const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto');
const {createStore}=require('../server/store.cjs');
const {createBridge}=require('../server/bridge.cjs');
const {createPortalFlows}=require('../server/portal-flows.cjs');
const adapters=require('../connector/portal-adapters.js');
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'facade-portal-test-'));
function setup(hash){
  const store=createStore(tmp());store.save(s=>s.records=[{id:'record',identifier:'2026_PWD_123_1',fields:{},review:{status:'Eligible',comment:'Keep this'},portalUrl:'https://etender.up.nic.in/nicgep/app',documents:[{key:'doc',name:'boq.csv',expectedSha256:hash,status:'portal_required'}]}]);
  const portals=createPortalFlows(store),flow=portals.queue(store.read().records[0],store.read().records[0].documents[0]);return{store,portals,flow};
}
test('90-second heartbeat tolerates long requests and a 30-second MV3 wakeup',()=>{
  let now=1000;const bridge=createBridge({now:()=>now}),pair=bridge.pair();bridge.poll(pair.token,true);now+=30000;assert.equal(bridge.status().connected,true);now+=30000;assert.equal(bridge.status().connected,true);now+=31000;assert.equal(bridge.status().connected,false);bridge.close();
});
test('repeat Connect preserves pairing and an in-flight API task',async()=>{
  const bridge=createBridge({pace:0}),pair=bridge.pair();bridge.poll(pair.token,true);const work=bridge.request('/api/v1/tenders?status=active');await new Promise(r=>setTimeout(r,10));const [task]=bridge.poll(pair.token,true);assert.equal(bridge.pair().token,pair.token);bridge.reply(pair.token,task.id,{status:200,data:{ok:true}});assert.deepEqual(await work,{ok:true});bridge.close();
});
test('authentication failure stays visible across heartbeats until explicitly rechecked',async()=>{
  const bridge=createBridge({pace:0}),pair=bridge.pair();bridge.poll(pair.token,true);const work=bridge.request('/api/v1/tenders?status=active');const rejected=assert.rejects(work,/verification/);await new Promise(r=>setTimeout(r,10));const [task]=bridge.poll(pair.token,true);bridge.reply(pair.token,task.id,{status:403,error:'Security verification'});await rejected;bridge.poll(pair.token,true);assert.equal(bridge.status().connected,false);assert.equal(bridge.status().reason,'tenderkart_auth_required');bridge.pair();assert.equal(bridge.status().connected,true);bridge.close();
});
test('lost service-worker dispatch is leased again, but active long work is not duplicated',async()=>{
  let now=1000;const bridge=createBridge({pace:0,now:()=>now}),pair=bridge.pair();bridge.poll(pair.token,true);const work=bridge.request('/api/v1/tenders?status=active');await new Promise(r=>setTimeout(r,10));const [task]=bridge.poll(pair.token,true);now+=46000;assert.equal(bridge.poll(pair.token,true,[task.id]).length,0);assert.equal(bridge.poll(pair.token,true,[])[0].id,task.id);bridge.reply(pair.token,task.id,{status:200,data:{ok:true}});await work;bridge.close();
});
test('all 26 observed hosts have a named adapter, with NIC session links replaced by a clean search URL',()=>{
  assert.equal(new Set(adapters.definitions.flatMap(a=>a.hosts)).size,26);
  const record={portalUrl:'https://etender.up.nic.in/nicgep/app',raw:{tender_link:'https://etender.up.nic.in/nicgep/app?session=expired'}};
  assert.equal(adapters.entry(record),'https://etender.up.nic.in/nicgep/app?page=FrontEndAdvancedSearch&service=page');assert.equal(adapters.forHost('unconfigured.example'),null);
});
test('CAPTCHA waiting and pause survive restart; only one portal tab may run',()=>{
  const {store,portals,flow}=setup();portals.open(flow.id);assert(portals.claim());assert.equal(portals.claim(),null);portals.report(flow.id,{state:'waiting_for_captcha',message:'Enter manually'});const resumed=createPortalFlows(createStore(store.root));assert.equal(resumed.get(flow.id).state,'waiting_for_captcha');resumed.pause(flow.id);assert.equal(resumed.get(flow.id).state,'paused');
});
test('a portal handoff lost during extension reload is retried after its lease expires',()=>{
  const {store,portals,flow}=setup();portals.open(flow.id);assert(portals.claim());assert.equal(portals.claim(),null);store.save(s=>s.portalFlows[0].updatedAt=new Date(Date.now()-31000).toISOString());assert.equal(portals.claim().id,flow.id);
});
test('checksum mismatch never assigns a wrong file; matching download saves evidence and Excel',async()=>{
  const bytes=Buffer.from('Facade lighting,100 watt\nExperience,2 years'),hash=crypto.createHash('sha256').update(bytes).digest('hex');const {store,portals,flow}=setup(hash);portals.open(flow.id);portals.claim();
  await assert.rejects(()=>portals.receive(flow.id,{base64:Buffer.from('Wrong file').toString('base64'),fileName:'boq.csv'}),/checksum/);assert(!store.read().records[0].documents[0].localPath);
  const complete=await portals.receive(flow.id,{base64:bytes.toString('base64'),fileName:'boq.csv'});assert.equal(complete.state,'complete');assert.equal(store.read().records[0].review.comment,'Keep this');assert.equal(store.read().records[0].documents[0].status,'indexed');assert(fs.existsSync(path.join(store.root,'exports/tenders.xlsx')));
  assert.equal((await portals.receive(flow.id,{})).state,'complete');
});
test('a checksum-free file requires explicit identity and exact filename, and server paths stay in Downloads',async()=>{
  const {portals,flow}=setup();portals.open(flow.id);portals.claim();const base64=Buffer.from('Facade lighting quantities,100 watt and cable').toString('base64');
  await assert.rejects(()=>portals.receive(flow.id,{base64,fileName:'boq.csv'}),/Confirm/);
  await assert.rejects(()=>portals.receive(flow.id,{base64,fileName:'other.csv',identityConfirmed:true}),/filename/);
  await assert.rejects(()=>portals.receive(flow.id,{filePath:path.join(os.homedir(),'.ssh','id_rsa')}),/outside/);
  await portals.receive(flow.id,{base64,fileName:'boq.csv',identityConfirmed:true});
});
