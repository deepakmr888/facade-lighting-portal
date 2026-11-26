const fs = require('fs');
const path = require('path');
const express = require('express');
const { createStore } = require('./store.cjs');
const { createBridge } = require('./bridge.cjs');
const { createSync } = require('./sync.cjs');
const { exportExcel } = require('./export.cjs');
const { within } = require('./documents.cjs');
const {createPortalFlows}=require('./portal-flows.cjs');

function createApp({ root = process.env.FACADE_DATA_DIR || path.resolve(__dirname, '../data'), interval = 1000 } = {}) {
  const store = createStore(root), bridge = createBridge({pairingFile:path.join(root,'browser-pairing.json')}),portals=createPortalFlows(store),sync = createSync({ store, bridge, portals, interval });
  const app = express(); app.disable('x-powered-by');
  const local = req => ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  app.use((req,res,next)=>{
    if (['POST','PUT','PATCH','DELETE'].includes(req.method)) {
      if (!local(req)) return res.status(403).json({error:'Run sync and editing controls on the server computer.'});
      if(req.headers.origin) { try { const u=new URL(req.headers.origin); const extension=/^\/api\/(?:bridge|portal-flows)\//.test(req.path)&&/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin);if(!extension&&!['localhost','127.0.0.1','[::1]'].includes(u.hostname))return res.status(403).json({error:'Untrusted request origin'}); } catch{return res.sendStatus(403);} }
    }
    next();
  });
  app.use('/api/bridge/reply', express.json({limit:'145mb'}));
  app.use('/api/portal-flows',express.json({limit:'145mb'}));
  app.use(express.json({limit:'2mb'}));
  app.get('/api/health',(req,res)=>res.json({ok:true,app:'facade-lighting-portal'}));
  app.get('/api/status',(req,res)=>{
    const state=store.read(); let excel=null;
    try{excel=JSON.parse(fs.readFileSync(path.join(root,'exports/export-status.json'),'utf8'));}catch{}
    res.json({job:state.job,connection:bridge.status(),count:state.records.length,updatedAt:state.updatedAt,lastSuccessfulSync:state.lastSuccessfulSync,lastSyncCheck:state.lastSyncCheck,excel,revision:state.revision});
  });
  app.get('/api/tenders',(req,res)=>res.json(store.read().records.map(({raw,...record})=>record)));
  app.get('/api/tenders/:id/source',(req,res)=>{
    const record=store.read().records.find(r=>r.id===req.params.id);
    if(!record)return res.status(404).json({error:'Tender not found'});
    res.json(record.raw||{notice:'No live source detail response has been fetched yet.',snapshot:record.fields});
  });
  app.patch('/api/tenders/:id/review',async(req,res,next)=>{try{
    const {status,comment}=req.body;
    if(!['Not Reviewed','Eligible','Not Eligible','Filled'].includes(status)||typeof comment!=='string'||comment.length>10000)return res.status(400).json({error:'Invalid review'});
    if(!store.read().records.some(r=>r.id===req.params.id))return res.status(404).json({error:'Tender not found'});
    store.save(s=>{s.records.find(r=>r.id===req.params.id).review={status,comment,updatedAt:new Date().toISOString()};});
    await exportExcel(store);res.json({ok:true});
  }catch(e){next(e);}});
  app.post('/api/sync',(req,res)=>res.status(202).json(sync.start()));
  app.post('/api/pause',async(req,res,next)=>{try{res.json(await sync.pause());}catch(e){next(e);}});
  app.post('/api/bridge/pair',(req,res)=>res.json(bridge.pair()));
  app.post('/api/bridge/poll',(req,res)=>res.json({tasks:bridge.poll(req.body.token,req.body.session,req.body.runningTaskIds),portalTask:portals.claim()}));
  app.post('/api/bridge/reply',(req,res)=>{bridge.reply(req.body.token,req.body.id,req.body.response);res.json({ok:true});});
  app.get('/api/portal-flows',(req,res)=>res.json({flows:portals.list(),coverage:portals.coverage()}));
  app.get('/api/portal-flows/:id',(req,res)=>res.json(portals.get(req.params.id)));
  app.post('/api/portal-flows/scan',(req,res)=>res.json({flows:portals.inventory()}));
  app.post('/api/portal-flows/:id/open',(req,res)=>res.json(portals.open(req.params.id)));
  app.post('/api/portal-flows/:id/pause',(req,res)=>res.json(portals.pause(req.params.id)));
  app.post('/api/portal-flows/:id/skip',(req,res)=>res.json(portals.skip(req.params.id,req.body.reason)));
  app.post('/api/portal-flows/:id/report',(req,res)=>{bridge.authenticate(req.body.token);res.json(portals.report(req.params.id,req.body));});
  app.post('/api/portal-flows/:id/file',async(req,res,next)=>{try{if(req.body.filePath)bridge.authenticate(req.body.token);res.json(await portals.receive(req.params.id,req.body));}catch(e){next(e);}});
  app.get('/api/export.json',(req,res)=>{
    const state=store.read();res.set('Content-Disposition','attachment; filename="facade-tenders.json"').json(state);
  });
  app.get('/api/export.xlsx',async(req,res,next)=>{try{res.download(await exportExcel(store),'facade-tenders.xlsx');}catch(e){next(e);}});
  app.get('/api/documents/:record/:key/text',(req,res,next)=>{try{
    const doc=store.read().records.find(r=>r.id===req.params.record)?.documents.find(d=>d.key===req.params.key);
    if(!doc?.cache)return res.status(404).json({error:'This file has no extracted text yet'});
    const cached=JSON.parse(fs.readFileSync(within(root,doc.cache),'utf8'));res.type('text/plain').send(cached.text);
  }catch(e){next(e);}});
  app.get('/api/documents/:record/:key',(req,res,next)=>{try{
    const doc=store.read().records.find(r=>r.id===req.params.record)?.documents.find(d=>d.key===req.params.key);
    if(!doc?.localPath)return res.status(404).json({error:'Document is not downloaded yet'});
    res.sendFile(within(root,doc.localPath));
  }catch(e){next(e);}});
  app.use('/api',(req,res)=>res.status(404).json({error:'Unknown API route'}));
  app.use('/connector',express.static(path.resolve(__dirname,'../connector')));
  app.use(express.static(path.resolve(__dirname,'../public')));
  app.use((error,req,res,next)=>{if(res.headersSent)return next(error);res.status(error.status||500).json({error:error.message});});
  return {app,store,bridge,sync,close(){sync.stop();bridge.close();}};
}
if(require.main===module){
 (async()=>{
  const restored=await require('./data-backup.cjs').ensureSavedData();
  if(restored.restored)console.log(`Restored ${restored.records} saved tenders; no Tenderkart re-download is required.`);
  const portal=createApp(),port=Number(process.env.PORT||4070),host=process.env.HOST||'127.0.0.1';
  const server=portal.app.listen(port,host,()=>{
    console.log(`Facade lighting portal: http://localhost:${port}`);
    if(process.env.FACADE_OPEN_BROWSER==='1'&&process.platform==='win32')require('child_process').spawn('powershell.exe',['-NoProfile','-Command',`Start-Process 'http://localhost:${port}'`],{windowsHide:true,stdio:'ignore'}).on('error',()=>{});
  });
  const close=()=>{portal.close();server.close(()=>process.exit(0));};
  process.once('SIGINT',close);process.once('SIGTERM',close);
 })().catch(error=>{console.error('Startup: '+error.message);process.exitCode=1;});
}
module.exports={createApp};
