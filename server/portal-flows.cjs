const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const adapters=require('../connector/portal-adapters.js');
const documents=require('./documents.cjs');
const {atomic}=require('./store.cjs');
const {exportExcel}=require('./export.cjs');
const active=new Set(['opening','navigating','waiting_for_captcha','waiting_for_login','waiting_for_user','downloading','receiving']);
function createPortalFlows(store){
  const list=()=>store.read().portalFlows||[];
  function support(record){let host=null;try{host=new URL(record.portalUrl).hostname;}catch{}const adapter=host?adapters.forHost(host):null;return{supported:Boolean(adapter),host,adapter,reason:adapter?null:`Document download skipped: no portal script for ${host||'an unidentified portal'}.`};}
  function reconcileSupport(){
    let changed=false;
    const next=structuredClone(store.read());next.portalFlows||=[];
    for(const record of next.records){
      const info=support(record);
      if(!info.supported){
        if(record.documentDownloadPolicy?.code!=='no_portal_script'||record.documentDownloadPolicy.host!==info.host){record.documentDownloadPolicy={code:'no_portal_script',host:info.host,reason:info.reason};record.fields['Document downloads']=info.reason;changed=true;}
        for(const doc of record.documents)if(!doc.localPath&&doc.status!=='skipped'){
          if(doc.status!=='needs_adapter'){doc.status='needs_adapter';doc.error=info.reason;changed=true;}
          let flow=next.portalFlows.find(f=>f.recordId===record.id&&f.documentKey===doc.key&&f.state!=='complete');
          if(!flow){next.portalFlows.push(makeFlow(record,doc,info.reason));changed=true;}
          else if(!['needs_adapter','skipped'].includes(flow.state)){flow.state='needs_adapter';flow.entryUrl=null;flow.message=info.reason;changed=true;}
        }
      }else if(record.documentDownloadPolicy?.code==='no_portal_script'){
        delete record.documentDownloadPolicy;delete record.fields['Document downloads'];changed=true;
        for(const doc of record.documents)if(doc.status==='needs_adapter'){doc.status='pending';doc.error=null;}
        for(const flow of next.portalFlows.filter(f=>f.recordId===record.id&&f.state==='needs_adapter')){flow.adapter=info.adapter.id;flow.origin=new URL(record.portalUrl).origin;flow.entryUrl=adapters.entry(record);flow.state='queued';flow.message='A portal script is now available. Ready for download.';}
      }
    }
    if(changed)store.save(s=>{s.records=next.records;s.portalFlows=next.portalFlows;});
  }
  function get(id){const flow=list().find(x=>x.id===id);if(!flow)throw Object.assign(new Error('Portal flow not found'),{status:404});return flow;}
  function update(id,fn){store.save(s=>{const f=s.portalFlows.find(x=>x.id===id);fn(f);f.updatedAt=new Date().toISOString();});return get(id);}
  function makeFlow(record,doc,reason){
    const info=support(record),adapter=info.adapter,entryUrl=adapters.entry(record);
    const flow={id:crypto.randomUUID(),recordId:record.id,documentKey:doc.key,identifier:record.identifier,reference:record.fields['Tender Reference Number'],name:doc.name,adapter:adapter?.id||'unsupported',entryUrl,origin:info.host?new URL(record.portalUrl).origin:null,expectedSha256:doc.expectedSha256||null,state:adapter?'queued':'needs_adapter',message:adapter?reason||'Ready for a portal browser session.':info.reason,createdAt:new Date().toISOString()};
    return flow;
  }
  function queue(record,doc,reason){const old=list().find(f=>f.recordId===record.id&&f.documentKey===doc.key&&f.state!=='complete');if(old)return old;const flow=makeFlow(record,doc,reason);store.save(s=>{s.portalFlows||=[];s.portalFlows.push(flow);});return flow;}
  function inventory(onlyRequired=false){
    reconcileSupport();
    const next=[];for(const r of store.read().records)for(const d of r.documents)if(!r.documentDownloadSkip&&d.status!=='skipped'&&!d.localPath&&(!onlyRequired||!d.url||['failed','portal_required','manual_review'].includes(d.status))&&!list().some(f=>f.recordId===r.id&&f.documentKey===d.key&&f.state!=='complete'))next.push(makeFlow(r,d,d.error));
    if(next.length)store.save(s=>{s.portalFlows||=[];s.portalFlows.push(...next);});return list();
  }
  function open(id){reconcileSupport();const flow=get(id);if(flow.state==='complete')return flow;if(!flow.entryUrl)throw new Error('This portal has no script yet. The tender is saved; document downloads are deferred.');
    const other=list().find(f=>f.id!==id&&active.has(f.state));if(other)throw Object.assign(new Error('Pause or finish the current portal flow first.'),{status:409});
    if(flow.state==='skipped')store.save(s=>{delete s.records.find(r=>r.id===flow.recordId).documentDownloadSkip;});
    return update(id,f=>{f.state='ready';f.message='Waiting for the browser connector.';});}
  function claim(){
    reconcileSupport();
    const existing=list().find(f=>active.has(f.state));
    if(existing){
      if(existing.state!=='opening'||Date.now()-Date.parse(existing.updatedAt||existing.createdAt)<30000)return null;
      update(existing.id,f=>{f.message='Retrying the browser handoff after a connector restart.';});
      return {...get(existing.id),config:adapters.definitions.find(a=>a.id===existing.adapter)};
    }
    const next=list().find(f=>f.state==='ready')||(store.read().portalQueueEnabled?list().find(f=>f.state==='queued'&&f.entryUrl):null);if(!next)return null;
    update(next.id,f=>{f.state='opening';f.message='Opening the tender portal in your normal browser.';});
    return {...get(next.id),config:adapters.definitions.find(a=>a.id===next.adapter)};
  }
  function report(id,body){
    if(!['navigating','waiting_for_captcha','waiting_for_login','waiting_for_user','downloading','failed','paused'].includes(body.state))throw new Error('Invalid portal flow state');
    if(['complete','receiving','paused','skipped'].includes(get(id).state))return get(id);
    if(body.state==='failed')return skip(id,body.message||'The tender portal returned an error.');
    return update(id,f=>{f.state=body.state;f.message=String(body.message||'').slice(0,700);if(body.identityConfirmed===true)f.identityConfirmed=true;if(body.downloadId!=null)f.downloadId=body.downloadId;});
  }
  function skip(id,reason='Skipped after a portal error.'){
    const flow=get(id);if(flow.state==='complete')return flow;
    store.save(s=>{
      s.portalQueueEnabled=true;
      for(const f of s.portalFlows||[])if(f.recordId===flow.recordId&&f.state!=='complete'){
        f.state='skipped';f.message=String(reason).slice(0,700);f.skippedAt=new Date().toISOString();
      }
      const record=s.records.find(r=>r.id===flow.recordId);
      record.documentDownloadSkip={reason:String(reason).slice(0,700),at:new Date().toISOString()};
      for(const doc of record.documents)if(!doc.localPath){doc.status='skipped';doc.error=String(reason).slice(0,700);}
    });
    exportExcel(store).catch(()=>{});return get(id);
  }
  function pause(id){get(id);store.save(s=>{s.portalQueueEnabled=false;const f=s.portalFlows.find(f=>f.id===id);if(f.state!=='complete')f.state='paused';});return get(id);}
  function needsBrowser(record,doc){
    if(!doc.url||doc.status==='portal_required')return true;
    try{const u=new URL(doc.url),adapter=adapters.forHost(new URL(record.portalUrl).hostname);return adapter?.id==='gePNIC'&&/\/(?:nicgep|eprocure)\/app$/i.test(u.pathname)||adapter?.id==='nprocure'&&u.pathname==='/common/download';}catch{return true;}
  }
  async function receive(id,{filePath,base64,fileName,identityConfirmed=false}){
    const flow=get(id);if(flow.state==='complete')return flow;if(!active.has(flow.state)&&!(flow.state==='ready'&&!filePath))throw new Error('Open this portal flow before attaching a file');
    const record=store.read().records.find(r=>r.id===flow.recordId),doc=record.documents.find(d=>d.key===flow.documentKey);
    let bytes;
    if(filePath){
      const allowed=path.join(os.homedir(),'Downloads'),resolved=documents.within(allowed,filePath);
      const real=fs.realpathSync(resolved);documents.within(fs.realpathSync(allowed),real);
      if(fs.statSync(real).size>100*1024**2)throw new Error('File exceeds 100 MB');
      fileName=path.basename(real);bytes=fs.readFileSync(real);
    }else{if(typeof base64!=='string'||base64.length>140*1024**2)throw new Error('Invalid uploaded file');bytes=Buffer.from(base64,'base64');}
    if(!bytes.length||bytes.length>100*1024**2)throw new Error('File is empty or exceeds 100 MB');
    const hash=crypto.createHash('sha256').update(bytes).digest('hex');
    if(flow.expectedSha256){if(hash!==flow.expectedSha256)throw new Error('This file does not match the expected document checksum. It was not attached.');}
    else{
      const name=v=>String(v||'').toLowerCase().replace(/\s*\(\d+\)(?=\.)/g,'').replace(/[^a-z0-9.]/g,'');
      if(!(flow.identityConfirmed||identityConfirmed)||name(fileName)!==name(doc.name))throw new Error('Confirm the tender identity and select the exact document filename before attaching it.');
    }
    if(/^\s*(?:<!doctype|<html)/i.test(bytes.subarray(0,300).toString()))throw new Error('A login/CAPTCHA page is not a tender document.');
    if(/\.pdf$/i.test(doc.name)&&(bytes.subarray(0,5).toString()!=='%PDF-'||!bytes.subarray(-4096).includes(Buffer.from('%%EOF'))))throw new Error('Invalid or incomplete PDF');
    update(id,f=>{f.state='receiving';f.message='Validating and reading the downloaded file.';});
    const localPath=`documents/${documents.safeName(record.identifier)}/${doc.key}-${documents.safeName(doc.name)}`;atomic(documents.within(store.root,localPath),bytes);
    let next={...doc,localPath,status:'downloaded',sha256:hash,downloadedAt:new Date().toISOString(),error:null};
    try{next=await documents.extract(next,store.root);}catch(error){next={...next,status:'manual_review',error:error.message};}
    store.save(s=>{const r=s.records.find(r=>r.id===record.id);r.documents[r.documents.findIndex(d=>d.key===doc.key)]=next;const f=s.portalFlows.find(f=>f.id===id);f.state='complete';f.message=next.status==='indexed'?'Document saved and indexed.':'Document saved; text needs manual review.';f.completedAt=new Date().toISOString();});
    await exportExcel(store);return get(id);
  }
  reconcileSupport();
  return {list,get,queue,inventory,open,claim,report,pause,skip,receive,needsBrowser,support,reconcileSupport,coverage:()=>adapters.definitions};
}
module.exports={createPortalFlows};
