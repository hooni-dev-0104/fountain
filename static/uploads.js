/* Bounded, resumable attachment transfers. IndexedDB stores metadata only, never file bytes or tokens. */
(() => {
  'use strict'; const CHUNK_SIZE=4*1024*1024,MAX_SIZE=5_000_000_000,SAMPLE_SIZE=64*1024; const DATABASE='fountain-upload-metadata-v1'; let database; const request=operation=>new Promise((resolve,reject)=> {
    operation.onsuccess=()=>resolve(operation.result); operation.onerror=()=>reject(operation.error);
  }); function open() {
    if(!database)database=new Promise((resolve,reject)=> {
      const value=indexedDB.open(DATABASE,1); value.onupgradeneeded=()=> {
        const store=value.result.createObjectStore('transfers', {
          keyPath:'key'
        }); store.createIndex('scopeId','scopeId'); store.createIndex('profileId','profileId');
      }; value.onsuccess=()=>resolve(value.result); value.onerror=()=> {
        database=null; reject(value.error);
      };
    }); return database;
  }
  async function transaction(mode,callback) {
    const db=await open(); return new Promise((resolve,reject)=> {
      const tx=db.transaction('transfers',mode); let result; tx.oncomplete=()=>resolve(result); tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error||new Error('전송 정보를 저장하지 못했습니다.')); Promise.resolve(callback(tx.objectStore('transfers'))).then(value=>result=value).catch(error=> {
        try {
          tx.abort();
        }
        catch {
        }
        reject(error);
      });
    });
  }
  const clone=value=>structuredClone(value); function identifier(value) {
    if(typeof value!=='string'||!value)throw new Error('로그인 정보를 확인하지 못했습니다.'); return encodeURIComponent(value);
  }
  function scopeIdentity(scope) {
    return `${location.origin}|${identifier(scope.workspaceId)}|${identifier(scope.memberId)}|${identifier(scope.binding)}|${identifier(scope.pageId)}`;
  }
  function profileIdentity(scope) {
    return `${location.origin}|${identifier(scope.workspaceId)}|${identifier(scope.memberId)}|${identifier(scope.binding)}`;
  }
  function abortError(message='전송을 일시 중지했습니다.') {
    return new DOMException(message,'AbortError');
  }
  function error(message,status=0) {
    if(!/[가-힣]/.test(message))message=( {
      401:'로그인이 만료되었거나 변경되었습니다. 다시 로그인해 주세요.',403:'문서의 파일 전송 권한이 변경되었습니다.',404:'전송 정보를 찾을 수 없습니다. 원본 파일을 새로 선택해 주세요.',409:'전송 내용이나 저장 위치가 일치하지 않습니다. 원본 파일을 확인해 주세요.',410:'전송 기한이 만료되었습니다. 새 전송을 시작해 주세요.',413:'파일 또는 전송 조각이 허용된 크기를 넘었습니다.',423:'문서가 잠겼거나 삭제되어 파일 전송을 중지했습니다.'
    })[status]||(status>=500?'서버가 파일을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.':'파일 전송을 처리하지 못했습니다.'); const value=new Error(message); value.status=status; return value;
  }
  async function fingerprint(file) {
    const digest=async blob=> {
      let buffer; try {
        buffer=await blob.arrayBuffer();
      }
      catch {
        throw error('원본 파일을 읽지 못했습니다. 파일을 다시 선택해 주세요.');
      }
      const bytes=new Uint8Array(buffer); let hex=''; for(const byte of bytes)hex+=byte.toString(16).padStart(2,'0'); return FountainCollaboration.sha256('fountain-file-sample-v1:'+hex);
    }; return {
      algorithm:'sample-v1',name:file.name,size:file.size,lastModified:file.lastModified,first:await digest(file.slice(0,Math.min(SAMPLE_SIZE,file.size))),last:await digest(file.slice(Math.max(0,file.size-SAMPLE_SIZE),file.size))
    };
  }
  function sameFingerprint(first,second) {
    return ['algorithm','name','size','lastModified','first','last'].every(key=>first[key]===second[key]);
  }
  async function purgeProfile(profileId) {
    return transaction('readwrite',async store=> {
      for(const row of await request(store.index('profileId').getAll(profileId)))store.delete(row.key);
    });
  }
  class UploadManager {
    constructor( {
      scope,isCurrent,onChange=()=> {
      },onComplete=async()=>true,onDenied=()=> {
      }
    }) {
      this.scope=clone(scope); this.scopeId=scopeIdentity(scope); this.profileId=profileIdentity(scope); this.resourceKey=this.scopeId; this.isCurrent=isCurrent; this.onChange=onChange; this.onComplete=onComplete; this.onDenied=onDenied; this.jobs=new Map(); this.closed=false; this.generation=0; this.profileCleared=event=> {
        if(event.detail?.profileId===this.profileId) {
          this.dispose(); purgeProfile(this.profileId).catch(()=> {
          });
        }
      }; this.profileChanged=async()=> {
        const current=await FountainOffline.getProfile().catch(()=>null); if(!this.closed&&current?.id!==this.profileId) {
          this.dispose(); purgeProfile(this.profileId).catch(()=> {
          });
        }
      }; this.resourcePurged=event=> {
        if(event.detail?.key===this.resourceKey) {
          this.dispose(); this.removeScope().catch(()=> {
          });
        }
      }; globalThis.addEventListener('fountain-offline-profile-cleared',this.profileCleared); globalThis.addEventListener('fountain-offline-profile-changed',this.profileChanged); globalThis.addEventListener('fountain-offline-resource-purged',this.resourcePurged);
    }
    async authorized() {
      const profile=await FountainOffline.getProfile(); if(!profile||profile.id!==this.profileId||this.closed)throw abortError('로그인 계정이 변경되어 전송을 중지했습니다.'); return profile;
    }
    current() {
      return !this.closed&&this.isCurrent(this.scope);
    }
    async load() {
      await this.authorized(); const records=await transaction('readonly',store=>request(store.index('scopeId').getAll(this.scopeId))); if(this.closed)return; for(const record of records) {
        if(Date.parse(record.expiresAt)<=Date.now()) {
          await this.remove(record.id); continue;
        }
        if(!this.jobs.has(record.id))this.jobs.set(record.id, {
          ...record,status:'reselect',message:'동일한 원본 파일을 다시 선택하면 서버의 저장 위치를 확인해 이어 보냅니다.',file:null,loaded:0
        });
      }
      this.emit();
    }
    view() {
      return [...this.jobs.values()].map(job=>( {
        id:job.id,name:job.name,size:job.size,offset:job.offset,loaded:job.loaded||0,status:job.status,message:job.message||'',hasFile:!!job.file
      }));
    }
    emit() {
      if(!this.closed)this.onChange(this.view());
    }
    active() {
      return [...this.jobs.values()].some(job=>['fingerprint','starting','uploading','checking','finishing','attaching'].includes(job.status));
    }
    liveJob(job) {
      return this.jobs.get(job.id)===job&&!['cancelled','done'].includes(job.status);
    }
    async save(job) {
      const generation=this.generation; await this.authorized(); if(!this.liveJob(job)||!this.current()||generation!==this.generation&&job.status!=='paused')throw abortError('전송 상태가 변경되어 저장을 중지했습니다.'); const record= {
        key:this.scopeId+'|'+identifier(job.id),id:job.id,profileId:this.profileId,scopeId:this.scopeId,pageId:this.scope.pageId,name:job.name,size:job.size,lastModified:job.lastModified,fingerprint:clone(job.fingerprint),offset:job.offset,expiresAt:job.expiresAt,publicationVersion:job.publicationVersion||0,publication:clone(job.publication||null)
      }; await transaction('readwrite',async store=> {
        if(!this.liveJob(job)||generation!==this.generation&&job.status!=='paused')return; const previous=await request(store.get(record.key)); if(!this.liveJob(job)||generation!==this.generation&&job.status!=='paused')return; if(!previous||previous.offset<=record.offset)store.put(record);
      }); const active=await FountainOffline.getProfile(); if(!this.liveJob(job)||active?.id!==this.profileId) {
        await this.remove(job.id); throw abortError('취소되었거나 로그인 계정이 변경되어 전송 정보를 정리했습니다.');
      }
      if(!this.current()||generation!==this.generation)throw abortError('전송이 일시 중지되었습니다. 원본 파일을 선택해 이어 보낼 수 있습니다.');
    }
    async remove(id) {
      return transaction('readwrite',store=>store.delete(this.scopeId+'|'+identifier(id)));
    }
    async removeScope() {
      return transaction('readwrite',async store=> {
        for(const record of await request(store.index('scopeId').getAll(this.scopeId)))store.delete(record.key);
      });
    }
    async json(job,path,body,method) {
      if(!this.current())throw abortError(); await this.authorized(); if(!this.current())throw abortError(); const controller=new AbortController(); job.controller=controller; try {
        const response=await FountainTransport.request('/api'+path, {
          method:method||(body?'POST':'GET'),signal:controller.signal,headers: {
            'Content-Type':'application/json'
          },...(body? {
            body:JSON.stringify(body)
          }
          : {
          })
        }); let value; try {
          value=await response.json();
        }
        catch {
          value= {
            error:'서버 응답을 읽지 못했습니다.'
          };
        }
        if(!response.ok)throw error(value.error||'파일 전송을 처리하지 못했습니다.',response.status); return value;
      }
      catch(failure) {
        if(failure.name==='AbortError'||failure.status)throw failure; throw error('서버에 연결하지 못했습니다. 저장 위치를 확인해 다시 시도해 주세요.');
      }
      finally {
        if(job.controller===controller)job.controller=null;
      }
    }
    async start(file) {
      if(!this.current())throw error('파일을 추가할 문서 편집 권한이 없습니다.',403); if(this.active())throw error('현재 전송을 마치거나 일시 중지한 뒤 다른 파일을 선택해 주세요.'); if(!Number.isSafeInteger(file.size)||file.size>MAX_SIZE)throw error('파일당 최대 5 GB까지 전송할 수 있습니다.'); const temporary='preparing_'+Date.now()+'_'+Math.random().toString(16).slice(2),job= {
        id:temporary,name:file.name,size:file.size,lastModified:file.lastModified,offset:0,file,loaded:0,publicationVersion:1,status:'fingerprint',message:'파일의 앞·뒤 일부를 확인하고 있습니다.'
      }; this.jobs.set(temporary,job); this.emit(); const generation=++this.generation; try {
        job.fingerprint=await fingerprint(file); if(!this.current()||generation!==this.generation)throw abortError(); job.status='starting'; job.message='전송을 준비하고 있습니다.'; this.emit(); const state=await this.json(job,'/uploads', {
          name:file.name,size:file.size,page_id:this.scope.pageId
        }); if(!this.current()||generation!==this.generation)throw abortError(); this.jobs.delete(temporary); job.id=state.id; this.validateState(job,state); job.offset=state.offset; job.expiresAt=state.expires_at; this.jobs.set(job.id,job); await this.save(job); return await this.transfer(job,generation);
      }
      catch(failure) {
        if(job.id===temporary) {
          this.jobs.delete(temporary); this.emit(); if([401,403,404,410].includes(failure.status)&&!this.closed)this.onDenied( {
            status:failure.status,message:failure.message,scope:this.scope
          }); if(failure.name!=='AbortError')throw failure; return;
        }
        return this.fail(job,failure,generation);
      }
    }
    async resume(id,file) {
      const job=this.jobs.get(id); if(!job)throw error('이어 보낼 전송 정보를 찾을 수 없습니다.'); if(this.active())throw error('진행 중인 전송을 먼저 일시 중지해 주세요.'); if(!this.current())throw error('현재 문서의 편집 권한을 확인해 주세요.',403); const selected=file||job.file; if(!selected)throw error('동일한 원본 파일을 다시 선택해 주세요.'); job.status='fingerprint'; job.message='다시 선택한 파일의 일부 표본을 비교하고 있습니다.'; this.emit(); const generation=++this.generation; try {
        const actual=await fingerprint(selected); if(!sameFingerprint(job.fingerprint,actual))throw error('파일 이름·크기·수정 시각 또는 일부 표본이 다릅니다. 이전에 보낸 원본 파일을 선택해 주세요.'); if(!this.current()||generation!==this.generation)throw abortError(); job.file=selected; job.status='checking'; job.message='서버에 저장된 위치를 확인하고 있습니다.'; this.emit(); const state=await this.json(job,'/uploads/'+encodeURIComponent(id)); if(!this.current()||generation!==this.generation)throw abortError(); this.validateState(job,state); job.offset=state.offset; job.expiresAt=state.expires_at;if(!state.completed)job.publicationVersion=1; await this.save(job); if(state.completed)return await this.finish(job,state.attachment,generation); return await this.transfer(job,generation);
      }
      catch(failure) {
        return this.fail(job,failure,generation);
      }
    }
    validateState(job,state) {
      if(state.id!==job.id||state.owner_id&&state.owner_id!==this.scope.memberId||state.page_id&&state.page_id!==this.scope.pageId||state.name!==job.name||state.size!==job.size||state.chunk_size!==CHUNK_SIZE||!Number.isSafeInteger(state.offset)||state.offset<0||state.offset>job.size||state.offset!==job.size&&state.offset%CHUNK_SIZE!==0)throw error('서버의 전송 정보가 원본 파일과 일치하지 않습니다.');
    }
    chunk(job,offset,generation) {
      const blob=job.file.slice(offset,Math.min(job.size,offset+CHUNK_SIZE)); return new Promise((resolve,reject)=> {
        const xhr=FountainTransport.xhr('PUT','/api/uploads/'+encodeURIComponent(job.id)+'/chunks?offset='+offset); job.xhr=xhr; xhr.setRequestHeader('Content-Type','application/octet-stream'); xhr.timeout=45000; xhr.upload.onprogress=event=> {
          if(!this.current()||generation!==this.generation) {
            xhr.abort(); return;
          }
          job.loaded=Math.min(blob.size,event.loaded); this.emit();
        }; xhr.onload=()=> {
          let value; try {
            value=JSON.parse(xhr.responseText);
          }
          catch {
            value= {
              error:'서버 응답을 읽지 못했습니다.'
            };
          }
          if(xhr.status>=200&&xhr.status<300)resolve(value); else reject(error(value.error||'파일 조각을 보내지 못했습니다.',xhr.status));
        }; xhr.onerror=()=>reject(error('서버에 연결하지 못했습니다. 다시 시도하면 저장 위치를 확인해 이어 보냅니다.')); xhr.ontimeout=()=>reject(error('전송 시간이 초과되었습니다. 저장 위치를 확인해 다시 시도해 주세요.')); xhr.onabort=()=>reject(abortError()); xhr.onloadend=()=> {
          if(job.xhr===xhr)job.xhr=null;
        }; xhr.send(blob);
      });
    }
    async transfer(job,generation) {
      let retries=0; while(job.offset<job.size) {
        if(!this.current()||generation!==this.generation)throw abortError(); job.status='uploading'; job.loaded=0; job.message='파일을 보내고 있습니다.'; this.emit(); try {
          const state=await this.chunk(job,job.offset,generation); if(!this.current()||generation!==this.generation)throw abortError(); this.validateState(job,state); job.offset=state.offset; job.loaded=0; await this.save(job); retries=0;
        }
        catch(failure) {
          if(failure.name==='AbortError'||[401,403,404,410,423].includes(failure.status)||retries>=2||!navigator.onLine)throw failure; retries++; job.status='checking'; job.message='연결을 다시 확인하고 서버의 저장 위치를 조회합니다.'; job.loaded=0; this.emit(); await new Promise(resolve=>setTimeout(resolve,300*retries)); if(!this.current()||generation!==this.generation)throw abortError(); const state=await this.json(job,'/uploads/'+encodeURIComponent(job.id)); this.validateState(job,state); job.offset=state.offset; await this.save(job); if(state.completed)return await this.finish(job,state.attachment,generation);
        }
      }
      if(!this.current()||generation!==this.generation)throw abortError(); job.status='finishing'; job.loaded=0; job.message='서버에서 완성된 파일을 확인하고 있습니다.'; this.emit(); const attachment=await this.json(job,'/uploads/'+encodeURIComponent(job.id)+'/complete', {
      }); return await this.finish(job,attachment,generation);
    }
    async finish(job,attachment,generation) {
      if(!attachment||attachment.id!==job.id||attachment.size!==job.size)throw error('완성된 파일 정보를 확인하지 못했습니다.'); if(!this.current()||generation!==this.generation)throw abortError(); job.offset=job.size; job.status='attaching'; job.message='완성된 파일을 문서에 연결하고 있습니다.'; this.emit(); const current=()=>this.current()&&generation===this.generation&&this.liveJob(job)&&job.status==='attaching';
      const publication={version:job.publicationVersion||0,get:()=>clone(job.publication||null),save:async receipt=>{if(!current())throw abortError();const previous=job.publication;job.publication=clone(receipt);try{await this.save(job);if(!current())throw abortError();}catch(failure){job.publication=previous;throw failure;}}};
      const accepted=await this.onComplete(attachment,this.scope,current,publication); if(!this.current()||generation!==this.generation||accepted!==true)throw abortError(); await this.remove(job.id); job.status='done'; job.message='문서에 파일을 추가했습니다.'; job.file=null; job.loaded=0; this.emit(); return attachment;
    }
    async fail(job,failure,generation) {
      if(generation!==undefined&&generation!==this.generation)return null; job.loaded=0; if(failure.name==='AbortError') {
        if(!['cancelled','done','paused'].includes(job.status)) {
          job.status=job.file?'paused':'reselect'; job.message='전송을 일시 중지했습니다. 원본 파일을 선택해 이어 보낼 수 있습니다.';
        }
        this.emit(); return;
      }
      job.status='error'; job.message=failure.message||'파일 전송을 완료하지 못했습니다.'; if([401,403,404,410].includes(failure.status)) {
        await this.remove(job.id); job.file=null; job.status='denied'; if(!this.closed)this.onDenied( {
          status:failure.status,message:job.message,scope:this.scope
        });
      }
      this.emit(); return null;
    }
    pause(id,message='전송을 일시 중지했습니다.') {
      const job=this.jobs.get(id); if(!job)return; if(['fingerprint','starting','uploading','checking','finishing','attaching'].includes(job.status))this.generation++; job.controller?.abort(); job.xhr?.abort(); job.status='paused'; job.loaded=0; job.message=message; this.emit();
    }
    pauseAll(message) {
      for(const job of this.jobs.values())if(['fingerprint','starting','uploading','checking','finishing','attaching'].includes(job.status))this.pause(job.id,message);
    }
    async cancel(id) {
      const job=this.jobs.get(id); if(!job)return; this.pause(id); job.status='cancelled'; job.message='전송을 취소했습니다.'; job.file=null; await this.remove(id); this.emit(); if(!id.startsWith('preparing_')&&this.current())try {
        await this.json(job,'/uploads/'+encodeURIComponent(id), {
        },'DELETE');
      }
      catch(failure) {
        if([401,403,404].includes(failure.status))this.onDenied( {
          status:failure.status,message:failure.message,scope:this.scope
        });
      }
      this.jobs.delete(id); this.emit();
    }
    dispose() {
      if(this.closed)return; this.pauseAll('페이지 또는 로그인 계정이 변경되어 전송을 중지했습니다.'); this.closed=true; for(const job of this.jobs.values()) {
        job.controller?.abort(); job.xhr?.abort(); job.file=null;
      }
      globalThis.removeEventListener('fountain-offline-profile-cleared',this.profileCleared); globalThis.removeEventListener('fountain-offline-profile-changed',this.profileChanged); globalThis.removeEventListener('fountain-offline-resource-purged',this.resourcePurged);
    }
  }
  globalThis.addEventListener('fountain-offline-resource-purged',event=> {
    if(typeof event.detail?.key==='string')transaction('readwrite',async store=> {
      for(const row of await request(store.index('scopeId').getAll(event.detail.key)))store.delete(row.key);
    }).catch(()=> {
    });
  }); globalThis.addEventListener('fountain-offline-profile-cleared',event=> {
    if(event.detail?.profileId)purgeProfile(event.detail.profileId).catch(()=> {
    });
  }); globalThis.addEventListener('fountain-offline-profile-changed',async()=> {
    const current=await FountainOffline.getProfile().catch(()=>null); if(!current)return; await transaction('readwrite',async store=> {
      for(const record of await request(store.getAll()))if(record.profileId!==current.id)store.delete(record.key);
    }).catch(()=> {
    });
  }); globalThis.FountainUploads=Object.freeze( {
    UploadManager,CHUNK_SIZE,MAX_SIZE,fingerprint,sameFingerprint
  });
})();
