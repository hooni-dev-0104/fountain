/** Escaped publishing/clipboard HTML. This returns data; the HTTP relay owns
 * publication content-type and fresh authentication/resource checks. */
import {get,truth} from './access.ts';
import type {Entity} from './access.ts';
import {normalize_blocks,block_depths,validate_marks} from './core.ts';
import type {Advanced} from './advanced.ts';
import {advancedRequire as check} from './advanced.ts';
import type {DomainResult} from './domain.ts';

export const escapeHTML=(value:string)=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
export function pythonJSON(value:any,ascii=false):string{
  const stringify=(item:any):string=>item===null||typeof item!=='object'?JSON.stringify(item):Array.isArray(item)?'['+item.map(stringify).join(', ')+']':'{'+Object.keys(item).map(key=>JSON.stringify(key)+': '+stringify(item[key])).join(', ')+'}';
  const result=stringify(value);return ascii?result.replace(/[\u007f-\uffff]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0')):result;
}
const COLORS:Entity={gray:'#787774',brown:'#9f6b53',orange:'#d9730d',yellow:'#b58105',green:'#448361',blue:'#337ea9',purple:'#9065b0',pink:'#c14c8a',red:'#d44c47'};
const BACKGROUNDS:Entity={gray:'#f1f1ef',brown:'#f4eeee',orange:'#fbecdd',yellow:'#fbf3db',green:'#edf3ec',blue:'#e7f3f8',purple:'#f4f0f7',pink:'#f9eef3',red:'#fdebec'};
export function inline_html(block:Entity):string{
  return (truth(get(block,'rich_text'))?block.rich_text:[{text:get(block,'text',''),marks:{}}]).map((token:Entity)=>{
    const marks=validate_marks(get(token,'marks',{}));let content=escapeHTML(get(token,'text','')).replace(/\n/g,'<br>');
    for(const [mark,tag]of [['code','code'],['bold','strong'],['italic','em'],['underline','u'],['strike','s']])if(truth(get(marks,mark)))content='<'+tag+'>'+content+'</'+tag+'>';
    const styles=[];if(Object.hasOwn(COLORS,marks.color))styles.push('color:'+COLORS[marks.color]);if(Object.hasOwn(BACKGROUNDS,marks.background))styles.push('background-color:'+BACKGROUNDS[marks.background]);if(styles.length)content='<span style="'+styles.join(';')+'">'+content+'</span>';
    if(truth(get(marks,'link')))content='<a rel="noopener noreferrer" href="'+escapeHTML(marks.link)+'">'+content+'</a>';return content;
  }).join('');
}
export function blocks_html(input:unknown):string{
  const blocks=normalize_blocks(input),depths=block_depths(blocks);return blocks.map(block=>{
    const kind=block.type;let tag=get({heading1:'h1',heading2:'h2',heading3:'h3',quote:'blockquote',code:'pre'},kind,'p'),content=inline_html(block);
    if(kind==='divider'){content='';tag='hr';}if(['bullet','numbered'].includes(kind))content=(kind==='bullet'?'• ':'1. ')+content;if(kind==='todo')content=(truth(get(block,'checked'))?'☑ ':'☐ ')+content;
    const style=depths[block.id]?' style="margin-left:'+depths[block.id]*24+'px"':'';return tag==='hr'?'<hr>':'<'+tag+style+'>'+content+'</'+tag+'>';
  }).join('');
}
export function render_public(service:Advanced,path:string):DomainResult|null{
  const parts=path.replace(/^\/+|\/+$/g,'').split('/');if(parts.length!==2)return null;
  check(!truth(get(service.settings(),'disable_public_sharing')),'공개 공유가 비활성화되었습니다',404);
  let title:string,description:string,content:string;
  if(parts[0]==='sites'){
    const sites=service.store.list('site').filter(site=>get(site,'slug',site.id)===parts[1]&&truth(get(site,'published')));check(sites.length,'게시된 사이트가 없습니다',404);const site=sites[0],page=service.item('page',site.page_id);check(!truth(get(page,'archived')),'삭제된 페이지입니다',404);
    title=get(site,'seo_title')||page.title;content='<h1>'+escapeHTML(page.title)+'</h1>'+blocks_html(get(page,'blocks',[]));description=get(site,'description','');service.store.audit('site.viewed',{page_id:page.id,site_id:site.id},service.actor);
  }else{
    const form=service.item('forms',parts[1]);check(truth(get(form,'published')),'게시된 양식이 없습니다',404);title=form.name;description=get(form,'description','');content='<h1>'+escapeHTML(title)+'</h1><p>'+escapeHTML(description)+'</p><form id="public-form" data-form-id="'+escapeHTML(form.id)+'">';
    for(const field of form.fields){let attrs=' name="'+escapeHTML(field.id)+'" data-type="'+escapeHTML(get(field,'type','text'))+'"';content+=truth(get(field,'condition'))?'<label data-condition="'+escapeHTML(pythonJSON(field.condition,true))+'">':'<label>';content+=escapeHTML(get(field,'label',field.id))+(truth(get(field,'required'))?' *':'');if(truth(get(field,'required')))attrs+=' required';if(field.type==='select')content+='<select'+attrs+'><option value="">선택</option>'+get(field,'options',[]).map((value:any)=>'<option>'+escapeHTML(typeof value==='string'?value:value===true?'True':value===false?'False':value===null?'None':String(value))+'</option>').join('')+'</select>';else content+='<input type="'+escapeHTML(get(field,'type','text'))+'"'+attrs+'>';content+='</label>';}
    content+='<button type="submit">제출</button><p role="status" id="form-status"></p></form><script src="/transport.js" defer></script><script src="/public.js" defer></script>';
  }
  const document='<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+escapeHTML(title)+'</title><meta name="description" content="'+escapeHTML(description)+'"><style>[hidden]{display:none!important}body{font:16px/1.8 system-ui;color:#37352f;max-width:760px;margin:10vh auto;padding:24px}label{display:block;margin:20px 0}input,select{display:block;padding:10px;font:inherit;width:100%;box-sizing:border-box;border:1px solid #ddd;border-radius:6px}input[type=checkbox]{width:auto}button{padding:10px 30px;background:#2383e2;border:0;color:white;border-radius:6px;font:inherit}pre{white-space:pre-wrap;background:#f5f5f4;padding:20px}blockquote{border-left:3px solid;padding-left:20px}</style><main>'+content+'</main></html>';
  return {status:200,payload:{_html:document}};
}
