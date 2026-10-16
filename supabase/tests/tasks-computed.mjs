/** Integral float metadata survives pure formulas/rollups without entering JSON. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {WorkspaceCore} from '../functions/_shared/core.ts';
import {formula_tree,evaluate_formula} from '../functions/_shared/tasks.ts';

const python=process.env.FOUNTAIN_PYTHON||'/Users/hooni.dev/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';
const formula=(id,expression,name=id)=>({id,name,type:'formula',expression}),rollup=(id,aggregation,target_property)=>({id,name:id,type:'rollup',relation_property:'rel',target_property,aggregation});
const db={id:'calc',properties:[formula('a','1/1'),formula('b',"concat('a=',a)"),formula('c','coalesce(a,5)','Returned amount'),formula('d',"concat('c=',prop('Returned amount'))"),formula('e','a*2'),formula('f','concat(e)'),formula('g','1.0'),formula('h','concat(g)')]};
const target={id:'targets',properties:[{id:'n',name:'n',type:'number'},formula('ratio','n/3'),formula('hybrid','n or 1.0'),formula('negzero','-0.0')]};
const related={id:'rollups',properties:[{id:'rel',name:'rel',type:'relation',database_id:'targets'},rollup('total','sum','ratio'),rollup('average','average','n'),rollup('minimum','min','ratio'),rollup('maximum','max','ratio'),rollup('mixed','min','hybrid'),rollup('zero','min','negzero'),...['total','average','minimum','maximum','mixed','zero'].map(id=>formula('label_'+id,`concat('${id}=',${id})`))]};
const targets=[{id:'one',database_id:'targets',properties:{n:1}},{id:'zero',database_id:'targets',properties:{n:0}},{id:'three',database_id:'targets',properties:{n:3}}];
const cases=[{database:db,rows:[{id:'r',database_id:db.id,properties:{}}],databases:[db],targets:[]},...[[['three'],'average=3.0'],[['one','zero'],'mixed=1'],[['zero','one'],'mixed=1.0'],[[],'total=0']].map(([ids,expectedLabel])=>({database:related,rows:[{id:'r',database_id:related.id,properties:{rel:ids}}],databases:[related,target],targets,expectedLabel}))];
let checks=0;
for(const test of cases){const entities={database:test.databases,row:[...test.targets,...test.rows]},before=structuredClone(entities),store={get:(kind,id)=>structuredClone(entities[kind]?.find(row=>row.id===id)??null),list:kind=>structuredClone(entities[kind]??[]),meta:()=>null};const core=new WorkspaceCore(store);const actual=core.computed_rows(test.database,structuredClone(test.rows));const fixture={records:entities,operations:[{method:'computed_rows',args:[test.database,test.rows]}]};const oracle=spawnSync(python,[fileURLToPath(new URL('./core-oracle.py',import.meta.url))],{input:JSON.stringify(fixture),encoding:'utf8',maxBuffer:2*1024*1024});assert.equal(oracle.status,0,oracle.stderr);const expected=JSON.parse(oracle.stdout).results[0].ok;assert.deepEqual(actual,expected);assert.deepEqual(entities,before,'computed values must not persist or mutate canonical source');if(test.expectedLabel)assert.ok(Object.values(actual[0].properties).includes(test.expectedLabel));checks+=test.database.properties.length;}
let kind;assert.equal(evaluate_formula(formula_tree('n+1'),()=>1,{numberKind:()=> 'float',onResult:value=>kind=value}),2);assert.equal(kind,'float');assert.equal(evaluate_formula(formula_tree('n+1'),()=>1),2);
console.log('PASS cross-formula/rollup Python dtype oracle:',checks,'computed fields; JSON primitives/source data unchanged');
