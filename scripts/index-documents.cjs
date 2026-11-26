const path=require('path');
const {createStore}=require('../server/store.cjs');
const {extract}=require('../server/documents.cjs');
const {exportExcel}=require('../server/export.cjs');
async function main(){
  const store=createStore(process.env.FACADE_DATA_DIR||path.resolve(__dirname,'../data'));
  let indexed=0,manual=0,failed=0;
  for(const record of store.read().records)for(const doc of record.documents){
    if(!doc.localPath)continue;
    let next;
    try{next=await extract(doc,store.root);if(next.status==='indexed')indexed++;else manual++;}
    catch(error){next={...doc,status:'failed',error:error.message};failed++;}
    store.save(s=>{const r=s.records.find(r=>r.id===record.id);r.documents[r.documents.findIndex(d=>d.key===doc.key)]=next;});
    if((indexed+manual+failed)%20===0)console.log(`Processed ${indexed+manual+failed} documents`);
  }
  await exportExcel(store);console.log(JSON.stringify({indexed,manual,failed}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
