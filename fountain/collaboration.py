"""Transactional collaboration snapshots, independent of HTTP and transport."""
from __future__ import annotations

from datetime import datetime, timezone

from .core import require, uid
from . import crdt


class Collaboration:
    def __init__(self, store, workspace):
        self.store, self.workspace = store, workspace

    def _document(self, page):
        document = self.store.get('collaboration', page['id'])
        if document is None:
            document = self.store.put('collaboration', {
                'id': page['id'], 'epoch': uid(), 'seq': 0,
                'state': crdt.seed_state(page.get('blocks', [])),
                'op_owners': {},
            })
        return document

    def _snapshot(self, page, document, access):
        return {'epoch': document['epoch'], 'seq': document['seq'],
                'state': crdt.public_state(document['state']),
                'page': page, 'blocks': page.get('blocks', []),
                'access_level': access.level('page', page),
                'access_revision': self.store.meta('access_revision', 0),
                'workspace_id': self.store.meta('workspace_id')}

    def snapshot(self, page_id, access):
        # Lazy initialisation also claims the SQLite writer, so two independent
        # Store connections cannot seed different epochs for the same page.
        with self.store.transaction():
            page = access.require_resource('page', page_id)
            return self._snapshot(page, self._document(page), access)

    def apply(self, page_id, body, access):
        with self.store.transaction():
            page = access.require_resource('page', page_id, 3)
            require(not page.get('locked'), 'Page is locked', 423)
            require(not page.get('archived'), 'Restore the page before editing', 409)
            document = self._document(page)
            require(body.get('epoch') == document['epoch'],
                    'Document was replaced. Keep your draft and reload before applying it.', 409)
            operations = body.get('ops')
            state = crdt.apply_operations(document['state'], operations)
            owners = self._operation_owners(document, operations, access.member_id)
            # Only ACK the precise IDs validated by the reducer. A retry is a
            # read: it does not grow history, revision or the audit log.
            ack = [operation['id'] for operation in operations]
            if state != document['state']:
                blocks = self.workspace.validate_blocks(crdt.project(state))
                from .authorization import Authorization
                authority = Authorization(access)
                for block in blocks:
                    if block.get('attachment_id'):
                        authority.attachment(block['attachment_id'])
                # Record the initial contents once per editing window. Restores
                # and legacy writes reset the epoch and therefore this window.
                timestamp = datetime.now(timezone.utc).timestamp()
                if timestamp - document.get('history_at', 0) >= 30:
                    self.store.put('version', {'page_id': page_id, 'revision': page['revision'],
                                              'title': page['title'], 'blocks': page.get('blocks', [])})
                    document['history_at'] = timestamp
                page.update(blocks=blocks, revision=page['revision'] + 1)
                page = self.store.put('page', page)
                document.update(state=state, op_owners=owners, seq=document['seq'] + 1)
                document = self.store.put('collaboration', document)
                self.store.audit('page.collaborated', {'page_id': page_id, 'revision': page['revision'],
                                                     'operations': len(operations)})
            return {**self._snapshot(page, document, access), 'ack': ack}

    @staticmethod
    def _operation_owners(document, operations, member_id):
        # The pure reducer has already validated every payload/digest. Only IDs
        # absent before this request can establish ownership or a client binding;
        # replaying an old seen ID must never claim an untracked legacy action.
        previous = document['state']
        owners = dict(document.get('op_owners', {}))
        ledger = previous.get('history', {}).get('ops', {})
        new = {operation['id']: operation for operation in operations if operation['id'] not in previous['seen']}
        clients = {operation['client'] for operation in new.values()}
        for identity, operation in ledger.items():
            if operation['client'] in clients:
                require(owners.get(identity) == member_id,
                        'Operation client belongs to another member or has no tracked owner', 403)
        prospective = {**owners, **{identity: member_id for identity in new}}
        for operation in new.values():
            if operation['type'] == 'history.cancel':
                for target in operation['targets']:
                    require(target in ledger or target in new,
                            'History target is not a tracked operation in this document', 409)
                    require(prospective.get(target) == member_id,
                            'History target belongs to another member', 403)
        return prospective
