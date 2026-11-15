// Run only against the local demo Firestore emulator; never a live project.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const firebase = require('firebase/compat/app');
require('firebase/compat/firestore');
const doc = (db, collection, id) => db.collection(collection).doc(id);
const getDoc = (ref) => ref.get();
const setDoc = (ref, data) => ref.set(data);
const deleteDoc = (ref) => ref.delete();
const runTransaction = (db, callback) => db.runTransaction(callback);
const writeBatch = (db) => db.batch();
const serverTimestamp = () => firebase.firestore.FieldValue.serverTimestamp();

const projectId = 'demo-oshs-delete-rules';
const rules = await readFile(new URL('../db/firestore.rules', import.meta.url), 'utf8');
const env = await initializeTestEnvironment({
  projectId,
  firestore: { host: '127.0.0.1', port: 8088, rules },
});
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const claimId = (number) => `official-20261123-${number}`;
const adminDb = env.authenticatedContext('test-admin').firestore();
const studentDb = env.unauthenticatedContext().firestore();
let passed = 0;

async function seed(rows) {
  await env.withSecurityRulesDisabled(async (context) => {
    const firestore = context.firestore();
    for (const [collection, key, data] of rows)
      await setDoc(doc(firestore, collection, key), data);
  });
}
async function read(db, collection, key) { return getDoc(doc(db, collection, key)); }
async function removeTogether(db, recordId, studentNumber, removeClaim = true) {
  const resultRef = doc(db, 'typingResults', recordId);
  const receiptRef = doc(db, 'receipts', recordId);
  const claimRef = doc(db, 'receipts', claimId(studentNumber));
  return runTransaction(db, async (tx) => {
    await Promise.all([tx.get(resultRef), tx.get(receiptRef), tx.get(claimRef)]);
    tx.delete(resultRef);
    tx.delete(receiptRef);
    if (removeClaim) tx.delete(claimRef);
  });
}
function record(recordId, number, mode = 'record') {
  return mode === 'record'
    ? { id: recordId, entry_mode: 'record', owner_uid: null, participantId: number, practice: false }
    : { id: recordId, owner_uid: 'legacy-account', participantId: 'legacy-account' };
}
function recordReceipt(recordId) {
  return { id: recordId, owner_uid: null, entry_mode: 'record', kind: 'typing', payload_hash: 'a'.repeat(64), created_at: new Date() };
}
function officialClaim(recordId, number) {
  return { kind: 'typingEntry', result_id: recordId, student_number: number, created_at: new Date() };
}

try {
  await env.withSecurityRulesDisabled(async (context) => {
    const firestore = context.firestore();
    await setDoc(doc(firestore, 'admins', 'test-admin'), { enabled: true, email: 'test@example.invalid', created_at: new Date() });
  });

  // Exact result, UUID receipt, and its official one-time claim are removed in one authorized transaction.
  await seed([
    ['typingResults', id(1), record(id(1), '20101')],
    ['receipts', id(1), recordReceipt(id(1))],
    ['receipts', claimId('20101'), officialClaim(id(1), '20101')],
  ]);
  await assertSucceeds(removeTogether(adminDb, id(1), '20101'));
  assert.equal((await read(adminDb, 'typingResults', id(1))).exists, false);
  assert.equal((await read(adminDb, 'receipts', id(1))).exists, false);
  assert.equal((await read(adminDb, 'receipts', claimId('20101'))).exists, false);
  passed++;

  // Each partial deletion is rejected, so the three documents cannot be left inconsistent.
  await seed([
    ['typingResults', id(2), record(id(2), '20102')],
    ['receipts', id(2), recordReceipt(id(2))],
    ['receipts', claimId('20102'), officialClaim(id(2), '20102')],
  ]);
  await assertFails(deleteDoc(doc(adminDb, 'typingResults', id(2))));
  await assertFails(deleteDoc(doc(adminDb, 'receipts', id(2))));
  await assertFails(deleteDoc(doc(adminDb, 'receipts', claimId('20102'))));
  assert.equal((await read(adminDb, 'typingResults', id(2))).exists, true);
  assert.equal((await read(adminDb, 'receipts', id(2))).exists, true);
  assert.equal((await read(adminDb, 'receipts', claimId('20102'))).exists, true);
  passed++;

  // A signed-in non-admin cannot delete a result and an anonymous client cannot delete its receipt.
  const nonAdminDb = env.authenticatedContext('student-user').firestore();
  await assertFails(deleteDoc(doc(nonAdminDb, 'typingResults', id(2))));
  await assertFails(deleteDoc(doc(studentDb, 'receipts', id(2))));
  passed++;

  // Deleting a duplicate row retains the claim that belongs to a different valid result.
  await seed([
    ['typingResults', id(3), record(id(3), '20103')],
    ['typingResults', id(4), record(id(4), '20103')],
    ['receipts', id(3), recordReceipt(id(3))],
    ['receipts', claimId('20103'), officialClaim(id(4), '20103')],
  ]);
  await assertSucceeds(removeTogether(adminDb, id(3), '20103', false));
  assert.equal((await read(adminDb, 'typingResults', id(4))).exists, true);
  assert.equal((await read(adminDb, 'receipts', claimId('20103'))).data().result_id, id(4));
  passed++;

  // An orphaned claim and any matching receipt can be safely removed only after the result is gone.
  await seed([
    ['receipts', id(5), recordReceipt(id(5))],
    ['receipts', claimId('20105'), officialClaim(id(5), '20105')],
  ]);
  await assertSucceeds(runTransaction(adminDb, async (tx) => {
    const resultRef = doc(adminDb, 'typingResults', id(5));
    const receiptRef = doc(adminDb, 'receipts', id(5));
    const claimRef = doc(adminDb, 'receipts', claimId('20105'));
    await Promise.all([tx.get(resultRef), tx.get(receiptRef), tx.get(claimRef)]);
    tx.delete(receiptRef); tx.delete(claimRef);
  }));
  assert.equal((await read(adminDb, 'receipts', id(5))).exists, false);
  assert.equal((await read(adminDb, 'receipts', claimId('20105'))).exists, false);
  passed++;

  // Orphan cleanup is rejected if that exact referenced result exists.
  await seed([
    ['typingResults', id(6), record(id(6), '20106')],
    ['receipts', id(6), recordReceipt(id(6))],
    ['receipts', claimId('20106'), officialClaim(id(6), '20106')],
  ]);
  await assertFails(runTransaction(adminDb, async (tx) => {
    const resultRef = doc(adminDb, 'typingResults', id(6));
    const receiptRef = doc(adminDb, 'receipts', id(6));
    const claimRef = doc(adminDb, 'receipts', claimId('20106'));
    await Promise.all([tx.get(resultRef), tx.get(receiptRef), tx.get(claimRef)]);
    tx.delete(receiptRef); tx.delete(claimRef);
  }));
  passed++;

  // Legacy UID rows remove their matching typing receipt with the result.
  await seed([
    ['typingResults', id(7), record(id(7), '', 'legacy')],
    ['receipts', id(7), { id: id(7), owner_uid: 'legacy-account', kind: 'typing', payload_hash: 'b'.repeat(64), created_at: new Date() }],
  ]);
  await assertSucceeds(runTransaction(adminDb, async (tx) => {
    const resultRef = doc(adminDb, 'typingResults', id(7));
    const receiptRef = doc(adminDb, 'receipts', id(7));
    await Promise.all([tx.get(resultRef), tx.get(receiptRef)]);
    tx.delete(resultRef); tx.delete(receiptRef);
  }));
  passed++;

  // Letter receipts are outside typing cleanup and remain undeletable through this rule.
  await seed([
    ['receipts', id(8), { id: id(8), owner_uid: null, entry_mode: 'record', kind: 'letter', payload_hash: 'c'.repeat(64), created_at: new Date() }],
  ]);
  await assertFails(deleteDoc(doc(adminDb, 'receipts', id(8))));
  passed++;

  // Once the old claim has been released, the public create transaction can claim the same student number again.
  const activeChallenge = 'typing-delete-rule-test';
  await env.withSecurityRulesDisabled(async (context) => {
    const firestore = context.firestore();
    await setDoc(doc(firestore, 'settings', 'event'), { phase: 'A', activeChallengeId: activeChallenge });
    await setDoc(doc(firestore, 'challenges', activeChallenge), { text: 'abcdefghij', referenceKeystrokes: 10, practice: false, enabled: true });
  });
  await seed([
    ['typingResults', id(9), record(id(9), '20109')],
    ['receipts', id(9), recordReceipt(id(9))],
    ['receipts', claimId('20109'), officialClaim(id(9), '20109')],
  ]);
  await assertSucceeds(removeTogether(adminDb, id(9), '20109'));
  const next = id(10);
  const batch = writeBatch(studentDb);
  batch.set(doc(studentDb, 'typingResults', next), {
    id: next, entry_mode: 'record', owner_uid: null, participantId: '20109', displayName: '학생',
    challengeId: activeChallenge, elapsedMs: 60000, speed: 10, errors: 0, score: 10,
    completedAt: '2026-11-16T00:00:00.000Z', prizeReceived: false, practice: false,
    verificationStatus: 'pending', received_at: serverTimestamp(), reviewed_at: null,
  });
  batch.set(doc(studentDb, 'receipts', next), {
    id: next, owner_uid: null, entry_mode: 'record', kind: 'typing', payload_hash: 'd'.repeat(64), created_at: serverTimestamp(),
  });
  batch.set(doc(studentDb, 'receipts', claimId('20109')), {
    kind: 'typingEntry', result_id: next, student_number: '20109', created_at: serverTimestamp(),
  });
  await assertSucceeds(batch.commit());
  assert.equal((await read(adminDb, 'receipts', claimId('20109'))).data().result_id, next);
  passed++;

  console.log(`firestore delete rules: ${passed} emulator cases passed`);
} finally {
  await env.cleanup();
}
