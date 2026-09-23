const MINUTE=60_000,HOUR=60*MINUTE,DAY=24*HOUR,WEEK=7*DAY,MONTH=30*DAY,YEAR=365*DAY;

function stamp(value:Date|string|number):number {return value instanceof Date?value.getTime():typeof value==='number'?value:Date.parse(value);}

/** Codex-style row age: 'now', '5m', '3h', '2d', '1w', '4mo', '1y'; '' when the date is unknown. Future stamps read as 'now'. */
export function compactAge(date:Date|string|number,now:number=Date.now()):string {
  const time=stamp(date);
  if(!Number.isFinite(time))return '';
  const elapsed=Math.max(0,now-time);
  if(elapsed<MINUTE)return 'now';
  if(elapsed<HOUR)return `${Math.floor(elapsed/MINUTE)}m`;
  if(elapsed<DAY)return `${Math.floor(elapsed/HOUR)}h`;
  if(elapsed<WEEK)return `${Math.floor(elapsed/DAY)}d`;
  if(elapsed<MONTH)return `${Math.floor(elapsed/WEEK)}w`;
  if(elapsed<YEAR)return `${Math.max(1,Math.floor(elapsed/MONTH))}mo`;
  return `${Math.floor(elapsed/YEAR)}y`;
}

const relativeFormats=new Map<string,Intl.RelativeTimeFormat>();
/** Localized sentence form, e.g. '5 minutes ago', 'yesterday', 'now'. */
export function relativeLabel(date:Date|string|number,now:number=Date.now(),locale?:string):string {
  const time=stamp(date);
  if(!Number.isFinite(time))return '';
  const key=locale??'';
  let format=relativeFormats.get(key);
  if(!format){format=new Intl.RelativeTimeFormat(locale,{numeric:'auto'});relativeFormats.set(key,format);}
  const elapsed=Math.max(0,now-time);
  if(elapsed<MINUTE)return format.format(0,'second');
  if(elapsed<HOUR)return format.format(-Math.floor(elapsed/MINUTE),'minute');
  if(elapsed<DAY)return format.format(-Math.floor(elapsed/HOUR),'hour');
  if(elapsed<WEEK)return format.format(-Math.floor(elapsed/DAY),'day');
  if(elapsed<MONTH)return format.format(-Math.floor(elapsed/WEEK),'week');
  if(elapsed<YEAR)return format.format(-Math.max(1,Math.floor(elapsed/MONTH)),'month');
  return format.format(-Math.floor(elapsed/YEAR),'year');
}

const exactFormat=new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'});
/** Exact local time for tooltips. */
export function exactTime(date:Date|string|number):string {
  const time=stamp(date);
  return Number.isFinite(time)?exactFormat.format(time):'';
}

/** Past-tense row age for sentences and meta lines: 'just now', '5m ago', '2w ago', '4mo ago'. Same buckets as compactAge; '' when unknown. */
export function agoLabel(date:Date|string|number,now:number=Date.now()):string {
  const age=compactAge(date,now);
  return !age?'':age==='now'?'just now':`${age} ago`;
}
