import { spawn } from "node:child_process";
import { webcrypto as crypto, createHash } from "node:crypto";
import { chromium, firefox } from "playwright";
const BASE="http://127.0.0.1:3095"; const enc=new TextEncoder(); const INFO_AUTH=enc.encode("runa/v1/auth");
const b64=(b)=>Buffer.from(b).toString("base64"); const b64url=(b)=>Buffer.from(b).toString("base64url");
async function hkdf(i,s,n,l){const k=await crypto.subtle.importKey("raw",i,"HKDF",false,["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({name:"HKDF",hash:"SHA-256",salt:s,info:n},k,l*8));}
const server=spawn(`${process.cwd()}/../target/release/runa-server`,[],{env:{...process.env,RUNA_DIST:"dist",RUNA_BIND:"127.0.0.1:3095"},stdio:["ignore","ignore","ignore"]});
process.on("exit",()=>{try{server.kill()}catch{}});
await new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error("no server")),5000);
  const p=setInterval(async()=>{try{await fetch(`${BASE}/version`);clearInterval(p);clearTimeout(t);res()}catch{}},150)});
async function newRoom(){
  const ls=crypto.getRandomValues(new Uint8Array(32)),salt=crypto.getRandomValues(new Uint8Array(16));
  const ak=await hkdf(ls,salt,INFO_AUTH,32);
  const r=await fetch(`${BASE}/api/rooms/unlisted`,{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({verifier:createHash("sha256").update(ak).digest().toString("base64"),
      kdf:{m_kib:65536,t:3,p:1,salt:b64(salt)},ttl:{kind:"idle-peers",secs:3600}})});
  return `${BASE}/r/${(await r.json()).room_id}#k=${b64url(ls)}&s=${b64url(salt)}`;
}
// Indented blocks: the structure every earlier probe of mine lacked.
const doc=[]; for (let b=0;b<12;b++){ doc.push(`Block header ${b}`); for(let i=0;i<20;i++) doc.push(`    indented body line ${b}.${i}`); }
for (const [name, engine] of [["chromium",chromium],["firefox",firefox]]) {
  const browser=await engine.launch();
  const page=await browser.newPage();
  await page.setViewportSize({width:1300,height:650});
  await page.goto(await newRoom(),{waitUntil:"domcontentloaded"});
  await page.waitForSelector(".monaco-editor",{timeout:40000});
  await page.waitForTimeout(2500);
  await page.click('.mode-tab:has-text("Editor")').catch(()=>{});
  await page.click(".monaco-editor .view-lines");
  await page.keyboard.insertText(doc.join("\n"));
  await page.waitForTimeout(3000);
  const look = () => page.evaluate(() => {
    const w = document.querySelector(".sticky-widget");
    const r = w?.getBoundingClientRect();
    return { h: r ? Math.round(r.height) : -1, text: (w?.textContent ?? "").replace(/ /g," ").trim().slice(0,50) };
  });
  await page.mouse.move(650, 400);
  for (let i=0;i<90;i++){ await page.mouse.wheel(0,-500); await page.waitForTimeout(25); }
  await page.waitForTimeout(600);
  console.log(`${name.padEnd(9)} at top:      ${JSON.stringify(await look())}`);
  for (let i=0;i<12;i++){ await page.mouse.wheel(0,260); await page.waitForTimeout(160); }
  await page.waitForTimeout(600);
  console.log(`${name.padEnd(9)} scrolled in: ${JSON.stringify(await look())}`);
  await browser.close();
}
server.kill();
