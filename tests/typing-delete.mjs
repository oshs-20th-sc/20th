import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../db/database.js', import.meta.url), 'utf8');
const createStart = source.indexOf('async function existingRecordReceipt');
const createEnd = source.indexOf('\nexport async function submitLetter', createStart);
const deleteStart = source.indexOf('export async function deleteTyping');
const deleteEnd = source.indexOf('\nexport function encodeFirestore', deleteStart);
assert(createStart >= 0 && createEnd > createStart, 'submission helper source must be present');
assert(deleteStart >= 0 && deleteEnd > deleteStart, 'deletion helper source must be present');
const createSource = source.slice(createStart, createEnd);
const deleteSource = source.slice(deleteStart, deleteEnd).replaceAll('export async function', 'async function');

const ID = '00000000-0000-4000-8000-000000000001';
const NEW_ID = '00000000-0000-4000-8000-000000000002';
const OTHER_ID = '00000000-0000-4000-8000-000000000003';
const CLAIM_ID = 'official-20261123-20101';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function setup({ results = {}, receipts = {}, authorized = true, failCommit = false } = {}) {
  const db = { results: structuredClone(results), receipts: structuredClone(receipts), authorized, failCommit };
  const path = (ref) => `${ref.collection}/${ref.id}`;
  const snapshot = (value) => ({ exists: () => value !== undefined, data: () => value });
  const read = (database, ref) => ref.collection === 'typingResults'
    ? database.results[ref.id]
    : database.receipts[ref.id];
  const context = {
    UUID_PATTERN,
    OFFICIAL_CLAIM_PREFIX: 'official-20261123-',
    ClientError: class ClientError extends Error {
      constructor(message, status = 0, code = 'UNKNOWN') { super(message); this.status = status; this.code = code; }
    },
    doc: (database, collection, id) => ({ database, collection, id }),
    withDeadline: (promise) => promise,
    payloadHash: async (payload) => JSON.stringify(payload),
    serverTimestamp: () => 'server-time',
    getDoc: async (ref) => snapshot(read(ref.database, ref)),
    writeBatch: (database) => {
      const writes = [];
      return {
        set(ref, data) { writes.push({ op: 'set', ref, data }); },
        async commit() {
          if (!database.authorized) throw Object.assign(new Error('permission denied'), { code: 'permission-denied' });
          if (writes.some((write) => write.ref.collection === 'typingEntries' &&
              write.ref.id.startsWith('official-20261123-') && database.receipts[write.ref.id]))
            throw Object.assign(new Error('claim already exists'), { code: 'permission-denied' });
          for (const write of writes) {
            const store = write.ref.collection === 'typingResults' ? database.results : database.receipts;
            store[write.ref.id] = structuredClone(write.data);
          }
        },
      };
    },
    runTransaction: async (database, callback) => {
      if (!database.authorized) throw Object.assign(new Error('permission denied'), { code: 'permission-denied' });
      const writes = [];
      const tx = {
        get: async (ref) => snapshot(read(database, ref)),
        delete: (ref) => writes.push({ op: 'delete', ref }),
      };
      const value = await callback(tx);
      if (database.failCommit) throw Object.assign(new Error('transaction aborted'), { code: 'unavailable' });

      const afterResults = structuredClone(database.results);
      const afterReceipts = structuredClone(database.receipts);
      for (const write of writes) {
        if (write.ref.collection === 'typingResults') delete afterResults[write.ref.id];
        else delete afterReceipts[write.ref.id];
      }
      for (const write of writes) {
        const { collection, id } = write.ref;
        if (collection === 'typingResults') {
          const before = database.results[id];
          if (before?.entry_mode === 'record') {
            assert.equal(afterReceipts[id], undefined, 'record deletion must remove its UUID receipt atomically');
            const claim = database.receipts[`${CLAIM_ID}`];
            if (before.practice === false && claim?.kind === 'typingEntry' &&
                claim.student_number === before.participantId && claim.result_id === id)
              assert.equal(afterReceipts[CLAIM_ID], undefined, 'exact official claim must be released atomically');
          } else if (database.receipts[id]?.kind === 'typing') {
            assert.equal(afterReceipts[id], undefined, 'legacy typing receipt must be removed with its result');
          }
        }
        if (collection === 'typingEntries' && id.startsWith('official-20261123-')) {
          const claim = database.receipts[id];
          assert.equal(afterResults[claim?.result_id], undefined, 'claim cannot be released while its result exists');
          assert.equal(afterReceipts[claim?.result_id], undefined, 'claim and UUID receipt are deleted together');
        }
      }
      for (const write of writes) {
        if (write.ref.collection === 'typingReceipts' && database.receipts[write.ref.id]?.kind === 'typing')
          assert.equal(afterResults[write.ref.id], undefined, 'typing receipt cannot be removed while its result exists');
      }
      database.results = afterResults;
      database.receipts = afterReceipts;
      return value;
    },
  };
  const factory = new vm.Script(`(() => { ${createSource}; ${deleteSource}; return { deleteTyping, releaseOrphanedTypingClaim, createRecordOnce }; })()`);
  return { db, api: factory.runInNewContext(context), path };
}

const result = (id = ID, participantId = '20101') => ({
  id, entry_mode: 'record', owner_uid: null, participantId, practice: false,
});
const receipt = () => ({ id: ID, owner_uid: null, entry_mode: 'record', kind: 'typing', payload_hash: 'a'.repeat(64) });
const claim = (resultId = ID, studentNumber = '20101') => ({
  kind: 'typingEntry', result_id: resultId, student_number: studentNumber,
});

{
  const { db, api } = setup({
    results: { [ID]: result() },
    receipts: { [ID]: receipt(), [CLAIM_ID]: claim() },
  });
  const deleted = await api.deleteTyping(db, ID);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.releasedParticipation, true);
  assert.equal(db.results[ID], undefined);
  assert.equal(db.receipts[ID], undefined);
  assert.equal(db.receipts[CLAIM_ID], undefined);
}

{
  const { db, api } = setup({
    results: { [ID]: result(), [OTHER_ID]: result(OTHER_ID) },
    receipts: { [ID]: receipt(), [CLAIM_ID]: claim(OTHER_ID) },
  });
  const deleted = await api.deleteTyping(db, ID);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.releasedParticipation, false);
  assert.ok(db.results[OTHER_ID]);
  assert.deepEqual(db.receipts[CLAIM_ID], claim(OTHER_ID));
}

{
  const legacy = { id: ID, owner_uid: 'legacy-user', participantId: 'legacy-user' };
  const { db, api } = setup({
    results: { [ID]: legacy },
    receipts: { [ID]: { id: ID, owner_uid: 'legacy-user', kind: 'typing', payload_hash: 'b'.repeat(64) } },
  });
  await api.deleteTyping(db, ID);
  assert.equal(db.results[ID], undefined);
  assert.equal(db.receipts[ID], undefined, 'legacy UID receipt is removed with its result');
}

{
  const initialResults = { [ID]: result() };
  const initialReceipts = { [ID]: receipt(), [CLAIM_ID]: claim() };
  const { db, api } = setup({ results: initialResults, receipts: initialReceipts, failCommit: true });
  await assert.rejects(api.deleteTyping(db, ID), /transaction aborted/);
  assert.deepEqual(db.results, initialResults, 'failed transaction leaves result untouched');
  assert.deepEqual(db.receipts, initialReceipts, 'failed transaction leaves receipt and claim untouched');
}

{
  const { db, api } = setup();
  const deleted = await api.deleteTyping(db, ID);
  assert.deepEqual(JSON.parse(JSON.stringify(deleted)), { id: ID, deleted: false, replayed: true });
}

{
  const { db, api } = setup({
    results: { [ID]: result() },
    receipts: { [ID]: receipt(), [CLAIM_ID]: claim() },
    authorized: false,
  });
  await assert.rejects(api.deleteTyping(db, ID), (error) =>
    error.code === 'TYPING_DELETE_REJECTED' && error.message.includes('삭제 규칙'));
  assert.ok(db.results[ID]);
  assert.ok(db.receipts[CLAIM_ID]);
}

{
  const { db, api } = setup({
    receipts: { [CLAIM_ID]: claim(ID), [ID]: receipt() },
  });
  const repair = await api.releaseOrphanedTypingClaim(db, '20101', ID);
  assert.deepEqual(JSON.parse(JSON.stringify(repair)), { released: true, resultId: ID });
  assert.equal(db.receipts[CLAIM_ID], undefined);
  assert.equal(db.receipts[ID], undefined);
}

{
  const { db, api } = setup({
    results: { [NEW_ID]: result(NEW_ID) },
    receipts: { [CLAIM_ID]: claim(NEW_ID), [NEW_ID]: { ...receipt(), id: NEW_ID } },
  });
  const repair = await api.releaseOrphanedTypingClaim(db, '20101', ID);
  assert.deepEqual(JSON.parse(JSON.stringify(repair)), { released: false, reason: 'claim_changed' });
  assert.ok(db.results[NEW_ID]);
  assert.equal(db.receipts[CLAIM_ID].result_id, NEW_ID);
}

{
  const { db, api } = setup({ receipts: { [CLAIM_ID]: claim(ID) }, authorized: false });
  await assert.rejects(api.releaseOrphanedTypingClaim(db, '20101', ID),
    (error) => error.code === 'permission-denied');
  assert.equal(db.receipts[CLAIM_ID].result_id, ID);
}

{
  const { db, api } = setup({
    results: { [ID]: result() },
    receipts: { [ID]: receipt(), [CLAIM_ID]: claim() },
  });
  await api.deleteTyping(db, ID);
  const next = {
    id: NEW_ID, entry_mode: 'record', owner_uid: null, participantId: '20101',
    displayName: '참가자', challengeId: 'test-challenge', elapsedMs: 1000,
    speed: 100, errors: 0, score: 100, completedAt: '2026-11-16T00:00:00.000Z',
    practice: false, prizeReceived: false, verificationStatus: 'pending', reviewed_at: null,
  };
  const saved = await api.createRecordOnce(db, NEW_ID, 'typing', next, { claimStudentNumber: '20101' });
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), { id: NEW_ID, replayed: false });
  assert.equal(db.receipts[CLAIM_ID].result_id, NEW_ID, 'new official submission reuses the released slot');
  assert.ok(db.results[NEW_ID]);
}

console.log('typing delete: 10 cases passed');
