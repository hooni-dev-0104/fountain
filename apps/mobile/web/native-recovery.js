/* Explicit metadata-only recovery. Native retains source data and all export bytes. */
(function(root){
  'use strict';
  const labels={typed:'문서·항목 변경',body:'본문 복구 기록',local_page:'새 문서 기록',unsupported:'확인할 수 없는 기록'};
  const only=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));
  const integer=value=>Number.isSafeInteger(value)&&value>=0;
  function create({bridge,transport}){
    let view=null,serial=0,confirmation=null;
    const available=()=>transport.recoveryEnabled===true&&transport.recoveryVersion===1&&typeof bridge.recoveryInventory==='function'&&typeof bridge.recoveryExport==='function';
    const stamp=()=>[transport.origin,transport.generation,transport.scopeEpoch??null].join('|');
    const element=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
    const button=(text,action,kind='outline-btn')=>{const node=element('button',text,kind);node.type='button';node.addEventListener('click',action);return node;};
    const requestId=()=>`recovery_${Date.now().toString(36)}_${++serial}`;
    function current(expected){return view===expected&&expected.dialog.isConnected&&stamp()===expected.scope;}
    function assertCurrent(expected){if(!current(expected))throw new DOMException('복구 화면이 변경되었습니다.','AbortError');}
    function cancelCapability(expected,token=expected.prepared?.exportToken,inventoryToken=expected.inventoryToken){if(!inventoryToken&&!token)return;bridge.recoveryExport({id:requestId(),generation:expected.generation,inventoryToken:inventoryToken||'',handles:[],phase:'cancel',...(token?{exportToken:token}:{})}).catch(()=>{});}
    function invalidate(expected){if(expected.prepared)cancelCapability(expected);expected.prepared=null;expected.result.replaceChildren();}
    function validFiles(files){
      if(!Array.isArray(files)||files.length>1000)return false;let total=0;for(const file of files){if(!only(file,['name','byteLength','format'])||typeof file.name!=='string'||!file.name||file.name.length>240||!integer(file.byteLength)||file.byteLength===0||file.byteLength>16*1024*1024||typeof file.format!=='string'||file.format.length>80)return false;total+=file.byteLength;if(!Number.isSafeInteger(total)||total>64*1024*1024)return false;}return true;
    }
    function clearInventory(expected){
      invalidate(expected);cancelCapability(expected,null);expected.inventoryToken=null;expected.session=null;expected.selected.clear();expected.handles.clear();expected.recordCounts.clear();expected.cursors.clear();expected.list.replaceChildren();expected.login.replaceChildren();expected.next.hidden=true;expected.account.textContent='현재 계정을 다시 확인해 주세요.';updateSelection(expected);
    }
    async function recoveryError(expected,error){
      if(['RECOVERY_AUTH_REQUIRED','RECOVERY_STALE'].includes(error?.code)&&current(expected))clearInventory(expected);if(error?.code==='RECOVERY_AUTH_REQUIRED'&&current(expected)){try{const value=await session(expected);login(expected,value);}catch(problem){report(expected,problem);}}report(expected,error);
    }
    function close(){if(confirmation){confirmation(false);confirmation=null;}const previous=view;if(!previous)return;view=null;for(const id of previous.pending)bridge.cancel({id,generation:previous.generation}).catch(()=>{});if(previous.prepared)cancelCapability(previous);cancelCapability(previous,null);previous.controller.abort();previous.dialog.close?.();previous.dialog.remove();previous.returnFocus?.focus?.();}
    function errorMessage(error){return ({RECOVERY_AUTH_REQUIRED:'기록을 확인할 계정으로 로그인해 주세요.',RECOVERY_STALE:'계정이나 보관된 내용이 바뀌었습니다. 목록을 다시 확인해 주세요.',RECOVERY_ACCESS_REQUIRED:'현재 권한으로 확인할 수 없는 내용은 그대로 보관했습니다.',RECOVERY_STORAGE:'기기 기록을 열지 못했습니다. 원본은 그대로 보관했습니다.',RECOVERY_LIMIT:'한 번에 확인할 기록이 많습니다. 선택을 나누어 다시 확인해 주세요.',RECOVERY_CANCELLED:'저장을 취소했습니다. 원본은 그대로 보관했습니다.',NATIVE_CANCELLED:'저장을 취소했습니다. 원본은 그대로 보관했습니다.'})[error?.code]||'복구 작업을 완료하지 못했습니다. 원본은 그대로 보관했습니다.';}
    function report(expected,error){if(!current(expected)||error?.name==='AbortError')return;expected.status.textContent=errorMessage(error);expected.status.setAttribute('role','alert');}
    function busy(expected,value){expected.busy=value;if(value)expected.status.setAttribute('role','status');for(const node of expected.body.querySelectorAll('button,input'))if(!node.classList.contains('native-recovery-close'))node.disabled=value||node.dataset.blocked==='true';expected.prepare.disabled=value||expected.selected.size===0;expected.dialog.setAttribute('aria-busy',String(value));}
    async function invoke(expected,method,payload){
      assertCurrent(expected);const id=requestId();expected.pending.add(id);let result;
      try{result=await bridge[method]({id,generation:expected.generation,...payload});if(!current(expected)){cancelCapability(expected,result?.exportToken||null,result?.inventoryToken);throw new DOMException('복구 화면이 변경되었습니다.','AbortError');}if(result?.generation!==expected.generation)throw Object.assign(new Error(),{code:'RECOVERY_STALE'});return result;}
      finally{expected.pending.delete(id);}
    }
    async function session(expected){
      const response=await transport.request('/api/session',{signal:expected.controller.signal});assertCurrent(expected);const value=await response.json();assertCurrent(expected);const signature=session=>JSON.stringify([session.workspace_id,session.member?.id,session.cache_binding]);const changed=expected.session?.authenticated&&value.authenticated&&signature(expected.session)!==signature(value);if(!value.authenticated||changed)clearInventory(expected);expected.session=value;
      if(!response.ok&&response.status!==401)throw Object.assign(new Error(),{code:'RECOVERY_AUTH_REQUIRED'});
      expected.account.textContent=value.authenticated?`${value.member?.name||'현재 계정'} · 이 서버의 기록만 확인합니다.`:'기록을 보관한 계정으로 로그인해 주세요.';if(changed)throw Object.assign(new Error(),{code:'RECOVERY_STALE'});return value;
    }
    function login(expected,value){
      expected.login.replaceChildren();const form=element('form',undefined,'form-grid native-recovery-login');
      if(value.mode==='local'){form.append(element('p','서버에서 현재 계정을 다시 확인해 주세요.'),button('다시 확인',()=>load(expected,null)));expected.login.append(form);return;}
      const add=(label,name,type)=>{const field=element('label',label),input=element('input');input.name=name;input.type=type;input.required=true;input.autocomplete=name==='email'?'username':'current-password';field.append(input);form.append(field);};
      if(value.mode==='accounts'){add('이메일','email','email');add('비밀번호','password','password');}else add('가족 공유 암호','token','password');
      if(value.mode==='accounts'&&value.setup_supported===true){
        const details=element('details',undefined,'native-recovery-setup');details.append(element('summary','처음 연결하거나 초대받았나요?'),element('p','받은 연결 코드를 입력하세요. 처음 시작한다면 새 계정 만들기를 선택하세요.'));
        const code=element('label','연결 코드'),nonce=element('input');nonce.name='setup_nonce';nonce.type='password';nonce.autocomplete='off';nonce.maxLength=43;code.append(nonce);
        const choice=element('label','새 계정 만들기'),create=element('input');create.type='checkbox';create.name='create_account';create.style.width='18px';choice.prepend(create);
        const confirmation=element('label','비밀번호 확인'),password=element('input');password.name='setup_password_confirm';password.type='password';password.autocomplete='new-password';confirmation.append(password);confirmation.hidden=true;
        create.addEventListener('change',()=>{confirmation.hidden=!create.checked;password.required=create.checked;form.querySelector('[name=password]').autocomplete=create.checked?'new-password':'current-password';});details.append(code,choice,confirmation);form.append(details);
      }

      const submit=element('button','로그인하고 기록 확인','solid-btn');submit.type='submit';form.append(submit);
      form.addEventListener('submit',async event=>{
        event.preventDefault();if(expected.busy)return;const data=new FormData(form),payload=value.mode==='accounts'?{email:data.get('email'),password:data.get('password')}:{token:data.get('token')};busy(expected,true);expected.status.textContent='로그인을 확인하고 있습니다…';
        try{
          if(value.setup_supported===true&&(data.get('setup_nonce')||data.has('create_account'))){
            const nonce=String(data.get('setup_nonce')||'');if(!/^[A-Za-z0-9_-]{43}$/.test(nonce))throw Object.assign(new Error(),{code:'RECOVERY_AUTH_REQUIRED'});payload.setup_nonce=nonce;
            if(data.has('create_account')){if(Array.from(String(data.get('password')||'')).length<10||data.get('password')!==data.get('setup_password_confirm'))throw Object.assign(new Error(),{code:'RECOVERY_AUTH_REQUIRED'});payload.create_account=true;}
          }
          // This intentional auth transition adopts only its synchronous transport scope.
          expected.ownAuth=true;let pending;try{pending=transport.request('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:expected.controller.signal});expected.scope=stamp();}finally{expected.ownAuth=false;}
          const response=await pending;assertCurrent(expected);if(!response.ok)throw Object.assign(new Error(),{code:'RECOVERY_AUTH_REQUIRED'});await response.json();assertCurrent(expected);expected.session=null;form.reset();expected.login.replaceChildren();await load(expected,null);
        }catch(error){report(expected,error);}finally{for(const input of form.querySelectorAll('input[type=password]'))input.value='';if(current(expected))busy(expected,false);}
      });expected.login.append(form);form.querySelector('input')?.focus();
    }
    function validInventory(value){return only(value,['generation','inventoryToken','items','next'])&&typeof value.inventoryToken==='string'&&value.inventoryToken.length>0&&value.inventoryToken.length<=512&&Array.isArray(value.items)&&value.items.length<=100&&(value.next===null||typeof value.next==='string'&&value.next.length>0&&value.next.length<=512)&&value.items.every(item=>only(item,['handle','category','recordCount','byteLength','state'])&&typeof item.handle==='string'&&item.handle.length>0&&item.handle.length<=512&&Object.hasOwn(labels,item.category)&&integer(item.recordCount)&&integer(item.byteLength)&&['needs_check','blocked'].includes(item.state));}
    function updateSelection(expected){invalidate(expected);expected.selectionVersion++;expected.prepare.disabled=expected.busy||expected.selected.size===0;expected.selection.textContent=`${expected.selected.size}개 묶음 선택`;}
    async function load(expected,cursor){
      if(!current(expected)||expected.busy&&cursor!==null)return;busy(expected,true);expected.status.textContent='현재 계정으로 보관된 기록을 확인하고 있습니다…';invalidate(expected);
      try{
        if(!expected.entered){if(typeof root.prepareNativeRecovery==='function')await root.prepareNativeRecovery();assertCurrent(expected);expected.entered=true;}
        if(cursor===null){cancelCapability(expected,null);expected.inventoryToken=null;expected.selected.clear();expected.handles.clear();expected.recordCounts.clear();expected.cursors.clear();expected.list.replaceChildren();expected.next.hidden=true;expected.selectionVersion++;}
        // This first native call enters recovery mode before generic session/login HTTP.
        const result=await invoke(expected,'recoveryInventory',{cursor,limit:50});if(!validInventory(result)||cursor!==null&&result.inventoryToken!==expected.inventoryToken)throw Object.assign(new Error(),{code:'RECOVERY_STALE'});
        if(result.next!==null&&(expected.cursors.has(result.next)||!result.items.length))throw Object.assign(new Error(),{code:'RECOVERY_STALE'});
        expected.inventoryToken=result.inventoryToken;if(result.next)expected.cursors.add(result.next);
        const account=await session(expected);if(!account.authenticated)throw Object.assign(new Error(),{code:'RECOVERY_AUTH_REQUIRED'});expected.login.replaceChildren();
        for(const item of result.items){
          if(expected.handles.has(item.handle))throw Object.assign(new Error(),{code:'RECOVERY_STALE'});expected.handles.add(item.handle);expected.recordCounts.set(item.handle,item.recordCount);
          const row=element('label',undefined,'native-recovery-item'),input=element('input');input.type='checkbox';input.dataset.blocked=String(item.state==='blocked');input.disabled=item.state==='blocked';
          const text=element('span');text.append(element('strong',labels[item.category]),element('small',`${item.recordCount}개 기록 · ${formatBytes(item.byteLength)}${item.state==='blocked'?' · 현재 확인 불가':''}`));row.append(input,text);expected.list.append(row);
          input.addEventListener('change',()=>{if(input.checked&&expected.selected.size>=100){input.checked=false;expected.status.textContent='한 번에 100개 묶음까지 선택할 수 있습니다.';return;}input.checked?expected.selected.add(item.handle):expected.selected.delete(item.handle);updateSelection(expected);});
        }
        expected.next.hidden=result.next===null;expected.next.onclick=()=>load(expected,result.next);expected.status.textContent=expected.handles.size?'내보낼 기록을 선택하고 현재 권한을 확인하세요.':'현재 계정으로 확인할 수 있는 보관 기록이 없습니다.';updateSelection(expected);if(cursor===null)await showReconciliation(expected);
      }catch(error){
        await recoveryError(expected,error);
      }finally{if(current(expected)){busy(expected,false);expected.prepare.disabled=expected.selected.size===0;}}
    }
    function formatBytes(size){return size<1024?`${size} B`:size<1048576?`${Math.ceil(size/1024)} KB`:`${(size/1048576).toFixed(1)} MB`;}
    async function prepare(expected){
      if(expected.busy||!expected.selected.size)return;busy(expected,true);invalidate(expected);const selectionVersion=expected.selectionVersion,handles=[...expected.selected].sort();expected.status.textContent='선택한 기록의 현재 권한을 확인하고 있습니다…';
      try{
        let selectedRecords=0;for(const handle of handles){selectedRecords+=expected.recordCounts.get(handle);if(!Number.isSafeInteger(selectedRecords))throw Object.assign(new Error(),{code:'RECOVERY_LIMIT'});}
        const result=await invoke(expected,'recoveryExport',{inventoryToken:expected.inventoryToken,handles,phase:'prepare'});assertCurrent(expected);
        if(!only(result,['generation','exportToken','readyCount','blockedCount','files','warnings'])||selectionVersion!==expected.selectionVersion||typeof result.exportToken!=='string'||!result.exportToken||result.exportToken.length>512||!integer(result.readyCount)||!integer(result.blockedCount)||!validFiles(result.files)||!Number.isSafeInteger(result.readyCount+result.blockedCount)||result.readyCount+result.blockedCount>selectedRecords||Boolean(result.readyCount)!==Boolean(result.files.length)||!Array.isArray(result.warnings)||result.warnings.length>100||!result.warnings.every(warning=>typeof warning==='string'&&warning.length<=1000)){cancelCapability(expected,result.exportToken);throw Object.assign(new Error(),{code:'RECOVERY_STALE'});}
        expected.prepared={exportToken:result.exportToken,files:result.files.map(file=>({byteLength:file.byteLength,format:file.format})),handles,selectionVersion};const summary=element('div',undefined,'native-recovery-summary');summary.append(element('h3','내보내기 확인'),element('p',`저장 가능 ${result.readyCount}개 · 보관 유지 ${result.blockedCount}개`));
        result.files.forEach((file,index)=>summary.append(element('p',`복구 파일 ${index+1} · JSON · ${formatBytes(file.byteLength)}`,'native-recovery-file')));
        if(result.blockedCount)summary.append(element('p','권한이나 내용을 확인할 수 없는 기록은 내보내지 않고 기기에 그대로 보관합니다.'));
        if(result.warnings.length)summary.append(element('p','일부 내용은 읽을 수 있는 원문으로 보관됩니다. 가져오기에서 내용을 확인한 뒤 별도로 복구하세요.','native-recovery-warning'));
        if(result.files.length>1)summary.append(element('p','파일마다 저장 위치를 선택해야 할 수 있습니다. 일부만 저장해도 원본은 유지됩니다.'));
        const save=button('파일로 저장',()=>savePrepared(expected),'solid-btn');save.disabled=!result.readyCount||!result.files.length;save.dataset.blocked=String(save.disabled);summary.append(save);expected.result.append(summary);expected.status.textContent='아직 파일을 저장하지 않았습니다. 내용을 확인하고 저장을 눌러 주세요.';
      }catch(error){await recoveryError(expected,error);}finally{if(current(expected))busy(expected,false);}
    }
    async function savePrepared(expected){
      const prepared=expected.prepared;if(expected.busy||!prepared||prepared.selectionVersion!==expected.selectionVersion)return;busy(expected,true);expected.status.textContent='기기의 저장 위치를 선택해 주세요…';
      try{
        const result=await invoke(expected,'recoveryExport',{inventoryToken:expected.inventoryToken,handles:prepared.handles,phase:'save',exportToken:prepared.exportToken});if(!only(result,['generation','saved','filesSaved'])||typeof result.saved!=='boolean'||!integer(result.filesSaved)||result.filesSaved>prepared.files.length)throw Object.assign(new Error(),{code:'RECOVERY_STALE'});
        invalidate(expected);expected.status.textContent=result.saved&&result.filesSaved===prepared.files.length?`${result.filesSaved}개 파일을 저장했습니다. 원본은 기기에 그대로 보관했습니다.`:result.filesSaved?`${result.filesSaved}개 파일만 저장했습니다. 나머지와 원본은 그대로 보관했습니다.`:'저장을 취소했습니다. 원본은 그대로 보관했습니다.';
      }catch(error){invalidate(expected);await recoveryError(expected,error);}finally{if(current(expected))busy(expected,false);}
    }
    async function confirmReconciliation(summary){
      const counts=summary?.counts;if(!counts||!['current','upgrade','promote'].includes(summary.mode))return false;
      // No resource names, bodies or hidden identifiers are part of this public summary.
      const dialog=element('dialog',undefined,'native-recovery-dialog native-reconcile-dialog'),body=element('div',undefined,'native-recovery-body'),scope=stamp();
      const heading=element('h2',summary.mode==='current'?'기기 기록 다시 확인':'보관된 기록 가져오기');heading.id='native-reconcile-heading';dialog.setAttribute('aria-labelledby',heading.id);
      body.append(heading,element('p','현재 계정과 문서 권한을 확인했습니다. 확인되지 않은 원본은 복구 보관함에 유지합니다.','native-recovery-description'));
      const list=element('dl',undefined,'native-reconcile-counts'),labels={refresh:'최신 상태로 갱신',keep:'그대로 유지',acknowledge:'서버 저장 확인',quarantine:'복구 보관함으로 이동',import:'새 변경으로 가져오기'};
      for(const [key,label]of Object.entries(labels)){list.append(element('dt',label),element('dd',String(counts[key])+'개'));}body.append(list);
      const explanations={missing:'현재 상태를 다시 확인한 기록이 있습니다.',expired:'권한 확인 기간이 지난 기록이 있습니다.',revision_changed:'문서 또는 데이터가 변경되었습니다.',epoch_changed:'문서 편집 기준이 변경되었습니다.',local_dependency:'서로 연결된 미전송 변경이 있습니다.',denied:'현재 권한으로 적용할 수 없는 기록은 보관합니다.',schema_changed:'데이터베이스 구조가 변경되었습니다.',dependency_conflict:'연결된 변경을 함께 보관합니다.',unconfirmed_input:'저장 완료를 확인하지 못한 입력은 보관합니다.',binding_changed:'이전 로그인 기록은 자동으로 적용하지 않습니다.',legacy_cache:'이전 앱의 기록을 별도로 보관했습니다.',unsupported_input:'자동으로 가져올 수 없는 원본은 내보내기로 확인할 수 있습니다.'};
      for(const reason of summary.reasons||[])if(explanations[reason])body.append(element('p',explanations[reason],'native-reconcile-reason'));
      body.append(element('p',summary.mode==='current'?'보관함으로 옮기는 기록은 현재 편집 목록에서 빠지지만 원본은 남습니다.':'가져온 변경은 새 식별자로 생성합니다. 이전 공유 설정이나 로그인 정보는 복원하지 않습니다.','native-recovery-warning'));
      const actions=element('div',undefined,'native-recovery-actions');body.append(actions);dialog.append(body);document.body.append(dialog);
      return new Promise(resolve=>{
        let settled=false,timer;const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);if(confirmation===finish)confirmation=null;root.removeEventListener('fountain-native-scope-changed',changed);root.removeEventListener('pagehide',cancel);dialog.close();dialog.remove();resolve(value&&scope===stamp()&&Date.now()<summary.expiresAt);};
        const changed=()=>finish(false),cancel=()=>finish(false);confirmation=finish;
        actions.append(button('취소하고 원본 보관',cancel),button(summary.mode==='current'?'확인하고 계속':'확인하고 가져오기',()=>finish(true),'solid-btn'));
        dialog.addEventListener('cancel',event=>{event.preventDefault();cancel();});root.addEventListener('fountain-native-scope-changed',changed);root.addEventListener('pagehide',cancel);timer=setTimeout(cancel,Math.max(0,summary.expiresAt-Date.now()));dialog.showModal();actions.querySelector('button').focus();
      });
    }
    async function continueStorage(expected,mode='current',handles=[]){
      if(expected.busy||!root.FountainNativeStorage)return;busy(expected,true);expected.status.textContent='현재 계정의 기기 저장을 준비하고 있습니다…';
      try{await root.FountainNativeStorage.reconcile({mode,handles,signal:expected.controller.signal});assertCurrent(expected);close();root.dispatchEvent(new CustomEvent('fountain-native-outbox-ready'));}
      catch(error){report(expected,error);}finally{if(current(expected))busy(expected,false);}
    }
    async function showReconciliation(expected){
      if(!root.FountainNativeStorage||!transport.outboxEnabled)return;
      const handles=await root.FountainNativeStorage.recoveryHandles();assertCurrent(expected);
      const section=element('section',undefined,'native-recovery-summary');section.append(element('h3','편집 다시 시작'),element('p','원본을 보관한 채 현재 계정의 최신 문서로 계속하거나, 확인한 기록을 새 변경으로 가져올 수 있습니다.'));
      section.append(button('원본 보관하고 최신 상태로 계속',()=>continueStorage(expected),'solid-btn'));
      const selected=new Set();for(const item of handles){const label=element('label',undefined,'native-recovery-item'),input=element('input');input.type='checkbox';input.addEventListener('change',()=>input.checked?selected.add(item.handle):selected.delete(item.handle));label.append(input,element('span',`${item.kind==='upgrade'?'이전 앱':'복구 보관함'} · ${item.count}개 기록`));section.append(label);}
      if(handles.length)section.append(button('선택한 기록 확인하고 가져오기',()=>{const items=handles.filter(item=>selected.has(item.handle));if(!items.length){expected.status.textContent='가져올 기록을 선택해 주세요.';return;}if(items.some(item=>item.kind!==items[0].kind)){expected.status.textContent='이전 앱 기록과 복구 보관함은 나누어 선택해 주세요.';return;}return continueStorage(expected,items[0].kind==='upgrade'?'upgrade':'promote',items.map(item=>item.handle));}));
      expected.result.append(section);
    }
    async function open(){
      if(!available())return false;close();const loginOnly=transport.outboxEnabled&&root.FountainNativeStorage?.identityState!=='verified',dialog=element('dialog',undefined,'native-recovery-dialog'),body=element('div',undefined,'native-recovery-body'),heading=element('h2',loginOnly?'가족 작업공간 연결':'기기에 보관된 기록 복구');heading.id='native-recovery-heading';dialog.setAttribute('aria-labelledby',heading.id);
      const expected={dialog,body,scope:stamp(),generation:transport.generation,controller:new AbortController(),pending:new Set(),selected:new Set(),handles:new Set(),recordCounts:new Map(),cursors:new Set(),selectionVersion:0,returnFocus:document.activeElement,prepared:null,inventoryToken:null,busy:false,entered:false};view=expected;
      const header=element('header');header.append(heading,button('닫기',close,'native-recovery-close'));expected.account=element('p','현재 계정을 확인합니다.','native-recovery-account');expected.login=element('div');expected.list=element('div',undefined,'native-recovery-list');expected.result=element('div');expected.status=element('p','', 'native-recovery-status');expected.status.setAttribute('role','status');expected.status.setAttribute('aria-live','polite');expected.selection=element('span','0개 묶음 선택');expected.prepare=button('선택한 기록 확인',()=>prepare(expected),'solid-btn');expected.prepare.disabled=true;expected.next=button('기록 더 보기',()=>{});expected.next.hidden=true;
      const actions=element('div',undefined,'native-recovery-actions');actions.append(expected.selection,expected.prepare);const accountActions=element('div',undefined,'native-recovery-account-actions');accountActions.append(button('목록 다시 확인',()=>load(expected,null)),button('다른 계정으로 로그인',()=>{if(!expected.entered){void load(expected,null);return;}invalidate(expected);expected.selected.clear();expected.list.replaceChildren();expected.next.hidden=true;login(expected,{...expected.session,mode:expected.session?.mode||'accounts'});updateSelection(expected);}));
      body.append(header,element('p',loginOnly?'연결할 계정으로 로그인하세요. 로그인 전에는 기기에 남은 기록을 변경하거나 적용하지 않습니다.':'이전에 보관한 기록을 파일로 내보냅니다. 현재 권한을 확인하며, 원본은 지우거나 자동으로 적용하지 않습니다. '+(transport.outboxEnabled&&root.FountainNativeStorage?'원본을 보관하고 편집을 다시 시작할 수도 있습니다.':'화면을 닫은 뒤 작업을 계속하려면 앱을 다시 열어 주세요.'),'native-recovery-description'),expected.account,accountActions,expected.status,expected.login,expected.list,expected.next,actions,expected.result);dialog.append(body);document.body.append(dialog);dialog.addEventListener('cancel',event=>{event.preventDefault();close();});dialog.showModal();dialog.querySelector('.native-recovery-close').focus();await load(expected,null);return current(expected);
    }
    root.addEventListener('fountain-native-scope-changed',()=>{if(view){if(view.ownAuth&&transport.generation===view.generation&&transport.origin===view.scope.split('|')[0])view.scope=stamp();else close();}});
    root.addEventListener('popstate',close);root.addEventListener('hashchange',close);root.addEventListener('pagehide',close);
    return Object.freeze({get available(){return available();},get active(){return !!view;},confirmReconciliation,open,close});
  }
  root.FountainNativeRecoveryPanel=Object.freeze({create});
})(globalThis);
