(()=>{
  const section=document.createElement('section');section.className='sync-panel portal-section';section.setAttribute('aria-label','Portal document downloads');
  section.innerHTML='<h2>Portal document downloads</h2><p>Use a saved portal flow when a document needs its original website, login or CAPTCHA. One browser flow runs at a time. Enter CAPTCHAs directly on the portal; the script never reads or fills them.</p><div class="sync-actions"><button id="portal-scan">Find documents needing a portal</button><button id="portal-next">Open next queued flow</button><label>Show <select id="portal-filter"><option value="pending">Pending</option><option value="all">All</option><option value="complete">Completed</option></select></label><strong id="portal-count"></strong></div><p id="portal-notice" role="status"></p><details><summary>Portal adapters and verification status</summary><ul id="portal-coverage"></ul></details><div id="portal-list" class="flow-list"></div><button id="portal-more" hidden>Show more flows</button>';
  document.querySelector('.filters').before(section);
  const q=id=>document.getElementById(id);let flows=[],fingerprint='',limit=15,pollBusy=false;
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function request(path,body){const response=await fetch('/api/portal-flows'+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw new Error(data.error||'Portal operation failed');return data;}
  function render(){
    const filter=q('portal-filter').value;
    const pending=flows.filter(f=>!['complete','skipped','needs_adapter'].includes(f.state));q('portal-count').textContent=`${pending.length} pending · ${flows.filter(f=>f.state==='complete').length} completed · ${flows.filter(f=>f.state==='skipped').length} skipped · ${flows.filter(f=>f.state==='needs_adapter').length} need a script`;
    const shown=flows.filter(f=>filter==='all'||(filter==='complete'?f.state==='complete':!['complete','skipped','needs_adapter'].includes(f.state)));
    shown.sort((a,b)=>Number(b.state.startsWith('waiting')||b.state==='downloading')-Number(a.state.startsWith('waiting')||a.state==='downloading'));
    q('portal-more').hidden=shown.length<=limit;
    q('portal-list').innerHTML=shown.slice(0,limit).map(f=>`<article data-flow="${esc(f.id)}"><strong>${esc(f.identifier)}</strong><p>${esc(f.name)} · ${esc(f.adapter)} · <span class="badge ${f.state==='complete'?'':'partial'}">${esc(f.state.replaceAll('_',' '))}</span></p><p>${esc(f.message||'')}</p>${!['complete','needs_adapter'].includes(f.state)?`<div class="sync-actions"><button data-open>Open / reopen flow</button><button data-pause>Pause flow</button><button data-skip>Skip tender after error</button><label>Attach downloaded file <input data-file type="file"></label></div><label class="flow-confirm"><input type="checkbox" data-confirm> I verified this is the requested tender and document.</label>`:''}</article>`).join('')||'<p>No flows in this view.</p>';
  }
  async function refresh(){if(pollBusy)return;pollBusy=true;try{const data=await request('');flows=data.flows;const hash=JSON.stringify(flows);if(hash!==fingerprint&&!document.activeElement?.closest('.flow-list')){fingerprint=hash;render();}q('portal-coverage').innerHTML=data.coverage.map(c=>`<li><strong>${esc(c.name)}</strong> — ${esc(c.verification)}<br><small>${esc(c.hosts.join(', '))}</small></li>`).join('');}catch(e){q('portal-notice').textContent=e.message;}finally{pollBusy=false;}}
  async function action(fn){try{q('portal-notice').textContent='Working…';await fn();fingerprint='';await refresh();q('portal-notice').textContent='Ready. Complete any CAPTCHA or login in the portal tab that opens.';}catch(e){q('portal-notice').textContent=e.message;}}
  q('portal-scan').onclick=()=>action(()=>request('/scan',{}));
  q('portal-next').onclick=()=>action(async()=>{const next=flows.find(f=>['queued','paused','failed','waiting_for_user'].includes(f.state));if(!next)throw new Error('No queued flow. Scan for documents first.');await request('/'+encodeURIComponent(next.id)+'/open',{});});
  q('portal-filter').onchange=()=>{limit=15;render();};q('portal-more').onclick=()=>{limit+=15;render();};
  q('portal-list').addEventListener('click',event=>{const card=event.target.closest('[data-flow]');if(!card)return;if(event.target.matches('[data-open]'))action(()=>request('/'+card.dataset.flow+'/open',{}));if(event.target.matches('[data-pause]'))action(()=>request('/'+card.dataset.flow+'/pause',{}));if(event.target.matches('[data-skip]'))action(()=>request('/'+card.dataset.flow+'/skip',{reason:'Skipped by the user after a portal error.'}));});
  q('portal-list').addEventListener('change',async event=>{
    if(!event.target.matches('[data-file]'))return;const card=event.target.closest('[data-flow]'),file=event.target.files[0];if(!file)return;
    if(!card.querySelector('[data-confirm]').checked){q('portal-notice').textContent='Confirm the tender and document before attaching the file.';event.target.value='';return;}
    if(file.size>100*1024*1024){q('portal-notice').textContent='Maximum file size is 100 MB.';return;}
    await action(async()=>{await request('/'+card.dataset.flow+'/open',{});const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});await request('/'+card.dataset.flow+'/file',{fileName:file.name,base64,identityConfirmed:true});});
  });
  refresh();setInterval(refresh,5000);
})();
