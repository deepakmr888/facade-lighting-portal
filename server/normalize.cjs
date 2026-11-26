const crypto = require('crypto');
const missing = value => value == null || value === '' || value === 'Not listed';
const text = value => Array.isArray(value) ? value.map(text).filter(Boolean).join(', ') : typeof value === 'object' && value ? value.name || value.label || JSON.stringify(value) : value == null ? '' : String(value);
function url(value) { try { const parsed = new URL(value); return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : null; } catch { return null; } }
function normalize(raw, prior = {}) {
  const fields = { ...prior.fields };
  const extended=raw.extended_data||{},gemData=extended.gem_data||{};
  const identifier=text([raw.tender_reference_number,raw.tender_id].find(v=>/^GEM\//i.test(String(v||'')))||raw.tender_id||prior.identifier||raw.tender_reference_number||raw.id);
  const mapping = {
    'Tender ID': identifier,
    'Tender Reference Number': raw.tender_reference_number,
    'Description': raw.description || raw.work_description || raw.title,
    'Tender Amount (INR)': raw.tender_value,
    'EMD (INR)': raw.emd_amount ?? raw.emd_fee ?? raw.emd,
    'Tender Type': raw.tender_type, 'Form of Contract': raw.form_of_contract,
    'Published Date': raw.published_at || raw.publish_date,
    'State': raw.state, 'District / city': raw.city || raw.location,
    'Organisation': raw.organisation, 'Organisation Chain': raw.organisation_chain,
    'Goods Quantity': raw.quantity ?? gemData.total_quantity, 'Department': raw.department,
    'Division': raw.division, 'Sub-Division': raw.sub_division,
    'Authority Contact': raw.authority_contact || extended.inviting_authority, 'Pincode': raw.pincode,
    'Open/Limited': raw.tender_category || raw.open_limited, 'RA Enabled': raw.ra_enabled,
    'Preferences': raw.preferences || gemData.preferences, 'Source status': raw.status || raw.raw_status,
    'Why This Matched': raw.match_reason || raw.matching_text || raw.search_snippet,
    'Source eligibility': gemData.eligibility, 'Source specifications': gemData.items || gemData.categories,
    'Bid opening date': raw.bid_opening_date,
  };
  for (const [key, value] of Object.entries(mapping)) if (!missing(value)) fields[key] = text(value);
  for(const field of ['Tender Amount','Tender Amount (INR)','EMD','EMD (INR)','Tender Type','Form of Contract','Description','Why This Matched','Preferences','Published Date','State','Organisation','Organisation Chain','Goods Quantity','Tender Reference Number','Open/Limited','RA Enabled','Department','Division','Sub-Division','Authority Contact','Pincode']) if(!(field in fields))fields[field]='Not listed';
  const gem = /^GEM\//i.test(identifier) || /^gem$/i.test(raw.portal_name || '');
  const portalUrl = url(raw.portal_base_url || raw.portal_link || raw.tender_link) || prior.portalUrl || (gem ? 'https://bidplus.gem.gov.in/' : null);
  const id = prior.id || raw.id || identifier;
  return { ...prior, id, sourceId: raw.id || prior.sourceId, identifier,
    title: text(raw.title || prior.title || fields.Description), fields,
    states: Array.isArray(raw.state) ? raw.state.map(text) : raw.state ? [text(raw.state)] : prior.states || [],
    department: text(raw.department || raw.organisation || prior.department || 'Not listed'),
    city: text(raw.city || raw.location || prior.city), portal: gem ? 'GeM' : 'Non-GeM', portalUrl,
    tenderUrl: raw.id ? `https://tenderkart.in/tender/${encodeURIComponent(raw.id)}` : prior.tenderUrl,
    closingAt: raw.effective_bid_submission_end || raw.closing_at || raw.bid_submission_end || prior.closingAt || null,
    publishedAt: raw.published_at || raw.publish_date || prior.publishedAt || null,
    review: prior.review || { status: 'Not Reviewed', comment: '' },
    documents: prior.documents || [], raw: { ...prior.raw, ...raw },
    lastSeenAt: new Date().toISOString(), detailState: prior.detailState || 'pending',
  };
}
function mergeListing(records, raw) {
  const ids=[raw.tender_id,raw.tender_reference_number].filter(Boolean);
  const prior = records.find(r => ids.includes(r.identifier)) || records.find(r => r.sourceId===raw.id && (!ids.length || r.identifier===r.sourceId));
  const next = normalize(raw, prior);
  if (prior) records[records.indexOf(prior)] = next; else records.push(next);
  return next;
}
function documentCandidates(raw) {
  const sources=[];
  function visit(value){
    if(!value||typeof value!=='object')return;
    if(Array.isArray(value)){value.forEach(visit);return;}
    if(value.download_url||value.document_download_url||value.file_url||value.url||value.link||value.path&&value.name){sources.push(value);return;}
    for(const child of Object.values(value))visit(child);
  }
  for(const value of [raw.documents,raw.tender_documents,raw.attachments,raw.corrigendum_documents,raw.boq_documents,raw.extended_data?.documents,raw.extended_data?.gem_data?.additional_documents,raw.corrigendums]){
    if(Array.isArray(value))for(const doc of value)typeof doc==='string'?sources.push(doc):visit(doc);else visit(value);
  }
  for (const contract of raw.gem_contracts || []) if (contract.document_download_url) sources.push({ url: contract.document_download_url, name: `${contract.contract_no || 'contract'}.pdf` });
  const unique = new Map();
  for (const value of sources) {
    const link = typeof value === 'string' ? value : value.download_url || value.document_download_url || value.file_url || value.url || value.link;
    let href;if(link)try{href=url(new URL(link,raw.portal_base_url||raw.portal_link||'https://tenderkart.in').href);}catch{}
    if(!href&&!value.path)continue;
    const name=text(value.name||value.title||value.file_name||value.filename||(href?new URL(href).pathname.split('/').pop():'document'));
    const expectedSha256=/^[a-f0-9]{64}$/i.test(value.checksum_sha256||'')?value.checksum_sha256.toLowerCase():null;
    const key=crypto.createHash('sha256').update([href?.split('?')[0],value.path,name,expectedSha256].join('|')).digest('hex').slice(0,20);
    unique.set(key,{key,url:href||null,name,archivePath:value.path||null,expectedSha256,status:href?'pending':'manual_review',...(!href?{error:'Tenderkart returned an archive path without a downloadable URL. Open this file in Tenderkart to obtain it.'}:{})});
  }
  return [...unique.values()];
}
function mergeDocuments(existing, incoming) {
  const result=existing.map(doc=>({...doc}));
  for(const doc of incoming){
    const prior=result.find(old=>old.key===doc.key||doc.expectedSha256&&old.sha256===doc.expectedSha256||old.name.toLowerCase()===doc.name.toLowerCase()&&(!doc.expectedSha256||!old.sha256||old.sha256===doc.expectedSha256));
    if(prior)Object.assign(prior,{...doc,...prior,url:doc.url||prior.url,expectedSha256:doc.expectedSha256||prior.expectedSha256,archivePath:doc.archivePath||prior.archivePath});
    else result.push(doc);
  }
  return result;
}
module.exports = { normalize, mergeListing, documentCandidates, mergeDocuments, url };
