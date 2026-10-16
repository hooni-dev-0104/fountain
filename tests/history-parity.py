"""Deterministic full-state Python/JS CRDT parity; run with Python and Node installed.

Independent expected behavior remains covered by test_history_crdt.py and
crdt-history.mjs. These vectors additionally compare the two implementations'
private state, public metadata, unknown slots, and exact-source hydration.
"""
import json
import os
from pathlib import Path
import random
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from fountain.crdt import seed_state,apply_operations,public_state,capture_public_hints,hydrate_public_state
rng=random.Random(7701)
vectors=[]
for case in range(80):
    initial=[{'id':'__proto__','text':'가🙂','rich_text':[{'text':'가🙂','marks':{'bold':True}}]}, {'id':'b','text':'xyz'},{'id':'p','text':''}]
    ops=[]; clocks={'a':0,'b':0};clientops={'a':[],'b':[]}
    for index in range(24):
        client=rng.choice(['a','b']); clocks[client]+=1; clock=clocks[client];id=f'{client}:{clock}'; bid=rng.choice(['__proto__','b','p','new'])
        kind=rng.choice(['block.set','block.move','block.insert','text.insert','text.delete','text.format','block.delete','history.cancel'])
        if kind=='history.cancel' and clientops[client]:
            op={'id':id,'client':client,'clock':clock,'type':kind,'targets':rng.sample(clientops[client],min(len(clientops[client]),rng.randint(1,3)))}
        else:
            if kind=='history.cancel':kind='block.set'
            op={'id':id,'client':client,'clock':clock,'type':kind,'block_id':bid,'group_id':rng.choice(['birth','later'])}
            if kind=='block.set':op.update(field='type',value=rng.choice(['quote','heading_1','paragraph']))
            if kind in ['block.move','block.insert']:op.update(parent_id=rng.choice(['p','new',None]),after_id=rng.choice(['b',None]))
            if kind=='block.insert':op['block_type']=rng.choice(['quote','heading1','paragraph'])
            if kind=='text.insert':op.update(text=rng.choice(['🚀한','secret','x']),after_id=rng.choice([None,'seed:b:0','a:1:0']),marks={'color':rng.choice(['red','blue'])})
            if kind in ['text.delete','text.format']:op['char_ids']=['seed:'+bid+':0']
            if kind=='text.format':op['marks']={'bold':rng.choice([True,False])}
        ops.append(op);clientops[client].append(id)
    rng.shuffle(ops)
    vectors.append({'initial':initial,'ops':ops})
# Include an unknown nonwinning source and an exact hydration source, plus atomic unknown position.
vectors.append({'initial':[{'id':'b','text':'x'},{'id':'p','text':''}], 'ops':[
 {'id':'b:2','client':'b','clock':2,'type':'block.set','block_id':'b','field':'type','value':'quote'},
 {'id':'a:3','client':'a','clock':3,'type':'block.set','block_id':'b','field':'type','value':'heading1'}],
 'extra':[{'id':'a:4','client':'a','clock':4,'type':'history.cancel','targets':['a:3']}],
 'hint_ops':[{'id':'b:2','client':'b','clock':2,'type':'block.set','block_id':'b','field':'type','value':'quote'}]})
for kind in ['position','mark']:
    if kind=='position':
        low={'id':'b:2','client':'b','clock':2,'type':'block.move','block_id':'b','parent_id':None,'after_id':'p'}
        high={'id':'a:3','client':'a','clock':3,'type':'block.move','block_id':'b','parent_id':'p','after_id':None}
    else:
        low={'id':'b:2','client':'b','clock':2,'type':'text.format','block_id':'b','char_ids':['seed:b:0'],'marks':{'color':'blue'}}
        high={'id':'a:3','client':'a','clock':3,'type':'text.format','block_id':'b','char_ids':['seed:b:0'],'marks':{'color':'red'}}
    vectors.append({'initial':[{'id':'b','text':'x'},{'id':'p','text':''}],'ops':[low,high],'extra':[{'id':'a:4','client':'a','clock':4,'type':'history.cancel','targets':['a:3']}],'hint_ops':[low]})
js=r'''const c=require('./static/collaboration.js'),fs=require('fs');const vectors=JSON.parse(fs.readFileSync(0,'utf8')); const output=vectors.map(v=>{let state=c.seedState(v.initial);for(const op of v.ops)state=c.applyOperations(state,[op]);const pub=c.publicState(state),hydrated=c.hydratePublicState(pub);let extra=v.extra?c.applyOperations(pub,v.extra):null,hints=v.hint_ops?c.capturePublicHints(c.publicState(c.applyOperations(c.seedState(v.initial),v.hint_ops))):new Map();return {state,pub,hydrated,extra,extraHydrated:extra?c.hydratePublicState(extra,hints):null};});process.stdout.write(JSON.stringify(output));'''
node = os.environ.get('FOUNTAIN_NODE') or shutil.which('node')
if not node:
    raise SystemExit('Node.js is required; put node on PATH or set FOUNTAIN_NODE.')
actual=json.loads(subprocess.check_output([node,'-e',js],input=json.dumps(vectors).encode(),cwd=ROOT))
def diff(a,b,path=''):
    if type(a)!=type(b):return (path,a,b)
    if isinstance(a,dict):
        if set(a)!=set(b):return(path+' keys',set(a),set(b))
        for k in a:
            v=diff(a[k],b[k],path+'/'+k)
            if v:return v
    elif isinstance(a,list):
        if len(a)!=len(b):return(path+' len',len(a),len(b))
        for i,(x,y) in enumerate(zip(a,b)):
            v=diff(x,y,path+'/'+str(i))
            if v:return v
    elif a!=b:return (path,a,b)
for i,(v,got) in enumerate(zip(vectors,actual)):
    state=seed_state(v['initial'])
    for op in v['ops']:state=apply_operations(state,[op])
    pub=public_state(state)
    expected={'state':state,'pub':pub,'hydrated':hydrate_public_state(pub),'extra':None,'extraHydrated':None}
    if 'extra' in v:
        expected['extra']=apply_operations(pub,v['extra']);hints=capture_public_hints(public_state(apply_operations(seed_state(v['initial']),v['hint_ops'])))
        expected['extraHydrated']=hydrate_public_state(expected['extra'],hints)
    if expected!=got:
        print('FAIL vector',i,diff(expected,got));sys.exit(1)
print('PASS:',len(vectors),'Python/JS exact full-state, public metadata, current hydration and unknown/exact-source rehydration vectors; Unicode and __proto__ included')
