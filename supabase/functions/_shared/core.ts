import {DatabaseVerification,prepareSchema,protectRow,pair} from './database-verification.ts';
import {protectFields,stampCreated,guardMove} from './wiki.ts';
/** Synchronous domain staging port of fountain/core.py. Authorization wraps this
* primitive; only CloudStore.commit may perform the eventual external write. */
import {
  Access,
  APIError,
  casefold,
  clone,
  get,
  has,
  is_object,
  put_key,
  require,
  truth
} from './access.ts';
import type {
  Entity,
  StoreReader
} from './access.ts';
import {
  MissingSelection
} from './store.ts';
import * as taskModule from './tasks.ts';
import {
  normalize_blocks as normalizeCRDT,
  validate_marks
} from './crdt.ts';
export {
  validate_marks
} from './crdt.ts';
export interface CoreStore extends StoreReader {
  with_content_actor?<T>(origin:{member_id:string;cause:'human'|'automation'|'import'|'public_form'},action:()=>T):T;
  requestTime?: string;
  context?: {
    memberId: string
  };
  allocate_id(kind: string): string;
  put(kind: string, data: Entity): Entity;
  delete(kind: string, id: unknown): void;
  set_meta(key: string, value: any): any;
  audit(action: string, details: Entity, user?: string): Entity;
  transaction<T>(callback: (store: any) => T): T;
}
type Options = {
  actor?: string;
  access?: Access;
  uid?: () => string;
  tasks?: typeof taskModule;
  normalizeBlocks?: (blocks: unknown) => Entity[]
};
const uuid = () => crypto.randomUUID().replaceAll('-', '');
const count = (value: string) => Array.from(value).length;
export function text(value: unknown, name: string, limit = 10000, empty = true): string {
  require(typeof value === 'string', name + ' must be text');
  require(count(value) <= limit && (empty || value.trim()), 'Invalid ' + name);
  return value;
}
export function compareText(a: string, b: string): number {
  const first = Array.from(a),
  second = Array.from(b);
  for (let i = 0; i < Math.min(first.length, second.length); i++) {
    const difference = first[i].codePointAt(0)! - second[i].codePointAt(0)!;
    if (difference) return difference;
  }
  return first.length - second.length;
}
export const PROPERTY_TYPES = new Set(['title','text','number','select','multi_select','date','checkbox','person','url','email','status','relation','rollup','formula','files','created_time','last_edited_time','owner','verification']);

export function normalize_blocks(blocks: unknown, uid: () => string = uuid): Entity[] {
  return normalizeCRDT(blocks, uid);
}
function equal(a: any, b: any): boolean {
  if (a === b || (typeof a === 'number' || typeof a === 'boolean') && (typeof b === 'number' || typeof b === 'boolean') && Number(a) === Number(b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value,index) => equal(value,b[index]));
  if (is_object(a) && is_object(b)) return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => has(b,key) && equal(a[key],b[key]));
  return false;
}
function compareValues(a: any, b: any): number | null {
  if (['number','boolean'].includes(typeof a) && ['number','boolean'].includes(typeof b)) return Number(a)-Number(b);
  if (typeof a==='string' && typeof b==='string') return compareText(a,b);
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let index=0;index<Math.min(a.length,b.length);index++) {
      if (equal(a[index],b[index])) continue;
      return compareValues(a[index],b[index]);
    }
    return a.length-b.length;
  }
  return null;
}
function repr(value: any): string {
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'string') {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    return quote + value.replace(/\\/g,'\\\\').replaceAll(quote,'\\'+quote).replace(/\n/g,'\\n').replace(/\r/g,'\\r').replace(/\t/g,'\\t') + quote;
  }
  if (Array.isArray(value)) return '[' + value.map(repr).join(', ') + ']';
  if (is_object(value)) return '{' + Object.entries(value).map(([key,item]) => repr(key)+': '+repr(item)).join(', ') + '}';
  return String(value);
}
function str(value: any): string {
  return typeof value === 'string' ? value : repr(value);
}
export function block_depths(blocks: Entity[]): Entity {
  const parents = new Map(blocks.map(block => [block.id,get(block,'parent_id')])),
  depths: Entity = {
  };
  for (const block of blocks) {
    const seen = new Set([block.id]);
    let parent = parents.get(block.id),
    depth = 0;
    while (parents.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      depth++;
      parent = parents.get(parent);
    } put_key(depths,block.id,Math.min(depth,20));
  }
  return depths;
}
export function inline_markdown(block: Entity): string {
  return (truth(get(block,'rich_text')) ? block.rich_text : [{
    text:get(block,'text',''),marks:{
    }
  }]).map((token: Entity) => {
    const marks = validate_marks(get(token,'marks',{
    })); let content = get(token,'text','');
    if (marks.code) {
      const fence = '`'.repeat(Math.max(0,...(content.match(/`+/g) ?? []).map((item: string) => item.length))+1);
       content = fence + (content.startsWith('`') ? ' ' : '') + content + (content.endsWith('`') ? ' ' : '') + fence;
      
    }
    else content = content.replace(/([\\`*_\[\]<>])/g,'\\$1');
    for (const [mark,delimiter] of [['bold','**'],['italic','*'],['strike','~~']]) if (marks[mark]) content = delimiter+content+delimiter;
    if (marks.underline) content = '<u>'+content+'</u>';
    if (marks.link) content = '['+content+']('+marks.link.replace(/\(/g,'%28').replace(/\)/g,'%29').replace(/</g,'%3C').replace(/>/g,'%3E')+')';
    return content;
  }).join('');
}
export class WorkspaceCore {
  store: CoreStore;
  actor: string;
  access?: Access;
  tasks: typeof taskModule;
  private uid: () => string;
  private normalizer: (blocks: unknown) => Entity[];
  constructor(store: CoreStore, options: Options = {
  }) {
    this.store=store;
    this.actor=options.actor ?? store.context?.memberId ?? 'local';
    this.access=options.access;
    this.uid=options.uid ?? uuid;
    this.tasks=options.tasks ?? taskModule;
    this.normalizer=options.normalizeBlocks ?? ((blocks) => normalize_blocks(blocks,this.uid));
    // Construction never seeds or performs I/O. Existing migrated data is authoritative.
  }
  private id(kind: string): string {
    return this.store.allocate_id(kind);
  }
  private now(): string {
    return this.store.requestTime ?? new Date().toISOString();
  }
  private graph() {
    return new this.tasks.TaskGraph(this.store,{
      uid:()=>this.id('row')
    });
  }
  snapshot(): Entity {
    return {
      workspace_id:this.store.meta('workspace_id'),
      pages:this.store.list('page'),
      databases:this.store.list('database'),
      teamspaces:this.store.list('teamspace'),
      members:this.store.list('member'),
      settings:this.store.meta('settings',{
      })
    };
  }
  page(id: unknown): Entity {
    const page=this.store.get('page',id);
    require(page !== null,'Page not found',404);
    return page;
  }
  detail(id: string): Entity {
    const page=this.page(id);
    return {
      page,
      blocks:get(page,'blocks',[]),
      versions:this.store.list('version').filter(item=>item.page_id===id).sort((a,b)=>compareText(b.created_at,a.created_at)),
      comments:this.store.list('comment').filter(item=>item.page_id===id)
    };
  }
  create_page(body: Entity): Entity {
    protectFields(body);
    const title=text(get(body,'title','제목 없음'),'title',500);
    if(truth(get(body,'id')))require(this.store.get('page',body.id)===null,'Page id already exists',409);
    const parent=get(body,'parent_id');
    if(truth(parent))this.page(parent);
    const page=this.store.put('page',{
      id:truth(get(body,'id'))?body.id:this.id('page'),title,icon:text(get(body,'icon','📄'),'icon',80),cover:text(get(body,'cover',''),'cover',4000),parent_id:parent,teamspace_id:get(body,'teamspace_id','general'),favorite:false,owner_id:get(body,'owner_id',this.actor),permissions:has(body,'permissions')?clone(body.permissions):null,archived:false,locked:false,revision:0,blocks:this.validate_blocks(get(body,'blocks',[]))
    });
    stampCreated(this.store,page,this.actor);
    this.store.audit('page.created',{
      page_id:page.id
    });
    return page;
  }
  update_page(id: string, body: Entity): Entity {
    protectFields(body);
    const page=this.page(id);
    this.check_revision(page,get(body,'revision'));
    if(has(body,'parent_id'))guardMove(page,body.parent_id);
    for(const field of ['title','icon','cover'])if(has(body,field))page[field]=text(body[field],field,field==='title'?500:4000);
    for(const field of ['favorite','archived','locked'])if(has(body,field)){
      require(typeof body[field]==='boolean',field+' must be boolean');
      page[field]=body[field];
    }
    if(body.archived===true&&!has(page,'deleted_at'))page.deleted_at=this.now();
    if(body.archived===false)delete page.deleted_at;
    if(has(body,'parent_id')){
      let parent=body.parent_id;
      const visited=new Set([id]);
      while(truth(parent)){
        require(!visited.has(parent),'Page hierarchy cannot contain cycles');
        visited.add(parent);
        parent=get(this.page(parent),'parent_id');
      }page.parent_id=body.parent_id;
    }
    page.revision++;
    this.store.audit('page.updated',{
      page_id:id
    });
    return this.store.put('page',page);
  }
  check_revision(page: Entity, revision: any): void {
    if(revision!==null)require(Number.isSafeInteger(revision)&&revision===page.revision,'Document changed. Reload before saving.',409);
  }
  validate_blocks(blocks: unknown): Entity[] {
    return this.normalizer(blocks);
  }
  save_blocks(id: string, blocks: unknown, revision: any = null): Entity {
    return this.store.transaction(()=>{
      let page=this.page(id);require(!truth(get(page,'locked')),'Page is locked',423);this.check_revision(page,revision);const normalized=this.validate_blocks(blocks);
      this.store.put('version',{
        page_id:id,revision:page.revision,title:page.title,blocks:get(page,'blocks',[])
      });page.blocks=normalized;page.revision++;page=this.store.put('page',page);this.store.delete('collaboration',id);this.store.audit('page.saved',{
        page_id:id,revision:page.revision
      });return {
        page,blocks:normalized,revision:page.revision
      };
    });
  }
  restore_version(id: string, versionId: string): Entity {
    return this.store.transaction(()=>{
      const version=this.store.get('version',versionId);
      require(version&&version.page_id===id,'Version not found',404);
      const title=text(get(version,'title',this.page(id).title),'title',500),restored=this.save_blocks(id,version.blocks);
      restored.page.title=title;
      restored.page=this.store.put('page',restored.page);
      return restored;
      
    });
  }
  search(query: unknown): Entity {
    const folded=casefold(text(query,'query',500)),
    pages=this.store.list('page').filter(page=>!truth(get(page,'archived'))&&(casefold(page.title).includes(folded)||get(page,'blocks',[]).some((block:Entity)=>casefold(get(block,'text','')).includes(folded))));
    
    return {
      results:pages,
      pages
    };
  }
  create_comment(id: string, body: Entity): Entity {
    this.page(id);
    const member=this.store.get('member',this.actor) ?? {
    },
    comment=this.store.put('comment',{
      page_id:id,text:text(get(body,'text',''),'comment',10000,false),block_id:get(body,'block_id'),author:this.actor,author_name:get(member,'name','나'),resolved:false
    });
    this.store.audit('comment.created',{
      page_id:id,id:comment.id
    });
    return comment;
  }
  resolve_comment(id: string, body: Entity): Entity {
    const comment=this.store.get('comment',id);
    require(comment,'Comment not found',404);
    require(typeof body.resolved==='boolean','resolved must be boolean');
    comment.resolved=body.resolved;
    this.store.audit('comment.resolved',{
      page_id:comment.page_id,id
    });
    return this.store.put('comment',comment);
  }
  database(id: unknown): Entity {
    const database=this.store.get('database',id);
    require(database!==null,'Database not found',404);
    return database;
  }
  validate_properties(properties: any): Entity[] {
    require(Array.isArray(properties)&&properties.length>0&&properties.length<=100,'Provide 1 to 100 properties');
    const ids=new Set();
    for(const prop of properties){
      require(is_object(prop),'Property must be an object');
      const generated=this.uid();
      if(!has(prop,'id'))prop.id=generated;
      text(prop.id,'property id',160,false);
      text(get(prop,'name',''),'property name',200,false);
      require(PROPERTY_TYPES.has(get(prop,'type')),'Unsupported property type');
      require(!ids.has(prop.id),'Duplicate property id');
      ids.add(prop.id);
      if(prop.type==='formula')this.tasks.formula_tree(get(prop,'expression',get(prop,'formula','')));
      if(prop.type==='relation'&&get(prop,'database_id')!==null)text(prop.database_id,'relation database',160,false);
      if(prop.type==='rollup'){
        require(['sum','count','average','min','max'].includes(get(prop,'aggregation')),'Invalid rollup aggregation');
        text(get(prop,'target_property'),'rollup target',160,false);
      }
    }
    const known=new Map(properties.map(prop=>[prop.id,prop]));
    for(const prop of properties)if(prop.type==='rollup')require(known.get(prop.relation_property)?.type==='relation','Rollup requires a relation property');
    return properties;
  }
  create_database(body: Entity): Entity {
    if(truth(get(body,'id')))require(this.store.get('database',body.id)===null,'Database id already exists',409);
    const database:Entity={
      id:truth(get(body,'id'))?body.id:this.id('database'),
      name:text(get(body,'name','새 데이터베이스'),'name',500,false),
      owner_id:get(body,'owner_id',this.actor),
      teamspace_id:get(body,'teamspace_id','general'),
      permissions:has(body,'permissions')?clone(body.permissions):null,
      row_permissions:clone(get(body,'row_permissions',{
      })),
      icon:get(body,'icon','📊'),
      properties:this.validate_properties(clone(get(body,'properties',[{
        id:'name',name:'이름',type:'title'
      }]))),
      views:get(body,'views',[{
        id:'table',name:'테이블',type:'table'
      }])
    };
    require(!has(body,'_property_generation')&&!has(body,'schema_revision'),'Property generations are server managed');
    prepareSchema(this.store,database,database.properties);
    database.task_settings=this.tasks.validate_settings(get(body,'task_settings',{
    }),database);
    return this.store.put('database',database);
  }
  validate_values(database: Entity, values: any, relationRows?: Map<string,Entity>): Entity {
    require(is_object(values),'properties must be an object');
    const known=new Map(database.properties.map((prop:Entity)=>[prop.id,prop]));
    for(const [key,value] of Object.entries(values)){
      require(known.has(key),'Unknown property: '+key);
      const prop:any=known.get(key),
      kind=prop.type;
      require(!['formula','rollup','verification'].includes(kind),key+' is computed and cannot be assigned');
      if(kind==='owner'){require(Array.isArray(value)&&value.length<=1000&&value.every(Access.verification_id),'Owner must be a member ID list');continue;}
      if(value===null)continue;
      if(kind==='number')require(typeof value==='number'&&Math.abs(value)<1e15,key+' must be a finite number');
      else if(kind==='checkbox')require(typeof value==='boolean',key+' must be boolean');
      else if(kind==='date')put_key(values,key,this.tasks.validate_date_value(value));
      else if(['multi_select','relation','files'].includes(kind)){
        require(Array.isArray(value)&&value.length<=1000,key+' must be a list');
        if(kind==='relation'){
          require(value.every(id=>typeof id==='string'),'Relation values must be row ids');
          require(new Set(value).size===value.length,'Duplicate relation row');
          for(const id of value){
            const target=relationRows?relationRows.get(id):this.store.get('row',id);
            require(target&&(!truth(get(prop,'database_id'))||target.database_id===prop.database_id),'Relation target row not found in target database');
          }
        }
      }
      else text(value,key,100000);
    }return values;
  }
  create_row(databaseId: string, body: Entity): Entity {
    protectRow(body);
    return this.store.transaction(()=>{
      const database=this.database(databaseId),id=text(truth(get(body,'id'))?body.id:this.id('row'),'row id',160,false);
      require(this.store.get('row',id)===null,'Row id already exists',409);
      
      const settings=get(database,'task_settings',{
      }),hasLinks=[get(body,'parent_row_id'),get(body,'depends_on'),get(settings,'subitems'),get(settings,'dependencies')].some(truth);
      const links=hasLinks?this.graph().prepare_row(database,id,body):{
        parent_row_id:null,depends_on:[]
      };if(!hasLinks)require(get(body,'parent_row_id')===null&&equal(get(body,'depends_on',[]),[]),'Enable task links before adding them');
      let row:Entity={id,database_id:databaseId,owner_id:this.actor,properties:this.validate_values(database,clone(get(body,'properties',get(body,'values',{})))),...links};
      new DatabaseVerification(this.store,this.access).apply_values(database,row,row.properties);
      row=this.store.put('row',row);this.store.audit('row.created',{
        database_id:databaseId,row_id:row.id
      });return row;
    });
  }
  update_row(databaseId: string, id: string, body: Entity, canEdit?: (row:Entity)=>boolean): Entity {
    protectRow(body);
    return this.store.transaction(()=>{
      const database=this.database(databaseId);
      let row=this.store.get('row',id);
      require(row&&row.database_id===databaseId,'Row not found',404);
      canEdit??=this.access?(item=>this.access!.can('row',item,3)):undefined;
      require(!canEdit||canEdit(row),'Insufficient row edit permission',403);
      
      const previous=clone(row),values=this.validate_values(database,get(body,'properties',get(body,'values',{
      })));for(const [key,value]of Object.entries(values))put_key(row.properties,key,value);
      new DatabaseVerification(this.store,this.access).apply_values(database,row,values,previous);
      const graph=this.graph(),settings=get(database,'task_settings',{
      }),hasLinks=[get(previous,'parent_row_id'),get(previous,'depends_on'),get(settings,'subitems'),get(settings,'dependencies'),get(body,'parent_row_id'),get(body,'depends_on')].some(truth);
      
      if(hasLinks)Object.assign(row,graph.prepare_row(database,id,body,{
        existing:previous
      }));else require(get(body,'parent_row_id')===null&&equal(get(body,'depends_on',[]),[]),'Invalid task links');
      const shifted=truth(get(settings,'dependencies'))?graph.plan_shift(database,previous,row,{
        can_edit:canEdit
      }):[];row=this.store.put('row',row);this.store.audit('row.updated',{
        database_id:databaseId,row_id:id
      });for(const dependent of shifted){
        this.store.put('row',dependent);this.store.audit('row.schedule.shifted',{
          database_id:databaseId,row_id:dependent.id,source_row_id:id
        });
      }return row;
    });
  }
  delete_row(databaseId:string,id:string,canEdit?: (row:Entity)=>boolean):Entity {
    return this.store.transaction(()=>{
      this.database(databaseId);
      const root=this.store.get('row',id);
      require(root&&root.database_id===databaseId,'Row not found',404);
      const hasChildren=this.store.list('row').some(row=>row.database_id===databaseId&&get(row,'parent_row_id')===id),deleted=hasChildren?this.graph().descendants(databaseId,id):[root];
      require(!canEdit||deleted.every(canEdit),'Cannot delete a subitem without edit permission',403);
      const ids=new Set(deleted.map(row=>row.id));
      
      for(const row of this.store.list('row'))if(row.database_id===databaseId&&!ids.has(row.id)&&get(row,'depends_on',[]).some((key:string)=>ids.has(key))){
        row.depends_on=row.depends_on.filter((key:string)=>!ids.has(key));this.store.put('row',row);
      }for(const row of deleted){
        this.store.delete('row',row.id);this.store.audit('row.deleted',{
          database_id:databaseId,row_id:row.id
        });
      }return {
        deleted:true,count:ids.size
      };
    });
  }
  duplicate_row(databaseId:string,id:string,canRead?: (row:Entity)=>boolean):Entity {
    return this.store.transaction(()=>{
      const planned=this.graph().duplicate_plan(databaseId,id,this.actor,canRead),database=this.database(databaseId),resolver=new DatabaseVerification(this.store,this.access),rows=planned.map(item=>this.store.put('row',resolver.apply_values(database,item,{},null,true)));
      for(const row of rows)this.store.audit('row.duplicated',{
        database_id:databaseId,row_id:row.id,source_row_id:id
      });return {
        root_id:rows[0].id,rows
      };
    });
  }
  computed_rows(database:Entity,rows:Entity[],canRead?: (row:Entity)=>boolean):Entity[] {
    const resolver=new DatabaseVerification(this.store,this.access),sources=new Map(rows.map(row=>[row.id,row]));
    if(pair(database)[0])rows=rows.map(row=>resolver.project(database,row));
    const cache=new Map<string,
    any>(),
    databases=new Map([[database.id,database]]);
    const numberKinds=new Map<string,'int'|'float'>();
    const resolve=(row:Entity,key:string,trail:string[]=[]):any=>{
      const token=JSON.stringify([row.id,key]);
      if(trail.includes(token))throw new Error('Circular formula or rollup reference');
      if(trail.length>50)throw new Error('Computed dependency chain is too deep');
      if(cache.has(token))return cache.get(token);
      if(!databases.has(row.database_id))databases.set(row.database_id,this.database(row.database_id));
      const db=databases.get(row.database_id)!;
      const prop=db.properties.find((item:Entity)=>item.id===key)??db.properties.find((item:Entity)=>item.name===key);
      if(!prop)throw new Error('Unknown property: '+key);
      key=prop.id;
      trail=[...trail,
      token];
      let result,numberKind:'int'|'float'|undefined;
      if(prop.type==='formula')result=this.tasks.evaluate_formula(this.tasks.formula_tree(get(prop,'expression',get(prop,'formula',''))),(name:string)=>resolve(row,name,trail),{numberKind:(name:string)=>numberKinds.get(JSON.stringify([row.id,name])),onResult:kind=>{numberKind=kind;}});
      else if(prop.type==='rollup'){
        const related=resolve(row,prop.relation_property,trail)||[];
        let targets=related.map((id:string)=>this.store.get('row',id));
        if(canRead)targets=targets.filter((target:Entity)=>target!==null&&canRead(target));
        if(targets.some((target:Entity)=>target===null))throw new Error('Related row was deleted');
        const resolved=targets.map((target:Entity)=>({value:resolve(target,prop.target_property,trail),kind:numberKinds.get(JSON.stringify([target.id,prop.target_property]))})).filter((entry:any)=>entry.value!==null),
        values=resolved.map((entry:any)=>entry.value),
        aggregation=prop.aggregation;
        if(aggregation==='count')result=values.length;
        else{
          if(values.some((value:any)=>typeof value!=='number'))throw new Error('Rollup requires numeric values');
          result=values.length||aggregation==='sum'?(aggregation==='sum'?values.reduce((sum:number,value:number)=>sum+value,0):aggregation==='average'?values.reduce((sum:number,value:number)=>sum+value,0)/values.length:values.reduce((best:number,value:number)=>aggregation==='min'?(value<best?value:best):(value>best?value:best))):null;
          if(result!==null)numberKind=aggregation==='average'?'float':aggregation==='sum'?(resolved.some((entry:any)=>entry.kind==='float')?'float':'int'):resolved[values.findIndex((value:number)=>value===result)]?.kind;
          
        }
      }
      else if(prop.type==='relation'&&canRead)result=get(row.properties,key,[]).filter((id:string)=>{
        const target=this.store.get('row',id);return target&&canRead(target);
      });
      else if(['owner','verification'].includes(prop.type))result=get(resolver.project(db,sources.get(row.id)??row).properties,key);
      else result=get(row.properties,key);
      cache.set(token,result);
      if(typeof result==='number')numberKinds.set(token,numberKind??(!Number.isInteger(result)||Object.is(result,-0)?'float':'int'));
      return result;
    };
    for(const row of rows){
      const errors:Entity={
      };
      for(const prop of database.properties)if(['formula','rollup'].includes(prop.type)){
        try{
          put_key(row.properties,prop.id,resolve(row,prop.id));
        }catch(error){
          if(error instanceof MissingSelection)throw error;
          put_key(row.properties,prop.id,null);
          put_key(errors,prop.id,error instanceof Error?error.message:String(error));
        }
      }if(Object.keys(errors).length)row.computed_errors=errors;
    }return rows;
  }
  database_detail(id:string,filters:any=null,sorts:any=null,canRead?: (row:Entity)=>boolean):Entity {
    const database=this.database(id);
    let rows=this.store.list('row').filter(row=>row.database_id===id&&(!canRead||canRead(row)));
    rows=this.computed_rows(database,rows,canRead);
    if(truth(filters)){
      require(Array.isArray(filters)&&filters.length<=50,'Invalid filters');
      for(const rule of filters){
        require(is_object(rule),'Invalid filter');
        const key=get(rule,'property'),
        op=get(rule,'operator','equals'),
        value=get(rule,'value');
        require(['equals','not_equals','contains','is_empty','greater_than','less_than'].includes(op),'Invalid filter operator');
        rows=rows.filter(row=>{
          const current=get(row.properties,key);
          if(op==='equals')return equal(current,value);
          if(op==='not_equals')return !equal(current,value);
          if(op==='contains')return casefold(str(truth(current)?current:'')).includes(casefold(str(value)));
          if(op==='is_empty')return current===null||current===''||Array.isArray(current)&&current.length===0;
          const order=compareValues(current,value);
          return order!==null&&(op==='greater_than'?order>0:order<0);
          
        });
      }
    }
    if(truth(sorts)){
      require(Array.isArray(sorts)&&sorts.length<=20,'Invalid sorts');
      for(const rule of [...sorts].reverse()){
        require(is_object(rule),'Invalid sort');
        const key=get(rule,'property'),
        direction=get(rule,'direction')==='descending'?-1:1;
        const tuple=(row:Entity):any[]=>{
          const val=get(row.properties,key);
          return [val===null,
          typeof val==='number'?0:1,
          typeof val==='number'?val:casefold(str(truth(val)?val:''))];
        };
        rows.sort((a,b)=>{
          const x=tuple(a),y=tuple(b);for(let i=0;i<3;i++){
            const delta=typeof x[i]==='string'?compareText(x[i],y[i]):Number(x[i])-Number(y[i]);if(delta)return delta*direction;
          }return 0;
        });
      }
    }
    return {
      database,
      rows
    };
  }
  export(format='json',databaseId?:string):Entity {
    if(format==='csv'){
      const detail=this.database_detail(databaseId||'projects'),
      properties=detail.database.properties;
      const cell=(value:any)=>{
        const raw=value===null?'':str(value);
        return /[",\r\n]/.test(raw)?'"'+raw.replace(/"/g,'""')+'"':raw;
        };
        return {filename:'database.csv',content:[properties.map((prop:Entity)=>cell(prop.name)).join(','),...detail.rows.map((row:Entity)=>properties.map((prop:Entity)=>cell(get(row.properties,prop.id,''))).join(','))].join('\r\n')+'\r\n',mime:'text/csv'};
        }
    if(format==='markdown'){const output:string[]=[];
    for(const page of this.store.list('page')){if(truth(get(page,'archived')))continue;
    output.push('# '+page.title);
    const depths=block_depths(get(page,'blocks',[]));
    for(const block of get(page,'blocks',[])){let content=inline_markdown(block);
    const prefix=get({heading1:'# ',heading2:'## ',heading3:'### ',bullet:'- ',numbered:'1. ',quote:'> ',todo:truth(get(block,'checked'))?'- [x] ':'- [ ] '},block.type,'');
    if(block.type==='code'){const raw=get(block,'text',''),fence='`'.repeat(Math.max(3,Math.max(0,...(raw.match(/`+/g)??[]).map((item:string)=>item.length))+1));
    content=fence+'\n'+raw+'\n'+fence;
    }else content=prefix+content;
    output.push('  '.repeat(depths[block.id])+content);
    }output.push('');
    }return {filename:'workspace.md',content:output.join('\n\n'),mime:'text/markdown'};
    }
    require(format==='json','Unsupported export format');
    const snapshot=this.snapshot();for(const database of snapshot.databases)delete database._property_generation;const resolver=new DatabaseVerification(this.store,this.access),rows=this.store.list('row').map(row=>resolver.project(this.database(row.database_id),row));
    return {filename:'workspace.json',content:JSON.stringify({format:'fountain-v1',...snapshot,rows},null,2),mime:'application/json'};
    
  }
  import_data(body:Entity):Entity { return this.store.transaction(()=>this._import_data(body)); }
  private _import_data(body:Entity):Entity {
    const privateACL={default:'private',inherit:false,members:{},groups:{}},format=get(body,'format','markdown'),content=text(get(body,'content',''),'content',2000000);
    if(format==='markdown'){const lines=content.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
    if(/[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]$/.test(content))lines.pop();
    if(!content)lines.length=0;
    const blocks=lines.map(raw=>{for(const [prefix,type]of [['### ','heading3'],['## ','heading2'],['# ','heading1'],['- ','bullet'],['> ','quote']])if(raw.startsWith(prefix))return {type,text:raw.slice(prefix.length)};
    return {type:'paragraph',text:raw};
    });
    return {page:this.create_page({title:get(body,'title','가져온 문서'),blocks,permissions:privateACL})};
    }
    if(format==='csv'){const records=parseCSV(content);
    require(records.length&&records[0].length>0&&records[0].length<=100,'CSV requires a header with at most 100 columns');
    const names=records.shift()!;
    require(records.length<=10000,'CSV row limit exceeded');
    const properties=names.map((name,index)=>({id:String(index),name,type:index===0?'title':'text'}));
    for(const row of records){require(row.length<=names.length,'CSV row has more fields than header');
    for(const value of row)text(value,'CSV value',100000);
    }const database=this.create_database({name:get(body,'title','가져온 데이터'),properties,permissions:privateACL});
    for(const row of records){const record:Entity={};
    names.forEach((name,index)=>put_key(record,name,row[index]??null));
    this.create_row(database.id,{properties:Object.fromEntries(names.map((name,index)=>[String(index),record[name]]))});
    }return {database,count:records.length};
    }
    require(format==='json','Unsupported import format');
    let data:any;
    try{data=JSON.parse(content);
    }catch{throw new APIError(400,'Invalid JSON import');
    }require(is_object(data)&&Array.isArray(data.pages)&&data.pages.length<=1000,'Invalid workspace import');
    const databases=get(data,'databases',[]),rows=get(data,'rows',[]);
    require(Array.isArray(databases)&&databases.length<=1000,'Invalid imported databases');
    require(Array.isArray(rows)&&rows.length<=100000,'Invalid imported rows');
    const pageIds=new Map<string,Entity>(),databaseIds=new Map<string,Entity>();
    
    for(const page of data.pages){require(is_object(page),'Invalid imported page');
    text(get(page,'title',''),'title',500);
    text(get(page,'icon','📄'),'icon',80);
    text(get(page,'cover',''),'cover',4000);
    this.validate_blocks(get(page,'blocks',[]));
    if(truth(get(page,'id'))){text(page.id,'id',160,false);
    require(!pageIds.has(page.id),'Duplicate imported page');
    pageIds.set(page.id,page);
    }}
    for(const page of data.pages){const visited=new Set([get(page,'id')]);
    let parent=get(page,'parent_id');
    while(truth(parent)){require(pageIds.has(parent)&&!visited.has(parent),'Invalid imported page hierarchy');
    visited.add(parent);
    parent=get(pageIds.get(parent),'parent_id');
    }}
    for(const database of databases){require(is_object(database)&&typeof get(database,'id')==='string','Invalid imported database');
    require(!databaseIds.has(database.id),'Duplicate imported database');
    text(get(database,'name',''),'name',500,false);
    database.properties=this.validate_properties(clone(get(database,'properties')));
    for(const prop of database.properties)for(const key of ['generation','initial_default','owner_property_id'])delete prop[key];delete database._property_generation;delete database.schema_revision;
    databaseIds.set(database.id,database);
    }
    const importedRows=new Map<string,Entity>();
    for(const row of rows){require(is_object(row)&&databaseIds.has(get(row,'database_id')),'Invalid imported row database');
    text(get(row,'id'),'imported row id',160,false);
    require(!importedRows.has(row.id),'Duplicate imported row');
    importedRows.set(row.id,row);
    }
    for(const database of databases)database.task_settings=this.tasks.validate_settings(get(database,'task_settings',{}),database);
    for(const row of rows){require(is_object(row.properties),'Invalid imported row properties');for(const prop of databaseIds.get(row.database_id)!.properties)if(['owner','verification'].includes(prop.type))delete row.properties[prop.id];this.validate_values(databaseIds.get(row.database_id)!,get(row,'properties'),importedRows);
    if(truth(get(row,'parent_row_id'))||truth(get(row,'depends_on')))this.graph().prepare_row(databaseIds.get(row.database_id)!,row.id,row,{existing:row,rows:importedRows});
    }
    const pages:Entity[]=[],pageMap=new Map<string,string>(),databaseMap=new Map<string,string>();
    for(const source of data.pages){const created=this.create_page({title:get(source,'title','제목 없음'),blocks:get(source,'blocks',[]),icon:get(source,'icon','📄'),cover:get(source,'cover',''),permissions:clone(privateACL)});
    pages.push(created);
    if(truth(get(source,'id')))pageMap.set(source.id,created.id);
    }
    data.pages.forEach((page:Entity,index:number)=>{if(truth(get(page,'parent_id'))){const created=pages[index];
    created.parent_id=pageMap.get(page.parent_id);
    created.permissions.inherit=true;
    this.store.put('page',created);
    }});
    
    for(const database of databases)databaseMap.set(database.id,this.id('database'));
    for(const database of databases){const imported=clone(database);
    imported.id=databaseMap.get(database.id);
    Object.assign(imported,{owner_id:this.actor,permissions:clone(privateACL),teamspace_id:'general',row_permissions:{}});
    for(const prop of imported.properties)if(prop.type==='relation'&&databaseMap.has(get(prop,'database_id')))prop.database_id=databaseMap.get(prop.database_id);
    this.create_database(imported);
    }
    const rowMap=new Map<string,string>(rows.map(row=>[row.id,this.id('row')]));
    for(const row of rows){const values=clone(row.properties);
    for(const prop of databaseIds.get(row.database_id)!.properties)if(prop.type==='relation'&&truth(get(values,prop.id)))put_key(values,prop.id,values[prop.id].map((id:string)=>rowMap.get(id)));
    const importedRow={id:rowMap.get(row.id),owner_id:this.actor,database_id:databaseMap.get(row.database_id),properties:values,parent_row_id:rowMap.get(get(row,'parent_row_id'))??null,depends_on:get(row,'depends_on',[]).map((id:string)=>rowMap.get(id))};
    new DatabaseVerification(this.store,this.access).apply_values(this.database(importedRow.database_id!),importedRow,values);this.store.put('row',importedRow);
    }
    return {pages,databases:Array.from(databaseMap.values()),count:pages.length,row_count:rows.length};
  }
}
export { WorkspaceCore as Workspace };
function parseCSV(content:string):string[][] {
  const rows:string[][]=[];let row:string[]=[],value='',quoted=false,started=false;
  for(let index=0;
  index<content.length;
  index++){const char=content[index];
  if(quoted){if(char==='"'){if(content[index+1]==='"'){value+='"';
  index++;
  }else quoted=false;
  }else value+=char;
  }else if(char==='"'&&!started){quoted=true;
  started=true;
  }else if(char===','){row.push(value);
  value='';
  started=false;
  }else if(char==='\n'||char==='\r'){if(char==='\r'&&content[index+1]==='\n')index++;
  if(started||value||row.length){row.push(value);
  rows.push(row);
  }else if(!rows.length)rows.push([]);
  row=[];
  value='';
  started=false;
  }else{value+=char;
  started=true;
  }}
  if(started||value||row.length){row.push(value);rows.push(row);}return rows;
}
