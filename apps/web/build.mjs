/** Copy reviewed public assets only; never upload the repository or .data. */
import {readFile,lstat,realpath,mkdir,rm,writeFile,copyFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const folder=dirname(fileURLToPath(import.meta.url)),source=resolve(folder,'../../static'),destination=join(folder,'dist');
export const ASSETS=Object.freeze(['account.js','workspaces.js','workspace-scope.js','app.js','backup.js','collaboration.js','index.html','mutations.js','offline.js','organization.html','organization.js','organization.css','presence.js','public.js','recovery-import.js','style.css','sw.js','transport.js','uploads.js','version-diff.js']);
export async function build(){
  try{if((await lstat(destination)).isSymbolicLink())throw Error('Web output must be a regular directory');}catch(error){if(error.code!=='ENOENT')throw error;}
  const files=[...ASSETS];
  for(const name of files){const path=join(source,name);if(!(await lstat(path)).isFile()||await realpath(path)!==path)throw Error('Public assets must be regular files');}
  const relay=join(folder,'api/public-relay.mjs');if(!(await lstat(relay)).isFile()||await realpath(relay)!==relay)throw Error('Relay must be a regular file');
  await rm(destination,{recursive:true,force:true});await mkdir(destination);
  for(const name of files)await copyFile(join(source,name),join(destination,name));
  const config=JSON.parse(await readFile(join(folder,'vercel.json'),'utf8'));
  // Only this presentation relay is dynamic. Business code, source maps,
  // databases, credentials and repository paths never enter the artifact.
  delete config.buildCommand;delete config.outputDirectory;delete config.installCommand;
  await writeFile(join(destination,'vercel.json'),JSON.stringify(config,null,2)+'\n');
  await mkdir(join(destination,'api'));await copyFile(relay,join(destination,'api/public-relay.mjs'));
  return {destination,files:[...files,'vercel.json','api/public-relay.mjs']};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const result=await build();console.log('Built web application: '+result.files.length+' allowlisted files including one presentation relay');}
