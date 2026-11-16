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
export const readTypingCertificate=async()=>{window.__certificateLookups=(window.__certificateLookups||0)+1;if(window.__certificateLookupError)throw Error('테스트: 기존 기록 조회 실패');if(window.__holdCertificateLookup)return new Promise(resolve=>{window.__releaseCertificateLookup=resolve});return window.__certificate??null};
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
 assert.equal(info.shell.width,460);assert(info.centerDelta<8);assert(info.name.top>info.student.bottom);assert.equal(info.student.width,412);assert(info.student.left-info.shell.left<=25);assert(info.shell.right-info.student.right<=25);assert.equal(info.overflow,false);
 assert.equal(await page.locator('#obyeol svg').getAttribute('viewBox'),'0 0 460 480');
 assert.equal(await page.locator('.status-chip, .intro-kicker, .inside-nav').count(),0);
 assert.equal(await page.locator('#obyeol-message').isVisible(),false);
 assert.equal(await page.locator('.inside-footer').count(),0);
 assert.equal(await page.locator('#obyeol-message').evaluate(el=>getComputedStyle(el,'::after').width),'9px');
 await page.screenshot({path:`${out}/redraw-login-final-${width}.png`,animations:'disabled'});measurements.push({width,height,...info});
}
await page.setViewportSize({width:1366,height:768});await page.clock.install();
await page.locator('[name=studentNumber]').fill('20101');await page.locator('[name=name]').fill('김오성');await page.locator('#entry-form button').click();await page.waitForFunction(()=>!document.querySelector('#typing-input').disabled);
assert.equal(await page.locator('.rules-panel, .inside-footer').count(),0);
const header=await page.evaluate(()=>{const r=el=>el.getBoundingClientRect();const head=r(document.querySelector('.typing-header'));const session=r(document.querySelector('#student-session'));const input=r(document.querySelector('#typing-input'));const prompt=r(document.querySelector('#challenge'));return {inside:document.querySelector('.typing-header').contains(document.querySelector('#student-session')),sessionBottom:session.bottom,headerBottom:head.bottom,sessionWidth:session.width,headerWidth:head.width,inputHeight:input.height,promptHeight:prompt.height,inputWidth:input.width,promptWidth:prompt.width}});
assert(header.inside);assert(header.sessionBottom<=header.headerBottom);assert(header.sessionWidth<header.headerWidth/2);assert(header.inputHeight>=160);assert(header.inputHeight>=header.promptHeight);assert.equal(header.inputWidth,header.promptWidth);
assert.equal(await page.locator('#obyeol').evaluate(el=>el.getBoundingClientRect().width),144);
await page.locator('#typing-input').evaluate(input=>{
 input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
 input.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,inputType:'insertCompositionText',data:'ㄱ',isComposing:true}));
 input.value='ㄱ';input.setSelectionRange(1,1);
 input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'ㄱ',isComposing:true}));
});
assert.equal(await page.locator('#challenge .incorrect').count(),1);
assert.equal(await page.locator('#challenge .incorrect').first().evaluate(el=>getComputedStyle(el).color),'rgb(211, 35, 50)');
assert.equal(await page.locator('#errors').textContent(),'0');
await page.locator('#typing-input').evaluate(input=>{
 input.value='가';input.setSelectionRange(1,1);
 input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'가'}));
 input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'가'}));
});
await page.clock.fastForward(6000);assert.equal(await page.locator('#obyeol').getAttribute('data-mood'),'focus');
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
await page.waitForFunction(()=>document.querySelector('#typing-input').getBoundingClientRect().height>=Math.ceil(document.querySelector('#challenge').getBoundingClientRect().height)+24);
for(const [width,height] of [[1366,768],[1710,1060]]){
 await page.setViewportSize({width,height});
 await page.waitForFunction(()=>document.querySelector('#typing-input').getBoundingClientRect().height>=Math.ceil(document.querySelector('#challenge').getBoundingClientRect().height)+24);
 const layout=await page.evaluate(()=>{const input=document.querySelector('#typing-input').getBoundingClientRect(),challenge=document.querySelector('#challenge').getBoundingClientRect(),shell=document.querySelector('.typing-shell').getBoundingClientRect();return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,inputBottom:input.bottom,inputHeight:input.height,challengeHeight:challenge.height,shellTop:shell.top,shellBottom:shell.bottom,centerDelta:Math.abs((shell.top+shell.bottom)/2-innerHeight/2)}});
 assert.equal(layout.overflow,false);assert(layout.inputBottom<height);if(layout.shellBottom-layout.shellTop+32<=height) assert(layout.centerDelta<1);assert(layout.shellTop>=15);measurements.push({typing:layout});
 await page.screenshot({path:`${out}/typing-spacious-${width}.png`,animations:'disabled'});
}
await page.setViewportSize({width:1366,height:768});
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
// Returning records restore the saved screen without enabling a new attempt.
const returning=await browser.newPage({viewport:{width:1366,height:768}});
await returning.route('**/db/firebase.js*',r=>r.fulfill({contentType:'text/javascript',body:firebase}));
await returning.route('**/db/database.js*',r=>r.fulfill({contentType:'text/javascript',body:database}));
await returning.goto('http://127.0.0.1:5176/typing/');await returning.locator('#entry-form').waitFor();
const certificate={id:'00000000-0000-4000-8000-000000000001',participantId:'20101',displayName:'김오성',challengeId:'test-only',elapsedMs:12345,speed:300,errors:2,score:294,completedAt:'2026-11-16T00:00:00.000Z',text:'가나',title:'기존 문구',referenceKeystrokes:4};
await returning.evaluate(value=>{window.__certificate=value},certificate);
const enter=async(number='20101',name='김오성')=>{await returning.locator('[name=studentNumber]').fill(number);await returning.locator('[name=name]').fill(name);await returning.locator('#entry-form button').click()};
await enter();await returning.locator('#record-dialog[open]').waitFor();
assert.equal(await returning.locator('#record-save-status').textContent(),'');
assert.equal(await returning.locator('#record-save-status').isVisible(),false);
assert.equal(await returning.locator('#record-dialog').getAttribute('aria-describedby'),null);
assert.equal(await returning.locator('#typing-input').isDisabled(),true);
assert.equal(await returning.locator('#typing-input').inputValue(),'가나');
assert.equal(await returning.locator('#record-score').textContent(),'294');
assert.equal(await returning.locator('#record-time').textContent(),'12.35');
assert.equal(await returning.evaluate(()=>window.__record),undefined);
await returning.screenshot({path:out+'/returning-record-desktop.png',animations:'disabled'});
await returning.keyboard.press('Escape');await returning.waitForFunction(()=>document.activeElement.id==='show-record');
await returning.locator('#student-logout').click();await returning.locator('#entry-form').waitFor();
await returning.evaluate(()=>{window.__certificateLookupError=true});await enter();
await returning.waitForFunction(()=>document.querySelector('#feedback').textContent.includes('조회 실패'));
assert.equal(await returning.locator('#typing-input').isDisabled(),true);assert(await returning.locator('#reload').isVisible());
await returning.evaluate(()=>{window.__certificateLookupError=false});await returning.locator('#reload').click();await returning.locator('#record-dialog[open]').waitFor();
await returning.locator('#record-close').click();await returning.locator('#student-logout').click();
await returning.evaluate(()=>{window.__holdCertificateLookup=true});await enter();await returning.waitForFunction(()=>!!window.__releaseCertificateLookup);
await returning.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')));
await returning.locator('#entry-form').waitFor();await returning.evaluate(()=>{window.__holdCertificateLookup=false;window.__certificate=null});await enter('20102','다음참가자');await returning.locator('#typing-input:enabled').waitFor();
await returning.evaluate(value=>window.__releaseCertificateLookup(value),certificate);
assert.equal(await returning.locator('#record-dialog').isVisible(),false);
assert.equal(await returning.locator('#typing-input').isEnabled(),true);
assert((await returning.locator('#student-name').textContent()).includes('다음참가자'));
await returning.close();
// Writing keeps comfortable controls and a generous textarea, without excess sections.
const writing=await browser.newPage({viewport:{width:1366,height:768}});
writing.on('pageerror',error=>{throw error});
await writing.route('**/db/firebase.js*',r=>r.fulfill({contentType:'text/javascript',body:firebase}));
await writing.route('**/db/public.js*',r=>r.fulfill({contentType:'text/javascript',body:'export const readEvent=async()=>({phase:"A",submissionsEnabled:true});'}));
await writing.route('**/db/database.js*',r=>r.fulfill({contentType:'text/javascript',body:'export const submitLetter=async()=>{throw Error("This visual test must not submit letters")};'}));
await writing.goto('http://127.0.0.1:5176/write/');await writing.locator('#submit:not(:disabled)').waitFor();
assert.equal(await writing.locator('#student-number').getAttribute('placeholder'),'학번');
const meta=await writing.evaluate(()=>{const privacy=document.querySelector('#privacy'),counter=document.querySelector('#content-count'),p=privacy.getBoundingClientRect(),c=counter.getBoundingClientRect();return {sameRow:privacy.parentElement===counter.parentElement,topDelta:Math.abs(p.top-c.top),space:c.left-p.right}});
assert(meta.sameRow);assert(meta.topDelta<1);assert(meta.space>=19);
await writing.locator('#content').fill('안녕하세요');await writing.waitForFunction(()=>document.querySelector('#content-count').textContent==='5자');
const writeLayout=await writing.evaluate(()=>({height:document.documentElement.scrollHeight,overflow:document.documentElement.scrollWidth>innerWidth,input:document.querySelector('#student-number').getBoundingClientRect().height,textarea:document.querySelector('#content').getBoundingClientRect().height}));
assert.equal(writeLayout.overflow,false);assert(writeLayout.input>=47);assert(writeLayout.textarea>=220);assert(writeLayout.height<960);
assert.equal(await writing.locator('.inside-footer, .form-panel-heading').count(),0);
await writing.screenshot({path:`${out}/comfortable-writing-desktop.png`,fullPage:true,animations:'disabled'});
await writing.setViewportSize({width:1710,height:1060});
assert(await writing.locator('#submit').evaluate(el=>el.getBoundingClientRect().bottom<innerHeight));
await writing.screenshot({path:`${out}/comfortable-writing-large-desktop.png`,animations:'disabled'});
await writing.close();
// Review all expressions together using the exact animated SVG markup and CSS.
await page.setContent(`<head><link rel="stylesheet" href="http://127.0.0.1:5176/style.css"><link rel="stylesheet" href="http://127.0.0.1:5176/typing/style.css"></head><body style="background:#fffaf0;padding:32px;display:flex;gap:16px"><div id="gallery" style="display:flex;gap:16px;width:1280px;height:250px"></div></body>`);
await page.evaluate(async()=>{const {mountObyeol}=await import('/typing/obyeol.js?v=typing-delete-v6-2');for(const [mood,label] of [['idle','대기'],['focus','집중'],['happy','연속 정답'],['surprised','오타'],['angry','연속 오타'],['complete','완료']]){const fig=document.createElement('div');fig.style='width:200px;text-align:center';const avatar=document.createElement('div');avatar.className='obyeol';avatar.dataset.mood=mood;mountObyeol(avatar);fig.append(avatar);const title=document.createElement('p');title.textContent=label;fig.append(title);document.querySelector('#gallery').append(fig)}});
await page.locator('#gallery').screenshot({path:`${out}/redraw-expression-gallery.png`,animations:'disabled'});
console.log(JSON.stringify({measurements,reactions:'idle/focus/surprised/angry/recovered/happy/complete passed',score:'original 3 point penalty preserved',record:'saved mock response and Escape focus restoration passed',prompt:'long text fully visible without internal scrolling',failure:'real rejection detail, pending backup and retry focus passed',mobileTests:false},null,2));
} finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exit(1)});
