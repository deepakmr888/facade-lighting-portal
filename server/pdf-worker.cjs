const fs=require('fs');
const parse=require('pdf-parse');
(async()=>{
  try{const result=await parse(fs.readFileSync(process.argv[2]),{version:'v2.0.550'});process.send({ok:true,text:result.text,pages:result.numpages},()=>process.exit(0));}
  catch(error){process.send({ok:false,error:error.message},()=>process.exit(0));}
})();
