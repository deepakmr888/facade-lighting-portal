const{test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const{createStore,atomic}=require('../server/store.cjs');
const{createBackup,restoreBackup}=require('../server/data-backup.cjs');
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'facade-backup-'));const store=createStore(path.join(root,'data'));store.save(s=>{s.records=[{id:'one',identifier:'ONE',fields:{Description:'Saved tender'},review:{status:'Eligible',comment:'Keep this'},documents:[{key:'file',name:'file.txt',localPath:'documents/file.txt',status:'indexed'}],raw:{authorization:'secret-not-to-share',portal_link:'https://portal.example/?session=private&bid=ONE'}}];s.job={state:'running'};s.portalQueueEnabled=true;});atomic(path.join(store.root,'documents/file.txt'),'Facade light specifications and saved tender content');atomic(path.join(store.root,'browser-pairing.json'),{token:'must-stay-local'});return{root,store};}
test('backup restores saved metadata and documents without copying login state or auto-starting jobs',async()=>{
 const{root,store}=fixture(),archive=path.join(root,'backup.zip');const backup=await createBackup({root:store.root,destination:archive});assert.equal(backup.records,1);assert(!backup.files.some(f=>/pairing|\.bak|token/.test(f.path)));
 const target=path.join(root,'restored');const result=await restoreBackup({archive,root:target,expectedHash:backup.archiveSha256});assert.equal(result.records,1);assert.equal(fs.readFileSync(path.join(target,'documents/file.txt'),'utf8'),'Facade light specifications and saved tender content');
 const state=createStore(target).read();assert.equal(state.records[0].review.comment,'Keep this');assert.equal(state.records[0].raw.authorization,undefined);assert(!state.records[0].raw.portal_link.includes('session'));assert.equal(state.job,null);assert.equal(state.portalQueueEnabled,false);assert(!fs.existsSync(path.join(target,'browser-pairing.json')));
});
test('restore keeps existing data and rejects a mismatched backup before installing anything',async()=>{
 const{root,store}=fixture(),archive=path.join(root,'backup.zip');await createBackup({root:store.root,destination:archive});const existing=await restoreBackup({archive,root:store.root});assert.equal(existing.restored,false);
 const empty=path.join(root,'empty');await assert.rejects(()=>restoreBackup({archive,root:empty,expectedHash:'0'.repeat(64)}),/SHA256/);assert(!fs.existsSync(path.join(empty,'tenders.json')));
});
