document.querySelector('#version').textContent='Connector version '+chrome.runtime.getManifest().version;
document.querySelector('#diagnose').onclick=async()=>{try{const result=await chrome.runtime.sendMessage({action:'status'});document.querySelector('#status').textContent=result.error||'No connector error reported.';}catch(error){document.querySelector('#status').textContent=error.message;}};
document.querySelector('#connect').addEventListener('click',async()=>{
  const button=document.querySelector('#connect'),status=document.querySelector('#status');button.disabled=true;status.textContent='Connecting to the facade portal on port 4070…';
  try{const result=await chrome.runtime.sendMessage({action:'connect',open:true});status.textContent=result.error||'Connected. Sign into Tenderkart if needed, then return to the facade portal.';}
  catch{status.textContent='Could not reach the connector. Reload this extension and try again.';}
  finally{button.disabled=false;}
});
