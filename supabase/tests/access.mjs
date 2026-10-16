/** Pure Deno/Node permission-port parity. No server, credentials, SQL, or network.
 * The actual Python classes produce expected DTOs in memory on every run.
 * FOUNTAIN_PYTHON selects the local compatibility-oracle interpreter.
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Access, casefold, get, has, is_object} from '../functions/_shared/access.ts';
import {Authorization} from '../functions/_shared/authorization.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const hash = text => createHash('sha256').update(text).digest('hex');
const sources = ['fountain/access.py', 'fountain/authorization.py'];
const sourceHashes = Object.fromEntries(sources.map(path => [path, hash(readFileSync(new URL('../../' + path, import.meta.url)))]));
const privateACL = {default: 'private'}, acl = (members = {}, groups = {}, inherit = false) => ({default: 'private', members, groups, inherit});
const members = [
  {id: 'local', role: 'owner', active: true}, {id: 'admin', role: 'admin', active: true},
  {id: 'alice', role: 'member', active: true, email: 'StraßeΣ@가족.test'},
  {id: 'bob', role: 'member', active: true}, {id: 'guest', role: 'guest', active: true},
  {id: '__proto__', role: 'member', active: true}, {id: 'constructor', role: 'member', active: true},
  {id: 'inactive', role: 'owner', active: false}, {id: 'integer-active', role: 'owner', active: 1},
  {id: 'invalid-role', role: 'root', active: true}
].map(member => ({name: '같은 이름', password_hash: 'PRIVATE-CREDENTIAL', ...member}));
const group = (id, who) => ({kind: 'group', record: {id, members: who}});
const page = (id, fields = {}) => ({kind: 'page', record: {id, title: '한글 😀', blocks: [], ...fields}});
const db = (id, fields = {}) => ({kind: 'database', record: {id, properties: [{id: 'who', type: 'person'}, {id: 'related', type: 'relation'}, {id: 'files', type: 'files'}, {id: '__proto__', type: 'text'}], ...fields}});
const row = (id, fields = {}) => ({kind: 'row', record: {id, database_id: 'db', properties: {who: 'alice'}, parent_row_id: null, depends_on: [], ...fields}});
const entities = [
  ...members.map(record => ({kind: 'member', record})), group('family', ['alice']), group('friends', ['alice', 'guest']), group('__proto__', ['__proto__']), group('constructor', ['constructor']),
  {kind: 'teamspace', record: {id: 'general', visibility: 'open'}},
  {kind: 'teamspace', record: {id: 'secret', visibility: 'private', members: ['bob'], groups: ['family']}},
  {kind: 'teamspace', record: {id: 'bad-team', visibility: 'open', members: {}, groups: []}},
  page('open', {teamspace_id: 'general'}), page('private', {owner_id: 'bob', permissions: privateACL}),
  page('shared', {owner_id: 'bob', permissions: acl({alice: 'edit', guest: 'comment'})}),
  page('full', {owner_id: 'bob', permissions: acl({alice: 'full', guest: 'full'})}),
  page('view', {owner_id: 'bob', permissions: acl({alice: 'view', guest: 'view'})}),
  page('child', {parent_id: 'shared'}), page('orphan', {parent_id: 'missing'}),
  page('cycle-a', {parent_id: 'cycle-b'}), page('cycle-b', {parent_id: 'cycle-a'}),
  page('closed', {teamspace_id: 'secret'}), page('bad-team-page', {teamspace_id: 'bad-team'}),
  page('group-grant', {permissions: acl({}, {family: 'none', friends: 'edit'})}),
  page('member-deny', {permissions: acl({alice: 'none'}, {family: 'full'})}),
  page('__proto__', {permissions: acl(JSON.parse('{"__proto__":"edit","constructor":"view"}'))}),
  page('가족 문서?#%', {permissions: acl({alice: 'full'})}),
  ...Array.from({length: 66}, (_, index) => page('deep-' + index, {parent_id: index < 65 ? 'deep-' + (index + 1) : null})),
  db('db', {row_permissions: {mode: 'assigned', property_id: 'who', edit_assigned: true, allow_create: true}}),
  db('private-db', {permissions: privateACL}), db('managed-db', {permissions: acl({alice: 'full'})}),
  db('all-db'), db('view-db', {permissions: acl({alice: 'view'})}),
  row('visible', {parent_row_id: 'hidden', depends_on: ['hidden'], properties: JSON.parse('{"who":"STRASSEς@가족.test","related":["hidden","visible","missing",3],"files":["row-file"],"__proto__":"reserved value","unknown":"hidden schema field"}')}),
  row('visible-2', {properties: {who: ['alice', 'bob']}}), row('hidden', {properties: {who: 'bob'}}),
  row('row-private', {permissions: privateACL}), row('row-owned-but-hidden', {owner_id: 'alice', properties: {who: 'bob'}}),
  row('cross', {database_id: 'all-db'}), row('managed-row', {database_id: 'managed-db'}),
  {kind: 'attachment', record: {id: 'owned-file', owner_id: 'alice', data: 'PRIVATE-BYTES'}},
  {kind: 'attachment', record: {id: 'row-file', owner_id: 'bob', data: 'PRIVATE-BYTES'}},
  {kind: 'attachment', record: {id: 'history-file', owner_id: 'bob'}},
  {kind: 'attachment', record: {id: 'private-file', owner_id: 'bob'}},
  {kind: 'version', record: {id: 'v', page_id: 'shared', blocks: [{id: 'b', attachment_id: 'history-file'}]}},
  {kind: 'comment', record: {id: 'own-comment', page_id: 'shared', author: 'alice'}},
  {kind: 'comment', record: {id: 'foreign-comment', page_id: 'shared', author: 'bob'}},
  {kind: 'clipboard', record: {id: 'clip', owner_id: 'alice'}},
  {kind: 'form', record: {id: 'form', database_id: 'managed-db', published: true, owner_id: 'alice'}},
  {kind: 'form', record: {id: 'unpublished', database_id: 'private-db', published: false}},
  {kind: 'site', record: {id: 'site', page_id: 'full', owner_id: 'alice'}},
  {kind: 'automation', record: {id: 'automation', database_id: 'managed-db', owner_id: 'alice'}}
];
const baseline = {entities, meta: {auth_accounts_required: true}};
const byKind = kind => entities.filter(entity => entity.kind === kind).map(entity => entity.record);
const find = (kind, id) => byKind(kind).find(record => record.id === id);
const cases = [];
const add = (name, method, args, principal = 'alice', overrides = {}) => cases.push({name, method, args, principal: typeof principal === 'string' ? find('member', principal) : principal, ...overrides});
for (const member of members) {
  add('state:' + member.id, 'state', [], member);
  for (const entity of entities.filter(entity => ['page', 'database', 'row', 'teamspace'].includes(entity.kind))) add(`level:${member.id}:${entity.kind}:${entity.record.id}`, 'level', [entity.kind, entity.record], member);
}
for (const principal of [null, {}, {id: 'x'}, {id: '', role: 'owner'}, {id: 'x', role: 'owner', active: 'true'}]) add('bad principal:' + JSON.stringify(principal), 'state', [], principal);
for (const value of [null, false, true, 0, 1, '', 'private', [], {}, {default: false}, {default: []}, {inherit: 1}, {inherit: null}, {members: []}, {groups: null}, {members: {alice: 'root'}}, {groups: {family: true}}, {default: 'private', members: {alice: 'view'}}, {default: 'workspace', inherit: false}]) {
  add('invalid persisted ACL:' + JSON.stringify(value), 'level', ['page', {id: 'test', permissions: value}]);
  add('permission input:' + JSON.stringify(value), 'validate_permissions', [value]);
}
for (const value of [null, false, [], {}, {mode: true}, {mode: 'assigned'}, {mode: 'assigned', property_id: []}, {allow_create: 1}, {edit_assigned: 1}, {mode: 'assigned', property_id: 'who', allow_create: true}]) {
  const database = {...find('database', 'db'), row_permissions: value};
  add('persisted row policy:' + JSON.stringify(value), 'can_create_row', [database]);
  add('row policy level:' + JSON.stringify(value), 'level', ['row', find('row', 'visible')], 'alice', {replace: [{kind: 'database', record: database}]});
}
for (const principal of ['local', 'admin', 'alice', 'guest', 'inactive']) for (const ownerOnly of [false, true]) add(`admin:${principal}:${ownerOnly}`, 'require_admin', [ownerOnly], principal);
for (const id of ['open', 'view', 'private', 'missing', '가족 문서?#%', '__proto__', '', null, 1, '😀'.repeat(160), '😀'.repeat(161)]) for (const needed of [1, 3, 4]) add(`require:${id}:${needed}`, 'require_resource', ['page', id, needed]);
for (const permissions of [acl({alice: 'full'}, {family: 'view'}), acl(JSON.parse('{"__proto__":"edit","constructor":"full"}')), {unknown: 1}, {members: {missing: 'view'}}, {members: {'invalid-role': 'view'}}]) add('validate ACL:' + JSON.stringify(permissions), 'validate_permissions', [permissions]);
const workspace = {pages: byKind('page'), databases: byKind('database'), teamspaces: byKind('teamspace'), members, groups: byKind('group'), settings: {workspace_name: '가족'}};
const database = {database: find('database', 'db'), rows: byKind('row').filter(row => row.database_id === 'db')};
const advanced = {teamspaces: byKind('teamspace'), members, groups: byKind('group'), sites: byKind('site'), forms: byKind('form'), automations: byKind('automation'), audit: [{secret: 1}], integrations: [{token: 'PRIVATE'}]};
for (const principal of ['local', 'admin', 'alice', 'guest', '__proto__']) {
  add('workspace filter:' + principal, 'filter_workspace', [workspace], principal);
  add('workspace projection:' + principal, 'project', ['/api/workspace', workspace], principal);
  add('DB projection:' + principal, 'project', ['/api/databases/db', database], principal);
  add('advanced projection:' + principal, 'project', ['/api/advanced', advanced], principal);
  add('row hidden projection:' + principal, 'project', ['/api/databases/db/rows/hidden', find('row', 'hidden')], principal);
  add('row mixed projection:' + principal, 'project', ['/api/databases/db/rows/x', {rows: [find('row', 'visible'), find('row', 'hidden')]}], principal);
  add('form private result:' + principal, 'project', ['/api/forms/form/submit', {row: find('row', 'hidden'), submission: {id: 's', private: 'NOT-PUBLIC'}}], principal);
  add('page history projection:' + principal, 'project', ['/api/pages/view', {page: find('page', 'view'), versions: [{text: 'OLD-PRIVATE'}]}], principal);
  add('search projection:' + principal, 'project', ['/api/search', {results: byKind('page'), pages: byKind('page')}], principal);
  for (const collection of ['sites', 'forms', 'automations']) add(`list projection:${principal}:${collection}`, 'project', ['/api/' + collection, {[collection]: byKind(collection.slice(0, -1))}], principal);
  for (const id of ['owned-file', 'row-file', 'history-file', 'private-file', 'missing']) for (const edit of [false, true]) add(`attachment:${principal}:${id}:${edit}`, 'attachment', [id, edit], principal);
}
const prepares = [
  ['GET','/api/health',{}], ['GET','/api/workspace',{}], ['GET','/api/accounts',{}], ['POST','/api/accounts/enable',{}],
  ...['settings','retention/run','audit','analytics','backup','export','import'].map(path => ['POST', '/api/' + path, {}]),
  ['POST','/api/ai',{page_id:'shared'}], ['POST','/api/ai',{page_id:'private'}],
  ['POST','/api/clipboard',{owner_id:'forged'}], ['GET','/api/clipboard/clip',{}],
  ['POST','/api/pages',{title:'새 문서',owner_id:'forged'}], ['POST','/api/pages',{parent_id:'shared',teamspace_id:'secret'}],
  ['POST','/api/pages',{parent_id:null}], ['POST','/api/pages',{parent_id:1}], ['POST','/api/pages',{blocks:[{attachment_id:'private-file'}]}],
  ['POST','/api/pages',{permissions:acl({alice:'edit'})}],
  ...['GET','PUT','DELETE','POST'].map(method => [method,'/api/pages/view/presence',{}]),
  ['PATCH','/api/pages/shared',{owner_id:'forged', title:'안녕'}], ['PATCH','/api/pages/shared',{permissions:{default:'workspace'}}],
  ['PATCH','/api/pages/shared',{archived:false}], ['PATCH','/api/pages/full',{parent_id:null,owner_id:'forged'}],
  ['PATCH','/api/pages/full',{parent_id:'private'}], ['PATCH','/api/pages/full',{parent_id:[]}],
  ['POST','/api/pages/view/comments',{author:'forged'}], ['POST','/api/pages/shared/comments',{author:'forged'}],
  ['POST','/api/pages/shared/operations',{ops:[{type:'block.set',field:'attachment_id',value:'private-file'}]}],
  ['POST','/api/pages/shared/restore',{}], ['POST','/api/pages/full/versions/v/restore',{}], ['DELETE','/api/pages/shared',{}],
  ['PATCH','/api/comments/own-comment',{resolved:true}], ['PATCH','/api/comments/foreign-comment',{}],
  ['POST','/api/databases',{owner_id:'forged'}], ['POST','/api/databases',{permissions:acl({alice:'view'})}],
  ['PATCH','/api/databases/db',{name:'x',owner_id:'forged'}], ['PATCH','/api/databases/managed-db',{owner_id:'forged'}],
  ['PATCH','/api/databases/managed-db',{row_permissions:{mode:'all'}}], ['PATCH','/api/databases/db/permissions',{}],
  // One failing reference per vector: Python intentionally iterates a set of
  // relation/file keys, so two simultaneous denials have no stable first message.
  ['POST','/api/databases/db/rows',{owner_id:'forged',properties:{related:['visible-2']}}],
  ['POST','/api/databases/db/rows',{owner_id:'forged',properties:{files:['row-file']}}],
  ['PATCH','/api/databases/db/rows/visible',{parent_row_id:null,depends_on:[],properties:{related:[]},owner_id:'forged'}],
  ['PATCH','/api/databases/db/rows/visible',{values:{related:null}}],
  ['PATCH','/api/databases/db/rows/visible',{properties:{related:['hidden']}}],
  ['PATCH','/api/databases/db/rows/visible',{properties:{files:['private-file']}}],
  ['PATCH','/api/databases/db/rows/visible',{depends_on:['cross']}], ['PATCH','/api/databases/db/rows/visible',{depends_on:null}],
  ['PATCH','/api/databases/db/rows/visible',{parent_row_id:'cross'}], ['PATCH','/api/databases/db/rows/cross',{}],
  ['POST','/api/databases/db/rows/visible/duplicate',{}], ['DELETE','/api/databases/db/rows/hidden',{}],
  ['POST','/api/attachments',{owner_id:'forged'}], ['GET','/api/uploads/upload',{}], ['POST','/api/uploads/cleanup',{}],
  ['GET','/api/attachments/history-file/metadata',{}], ['DELETE','/api/attachments/row-file',{}],
  ['GET','/api/members',{}], ['PATCH','/api/members/local',{active:false}], ['POST','/api/members',{role:'owner'}],
  ['DELETE','/api/members/alice',{}], ['DELETE','/api/groups/family',{}],
  ['POST','/api/teamspaces',{owner_id:'forged',members:['bob','alice']}], ['POST','/api/teamspaces',{members:null}],
  ['GET','/api/teamspaces/secret',{}], ['PATCH','/api/teamspaces/general',{owner_id:'forged'}],
  ['GET','/api/forms',{}], ['GET','/api/forms/form',{}], ['POST','/api/forms/form/submit',{answer:'text'}],
  ['POST','/api/forms/unpublished/submit',{}], ['PATCH','/api/forms/form',{database_id:'private-db'}],
  ['POST','/api/forms',{database_id:'managed-db',owner_id:'forged'}], ['GET','/api/sites/site',{}], ['PATCH','/api/sites/site',{page_id:'private'}],
  ['POST','/api/automations/automation/run',{}], ['GET','/api/integrations',{}],
  ['GET','/forms/form',{}], ['GET','/sites/site',{}], ['GET','/api/nonexistent',{}],
  ['PATCH','/scim/v2/Users/local',{Operations:[{op:'replace',path:'active',value:false}]}],
  ['PATCH','/scim/v2/Users/local',{Operations:[{op:'replace',value:{active:false}}]}], ['GET','/scim/v2/Groups',{}]
];
for (const principal of ['local','admin','alice','guest','inactive']) for (const [method,path,body] of prepares) add(`prepare:${principal}:${method}:${path}:${JSON.stringify(body)}`, 'prepare', [method,path,body], principal);
for (const principal of ['alice','guest','local']) for (const result of [null, [], {page:find('page','shared'),versions:[{id:'v'}]}, find('page','shared'), {pages:[find('page','shared')],databases:['created-db-id']}, {teamspaces:byKind('teamspace')}]) add('projection variants:' + principal + JSON.stringify(result), 'project', ['/api/pages/shared',result],principal);
add('last owner no credential', 'member_change', ['DELETE','local',{}], 'local');
add('second owner credential allows removal', 'member_change', ['DELETE','local',{}], 'local', {append:[{kind:'member',record:{id:'owner2',role:'owner'}},{kind:'credential',record:{id:'owner2',salt:'x'}}]});
add('invalid inactive owner bool cannot preserve owner', 'member_change', ['DELETE','local',{}], 'local', {append:[{kind:'member',record:{id:'owner2',role:'owner',active:1}},{kind:'credential',record:{id:'owner2'}}]});
add('guest hides secret parent/teamspace', 'project', ['/api/workspace',{...workspace,pages:[{id:'guest-page',parent_id:'private',teamspace_id:'secret',permissions:acl({guest:'view'})}]}], 'guest');
add('direct hidden relation merge', 'relation_values', [find('database','db'),{properties:{related:[]}},find('row','visible')]);
add('database manager', 'manage_database', ['managed-db']);
add('visible spaces', 'visible_teamspaces', []);

class MemoryStore {
  constructor(test) {
    this.entities = structuredClone(baseline.entities);
    for (const replacement of test.replace || []) this.entities = this.entities.filter(e => !(e.kind === replacement.kind && e.record.id === replacement.record.id)).concat(structuredClone(replacement));
    this.entities.push(...structuredClone(test.append || []));
    this.metadata = {...baseline.meta,...test.meta};
  }
  get(kind,id) { return structuredClone(this.entities.find(entity => entity.kind === kind && entity.record.id === id)?.record || null); }
  list(kind) { return structuredClone(this.entities.filter(entity => entity.kind === kind).map(entity => entity.record)); }
  meta(key,fallback = null) { return has(this.metadata,key) ? this.metadata[key] : fallback; }
}
function execute(test) {
  const store = new MemoryStore(test), access = new Access(store, structuredClone(test.principal)), authorization = new Authorization(access), args = JSON.parse(JSON.stringify(test.args));
  const before = JSON.stringify(store.entities), originalArgs = JSON.stringify(args);
  let result;
  try {
    let value;
    if (test.method === 'state') value = {active:access.active,owner:access.owner,regular:access.regular,member_id:access.member_id,groups:Array.from(access.groups).sort()};
    else if (['owned','manage_database','relation_values','member_change','attachment','prepare','project'].includes(test.method)) value = authorization[test.method](...args);
    else value = access[test.method](...args);
    result = {value:value === undefined ? null : value};
  } catch (error) {
    if (!Number.isInteger(error.status)) throw new Error(test.name + ': unexpected ' + error.stack);
    result = {error:{status:error.status,message:error.message}};
  }
  if (test.method === 'prepare') result.body = args[2];
  if (test.method === 'relation_values') result.body = args[1];
  assert.equal(JSON.stringify(store.entities),before,test.name + ': mutated store');
  if (['project','filter_workspace','filter_database'].includes(test.method)) assert.equal(JSON.stringify(args),originalArgs,test.name + ': mutated input');
  return result;
}
const oracle = String.raw`
import sys,json,copy,unicodedata
from fountain.access import Access
from fountain.authorization import Authorization
from fountain.core import APIError
payload=json.load(sys.stdin)
class Store:
 def __init__(self,test):
  self.entities=copy.deepcopy(payload['baseline']['entities'])
  for replacement in test.get('replace',[]): self.entities=[e for e in self.entities if (e['kind'],e['record']['id'])!=(replacement['kind'],replacement['record']['id'])]+[copy.deepcopy(replacement)]
  self.entities+=copy.deepcopy(test.get('append',[]))
  self.metadata=dict(payload['baseline']['meta'],**test.get('meta',{}))
 def get(self,kind,identity): return copy.deepcopy(next((e['record'] for e in self.entities if e['kind']==kind and e['record']['id']==identity),None))
 def list(self,kind): return copy.deepcopy([e['record'] for e in self.entities if e['kind']==kind])
 def meta(self,key,fallback=None): return self.metadata.get(key,fallback)
results=[]
for test in payload['cases']:
 store=Store(test); a=Access(store,copy.deepcopy(test['principal'])); authority=Authorization(a); args=copy.deepcopy(test['args'])
 try:
  if test['method']=='state': value=dict(active=a.active,owner=a.owner,regular=a.regular,member_id=a.member_id,groups=sorted(a.groups))
  elif hasattr(authority,test['method']): value=getattr(authority,test['method'])(*args)
  else: value=getattr(a,test['method'])(*args)
  result={'value':value}
 except APIError as error: result={'error':dict(status=error.status,message=error.message)}
 except Exception as error: raise RuntimeError(test['name']) from error
 if test['method']=='prepare': result['body']=args[2]
 if test['method']=='relation_values': result['body']=args[1]
 results.append(result)
print(json.dumps(dict(results=results,unicode=unicodedata.unidata_version,casefold=[[chr(i),chr(i).casefold()] for i in range(0x110000) if chr(i).casefold()!=chr(i)]),ensure_ascii=False))
`;
const golden = (() => {
  const python = process.env.FOUNTAIN_PYTHON || 'python3';
  const run = spawnSync(python,['-c',oracle],{cwd:root,input:JSON.stringify({baseline,cases}),encoding:'utf8',maxBuffer:64*1024*1024});
  assert.equal(run.status,0,run.stderr);
  const output=JSON.parse(run.stdout);
  assert(Number(output.unicode.split('.')[0])>=15,'Use Python 3.11+ through FOUNTAIN_PYTHON to verify the complete Unicode 15 casefold table');
  return {sourceHashes,baseline,cases,...output};
})();
assert.deepEqual(golden.sourceHashes,sourceHashes,'Python oracle source changed: inspect and refresh vectors explicitly');
assert.deepEqual(golden.baseline,baseline);
assert.deepEqual(golden.cases,cases);
for (const [index,test] of cases.entries()) assert.deepEqual(execute(test),golden.results[index],test.name);
for (const [input,expected] of golden.casefold) assert.equal(casefold(input),expected,'Unicode casefold: '+input.codePointAt(0));
// JS-only prototype hazards cannot appear as inherited properties in Python JSON.
const inherited = Object.create({id:'local',role:'owner',active:true});
assert.equal(new Access(new MemoryStore({}),inherited).active,false);
assert.equal(new Access(new MemoryStore({}),{id:'local',role:['owner']}).active,false);
const inheritedACL = Object.create({members:{alice:'full'},default:'private'});
assert.equal(new Access(new MemoryStore({}),find('member','alice')).level('page',{id:'p',permissions:inheritedACL}),3);
assert.equal(get(JSON.parse('{"__proto__":"data"}'),'__proto__'),'data');
assert.equal(is_object([]),false);
console.log(JSON.stringify({ok:true,oracle:'actual Python Access/Authorization',cases:cases.length,unicodeCasefoldMappings:golden.casefold.length,unicodeVersion:golden.unicode,storeAndProjectionInputsUnchanged:true}));
