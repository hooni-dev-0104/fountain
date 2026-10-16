/* Recovery files are data, never receipts, credentials, or executable operations. */
(() => {
  'use strict';
  const C=globalThis.FountainCollaboration||(typeof require==='function'?require('./collaboration.js'):null);
  const MAX_BYTES=16*1024*1024,MAX_RECORDS=1000,MAX_BLOCKS=2000,MAX_RGA_POINTS=50000;
  const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
  const copy=value=>structuredClone(value);
  function fail(message='복구 파일 형식을 확인해 주세요.',code='INVALID_RECOVERY',status=400){const error=new Error(message);Object.assign(error,{code,status});throw error;}
  function check(value,message){if(!value)fail(message);}
  function identity(value){check(typeof value==='string'&&value.length>0&&Array.from(value).length<=160&&!/[\\/\u0000-\u001f\u007f]/.test(value)&&!['.','..'].includes(value));return value;}
  function preflight(text){
    let depth=0,nodes=0,quoted=false,escaped=false,start=true;
    for(let index=0;index<text.length;index++){
      const point=text[index];
      if(quoted){if(escaped)escaped=false;else if(point==='\\')escaped=true;else if(point==='"')quoted=false;continue;}
      if(point==='"'){quoted=true;start=false;check(++nodes<=150000,'복구 파일의 항목 수가 너무 큽니다.');}
      else if(point==='{'||point==='['){check(++depth<=32&&++nodes<=150000,'복구 파일의 중첩 또는 항목 수가 너무 큽니다.');start=true;}
      else if(point==='}'||point===']'){check(--depth>=0);start=false;}
      else if(point===','||point===':')start=true;
      else if(!/\s/.test(point)&&start){check(++nodes<=150000,'복구 파일의 항목 수가 너무 큽니다.');start=false;}
    }
  }
  function bounded(value){
    const stack=[[value,0]];let nodes=0;
    while(stack.length){const [current,depth]=stack.pop();check(++nodes<=150000&&depth<=32,'복구 파일의 중첩 또는 항목 수가 너무 큽니다.');
      if(typeof current==='string'){for(const point of current){const code=point.codePointAt(0);check(code<0xd800||code>0xdfff,'올바르지 않은 유니코드가 포함되어 있습니다.');}}
      else if(current&&typeof current==='object')for(const key of Object.keys(current)){check(!['__proto__','prototype','constructor'].includes(key),'안전하지 않은 속성 이름입니다.');stack.push([current[key],depth+1]);}
      else check(current===null||typeof current==='boolean'||typeof current==='number'&&Number.isFinite(current));
    }
  }
  function origin(value){try{const url=new URL(value);check(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash);return url.origin;}catch{fail('복구 파일의 서버 주소가 올바르지 않습니다.');}}
  function namespace(value){
    check(typeof value==='string');const parts=value.split('|');check(parts.length>=4);
    try{return {origin:origin(parts[0]),workspaceId:decodeURIComponent(parts[1]),memberId:decodeURIComponent(parts[2]),sourceBinding:decodeURIComponent(parts[3])};}catch{fail('복구 파일의 출처 정보가 올바르지 않습니다.');}
  }
  function marks(value){check(value===undefined||object(value));try{return C.validateMarks(value||{});}catch{fail('복구 파일의 서식 또는 링크가 올바르지 않습니다.');}}
  function bodyCodePoints(values,{limit=Infinity}={}){
    check(Array.isArray(values));let count=0;
    for(const block of values){const chunks=typeof block.text==='string'?[block.text]:(block.rich_text||[]).map(token=>token.text||'');for(const text of chunks)for(const point of text){count++;if(count>limit)return limit+1;}}
    return count;
  }
  // This is an amplification fence, not a replacement for the CRDT validator.
  // Count mark candidates as well as characters, and never enumerate string maps.
  function replayPoints(state,operations){
    let count=0;
    const invalid=()=>{count=MAX_RGA_POINTS+1;return false;};
    const add=value=>{if(!Number.isSafeInteger(value)||value<0||value>MAX_RGA_POINTS-count)return invalid();count+=value;return true;};
    const id=(value,limit=300)=>typeof value==='string'&&value.length>0&&value.length<=limit;
    const stamp=value=>value===null||Array.isArray(value)&&value.length===3&&Number.isSafeInteger(value[0])&&value[0]>=0&&id(value[1],80)&&id(value[2]);
    const markNames=['bold','italic','underline','strike','code','color','background','link'];
    const markMap=value=>object(value)&&Object.keys(value).every(key=>markNames.includes(key));
    const text=value=>{if(typeof value!=='string')return invalid();let points=0;for(const point of value)if(++points>MAX_RGA_POINTS)return invalid();return points;};
    if(!object(state)||!object(state.blocks)||!object(state.seen))return MAX_RGA_POINTS+1;
    const containers=[state.blocks];
    if(state.history){if(!object(state.history)||!object(state.history.baseline)||!object(state.history.baseline.blocks)||!object(state.history.ops))return MAX_RGA_POINTS+1;containers.push(state.history.baseline.blocks);}
    for(const container of containers){
      if(Object.keys(container).length>MAX_BLOCKS)return MAX_RGA_POINTS+1;
      for(const [blockId,block]of Object.entries(container)){
        if(!id(blockId,160)||!object(block)||!object(block.fields)||!object(block.chars)||!stamp(block.insert)||!stamp(block.move))return MAX_RGA_POINTS+1;
        for(const [field,register]of Object.entries(block.fields))if(!['type','checked','language','attachment_id','size'].includes(field)||!object(register)||!stamp(register.stamp))return MAX_RGA_POINTS+1;
        for(const [charId,char]of Object.entries(block.chars)){
          if(!id(charId)||!object(char)||!stamp(char.stamp)||!markMap(char.marks)||!add(1+Object.keys(char.marks).length))return MAX_RGA_POINTS+1;
          for(const register of Object.values(char.marks))if(!object(register)||!stamp(register.stamp))return MAX_RGA_POINTS+1;
        }
      }
    }
    const operationCost=(operation,isPublic)=>{
      if(!object(operation)||!id(operation.id)||!id(operation.client,80)||!Number.isSafeInteger(operation.clock)||operation.clock<=0)return invalid();
      if(operation.type==='history.cancel')return Array.isArray(operation.targets)&&operation.targets.every(value=>id(value))||invalid();
      if(!id(operation.block_id,160))return invalid();
      if(!['text.insert','text.delete','text.format'].includes(operation.type))return ['block.insert','block.move','block.set','block.delete'].includes(operation.type)||invalid();
      let markCount=0;
      if(operation.type!=='text.delete'){
        if(isPublic){if(!Array.isArray(operation.mark_keys)||!operation.mark_keys.every(key=>markNames.includes(key))||new Set(operation.mark_keys).size!==operation.mark_keys.length)return invalid();markCount=operation.mark_keys.length;}
        else{if(!markMap(operation.marks||{}))return invalid();try{C.validateMarks(operation.marks||{});}catch{return invalid();}markCount=Object.keys(operation.marks||{}).length;}
      }
      if(operation.type==='text.insert'){
        const points=isPublic?operation.character_count:text(operation.text);
        return Number.isSafeInteger(points)&&points>=0&&add(points*(1+markCount))||invalid();
      }
      return Array.isArray(operation.char_ids)&&operation.char_ids.every(value=>id(value))&&add(operation.char_ids.length*(1+markCount))||invalid();
    };
    for(const operation of Object.values(state.history?.ops||{}))if(!operationCost(operation,state.history.public===true))return count;
    for(const operation of operations)if(!operationCost(operation,false))return count;
    return count;
  }
  function blocks(values,counter){
    check(Array.isArray(values));counter.blocks+=values.length;check(counter.blocks<=MAX_BLOCKS,'본문 블록은 합쳐서 2000개까지 가져올 수 있습니다.');
    const sanitized=values.map(value=>{check(object(value));const result={id:identity(value.id),type:value.type||'paragraph',text:value.text??(value.rich_text||[]).map(token=>token.text||'').join(''),parent_id:value.parent_id??null};
      if(result.parent_id!==null)identity(result.parent_id);
      for(const field of ['checked','language','attachment_id','size'])if(own(value,field))result[field]=copy(value[field]);
      if(value.rich_text!==undefined){check(Array.isArray(value.rich_text));result.rich_text=value.rich_text.map(token=>{check(object(token)&&typeof token.text==='string');return {text:token.text,marks:marks(token.marks)};});}
      return result;
    });
    try{return C.normalizeBlocks(sanitized);}catch{fail('복구할 본문 블록이 올바르지 않습니다.');}
  }
  function readable(text,counter){
    const result=[];let offset=0;
    while(offset<text.length){let end=Math.min(offset+100000,text.length);if(end<text.length&&text.charCodeAt(end-1)>=0xd800&&text.charCodeAt(end-1)<=0xdbff)end--;result.push({id:'raw-import-'+(counter.raw=(counter.raw||0)+1),type:'code',language:'json',parent_id:null,text:text.slice(offset,end),rich_text:[{text:text.slice(offset,end),marks:{}}]});offset=end;}
    counter.blocks+=result.length;check(counter.blocks<=MAX_BLOCKS,'복구할 본문 블록이 너무 많습니다.');return result;
  }
  function rawDraft(value,counter,warnings,originalText){
    check(object(value)&&Object.keys(value).every(key=>['epoch','seq','ops','blocks','reason','createdAt','history_pending','imported','source_digest'].includes(key)),'본문 복구 파일에 지원하지 않는 정보가 있습니다.');
    check(value.blocks!==undefined||Array.isArray(value.ops));
    if(value.blocks!==undefined){check(Array.isArray(value.blocks));if(value.blocks.length)return {blocks:blocks(value.blocks,counter),reason:'imported',...(value.history_pending?{history_pending:true}:{})};}
    check(Array.isArray(value.ops));warnings.push('원래 문자 위치를 확정할 수 없는 작업은 재실행하지 않고 JSON 원문을 코드 블록으로 보관합니다.');
    return {blocks:readable(originalText??JSON.stringify(value,null,2),counter),reason:'imported_ops_only',ops_only:true};
  }
  function typedOperation(record){
    check(object(record)&&object(record.operation));const operation=record.operation;
    check(['page.create','page.patch','row.create','row.patch','row.delete'].includes(operation.kind));
    const result={id:identity(operation.id),kind:operation.kind,target_id:identity(operation.target_id),body:{},depends_on:[]};
    check(object(operation.body||{}));const body=operation.body||{};
    if(operation.kind.startsWith('page.')){
      const allowed=operation.kind==='page.create'?['title','icon','cover','parent_id','teamspace_id']:['title','icon','cover','favorite'];
      for(const key of allowed)if(own(body,key))result.body[key]=copy(body[key]);
      for(const key of ['title','icon','cover'])if(own(result.body,key))check(typeof result.body[key]==='string'&&Array.from(result.body[key]).length<=(key==='title'?500:10000));
      if(own(result.body,'favorite'))check(typeof result.body.favorite==='boolean');
      for(const key of ['parent_id','teamspace_id'])if(result.body[key]!=null)identity(result.body[key]);
      if(operation.kind==='page.create'){result.body.title??='제목 없음';result.body.icon??='📄';result.body.cover??='';result.body.parent_id??=null;}
    }else{
      result.database_id=identity(operation.database_id);
      if(operation.kind!=='row.delete'){
        check(body.properties===undefined||object(body.properties));result.body.properties=copy(body.properties||{});
        if(own(body,'parent_row_id'))result.body.parent_row_id=body.parent_row_id===null?null:identity(body.parent_row_id);
        if(own(body,'depends_on')){check(Array.isArray(body.depends_on)&&body.depends_on.length<=1000);result.body.depends_on=body.depends_on.map(identity);}
      }
    }
    check(operation.depends_on===undefined||Array.isArray(operation.depends_on)&&operation.depends_on.length<=1000);
    result.depends_on=[...new Set([...(operation.depends_on||[]),...Object.values(operation.base_rows||{}).map(value=>value?.after_operation).filter(Boolean)].map(identity))];
    return {operation:result,sourceStatus:typeof record.status==='string'?record.status:'unknown'};
  }
  function topological(records,extraEdges=new Map()){
    const known=new Map(records.map(record=>[record.operation.id,record])),children=new Map(),indegree=new Map(records.map(record=>[record.operation.id,0]));let edges=0;
    check(known.size===records.length,'복구 파일에 중복된 변경 식별자가 있습니다.');
    for(const record of records){const id=record.operation.id;for(const target of new Set([...(record.operation.depends_on||[]),...(extraEdges.get(id)||[])]))if(known.has(target)){
      check(++edges<=50000,'복구 변경의 연결이 너무 많습니다.');if(!children.has(target))children.set(target,[]);children.get(target).push(id);indegree.set(id,indegree.get(id)+1);
    }}
    const queue=records.filter(record=>indegree.get(record.operation.id)===0),result=[];
    for(let index=0;index<queue.length;index++){const record=queue[index];result.push(record);for(const id of children.get(record.operation.id)||[]){indegree.set(id,indegree.get(id)-1);if(indegree.get(id)===0)queue.push(known.get(id));}}
    check(result.length===records.length,'복구 변경의 의존 관계에 순환이 있습니다.');return result;
  }
  function parse(text,expected){
    check(C&&typeof text==='string'&&text.length<=MAX_BYTES&&new TextEncoder().encode(text).byteLength<=MAX_BYTES,'복구 JSON은 16MiB까지 가져올 수 있습니다.');
    preflight(text);let value;try{value=JSON.parse(text);}catch{fail('JSON 복구 파일을 읽을 수 없습니다.');}bounded(value);check(object(value));
    const counter={blocks:0},warnings=[],raw=!own(value,'format');let source;
    if(raw){const draft=rawDraft(value,counter,warnings,text),normalized={source:null,records:[],localPages:[],drafts:[{page_id:null,draft}],kind:'body'};return {...normalized,digest:C.sha256(C.canonical(value)),summary:{records:0,localPages:0,drafts:1,blocks:counter.blocks,replayedCodePoints:0},warnings:['본문만 현재 선택한 문서의 복구 내용으로 복사합니다.',...warnings]};}
    check(['fountain-mutation-recovery-v1','fountain-recovery-v2'].includes(value.format),'지원하지 않는 복구 파일 버전입니다.');
    const candidates=[];
    if(value.origin!==undefined)candidates.push({origin:origin(value.origin),workspaceId:value.workspace_id,memberId:value.member_id,sourceBinding:value.source_binding});
    check(Array.isArray(value.records)&&value.records.length<=MAX_RECORDS);
    for(const record of value.records){check(object(record));if(record.profileId)candidates.push(namespace(record.profileId));if(record.resourceKey)candidates.push(namespace(record.resourceKey));}
    check(candidates.length>0,'복구 파일의 원래 서버와 계정을 확인할 수 없습니다.');
    source={...candidates[0]};source.workspaceId=identity(source.workspaceId??value.workspace_id);source.memberId=identity(source.memberId??value.member_id);
    check(typeof source.sourceBinding==='string'&&source.sourceBinding.length>0&&source.sourceBinding.length<=1000,'복구 파일의 원래 로그인 출처를 확인할 수 없습니다.');
    for(const candidate of candidates)check(candidate.origin===source.origin&&candidate.workspaceId===source.workspaceId&&candidate.memberId===source.memberId&&(!candidate.sourceBinding||candidate.sourceBinding===source.sourceBinding),'복구 파일 안의 계정 출처가 서로 다릅니다.');
    check(value.workspace_id===source.workspaceId&&value.member_id===source.memberId,'복구 파일의 계정 출처가 서로 다릅니다.');
    if(source.origin!==origin(expected.origin)||source.workspaceId!==expected.workspaceId||source.memberId!==expected.memberId)fail('다른 서버·워크스페이스·계정의 복구 파일은 가져올 수 없습니다.','IMPORT_SOURCE_MISMATCH',403);
    const records=value.records.map(typedOperation);
    for(let index=0;index<records.length;index++){
      const original=value.records[index],operation=records[index].operation;
      if(original.profileId)check(original.profileId.split('|').length===4,'복구 변경의 프로필 출처가 올바르지 않습니다.');
      if(original.resourceKey){const parts=original.resourceKey.split('|'),database=operation.kind.startsWith('row.');
        check(parts.length===(database?6:5)&&(!database||parts[4]==='database'),'복구 리소스 종류가 일치하지 않습니다.');
        try{check(decodeURIComponent(parts.at(-1))===(database?operation.database_id:operation.target_id),'복구 리소스와 변경 대상이 일치하지 않습니다.');}catch{fail('복구 리소스 식별자가 올바르지 않습니다.');}
      }
    }
    topological(records);
    if(records.some(record=>record.sourceStatus==='applied'))warnings.push('과거 반영 상태와 영수증은 다시 실행할 권한이나 성공 증거로 사용하지 않습니다.');
    if(records.some(record=>record.operation.kind.endsWith('.create')))warnings.push('새 문서와 새 항목은 새로운 식별자를 가진 사본으로 준비합니다.');
    const localPages=[],legacyDrafts=[];check(value.localPages===undefined||Array.isArray(value.localPages)&&value.localPages.length<=MAX_RECORDS);
    for(const local of value.localPages||[]){
      check(object(local)&&object(local.metadata)&&object(local.metadata.page)&&object(local.snapshot));const pageId=identity(local.metadata.page.id);
      check(local.snapshot.page?.id===pageId,'새 문서의 본문 식별자가 일치하지 않습니다.');
      for(const [field,expectedValue] of [['workspace_id',source.workspaceId],['current_member_id',source.memberId],['session_binding',source.sourceBinding]])if(local.snapshot[field]!==undefined)check(local.snapshot[field]===expectedValue,'새 문서 본문의 출처가 서로 다릅니다.');
      check(records.some(record=>record.operation.kind==='page.create'&&record.operation.target_id===pageId),'새 문서를 만들 변경 기록이 없습니다.');
      let body=null,replayFailed=false;const operations=local.operations||[];check(Array.isArray(operations));
      const matching=operations.filter(operation=>operation?._epoch===local.snapshot.epoch),unmatched=operations.filter(operation=>operation?._epoch!==local.snapshot.epoch);
      const drafts=(local.drafts||[]).filter(record=>record?.draft?.blocks?.length&&record.draft.reason==='pending'&&record.draft.epoch===local.snapshot.epoch).sort((a,b)=>(a.updatedAt||0)-(b.updatedAt||0));
      const estimated=local.snapshot.state?replayPoints(local.snapshot.state,matching):0,replayAllowed=estimated+(counter.replayPoints||0)<=MAX_RGA_POINTS;
      if(local.snapshot.state&&replayAllowed){
        counter.replayPoints=(counter.replayPoints||0)+estimated;
        try{let state=copy(local.snapshot.state);for(let offset=0;offset<matching.length;offset+=1000)state=C.applyOperations(state,matching.slice(offset,offset+1000).map(({_epoch,...operation})=>operation));if(!state.unresolved_slots?.length)body=blocks(C.project(state),counter);}catch{replayFailed=true;/* Preserve the last readable view and original lineage below. */}
      }
      if(!replayAllowed)warnings.push('한 번에 자동 복원할 수 있는 본문 구성 범위를 넘어 읽을 수 있는 본문과 원문 상태·작업 JSON을 보관했습니다. 정확한 본문 복원으로 표시하지 않습니다.');
      const appendDocument=raw=>{const used=new Set(body.map(block=>block.id));for(const block of readable(JSON.stringify(raw,null,2),counter)){while(used.has(block.id))block.id='raw-import-'+(++counter.raw);used.add(block.id);body.push(block);}};
      const appendRaw=raw=>appendDocument({ops:raw});
      if(body===null){
        body=blocks(drafts.length?drafts.at(-1).draft.blocks:local.snapshot.blocks||[],counter);
        if(!replayAllowed||replayFailed){warnings.push('원래 본문 상태를 자동 실행하지 않고 상태·작업 JSON을 함께 보관합니다.');appendDocument({state:local.snapshot.state??null,ops:matching});}
        else if(matching.length){warnings.push('새 문서의 원래 작업 위치를 확정하지 못해 마지막 본문과 작업 JSON을 함께 보관합니다.');appendRaw(matching);}
      }
      if(unmatched.length){warnings.push('다른 문서 버전이거나 버전이 없는 작업은 본문에 합치지 않고 JSON 코드 블록으로 보관합니다.');appendRaw(unmatched);}
      for(const record of local.drafts||[])if(record?.draft&&!['pending','basis'].includes(record.draft.reason))legacyDrafts.push({page_id:pageId,draft:rawDraft(record.draft,counter,warnings)});
      check(!localPages.some(item=>item.page_id===pageId),'새 문서 본문이 중복되어 있습니다.');localPages.push({page_id:pageId,blocks:body});
    }
    for(const record of records)if(record.operation.kind==='page.create')check(localPages.some(page=>page.page_id===record.operation.target_id),'새 문서의 복구 본문이 없습니다.');
    const drafts=[...legacyDrafts];check(value.drafts===undefined||Array.isArray(value.drafts)&&value.drafts.length<=MAX_RECORDS);
    for(const entry of value.drafts||[]){check(object(entry));drafts.push({page_id:identity(entry.page_id),draft:rawDraft(entry.draft,counter,warnings)});}
    check(records.length+drafts.length>0,'복구할 내용이 없습니다.');
    const normalized={source,records,localPages,drafts,kind:records.length?'typed':'body'};
    return {...normalized,digest:C.sha256(C.canonical(normalized)),summary:{records:records.length,localPages:localPages.length,drafts:drafts.length,blocks:counter.blocks,replayedCodePoints:counter.replayPoints||0},warnings:[...new Set(warnings)]};
  }
  function wrapDraft(profile,pageId,draft){return {format:'fountain-recovery-v2',origin:profile.origin,workspace_id:profile.workspaceId,member_id:profile.memberId,source_binding:profile.cacheBinding||profile.session?.cache_binding,records:[],localPages:[],drafts:[{page_id:identity(pageId),draft:copy(draft)}]};}
  function remapBlocks(blocks,{newId}){
    check(new Set(blocks.map(block=>block.id)).size===blocks.length,'복구 본문 식별자가 중복되어 있습니다.');
    const mapping=new Map(blocks.map(block=>[block.id,newId()]));return blocks.map(block=>({...copy(block),id:mapping.get(block.id),parent_id:mapping.get(block.parent_id)||null}));
  }
  function buildBody(blocks,{newId,clientId,epoch}){
    const freshBlocks=remapBlocks(blocks,{newId}),mapping=new Map(blocks.map((block,index)=>[block.id,freshBlocks[index].id])),operations=[];let clock=0;const previous=new Map();
    const add=(type,block_id,fields)=>{const op={id:clientId+':'+(++clock),client:clientId,clock,type,block_id,group_id:'imported_body',...fields};operations.push({...op,_epoch:epoch});return op;};
    for(const block of blocks){const id=mapping.get(block.id),parent_id=mapping.get(block.parent_id)||null;add('block.insert',id,{block_type:block.type,parent_id,after_id:previous.get(parent_id)||null});previous.set(parent_id,id);
      for(const field of ['checked','language','attachment_id','size'])if(own(block,field))add('block.set',id,{field,value:copy(block[field])});
      let after_id=null;for(const token of block.rich_text?.length?block.rich_text:[{text:block.text||'',marks:{}}])if(token.text){const op=add('text.insert',id,{after_id,text:token.text,marks:copy(token.marks||{})});after_id=op.id+':'+(Array.from(token.text).length-1);}
    }
    return {blocks:freshBlocks,operations};
  }
  const exported={parse,wrapDraft,buildBody,remapBlocks,bodyCodePoints,MAX_RGA_POINTS,topological,identity};globalThis.FountainRecovery=Object.freeze(exported);if(typeof module!=='undefined'&&module.exports)module.exports=exported;
})();
