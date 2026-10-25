// Executed inside the temporary production install, without workspace imports or fd on PATH.
import {access,writeFile,unlink} from "node:fs/promises";
import {createRequire} from "node:module";
import {dirname,join} from "node:path";
import {Connection,LocalExecutionEnv,localDaemon} from "@earendil-works/pi-env";
import {createNodePhotonImages} from "@earendil-works/pi-durable/images/node";
import {createReadTool} from "@earendil-works/pi-durable/tools";
import {BACKGROUND_CONTEXT as context} from "@earendil-works/chord/context";
import {CodemodeSandbox} from "@earendil-works/pi-codemode";
import sharp from "sharp";
const require=createRequire(import.meta.url);
const root=process.cwd();
const daemon=localDaemon();await access(daemon);
const platform=process.platform==="win32"?"windows":process.platform;
if(!daemon.includes(`${platform}-${process.arch}`))throw new Error(`Unexpected daemon platform: ${daemon}`);
await access(require.resolve("@silvia-odwyer/photon/photon_rs_bg.wasm"));
await access(join(dirname(require.resolve("@earendil-works/pi-durable/images/node")),"node-worker.js"));
const connection=new Connection({command:[daemon]});
const env=new LocalExecutionEnv({connection,cwd:root});
let pid;
try{
 const info=await connection.info();pid=info.pid;if(info.version!=="1.4.0"||!info.features.includes("listFiles"))throw new Error("Invalid packaged daemon");
 await writeFile("cache-first.txt","file body");
 let changed=false;const watch=await env.watch([{path:root}],()=>{changed=true;},context);if(!watch.ok)throw watch.error;
 const first=await env.listFiles(".",{maxEntries:100,exclude:["node_modules"]},context);if(!first.ok||!first.value.entries.some(entry=>entry.path==="cache-first.txt"))throw new Error("Initial discovery failed");
 await writeFile("cache-after.txt","next");for(let i=0;i<200&&!changed;i++)await new Promise(resolve=>setTimeout(resolve,25));if(!changed)throw new Error("Watch did not invalidate");
 const refreshed=await env.listFiles(".",{maxEntries:100,exclude:["node_modules"]},context);if(!refreshed.ok||!refreshed.value.entries.some(entry=>entry.path==="cache-after.txt"))throw new Error("Refresh failed");await watch.value.close(context);
 const processor=await createNodePhotonImages({idleMs:30});
 const read=createReadTool({images:processor});
 const api={env,agent:async()=>({model:{provider:"fixture",modelId:"vision"}}),models:{getModel:()=>({input:["text","image"],inputLimits:{images:{resize:{maxWidth:16,maxHeight:16,maxBytes:100000}}}})}};
 const png=await sharp({create:{width:32,height:24,channels:3,background:"red"}}).png().toBuffer();await writeFile("resize.png",png);
 const result=await read.execute({path:"resize.png"},api,context);const image=result.output?.find(block=>block.type==="image");if(!image||result.isError)throw new Error("Packaged read failed");const meta=await sharp(Buffer.from(image.data,"base64")).metadata();if(meta.width!==16||meta.height!==12||!result.diagnostics.some(note=>note.message.includes("Resized")))throw new Error("Photon resize failed");
 const bmp=Buffer.alloc(70);bmp.write("BM");bmp.writeUInt32LE(70,2);bmp.writeUInt32LE(54,10);bmp.writeUInt32LE(40,14);bmp.writeInt32LE(2,18);bmp.writeInt32LE(2,22);bmp.writeUInt16LE(1,26);bmp.writeUInt16LE(24,28);bmp.writeUInt32LE(16,34);bmp.fill(160,54);await writeFile("convert.bmp",bmp);
 const converted=await read.execute({path:"convert.bmp"},api,context);if(!converted.output?.some(block=>block.type==="image"&&block.mimeType==="image/png")||!converted.diagnostics?.some(note=>note.message.includes("Converted")))throw new Error("Photon BMP conversion failed");
 await unlink("resize.png");await unlink("convert.bmp");
 const sandbox=new CodemodeSandbox({memoryLimitBytes:256*1024*1024});
 try{const ran=await sandbox.execute("return 6*7;");if(!ran.ok||ran.value!==42)throw new Error("Packaged codemode script failed: "+JSON.stringify(ran));}finally{sandbox.close();}
 console.log(`Pi 1.4 production SDK smoke passed (${process.platform}/${process.arch}, daemon pid ${pid})`);
}finally{connection.close();}
if(pid){let stopped=false;for(let i=0;i<100;i++){try{process.kill(pid,0);}catch{stopped=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}if(!stopped)throw new Error("Packaged helper did not exit");}
