window.addEventListener('message',event=>{
  if(event.source!==window||event.origin!==location.origin||event.data?.type!=='facade:connect')return;
  chrome.runtime.sendMessage({action:'connect'}).then(result=>window.postMessage({type:'facade:connection',...result},location.origin)).catch(()=>{});
});
window.postMessage({type:'facade:connector-ready',version:chrome.runtime.getManifest().version},location.origin);
setInterval(()=>window.postMessage({type:'facade:connector-ready',version:chrome.runtime.getManifest().version},location.origin),3000);
