const fs=require('fs'),path=require('path'),crypto=require('crypto'),cheerio=require('cheerio');
const {createStore}=require('../server/store.cjs');
const {exportExcel}=require('../server/export.cjs');
const {within}=require('../server/documents.cjs');
const input=process.argv[2];
async function main(){
  if(!input)throw new Error('Usage: npm run import:snapshot -- "C:\\path\\Facade_Lighting_Tender_Portal_With_Documents"');
  const source=path.resolve(input),root=process.env.FACADE_DATA_DIR||path.resolve(__dirname,'../data'),store=createStore(root);
  if(store.read().records.length)throw new Error('Import only into an empty project data folder. Existing records were left unchanged.');
  const q=cheerio.load(fs.readFileSync(path.join(source,'Facade_Lighting_Tender_Portal.html'),'utf8'));
  function date(value){
    const match=String(value).match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4}),?\s+(\d{2}):(\d{2})/);
    if(!match)return null;
    const month=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(match[2])+1;
    return month?`${match[3]}-${String(month).padStart(2,'0')}-${match[1].padStart(2,'0')}T${match[4]}:${match[5]}:00+05:30`:null;
  }
  const records=q('details[data-tender-id]').toArray().map(card=>{
    const c=q(card),identifier=c.attr('data-tender-id'),fields={};
    c.find('dl > .field').each((i,field)=>{const f=q(field);if(f.find('dt').length&&!f.hasClass('tender-documents'))fields[f.find('dt').text().trim()]=f.find('dd').text().trim();});
    const tenderUrl=c.find('.field').filter((i,f)=>q(f).find('dt').text()==='Tender Link').find('a').attr('href');
    const summaryUrl=c.find('summary a').first().attr('href');
    const docs=c.find('.tender-documents a').toArray().map(a=>{
      const relative=decodeURIComponent(q(a).attr('href')||'');
      const absolute=within(source,relative);
      const target=`documents/${relative.replace(/^Facade_Lighting_Tender_Documents\//,'')}`;
      const destination=within(root,target);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(absolute,destination);
      return {key:crypto.createHash('sha256').update(relative).digest('hex').slice(0,20),name:q(a).text().trim(),localPath:target,status:'downloaded'};
    });
    const sourceId=tenderUrl?.match(/\/tender\/([a-f0-9-]{36})/)?.[1];
    const sourceIds=[...new Set([sourceId,summaryUrl?.match(/\/tender\/([a-f0-9-]{36})/)?.[1]].filter(Boolean))];
    return {id:identifier,identifier,sourceId,sourceIds,tenderUrl,summaryUrl,title:fields.Description||identifier,fields,
      closingAt:date(c.find('summary .summary-field').first().children('span').last().text()),publishedAt:date(fields['Published Date']),
      states:JSON.parse(c.attr('data-states')||'[]'),department:c.attr('data-department')||fields.Department||'Not listed',city: c.find('summary .summary-field').eq(3).children('span').last().text(),
      portal:/^GEM\//i.test(identifier)?'GeM':'Non-GeM',portalUrl:fields['Portal URL'],documents:docs,
      documentNotice:c.find('.tender-documents p').text(),detailState:'pending',review:{status:'Not Reviewed',comment:''},importedAt:new Date().toISOString()};
  });
  store.save(s=>{s.records=records;s.importedFrom='Facade lighting portal snapshot';});
  await exportExcel(store);
  console.log(JSON.stringify({tenders:records.length,linkedDocuments:records.reduce((n,r)=>n+r.documents.length,0),data:root}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
