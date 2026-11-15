// Run only against the local demo Firestore emulator; never a live project.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const firebase = require('firebase/compat/app');
require('firebase/compat/firestore');
const doc = (db, path, id) => db.doc(`${path}/${id}`);
const setDoc = (ref, data) => ref.set(data);
const deleteDoc = (ref) => ref.delete();
const runTransaction = (db, callback) => db.runTransaction(callback);
const writeBatch = (db) => db.batch();
const serverTimestamp = () => firebase.firestore.FieldValue.serverTimestamp();

const projectId = 'demo-oshs-delete-rules';
const rules = await readFile(new URL(process.env.FIRESTORE_RULES ?? '../db/firestore.rules', import.meta.url), 'utf8');
const env = await initializeTestEnvironment({
  projectId,
  firestore: { host: '127.0.0.1', port: 8088, rules },
});
const paths = {
  admins: '관리자', settings: '운영설정', challenges: '타자대회/2026-11-23/문구',
  results: '타자대회/2026-11-23/기록', entries: '타자대회/2026-11-23/참여제한',
  typingReceipts: '타자대회/2026-11-23/접수확인', letterReceipts: '글쓰기/기본/접수확인',
};
const adminDb = env.authenticatedContext('test-admin').firestore();
const studentDb = env.unauthenticatedContext().firestore();
let passed = 0;
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function seed(rows) {
  await env.withSecurityRulesDisabled(async (context) => {
    const firestore = context.firestore();
    for (const [path, key, data] of rows) await setDoc(doc(firestore, path, key), data);
  });
}
async function read(db, path, key) { return doc(db, path, key).get(); }
async function removeTogether(db, recordId, studentNumber, removeEntry = true) {
  const resultRef = doc(db, paths.results, recordId);
  const receiptRef = doc(db, paths.typingReceipts, recordId);
  const entryRef = doc(db, paths.entries, studentNumber);
  return runTransaction(db, async (tx) => {
    await Promise.all([tx.get(resultRef), tx.get(receiptRef), tx.get(entryRef)]);
    tx.delete(resultRef); tx.delete(receiptRef);
    if (removeEntry) tx.delete(entryRef);
  });
}
function record(recordId, number, mode = 'record') {
  return mode === 'record'
    ? { 문서ID: recordId, 참가방식: 'record', 이전계정UID: null, 학번: number, 연습여부: false }
    : { 문서ID: recordId, 이전계정UID: 'legacy-account', 이전참가자ID: 'legacy-account' };
}
function receipt(recordId) {
  return { 문서ID: recordId, 이전계정UID: null, 참가방식: 'record', 접수종류: 'typing', 내용해시: 'a'.repeat(64), 생성시각: new Date() };
}
function entry(recordId, number) {
  return { 접수종류: 'typingEntry', 기록ID: recordId, 학번: number, 생성시각: new Date() };
}

try {
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), paths.admins, 'test-admin'), { 사용여부: true, 이메일: 'test@example.invalid', 생성시각: new Date() });
  });

  // The result, its retry receipt, and only its matching one-time entry are deleted atomically.
  await seed([[paths.results, id(1), record(id(1), '20101')], [paths.typingReceipts, id(1), receipt(id(1))], [paths.entries, '20101', entry(id(1), '20101')]]);
  await assertSucceeds(removeTogether(adminDb, id(1), '20101'));
  assert.equal((await read(adminDb, paths.results, id(1))).exists, false);
  assert.equal((await read(adminDb, paths.typingReceipts, id(1))).exists, false);
  assert.equal((await read(adminDb, paths.entries, '20101')).exists, false);
  passed++;

  // Each partial deletion is denied, so related records stay consistent.
  await seed([[paths.results, id(2), record(id(2), '20102')], [paths.typingReceipts, id(2), receipt(id(2))], [paths.entries, '20102', entry(id(2), '20102')]]);
  await assertFails(deleteDoc(doc(adminDb, paths.results, id(2))));
  await assertFails(deleteDoc(doc(adminDb, paths.typingReceipts, id(2))));
  await assertFails(deleteDoc(doc(adminDb, paths.entries, '20102')));
  assert.equal((await read(adminDb, paths.results, id(2))).exists, true);
  assert.equal((await read(adminDb, paths.typingReceipts, id(2))).exists, true);
  assert.equal((await read(adminDb, paths.entries, '20102')).exists, true);
  passed++;

  const nonAdminDb = env.authenticatedContext('student-user').firestore();
  await assertFails(deleteDoc(doc(nonAdminDb, paths.results, id(2))));
  await assertFails(deleteDoc(doc(studentDb, paths.typingReceipts, id(2))));
  passed++;

  // Removing a duplicate row cannot release the entry for another real result.
  await seed([[paths.results, id(3), record(id(3), '20103')], [paths.results, id(4), record(id(4), '20103')],
    [paths.typingReceipts, id(3), receipt(id(3))], [paths.entries, '20103', entry(id(4), '20103')]]);
  await assertSucceeds(removeTogether(adminDb, id(3), '20103', false));
  assert.equal((await read(adminDb, paths.results, id(4))).exists, true);
  assert.equal((await read(adminDb, paths.entries, '20103')).data().기록ID, id(4));
  passed++;

  // An orphaned entry may be released only after its matching receipt and absent result are verified.
  await seed([[paths.typingReceipts, id(5), receipt(id(5))], [paths.entries, '20105', entry(id(5), '20105')]]);
  await assertSucceeds(runTransaction(adminDb, async (tx) => {
    const result = doc(adminDb, paths.results, id(5)), receiptRef = doc(adminDb, paths.typingReceipts, id(5)), entryRef = doc(adminDb, paths.entries, '20105');
    await Promise.all([tx.get(result), tx.get(receiptRef), tx.get(entryRef)]); tx.delete(receiptRef); tx.delete(entryRef);
  }));
  assert.equal((await read(adminDb, paths.typingReceipts, id(5))).exists, false);
  assert.equal((await read(adminDb, paths.entries, '20105')).exists, false);
  passed++;

  await seed([[paths.results, id(6), record(id(6), '20106')], [paths.typingReceipts, id(6), receipt(id(6))], [paths.entries, '20106', entry(id(6), '20106')]]);
  await assertFails(runTransaction(adminDb, async (tx) => {
    const result = doc(adminDb, paths.results, id(6)), receiptRef = doc(adminDb, paths.typingReceipts, id(6)), entryRef = doc(adminDb, paths.entries, '20106');
    await Promise.all([tx.get(result), tx.get(receiptRef), tx.get(entryRef)]); tx.delete(receiptRef); tx.delete(entryRef);
  }));
  passed++;

  // Historical UID results still remove their matching receipt but have no school-number entry.
  await seed([[paths.results, id(7), record(id(7), '', 'legacy')], [paths.typingReceipts, id(7),
    { 문서ID: id(7), 이전계정UID: 'legacy-account', 접수종류: 'typing', 내용해시: 'b'.repeat(64), 생성시각: new Date() }]]);
  await assertSucceeds(runTransaction(adminDb, async (tx) => {
    const result = doc(adminDb, paths.results, id(7)), receiptRef = doc(adminDb, paths.typingReceipts, id(7));
    await Promise.all([tx.get(result), tx.get(receiptRef)]); tx.delete(result); tx.delete(receiptRef);
  }));
  passed++;

  // Letter retry receipts live elsewhere and cannot be removed through typing cleanup.
  await seed([[paths.letterReceipts, id(8), { ...receipt(id(8)), 접수종류: 'letter' }]]);
  await assertFails(deleteDoc(doc(adminDb, paths.letterReceipts, id(8))));
  passed++;

  // After deletion, a new official record with a split receipt and student-number key can be accepted.
  const challengeId = 'typing-delete-rule-test';
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, paths.settings, '행사'), { 운영단계: 'A', 선택문구ID: challengeId, 수정시각: new Date() });
    await setDoc(doc(db, paths.challenges, challengeId), { 문구본문: 'abcdefghij', 기준타수: 10, 연습여부: false, 사용여부: true });
  });
  await seed([[paths.results, id(9), record(id(9), '20109')], [paths.typingReceipts, id(9), receipt(id(9))], [paths.entries, '20109', entry(id(9), '20109')]]);
  await assertSucceeds(removeTogether(adminDb, id(9), '20109'));
  const next = id(10), batch = writeBatch(studentDb);
  batch.set(doc(studentDb, paths.results, next), {
    문서ID: next, 참가방식: 'record', 이전계정UID: null, 학번: '20109', 이름: '학생', 문구ID: challengeId,
    소요시간밀리초: 60000, 분당타수: 10, 누적오타: 0, 최종점수: 10,
    완료시각: '2026-11-16T00:00:00.000Z', 상품수령여부: false, 연습여부: false,
    검수상태: 'pending', 접수시각: serverTimestamp(), 검수시각: null,
  });
  batch.set(doc(studentDb, paths.typingReceipts, next), {
    문서ID: next, 이전계정UID: null, 참가방식: 'record', 접수종류: 'typing', 내용해시: 'd'.repeat(64), 생성시각: serverTimestamp(),
  });
  batch.set(doc(studentDb, paths.entries, '20109'), {
    접수종류: 'typingEntry', 기록ID: next, 학번: '20109', 생성시각: serverTimestamp(),
  });
  await assertSucceeds(batch.commit());
  assert.equal((await read(adminDb, paths.entries, '20109')).data().기록ID, next);
  passed++;

  console.log(`${process.env.FIRESTORE_RULES ? 'compat' : 'canonical'} Firestore delete rules: ${passed} emulator cases passed`);
} finally { await env.cleanup(); }
