const base='http://127.0.0.1:4070/api/bridge';
importScripts('portal-adapters.js','portal-runtime.js');
let busy=false,taskBusy=false,lastError='',activeTask=null;
async function connect(open=false){
  let response;try{response=await fetch(base+'/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(8000)});}catch{throw new Error('Facade portal server is not reachable. Start facade-lighting-portal/start.cmd, open http://localhost:4070, then reconnect. This connector uses port 4070, not the original tracker port 4000.');}
  if(!response.ok)throw new Error('Start the facade portal first.');
  const token=(await response.json()).token;
  const {pendingReply}=await chrome.storage.local.get('pendingReply');
  await chrome.storage.local.set({token,enabled:true,...(pendingReply?{pendingReply:{...pendingReply,token}}:{})});
  if(open){const tabs=await chrome.tabs.query({url:'https://tenderkart.in/*'});if(tabs[0])await chrome.tabs.update(tabs[0].id,{active:true});else await chrome.tabs.create({url:'https://tenderkart.in/tenders/filters?keywords=facade+light&mode=live'});}
  lastError='';
}
async function runInTab(tabId,task){
  const result=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',args:[task],func:async(task)=>{
    let token=localStorage.getItem('CapacitorStorage.tk_auth_token');try{token=JSON.parse(token);}catch{}
    if(!token)return{status:401,error:'Sign into Tenderkart first.'};
    try{
      let address;
      if(task.kind==='json'){
        if(!/^\/api\/v1\/tenders(?:\?[^\s#]*|\/[a-f0-9-]{36})$/i.test(task.path))return{status:400,error:'Unsupported API path'};
        address=task.path;
      }else if(task.kind==='download'){
        const url=new URL(task.url);
        if(url.origin!=='https://tenderkart.in')return{status:400,error:'Unsupported document origin'};
        address=url.href;
      }else return{status:400,error:'Unsupported browser task'};
      const response=await fetch(address,{headers:{Authorization:`Bearer ${token}`},credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(80000)});
      if(!response.ok)return{status:response.status,retryAfter:response.headers.get('retry-after'),error:`Tenderkart HTTP ${response.status}. Check login, account limits or verification in its tab.`};
      if(task.kind==='download'){
        const blob=await response.blob();if(blob.size>100*1024*1024)return{status:413,error:'Document exceeds 100 MB'};
        const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=reject;reader.readAsDataURL(blob);});
        return{status:response.status,data:{base64}};
      }
      if(!(response.headers.get('content-type')||'').includes('json'))return{status:502,reason:'verification',error:'Open Tenderkart to complete login or security verification, then click Sign in / reconnect.'};
      return{status:response.status,data:await response.json()};
    }catch{return{status:502,error:'Tenderkart request failed or the tab navigated. Check its tab.'};}
  }});
  return result[0]?.result||{status:502,error:'Tenderkart did not respond'};
}
async function saveReply(token,id,response){
  await chrome.storage.local.set({pendingReply:{token,id,response}});
  await flushReply();
}
async function flushReply(){
  const {pendingReply}=await chrome.storage.local.get('pendingReply');if(!pendingReply)return;
  const sent=await fetch(base+'/reply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(pendingReply),signal:AbortSignal.timeout(15000)});
  if(sent.ok)await chrome.storage.local.remove('pendingReply');
  else throw new Error('The portal could not save the response. It will retry the saved reply.');
}
async function tick(){
  if(busy)return;busy=true;
  try{
    const {token,enabled}=await chrome.storage.local.get(['token','enabled']);if(!enabled||!token)return;
    try{await flushReply();}catch(error){lastError=error.message;}
    const tabs=await chrome.tabs.query({url:'https://tenderkart.in/*'});let tab,session=false;
    for(const candidate of tabs){
      try{const result=await chrome.scripting.executeScript({target:{tabId:candidate.id},world:'MAIN',func:()=>{let v=localStorage.getItem('CapacitorStorage.tk_auth_token');try{v=JSON.parse(v);}catch{}return Boolean(v)&&!/just a moment|security verification/i.test(document.title);}});if(result[0]?.result){tab=candidate;session=true;break;}}catch{}
    }
    // This heartbeat is independent of long Tenderkart requests and portal CAPTCHAs.
    const poll=await fetch(base+'/poll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,session,runningTaskIds:activeTask?[activeTask]:[]}),signal:AbortSignal.timeout(12000)});
    if(!poll.ok)throw new Error('Reconnect from the facade portal.');
    const payload=await poll.json();
    if(tab)await chrome.tabs.update(tab.id,{autoDiscardable:false}).catch(()=>{});
    if(payload.portalTask){try{await FacadePortalRuntime.open(payload.portalTask,token);}catch(error){await fetch('http://127.0.0.1:4070/api/portal-flows/'+payload.portalTask.id+'/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,state:'waiting_for_user',message:'Chrome could not open the portal flow: '+error.message+'. Reload connector version 1.1.0 and check its site/download permissions.'})});}}
    FacadePortalRuntime.tick(token).catch(error=>{lastError=error.message;});
    if(!taskBusy)for(const task of payload.tasks){
      taskBusy=true;activeTask=task.id;
      (async()=>{try{let response;try{response=tab?await runInTab(tab.id,task):{status:401,error:'Sign into Tenderkart and leave its tab open.'};}catch{response={status:502,error:'Tenderkart tab closed or navigated. Reopen its tab.'};}await saveReply(token,task.id,response);}catch(error){lastError=error.message;}finally{taskBusy=false;activeTask=null;}})();break;
    }
    lastError=session?'':'Sign into Tenderkart in this browser.';
  }catch(error){lastError=error.message;}finally{busy=false;}
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(message.action==='portal-continue'){FacadePortalRuntime.continueFromPanel(message,sender).then(respond).catch(e=>respond({error:e.message}));return true;}
  if(sender.url&&!/^http:\/\/(?:localhost|127\.0\.0\.1):4070\//.test(sender.url)&&!sender.url.startsWith(chrome.runtime.getURL('')))return;
  (async()=>{if(message.action==='connect')await connect(Boolean(message.open));tick();return{ok:true,error:lastError};})().then(respond).catch(error=>respond({error:error.message}));return true;
});
chrome.alarms.create('facade-sync',{periodInMinutes:0.5});chrome.alarms.onAlarm.addListener(tick);setInterval(tick,5000);tick();
