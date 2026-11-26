const path=require('path');
const {createBackup}=require('../server/data-backup.cjs');
const root=path.resolve(__dirname,'..');
createBackup({root:process.env.FACADE_DATA_DIR||path.join(root,'data'),destination:path.join(root,'downloaded-data.zip')}).then(result=>{require('fs').mkdirSync(path.join(root,'release'),{recursive:true});require('fs').writeFileSync(path.join(root,'release/data-backup-build.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({archive:result.archive,records:result.records,files:result.files.length,bytes:result.archiveBytes,sha256:result.archiveSha256}));}).catch(e=>{console.error(e.message);process.exitCode=1;});
