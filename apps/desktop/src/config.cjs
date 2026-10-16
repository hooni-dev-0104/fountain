'use strict';
const fs=require('node:fs');const path=require('node:path');const {randomUUID}=require('node:crypto');
const {normalizeServer}=require('./security.cjs');
function prepare(directory){
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const info=fs.lstatSync(directory);
  if(info.isSymbolicLink()||!info.isDirectory())throw new Error('설정 폴더를 사용할 수 없습니다.');
  if(process.platform!=='win32'){if(info.uid!==process.getuid())throw new Error('설정 폴더 소유자를 확인하세요.');fs.chmodSync(directory,0o700);}
}
function configPath(directory){return path.join(directory,'server.json');}
function checkFile(file){
  let info;try{info=fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')return false;throw error;}
  if(info.isSymbolicLink()||!info.isFile()||info.size>8192||(process.platform!=='win32'&&(info.uid!==process.getuid()||(info.mode&0o077))))throw new Error('저장된 서버 설정을 확인하세요.');
  return true;
}
function readConfig(directory){
  const file=configPath(directory);if(!checkFile(file))return null;
  const value=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!value||Object.keys(value).sort().join(',')!=='server,version'||value.version!==1)throw new Error('저장된 서버 설정을 확인하세요.');
  return normalizeServer(value.server);
}
function saveConfig(directory,server){
  prepare(directory);checkFile(configPath(directory));const normalized=normalizeServer(server);
  const temporary=path.join(directory,'.server-'+randomUUID()+'.tmp');
  try{fs.writeFileSync(temporary,JSON.stringify({version:1,server:normalized})+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temporary,configPath(directory));}
  finally{try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
  return normalized;
}
module.exports={prepare,readConfig,saveConfig,configPath};
