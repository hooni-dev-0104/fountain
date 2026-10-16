/** Build a local-only shell from regular public assets; never traverse the repository. */
import {readFile,readdir,lstat,realpath,mkdir,rm,writeFile,copyFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
const mobile=resolve(dirname(fileURLToPath(import.meta.url)),'..'),source=resolve(mobile,'../../static');
export async function build(output=join(mobile,'www')) {
  const destination=resolve(output);
  if(destination!==join(mobile,'www')&&!destination.startsWith(resolve(tmpdir())+'/fountain-mobile-'))throw new Error('Bundle destination must be www or an isolated mobile test directory');
  if(destination===source||source.startsWith(destination+'/')||destination===mobile||destination===resolve(mobile,'../..'))throw new Error('Unsafe bundle destination');
  try{if((await lstat(destination)).isSymbolicLink())throw new Error('Bundle destination must not be a symbolic link');}catch(error){if(error.code!=='ENOENT')throw error;}
  const assets=[];
  for(const name of await readdir(source))if(name==='index.html'||/^[a-z][a-z0-9.-]*\.(js|css)$/.test(name)){
    const file=join(source,name);if(!(await lstat(file)).isFile()||(await realpath(file))!==file)throw new Error('Public assets must be regular files: '+name);assets.push(name);
  }
  const original=await readFile(join(source,'index.html'),'utf8');
  const scripts=[...original.matchAll(/<script src="\/([a-z][a-z0-9.-]*\.js)" defer><\/script>/g)].map(match=>match[1]).filter(name=>name!=='transport.js');
  if(!scripts.includes('app.js')||scripts.some(name=>!assets.includes(name)))throw new Error('Missing bundled application assets');
  const csp="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-src 'none'";
  const html=original.replace('<head>','<head>\n<meta http-equiv="Content-Security-Policy" content="'+csp+'">').replace('</head>','<link rel="stylesheet" href="/native-configuration.css"></head>').replace(/<script src="\/[a-z][a-z0-9.-]*\.js" defer><\/script>/g,'').replace('</body>','<script src="/capacitor.js" defer></script><script src="/native-transport.js" defer></script><script src="/bootstrap.js" data-assets="'+scripts.join(',')+'" defer></script></body>');
  await rm(destination,{recursive:true,force:true});await mkdir(destination,{recursive:true});
  for(const name of assets)if(name!=='index.html'&&name!=='transport.js')await copyFile(join(source,name),join(destination,name));
  for(const name of ['native-transport.js','bootstrap.js','native-configuration.css'])await copyFile(join(mobile,'web',name),join(destination,name));
  await copyFile(join(mobile,'node_modules/@capacitor/core/dist/capacitor.js'),join(destination,'capacitor.js'));
  await writeFile(join(destination,'index.html'),html);
  return {destination,assets:[...assets.filter(name=>name!=='transport.js'),'native-transport.js','bootstrap.js','native-configuration.css','capacitor.js']};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const result=await build();console.log('Built native shell: '+result.assets.length+' public assets');}
