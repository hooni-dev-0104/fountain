/** Read-only route audit. Parse Python AST without importing/running the server.
 * --refresh-evidence updates only the checked-in inventory after a deliberate audit.
 */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createBackend} from '../functions/_shared/backend.ts';

const root=fileURLToPath(new URL('../../',import.meta.url));
const location=new URL('./route-inventory.json',import.meta.url);
const inventory=JSON.parse(readFileSync(location,'utf8'));
const parser=String.raw`
import ast,hashlib,json,sys
from pathlib import Path
root=Path(sys.argv[1]); manifest=json.load(sys.stdin)
targets={
 'fountain/server.py':['Application.dispatch','Application._dispatch','handler_for.Handler.handle_request'],
 'fountain/advanced.py':['Advanced.dispatch'],
 'fountain/wiki.py':['Wiki.route'],
 'fountain/database_verification.py':['DatabaseVerification.route'],
 'fountain/scim.py':['scim_resource'],
 'fountain/publishing.py':['render_public'],
 'fountain/authorization.py':['Authorization.prepare','Authorization.project']}
functions={}; sources={}; source_texts={}; original_nodes=set(); terminal_cache={}
def collect(nodes,prefix,file):
 for node in nodes:
  if isinstance(node,(ast.ClassDef,ast.FunctionDef,ast.AsyncFunctionDef)):
   name='.'.join(prefix+[node.name]); key=file+':'+name
   if name in targets[file]: functions[key]=node
   collect(node.body,prefix+[node.name],file)
for file in targets:
 source_texts[file]=(root/file).read_text();tree=ast.parse(source_texts[file]);original_nodes.update(id(node) for node in ast.walk(tree));collect(tree.body,[],file)
if len(sys.argv)>2 and sys.argv[2]=='simulate-added-route':
 node=functions['fountain/server.py:Application._dispatch']
 node.body.insert(0,ast.parse("if path == '/api/__inventory_added__' and method == 'GET':\n return 200, {}\n").body[0])
 ast.fix_missing_locations(node)
if len(sys.argv)>2 and sys.argv[2]=='simulate-added-wiki-method':
 node=functions['fountain/wiki.py:Wiki.route']
 # Add PUT only to the wiki conversion method guard, without editing source.
 guard=node.body[0].body[0].value.args[0].comparators[0]
 guard.elts.append(ast.Constant(value='PUT'));ast.fix_missing_locations(node)
if len(sys.argv)>2 and sys.argv[2]=='simulate-added-database-verification-method':
 node=functions['fountain/database_verification.py:DatabaseVerification.route']
 guard=next(item for item in ast.walk(node) if isinstance(item,ast.Compare)
  and isinstance(item.left,ast.Name) and item.left.id=='method' and isinstance(item.ops[0],ast.In))
 guard.comparators[0].elts.append(ast.Constant(value='PUT'));ast.fix_missing_locations(node)
def stable_ast(node):
 if isinstance(node,ast.AST):
  # Python 3.12 adds empty type_params to function/class AST nodes. Ignore only
  # that absent semantic difference; nonempty type parameters still change proof.
  return [type(node).__name__,[[key,stable_ast(value)] for key,value in ast.iter_fields(node) if not(key=='type_params' and value==[])]]
 if isinstance(node,list):return [stable_ast(value) for value in node]
 return node
for key,node in functions.items():
 sources[key]=hashlib.sha256(json.dumps(stable_ast(node),ensure_ascii=True,separators=(',',':')).encode()).hexdigest()
collections=None
for node in ast.walk(ast.parse((root/'fountain/advanced.py').read_text())):
 if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='collections' for t in node.targets):collections=sorted(ast.literal_eval(node.value))
safe_names={'path','method','parts','resource','category','kind','identity','schemas','self','len'}
route_names={'path','method','parts','resource','category','kind','identity','schemas'}
def evaluate(node,env):
 for item in ast.walk(node):
  if isinstance(item,ast.Name) and item.id not in safe_names:raise ValueError()
  if isinstance(item,ast.Attribute):
   if isinstance(item.value,ast.Name) and item.value.id=='self':
    if item.attr not in {'command','collections'}:raise ValueError()
   elif item.attr not in {'strip','split','rsplit','startswith'}:raise ValueError()
  if isinstance(item,ast.Call):
   if not (isinstance(item.func,ast.Name) and item.func.id=='len' or isinstance(item.func,ast.Attribute) and item.func.attr in {'strip','split','rsplit','startswith'}):raise ValueError()
  if isinstance(item,(ast.Lambda,ast.NamedExpr,ast.ListComp,ast.SetComp,ast.DictComp,ast.GeneratorExp)):raise ValueError()
 return eval(compile(ast.Expression(node),'<route-predicate>','eval'),{'__builtins__':{'len':len}},env)
def terminal(node,key):
 identity=(key,id(node))
 if identity in terminal_cache:return terminal_cache[identity]
 # Evidence quotes the real source, not ast.unparse's version-specific formatting.
 statement=ast.get_source_segment(source_texts[key.split(':',1)[0]],node) if id(node) in original_nodes else ast.unparse(node)
 result={'source':key,'line':node.lineno,'statement':statement};terminal_cache[identity]=result;return result
def walk(nodes,env,key):
 if not nodes:return [],[env]
 node,*tail=nodes
 if isinstance(node,ast.If):
  try:branches=[node.body if evaluate(node.test,env) else node.orelse]
  except (ValueError,KeyError,NameError,AttributeError,TypeError,IndexError):branches=[node.body,node.orelse]
  done=[];continuations=[];leftover=[]
  for branch in branches:
   result,remaining=walk(branch,dict(env),key);done+=result;continuations+=remaining
  for current in continuations:
   result,remaining=walk(tail,current,key);done+=result;leftover+=remaining
  return done,leftover
 if isinstance(node,(ast.With,ast.Try)):
  done,remaining=walk(node.body,dict(env),key);leftover=[]
  for current in remaining:
   result,continuations=walk(tail,current,key);done+=result;leftover+=continuations
  return done,leftover
 if isinstance(node,ast.Assign):
  try:
   value=evaluate(node.value,env)
   for target in node.targets:
    if isinstance(target,ast.Name) and target.id in route_names:env[target.id]=value
  except (ValueError,KeyError,NameError,AttributeError,TypeError,IndexError):pass
 if isinstance(node,ast.Expr) and isinstance(node.value,ast.Call):
  call=node.value
  if isinstance(call.func,ast.Name) and call.func.id=='require' and call.args:
   try:
    if not evaluate(call.args[0],env):return [],[]
   except (ValueError,KeyError,NameError,AttributeError,TypeError,IndexError):pass
  if key.endswith('handle_request') and isinstance(call.func,ast.Attribute) and call.func.attr in {'send_payload','send_bytes','send_download','stream_page'}:
   return [terminal(node,key)],[]
 if isinstance(node,ast.Return):
  if node.value is None or isinstance(node.value,ast.Constant) and node.value.value is None:return [],[]
  # Outer delegation branches accept every verb syntactically; dedicated
  # router require guards decide which methods really reach a response.
  if isinstance(node.value,ast.Tuple) and len(node.value.elts)==2:
   call=node.value.elts[1]
   if (isinstance(call,ast.Call) and isinstance(call.func,ast.Attribute) and call.func.attr=='route'
       and isinstance(call.func.value,ast.Call) and isinstance(call.func.value.func,ast.Name)
       and call.func.value.func.id in {'Wiki','DatabaseVerification'}):
    delegated=dict(env);router=call.func.value.func.id
    if router=='Wiki':delegated['kind']=evaluate(call.args[2],env)
    target={'Wiki':'fountain/wiki.py:Wiki.route','DatabaseVerification':'fountain/database_verification.py:DatabaseVerification.route'}[router]
    done,_=walk(functions[target].body,delegated,target)
    return ([terminal(node,key),*done] if done else []),[]
  return [terminal(node,key)],[]
 if isinstance(node,ast.Raise):return [],[]
 return walk(tail,env,key)
def probe(key,method,path):
 class Receiver:pass
 receiver=Receiver();receiver.command=method;receiver.collections=set(collections)
 # Handler maps HEAD to GET; other entry points receive the normalized method.
 actual=method if key.endswith('handle_request') else 'GET' if method=='HEAD' else method
 result,_=walk(functions[key].body,{'method':actual,'path':path,'self':receiver},key)
 unique={json.dumps(item,sort_keys=True):item for item in result}
 return sorted(unique.values(),key=lambda item:item['line'])
routes=[];matrix=[]
for route in manifest['routes']:
 path=route['probe']; layers=route['source']['functions']
 evidence=[]
 for key in layers:evidence+=probe(key,route['method'],path)
 routes.append({'id':route['id'],'evidence':evidence})
for key,path in sorted({(r['source']['functions'][0],r['probe']) for r in manifest['routes']}):
 for method in ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']:
  matrix.append({'source':key,'probe':path,'method':method,'evidence':probe(key,method,path)})
verification_path='/api/databases/sample-database/rows/sample-row/verification'
verification_aliases=[{'path':path,'method':method,'evidence':probe('fountain/server.py:Application._dispatch',method,path)}
 for path in [verification_path+'/',verification_path+'/extra'] for method in ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']]
def terminals(nodes,key):
 for node in nodes:
  if isinstance(node,(ast.FunctionDef,ast.ClassDef)):continue
  if isinstance(node,ast.Return) and node.value is not None and not(isinstance(node.value,ast.Constant) and node.value.value is None):yield terminal(node,key)
  if key.endswith('handle_request') and isinstance(node,ast.Expr) and isinstance(node.value,ast.Call) and isinstance(node.value.func,ast.Attribute) and node.value.func.attr in {'send_payload','send_bytes','send_download','stream_page'}:yield terminal(node,key)
  for field in ['body','orelse','finalbody']:yield from terminals(getattr(node,field,[]),key)
  for handler in getattr(node,'handlers',[]):yield from terminals(handler.body,key)
all_terminals=[]
for key,node in functions.items():
 if key.startswith('fountain/authorization.py:'):continue
 all_terminals.extend(terminals(node.body,key))
print(json.dumps({'sources':sources,'collections':collections,'routes':routes,'matrix':matrix,'verificationAliases':verification_aliases,'terminals':all_terminals},ensure_ascii=False))
`;
const result=spawnSync(process.env.FOUNTAIN_PYTHON||'python3',['-c',parser,root],{input:JSON.stringify(inventory),encoding:'utf8',maxBuffer:16*1024*1024});
assert.equal(result.status,0,result.stderr);
const parsed=JSON.parse(result.stdout);
const cloudSources=Object.fromEntries(['supabase/functions/_shared/backend.ts','supabase/functions/_shared/application.ts','supabase/functions/fountain-api/index.ts','supabase/functions/fountain-api/deployment.ts'].map(path=>[path,createHash('sha256').update(readFileSync(root+path)).digest('hex')]));
if(process.argv.includes('--refresh-evidence')){
 inventory.sourceFingerprints=parsed.sources;
 inventory.cloudEntryFingerprints=cloudSources;
 for(const route of inventory.routes)route.source.evidence=parsed.routes.find(value=>value.id===route.id).evidence;
 writeFileSync(location,JSON.stringify(inventory,null,2)+'\n');
}
assert.deepEqual(parsed.sources,inventory.sourceFingerprints,'Python routing changed: audit every method/path, then --refresh-evidence.');
assert.deepEqual(cloudSources,inventory.cloudEntryFingerprints,'Cloud entry changed: audit installed route coverage before refreshing the inventory.');
assert.deepEqual(parsed.collections,inventory.advancedCollections,'Advanced collections changed: inventory expansion required.');
const ids=new Set(),routes=new Set();
const site=entry=>entry.source+'\n'+entry.statement;
const nonRoutes=new Set(inventory.nonRouteTerminals.map(site));
const observed=new Set();
for(const route of inventory.routes){
 assert(!ids.has(route.id),'Duplicate route ID: '+route.id);ids.add(route.id);
 const key=route.method+' '+route.path;assert(!routes.has(key),'Duplicate method/path: '+key);routes.add(key);
 assert(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(route.method));
 assert(route.path.startsWith('/')&&route.probe.startsWith('/')&&route.handler&&route.domain&&route.module);
 assert(['public','session','local-only','scim-bearer','publication-and-session'].includes(route.auth));
 assert.equal(typeof route.public,'boolean');
 const fresh=parsed.routes.find(value=>value.id===route.id).evidence;
 assert(fresh.length>0,'No actual Python route branch recognizes '+key);
 assert.deepEqual(fresh,route.source.evidence,'Route evidence drift: '+key);
 for(const entry of fresh)if(!nonRoutes.has(site(entry)))observed.add(site(entry));
 assert(['pending','staged-contract','staged-auth','static-relay-required','not-applicable'].includes(route.cloud.status));
 assert.equal(route.cloud.productionParityVerified,false,'This foundation inventory must not claim completed domain/cloud parity.');
}
for(const entry of parsed.terminals)assert(observed.has(site(entry))||nonRoutes.has(site(entry)),'Uninventoried Python return/HTTP handler: '+entry.source+':'+entry.line+' '+entry.statement);
for(const entry of inventory.nonRouteTerminals)assert(parsed.terminals.some(value=>site(value)===site(entry))&&entry.reason,'Stale/unexplained non-route exemption');
// Prove the drift gate with an AST-only added route; never edit source files.
const changed=spawnSync(process.env.FOUNTAIN_PYTHON||'python3',['-c',parser,root,'simulate-added-route'],{input:JSON.stringify(inventory),encoding:'utf8',maxBuffer:16*1024*1024});
assert.equal(changed.status,0,changed.stderr);
const added=JSON.parse(changed.stdout);
assert.notDeepEqual(added.sources,inventory.sourceFingerprints,'AST parser failed to detect a newly added route.');
assert(added.terminals.some(entry=>!observed.has(site(entry))&&!nonRoutes.has(site(entry))),'New route terminal must require an inventory entry.');
const changedWiki=spawnSync(process.env.FOUNTAIN_PYTHON||'python3',['-c',parser,root,'simulate-added-wiki-method'],{input:JSON.stringify(inventory),encoding:'utf8',maxBuffer:16*1024*1024});
assert.equal(changedWiki.status,0,changedWiki.stderr);
const addedWiki=JSON.parse(changedWiki.stdout);
assert.notDeepEqual(addedWiki.sources,inventory.sourceFingerprints,'An added delegated wiki method must change its AST fingerprint.');
assert(addedWiki.matrix.some(row=>row.source==='fountain/server.py:Application._dispatch'&&row.probe==='/api/pages/sample-page/wiki'&&row.method==='PUT'&&row.evidence.length>0),'Method audit must follow the delegated wiki guard.');
assert(!parsed.matrix.some(row=>row.source==='fountain/server.py:Application._dispatch'&&row.probe==='/api/pages/sample-page/wiki'&&['PUT','PATCH','OPTIONS'].includes(row.method)&&row.evidence.length>0),'Unsupported wiki methods must not be counted as implemented routes.');
const verificationProbe='/api/databases/sample-database/rows/sample-row/verification',verificationRouter='fountain/database_verification.py:DatabaseVerification.route';
const changedVerification=spawnSync(process.env.FOUNTAIN_PYTHON||'python3',['-c',parser,root,'simulate-added-database-verification-method'],{input:JSON.stringify(inventory),encoding:'utf8',maxBuffer:16*1024*1024});
assert.equal(changedVerification.status,0,changedVerification.stderr);
const addedVerification=JSON.parse(changedVerification.stdout);
assert.notDeepEqual(addedVerification.sources,inventory.sourceFingerprints,'An added DB verification method must change its delegated AST fingerprint.');
assert(addedVerification.matrix.some(row=>row.source==='fountain/server.py:Application._dispatch'&&row.probe===verificationProbe&&row.method==='PUT'&&row.evidence.some(entry=>entry.source===verificationRouter)),'DB verification audit must follow the delegated method guard.');
for(const row of parsed.verificationAliases){
 const recognized=row.evidence.some(entry=>entry.source===verificationRouter);
 const expected=row.path===verificationProbe+'/'&&['GET','HEAD','POST','DELETE'].includes(row.method);
 assert.equal(recognized,expected,'DB verification slash/suffix method mismatch: '+row.method+' '+row.path);
}
function matches(route,path){
 if(route.kind==='static-pattern'&&inventory.staticExcludedPrefixes.some(prefix=>path.startsWith(prefix)))return false;
 const pattern=route.path.split('/').map(segment=>/^\{[^}]+\+\}$/.test(segment)?'.+':/^\{[^}]+\}$/.test(segment)?'[^/]+':segment.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('/');
 return new RegExp('^'+pattern+'$').test(path);
}
for(const row of parsed.matrix){
 const recognized=row.evidence.some(entry=>!nonRoutes.has(site(entry)));
 const declared=inventory.routes.some(route=>route.method===row.method&&route.source.functions[0]===row.source&&matches(route,row.probe));
 assert.equal(declared,recognized,'Missing/extra method in actual Python route family: '+row.method+' '+row.probe+' ('+row.source+')');
}
// The AST fingerprints make additions/changes fail even if their path has not yet
// been entered. These presence checks also prevent accidentally deleting a family.
for(const family of ['session','workspace','pages','wiki','inbox','databases','uploads','attachments','accounts','sync','ai','publishing','scim','advanced','static'])assert(inventory.routes.some(route=>route.domain===family),'Missing route family '+family);
for(const collection of parsed.collections)for(const [method,path] of [['GET','/api/'+collection],['POST','/api/'+collection],['GET','/api/'+collection+'/{id}'],['PATCH','/api/'+collection+'/{id}'],['DELETE','/api/'+collection+'/{id}']])assert(routes.has(method+' '+path),'Missing Advanced collection method '+method+' '+path);
// A real in-process Edge boundary invocation: staged health/auth plumbing must
// continue to refuse all domain paths rather than being counted as parity.
const candidate=createBackend({origins:[],auth:async()=>({session:async()=>({status:200,body:{authenticated:true}}),login:async()=>({status:200,body:{authenticated:true}}),logout:async()=>({status:200,body:{authenticated:false}})})});
let pendingChecks=0;
for(const route of inventory.routes.filter(route=>route.cloud.status==='pending'&&route.method!=='OPTIONS')){
 const response=await candidate(new Request('https://fixture.invalid/functions/v1/fountain-api'+route.probe,{method:route.method,headers:{'X-Fountain-Request':'1'}}));
 assert.equal(response.status,503,'Domain route unexpectedly became active: '+route.method+' '+route.path);
 if(route.method!=='HEAD')assert.equal((await response.json()).code,'BACKEND_MIGRATION_IN_PROGRESS');
 pendingChecks++;
}
const health=await candidate(new Request('https://fixture.invalid/functions/v1/fountain-api/health'));
assert.equal((await health.json()).ready,false);
assert(!inventory.routes.some(route=>route.path==='/health'),'New health surface is not legacy route coverage.');
console.log(JSON.stringify({ok:true,routes:inventory.routes.length,sourceFunctions:Object.keys(parsed.sources).length,methodMatrixChecks:parsed.matrix.length,delegatedWikiMethodChecks:2,delegatedDatabaseVerificationMethodChecks:2,databaseVerificationAliasChecks:parsed.verificationAliases.length,pendingBoundaryChecks:pendingChecks,cloudProductionParityVerified:0,parser:'Python AST including delegated wiki and DB verification method guards; server never imported; no database access'}));
