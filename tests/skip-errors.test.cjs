const{test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const{createStore}=require('../server/store.cjs'),{createPortalFlows}=require('../server/portal-flows.cjs');
test('portal error skips remaining files for that tender, preserves saved PDFs, and advances to another tender',()=>{
 const store=createStore(fs.mkdtempSync(path.join(os.tmpdir(),'facade-skip-')));
 store.save(s=>s.records=['one','two'].map(id=>({id,identifier:id,portalUrl:'https://etender.up.nic.in/nicgep/app',fields:{},documents:[{key:'saved',name:'saved.pdf',localPath:'documents/saved.pdf',status:'indexed'},{key:'a',name:'a.pdf'},{key:'b',name:'b.pdf'}]})));
 const p=createPortalFlows(store);p.inventory();const first=p.list().find(f=>f.recordId==='one');p.open(first.id);p.claim();p.report(first.id,{state:'failed',message:'Portal returned 500'});
 assert(p.list().filter(f=>f.recordId==='one').every(f=>f.state==='skipped'));assert.equal(store.read().records[0].documents[0].status,'indexed');assert.equal(store.read().records[0].documents[1].status,'skipped');assert.equal(p.claim().recordId,'two');
 p.report(first.id,{state:'navigating',message:'Late reply'});assert.equal(p.get(first.id).state,'skipped');const count=p.list().length;p.inventory();assert.equal(p.list().length,count);
});
