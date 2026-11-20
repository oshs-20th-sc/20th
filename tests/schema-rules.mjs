// Scope and access-boundary checks for the v6 canonical Firestore schema.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const firebase = require('firebase/compat/app');
require('firebase/compat/firestore');
const projectId = 'demo-oshs-schema-rules';
const rules = await readFile(new URL('../db/firestore.rules', import.meta.url), 'utf8');
const env = await initializeTestEnvironment({ projectId, firestore: { host: '127.0.0.1', port: 8088, rules } });
const doc = (db, path) => db.doc(path);
const publicDb = env.unauthenticatedContext().firestore();
const studentDb = env.authenticatedContext('student-uid').firestore();
const adminDb = env.authenticatedContext('admin-uid').firestore();
let passed = 0;
const prizeIds = {
  pending: '00000000-0000-4000-8000-000000000001',
  rejected: '00000000-0000-4000-8000-000000000002',
  practice: '00000000-0000-4000-8000-000000000003',
};
async function seed(rows) {
  await env.withSecurityRulesDisabled(async (context) => {
    const firestore = context.firestore();
    for (const [path, data] of rows) await doc(firestore, path).set(data);
  });
}
try {
  await seed([
    ['관리자/admin-uid', { 사용여부: true, 이메일: 'admin@example.invalid', 생성시각: new Date() }],
    ['관리자/other-admin', { 사용여부: true, 이메일: 'other@example.invalid', 생성시각: new Date() }],
    ['운영설정/행사', { 운영단계: 'A', 수정시각: new Date(), 글접수허용: true, 공개글열람허용: false }],
    ['운영설정/세션', { 공용기기모드: true, 자동퇴장대기분: 20, 수정시각: new Date() }],
    ['운영설정/비대상', { 공개: true }],
    ['타자대회/기본', { 운영명: '타자 대회', 스키마버전: 6 }],
    ['타자대회/2026-11-22', { 행사명: '타자 대회', 행사일: '2026-11-22', 스키마버전: 5 }],
    ['글쓰기/기본', { 운영명: '글쓰기', 스키마버전: 6 }],
    ['글쓰기/다른행사', { 운영명: '글쓰기', 스키마버전: 5 }],
    ['타자대회/기본/문구/public', { 문구본문: '공개 문구' }],
    ['타자대회/기본/문구/prize-eligible', { 문구본문: '공식 문구', 기준타수: 1, 연습여부: false, 사용여부: true, 오타감점: 3 }],
    ['타자대회/기본/문구/prize-practice', { 문구본문: '연습 문구', 기준타수: 1, 연습여부: true, 사용여부: true, 오타감점: 3 }],
    ['타자대회/2026-11-22/문구/wrong-event', { 문구본문: '다른 행사 문구' }],
    ['타자대회/기본/기록/private-record', { 문서ID: 'private-record' }],
    ...['pending', 'rejected', 'practice'].map((variant) => {
      const id = prizeIds[variant];
      const practice = variant === 'practice';
      return [`타자대회/기본/기록/${id}`, {
        문서ID: id,
        이전계정UID: null,
        참가방식: 'record',
        학번: '20101',
        이름: '학생',
        문구ID: practice ? 'prize-practice' : 'prize-eligible',
        소요시간밀리초: 60000,
        분당타수: 1,
        누적오타: 0,
        최종점수: 1,
        완료시각: '2026-11-20T03:00:00Z',
        상품수령여부: false,
        연습여부: practice,
        검수상태: variant === 'rejected' ? 'rejected' : 'pending',
        접수시각: new Date(),
        검수시각: null,
      }];
    }),
    ['글쓰기/기본/접수글/private-letter', { 문서ID: 'private-letter' }],
    ['글쓰기/다른행사/접수글/wrong-event', { 문서ID: 'wrong-event' }],
    ['글쓰기/기본/기타/wrong-subcollection', { 공개: true }],
    ['기타/admin-uid', { 사용여부: true }],
  ]);

  // Public metadata is limited to the exact event/config documents; there is no collection listing.
  await assertSucceeds(doc(publicDb, '운영설정/행사').get());
  await assertSucceeds(doc(publicDb, '운영설정/세션').get());
  await assertSucceeds(doc(publicDb, '타자대회/기본').get());
  await assertSucceeds(doc(publicDb, '글쓰기/기본').get());
  await assertFails(doc(publicDb, '운영설정/비대상').get());
  await assertFails(doc(publicDb, '타자대회/2026-11-23').get());
  await assertFails(doc(publicDb, '타자대회/2026-11-22').get());
  await assertFails(doc(publicDb, '글쓰기/다른행사').get());
  await assertFails(publicDb.collection('운영설정').get());
  await assertFails(doc(adminDb, '타자대회/기본').set({ 행사명: 'changed' }));
  passed++;

  // Same-depth path substitutions cannot inherit access from the matching collection block.
  await assertSucceeds(doc(publicDb, '타자대회/기본/문구/public').get());
  await assertFails(doc(publicDb, '타자대회/2026-11-23/문구/public').get());
  await assertFails(doc(publicDb, '타자대회/2026-11-22/문구/wrong-event').get());
  await assertFails(doc(adminDb, '글쓰기/다른행사/접수글/wrong-event').get());
  await assertFails(doc(adminDb, '글쓰기/기본/기타/wrong-subcollection').get());
  await assertSucceeds(doc(adminDb, '타자대회/기본/기록/private-record').get());
  await assertFails(doc(studentDb, '타자대회/기본/기록/private-record').get());
  await assertFails(doc(studentDb, '글쓰기/기본/접수글/private-letter').get());
  await assertSucceeds(doc(adminDb, '글쓰기/기본/접수글/private-letter').get());
  passed++;

  // Product receipt does not require a separate "verified" status, but practice and rejected records stay ineligible.
  const serverTimestamp = firebase.firestore.FieldValue.serverTimestamp();
  await assertSucceeds(doc(adminDb, `타자대회/기본/기록/${prizeIds.pending}`).update({
    상품수령여부: true,
    검수시각: serverTimestamp,
  }));
  await assertFails(doc(adminDb, `타자대회/기본/기록/${prizeIds.rejected}`).update({
    상품수령여부: true,
    검수시각: firebase.firestore.FieldValue.serverTimestamp(),
  }));
  await assertFails(doc(adminDb, `타자대회/기본/기록/${prizeIds.practice}`).update({
    상품수령여부: true,
    검수시각: firebase.firestore.FieldValue.serverTimestamp(),
  }));
  passed++;

  // The account role doc is self-readable; another role doc and a same-depth impostor are not.
  await assertSucceeds(doc(adminDb, '관리자/admin-uid').get());
  await assertFails(doc(studentDb, '관리자/admin-uid').get());
  await assertFails(doc(studentDb, '관리자/other-admin').get());
  await assertFails(doc(adminDb, '기타/admin-uid').get());
  await assertFails(doc(studentDb, '관리자/student-uid').set({ 사용여부: true }));
  passed++;

  // Unknown paths default to deny for anonymous, signed-in, and admin clients.
  for (const db of [publicDb, studentDb, adminDb]) {
    await assertFails(doc(db, '타자대회/기본/미등록/private').get());
    await assertFails(doc(db, '알수없음/문서').get());
  }
  passed++;
  console.log(`canonical Firestore schema rules: ${passed} emulator groups passed`);
} finally { await env.cleanup(); }
