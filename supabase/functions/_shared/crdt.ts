/** Pure server RGA/history reducer extracted from static/collaboration.js.
 * Algorithm source SHA256: f08ee824aa340e481b033fbfcb7c2b29a25393f559e36476bac9b932b0a0c3a5.
 * DOM/channel/global registration intentionally excluded. Boundary validators are
 * Python-compatible; immutable lineage/merge/projection algorithms are retained.
 * Dynamic internal JSON nodes mirror the existing wire format, not DOM objects.
 */
import {APIError,get,is_object,truth} from './access.ts';
import type {Entity} from './access.ts';
const own=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
const dict=():Entity=>Object.create(null);
function clone(value:any):any{if(Array.isArray(value))return value.map(clone);if(value&&typeof value==='object'){const result=dict();for(const key of Object.keys(value))result[key]=clone(value[key]);return result;}return value;}
function check(condition:any,message:string,status=400):void{if(!condition)throw new APIError(status,message);}
function string(value:any,name:string,limit:number,nullable=false):any{if(nullable&&value===null)return value;check(typeof value==='string'&&Array.from(value).length<=limit,'Invalid '+name);for(const point of value)check(point.codePointAt(0)!<0xd800||point.codePointAt(0)!>0xdfff,'Invalid Unicode in '+name);return value;}
function identity(value:any,nullable=false,label='identifier'):any{string(value,label,300,nullable);check(nullable&&value===null||!!value,'Invalid '+label);return value;}
function compareText(a:any,b:any):any{const first=Array.from(a),second=Array.from(b);for(let i=0;i<Math.min(first.length,second.length);i++){const delta=first[i].codePointAt(0)-second[i].codePointAt(0);if(delta)return delta;}return first.length-second.length;}
function compareStamp(a:any,b:any):any{if(!b)return 1;if(!a)return -1;return a[0]-b[0]||compareText(a[1],b[1])||compareText(a[2],b[2]);}
const PALETTE=['default','gray','brown','orange','yellow','green','blue','purple','pink','red'];
const BOOL_MARKS=['bold','italic','underline','strike','code'];
const FIELDS=['type','checked','language','attachment_id','size'];
const TYPES=['paragraph','heading1','heading2','heading3','bullet','numbered','todo','quote','code','callout','divider','toggle','image','bookmark','file'];
const ALIASES=Object.assign(dict(),{heading_1:'heading1',heading_2:'heading2',heading_3:'heading3',bulleted_list_item:'bullet',numbered_list_item:'numbered',to_do:'todo'});
function validateMarks(marks:unknown):Entity{
  check(is_object(marks)&&Object.keys(marks).every(key=>[...BOOL_MARKS,'color','background','link'].includes(key)),'Unsupported rich text marks');const result=dict();
  for(const [key,value] of Object.entries(marks as Entity)){
    if(BOOL_MARKS.includes(key))check(typeof value==='boolean',key+' must be boolean');
    else if(key==='color'||key==='background')check(typeof value==='string'&&PALETTE.includes(value),'Unsupported text color');
    else if(value!==null){
      string(value,'link',2048);check(value&&!/[\u0000-\u0020\\]/u.test(value),'Unsafe text link');
      const parts=/^(?:([A-Za-z][A-Za-z0-9+.-]*):)?(?:\/\/([^/?#]*))?([^?#]*)/.exec(value)!;
      const scheme=(parts[1]||'').toLowerCase(),authority=parts[2]||'',path=parts[3]||'';
      let allowed=false;
      if(['http','https'].includes(scheme)&&authority){try{allowed=!!new URL(value).hostname;}catch{/* Invalid authority */}}
      else if(scheme==='mailto')allowed=!!path;
      else if(!scheme&&!authority)allowed=(value.startsWith('/')||value.startsWith('#'))&&!value.startsWith('//');
      check(allowed,'Unsafe text link');
    }
    result[key]=value;
  }
  return result;
}
function fieldValue(field:any,value:any):any{
  check(typeof field==='string'&&FIELDS.includes(field),'Unsupported block field');
  if(field==='type'){check(typeof value==='string','Invalid block type');value=own(ALIASES,value)?ALIASES[value]:value;check(TYPES.includes(value),'Unsupported block type');}
  else if(field==='checked')check(typeof value==='boolean','checked must be boolean');
  else if(field==='size')check(Number.isSafeInteger(value)&&value>=0,'Invalid block size');
  else string(value,field==='attachment_id'?'attachment id':'language',field==='language'?100:160,field==='attachment_id');
  return value;
}
function canonical(value:any):any{if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort(compareText).map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';return JSON.stringify(value);}
// Synchronous SHA-256 keeps the reducer deterministic on insecure LAN and in Node without dependencies.
const K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
const rotate=(value,n)=>(value>>>n)|(value<<(32-n));
function sha256(text:any):any{
  const input=new TextEncoder().encode(text),length=Math.ceil((input.length+9)/64)*64,bytes=new Uint8Array(length);bytes.set(input);bytes[input.length]=128;
  const view=new DataView(bytes.buffer),bits=input.length*8;view.setUint32(length-8,Math.floor(bits/0x100000000));view.setUint32(length-4,bits>>>0);
  const hash=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19],words=new Uint32Array(64);
  for(let offset=0;offset<length;offset+=64){
    for(let i=0;i<16;i++)words[i]=view.getUint32(offset+i*4);
    for(let i=16;i<64;i++){const a=words[i-15],b=words[i-2];words[i]=(words[i-16]+(rotate(a,7)^rotate(a,18)^(a>>>3))+words[i-7]+(rotate(b,17)^rotate(b,19)^(b>>>10)))>>>0;}
    let [a,b,c,d,e,f,g,h]=hash;
    for(let i=0;i<64;i++){const first=(h+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+K[i]+words[i])>>>0;const second=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))>>>0;h=g;g=f;f=e;e=(d+first)>>>0;d=c;c=b;b=a;a=(first+second)>>>0;}
    [a,b,c,d,e,f,g,h].forEach((value,index)=>hash[index]=(hash[index]+value)>>>0);
  }
  return hash.map(value=>value.toString(16).padStart(8,'0')).join('');
}
function block(id:any):any{return {id,insert:null,deleted:false,parent_id:null,after_id:null,move:null,fields:dict(),chars:dict()};}
function char(id:any):any{return {id,after_id:null,stamp:null,deleted:false,marks:dict()};}
function set(registers:any,key:any,value:any,stamp:any):any{if(!own(registers,key)||compareStamp(stamp,registers[key].stamp)>0)registers[key]={value:clone(value),stamp:[...stamp]};}
function normalizeBlocks(blocks:unknown,uid:()=>string=()=>crypto.randomUUID().replaceAll('-','')):Entity[]{
  check(Array.isArray(blocks)&&blocks.length<=2000,'Provide at most 2000 blocks');const seen=new Set<string>(),normalized:Entity[]=[];
  for(const value of blocks as Entity[]){
    check(is_object(value),'Block must be an object');const id=identity(truth(get(value,'id'))?value.id:uid(),false,'block id');
    check(Array.from(id).length<=160&&!seen.has(id),'Invalid or duplicate block id');seen.add(id);
    const tokens=get(value,'rich_text',[]);check(Array.isArray(tokens)&&tokens.length<=10000,'Invalid rich text tokens');let rich:Entity[]=[],total=0;
    for(const token of tokens){
      check(is_object(token)&&Object.keys(token).every(key=>['text','marks'].includes(key)),'Invalid rich text token');const text=string(get(token,'text',''),'rich text',100000),marks=validateMarks(get(token,'marks',{}));
      total+=Array.from(text).length;check(total<=100000,'Block text is too large');
      if(text){if(rich.length&&canonical(rich.at(-1)!.marks)===canonical(marks))rich.at(-1)!.text+=text;else rich.push({text,marks});}
    }
    const joined=rich.map(token=>token.text).join(''),text=string(get(value,'text',joined),'block text',100000);check(Array.from(joined).length<=100000,'Block text is too large');
    if(text!==joined)rich=text?[{text,marks:dict()}]:[];
    const item:Entity={id,type:fieldValue('type',get(value,'type','paragraph')),text,parent_id:identity(get(value,'parent_id'),true,'parent id'),rich_text:rich};
    for(const field of FIELDS)if(field!=='type'&&own(value,field))item[field]=fieldValue(field,clone(value[field]));normalized.push(item);
  }
  const parents=dict();for(const item of normalized)parents[item.id]=seen.has(item.parent_id)&&item.parent_id!==item.id?item.parent_id:null;
  breakCycles(parents);const children=new Map<any,Entity[]>();for(const item of normalized){item.parent_id=parents[item.id];if(!children.has(item.parent_id))children.set(item.parent_id,[]);children.get(item.parent_id)!.push(item);}
  const ordered:Entity[]=[],stack=[...(children.get(null)||[])].reverse();while(stack.length){const item=stack.pop()!;ordered.push(item);stack.push(...[...(children.get(item.id)||[])].reverse());}return ordered;
}
function seedState(blocks:any,uid?:()=>string):any{
  const state={version:1,max_clock:0,blocks:dict(),seen:dict()},previous=new Map();
  for(const item of normalizeBlocks(blocks,uid)){
    const stamp=[0,'seed',item.id],node=block(item.id);node.insert=[...stamp];node.move=[...stamp];node.parent_id=item.parent_id;node.after_id=previous.get(item.parent_id)||null;previous.set(item.parent_id,item.id);
    for(const field of FIELDS)if(own(item,field))set(node.fields,field,item[field],stamp);
    let index=0,anchor=null;for(const token of item.rich_text)for(const text of Array.from(token.text)){const id=`seed:${item.id}:${index++}`,value=char(id);Object.assign(value,{after_id:anchor,stamp:[...stamp],text});for(const key of Object.keys(token.marks))set(value.marks,key,token.marks[key],stamp);node.chars[id]=value;anchor=id;}
    state.blocks[item.id]=node;
  }
  return state;
}
function validateOperation(op:unknown):any[]{
  check(is_object(op),'Operation must be an object');const value=op as Entity,client=string(get(value,'client'),'client',80);
  check(/^[A-Za-z0-9_-]+$/.test(client),'Invalid operation client');const clock=get(value,'clock');
  check(Number.isSafeInteger(clock)&&clock>0,'Invalid operation clock');check(get(value,'id')===client+':'+clock,'Operation id must match client and clock');
  const kind=get(value,'type');check(typeof kind==='string'&&['block.insert','block.set','block.move','block.delete','text.insert','text.delete','text.format','history.cancel'].includes(kind),'Unknown operation type');
  if(kind==='history.cancel'){
    check(Object.keys(value).length===5&&['id','client','clock','type','targets'].every(key=>own(value,key)),'Unsupported cancellation fields');
    const targets=get(value,'targets');check(Array.isArray(targets)&&targets.length>0&&targets.length<=1000,'Provide 1 to 1000 cancellation targets');
    for(const target of targets){check(typeof target==='string','Invalid cancellation target');const index=target.lastIndexOf(':'),prefix=target.slice(0,index),number=target.slice(index+1);check(index>=0&&prefix===client&&/^[1-9][0-9]{0,15}$/.test(number)&&Number(number)<clock&&target===client+':'+Number(number),'Invalid cancellation target');}
    check(new Set(targets).size===targets.length,'Cancellation targets must be unique');return [clock,client,value.id];
  }
  if(own(value,'group_id')){string(value.group_id,'creation group',80);check(/^[A-Za-z0-9_-]+$/.test(value.group_id),'Invalid creation group');}
  const fields:Entity={'block.insert':['parent_id','after_id','block_type'],'block.move':['parent_id','after_id'],'block.set':['field','value'],'block.delete':[],'text.insert':['after_id','text','marks'],'text.delete':['char_ids'],'text.format':['char_ids','marks']};
  check(Object.keys(value).every(key=>['id','client','clock','type','block_id','group_id',...fields[kind]].includes(key)),'Unsupported operation fields');
  identity(get(value,'block_id'),false,'block id');check(Array.from(value.block_id).length<=160,'Block id is too long');
  if(['block.insert','block.move'].includes(kind)){identity(get(value,'parent_id'),true,'parent id');identity(get(value,'after_id'),true,'block anchor');}
  if(kind==='block.insert')fieldValue('type',get(value,'block_type','paragraph'));if(kind==='block.set')fieldValue(get(value,'field'),get(value,'value'));
  if(kind==='text.insert'){identity(get(value,'after_id'),true,'character anchor');string(get(value,'text'),'insert text',100000);validateMarks(get(value,'marks',{}));}
  if(['text.delete','text.format'].includes(kind)){const ids=get(value,'char_ids');check(Array.isArray(ids)&&ids.length<=100000,'Invalid character ids');for(const id of ids)identity(id,false,'character id');}
  if(kind==='text.format')validateMarks(get(value,'marks',{}));return [clock,client,value.id];
}
function operationStamp(op:any):any{return [op.clock,op.client,op.id];}
function slot(blockId:any,kind:any,source:any,extra:any={}):any{return {block_id:blockId,kind,...extra,source:[...source]};}
function hintKey(value:any):any{return canonical([value.block_id,value.kind,value.field??null,value.char_id??null,value.mark??null,value.source]);}
function capturePublicHints(state:any):any{
  const hints=new Map(),unknown=new Set((state.unresolved_slots||[]).map(hintKey));
  for(const [id,node] of Object.entries(state.blocks||{})){
    if(node.deleted||node.insert===null)continue;
    if(node.move&&own(node,'parent_id')&&own(node,'after_id')&&!unknown.has(hintKey(slot(id,'position',node.move))))hints.set(hintKey(slot(id,'position',node.move)),{parent_id:node.parent_id,after_id:node.after_id});
    for(const [field,value] of Object.entries(node.fields))if(own(value,'value'))hints.set(hintKey(slot(id,'field',value.stamp,{field})),clone(value.value));
    for(const [charId,value] of Object.entries(node.chars))if(!value.deleted&&value.stamp){
      if(own(value,'text'))hints.set(hintKey(slot(id,'text',value.stamp,{char_id:charId})),value.text);
      for(const [mark,entry] of Object.entries(value.marks))if(own(entry,'value'))hints.set(hintKey(slot(id,'mark',entry.stamp,{char_id:charId,mark})),clone(entry.value));
    }
  }
  return hints;
}
function operationMetadata(op:any):any{
  const result={id:op.id,client:op.client,clock:op.clock,type:op.type};
  for(const key of ['block_id','group_id','field','char_ids','targets'])if(own(op,key))result[key]=clone(op[key]);
  if(op.type==='text.insert'){result.after_id=op.after_id??null;result.character_count=own(op,'text')?Array.from(op.text).length:op.character_count;}
  if(['text.insert','text.format'].includes(op.type))result.mark_keys=own(op,'marks')?Object.keys(op.marks).sort(compareText):[...(op.mark_keys||[])].sort(compareText);
  return result;
}
function redactBaseline(blocks:any):any{
  const result=clone(blocks);
  for(const node of Object.values(result)){
    delete node.parent_id;delete node.after_id;
    for(const value of Object.values(node.fields))delete value.value;
    for(const value of Object.values(node.chars)){delete value.text;for(const entry of Object.values(value.marks))delete entry.value;}
  }
  return result;
}
function operationHints(operations:any,hints:any):any{
  for(const op of operations){
    const source=operationStamp(op),id=op.block_id,put=(kind,value,extra={})=>hints.set(hintKey(slot(id,kind,source,extra)),clone(value));
    if(['block.insert','block.move'].includes(op.type))put('position',{parent_id:op.parent_id??null,after_id:op.after_id??null});
    if(op.type==='block.insert')put('field',fieldValue('type',op.block_type||'paragraph'),{field:'type'});
    if(op.type==='block.set')put('field',fieldValue(op.field,op.value),{field:op.field});
    if(op.type==='text.insert')Array.from(op.text).forEach((text,index)=>{const char_id=op.id+':'+index;put('text',text,{char_id});for(const [mark,value] of Object.entries(op.marks||{}))put('mark',value,{char_id,mark});});
    if(op.type==='text.format')for(const char_id of op.char_ids)for(const [mark,value] of Object.entries(op.marks||{}))put('mark',value,{char_id,mark});
  }
}
function materializeHistory(state:any,hints:any=new Map()):any{
  const history=state.history,isPublic=history.public===true,records=dict(),active=new Set(),disabled=new Set();
  const operations=Object.values(history.ops).sort((a,b)=>compareStamp(operationStamp(a),operationStamp(b)));
  for(const op of [...operations].reverse()){if(disabled.has(op.id))continue;active.add(op.id);if(op.type==='history.cancel')op.targets.forEach(id=>disabled.add(id));}
  const ensure=id=>{if(!own(records,id))records[id]={node:block(id),baseline:null,insertions:[],fields:dict(),positions:[],chars:dict(),contributions:[],deleted:false};return records[id];};
  const ensureChar=(record,id)=>{if(!own(record.chars,id))record.chars[id]={node:char(id),baseline:false,origin:null,marks:dict(),deleted:false};return record.chars[id];};
  const candidate=(descriptor,opId,value,known)=>{
    const result={descriptor,stamp:descriptor.source,opId};
    if(known)result.value=clone(value);else if(isPublic&&hints.has(hintKey(descriptor)))result.value=clone(hints.get(hintKey(descriptor)));
    return result;
  };
  const add=(registers,key,value)=>{if(!own(registers,key))registers[key]=[];registers[key].push(value);};
  for(const [id,base] of Object.entries(history.baseline.blocks)){
    const record=ensure(id);record.baseline=base;record.node.insert=clone(base.insert);record.deleted=base.deleted;
    if(base.move)record.positions.push(candidate(slot(id,'position',base.move),null,{parent_id:base.parent_id,after_id:base.after_id},own(base,'parent_id')&&own(base,'after_id')));
    for(const [field,value] of Object.entries(base.fields))add(record.fields,field,candidate(slot(id,'field',value.stamp,{field}),null,value.value,own(value,'value')));
    for(const [charId,value] of Object.entries(base.chars)){
      const entry=ensureChar(record,charId);entry.node=clone(value);entry.baseline=value.stamp!==null;entry.deleted=value.deleted;
      if(value.stamp)entry.origin=candidate(slot(id,'text',value.stamp,{char_id:charId}),null,value.text,own(value,'text'));
      for(const [mark,register] of Object.entries(value.marks))add(entry.marks,mark,candidate(slot(id,'mark',register.stamp,{char_id:charId,mark}),null,register.value,own(register,'value')));
    }
  }
  for(const op of operations){
    if(op.type==='history.cancel')continue;
    const id=op.block_id,record=ensure(id),stamp=operationStamp(op),live=active.has(op.id);
    if(live&&['block.set','block.move'].includes(op.type))record.contributions.push(op);
    if(op.type==='block.delete'){if(live)record.deleted=true;continue;}
    if(['block.insert','block.move'].includes(op.type)){
      if(op.type==='block.insert'){
        record.insertions.push(op);
        if(compareStamp(stamp,record.node.insert)>0)record.node.insert=[...stamp];
        add(record.fields,'type',candidate(slot(id,'field',stamp,{field:'type'}),op.id,isPublic?undefined:fieldValue('type',op.block_type||'paragraph'),!isPublic));
      }
      record.positions.push(candidate(slot(id,'position',stamp),op.id,{parent_id:op.parent_id??null,after_id:op.after_id??null},!isPublic));
    }else if(op.type==='block.set')add(record.fields,op.field,candidate(slot(id,'field',stamp,{field:op.field}),op.id,isPublic?undefined:fieldValue(op.field,op.value),!isPublic));
    else if(op.type==='text.insert'){
      let anchor=op.after_id??null;const texts=isPublic?null:Array.from(op.text),count=isPublic?op.character_count:texts.length;
      for(let index=0;index<count;index++){
        const charId=op.id+':'+index,entry=ensureChar(record,charId);Object.assign(entry.node,{after_id:anchor,stamp:[...stamp]});
        entry.origin=candidate(slot(id,'text',stamp,{char_id:charId}),op.id,texts?.[index],!isPublic);
        for(const mark of isPublic?op.mark_keys:Object.keys(op.marks||{}))add(entry.marks,mark,candidate(slot(id,'mark',stamp,{char_id:charId,mark}),op.id,op.marks?.[mark],!isPublic));
        anchor=charId;
      }
    }else for(const charId of op.char_ids){
      const entry=ensureChar(record,charId);
      if(op.type==='text.delete'){if(live)entry.deleted=true;}
      else for(const mark of isPublic?op.mark_keys:Object.keys(op.marks||{}))add(entry.marks,mark,candidate(slot(id,'mark',stamp,{char_id:charId,mark}),op.id,op.marks?.[mark],!isPublic));
    }
  }
  const greatest=values=>values.reduce((winner,value)=>!winner||compareStamp(value.stamp,winner.stamp)>0?value:winner,null);
  const isActive=value=>value.opId===null||active.has(value.opId),parents=dict(),eligible=new Set(),visible=new Set();
  for(const [id,record] of Object.entries(records)){
    const baselineBorn=record.baseline?.insert!==null&&record.baseline?.insert!==undefined,birth=baselineBorn?null:record.insertions[0];
    record.cohort=op=>!!birth&&(birth.group_id?op.client===birth.client&&op.group_id===birth.group_id&&op.block_id===id&&['block.insert','block.set','block.move','text.insert'].includes(op.type):op.id===birth.id);
    record.originActive=baselineBorn||record.insertions.some(op=>active.has(op.id));
    record.position=greatest(record.positions.filter(isActive))||greatest(record.positions.filter(value=>value.opId&&record.cohort(history.ops[value.opId])));
    record.node.move=record.position?[...record.position.stamp]:null;
    record.node.parent_id=record.position&&own(record.position,'value')?record.position.value.parent_id:null;
    record.node.after_id=record.position&&own(record.position,'value')?record.position.value.after_id:null;
    for(const entry of Object.values(record.chars)){entry.node.deleted=entry.deleted||!(entry.baseline||entry.origin&&active.has(entry.origin.opId));}
    if(record.node.insert!==null&&!record.deleted){eligible.add(id);if(record.originActive||Object.values(record.chars).some(entry=>entry.node.stamp!==null&&!entry.node.deleted)||record.contributions.some(op=>!record.cohort(op)))visible.add(id);}
  }
  for(const id of eligible){const parent=records[id].node.parent_id;parents[id]=eligible.has(parent)&&parent!==id?parent:null;}breakCycles(parents);
  const stack=[...visible];while(stack.length){const parent=parents[stack.pop()];if(parent!==null&&parent!==undefined&&!visible.has(parent)){visible.add(parent);stack.push(parent);}}
  const unresolved=[],resolve=value=>{if(value&&!own(value,'value'))unresolved.push(clone(value.descriptor));};
  state.blocks=dict();
  for(const [id,record] of Object.entries(records)){
    const node=record.node;node.deleted=record.deleted||node.insert!==null&&!visible.has(id);node.fields=dict();node.chars=dict();
    if(!node.deleted&&node.insert!==null)resolve(record.position);
    for(const [field,values] of Object.entries(record.fields)){
      const value=greatest(values.filter(isActive))||(!record.originActive&&visible.has(id)?greatest(values.filter(value=>value.opId&&record.cohort(history.ops[value.opId]))):null);
      if(value){node.fields[field]={stamp:[...value.stamp]};if(own(value,'value'))node.fields[field].value=clone(value.value);if(!node.deleted&&node.insert!==null)resolve(value);}
    }
    for(const [charId,entry] of Object.entries(record.chars)){
      const value=entry.node;delete value.text;value.marks=dict();
      if(entry.origin&&own(entry.origin,'value'))value.text=entry.origin.value;
      const displayed=!node.deleted&&node.insert!==null&&!value.deleted&&value.stamp!==null;
      if(displayed)resolve(entry.origin);
      for(const [mark,values] of Object.entries(entry.marks)){
        const winner=greatest(values.filter(isActive));if(!winner)continue;
        value.marks[mark]={stamp:[...winner.stamp]};if(own(winner,'value'))value.marks[mark].value=clone(winner.value);if(displayed)resolve(winner);
      }
      node.chars[charId]=value;
    }
    state.blocks[id]=node;
  }
  if(isPublic)state.unresolved_slots=unresolved.sort((a,b)=>compareText(canonical(a),canonical(b)));else delete state.unresolved_slots;
  return state;
}
function hydratePublicState(state:any,hints:any=new Map()):any{
  check(state?.history?.public===true,'Expected public collaboration state');
  const known=new Map(capturePublicHints(state));for(const [key,value] of hints)known.set(key,clone(value));
  const result=materializeHistory(clone(state),known);return {state:result,unresolved_slots:result.unresolved_slots};
}
function applyOperations(state:any,operations:any,hints:any=new Map()):any{
  check(is_object(state)&&state.version===1,'Unsupported collaboration state');check(Array.isArray(operations)&&operations.length<=1000,'Send at most 1000 operations at a time');
  const validated=operations.map(op=>({op,stamp:validateOperation(op),digest:sha256(canonical(op))})),result=clone(state),fresh=[];
  for(const {op,digest} of validated){
    result.max_clock=Math.max(result.max_clock??0,op.clock);
    if(own(result.seen,op.id)){check(result.seen[op.id]===true||result.seen[op.id]===digest,'Operation id was reused with different content',409);continue;}
    result.seen[op.id]=digest;fresh.push(op);
  }
  if(!fresh.length)return result;
  if(!result.history)result.history={version:1,baseline:{blocks:clone(state.blocks)},ops:dict()};
  const isPublic=result.history.public===true,known=isPublic?new Map(capturePublicHints(state)):new Map();if(isPublic){for(const [key,value] of hints)known.set(key,clone(value));operationHints(fresh,known);}
  for(const op of fresh)result.history.ops[op.id]=isPublic?operationMetadata(op):clone(op);
  return materializeHistory(result,known);
}
function breakCycles(anchors:any):any{
  const finished=new Set();for(const id of Object.keys(anchors).sort(compareText)){if(finished.has(id))continue;const path=[],positions=new Map();let current=id;while(current!==null&&!finished.has(current)){if(positions.has(current)){anchors[path.slice(positions.get(current)).sort(compareText)[0]]=null;break;}positions.set(current,path.length);path.push(current);current=own(anchors,current)?anchors[current]:null;}path.forEach(value=>finished.add(value));}return anchors;
}
function ordered(nodes:any,input:any,stampKey:any,pendingMissing:any=false):any{
  const anchors=clone(input),active=new Set(Object.keys(nodes));
  if(pendingMissing){const dependents=new Map(),blocked=new Set();for(const id of Object.keys(anchors)){const after=anchors[id];if(!dependents.has(after))dependents.set(after,[]);dependents.get(after).push(id);if(after!==null&&!own(nodes,after))blocked.add(id);}const stack=[...blocked];while(stack.length)for(const id of dependents.get(stack.pop())||[])if(!blocked.has(id)){blocked.add(id);stack.push(id);}blocked.forEach(id=>active.delete(id));}
  const safe=dict();for(const id of active)safe[id]=active.has(anchors[id])&&anchors[id]!==id?anchors[id]:null;breakCycles(safe);
  const children=new Map([[null,[]]]);for(const id of Object.keys(safe)){const parent=safe[id];if(!children.has(parent))children.set(parent,[]);children.get(parent).push(id);}
  for(const siblings of children.values())siblings.sort((a,b)=>-(compareStamp(nodes[a][stampKey]||[0,'',''],nodes[b][stampKey]||[0,'',''])||compareText(a,b)));
  const stack=[...(children.get(null)||[])].reverse(),result=[];while(stack.length){const id=stack.pop();result.push(id);stack.push(...[...(children.get(id)||[])].reverse());}return result;
}
function visibleChars(state:any,id:any):any{
  if(!own(state.blocks,id))return [];const node=state.blocks[id];if(node.deleted||node.insert===null)return [];const chars=dict(),anchors=dict();for(const key of Object.keys(node.chars))if(node.chars[key].stamp!==null){chars[key]=node.chars[key];anchors[key]=chars[key].after_id;}
  return ordered(chars,anchors,'stamp',true).filter(key=>!chars[key].deleted&&own(chars[key],'text')).map(key=>({id:key,text:chars[key].text,marks:Object.fromEntries(Object.keys(chars[key].marks).filter(mark=>own(chars[key].marks[mark],'value')).map(mark=>[mark,clone(chars[key].marks[mark].value)]))}));
}
function project(state:any):any{
  const created=dict(),parents=dict();for(const id of Object.keys(state.blocks))if(state.blocks[id].insert!==null)created[id]=state.blocks[id];
  for(const id of Object.keys(created)){const parent=created[id].parent_id;parents[id]=own(created,parent)&&!created[parent].deleted&&parent!==id?parent:null;}breakCycles(parents);
  const siblings=new Map(),orders=new Map();for(const id of Object.keys(created)){const parent=parents[id];if(!siblings.has(parent))siblings.set(parent,dict());siblings.get(parent)[id]=created[id];}
  for(const [parent,nodes] of siblings){const anchors=dict();for(const id of Object.keys(nodes))anchors[id]=nodes[id].after_id;orders.set(parent,ordered(nodes,anchors,'move'));}
  const stack=[...(orders.get(null)||[])].reverse(),result=[];while(stack.length){const id=stack.pop(),node=created[id];if(!node.deleted){const fields=dict();for(const key of Object.keys(node.fields))if(own(node.fields[key],'value'))fields[key]=clone(node.fields[key].value);const rich=[];for(const value of visibleChars(state,id)){if(rich.length&&canonical(rich.at(-1).marks)===canonical(value.marks))rich.at(-1).text+=value.text;else rich.push({text:value.text,marks:clone(value.marks)});}result.push({id,type:'paragraph',...fields,parent_id:parents[id],text:rich.map(token=>token.text).join(''),rich_text:rich});}stack.push(...[...(orders.get(id)||[])].reverse());}return result;
}
function publicState(state:any):any{
  const result=clone(state),history=state.history||{version:1,baseline:{blocks:state.blocks},ops:dict()};
  result.history={version:1,public:true,baseline:{blocks:redactBaseline(history.baseline.blocks)},ops:dict()};
  for(const [id,op] of Object.entries(history.ops))result.history.ops[id]=operationMetadata(op);
  for(const id of Object.keys(result.seen))result.seen[id]=true;
  for(const node of Object.values(result.blocks)){
    if(node.deleted)for(const value of Object.values(node.fields))delete value.value;
    for(const value of Object.values(node.chars))if(node.deleted||value.deleted){delete value.text;value.marks=dict();}
  }
  delete result.unresolved_slots;return result;
}
const hintMap=(hints:any)=>hints instanceof Map?hints:new Map(Object.entries(hints||{}));
export {seedState,applyOperations,project,publicState,capturePublicHints,hydratePublicState,visibleChars,normalizeBlocks,validateMarks,canonical,sha256,compareText,PALETTE,BOOL_MARKS};
export const seed_state=seedState,public_state=publicState,visible_chars=visibleChars,normalize_blocks=normalizeBlocks,validate_marks=validateMarks;
export const apply_operations=(state:any,ops:any,hints:any=null):any=>applyOperations(state,ops,hintMap(hints));
export const capture_public_hints=(state:any):Entity=>Object.fromEntries(capturePublicHints(state));
export const hydrate_public_state=(state:any,hints:any=null):any=>hydratePublicState(state,hintMap(hints));
