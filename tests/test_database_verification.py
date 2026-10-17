import copy
import unittest
from fountain.core import Store,APIError
from fountain.server import Application

class DatabaseVerificationTests(unittest.TestCase):
    def setUp(self):
        self.store=Store(':memory:');self.app=Application(self.store)
        for identity,role in [('alice','member'),('bob','member'),('guest','guest'),('inactive','member')]:self.store.put('member',{'id':identity,'name':identity,'role':role,'active':identity!='inactive'})
    def tearDown(self):self.store.close()
    def call(self,method,path,body=None,actor='local',query=None):return self.app.dispatch(method,path,body or {},query or {},principal=self.store.get('member',actor))[1]
    def database(self,props=None):return self.call('POST','/api/databases',{'id':'typed','name':'Typed','properties':props or [{'id':'title','name':'Title','type':'title'},{'id':'verified','name':'Verified','type':'verification'}]})
    def row(self):return self.call('POST','/api/databases/typed/rows',{'id':'row','properties':{'title':'Original'}},'alice')
    def context(self,actor='local'):return self.call('GET','/api/databases/typed/rows/row/verification',actor=actor)
    def denied(self,status,method,path,body=None,actor='local',query=None):
        before=list(self.store.db.execute('SELECT kind,id,data FROM entities ORDER BY kind,id'))
        with self.assertRaises(APIError) as error:self.call(method,path,body,actor,query)
        self.assertEqual(error.exception.status,status);self.assertEqual(before,list(self.store.db.execute('SELECT kind,id,data FROM entities ORDER BY kind,id')))
    def test_schema_pair_defaults_verification_and_opaque_cas(self):
        db=self.database();owner=next(p for p in db['properties'] if p['type']=='owner');self.assertEqual(owner['initial_default'],'created_by');row=self.row();self.assertEqual(row['properties'][owner['id']],['alice']);self.assertNotIn('_owner_generations',row)
        context=self.context('bob');self.assertTrue(context['can_verify']);self.assertEqual(len(context['revision']),64)
        verified=self.call('POST','/api/databases/typed/rows/row/verification',{'revision':context['revision'],'expires_at':None},'bob');self.assertEqual(verified['verification']['status'],'verified');self.assertEqual(verified['verification']['verified_by'],'bob')
        self.denied(409,'DELETE','/api/databases/typed/rows/row/verification',{'revision':context['revision']},'bob')
        detail=self.call('GET','/api/databases/typed');self.assertEqual(detail['rows'][0]['properties']['verified']['status'],'verified')
        self.call('DELETE','/api/databases/typed/rows/row/verification',{'revision':verified['revision']},'alice');self.assertEqual(self.context()['verification']['status'],'unverified')
    def test_singleton_cap_and_managed_fields_are_atomic(self):
        db=self.database();props=db['properties']
        for prop in [{'id':'o','name':'Other','type':'owner'},{'id':'v','name':'Other','type':'verification'}]:self.denied(400,'PATCH','/api/databases/typed',{'properties':props+[prop]})
        for key,value in [('generation',999),('initial_default','none')]:
            changed=copy.deepcopy(props);owner=next(p for p in changed if p['type']=='owner');owner[key]=value;self.denied(400,'PATCH','/api/databases/typed',{'properties':changed})
        self.denied(400,'PATCH','/api/databases/typed',{'_property_generation':999})
        changed=[p for p in props if p['type']!='owner'];self.denied(400,'PATCH','/api/databases/typed',{'properties':changed})
        self.call('PATCH','/api/databases/typed',{'properties':[p for p in props if p['type']!='verification']})
        self.assertIsNone(self.context_if_created())
    def context_if_created(self):return self.store.get('row','row')
    def test_generation_removal_readd_and_promoted_dormant_values(self):
        db=self.database([{'id':'title','name':'Title','type':'title'},{'id':'person','name':'Person','type':'multi_select'}]);row=self.call('POST','/api/databases/typed/rows',{'id':'row','properties':{'title':'Legacy','person':['bob']}},'alice')
        db=self.call('PATCH','/api/databases/typed',{'properties':[db['properties'][0],{'id':'person','name':'Person','type':'owner'},{'id':'verified','name':'Verified','type':'verification'}]});self.assertEqual(self.context()['owners'],[])
        self.call('PATCH','/api/databases/typed/rows/row',{'properties':{'person':['alice']}});first=self.context();verified=self.call('POST','/api/databases/typed/rows/row/verification',{'revision':first['revision']})
        self.call('PATCH','/api/databases/typed',{'properties':[db['properties'][0]]})
        self.call('PATCH','/api/databases/typed',{'properties':[db['properties'][0],{'id':'person','name':'Person','type':'owner'},{'id':'verified','name':'Verified','type':'verification'}]})
        latest=self.context();self.assertEqual(latest['owners'],[]);self.assertEqual(latest['verification']['status'],'unverified');self.assertNotEqual(latest['revision'],verified['revision']);self.assertGreater(latest['owner_property']['generation'],first['owner_property']['generation'])
    def test_initial_default_frozen_and_new_default_explicit(self):
        db=self.database([{'id':'title','name':'Title','type':'title'}]);legacy=self.row();before=self.store.get('row','row')
        db=self.call('PATCH','/api/databases/typed',{'properties':db['properties']+[{'id':'owner','name':'Owner','type':'owner'}]});self.assertEqual(self.context()['owners'],['alice']);self.assertEqual(self.store.get('row','row'),before)
        props=copy.deepcopy(db['properties']);props[-1]['default']='none';self.call('PATCH','/api/databases/typed',{'properties':props});self.assertEqual(self.context()['owners'],['alice'])
        new=self.call('POST','/api/databases/typed/rows',{'id':'new','properties':{'title':'New'}},'alice');self.assertEqual(new['properties']['owner'],[]);self.assertEqual(self.store.get('row','new')['_owner_generations'],{'owner':db['properties'][-1]['generation']})
        raw=self.store.get('row','row');raw.pop('owner_id');self.store.put('row',raw);self.assertEqual(self.context()['owners'],[])
    def test_limit_tightening_preserves_all_rows_and_hidden_owner_edits(self):
        self.database([{'id':'title','name':'Title','type':'title'},{'id':'owner','name':'Owner','type':'owner','limit':'unlimited'}]);self.row()
        self.call('PATCH','/api/databases/typed/rows/row',{'properties':{'owner':['alice','bob','bob']}});raw=self.store.get('row','row');self.assertEqual(raw['properties']['owner'],['alice','bob'])
        db=self.call('GET','/api/databases/typed')['database'];props=copy.deepcopy(db['properties']);props[-1]['limit']='one';self.denied(409,'PATCH','/api/databases/typed',{'properties':props});self.assertEqual(self.store.get('row','row'),raw)
        db=self.store.get('database','typed');db['permissions']={'default':'workspace','members':{'guest':'edit'},'groups':{},'inherit':False};self.store.put('database',db)
        self.call('PATCH','/api/databases/typed/rows/row',{'properties':{'owner':['guest']}},'guest');self.assertEqual(self.store.get('row','row')['properties']['owner'],['guest','alice','bob']);self.assertEqual(self.context('guest')['owners'],['guest'])
        for value in [None,'alice',[False],['inactive'],['missing'],['alice']*1001]:self.denied(404 if value in [['inactive'],['missing']] else 400,'PATCH','/api/databases/typed/rows/row',{'properties':{'owner':value}})
    def test_schema_owner_never_promotes_assignment_access(self):
        self.database([{'id':'title','name':'Title','type':'title'},{'id':'person','name':'Person','type':'person'}]);db=self.store.get('database','typed');db['row_permissions']={'mode':'assigned','property_id':'person','allow_create':True};self.store.put('database',db)
        self.denied(400,'PATCH','/api/databases/typed',{'properties':[db['properties'][0],{'id':'person','name':'Person','type':'owner'}]})
        from fountain.access import Access
        db['properties'][-1]['type']='owner';self.assertIsNone(Access._row_policy(db))
    def test_forgery_rejected_even_null_and_readonly_role(self):
        db=self.database();row=self.row();path='/api/databases/typed/rows/row'
        for key in ['verification','_owner_generations','verification_cycle','_verification_generation','owner_generations']:
            self.denied(400,'PATCH',path,{key:None});self.denied(400,'POST','/api/databases/typed/rows',{'id':'forged',key:None})
        for value in [None,{},'verified']:self.denied(400,'PATCH',path,{'properties':{'verified':value}})
        for revision in [None,0,True,'x'*64,'A'*64,'0'*63]:self.denied(400,'POST',path+'/verification',{'revision':revision})
        token=self.context()['revision']
        for expiry in ['2026-01-01','2099-01-01T00:00:00','2020-01-01T00:00:00Z',True,{},[]]:self.denied(400,'POST',path+'/verification',{'revision':token,'expires_at':expiry})
        self.denied(400,'POST',path+'/verification',{'revision':token,'owners':['alice']});self.denied(400,'GET',path+'/verification',query={'q':['x']});self.denied(405,'PATCH',path+'/verification',{})
        self.denied(404,'GET','/api/databases/projects/rows/row/verification')
        raw=self.store.get('row','row');raw['permissions']={'default':'workspace','members':{'bob':'view'},'groups':{},'inherit':False};self.store.put('row',raw);self.denied(403,'POST',path+'/verification',{'revision':self.context()['revision']},'bob')
    def test_owner_changes_preserve_stamp_source_and_frozen_clock_cycles(self):
        from unittest.mock import patch
        db=self.database();owner=next(p for p in db['properties'] if p['type']=='owner');self.row();raw=self.store.get('row','row');raw['unknown']={'nested':['preserve']};raw['permissions']={'default':'workspace','members':{},'groups':{},'inherit':False};self.store.put('row',raw)
        with patch('fountain.database_verification.now',return_value='2026-10-17T00:00:00+00:00'):
            first=self.call('POST','/api/databases/typed/rows/row/verification',{'revision':self.context()['revision'],'expires_at':'2099-01-01T00:00:00Z'});before=self.store.get('row','row')
            self.call('PATCH','/api/databases/typed/rows/row',{'properties':{owner['id']:['bob']}});after=self.store.get('row','row');self.assertEqual(after['verification'],before['verification']);self.assertEqual(after['unknown'],before['unknown']);self.assertEqual(after['owner_id'],'alice');self.assertEqual(after['permissions'],before['permissions']);self.assertEqual(self.context()['verification']['owners'],['bob'])
            second=self.call('POST','/api/databases/typed/rows/row/verification',{'revision':self.context()['revision'],'expires_at':'2099-01-01T00:00:00Z'});self.assertNotEqual(second['revision'],first['revision']);self.assertEqual(self.store.get('row','row')['verification_cycle'],2)
            self.call('DELETE','/api/databases/typed/rows/row/verification',{'revision':second['revision']});self.assertEqual(self.store.get('row','row')['verification_cycle'],3)
    def test_projection_before_filters_formula_rollup_and_csv(self):
        db=self.database([{'id':'title','name':'Title','type':'title'},{'id':'owner','name':'Owner','type':'owner'},{'id':'formula','name':'Formula','type':'formula','expression':'concat(prop("owner"))'}]);self.row();raw=self.store.get('database','typed');raw['permissions']={'default':'workspace','members':{'guest':'view'},'groups':{},'inherit':False};self.store.put('database',raw)
        detail=self.call('GET','/api/databases/typed',actor='guest');self.assertEqual(detail['rows'][0]['properties']['owner'],[]);self.assertEqual(detail['rows'][0]['properties']['formula'],'[]')
        filtered=self.call('GET','/api/databases/typed',actor='guest',query={'filters':['[{"property":"owner","operator":"contains","value":"alice"}]']});self.assertEqual(filtered['rows'],[])
        self.call('POST','/api/databases',{'id':'rollup','name':'Rollup','properties':[{'id':'relation','name':'Relation','type':'relation','database_id':'typed'},{'id':'owners','name':'Owners','type':'rollup','relation_property':'relation','target_property':'formula','aggregation':'count'}],'permissions':{'default':'workspace','members':{'guest':'view'},'groups':{},'inherit':False}})
        self.call('POST','/api/databases/rollup/rows',{'id':'related','properties':{'relation':['row']}});self.assertEqual(self.call('GET','/api/databases/rollup',actor='guest')['rows'][0]['properties']['owners'],1)
        from fountain.core import CURRENT_ACCESS
        from fountain.access import Access
        token=CURRENT_ACCESS.set(Access(self.store,self.store.get('member','guest')))
        try: exported=self.app.workspace.export('csv','typed')
        finally: CURRENT_ACCESS.reset(token)
        self.assertNotIn('alice',exported['content']);self.assertNotIn('_owner_generations',exported['content'])
    def test_duplicate_and_import_reset_trust_to_actualcreator(self):
        import json
        db=self.database();owner=next(p for p in db['properties'] if p['type']=='owner');self.row();self.call('POST','/api/databases/typed/rows/row/verification',{'revision':self.context()['revision']})
        result=self.call('POST','/api/databases/typed/rows/row/duplicate',actor='bob');copied=result['rows'][0];self.assertEqual(copied['owner_id'],'bob');self.assertEqual(copied['properties'][owner['id']],['bob']);self.assertEqual(copied['properties']['verified']['status'],'unverified')
        member=self.store.get('member','bob');member['role']='owner';self.store.put('member',member)
        imported=self.call('POST','/api/import',{'format':'json','content':json.dumps({'pages':[],'databases':[self.store.get('database','typed')],'rows':[self.store.get('row','row')]})},'bob');target=imported['databases'][0];rows=self.call('GET','/api/databases/'+target,actor='bob')['rows'];self.assertEqual(rows[0]['owner_id'],'bob');self.assertEqual(rows[0]['properties'][owner['id']],['bob']);self.assertEqual(rows[0]['properties']['verified']['status'],'unverified');self.assertNotIn('verification',self.store.get('row',rows[0]['id']))
    def test_owner_form_prohibition_and_automation_same_validator(self):
        self.database([{'id':'title','name':'Title','type':'title'},{'id':'owner','name':'Owner','type':'owner'},{'id':'verified','name':'Verified','type':'verification'}]);self.row()
        for key in ['owner','verified']:self.denied(400,'POST','/api/forms',{'name':'Test','database_id':'typed','fields':[{'id':'answer','property_id':key,'type':'text'}]})
        automation=self.call('POST','/api/automations',{'name':'Assign','database_id':'typed','actions':[{'type':'set_property','property_id':'owner','value':['bob']}]});self.call('POST','/api/automations/'+automation['id']+'/run',{'row_id':'row'});self.assertEqual(self.context()['owners'],['bob'])
        automation=self.call('POST','/api/automations',{'name':'Forge','database_id':'typed','actions':[{'type':'set_property','property_id':'verified','value':None}]});self.denied(400,'POST','/api/automations/'+automation['id']+'/run',{'row_id':'row'})
    def test_schema_add_and_config_do_not_load_or_write_rows(self):
        self.database([{'id':'title','name':'Title','type':'title'}]);self.row();before=self.store.get('row','row');original=self.store.list
        def bounded(kind):
            self.assertNotEqual(kind,'row','Schema activation must not load row bodies')
            return original(kind)
        self.store.list=bounded
        try:
            result=self.call('PATCH','/api/databases/typed',{'properties':[{'id':'title','name':'Title','type':'title'},{'id':'owner','name':'Owner','type':'owner'}]})
            props=result['properties'];props[-1]['default']='none';self.call('PATCH','/api/databases/typed',{'properties':props})
        finally:self.store.list=original
        self.assertEqual(self.store.get('row','row'),before)
    def test_property_cap_single_person_and_owner_budget(self):
        self.database([{'id':str(i),'name':str(i),'type':'text'} for i in range(100)])
        props=[{'id':str(i),'name':str(i),'type':'text'} for i in range(99)]+[{'id':'v','name':'Verification','type':'verification'}]
        self.denied(400,'PATCH','/api/databases/typed',{'properties':props})
        self.call('PATCH','/api/databases/typed',{'properties':[{'id':'title','name':'Title','type':'title'},{'id':'owner','name':'Owner','type':'owner','limit':'unlimited'}]});self.row()
        ids=['member-'+str(i) for i in range(1000)]
        for identity in ids:self.store.put('member',{'id':identity,'name':identity,'role':'member','active':True})
        self.call('PATCH','/api/databases/typed/rows/row',{'properties':{'owner':ids}});self.assertEqual(self.context()['owners'],ids)
        self.denied(400,'PATCH','/api/databases/typed/rows/row',{'properties':{'owner':ids+['alice']}})
    def test_owner_sync_public_schema_generation_and_verification_rejected(self):
        from fountain.sync import SyncService
        self.database([{'id':'title','name':'Title','type':'title'},{'id':'owner','name':'Owner','type':'owner'},{'id':'verified','name':'Verified','type':'verification'}]);self.row();db=self.store.get('database','typed');prop=next(p for p in db['properties'] if p['id']=='owner');minimal={key:prop[key] for key in ('type','generation','limit','default','initial_default')}
        SyncService._schema({'owner':['bob']},{'schema':{'owner':minimal}},db)
        for schema in [{**minimal,'generation':minimal['generation']+1},{**minimal,'limit':'unlimited'}]:
            with self.assertRaises(APIError) as e:SyncService._schema({'owner':[]},{'schema':{'owner':schema}},db)
            self.assertEqual(e.exception.status,409)
        with self.assertRaises(APIError) as e:SyncService._schema({'verified':None},{'schema':{'verified':db['properties'][-1]}},db)
        self.assertEqual(e.exception.status,400)
    def test_related_owner_resolves_before_formula_and_actor_search(self):
        self.database([{'id':'title','name':'Title','type':'title'},{'id':'owner','name':'Owner','type':'owner'},{'id':'formula','name':'Formula','type':'formula','expression':'concat(prop("owner"))'}]);self.row();db=self.store.get('database','typed');db['permissions']={'default':'workspace','members':{'guest':'view'},'groups':{},'inherit':False};self.store.put('database',db)
        from fountain.core import CURRENT_ACCESS
        from fountain.access import Access
        guest=Access(self.store,self.store.get('member','guest'));token=CURRENT_ACCESS.set(guest)
        try:
            fake={'id':'rollup','properties':[{'id':'relation','name':'Relation','type':'relation'},{'id':'value','name':'Value','type':'rollup','relation_property':'relation','target_property':'owner','aggregation':'min'}]}
            row={'id':'source','database_id':'rollup','properties':{'relation':['row']}}
            result=self.app.workspace.computed_rows(fake,[row],lambda r:guest.can('row',r));self.assertIsNone(result[0]['properties']['value']);self.assertIn('numeric',result[0]['computed_errors']['value'])
        finally:CURRENT_ACCESS.reset(token)
        guest_result=self.call('GET','/api/search/advanced',actor='guest',query={'q':['alice'],'types':['row']});self.assertEqual(guest_result['results'],[])
        normal=self.call('GET','/api/search/advanced',query={'q':['alice'],'types':['row']});self.assertEqual([item['id'] for item in normal['results']],['row'])
    def test_removed_types_never_reveal_retained_private_proof(self):
        self.database([{'id':'title','name':'Title','type':'title'},{'id':'owner','name':'Owner','type':'owner'},{'id':'verified','name':'Verified','type':'verification'}]);self.row();self.call('POST','/api/databases/typed/rows/row/verification',{'revision':self.context()['revision']})
        db=self.store.get('database','typed');db['permissions']={'default':'workspace','members':{'guest':'edit'},'groups':{},'inherit':False};self.store.put('database',db)
        source=self.store.get('row','row');self.call('PATCH','/api/databases/typed',{'properties':[db['properties'][0]]});self.assertEqual(self.store.get('row','row'),source)
        rows=self.call('GET','/api/databases/typed',actor='guest')['rows'];direct=self.call('PATCH','/api/databases/typed/rows/row',{'properties':{'title':'Guest edit'}},'guest')
        for row in [rows[0],direct]:
            for key in ['verification','_owner_generations','verification_cycle','_verification_generation','owner_generations']:self.assertNotIn(key,row)
        form=self.call('POST','/api/forms',{'name':'Text','database_id':'typed','published':True,'fields':[{'id':'title','type':'text'}]})
        raw_form=self.store.get('form',form['id']);result=self.call('POST','/api/forms/'+form['id']+'/submit',{'answers':{'title':'Safe'}},'guest')
        if 'row' in result:
            for key in ['verification','_owner_generations','verification_cycle']:self.assertNotIn(key,result['row'])
    def test_invalid_cycle_and_nonapplicable_managed_keys_rejected(self):
        self.database([{'id':'title','name':'Title','type':'title'},{'id':'owner','name':'Owner','type':'owner'},{'id':'verified','name':'Verified','type':'verification'}]);self.row();props=self.call('GET','/api/databases/typed')['database']['properties']
        for identity,key,value in [('owner','owner_property_id','forged'),('verified','initial_default','none'),('verified','default','none'),('verified','limit','one')]:
            changed=copy.deepcopy(props);next(p for p in changed if p['id']==identity)[key]=value;self.denied(400,'PATCH','/api/databases/typed',{'properties':changed})
        original=self.store.get('row','row')
        for cycle in [True,-1,1.5,None,'2',9007199254740991,9007199254740992]:
            raw=copy.deepcopy(original);raw['verification_cycle']=cycle;self.store.put('row',raw)
            self.denied(409,'POST','/api/databases/typed/rows/row/verification',{'revision':self.context()['revision']})
    def test_microsecond_expiry_timezone_and_json_export_redaction(self):
        import json
        from unittest.mock import patch
        self.database([{'id':'title','name':'Title','type':'title'},{'id':'owner','name':'Owner','type':'owner'},{'id':'verified','name':'Verified','type':'verification'}]);self.row()
        with patch('fountain.database_verification.now',return_value='2026-10-17T00:00:00.123000+00:00'):
            for expiry in ['2026-10-17T00:00:00.123000Z','2026-10-17T09:00:00.123000+09:00']:
                self.denied(400,'POST','/api/databases/typed/rows/row/verification',{'revision':self.context()['revision'],'expires_at':expiry})
            verified=self.call('POST','/api/databases/typed/rows/row/verification',{'revision':self.context()['revision'],'expires_at':'2026-10-17T09:00:00.123001+09:00'});self.assertEqual(verified['verification']['status'],'verified')
        with patch('fountain.database_verification.now',return_value='2026-10-17T00:00:00.123001+00:00'):self.assertEqual(self.context()['verification']['status'],'expired')
        exported=json.loads(self.call('GET','/api/export',query={'format':['json']})['content']);row=next(r for r in exported['rows'] if r['id']=='row')
        for key in ['verification','_owner_generations','verification_cycle']:self.assertNotIn(key,row)
        self.assertNotIn('_property_generation',next(d for d in exported['databases'] if d['id']=='typed'))
    def test_atomic_schema_revision_after_interleaved_writer(self):
        db=self.database([{'id':'title','name':'Title','type':'title'},{'id':'owner','name':'Owner','type':'owner'}]);token=db['schema_revision'];self.assertEqual(len(token),64);detail=self.call('GET','/api/databases/typed')['database'];self.assertEqual(detail['schema_revision'],token)
        workspace=self.call('GET','/api/workspace');self.assertEqual(next(d for d in workspace['databases'] if d['id']=='typed')['schema_revision'],token)
        props=copy.deepcopy(db['properties']);props[-1]['default']='none';changed=self.call('PATCH','/api/databases/typed',{'properties':props,'schema_revision':token});self.assertNotEqual(changed['schema_revision'],token)
        self.denied(409,'PATCH','/api/databases/typed',{'properties':db['properties'],'schema_revision':token})
        self.assertEqual(self.store.get('database','typed')['properties'],changed['properties']);self.assertNotIn('schema_revision',self.store.get('database','typed'))
        for bad in [None,False,0,'A'*64,'0'*63]:self.denied(400,'PATCH','/api/databases/typed',{'properties':props,'schema_revision':bad})
        legacy=self.call('PATCH','/api/databases/typed',{'properties':props});self.assertEqual(legacy['schema_revision'],changed['schema_revision'])
        self.denied(400,'POST','/api/databases',{'id':'forged','name':'Forged','schema_revision':token})
    def test_hidden_merge_budget_and_context_whitelist(self):
        self.database([{'id':'title','name':'Title','type':'title'},{'id':'owner','name':'Owner','type':'owner','limit':'unlimited'},{'id':'verified','name':'Verified','type':'verification'}]);self.row();db=self.store.get('database','typed');db['permissions']={'default':'workspace','members':{'guest':'edit'},'groups':{},'inherit':False};db['properties'][1]['private']='never';db['properties'][2]['private']='never';self.store.put('database',db)
        ids=['member-'+str(i) for i in range(1000)]
        for identity in ids:self.store.put('member',{'id':identity,'name':identity,'role':'member','active':True})
        self.call('PATCH','/api/databases/typed/rows/row',{'properties':{'owner':ids}})
        self.denied(400,'PATCH','/api/databases/typed/rows/row',{'properties':{'owner':['guest']}},'guest')
        context=self.context('guest');self.assertEqual(context['owners'],[]);self.assertNotIn('private',context['owner_property']);self.assertNotIn('private',context['verification_property'])
    def test_missing_invalid_generation_highwater_fails_closed(self):
        self.database([{'id':'title','name':'Title','type':'title'}]);original=self.store.get('database','typed')
        for value in [None,True,[],{},-1,9007199254740991]:
            changed=copy.deepcopy(original);changed['_property_generation']=value;self.store.put('database',changed)
            self.denied(409,'PATCH','/api/databases/typed',{'properties':[original['properties'][0],{'id':'owner','name':'Owner','type':'owner'}]})
