import { adminContext, getClients, withDeadline } from './firebase.js';
import { normalizeText, UUID_PATTERN } from '../common.js';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  startAfter,
  Timestamp,
  where,
  writeBatch,
} from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';

export const DEFAULT_SESSION_POLICY = { boothMode: true, idleMinutes: 10, academicYear: 2026 };
const STUDENT_ID = /^(?:[A-Za-z0-9_-]{20}|[0-9]{7})$/;
const CANONICAL_STUDENT_ID = /^[A-Za-z0-9_-]{20}$/;

export function studentGrade(student, academicYear) {
  const grade = academicYear - student.admission_year + 1;
  return Number.isInteger(grade) && grade >= 1 && grade <= 3 ? grade : null;
}
export function writeRestricted(student, now = Date.now()) {
  return (
    student.write_blocked === true &&
    (!student.blocked_until || student.blocked_until.toMillis() > now)
  );
}
export async function readSessionPolicy(db) {
  const saved = await withDeadline(getDoc(doc(db, 'settings', 'sessionPolicy')));
  return saved.exists() ? saved.data() : { ...DEFAULT_SESSION_POLICY };
}
export async function saveSessionPolicy(db, value) {
  const idleMinutes = Number(value.idleMinutes);
  const academicYear = Number(value.academicYear);
  if (
    !Number.isInteger(idleMinutes) ||
    idleMinutes < 1 ||
    idleMinutes > 120 ||
    !Number.isInteger(academicYear) ||
    academicYear < 2020 ||
    academicYear > 2100
  )
    throw new Error('미사용 시간은 1~120분, 기준 학년도는 2020~2100년으로 입력하세요.');
  const batch = writeBatch(db);
  batch.set(doc(db, 'settings', 'sessionPolicy'), {
    boothMode: value.boothMode === true,
    idleMinutes,
    academicYear,
    updated_at: serverTimestamp(),
  });
  await withDeadline(batch.commit());
}
async function documents(db, name, filters = []) {
  const items = [];
  let cursor;
  while (true) {
    const page = await withDeadline(
      getDocs(
        query(
          collection(db, name),
          ...filters,
          orderBy('__name__'),
          ...(cursor ? [startAfter(cursor)] : []),
          limit(100),
        ),
      ),
    );
    items.push(...page.docs.map((item) => ({ ...item.data(), id: item.id })));
    if (page.docs.length < 100) return items;
    cursor = page.docs.at(-1);
  }
}
export const readStudents = (db) => documents(db, 'students');
export async function readStudentHistory(db, studentId) {
  if (!STUDENT_ID.test(studentId)) throw new Error('학번을 확인하세요.');
  const [letters, logs] = await Promise.all([
    documents(db, 'letters', [where('owner_uid', '==', studentId)]),
    documents(db, 'moderationLogs', [where('target_student_id', '==', studentId)]),
  ]);
  return {
    letters: letters.sort(
      (a, b) => (b.created_at?.toMillis() ?? 0) - (a.created_at?.toMillis() ?? 0),
    ),
    logs: logs.sort(
      (a, b) => (b.created_at?.toMillis() ?? 0) - (a.created_at?.toMillis() ?? 0),
    ),
  };
}
export function moderationUpdate(action, until = null) {
  if (action === 'block_write') {
    const milliseconds = until ? Date.parse(until) : null;
    if (milliseconds !== null && (!Number.isFinite(milliseconds) || milliseconds <= Date.now()))
      throw new Error('제한 종료 시각은 현재 이후로 입력하세요.');
    return {
      write_blocked: true,
      blocked_until: milliseconds === null ? null : Timestamp.fromMillis(milliseconds),
    };
  }
  if (action === 'unblock_write') return { write_blocked: false, blocked_until: null };
  if (action === 'deactivate') return { is_active: false };
  if (action === 'activate') return { is_active: true };
  throw new Error('조치 종류를 확인하세요.');
}
export async function moderateStudent(studentId, values) {
  const reason = normalizeText(values.reason ?? '');
  const related = values.related_letter_id || null;
  if (
    !STUDENT_ID.test(studentId) ||
    !reason ||
    Array.from(reason).length > 500 ||
    (related !== null && !UUID_PATTERN.test(related))
  )
    throw new Error('학번·사유·관련 글을 확인하세요.');
  const { db, uid } = await adminContext();
  const id = crypto.randomUUID();
  const batch = writeBatch(db);
  batch.update(doc(db, 'students', studentId), {
    ...moderationUpdate(values.action, values.blocked_until),
    updated_at: serverTimestamp(),
    last_moderation_id: id,
  });
  batch.set(doc(db, 'moderationLogs', id), {
    target_student_id: studentId,
    action: values.action,
    reason,
    operator_uid: uid,
    related_letter_id: related,
    created_at: serverTimestamp(),
  });
  await withDeadline(batch.commit());
  return (await withDeadline(getDoc(doc(db, 'students', studentId)))).data();
}
let functionsClient;
export async function canResetStudentPassword() {
  const { adminAuth, emulator } = await getClients();
  return emulator || adminAuth.app.options.studentAdminFunctionsEnabled === true;
}
export async function resetStudentPassword(studentId, reason) {
  if (
    !CANONICAL_STUDENT_ID.test(studentId) ||
    !normalizeText(reason) ||
    Array.from(normalizeText(reason)).length > 500
  )
    throw new Error('학번과 사유를 확인하세요.');
  const { adminAuth, emulator } = await getClients();
  if (!emulator && adminAuth.app.options.studentAdminFunctionsEnabled !== true)
    throw new Error(
      '학생 비밀번호 재발급 서버가 아직 연결되지 않았습니다. 운영진이 서버 설정을 완료해야 합니다.',
    );
  await adminContext();
  if (!functionsClient) {
    functionsClient = (async () => {
      const sdk =
        await import('https://www.gstatic.com/firebasejs/13.1.0/firebase-functions.js');
      const client = sdk.getFunctions(
        adminAuth.app,
        adminAuth.app.options.functionsRegion || 'asia-northeast3',
      );
      if (emulator) sdk.connectFunctionsEmulator(client, '127.0.0.1', 5008);
      return sdk.httpsCallable(client, 'resetStudentPassword', { timeout: 30000 });
    })().catch((error) => {
      functionsClient = null;
      throw error;
    });
  }
  return (await (await functionsClient)({ studentId, reason: normalizeText(reason) })).data;
}
