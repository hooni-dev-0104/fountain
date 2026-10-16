/* Read-only saved-version comparison. No document state, DOM, or network access. */
(() => {
  'use strict';
  const DEFAULT_CELLS=200000;
  const own=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
  const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  function requireInput(valid){if(!valid)throw new TypeError('Invalid version comparison input');}
  function budget(options){const value=options.maxCells??DEFAULT_CELLS;requireInput(Number.isSafeInteger(value)&&value>=0);return value;}
  function addRun(runs,type,text){if(!text)return;const last=runs.at(-1);if(last&&last.type===type)last.parts.push(text);else runs.push({type,parts:[text]});}
  function complete(runs,coarse,cells=0){return {runs:runs.map(run=>({type:run.type,text:run.parts.join('')})),coarse,cells};}
  function previousPoint(text,end){const last=text.charCodeAt(end-1);return last>=0xdc00&&last<=0xdfff&&end>1&&text.charCodeAt(end-2)>=0xd800&&text.charCodeAt(end-2)<=0xdbff?end-2:end-1;}
  function textDifference(before,after,maxCells){
    requireInput(typeof before==='string'&&typeof after==='string');
    const runs=[];
    if(before===after){addRun(runs,'equal',before);return complete(runs,false);}
    let start=0,beforeEnd=before.length,afterEnd=after.length;
    while(start<Math.min(beforeEnd,afterEnd)){
      const point=before.codePointAt(start);if(point!==after.codePointAt(start))break;start+=point>0xffff?2:1;
    }
    while(beforeEnd>start&&afterEnd>start){
      const left=previousPoint(before,beforeEnd),right=previousPoint(after,afterEnd);
      if(left<start||right<start||before.codePointAt(left)!==after.codePointAt(right))break;
      beforeEnd=left;afterEnd=right;
    }
    addRun(runs,'equal',before.slice(0,start));
    const left=before.slice(start,beforeEnd),right=after.slice(start,afterEnd),suffix=before.slice(beforeEnd);
    const finish=(coarse,cells=0)=>{addRun(runs,'equal',suffix);return complete(runs,coarse,cells);};
    if(!left||!right){addRun(runs,'delete',left);addRun(runs,'insert',right);return finish(false);}
    // A codepoint occupies at most two UTF-16 units. Reject an oversized matrix
    // before Array.from would allocate millions of per-character entries.
    const minimumRows=Math.ceil(left.length/2)+1,minimumColumns=Math.ceil(right.length/2)+1;
    const coarse=()=>{addRun(runs,'delete',left);addRun(runs,'insert',right);return finish(true);};
    if(minimumRows>maxCells/minimumColumns)return coarse();
    const a=Array.from(left),b=Array.from(right),rows=a.length+1,columns=b.length+1;
    if(rows>maxCells/columns)return coarse();
    const cells=rows*columns,matrix=new Uint32Array(cells);
    for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)matrix[i*columns+j]=a[i]===b[j]?matrix[(i+1)*columns+j+1]+1:Math.max(matrix[(i+1)*columns+j],matrix[i*columns+j+1]);
    let i=0,j=0;
    while(i<a.length||j<b.length){
      if(i<a.length&&j<b.length&&a[i]===b[j]){addRun(runs,'equal',a[i++]);j++;}
      else if(i<a.length&&(j===b.length||matrix[(i+1)*columns+j]>=matrix[i*columns+j+1]))addRun(runs,'delete',a[i++]);
      else addRun(runs,'insert',b[j++]);
    }
    return finish(false,cells);
  }
  function diffText(before,after,options={}){const {runs,coarse}=textDifference(before,after,budget(options));return {runs,coarse};}

  function canonical(value,path=new Set()){
    if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
    if(typeof value==='number'){requireInput(Number.isFinite(value));return JSON.stringify(value);}
    requireInput((Array.isArray(value)||object(value))&&!path.has(value)&&path.size<64);
    path.add(value);
    const result=Array.isArray(value)?'['+value.map(item=>canonical(item,path)).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key],path)).join(',')+'}';
    path.delete(value);return result;
  }
  function blockText(block){
    if(own(block,'text')){requireInput(typeof block.text==='string');return block.text;}
    return (block.rich_text||[]).map(token=>{requireInput(object(token)&&typeof token.text==='string');return token.text;}).join('');
  }
  function indexVersion(version){
    requireInput(object(version)&&typeof version.title==='string'&&Array.isArray(version.blocks));
    const indexed=new Map();
    for(const block of version.blocks){
      requireInput(object(block)&&typeof block.id==='string'&&block.id.length>0&&!indexed.has(block.id));
      requireInput(block.parent_id==null||typeof block.parent_id==='string');
      requireInput(block.rich_text===undefined||Array.isArray(block.rich_text));
      indexed.set(block.id,block);blockText(block);
    }
    return indexed;
  }
  function parent(block){return block.parent_id??null;}
  function attributes(block){
    const result=Object.create(null);
    for(const key of Object.keys(block))if(!['id','text','parent_id','rich_text'].includes(key))result[key]=block[key];
    return canonical(result);
  }
  function markDescriptor(marks){
    const result=Object.create(null);
    for(const key of Object.keys(marks)){
      const value=marks[key];
      if(['bold','italic','underline','strike','code'].includes(key)&&value===false)continue;
      if((key==='color'||key==='background')&&value==='default')continue;
      if(key==='link'&&(value===null||value===''))continue;
      result[key]=value;
    }
    return canonical(result);
  }
  function markSpans(block,text){
    const spans=[];let offset=0,valid=true;
    for(const token of block.rich_text||[]){
      requireInput(object(token)&&typeof token.text==='string'&&(token.marks===undefined||object(token.marks)));
      valid=valid&&text.startsWith(token.text,offset);offset+=token.text.length;
      if(!token.text)continue;
      const marks=markDescriptor(token.marks||{}),last=spans.at(-1);
      if(last&&last.marks===marks)last.end=offset;else spans.push({end:offset,marks});
    }
    // Match the editor's legacy plain-text replacement behavior: stale rich
    // tokens cannot silently retain formatting on a replaced plain body.
    if(!valid||offset!==text.length)return text?[{end:text.length,marks:'{}'}]:[];
    return spans;
  }
  function formatChanged(before,after,difference){
    const left=markSpans(before,blockText(before)),right=markSpans(after,blockText(after));
    let beforeOffset=0,afterOffset=0,i=0,j=0,equalLength=0;
    for(const run of difference.runs){
      const length=run.text.length;
      if(run.type==='equal'){
        equalLength+=length;let remaining=length;
        while(remaining){
          while(i<left.length&&left[i].end<=beforeOffset)i++;
          while(j<right.length&&right[j].end<=afterOffset)j++;
          const first=left[i],second=right[j];
          if(first?.marks!==second?.marks)return true;
          const step=Math.min(remaining,first.end-beforeOffset,second.end-afterOffset);
          requireInput(step>0);beforeOffset+=step;afterOffset+=step;remaining-=step;
        }
      }else if(run.type==='delete')beforeOffset+=length;else afterOffset+=length;
    }
    // With no retained characters, compare styles rather than token lengths.
    // Otherwise formatting on newly inserted/deleted text belongs to that text
    // edit and does not falsely mark unchanged characters as reformatted.
    if(!equalLength){
      const descriptors=spans=>JSON.stringify(spans.length?spans.map(value=>value.marks):['{}']);
      return descriptors(left)!==descriptors(right);
    }
    return false;
  }

  function movedBlocks(before,after){
    const moved=new Set(),previous=new Map(),current=new Map();
    for(const [id,block] of before)if(after.has(id)){
      if(parent(block)!==parent(after.get(id))){moved.add(id);continue;}
      const key=parent(block);if(!previous.has(key))previous.set(key,[]);previous.get(key).push(id);
    }
    for(const [id,block] of after)if(before.has(id)&&!moved.has(id)){
      const key=parent(block);if(!current.has(key))current.set(key,[]);current.get(key).push(id);
    }
    for(const [key,ids] of current){
      const positions=new Map(previous.get(key).map((id,index)=>[id,index])),tails=[],tailIndices=[],predecessors=new Int32Array(ids.length).fill(-1);
      for(let index=0;index<ids.length;index++){
        const value=positions.get(ids[index]);let low=0,high=tails.length;
        while(low<high){const middle=(low+high)>>>1;if(tails[middle]<value)low=middle+1;else high=middle;}
        if(low)predecessors[index]=tailIndices[low-1];
        tails[low]=value;tailIndices[low]=index;
      }
      const retained=new Set();let index=tailIndices.at(-1);
      while(index!==undefined&&index>=0){retained.add(ids[index]);index=predecessors[index];}
      for(const id of ids)if(!retained.has(id))moved.add(id);
    }
    return moved;
  }
  function orderedIdentities(before,after){
    const removed=new Map();let anchor=null;
    for(const id of [...before.keys()].reverse()){
      if(after.has(id))anchor=id;
      else{if(!removed.has(anchor))removed.set(anchor,[]);removed.get(anchor).push(id);}
    }
    const result=[],appendRemoved=anchor=>{const ids=removed.get(anchor)||[];for(let index=ids.length-1;index>=0;index--)result.push(ids[index]);};
    for(const id of after.keys()){appendRemoved(id);result.push(id);}
    appendRemoved(null);return result;
  }
  function compareVersions(before,after,options={}){
    const previous=indexVersion(before),current=indexVersion(after),moved=movedBlocks(previous,current);
    let remaining=budget(options),coarse=false;
    const compareText=(left,right)=>{const result=textDifference(left,right,remaining);remaining-=result.cells;coarse=coarse||result.coarse;return {runs:result.runs,coarse:result.coarse};};
    const titleDiff=compareText(before.title,after.title),summary={added:0,removed:0,moved:0,textChanged:0,attributesChanged:0},changes=[];
    for(const id of orderedIdentities(previous,current)){
      const first=previous.get(id)||null,second=current.get(id)||null;
      const textDiff=compareText(first?blockText(first):'',second?blockText(second):'');
      const common=first!==null&&second!==null;
      const change={id,before:first,after:second,added:first===null,removed:second===null,moved:moved.has(id),
        textChanged:common&&blockText(first)!==blockText(second),
        attributesChanged:common&&(attributes(first)!==attributes(second)||formatChanged(first,second,textDiff)),textDiff};
      for(const key of Object.keys(summary))if(change[key])summary[key]++;
      changes.push(change);
    }
    return {titleChanged:before.title!==after.title,titleDiff,changes,summary,coarse};
  }
  const exported={diffText,compareVersions};
  globalThis.FountainVersionDiff=exported;
  if(typeof module!=='undefined'&&module.exports)module.exports=exported;
})();
