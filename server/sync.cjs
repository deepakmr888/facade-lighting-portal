const crypto = require('crypto');
const { mergeListing, normalize, documentCandidates, mergeDocuments } = require('./normalize.cjs');
const documents = require('./documents.cjs');
const { exportExcel } = require('./export.cjs');
const activeStates = new Set(['running','queued','waiting_for_login','rate_limited','retrying']);
function createSync({ store, bridge, portals, interval = 1000, now = Date.now }) {
  let busy = false, stopped = false;
  if (store.read().job && activeStates.has(store.read().job.state)) store.save(s => { s.job.state = 'queued'; s.job.message = 'Resuming saved progress after restart.'; });
  function start() {
    if(store.read().job&&activeStates.has(store.read().job.state))return store.read().job;
    if (store.read().job && ['paused','failed'].includes(store.read().job.state)) {
      store.save(s => { s.job.state = 'queued'; }); return store.read().job;
    }
    store.save(s => { s.job = { id: crypto.randomUUID(), state: 'queued', phase: 'listings', page: 1, total: null, received: 0, seen: [], failures: [], detailQueue: [], documentQueue: [], startedAt: new Date(now()).toISOString(), nextRunAt: 0, retryCount: 0, message: 'Checking live facade-light tenders.' }; });
    return store.read().job;
  }
  const modify = fn => store.save(s => { const paused=s.job?.state==='paused';fn(s.job,s);if(paused&&s.job)s.job.state='paused'; });
  async function tick() {
    const initial = store.read().job;
    if (busy || stopped || !initial || !activeStates.has(initial.state) || initial.nextRunAt > now()) return;
    busy = true;
    try {
      if (['listings','details'].includes(initial.phase) && !bridge.status().connected) { if(initial.state!=='waiting_for_login')modify(j=>{j.state='waiting_for_login';j.message='Sign into Tenderkart in the connected browser. The job will continue automatically.';}); return; }
      modify(j=>{j.state='running';j.error=null;});
      const job = store.read().job;
      if (job.phase === 'listings') {
        if ((job.page-1)*50 >= 10000) throw new Error('Tenderkart search exceeds its 10,000-record window. Saved records are retained; this run is incomplete.');
        const params = new URLSearchParams({ keywords: store.read().settings.query, status:'active', sort:'relevance', limit:'50', page:String(job.page) });
        const result = await bridge.request(`/api/v1/tenders?${params}`);
        if (!Array.isArray(result?.data) || !Number.isFinite(result.meta?.total) || !Number.isFinite(result.meta?.pages) || result.data.some(r=>typeof r.id!=='string' || typeof r.title!=='string')) throw new Error('Unexpected Tenderkart listing format; no page checkpoint was advanced.');
        if (!result.data.length && result.meta.total > (job.page-1)*50) throw new Error('Tenderkart returned an empty page before the end.');
        modify((j,s)=>{
          for (const raw of result.data) { const record=mergeListing(s.records,raw); if (!j.seen.includes(record.id)) j.seen.push(record.id); }
          j.received += result.data.length; j.total=result.meta.total; j.page++; j.retryCount=0;
          if (job.page >= result.meta.pages || result.meta.total === 0) {
            if(j.seen.length < result.meta.total) j.failures.push({stage:'listings',error:`Tenderkart reported ${result.meta.total} matches but returned ${j.seen.length} unique records. Run Sync again to recheck.`});
            j.phase='details'; j.detailQueue=s.records.filter(r=>r.sourceId).map(r=>r.id);
            for(const r of s.records.filter(r=>!r.sourceId)){r.detailState='manual_review';r.detailError='No Tenderkart source ID is available. Open this tender on Tenderkart to verify.';}
          }
          j.message=`Saved ${j.seen.length} of ${j.total} live matches. Existing saved tenders are retained.`;
        });
      } else if (job.phase === 'details') {
        const id = job.detailQueue[0];
        if (!id) { portals?.inventory(true);modify((j,s)=>{j.phase='documents';j.documentQueue=s.records.flatMap(r=>r.documents.filter(d=>d.localPath || d.url).map(d=>({record:r.id,key:d.key})));j.message='Downloading and reading tender documents.';}); }
        else {
          const prior = store.read().records.find(r=>r.id===id);
          try {
            let raw,identityError=false;
            const aliases=[...new Set([prior.sourceId,...(prior.sourceIds||[]),prior.summaryUrl?.match(/\/tender\/([a-f0-9-]{36})/)?.[1]].filter(Boolean))];
            for(const sourceId of aliases){
              let candidate;
              try{candidate=await bridge.request(`/api/v1/tenders/${encodeURIComponent(sourceId)}`);}catch(error){if([404,410].includes(error.status))continue;throw error;}
              if(candidate?.id!==sourceId || typeof candidate.title!=='string')throw new Error('Tenderkart detail response did not match the requested tender.');
              const ids=[candidate.tender_id,candidate.tender_reference_number].filter(Boolean).map(v=>String(v).trim().toLowerCase());
              if(ids.length&&prior.identifier!==prior.sourceId&&!ids.includes(prior.identifier.trim().toLowerCase())){identityError=true;continue;}
              raw=candidate;break;
            }
            if(!raw){
              if(!identityError)throw Object.assign(new Error('Tenderkart no longer returns this saved tender.'),{status:404});
              modify((j,s)=>{const r=s.records.find(r=>r.id===id);r.detailState='manual_review';r.detailError='Saved Tenderkart links resolve to different tender identifiers. Original details were preserved.';j.failures.push({stage:'identity',id,error:r.detailError});j.detailQueue.shift();});return;
            }
            modify((j,s)=>{
              const current=s.records.find(r=>r.id===id), record=normalize(raw,current);
              // Do not overwrite a review edited while the API request was in flight.
              record.documents=mergeDocuments(current.documents,documentCandidates(raw));
              record.detailState='complete';record.detailError=null;record.detailsFetchedAt=new Date(now()).toISOString();
              if(!record.documents.length)record.documentNotice='Tenderkart supplied no downloadable document links. Documents may be unavailable, plan-restricted or require a manual portal download.';
              s.records[s.records.indexOf(current)]=record;j.detailQueue.shift();j.retryCount=0;j.message=`Updated ${record.identifier}. ${j.detailQueue.length} details remaining.`;
            });
          } catch(error) {
            if(![404,410].includes(error.status))throw error;
            modify((j,s)=>{const r=s.records.find(r=>r.id===id);r.detailState='unavailable';r.detailError=error.message;j.failures.push({stage:'details',id,error:error.message});j.detailQueue.shift();});
          }
        }
      } else if (job.phase === 'documents') {
        const item=job.documentQueue[0];
        if(!item){modify(j=>{j.phase='export';});}
        else {
          const r=store.read().records.find(r=>r.id===item.record), doc=r.documents.find(d=>d.key===item.key);
          if(!doc.localPath&&portals&&!portals.support(r).supported){portals.reconcileSupport();modify(j=>{j.documentQueue.shift();j.message='Tender retained; document download skipped because its portal has no script.';});return;}
          if(!doc.localPath&&(r.documentDownloadSkip||doc.status==='skipped')){modify(j=>{j.documentQueue.shift();});return;}
          if(!doc.localPath&&portals?.needsBrowser(r,doc)){
            const flow=portals.queue(r,doc,'This download requires the original portal session and may need a manual CAPTCHA.');
            modify((j,s)=>{const record=s.records.find(x=>x.id===r.id),saved=record.documents.find(d=>d.key===doc.key);saved.status='portal_required';saved.portalFlowId=flow.id;saved.error='Open its portal flow to download this file.';j.documentQueue.shift();j.message=`${j.documentQueue.length} document checks remaining. Portal downloads are queued separately.`;});return;
          }
          let next;
          try {
            next=doc;
            if(!doc.localPath){
              if(new URL(doc.url).hostname==='tenderkart.in' && !bridge.status().connected)throw Object.assign(new Error('Sign into Tenderkart to download this document'),{status:401});
              next=await documents.download(doc,store.root,r,request=>bridge.request(request));
              modify((j,s)=>{const record=s.records.find(x=>x.id===r.id);record.documents[record.documents.findIndex(x=>x.key===doc.key)]=next;});
            }
            next=await documents.extract(next,store.root);
          }catch(error){
            if(error.status===429||error.status===401&&doc.url&&new URL(doc.url).hostname==='tenderkart.in')throw error;
            if(!next?.localPath&&portals){const flow=portals.queue(r,doc,error.message);next={...(next||doc),status:'portal_required',portalFlowId:flow.id,error:error.message};}
            else next={...(next||doc),status:'failed',error:error.message};
          }
          modify((j,s)=>{const record=s.records.find(x=>x.id===r.id);record.documents[record.documents.findIndex(x=>x.key===doc.key)]=next;j.documentQueue.shift();j.message=`${j.documentQueue.length} document checks remaining.`;});
        }
      } else if(job.phase==='export') {
        const issues=store.read().records.reduce((n,r)=>n+Number(r.detailState!=='complete')+Number(!r.documents.length)+r.documents.filter(d=>d.status!=='indexed').length,0);
        const partial=Boolean(issues || job.failures.length);
        modify((j,s)=>{j.state=partial?'partial':'complete';j.finishedAt=new Date(now()).toISOString();j.message=partial?'Sync finished with missing or unreadable details. Review the marked tenders and documents.':'Sync completed. JSON and Excel are up to date.';if(!partial)s.lastSuccessfulSync=j.finishedAt;s.lastSyncCheck=j.finishedAt;});
        try { await exportExcel(store); }
        catch(error){modify(j=>{j.state='partial';j.error=`JSON is saved, but Excel export failed: ${error.message}`;});}
      }
    } catch(error) {
      modify(j=>{
        j.retryCount=(j.retryCount||0)+1;j.error=error.message;
        if(error.status===429){j.state='rate_limited';j.nextRunAt=now()+Math.max(error.retryAfterMs||60000,Math.min(3600000,60000*2**Math.min(j.retryCount-1,6)));j.message='Tenderkart request limit reached. Saved progress will resume after the wait.';}
        else if([401,403].includes(error.status)||/browser|login|sign.in|reconnect/i.test(error.message)){j.state='waiting_for_login';j.nextRunAt=now()+10000;j.message=error.message;}
        else if(error.status>=500||/network|timeout|fetch failed/i.test(error.message)){j.state='retrying';j.nextRunAt=now()+Math.min(900000,30000*2**Math.min(j.retryCount-1,5));}
        else {j.state='failed';j.message='Sync stopped. Saved records and the last page checkpoint are retained.';}
      });
    } finally { busy=false; }
  }
  const timer=interval?setInterval(()=>tick().catch(()=>{}),interval):null;timer?.unref();
  return { start, tick, async pause(){modify(j=>{if(j)j.state='paused';});while(busy)await new Promise(r=>setTimeout(r,50));await exportExcel(store);return store.read().job;}, stop(){stopped=true;if(timer)clearInterval(timer);} };
}
module.exports={createSync};
