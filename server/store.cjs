const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx');
  try { fs.writeFileSync(fd, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
function validState(data) {
  if (data?.schemaVersion !== 1 || !Array.isArray(data.records) || data.records.some(r => !r.id || !r.fields || !Array.isArray(r.documents))) throw new Error('Invalid saved tender data');
  if (new Set(data.records.map(r => r.id)).size !== data.records.length) throw new Error('Duplicate saved tender identifiers');
  return data;
}
function createStore(root) {
  const file = path.join(root, 'tenders.json');
  fs.mkdirSync(root, { recursive: true });
  let state = fs.existsSync(file) ? validState(JSON.parse(fs.readFileSync(file, 'utf8'))) : {
    schemaVersion: 1, revision: 0, updatedAt: null, lastSuccessfulSync: null,
    settings: { query: 'facade light', includeResults: false }, records: [], job: null,
  };
  return {
    root, file,
    read: () => state,
    save(mutator) {
      const next = structuredClone(state);
      mutator(next); validState(next);
      next.revision = (state.revision || 0) + 1; next.updatedAt = new Date().toISOString();
      if (fs.existsSync(file)) atomic(file + '.bak', fs.readFileSync(file));
      atomic(file, next); state = next; return state;
    },
  };
}
module.exports = { atomic, createStore, validState };
