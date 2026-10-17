/** Shared input/expectation integrity only. Does NOT execute or simulate a native reconciliation engine. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import test from 'node:test';

export const fixtureURL = new URL('./fixtures/native-reconcile-cases.json', import.meta.url);
const buckets = {
  profiles: ['id'], meta: ['id'], snapshots: ['key'], databaseSnapshots: ['key'],
  operations: ['key', 'id'], drafts: ['key', 'clientId'], mutations: ['profileId', 'id'],
  localPages: ['key'], transfers: ['key'],
};
const fields = {
  profiles: ['id','origin','workspaceId','memberId','cacheBinding','session','workspace','validUntil','updatedAt'],
  meta: ['id','profileId','value'], snapshots: ['key','profileId','snapshot','updatedAt'],
  databaseSnapshots: ['key','resourceKey','profileId','snapshot','updatedAt'],
  operations: ['key','id','profileId','operation'], drafts: ['key','clientId','profileId','draft','updatedAt'],
  mutations: ['profileId','id','resourceKey','operation','status','sequence','createdAt','updatedAt','result','error'],
  localPages: ['key','resourceKey','profileId','metadata','updatedAt'],
  transfers: ['key','id','profileId','scopeId','pageId','name','size','lastModified','fingerprint','offset','expiresAt','publicationVersion','publication','verificationPending','verifiedOffset'],
};
const reasons = new Set(['missing','expired','revision_changed','epoch_changed','local_dependency','denied','schema_changed','dependency_conflict','unconfirmed_input','binding_changed','legacy_cache','unsupported_input']);
const groups = ['kept','acknowledged','quarantined','archived','replaced','unchanged','opaque','safetyChanged'];
const inputBuckets = new Set(['operations','drafts','mutations','localPages','transfers']);
const assertions = new Set(['input_bytes_preserved','canonical_installed_atomically','no_network_replay','same_transaction_seen_only','one_transform','archive_before_remove','no_old_crdt_identity_replay','complete_dependency_closure','no_hidden_body_delivery','native_role_only','source_bytes_unchanged','no_partial_active_replace','immutable_receipt','exact_retry_current_owner','native_admission_only','no_fabricated_denial','denial_survives_cancel','archive_bytes_preserved','fresh_private_acl','no_old_owner_session_receipts','explicit_confirmation','cross_actor_no_descriptors_counts','archive_collision_no_overwrite','both_archives_exportable','two_sweeps_max','no_upload_auto_resume','export_requires_current_resource_proof','external_source_change_preserved','late_legacy_commit_fenced','no_old_delete_replay','missing_before_image_blocks','attachment_metadata_native_proof','journal_before_image_puts_only','checkpoint_after_quarantine_receipt','stable_unowned_proof_unchanged','unowned_proof_change_invalidates','untrusted_profile_does_not_qualify_history','unaccepted_submit_rejected','staging_bytes_preserved','unaccepted_input_not_qualified','same_floor_equivocation_rejected','accepted_identity_preserved','no_fresh_reimport']);
const eventFields = {
  stage_untrusted_quarantine: ['sourceRefs'], assert_no_source_handles: [], quarantine_journal: ['acceptReceipt'], delete_checkpoint: ['txId'], settle: ['journals'], late_legacy_commit: ['txId'], prepare: [], collect: [], commit: ['confirm'], cancel: [], drop_commit_reply: [], retry_commit: [], retry_cancel: [],
  mutate_source: ['ref'], auth_change: ['authority'], advance_clock: ['milliseconds'],
  admit_http: ['response'], deliver_http: ['response'], fail_commit: [], observe_after_ready: ['response'],
  collide_archive: ['ref'], select_handle: ['sourceRefs'], change_sweep: ['response','dataRevision'],
};
const recordId = record => JSON.stringify([record.storage,record.bucket,record.key]);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const string = (value, label) => assert.ok(typeof value === 'string' && value.length > 0, label);
const integer = (value, label, min=0) => assert.ok(Number.isSafeInteger(value) && value >= min, label);
function exact(object, required, optional=[]) {
  assert.ok(plain(object), 'Expected an object');
  assert.ok(Object.keys(object).every(key => [...required,...optional].includes(key)), 'Unknown fixture field');
  for (const key of required) assert.ok(Object.hasOwn(object,key), `Missing ${key}`);
}
function unique(values, label) { assert.ok(Array.isArray(values), label); assert.equal(new Set(values).size,values.length,label); }
function nativeRecord(record) {
  exact(record,['ref','storage','bucket','key','value']);string(record.ref,'record ref');
  assert.ok(['active','recovery','upgrade','unaccepted'].includes(record.storage));assert.ok(Object.hasOwn(buckets,record.bucket));assert.ok(plain(record.value));
  assert.ok(Object.keys(record.value).every(key => fields[record.bucket].includes(key)), 'Invented source record field');
  const components=buckets[record.bucket].map(field => record.value[field]);components.forEach(value=>string(value,'storage key field'));
  assert.deepEqual(record.key,components.length===1?components[0]:components,'Source key does not match the actual bucket key path');
  if (record.bucket !== 'meta') string(record.value[record.bucket==='profiles'?'id':'profileId'],'record profile');
  if (record.bucket==='operations') {assert.equal(record.value.id,record.value.operation.id);string(record.value.operation._epoch,'operation epoch');assert.ok(!Object.hasOwn(record.value.operation,'fields'),'Stored CRDT fields are flattened, not DocumentChannel.submit instructions');}
  if (record.bucket==='mutations') {assert.equal(record.value.id,record.value.operation.id);assert.ok(['page.create','page.patch','row.create','row.patch','row.delete'].includes(record.value.operation.kind));if(record.value.operation.kind==='page.patch')assert.ok(plain(record.value.operation.base.fields),'Actual page.patch base.fields required');}
  if (record.bucket==='drafts') assert.ok(plain(record.value.draft));
  if (record.bucket==='localPages') assert.ok(plain(record.value.metadata));
}
export function validateCorpus(corpus) {
  exact(corpus,['version','scope','clockMs','planTTLms','authorities','cases','executionCoverage']);assert.equal(corpus.version,1);assert.equal(corpus.scope,'schema-corpus-only-not-native-execution');
  integer(corpus.clockMs,'fixed clock',1);integer(corpus.planTTLms,'plan TTL',1);assert.ok(corpus.planTTLms<=120000);assert.ok(plain(corpus.authorities));
  for(const authority of Object.values(corpus.authorities)) {
    exact(authority,['session','sessionRef']);string(authority.sessionRef,'private synthetic cookie reference');
    const s=authority.session;exact(s,['authenticated','required','mode','workspace_id','cache_binding','member','expires_at']);assert.equal(s.authenticated,true);assert.equal(s.required,true);assert.equal(s.mode,'accounts');
    exact(s.member,['id','active','role']);assert.equal(s.member.active,true);assert.ok(['owner','member','guest'].includes(s.member.role));
    assert.equal(Date.parse(s.expires_at)-corpus.clockMs,3600000,'Fixture expiry must be relative to injected fixed clock');
  }
  assert.ok(Array.isArray(corpus.cases)&&corpus.cases.length>=40);unique(corpus.cases.map(c=>c.id),'case IDs');
  for (const c of corpus.cases) {
    exact(c,['id','title','authority','mode','sourceRecords','responses','events','expected','executionTargets'],['selectedSources','legacyJournal','receiptLookup','privatePriorObservations','privateSetup']);
    unique(c.executionTargets,'execution targets');assert.equal(c.executionTargets.length,1);assert.ok(['native','js','bridge'].includes(c.executionTargets[0]));assert.match(c.id,/^[a-z][a-z0-9-]+$/);string(c.title,'title');assert.ok(Object.hasOwn(corpus.authorities,c.authority));assert.ok(['current','upgrade','promote'].includes(c.mode));
    if(c.privatePriorObservations!==undefined){assert.ok(Array.isArray(c.privatePriorObservations));for(const r of c.privatePriorObservations)exact(r,['ref','method','path','status','body','sessionRef']);}if(c.privateSetup!==undefined){exact(c.privateSetup,[],['sourceSetup','sourceAuthority','unacceptedRefs','confirmedMirrors']);if(c.privateSetup.sourceSetup!==undefined)assert.ok(['via-untrusted-quarantine','accepted-journal-only'].includes(c.privateSetup.sourceSetup));if(c.privateSetup.confirmedMirrors!==undefined){assert.ok(Array.isArray(c.privateSetup.confirmedMirrors));for(const pair of c.privateSetup.confirmedMirrors){exact(pair,['source','active']);const a=c.sourceRecords.find(r=>r.ref===pair.source),b=c.sourceRecords.find(r=>r.ref===pair.active);assert.ok(a&&b&&a.storage==='upgrade'&&b.storage==='active');assert.equal(a.bucket,b.bucket);assert.deepEqual(a.key,b.key);assert.deepEqual(a.value,b.value);}}if(c.privateSetup.sourceAuthority!==undefined)assert.ok(Object.hasOwn(corpus.authorities,c.privateSetup.sourceAuthority));if(c.privateSetup.unacceptedRefs!==undefined){unique(c.privateSetup.unacceptedRefs,'unaccepted refs');for(const ref of c.privateSetup.unacceptedRefs)assert.ok(c.sourceRecords.some(r=>r.ref===ref&&r.storage==='unaccepted'));}}
    assert.ok(Array.isArray(c.sourceRecords));c.sourceRecords.forEach(nativeRecord);unique(c.sourceRecords.map(r=>r.ref),'source refs');unique(c.sourceRecords.map(recordId),'distinct source records');
    const source=new Map(c.sourceRecords.map(r=>[r.ref,r]));assert.ok(Array.isArray(c.responses));unique(c.responses.map(r=>r.ref),'response refs');const responses=new Map();
    for (const r of c.responses) {
      exact(r,['ref','method','path','status','body','sessionRef']);string(r.ref,'response ref');assert.ok(['GET','POST'].includes(r.method));assert.match(r.path,/^\/api\/(workspace|pages\/[^/?#]+\/(collaboration|operations)|databases\/[^/?#]+|attachments\/[^/?#]+\/metadata)$/);integer(r.status,'HTTP status',100);assert.ok(r.status<=599);assert.ok(plain(r.body));assert.ok(Object.values(corpus.authorities).some(a=>a.sessionRef===r.sessionRef));if(r.status===200&&r.path.startsWith('/api/attachments/')){exact(r.body,['id','name','size','mime','storage','status'],['sha256']);integer(r.body.size,'metadata size');assert.ok(r.body.size<=5000000000);assert.ok(typeof r.body.name==='string'&&[...r.body.name].length>0&&[...r.body.name].length<=255&&!/[\\/\u0000-\u001f\u007f]/.test(r.body.name)&&!['.','..'].includes(r.body.name));assert.ok(typeof r.body.mime==='string'&&r.body.mime.length>0&&r.body.mime.length<=255);assert.ok(['inline','chunks'].includes(r.body.storage));assert.equal(r.body.status,'complete');if(r.body.sha256!==undefined)assert.match(r.body.sha256,/^[a-f0-9]{64}$/);}
      responses.set(r.ref,r);
    }
    assert.ok(Array.isArray(c.events)&&c.events.length>0);
    for(const event of c.events) {
      assert.ok(plain(event)&&Object.hasOwn(eventFields,event.type),'Unknown harness event');exact(event,['type',...eventFields[event.type]],event.type==='collect'?['responseRefs']:[]);
      if(event.responseRefs!==undefined){unique(event.responseRefs,'collected response refs');event.responseRefs.forEach(ref=>assert.ok(responses.has(ref)));}
      if(event.type==='settle'){assert.ok(Array.isArray(event.journals)&&event.journals.length>0&&event.journals.length<=100);for(const j of event.journals){exact(j,['txId','digest','baseHead','proofEpoch']);string(j.txId,'settled tx');assert.match(j.digest,/^[a-f0-9]{64}$/);integer(j.baseHead,'source head');integer(j.proofEpoch,'source proof epoch');}}
      if(event.acceptReceipt!==undefined)assert.equal(typeof event.acceptReceipt,'boolean');
      if(event.response!==undefined)assert.ok(responses.has(event.response),'Unknown response ref');if(event.ref!==undefined)assert.ok(source.has(event.ref),'Unknown source ref');
      if(event.authority!==undefined)assert.ok(Object.hasOwn(corpus.authorities,event.authority));if(event.confirm!==undefined)assert.equal(typeof event.confirm,'boolean');if(event.milliseconds!==undefined)integer(event.milliseconds,'clock advance',1);
      if(event.dataRevision!==undefined)integer(event.dataRevision,'counter');if(event.sourceRefs!==undefined){unique(event.sourceRefs,'selected refs');event.sourceRefs.forEach(ref=>assert.ok(source.has(ref)));}
    }
    if(c.mode==='current')assert.equal(c.selectedSources,undefined,'Current mode must not accept handles');
    else {unique(c.selectedSources,'selected archive refs');c.selectedSources.forEach(ref=>assert.ok(source.has(ref)&&source.get(ref).storage!=='active'));}
    const e=c.expected;exact(e,['result','requiresConfirmation','requiredReasons','records','recordCounts','refresh','assertions','fresh','counts'],['journalDisposition','needed','settlements','journalRecoveryPuts']);assert.ok(['settled','committed','collecting','confirmation_required','retryable','rejected','cancelled'].includes(e.result));assert.equal(typeof e.requiresConfirmation,'boolean');
    unique(e.requiredReasons,'reason codes');assert.deepEqual([...e.requiredReasons].sort(),e.requiredReasons,'Reasons must be codepoint sorted');e.requiredReasons.forEach(reason=>assert.ok(reasons.has(reason),'Unknown reason'));
    exact(e.records,groups);exact(e.recordCounts,groups);let partition=[];
    for(const group of groups){unique(e.records[group],group);e.records[group].forEach(ref=>assert.ok(source.has(ref),'Expected unknown source ref'));assert.equal(e.recordCounts[group],e.records[group].length);partition.push(...e.records[group]);}
    unique(partition,'Expectation groups overlap');assert.deepEqual([...partition].sort(),[...source.keys()].sort(),'Every original must have one disposition');
    if(e.needed!==undefined){assert.equal(e.result,'collecting');for(const n of e.needed){exact(n,['kind','id']);assert.ok(['workspace','page','database'].includes(n.kind));string(n.id,'needed id');}}
    unique(e.refresh,'refresh refs');e.refresh.forEach(ref=>assert.ok(responses.has(ref)));unique(e.assertions,'assertions');e.assertions.forEach(value=>assert.ok(assertions.has(value),'Unknown assertion'));
    assert.ok(Array.isArray(e.fresh));for(const fresh of e.fresh){exact(fresh,['source','fields','allDifferent','consistentReferences']);assert.ok(source.has(fresh.source));assert.equal(fresh.allDifferent,true);assert.equal(fresh.consistentReferences,true);unique(fresh.fields,'fresh identity fields');fresh.fields.forEach(field=>assert.ok(['operation.id','operation.target_id','operation.document_epoch','operation._epoch','operation.block_id'].includes(field)));}
    if(e.counts!==null){
      exact(e.counts,['refresh','keep','acknowledge','quarantine','import']);Object.values(e.counts).forEach(value=>{integer(value,'summary count');assert.ok(value<=100000);});
      const activeInput=ref=>source.get(ref).storage==='active'&&inputBuckets.has(source.get(ref).bucket);
      assert.equal(e.counts.keep,e.records.kept.filter(activeInput).length,'keep counts logical active INPUT records');
      assert.equal(e.counts.quarantine,e.records.quarantined.filter(activeInput).length,'quarantine excludes baseline archive copies');
      assert.equal(e.counts.acknowledge,e.records.acknowledged.length);e.records.acknowledged.forEach(ref=>assert.equal(source.get(ref).bucket,'operations'));
      assert.equal(e.counts.import,c.mode==='current'?0:c.sourceRecords.filter(r=>r.storage!=='active'&&inputBuckets.has(r.bucket)).length-(c.privateSetup?.confirmedMirrors||[]).filter(pair=>inputBuckets.has(source.get(pair.source).bucket)).length,'import counts fresh input only');
      assert.equal(e.counts.refresh,3+e.refresh.filter(ref=>responses.get(ref).path!=='/api/workspace').length+(c.mode==='current'?0:c.sourceRecords.filter(r=>r.storage!=='active'&&r.bucket==='snapshots').length-(c.privateSetup?.confirmedMirrors||[]).filter(pair=>source.get(pair.source).bucket==='snapshots').length)+c.sourceRecords.filter(r=>r.storage==='active'&&r.bucket==='drafts'&&r.value.draft.reason==='basis'&&e.records.archived.includes(r.ref)).length,'refresh counts native canonical baseline writes');
      assert.equal(e.requiresConfirmation,c.mode!=='current'||e.counts.quarantine>0);assert.ok(e.counts.refresh>=3,'Profile + active + last-profile baseline writes required');
    }
    if(e.journalRecoveryPuts!==undefined){assert.ok(Array.isArray(e.journalRecoveryPuts));for(const r of e.journalRecoveryPuts){exact(r,['bucket','key','value']);nativeRecord({ref:'recovery',storage:'recovery',...r});}}
    if(e.settlements!==undefined){assert.ok(Array.isArray(e.settlements));for(const row of e.settlements){exact(row,['txId','digest','status'],row.status==='accepted'?['head','proofEpoch']:[]);assert.ok(['accepted','unaccepted'].includes(row.status));assert.match(row.digest,/^[a-f0-9]{64}$/);if(row.status==='accepted'){integer(row.head,'accepted receipt head');integer(row.proofEpoch,'original receipt proof epoch');}else{assert.equal(row.head,undefined);assert.equal(row.proofEpoch,undefined);}}}
    if(c.legacyJournal!==undefined){
      assert.ok(Array.isArray(c.legacyJournal));for(const j of c.legacyJournal){exact(j,['txId','version','origin','profileId','baseHead','lease','proofEpoch','deltaJSON','digest','createdAt'],['beforeImages']);if(j.beforeImages!==undefined){assert.ok(Array.isArray(j.beforeImages));for(const image of j.beforeImages){exact(image,['bucket','key','present'],['value']);assert.equal(typeof image.present,'boolean');if(image.present){assert.ok(Object.hasOwn(image,'value'));nativeRecord({ref:'before',storage:'upgrade',bucket:image.bucket,key:image.key,value:image.value});}else assert.equal(Object.hasOwn(image,'value'),false);}}assert.equal(j.version,1);string(j.lease,'native owner lease');if(j.digest!==null)assert.equal(createHash('sha256').update(j.deltaJSON).digest('hex'),j.digest);JSON.parse(j.deltaJSON);}
      exact(c.receiptLookup,['txId','accepted']);assert.equal(typeof c.receiptLookup.accepted,'boolean');exact(e.journalDisposition,['clearAcceptedCheckpoint','preserveUncertain','repeatMutation']);if(e.result==='settled'||e.result==='committed'){assert.equal(e.journalDisposition.clearAcceptedCheckpoint,c.receiptLookup.accepted);assert.equal(e.journalDisposition.preserveUncertain,!c.receiptLookup.accepted);}assert.equal(e.journalDisposition.repeatMutation,false);
    }
  }
  exact(corpus.executionCoverage,['native','js','bridge']);for(const target of ['native','js','bridge']){unique(corpus.executionCoverage[target],'coverage IDs');assert.deepEqual(corpus.executionCoverage[target],corpus.cases.filter(c=>c.executionTargets.includes(target)).map(c=>c.id));}
  assert.equal(corpus.executionCoverage.native.length,62);assert.deepEqual([...corpus.executionCoverage.js].sort(),['legacy-delete-no-before-image','settle-beforeimage-absent','settle-beforeimage-mixed-puts','settle-beforeimage-present','settle-beforeimage-receipt-failure']);assert.equal(corpus.executionCoverage.bridge.length,0);unique(Object.values(corpus.executionCoverage).flat(),'whole corpus coverage');assert.equal(Object.values(corpus.executionCoverage).flat().length,corpus.cases.length);
  return {cases:corpus.cases.length,records:corpus.cases.reduce((sum,c)=>sum+c.sourceRecords.length,0)};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const corpus=JSON.parse(await readFile(fixtureURL,'utf8'));
  test('shared native reconciliation corpus is structurally complete (not native execution)',()=>{const report=validateCorpus(corpus);assert.equal(report.cases,67);});
  const bad=(name,change)=>test(name,()=>{const next=structuredClone(corpus);change(next);assert.throws(()=>validateCorpus(next));});
  bad('rejects a record key inconsistent with actual storage keyPath',d=>{d.cases[0].sourceRecords[0].key='wrong';});
  bad('rejects fixture-only fields smuggled into stored record values',d=>{d.cases[0].sourceRecords[0].value.nativeGrant=true;});
  bad('rejects an expectation referring to a nonexistent original',d=>{d.cases[0].expected.records.kept.push('missing');});
  bad('rejects overlapping disposition sets',d=>{d.cases[0].expected.records.quarantined.push('pending-op');});
  bad('rejects invented wire count units',d=>{d.cases[0].expected.counts.keep++;});
  bad('rejects a private-control reason absent from the agreed enum',d=>{d.cases[0].expected.requiredReasons=['private_name'];});
  bad('rejects a clock tied to runner wall time',d=>{d.authorities.current.session.expires_at='2031-01-01T00:00:00Z';});
  bad('rejects silently unsupported harness events',d=>{d.cases[0].events.push({type:'skip_case'});});
  bad('rejects an injected receipt on the current-mode bridge request',d=>{d.cases[0].events[0].receipt={accepted:true};});
  bad('rejects a made-up DocumentChannel submit wrapper in persisted operations',d=>{d.cases[0].sourceRecords.find(r=>r.bucket==='operations').value.operation.fields={block_type:'paragraph'};});
  bad('rejects import counts that include archived baseline snapshots',d=>{d.cases.find(c=>c.mode==='promote'&&c.expected.counts).expected.counts.import++;});
  bad('rejects an absent before-image that nonetheless carries a source value',d=>{d.cases.find(c=>c.id==='settle-beforeimage-absent').legacyJournal[0].beforeImages[0].value={};});
  bad('rejects silent delegation that drops a corpus requirement',d=>{d.executionCoverage.native.pop();});
  bad('rejects a non-bound legacy intent digest',d=>{d.cases.find(c=>c.legacyJournal).legacyJournal[0].digest='0'.repeat(64);});
}
