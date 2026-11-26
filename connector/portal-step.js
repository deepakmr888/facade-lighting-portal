// Runs in an isolated extension world. CAPTCHA fields/images are never read or filled.
globalThis.facadePortalStep=function(task){
  const visible=e=>Boolean(e&&e.getClientRects().length&&!e.closest('#facade-portal-helper'));
  const norm=v=>String(v||'').toLowerCase().replace(/\s+/g,' ').trim();
  const all=(selector)=>[...document.querySelectorAll(selector)].filter(visible);
  let panel=document.getElementById('facade-portal-helper');
  if(!panel){panel=document.createElement('aside');panel.id='facade-portal-helper';panel.style.cssText='position:fixed;bottom:16px;right:16px;z-index:2147483647;max-width:390px;padding:16px;background:#fff;color:#142b3c;border:2px solid #076555;border-radius:8px;font:15px/1.5 system-ui;box-shadow:0 3px 20px #0003';document.documentElement.append(panel);}
  function show(state,message,extra={}){
    panel.replaceChildren();const title=document.createElement('strong');title.textContent='Facade portal · '+task.identifier;const p=document.createElement('p');p.textContent=message;
    const file=document.createElement('p');file.textContent='File: '+task.name;const button=document.createElement('button');button.textContent='Continue after manual step';button.style.cssText='padding:8px;cursor:pointer';button.onclick=()=>chrome.runtime.sendMessage({action:'portal-continue',flowId:task.id});
    panel.append(title,file,p,button);return{state,message,...extra};
  }
  if(location.origin!==task.origin)return show('waiting_for_user','This page redirected to another portal. Review it manually; automation will not follow an unconfigured origin.');
  const pageText=norm(document.body?.innerText?.replace(panel.innerText,'')||'');
  if(/just a moment|performing security verification|checking your browser/i.test(document.title+' '+pageText.slice(0,600)))return show('waiting_for_captcha','Complete the portal security verification yourself. The script will wait.');
  if(all('input[type=password],input[id="mobileNo"],input[id*="otp" i]').length)return show('waiting_for_login','Complete this portal’s login or mobile/OTP guest sign-in yourself, then continue. Credentials stay in this browser.');
  if(/(?:\b(?:404|500|502|503)\s*(?:error|not found|internal server|bad gateway|service unavailable)|page (?:was )?not found|session (?:has )?expired|invalid session|access denied|an (?:unexpected )?error (?:has )?occurred|tender (?:is )?(?:not found|not available|does not exist))/i.test(pageText))return show('failed','The tender portal reports an error or expired page. Skip this tender and continue with the next.');
  const identifiers=[task.identifier,task.reference,task.identifier?.split('~')[0]].map(norm).filter(v=>v&&v!=='not listed');
  const logicalPage=new URL(location.href).searchParams.get('page')||'';
  // GePNIC's history view can omit the tender ID. Keep the identity established
  // by the matching result and the tender-specific history link, not a sidebar.
  const trustedHistory=task.adapter==='gePNIC'&&task.identityConfirmed&&task.visitedDetails&&task.visitedDocuments&&(/Corrigendum/i.test(logicalPage)||/corrigendum\s+(?:history|details|list)/i.test(pageText));
  const identified=identifiers.some(id=>pageText.includes(id))||trustedHistory;
  const links=all('a,button,input[type=button],input[type=submit]');
  const label=e=>norm(e.innerText||e.value||e.getAttribute('title')||e.getAttribute('aria-label'));
  // A file is clicked only from a page containing the expected tender identity.
  if(identified){
    const candidates=links.filter(e=>label(e).includes(norm(task.name)));
    const exact=candidates.filter(e=>label(e)===norm(task.name));
    const chosen=exact.length===1?exact[0]:candidates.length===1?candidates[0]:null;
    if(chosen){
      if(task.armed){const captcha=all('input[id*="captcha" i],input[name*="captcha" i],.g-recaptcha,.cf-turnstile');return show(captcha.length?'waiting_for_captcha':'downloading','Waiting for the selected file. If a CAPTCHA appears, enter and submit it yourself. If a PDF viewer opens, use its Download button.',{identityConfirmed:true});}
      chosen.dataset.facadeDownload=task.id;
      return show('navigating','The matching tender and file were found. Starting the normal download flow.',{identityConfirmed:true,action:'download',href:chosen.getAttribute('href')||null});
    }
    const details=links.filter(e=>{
      if(/^(view tender|tender details|view details|view nit|view)$/i.test(label(e)))return true;
      if(task.adapter!=='gePNIC'||e.tagName!=='A')return false;
      try{const u=new URL(e.getAttribute('href'),location.href);return u.origin===location.origin&&u.searchParams.get('service')==='direct'&&/DirectLink/i.test(u.searchParams.get('component')||'');}catch{return false;}
    });
    const matches=details.filter(e=>identifiers.some(id=>norm(e.closest('tr,article,.card')?.innerText).includes(id)));
    if(matches.length===1&&!task.visitedDetails){matches[0].dataset.facadeNavigate=task.id;return show('navigating','Opening this tender’s detail page.',{identityConfirmed:true,action:'details'});}
    const rowLinks=links.filter(e=>e.tagName==='A'&&label(e)&&identifiers.some(id=>norm(e.closest('tr')?.innerText).includes(id)));
    const titleLinks=rowLinks.filter(e=>!/^(?:view\s+)?(?:corrigendum|corrigendums|documents?|downloads?|history)$/i.test(label(e)));
    if(task.adapter==='gePNIC'&&titleLinks.length===1&&!task.visitedDetails){titleLinks[0].dataset.facadeNavigate=task.id;return show('navigating','Opening the tender title from its matching result row.',{identityConfirmed:true,action:'details'});}
    const captcha=all('input[id*="captcha" i],input[name*="captcha" i],.g-recaptcha,.cf-turnstile,iframe[src*="challenges.cloudflare.com"]');
    if(captcha.length&&rowLinks.length)return show('waiting_for_user','The tender appears in the results. Open its matching title or View Details link. Visible row links: '+rowLinks.slice(0,3).map(label).join(' | '),{identityConfirmed:true});
    if(captcha.length)return show('waiting_for_captcha','Enter and submit the CAPTCHA directly on this portal. No CAPTCHA is sent to the app.',{identityConfirmed:true});
    const sections=links.filter(e=>(task.config.fileSections||[]).some(t=>{const name=norm(t);return [name,'view '+name,name+' details','view '+name+' details',name+' history','view '+name+' history'].includes(label(e));}));
    const history=sections.filter(e=>/^(?:view )?corrigendum history$/i.test(label(e)));
    const section=trustedHistory?null:task.adapter==='gePNIC'&&history.length===1?history[0]:sections.length===1?sections[0]:null;
    const freshHistory=section&&history.includes(section)&&section.dataset.facadeHistoryOpened!==task.id;
    if(section&&(!task.visitedDocuments||freshHistory)){section.dataset.facadeNavigate=task.id;if(freshHistory)section.dataset.facadeHistoryOpened=task.id;return show('navigating','Opening this tender’s document or corrigendum history.',{identityConfirmed:true,action:'documents'});}
    const documentActions=links.map(label).filter(t=>/corrigendum|document|download/i.test(t)).slice(0,5);
    return show('failed','The requested document was not found by this portal flow; skip this tender.'+(documentActions.length?' Available document actions: '+documentActions.join(' | '):''),{identityConfirmed:true});
  }
  const field=(task.config.search||[]).map(s=>document.querySelector(s)).find(visible);
  if(field){
    const value=task.config.searchValue==='reference'?task.reference||task.identifier:task.identifier.split('~')[0];
    // A dependent dropdown or a validation response can recreate an empty input.
    // The saved flag is not evidence that the current form still has its ID.
    if(!task.searchFilled||field.value!==value){
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;setter?setter.call(field,value):field.value=value;field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));
      return show('waiting_for_user','Tender search was filled in. Complete any CAPTCHA and submit Search yourself.',{searchFilled:true});
    }
    const tenderType=document.querySelector('#TenderType');
    if(visible(tenderType)&&tenderType.tagName==='SELECT'&&(!tenderType.value||/select|choose/i.test(tenderType.selectedOptions[0]?.textContent||'')))return show('waiting_for_user','Select the mandatory Tender Type on this portal before entering its CAPTCHA. The helper will restore the tender ID if that selection clears it.');
    if(all('input[id*="captcha" i],input[name*="captcha" i],.g-recaptcha,.cf-turnstile').length)return show('waiting_for_captcha','Enter and submit the search CAPTCHA yourself. Results will be matched to this tender only.');
    const submit=links.filter(e=>/^(search|go|find)$/i.test(label(e)));
    if(submit.length===1&&!task.searchSubmitted){submit[0].dataset.facadeNavigate=task.id;return show('navigating','Submitting the prepared tender search.',{action:'submit_search'});}
    return show('waiting_for_user','Submit the prepared tender search, then continue when results appear.');
  }
  // GePNIC can put its download CAPTCHA on a separate page without a tender ID.
  if(all('input[id*="captcha" i],input[name*="captcha" i],.g-recaptcha,.cf-turnstile,iframe[src*="challenges.cloudflare.com"]').length)return show('waiting_for_captcha','This portal step requires another CAPTCHA. Enter and submit it directly on the portal; the script will wait.');
  const search=links.filter(e=>(task.config.searchLinks||[]).some(t=>norm(t)===label(e)));
  if(search.length===1&&!task.visitedSearch){search[0].dataset.facadeNavigate=task.id;return show('navigating','Opening this portal’s tender search.',{action:'search'});}
  return show('failed','The portal returned a page this adapter cannot process. Skip this tender and continue with the next.');
};
