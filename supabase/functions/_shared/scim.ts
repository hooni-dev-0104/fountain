/** Pure SCIM representation/staging. A separate trusted bearer HTTP boundary is
 * required; this module never manufactures a cloud service/owner identity. */
import {clone,get,is_object,truth} from './access.ts';
import type {Entity} from './access.ts';
import {advancedRequire as check,AdvancedError} from './advanced.ts';
import type {Advanced} from './advanced.ts';
import type {DomainResult} from './domain.ts';
export function scim_resource(service:Advanced,method:string,path:string,input:Entity,query:URLSearchParams|Entity):DomainResult{
  const resource=path.split('/').slice(3),schemas:Entity={Users:'urn:ietf:params:scim:schemas:core:2.0:User',Groups:'urn:ietf:params:scim:schemas:core:2.0:Group'},response=(payload:any,status=200)=>({status,payload});let body=clone(input);
  if(resource.length===1&&resource[0]==='ServiceProviderConfig')return response({schemas:['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],patch:{supported:true},filter:{supported:false},bulk:{supported:false}});
  check(resource.length&&resource.length<=2&&Object.hasOwn(schemas,resource[0]),'SCIM 리소스를 찾을 수 없습니다',404);const category=resource[0],kind=category==='Users'?'members':'groups',identity=resource.length>1?resource[1]:null;
  const represent=(item:Entity):Entity=>{const base={schemas:[schemas[category]],id:item.id,meta:{resourceType:category.slice(0,-1)}};return category==='Users'?{...base,userName:item.email,displayName:get(item,'name',''),active:get(item,'active',true)}:{...base,displayName:item.name,members:get(item,'members',[]).map((member:string)=>({value:member}))};};
  const option=(key:string,fallback:string)=>query instanceof URLSearchParams?query.get(key)??fallback:get(query,key,[fallback])[0];
  if(method==='GET'){
    if(truth(identity))return response(represent(service.item(kind,identity)));check(!(query instanceof URLSearchParams?query.has('filter'):truth(get(query,'filter'))),'SCIM 필터는 지원하지 않습니다');const items=service.store.list(kind.slice(0,-1));let start:number,count:number;
    try{const first=option('startIndex','1'),size=option('count','100');if(!/^[+-]?\d+$/.test(first.trim())||!/^[+-]?\d+$/.test(size.trim()))throw Error();start=Math.max(1,Number(first));count=Math.max(0,Math.min(1000,Number(size)));if(!Number.isSafeInteger(start)||!Number.isSafeInteger(count))throw Error();}catch{throw new AdvancedError('페이지 범위가 올바르지 않습니다');}
    const selected=items.slice(start-1,start-1+count);return response({schemas:['urn:ietf:params:scim:api:messages:2.0:ListResponse'],totalResults:items.length,startIndex:start,itemsPerPage:selected.length,Resources:selected.map(represent)});
  }
  if(method==='DELETE'&&truth(identity)){service.item(kind,identity);service.store.delete(kind.slice(0,-1),identity);service.store.audit('scim.deleted',{kind,id:identity},service.actor);return response(null,204);}
  check(['POST','PUT','PATCH'].includes(method),'지원하지 않는 SCIM 메서드입니다',405);check((method==='POST')===(identity===null),'SCIM 주소가 올바르지 않습니다');
  const members=(value:any)=>Array.isArray(value)&&value.every(item=>is_object(item)&&typeof item.value==='string');
  const mergeMembers=(current:Entity,incoming:Entity[])=>{const existing=new Map<string,Entity>(get(current,'members',[]).map((item:Entity)=>[item.value,item]));for(const item of incoming)existing.set(item.value,item);return [...existing.values()];};
  if(method==='PATCH'){
    const current=represent(service.item(kind,identity)),operations=get(body,'Operations');check(Array.isArray(operations)&&operations.length&&operations.every(is_object),'SCIM 작업 목록이 필요합니다');
    for(const op of operations){const operation=typeof op.op==='string'?op.op.toLowerCase():'';check(['replace','add'].includes(operation),'지원하지 않는 SCIM 작업입니다');if(truth(get(op,'path'))){check((category==='Users'?['active','displayName','userName']:['displayName','members']).includes(op.path),'지원하지 않는 SCIM 경로입니다');if(op.path==='members'&&operation==='add'){const incoming=get(op,'value');check(Array.isArray(incoming),'멤버 목록이 필요합니다');check(members(incoming),'멤버 ID가 필요합니다');current.members=mergeMembers(current,incoming);}else Object.defineProperty(current,op.path,{value:get(op,'value'),writable:true,enumerable:true,configurable:true});}
      else{check(is_object(op.value),'SCIM 값 객체가 필요합니다');const incoming=clone(op.value);if(operation==='add'&&Object.hasOwn(incoming,'members')){check(members(incoming.members),'멤버 ID가 필요합니다');incoming.members=mergeMembers(current,incoming.members);}for(const [key,value] of Object.entries(incoming))Object.defineProperty(current,key,{value,writable:true,enumerable:true,configurable:true});}}
    body=current;
  }
  let data:Entity;if(category==='Users'){check(typeof get(body,'active',true)==='boolean','active 값이 올바르지 않습니다');data={email:get(body,'userName',''),name:get(body,'displayName',''),active:get(body,'active',true)};}else{const input=get(body,'members',[]);check(members(input),'멤버 목록이 필요합니다');data={name:get(body,'displayName',''),members:input.map((item:Entity)=>item.value)};}
  return response(represent(service.save(kind,data,identity)),method==='POST'?201:200);
}
