(function(root){
  const nicHosts=['jktenders.gov.in','etender.up.nic.in','defproc.gov.in','etenders.gov.in','etenders.hry.nic.in','etenders.chd.nic.in','govtprocurement.delhi.gov.in','uktenders.gov.in','coalindiatenders.nic.in','tntenders.gov.in','eprocure.gov.in','eproc.rajasthan.gov.in','ddtenders.gov.in','mptenders.gov.in','hptenders.gov.in','mahatenders.gov.in'];
  const definitions=[
    {id:'gePNIC',name:'NIC / GePNIC',hosts:nicHosts,verification:'Live Uttar Pradesh search prefill and manual-CAPTCHA pause verified; document stages await live verification',search:['#tenderId','input[name="tenderId"]'],searchLinks:['Search','Advanced Search'],searchValue:'identifier',fileSections:['Tender Documents','Tendernotice','Work Item Documents','Corrigendum']},
    {id:'gem',name:'GeM bids',hosts:['bidplus.gem.gov.in'],verification:'Direct document links supported; browser flow awaiting live verification',search:['#searchBid','input[name="searchBid"]','input[placeholder*="Search" i]'],searchLinks:['All Bids'],searchValue:'reference',fileSections:['Bid Document','Additional Documents','Buyer Added']},
    {id:'ireps',name:'Indian Railways IREPS',hosts:['www.ireps.gov.in'],verification:'Live Search Tenders redirects to mobile/OTP guest sign-in; post-login document stages await verification',search:['input[name="tenderNo"]','input[name="tenderNumber"]','input[id*="tenderNo" i]'],searchLinks:['Search Tenders','Search Tender'],fileSections:['Tender Document','Tender Details','Documents']},
    {id:'nprocure',name:'nProcure',hosts:['tender.nprocure.com'],verification:'Tender-specific URL available; layout requires live verification',search:['input[name="tenderId"]','input[name="tenderNo"]','input[placeholder*="Tender" i]'],searchLinks:['View Tenders','Search Tenders'],fileSections:['Tender Documents','Documents','Attachments']},
    {id:'chips',name:'Chhattisgarh CHiPS',hosts:['eproc.cgstate.gov.in'],verification:'Public RFQ search field verified; document stage awaiting live verification',search:['input[name="rfqPart"]'],searchLinks:['Advanced Search'],fileSections:['Tender Documents','Documents']},
    {id:'cpwd',name:'CPWD',hosts:['etender.cpwd.gov.in'],verification:'Public portal reachable; search/document stages awaiting live verification',search:['input[name="nitNo"]','input[id*="tenderNo" i]','input[placeholder*="Tender" i]'],searchLinks:['Search Tender','Tender Search','Published Tenders'],fileSections:['NIT','Tender Documents','Documents']},
    {id:'kppp',name:'Karnataka KPPP',hosts:['kppp.karnataka.gov.in'],verification:'Tender-specific URL available; application stages awaiting live verification',search:['input[placeholder*="Tender" i]','input[name="tenderNumber"]'],searchLinks:['Search Tenders','Tenders'],fileSections:['Tender Documents','Documents']},
    {id:'enivida',name:'NBCC eNivida',hosts:['nbcc.enivida.com'],verification:'Public portal reachable; login/document stages awaiting live verification',search:['input[name="tenderNo"]','input[placeholder*="Tender" i]'],searchLinks:['Current Tenders','Tender Search','Search Tender'],fileSections:['Documents','Tender Documents']},
    {id:'hal',name:'HAL eProcurement',hosts:['eproc.hal-india.co.in'],verification:'Public portal reachable; tender/document stages awaiting live verification',search:['input[name="tenderNo"]','input[placeholder*="Tender" i]'],searchLinks:['Tenders','Current Tenders','Tender Search'],fileSections:['Tender Documents','Documents']},
    {id:'powergrid',name:'POWERGRID',hosts:['apps.powergrid.in'],verification:'Portal navigation needs live verification',search:['input[name="tenderNo"]','input[placeholder*="Tender" i]'],searchLinks:['Tender Search','Current Tenders'],fileSections:['Tender Documents','Documents']},
    {id:'gep',name:'GEP / BIAL',hosts:['quantum.gep.com'],verification:'Login and document stages require live verification',search:['input[placeholder*="Search" i]','input[name="search"]'],searchLinks:['Opportunities','Tenders'],fileSections:['Documents','Attachments']},
  ];
  function forHost(host){return definitions.find(d=>d.hosts.includes(String(host).toLowerCase()))||null;}
  function entry(record){
    let portal;try{portal=new URL(record.portalUrl);}catch{return null;}
    const adapter=forHost(portal.hostname);if(!adapter)return null;
    if(adapter.id==='gePNIC')return portal.origin+(['etenders.gov.in','eprocure.gov.in'].includes(portal.hostname)?'/eprocure/app':'/nicgep/app')+'?page=FrontEndAdvancedSearch&service=page';
    try{const deep=new URL(record.raw?.tender_link);if(deep.origin===portal.origin)return deep.href;}catch{}
    return portal.href;
  }
  const api={definitions,forHost,entry};if(typeof module!=='undefined')module.exports=api;else root.FacadePortalAdapters=api;
})(globalThis);
