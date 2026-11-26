const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {pipeline}=require('stream/promises');
const {Transform}=require('stream');
const {execFileSync}=require('child_process');
const archiver=require('archiver'),unzipper=require('unzipper');
const {atomic,validState}=require('./store.cjs');
const {within}=require('./documents.cjs');
const project=path.resolve(__dirname,'..');
const hashFile=async file=>{const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);return hash.digest('hex');};
function clean(value){
 if(Array.isArray(value))return value.map(clean);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>! /^(?:token|access_token|refresh_token|authorization|password|cookies?|tabId|downloadId|clientId)$/i.test(key)).map(([key,v])=>[key,clean(v)]));
 if(typeof value==='string'&&/^https?:\/\//.test(value))try{const u=new URL(value);for(const key of [...u.searchParams.keys()])if(/^(?:token|access_token|refresh_token|authorization|password|session|sessionid)$/i.test(key))u.searchParams.delete(key);return u.href;}catch{}
 return value;
}
const allowed=relative=>relative==='tenders.json'||relative==='exports/tenders.xlsx'||/^documents\/.+/.test(relative)&&!/(?:^|\/)[.]|\.(?:log|tmp|part)$/i.test(relative)||/^extracted\/[a-f0-9]{64}\.json$/.test(relative);
async function createBackup({root,destination}){
 const state=clean(validState(JSON.parse(fs.readFileSync(path.join(root,'tenders.json'),'utf8'))));
 state.job=null;state.portalQueueEnabled=false;
 for(const f of state.portalFlows||[])if(['ready','opening','navigating','waiting_for_captcha','waiting_for_login','waiting_for_user','downloading','receiving'].includes(f.state)){f.state='paused';f.message='Restored data snapshot. Open this flow explicitly to continue on this computer.';}
 const candidates=new Set();
 for(const r of state.records)for(const d of r.documents){
  if(d.localPath){if(allowed(d.localPath))candidates.add(d.localPath);else{delete d.localPath;d.status='manual_review';d.error='Local diagnostic file excluded from the shared data snapshot.';}}
  if(d.cache&&allowed(d.cache))candidates.add(d.cache);
 }
 if(fs.existsSync(path.join(root,'exports/tenders.xlsx')))candidates.add('exports/tenders.xlsx');
 const contents=Buffer.from(JSON.stringify(state,null,2));
 const manifest={schemaVersion:1,id:crypto.randomUUID(),createdAt:new Date().toISOString(),records:state.records.length,files:[{path:'tenders.json',bytes:contents.length,sha256:crypto.createHash('sha256').update(contents).digest('hex')}],totalBytes:contents.length};
 const realRoot=fs.realpathSync(root);
 for(const relative of [...candidates].sort()){
  const absolute=within(root,relative);within(realRoot,fs.realpathSync(absolute));
  const bytes=fs.statSync(absolute).size;manifest.files.push({path:relative,bytes,sha256:await hashFile(absolute)});manifest.totalBytes+=bytes;
 }
 fs.mkdirSync(path.dirname(destination),{recursive:true});
 const building=destination+'.'+crypto.randomUUID()+'.tmp';
 await new Promise((resolve,reject)=>{
  const output=fs.createWriteStream(building),archive=archiver('zip',{zlib:{level:6}});
  output.on('close',resolve);output.on('error',reject);archive.on('error',reject);archive.pipe(output);
  archive.append(contents,{name:'data/tenders.json'});
  for(const file of manifest.files.filter(f=>f.path!=='tenders.json'))archive.file(within(root,file.path),{name:'data/'+file.path});
  archive.append(JSON.stringify(manifest,null,2),{name:'data/snapshot-manifest.json'});archive.finalize().catch(reject);
 });
 fs.renameSync(building,destination);
 return {...manifest,archive:destination,archiveBytes:fs.statSync(destination).size,archiveSha256:await hashFile(destination)};
}
function hasRecords(root){const file=path.join(root,'tenders.json');return fs.existsSync(file)&&validState(JSON.parse(fs.readFileSync(file,'utf8'))).records.length>0;}
async function restoreBackup({archive,root,expectedHash}){
 if(hasRecords(root))return{restored:false,reason:'Existing saved records retained.'};
 if(expectedHash&&await hashFile(archive)!==expectedHash)throw new Error('Data backup failed its SHA256 check. Existing data was left untouched.');
 const zip=await unzipper.Open.file(archive),entries=zip.files.filter(f=>f.type==='File');
 const manifestFile=entries.find(f=>f.path==='data/snapshot-manifest.json');if(!manifestFile)throw new Error('This ZIP is not a facade data backup.');
 const manifest=JSON.parse((await manifestFile.buffer()).toString('utf8'));
 if(manifest.schemaVersion!==1||!Array.isArray(manifest.files)||manifest.files.length>50000||manifest.totalBytes>10*1024**3)throw new Error('Invalid data backup manifest.');
 const listed=new Map();
 for(const f of manifest.files){if(!allowed(f.path)||f.path.includes('\\')||f.path.split('/').includes('..')||!Number.isSafeInteger(f.bytes)||f.bytes<0||!/^[a-f0-9]{64}$/.test(f.sha256)||listed.has(f.path.toLowerCase()))throw new Error('Unsafe or duplicate backup path.');listed.set(f.path.toLowerCase(),f);}
 if(!listed.has('tenders.json')||manifest.totalBytes!==manifest.files.reduce((n,f)=>n+f.bytes,0))throw new Error('Incomplete backup manifest.');
 const names=new Set();
 for(const entry of entries){if(names.has(entry.path.toLowerCase()))throw new Error('Duplicate ZIP entry');names.add(entry.path.toLowerCase());if(entry.path==='data/snapshot-manifest.json')continue;const relative=entry.path.startsWith('data/')?entry.path.slice(5):'';if(!listed.has(relative.toLowerCase()))throw new Error('Unexpected ZIP entry; no files were restored.');}
 if(entries.length!==manifest.files.length+1)throw new Error('Backup files are missing.');
 const parent=path.resolve(path.dirname(root));fs.mkdirSync(parent,{recursive:true});
 const stat=fs.statfsSync(parent);if(stat.bavail*stat.bsize<manifest.totalBytes*1.1)throw new Error('Not enough free disk space to restore tender data.');
 const stage=fs.mkdtempSync(path.join(parent,'.data-restore-'));
 try{
  for(const entry of entries){
   if(entry.path==='data/snapshot-manifest.json')continue;
   const file=listed.get(entry.path.slice(5).toLowerCase()),target=within(stage,file.path);fs.mkdirSync(path.dirname(target),{recursive:true});
   const hash=crypto.createHash('sha256');let bytes=0;
   const verify=new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;if(bytes>file.bytes)return callback(new Error('Backup entry exceeds its declared size.'));hash.update(chunk);callback(null,chunk);}});
   await pipeline(entry.stream(),verify,fs.createWriteStream(target));
   if(bytes!==file.bytes||hash.digest('hex')!==file.sha256)throw new Error('Backup file integrity check failed: '+file.path);
  }
  const state=validState(JSON.parse(fs.readFileSync(path.join(stage,'tenders.json'),'utf8')));if(state.records.length!==manifest.records)throw new Error('Backup tender count mismatch.');
  // Install metadata last; it can never refer to partially restored files.
  for(const f of manifest.files.filter(f=>f.path!=='tenders.json')){const target=within(root,f.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.renameSync(within(stage,f.path),target);}
  fs.mkdirSync(root,{recursive:true});atomic(path.join(root,'restored-snapshot.json'),{id:manifest.id,createdAt:manifest.createdAt,restoredAt:new Date().toISOString()});fs.renameSync(path.join(stage,'tenders.json'),path.join(root,'tenders.json'));
  return{restored:true,records:manifest.records,files:manifest.files.length};
 }finally{
  const resolved=path.resolve(stage);if(path.dirname(resolved)===parent&&path.basename(resolved).startsWith('.data-restore-'))fs.rmSync(resolved,{recursive:true,force:true});
 }
}
function githubHeaders(){
 const output=execFileSync('git',['credential','fill'],{input:'protocol=https\nhost=github.com\nusername=deepakmr888\n\n',encoding:'utf8',cwd:project,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never'},stdio:['pipe','pipe','pipe']});
 const credentials=Object.fromEntries(output.trim().split(/\r?\n/).map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)];}));
 if(!credentials.password)throw new Error('Sign into GitHub using Git first, or copy downloaded-data.zip beside start.cmd.');
 return{Authorization:'Bearer '+credentials.password,Accept:'application/octet-stream','X-GitHub-Api-Version':'2022-11-28','User-Agent':'facade-lighting-data-restore'};
}
async function downloadBackup(descriptor,destination){
 const headers=githubHeaders(),url=`https://api.github.com/repos/${descriptor.repository}/releases/assets/${descriptor.assetId}`;
 let response=await fetch(url,{headers,redirect:'manual',signal:AbortSignal.timeout(3600000)});
 if([301,302,303,307,308].includes(response.status)){
  const target=new URL(response.headers.get('location'));if(target.protocol!=='https:'||!target.hostname.endsWith('.githubusercontent.com'))throw new Error('Unexpected GitHub data-download redirect.');
  await response.body?.cancel();response=await fetch(target.href,{signal:AbortSignal.timeout(3600000)});
 }
 if(!response.ok)throw new Error('GitHub data download failed (HTTP '+response.status+'). Copy downloaded-data.zip beside start.cmd to restore manually.');
 const temporary=path.join(project,'.runtime/data-download.part');fs.mkdirSync(path.dirname(temporary),{recursive:true});
 let bytes=0,nextReport=100*1024**2;const hash=crypto.createHash('sha256');
 const monitor=new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;if(bytes>descriptor.bytes)return callback(new Error('Data download exceeds its expected size.'));hash.update(chunk);if(bytes>=nextReport){console.log(`Saved-data download: ${Math.round(bytes/1024**2)} MB`);nextReport+=100*1024**2;}callback(null,chunk);}});
 await pipeline(response.body,monitor,fs.createWriteStream(temporary));
 if(bytes!==descriptor.bytes||hash.digest('hex')!==descriptor.sha256)throw new Error('Downloaded data archive failed its integrity check. Retry or copy the backup manually.');
 fs.renameSync(temporary,destination);
}
async function ensureSavedData({root=process.env.FACADE_DATA_DIR||path.join(project,'data'),archive=path.join(project,'downloaded-data.zip'),download=true}={}){
 if(hasRecords(root))return{restored:false,reason:'Existing saved records retained.'};
 const config=path.join(project,'saved-data.json');let descriptor;if(fs.existsSync(config))descriptor=JSON.parse(fs.readFileSync(config,'utf8'));
 if(!fs.existsSync(archive)&&descriptor&&download){console.log('Downloading the saved tender dataset from the private GitHub repository. No Tenderkart requests are needed.');await downloadBackup(descriptor,archive);}
 if(!fs.existsSync(archive)){if(descriptor)throw new Error('Place downloaded-data.zip in the project folder beside start.cmd, then start again.');return{restored:false,reason:'No saved data backup configured.'};}
 console.log('Checking and restoring saved tenders, documents and extracted text…');
 return restoreBackup({archive,root,expectedHash:descriptor?.sha256});
}
module.exports={createBackup,restoreBackup,ensureSavedData,hashFile,clean,githubHeaders};
