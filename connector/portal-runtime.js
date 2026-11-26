globalThis.FacadePortalRuntime=(()=>{
  const api='http://127.0.0.1:4070/api';let busy=false;
  async function post(path,body){const r=await fetch(api+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(110000)});const data=await r.json();if(!r.ok)throw new Error(data.error||'Portal action failed');return data;}
  async function report(run,state,message,extra={}){await post(`/portal-flows/${run.id}/report`,{token:run.token,state,message,...extra});}
  async function open(task,token){
    const {portalRun}=await chrome.storage.local.get('portalRun');
    if(portalRun?.id===task.id){try{await chrome.tabs.get(portalRun.tabId);await report(portalRun,'navigating','Portal tab is open; waiting for the page to finish loading.');return;}catch{}}
    let tab;try{if(portalRun?.tabId)tab=await chrome.tabs.get(portalRun.tabId);}catch{}
    if(tab)tab=await chrome.tabs.update(tab.id,{url:task.entryUrl,active:true});else tab=await chrome.tabs.create({url:task.entryUrl,active:true});
    await chrome.storage.local.set({portalRun:{...task,token,tabId:tab.id,armed:false}});
  }
  async function tick(token){
    if(busy)return;busy=true;
    try{
      let {portalRun:run}=await chrome.storage.local.get('portalRun');if(!run)return;
      const state=await(await fetch(api+`/portal-flows/${run.id}`)).json();
      if(['paused','complete','skipped'].includes(state.state)){if(['complete','skipped'].includes(state.state))await chrome.storage.local.remove('portalRun');return;}
      if(run.needsManual)return;
      if(run.downloadId){
        const [download]=await chrome.downloads.search({id:run.downloadId});
        if(download?.state==='complete'){
          try{await post(`/portal-flows/${run.id}/file`,{token,filePath:download.filename,identityConfirmed:run.userConfirmed===true});await chrome.storage.local.remove('portalRun');}
          catch(e){run.needsManual=true;run.armed=false;run.downloadId=null;await chrome.storage.local.set({portalRun:run});await report(run,'waiting_for_user',e.message+' Use Attach downloaded file in the portal app if your download folder is custom.');}
        }else if(download?.state==='interrupted'){await report(run,'failed','The browser download was interrupted by the portal.');}
        return;
      }
      let tab;try{tab=await chrome.tabs.get(run.tabId);}catch{await report(run,'failed','Portal tab was closed before the download completed.');return;}
      if(tab.status!=='complete')return;
      if(new URL(tab.url).origin!==run.origin){await report(run,'waiting_for_user','Portal redirected to another origin. Review this in the browser.');return;}
      await chrome.scripting.executeScript({target:{tabId:run.tabId},files:['portal-step.js']}).catch(e=>{throw Object.assign(e,{portalAction:true});});
      const response=await chrome.scripting.executeScript({target:{tabId:run.tabId},args:[run],func:task=>globalThis.facadePortalStep(task)}).catch(e=>{throw Object.assign(e,{portalAction:true});});
      const step=response[0]?.result;if(!step)return;
      run={...run,identityConfirmed:run.identityConfirmed||step.identityConfirmed,searchFilled:run.searchFilled||step.searchFilled};
      await report(run,step.state,step.message,{identityConfirmed:run.identityConfirmed});
      if(step.action){
        if(step.action==='download'){run.armed=true;run.armedAt=Date.now();run.expectedUrl=step.href?new URL(step.href,tab.url).href:null;}
        if(step.action==='search')run.visitedSearch=true;
        if(step.action==='details')run.visitedDetails=true;
        if(step.action==='documents')run.visitedDocuments=true;
        if(step.action==='submit_search')run.searchSubmitted=true;
        await chrome.storage.local.set({portalRun:run});
        await chrome.scripting.executeScript({target:{tabId:run.tabId},args:[run.id,step.action],func:(id,action)=>{const target=[...document.querySelectorAll(action==='download'?'[data-facade-download]':'[data-facade-navigate]')].find(e=>(action==='download'?e.dataset.facadeDownload:e.dataset.facadeNavigate)===id);target?.click();}});
      }else await chrome.storage.local.set({portalRun:run});
    }catch(error){const {portalRun}=await chrome.storage.local.get('portalRun');if(portalRun)await report(portalRun,error.portalAction?'failed':'waiting_for_user',error.message).catch(()=>{});}
    finally{busy=false;}
  }
  async function continueFromPanel(message,sender){const {portalRun:run}=await chrome.storage.local.get('portalRun');if(!run||sender.tab?.id!==run.tabId||message.flowId!==run.id)throw new Error('This is not the current portal flow');run.needsManual=false;run.visitedDetails=false;run.visitedSearch=false;run.visitedDocuments=false;await chrome.storage.local.set({portalRun:run});await tick(run.token);return{ok:true};}
  chrome.tabs.onCreated.addListener(tab=>{chrome.storage.local.get('portalRun').then(async({portalRun:run})=>{if(!run||tab.openerTabId!==run.tabId)return;try{if(new URL(tab.url||tab.pendingUrl).origin!==run.origin)return;}catch{return;}run.tabId=tab.id;await chrome.storage.local.set({portalRun:run});}).catch(()=>{});});
  chrome.downloads.onCreated.addListener(download=>{
    (async()=>{
      const {portalRun:run}=await chrome.storage.local.get('portalRun');if(!run?.armed||run.downloadId||Date.now()-run.armedAt>10*60*1000)return;
      let related=false;try{related=new URL(download.referrer).origin===run.origin;}catch{}
      if(!related&&run.expectedUrl)related=download.url===run.expectedUrl;
      if(!related)return;
      // Bind only a filename match, or let the server verify a known checksum.
      const name=String(download.filename||'').split(/[\\/]/).pop().toLowerCase();
      if(!run.expectedSha256&&name&&name!==run.name.toLowerCase())return;
      run.downloadId=download.id;await chrome.storage.local.set({portalRun:run});await report(run,'downloading','Browser download detected; it will be validated before attachment.',{downloadId:download.id,identityConfirmed:run.identityConfirmed});
    })().catch(()=>{});
  });
  chrome.downloads.onChanged.addListener(()=>{chrome.storage.local.get('portalRun').then(({portalRun})=>{if(portalRun)tick(portalRun.token);});});
  return{open,tick,continueFromPanel};
})();
