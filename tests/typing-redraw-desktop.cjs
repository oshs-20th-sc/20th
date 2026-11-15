// Desktop-only regression checks for the reference redraw and centered login.
// Start `node serve.mjs 5176`; requires Playwright and Google Chrome.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {chromium}=require('playwright');
const out=process.env.V6_ARTIFACT_DIR || '/tmp/oshs-v6-redraw';
fs.mkdirSync(out,{recursive:true});
const firebase=`
export const getPublicDb=async()=>({app:{options:{projectId:'test-only'}}});
export const doc=(...args)=>args;
export const getDoc=async()=>({data:()=>({boothMode:true,idleMinutes:10})});
export const sessionPolicy=data=>data;
export const loginAdmin=async()=>{throw Error('unused')};
export const errorMessage=error=>error.message;
export const firebaseError=error=>error;
export const adminContext=async()=>{throw Error('unused')};`;
const database=`
import {countKeystrokes} from '/typing/scoring.js';
const text='가나다라마바사아자차카타파하';
export const readEvent=async()=>({activeChallengeId:'test-only',phase:'A'});
export const readChallenge=async()=>{const current=window.__longPrompt || text;return {challengeId:'test-only',text:current,title:'타자 문구',referenceKeystrokes:countKeystrokes(current),practice:false}};
export const diagnoseTypingSubmission=async()=>({kind:'rules_rejection_unresolved'});
export const validateTypingResult=value=>value;
export const submitTyping=async(db,participant,record)=>{window.__record=record;if(window.__rejectSave){const error=Error('같은 학번의 기존 기록 또는 접수 조건을 확인해 주세요.');error.code='TYPING_REJECTED';throw error}return record};`;
(async()=>{
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
const page=await browser.newPage();
page.on('pageerror',e=>{throw e});
await page.route('**/db/firebase.js*',r=>r.fulfill({contentType:'text/javascript',body:firebase}));
await page.route('**/db/database.js*',r=>r.fulfill({contentType:'text/javascript',body:database}));
const measurements=[];
for(const [width,height] of [[1366,768],[1710,1060]]){
 await page.setViewportSize({width,height});await page.goto('http://127.0.0.1:5176/typing/');await page.locator('#entry-form').waitFor();
 const info=await page.evaluate(()=>{const rect=el=>{const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}};const shell=rect(document.querySelector('.typing-shell'));return{shell,centerDelta:Math.abs((shell.top+shell.bottom)/2-innerHeight/2),student:rect(document.querySelector('[name=studentNumber]')),name:rect(document.querySelector('[name=name]')),overflow:document.documentElement.scrollWidth>innerWidth}});
 assert.equal(info.shell.width,660);assert(info.centerDelta<8);assert(info.name.top>info.student.bottom);assert.equal(info.student.width,380);assert.equal(info.overflow,false);
 assert.equal(await page.locator('#obyeol svg').getAttribute('viewBox'),'0 0 460 480');
 assert.equal(await page.locator('.status-chip, .intro-kicker, .inside-nav').count(),0);
 assert(await page.locator('#obyeol-message').isVisible());
 assert.equal(await page.locator('#obyeol-message').evaluate(el=>getComputedStyle(el,'::after').width),'9px');
 await page.screenshot({path:`${out}/redraw-login-final-${width}.png`,animations:'disabled'});measurements.push({width,height,...info});
}
await page.setViewportSize({width:1366,height:768});await page.clock.install();
await page.locator('[name=studentNumber]').fill('20101');await page.locator('[name=name]').fill('김오성');await page.locator('#entry-form button').click();await page.waitForFunction(()=>!document.querySelector('#typing-input').disabled);
await page.keyboard.insertText('가');await page.clock.fastForward(6000);assert.equal(await page.locator('#obyeol').getAttribute('data-mood'),'focus');
await page.keyboard.insertText('X');assert.equal(await page.locator('#obyeol').getAttribute('data-mood'),'surprised');await page.waitForFunction(()=>getComputedStyle(document.querySelector('#obyeol .ob-mouth-pout')).opacity==='1');
await page.keyboard.insertText('Y');assert.equal(await page.locator('#obyeol').getAttribute('data-mood'),'angry');
await page.keyboard.press('Backspace');await page.keyboard.press('Backspace');await page.keyboard.insertText('나');assert.equal(await page.locator('#obyeol').getAttribute('data-mood'),'angry');
for(const char of '다라') await page.keyboard.insertText(char);
assert.equal(await page.locator('#obyeol').getAttribute('data-mood'),'angry');
await page.clock.fastForward(1500);await page.keyboard.insertText('마');
assert.equal(await page.locator('#obyeol').getAttribute('data-mood'),'focus');
for(const char of '바사아자') await page.keyboard.insertText(char);assert.equal(await page.locator('#obyeol').getAttribute('data-mood'),'happy');
await page.screenshot({path:`${out}/redraw-typing-final-desktop.png`,animations:'disabled'});
await page.keyboard.insertText('차카타파하');await page.locator('#record-dialog[open]').waitFor();await page.waitForFunction(()=>document.querySelector('#record-save-status').dataset.state==='saved');
assert.equal(await page.locator('#obyeol').getAttribute('data-mood'),'complete');const record=await page.evaluate(()=>window.__record);assert.equal(record.errors,2);assert.equal(record.score,Math.max(0,record.speed-6));
await page.screenshot({path:`${out}/redraw-record-final-desktop.png`,animations:'disabled'});
await page.keyboard.press('Escape');await page.waitForFunction(()=>document.activeElement.id==='show-record');
await page.locator('#student-logout').click();await page.waitForFunction(()=>!document.body.classList.contains('has-participant'));
// A long prompt must be completely readable, with no internal clipping or scroll.
await page.reload();await page.locator('#entry-form').waitFor();
await page.evaluate(()=>{window.__longPrompt='천안오성고등학교에서 서로 소통하고 다양한 경험을 쌓으며 자신의 꿈을 향해 나아갑니다. '.repeat(7).trim()});
await page.locator('[name=studentNumber]').fill('20102');await page.locator('[name=name]').fill('문구확인');await page.locator('#entry-form button').click();await page.waitForFunction(()=>!document.querySelector('#typing-input').disabled);
const prompt=await page.locator('#challenge').evaluate(el=>({scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,maxHeight:getComputedStyle(el).maxHeight,overflow:getComputedStyle(el).overflowY,lastBottom:el.lastElementChild.getBoundingClientRect().bottom,panelBottom:el.getBoundingClientRect().bottom}));
assert.equal(prompt.maxHeight,'none');assert.equal(prompt.overflow,'visible');assert(prompt.scrollHeight<=prompt.clientHeight+1);assert(prompt.lastBottom<prompt.panelBottom);
assert.equal(await page.locator('#feedback').isVisible(),false);assert.equal(await page.locator('#attempt-status').textContent(),'');
await page.screenshot({path:`${out}/full-prompt-desktop.png`,animations:'disabled'});
await page.locator('#student-logout').click();
// Failed submission retains the real rejection message and the pending IndexedDB record.
await page.evaluate(()=>{window.__longPrompt='가나';window.__rejectSave=true});
await page.locator('[name=studentNumber]').fill('20103');await page.locator('[name=name]').fill('백업확인');await page.locator('#entry-form button').click();await page.waitForFunction(()=>!document.querySelector('#typing-input').disabled);await page.keyboard.insertText('가나');
await page.waitForFunction(()=>document.querySelector('#record-save-status').dataset.state==='failed');
const failure=await page.locator('#record-save-status').textContent();assert(failure.includes('같은 학번'));assert(failure.includes('기기에 보관'));assert(!failure.includes('저장되었어요'));
await page.locator('#record-return').click();await page.waitForFunction(()=>document.activeElement.id==='retry');assert(await page.locator('#retry').isVisible());
await page.screenshot({path:`${out}/save-rejection-desktop.png`,animations:'disabled'});
// Review all expressions together using the exact animated SVG markup and CSS.
await page.setContent(`<head><link rel="stylesheet" href="http://127.0.0.1:5176/style.css"><link rel="stylesheet" href="http://127.0.0.1:5176/typing/style.css"></head><body style="background:#fffaf0;padding:32px;display:flex;gap:16px"><div id="gallery" style="display:flex;gap:16px;width:1280px;height:250px"></div></body>`);
await page.evaluate(async()=>{const {mountObyeol}=await import('/typing/obyeol.js?v=obyeol-ui-v6');for(const [mood,label] of [['idle','대기'],['focus','집중'],['happy','연속 정답'],['surprised','오타'],['angry','연속 오타'],['complete','완료']]){const fig=document.createElement('div');fig.style='width:200px;text-align:center';const avatar=document.createElement('div');avatar.className='obyeol';avatar.dataset.mood=mood;mountObyeol(avatar);fig.append(avatar);const title=document.createElement('p');title.textContent=label;fig.append(title);document.querySelector('#gallery').append(fig)}});
await page.locator('#gallery').screenshot({path:`${out}/redraw-expression-gallery.png`,animations:'disabled'});
console.log(JSON.stringify({measurements,reactions:'idle/focus/surprised/angry/recovered/happy/complete passed',score:'original 3 point penalty preserved',record:'saved mock response and Escape focus restoration passed',prompt:'long text fully visible without internal scrolling',failure:'real rejection detail, pending backup and retry focus passed',mobileTests:false},null,2));
} finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exit(1)});
