const el=id=>document.getElementById(id),escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=value=>value&&!Number.isNaN(Date.parse(value))?new Date(value).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}):'Not listed';
const href=value=>{try{const u=new URL(value,location.origin);return ['http:','https:'].includes(u.protocol)?escapeHtml(u.href):'';}catch{return '';}};
let records=[],status=null,revision=-1,connector=false,loaded=false,polling=false,lastTerminal=null;
const drafts=new Map(),saveTimers=new Map();
async function api(path,body,method='POST'){
  const response=await fetch('/api'+path,body===undefined?{}:{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json().catch(()=>{throw new Error(`The server returned an unreadable response (${response.status}).`);});
  if(!response.ok)throw new Error(data.error||`Request failed (${response.status})`);return data;
}
function showError(message){el('error').textContent=message||'';el('error').hidden=!message;}
function populateFilters(){
  for(const [id,values]of [['state',records.flatMap(r=>r.states)],['department',records.map(r=>r.department)]]){
    const selected=el(id).value;el(id).innerHTML=`<option value="">All ${id==='state'?'states':'departments'}</option>`+[...new Set(values)].filter(Boolean).sort().map(v=>`<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');el(id).value=selected;
  }
}
function render(){
  const opened=new Set([...document.querySelectorAll('.tender[open]')].map(card=>card.dataset.id));
  const term=el('search').value.toLowerCase().trim(),state=el('state').value,department=el('department').value,review=el('review').value,portal=el('portal').value;
  let result=records.filter(r=>(!state||r.states.includes(state))&&(!department||r.department===department)&&(!review||(drafts.get(r.id)||r.review).status===review)&&(!portal||r.portal===portal)&&(!el('active-only').checked||Date.parse(r.closingAt)>Date.now())&&(!term||JSON.stringify([r.identifier,r.title,r.fields,r.documents.map(d=>d.evidence)]).toLowerCase().includes(term)));
  const [sort,direction]=el('sort').value.split(':');
  result.sort((a,b)=>{
    const get=r=>sort==='amount'?Number(String(r.fields['Tender Amount (INR)']||'').replace(/[^\d.]/g,''))||null:['closingAt','publishedAt'].includes(sort)?Date.parse(r[sort])||null:r[sort];
    const x=get(a),y=get(b);if(x==null&&y==null)return a.id.localeCompare(b.id);if(x==null)return 1;if(y==null)return-1;
    return(typeof x==='string'?x.localeCompare(y):x-y)*(direction==='desc'?-1:1)||a.id.localeCompare(b.id);
  });
  el('result-count').textContent=`${result.length} of ${records.length} tenders`;el('empty').hidden=Boolean(result.length);
  el('tenders').innerHTML=result.map(r=>{
    const review=drafts.get(r.id)||r.review,downloaded=r.documents.filter(d=>d.localPath).length,indexed=r.documents.filter(d=>d.status==='indexed').length;
    const docsBadge=downloaded?`${downloaded} saved · ${indexed} read`:'No local documents';
    const fields=Object.entries(r.fields).filter(([key])=>!['Portal URL','Tender Link'].includes(key));
    return `<details class="tender" data-id="${escapeHtml(r.id)}" data-review="${escapeHtml(review.status)}" ${opened.has(r.id)?'open':''}><summary>${[['Bid end date',date(r.closingAt)],['State / UT',r.states.join(', ')||'Not listed'],['Department',r.department],['City',r.city||'Not listed']].map(([label,value])=>`<span class="cell"><span class="mobile-label">${label}</span>${escapeHtml(value)}</span>`).join('')}<span class="cell"><span class="mobile-label">Documents</span><span class="badge ${indexed<r.documents.length?'partial':downloaded?'':'none'}">${docsBadge}</span></span><span class="cell"><span class="mobile-label">Portal</span>${escapeHtml(r.portal)}</span><span class="cell"><span class="mobile-label">Review</span><span class="review-badge">${escapeHtml(review.status)}</span></span><span class="toggle" aria-hidden="true"></span></summary>
      <div class="review-fields"><label>Review status<select data-review-status>${['Not Reviewed','Eligible','Not Eligible','Filled'].map(v=>`<option ${v===review.status?'selected':''}>${v}</option>`).join('')}</select><span class="save-status" role="status"></span></label><label>Comment<textarea data-review-comment rows="3" maxlength="10000" placeholder="Add a comment for this tender">${escapeHtml(review.comment)}</textarea></label></div><dl><div class="field wide"><dt>Tender and source</dt><dd><strong>${escapeHtml(r.identifier)}</strong> · <a href="${href(r.tenderUrl)}" target="_blank" rel="noopener noreferrer">Open Tenderkart</a>${r.portalUrl?` · <a href="${href(r.portalUrl)}" target="_blank" rel="noopener noreferrer">Open original portal</a>`:''}<br>${escapeHtml(r.title)}</dd></div><div class="field wide"><dt>Details check ? <a href="/api/tenders/${encodeURIComponent(r.id)}/source" target="_blank" rel="noopener">Full source JSON</a></dt><dd>${escapeHtml(r.detailState)}${r.detailsFetchedAt?` · ${date(r.detailsFetchedAt)}`:''}${r.detailError?`<br>${escapeHtml(r.detailError)}`:''}</dd></div>${fields.map(([key,value])=>`<div class="field ${['Description','Why This Matched','Organisation Chain'].includes(key)?'wide':''}"><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value||'Not listed')}</dd></div>`).join('')}<div class="field wide documents"><dt>Tender documents</dt><dd>${r.documentNotice?`<p>${escapeHtml(r.documentNotice)}</p>`:''}${r.documents.length?`<ul>${r.documents.map(d=>`<li>${d.localPath?`<a href="/api/documents/${encodeURIComponent(r.id)}/${encodeURIComponent(d.key)}" target="_blank" rel="noopener">${escapeHtml(d.name)}</a>`:escapeHtml(d.name)} · <span class="badge ${d.status==='indexed'?'':'partial'}">${escapeHtml(d.status)}</span>${d.cache?` · <a href="/api/documents/${encodeURIComponent(r.id)}/${encodeURIComponent(d.key)}/text" target="_blank" rel="noopener">Read extracted text</a>`:''}<small>${escapeHtml(d.error||'')}${d.url?` <a href="${href(d.url)}" target="_blank" rel="noopener noreferrer">Source file</a>`:''}</small></li>`).join('')}</ul>`:'No downloadable files are saved for this tender.'}</dd></div><div class="field wide facts"><dt>Evidence from documents</dt><dd><details class="evidence"><summary>Show extracted eligibility, amounts, contacts and lighting specifications</summary><p>These are source excerpts, not an eligibility decision. Verify the original documents.</p><div data-evidence></div></details></dd></div></dl></details>`;
  }).join('');
}

el('tenders').addEventListener('toggle',event=>{
  if(!event.target.matches('.evidence')||!event.target.open)return;
  const target=event.target.querySelector('[data-evidence]');if(target.childElementCount)return;
  const record=records.find(r=>r.id===event.target.closest('.tender').dataset.id);
  target.innerHTML=record.documents.flatMap(d=>(d.evidence||[]).map(f=>'<div class="fact"><small>'+escapeHtml(f.field)+' ? '+escapeHtml(d.name)+'</small>'+escapeHtml(f.text)+'</div>')).join('')||'<p>No document text has been extracted yet.</p>';
},true);

async function saveReview(id){
  const draft=drafts.get(id);if(!draft)return;const sent={...draft};
  const card=[...document.querySelectorAll('.tender')].find(c=>c.dataset.id===id);
  try{await api(`/tenders/${encodeURIComponent(id)}/review`,sent,'PATCH');const r=records.find(r=>r.id===id);r.review=sent;if(JSON.stringify(drafts.get(id))===JSON.stringify(sent))drafts.delete(id);if(card)card.querySelector('.save-status').textContent='Saved';}
  catch(error){if(card)card.querySelector('.save-status').textContent='Save failed';showError(error.message);}
}
el('tenders').addEventListener('input',event=>{
  if(!event.target.matches('[data-review-status],[data-review-comment]'))return;
  const card=event.target.closest('.tender'),id=card.dataset.id;
  const review={status:card.querySelector('[data-review-status]').value,comment:card.querySelector('[data-review-comment]').value};drafts.set(id,review);card.dataset.review=review.status;card.querySelector('.review-badge').textContent=review.status;card.querySelector('.save-status').textContent='Saving…';
  clearTimeout(saveTimers.get(id));saveTimers.set(id,setTimeout(()=>saveReview(id),600));
});
for(const id of ['search','state','department','review','portal','sort','active-only'])el(id).addEventListener(id==='search'?'input':'change',render);
el('clear').addEventListener('click',()=>{for(const id of ['search','state','department','review','portal'])el(id).value='';el('active-only').checked=false;el('sort').value='closingAt:asc';render();});
async function connectAndSync(sync){
  showError('');
  if(!status?.connection.connected){
    window.open('https://tenderkart.in/tenders/filters?keywords=facade+light&sort=relevance&mode=live','facade-tenderkart','noopener');
    if(connector)window.postMessage({type:'facade:connect'},location.origin);else{el('setup').open=true;showError('Install the connector once using the steps below, reload this page, then click Sync latest.');}
  }
  if(sync){try{await api('/sync',{});await poll();}catch(error){showError(error.message);}}
}
el('sync').addEventListener('click',()=>connectAndSync(true));el('login').addEventListener('click',()=>connectAndSync(false));
el('pause').addEventListener('click',async()=>{el('pause').disabled=true;try{await api('/pause',{});await poll();}catch(error){showError(error.message);}});
window.addEventListener('message',event=>{
  if(event.source!==window||event.origin!==location.origin)return;
  if(event.data?.type==='facade:connector-ready'){connector=true;el('connector-status').textContent=event.data.version?`Connector ${event.data.version} detected in this browser.`:'Older connector detected. Reload the extension to activate version 1.1.0.';}
  if(event.data?.type==='facade:connection'&&event.data.error)showError(event.data.error);
});
el('notify-close').addEventListener('click',()=>el('notify').close());
async function poll(){
  if(polling)return;polling=true;
  try{
    status=await api('/status');const job=status.job,connected=status.connection.connected;
    el('connection').textContent=connected?'Tenderkart connected':status.connection.reason==='tenderkart_auth_required'?'Tenderkart login / security verification required':status.connection.browserPresent?'Browser connected · open a signed-in Tenderkart tab':'Browser connector unavailable · reopen Chrome or reload the extension';
    el('last-sync').textContent=status.lastSyncCheck?`Last sync check: ${date(status.lastSyncCheck)}`:'No sync check completed yet';
    el('job-message').textContent=job?`${job.state.replaceAll('_',' ')} · ${job.message||job.phase}${job.nextRunAt>Date.now()?` Retry after ${date(new Date(job.nextRunAt).toISOString())}.`:''}`:'Ready to review saved tenders. Sync latest checks for new and changed records.';
    const running=job&&['running','queued','waiting_for_login','rate_limited','retrying'].includes(job.state);
    el('sync').disabled=Boolean(running);el('sync').textContent=job?.state==='paused'?'Resume sync':'Sync latest';el('pause').disabled=!running;
    el('counts').textContent=`${status.count} saved tenders${job?.total!=null?` · ${job.seen?.length||0}/${job.total} live matches checked`:''}${status.excel?` · Excel saved ${date(status.excel.exportedAt)}`:''}`;
    el('progress').hidden=!running;if(job?.total){el('progress').max=job.total;el('progress').value=job.seen?.length||0;}else el('progress').removeAttribute('value');
    if(job?.error)showError(job.error);else if(connected&&!drafts.size)showError('');
    if(status.revision!==revision&&!document.activeElement?.closest('.review-fields')){records=await api('/tenders');revision=status.revision;populateFilters();render();}
    const terminal=job&&['complete','partial','failed'].includes(job.state)?`${job.id}:${job.state}`:null;
    if(loaded&&terminal&&terminal!==lastTerminal){el('notify-title').textContent=job.state==='complete'?'Sync complete':job.state==='partial'?'Sync finished — review required':'Sync needs attention';el('notify-message').textContent=job.message+(job.error?` ${job.error}`:'');if(!el('notify').open)el('notify').showModal();}
    lastTerminal=terminal;loaded=true;
  }catch(error){showError(error.message);}finally{polling=false;}
}
poll();setInterval(poll,2500);
setTimeout(()=>{if(!connector)el('connector-status').textContent='Connector not detected. Follow the steps above, then reload this page.';},4000);
