/** Pure calendar calculation and synchronous staged schedule claims. A trusted
 * Cron caller must provide its own current authorized transaction; no daemon/I/O. */
import {APIError,get,has,is_object,require,truth} from './access.ts';
import type {Entity} from './access.ts';
import type {CoreStore} from './core.ts';
import {sha256} from './crdt.ts';
import {MissingSelection} from './store.ts';

const SECOND=1_000_000n,DAY=86400n*SECOND;
const FREQUENCIES=new Set(['minutes','hours','days','weeks','months','years']);
function utc(year:number,month:number,day:number,hour=0,minute=0,second=0):number{
  const value=new Date(0);value.setUTCFullYear(year,month-1,day);value.setUTCHours(hour,minute,second,0);return value.getTime();
}
export function scheduleDatetime(value:unknown,name:string):bigint{
  if(value instanceof Date){require(Number.isFinite(value.getTime()),'Invalid '+name);value=value.toISOString();}
  require(typeof value==='string'&&value.length<=100,typeof value==='string'?'Invalid '+name:name+' must include a timezone');
  const matched=/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2}(?::?\d{2}(?:[.,]\d{1,6})?)?)$/.exec(value);
  require(matched,name+' must include a timezone');
  const [,y,m,d,h,min,s='0',fraction='',offset]=matched,year=Number(y),month=Number(m),day=Number(d),hour=Number(h),minute=Number(min),second=Number(s);
  const naive=utc(year,month,day,hour,minute,second),date=new Date(naive);
  require(month>=1&&month<=12&&day>=1&&date.getUTCFullYear()===year&&date.getUTCMonth()+1===month&&date.getUTCDate()===day&&hour<24&&minute<60&&second<60,'Invalid '+name);
  let offsetMicros=0n;
  if(offset!=='Z'){
    const parts=/^([+-])(\d{2}):?(\d{2})(?::?(\d{2})(?:[.,](\d{1,6}))?)?$/.exec(offset)!;
    require(Number(parts[2])<24&&Number(parts[3])<60&&Number(parts[4]||0)<60,'Invalid '+name);
    offsetMicros=BigInt(Number(parts[2])*3600+Number(parts[3])*60+Number(parts[4]||0))*SECOND+BigInt((parts[5]||'').padEnd(6,'0')||0);
    if(parts[1]==='-')offsetMicros=-offsetMicros;
  }
  const result=BigInt(naive)*1000n+BigInt(fraction.slice(0,6).padEnd(6,'0')||0)-offsetMicros;
  const actual=new Date(Number(result/1000n));
  require(actual.getUTCFullYear()>=1970&&actual.getUTCFullYear()<=9998,name+' is outside supported date bounds');return result;
}
export function scheduleISO(value:bigint):string{
  const whole=value/SECOND,fraction=value%SECOND,date=new Date(Number(whole*1000n));
  require(date.getUTCFullYear()<=9998&&date.getUTCFullYear()>=1970,'Schedule exceeds supported date bounds');
  return date.toISOString().slice(0,19)+(fraction?'.'+String(fraction).padStart(6,'0'):'')+'+00:00';
}
const formatters=new Map<string,Intl.DateTimeFormat>();
function formatter(zone:string):Intl.DateTimeFormat{
  let result=formatters.get(zone);if(result)return result;
  // Keep IANA-style names; Intl also accepts numeric fixed offsets which are
  // not ZoneInfo database names. Do not infer case rules from the host filesystem.
  require(/^[A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z][A-Za-z0-9_+\-]*)*$/.test(zone),'Unknown schedule timezone');
  // IANA's Factory placeholder is a zero-offset zone in ZoneInfo but is not
  // exposed by ICU. Keep its stored spelling while calculating the UTC offset.
  try{result=new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn',{timeZone:zone==='Factory'?'UTC':zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});result.format(new Date(0));}
  catch{throw new APIError(400,'Unknown schedule timezone');}
  // Keep this cache bounded across server requests.
  if(formatters.size>=128)formatters.delete(formatters.keys().next().value!);formatters.set(zone,result);return result;
}
export function validate_schedule(schedule:unknown):Entity{
  require(is_object(schedule),'schedule must be an object');
  require(Object.keys(schedule).every(key=>['frequency','interval','timezone','start_at','end_at'].includes(key)),'Unknown schedule field');
  const frequency=get(schedule,'frequency'),interval=get(schedule,'interval',1),zone=get(schedule,'timezone','UTC');
  require(typeof frequency==='string'&&FREQUENCIES.has(frequency),'Invalid schedule frequency');
  require(Number.isInteger(interval)&&typeof interval==='number'&&interval>=1&&interval<=365,'Schedule interval must be between 1 and 365');
  require(typeof zone==='string'&&zone.length>0&&zone.length<=100,'Invalid schedule timezone');formatter(zone);
  require(typeof schedule.start_at==='string','start_at must be an ISO datetime');const anchor=scheduleDatetime(schedule.start_at,'start_at');
  const result:Entity={frequency,interval,timezone:zone,start_at:scheduleISO(anchor)};
  if(has(schedule,'end_at')){require(typeof schedule.end_at==='string','end_at must be an ISO datetime');const end=scheduleDatetime(schedule.end_at,'end_at');require(end>=anchor,'end_at cannot precede start_at');result.end_at=scheduleISO(end);}
  return result;
}
function localParts(value:bigint,zone:string):number[]{
  const parts=Object.fromEntries(formatter(zone).formatToParts(new Date(Number(value/1000n))).filter(part=>part.type!=='literal').map(part=>[part.type,Number(part.value)]));
  return [parts.year,parts.month,parts.day,parts.hour,parts.minute,parts.second];
}
function wall(value:bigint,zone:string):bigint{return BigInt(utc(...localParts(value,zone) as [number,number,number,number,number,number]))*1000n+value%SECOND;}
function resolveWall(naive:bigint,zone:string):bigint{
  const offsets=new Set<bigint>();
  // Covers non-hour transitions and date-line gaps; no scan through missed runs.
  for(let hours=-72;hours<=72;hours+=6){const sample=naive+BigInt(hours)*3600n*SECOND;offsets.add(wall(sample,zone)-sample);}
  const candidates=[...offsets].map(offset=>naive-offset),valid=candidates.filter(value=>wall(value,zone)===naive);
  const choices=valid.length?valid:candidates.filter(value=>wall(value,zone)>naive);
  require(choices.length>0,'Cannot resolve schedule local time');return choices.reduce((a,b)=>a<b?a:b);
}
export function next_occurrence(input:unknown,afterInput:unknown):string|null{
  const schedule=validate_schedule(input),after=scheduleDatetime(afterInput,'after_datetime'),anchor=scheduleDatetime(schedule.start_at,'start_at'),end=has(schedule,'end_at')?scheduleDatetime(schedule.end_at,'end_at'):null;
  if(end!==null&&after>=end)return null;
  const finish=(candidate:bigint)=>end!==null&&candidate>end?null:scheduleISO(candidate);
  if(after<anchor)return scheduleISO(anchor);
  const frequency=schedule.frequency;let interval=schedule.interval;
  try{
    if(['minutes','hours'].includes(frequency)){const step=BigInt(interval)*(frequency==='minutes'?60n:3600n)*SECOND;return finish(anchor+((after-anchor)/step+1n)*step);}
    const zone=schedule.timezone,local=localParts(anchor,zone),afterLocal=localParts(after,zone),fraction=anchor%SECOND;
    const localNaive=BigInt(utc(...local as [number,number,number,number,number,number]))*1000n+fraction;
    let index:number,occurrence:(index:number)=>bigint;
    if(['months','years'].includes(frequency)){
      if(frequency==='years')interval*=12;
      const months=(afterLocal[0]-local[0])*12+afterLocal[1]-local[1];index=Math.max(0,Math.floor(months/interval));
      occurrence=number=>{const monthIndex=local[0]*12+local[1]-1+number*interval,year=Math.floor(monthIndex/12),month=monthIndex%12+1;require(year<=9998,'Schedule exceeds supported date bounds');const last=new Date(utc(year,month+1,0)).getUTCDate(),day=Math.min(local[2],last);return resolveWall(BigInt(utc(year,month,day,local[3],local[4],local[5]))*1000n+fraction,zone);};
    }else{
      const days=interval*(frequency==='weeks'?7:1),afterNaive=BigInt(utc(...afterLocal as [number,number,number,number,number,number]))*1000n+after%SECOND;
      index=Math.max(0,Number((afterNaive-localNaive)/DAY)/days|0);occurrence=number=>resolveWall(localNaive+BigInt(number*days)*DAY,zone);
    }
    for(let attempts=0;attempts<4;attempts++,index++){const candidate=occurrence(index);if(candidate>after&&candidate>=anchor)return finish(candidate);}
    throw new APIError(400,'Cannot resolve schedule local time');
  }catch(error){if(end!==null&&error instanceof APIError&&error.message==='Schedule exceeds supported date bounds')return null;throw error;}
}

/** Only staged database work is permitted in runCallback. Global Cron claiming
 * and authorization are supplied by a future trusted service RPC, not this class. */
export class Scheduler {
  store:CoreStore;private callback:(identity:string,body:Entity,actor:string)=>unknown;
  constructor(store:CoreStore,callback:(identity:string,body:Entity,actor:string)=>unknown){this.store=store;this.callback=callback;}
  static _run_id(identity:string,scheduledAt:string):string{return sha256(identity+'\n'+scheduledAt);}
  private author(automation:Entity):string{
    const id=get(automation,'owner_id','local');require(typeof id==='string'&&!!id,'Automation author is invalid',403);
    const member=this.store.get('member',id);
    require(member&&get(member,'active',true)===true&&['owner','admin','member','guest'].includes(member.role),'Automation author was deleted or deactivated',403);return id;
  }
  tick(input:unknown=new Date()):Entity[]{
    const current=scheduleDatetime(input,'now'),now=scheduleISO(current),runs:Entity[]=[];
    for(const candidate of this.store.list('automation'))this.store.transaction(()=>{
      const automation=this.store.get('automation',candidate.id);if(!automation||automation.trigger!=='scheduled'||!truth(get(automation,'enabled',true)))return;
      let following:string|null,due:bigint;
      try{
        const schedule=validate_schedule(get(automation,'schedule'));due=scheduleDatetime(get(automation,'next_run_at')||schedule.start_at,'next_run_at');
        if(has(schedule,'end_at')&&due>scheduleDatetime(schedule.end_at,'end_at')){Object.assign(automation,{enabled:false,next_run_at:null,schedule_status:'completed'});this.store.put('automation',automation);return;}
        if(due>current)return;following=next_occurrence(schedule,now);
      }catch(error){
        if(error instanceof MissingSelection)throw error;
        const message=(error instanceof Error?error.message:String(error)).slice(0,1000),run=this.store.put('automation_run',{id:Scheduler._run_id(automation.id,'invalid-schedule'),automation_id:automation.id,scheduled_at:null,started_at:now,finished_at:now,status:'failed',error:message,next_run_at:null});
        Object.assign(automation,{enabled:false,next_run_at:null,last_error:message});this.store.put('automation',automation);runs.push(run);return;
      }
      const scheduledAt=scheduleISO(due),id=Scheduler._run_id(automation.id,scheduledAt);
      if(this.store.get('automation_run',id)){automation.next_run_at=following;if(following===null)Object.assign(automation,{enabled:false,schedule_status:'completed'});this.store.put('automation',automation);return;}
      const run:Entity={id,automation_id:automation.id,scheduled_at:scheduledAt,started_at:now,status:'running',next_run_at:following};this.store.put('automation_run',run);
      try{this.store.transaction(()=>{const actor=this.author(automation),body=truth(get(automation,'row_id'))?{row_id:automation.row_id}:{};const result=this.callback(automation.id,body,actor);require(!(result&&typeof (result as any).then==='function'),'Scheduled callbacks must be synchronous');Object.assign(run,{status:'succeeded',result});this.store.put('automation_run',run);});}
      catch(error){if(error instanceof MissingSelection)throw error;delete run.result;Object.assign(run,{status:'failed',error:(error instanceof Error?error.message:String(error)).slice(0,1000)});}
      run.finished_at=now;const saved=this.store.put('automation_run',run),latest=this.store.get('automation',automation.id);
      if(latest){Object.assign(latest,{next_run_at:following,last_run_at:now,last_run_status:run.status,last_error:get(run,'error')});if(following===null)Object.assign(latest,{enabled:false,schedule_status:'completed'});this.store.put('automation',latest);}runs.push(saved);
    });return runs;
  }
}
