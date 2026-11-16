// Run against `node serve.mjs 5176`. Requires Playwright and Chrome.
// Real app/login/engine/scoring/storage/IndexedDB; only the Firebase boundary is simulated.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { chromium, webkit } = createRequire(import.meta.url)('playwright');
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:5176';
const output = process.env.V6_ARTIFACT_DIR || '/tmp/oshs-v6-review';
await mkdir(output, { recursive: true });
const browser = process.env.TEST_BROWSER === 'webkit'
  ? await webkit.launch({headless:true})
  : await chromium.launch({channel:'chrome',headless:true});
const report = [];
const firebase = `
export const getPublicDb = async () => ({app:{options:{projectId:'test-only'}}});
export const doc = (...args) => args;
export const getDoc = async () => ({data:() => ({boothMode:true,idleMinutes:10})});
export const sessionPolicy = data => data;
export const loginAdmin = async () => {throw Error('Not used in this UI test')};
export const errorMessage = error => error.message;
export const firebaseError = error => error;
export const adminContext = async () => {throw Error('Not used in this UI test')};
`;
const database = `
import { CHALLENGE } from '/typing/challenge.js';
import { countKeystrokes } from '/typing/scoring.js';
export const readEvent = async () => ({activeChallengeId:CHALLENGE.challengeId,phase:'A'});
export const readChallenge = async () => {const text=window.__challengeText || CHALLENGE.text;return {...CHALLENGE,text,referenceKeystrokes:countKeystrokes(text)}};
export const readTypingCertificate = async () => null;
export const validateTypingResult = value => value;
export async function submitTyping(db, participant, record) {
  window.__submitted.push(structuredClone(record));
  await new Promise(resolve => setTimeout(resolve, window.__saveDelay ?? 80));
  if (window.__failSave) throw Error('테스트: 서버에 연결하지 못했습니다. 다시 시도하세요.');
  return record;
}
`;
async function setup(width=1365,height=900,{fail=false,backup=false,text,delay=80}={}) {
  const context = await browser.newContext({viewport:{width,height}, acceptDownloads:true});
  await context.route('**/db/firebase.js*', route => route.fulfill({contentType:'text/javascript',body:firebase}));
  await context.route('**/db/database.js*', route => route.fulfill({contentType:'text/javascript',body:database}));
  await context.addInitScript(({fail,backup,text,delay}) => {
    window.__failSave = fail; window.__submitted = []; window.__challengeText = text; window.__saveDelay=delay;
    if (backup) Object.defineProperty(window,'indexedDB',{value:undefined});
  },{fail,backup,text,delay});
  const page = await context.newPage();
  page.on('pageerror', error => { throw error; });
  await page.goto(`${base}/typing/`);
  await page.locator('#entry-form').waitFor();
  return {context,page};
}
async function login(page) {
  await page.locator('[name=studentNumber]').fill('20101');
  await page.locator('[name=name]').fill('김오성');
  await page.locator('#entry-form button').click();
  await page.waitForFunction(() => !document.getElementById('typing-input').disabled);
}
async function waitText(page,selector,text) {
  await page.waitForFunction(({selector,text}) => document.querySelector(selector).textContent.includes(text),{selector,text});
}
async function overflow(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
}
async function shot(page,name) { await page.screenshot({path:`${output}/${name}.png`,fullPage:true,animations:'disabled'}); }
// Native beforeinput metadata matters for selection edits and IME; these events deliberately
// model browser IME ordering, while real Korean OS keyboard input remains a manual check.
async function ime(page,value) {
  await page.locator('#typing-input').evaluate((input,value) => {
    input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));
    input.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,inputType:'insertCompositionText',data:value,isComposing:true}));
    input.value=value;
    input.setSelectionRange(value.length,value.length);
    input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:value,isComposing:true}));
  },value);
}
async function endIme(page,value) {
  await page.locator('#typing-input').evaluate((input,value) => {
    input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:value}));
    input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));
  },value);
}
try {
  // Full default phrase at laptop and mobile sizes, before and after entry.
  for (const [width,height] of [[1365,900],[1366,768],[1024,768],[768,1024],[390,844],[320,740]]) {
    const {context,page}=await setup(width,height);
    await overflow(page); await shot(page,`login-${width}`);
    await login(page); await overflow(page); await shot(page,`typing-${width}`);
    const geometry = await page.evaluate(() => {
      const title=document.querySelector('h1').getBoundingClientRect();
      const input=document.querySelector('#typing-input').getBoundingClientRect();
      const mascot=document.querySelector('#obyeol').getBoundingClientRect();
      return {title: title.top, inputBottom:input.bottom, mascot:mascot.width, shellBottom:document.querySelector('.typing-shell').getBoundingClientRect().bottom, viewport:innerHeight};
    });
    assert(geometry.title>=0); assert(geometry.mascot>0);
    if(width>=1024) assert(geometry.shellBottom<height,JSON.stringify(geometry));
    report.push({case:`layout ${width}×${height}`, ...geometry});
    await context.close();
  }
  {
    const {context,page}=await setup(1365,900,{text:'가나다라마바사아자차카타파하',delay:700});
    await page.clock.install();
    await login(page);
    await ime(page,'ㄱ');
    assert.equal(await page.locator('#errors').textContent(),'0');
    assert.equal(await page.locator('#challenge .incorrect').count(),1);
    assert.equal(await page.locator('#challenge .composing').count(),0);
    assert.equal(await page.locator('#obyeol').getAttribute('data-mood'),'idle');
    await page.locator('#typing-input').evaluate(input => {input.value='가';input.setSelectionRange(1,1);});
    await endIme(page,'가');
    await page.clock.fastForward(6000);
    assert.equal(await page.locator('#errors').textContent(),'0');
    assert.equal(await page.locator('#obyeol').getAttribute('data-mood'),'focus');
    await page.keyboard.insertText('X');
    assert.equal(await page.locator('#errors').textContent(),'1');
    assert.equal(await page.locator('#obyeol').getAttribute('data-mood'),'surprised');
    await page.keyboard.insertText('Y');
    assert.equal(await page.locator('#errors').textContent(),'2');
    assert.equal(await page.locator('#obyeol').getAttribute('data-mood'),'angry');
    await shot(page,'reaction-angry');
    await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');
    assert.equal(await page.locator('#errors').textContent(),'2');
    await page.keyboard.insertText('나');
    assert.equal(await page.locator('#obyeol').getAttribute('data-mood'),'angry');
    await page.clock.fastForward(1500);
    for(const char of '다라마바사아자') await page.keyboard.insertText(char);
    assert.equal(await page.locator('#obyeol').getAttribute('data-mood'),'happy');
    await shot(page,'reaction-happy');
    await page.keyboard.insertText('차카타파하');
    await page.locator('#record-dialog[open]').waitFor();
    assert.equal(await page.locator('#obyeol').getAttribute('data-mood'),'complete');
    await waitText(page,'#record-save-status','저장하고');
    await shot(page,'record-saving');
    assert.equal(await page.locator('#record-student').textContent(),'20101');
    assert.equal(await page.locator('#record-name').textContent(),'김오성');
    await page.waitForFunction(()=>document.querySelector('#record-save-status').dataset.state==='saved' && document.querySelector('#record-save-status').hidden);
    const result=await page.evaluate(()=>window.__submitted[0]);
    assert.equal(result.errors,2); assert.equal(result.score,Math.max(0,result.speed-6));
    const identity=await page.evaluate(()=>document.activeElement.id);
    assert.equal(identity,'record-close');
    for(let i=0;i<5;i++) {await page.keyboard.press('Tab'); assert(await page.evaluate(()=>document.activeElement.closest('#record-dialog')!==null));}
    await page.keyboard.press('Shift+Tab');
    assert(await page.evaluate(()=>document.activeElement.closest('#record-dialog')!==null));
    await shot(page,'record-desktop');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#record-dialog').getAttribute('open'),null);
    await page.waitForFunction(()=>document.activeElement.id==='show-record');
    await page.locator('#show-record').click(); await page.locator('#record-close').click();
    await page.locator('#student-logout').click();
    assert.equal(await page.locator('#record-name').textContent(),'');
    assert.equal(await page.locator('#show-record').isVisible(),false);
    report.push({case:'IME composition, typo streak/recovery, deletion, 3 point scoring, success, focus trap, Escape, reopen, next participant',passed:true});
    await context.close();
  }
  // Real IndexedDB queue on server failure; retry reuses exactly the same record.
  {
    const {context,page}=await setup(390,844,{fail:true,text:'가나다라'});
    await page.clock.install();
    await login(page); await page.keyboard.insertText('가'); await page.clock.fastForward(2000); await page.keyboard.insertText('나다라');
    await waitText(page,'#record-save-status','기기에 보관'); await shot(page,'record-failed-mobile');
    await overflow(page); await page.locator('#record-return').click();
    await page.waitForFunction(()=>document.activeElement.id==='retry');
    assert.equal(await page.locator('#rescue').isVisible(),false);
    const queued=await page.evaluate(()=>new Promise((resolve,reject)=>{
      const r=indexedDB.open('osung-typing',1);r.onsuccess=()=>{const db=r.result;const get=db.transaction('results').objectStore('results').getAll();get.onsuccess=()=>{resolve(get.result);db.close()};get.onerror=reject};r.onerror=reject;
    }));
    assert.equal(queued.length,1); assert.equal(queued[0].syncState,'pending');
    await shot(page,'failed-controls-mobile');
    await page.evaluate(()=>{window.__failSave=false;}); await page.locator('#retry').click();
    await waitText(page,'#attempt-status','저장 완료');
    const records=await page.evaluate(()=>window.__submitted);
    assert.equal(records.length,2); assert.deepEqual(records[0],records[1]);
    await page.locator('#show-record').click(); await page.waitForFunction(()=>document.querySelector('#record-save-status').dataset.state==='saved' && document.querySelector('#record-save-status').hidden);
    await shot(page,'record-mobile'); await page.locator('#record-close').click();
    report.push({case:'server failure + IndexedDB queue + exact retry payload + mobile result',passed:true});
    await context.close();
  }
  {
    const {context,page}=await setup(320,740,{fail:true,backup:true,text:'가나'});
    await page.clock.install();
    await login(page); await page.keyboard.insertText('가'); await page.clock.fastForward(1000); await page.keyboard.insertText('나');
    await waitText(page,'#record-save-status','기기 보관에 실패');
    await shot(page,'record-backup-320'); await overflow(page);
    await page.locator('#record-return').click(); await page.locator('#rescue').waitFor();
    const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#rescue').click()]);
    assert(download.suggestedFilename().startsWith('typing-'));
    await page.locator('#rescue-confirm').click();
    await page.locator('#show-record').click(); await waitText(page,'#record-save-status','저장한 기록 파일');
    assert(!(await page.locator('#record-save-status').textContent()).includes('기록이 저장되었어요'));
    await shot(page,'record-backup-confirmed');
    report.push({case:'server + IndexedDB failure, JSON download, backup confirmation truthfulness at 320px',passed:true});
    await context.close();
  }
  {
    const text='가나다라마바사아자차카타파하 '.repeat(24).trim();
    const {context,page}=await setup(390,844,{text});
    await login(page);
    await page.setViewportSize({width:1366,height:768});
    assert(await page.locator('.typing-shell').evaluate(el=>el.getBoundingClientRect().bottom < innerHeight));
    await shot(page,'long-prompt-desktop');
    await page.setViewportSize({width:390,height:844});
    await page.keyboard.insertText('틀');
    await page.locator('#typing-input').evaluate(input=>input.select());
    await page.keyboard.insertText('가');
    assert.equal(await page.locator('#obyeol').getAttribute('data-mood'),'surprised');
    assert.equal(await page.locator('#errors').textContent(),'1');
    const colors=await page.locator('#challenge .correct').first().evaluate(el=>({bg:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color}));
    assert.equal(colors.bg,'rgba(0, 0, 0, 0)');
    assert.equal(colors.color,'rgb(23, 104, 65)');
    await page.keyboard.insertText(text.slice(1,250));
    assert(await page.locator('#challenge').evaluate(el=>el.scrollHeight<=el.clientHeight+1));
    await overflow(page); await shot(page,'long-prompt-mobile');
    await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
    await context.close();
    report.push({case:'selection correction, color-only feedback, long prompt is fully visible without internal clipping',passed:true});
  }
  {
    const {context,page}=await setup(390,844);
    await page.emulateMedia({reducedMotion:'reduce'}); await login(page);
    assert.equal(await page.locator('.ob-float').first().evaluate(el=>getComputedStyle(el).animationName),'none');
    await page.keyboard.insertText('동');
    await page.locator('#typing-input').dispatchEvent('paste');
    await waitText(page,'#feedback','직접 입력');
    await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
    await waitText(page,'#attempt-status','중단');
    assert.equal(await page.locator('#typing-input').isDisabled(),true);
    assert.equal(await page.evaluate(()=>window.__submitted.length),0);
    report.push({case:'reduced motion, paste blocked, blur invalidation without save',passed:true});
    await context.close();
  }
  // Landing has only the two authorized event destinations.
  {
    const {context,page}=await setup(390,844);
    await page.goto(base); await overflow(page); await shot(page,'landing-mobile');
    assert.deepEqual(await page.locator('.event-card h2').allTextContents(),['타자 대회','글쓰기']);
    await page.setViewportSize({width:1365,height:900}); await shot(page,'landing-desktop');
    await context.close();
  }
  await writeFile(`${output}/report.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally { await browser.close(); }
