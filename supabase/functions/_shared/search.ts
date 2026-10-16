/** Synchronous, authorized lexical retrieval. No embeddings, provider or stored cursor. */
import {APIError,casefold,get,has,is_object,truth,valid_id} from './access.ts';
import type {Access,Entity,StoreReader} from './access.ts';
import {canonicalJSON} from './store.ts';
import {IncrementalSHA256} from './storage.ts';

const TYPES=['page','database','row'] as const;
type Kind=typeof TYPES[number];
type Filters={q:string;terms:string[];types:Kind[];owners:string[];teamspace:string|null;in:string|null;title_only:boolean;date_field:'updated'|'created';after:string|null;before:string|null;sort:string};
type Query={filters:Filters;limit:number;offset:number;marker:string|null;after:number|null;before:number|null};
type Candidate={dto:Entity;title:string;created:number|null;updated:number|null;score:number};
const TEXT_BLOCKS=new Set(['paragraph','heading1','heading2','heading3','bullet','numbered','todo','quote','code','callout','toggle']);
const STRINGS=new Set(['title','text','select','status','url','email','phone']);
const WHITE=/\p{White_Space}+/gu;
const text=(value:unknown):value is string=>typeof value==='string'&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const id=(value:unknown):value is string=>valid_id(value)&&text(value);
const string=(value:unknown):string=>text(value)?value:'';
const display=(value:string):string=>value.normalize('NFKC').replace(WHITE,' ').replace(/^ +| +$/g,'');
const normalized=(value:string):string=>casefold(value.normalize('NFKC')).replace(WHITE,' ').replace(/^ +| +$/g,'');
function fail(status=400):never {throw new APIError(status,status===404?'Search container not found':status===409?'Search results changed; start again':status===401?'Authentication required':'Invalid advanced search query');}
function check(value:unknown,status=400):asserts value {if(!value)fail(status);}
function compare(a:string,b:string):number {
  const x=Array.from(a),y=Array.from(b);for(let i=0;i<Math.min(x.length,y.length);i++){const delta=x[i].codePointAt(0)!-y[i].codePointAt(0)!;if(delta)return delta;}return x.length-y.length;
}
function day(year:number,month:number,date:number):boolean {
  return year>=1&&year<=9999&&month>=1&&month<=12&&date>=1&&date<=[31,28+(year%4===0&&(year%100!==0||year%400===0)?1:0),31,30,31,30,31,31,30,31,30,31][month-1];
}
/** Preserve source spelling, but compare integer floor UTC milliseconds. */
function timestamp(value:unknown):number|null {
  if(typeof value!=='string')return null;
  const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);if(!m)return null;
  const y=+m[1],mo=+m[2],d=+m[3],h=+m[4],mi=+m[5],s=+m[6],oh=+(m[10]??0),om=+(m[11]??0);
  if(!day(y,mo,d)||h>23||mi>59||s>59||oh>23||om>59)return null;
  const date=new Date(0);date.setUTCFullYear(y,mo-1,d);date.setUTCHours(h,mi,s,0);
  const milliseconds=+(m[7]??'').padEnd(6,'0').slice(0,3),offset=(m[9]==='-'?-1:1)*(oh*60+om)*60000;
  const time=date.getTime()+milliseconds-offset;return time< -62135596800000||time>253402300799999?null:time;
}
function dateOnly(value:string):boolean {const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value);return !!m&&day(+m[1],+m[2],+m[3]);}
function terms(query:string):string[] {
  const result:string[]=[];let at=0,count=0;
  while(at<query.length){if(query[at]===' '){at++;continue;}let term:string;
    if(query[at]==='"'){const end=query.indexOf('"',at+1);check(end>=0);term=query.slice(at+1,end).replace(/^ +| +$/g,'');check(term.length>0&&(end+1===query.length||query[end+1]===' '));at=end+1;}
    else{const end=query.indexOf(' ',at);term=query.slice(at,end<0?query.length:end);check(!term.includes('"'));at=end<0?query.length:end;}
    check(++count<=16);if(!result.includes(term))result.push(term);
  }return result;
}
function parse(query:URLSearchParams):Query {
  const allowed=new Set(['q','types','owner','teamspace','in','title_only','date_field','after','before','sort','limit','offset','result_set']);
  for(const key of query.keys()){check(allowed.has(key));if(key!=='owner')check(query.getAll(key).length===1);}
  const raw=query.get('q')??'';check(Array.from(raw).length<=500);const q=normalized(raw),parsed=terms(q);
  const requested=(query.get('types')??'page,database,row').split(',');check(requested.length>0&&new Set(requested).size===requested.length&&requested.every(v=>(TYPES as readonly string[]).includes(v)));
  const owners=[...new Set(query.getAll('owner'))];check(owners.length<=20&&owners.every(id));owners.sort(compare);
  const teamspace=query.get('teamspace'),inside=query.get('in');check(teamspace===null||id(teamspace));check(inside===null||id(inside));
  const titleOnly=query.get('title_only')??'0',field=query.get('date_field')??'updated',sort=query.get('sort')??'relevance';
  check(['0','1'].includes(titleOnly)&&['updated','created'].includes(field)&&['relevance','updated_desc','updated_asc','created_desc','created_asc','title'].includes(sort));
  const after=query.get('after'),before=query.get('before');
  const canonicalDate=(value:string|null):number|null=>{if(value===null)return null;check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value));const time=timestamp(value);check(time!==null);return time;};
  const lower=canonicalDate(after),upper=canonicalDate(before);check(lower===null||upper===null||lower<upper);
  const integer=(name:string,fallback:number,maximum:number,minimum=0):number=>{const raw=query.get(name);if(raw===null)return fallback;check(/^(0|[1-9][0-9]*)$/.test(raw));const n=Number(raw);check(Number.isSafeInteger(n)&&n>=minimum&&n<=maximum);return n;};
  const limit=integer('limit',20,50,1),offset=integer('offset',0,100000),marker=query.get('result_set');check(marker===null||/^[a-f0-9]{64}$/.test(marker));check(offset===0||marker!==null);
  const filters:Filters={q,terms:parsed,types:TYPES.filter(v=>requested.includes(v)),owners,teamspace,in:inside,title_only:titleOnly==='1',date_field:field as Filters['date_field'],after,before,sort};
  canonicalJSON(filters); // Reject invalid JSON scalar strings before touching the corpus.
  return {filters,limit,offset,marker,after:lower,before:upper};
}
export function validateAdvancedSearchQuery(query:URLSearchParams):void {parse(query);}
function scalarNumber(value:unknown):string {
  if(typeof value!=='number'||!Number.isFinite(value)||Number.isInteger(value)&&!Number.isSafeInteger(value))return '';
  return String(value).replace(/e\+?(-?)0*([0-9]+)$/,'e$1$2');
}
function dateValue(value:unknown):string {
  const atom=(item:unknown):{kind:string;time:number}|null=>{if(!text(item))return null;if(dateOnly(item))return {kind:'day',time:timestamp(item+'T00:00:00Z')!};const time=timestamp(item);return time===null?null:{kind:'time',time};};
  if(text(value))return atom(value)?value:'';
  if(is_object(value)&&Object.keys(value).length===2&&has(value,'start')&&has(value,'end')){const a=atom(value.start),b=atom(value.end);if(a&&b&&a.kind===b.kind&&a.time<=b.time)return value.start+' '+value.end;}
  return '';
}
function rowValues(database:Entity,row:Entity):{title:string;body:string} {
  const properties=Array.isArray(database.properties)?database.properties:[],values=is_object(row.properties)?row.properties:{};
  const titleProperty=properties.find(p=>is_object(p)&&p.type==='title');
  const title=titleProperty&&typeof titleProperty.id==='string'?string(get(values,titleProperty.id)):'';
  const body:string[]=[];
  for(const property of properties){if(!is_object(property)||typeof property.id!=='string')continue;const value=get(values,property.id),kind=property.type;let extracted='';
    if(STRINGS.has(kind))extracted=string(value);
    else if(kind==='number')extracted=scalarNumber(value);
    else if(kind==='checkbox'&&typeof value==='boolean')extracted=value?'true':'false';
    else if(kind==='multi_select'&&Array.isArray(value)&&value.every(text))extracted=value.join(' ');
    else if(kind==='date')extracted=dateValue(value);
    if(extracted)body.push(extracted);
  }
  return {title,body:body.join(' ')};
}
function snippet(body:string,terms:string[],titleOnly:boolean):string {
  const text=Array.from(body);if(text.length<=180)return body;let hit=0;
  if(!titleOnly&&terms.length){let folded='',map:number[]=[];for(let i=0;i<text.length;i++){const value=casefold(text[i]);folded+=value;for(let j=0;j<value.length;j++)map.push(i);}
    const positions=terms.map(term=>folded.indexOf(term)).filter(index=>index>=0);if(positions.length)hit=map[Math.min(...positions)];
  }
  const start=Math.max(0,Math.min(hit-89,text.length-178)),end=Math.min(text.length,start+178);
  return (start?'…':'')+text.slice(start,end).join('')+(end<text.length?'…':'');
}
function dateCompare(a:number|null,b:number|null,descending:boolean):number {if(a===null||b===null)return a===b?0:a===null?1:-1;return descending?b-a:a-b;}

export function advancedSearch(store:StoreReader,access:Access,query:URLSearchParams):Entity {
  const parsed=parse(query),f=parsed.filters;check(access.active,401);
  if(f.teamspace!==null){const item=store.get('teamspace',f.teamspace);check(item&&access.can('teamspace',item),404);}
  if(f.in!==null){const item=store.get('page',f.in);check(item&&access.can('page',item)&&!truth(get(item,'archived')),404);}
  // Only these authorized maps may supply searchable text or containment metadata.
  const pages=new Map<string,Entity>(),databases=new Map<string,Entity>();
  for(const item of store.list('page'))if(access.can('page',item)&&!truth(get(item,'archived'))&&id(item.id))pages.set(item.id,item);
  if(f.types.includes('database')||f.types.includes('row'))for(const item of store.list('database'))if(access.can('database',item)&&!truth(get(item,'archived'))&&id(item.id))databases.set(item.id,item);
  const ancestry=(identity:unknown):Entity[]=>{const chain:Entity[]=[],seen=new Set<string>();while(id(identity)&&!seen.has(identity)){const item=pages.get(identity);if(!item)break;chain.push(item);seen.add(identity);identity=get(item,'parent_id');}return chain;};
  const contained=(kind:Kind,item:Entity,db?:Entity):boolean=>{
    const base=db??item,chain=kind==='page'?ancestry(item.id):[...ancestry(get(base,'parent_id')),...ancestry(get(base,'page_id'))];
    if(f.in!==null&&!chain.some(p=>p.id===f.in))return false;
    if(f.teamspace!==null){let teamspace=get(base,'teamspace_id');if(teamspace===null)teamspace=chain.map(p=>get(p,'teamspace_id')).find(value=>value!==null)??null;if(teamspace!==f.teamspace)return false;}
    return true;
  };
  const selected:Candidate[]=[];
  function add(kind:Kind,item:Entity,db?:Entity):void {
    const owner=has(item,'owner_id')?id(item.owner_id)?item.owner_id:null:'local';
    if(f.owners.length&&!f.owners.includes(owner as string))return;
    if(!contained(kind,item,db))return;
    const created=timestamp(item.created_at),updated=timestamp(item.updated_at),date=f.date_field==='updated'?updated:created;
    if((parsed.after!==null||parsed.before!==null)&&(date===null||parsed.after!==null&&date<parsed.after||parsed.before!==null&&date>=parsed.before))return;
    let title='',rawBody='';
    if(kind==='page'){title=string(item.title);rawBody=(Array.isArray(item.blocks)?item.blocks:[]).filter(b=>is_object(b)&&TEXT_BLOCKS.has(get(b,'type','paragraph'))&&!truth(get(b,'attachment_id'))&&text(b.text)).map(b=>b.text).join(' ');}
    else if(kind==='database'){title=text(item.name)?item.name:string(item.title);rawBody=string(item.description);}
    else{const row=rowValues(db!,item);title=row.title;rawBody=row.body;}
    const foldedTitle=normalized(title),body=display(rawBody),foldedBody=casefold(body);let score=0;
    for(const term of f.terms){const titleHit=foldedTitle.includes(term),bodyHit=!f.title_only&&foldedBody.includes(term);if(!titleHit&&!bodyHit)return;score+=50*Number(titleHit)+8*Number(bodyHit);}
    if(f.terms.length&&foldedTitle.includes(f.q.replaceAll('"','').replace(WHITE,' ').replace(/^ +| +$/g,'')))score+=30;
    const dto:Entity={type:kind,id:item.id,title,icon:text(item.icon)?item.icon:null,snippet:snippet(body,f.terms,f.title_only),owner_id:owner,created_at:created===null?null:item.created_at,updated_at:updated===null?null:item.updated_at};
    if(kind==='row'){dto.database_id=db!.id;dto.database_title=text(db!.name)?db!.name:string(db!.title);}
    selected.push({dto,title:foldedTitle,created,updated,score});
  }
  if(f.types.includes('page'))for(const item of pages.values())add('page',item);
  if(f.types.includes('database'))for(const item of databases.values())add('database',item);
  if(f.types.includes('row'))for(const item of store.list('row')){if(!access.can('row',item)||truth(get(item,'archived'))||!id(item.id))continue;const db=databases.get(get(item,'database_id'));if(db)add('row',item,db);}
  selected.sort((a,b)=>{
    let delta=0;
    if(f.sort==='relevance')delta=b.score-a.score||dateCompare(a.updated,b.updated,true);
    else if(f.sort.startsWith('updated_'))delta=dateCompare(a.updated,b.updated,f.sort.endsWith('_desc'));
    else if(f.sort.startsWith('created_'))delta=dateCompare(a.created,b.created,f.sort.endsWith('_desc'));
    return delta||compare(a.title,b.title)||TYPES.indexOf(a.dto.type)-TYPES.indexOf(b.dto.type)||compare(a.dto.id,b.dto.id);
  });
  const all=selected.map(item=>item.dto),hash=new IncrementalSHA256();hash.update(new TextEncoder().encode(canonicalJSON([1,store.meta('workspace_id'),access.member_id,f,all])));const marker=hash.hex();
  if(parsed.marker!==null&&parsed.marker!==marker)fail(409);
  const results=all.slice(parsed.offset,parsed.offset+parsed.limit),more=parsed.offset+results.length<all.length;
  return {results,total:all.length,offset:parsed.offset,limit:parsed.limit,has_more:more,next_offset:more?parsed.offset+results.length:null,result_set:marker};
}
