const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),path=require('path'),vm=require('vm');

test('real connector loop sends another heartbeat while its Tenderkart request is still unresolved',async()=>{
  const values={token:'paired-token',enabled:true},intervals=[];let polls=0,replies=0,resolveFetch;
  const longRequest=new Promise(resolve=>resolveFetch=resolve);
  const chrome={
    storage:{local:{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,values[k]])),set:async data=>Object.assign(values,data),remove:async key=>{delete values[key];}}},
    tabs:{query:async()=>[{id:1}],update:async()=>({id:1})},
    scripting:{executeScript:async options=>options.args?longRequest:[{result:true}]},
    alarms:{create(){},onAlarm:{addListener(){}}},runtime:{onMessage:{addListener(){}}},
  };
  const fetch=async url=>{
    if(url.endsWith('/poll')){polls++;return{ok:true,json:async()=>({tasks:polls===1?[{id:'long-task',kind:'json',path:'/api/v1/tenders?status=active'}]:[]})};}
    if(url.endsWith('/reply')){replies++;return{ok:true};}throw new Error('Unexpected request: '+url);
  };
  const context={chrome,fetch,importScripts(){},FacadePortalRuntime:{open:async()=>{},tick:async()=>{}},setInterval:fn=>intervals.push(fn),AbortSignal,URL,console};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../connector/background.js'),'utf8'),context);
  for(let n=0;n<10&&polls<1;n++)await new Promise(r=>setImmediate(r));
  assert.equal(polls,1);assert.equal(replies,0);
  await intervals[0]();assert.equal(polls,2);assert.equal(replies,0);
  resolveFetch([{result:{status:200,data:{data:[],meta:{total:0}}}}]);
  for(let n=0;n<10&&replies<1;n++)await new Promise(r=>setImmediate(r));
  assert.equal(replies,1);assert.equal(values.pendingReply,undefined);
});
