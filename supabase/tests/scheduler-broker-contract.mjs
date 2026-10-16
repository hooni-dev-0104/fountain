/** Source-contract locks only. This suite DOES NOT parse/compile/execute SQL,
 * prove PostgreSQL locks or execute Cron. Root separately owns actual PG/Edge QA. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createSchedulePlan,validatePlanningImage,validateBoundClaim} from '../functions/_shared/scheduler-worker.ts';
const sql=readFileSync(new URL('../migrations/20261016155423_fountain_cloud_scheduler_broker.sql',import.meta.url),'utf8');
const functions=[...sql.matchAll(/CREATE(?: OR REPLACE)? FUNCTION ((?:fountain_cloud|public)\.[a-z_]+)\(([^]*?)\) RETURNS ([^]*?)\nLANGUAGE ([^]*?)AS \$\$([^]*?)\$\$;/g)];
const body=name=>{const found=functions.find(match=>match[1]==='fountain_cloud.'+name);assert(found,'function '+name);return found[5];};
const statements=sql.replace(/AS \$\$[^]*?\$\$;/g,'AS <body>;').replace(/--[^\n]*/g,'');

test('migration defines private LOGGED state without installing extensions, jobs or a namespace',()=>{
 assert(!/CREATE\s+(?:UNLOGGED|TEMP)/i.test(statements));assert(!/CREATE EXTENSION/i.test(statements));assert(!/^(?:INSERT|SELECT|DO)\b/gmi.test(statements));
 for(const table of ['scheduler_registry','scheduler_due','scheduler_jobs','scheduler_attempts','scheduler_prepare_receipts','scheduler_owner_dirty']){assert(sql.includes('CREATE TABLE fountain_cloud.'+table));assert(sql.includes('ALTER TABLE fountain_cloud.'+table+' FORCE ROW LEVEL SECURITY'));assert(sql.includes('ALTER TABLE fountain_cloud.'+table+' ENABLE ROW LEVEL SECURITY'));}
 assert(!/GRANT[^;]*fountain_private/i.test(statements));assert(!/CREATE(?: OR REPLACE)? FUNCTION fountain_cloud.store_(?:context|commit|snapshot)\(/.test(sql));
});
test('all new private functions revoke direct execution and both RPCs have exact service-only signatures',()=>{
 assert(functions.length>=20);
 for(const match of functions.filter(match=>match[1].startsWith('fountain_cloud.')))assert(new RegExp('REVOKE ALL ON FUNCTION[^;]*'+match[1].replaceAll('.','\\.')+'\\(').test(sql),match[1]);
 for(const name of ['open','prepare'])assert(sql.includes('CREATE FUNCTION public.fountain_cloud_scheduler_'+name));
 assert(sql.includes('public.fountain_cloud_scheduler_open(text,uuid),public.fountain_cloud_scheduler_prepare(text,uuid,bigint,uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;'));
 assert(sql.includes('public.fountain_cloud_scheduler_open(text,uuid),public.fountain_cloud_scheduler_prepare(text,uuid,bigint,uuid,text,text,jsonb) TO service_role;'));
 assert(!/\bEXECUTE\s+(?:format|v_|p_)/i.test(sql));for(const match of functions)assert(match[4].includes('search_path=pg_catalog'));
});
test('private tables retain hash-only tokens, deadlines and scoped receipts',()=>{
 const tables=statements.slice(0,statements.indexOf('CREATE FUNCTION'));
 assert(tables.includes('ticket_hash text NOT NULL UNIQUE'));assert(!/\b(?:raw_ticket|access_token|actions|cookie|password)\s+(?:text|jsonb)/.test(tables));
 assert(tables.includes('UNIQUE(workspace_id,attempt_id)'));assert(tables.includes('PRIMARY KEY(workspace_id,attempt_id,invocation_id,transaction_id)'));assert(tables.includes('CHECK(ack_until>work_until)'));
});
test('ticket gate obtains workspace lock before row locks and binds exact invocation/generation',()=>{
 const gate=body('scheduler_ticket');assert(gate.indexOf('store_lock(v_ws)')<gate.indexOf('FOR UPDATE'));assert(gate.includes('r.enabled'));assert(gate.includes('v_job.generation<>v_attempt.generation'));assert(gate.includes('v_attempt.ack_until<=v_now'));assert(gate.includes("v_job.state<>'done' AND v_attempt.work_until<=v_now"));assert(gate.includes('v_attempt.invocation_id<>p_invocation_id'));assert(gate.includes("'INVOCATION_CONFLICT'"));
});
test('prepare authenticates before exact digest receipt and guards acceptance before mutation',()=>{
 const prepare=body('scheduler_prepare');assert(prepare.indexOf('scheduler_ticket')<prepare.indexOf('INTO v_receipt'));assert(prepare.indexOf('Invalid scheduler digest')<prepare.indexOf('INTO v_receipt'));assert(prepare.includes("'ticketHash',p_ticket_hash,'invocationId',p_invocation_id,'expectedRevision',p_expected_revision,'plan',p_plan"));assert(prepare.includes('v_receipt.digest<>p_digest'));assert(prepare.includes('PREPARE_ALREADY_ACCEPTED'));
 assert(prepare.indexOf('REVISION_CONFLICT')<prepare.indexOf('UPDATE fountain_cloud.scheduler_jobs'));assert(prepare.includes('service_context(v_receipt.response'));assert(prepare.includes('v_job.run_id IS NOT NULL'));assert(prepare.includes('v_job.next_at IS DISTINCT FROM v_next'));
});
test('planner projection reconstructs scalar metadata and never returns actions/row bodies',()=>{
 const image=body('scheduler_image');assert(image.includes("v_malformed:=true;v_next:='null'::jsonb"));assert(image.includes('IF v_malformed THEN v_schedule:=NULL'));assert(image.includes("jsonb_typeof(v_schedule) IS DISTINCT FROM 'object'"));assert(image.includes("'frequency','interval','timezone','start_at','end_at'"));assert(!image.includes("'actions'"));assert(!image.includes("'row_id'"));assert(image.includes("'authorAvailable'"));assert(image.includes('g.version=v_due.grant_version'));assert(image.includes('g.enabled'));
});
test('control path produces restricted runtime/run puts and never acquires a fake principal',()=>{
 const prepare=body('scheduler_prepare');assert(prepare.includes("'kind','automation_run'"));assert(prepare.includes("'kind','automation'"));assert(!prepare.includes("'kind','page'"));assert(!prepare.includes("'kind','row'"));assert(!prepare.includes("'authSessionId'"));assert(!prepare.includes("'role','owner'"));assert(prepare.includes('v_current_actor'));assert(prepare.includes('Automation delegated authority is unavailable'));assert(prepare.includes('Automation author was deleted or deactivated'));
 assert(prepare.indexOf("SET state='done',outcome=v_outcome")<prepare.indexOf('store_apply_changes_locked'));assert(prepare.indexOf('store_apply_changes_locked')<prepare.indexOf('INSERT INTO fountain_cloud.scheduler_prepare_receipts'));
});
test('SQL pins UTC instants/run hashes only and leaves recurrence/DST to the existing TS planner',()=>{
 const prepare=body('scheduler_prepare');assert(prepare.includes("automation_id||chr(10)||v_slot"));assert(prepare.includes("automation_id||chr(10)||'invalid-schedule'"));assert(prepare.includes('v_time>v_job.fixed_now'));assert(prepare.includes('v_next_time<=v_job.fixed_now'));assert(!/AT TIME ZONE.*schedule|pg_timezone_names|generate_series|interval.*months|interval.*days/i.test(prepare));
 const utc=body('scheduler_utc');assert(utc.includes('scheduler_stamp(v_time)<>p_value'));assert(body('scheduler_stamp').includes('SS.US'));assert(body('scheduler_wake').includes('EXCEPTION WHEN data_exception'));
});
test('service commit preserves current authority and original receipt-before-new-work ordering',()=>{
 const commit=body('service_commit');assert(commit.indexOf('service_context(p_context)')<commit.indexOf('INTO v_recorded'));assert(commit.indexOf('INTO v_recorded')<commit.indexOf('service_data_ready'));assert(commit.indexOf('service_data_ready')<commit.indexOf('store_apply_changes_locked'));assert(commit.includes('r.authority_hash=v_scope'));assert(commit.includes("jsonb_build_object('context',p_context,'expectedRevision',p_expected_revision,'changes',p_changes)"));assert(commit.includes("RETURN jsonb_build_object('revision',v_recorded.result_revision)"));
});
test('service completion validates final puts, marks done provisionally, applies then stores receipt atomically',()=>{
 const commit=body('service_commit');assert.equal((commit.match(/ORDER BY c.ordinal DESC LIMIT 1/g)||[]).length,2);assert(commit.includes('WITH ORDINALITY'));assert(commit.includes("'started_at' IS DISTINCT FROM to_jsonb(v_stamp)"));assert(commit.includes("'scheduled_at' IS DISTINCT FROM to_jsonb(v_job.scheduled_at)"));assert(commit.includes("'next_run_at' IS DISTINCT FROM v_next"));
 assert(commit.indexOf("SET state='done'")<commit.indexOf('store_apply_changes_locked'));assert(commit.indexOf('store_apply_changes_locked')<commit.indexOf('INSERT INTO fountain_cloud.service_commit_receipts'));assert(!/SET closed=true/.test(commit));
});
test('new data ready checks real broker context/current source hashes but keeps old exact ACK lease separate',()=>{
 const gate=body('scheduler_service_ready');for(const part of ["v_job.state IS DISTINCT FROM 'ready'",'v_job.generation IS DISTINCT FROM v_attempt.generation','v_attempt.work_until<=clock_timestamp()','v_due.grant_version IS DISTINCT FROM','v_due.incarnation IS DISTINCT FROM','scheduler_definition(v_data) IS DISTINCT FROM','scheduler_due_hash(v_data) IS DISTINCT FROM'])assert(gate.includes(part),part);
 assert(body('scheduler_bound').includes('p_attempt.ack_until,false'));assert(body('scheduler_bound').includes('service_context(v_context)'));
});
test('self runtime numeric representation normalization has a done+OLD/NEW logical equality exception only',()=>{
 const sync=body('scheduler_sync');assert(sync.includes("v_own_completion:=v_job.state='done' AND p_previous IS NOT NULL"));assert(sync.includes("p_previous-ARRAY['updated_at'"));assert(sync.includes("p_data-ARRAY['updated_at'"));assert(sync.includes('v_due.definition_hash<>v_definition AND NOT COALESCE(v_own_completion,false)'));assert(sync.includes("IF v_job.state IN('preparing','ready')"));assert(body('scheduler_entity_event').includes("CASE WHEN TG_OP='UPDATE' THEN OLD.data"));
});
test('revoked delegation is not auto-reissued; identity/source changes version and fence old authority',()=>{
 const sync=body('scheduler_sync');assert(sync.includes('v_due.identity_user IS DISTINCT FROM v_mapped'));assert(sync.includes('v_due.definition_version:=v_due.definition_version+1'));assert(sync.includes('v_grant_version:=NULL'));assert(!sync.includes('OR NOT v_old_grant.enabled'));assert(sync.includes('v_due.grant_id IS NOT NULL'));assert(sync.includes("v_grant IS NULL AND COALESCE(v_active,false)"));assert(sync.includes('AND g.version=v_grant_version AND g.enabled'));
 const insert=sync.slice(sync.indexOf('INSERT INTO fountain_cloud.service_grants'),sync.indexOf('IF v_due.active_job IS NOT NULL',sync.indexOf('INSERT INTO fountain_cloud.service_grants')));assert(insert.includes('created_at,creation_digest,pending_until'));assert(insert.includes("'automation',1,true,v_author,v_user"));
});
test('mapping trigger only queues IDs; dispatcher uses bounded indexed backfill/author keysets',()=>{
 const mapping=body('scheduler_mapping_event').replace(/--[^\n]*/g,'');assert(!mapping.includes('store_lock'));assert(!mapping.includes('scheduler_sync'));assert(!mapping.includes('FOR UPDATE'));assert(mapping.includes('scheduler_owner_dirty'));assert(!mapping.includes('OLD.data'));assert(!mapping.includes('r.enabled'));
 const dispatch=body('scheduler_dispatch');assert(dispatch.includes("e.kind='automation'"));assert(dispatch.includes('LIMIT 32'));assert(dispatch.includes('LIMIT v_budget'));assert(dispatch.includes('d.author_id=v_dirty.member_id'));assert(dispatch.includes('d.automation_id COLLATE "C">v_dirty.cursor_id'));assert(dispatch.includes('v_budget:=v_budget-1'));
});
test('durable dispatcher limits four/minute and never depends on pg_net completion',()=>{
 const dispatch=body('scheduler_dispatch');assert(dispatch.includes('v_limit:=4-v_registry.dispatch_count'));assert(dispatch.includes('LIMIT v_limit'));assert(dispatch.includes('extensions.gen_random_bytes(32)'));assert(dispatch.includes("jsonb_build_object('ticket',v_raw)"));assert(dispatch.includes('timeout_milliseconds:=120000'));assert(dispatch.includes("interval '90 seconds'"));assert(dispatch.includes("interval '150 seconds'"));assert(dispatch.includes('v_job.generation:=v_job.generation+1'));assert(!/http_response|http_request_queue/.test(dispatch));assert(!/SET fixed_now/.test(dispatch));assert(!/INSERT[^;]+v_raw/i.test(dispatch));
});
test('installer checks ownership before schedule/alter, fixed URL, and re-enable bounded backfill',()=>{
 const install=body('scheduler_install'),owned=body('scheduler_owned'),remove=body('scheduler_remove');assert(install.indexOf('scheduler_owned')<install.indexOf('cron.schedule'));assert(install.indexOf('CRON_OWNERSHIP_CONFLICT')<install.indexOf('cron.schedule'));for(const field of ['cron_id','cron_name','cron_user','cron_command'])assert(owned.includes(field));assert(owned.includes('c.database=current_database()'));assert(owned.includes('c.active=p_registry.enabled'));assert(install.includes('quote_literal(p_workspace_id)'));assert(install.includes('fountain-worker'));assert(install.includes('backfill_done=CASE WHEN p_enabled'));assert(remove.indexOf('scheduler_owned')<remove.indexOf('cron.unschedule'));
});
test('cleanup is workspace/owned-history bounded, keeps uncertain state and never deletes business history',()=>{
 const cleanup=body('scheduler_cleanup');assert(cleanup.includes('scheduler_owned'));assert(cleanup.includes('a.ack_until<v_cutoff'));assert(cleanup.includes('a.generation<j.generation'));assert((cleanup.match(/LIMIT 32/g)||[]).length>=5);assert(!cleanup.includes('DELETE FROM fountain_private'));assert(cleanup.includes('x.jobid=p_registry.cron_id'));assert(cleanup.includes('NOT EXISTS'));assert(!cleanup.includes("DELETE FROM fountain_private.entities"));
});
test('public planning/ready/done DTO key contract matches actual TS validators',()=>{
 const sample={jobId:'11111111-1111-4111-8111-111111111111',workspaceId:'QA 공간',automationId:'예약 😀',incarnation:'22222222-2222-4222-8222-222222222222',definitionVersion:1,definitionHash:'f'.repeat(64),dueHash:'e'.repeat(64),fixedNow:'2026-10-17T00:00:00.123456+00:00',revision:0,enabled:true,trigger:'scheduled',schedule:{frequency:'days',timezone:'UTC',start_at:'2026-10-17T00:00:00Z'},nextRunAt:null,malformed:false,authorAvailable:true};
 validatePlanningImage(sample);const plan=createSchedulePlan(sample);validateBoundClaim({jobId:sample.jobId,workspaceId:sample.workspaceId,automationId:sample.automationId,definitionVersion:1,definitionHash:sample.definitionHash,dueHash:sample.dueHash,fixedNow:sample.fixedNow,scheduledAt:plan.scheduledAt,runId:plan.runId,nextRunAt:plan.nextRunAt});
 const open=body('scheduler_open'),prepare=body('scheduler_prepare');assert(open.includes("jsonb_build_object('state','planning','image'"));assert(open.includes("jsonb_build_object('state','done')"));assert(prepare.includes("jsonb_build_object('state','done')"));assert(body('scheduler_bound').includes("'workspaceId',v_job.workspace_id"));assert(!/jsonb_build_object\('state','done',/.test(sql));
});

test('control failure preserves tick_one revision order and stored/request timestamp precision',()=>{
 const prepare=body('scheduler_prepare');assert(prepare.includes("IF v_kind='due' THEN\n     -- Match tick_one"));assert(prepare.includes("'status','running'"));assert(prepare.includes("'previousCreatedAt',NULL"));assert(prepare.includes("'previousCreatedAt',CASE WHEN v_kind='due' THEN v_store_stamp ELSE v_previous.created_at END"));assert(prepare.includes('COALESCE(v_previous.created_at,v_store_stamp)'));assert(prepare.includes("'updated_at',v_store_stamp"));assert(prepare.includes("'started_at',v_now,'finished_at',v_now"));assert(body('scheduler_store_stamp').includes("'000+00:00'"));
});

test('expired-attempt receipt cleanup makes progress even while its grant keeps scheduling',()=>{
 const cleanup=body('scheduler_cleanup');assert(cleanup.includes('x.authority_hash=v_attempt.authority_hash'));assert(cleanup.includes('r.authority_hash=v_attempt.authority_hash'));assert(cleanup.indexOf('DELETE FROM fountain_cloud.service_commit_receipts')<cleanup.indexOf('DELETE FROM fountain_cloud.scheduler_attempts'));assert(!cleanup.includes('l.expires_at>=v_cutoff'));assert(body('scheduler_bound').includes("authority_hash=encode(sha256(convert_to(v_context::text"));
});

test('sticky mapping epochs fence same-UUID relinks before receipt ACK and survive reconciliation',()=>{
 const mapping=body('scheduler_mapping_event'),member=body('scheduler_entity_event'),guard=body('scheduler_identity_guard'),dispatch=body('scheduler_dispatch'),commit=body('service_commit');
 assert(mapping.includes('identity_epoch=queued.identity_epoch+1'));assert(!member.includes('identity_epoch='));assert(guard.includes('v_attempt.identity_epoch IS DISTINCT FROM v_epoch'));assert(!guard.includes('FOR UPDATE'));assert(commit.indexOf('service_context')<commit.indexOf('scheduler_identity_guard'));assert(commit.indexOf('scheduler_identity_guard')<commit.indexOf('INTO v_recorded'));assert(!dispatch.includes('DELETE FROM fountain_cloud.scheduler_owner_dirty'));assert(dispatch.includes('AND q.pending'));assert(dispatch.includes('q.version=v_dirty.version'));assert(!/scheduler_owner_dirty[^;]*FOR UPDATE/.test(dispatch));assert(sql.includes('WHERE pending;'));
});
test('malformed legacy schedule projection has a size cap and exactly five scalar lookups',()=>{
 const image=body('scheduler_image');assert(image.includes('pg_column_size(v_schedule)>4096'));assert(image.includes('FOREACH v_key IN ARRAY'));assert(!image.includes('jsonb_each'));assert(image.includes('IF v_malformed THEN EXIT'));assert(image.indexOf('pg_column_size')<image.indexOf('FOREACH'));
});

test('member enqueue is deferred after owner Auth locks; availability does not rotate mapping epochs',()=>{
 const member=body('scheduler_member_event'),sync=body('scheduler_sync');assert(!member.includes('identity_epoch='));assert(!member.includes('FOR UPDATE'));assert(!member.includes('scheduler_author'));assert.equal((sql.match(/DEFERRABLE INITIALLY DEFERRED/g)||[]).length,3);assert(!sync.includes('v_changed OR v_user IS NULL'));assert(sync.includes('v_due.identity_epoch IS DISTINCT FROM v_epoch'));
});
test('raw legacy microseconds are truncated before PostgreSQL instant parsing, not rounded',()=>{
 const wake=body('scheduler_wake');assert(wake.includes("regexp_replace(replace(v_text,',','.')"));assert(wake.includes('([.][0-9]{6})[0-9]+'));assert(wake.indexOf('regexp_replace')<wake.indexOf('v_text::timestamptz'));
});

test('source wake-up casts are never a slot-authority parser for legacy ISO syntax',()=>{
 const prepare=body('scheduler_prepare');assert(!prepare.includes('scheduler_wake('));assert(prepare.includes('scheduler_due_hash(v_data)<>v_job.due_hash'));assert(prepare.includes('scheduler_definition(v_data)<>v_job.definition_hash'));assert(prepare.includes('fountain_cloud.scheduler_utc(v_slot)'));assert(prepare.includes("automation_id||chr(10)||v_slot"));
});
