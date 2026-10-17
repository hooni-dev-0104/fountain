"""Wiki hierarchy and knowledge ownership; ownership never grants page access."""
import re
from .access import Access
from .core import require

PROTECTED = {'is_wiki', 'wiki_owner', 'knowledge_owner', 'wiki_page'}

def protect_fields(body):
    require(not (set(body) & PROTECTED), 'Use the wiki endpoint')

def active(page):
    return isinstance(page, dict) and not any(page.get(key) for key in ('archived','deleted','deleted_at'))

def ancestry(store, page):
    if not active(page): return False, None
    if page.get('is_wiki') is True:
        return (True, None) if page.get('parent_id') is None else (False, None)
    visited={page['id']};parent=page.get('parent_id')
    while parent is not None:
        if not Access.verification_id(parent) or parent in visited: return False, None
        visited.add(parent);ancestor=store.get('page',parent)
        if not active(ancestor): return False,None
        if ancestor.get('is_wiki') is True:
            return (True,ancestor) if ancestor.get('parent_id') is None else (False,None)
        parent=ancestor.get('parent_id')
    return True,None

def stamp_created(store,page,actor):
    _,root=ancestry(store,page)
    if root is not None:
        require(Access.verification_id(actor),'Wiki creator is unavailable',409)
        store.put('wiki_page',{'id':page['id'],'page_id':page['id'],'owner_id':actor})

def guard_move(page,parent):
    require(not (page.get('is_wiki') is True and parent is not None),'Wiki roots must remain standalone',409)

def integer(value):
    return type(value) in (int,float) and 0 <= value <= 9007199254740991 and value == int(value)

def title_of(page):
    return page.get('title') if isinstance(page.get('title'),str) else ''

class Wiki:
    def __init__(self,store,access): self.store,self.access=store,access
    def batch(self):
        self.store.list('page');self.store.list('member');self.store.list('wiki_page')
    def page(self,identity,level=1):
        page=self.access.require_resource('page',identity,level)
        require(active(page),'Wiki page not found',404)
        return page
    def owner_id(self,page):
        record=self.store.get('wiki_page',page['id'])
        identity=page.get('owner_id') if record is None else record.get('owner_id') if record.get('page_id')==page['id'] else None
        return identity if self.access.verification_member(identity,page,visible=False) else None
    def public_member(self,identity,page):
        if not self.access.verification_member(identity,page):return None
        member=self.store.get('member',identity)
        return {'id':identity,'name':member.get('name') if isinstance(member.get('name'),str) else ''}
    def current(self,page):
        valid,root=ancestry(self.store,page);require(valid,'Wiki page not found',404)
        return root
    def revision(self,page,body):
        require(integer(body.get('revision')),'A page revision is required')
        revision=page.get('revision',0)
        require(integer(revision) and revision < 9007199254740991 and body['revision']==revision,'Page changed. Reload before saving.',409)
        require(not page.get('locked'),'Page is locked',423)
        return int(revision)
    def owner_view(self,identity):
        self.batch();page=self.page(identity);root=self.current(page)
        if root is None:return {'in_wiki':False,'wiki':None,'owner':None,'members':[],'revision':page.get('revision',0),'can_manage':False,'can_verify':self.access.can('page',page,3)}
        owner=self.owner_id(page);editable=self.access.can('page',page,3)
        members=[value for member in self.store.list('member') if (value:=self.public_member(member.get('id'),page)) is not None]
        members.sort(key=lambda value:(value['name'].casefold(),value['id']))
        return {'in_wiki':True,'wiki':{'id':root['id'],'title':title_of(root)} if self.access.can('page',root) else None,
                'owner':self.public_member(owner,page),'members':members,'revision':page.get('revision',0),
                'can_manage':editable,'can_verify':editable and owner==self.access.member_id}
    def change_owner(self,identity,body):
        require(isinstance(body,dict) and set(body)=={'owner_id','revision'} and Access.verification_id(body['owner_id']),'Invalid wiki owner fields')
        self.batch();page=self.page(identity,3);require(self.current(page) is not None,'Wiki page not found',404);revision=self.revision(page,body)
        require(self.access.verification_member(body['owner_id'],page),'Wiki owner not found',404)
        valid=self.access.project_verification(page)
        if valid and valid['verified_at'] is not None:
            page['verification']={**page['verification'],'owners':[body['owner_id']],'owner':body['owner_id']}
        page['revision']=revision+1;self.store.put('page',page)
        self.store.put('wiki_page',{'id':identity,'page_id':identity,'owner_id':body['owner_id']})
        self.store.audit('wiki.owner.updated',{'page_id':identity})
        return self.owner_view(identity)
    def convert(self,method,identity,body):
        require(isinstance(body,dict) and set(body)=={'revision'},'Invalid wiki fields')
        self.batch();page=self.page(identity,4);revision=self.revision(page,body)
        if method=='POST':
            require(page.get('parent_id') is None,'Wiki roots must be standalone',409)
            require(page.get('is_wiki') is not True,'Page is already a wiki',409)
            # Refuse malformed nested boundaries without changing any descendants.
            for candidate in self.store.list('page'):
                if candidate.get('is_wiki') is not True or candidate['id']==identity:continue
                seen=set();parent=candidate.get('parent_id')
                while Access.verification_id(parent) and parent not in seen:
                    require(parent!=identity,'Nested wikis are not allowed',409);seen.add(parent)
                    ancestor=self.store.get('page',parent)
                    if ancestor is None:break
                    parent=ancestor.get('parent_id')
            page['is_wiki']=True;page['parent_id']=None
        else:
            require(page.get('is_wiki') is True,'Wiki page not found',404);page['is_wiki']=False
        page['revision']=revision+1;self.store.put('page',page);self.store.audit('wiki.updated',{'page_id':identity})
        return {'wiki':{'id':identity,'title':title_of(page),'revision':page['revision']},'is_wiki':page['is_wiki']}
    def view(self,identity,query):
        require(isinstance(query,dict) and set(query)<={'view','q','limit','offset'},'Invalid wiki query')
        values={}
        for key,default in [('view','home'),('q',''),('limit','50'),('offset','0')]:
            value=query.get(key,[default]);require(isinstance(value,list) and len(value)==1 and isinstance(value[0],str),'Invalid wiki query');values[key]=value[0]
        require(values['view'] in {'home','all','owned'} and len(values['q'])<=200,'Invalid wiki query')
        for key,low,high in [('limit',1,100),('offset',0,1000000)]:
            require(bool(re.fullmatch(r'0|[1-9][0-9]{0,6}',values[key])) and low<=int(values[key])<=high,'Invalid wiki '+key);values[key]=int(values[key])
        self.batch();root=self.page(identity);require(root.get('is_wiki') is True and root.get('parent_id') is None,'Wiki page not found',404)
        items=[]
        for page in self.store.list('page'):
            valid,current=ancestry(self.store,page)
            if not valid or current is None or current['id']!=identity or not self.access.can('page',page):continue
            owner=self.owner_id(page)
            if values['view']=='owned' and owner!=self.access.member_id:continue
            title=title_of(page)
            if values['q'].casefold() not in title.casefold():continue
            parent=page.get('parent_id');parent_page=self.store.get('page',parent) if Access.verification_id(parent) else None
            editable=self.access.can('page',page,3)
            items.append({'id':page['id'],'title':title,'icon':page.get('icon') if isinstance(page.get('icon'),str) else None,
                'parent_id':parent if parent_page and self.access.can('page',parent_page) else None,'owner':self.public_member(owner,page),
                'verification':self.access.project_verification(page) if 'verification' in page else None,
                'created_at':page.get('created_at') if isinstance(page.get('created_at'),str) else None,'updated_at':page.get('updated_at') if isinstance(page.get('updated_at'),str) else None,
                'revision':page.get('revision',0),'can_edit':editable,'can_verify':editable and owner==self.access.member_id})
        items.sort(key=lambda item:(item['title'].casefold(),item['id']))
        offset,limit=values['offset'],values['limit']
        return {'wiki':{'id':identity,'title':title_of(root),'revision':root.get('revision',0)},'view':values['view'],
                'items':items[offset:offset+limit],'total':len(items),'has_more':offset+limit<len(items),'offset':offset,'limit':limit,'can_manage':self.access.can('page',root,4)}
    def guard_verify(self,page,owners=None):
        self.batch();root=self.current(page)
        if root is None:return False
        owner=self.owner_id(page);require(owner==self.access.member_id,'Only the wiki page owner can verify',403)
        if owners is not None:require(owners==[owner],'Wiki verification requires its knowledge owner')
        return True
    def route(self,method,identity,kind,body,query):
        if kind=='wiki':
            require(method in {'GET','POST','DELETE'},'Unsupported wiki method',405)
            if method=='GET':return self.view(identity,query)
            require(not query,'Invalid wiki query');return self.convert(method,identity,body)
        require(method in {'GET','PATCH'},'Unsupported wiki owner method',405);require(not query,'Invalid wiki query')
        return self.owner_view(identity) if method=='GET' else self.change_owner(identity,body)
