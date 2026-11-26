const fs=require('fs'),path=require('path'),archiver=require('archiver');
const root=path.resolve(__dirname,'..'),out=path.join(root,'release');fs.mkdirSync(out,{recursive:true});
const output=fs.createWriteStream(path.join(out,'facade-lighting-portal-source.zip')),archive=archiver('zip',{zlib:{level:9}});
archive.on('error',error=>{console.error(error.message);process.exitCode=1;output.destroy();});
output.on('close',()=>console.log(`Source ZIP: ${output.path} (${archive.pointer()} bytes; runtime data and sessions excluded)`));
archive.pipe(output);
for(const name of ['server','scripts','public','connector','tests'])archive.directory(path.join(root,name),name);
for(const name of ['package.json','package-lock.json','README.md','start.cmd','start-lan.cmd','.gitignore','.env.example'])archive.file(path.join(root,name),{name});
archive.append('',{name:'data/.gitkeep'});archive.finalize();
