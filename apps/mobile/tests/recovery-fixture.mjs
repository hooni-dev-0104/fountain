/** Read-only SQLite/native recovery MODEL. Not Android/iOS, OS picker or TLS evidence. */
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,readFile,open,unlink,mkdtemp,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
const C=createRequire(import.meta.url)('../../../static/collaboration.js'); // Pure normalizer/marks only; never execute old RGA.
const level=value=>Number.isSafeInteger(value)&&value>=1&&value<=4;
const RECORD=16*1024*1024,TOTAL=64*1024*1024,ARM=300000,AUTHORITY=120000;
const kinds=new Set(['mutations','operations','drafts','localPages']);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=value=>JSON.stringify(value);
const fail=(code='RECOVERY_STALE')=>Object.assign(new Error('Native recovery request could not be confirmed'),{code});
const need=(value,code)=>{if(!value)throw fail(code);};
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const clone=value=>structuredClone(value);
const identity=value=>{need(typeof value==='string'&&value&&Array.from(value).length<=160&&!/[\\/\u0000-\u001f\u007f]/.test(value)&&!['.','..'].includes(value),'RECOVERY_ACCESS_REQUIRED');return value;};
function bounded(value){const stack=[[value,0]];let nodes=0;while(stack.length){const [item,depth]=stack.pop();need(++nodes<=150000&&depth<=32,'RECOVERY_LIMIT');if(typeof item==='string'){for(const p of item)need(p.codePointAt(0)<0xd800||p.codePointAt(0)>0xdfff,'RECOVERY_ACCESS_REQUIRED');}else if(item&&typeof item==='object')for(const key of Object.keys(item)){need(!['__proto__','prototype','constructor'].includes(key),'RECOVERY_ACCESS_REQUIRED');stack.push([item[key],depth+1]);}else need(item===null||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item),'RECOVERY_ACCESS_REQUIRED');}}
function profile(value){try{const p=value.split('|');need(p.length===4);return{origin:p[0],workspace:decodeURIComponent(p[1]),member:decodeURIComponent(p[2]),binding:decodeURIComponent(p[3])};}catch{throw fail('RECOVERY_ACCESS_REQUIRED');}}
export async function fileDigest(file){const h=createHash('sha256');for await(const bytes of createReadStream(file,{highWaterMark:65536}))h.update(bytes);return h.digest('hex');}
export async function nativeSchema(platform='android'){
  if(platform==='android'){const source=await readFile(new URL('../android/app/src/main/java/dev/fountain/workspace/NativeOutbox.java',import.meta.url),'utf8');const literal=source.match(/SCHEMA = \{([\s\S]*?)\n    \};/)[1];return [...literal.matchAll(/"([^"\n]+)"/g)].map(match=>match[1]).join(';');}
  const source=await readFile(new URL('../ios/App/App/FountainOutbox.swift',import.meta.url),'utf8');return source.match(/static let schema = """([\s\S]*?)"""/)[1];
}
/** Test setup only: production-schema SQLite; recovery model itself never creates it. */
export async function createRecoverySource(file,entries,{platform='android'}={}){
  const db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA;'+await nativeSchema(platform));
  if(platform==='android'){
    db.prepare('INSERT INTO control VALUES(?,?)').run('head','17');db.prepare('INSERT INTO control VALUES(?,?)').run('lease','private-source-lease');
    for(const item of entries)db.prepare('INSERT INTO records(mode,bucket,key,profile_id,resource_key,payload) VALUES(?,?,?,?,?,?)').run(item.mode||'quarantine',item.bucket,json(item.key),item.profileId,item.resourceKey||null,Buffer.from(item.raw??json(item.value)));
  }else{
    db.prepare('INSERT INTO control VALUES(?,?)').run('head',Buffer.from('17'));db.prepare('INSERT INTO control VALUES(?,?)').run('lease',Buffer.from('"private-source-lease"'));
    entries.forEach((item,index)=>db.prepare('INSERT INTO recovery(tx_id,position,bucket,key,profile_id,value) VALUES(?,?,?,?,?,?)').run('source-quarantine',index,item.bucket,json(item.key),item.profileId,Buffer.from(item.raw??json(item.wrapped?{op:'put',bucket:item.bucket,key:item.key,value:item.value}:item.value))));
  }
  db.prepare('INSERT INTO tx_receipts VALUES(?,?,?)').run('source-receipt','a'.repeat(64),17);db.close();await chmod(file,0o600);
}
export class NativeRecoveryModel {
  constructor(file,{origin,generation=1,currentSession,canonical,picker,now=Date.now,fileLimit=RECORD,totalLimit=TOTAL}){
    Object.assign(this,{file,origin,generation,currentSession,canonical,picker,now});this.fileLimit=Math.min(fileLimit,RECORD);this.totalLimit=Math.min(totalLimit,TOTAL);this.inventory=null;this.prepared=new Map();this.recoveryMode=false;this.sqlOpens=0;this.privateDirectory=null;
  }
  async context(){
    const value=await this.currentSession();const s=value?.session;
    need(value?.origin===this.origin&&value.generation===this.generation&&integer(value.authGeneration)&&s?.authenticated===true&&plain(s.member)&&s.member.active!==false,'RECOVERY_AUTH_REQUIRED');
    for(const id of [s.workspace_id,s.member.id,s.cache_binding])need(typeof id==='string'&&id&&id.length<=1000,'RECOVERY_AUTH_REQUIRED');
    const local=s.mode==='local'&&s.required===false&&value.sessionRef===null;
    need(local||['accounts','family'].includes(s.mode)&&/^[0-9a-f]{64}$/.test(value.sessionRef),'RECOVERY_AUTH_REQUIRED');
    const validUntil=local?this.now()+86400000:Date.parse(s.expires_at);need(Number.isFinite(validUntil)&&validUntil>this.now(),'RECOVERY_AUTH_REQUIRED');
    const context={origin:this.origin,workspace:s.workspace_id,member:s.member.id,binding:s.cache_binding,sessionRef:value.sessionRef,authGeneration:value.authGeneration,validUntil};if(this.recoveryContext&&!this.same(context,this.recoveryContext))await this.invalidateContext();this.recoveryContext=context;return context;
  }
  same(a,b){return ['origin','workspace','member','binding','sessionRef','authGeneration'].every(key=>a[key]===b[key]);}
  async source(){
    let stat;try{stat=await lstat(this.file);}catch(error){if(error.code==='ENOENT')return null;throw fail('RECOVERY_STORAGE');}
    need(stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0&&(process.getuid?.()===undefined||stat.uid===process.getuid()),'RECOVERY_STORAGE');
    const parent=await lstat(dirname(this.file));need(parent.isDirectory()&&!parent.isSymbolicLink()&&(parent.mode&0o077)===0,'RECOVERY_STORAGE');
    const db=new DatabaseSync(this.file,{readOnly:true});this.sqlOpens++;
    try{db.exec('PRAGMA query_only=ON');const columns=db.prepare('PRAGMA table_info(records)').all().map(row=>row.name);need(columns.includes('profile_id'),'RECOVERY_STORAGE');const platform=columns.includes('mode')?'android':'ios';const key=platform==='android'?'key':'id';const head=db.prepare(`SELECT value FROM control WHERE ${key}='head'`).get()?.value;
      return{db,platform,fingerprint:json([stat.dev,stat.ino,stat.size,await fileDigest(this.file),String(head??'')])};
    }catch(error){db.close();throw error;}
  }
  *rows(source){
    const {db,platform}=source;
    for(const row of db.prepare(platform==='android'?"SELECT rowid AS row_id,mode,bucket,key,profile_id,resource_key,length(payload) AS bytes FROM records WHERE mode IN ('active','quarantine') ORDER BY rowid":"SELECT rowid AS row_id,'recovery' AS mode,bucket,key,profile_id,NULL AS resource_key,length(value) AS bytes FROM recovery ORDER BY rowid").iterate())yield{...row,table:platform==='android'?'records':'recovery'};
    if(platform==='ios')for(const row of db.prepare("SELECT rowid AS row_id,'active' AS mode,bucket,key,profile_id,resource_key,length(value) AS bytes FROM records ORDER BY rowid").iterate())yield{...row,table:'records'};
  }
  value(source,row){need(row.bytes<=RECORD,'RECOVERY_LIMIT');const field=source.platform==='android'?'payload':'value';const value=source.db.prepare(`SELECT ${field} AS payload FROM ${row.table} WHERE rowid=?`).get(row.row_id)?.payload;need(value,'RECOVERY_STALE');let decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(value));if(source.platform==='ios'&&row.table==='recovery'&&plain(decoded)&&Object.hasOwn(decoded,'op')){need(decoded.op==='put'&&decoded.bucket===row.bucket&&json(decoded.key)===json(JSON.parse(row.key))&&plain(decoded.value)&&decoded.value.profileId===row.profile_id,'RECOVERY_ACCESS_REQUIRED');decoded=decoded.value;}return{value:decoded,digest:hash(value)};}
  category(row,value){if(row.bucket==='localPages'||value?.operation?.kind?.endsWith('.create'))return'local_page';if(row.bucket==='mutations')return'typed';if(['drafts','operations'].includes(row.bucket))return'body';return'unsupported';}
  async recoveryInventory(input){try{return await this.performInventory(input);}catch(error){if(error.code==='RECOVERY_AUTH_REQUIRED')await this.invalidateContext();if(typeof error.code==='string'&&error.code.startsWith('RECOVERY_'))throw error;throw fail('RECOVERY_STORAGE');}}
  async performInventory(input){
    need(input.generation===this.generation&&typeof input.id==='string'&&integer(input.limit)&&input.limit>=1&&input.limit<=100,'RECOVERY_STALE');
    this.recoveryMode=true; // Arm before session HTTP; generic grant/revoke hooks must already be fenced.
    const context=await this.context();let inventory=this.inventory;
    const source=await this.source();
    try{
      if(input.cursor!==null&&input.cursor!==undefined){need(inventory&&this.same(inventory.context,context)&&inventory.deadline>this.now(),'RECOVERY_STALE');need(source?.fingerprint===inventory.fingerprint,'RECOVERY_STALE');}
      else{inventory={token:randomUUID(),context,fingerprint:source?.fingerprint??null,rows:[],deadline:Math.min(context.validUntil,this.now()+ARM),cursors:new Map()};this.inventory=inventory;}
      let offset=0;if(input.cursor!=null){offset=inventory.cursors.get(input.cursor);need(integer(offset),'RECOVERY_STALE');}
      const selected=[];let index=0,more=false;
      if(source)for(const row of this.rows(source)){
        if(!kinds.has(row.bucket))continue;let owner;try{owner=profile(row.profile_id);}catch{continue;}
        if(owner.origin!==context.origin||owner.workspace!==context.workspace||owner.member!==context.member)continue;
        if(index++<offset)continue;if(selected.length===input.limit){more=true;break;}
        let parsed,category='unsupported',state='blocked';try{parsed=this.value(source,row);bounded(parsed.value);need(parsed.value.profileId===row.profile_id,'RECOVERY_ACCESS_REQUIRED');category=this.category(row,parsed.value);state=category==='local_page'?'blocked':'needs_check';}catch{}
        const item={row,handle:randomUUID(),category,state,digest:parsed?.digest};selected.push(item);inventory.rows.push(item);
        need(Buffer.byteLength(json(inventory.rows))<=RECORD,'RECOVERY_LIMIT');
      }
      let next=null;if(more){next=randomUUID();inventory.cursors.set(next,offset+selected.length);}
      return{generation:this.generation,inventoryToken:inventory.token,items:selected.map(item=>({handle:item.handle,category:item.category,recordCount:1,byteLength:item.row.bytes,state:item.state})),next};
    }finally{source?.db.close();}
  }
  async canonicalBody(path,context,cache){
    const match=path.match(/^\/api\/(pages|databases)\/([^/]+)/);
    if(match&&context.source){const current=[context.origin,context.workspace,context.member,context.binding].map((value,index)=>index?encodeURIComponent(value):value).join('|'),scope=current+'|'+(match[1]==='databases'?'database|':'')+encodeURIComponent(decodeURIComponent(match[2])),column=context.source.platform==='android'?'id':'scope';need(!context.source.db.prepare(`SELECT 1 FROM tombstones WHERE kind='resource' AND ${column}=?`).get(scope),'RECOVERY_ACCESS_REQUIRED');}
    if(cache.has(path))return cache.get(path);const result=await this.canonical(path);const body=result.body;
    need(result.status===200,'RECOVERY_ACCESS_REQUIRED');need(body.workspace_id===context.workspace&&body.current_member_id===context.member&&body.session_binding===context.binding&&integer(body.access_revision)&&integer(body.data_revision),'RECOVERY_ACCESS_REQUIRED');cache.set(path,body);return body;
  }
  async editablePage(id,context,cache){const value=await this.canonicalBody('/api/pages/'+encodeURIComponent(identity(id))+'/collaboration',context,cache);need(value.page?.id===id&&level(value.access_level)&&level(value.page.access_level)&&value.access_level>=3&&value.page.access_level>=3&&typeof value.page.locked==='boolean'&&typeof value.page.archived==='boolean'&&!value.page.locked&&!value.page.archived,'RECOVERY_ACCESS_REQUIRED');return value;}
  async database(id,context,cache,level=3){const value=await this.canonicalBody('/api/databases/'+encodeURIComponent(identity(id)),context,cache);need(value.database?.id===id&&Number.isSafeInteger(value.database.access_level)&&value.database.access_level>=level&&value.database.access_level<=4&&typeof value.database.can_create_row==='boolean'&&Array.isArray(value.rows)&&value.rows.every(row=>Number.isSafeInteger(row.access_level)&&row.access_level>=1&&row.access_level<=4&&row.database_id===id),'RECOVERY_ACCESS_REQUIRED');return value;}
  property(property,value,assign=true){
    if(value===null)return;
    const type=property.type;if(['formula','rollup'].includes(type)){need(!assign&&(typeof value==='string'||typeof value==='number'||typeof value==='boolean'),'RECOVERY_ACCESS_REQUIRED');return;}
    if(type==='number')need(typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<1e15,'RECOVERY_ACCESS_REQUIRED');
    else if(type==='checkbox')need(typeof value==='boolean','RECOVERY_ACCESS_REQUIRED');
    else if(['relation','files','multi_select'].includes(type))need(Array.isArray(value)&&value.length<=1000&&value.every(item=>typeof item==='string'),'RECOVERY_ACCESS_REQUIRED');
    else if(type==='date'){const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)&&Number.isFinite(Date.parse(value));need(date(value)||plain(value)&&Object.keys(value).every(key=>['start','end','time_zone'].includes(key))&&date(value.start)&&(value.end==null||date(value.end))&&(value.time_zone==null||typeof value.time_zone==='string'),'RECOVERY_ACCESS_REQUIRED');}
    else need(typeof value==='string'&&Array.from(value).length<=100000,'RECOVERY_ACCESS_REQUIRED');
  }
  async references(operation,context,cache){
    const snapshot=await this.database(operation.database_id,context,cache),props=snapshot.database.properties;
    const row=snapshot.rows.find(row=>row.id===operation.target_id);need(row?.access_level>=3,'RECOVERY_ACCESS_REQUIRED');
    const ref=async(id,databaseId=operation.database_id)=>{if(id==null)return;const value=await this.database(databaseId,context,cache,1);need(value.rows.some(row=>row.id===id&&row.access_level>=1),'RECOVERY_ACCESS_REQUIRED');};
    for(const body of [row,operation.body,operation.base,operation.base?.fields,...Object.values(operation.base_rows||{}),...Object.values(operation.base_rows||{}).map(value=>value.fields)]){
      if(!body)continue;await ref(body.parent_row_id);for(const id of body.depends_on||[])await ref(id);
      for(const key of Object.keys(body.properties||{})){const property=props.find(property=>property.id===key);need(property,'RECOVERY_ACCESS_REQUIRED');if(body!==row)this.property(property,body.properties[key],body===operation.body);}for(const property of props){if(property.type==='relation')for(const id of body.properties?.[property.id]||[])await ref(id,property.database_id||operation.database_id);if(property.type==='files')for(const id of body.properties?.[property.id]||[])await this.attachment(id,cache);}
    }
    for(const id of Object.keys(operation.base_rows||{}))await ref(id);
  }
  async attachment(id,cache){const path='/api/attachments/'+encodeURIComponent(identity(id))+'/metadata',response=await this.canonical(path);need(response.status===200&&response.body.id===id&&response.body.status==='complete'&&integer(response.body.size),'RECOVERY_ACCESS_REQUIRED');cache.set(path,response.body);}
  blocks(value){
    need(Array.isArray(value)&&value.length<=2000,'RECOVERY_LIMIT');
    try{return C.normalizeBlocks(value.map(block=>{need(plain(block),'RECOVERY_ACCESS_REQUIRED');const output={};for(const field of ['id','type','text','parent_id','rich_text','checked','language','attachment_id','size'])if(Object.hasOwn(block,field))output[field]=clone(block[field]);return output;}));}
    catch{throw fail('RECOVERY_ACCESS_REQUIRED');}
  }
  rawOperation(value){
    const specific={'block.insert':['block_id','parent_id','after_id','block_type'],'block.move':['block_id','parent_id','after_id'],'block.set':['block_id','field','value'],'block.delete':['block_id'],'text.insert':['block_id','after_id','text','marks'],'text.delete':['block_id','char_ids'],'text.format':['block_id','char_ids','marks'],'history.cancel':['targets']};
    need(plain(value)&&Object.hasOwn(specific,value.type),'RECOVERY_ACCESS_REQUIRED');
    need(Object.keys(value).every(key=>['id','client','clock','type','group_id','_epoch',...specific[value.type]].includes(key)),'RECOVERY_ACCESS_REQUIRED');
    const operation=clone(value),identifier=(value,maximum=300)=>typeof value==='string'&&value.length>0&&Array.from(value).length<=maximum;
    need(identifier(operation.id)&&identifier(operation.client,80)&&integer(operation.clock)&&operation.clock>0,'RECOVERY_ACCESS_REQUIRED');
    if(operation.type!=='history.cancel')need(identifier(operation.block_id,160),'RECOVERY_ACCESS_REQUIRED');
    for(const field of ['parent_id','after_id'])if(Object.hasOwn(operation,field)&&operation[field]!==null)need(identifier(operation[field]),'RECOVERY_ACCESS_REQUIRED');
    for(const field of ['group_id','_epoch'])if(Object.hasOwn(operation,field))need(identifier(operation[field]),'RECOVERY_ACCESS_REQUIRED');
    if(operation.char_ids!==undefined||operation.type==='history.cancel'){const ids=operation.type==='history.cancel'?operation.targets:operation.char_ids;need(Array.isArray(ids)&&ids.every(value=>identifier(value)),'RECOVERY_ACCESS_REQUIRED');}
    try{
      if(operation.type==='text.insert')C.normalizeBlocks([{id:'validate',type:'paragraph',text:operation.text}]);
      if(['text.insert','text.format'].includes(operation.type))operation.marks=C.validateMarks(operation.marks||{});
      if(operation.type==='block.insert')operation.block_type=C.normalizeBlocks([{id:'validate',type:operation.block_type||'paragraph',text:''}])[0].type;
      if(operation.type==='block.set'){need(['type','checked','language','attachment_id','size'].includes(operation.field),'RECOVERY_ACCESS_REQUIRED');operation.value=C.normalizeBlocks([{id:'validate',type:'paragraph',text:'',[operation.field]:operation.value}])[0][operation.field];}
    }catch{throw fail('RECOVERY_ACCESS_REQUIRED');}
    return operation;
  }
  typed(operation){need(plain(operation)&&plain(operation.body||{})&&['page.patch','row.patch','row.delete'].includes(operation.kind),'RECOVERY_ACCESS_REQUIRED');const result={id:identity(operation.id),kind:operation.kind,target_id:identity(operation.target_id),depends_on:clone(operation.depends_on||[]),body:{}};need(Array.isArray(result.depends_on)&&result.depends_on.every(value=>typeof value==='string'),'RECOVERY_ACCESS_REQUIRED');
    if(operation.kind==='page.patch'){for(const field of ['title','icon','cover','favorite'])if(Object.hasOwn(operation.body||{},field))result.body[field]=clone(operation.body[field]);for(const [key,value]of Object.entries(result.body))need(key==='favorite'?typeof value==='boolean':typeof value==='string'&&Array.from(value).length<=(key==='title'?500:10000),'RECOVERY_ACCESS_REQUIRED');}
    else{result.database_id=identity(operation.database_id);if(operation.kind!=='row.delete')for(const field of ['properties','parent_row_id','depends_on'])if(Object.hasOwn(operation.body||{},field))result.body[field]=clone(operation.body[field]);if(Object.hasOwn(result.body,'properties'))need(plain(result.body.properties),'RECOVERY_ACCESS_REQUIRED');if(result.body.parent_row_id!==undefined&&result.body.parent_row_id!==null)identity(result.body.parent_row_id);if(result.body.depends_on!==undefined)need(Array.isArray(result.body.depends_on)&&result.body.depends_on.every(value=>typeof value==='string'),'RECOVERY_ACCESS_REQUIRED');}
    const page=operation.kind==='page.patch',pageFields=['title','icon','cover','favorite'],rowFields=['parent_row_id','depends_on'];
    const field=(key,value)=>{
      if(key==='favorite')need(typeof value==='boolean','RECOVERY_ACCESS_REQUIRED');
      else if(key==='parent_row_id'){if(value!==null)identity(value);}
      else if(key==='depends_on'){need(Array.isArray(value)&&value.length<=1000,'RECOVERY_ACCESS_REQUIRED');for(const id of value)identity(id);}
      else need(typeof value==='string'&&Array.from(value).length<=(key==='title'?500:10000),'RECOVERY_ACCESS_REQUIRED');
      return clone(value);
    };
    const base=value=>{
      need(plain(value)&&Object.keys(value).every(key=>(page?['fields']:['properties','fields','schema','updated_at','after_operation',...rowFields]).includes(key)),'RECOVERY_ACCESS_REQUIRED');const clean={};
      if(Object.hasOwn(value,'fields')){need(plain(value.fields)&&Object.keys(value.fields).every(key=>(page?pageFields:rowFields).includes(key)),'RECOVERY_ACCESS_REQUIRED');clean.fields={};for(const [key,item]of Object.entries(value.fields))clean.fields[key]=field(key,item);}
      if(!page){
        if(Object.hasOwn(value,'properties')){need(plain(value.properties),'RECOVERY_ACCESS_REQUIRED');clean.properties=clone(value.properties);}
        if(Object.hasOwn(value,'schema'))need(plain(value.schema),'RECOVERY_ACCESS_REQUIRED'); // Current canonical schema is authority; never export old control metadata.
        if(Object.hasOwn(value,'updated_at')){need(typeof value.updated_at==='string'&&value.updated_at.length<=1000&&Number.isFinite(Date.parse(value.updated_at)),'RECOVERY_ACCESS_REQUIRED');clean.updated_at=value.updated_at;}
        if(Object.hasOwn(value,'after_operation'))clean.after_operation=identity(value.after_operation);
        for(const key of rowFields)if(Object.hasOwn(value,key))clean[key]=field(key,value[key]);
      }
      return clean;
    };
    if(Object.hasOwn(operation,'base'))result.base=base(operation.base);
    if(Object.hasOwn(operation,'base_rows')){need(!page&&plain(operation.base_rows),'RECOVERY_ACCESS_REQUIRED');result.base_rows={};for(const [id,value]of Object.entries(operation.base_rows))result.base_rows[identity(id)]=base(value);}
    result.depends_on=[...new Set([...result.depends_on,...Object.values(result.base_rows||{}).map(value=>value.after_operation).filter(Boolean)])];return result;
  }
  readable(value,prefix='Native lineage preserved; manual review required'){const text=typeof value==='string'?value:json(value),result=[];const points=Array.from(text);for(let offset=0;offset<points.length;offset+=50000)result.push({id:'native-raw-'+result.length,type:'code',language:'json',text:prefix+'\n'+points.slice(offset,offset+50000).join(''),parent_id:null});return result;}
  async project(item,value,context,cache){
    const owner=profile(item.row.profile_id),parts=(value.resourceKey||value.scopeId||value.key||'').split('|');need(parts.slice(0,4).join('|')===item.row.profile_id,'RECOVERY_ACCESS_REQUIRED');
    if(item.category==='local_page'||item.category==='unsupported')throw fail('RECOVERY_ACCESS_REQUIRED');
    if(item.row.bucket==='mutations'){
      need(json(JSON.parse(item.row.key))===json([item.row.profile_id,value.id])&&value.id===value.operation?.id,'RECOVERY_ACCESS_REQUIRED');const operation=this.typed(value.operation);need(parts.length===(operation.kind.startsWith('row.')?6:5)&&decodeURIComponent(parts.at(-1))===(operation.database_id||operation.target_id)&&(!operation.database_id||parts[4]==='database'),'RECOVERY_ACCESS_REQUIRED');
      if(operation.kind==='page.patch')await this.editablePage(operation.target_id,context,cache);else await this.references(operation,context,cache);
      return{binding:owner.binding,record:{id:operation.id,profileId:item.row.profile_id,resourceKey:value.resourceKey,status:'paused',operation}};
    }
    need(parts.length===5&&json(JSON.parse(item.row.key))===json([value.key,item.row.bucket==='drafts'?value.clientId:value.id]),'RECOVERY_ACCESS_REQUIRED');const pageId=decodeURIComponent(parts[4]);await this.editablePage(pageId,context,cache);
    let blocks;
    if(item.row.bucket==='drafts'&&Array.isArray(value.draft?.blocks))blocks=this.blocks(value.draft.blocks);
    else{const operation=this.rawOperation(item.row.bucket==='operations'?value.operation:null);if(operation.type==='block.set'&&operation.field==='attachment_id'&&operation.value)await this.attachment(operation.value,cache);blocks=this.readable({ops:[operation]});}
    for(const block of blocks)if(block.attachment_id)await this.attachment(block.attachment_id,cache);
    return{binding:owner.binding,draft:{page_id:pageId,draft:{blocks,reason:'imported'}}};
  }
  async validateInventory(input){
    const inventory=this.inventory;need(input.generation===this.generation&&inventory?.token===input.inventoryToken&&inventory.deadline>this.now(),'RECOVERY_STALE');
    const context=await this.context();need(this.same(context,inventory.context),'RECOVERY_STALE');const source=await this.source();try{need(source?.fingerprint===inventory.fingerprint,'RECOVERY_STALE');return{inventory,context,source};}catch(error){source?.db.close();throw error;}
  }
  async outputs(groups){
    if(!this.privateDirectory)this.privateDirectory=await mkdtemp(join(tmpdir(),'fountain-native-recovery-private-'));
    const files=[];let total=0,index=0;
    const append=async(value,format)=>{const bytes=Buffer.from(json(value));need(bytes.length<=this.fileLimit&&total+bytes.length<=this.totalLimit,'RECOVERY_LIMIT');bounded(value);const name='fountain-recovery-'+(++index)+'.json',path=join(this.privateDirectory,randomUUID()+'.json');const handle=await open(path,'wx',0o600);try{for(let offset=0;offset<bytes.length;offset+=256*1024)await handle.write(bytes.subarray(offset,offset+256*1024));await handle.sync();}finally{await handle.close();}total+=bytes.length;files.push({name,path,byteLength:bytes.length,format,digest:hash(bytes)});};
    try{for(const group of groups){const normal={format:'fountain-recovery-v2',origin:this.origin,workspace_id:group.context.workspace,member_id:group.context.member,source_binding:group.binding,records:group.records,localPages:[],drafts:group.drafts};
      need(group.records.length<=1000,'RECOVERY_LIMIT');const bytes=Buffer.from(json(normal));
      if(bytes.length<=this.fileLimit)await append(normal,'fountain-recovery-v2');
      else{const text=json(normal),digest=hash(text),points=Array.from(text),width=Math.min(50000,Math.max(1,Math.floor(this.fileLimit/16))),count=Math.ceil(points.length/width);
        for(let part=0;part<count;part++){const block={id:'part-'+part,type:'code',language:'json',parent_id:null,text:`Fountain readable recovery part ${part+1}/${count} sha256:${digest}\n`+points.slice(part*width,(part+1)*width).join('')};await append({blocks:[block]},'readable-body');}
      }
    }return files;}catch(error){for(const file of files)await unlink(file.path).catch(()=>{});throw error;}
  }
  async recoveryExport(input){
    try{return await this.performExport(input);}catch(error){
      if(error.code==='RECOVERY_AUTH_REQUIRED')await this.invalidateContext();
      const prepared=this.prepared.get(input.exportToken);if(prepared){for(const file of prepared.files)await unlink(file.path).catch(()=>{});this.prepared.delete(input.exportToken);}
      if(typeof error.code==='string'&&error.code.startsWith('RECOVERY_'))throw error;
      throw fail('RECOVERY_STORAGE');
    }
  }
  async performExport(input){
    need(input.generation===this.generation&&typeof input.id==='string'&&['prepare','save','cancel'].includes(input.phase),'RECOVERY_STALE');
    if(input.phase==='cancel'){const matches=input.exportToken?[this.prepared.get(input.exportToken)].filter(Boolean):[...this.prepared.values()].filter(value=>value.inventory===input.inventoryToken);for(const prepared of matches){for(const file of prepared.files)await unlink(file.path).catch(()=>{});for(const [token,value]of this.prepared)if(value===prepared)this.prepared.delete(token);}if(!input.exportToken&&this.inventory?.token===input.inventoryToken){this.inventory.cancelled=true;this.inventory=null;}return{generation:this.generation,saved:false,filesSaved:0};}
    const {inventory,context,source}=await this.validateInventory(input);context.source=source;
    try{
      need(Array.isArray(input.handles)&&input.handles.length>0&&input.handles.length<=100&&new Set(input.handles).size===input.handles.length,'RECOVERY_LIMIT');
      if(input.phase==='save'){
        const prepared=this.prepared.get(input.exportToken);need(prepared&&prepared.inventory===inventory.token&&json(prepared.handles)===json(input.handles)&&prepared.deadline>this.now()&&this.same(prepared.context,context),'RECOVERY_STALE');need(prepared.files.length>0,'RECOVERY_ACCESS_REQUIRED');
        for(const [path,body]of prepared.authority){const current=await this.canonical(path);need(current.status===200&&json(current.body)===json(body),'RECOVERY_STALE');}
        let count=0;
        try{for(const file of prepared.files){need(prepared.deadline>this.now()&&this.same(await this.context(),context),'RECOVERY_STALE');need(await fileDigest(file.path)===file.digest,'RECOVERY_STORAGE');const picked=await this.picker({name:file.name,path:file.path,format:file.format});
          try{need(this.prepared.get(input.exportToken)===prepared&&this.same(await this.context(),context),'RECOVERY_STALE');const latest=await this.source();try{need(latest?.fingerprint===inventory.fingerprint,'RECOVERY_STALE');}finally{latest?.db.close();}}catch(error){await picked?.rollback?.();throw error;}
          if(!picked?.saved)return{generation:this.generation,saved:false,filesSaved:count};count++;
        }return{generation:this.generation,saved:true,filesSaved:count};}
        finally{for(const file of prepared.files)await unlink(file.path).catch(()=>{});this.prepared.delete(input.exportToken);}
      }
      const selected=input.handles.map(handle=>inventory.rows.find(row=>row.handle===handle));need(selected.every(Boolean),'RECOVERY_STALE');let cache=new Map(),groups,blockedCount,readyCount,stable=false;
      for(let attempt=0;attempt<3;attempt++){
        const previous=cache;cache=new Map();
        for(const path of previous.keys())if(path.startsWith('/api/attachments/')){const response=await this.canonical(path);need(response.status===200,'RECOVERY_ACCESS_REQUIRED');cache.set(path,response.body);}else await this.canonicalBody(path,context,cache);
        groups=new Map();blockedCount=0;readyCount=0;let sourceBytes=0;
        for(const item of selected){try{const parsed=this.value(source,item.row);need(parsed.digest===item.digest,'RECOVERY_STALE');sourceBytes+=item.row.bytes;need(sourceBytes<=TOTAL,'RECOVERY_LIMIT');bounded(parsed.value);const projected=await this.project(item,parsed.value,context,cache);if(!groups.has(projected.binding))groups.set(projected.binding,{binding:projected.binding,context,records:[],drafts:[]});const group=groups.get(projected.binding);if(projected.record)group.records.push(projected.record);else group.drafts.push(projected.draft);readyCount++;}catch(error){if(error.code==='RECOVERY_LIMIT'||error.code==='RECOVERY_STALE')throw error;blockedCount++;}}
        const responses=[...cache.values()].filter(value=>integer(value.data_revision)),access=Math.max(0,...responses.map(value=>value.access_revision)),data=Math.max(0,...responses.map(value=>value.data_revision));
        if(responses.every(value=>value.access_revision===access&&value.data_revision===data)){stable=true;break;}
      }
      need(stable,'RECOVERY_STALE');
      for(const group of groups.values()){const ids=new Set(group.records.map(record=>record.operation.id));for(const record of group.records)need(record.operation.depends_on.every(id=>ids.has(id)),'RECOVERY_ACCESS_REQUIRED');const remaining=new Set(ids);for(let pass=0;pass<group.records.length&&remaining.size;pass++)for(const record of group.records)if(remaining.has(record.operation.id)&&record.operation.depends_on.every(id=>!remaining.has(id)))remaining.delete(record.operation.id);need(!remaining.size,'RECOVERY_ACCESS_REQUIRED');}
      need(this.inventory===inventory&&!inventory.cancelled&&this.same(await this.context(),context),'RECOVERY_STALE');const files=await this.outputs(groups.values());if(this.inventory!==inventory||inventory.cancelled){for(const file of files)await unlink(file.path).catch(()=>{});throw fail('RECOVERY_CANCELLED');}const exportToken=randomUUID();this.prepared.set(exportToken,{inventory:inventory.token,context,handles:clone(input.handles),files,authority:cache,deadline:Math.min(context.validUntil,this.now()+AUTHORITY)});
      return{generation:this.generation,exportToken,readyCount,blockedCount,files:files.map(({name,byteLength,format})=>({name,byteLength,format})),warnings:files.some(file=>file.format==='readable-body')?['큰 복구 내용은 원문 JSON을 나눈 읽기 전용 본문입니다. 자동 변경으로 실행하지 않습니다.']:[]};
    }finally{source?.db.close();}
  }
  async invalidateContext(){this.inventory=null;this.recoveryContext=null;for(const prepared of this.prepared.values())for(const file of prepared.files)await unlink(file.path).catch(()=>{});this.prepared.clear();if(this.privateDirectory)await rm(this.privateDirectory,{recursive:true,force:true});this.privateDirectory=null;}
  async close(){await this.invalidateContext();}
}
