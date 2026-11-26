const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const ExcelJS = require('exceljs');
const { fork } = require('child_process');
const { atomic } = require('./store.cjs');
const safeName = name => String(name || 'document').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 150);
function parsePdf(file) {
  return new Promise((resolve,reject)=>{
    const worker=fork(path.join(__dirname,'pdf-worker.cjs'),[file],{silent:true,execArgv:['--max-old-space-size=512']});
    // PDF libraries can print thousands of font warnings; diagnostics do not belong in API output.
    worker.stdout.resume();worker.stderr.resume();let result;
    const timer=setTimeout(()=>{worker.kill();reject(new Error('PDF text extraction exceeded 45 seconds; manual review is required.'));},45000);
    worker.once('message',message=>{result=message;});
    worker.once('error',error=>{clearTimeout(timer);reject(error);});
    worker.once('exit',()=>{clearTimeout(timer);if(result?.ok)resolve(result);else reject(new Error(result?.error||'PDF parser stopped unexpectedly; the original file is preserved for manual review.'));});
  });
}
function within(root, relative) {
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error('Document path is outside the data folder');
  return resolved;
}
function publicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a,b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18,19].includes(b)));
  }
  return net.isIP(address) === 6 && /^[23][a-f0-9:]+$/i.test(address) && !/^2001:(?:db8|0):/i.test(address);
}
async function publicUrl(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) throw new Error('Only public HTTPS document links are supported');
  const addresses = await dns.lookup(u.hostname, { all: true });
  if (!addresses.length || !addresses.every(a => publicAddress(a.address))) throw new Error('Private-network document links are blocked');
  return u;
}
async function download(doc, root, record, request) {
  const target = doc.localPath || `documents/${safeName(record.identifier)}/${doc.key}-${safeName(doc.name)}`;
  const destination = within(root, target);
  let bytes;
  const original = new URL(doc.url);
  if (original.hostname === 'tenderkart.in') {
    const response = await request({ kind: 'download', url: doc.url });
    if (!response?.base64) throw new Error('Tenderkart did not return a document');
    bytes = Buffer.from(response.base64, 'base64');
  } else {
    let address = doc.url;
    for (let n = 0; n < 5; n++) {
      await publicUrl(address);
      const response = await fetch(address, { redirect: 'manual', signal: AbortSignal.timeout(90000) });
      if ([301,302,303,307,308].includes(response.status)) { address = new URL(response.headers.get('location'), address).href; await response.body?.cancel(); continue; }
      if (!response.ok) throw Object.assign(new Error(`Document server returned HTTP ${response.status}`), { status: response.status });
      if (Number(response.headers.get('content-length')) > 100 * 1024 ** 2) throw new Error('Document exceeds the 100 MB limit');
      const chunks = []; let length = 0;
      for await (const chunk of response.body) { length += chunk.length; if (length > 100 * 1024 ** 2) throw new Error('Document exceeds the 100 MB limit'); chunks.push(chunk); }
      bytes = Buffer.concat(chunks); break;
    }
  }
  if (!bytes?.length) throw new Error('Document download returned no file');
  if(doc.expectedSha256&&crypto.createHash('sha256').update(bytes).digest('hex')!==doc.expectedSha256)throw new Error('Downloaded document does not match the source checksum; no file was saved.');
  if (/^\s*(?:<!doctype|<html)/i.test(bytes.subarray(0, 300).toString())) throw new Error('The portal returned a login or CAPTCHA page. Download this document manually.');
  if (/\.pdf$/i.test(doc.name) && (bytes.subarray(0, 5).toString() !== '%PDF-' || !bytes.subarray(-4096).includes(Buffer.from('%%EOF')))) throw new Error('Incomplete or invalid PDF; no file was saved');
  atomic(destination, bytes);
  return { ...doc, localPath: target, status: 'downloaded', downloadedAt: new Date().toISOString(), error: null };
}
function evidence(text, file) {
  const labels = { eligibility: /eligib|experience|turnover|registration|incorporat/i, deadlines: /submission|closing|last date|bid end/i, amount: /estimated (?:cost|value)|tender value|earnest money|\bEMD\b/i, contacts: /e-?mail|contact|phone|consignee|address|pincode/i, specifications: /facade|façade|watt|luminaire|lighting|IP6[5-9]/i };
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return Object.entries(labels).flatMap(([field, regex]) => lines.flatMap((line, i) => regex.test(line) ? [{ field, file, text: lines.slice(Math.max(0,i-1),i+3).join(' ').slice(0,900) }] : []).slice(0, 20));
}
async function extract(doc, root) {
  const file = within(root, doc.localPath);
  const bytes = fs.readFileSync(file);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const cache = `extracted/${hash}.json`;
  if (fs.existsSync(path.join(root, cache))) {
    const saved = JSON.parse(fs.readFileSync(path.join(root, cache), 'utf8'));
    return { ...doc, ...saved.summary, cache, sha256: hash, evidence: evidence(saved.text, doc.name), error: null };
  }
  let text = '', pages = null;
  if (bytes.subarray(0,5).toString() === '%PDF-') { const parsed = await parsePdf(file); text = parsed.text; pages = parsed.pages; }
  else if (bytes.subarray(0,2).toString() === 'PK' && /\.xlsx?$/i.test(doc.name)) {
    const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes);
    for (const sheet of book.worksheets) { text += `\nSheet: ${sheet.name}\n`; sheet.eachRow(row => { text += row.values.map(v => typeof v === 'object' && v ? v.text || v.result || JSON.stringify(v) : v ?? '').join(' | ') + '\n'; }); }
  } else if (/\.(?:txt|csv)$/i.test(doc.name)) text = bytes.toString('utf8');
  else return { ...doc, sha256:hash, status: 'manual_review', error: 'This file format requires manual review (legacy XLS, archive, image or other unsupported format).' };
  const summary = { status: text.trim().length >= 30 ? 'indexed' : 'manual_review', pages, characters: text.length, extractedAt: new Date().toISOString() };
  atomic(path.join(root, cache), { summary, text });
  return { ...doc, ...summary, cache, sha256: hash, evidence: evidence(text, doc.name), error: summary.status === 'manual_review' ? 'No readable text found. This document may need OCR or manual review.' : null };
}
module.exports = { safeName, within, publicAddress, publicUrl, download, extract, evidence };
