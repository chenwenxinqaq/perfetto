import {chromium} from '@playwright/test';
const browser = await chromium.launch({headless:true, args:['--ignore-gpu-blocklist','--use-angle=gl']});
const page = await browser.newPage();
page.on('console',m=>{const t=m.text(); if(t.includes('PROBE'))console.log(t);});
await page.goto('http://127.0.0.1:10000/?testing=1',{waitUntil:'load',timeout:180000});
// Test: (1) inline Blob Worker, (2) DecompressionStream in worker, (3) streaming brace-depth tokenize + rewrite + Blob output, with progress.
const ok = await page.evaluate(async ()=>{
  // build a gzipped chrome json in-memory
  const events=[]; for(let i=0;i<5000;i++) events.push({ph:'X',pid:'XPU0 HW(af)',tid:'C0',ts:i*10,dur:5,cat:'cluster',name:'k'+i,args:{device:0}});
  const json=JSON.stringify({traceEvents:events});
  const cs=new CompressionStream('gzip');
  const gzBlob=await new Response(new Blob([json]).stream().pipeThrough(cs)).blob();
  const file=new File([gzBlob],'t.json.gz');

  const workerCode=`
    self.onmessage = async (e)=>{
      const {file, traceIndex}=e.data;
      try {
        const head=new Uint8Array(await file.slice(0,2).arrayBuffer());
        const isGz=head[0]===0x1f&&head[1]===0x8b;
        let stream=file.stream();
        if(isGz) stream=stream.pipeThrough(new DecompressionStream('gzip'));
        const reader=stream.pipeThrough(new TextDecoderStream()).getReader();
        // find traceEvents array, split top-level objects by brace depth
        let buf=''; let started=false; let depth=0; let instr=false; let esc=false; let cur='';
        const out=['{"displayTimeUnit":"ns","traceEvents":['];
        let first=true; let count=0; let bytes=0;
        const prefix='T'+(traceIndex+1)+'/';
        for(;;){
          const {value,done}=await reader.read();
          if(done) break;
          buf+=value; bytes+=value.length;
          let i=0;
          if(!started){ const k=buf.indexOf('"traceEvents"'); if(k<0){ buf=buf.slice(-20); continue;} const b=buf.indexOf('[',k); if(b<0) continue; i=b+1; started=true; }
          for(; i<buf.length; i++){
            const ch=buf[i];
            if(depth===0){ if(ch===']'){ break; } if(ch!=='{'&&ch!==','&&ch!==' '&&ch!=='\\n'&&ch!=='\\r'&&ch!=='\\t'){} }
            if(ch==='"'&&!esc) instr=!instr;
            esc=(ch==='\\\\'&&!esc);
            if(!instr){ if(ch==='{'){depth++;} else if(ch==='}'){depth--; cur+=ch; if(depth===0){ const ev=JSON.parse(cur); cur=''; if(typeof ev.pid==='string') ev.pid=prefix+ev.pid; if(ev.ph!=='M'){ev.args=Object.assign({},ev.args,{__trace:traceIndex});} out.push((first?'':',')+JSON.stringify(ev)); first=false; count++; continue; } } }
            if(depth>0) cur+=ch;
          }
          buf=buf.slice(i);
          self.postMessage({progress:bytes});
        }
        out.push(']}');
        const blob=new Blob(out,{type:'application/json'});
        self.postMessage({done:true, count, size:blob.size, blob});
      } catch(err){ self.postMessage({error:String(err)}); }
    };
  `;
  const w=new Worker(URL.createObjectURL(new Blob([workerCode],{type:'application/javascript'})));
  const res=await new Promise((resolve)=>{
    let progressTicks=0;
    w.onmessage=(e)=>{ if(e.data.progress!==undefined) progressTicks++; else resolve({...e.data, progressTicks}); };
    w.postMessage({file, traceIndex:1});
  });
  return res;
});
console.log('PROBE result:', JSON.stringify({count:ok.count, size:ok.size, progressTicks:ok.progressTicks, error:ok.error, hasBlob: !!ok.blob}));
await browser.close(); console.log('PROBE DONE');
