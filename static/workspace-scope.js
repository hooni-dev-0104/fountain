/* Shared, token-free workspace address rules for browser and native shells. */
(function(root){
  'use strict';
  const id=/^[A-Za-z0-9_-]{1,160}$/,binding=/^[a-f0-9]{32}$/;
  const invalid=()=>{throw new TypeError('작업공간 연결 범위가 올바르지 않습니다.');};
  function validate(value,{now=Date.now(),allowExpired=false}={}){
    if(!value||typeof value!=='object'||Array.isArray(value)||!id.test(value.workspaceId)||!id.test(value.memberId)||!binding.test(value.binding)||!binding.test(value.accountBinding)||!Number.isSafeInteger(value.expiresAt)||!allowExpired&&value.expiresAt<=now||!Number.isSafeInteger(value.workspaceEpoch)||value.workspaceEpoch<0)invalid();
    if(value.offline!==undefined&&typeof value.offline!=='boolean')invalid();
    const copy=Object.fromEntries(['workspaceId','memberId','binding','accountBinding','expiresAt','workspaceEpoch'].map(key=>[key,value[key]]));if(value.offline!==undefined)copy.offline=value.offline;return Object.freeze(copy);
  }
  function path(value){
    if(typeof value!=='string'||value.length>16384||!value.startsWith('/api/')||/[\\\u0000-\u0020\u007f#]/.test(value))invalid();
    const raw=value.split('?')[0];let decoded=raw;
    for(let n=0;n<8;n++){if(decoded.includes('//')||decoded.split('/').some(part=>part==='.'||part==='..')||/[\\\u0000-\u001f\u007f]/.test(decoded))invalid();if(!/%[0-9a-f]{2}/i.test(decoded)){if(n===0&&decoded.includes('%'))invalid();break;}let next;try{next=decodeURIComponent(decoded);}catch{invalid();}if(next.split('/').length!==decoded.split('/').length)invalid();decoded=next;if(n===7)invalid();}
    if(raw.split('/')[2]!==decoded.split('/')[2]&&/^\/api\/(?:w|account|organization)(?:\/|$)/.test(decoded))invalid();return value;
  }
  function logical(value,scope){
    value=path(value);scope=validate(scope);const prefix='/api/w/'+scope.workspaceId+'/'+scope.binding+'/';
    if(value.startsWith(prefix)){const result='/api/'+value.slice(prefix.length);if(/^\/api\/(?:w|account|organization)(?:\/|\?|$)/.test(result))invalid();return path(result);}
    if(/^\/api\/(?:w|account|organization)(?:\/|\?|$)/.test(value))invalid();return value;
  }
  function wire(value,scope){scope=validate(scope);return '/api/w/'+scope.workspaceId+'/'+scope.binding+logical(value,scope).slice(4);}
  function navigation(route='home',scope){scope=validate(scope);if(typeof route!=='string'||! /^(?:home|page\/[^/?#]+|database\/[^/?#]+|form\/[^/?#]+|site\/[^/?#]+)$/.test(route)||/[\\\u0000-\u0020\u007f]/.test(route))invalid();return 'w/'+scope.workspaceId+'/'+route;}
  function fromSession(session,workspaceEpoch=0){if(session?.authenticated!==true||session.mode!=='accounts')invalid();return validate({workspaceId:session?.workspace_id,memberId:session?.member?.id,binding:session?.cache_binding,accountBinding:session?.account_binding,expiresAt:Date.parse(session?.expires_at),workspaceEpoch});}
  function same(a,b){return !!a&&!!b&&['workspaceId','memberId','binding','accountBinding','expiresAt','workspaceEpoch'].every(key=>a[key]===b[key]);}
  function parsePresentationScope(pathname,metadata){
    if(typeof pathname!=='string'||!/^\/api\/w\/[A-Za-z0-9_-]{1,160}\/[a-f0-9]{32}\/(?:sites|forms)\/[A-Za-z0-9_-]{1,160}$/.test(pathname))invalid();
    let value=metadata;if(typeof value==='string'){if(value.length>4096)invalid();try{value=JSON.parse(value);}catch{invalid();}}
    if(!value||Object.keys(value).sort().join(',')!==['workspaceId','memberId','binding','accountBinding','expiresAt'].sort().join(','))invalid();
    const scope=validate({...value,workspaceEpoch:0}),parts=pathname.split('/');if(parts[3]!==scope.workspaceId||parts[4]!==scope.binding)invalid();return scope;
  }
  const api=Object.freeze({validate,wire,logical,navigation,fromSession,same,parsePresentationScope});root.FountainWorkspaceScope=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(globalThis);
