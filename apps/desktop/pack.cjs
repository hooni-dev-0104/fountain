'use strict';
const path=require('node:path');
(async()=>{
  const [platform,arch]=process.argv.slice(2);
  if(!((platform==='darwin'&&arch==='arm64')||(platform==='win32'&&arch==='x64')))throw new Error('Use darwin arm64 or win32 x64');
  const {packager}=await import('@electron/packager');
  const output=path.resolve(__dirname,'..','..','.data','desktop-build');
  const results=await packager({dir:__dirname,name:'Fountain',platform,arch,electronVersion:'44.8.0',appVersion:'0.1.0',
    out:output,overwrite:true,asar:true,prune:true,appBundleId:'dev.fountain.desktop',appCategoryType:'public.app-category.productivity',
    ignore:[/^\/\.gitignore$/,/^\/pack\.cjs$/,/^\/README\.md$/,/^\/package-lock\.json$/],
    ...(platform==='darwin'?{osxSign:false}:{}),
  });
  console.log(results.join('\n'));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
