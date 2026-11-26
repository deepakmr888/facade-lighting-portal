const path=require('path');
const {ensureSavedData}=require('../server/data-backup.cjs');
ensureSavedData({...(process.argv[2]?{archive:path.resolve(process.argv[2])}:{})}).then(result=>console.log(JSON.stringify(result))).catch(e=>{console.error('Saved-data restore: '+e.message);process.exitCode=1;});
