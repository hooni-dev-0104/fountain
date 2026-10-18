/** Real shared JS scope helper -> Java canonical tail; no network/Auth claim. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile,writeFile} from 'node:fs/promises';
const source=await readFile(new URL('../../../../static/workspace-scope.js',import.meta.url),'utf8');
const context=vm.createContext({URL});vm.runInContext(source,context);
const helper=context.FountainWorkspaceScope;
const scope={workspaceId:'workspace-A',memberId:'member-A',binding:'0123456789abcdef0123456789abcdef',accountBinding:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',expiresAt:Date.now()+3600000,workspaceEpoch:1};
const lines=[];
for(const id of ['가족 文書?','space id','tag#id','🏠',"safe!~*'()_-.",'literal%41','a%3Fb','question?#']){
 const logical='/api/pages/'+encodeURIComponent(id)+'/collaboration?cursor=literal%25&search=%3F%23';
 const wire=helper.wire(logical,scope);assert.equal(helper.logical(wire,scope),logical);
 lines.push(wire+'\t'+logical);
}
assert.ok(process.argv[2]);await writeFile(process.argv[2],lines.join('\n')+'\n',{flag:'wx'});
