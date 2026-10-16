'use strict';
const {createHash}=require('node:crypto');

function normalizeServer(input){
  if(typeof input!=='string'||!input||input.length>2048||/[\s\\\u0000-\u001f\u007f?#]/u.test(input))throw new Error('서버 주소를 확인하세요.');
  const root=/^(https?):\/\/([^/]+)\/?$/i.exec(input);
  if(!root)throw new Error('서버의 HTTPS 기본 주소만 입력하세요.');
  let url;try{url=new URL(input);}catch{throw new Error('올바른 서버 주소를 입력하세요.');}
  if(url.username||url.password||url.pathname!=='/'||url.search||url.hash||!url.hostname||url.hostname==='.')throw new Error('계정 정보나 경로가 없는 서버 주소를 입력하세요.');
  if(url.protocol==='http:'&&!/^(localhost|127\.0\.0\.1|\[::1\])(?::[1-9][0-9]{0,4})?$/i.test(root[2]))throw new Error('외부 서버에는 HTTPS를 사용하세요.');
  if(!['http:','https:'].includes(url.protocol)||root[2].includes('@')||root[2].endsWith(':'))throw new Error('허용되지 않은 서버 주소입니다.');
  return url.origin+'/';
}
function sameOrigin(target,server){
  try{const value=new URL(target);return !value.username&&!value.password&&['http:','https:'].includes(value.protocol)&&value.origin===new URL(server).origin;}catch{return false;}
}
function downloadAllowed(target,server){
  if(sameOrigin(target,server))return true;
  try{const value=new URL(target);return value.protocol==='blob:'&&value.origin===new URL(server).origin;}catch{return false;}
}
function resourceAllowed(target,server){
  return sameOrigin(target,server)||downloadAllowed(target,server)||/^data:(image\/|font\/)/i.test(target);
}
function partitionFor(server){return 'persist:fountain-'+createHash('sha256').update(normalizeServer(server)).digest('hex');}
function popupAllowed(details,server){
  if(!details||details.postBody||!sameOrigin(details.url,server))return false;
  const value=new URL(details.url);
  return !value.search&&!value.hash&&/^\/(?:forms|sites)\/[A-Za-z0-9_-]{1,160}$/.test(value.pathname);
}
function isSetupSender(event,contents,setupURL){
  try{return !!contents&&!contents.isDestroyed()&&event.sender===contents&&event.senderFrame===contents.mainFrame&&event.senderFrame.url===setupURL;}catch{return false;}
}
module.exports={normalizeServer,sameOrigin,downloadAllowed,resourceAllowed,partitionFor,popupAllowed,isSetupSender};
