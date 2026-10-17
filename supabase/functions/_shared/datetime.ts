/** Shared existing calendar parser; integer microseconds preserve strict expiry. */
import {require} from './access.ts';
const SECOND=1_000_000n;
export function utcDateMillis(year:number,month:number,day:number,hour=0,minute=0,second=0):number{
  const value=new Date(0);value.setUTCFullYear(year,month-1,day);value.setUTCHours(hour,minute,second,0);return value.getTime();
}
export function awareDatetimeMicros(value:unknown,name:string):bigint{
  if(value instanceof Date){require(Number.isFinite(value.getTime()),'Invalid '+name);value=value.toISOString();}
  require(typeof value==='string'&&value.length<=100,typeof value==='string'?'Invalid '+name:name+' must include a timezone');
  const matched=/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2}(?::?\d{2}(?:[.,]\d{1,6})?)?)$/.exec(value);
  require(matched,name+' must include a timezone');
  const [,y,m,d,h,min,s='0',fraction='',offset]=matched,year=Number(y),month=Number(m),day=Number(d),hour=Number(h),minute=Number(min),second=Number(s);
  const naive=utcDateMillis(year,month,day,hour,minute,second),date=new Date(naive);
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
