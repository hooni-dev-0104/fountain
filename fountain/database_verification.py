"""Typed database knowledge owners and server-only verification trust.

Raw rows remain mutation sources. Public resolution is a detached projection and
must happen before derived properties or predicates, including related rows.
"""
from __future__ import annotations
import copy
import hashlib
import json
import re
from datetime import datetime
from .core import require, now, uid
from .access import Access, ROLES

PRIVATE_ROW_FIELDS = {'verification', '_owner_generations', 'verification_cycle', '_verification_generation', 'owner_generations'}
PRIVATE_DB_FIELDS = {'_property_generation'}

def protect_row(body):
    require(not PRIVATE_ROW_FIELDS.intersection(body), 'Database verification fields are server managed')

def pair(database):
    props = database.get('properties', [])
    return (next((p for p in props if p.get('type') == 'owner'), None),
            next((p for p in props if p.get('type') == 'verification'), None))

def schema_revision(database):
    value=[database.get('id'),database.get('properties',[]),database.get('_property_generation',0),database.get('task_settings',{}),database.get('row_permissions',{})]
    return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()

def check_schema_revision(database, body):
    if 'schema_revision' not in body: return
    token=body['schema_revision']
    require(isinstance(token,str) and re.fullmatch('[0-9a-f]{64}',token),'Schema revision must be a SHA256 token')
    require(token==schema_revision(database),'Database schema changed',409)

def prepare_schema(store, database, properties, previous=None):
    """Activate types without scanning/backfilling rows; only tightening scans."""
    previous = previous or {}
    old = {p['id']: p for p in previous.get('properties', [])}
    require(sum(p['type'] == 'owner' for p in properties) <= 1, 'Only one Owner property is supported')
    require(sum(p['type'] == 'verification' for p in properties) <= 1, 'Only one Verification property is supported')
    owner, verification = pair({'properties': properties})
    if verification and not owner:
        require(len(properties) < 100, 'Verification requires an available Owner property slot')
        names, ids = {p['name'] for p in properties}, {p['id'] for p in properties}
        name, index = 'Owner', 2
        while name in names: name, index = 'Owner '+str(index), index+1
        identity = uid()
        while identity in ids: identity = uid()
        owner = {'id': identity, 'name': name, 'type': 'owner'}
        properties.append(owner)
    high = previous.get('_property_generation', 0)
    require(type(high) is int and 0 <= high < 9007199254740991, 'Property generation exhausted',409)
    high = max([high, *[p.get('generation', 0) for p in old.values() if type(p.get('generation')) is int]])
    for prop in properties:
        kind = prop['type']
        if kind not in {'owner', 'verification'}:
            require(not {'generation', 'initial_default', 'owner_property_id'}.intersection(prop), 'Owner settings require a typed property')
            continue
        existing = old.get(prop['id'])
        active = bool(existing and existing.get('type') == kind and type(existing.get('generation')) is int and existing['generation'] > 0)
        require(not ({'owner_property_id'} if kind=='owner' else {'initial_default','limit','default'}).intersection(prop), 'Invalid settings for property type')
        managed = {'generation', 'initial_default'} if kind == 'owner' else {'generation', 'owner_property_id'}
        for key in managed:
            require(key not in prop or active and prop[key] == existing.get(key), 'Property trust metadata is server managed')
        if active: prop['generation'] = existing['generation']
        else:
            high += 1
            require(high < 9007199254740991, 'Property generation exhausted', 409)
            prop['generation'] = high
        if kind == 'owner':
            prop.setdefault('limit', existing.get('limit', 'one') if active else 'one')
            prop.setdefault('default', existing.get('default', 'created_by') if active else 'created_by')
            require(isinstance(prop['limit'],str) and isinstance(prop['default'],str) and prop['limit'] in {'one','unlimited'} and prop['default'] in {'created_by','none'}, 'Invalid Owner settings')
            prop['initial_default'] = existing['initial_default'] if active else prop['default']
            if active and existing.get('limit') == 'unlimited' and prop['limit'] == 'one':
                resolver = DatabaseVerification(store, None)
                require(all(len(resolver.raw_owners(previous, row)) <= 1 for row in store.list('row') if row.get('database_id') == database['id']), 'Existing rows have multiple owners', 409)
        else:
            require(owner is not None, 'Verification requires Owner')
            if active and existing.get('owner_property_id') != owner['id']:
                high += 1; prop['generation'] = high
            prop['owner_property_id'] = owner['id']
    prior_owner, prior_verification = pair(previous)
    if prior_verification and verification and prior_owner and (not owner or owner['id'] != prior_owner['id']):
        require(False, 'Remove Verification before removing its Owner')
    policy=database.get("row_permissions",{})
    require(not isinstance(policy,dict) or policy.get("mode")!="assigned" or not any(p["id"]==policy.get("property_id") and p["type"] in {"owner","verification"} for p in properties), "Knowledge ownership cannot grant row access")
    database['_property_generation'] = high
    database['properties'] = properties
    return properties

class DatabaseVerification:
    def __init__(self, store, access=None): self.store, self.access = store, access
    def member(self, identity, row, visible=True):
        if not Access.verification_id(identity): return False
        member = self.store.get('member', identity)
        return bool(member and member.get('active', True) is True and member.get('role') in ROLES
                    and (not visible or self.access is None or self.access.regular or identity == self.access.member_id)
                    and Access(self.store, member).can('row', row))
    def raw_owners(self, database, row):
        owner, _ = pair(database)
        if not owner or type(owner.get('generation')) is not int or not 0<owner['generation']<9007199254740991: return []
        values = row.get('properties', {})
        generations = row.get('_owner_generations', {})
        if not isinstance(generations, dict): return []
        if owner['id'] in values:
            value = values[owner['id']]
            if generations.get(owner['id']) != owner.get('generation') or not isinstance(value,list) or len(value)>1000 or not all(Access.verification_id(v) for v in value): return []
            return list(dict.fromkeys(value))
        if owner['id'] in generations: return []
        identity = row.get('owner_id')
        return [identity] if owner.get('initial_default') == 'created_by' and Access.verification_id(identity) else []
    def owners(self, database, row, visible=True):
        ids=self.raw_owners(database,row)
        if len(ids)>1: self.store.list('member')
        return [v for v in ids if self.member(v,row,visible)]
    def apply_values(self, database, row, values, existing=None, reset=False):
        owner, verification = pair(database)
        if verification: require(verification['id'] not in values, 'Verification is computed and cannot be assigned')
        if reset:
            for key in PRIVATE_ROW_FIELDS: row.pop(key,None)
            if verification: row.get('properties',{}).pop(verification['id'],None)
            if owner: values.pop(owner['id'],None); row.get('properties',{}).pop(owner['id'],None)
        if not owner: return row
        key = owner['id']
        explicit = key in values
        if explicit:
            selected = values[key]
            require(isinstance(selected,list) and len(selected)<=1000 and all(Access.verification_id(v) for v in selected), 'Owner must be a member ID list')
            selected = list(dict.fromkeys(selected))
            if len(selected)>1: self.store.list('member')
            require(all(self.member(v,existing or row) for v in selected), 'Owner member not found',404)
            if existing and self.access:
                hidden = [v for v in self.owners(database,existing,False) if not self.member(v,existing)]
                selected = list(dict.fromkeys([*selected,*hidden]))
        elif existing: return row
        else: selected = [row['owner_id']] if owner.get('default')=='created_by' and Access.verification_id(row.get('owner_id')) else []
        require(len(selected)<=1000,'Owner member budget exceeded')
        require(owner['limit'] != 'one' or len(selected)<=1, 'Owner allows only one person')
        row.setdefault('properties',{})[key] = selected
        if not isinstance(row.get('_owner_generations'),dict): row['_owner_generations']={}
        row['_owner_generations'][key] = owner['generation']
        return row
    def event_cycle(self, database, row):
        _, prop = pair(database)
        stamp = row.get('verification')
        owner,_=pair(database)
        if not prop or not owner or prop.get('owner_property_id')!=owner.get('id') or type(prop.get('generation')) is not int or prop['generation']<=0 or not isinstance(stamp,dict) or stamp.get('generation') != prop.get('generation'): return None
        cycle=row.get('verification_cycle',0)
        if type(cycle) is not int or not 0<=cycle<=9007199254740991: return None
        return [prop['generation'], cycle]
    def public_verification(self, database, row):
        owners = self.owners(database,row)
        neutral = {'status':'unverified','owners':owners,'owner':owners[0] if owners else None,'verified_by':None,'verified_at':None,'expires_at':None}
        _, prop = pair(database)
        stamp = row.get('verification')
        if self.event_cycle(database,row) is None: return neutral
        if not Access.verification_date(stamp.get('verified_at')) or stamp.get('expires_at') is not None and not Access.verification_date(stamp['expires_at']): return {**neutral,'status':'unknown'}
        if not self.owners(database,row,False): return neutral
        current = getattr(self.store,'requestTime',None) or now()
        status = 'expired' if stamp.get('expires_at') and datetime.fromisoformat(stamp['expires_at']) <= datetime.fromisoformat(current) else 'verified'
        return {**neutral,'status':status,'verified_by':stamp.get('verified_by') if self.member(stamp.get('verified_by'),row) else None,'verified_at':stamp['verified_at'],'expires_at':stamp.get('expires_at')}
    def project(self, database, row):
        result = copy.deepcopy(row)
        owner, verification = pair(database)
        if owner: result.setdefault('properties',{})[owner['id']] = self.owners(database,row)
        if verification: result.setdefault('properties',{})[verification['id']] = self.public_verification(database,row)
        for key in PRIVATE_ROW_FIELDS: result.pop(key,None)
        return result
    def revision(self, database, row):
        owner, verification = pair(database)
        return hashlib.sha256(json.dumps([row,owner,verification],ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    def resources(self, database_id, row_id, edit=False):
        require(self.access is not None,'Current principal required',403)
        database = self.access.require_resource('database',database_id)
        row = self.access.require_resource('row',row_id,3 if edit else 1)
        require(row.get('database_id')==database_id,'Row not found',404)
        require(pair(database)[0] is not None,'Owner property not found',404)
        return database,row
    def context(self, database_id, row_id):
        database,row = self.resources(database_id,row_id)
        owner,verification = pair(database)
        editable = self.access.can('row',row,3)
        members = [{'id':m['id'],'name':m.get('name') if isinstance(m.get('name'),str) else m['id']} for m in self.store.list('member') if self.member(m['id'],row)]
        members.sort(key=lambda member:member['id'])
        return {'database_id':database_id,'row_id':row_id,'revision':self.revision(database,row),'owner_property':{key:copy.deepcopy(value) for key,value in owner.items() if key in {'id','name','type','limit','default','initial_default','generation'}},'verification_property':{key:copy.deepcopy(value) for key,value in verification.items() if key in {'id','name','type','generation','owner_property_id'}} if verification else None,'owners':self.owners(database,row),'verification':self.public_verification(database,row),'members':members,'can_verify':bool(verification and editable and self.owners(database,row,False)),'can_manage':editable}
    def mutate(self, database_id, row_id, body, remove=False):
        require(isinstance(body,dict) and set(body)<=({'revision'} if remove else {'revision','expires_at'}),'Unknown verification fields')
        require(isinstance(body.get('revision'),str) and re.fullmatch('[0-9a-f]{64}',body['revision']),'Verification revision must be a SHA256 token')
        with self.store.transaction():
            database,row = self.resources(database_id,row_id,True)
            _,prop = pair(database)
            require(prop is not None,'Verification property not found',404)
            require(body['revision']==self.revision(database,row),'Row verification changed',409)
            require(self.owners(database,row,False),'At least one eligible Owner is required',409)
            current = getattr(self.store,'requestTime',None) or now()
            if remove: row.pop('verification',None)
            else:
                expiry=body.get('expires_at')
                require(expiry is None or Access.verification_date(expiry),'Expiry must be an aware date or null')
                require(expiry is None or datetime.fromisoformat(expiry)>datetime.fromisoformat(current),'Expiry must be in the future')
                row['verification']={'generation':prop['generation'],'verified_by':self.access.member_id,'verified_at':current,'expires_at':expiry}
            cycle=row.get('verification_cycle',0)
            require(type(cycle) is int and 0<=cycle<9007199254740991,'Verification cycle exhausted',409)
            row['verification_cycle']=cycle+1
            self.store.put('row',row)
            self.store.audit('row.verification.updated',{'database_id':database_id,'row_id':row_id})
            return self.context(database_id,row_id)
    def route(self, method, database_id, row_id, body, query):
        require(not query,'Verification does not accept query parameters')
        require(method in {'GET','POST','DELETE'},'Unsupported verification method',405)
        if method=='GET': require(not body,'Verification GET does not accept a body'); return self.context(database_id,row_id)
        return self.mutate(database_id,row_id,body,method=='DELETE')
