import {chromium} from '@playwright/test';
const b=await chromium.launch({headless:true,args:['--ignore-gpu-blocklist','--use-angle=gl','--js-flags=--max-old-space-size=4096']});
const p=await b.newPage();
p.on('console',m=>{const t=m.text();if(t.startsWith('M:'))console.log(t);});
await p.goto('http://127.0.0.1:10000/?testing=1',{waitUntil:'load',timeout:180000});
const r=await p.evaluate(async ()=>{
  // Worker: generate ~N events, JSON.stringify (simulate a file), then parse+remap+stringify, timing each phase.
  const code=`
  self.onmessage=(e)=>{
    const {nEvents}=e.data;
    const t={};
    let t0=performance.now();
    // build a representative chrome-json string (one big file)
    const parts=['{"traceEvents":['];
    for(let i=0;i<nEvents;i++){
      if(i)parts.push(',');
      parts.push(JSON.stringify({ph:'X',pid:'XPU0 HW(0000:af:00.0)',tid:'SSE-Channel-0',ts:i*1000,dur:500,cat:'cluster',name:'void xpukernel_xpu3::some_kernel<3,int>(int const*,int,bool*,long)',args:{device:0,channel:0,token:i,cu_type:'cluster'}}));
    }
    parts.push(']}');
    const jsonStr=parts.join('');
    t.buildMs=Math.round(performance.now()-t0); t.bytes=jsonStr.length;
    t0=performance.now();
    const obj=JSON.parse(jsonStr);
    t.parseMs=Math.round(performance.now()-t0);
    t0=performance.now();
    const evs=obj.traceEvents;
    for(let i=0;i<evs.length;i++){const ev=evs[i]; if(typeof ev.pid==='string')ev.pid='T2/'+ev.pid; if(ev.ph!=='M'){ev.args=ev.args||{};ev.args.__trace=1;}}
    t.remapMs=Math.round(performance.now()-t0);
    t0=performance.now();
    const outStr=JSON.stringify(obj);
    t.stringifyMs=Math.round(performance.now()-t0); t.outBytes=outStr.length;
    t0=performance.now();
    const blob=new Blob([outStr],{type:'application/json'});
    t.blobMs=Math.round(performance.now()-t0);
    self.postMessage(t);
  };`;
  const w=new Worker(URL.createObjectURL(new Blob([code],{type:'application/javascript'})));
  // ~150MB: each event JSON ~ 300 bytes; 500k events ~ 150MB
  return await new Promise(res=>{w.onmessage=e=>res(e.data); w.postMessage({nEvents:500000});});
});
console.log('M:'+JSON.stringify(r));
await b.close();console.log('M:DONE');
