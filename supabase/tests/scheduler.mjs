import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {APIError} from '../functions/_shared/access.ts';
import {validate_schedule,next_occurrence, scheduleISO,scheduleDatetime,Scheduler} from '../functions/_shared/scheduler.ts';

const cases=[],base={frequency:'days',interval:1,timezone:'Asia/Seoul',start_at:'2026-01-31T09:30:00+09:00'};
const python=process.env.FOUNTAIN_PYTHON||'/Users/hooni.dev/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';
const catalog=spawnSync(python,['-c','import json,zoneinfo; print(json.dumps(sorted(zoneinfo.available_timezones())))'],{encoding:'utf8'});assert.equal(catalog.status,0,catalog.stderr);
const zoneCatalog=JSON.parse(catalog.stdout);
const zones=['UTC','Asia/Seoul','America/New_York','Europe/Berlin','Australia/Lord_Howe','Pacific/Apia','Asia/Kathmandu'];
const anchors=['2024-02-29T09:30:00.123456+09:00','2026-01-31T00:30:00Z','2026-03-07T02:30:00-05:00','2026-10-31T01:30:00-04:00','2011-12-29T10:00:00-10:00'];
const afters=['2010-01-01T00:00:00Z','2024-02-29T00:30:00.123456Z','2026-01-31T00:30:00Z','2026-03-08T07:30:00Z','2026-11-01T05:30:00Z','2040-01-31T00:34:59Z'];
for(const frequency of ['minutes','hours','days','weeks','months','years'])for(const interval of [1,2,365])for(const timezone of zones)for(const start_at of anchors){
 const schedule={frequency,interval,timezone,start_at};cases.push({method:'validate',schedule});for(const after of afters)cases.push({method:'next',schedule,after});
}
for(const invalid of [null,[],{}, {...base,interval:true},{...base,interval:0},{...base,interval:366},{...base,interval:1.5},{...base,frequency:[]},{...base,frequency:'fortnights'},{...base,timezone:'Missing/Zone'},{...base,timezone:[]},{...base,timezone:'../UTC'},{...base,timezone:'utc'},{...base,start_at:'2026-01-01'},{...base,start_at:'2026-02-30T00:00:00Z'},{...base,start_at:'not-a-date'},{...base,start_at:null},{...base,start_at:'1900-01-01T00:00:00Z'},{...base,start_at:'9999-01-01T00:00:00Z'},{...base,end_at:'2025-01-01T00:00:00Z'},{...base,end_at:null},{...base,extra:true}])cases.push({method:'validate',schedule:invalid});
cases.push({method:'next',schedule:{...base,frequency:'years',timezone:'UTC',start_at:'9998-12-31T00:00:00Z'},after:'9998-12-31T00:00:00Z'});
for(const timezone of zoneCatalog){const schedule={...base,timezone,start_at:'2026-03-27T06:30:00.000001Z'};cases.push({method:'validate',schedule},{method:'next',schedule,after:'2026-03-29T06:30:00.000001Z'});}
for(const after of ['2026-01-31T00:30:00Z','2026-02-01T00:30:00Z','2030-01-01T00:00:00Z'])cases.push({method:'next',schedule:{...base,end_at:'2026-02-01T09:30:00+09:00'},after});
const actual=cases.map(caseValue=>{try{return {ok:caseValue.method==='validate'?validate_schedule(caseValue.schedule):next_occurrence(caseValue.schedule,caseValue.after)};}catch(error){if(error instanceof APIError)return {error:error.status};throw error;}});
const root=fileURLToPath(new URL('../../',import.meta.url));
const reference=spawnSync(python,[root+'supabase/tests/scheduler-oracle.py'],{input:JSON.stringify(cases),encoding:'utf8',maxBuffer:16*1024*1024});assert.equal(reference.status,0,reference.stderr);
const expected=JSON.parse(reference.stdout);for(let index=0;index<cases.length;index++)assert.deepEqual(actual[index],expected[index],JSON.stringify(cases[index]));
assert.equal(scheduleISO(scheduleDatetime('2026-10-16T23:59:59.000001+00:00','probe')),'2026-10-16T23:59:59.000001+00:00');
assert.equal(Scheduler._run_id('fixture','2026-01-31T00:30:00+00:00').length,64);
console.log(JSON.stringify({ok:true,pythonZoneinfoCases:cases.length,timezones:zoneCatalog.length,microseconds:true,dst:'gap/overlap/non-hour/date-line',cronDeployment:false}));
