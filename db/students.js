import { adminContext, getClients, withDeadline } from './firebase.js';
import { normalizeText, UUID_PATTERN } from '../common.js';
import {
  collection,
  documentId,
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
const LOGIN_ID = /^[1-3][0-9]{4}$/;
const HISTORY_PAGE_SIZE = 20;
const MAX_HISTORY_PAGE_SIZE = 100;

const isStudentId = (id) => typeof id === 'string' && STUDENT_ID.test(id);
const record = (snapshot) => ({ ...snapshot.data(), id: snapshot.id });

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

// Fetch only profiles referenced by a visible page, using small ID-query batches.
export async function readStudentsByIds(db, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const uniqueIds = [...new Set(ids.filter(isStudentId))];
  if (uniqueIds.length === 0) return [];

  const pages = await Promise.all(
    Array.from({ length: Math.ceil(uniqueIds.length / 10) }, (_, index) =>
      withDeadline(
        getDocs(
          query(
            collection(db, 'students'),
            where(documentId(), 'in', uniqueIds.slice(index * 10, index * 10 + 10)),
          ),
        ),
      ),
    ),
  );
  const byId = new Map(
    pages.flatMap((page) => page.docs.map((snapshot) => [snapshot.id, record(snapshot)])),
  );
  return uniqueIds.flatMap((id) => (byId.has(id) ? [byId.get(id)] : []));
}

export async function readStudent(db, studentId) {
  if (!isStudentId(studentId)) return null;
  const snapshot = await withDeadline(getDoc(doc(db, 'students', studentId)));
  return snapshot.exists() ? record(snapshot) : null;
}

export async function readStudentByLogin(db, loginId) {
  if (typeof loginId !== 'string' || !LOGIN_ID.test(loginId)) return null;
  const matches = await withDeadline(
    getDocs(query(collection(db, 'students'), where('login_id', '==', loginId), limit(2))),
  );
  if (matches.size > 1) throw new Error('학번이 중복 등록되어 있습니다.');
  return matches.empty ? null : record(matches.docs[0]);
}

// Full substring matching cannot be expressed by Firestore. Exact current
// student numbers use one indexed query; shorter numeric searches scan the
// roster only after the administrator has entered a search term.
export async function findStudentsByLogin(db, search) {
  const value = typeof search === 'string' ? search.trim() : '';
  if (!/^[0-9]{1,5}$/.test(value)) return [];
  if (value.length === 5) {
    if (!LOGIN_ID.test(value)) return [];
    const matches = await withDeadline(
      getDocs(query(collection(db, 'students'), where('login_id', '==', value))),
    );
    return matches.docs.map(record);
  }
  const roster = await readStudents(db);
  return roster.filter((student) => student.login_id?.includes(value));
}

export async function readStudentLetter(db, studentId, letterId) {
  if (!isStudentId(studentId) || !UUID_PATTERN.test(letterId ?? '')) return null;
  const snapshot = await withDeadline(getDoc(doc(db, 'letters', letterId)));
  if (!snapshot.exists() || snapshot.data().owner_uid !== studentId) return null;
  return record(snapshot);
}

export async function readStudentHistoryPage(
  db,
  studentId,
  kind,
  { cursor = null, pageSize = HISTORY_PAGE_SIZE } = {},
) {
  if (!isStudentId(studentId)) throw new Error('학번을 확인하세요.');
  if (!['letters', 'logs'].includes(kind)) throw new Error('기록 종류를 확인하세요.');
  const size =
    Number.isInteger(pageSize) && pageSize > 0
      ? Math.min(pageSize, MAX_HISTORY_PAGE_SIZE)
      : HISTORY_PAGE_SIZE;
  const collectionName = kind === 'letters' ? 'letters' : 'moderationLogs';
  const ownerField = kind === 'letters' ? 'owner_uid' : 'target_student_id';
  const constraints = [
    where(ownerField, '==', studentId),
    orderBy('created_at', 'desc'),
    orderBy(documentId(), 'desc'),
  ];
  if (cursor !== null) {
    const validCursor =
      cursor &&
      typeof cursor.id === 'string' &&
      cursor.id.length > 0 &&
      cursor.id.length <= 1500 &&
      typeof cursor.createdAt?.toMillis === 'function';
    if (!validCursor) throw new Error('기록 페이지 위치를 확인하세요.');
    constraints.push(startAfter(cursor.createdAt, cursor.id));
  }
  constraints.push(limit(size + 1));
  const page = await withDeadline(
    getDocs(query(collection(db, collectionName), ...constraints)),
  );
  const snapshots = page.docs.slice(0, size);
  const items = snapshots.map(record);
  const hasNext = page.docs.length > size;
  const last = snapshots.at(-1);
  return {
    items,
    cursor: hasNext && last ? { createdAt: last.get('created_at'), id: last.id } : null,
    hasNext,
  };
}

export async function readStudentHistory(db, studentId) {
  if (!isStudentId(studentId)) throw new Error('학번을 확인하세요.');
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
