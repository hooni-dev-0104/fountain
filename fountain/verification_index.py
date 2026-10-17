"""Body-free local Inbox projections; never use these records for mutation."""
import copy

VERIFICATION_INDEX_META_KEY = 'database_verification_rows_v1'
DATABASE_INDEX_FIELDS = ('id','name','title','icon','parent_id','owner_id','teamspace_id','permissions','row_permissions','archived','deleted','deleted_at','created_at','updated_at')
ROW_INDEX_FIELDS = ('id','database_id','owner_id','permissions','archived','deleted','deleted_at','created_at','updated_at','verification_cycle')
DESCRIPTOR_INDEX_FIELDS = ('id','name','type','generation','initial_default','limit','default','owner_property_id')
STAMP_INDEX_FIELDS = ('generation','verified_by','verified_at','expires_at')

def invalid():
    from .core import require
    require(False, 'Workspace database verification index is unavailable', 503)

def valid_id(value):
    return isinstance(value,str) and 0<len(value)<=160

def pick(value,fields):
    return {key:copy.deepcopy(value[key]) for key in fields if key in value}

def positive(value):
    return type(value) is int and 0<value<=9007199254740991

def project_verification_database(database):
    if not isinstance(database,dict) or not valid_id(database.get('id')) or not isinstance(database.get('properties'),list):return invalid()
    properties=database['properties']
    if any(not isinstance(p,dict) or not valid_id(p.get('id')) or not isinstance(p.get('type'),str) for p in properties):return invalid()
    if len({p['id'] for p in properties})!=len(properties):return invalid()
    owners=[p for p in properties if p['type']=='owner'];verifications=[p for p in properties if p['type']=='verification']
    if len(owners)>1 or len(verifications)>1:return invalid()
    if not owners or not verifications:return None
    owner,verification=owners[0],verifications[0]
    if not positive(owner.get('generation')) or owner.get('initial_default') not in ('created_by','none') or owner.get('default') not in ('created_by','none') or owner.get('limit') not in ('one','unlimited') or not positive(verification.get('generation')) or verification.get('owner_property_id')!=owner['id']:return invalid()
    title=next((p for p in properties if p['type']=='title'),None);policy=database.get('row_permissions');assignment=policy.get('property_id') if isinstance(policy,dict) and policy.get('mode')=='assigned' else None
    result=pick(database,DATABASE_INDEX_FIELDS);result['properties']=[pick(p,DESCRIPTOR_INDEX_FIELDS) for p in properties if p is owner or p is verification or p is title or p['id']==assignment]
    return result

def verification_property_keys(database):
    owner=next(p for p in database['properties'] if p['type']=='owner');title=next((p for p in database['properties'] if p['type']=='title'),{})
    policy=database.get('row_permissions');assignment=policy.get('property_id') if isinstance(policy,dict) and policy.get('mode')=='assigned' else None
    return list(dict.fromkeys(v for v in (owner['id'],title.get('id'),assignment) if valid_id(v)))

def project_verification_row(row,database):
    if not isinstance(row,dict) or not valid_id(row.get('id')) or row.get('database_id')!=database['id']:return invalid()
    if 'verification' not in row:return None
    if not isinstance(row.get('properties'),dict):return invalid()
    result=pick(row,ROW_INDEX_FIELDS);owner=next(p for p in database['properties'] if p['type']=='owner')
    result['properties']=pick(row['properties'],verification_property_keys(database))
    if '_owner_generations' in row:
        value=row['_owner_generations'];result['_owner_generations']=pick(value,(owner['id'],)) if isinstance(value,dict) else copy.deepcopy(value)
    value=row['verification'];result['verification']=pick(value,STAMP_INDEX_FIELDS) if isinstance(value,dict) else copy.deepcopy(value)
    return result

def project_verification_index(databases,rows):
    selected=[value for db in databases if (value:=project_verification_database(db)) is not None];by_id={db['id']:db for db in selected}
    if len(by_id)!=len(selected):return invalid()
    result=[];ids=set()
    for row in rows:
        db=by_id.get(row.get('database_id'))
        if db is None or 'verification' not in row:continue
        value=project_verification_row(row,db)
        if value['id'] in ids:return invalid()
        ids.add(value['id']);result.append(value)
    return {'databases':selected,'rows':result}

class InboxStoreReader:
    """Request-local, detached projections. SQLite rollback advances total_changes.

    CloudStore owns the reserved metadata implementation in TypeScript; Python
    does not provide a service metadata bypass or a remote full-body fallback.
    """
    def __init__(self,store):
        from .wiki import page_header_reader
        self.store=store;self.pages=page_header_reader(store);self._marker=None;self._cached=None
    def _index(self):
        revision=self.store.meta('_entity_revision');generation=getattr(getattr(self.store,'db',None),'total_changes',None)
        cacheable=type(revision) is int and type(generation) is int;marker=(revision,generation)
        if cacheable and marker==self._marker and self._cached is not None:return self._cached
        value=project_verification_index(self.store.list('database'),self.store.list('row'))
        if cacheable:self._marker=marker;self._cached=value
        return value
    def get(self,kind,identity):
        if kind not in ('database','row'):return self.pages.get(kind,identity)
        if not valid_id(identity):return None
        return next((copy.deepcopy(value) for value in self._index()['databases' if kind=='database' else 'rows'] if value['id']==identity),None)
    def list(self,kind):
        return copy.deepcopy(self._index()['databases' if kind=='database' else 'rows']) if kind in ('database','row') else self.pages.list(kind)
    def meta(self,key,fallback=None):return copy.deepcopy(self._index()) if key==VERIFICATION_INDEX_META_KEY else self.store.meta(key,fallback)
    @property
    def requestTime(self):return getattr(self.store,'requestTime',None)

def inbox_store_reader(store):
    return store if isinstance(store,InboxStoreReader) else InboxStoreReader(store)
