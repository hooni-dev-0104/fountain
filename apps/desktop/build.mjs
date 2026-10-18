/** Build only the reviewed public UI, never the relay, repository or private data. */
import {constants} from 'node:fs';
import {lstat,realpath,readdir,open,mkdtemp,writeFile,rm,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,join,resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ASSETS} from '../web/build.mjs';

const folder=dirname(fileURLToPath(import.meta.url));
const MIME=Object.freeze({'.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8'});
const FILE_LIMIT=4*1024*1024,TOTAL_LIMIT=16*1024*1024;
if(ASSETS.length!==20||new Set(ASSETS).size!==20||ASSETS.some(name=>! /^[a-z0-9][a-z0-9-]*\.(js|css|html)$/.test(name)))throw Error('Review desktop public asset policy');

async function directory(path){
  const info=await lstat(path);
  if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path)throw Error('Bundle paths must be regular directories without links');
}
async function output(destination){
  await directory(dirname(destination));
  try{await directory(destination);return true;}catch(error){if(error.code!=='ENOENT')throw error;return false;}
}
// Crash recovery uses one fixed sibling. Missing output is restored automatically;
// if both exist, preserve both and require operator review of bundle.previous.
// These are two renames, not an atomic whole-directory swap. Unfinished stage
// directories also fail closed for operator review, never entering a package.
async function recover(destination,renameDirectory){
  const present=await output(destination),previous=destination+'.previous';
  if(await output(previous)){
    if(present)throw Error('Desktop bundle recovery requires review of existing output and .previous');
    await renameDirectory(previous,destination);
  }
}
async function asset(source,name){
  const path=join(source,name),before=await lstat(path);
  if(!before.isFile()||before.isSymbolicLink()||before.size>FILE_LIMIT||await realpath(path)!==path)throw Error('Public assets must be bounded regular files without links');
  const handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
  try{
    const info=await handle.stat();
    if(!info.isFile()||info.size!==before.size||info.ino!==before.ino||info.dev!==before.dev)throw Error('Public asset changed during build');
    const bytes=Buffer.alloc(info.size);let offset=0;
    while(offset<bytes.length){const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,null);if(!bytesRead)throw Error('Incomplete public asset');offset+=bytesRead;}
    const extra=await handle.read(Buffer.alloc(1),0,1,null),after=await handle.stat(),current=await lstat(path);
    if(extra.bytesRead||after.size!==info.size||after.mtimeMs!==info.mtimeMs||after.ctimeMs!==info.ctimeMs||!current.isFile()||current.ino!==info.ino||current.dev!==info.dev||await realpath(path)!==path)throw Error('Public asset changed during build');
    return bytes;
  }finally{await handle.close();}
}

// Injection is for isolated fixtures; the executable has fixed paths and no options.
export function createBuilder({source=resolve(folder,'../../static'),destination=join(folder,'bundle'),renameDirectory=rename}={}){
  source=resolve(source);destination=resolve(destination);
  if(source===destination||destination.startsWith(source+sep)||source.startsWith(destination+sep))throw Error('Bundle paths must be separate');
  return async function build(){
    await directory(source);await recover(destination,renameDirectory);
    if((await readdir(dirname(destination))).some(name=>name.startsWith('.fountain-bundle-')))throw Error('Unfinished desktop bundle stage requires review');
    const files=[];let total=0;
    for(const name of ASSETS){const bytes=await asset(source,name);total+=bytes.length;if(total>TOTAL_LIMIT)throw Error('Public bundle is too large');files.push({name,bytes});}
    const manifest={version:1,files:files.map(({name,bytes})=>({name,mime:MIME[extname(name)],size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}))};
    const stage=await mkdtemp(join(dirname(destination),'.fountain-bundle-'));let failure;
    try{
      for(const {name,bytes}of files)await writeFile(join(stage,name),bytes,{flag:'wx'});
      await writeFile(join(stage,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
      const previous=destination+'.previous',hadOld=await output(destination);
      if(await output(previous))throw Error('Desktop bundle recovery requires review of .previous');
      if(hadOld)await renameDirectory(destination,previous);
      try{await renameDirectory(stage,destination);}catch(error){
        if(hadOld){
          try{await renameDirectory(previous,destination);}catch(restoreError){
            throw new AggregateError([error,restoreError],'Desktop publication failed; .previous needs recovery',{cause:error});
          }
        }
        throw error;
      }
      if(hadOld)await rm(previous,{recursive:true,force:true});
    }catch(error){failure=error;throw error;}finally{
      try{await rm(stage,{recursive:true,force:true});}catch(cleanupError){
        if(failure)throw new AggregateError([failure,cleanupError],'Desktop build failed and stage cleanup failed',{cause:failure});
        throw cleanupError;
      }
    }
    return {destination,manifest};
  };
}
export const build=createBuilder();
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==2)throw Error('Desktop build accepts no arguments');
  const result=await build();console.log('Built desktop public UI: '+result.manifest.files.length+' files');
}
