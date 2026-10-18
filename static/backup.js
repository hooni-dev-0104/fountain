/* Resumable backup control and bounded binary SHA-256, shared with the worker.
 * Job/transaction identifiers live in this tab/worker RAM only. No file Blob,
 * whole-file buffer, OPFS staging or private cache is used by this module.
 */
(function(root){
  'use strict';
  const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,TOKEN=/^[A-Za-z0-9_-]{43}$/,CHUNK=256*1024;
  function transactionId(){const bytes=root.crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const hex=Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');}
  const K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const rotate=(v,n)=>(v>>>n)|(v<<(32-n));
  class SHA256{
    constructor(){this.words=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];this.bytes=0;this.tail=new Uint8Array();}
    update(bytes){
      if(!(bytes instanceof Uint8Array)||bytes.length>CHUNK||this.bytes+bytes.length>Math.floor(Number.MAX_SAFE_INTEGER/8)-128)throw Error('백업 해시 범위를 초과했습니다.');
      this.bytes+=bytes.length;const pending=new Uint8Array(this.tail.length+bytes.length);pending.set(this.tail);pending.set(bytes,this.tail.length);const work=new Uint32Array(64);let offset=0;
      for(;offset+64<=pending.length;offset+=64){const view=new DataView(pending.buffer,pending.byteOffset+offset,64);for(let i=0;i<16;i++)work[i]=view.getUint32(i*4);
        for(let i=16;i<64;i++){const a=work[i-15],b=work[i-2];work[i]=(work[i-16]+(rotate(a,7)^rotate(a,18)^(a>>>3))+work[i-7]+(rotate(b,17)^rotate(b,19)^(b>>>10)))>>>0;}
        let [a,b,c,d,e,f,g,h]=this.words;
        for(let i=0;i<64;i++){const t=(h+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+K[i]+work[i])>>>0,u=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))>>>0;h=g;g=f;f=e;e=(d+t)>>>0;d=c;c=b;b=a;a=(t+u)>>>0;}
        [a,b,c,d,e,f,g,h].forEach((v,i)=>this.words[i]=(this.words[i]+v)>>>0);
      }this.tail=pending.slice(offset);
    }
    hex(){const copy=new SHA256();copy.words=[...this.words];copy.bytes=this.bytes;copy.tail=new Uint8Array(this.tail);const bits=this.bytes*8,pad=new Uint8Array(1+(56-(this.bytes+1)%64+64)%64+8);pad[0]=128;const view=new DataView(pad.buffer);view.setUint32(pad.length-8,Math.floor(bits/0x100000000));view.setUint32(pad.length-4,bits>>>0);copy.update(pad);return copy.words.map(v=>v.toString(16).padStart(8,'0')).join('');}
  }
  const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v),integer=v=>Number.isSafeInteger(v)&&v>=0;
  function failure(status=503){return Object.assign(new Error(status===401?'다시 로그인한 뒤 백업을 시작해 주세요.':status===403?'백업을 내려받을 권한이 없습니다.':status===410?'백업 작업이 만료되었습니다. 다시 시작해 주세요.':'백업을 완료하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.'),{status});}
  function validateJob(value,id){
    if(!object(value)||typeof value.id!=='string'||!UUID.test(value.id)||id&&value.id!==id||!['snapshot','building','ready','cancelled','failed','expired'].includes(value.phase)||!integer(value.revision)||!integer(value.version)||typeof value.expires_at!=='string'||value.expires_at.length>64||!Number.isFinite(Date.parse(value.expires_at))||!object(value.progress))throw failure();
    if(Date.parse(value.expires_at)<=Date.now())throw failure(410);
    if(!integer(value.progress.source_rows)||!integer(value.progress.output_bytes)||!(value.progress.writer_phase===null||typeof value.progress.writer_phase==='string'&&/^[a-z][a-z0-9_-]{0,60}$/.test(value.progress.writer_phase))||Object.keys(value.progress).some(k=>!['source_rows','output_bytes','writer_phase'].includes(k)))throw failure();
    if(Object.keys(value).some(k=>!['id','phase','revision','version','expires_at','progress','size','sha256','cleanup_pending'].includes(k))||value.cleanup_pending!==undefined&&typeof value.cleanup_pending!=='boolean')throw failure();
    if(value.phase==='ready'&&(!integer(value.size)||value.size<1||value.size>Math.floor(Number.MAX_SAFE_INTEGER/8)-128||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256)))throw failure();
    return structuredClone(value);
  }
  async function readJSON(response){
    const reader=response.body?.getReader();if(!reader)throw failure();let length=0;const chunks=[];
    try{for(;;){const next=await reader.read();if(next.done)break;length+=next.value.length;if(length>65536)throw failure();chunks.push(next.value);}const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
    catch{await reader.cancel().catch(()=>{});throw failure();}finally{reader.releaseLock();}
  }
  function message(type,body,proof){
    const controller=root.navigator?.serviceWorker?.controller;if(!controller)return Promise.reject(new Error('스트리밍 백업을 준비하려면 앱을 새로고침해 주세요.'));
    return new Promise((resolve,reject)=>{const channel=new MessageChannel(),timer=setTimeout(()=>{channel.port1.close();reject(new Error('다운로드 연결을 준비하지 못했습니다. 앱을 새로고침해 주세요.'));},5000);channel.port1.onmessage=event=>{
      if(event.data?.type==='fountain-backup-proof'&&proof){let granted=false;try{granted=proof()===true;}catch{}channel.port1.postMessage({type:'fountain-backup-proof-result',requestId:event.data.requestId,granted});return;}
      clearTimeout(timer);if(event.data?.ok){if(!proof)channel.port1.close();resolve({...event.data,port:proof?channel.port1:null});}else{channel.port1.close();reject(failure());}
    };controller.postMessage({type,...body},[channel.port2]);});
  }
  class Manager{
    constructor({transport=root.FountainTransport,getScope,isCurrent,onChange=()=>{}}){
      this.transport=transport.workspaceScope?.()?transport.capture():transport;this.getScope=getScope;this.isCurrent=isCurrent;this.onChange=onChange;this.scope=getScope();this.controller=new AbortController();this.job=null;this.pending=null;this.state='idle';this.closed=false;this.running=null;this.transferId=null;
      this.listener=event=>{const v=event.data;if(v?.type!=='fountain-backup-state'||v.jobId!==this.job?.id||v.transferId!==this.transferId||!this.current())return;if(v.state==='error'){this.state='error';this.error=failure(v.status);if(v.status===410)this.restartRequired=true;this.emit();}else if(v.state==='complete'){this.state='complete';this.emit();}else if(v.state==='downloading'){this.downloaded=v.completed;this.emit();}};
      root.navigator?.serviceWorker?.addEventListener('message',this.listener);
      this.watch=setInterval(()=>{if(!this.current())void this.cancel();},300);
    }
    current(){return !this.closed&&!this.controller.signal.aborted&&this.isCurrent(this.scope);}
    emit(){if(this.current())this.onChange({state:this.state,job:this.job?structuredClone(this.job):null,downloaded:this.downloaded||0,error:this.error?.message||null,restartRequired:!!this.restartRequired});}
    assert(){if(!this.current())throw new DOMException('백업 범위가 변경되었습니다.','AbortError');}
    async requestPending(){
      this.assert();const p=this.pending,response=await this.transport.request(p.path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transaction_id:p.tx}),signal:this.controller.signal});this.assert();
      if(p.kind==='create'&&[404,405].includes(response.status)){await response.body?.cancel();this.pending=null;this.state='legacy';this.emit();await this.legacy();return null;}
      if(!(p.kind==='create'?response.status===201:[200,202].includes(response.status))){await response.body?.cancel();throw failure(response.status);}
      const value=validateJob(await readJSON(response),this.job?.id);if(this.job&&(value.revision!==this.job.revision||value.version<this.job.version))throw failure();this.assert();this.job=value;this.pending=null;this.emit();return value;
    }
    async start(){return this.run();}
    async retry(){if(!this.current()||this.restartRequired)return;this.error=null;return this.run();}
    run(){
      if(this.running)return this.running;
      this.running=(async()=>{try{
        this.assert();this.state='working';this.error=null;this.emit();
        if(!this.job){this.pending??={kind:'create',path:'/api/backup/jobs',tx:transactionId()};if(!await this.requestPending())return;}
        while(this.job.phase!=='ready'){
          if(['failed','cancelled','expired'].includes(this.job.phase)){this.restartRequired=true;throw failure(this.job.phase==='expired'?410:503);}
          this.pending??={kind:'step',path:'/api/backup/jobs/'+this.job.id+'/step',tx:transactionId()};await this.requestPending();this.assert();
        }
        await this.download();
      }catch(error){if(error.name==='AbortError')return;if(error.status===410)this.restartRequired=true;this.error=error?.status?failure(error.status):failure();this.state='error';this.emit();}finally{this.running=null;}})();return this.running;
    }
    async legacy(){
      this.assert();if(this.transport.native)await this.transport.download('/api/backup','fountain-backup.sqlite',{signal:this.controller.signal});
      else{const a=root.document.createElement('a');a.href=this.transport.downloadURL('/api/backup');a.download='fountain-backup.sqlite';a.click();}
      this.assert();this.state='legacy';this.emit();
    }
    async download(){
      this.assert();const path='/api/backup?job_id='+this.job.id;
      if(this.transport.native){this.state='downloading';this.emit();await this.transport.download(path,'fountain-backup.sqlite',{signal:this.controller.signal});this.assert();this.state='complete';this.emit();return;}
      const scope={workspaceId:this.scope.workspaceId,memberId:this.scope.memberId,binding:this.scope.binding,...(this.scope.accountBinding?{accountBinding:this.scope.accountBinding}:{})};
      if(!Object.values(scope).every(v=>typeof v==='string'&&v.length>0&&v.length<=1000))throw failure();
      this.port?.close();
      const registered=await message('fountain-backup-register',{jobId:this.job.id,scope},()=>this.current());this.port=registered.port;if(!TOKEN.test(registered.transferId||'')){this.port?.close();throw failure();}this.transferId=registered.transferId;this.assert();this.state='downloading';this.emit();
      // Chrome bypasses Service Worker fetch for an <a download> request. A
      // same-origin navigation is intercepted first; the worker's attachment
      // Content-Disposition then hands its verified stream to the browser.
      // The one-use URL is an authorized bearer handoff, not a claim about the
      // initiating navigation window (browsers omit its clientId). The worker
      // additionally asks THIS registered live window for scope proof per chunk.
      this.frame?.remove();this.frame=root.document.createElement('iframe');this.frame.hidden=true;this.frame.referrerPolicy='no-referrer';this.frame.title='백업 다운로드';this.frame.src=root.location.origin+'/__fountain_backup_stream/'+this.transferId;root.document.body.append(this.frame);
    }
    async cancel(){
      if(this.closed)return;const now=this.getScope(),same=['workspaceId','memberId','binding','profileId','transportEpoch'].every(k=>now[k]===this.scope[k]);this.closed=true;clearInterval(this.watch);this.controller.abort();this.frame?.remove();this.port?.close();root.navigator?.serviceWorker?.removeEventListener('message',this.listener);
      if(this.job){void message('fountain-backup-cancel',{jobId:this.job.id,transferId:this.transferId}).catch(()=>{});if(same)await this.transport.request('/api/backup/jobs/'+this.job.id,{method:'DELETE',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)}).then(r=>r.body?.cancel()).catch(()=>{});}
    }
    close(){return this.cancel();}
  }
  root.FountainBackup=Object.freeze({Manager,SHA256,CHUNK,UUID,TOKEN,validateJob,readJSON,failure});
})(globalThis);
