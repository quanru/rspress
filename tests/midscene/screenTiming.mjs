import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import {OriginalFixture} from './scripts/original-fixture.ts';
import {fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(import.meta.url);
const {chromium}=require('playwright');const sharp=require('sharp');
async function imageDifference(a,b){
 const decode=async s=>sharp(Buffer.from(s.split(',')[1],'base64')).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 const [x,y]=await Promise.all([decode(a),decode(b)]);if(x.info.width!==y.info.width||x.info.height!==y.info.height)return {changedPixels:0,dimensionsChanged:true};
 let changedPixels=0;for(let i=0;i<x.data.length;i+=4)if(Math.max(Math.abs(x.data[i]-y.data[i]),Math.abs(x.data[i+1]-y.data[i+1]),Math.abs(x.data[i+2]-y.data[i+2]))>32)changedPixels++;
 return {changedPixels,dimensionsChanged:false};
}
const dir=process.env.OUTPUT_DIR||'screen-timing-'+Date.now();await fs.mkdir(dir);console.log(dir);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const stats=a=>{a=[...a].sort((a,b)=>a-b);return {n:a.length,median:a[Math.floor(a.length*.5)],p95:a[Math.min(a.length-1,Math.ceil(a.length*.95)-1)],max:a.at(-1)}};
const results={machine:{model:os.cpus()[0].model,cpus:os.cpus().length,memoryGiB:os.totalmem()/2**30},diff:[],browser:[]};
const fixture=new OriginalFixture(repo,true);let browser;const loads=[];let loadPromise;
try{const origin=await fixture.open('nav-slots','production');browser=await chromium.launch({headless:true});
for(const count of (process.env.COUNTS||"1,10,40").split(",").map(Number)){const contexts=[],pages=[];for(let i=0;i<count;i++){const ctx=await browser.newContext({viewport:{width:390,height:844}});contexts.push(ctx);const p=await ctx.newPage();if(process.env.CPU_RATE){const cdp=await ctx.newCDPSession(p);await cdp.send("Emulation.setCPUThrottlingRate",{rate:Number(process.env.CPU_RATE)})}await p.goto(origin);await p.locator('.rp-nav-hamburger:visible').click();await p.locator('.rp-nav-screen-menu-item').filter({hasText:/^More$/}).click();pages.push(p)}await sleep(1000);
if(process.env.BUILD_LOAD){for(let j=0;j<Number(process.env.BUILD_LOAD);j++)loads.push(new OriginalFixture(repo,true));loadPromise=Promise.allSettled(loads.map(f=>f.open('nav-slots','production')));await sleep(500)}
const rows=[];for(let round=0;round<Number(process.env.ROUNDS||3);round++){const batch=await Promise.all(pages.map(async(p,i)=>{const nested=p.locator('.rp-nav-screen-menu-item').filter({hasText:/^Nested$/});const box=await nested.boundingBox();await p.evaluate(()=>{window.probe={};const now=()=>performance.timeOrigin+performance.now();document.addEventListener('click',()=>{window.probe.handler=now();requestAnimationFrame(()=>requestAnimationFrame(()=>window.probe.raf2=now()))},{capture:true,once:true});const obs=new MutationObserver(()=>{window.probe.mutation=now();obs.disconnect()});obs.observe(document.body,{attributes:true,subtree:true,childList:true});});
const start=Date.now();await p.mouse.click(box.x+box.width/2,box.y+box.height/2);const returned=Date.now();await sleep(300);const shotStart=Date.now();const a=await p.screenshot({type:'jpeg',quality:90});const shotEnd=Date.now();await sleep(1000);const b=await p.screenshot({type:'jpeg',quality:90});const probe=await p.evaluate(()=>window.probe);const diff=await imageDifference('data:image/jpeg;base64,'+a.toString('base64'),'data:image/jpeg;base64,'+b.toString('base64'));if(diff.changedPixels>=16||(round===0&&i===0)){await fs.writeFile(`${dir}/${count}-${round}-${i}-immediate.jpg`,a);await fs.writeFile(`${dir}/${count}-${round}-${i}-settled.jpg`,b)}return {count,round,i,clickMs:returned-start,shotMs:shotEnd-shotStart,handlerMs:probe.handler-start,mutationMs:probe.mutation-start,raf2Ms:probe.raf2-start,shotRequestMs:shotStart-start,diff};}));rows.push(...batch);}
const summary={count,rows:rows.length,click:stats(rows.map(x=>x.clickMs)),shot:stats(rows.map(x=>x.shotMs)),handler:stats(rows.map(x=>x.handlerMs)),raf2:stats(rows.map(x=>x.raf2Ms)),unstable:rows.filter(x=>x.diff.changedPixels>=16).length};results.browser.push({summary,rows});await fs.writeFile(dir+'/results.json',JSON.stringify(results,null,2));console.log('BROWSER',JSON.stringify(summary));if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,`| ${count} | ${process.env.BUILD_LOAD||0} | ${rows.length} | ${summary.click.median}/${summary.click.p95} | ${summary.shot.median}/${summary.shot.p95} | ${summary.shot.max} | ${summary.unstable} |\n`);await Promise.all(contexts.map(c=>c.close()));if(loadPromise){console.log("BUILDS",JSON.stringify((await loadPromise).map(x=>({status:x.status,error:x.reason?.message}))));await Promise.all(loads.map(f=>f.close()));loads.length=0;loadPromise=undefined}}
}finally{await browser?.close();await fixture.close();await Promise.all(loads.map(f=>f.close()));await fs.writeFile(dir+'/results.json',JSON.stringify(results,null,2));}
