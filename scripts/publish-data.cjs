const fs=require('fs'),path=require('path');
const {Transform}=require('stream');
const {createBackup,hashFile,githubHeaders}=require('../server/data-backup.cjs');
const {atomic}=require('../server/store.cjs');
const root=path.resolve(__dirname,'..'),repository='deepakmr888/facade-lighting-portal';
async function main(){
 const buildFile=path.join(root,'release/data-backup-build.json');let backup;
 if(process.argv.includes('--existing'))backup=JSON.parse(fs.readFileSync(buildFile,'utf8'));
 else{
  backup=await createBackup({root:process.env.FACADE_DATA_DIR||path.join(root,'data'),destination:path.join(root,'downloaded-data.zip')});
  atomic(buildFile,backup);
 }
 if(await hashFile(backup.archive)!==backup.archiveSha256)throw new Error('The local archive has changed. Build the data backup again.');
 const auth={...githubHeaders(),Accept:'application/vnd.github+json'};
 async function api(endpoint,body,method=body?'POST':'GET'){
  const response=await fetch('https://api.github.com'+endpoint,{method,headers:{...auth,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(120000)});
  const value=await response.json();if(!response.ok)throw new Error(`GitHub HTTP ${response.status}: ${value.message||'Request failed'}`);return value;
 }
 const repo=await api('/repos/'+repository);if(!repo.private)throw new Error('Data backup publication requires this repository to remain private.');
 const tag='data-'+new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d+Z$/,'Z');
 const release=await api('/repos/'+repository+'/releases',{tag_name:tag,target_commitish:'main',name:`Saved tender data — ${backup.records} tenders`,draft:true,body:'Saved tender metadata, documents, extracted text and Excel. Login credentials and browser pairing are excluded. The app restores this dataset on an empty installation.'});
 atomic(path.join(root,'.runtime/data-upload-progress.json'),{stage:'uploading',releaseId:release.id,tag,bytes:0,total:backup.archiveBytes});
 const upload=new URL(release.upload_url.replace(/\{.*$/,''));if(upload.hostname!=='uploads.github.com'||upload.protocol!=='https:')throw new Error('Unexpected GitHub upload URL');upload.searchParams.set('name','downloaded-data.zip');
 let sent=0,lastUpdate=0,lastPrinted=0;
 const progress=new Transform({transform(chunk,encoding,callback){sent+=chunk.length;const now=Date.now();if(now-lastUpdate>2000){atomic(path.join(root,'.runtime/data-upload-progress.json'),{stage:'uploading',releaseId:release.id,tag,bytes:sent,total:backup.archiveBytes});lastUpdate=now;}if(sent-lastPrinted>=50*1024**2){console.log(`Uploading saved data: ${Math.round(sent/1024**2)} / ${Math.round(backup.archiveBytes/1024**2)} MB`);lastPrinted=sent;}callback(null,chunk);}});
 const body=fs.createReadStream(backup.archive).pipe(progress);
 const response=await fetch(upload,{method:'POST',headers:{...auth,'Content-Type':'application/zip','Content-Length':String(backup.archiveBytes)},body,duplex:'half',signal:AbortSignal.timeout(3600000)});
 const asset=await response.json();if(!response.ok)throw new Error(`Data upload failed (HTTP ${response.status}): ${asset.message||'GitHub rejected the upload'}`);
 if(asset.state!=='uploaded'||asset.size!==backup.archiveBytes||asset.digest&&asset.digest!=='sha256:'+backup.archiveSha256)throw new Error('GitHub asset integrity check failed. The release remains a draft.');
 const published=await api('/repos/'+repository+'/releases/'+release.id,{draft:false},'PATCH');
 const descriptor={schemaVersion:1,repository,releaseTag:tag,releaseUrl:published.html_url,assetId:asset.id,assetName:'downloaded-data.zip',bytes:backup.archiveBytes,sha256:backup.archiveSha256,records:backup.records,files:backup.files.length,createdAt:backup.createdAt};
 atomic(path.join(root,'saved-data.json'),descriptor);atomic(path.join(root,'.runtime/data-upload-progress.json'),{stage:'complete',releaseId:release.id,bytes:backup.archiveBytes,total:backup.archiveBytes});
 console.log(JSON.stringify({release:published.html_url,assetId:asset.id,records:backup.records,bytes:backup.archiveBytes,published:true}));
}
main().catch(error=>{console.error(error.message);console.error('Saved local records are unchanged. An incomplete upload is not published.');process.exitCode=1;});
