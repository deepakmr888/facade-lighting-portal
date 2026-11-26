const fs=require('fs'),path=require('path'),archiver=require('archiver');
const root=path.resolve(__dirname,'..');
const output=fs.createWriteStream(path.join(root,'public/connector.zip')),archive=archiver('zip',{zlib:{level:9}});
archive.on('error',error=>{console.error(error.message);process.exitCode=1;output.destroy();});
archive.pipe(output);archive.directory(path.join(root,'connector'),false);archive.finalize();
