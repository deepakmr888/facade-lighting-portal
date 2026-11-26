const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),path=require('path'),os=require('os');
const {extract}=require('../server/documents.cjs');
test('a damaged PDF cannot crash the parent document job',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'facade-pdf-'));fs.mkdirSync(path.join(root,'documents'));
  const file=path.join(root,'documents/broken.pdf');fs.writeFileSync(file,'%PDF-1.4\nbroken document\n%%EOF');
  await assert.rejects(()=>extract({localPath:'documents/broken.pdf',name:'broken.pdf'},root));
  assert(fs.existsSync(file));
});
