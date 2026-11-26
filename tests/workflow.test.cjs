const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const ExcelJS=require('exceljs');
const {createStore,atomic}=require('../server/store.cjs');
const {mergeListing,normalize,documentCandidates,mergeDocuments}=require('../server/normalize.cjs');
const {createSync}=require('../server/sync.cjs');
const {createBridge}=require('../server/bridge.cjs');
const {extract,within,publicAddress,download}=require('../server/documents.cjs');
const {createApp}=require('../server/index.cjs');
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'facade-test-'));
const raw=(id='11111111-1111-4111-8111-111111111111')=>({id,title:'Facade light 100 W',tender_id:'GEM/2026/B/1',department:'Works',status:'active'});
const list=(data,total=data.length,pages=1)=>({data,meta:{total,pages}});

test('atomic JSON checkpoints retain a previous valid snapshot and refuse corrupt input',()=>{
  const root=tmp(),s=createStore(root);s.save(x=>x.records.push(normalize(raw())));s.save(x=>x.records[0].review.comment='Keep this');
  assert.equal(createStore(root).read().records[0].review.comment,'Keep this');
  assert.equal(JSON.parse(fs.readFileSync(s.file+'.bak')).records[0].review.comment,'');
  fs.writeFileSync(s.file,'{broken');assert.throws(()=>createStore(root));assert.equal(fs.readFileSync(s.file,'utf8'),'{broken');
});
test('listing upserts retain review, richer fields, documents and closed saved records',()=>{
  const record=normalize(raw());record.fields['Authority Contact']='Existing buyer';record.review={status:'Eligible',comment:'Our note'};record.documents=[{key:'doc',localPath:'documents/a.pdf'}];
  const rows=[record];mergeListing(rows,{...raw(),title:'Updated title'});
  assert.equal(rows.length,1);assert.equal(rows[0].review.comment,'Our note');assert.equal(rows[0].fields['Authority Contact'],'Existing buyer');assert.equal(rows[0].documents.length,1);
  mergeListing(rows,{...raw('22222222-2222-4222-8222-222222222222'),tender_id:'GEM/2026/B/2'});assert.equal(rows.length,2);
});
test('document discovery accepts known links without inventing absent endpoints',()=>{
  const docs=documentCandidates({documents:[{download_url:'/api/files/one.pdf',file_name:'one.pdf'},{url:'javascript:alert(1)'},{id:'opaque'}]});
  assert.equal(docs.length,1);assert.equal(docs[0].url,'https://tenderkart.in/api/files/one.pdf');
});
test('live GeM references and nested archived documents are mapped without duplicating saved PDFs',()=>{
  const hash='a'.repeat(64),source={...raw(),tender_id:'10147253',tender_reference_number:'GEM/2026/B/8257891',portal_base_url:'https://bidplus.gem.gov.in',extended_data:{documents:{nit:[{name:'bid_10147253.pdf',download_url:'/showbidDocument/10147253',checksum_sha256:hash}]},gem_data:{additional_documents:[{name:'attachment.pdf',path:'gem/10147253/attachment.pdf'}]}}};
  const record=normalize(source);assert.equal(record.identifier,'GEM/2026/B/8257891');assert.equal(record.fields['Tender ID'],record.identifier);
  const docs=documentCandidates(source);assert.equal(docs.length,2);assert.equal(docs[0].url,'https://bidplus.gem.gov.in/showbidDocument/10147253');assert.equal(docs[1].url,null);assert.equal(docs[1].status,'manual_review');
  const merged=mergeDocuments([{key:'original',name:'GeM_Bid_Document.pdf',sha256:hash,localPath:'documents/original.pdf',status:'indexed'}],docs);assert.equal(merged.length,2);assert.equal(merged[0].localPath,'documents/original.pdf');assert.equal(merged[0].key,'original');
});
test('full sync persists a page, refreshes details, reads a file and exports Excel',async()=>{
  const store=createStore(tmp()),record=normalize(raw());record.documents=[{key:'doc',name:'boq.csv',localPath:'documents/boq.csv',status:'downloaded'}];store.save(s=>s.records=[record]);atomic(path.join(store.root,'documents/boq.csv'),'Facade lighting,100 watt\nExperience,2 years');
  const sync=createSync({store,interval:0,bridge:{status:()=>({connected:true}),request:async p=>p.includes('?')?list([raw()]):raw()}});
  sync.start();for(let i=0;i<8;i++)await sync.tick();
  assert.equal(store.read().job.state,'complete');assert(store.read().lastSuccessfulSync);assert.equal(store.read().records.length,1);assert.equal(store.read().records[0].documents[0].status,'indexed');
  const book=new ExcelJS.Workbook();await book.xlsx.readFile(path.join(store.root,'exports/tenders.xlsx'));assert.equal(book.getWorksheet('Tenders').rowCount,2);assert(book.getWorksheet('Document evidence').rowCount>1);sync.stop();
});
test('restart resumes the saved next page and queue without dropping old records',async()=>{
  const root=tmp(),store=createStore(root);const requests=[];
  const bridge={status:()=>({connected:true}),request:async p=>{requests.push(p);if(p.includes('page=1'))return list([raw()],2,2);if(p.includes('page=2'))return list([{...raw('22222222-2222-4222-8222-222222222222'),tender_id:'GEM/2026/B/2'}],2,2);return {...raw(p.split('/').pop()),tender_id:p.includes('2222')?'GEM/2026/B/2':'GEM/2026/B/1'};}};
  let sync=createSync({store,bridge,interval:0});sync.start();await sync.tick();assert.equal(store.read().job.page,2);sync.stop();
  const resumed=createStore(root);sync=createSync({store:resumed,bridge,interval:0});await sync.tick();assert(requests[1].includes('page=2'));assert.equal(resumed.read().records.length,2);sync.stop();
});
test('rate limits keep the cursor and honor retry time',async()=>{
  let clock=1000,calls=0;const store=createStore(tmp());const sync=createSync({store,interval:0,now:()=>clock,bridge:{status:()=>({connected:true}),request:async()=>{calls++;throw Object.assign(new Error('Daily quota'),{status:429,retryAfterMs:3600000});}}});
  sync.start();await sync.tick();assert.equal(store.read().job.state,'rate_limited');assert.equal(store.read().job.page,1);sync.start();await sync.tick();assert.equal(calls,1);clock+=3600001;await sync.tick();assert.equal(calls,2);sync.stop();
});
test('pause during an in-flight response saves its records and Excel, then stays paused on restart',async()=>{
  let release;const response=new Promise(resolve=>release=resolve),store=createStore(tmp());
  const sync=createSync({store,interval:0,bridge:{status:()=>({connected:true}),request:()=>response}});sync.start();const work=sync.tick();await new Promise(resolve=>setImmediate(resolve));const paused=sync.pause();release(list([raw()],2,2));await Promise.all([work,paused]);
  assert.equal(store.read().job.state,'paused');assert.equal(store.read().job.page,2);assert.equal(store.read().records.length,1);assert(fs.existsSync(path.join(store.root,'exports/tenders.xlsx')));
  const resumed=createSync({store:createStore(store.root),interval:0,bridge:{status:()=>({connected:true}),request:()=>{throw new Error('Must stay paused');}}});await resumed.tick();assert.equal(createStore(store.root).read().job.state,'paused');sync.stop();resumed.stop();
});
test('mismatched tender detail never overwrites the original tender',async()=>{
  const store=createStore(tmp());store.save(s=>s.records=[normalize(raw())]);let request=0;
  const sync=createSync({store,interval:0,bridge:{status:()=>({connected:true}),request:async()=>++request===1?list([]):{...raw(),tender_id:'GEM/2026/B/DIFFERENT'}}});sync.start();await sync.tick();await sync.tick();assert.equal(store.read().records[0].identifier,'GEM/2026/B/1');assert.equal(store.read().records[0].detailState,'manual_review');sync.stop();
});
test('cached XLSX extraction is reusable and document paths/private URLs are constrained',async()=>{
  const root=tmp(),book=new ExcelJS.Workbook();book.addWorksheet('BOQ').addRow(['Facade lighting','100 watt']);atomic(path.join(root,'documents/a.xlsx'),Buffer.from(await book.xlsx.writeBuffer()));
  const doc={key:'a',name:'a.xlsx',localPath:'documents/a.xlsx'};const first=await extract(doc,root),second=await extract(doc,root);assert.equal(first.status,'indexed');assert.equal(first.sha256,second.sha256);assert.equal(first.extractedAt,second.extractedAt);assert.throws(()=>within(root,'../secret'));assert.equal(publicAddress('127.0.0.1'),false);assert.equal(publicAddress('10.1.2.3'),false);assert.equal(publicAddress('::1'),false);assert.equal(publicAddress('8.8.8.8'),true);
});
test('bridge only accepts authenticated replies to supported tasks',async()=>{
  const bridge=createBridge({pace:0,timeout:1000}),pair=bridge.pair();bridge.poll(pair.token,true);
  await assert.rejects(()=>bridge.request('/api/private'),/Unsupported/);
  const promise=bridge.request('/api/v1/tenders?status=active');await new Promise(resolve=>setTimeout(resolve,10));const [task]=bridge.poll(pair.token,true);assert(task);assert.throws(()=>bridge.reply('wrong',task.id,{}));bridge.reply(pair.token,task.id,{status:200,data:list([])});assert.deepEqual(await promise,list([]));bridge.close();
});
test('saved local pairing survives restart without storing Tenderkart login tokens',()=>{
  const pairingFile=path.join(tmp(),'pairing.json');let bridge=createBridge({pairingFile});const pair=bridge.pair();bridge.close();bridge=createBridge({pairingFile});assert.doesNotThrow(()=>bridge.poll(pair.token,true));assert.equal(bridge.status().connected,true);assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(pairingFile))),['token']);bridge.close();
});
test('source checksum rejects a wrong downloaded file before saving it',async()=>{
  const root=tmp(),book=new ExcelJS.Workbook();book.addWorksheet('BOQ').addRow(['Facade light',100]);const bytes=Buffer.from(await book.xlsx.writeBuffer());
  const doc={key:'boq',name:'boq.xlsx',url:'https://tenderkart.in/download/example',expectedSha256:'0'.repeat(64)};
  await assert.rejects(()=>download(doc,root,{identifier:'GEM/2026/B/1'},async()=>({base64:bytes.toString('base64')})),/checksum/);
  assert(!fs.existsSync(path.join(root,'documents')));
});
test('standalone API and UI work, untrusted origins cannot pair, extension origins can',async t=>{
  const portal=createApp({root:tmp(),interval:0}),server=portal.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>{portal.close();server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base)).status,200);assert.deepEqual(await(await fetch(base+'/api/tenders')).json(),[]);
  assert.equal((await fetch(base+'/api/bridge/pair',{method:'POST',headers:{Origin:'https://untrusted.example'}})).status,403);
  assert.equal((await fetch(base+'/api/bridge/pair',{method:'POST',headers:{Origin:'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}})).status,200);
  const missing=await fetch(base+'/api/missing');assert.equal(missing.status,404);assert.match(missing.headers.get('content-type'),/json/);
});
