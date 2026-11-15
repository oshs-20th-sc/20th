import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../db/database.js', import.meta.url), 'utf8');
const startMarker = 'export async function diagnoseTypingSubmission(db, input) {';
const endMarker = '\nexport async function submitTyping';
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);
assert(start >= 0 && end > start, 'diagnostic helper source must be present');
const helperSource = source.slice(start, end).replace('export async function', 'async function');

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHALLENGE_ID = '00000000-0000-4000-8000-000000000001';
const RECORD_ID = '00000000-0000-4000-8000-000000000002';
const OTHER_ID = '00000000-0000-4000-8000-000000000003';
const BASE = {
  id: RECORD_ID,
  entry_mode: 'record',
  participantId: '20101',
  displayName: '참가자',
  challengeId: CHALLENGE_ID,
  elapsedMs: 164312,
  speed: 265,
  errors: 20,
  score: 205,
  completedAt: '2026-11-15T14:00:00.000Z',
  practice: false,
  prizeReceived: false,
};
const EXPECTED_PAYLOAD = {
  id: RECORD_ID,
  entry_mode: 'record',
  owner_uid: null,
  participantId: '20101',
  displayName: '참가자',
  challengeId: CHALLENGE_ID,
  elapsedMs: 164312,
  speed: 265,
  errors: 20,
  score: 205,
  completedAt: '2026-11-15T14:00:00.000Z',
  practice: false,
  prizeReceived: false,
  verificationStatus: 'pending',
  reviewed_at: null,
};

function setup({ receipts = {}, results = {}, activeChallengeId = CHALLENGE_ID } = {}) {
  const reads = [];
  const db = {
    receipts,
    results,
    activeChallengeId,
    challenge: {
      challengeId: CHALLENGE_ID,
      title: '테스트 문구',
      text: '가나다',
      referenceKeystrokes: 3,
      errorPenalty: 3,
      practice: false,
      enabled: true,
      deleted: false,
    },
  };
  const context = {
    UUID_PATTERN: uuidPattern,
    OFFICIAL_CLAIM_PREFIX: 'official-20261123-',
    doc: (database, collection, id) => ({ database, collection, id }),
    getDoc: async ({ database, collection, id }) => {
      reads.push(`${collection}/${id}`);
      const data = collection === 'receipts'
        ? database.receipts[id]
        : collection === 'typingResults'
          ? database.results[id]
          : undefined;
      return { exists: () => data !== undefined, data: () => data };
    },
    withDeadline: (promise) => promise,
    payloadHash: async (payload) => JSON.stringify(payload),
    validateParticipant: ({ studentNumber, name }) =>
      /^[1-3][0-9]{4}$/.test(studentNumber) && name.trim()
        ? { value: { studentNumber: studentNumber.trim(), name: name.trim() } }
        : { error: 'invalid identity' },
    readEvent: async (database) => ({ activeChallengeId: database.activeChallengeId }),
    readChallenge: async (database) => database.challenge,
    countKeystrokes: (text) => Array.from(text).length,
    validateTypingResult: (input) => {
      if (!Number.isFinite(input.elapsedMs) || input.elapsedMs <= 0 || input.speed !== 265 || input.score !== 205)
        throw new Error('test validation rejected payload');
    },
  };
  const factory = new vm.Script(`(() => { ${helperSource}; return diagnoseTypingSubmission; })()`);
  return { db, reads, diagnose: factory.runInNewContext(context) };
}

const claimId = 'official-20261123-20101';

{
  const { db, diagnose } = setup({
    receipts: { [claimId]: { kind: 'typingEntry', student_number: '20101', result_id: OTHER_ID } },
    results: { [OTHER_ID]: { id: OTHER_ID } },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await diagnose(db, BASE))), {
    kind: 'claim_used', resultExists: true,
  });
}

{
  const { db, diagnose } = setup({
    receipts: { [claimId]: { kind: 'typingEntry', student_number: '20101', result_id: OTHER_ID } },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await diagnose(db, BASE))), {
    kind: 'claim_used', resultExists: false,
  });
}

{
  const { db, diagnose } = setup({
    receipts: {
      [RECORD_ID]: { entry_mode: 'record', kind: 'typing', payload_hash: JSON.stringify(EXPECTED_PAYLOAD) },
    },
    results: { [RECORD_ID]: { id: RECORD_ID } },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await diagnose(db, BASE))), { kind: 'already_saved' });
}

{
  const { db, diagnose } = setup();
  assert.deepEqual(JSON.parse(JSON.stringify(await diagnose(db, BASE))), {
    kind: 'rules_rejection_unresolved',
  });
}

{
  const { db, diagnose } = setup({ activeChallengeId: OTHER_ID });
  assert.deepEqual(JSON.parse(JSON.stringify(await diagnose(db, BASE))), { kind: 'challenge_changed' });
}

{
  const { db, diagnose, reads } = setup();
  assert.deepEqual(JSON.parse(JSON.stringify(await diagnose(db, { ...BASE, id: 'bad-id' }))), {
    kind: 'invalid_local_id',
  });
  assert.equal(reads.length, 0, 'invalid local IDs do not read the server');
  assert.deepEqual(JSON.parse(JSON.stringify(await diagnose(db, { ...BASE, score: 204 }))), {
    kind: 'invalid_payload',
    reason: 'test validation rejected payload',
  });
  assert.equal(reads.length, 2, 'invalid payloads read only the two private receipts');
}

console.log('typing diagnostic: 6 cases passed');
