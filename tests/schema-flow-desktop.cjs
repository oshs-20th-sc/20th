// Real desktop browser + Firestore/Auth emulator integration.
// Run with Java 21 and firebase emulators:exec --project demo-ohsung --config db/firebase.json --only auth,firestore.
// Never points at a production Firebase project.
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { chromium } = require('playwright');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');

const projectId = 'demo-ohsung';
const baseUrl = 'http://127.0.0.1:5176';
const eventId = '2026-11-23';
const challengeId = 'schema-flow-desktop';
const phrase = '가';
const targetStudent = '20103';
const targetName = '통합검증';
const certificateKey=(studentNumber,name)=>createHash('sha256').update(studentNumber+String.fromCharCode(10)+name.trim().normalize('NFKC').normalize('NFC')).digest('hex');

(async()=>{
const testEnv = await initializeTestEnvironment({projectId,firestore:{host:'127.0.0.1',port:8088}});
const browser = await chromium.launch({channel:'chrome',headless:true});
const errors = [];

async function seed(path,data) {
  await testEnv.withSecurityRulesDisabled(async context=>context.firestore().doc(path).set(data));
}
async function unsafe(work) {
  let result;
  await testEnv.withSecurityRulesDisabled(async context=>{result=await work(context.firestore());});
  return result;
}
async function raw(path) {
  return unsafe(async db=>{
    const saved=await db.doc(path).get();
    return saved.exists?{exists:true,data:saved.data()}:{exists:false,data:null};
  });
}
async function clearAuthUsers() {
  await fetch(`http://127.0.0.1:9098/emulator/v1/projects/${projectId}/accounts`,{method:'DELETE'});
}
async function createAuthFixture(enabled=true) {
  const email=`schema-flow-${randomUUID()}@example.test`, password='Emulator-Test-Only-1!';
  const config=require('../db/firebase-config.json');
  const response=await fetch(`http://127.0.0.1:9098/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${config.apiKey}`,{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({email,password,returnSecureToken:true}),
  });
  const auth=await response.json();assert(response.ok,`Auth emulator fixture creation failed: ${auth.error?.message}`);
  await seed(`관리자/${auth.localId}`,{사용여부:enabled,이메일:email,생성시각:new Date()});
  return {email,password,uid:auth.localId};
}
async function seedApplication() {
  await seed(`타자대회/${eventId}`,{행사명:'테스트 타자 대회',행사일:eventId,스키마버전:5});
  await seed('글쓰기/기본',{운영명:'글쓰기 테스트',스키마버전:5});
  await seed('운영설정/행사',{
    운영단계:'A',타자접수허용:true,글접수허용:true,공개글열람허용:true,
    선택문구ID:challengeId,수정시각:new Date(),
  });
  await seed('운영설정/세션',{공용기기모드:false,자동퇴장대기분:10,학년도:2026,수정시각:new Date()});
  await seed(`타자대회/${eventId}/문구/${challengeId}`,{
    문구제목:'화면 통합 검증',문구본문:phrase,기준타수:2,오타감점:3,
    연습여부:false,사용여부:true,삭제여부:false,
  });
}
async function openPage(path) {
  const page=await browser.newPage({viewport:{width:1366,height:768}});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('dialog',dialog=>dialog.accept());
  await page.goto(`${baseUrl}${path}`);
  return page;
}
async function loginStudent(studentNumber=targetStudent,name=targetName) {
  const page=await openPage('/typing/?emulator=1');
  await page.locator('[name=studentNumber]').fill(studentNumber);
  await page.locator('[name=name]').fill(name);
  await page.locator('#entry-form button[type=submit]').click();
  await page.waitForFunction(()=>!document.querySelector('#typing-input').disabled ||
    document.querySelector('#record-dialog').open || !document.querySelector('#reload').hidden);
  return page;
}
async function studentPage(studentNumber=targetStudent,name=targetName) {
  const page=await loginStudent(studentNumber,name);
  await page.locator('#typing-input:enabled').waitFor();
  return page;
}
async function typeAndWait(page) {
  await page.locator('#typing-input').focus();
  for(const character of phrase) await page.keyboard.insertText(character);
  await page.locator('#record-dialog[open]').waitFor();
  await page.waitForFunction(()=>document.querySelector('#record-save-status')?.dataset.state==='saved' || document.querySelector('#record-save-status')?.dataset.state==='failed');
  return page.locator('#record-save-status').getAttribute('data-state');
}
async function signInAdmin(page,admin) {
  await page.locator('#login [name=email]').fill(admin.email);
  await page.locator('#login [name=password]').fill(admin.password);
  await page.locator('#login button[type=submit]').click();
  await page.waitForURL(/\/(typing|write)\/admin\//,{timeout:15000});
  await page.locator('#view').waitFor();
}
async function verifyTypingResult(recordId,student=targetStudent,name=targetName) {
  const [result,receipt,claim,certificate]=await Promise.all([
    raw(`타자대회/${eventId}/기록/${recordId}`),
    raw(`타자대회/${eventId}/접수확인/${recordId}`),
    raw(`타자대회/${eventId}/참여제한/${student}`),
    raw(`타자대회/${eventId}/기록증/${certificateKey(student,name)}`),
  ]);
  assert(result.exists,'typing result should be stored at the event-scoped path');
  assert.equal(result.data['학번'],student);
  assert.equal(result.data['이름'],name);
  assert.equal(typeof result.data['최종점수'],'number');
  assert.equal('participantId' in result.data,false);
  assert.equal('displayName' in result.data,false);
  assert(receipt.exists,'idempotency receipt belongs in the typing receipt collection');
  assert.equal(receipt.data['접수종류'],'typing');
  assert(claim.exists,'the participation constraint is in its own collection');
  assert.equal(claim.data['기록ID'],recordId);
  assert(certificate.exists,'the reusable, minimal typing certificate is stored separately');
  assert.equal(certificate.data['학번'],student);
  assert.equal(certificate.data['이름'],name);
  assert.equal(certificate.data['문구본문'],phrase);
  assert.equal(certificate.data['문구ID'],challengeId);
  assert.equal(certificate.data['문서ID'],recordId);
  assert.equal(certificate.data['최종점수'],result.data['최종점수']);
  assert.equal(certificate.data['분당타수'],result.data['분당타수']);
  assert.equal(certificate.data['누적오타'],result.data['누적오타']);
  assert.equal(certificate.data['소요시간밀리초'],result.data['소요시간밀리초']);
  return {result:result.data,certificate:certificate.data};
}

try {
  await testEnv.clearFirestore();
  await clearAuthUsers();
  const admin=await createAuthFixture(true);
  const disabledAdmin=await createAuthFixture(false);
  await seedApplication();

  // The metadata role document, not Auth account existence, grants admin access.
  const deniedAdmin=await openPage('/typing/admin/?emulator=1');
  await deniedAdmin.locator('#login [name=email]').fill(disabledAdmin.email);
  await deniedAdmin.locator('#login [name=password]').fill(disabledAdmin.password);
  await deniedAdmin.locator('#login button[type=submit]').click();
  await deniedAdmin.waitForFunction(()=>document.querySelector('#status')?.textContent.includes('관리자 권한이 없는'));
  assert.equal(await deniedAdmin.locator('#view').count(),0,'a disabled metadata role must not open admin tools');
  await deniedAdmin.close();

  const first=await studentPage();
  // Both clients pass the certificate lookup before either has submitted, preserving
  // the real duplicate-submission race and the existing backup/retry behavior.
  const duplicate=await studentPage();
  assert.equal(await typeAndWait(first),'saved','first record submission through the page must succeed');
  const resultRows=await unsafe(async db=>{
    const collection=db.collection(`타자대회/${eventId}/기록`);
    const snapshot=await collection.where('학번','==',targetStudent).get();
    return snapshot.docs.map(item=>({id:item.id,data:item.data()}));
  });
  assert.equal(resultRows.length,1,'one complete record must create exactly one result');
  const recordId=resultRows[0].id;
  const savedCertificate=await verifyTypingResult(recordId);
  await first.close();

  // The second client already looked up an empty certificate; its in-flight attempt is
  // still rejected by the atomic participation claim and must remain locally recoverable.
  assert.equal(await typeAndWait(duplicate),'failed','duplicate official entry must be rejected');
  assert.match(await duplicate.locator('#record-save-status').innerText(),/이미 있|확인|거부/);
  const localPending=await duplicate.evaluate(async()=>{
    const open=indexedDB.open('osung-typing',1);
    const db=await new Promise((resolve,reject)=>{open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error)});
    return new Promise((resolve,reject)=>{const tx=db.transaction('results','readonly');const request=tx.objectStore('results').getAll();tx.oncomplete=()=>resolve(request.result);tx.onerror=()=>reject(tx.error)});
  });
  assert.equal(localPending.length,1,'failed result must remain in the existing IndexedDB backup');
  await duplicate.close();

  // A later visit finds the saved certificate and opens the exact result read-only.
  const returning=await loginStudent();
  await returning.locator('#record-dialog[open]').waitFor();
  assert.equal(await returning.locator('#typing-input').isDisabled(),true);
  assert.equal(await returning.locator('#typing-input').inputValue(),phrase);
  assert.equal(await returning.locator('#record-save-status').getAttribute('data-state'),'saved');
  assert.equal(await returning.locator('#record-save-status').textContent(),'');
  assert.equal(await returning.locator('#record-save-status').isVisible(),false);
  assert.equal(await returning.locator('#record-dialog').getAttribute('aria-describedby'),null);
  assert.equal(await returning.locator('#obyeol').getAttribute('data-mood'),'complete');
  const replayMetrics=await returning.locator('#record-dialog').evaluate(dialog=>Object.fromEntries(
    ['student','name','score','speed','errors','time'].map(field=>[field,document.getElementById(`record-${field}`).textContent])
  ));
  assert.deepEqual(replayMetrics,{student:targetStudent,name:targetName,
    score:String(savedCertificate.certificate['최종점수']),
    speed:String(savedCertificate.certificate['분당타수']),
    errors:String(savedCertificate.certificate['누적오타']),
    time:(savedCertificate.certificate['소요시간밀리초']/1000).toFixed(2)});
  assert.equal(await returning.locator('#student-logout').innerText(),'다음 참가자');
  await returning.keyboard.press('Escape');
  await returning.waitForFunction(()=>!document.querySelector('#record-dialog').open);
  await returning.locator('#show-record').click();
  await returning.locator('#record-dialog[open]').waitFor();
  await returning.locator('#record-close').click();
  await returning.locator('#student-logout').click();
  await returning.locator('#entry-form').waitFor();
  await returning.locator('[name=studentNumber]').fill('20105');
  await returning.locator('[name=name]').fill('둘째검증');
  await returning.locator('#entry-form button[type=submit]').click();
  await returning.locator('#typing-input:enabled').waitFor();
  const afterReplay=await unsafe(async db=>{
    const results=await db.collection(`타자대회/${eventId}/기록`).where('학번','==',targetStudent).get();
    const receipts=await db.collection(`타자대회/${eventId}/접수확인`).where('학번','==',targetStudent).get();
    return {results:results.size, certificate:(await db.doc(`타자대회/${eventId}/기록증/${certificateKey(targetStudent,targetName)}`).get()).data()};
  });
  assert.equal(afterReplay.results,1,'reopening a saved certificate never creates another result');
  assert.deepEqual(afterReplay.certificate,savedCertificate.certificate);
  await returning.close();

  // Remove the first test result in the actual admin UI; the coupled participation key must go too.
  const typingAdmin=await openPage('/typing/admin/?emulator=1');
  await signInAdmin(typingAdmin,admin);
  const deleteButton=typingAdmin.locator(`[data-delete="${recordId}"]`);
  await deleteButton.waitFor({timeout:10000});
  await deleteButton.click();
  await typingAdmin.waitForFunction(()=>document.querySelector('#status')?.textContent.includes('삭제'));
  assert.equal((await raw(`타자대회/${eventId}/기록/${recordId}`)).exists,false);
  assert.equal((await raw(`타자대회/${eventId}/접수확인/${recordId}`)).exists,false);
  assert.equal((await raw(`타자대회/${eventId}/참여제한/${targetStudent}`)).exists,false);
  assert.equal((await raw(`타자대회/${eventId}/기록증/${certificateKey(targetStudent,targetName)}`)).exists,false);
  await typingAdmin.close();

  const reentry=await studentPage();
  assert.equal(await typeAndWait(reentry),'saved','released student may submit a fresh official attempt');
  const newRows=await unsafe(async db=>{
    const snapshot=await db.collection(`타자대회/${eventId}/기록`).where('학번','==',targetStudent).get();
    return snapshot.docs.map(item=>item.id);
  });
  assert.equal(newRows.length,1);await verifyTypingResult(newRows[0]);await reentry.close();

  // A second canonical record exercises the real Firestore cursor and field filters.
  const secondTyper=await studentPage('20105','둘째검증');
  assert.equal(await typeAndWait(secondTyper),'saved');
  const secondRows=await unsafe(async db=>{
    const snapshot=await db.collection(`타자대회/${eventId}/기록`).where('학번','==','20105').get();
    return snapshot.docs.map(item=>item.id);
  });
  assert.equal(secondRows.length,1);await verifyTypingResult(secondRows[0],'20105','둘째검증');await secondTyper.close();

  const typingQueryPage=await openPage('/typing/admin/?emulator=1');
  await signInAdmin(typingQueryPage,admin);
  const typingPages=await typingQueryPage.evaluate(async(challengeId)=>{
    const database=await import('/db/database.js?v=typing-certificate-1');
    const firebase=await import('/db/firebase.js?v=typing-certificate-1');
    const {db}=await firebase.adminContext();
    const first=await database.readTypingPage(db,{version:challengeId,pageSize:1});
    const second=await database.readTypingPage(db,{version:challengeId,pageSize:1,cursor:first.cursor});
    const filtered=await database.readTypingPage(db,{version:challengeId,verification:'pending',pageSize:10});
    return {first:first.items.map(row=>row.id),firstHasNext:first.hasNext,
      second:second.items.map(row=>row.id),secondHasNext:second.hasNext,
      pending:filtered.items.length};
  },challengeId);
  assert.equal(typingPages.first.length,1);assert.equal(typingPages.firstHasNext,true);
  assert.equal(typingPages.second.length,1);assert.equal(typingPages.secondHasNext,false);
  assert.notEqual(typingPages.first[0],typingPages.second[0]);assert.equal(typingPages.pending,2);
  await typingQueryPage.close();

  // A writing submission is private; approving it creates a minimal public copy.
  async function submitLetter(student,name,nickname,body) {
    const page=await openPage('/write/?emulator=1');
    await page.locator('#submit:not(:disabled)').waitFor({timeout:10000});
    await page.locator('#student-number').fill(student);
    await page.locator('#student-name').fill(name);
    await page.locator('#nickname').fill(nickname);
    await page.locator('#content').fill(body);
    await page.locator('#consent').check();
    await page.locator('#submit').click();
    await page.locator('#complete:not([hidden])').waitFor();
    return page;
  }
  const writing=await submitLetter('20104','글테스트','한줄','서로 응원하는 학교생활을 만들어요.');
  const letterDocs=await unsafe(async db=>{
    const snapshot=await db.collection('글쓰기/기본/접수글').where('학번','==','20104').get();
    return snapshot.docs.map(item=>({id:item.id,data:item.data()}));
  });
  assert.equal(letterDocs.length,1);const letterId=letterDocs[0].id;
  assert.equal(letterDocs[0].data['이름'],'글테스트');
  assert.equal('student_number' in letterDocs[0].data,false);
  await writing.close();
  const secondWriting=await submitLetter('20106','글둘째','한줄더','서로 배려하며 즐겁게 지내요.');
  const secondLetterDocs=await unsafe(async db=>{
    const snapshot=await db.collection('글쓰기/기본/접수글').where('학번','==','20106').get();
    return snapshot.docs.map(item=>item.id);
  });
  assert.equal(secondLetterDocs.length,1);await secondWriting.close();

  const writingAdmin=await openPage('/write/admin/?emulator=1');
  await signInAdmin(writingAdmin,admin);
  const letterPages=await writingAdmin.evaluate(async()=>{
    const database=await import('/db/database.js?v=typing-certificate-1');
    const firebase=await import('/db/firebase.js?v=typing-certificate-1');
    const {db}=await firebase.adminContext();
    const first=await database.readLettersPage(db,{status:'pending',pageSize:1});
    const second=await database.readLettersPage(db,{status:'pending',pageSize:1,cursor:first.cursor});
    const filtered=await database.readLettersPage(db,{query:'20104',pageSize:10});
    return {first:first.items.map(row=>row.id),firstHasNext:first.hasNext,
      second:second.items.map(row=>row.id),secondHasNext:second.hasNext,
      filtered:filtered.items.map(row=>row.id)};
  });
  assert.equal(letterPages.first.length,1);assert.equal(letterPages.firstHasNext,true);
  assert.equal(letterPages.second.length,1);assert.equal(letterPages.secondHasNext,false);
  assert.deepEqual(letterPages.filtered,[letterId]);
  await writingAdmin.locator(`[data-review-letter="${letterId}"][data-review-status="approved"]`).click();
  await writingAdmin.waitForFunction(()=>document.querySelector('#status')?.textContent.includes('변경 1건'));
  const publicLetter=await raw(`글쓰기/기본/공개글/${letterId}`);
  assert(publicLetter.exists,'approval creates the public projection');
  assert.deepEqual(Object.keys(publicLetter.data).sort(),['문서ID','별명','본문','공개순서','정렬순서'].sort());
  assert.equal(Object.hasOwn(publicLetter.data,'학번'),false);
  assert.equal(Object.hasOwn(publicLetter.data,'이름'),false);

  await writingAdmin.locator(`[data-delete="${letterId}"]`).click();
  await writingAdmin.waitForFunction(()=>document.querySelector('#status')?.textContent.includes('휴지통으로 이동 완료'));
  assert((await raw(`글쓰기/기본/휴지통/${letterId}`)).exists,'trash action preserves the original in the writing archive');
  const trashPage=await writingAdmin.evaluate(async(letterId)=>{
    const database=await import('/db/database.js?v=typing-certificate-1');
    const firebase=await import('/db/firebase.js?v=typing-certificate-1');
    const {db}=await firebase.adminContext();
    const page=await database.readLettersPage(db,{trash:true,status:'approved',pageSize:10});
    const history=await database.readLetterHistory(db,letterId);
    return {trashed:page.items.map(row=>row.id),actions:history.items.map(row=>row.action)};
  },letterId);
  assert.deepEqual(trashPage.trashed,[letterId]);
  assert.deepEqual(new Set(trashPage.actions),new Set(['review','trash']));
  await writingAdmin.locator('#letter-filter [name=status]').selectOption('trash');
  await writingAdmin.locator('#letter-filter button').click();
  await writingAdmin.locator(`[data-restore-letter="${letterId}"]`).click();
  await writingAdmin.waitForFunction(()=>document.querySelector('#status')?.textContent.includes('복원 완료'));
  const restored=await raw(`글쓰기/기본/접수글/${letterId}`);
  assert(restored.exists);assert.equal(restored.data['검수상태'],'pending');
  const restoreAudit=await unsafe(async db=>{
    const snapshot=await db.collection('글쓰기/기본/검수이력').where('글ID','==',letterId).get();
    return snapshot.docs.map(item=>item.data()['처리종류']).sort();
  });
  assert.deepEqual(restoreAudit,['restore','review','trash'].sort());
  await writingAdmin.close();

  // Public full backup has the v5 data and admin authorization role, never Auth passwords/tokens.
  const backupPage=await openPage('/typing/admin/?emulator=1');
  await signInAdmin(backupPage,admin);
  const backup=await backupPage.evaluate(async()=>{
    const database=await import('/db/database.js?v=typing-certificate-1');
    const firebase=await import('/db/firebase.js?v=typing-certificate-1');
    const context=await firebase.adminContext();
    return database.createPrivateBackup(context.db);
  });
  assert.equal(backup.schemaVersion,5);assert.equal(backup.includesAuthentication,false);
  assert(Array.isArray(backup.collections.admins));assert(Array.isArray(backup.collections.typingEntries));
  assert(Array.isArray(backup.collections.typingReceipts));assert(Array.isArray(backup.collections.letterReceipts));
  assert(!JSON.stringify(backup).includes('refresh_token'));
  const {validateBackup}=await import('../db/scripts/restore-backup.mjs');
  const backupRows=validateBackup(backup);
  assert(backupRows.some(row=>row.collection==='admins'&&row.id===admin.uid));
  assert(backupRows.some(row=>row.collection==='letterLogs'&&row.id.endsWith('-restore')));
  assert.deepEqual(errors,[],'browser JavaScript should run without uncaught errors');
  console.log('schema-flow desktop: typing, duplicate backup, admin deletion/re-entry, private writing, public approval, trash/restore and v5 backup passed');
  await backupPage.close();
} finally {
  await browser.close();
  await testEnv.cleanup();
}
})().catch(error=>{console.error(error);process.exitCode=1;});
