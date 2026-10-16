/* Load the bundled shell only after the native server scope is known. */
(async function () {
  'use strict';
  const assets=(document.currentScript?.dataset.assets||'').split(',').filter(Boolean);
  const main=document.getElementById('main');
  function error(message){main.replaceChildren();const paragraph=document.createElement('p');paragraph.className='empty';paragraph.textContent=message;main.append(paragraph);}
  try {
    if(!globalThis.Capacitor?.isNativePlatform()||!Capacitor.isPluginAvailable('FountainNative'))throw new Error('이 번들은 Fountain 네이티브 앱에서 열어 주세요.');
    const bridge=Capacitor.registerPlugin('FountainNative'),transport=FountainNativeTransport.create(bridge);
    globalThis.FountainTransport=transport;
    globalThis.addEventListener('fountain-native-error',event=>{const toast=document.getElementById('toast');if(toast){toast.textContent=event.detail.message;toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),5000);}});
    const configuration=await transport.initialize();
    if(!configuration.origin)await new Promise(resolve=>{
      main.replaceChildren();const panel=document.createElement('section');panel.className='empty native-configuration';
      const heading=document.createElement('h1');heading.textContent='Fountain 서버 연결';
      const description=document.createElement('p');description.textContent='가족이 사용하는 HTTPS 서버 주소를 입력하세요. 로그인 정보는 다음 화면에서 입력합니다.';
      const form=document.createElement('form');form.className='form-grid';form.id='native-configuration-form';
      const label=document.createElement('label');label.textContent='HTTPS 서버 주소';const input=document.createElement('input');input.name='origin';input.type='url';input.required=true;input.placeholder='https://fountain.example.com';input.autocomplete='url';label.append(input);
      const submit=document.createElement('button');submit.className='solid-btn';submit.textContent='서버 연결';const status=document.createElement('p');status.setAttribute('role','status');form.append(label,submit,status);
      form.addEventListener('submit',async event=>{event.preventDefault();submit.disabled=true;try{await transport.configure({origin:input.value});resolve();}catch(failure){status.textContent=failure.message;}finally{submit.disabled=false;}});
      panel.append(heading,description,form);main.append(panel);input.focus();
    });
    const load=async name=>{if(!/^[a-z][a-z0-9.-]*\.js$/.test(name))throw new Error('앱 자산 목록이 올바르지 않습니다.');await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/'+name;script.onload=resolve;script.onerror=()=>reject(new Error('앱 파일을 열지 못했습니다.'));document.body.append(script);});};
    for(const name of assets.filter(name=>name!=='app.js'))await load(name);
    if(transport.outboxEnabled===true&&transport.outboxVersion===1){
      // A real native request verifies the private grant; offline startup can use only an existing native grant.
      try{const session=await transport.request('/api/session');await session.json();}catch(failure){if(failure.name!=='TypeError'&&failure.name!=='NetworkError'&&failure.name!=='TimeoutError')throw failure;}
      const storage=FountainNativeOutbox.create(bridge,{origin:transport.origin,generation:transport.generation});
      await storage.initialize();globalThis.FountainNativeStorage=storage;
    }
    await load('app.js');
  }catch(failure){error(failure.message||'앱을 시작하지 못했습니다.');}
})();
