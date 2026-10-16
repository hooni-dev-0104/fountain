/* Fountain's independent codepoint RGA, shared with fountain/crdt.py. No document replacement on merge. */
(() => {
  'use strict';
  const own=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
  const dict=()=>Object.create(null);
  function clone(value){if(Array.isArray(value))return value.map(clone);if(value&&typeof value==='object'){const result=dict();for(const key of Object.keys(value))result[key]=clone(value[key]);return result;}return value;}
  function check(condition,message,status=400){if(!condition){const error=new Error(message);error.status=status;throw error;}}
  function string(value,name,limit,nullable=false){if(nullable&&value===null)return value;check(typeof value==='string'&&Array.from(value).length<=limit,'Invalid '+name);for(const point of value)check(point.codePointAt(0)<0xd800||point.codePointAt(0)>0xdfff,'Invalid Unicode');return value;}
  function identity(value,nullable=false){if(value===undefined&&nullable)return null;string(value,'identifier',300,nullable);check(nullable&&value===null||!!value,'Invalid identifier');return value;}
  function compareText(a,b){const first=Array.from(a),second=Array.from(b);for(let i=0;i<Math.min(first.length,second.length);i++){const delta=first[i].codePointAt(0)-second[i].codePointAt(0);if(delta)return delta;}return first.length-second.length;}
  function compareStamp(a,b){if(!b)return 1;if(!a)return -1;return a[0]-b[0]||compareText(a[1],b[1])||compareText(a[2],b[2]);}
  const PALETTE=['default','gray','brown','orange','yellow','green','blue','purple','pink','red'];
  const BOOL_MARKS=['bold','italic','underline','strike','code'];
  const FIELDS=['type','checked','language','attachment_id','size'];
  const TYPES=['paragraph','heading1','heading2','heading3','bullet','numbered','todo','quote','code','callout','divider','toggle','image','bookmark','file'];
  const ALIASES=Object.assign(dict(),{heading_1:'heading1',heading_2:'heading2',heading_3:'heading3',bulleted_list_item:'bullet',numbered_list_item:'numbered',to_do:'todo'});
  function validateMarks(marks){
    check(marks&&typeof marks==='object'&&!Array.isArray(marks),'Invalid rich text marks');const result=dict();
    for(const key of Object.keys(marks)){
      const value=marks[key];check([...BOOL_MARKS,'color','background','link'].includes(key),'Unsupported rich text marks');
      if(BOOL_MARKS.includes(key))check(typeof value==='boolean','Invalid boolean mark');
      else if(key==='color'||key==='background')check(typeof value==='string'&&PALETTE.includes(value),'Unsupported text color');
      else if(value!==null){
        string(value,'link',2048);check(value&&!/[\u0000-\u0020\\]/u.test(value),'Unsafe text link');
        if(value.startsWith('/')||value.startsWith('#'))check(!value.startsWith('//'),'Unsafe text link');
        else{let parsed;try{parsed=new URL(value);}catch{check(false,'Unsafe text link');}check(['http:','https:'].includes(parsed.protocol)&&!!parsed.hostname||parsed.protocol==='mailto:'&&!!parsed.pathname,'Unsafe text link');}
      }
      result[key]=value;
    }
    return result;
  }
  function fieldValue(field,value){
    check(FIELDS.includes(field),'Unsupported block field');
    if(field==='type'){value=own(ALIASES,value)?ALIASES[value]:value;check(TYPES.includes(value),'Unsupported block type');}
    else if(field==='checked')check(typeof value==='boolean','checked must be boolean');
    else if(field==='size')check(Number.isSafeInteger(value)&&value>=0,'Invalid block size');
    else string(value,field,field==='language'?100:160,field==='attachment_id');
    return value;
  }
  function canonical(value){if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort(compareText).map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';return JSON.stringify(value);}
  // Synchronous SHA-256 keeps the reducer deterministic on insecure LAN and in Node without dependencies.
  const K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const rotate=(value,n)=>(value>>>n)|(value<<(32-n));
  function sha256(text){
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
  function block(id){return {id,insert:null,deleted:false,parent_id:null,after_id:null,move:null,fields:dict(),chars:dict()};}
  function char(id){return {id,after_id:null,stamp:null,deleted:false,marks:dict()};}
  function set(registers,key,value,stamp){if(!own(registers,key)||compareStamp(stamp,registers[key].stamp)>0)registers[key]={value:clone(value),stamp:[...stamp]};}
  function normalizeBlocks(blocks){
    check(Array.isArray(blocks)&&blocks.length<=2000,'Provide at most 2000 blocks');const seen=new Set();
    const normalized=blocks.map(value=>{
      check(value&&typeof value==='object'&&!Array.isArray(value),'Invalid block');const id=identity(value.id);check(Array.from(id).length<=160&&!seen.has(id),'Duplicate block');seen.add(id);
      const tokens=value.rich_text||[];check(Array.isArray(tokens)&&tokens.length<=10000,'Invalid rich text');const rich=[];
      for(const token of tokens){check(token&&typeof token==='object'&&Object.keys(token).every(key=>['text','marks'].includes(key)),'Invalid rich text token');const text=string(token.text??'','text',100000),marks=validateMarks(token.marks||{});if(text){if(rich.length&&canonical(rich.at(-1).marks)===canonical(marks))rich.at(-1).text+=text;else rich.push({text,marks});}}
      const joined=rich.map(token=>token.text).join(''),text=string(own(value,'text')?value.text:joined,'block text',100000);check(Array.from(joined).length<=100000,'Block text too large');
      const result={id,type:fieldValue('type',value.type||'paragraph'),text,parent_id:identity(value.parent_id??null,true),rich_text:text!==joined?(text?[{text,marks:dict()}]:[]):rich};
      for(const field of FIELDS)if(field!=='type'&&own(value,field))result[field]=fieldValue(field,clone(value[field]));return result;
    });
    const indexed=new Map(normalized.map(item=>[item.id,item])),parents=dict();
    for(const item of normalized)parents[item.id]=indexed.has(item.parent_id)&&item.parent_id!==item.id?item.parent_id:null;
    breakCycles(parents);const children=new Map();for(const item of normalized){item.parent_id=parents[item.id];if(!children.has(item.parent_id))children.set(item.parent_id,[]);children.get(item.parent_id).push(item);}
    const ordered=[],stack=[...(children.get(null)||[])].reverse();while(stack.length){const item=stack.pop();ordered.push(item);stack.push(...[...(children.get(item.id)||[])].reverse());}return ordered;
  }
  function seedState(blocks){
    const state={version:1,max_clock:0,blocks:dict(),seen:dict()},previous=new Map();
    for(const item of normalizeBlocks(blocks)){
      const stamp=[0,'seed',item.id],node=block(item.id);node.insert=[...stamp];node.move=[...stamp];node.parent_id=item.parent_id;node.after_id=previous.get(item.parent_id)||null;previous.set(item.parent_id,item.id);
      for(const field of FIELDS)if(own(item,field))set(node.fields,field,item[field],stamp);
      let index=0,anchor=null;for(const token of item.rich_text)for(const text of Array.from(token.text)){const id=`seed:${item.id}:${index++}`,value=char(id);Object.assign(value,{after_id:anchor,stamp:[...stamp],text});for(const key of Object.keys(token.marks))set(value.marks,key,token.marks[key],stamp);node.chars[id]=value;anchor=id;}
      state.blocks[item.id]=node;
    }
    return state;
  }
  function validateOperation(op){
    check(op&&typeof op==='object'&&!Array.isArray(op),'Invalid operation');string(op.client,'client',80);check(/^[A-Za-z0-9_-]+$/.test(op.client),'Invalid client');check(Number.isSafeInteger(op.clock)&&op.clock>0,'Invalid clock');check(op.id===op.client+':'+op.clock,'Invalid operation id');
    const fields={'block.insert':['parent_id','after_id','block_type'],'block.move':['parent_id','after_id'],'block.set':['field','value'],'block.delete':[],'text.insert':['after_id','text','marks'],'text.delete':['char_ids'],'text.format':['char_ids','marks']};
    check(own(fields,op.type),'Unknown operation');check(Object.keys(op).every(key=>['id','client','clock','type','block_id',...fields[op.type]].includes(key)),'Unsupported operation fields');identity(op.block_id);check(Array.from(op.block_id).length<=160,'Block id too long');
    if(['block.insert','block.move'].includes(op.type)){identity(op.parent_id??null,true);identity(op.after_id??null,true);}
    if(op.type==='block.insert')fieldValue('type',op.block_type||'paragraph');
    if(op.type==='block.set')fieldValue(op.field,op.value);
    if(op.type==='text.insert'){identity(op.after_id??null,true);string(op.text,'insert text',100000);validateMarks(op.marks||{});}
    if(['text.delete','text.format'].includes(op.type)){check(Array.isArray(op.char_ids)&&op.char_ids.length<=100000,'Invalid char ids');op.char_ids.forEach(id=>identity(id));}
    if(op.type==='text.format')validateMarks(op.marks||{});
    return [op.clock,op.client,op.id];
  }
  function applyOperations(state,operations){
    check(state?.version===1,'Unsupported state');check(Array.isArray(operations)&&operations.length<=1000,'Too many operations');const validated=operations.map(op=>({op,stamp:validateOperation(op),digest:sha256(canonical(op))})),result=clone(state);result.max_clock=result.max_clock||0;
    for(const {op,stamp,digest} of validated){
      result.max_clock=Math.max(result.max_clock,op.clock);if(own(result.seen,op.id)){check(result.seen[op.id]===true||result.seen[op.id]===digest,'Operation id reused with different content',409);continue;}result.seen[op.id]=digest;
      const node=own(result.blocks,op.block_id)?result.blocks[op.block_id]:(result.blocks[op.block_id]=block(op.block_id));
      if(op.type==='block.delete')node.deleted=true;
      else if(['block.insert','block.move'].includes(op.type)){if(op.type==='block.insert'){if(compareStamp(stamp,node.insert)>0)node.insert=[...stamp];set(node.fields,'type',fieldValue('type',op.block_type||'paragraph'),stamp);}if(compareStamp(stamp,node.move)>0){node.parent_id=op.parent_id??null;node.after_id=op.after_id??null;node.move=[...stamp];}}
      else if(op.type==='block.set')set(node.fields,op.field,fieldValue(op.field,op.value),stamp);
      else if(op.type==='text.insert'){let anchor=op.after_id??null;Array.from(op.text).forEach((text,index)=>{const id=op.id+':'+index,value=own(node.chars,id)?node.chars[id]:(node.chars[id]=char(id));Object.assign(value,{after_id:anchor,stamp:[...stamp],text});for(const key of Object.keys(op.marks||{}))set(value.marks,key,op.marks[key],stamp);anchor=id;});}
      else for(const id of op.char_ids){const value=own(node.chars,id)?node.chars[id]:(node.chars[id]=char(id));if(op.type==='text.delete')value.deleted=true;else for(const key of Object.keys(op.marks||{}))set(value.marks,key,op.marks[key],stamp);}
    }
    return result;
  }
  function breakCycles(anchors){
    const finished=new Set();for(const id of Object.keys(anchors).sort(compareText)){if(finished.has(id))continue;const path=[],positions=new Map();let current=id;while(current!==null&&!finished.has(current)){if(positions.has(current)){anchors[path.slice(positions.get(current)).sort(compareText)[0]]=null;break;}positions.set(current,path.length);path.push(current);current=own(anchors,current)?anchors[current]:null;}path.forEach(value=>finished.add(value));}return anchors;
  }
  function ordered(nodes,input,stampKey,pendingMissing=false){
    const anchors=clone(input),active=new Set(Object.keys(nodes));
    if(pendingMissing){const dependents=new Map(),blocked=new Set();for(const id of Object.keys(anchors)){const after=anchors[id];if(!dependents.has(after))dependents.set(after,[]);dependents.get(after).push(id);if(after!==null&&!own(nodes,after))blocked.add(id);}const stack=[...blocked];while(stack.length)for(const id of dependents.get(stack.pop())||[])if(!blocked.has(id)){blocked.add(id);stack.push(id);}blocked.forEach(id=>active.delete(id));}
    const safe=dict();for(const id of active)safe[id]=active.has(anchors[id])&&anchors[id]!==id?anchors[id]:null;breakCycles(safe);
    const children=new Map([[null,[]]]);for(const id of Object.keys(safe)){const parent=safe[id];if(!children.has(parent))children.set(parent,[]);children.get(parent).push(id);}
    for(const siblings of children.values())siblings.sort((a,b)=>-(compareStamp(nodes[a][stampKey]||[0,'',''],nodes[b][stampKey]||[0,'',''])||compareText(a,b)));
    const stack=[...(children.get(null)||[])].reverse(),result=[];while(stack.length){const id=stack.pop();result.push(id);stack.push(...[...(children.get(id)||[])].reverse());}return result;
  }
  function visibleChars(state,id){
    if(!own(state.blocks,id))return [];const node=state.blocks[id];if(node.deleted||node.insert===null)return [];const chars=dict(),anchors=dict();for(const key of Object.keys(node.chars))if(node.chars[key].stamp!==null){chars[key]=node.chars[key];anchors[key]=chars[key].after_id;}
    return ordered(chars,anchors,'stamp',true).filter(key=>!chars[key].deleted&&own(chars[key],'text')).map(key=>({id:key,text:chars[key].text,marks:Object.fromEntries(Object.keys(chars[key].marks).filter(mark=>own(chars[key].marks[mark],'value')).map(mark=>[mark,clone(chars[key].marks[mark].value)]))}));
  }
  function project(state){
    const created=dict(),parents=dict();for(const id of Object.keys(state.blocks))if(state.blocks[id].insert!==null)created[id]=state.blocks[id];
    for(const id of Object.keys(created)){const parent=created[id].parent_id;parents[id]=own(created,parent)&&!created[parent].deleted&&parent!==id?parent:null;}breakCycles(parents);
    const siblings=new Map(),orders=new Map();for(const id of Object.keys(created)){const parent=parents[id];if(!siblings.has(parent))siblings.set(parent,dict());siblings.get(parent)[id]=created[id];}
    for(const [parent,nodes] of siblings){const anchors=dict();for(const id of Object.keys(nodes))anchors[id]=nodes[id].after_id;orders.set(parent,ordered(nodes,anchors,'move'));}
    const stack=[...(orders.get(null)||[])].reverse(),result=[];while(stack.length){const id=stack.pop(),node=created[id];if(!node.deleted){const fields=dict();for(const key of Object.keys(node.fields))if(own(node.fields[key],'value'))fields[key]=clone(node.fields[key].value);const rich=[];for(const value of visibleChars(state,id)){if(rich.length&&canonical(rich.at(-1).marks)===canonical(value.marks))rich.at(-1).text+=value.text;else rich.push({text:value.text,marks:clone(value.marks)});}result.push({id,type:'paragraph',...fields,parent_id:parents[id],text:rich.map(token=>token.text).join(''),rich_text:rich});}stack.push(...[...(orders.get(id)||[])].reverse());}return result;
  }
  function publicState(state){const result=clone(state);for(const id of Object.keys(result.seen))result.seen[id]=true;for(const node of Object.values(result.blocks)){if(node.deleted)for(const value of Object.values(node.fields))delete value.value;for(const value of Object.values(node.chars))if(node.deleted||value.deleted){delete value.text;value.marks=dict();}}return result;}
  function randomClient(){const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);return 'tab_'+[...bytes].map(value=>value.toString(16).padStart(2,'0')).join('');}
  const stripEpoch=entry=>{const value=clone(entry);delete value._epoch;return value;};
  class DocumentChannel {
    constructor({pageId,profile,fetcher,onChange=()=>{},onStatus=()=>{},onDenied=()=>{},onDraft=()=>{},onError=()=>{}}){
      this.pageId=pageId;this.profile=profile;this.clientId=randomClient();this.fetcher=fetcher;this.onChange=onChange;this.onStatus=onStatus;this.onDenied=onDenied;this.onDraft=onDraft;this.onError=onError;this.offline=globalThis.FountainOffline;
      this.key=this.offline?.key(profile,pageId);this.pending=new Map();this.base=null;this.state=null;this.clock=0;this.closed=false;this.persistence=Promise.resolve();this.delay=500;this.recovering=false;this.retiredEpochs=new Set();
      this.onlineHandler=()=>this.reconnect();this.offlineHandler=()=>{this.source?.close();this.setStatus('offline');};
      globalThis.addEventListener('online',this.onlineHandler);globalThis.addEventListener('offline',this.offlineHandler);
      this.profileCleared=event=>{if(!this.closed&&event.detail?.profileId===this.profile.id){this.close();this.onDenied({status:401,message:'로그인이 종료되었습니다.'});}};
      this.resourcePurged=event=>{if(!this.closed&&event.detail?.key===this.key){this.close();this.onDenied({status:403,message:'이 문서의 접근 권한이 변경되었습니다.'});}};
      globalThis.addEventListener('fountain-offline-profile-cleared',this.profileCleared);globalThis.addEventListener('fountain-offline-resource-purged',this.resourcePurged);
      this.profileChanged=async()=>{const current=await this.offline?.getProfile().catch(()=>null);if(!this.closed&&current?.id!==this.profile.id){this.close();this.onDenied({status:401,message:'다른 계정으로 전환되었습니다.',switched:true});}};globalThis.addEventListener('fountain-offline-profile-changed',this.profileChanged);
      this.broadcast=typeof BroadcastChannel==='function'?new BroadcastChannel('fountain-document-operations'):null;
      if(this.broadcast)this.broadcast.onmessage=event=>{if(event.data?.key===this.key&&event.data.client!==this.clientId&&!this.closed)this.importPending().then(()=>this.flush()).catch(error=>this.onError(error));};
      const expires=profile.validUntil||Date.parse(profile.session?.expires_at);if(Number.isFinite(expires))this.expiryTimer=setTimeout(()=>this.deny(401,'오프라인 저장 기한이 만료되었습니다. 다시 로그인해 주세요.'),Math.max(0,Math.min(2147483647,expires-Date.now())));
    }
    setStatus(status){this.status=status;if(!this.closed)this.onStatus({status,pending:this.pending.size,durable:this.durable!==false});}
    async fetch(path,body){if(this.fetcher)return this.fetcher(path,body);const response=await FountainTransport.request('/api'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok){const error=new Error(data.error||'문서를 동기화하지 못했습니다.');error.status=response.status;throw error;}return data;}
    async open(snapshot,{cached=false}={}){
      if(this.offline&&this.key)this.previousCached=await this.offline.getSnapshot(this.key);
      if(this.closed)return this;
      this.base=clone(snapshot||await this.fetch('/pages/'+encodeURIComponent(this.pageId)+'/collaboration'));this.state=clone(this.base.state);this.clock=this.state.max_clock||0;
      await this.importPending(false);await this.rebuild('open');
      if(this.closed)return this;
      if(this.offline&&this.key)await this.offline.saveSnapshot(this.key,this.base);
      if(cached){this.setStatus('offline');if(navigator.onLine)this.reconnect();}else{this.setStatus(this.pending.size?'pending':'synced');this.connectEvents();this.flush();}
      const drafts=this.offline&&this.key?await this.offline.getDrafts(this.key):[];if(drafts.length&&!this.closed)this.onDraft(drafts.filter(record=>!['pending','basis'].includes(record.draft.reason)));return this;
    }
    async importPending(rebuild=true){
      if(!this.offline||!this.key||this.closed)return;
      const entries=await this.offline.pendingOperations(this.key);if(this.closed)return;
      let changed=false;for(const entry of entries)if(!this.pending.has(entry.id)){this.pending.set(entry.id,clone(entry));changed=true;}
      if(rebuild&&this.base&&changed)await this.rebuild('queue');
    }
    async recover(entries,reason){
      if(!entries.length)return;
      check(this.offline&&this.key,'복구 내용을 기기에 저장할 수 없습니다.');
      const epoch=entries[0]._epoch||this.base.epoch,records=await this.offline.getDrafts(this.key);
      const bases=records.filter(record=>record.draft.reason==='basis'&&record.draft.epoch===epoch&&record.draft.state).map(record=>record.draft);
      if(this.previousCached?.epoch===epoch)bases.push(this.previousCached);
      let blocks=null;
      if(this.base.epoch===epoch)blocks=project(this.state);
      else if(bases.length){
        bases.sort((a,b)=>(b.seq||0)-(a.seq||0));let recovered=clone(bases[0].state);
        const operations=entries.map(stripEpoch);for(let index=0;index<operations.length;index+=1000)recovered=applyOperations(recovered,operations.slice(index,index+1000));blocks=project(recovered);
      }
      if(blocks===null){
        const previous=records.filter(record=>record.draft.epoch===epoch&&record.draft.reason==='pending');
        for(const record of previous)await this.offline.saveDraft(this.key,record.clientId+':recovery:'+epoch+':'+randomClient(),{...record.draft,reason});
        if(previous.length)blocks=previous.at(-1).draft.blocks;
      }
      const recoveryId=this.clientId+':recovery:'+epoch+':'+randomClient();
      await this.offline.saveDraft(this.key,recoveryId,{epoch,ops:entries.map(stripEpoch),blocks:blocks||[],reason:blocks?reason:reason+'_ops_only',createdAt:new Date().toISOString()});
      await this.offline.acknowledge(this.key,entries.map(entry=>entry.id));entries.forEach(entry=>this.pending.delete(entry.id));
      if(!this.closed)this.onDraft((await this.offline.getDrafts(this.key)).filter(record=>!['pending','basis'].includes(record.draft.reason)));
    }
    async cleanPendingDrafts(){
      if(!this.offline||!this.key)return;
      for(const record of await this.offline.getDrafts(this.key)){
        if(record.draft.reason==='pending'&&record.draft.epoch===this.base.epoch&&(record.draft.ops||[]).every(op=>own(this.base.state.seen,op.id)))await this.offline.saveDraft(this.key,record.clientId,null);
      }
    }
    async rebuild(source){
      const old=[...this.pending.values()].filter(entry=>entry._epoch&&entry._epoch!==this.base.epoch);
      if(old.length)await this.recover(old,'epoch_changed');
      let next=clone(this.base.state);const operations=[...this.pending.values()].map(stripEpoch);
      for(let index=0;index<operations.length;index+=1000)next=applyOperations(next,operations.slice(index,index+1000));
      this.state=next;this.clock=Math.max(this.clock,next.max_clock||0);
      if(!this.closed)this.onChange({snapshot:this.base,state:this.state,blocks:project(this.state),source,pending:this.pending.size});
    }
    receive(snapshot,source='remote'){
      this.receiving=(this.receiving||Promise.resolve()).catch(()=>{}).then(()=>this.receiveOrdered(snapshot,source));return this.receiving;
    }
    async receiveOrdered(snapshot,source){
      if(this.closed)return;
      if(snapshot.session_binding&&snapshot.session_binding!==this.profile.session.cache_binding){this.close();this.onDenied({status:401,message:'로그인 계정이 변경되었습니다.',switched:true});return;}
      if(this.retiredEpochs.has(snapshot.epoch)||(snapshot.access_revision||0)<(this.base?.access_revision||0))return;
      if(this.base&&snapshot.epoch!==this.base.epoch&&(snapshot.page?.revision||0)<(this.base.page?.revision||0))return;
      if(this.base&&snapshot.epoch===this.base.epoch&&(snapshot.seq<this.base.seq||snapshot.seq===this.base.seq&&(snapshot.page?.revision||0)<(this.base.page?.revision||0)))return;
      // Preserve the old optimistic view before switching epochs, so recovery includes local text.
      if(this.base&&snapshot.epoch!==this.base.epoch&&this.pending.size)await this.recover([...this.pending.values()],'epoch_changed');
      if(this.closed)return;
      if(this.base&&snapshot.epoch!==this.base.epoch)this.retiredEpochs.add(this.base.epoch);
      this.base=clone(snapshot);await this.rebuild(source);
      if(this.closed)return;
      if(this.offline&&this.key)await this.offline.saveSnapshot(this.key,this.base);
      await this.cleanPendingDrafts();
      if((snapshot.access_level<3||snapshot.page?.locked)&&this.pending.size){await this.recover([...this.pending.values()],'read_only');await this.rebuild('read_only');}
      this.delay=500;this.setStatus(this.pending.size?'pending':'synced');
    }
    operation(type,blockId,fields={}){this.clock=Math.max(this.clock,this.state?.max_clock||0)+1;check(Number.isSafeInteger(this.clock),'작업 시계가 한도를 초과했습니다.');return {id:this.clientId+':'+this.clock,client:this.clientId,clock:this.clock,type,block_id:blockId,...clone(fields)};}
    submit(specifications){
      check(!this.closed&&this.base&&this.base.access_level>=3&&!this.base.page?.locked,'페이지 편집 권한이 없습니다.',403);
      return this.queue(specifications.map(spec=>this.operation(spec.type,spec.block_id,spec.fields||{})));
    }
    queue(operations){
      check(!this.closed&&this.base?.access_level>=3&&!this.base.page?.locked,'페이지 편집 권한이 없습니다.',403);
      if(!operations.length)return [];
      let next=this.state;for(let index=0;index<operations.length;index+=1000)next=applyOperations(next,operations.slice(index,index+1000));
      const entries=operations.map(op=>({...op,_epoch:this.base.epoch}));entries.forEach(entry=>this.pending.set(entry.id,entry));this.state=next;this.durable=false;
      const draft={epoch:this.base.epoch,ops:[...this.pending.values()].map(stripEpoch),blocks:project(this.state),reason:'pending',createdAt:new Date().toISOString()};
      this.onChange({snapshot:this.base,state:this.state,blocks:project(this.state),source:'local',pending:this.pending.size});this.setStatus(this.status==='offline'||!navigator.onLine?'offline':'pending');
      this.latestDraft=draft;this.persistPending();
      clearTimeout(this.flushTimer);this.flushTimer=setTimeout(()=>this.flush().catch(error=>this.onError(error)),180);return operations;
    }
    persistPending(){
      this.persistence=this.persistence.catch(()=>{}).then(async()=>{
        if(this.closed)return;
        const entries=[...this.pending.values()];if(!entries.length)return;
        check(this.offline&&this.key,'기기 저장소를 사용할 수 없습니다. 탭을 닫기 전에 연결을 복구해 주세요.');
        const epochs=new Set(entries.map(entry=>entry._epoch||this.base.epoch));
        if(epochs.has(this.base.epoch))await this.offline.saveDraft(this.key,this.clientId+':basis:'+this.base.epoch,{reason:'basis',epoch:this.base.epoch,seq:this.base.seq,state:clone(this.base.state),blocks:this.base.blocks});
        if(this.closed)return;
        await this.offline.putOperations(this.key,entries);
        if(this.closed)return;
        if(this.latestDraft)await this.offline.saveDraft(this.key,this.clientId,this.latestDraft);
        this.durable=true;this.broadcast?.postMessage({key:this.key,client:this.clientId});this.setStatus(this.status==='offline'||!navigator.onLine?'offline':'pending');
      }).catch(error=>{this.durable=false;this.onError(error);throw error;});
      this.persistence.catch(()=>{});return this.persistence;
    }
    chars(id){return visibleChars(this.state,id);}
    replaceText(id,text,baseline=this.chars(id),marks){
      const after=Array.from(text),before=baseline.map(value=>value.text);let start=0,end=0;
      while(start<before.length&&start<after.length&&before[start]===after[start])start++;
      while(end<before.length-start&&end<after.length-start&&before[before.length-1-end]===after[after.length-1-end])end++;
      const removed=baseline.slice(start,before.length-end),inserted=after.slice(start,after.length-end).join(''),specs=[];
      if(removed.length)specs.push({type:'text.delete',block_id:id,fields:{char_ids:removed.map(value=>value.id)}});
      if(inserted)specs.push({type:'text.insert',block_id:id,fields:{after_id:start?baseline[start-1].id:null,text:inserted,marks:marks||baseline[Math.max(0,start-1)]?.marks||{}}});
      return this.submit(specs);
    }
    format(id,charIds,marks){return this.submit([{type:'text.format',block_id:id,fields:{char_ids:charIds,marks:validateMarks(marks)}}]);}
    reconcile(blocks){
      const current=project(this.state),currentIds=new Set(current.map(value=>value.id)),desired=new Set(blocks.map(value=>value.id)),specs=[],previous=new Map();
      for(const value of current)if(!desired.has(value.id))specs.push({type:'block.delete',block_id:value.id});
      const currentPredecessor=new Map(),currentPrevious=new Map();for(const value of current){if(!desired.has(value.id))continue;currentPredecessor.set(value.id,currentPrevious.get(value.parent_id)||null);currentPrevious.set(value.parent_id,value.id);}
      for(const value of blocks){
        const parent=value.parent_id||null,anchor=previous.get(parent)||null,node=own(this.state.blocks,value.id)?this.state.blocks[value.id]:null;
        if(!currentIds.has(value.id)){
          specs.push({type:'block.insert',block_id:value.id,fields:{parent_id:parent,after_id:anchor,block_type:value.type||'paragraph'}});
          let textAnchor=null;const tokens=value.rich_text?.map(token=>token.text).join('')===value.text?value.rich_text:[{text:value.text||'',marks:{}}];
          for(const token of tokens||[]){if(!token.text)continue;const op=this.operation('text.insert',value.id,{after_id:textAnchor,text:token.text,marks:token.marks||{}});specs.push({operation:op});textAnchor=op.id+':'+(Array.from(token.text).length-1);}
        }else{
          const old=current.find(item=>item.id===value.id);let priorExisting=anchor;
          if(priorExisting&&!currentIds.has(priorExisting)){const index=blocks.findIndex(item=>item.id===value.id);priorExisting=[...blocks.slice(0,index)].reverse().find(item=>currentIds.has(item.id)&&(item.parent_id||null)===parent)?.id||null;}
          if(old.parent_id!==parent||currentPredecessor.get(value.id)!==priorExisting)specs.push({type:'block.move',block_id:value.id,fields:{parent_id:parent,after_id:anchor}});
          if(old.text!==(value.text||''))this.replaceText(value.id,value.text||'');
        }
        for(const key of FIELDS)if(key!=='type'&&own(value,key)&&(!node||!own(node.fields,key)||!own(node.fields[key],'value')||canonical(node.fields[key].value)!==canonical(value[key])))specs.push({type:'block.set',block_id:value.id,fields:{field:key,value:value[key]}});
        if(currentIds.has(value.id)&&current.find(item=>item.id===value.id).type!==value.type)specs.push({type:'block.set',block_id:value.id,fields:{field:'type',value:value.type}});
        previous.set(parent,value.id);
      }
      // Preallocated text insert IDs anchor rich tokens; keep their operation clocks intact.
      const operations=[];for(const spec of specs){if(spec.operation)operations.push(spec.operation);else operations.push(this.operation(spec.type,spec.block_id,spec.fields||{}));}
      if(!operations.length)return;
      this.submitPrepared(operations);
    }
    submitPrepared(operations){return this.queue(operations);}
    async flush(){
      if(this.closed||this.flushing)return this.flushing;clearTimeout(this.flushTimer);
      this.flushing=(async()=>{
        await this.persistence.catch(()=>this.persistPending());await this.importPending();if(this.closed||!this.pending.size)return;
        if(!navigator.onLine){this.setStatus('offline');return;}
        while(this.pending.size&&!this.closed){
          const entries=[...this.pending.values()].filter(entry=>!entry._epoch||entry._epoch===this.base.epoch).slice(0,300);if(!entries.length)break;
          let snapshot;try{snapshot=await this.fetch('/pages/'+encodeURIComponent(this.pageId)+'/operations',{epoch:this.base.epoch,ops:entries.map(stripEpoch)});}catch(error){
            if([401,403,404].includes(error.status)){await this.deny(error.status,error.message);return;}
            if(error.status===409){const latest=await this.fetch('/pages/'+encodeURIComponent(this.pageId)+'/collaboration');if(latest.epoch===this.base.epoch)await this.recover(entries,'rejected');await this.receive(latest,'reset');continue;}
            if(error.status===423||error.status===400){await this.recover(entries,error.status===423?'locked':'rejected');await this.rebuild('recovery');this.onError(error);return;}
            if(error.status){this.onError(error);this.setStatus('error');return;}
            this.setStatus('offline');this.retry();return;
          }
          const acknowledged=Array.isArray(snapshot.ack)?snapshot.ack:[];
          if(this.offline&&this.key)await this.offline.acknowledge(this.key,acknowledged);acknowledged.forEach(id=>this.pending.delete(id));
          await this.receive(snapshot,'ack');
          if(!acknowledged.length){this.setStatus('error');break;}
        }
        if(!this.closed)this.setStatus(this.pending.size?'pending':'synced');
      })().catch(error=>{if(!this.closed){this.onError(error);this.setStatus('error');}}).finally(()=>{this.flushing=null;});return this.flushing;
    }
    connectEvents(){
      if(this.closed||typeof EventSource==='undefined'||!navigator.onLine)return;this.source?.close();
      this.source=FountainTransport.events('/api/pages/'+encodeURIComponent(this.pageId)+'/events');
      this.source.addEventListener('snapshot',event=>{try{const data=JSON.parse(event.data);this.receive(data).then(()=>this.flush()).catch(error=>this.onError(error));}catch(error){this.onError(error);}});
      this.source.addEventListener('denied',event=>{let data;try{data=JSON.parse(event.data);}catch{data={status:403,error:'문서 접근 권한이 변경되었습니다.'};}this.deny(data.status,data.error);});
      this.source.onerror=()=>{this.source?.close();if(!this.closed){this.setStatus('offline');this.retry();}};
    }
    retry(){clearTimeout(this.retryTimer);if(this.closed)return;this.retryTimer=setTimeout(()=>this.reconnect(),this.delay);this.delay=Math.min(10000,this.delay*2);}
    async reconnect(){
      if(this.closed)return;if(!navigator.onLine){this.setStatus('offline');return;}
      try{await this.persistence.catch(()=>this.persistPending());const snapshot=await this.fetch('/pages/'+encodeURIComponent(this.pageId)+'/collaboration');await this.importPending(false);await this.receive(snapshot,'reconnect');this.connectEvents();await this.flush();}catch(error){if([401,403,404].includes(error.status))await this.deny(error.status,error.message);else{this.setStatus('offline');this.retry();}}
    }
    async deny(status,message){if(this.closed)return;this.close();this.onDenied({status,message});if(this.offline){if(status===401)await this.offline.clearProfile(this.profile).catch(()=>{});else if(this.key)await this.offline.purgeResource(this.key).catch(()=>{});}}
    close(){this.closed=true;this.source?.close();this.broadcast?.close();clearTimeout(this.flushTimer);clearTimeout(this.retryTimer);clearTimeout(this.expiryTimer);globalThis.removeEventListener('online',this.onlineHandler);globalThis.removeEventListener('offline',this.offlineHandler);globalThis.removeEventListener('fountain-offline-profile-cleared',this.profileCleared);globalThis.removeEventListener('fountain-offline-resource-purged',this.resourcePurged);globalThis.removeEventListener('fountain-offline-profile-changed',this.profileChanged);}
  }
  const exported={seedState,applyOperations,project,publicState,visibleChars,normalizeBlocks,validateMarks,canonical,sha256,compareText,DocumentChannel,PALETTE,BOOL_MARKS};
  globalThis.FountainCollaboration=exported;if(typeof module!=='undefined'&&module.exports)module.exports=exported;
})();
