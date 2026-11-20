import assert from 'node:assert/strict';
import {
  COLLECTIONS, SCHEMA_VERSION, collectionPath, documentPath, logicalId,
  kindForPath, fieldPath, encodeData, decodeData, legacyDestination,
} from '../db/schema.js';

assert.equal(SCHEMA_VERSION, 6);
assert.equal(collectionPath('typingResults'), '타자대회/기본/기록');
assert.equal(documentPath('settings', 'event'), '운영설정/행사');
assert.equal(documentPath('settings', 'sessionPolicy'), '운영설정/세션');
assert.equal(documentPath('typingEntries', 'official-20261123-20101'), '타자대회/기본/참여제한/20101');
assert.equal(documentPath('typingEntries', 'official-20350101-20101'), '타자대회/기본/참여제한/20101');
assert.equal(logicalId('typingEntries', '20101'), '20101');
assert.equal(logicalId('typingEntries', 'official-20261123-20101'), '20101');
assert.equal(kindForPath('글쓰기/기본/접수글/0123'), 'letters');
assert.equal(kindForPath('타자대회/기본/기록/0123'), 'typingResults');
assert.equal(kindForPath('타자대회/2026-11-23/기록/0123'), null);
assert.equal(kindForPath('학생들/오래된/위치'), null);
assert.equal(fieldPath('verificationStatus'), '검수상태');
assert.equal(fieldPath('letter.status'), '글원본.검수상태');
assert.equal(fieldPath('__name__'), '__name__');

const typing = {
  id: '00000000-0000-4000-8000-000000000001',
  entry_mode: 'record', owner_uid: null, participantId: '20101', displayName: '오별이',
  challengeId: 'demo', elapsedMs: 1100.5, speed: 42, errors: 3, score: 33,
  completedAt: '2026-11-23T03:00:00.000Z', received_at: {seconds:42,nanoseconds:123000000},
  reviewed_at: null, prizeReceived: false, practice: false,
  verificationStatus: 'pending', duplicate_of: null,
};
const encodedTyping = encodeData('typingResults', typing);
assert.equal(encodedTyping['학번'], '20101');
assert.equal(encodedTyping['이름'], '오별이');
assert.equal(encodedTyping['최종점수'], 33);
assert.equal(encodedTyping['소요시간밀리초'], 1100.5);
assert.equal(encodedTyping['접수시각'], typing.received_at);
assert.deepEqual(decodeData('typingResults', encodedTyping), typing);

const legacyTyping = {...typing};
delete legacyTyping.entry_mode;
legacyTyping.owner_uid = 'legacy-user-0123456789';
const encodedLegacy = encodeData('typingResults', legacyTyping);
assert.equal(encodedLegacy['이전참가자ID'], '20101');
assert.equal('학번' in encodedLegacy, false);
assert.deepEqual(decodeData('typingResults', encodedLegacy), legacyTyping);

const letter = {
  id: '00000000-0000-4000-8000-000000000002', owner_uid: null, entry_mode: 'record',
  student_number: '20102', student_name: '학생', nickname: null, content: '글 내용',
  published_content: null, consent_to_publish: 1, status: 'pending', publish_order: null,
  submission_key: '00000000-0000-4000-8000-000000000002', created_at: {seconds:11,nanoseconds:0},
  reviewed_at: null,
};
const encodedLetter = encodeData('letters', letter);
assert.equal(encodedLetter['학번'], '20102');
assert.equal(encodedLetter['이름'], '학생');
assert.deepEqual(decodeData('letters', encodedLetter), letter);
const trash = {letter,trashed_at:{seconds:13,nanoseconds:0},trashed_by:'admin',last_history_id:'history'};
const encodedTrash = encodeData('letterTrash', trash);
assert.deepEqual(encodedTrash, {'글원본':encodedLetter,'삭제시각':trash.trashed_at,'삭제관리자UID':'admin','최근이력ID':'history'});
assert.deepEqual(decodeData('letterTrash', encodedTrash), trash);

assert.equal(legacyDestination('receipts', typing.id, {kind:'typing'}).path, `${COLLECTIONS.typingReceipts}/${typing.id}`);
assert.equal(legacyDestination('receipts', 'official-20261123-20101', {kind:'typingEntry'}).path,
  `${COLLECTIONS.typingEntries}/20101`);
assert.equal(legacyDestination('receipts', letter.id, {kind:'letter'}).path, `${COLLECTIONS.letterReceipts}/${letter.id}`);
assert.throws(()=>encodeData('typingResults',{...typing, unknown_field:'bad'}),/Unknown typingResults field/);
assert.throws(()=>documentPath('typingResults','bad/id'),/Invalid document ID/);

console.log('schema codec: Korean paths, fields, legacy identity separation, nested audit documents, receipt split and strict writes passed');
