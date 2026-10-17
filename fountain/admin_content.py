"""Capability-gated administrator corpus search over private derivative headers/chunks."""
from __future__ import annotations

import base64
import copy
import csv
import hashlib
import hmac
import io
import json
import re
from datetime import datetime, timezone
from functools import cmp_to_key

from .access import Access, LEVELS
from .admin_roles import AdminAuthority
from .content_index import ContentIndex, IndexHeaderReader, canonical, _valid_text, trusted_actor
from .core import require
from .search import _fold, _id, _terms

DEFAULTS={'version':1,'q':'','terms':[],'field':'all','kind':'all','status':'all','audience':'all',
          'creator_id':None,'creator_unknown':False,'editor_id':None,'editor_unknown':False,
          'created_after':None,'created_before':None,'edited_after':None,'edited_before':None,
          'location_kind':'all','location_id':None,'shared_with_id':None,'sort':'title','direction':'asc','limit':50}
ENUMS={'field':('all','id','title','body'),'kind':('all','page','database','row'),'status':('all','active','trash'),
       'audience':('all','private','internal','external','web','unknown'),'location_kind':('all','page','teamspace','database'),
       'sort':('title','created','edited'),'direction':('asc','desc')}
DATE=re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$',re.ASCII)
HASH=re.compile(r'^[a-f0-9]{64}$')
CSV_COLUMNS=('kind','id','title','status','location_kind','location_id','location_title','creator_id','creator_name','creation_cause',
             'created_at','last_editor_id','last_editor_name','edit_cause','edited_at','audience','implicit_owner_id','internal_count',
             'external_count','workspace_owner_admin_access','publication_state','site_count','form_count','shared_with')


def timestamp(value):
    if not isinstance(value,str) or not DATE.fullmatch(value): return None
    if not value.endswith('Z') and (int(value[-5:-3])>23 or int(value[-2:])>59):return None
    try:return datetime.fromisoformat(value.replace('Z','+00:00')).astimezone(timezone.utc)
    except (ValueError,OverflowError):return None


def excerpt(display,terms):
    folded=[];positions=[]
    for index,character in enumerate(display):
        piece=character.casefold();folded.append(piece);positions.extend([index]*len(piece))
    folded=''.join(folded)
    hits=[folded.find(term) for term in terms if term in folded]
    start=max(0,(positions[min(hits)] if hits else 0)-60)
    return display[start:start+180]


def bounded(values,limit):
    result=[];size=0
    for value in values[:limit]:
        length=len(json.dumps(value,ensure_ascii=False).encode())
        if size+length>524288:
            require(bool(result),'Content metadata limit exceeded',413)
            break
        size+=length;result.append(value)
    return result


def content_query(query):
    require(isinstance(query,dict) and set(query)<=set(DEFAULTS)-{'version','terms'}|{'cursor'},'Invalid admin content query')
    require(all(isinstance(values,list) and len(values)==1 and isinstance(values[0],str) and _valid_text(values[0]) for values in query.values()),'Invalid admin content query')
    result=copy.deepcopy(DEFAULTS)
    for key,values in query.items():
        if key!='cursor':result[key]=values[0]
    require(len(result['q'])<=512,'Invalid admin content query')
    result['q']=_fold(result['q']);require(len(result['q'])<=512,'Invalid admin content query')
    result['terms']=_terms(result['q'])
    for key,choices in ENUMS.items():require(result[key] in choices,'Invalid admin content '+key)
    for key in ('creator_unknown','editor_unknown'):
        if key in query:
            require(result[key] in ('0','1'),'Invalid admin content '+key);result[key]=result[key]=='1'
    for key in ('creator_id','editor_id','location_id','shared_with_id'):
        require(result[key] is None or _id(result[key]),'Invalid admin content '+key)
    require(not result['creator_unknown'] or result['creator_id'] is None,'Conflicting creator filter')
    require(not result['editor_unknown'] or result['editor_id'] is None,'Conflicting editor filter')
    require((result['location_id'] is None)==(result['location_kind']=='all'),'Invalid location filter')
    for prefix in ('created','edited'):
        for suffix in ('after','before'):
            key=prefix+'_'+suffix
            if result[key] is not None:
                instant=timestamp(result[key]);require(instant is not None,'Invalid admin content date')
                result[key]=instant.isoformat(timespec='microseconds').replace('+00:00','Z')
        after,before=result[prefix+'_after'],result[prefix+'_before']
        require(after is None or before is None or after<before,'Invalid admin content date bounds')
    if 'limit' in query:
        require(re.fullmatch(r'[1-9][0-9]{0,2}',result['limit']) is not None and int(result['limit'])<=100,'Invalid admin content limit')
        result['limit']=int(result['limit'])
    cursor=query.get('cursor',[None])[0]
    if cursor is not None:decode_cursor(cursor)
    return result,cursor


def decode_cursor(value):
    require(isinstance(value,str) and 0<len(value)<=4096 and re.fullmatch(r'[A-Za-z0-9_-]+',value) is not None,'Invalid content cursor')
    try:
        decoded=base64.b64decode(value+'='*((-len(value))%4),altchars=b'-_',validate=True)
        require(base64.urlsafe_b64encode(decoded).decode().rstrip('=')==value,'Invalid content cursor')
        def unique(pairs):
            result={}
            for key,val in pairs:
                if key in result:raise ValueError()
                result[key]=val
            return result
        def nonfinite(_):raise ValueError()
        def utf8(child):
            if isinstance(child,str):return _valid_text(child)
            if isinstance(child,list):return all(utf8(value) for value in child)
            if isinstance(child,dict):return all(utf8(key) and utf8(value) for key,value in child.items())
            return child is None or type(child) in (bool,int,float)
        result=json.loads(decoded.decode('utf-8'),object_pairs_hook=unique,parse_constant=nonfinite)
        require(utf8(result),'Invalid content cursor')
        require(isinstance(result,dict) and set(result)=={'payload','signature'} and isinstance(result['payload'],dict) and isinstance(result['signature'],str) and HASH.fullmatch(result['signature']) is not None,'Invalid content cursor')
        payload=result['payload']
        require(set(payload)=={'purpose','query','workspace','member','session','index_version','content_revision','after'},'Invalid content cursor')
        require(payload['purpose'] in ('search','access','options') and isinstance(payload['query'],str) and HASH.fullmatch(payload['query']) is not None,'Invalid content cursor')
        require(payload['workspace'] is None or _id(payload['workspace']),'Invalid content cursor')
        require(_id(payload['member']) and (payload['session'] is None or isinstance(payload['session'],str)),'Invalid content cursor')
        require(type(payload['index_version']) is int and payload['index_version']==1 and type(payload['content_revision']) is int and 0<=payload['content_revision']<=9007199254740991,'Invalid content cursor')
        after=payload['after']
        require(isinstance(after,dict) and set(after)=={'kind','id'} and after['kind'] in ('page','database','row','member','group','teamspace') and _id(after['id']),'Invalid content cursor')
    except (ValueError,UnicodeError,TypeError,RecursionError,OverflowError,KeyError):
        require(False,'Invalid content cursor')
    return result


class NormalAccess(Access):
    """Calculate ordinary access without the universal owner override."""
    def __init__(self,store,principal):
        super().__init__(store,principal)
        self.owner=False


class AdminContent:
    def __init__(self,store,access):
        self.store,self.principal=store,copy.deepcopy(access.principal)
        self.authority=AdminAuthority(store,access)
        self.index=ContentIndex(store)

    def _authorize(self,action='content.search.read'):
        self.authority.require_action('content.search.read')
        if action!='content.search.read':self.authority.require_action(action)
        if action=='content.search.export':
            settings=self.store.get('settings','workspace') or {}
            require(settings.get('disable_export') is not True,'Workspace export is disabled',403)
        self.state=self.index.state()

    def _pin(self,action='content.search.read'):
        self._authorize(action)
        self.docs=self.index.documents()
        self.by_key={(doc['kind'],doc['id']):doc for doc in self.docs}
        self.reader=IndexHeaderReader(self.store,self.docs)
        self.all_members={m['id']:m for m in self.store.list('member') if isinstance(m,dict) and _id(m.get('id'))}
        self.members={m['id']:m for m in self.all_members.values() if isinstance(m,dict) and _id(m.get('id')) and m.get('active',True) is True and m.get('role') in ('owner','admin','member','guest')}
        self.groups={g['id']:g for g in self.store.list('group') if isinstance(g,dict) and _id(g.get('id'))}
        self.spaces={s['id']:s for s in self.store.list('teamspace') if isinstance(s,dict) and _id(s.get('id'))}
        self.sites=self.store.list('site');self.forms=self.store.list('form')
        self.normal_access={identity:NormalAccess(self.reader,member) for identity,member in self.members.items()}

    def _scope(self,purpose,query):
        return {'purpose':purpose,'query':hashlib.sha256(canonical(query).encode()).hexdigest(),
                'workspace':getattr(self.store,'workspace_id',None) or self.store.meta('workspace_id'),
                'member':self.principal.get('id'),'session':self.principal.get('_content_session_binding'),
                'index_version':self.state['version'],'content_revision':self.state['revision']}

    def _cursor(self,purpose,query,after):
        payload={**self._scope(purpose,query),'after':after}
        signature=hmac.new(bytes.fromhex(self.state['secret']),canonical(payload).encode(),hashlib.sha256).hexdigest()
        return base64.urlsafe_b64encode(canonical({'payload':payload,'signature':signature}).encode()).decode().rstrip('=')

    def _after(self,cursor,purpose,query):
        if cursor is None:return None
        value=decode_cursor(cursor);payload=value['payload']
        signature=hmac.new(bytes.fromhex(self.state['secret']),canonical(payload).encode(),hashlib.sha256).hexdigest()
        require(hmac.compare_digest(signature,value['signature']),'Invalid content cursor')
        scope=self._scope(purpose,query)
        require(set(payload)==set(scope)|{'after'} and all(payload.get(key)==value for key,value in scope.items()),'Content results changed; restart search',409)
        after=payload['after'];require(isinstance(after,dict) and set(after)=={'kind','id'} and after['kind'] in ('page','database','row','member','group','teamspace') and _id(after['id']),'Invalid content cursor')
        return after

    def _review(self,doc):
        return hashlib.sha256(json.dumps([1,self._scope('review',{})['workspace'],doc['kind'],doc['id'],doc['generation'],self.state['revision']],ensure_ascii=False).encode()).hexdigest()

    def _implicit(self,doc):
        target=doc['header']
        if doc['kind']=='row':target=self.reader.get('database',target.get('database_id')) or {}
        identity=target.get('owner_id','local')
        return identity if _id(identity) else None

    def _valid(self,doc):
        if not doc['validity']:return False
        value=doc['header'];kind=doc['kind'];seen=set()
        if kind=='row':
            acl=value.get('permissions')
            if acl is not None and (not isinstance(acl,dict) or set(acl)-{'default','inherit','members','groups'} or not isinstance(acl.get('default','workspace'),str) or acl.get('default','workspace') not in ('private','workspace') or type(acl.get('inherit',False)) is not bool or any(not isinstance(acl.get(field,{}),dict) or any(not isinstance(v,str) or v not in LEVELS for v in acl.get(field,{}).values()) for field in ('members','groups'))):return False
            value=self.reader.get('database',value.get('database_id'));kind='database'
            if not isinstance(value,dict) or Access._row_policy(value) is None:return False
        for depth in range(65):
            if not isinstance(value,dict) or not _id(value.get('id')) or (kind,value['id']) in seen or depth==64:return False
            seen.add((kind,value['id']))
            acl=value.get('permissions')
            if acl is not None and (not isinstance(acl,dict) or set(acl)-{'default','inherit','members','groups'}
                or acl.get('default','workspace') not in ('private','workspace') or type(acl.get('inherit',False)) is not bool
                or any(not isinstance(acl.get(field,{}),dict) or any(not _id(k) or not isinstance(v,str) or v not in LEVELS for k,v in acl.get(field,{}).items()) for field in ('members','groups'))):return False
            parent=value.get('parent_id')
            if parent is None:return value.get('teamspace_id') is None or _id(value.get('teamspace_id')) and value['teamspace_id'] in self.spaces
            if not _id(parent):return False
            value=self.reader.get('page',parent);kind='page'
        return False

    def _via(self,kind,entity,member,normal,trail=None):
        trail=set() if trail is None else trail
        token=(kind,entity.get('id'))
        if token in trail or len(trail)>=64:return 'workspace'
        trail=trail|{token}
        if kind=='row':
            database=self.reader.get('database',entity.get('database_id'))
            if not isinstance(database,dict):return 'workspace'
            if database.get('owner_id','local')==member['id']:return 'resource_owner'
            base=normal.level('database',database)
            via=self._via('database',database,member,normal,trail)
            policy=normal._row_policy(database) or {}
            before=base
            if base<4 and policy.get('mode','all')=='assigned':
                via='assignment';before=min(base,3 if policy.get('edit_assigned',False) is True else 1)
            if entity.get('permissions') is not None:
                override,_=normal._acl(entity['permissions'])
                if override is not None and override<=before:
                    acl=entity['permissions'];via='direct' if member['id'] in acl.get('members',{}) else 'group'
            return via
        if entity.get('owner_id','local')==member['id']:return 'resource_owner'
        acl=entity.get('permissions')
        if isinstance(acl,dict):
            override,_=normal._acl(acl)
            if override is not None:return 'direct' if member['id'] in acl.get('members',{}) else 'group'
        if entity.get('parent_id') and (acl is None or isinstance(acl,dict) and acl.get('inherit',False) is True):return 'inherited'
        return 'workspace'

    def _access(self,doc):
        result=[];implicit=self._implicit(doc);entity=self.reader.get(doc['kind'],doc['id'])
        for member in self.members.values():
            normal=self.normal_access[member['id']]
            universal=member['role']=='owner'
            if not doc['validity']:level=0
            else:
                try:level=normal.level(doc['kind'],entity)
                except (TypeError,ValueError,KeyError):level=0
            if not level and not universal:continue
            via='workspace_admin' if universal else self._via(doc['kind'],entity,member,normal)
            result.append({'id':member['id'],'name':member.get('name') if isinstance(member.get('name'),str) else None,
                           'email':member.get('email') if isinstance(member.get('email'),str) else None,'role':member['role'],
                           'level':4 if universal else level,'via':via,'can_revoke':not universal and member['id']!=implicit and self.authority.allows('content.permissions.manage')})
        return sorted(result,key=lambda item:item['id'].encode('utf-8'))

    def _publication(self,doc):
        sites=[s for s in self.sites if doc['kind']=='page' and s.get('page_id')==doc['id'] and bool(s.get('published'))]
        forms=[f for f in self.forms if doc['kind']=='database' and f.get('database_id')==doc['id'] and bool(f.get('published'))]
        settings=self.store.get('settings','workspace') or {}
        disabled=any(doc['header'].get(key) for key in ('archived','deleted','deleted_at')) or not self._valid(doc) or isinstance(settings,dict) and settings.get('disable_public_sharing') is True
        return {'state':'disabled' if disabled and (sites or forms) else 'authenticated' if sites else 'none','site_count':len(sites),'form_count':len(forms)}

    def _active_location_ancestor(self,kind,identity):
        """Read only a lifecycle predicate, never transfer an ancestor's body."""
        if self.index.postgres:
            row=self.store._execute("SELECT jsonb_typeof(data->'id')='string' AND data->>'id'=%s "
                "AND coalesce(data->'active','true'::jsonb)='true'::jsonb "
                "AND coalesce(data->'archived','false'::jsonb)='false'::jsonb "
                "AND coalesce(data->'deleted','false'::jsonb)='false'::jsonb "
                "AND coalesce(data->'deleted_at','null'::jsonb)='null'::jsonb "
                "FROM fountain_private.entities WHERE workspace_id=%s AND kind=%s AND id=%s",
                (identity,self.store.workspace_id,kind,identity),fetch='one')
            return row is not None and row[0] is True
        row=self.store.db.execute("SELECT json_type(data,'$.id')='text' AND json_extract(data,'$.id')=? "
            "AND (json_type(data,'$.active') IS NULL OR json_type(data,'$.active')='true') "
            "AND (json_type(data,'$.archived') IS NULL OR json_type(data,'$.archived')='false') "
            "AND (json_type(data,'$.deleted') IS NULL OR json_type(data,'$.deleted')='false') "
            "AND (json_type(data,'$.deleted_at') IS NULL OR json_type(data,'$.deleted_at')='null') "
            "FROM entities WHERE kind=? AND id=?",(identity,kind,identity)).fetchone()
        return row is not None and row[0]==1

    def _locations(self,doc):
        result=[];seen=set();links=0
        trash_location=doc['kind']=='page' and doc['header'].get('archived') is True
        while True:
            token=(doc['kind'],doc['id'])
            trashed_leaf=not seen and trash_location
            if token in seen or not doc['validity'] or not trashed_leaf and any(doc['header'].get(k) for k in ('archived','deleted','deleted_at')):return None
            if trash_location and seen and not self._active_location_ancestor(doc['kind'],doc['id']):return None
            seen.add(token);value=doc['header']
            if doc['kind']=='row':
                kind,identity='database',value.get('database_id')
            elif value.get('parent_id') is not None:
                if links>=64:return None
                kind,identity='page',value['parent_id'];links+=1
            else:
                identity=value.get('teamspace_id')
                if identity is None:return result
                space=self.spaces.get(identity) if _id(identity) else None
                if space is None:return None
                if trash_location and (space.get('id')!=identity or space.get('active',True) is not True or
                    space.get('archived',False) is not False or space.get('deleted',False) is not False or
                    space.get('deleted_at') is not None):return None
                result.append({'kind':'teamspace','id':identity,'title':space.get('name') if isinstance(space.get('name'),str) else ''})
                return result
            if not _id(identity):return None
            doc=self.by_key.get((kind,identity))
            if doc is None:return None
            result.append({'kind':kind,'id':identity,'title':doc['title']})

    def _location(self,doc):
        locations=self._locations(doc)
        return locations[0] if locations else None

    def _actor(self,doc,key):
        identity=doc.get(key+'_id');cause=doc.get('creator_cause' if key=='creator' else 'editor_cause') or 'unknown'
        if cause not in ('human','automation','import','public_form','system'):cause='unknown'
        member=self.all_members.get(identity,{})
        return {'id':identity,'name':member['name'][:1000] if isinstance(member.get('name'),str) else None,'cause':cause}

    def _item(self,doc,snippet):
        viewers=self._access(doc);implicit=self._implicit(doc)
        shared=[v for v in viewers if v['role']!='owner' and v['id']!=implicit]
        internal=sum(v['role']!='guest' for v in shared);external=sum(v['role']=='guest' for v in shared)
        audience='unknown' if not self._valid(doc) else 'external' if external else 'internal' if internal else 'private'
        publication=self._publication(doc)
        return {'kind':doc['kind'],'id':doc['id'],'title':doc['title'],'icon':doc['icon'],
                'status':'trash' if any(doc['header'].get(key) for key in ('archived','deleted','deleted_at')) else 'active',
                'location':self._location(doc),'creator':self._actor(doc,'creator'),'created_at':doc['created_at'] if timestamp(doc['created_at']) else None,
                'last_editor':self._actor(doc,'editor'),'edited_at':doc['edited_at'] if timestamp(doc['edited_at']) else None,
                'audience':audience,'access_summary':{'internal_count':internal,'external_count':external,'implicit_owner_id':implicit,
                'workspace_owner_override':True,'sample':[{key:v[key] for key in ('id','name','role','level')} for v in shared[:10]],'has_more':len(shared)>10},
                'publication':publication,'snippet':snippet,'review_revision':self._review(doc),
                'can_manage_permissions':self.authority.allows('content.permissions.manage'),
                'can_unpublish':doc['kind']!='row' and bool(publication['site_count']+publication['form_count']) and self.authority.allows('content.publish.manage')}

    def _body_match(self,doc,query):
        terms=query['terms'];field=query['field'];pending=set(terms);snippet=None
        if field in ('all','id'):pending.difference_update(t for t in terms if t in doc['id_fold'])
        if field in ('all','title'):pending.difference_update(t for t in terms if t in doc['title_fold'])
        if field in ('all','body') and terms:
            for display,folded in self.index.chunks(doc['kind'],doc['id']):
                hits=[term for term in terms if term in folded]
                if snippet is None and hits:snippet=excerpt(display,terms)
                pending.difference_update(hits)
                if not pending and snippet is not None:break
        if snippet is None and field in ('title','all'):snippet=excerpt(doc['title'],terms)
        if snippet is None and field=='id':snippet=excerpt(doc['id'],terms)
        return not pending,snippet or ''

    def _filtered(self,query):
        found=[]
        for doc in self.docs:
            if not _id(doc['id']):continue
            if query['kind']!='all' and query['kind']!=doc['kind']:continue
            for prefix,key in (('creator','creator_id'),('editor','editor_id')):
                if query[prefix+'_id'] is not None and doc[key]!=query[prefix+'_id'] or query[prefix+'_unknown'] and doc[key] is not None:break
            else:
                dates_ok=True
                for prefix,key in (('created','created_at'),('edited','edited_at')):
                    stamp=timestamp(doc[key]);after=query[prefix+'_after'];before=query[prefix+'_before']
                    if (after is not None or before is not None) and (stamp is None or after is not None and stamp<timestamp(after) or before is not None and stamp>=timestamp(before)):dates_ok=False;break
                if not dates_ok:continue
                matches,snippet=self._body_match(doc,query)
                if not matches:continue
                item=self._item(doc,snippet)
                if query['status']!='all' and item['status']!=query['status'] or query['audience']!='all' and item['audience']!=query['audience']:continue
                location=item['location']
                if query['location_kind']!='all' and not any(value['kind']==query['location_kind'] and value['id']==query['location_id'] for value in self._locations(doc) or []):continue
                if query['shared_with_id'] is not None:
                    member=self.members.get(query['shared_with_id'])
                    if member is None or not self.normal_access[member['id']].can(doc['kind'],self.reader.get(doc['kind'],doc['id'])):continue
                found.append((doc,item))
        def compare(a,b):
            key='title_fold' if query['sort']=='title' else 'created_at' if query['sort']=='created' else 'edited_at'
            left,right=(a[0][key],b[0][key])
            if key!='title_fold':left,right=timestamp(left),timestamp(right)
            if left!=right:
                if left is None or right is None:return 1 if left is None else -1
                return ((left>right)-(left<right))*(1 if query['direction']=='asc' else -1)
            left,right=(a[0]['kind'].encode(),a[0]['id'].encode()),(b[0]['kind'].encode(),b[0]['id'].encode())
            return (left>right)-(left<right)
        return sorted(found,key=cmp_to_key(compare))

    def search(self,query):
        normalized,cursor=content_query(query)
        with self.store.transaction():
            self._pin();after=self._after(cursor,'search',normalized)
            found=self._filtered(normalized);start=0
            if after is not None:
                position=next((i for i,(doc,_) in enumerate(found) if {'kind':doc['kind'],'id':doc['id']}==after),None)
                require(position is not None,'Content results changed; restart search',409);start=position+1
            selected_items=bounded([item for _,item in found[start:]],normalized['limit'])
            selected=found[start:start+len(selected_items)]
            next_cursor=self._cursor('search',normalized,{'kind':selected[-1][0]['kind'],'id':selected[-1][0]['id']}) if selected and start+len(selected)<len(found) else None
            return {'items':[item for _,item in selected],'next_cursor':next_cursor,'content_revision':self.state['revision']}

    def access(self,query):
        require(isinstance(query,dict) and set(query)<={'kind','id','limit','cursor'} and all(isinstance(v,list) and len(v)==1 and isinstance(v[0],str) for v in query.values()),'Invalid content access query')
        kind=query.get('kind',[None])[0];identity=query.get('id',[None])[0]
        require(kind in ('page','database','row') and _id(identity),'Invalid content target')
        raw=query.get('limit',['50'])[0];require(re.fullmatch(r'[1-9][0-9]{0,2}',raw) is not None and int(raw)<=100,'Invalid access limit')
        limit=int(raw);cursor=query.get('cursor',[None])[0];scope={'kind':kind,'id':identity,'limit':limit}
        with self.store.transaction():
            self._pin();after=self._after(cursor,'access',scope);doc=self.by_key.get((kind,identity));require(doc is not None,'Content not found',404)
            values=self._access(doc)
            if after is not None:
                require(after['kind']=='member' and any(v['id']==after['id'] for v in values),'Content access changed',409)
                values=[v for v in values if v['id'].encode()>after['id'].encode()]
            selected=bounded(values,limit)
            return {'kind':kind,'id':identity,'items':selected,'next_cursor':self._cursor('access',scope,{'kind':'member','id':selected[-1]['id']}) if len(values)>len(selected) else None,
                    'review_revision':self._review(doc),'content_revision':self.state['revision']}

    def permissions(self,query,restore=False):
        require(isinstance(query,dict) and set(query)=={'kind','id'} and all(isinstance(v,list) and len(v)==1 and isinstance(v[0],str) for v in query.values()),'Invalid content permissions query')
        kind,identity=query['kind'][0],query['id'][0]
        require(kind in ('page','database','row') and _id(identity),'Invalid content target')
        require(not restore or kind=='page','Only pages can be restored')
        with self.store.transaction():
            self._pin('content.restore.manage' if restore else 'content.permissions.manage')
            doc=self.by_key.get((kind,identity));require(doc is not None,'Content not found',404)
            if restore:require(doc['header'].get('archived') is True,'Page is not in trash',409)
            acl=doc['header'].get('permissions')
            invalid=False
            if acl is not None:
                invalid=not isinstance(acl,dict) or bool(set(acl)-{'default','inherit','members','groups'}) or acl.get('default','workspace') not in ('private','workspace') or type(acl.get('inherit',False)) is not bool
                if not invalid:
                    invalid=any(not isinstance(acl.get(field,{}),dict) or any(not isinstance(value,str) or value not in LEVELS for value in acl.get(field,{}).values()) for field in ('members','groups'))
                if invalid:acl=None
            require(len(canonical(acl).encode())<=1048576,'Permissions metadata limit exceeded',413)
            return {'kind':kind,'id':identity,'permissions':copy.deepcopy(acl),'source_invalid':invalid,'review_revision':self._review(doc)}

    def _restore_location(self,page):
        """Validate every original ancestor and configured space before any write."""
        seen={page['id']}
        current=page
        while True:
            require('is_wiki' not in current or type(current['is_wiki']) is bool,'Invalid wiki lifecycle',409)
            require(current.get('is_wiki') is not True or current.get('parent_id') is None,
                    'Wiki must be restored at the root',409)
            space_id=current.get('teamspace_id')
            if space_id is not None:
                require(_id(space_id),'Invalid original teamspace',409)
                space=self.spaces.get(space_id)
                require(isinstance(space,dict) and space.get('active',True) is True and
                        space.get('archived',False) is False and space.get('deleted',False) is False and
                        space.get('deleted_at') is None,'Original teamspace is unavailable',409)
            parent_id=current.get('parent_id')
            if parent_id is None:return
            require(_id(parent_id) and parent_id not in seen,'Invalid original page hierarchy',409)
            seen.add(parent_id)
            current=self.store.get('page',parent_id)
            require(isinstance(current,dict) and current.get('active',True) is True and current.get('archived',False) is False and
                    current.get('deleted',False) is False and current.get('deleted_at') is None,
                    'Original parent is unavailable',409)

    def restore(self,body):
        require(isinstance(body,dict) and set(body)=={'kind','id','review_revision','mode'} and
                body.get('kind')=='page' and _id(body.get('id')) and body.get('mode') in ('original','private') and
                isinstance(body.get('review_revision'),str) and HASH.fullmatch(body['review_revision']) is not None,
                'Invalid content restore')
        with self.store.transaction():
            self._pin('content.restore.manage')
            doc=self.by_key.get(('page',body['id']));require(doc is not None,'Content not found',404)
            require(hmac.compare_digest(body['review_revision'],self._review(doc)),'Content changed; review again',409)
            page=self.store.get('page',body['id'])
            require(isinstance(page,dict) and page.get('archived') is True,'Page is not in trash',409)
            require(all(key not in page or type(page[key]) is bool for key in ('archived','deleted','active','locked','is_wiki')) and
                    page.get('active',True) is True,
                    'Invalid page lifecycle',409)
            require(type(page.get('revision')) is int and 0<=page['revision']<9007199254740991,'Invalid page revision',409)
            require(not page.get('locked'),'Page is locked',423)
            if body['mode']=='original':self._restore_location(page)
            else:page.update(owner_id=self.principal['id'],parent_id=None,teamspace_id=None,
                             permissions={'default':'private','inherit':False,'members':{},'groups':{}})
            # Location changes normally count as edits. Restoration is a management
            # action: retain the trusted history exactly, including deleted actors.
            columns='generation,creator_id,creator_cause,editor_id,edited_at,editor_cause'
            if self.index.postgres:
                history=self.store._execute('SELECT '+columns+' FROM fountain_private.content_provenance WHERE workspace_id=%s AND kind=%s AND id=%s',
                                            (self.store.workspace_id,'page',body['id']),fetch='one')
            else:history=self.store.db.execute('SELECT '+columns+' FROM content_provenance WHERE kind=? AND id=?',('page',body['id'])).fetchone()
            require(history is not None,'Content history is unavailable',503)
            page.update(archived=False,deleted=False,revision=page['revision']+1)
            page.pop('deleted_at',None)
            saved=self.store.put('page',page)
            for site in self.sites:
                if site.get('page_id')==body['id'] and bool(site.get('published')):
                    site['published']=False;self.store.put('site',site)
            actor=trusted_actor(self.store)
            values=(*history,actor,saved['updated_at'] if actor is not None else None)
            if self.index.postgres:
                self.store._execute('UPDATE fountain_private.content_provenance SET generation=%s,creator_id=%s,creator_cause=%s,editor_id=%s,edited_at=%s,editor_cause=%s,manager_id=%s,manager_at=%s WHERE workspace_id=%s AND kind=%s AND id=%s',
                                    (*values,self.store.workspace_id,'page',body['id']))
            else:self.store.db.execute('UPDATE content_provenance SET generation=?,creator_id=?,creator_cause=?,editor_id=?,edited_at=?,editor_cause=?,manager_id=?,manager_at=? WHERE kind=? AND id=?',(*values,'page',body['id']))
            revision=self.store.meta('access_revision',0)
            require(type(revision) is int and 0<=revision<9007199254740991,'Invalid access revision',503)
            self.store.set_meta('access_revision',revision+1)
            self.store.audit('admin.content.restore_'+body['mode'],{'kind':'page','id':body['id']},self.principal.get('id'))
            return {'applied':True}

    def options(self,query):
        require(isinstance(query,dict) and set(query)<={'kind','q','limit','cursor'} and all(isinstance(v,list) and len(v)==1 and isinstance(v[0],str) and _valid_text(v[0]) for v in query.values()),'Invalid content options')
        kind=query.get('kind',[None])[0]
        require(kind in ('member','group','teamspace','page','database'),'Invalid content options kind')
        q=query.get('q',[''])[0];require(len(q)<=100,'Invalid content options query');q=_fold(q);require(len(q)<=100,'Invalid content options query')
        raw=query.get('limit',['50'])[0];require(re.fullmatch(r'[1-9][0-9]{0,2}',raw) is not None and int(raw)<=100,'Invalid content options limit')
        normalized={'kind':kind,'q':q,'limit':int(raw)};cursor=query.get('cursor',[None])[0]
        with self.store.transaction():
            self._pin('content.permissions.manage' if kind=='group' else 'content.search.read')
            after=self._after(cursor,'options',normalized)
            if kind in ('page','database'):
                values=[{'id':doc['id'],'label':doc['title'],'email':None,'role':None,'active':None} for doc in self.docs if doc['kind']==kind]
            else:
                values=[{'id':value['id'],'label':value.get('name') if isinstance(value.get('name'),str) else value['id'],
                         'email':value.get('email') if kind=='member' and isinstance(value.get('email'),str) else None,
                         'role':value.get('role') if kind=='member' and value.get('role') in ('owner','admin','member','guest') else None,
                         'active':value.get('active',True) is True if kind=='member' else None} for value in self.store.list(kind) if _id(value.get('id'))]
            values.sort(key=lambda value:(_fold(value['label']).encode(),value['id'].encode()))
            if after is not None:
                require(after['kind']==kind,'Invalid options cursor')
                position=next((i for i,value in enumerate(values) if value['id']==after['id']),None)
                require(position is not None,'Options changed; restart',409);values=values[position+1:]
            values=[value for value in values if not q or any(q in _fold(value[key] or '') for key in ('label','id','email'))]
            selected=bounded(values,normalized['limit'])
            return {'kind':kind,'items':selected,'next_cursor':self._cursor('options',normalized,{'kind':kind,'id':selected[-1]['id']}) if len(values)>len(selected) else None,'content_revision':self.state['revision']}

    def change(self,body,unpublish=False):
        require(isinstance(body,dict),'Invalid content change')
        allowed={'kind','id','review_revision'} if unpublish else {'kind','id','review_revision','operation','member_id','group_id','permissions'}
        require(set(body)<=allowed and body.get('kind') in ('page','database','row') and _id(body.get('id')) and isinstance(body.get('review_revision'),str) and HASH.fullmatch(body['review_revision']) is not None,'Invalid content change')
        operation='unpublish' if unpublish else body.get('operation')
        extras={'set_private':set(),'revoke_member':{'member_id'},'remove_group':{'group_id'},'replace_permissions':{'permissions'},'unpublish':set()}
        require(operation in extras and set(body)=={'kind','id','review_revision'}|({'operation'} if not unpublish else set())|extras[operation],'Invalid content operation')
        with self.store.transaction():
            self._pin('content.publish.manage' if unpublish else 'content.permissions.manage')
            doc=self.by_key.get((body['kind'],body['id']));require(doc is not None,'Content not found',404)
            require(hmac.compare_digest(body['review_revision'],self._review(doc)),'Content changed; review again',409)
            value=self.store.get(body['kind'],body['id'])
            if unpublish:
                require(body['kind']!='row','Rows cannot be unpublished')
                kind='site' if body['kind']=='page' else 'form';field='page_id' if kind=='site' else 'database_id'
                for publication in self.sites if kind=='site' else self.forms:
                    if publication.get(field)==body['id'] and bool(publication.get('published')):
                        publication['published']=False
                        self.store.put(kind,publication)
            else:
                if operation=='set_private':permissions={'default':'private','inherit':False,'members':{},'groups':{}}
                elif operation=='replace_permissions':permissions=Access(self.reader,self.principal).validate_permissions(body['permissions'])
                else:
                    permissions=Access(self.reader,self.principal).validate_permissions(value.get('permissions') if value.get('permissions') is not None else {'default':'workspace','inherit':True,'members':{},'groups':{}})
                    if operation=='revoke_member':
                        identity=body['member_id'];require(_id(identity) and identity in self.members,'Invalid member')
                        require(identity!=self._implicit(doc) and self.members[identity]['role']!='owner','Implicit owner access cannot be revoked',409)
                        permissions.setdefault('members',{})[identity]='none'
                    else:
                        identity=body['group_id'];require(_id(identity) and identity in self.groups,'Invalid group')
                        require(isinstance(permissions.get('groups'),dict) and permissions['groups'].get(identity) in ('view','comment','edit','full'),'No direct positive group grant',409)
                        del permissions['groups'][identity]
                    permissions=Access(self.reader,self.principal).validate_permissions(permissions)
                value['permissions']=permissions;self.store.put(body['kind'],value)
            revision=self.store.meta('access_revision',0);require(type(revision) is int and 0<=revision<9007199254740991,'Invalid access revision',503)
            self.store.set_meta('access_revision',revision+1)
            self.store.audit('admin.content.'+operation,{'kind':body['kind'],'id':body['id']},self.principal.get('id'))
            return {'applied':True}

    def csv(self,query):
        normalized,cursor=content_query(query)
        with self.store.transaction():
            self._pin('content.search.export')
            expected=self.state['revision']
        def check():
            self._authorize('content.search.export')
            require(self.state['revision']==expected,'Content changed during export',409)
        def encode(values,user=True):
            output=io.StringIO(newline='')
            writer=csv.writer(output,quoting=csv.QUOTE_ALL,lineterminator='\r\n')
            writer.writerow(["'"+v if user and isinstance(v,str) else '' if v is None else 'true' if v is True else 'false' if v is False else v for v in values])
            return output.getvalue().encode('utf-8')
        def pieces(value):
            for offset in range(0,len(value),65536):
                with self.store.transaction():check()
                yield value[offset:offset+65536]
        def rows():
            with self.store.transaction():check()
            yield encode(CSV_COLUMNS,False)
            search_query={key:[value[0]] for key,value in query.items()}
            search_cursor=cursor
            while True:
                with self.store.transaction():
                    check()
                    if search_cursor is not None:search_query['cursor']=[search_cursor]
                    result=self.search(search_query)
                    require(result['content_revision']==expected,'Content changed during export',409)
                for item in result['items']:
                    location=item['location'] or {};creator=item['creator'] or {};editor=item['last_editor'] or {}
                    summary=item['access_summary'];publication=item['publication']
                    values=[item['kind'],item['id'],item['title'],item['status'],location.get('kind'),location.get('id'),location.get('title'),creator.get('id'),creator.get('name'),creator.get('cause'),item['created_at'],editor.get('id'),editor.get('name'),editor.get('cause'),item['edited_at'],item['audience'],summary['implicit_owner_id'],summary['internal_count'],summary['external_count'],True,publication['state'],publication['site_count'],publication['form_count']]
                    # The final cell is streamed: no all-viewer JSON/list buffer.
                    yield from pieces(encode(values)[:-2]+b",\"'[")
                    access_query={'kind':[item['kind']],'id':[item['id']],'limit':['100']}
                    first=True
                    while True:
                        with self.store.transaction():
                            check()
                            page=self.access(access_query)
                            require(page['content_revision']==expected,'Content changed during export',409)
                        raw=[]
                        for viewer in page['items']:
                            raw.append(('' if first else ',')+canonical(viewer));first=False
                        yield from pieces(''.join(raw).replace('"','""').encode('utf-8'))
                        if page['next_cursor'] is None:break
                        access_query['cursor']=[page['next_cursor']]
                    yield from pieces(b']"\r\n')
                search_cursor=result['next_cursor']
                if search_cursor is None:break
            with self.store.transaction():check()
        return rows()
