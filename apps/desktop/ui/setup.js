'use strict';
const form=document.getElementById('server-form'),input=document.getElementById('server'),error=document.getElementById('error'),button=form.querySelector('button');
window.fountainSetup.get().then(value=>{input.value=value.server||'';error.textContent=value.error||'';input.focus();}).catch(()=>{error.textContent='설정을 열 수 없습니다.';});
form.addEventListener('submit',async event=>{
  event.preventDefault();button.disabled=true;error.textContent='';
  try{const result=await window.fountainSetup.save(input.value.trim());if(!result.ok)error.textContent=result.error;}
  catch{error.textContent='서버 주소를 저장할 수 없습니다.';}
  finally{button.disabled=false;}
});
