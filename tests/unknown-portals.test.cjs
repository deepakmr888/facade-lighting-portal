const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {createStore}=require('../server/store.cjs'),{createPortalFlows}=require('../server/portal-flows.cjs'),{createSync}=require('../server/sync.cjs');
const adapters=require('../connector/portal-adapters.js');
function fixture(){const store=createStore(fs.mkdtempSync(path.join(os.tmpdir(),'facade-new-portal-')));store.save(s=>s.records=[{id:'new',sourceId:'11111111-1111-4111-8111-111111111111',identifier:'NEW-001',fields:{Description:'Saved metadata'},portalUrl:'https://new-portal.example/',review:{status:'Eligible',comment:'Keep this'},documents:[{key:'saved',name:'existing.pdf',localPath:'documents/existing.pdf',status:'indexed'},{key:'pending',name:'new.pdf',url:'https://new-portal.example/new.pdf',status:'pending'}]}]);return store;}
test('unknown portal retains metadata and saved PDFs while direct URLs are deferred and never claimed',()=>{
 const store=fixture(),p=createPortalFlows(store);p.inventory();const record=store.read().records[0];assert.equal(record.fields.Description,'Saved metadata');assert.equal(record.review.comment,'Keep this');assert.equal(record.documents[0].status,'indexed');assert.equal(record.documents[1].status,'needs_adapter');assert.equal(record.documentDownloadPolicy.code,'no_portal_script');assert.equal(p.list().length,1);assert.equal(p.list()[0].state,'needs_adapter');assert.equal(p.claim(),null);assert.throws(()=>p.open(p.list()[0].id),/no script/);
});
test('registering an adapter makes deferred records eligible without deleting or duplicating them',()=>{
 const store=fixture(),p=createPortalFlows(store);const original=p.list()[0].id;adapters.definitions.push({id:'future-test',hosts:['new-portal.example'],name:'Future script',search:[]});
 try{p.inventory();assert.equal(p.list().length,1);assert.equal(p.list()[0].id,original);assert.equal(p.list()[0].state,'queued');assert.equal(store.read().records[0].documentDownloadPolicy,undefined);assert.equal(store.read().records[0].documents[1].status,'pending');}finally{adapters.definitions.pop();}
});
test('sync refreshes Tenderkart metadata for unknown portals but bypasses their document requests',async()=>{
 const store=fixture();store.save(s=>{s.records[0].documents=s.records[0].documents.filter(d=>!d.localPath);});const p=createPortalFlows(store);const raw={id:store.read().records[0].sourceId,tender_id:'NEW-001',title:'New facade light tender',portal_base_url:'https://new-portal.example',status:'active',description:'Updated Tenderkart metadata'};
 const sync=createSync({store,portals:p,interval:0,bridge:{status:()=>({connected:true}),request:async url=>url.includes('?')?{data:[raw],meta:{total:1,pages:1}}:raw}});
 sync.start();for(let n=0;n<8;n++)await sync.tick();assert.equal(store.read().records.length,1);assert.equal(store.read().records[0].fields.Description,'Updated Tenderkart metadata');assert.equal(store.read().records[0].documents[0].status,'needs_adapter');assert.equal(store.read().job.state,'partial');sync.stop();
});
