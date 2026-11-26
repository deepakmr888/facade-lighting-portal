const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { atomic } = require('./store.cjs');
const exportsInFlight = new WeakMap();
function exportExcel(store) {
  const next = (exportsInFlight.get(store) || Promise.resolve()).catch(()=>{}).then(()=>writeExcel(store));
  exportsInFlight.set(store,next);return next;
}
async function writeExcel(store) {
  const state = structuredClone(store.read());
  const book = new ExcelJS.Workbook(); book.creator = 'Facade Lighting Portal';
  const fields = [...new Set(state.records.flatMap(record => Object.keys(record.fields)))].filter(f=>f!=='Tender ID').sort();
  const sheet = book.addWorksheet('Tenders', { views: [{ state: 'frozen', ySplit: 1 }] });
  const headers = ['Tender ID','Bid end date','GeM classification','Portal URL','Tenderkart URL','Review status','Comment','Details status','Documents indexed','Documents needing review', ...fields];
  sheet.addRow(headers);
  for (const record of state.records) sheet.addRow([record.identifier, record.closingAt, record.portal, record.portalUrl, record.tenderUrl, record.review.status, record.review.comment, record.detailState, record.documents.filter(d=>d.status==='indexed').length, record.documents.filter(d=>['manual_review','failed'].includes(d.status)).length, ...fields.map(f=>record.fields[f] ?? '')]);
  sheet.autoFilter = { from: 'A1', to: { row: 1, column: headers.length } };
  sheet.getRow(1).font = { bold: true }; sheet.columns.forEach(column => { column.width = 25; });
  const documents = book.addWorksheet('Documents'); documents.addRow(['Tender ID','File','Download URL','Local file','Status','Error','SHA256']);
  const facts = book.addWorksheet('Document evidence'); facts.addRow(['Tender ID','Field','File','Extracted text (verify in source)']);
  for (const record of state.records) for (const doc of record.documents) {
    documents.addRow([record.identifier,doc.name,doc.url,doc.localPath,doc.status,doc.error,doc.sha256]);
    for (const fact of doc.evidence || []) facts.addRow([record.identifier,fact.field,doc.name,fact.text]);
  }
  const meta = book.addWorksheet('Export info'); meta.addRow(['JSON revision',state.revision]); meta.addRow(['Exported at',new Date().toISOString()]); meta.addRow(['Last fully successful sync',state.lastSuccessfulSync]);
  const destination = path.join(store.root, 'exports/tenders.xlsx');
  atomic(destination, Buffer.from(await book.xlsx.writeBuffer()));
  atomic(path.join(store.root, 'exports/export-status.json'), { revision: state.revision, exportedAt: new Date().toISOString() });
  return destination;
}
module.exports = { exportExcel };
