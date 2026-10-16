/* Ephemeral page presence. Nothing here is written to IndexedDB or CacheStorage. */
(() => {
  'use strict';
  const COLORS = new Set(['#2563eb','#7c3aed','#db2777','#dc2626','#ea580c','#16a34a','#0891b2','#4f46e5']);
  const copy = value => structuredClone(value);
  class Manager {
    constructor({pageId,profile,clientId,epoch,isCurrent,isAuthorized,getSelection,getBlockElement,getChars,onParticipants=()=>{},onDenied=()=>{}}) {
      Object.assign(this,{pageId,profile,clientId,epoch,isCurrent,isAuthorized,getSelection,getBlockElement,getChars,onParticipants,onDenied});
      this.closed=false;this.running=false;this.seq=0;this.revision=-1;this.generation=0;this.participants=[];this.selection=null;this.requests=new Set();
      this.overlay=document.createElement('div');this.overlay.className='presence-overlay';this.overlay.setAttribute('aria-hidden','true');document.body.append(this.overlay);
      this.visibility=()=>document.visibilityState==='hidden'?this.pause():this.start();
      this.offline=()=>this.pause({leave:false});this.online=()=>this.start();
      this.pagehide=()=>this.pause();this.pageshow=()=>this.start();
      this.relayout=()=>this.layout();
      document.addEventListener('visibilitychange',this.visibility);
      addEventListener('offline',this.offline);addEventListener('online',this.online);addEventListener('pagehide',this.pagehide);addEventListener('pageshow',this.pageshow);
      addEventListener('resize',this.relayout);addEventListener('scroll',this.relayout,true);
      this.resizeObserver=typeof ResizeObserver==='function'?new ResizeObserver(this.relayout):null;
      this.editor=document.querySelector('#blocks');if(this.editor)this.resizeObserver?.observe(this.editor);
    }
    eligible() { return !this.closed&&navigator.onLine&&document.visibilityState!=='hidden'&&this.isAuthorized()&&this.isCurrent(); }
    nextSequence() { if(this.seq>=Number.MAX_SAFE_INTEGER){this.pause({leave:false});return null;}return ++this.seq; }
    start() {
      if(!this.eligible()||this.running)return;
      this.running=true;this.selection=null;this.dirty=true;this.send();
      this.heartbeat=setInterval(()=>{if(this.eligible()){this.dirty=true;this.send();}else this.pause({leave:false});},5000);
    }
    restart(epoch) {
      if(this.closed||epoch===this.epoch)return;
      this.pause({leave:false});this.epoch=epoch;this.revision=-1;this.selfId=null;this.selection=null;this.start();
    }
    update(selection=this.getSelection()) {
      if(!this.eligible()){this.pause({leave:false});return;}
      // Only RGA character identifiers and codepoint offsets are transmitted.
      this.selection=selection?{block_id:selection.block_id,anchor:copy(selection.anchor),focus:copy(selection.focus)}:null;
      clearTimeout(this.debounce);this.debounce=setTimeout(()=>{this.dirty=true;this.send();},100);
    }
    async send() {
      if(!this.running||!this.eligible()||this.sending||!this.dirty)return;
      const seq=this.nextSequence();if(!seq)return;
      this.dirty=false;const generation=this.generation,epoch=this.epoch,abort=new AbortController();this.requests.add(abort);this.sending=abort;
      this.announced=true;
      const timer=setTimeout(()=>abort.abort(),6000);
      try {
        const response=await FountainTransport.request('/api/pages/'+encodeURIComponent(this.pageId)+'/presence',{method:'PUT',signal:abort.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({session_binding:this.profile.session.cache_binding,epoch,client_id:this.clientId,seq,selection:this.selection})});
        const payload=await response.json();
        if(this.closed||generation!==this.generation||!this.eligible()||epoch!==this.epoch)return;
        if(!response.ok){const error=new Error(payload.error||'접속 상태를 확인하지 못했습니다.');error.status=response.status;throw error;}
        this.announced=true;this.receive(payload);
      }catch(error){
        if(!this.closed&&generation===this.generation){this.clear();if([401,403,404].includes(error.status)){this.pause({leave:false});this.onDenied({status:error.status,message:error.message});}}
      }finally{
        clearTimeout(timer);this.requests.delete(abort);if(this.sending===abort)this.sending=null;
        if(!this.closed&&generation===this.generation&&this.dirty&&this.eligible())this.send();
      }
    }
    receive(payload) {
      if(!this.running||!this.eligible()||payload?.epoch!==this.epoch||payload.workspace_id!==this.profile.workspaceId||payload.current_member_id!==this.profile.memberId||payload.session_binding!==this.profile.session.cache_binding||!Number.isSafeInteger(payload.revision)||payload.revision<this.revision||!Array.isArray(payload.participants))return false;
      this.revision=payload.revision;if(typeof payload.participant_id==='string')this.selfId=payload.participant_id;
      this.participants=payload.participants.filter(person=>person&&typeof person.id==='string'&&typeof person.name==='string'&&typeof person.member_id==='string'&&typeof person.client_id==='string'&&COLORS.has(person.color)).map(copy);
      clearTimeout(this.expiry);this.expiry=setTimeout(()=>this.clear(),15000);
      this.onParticipants(copy(this.participants));this.layout();return true;
    }
    clear() { this.participants=[];this.overlay.replaceChildren();this.onParticipants([]); }
    pause({leave=true}={}) {
      if(this.closed)return;
      const announced=this.announced;this.announced=false;this.running=false;this.generation++;this.dirty=false;
      clearInterval(this.heartbeat);clearTimeout(this.debounce);clearTimeout(this.expiry);
      for(const request of this.requests)request.abort();this.requests.clear();this.sending=null;this.clear();
      if(leave&&announced&&navigator.onLine&&this.isAuthorized())this.leave();
    }
    leave() {
      const seq=this.nextSequence();if(!seq)return;
      FountainTransport.request('/api/pages/'+encodeURIComponent(this.pageId)+'/presence',{method:'DELETE',keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify({session_binding:this.profile.session.cache_binding,epoch:this.epoch,client_id:this.clientId,seq})}).catch(()=>{});
    }
    point(point,chars) {
      if(!point)return null;
      let index=point.before?chars.findIndex(char=>char.id===point.before):-1;if(index>=0)return index+1;
      index=point.after?chars.findIndex(char=>char.id===point.after):-1;if(index>=0)return index;
      if(point.before||point.after)return null;
      return Number.isSafeInteger(point.offset)?Math.min(chars.length,Math.max(0,point.offset)):null;
    }
    locate(element,offset) {
      let left=offset,node;const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);
      while((node=walker.nextNode())){const points=Array.from(node.textContent);if(left<=points.length)return [node,points.slice(0,left).join('').length];left-=points.length;}
      return [element,element.childNodes.length];
    }
    caretRect(element,offset,length) {
      const range=document.createRange(),point=this.locate(element,offset);range.setStart(...point);range.collapse(true);
      const rect=range.getClientRects()[0];if(rect?.height)return rect;
      if(length){const probe=document.createRange();probe.setStart(...this.locate(element,offset===length?offset-1:offset));probe.setEnd(...this.locate(element,offset===length?offset:offset+1));const rects=[...probe.getClientRects()];const adjacent=offset===length?rects.at(-1):rects[0];if(adjacent)return {left:offset===length?adjacent.right:adjacent.left,top:adjacent.top,height:adjacent.height};}
      const bounds=element.getBoundingClientRect();return {left:bounds.left,top:bounds.top,height:parseFloat(getComputedStyle(element).lineHeight)||20};
    }
    layout() {
      cancelAnimationFrame(this.frame);if(this.closed)return;
      const editor=document.querySelector('#blocks');if(editor!==this.editor){this.resizeObserver?.disconnect();this.editor=editor;if(editor)this.resizeObserver?.observe(editor);}
      this.frame=requestAnimationFrame(()=>this.draw());
    }
    draw() {
      this.overlay.replaceChildren();if(!this.eligible())return;
      for(const person of this.participants){
        if((this.selfId?person.id===this.selfId:person.client_id===this.clientId&&person.member_id===this.profile.memberId)||!person.selection)continue;
        const selection=person.selection,element=this.getBlockElement(selection.block_id),chars=this.getChars(selection.block_id);
        if(!element?.isConnected||!Array.isArray(chars))continue;
        const anchor=this.point(selection.anchor,chars),focus=this.point(selection.focus,chars);if(anchor===null||focus===null)continue;
        if(anchor!==focus){
          const range=document.createRange();range.setStart(...this.locate(element,Math.min(anchor,focus)));range.setEnd(...this.locate(element,Math.max(anchor,focus)));
          for(const bounds of range.getClientRects()){
            if(!bounds.width||!bounds.height)continue;
            const mark=document.createElement('span');mark.className='remote-selection';mark.dataset.presenceId=person.id;mark.style.cssText=`left:${bounds.left}px;top:${bounds.top}px;width:${bounds.width}px;height:${bounds.height}px;--presence-color:${person.color}`;this.overlay.append(mark);
          }
        }
        const bounds=this.caretRect(element,focus,chars.length);if(bounds.top+bounds.height<0||bounds.top>innerHeight||bounds.left<0||bounds.left>innerWidth)continue;
        const caret=document.createElement('span');caret.className='remote-caret';caret.dataset.presenceId=person.id;caret.style.cssText=`left:${Math.min(innerWidth-2,Math.max(0,bounds.left))}px;top:${bounds.top}px;height:${bounds.height}px;--presence-color:${person.color}`;
        const label=document.createElement('span');label.className='remote-caret-label';label.textContent=person.name;caret.append(label);this.overlay.append(caret);
        const labelWidth=label.getBoundingClientRect().width;label.style.left=Math.min(0,innerWidth-bounds.left-labelWidth-8)+'px';
      }
    }
    close() {
      if(this.closed)return;this.pause();this.closed=true;cancelAnimationFrame(this.frame);this.overlay.remove();this.resizeObserver?.disconnect();
      document.removeEventListener('visibilitychange',this.visibility);removeEventListener('offline',this.offline);removeEventListener('online',this.online);removeEventListener('pagehide',this.pagehide);removeEventListener('pageshow',this.pageshow);removeEventListener('resize',this.relayout);removeEventListener('scroll',this.relayout,true);
    }
  }
  globalThis.FountainPresence=Object.freeze({Manager});
})();
