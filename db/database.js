import { makePublicData, toCsv } from '../common.js';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  where,
  runTransaction,
  serverTimestamp,
  startAfter,
  Timestamp,
  updateDoc,
  writeBatch,
  setDoc,
  deleteDoc,
} from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';
import { normalizeText, unicodeLength, UUID_PATTERN, validateSubmission } from '../common.js';
import { calculateScore, countKeystrokes } from '../typing/scoring.js';
import { CHALLENGE } from '../typing/challenge.js';
import { ClientError, withDeadline, adminContext, STUDENT_UID_PATTERN } from './firebase.js';
export const RATE_LIMIT = 600;
export const PAGE_SIZE = 100;
export async function payloadHash(payload) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}
async function createOnce(db, uid, id, kind, payload, ownerUid = uid) {
  const hash = await payloadHash(payload);
  return withDeadline(
    runTransaction(db, async (tx) => {
      const receiptRef = doc(db, 'receipts', id);
      const receipt = await tx.get(receiptRef);
      if (receipt.exists()) {
        if (receipt.data().payload_hash !== hash || receipt.data().kind !== kind)
          throw new ClientError(
            '동일 접수번호에 다른 내용이 연결되어 있습니다. 원래 내용으로 재시도해 주세요.',
            409,
            'KEY_CONFLICT',
          );
        return {
          id,
          replayed: true,
        };
      }
      const rateRef = doc(db, 'rateLimits', uid);
      const rate = await tx.get(rateRef);
      const previous = rate.data();
      const currentWindow =
        previous?.window_start instanceof Timestamp &&
        Date.now() - previous.window_start.toMillis() < 60000;
      if (currentWindow && Number(previous?.count) >= RATE_LIMIT)
        throw new ClientError(
          '이 기기의 제출 요청이 많습니다. 1분 후 다시 시도해 주세요.',
          429,
          'RATE_LIMITED',
        );
      tx.set(rateRef, {
        window_start: currentWindow ? previous.window_start : serverTimestamp(),
        count: currentWindow ? Number(previous.count) + 1 : 1,
        last_write_at: serverTimestamp(),
        last_event_id: id,
        kind,
      });
      tx.set(receiptRef, {
        id,
        owner_uid: ownerUid,
        kind,
        payload_hash: hash,
        created_at: serverTimestamp(),
      });
      tx.set(doc(db, kind === 'letter' ? 'letters' : 'typingResults', id), {
        ...payload,
        owner_uid: ownerUid,
        [kind === 'letter' ? 'created_at' : 'received_at']: serverTimestamp(),
      });
      return {
        id,
        replayed: false,
      };
    }),
  );
}
export async function submitLetter(db, uid, input) {
  await submissionStudent(db, uid, true);
  const { value, error } = validateSubmission(input);
  if (!value) throw new ClientError(error, 400, 'VALIDATION_FAILED');
  const payload = {
    id: value.submissionKey,
    nickname: value.nickname || null,
    content: value.content,
    published_content: null,
    consent_to_publish: 1,
    status: 'pending',
    publish_order: null,
    submission_key: value.submissionKey,
    reviewed_at: null,
  };
  return createOnce(db, uid, value.submissionKey, 'letter', payload);
}
export function validateTypingResult(input, challenge = CHALLENGE) {
  if (
    !UUID_PATTERN.test(input.id) ||
    !normalizeText(input.participantId) ||
    !normalizeText(input.displayName) ||
    unicodeLength(input.participantId) > 30 ||
    unicodeLength(input.displayName) > 30 ||
    input.challengeId !== challenge.challengeId ||
    input.practice !== challenge.practice ||
    input.prizeReceived ||
    !Number.isFinite(Date.parse(input.completedAt)) ||
    input.elapsedMs > 3600000
  )
    throw new ClientError('타자 기록의 형식을 확인해 주세요.', 400, 'INVALID_RESULT');
  const computed = calculateScore(challenge.referenceKeystrokes, input.elapsedMs, input.errors, challenge.errorPenalty);
  if (input.speed !== computed.speed || input.score !== computed.score)
    throw new ClientError('타수와 최종 점수 계산이 일치하지 않습니다.', 400, 'INVALID_SCORE');
}
async function submissionStudent(db, uid, writing = false) {
  if (!STUDENT_UID_PATTERN.test(uid)) throw new ClientError('학생 로그인이 필요합니다.', 401);
  const snapshot = await withDeadline(getDoc(doc(db, 'students', uid)));
  const student = snapshot.data();
  if (student?.student_id !== uid || student?.is_active !== true)
    throw new ClientError('계정을 사용할 수 없습니다. 운영진에게 문의하세요.', 403);
  if (
    writing &&
    student.write_blocked &&
    (!student.blocked_until || student.blocked_until.toMillis() > Date.now())
  )
    throw new ClientError('글 작성이 제한된 계정입니다. 운영진에게 문의하세요.', 403);
  return student;
}
export async function submitTyping(db, uid, result, { asAdmin = false } = {}) {
  if (!asAdmin) {
    const student = await submissionStudent(db, uid);
    if (result.participantId !== uid || result.displayName !== student.student_name)
      throw new ClientError('로그인 계정과 참가 정보가 일치하지 않습니다.', 403);
  }
  validateTypingResult(result, await readChallenge(db, result.challengeId));
  const ownerUid = asAdmin && result.owner_uid ? result.owner_uid : uid;
  if (asAdmin && ownerUid !== uid) {
    if (!STUDENT_UID_PATTERN.test(ownerUid) || result.participantId !== ownerUid)
      throw new ClientError('복구할 기록의 작성 계정이 일치하지 않습니다.', 400);
    const original = await withDeadline(getDoc(doc(db, 'students', ownerUid)));
    if (original.data()?.student_id !== ownerUid)
      throw new ClientError('원래 학생 계정의 명부를 확인해 주세요.', 400);
  }
  const payload = {
    id: result.id,
    participantId: normalizeText(result.participantId),
    displayName: normalizeText(result.displayName),
    challengeId: result.challengeId,
    elapsedMs: result.elapsedMs,
    speed: result.speed,
    errors: result.errors,
    score: result.score,
    completedAt: result.completedAt,
    prizeReceived: false,
    practice: result.practice,
    verificationStatus: 'pending',
    reviewed_at: null,
  };
  return createOnce(db, uid, result.id, 'typing', payload, ownerUid);
}
export const dateString = (value) =>
  value instanceof Timestamp
    ? value.toDate().toISOString()
    : typeof value === 'string'
      ? value
      : '';
export async function allDocuments(db, name) {
  const documents = [];
  let cursor;
  while (true) {
    const page = await withDeadline(
      getDocs(
        query(
          collection(db, name),
          orderBy('__name__'),
          ...(cursor ? [startAfter(cursor)] : []),
          limit(PAGE_SIZE),
        ),
      ),
    );
    documents.push(...page.docs);
    if (page.docs.length < PAGE_SIZE) return documents;
    cursor = page.docs.at(-1);
  }
}
export async function readLetters(db) {
  return (await allDocuments(db, 'letters')).map(decodeLetter);
}
function decodeLetter(snapshot) {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    owner_uid: data.owner_uid,
    nickname: data.nickname,
    content: data.content,
    published_content: data.published_content,
    consent_to_publish: data.consent_to_publish,
    status: data.status,
    publish_order: data.publish_order,
    submission_key: data.submission_key,
    created_at: dateString(data.created_at),
    reviewed_at: data.reviewed_at ? dateString(data.reviewed_at) : null,
    last_history_id: data.last_history_id ?? null,
  };
}
// A cursor is kept in memory by the administrator view, never persisted or sent as JSON.
async function matchingPage(db, name, constraints, decode, accept, cursor, pageSize) {
  const items = [];
  let position = cursor ?? null;
  let boundary = null;
  while (true) {
    const page = await withDeadline(
      getDocs(
        query(
          collection(db, name),
          ...constraints,
          ...(position ? [startAfter(position)] : []),
          limit(pageSize + 1),
        ),
      ),
    );
    for (const snapshot of page.docs) {
      const item = decode(snapshot);
      position = snapshot;
      if (!accept(item)) continue;
      if (items.length === pageSize) return { items, cursor: boundary, hasNext: true };
      items.push(item);
      boundary = snapshot;
    }
    if (page.docs.length < pageSize + 1) return { items, cursor: boundary, hasNext: false };
  }
}
export async function readLettersPage(
  db,
  {
    status = '',
    sort = 'desc',
    query: search = '',
    cursor = null,
    pageSize = 20,
    trash = false,
  } = {},
) {
  const term = normalizeText(search).toLocaleLowerCase();
  const direction = sort === 'asc' ? 'asc' : 'desc';
  return matchingPage(
    db,
    trash ? 'letterTrash' : 'letters',
    [
      ...(status ? [where(trash ? 'letter.status' : 'status', '==', status)] : []),
      orderBy(trash ? 'trashed_at' : 'created_at', direction),
      orderBy('__name__', direction),
    ],
    (snapshot) => {
      if (!trash) return decodeLetter(snapshot);
      const data = snapshot.data();
      return {
        ...decodeLetter({ id: snapshot.id, data: () => data.letter }),
        trashed_at: dateString(data.trashed_at),
        trashed_by: data.trashed_by,
      };
    },
    (item) =>
      !term ||
      `${item.nickname ?? ''} ${item.content} ${item.published_content ?? ''}`
        .toLocaleLowerCase()
        .includes(term),
    cursor,
    Math.max(1, Math.min(100, pageSize)),
  );
}
export async function readTyping(db) {
  return (await allDocuments(db, 'typingResults')).map(decodeTyping);
}
function decodeTyping(snapshot) {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    participantId: data.participantId,
    displayName: data.displayName,
    challengeId: data.challengeId,
    elapsedMs: data.elapsedMs,
    speed: data.speed,
    errors: data.errors,
    score: data.score,
    completedAt: data.completedAt,
    practice: data.practice,
    prizeReceived: data.prizeReceived,
    verificationStatus: data.verificationStatus,
    receivedAt: dateString(data.received_at),
    reviewedAt: data.reviewed_at ? dateString(data.reviewed_at) : null,
  };
}
export async function readTypingPage(
  db,
  {
    version,
    verification = 'all',
    view = 'ranking',
    query: search = '',
    participantIds = [],
    cursor = null,
    pageSize = 25,
  } = {},
) {
  if (!version) return { items: [], cursor: null, hasNext: false };
  const term = normalizeText(search).toLocaleLowerCase();
  const matchingIds = new Set(participantIds);
  const ranking = view !== 'attempts';
  const size = Math.max(1, Math.min(100, pageSize));
  const constraints = [
    where('challengeId', '==', version),
    ...(verification !== 'all' ? [where('verificationStatus', '==', verification)] : []),
    ...(ranking
      ? [
          orderBy('score', 'desc'),
          orderBy('errors'),
          orderBy('elapsedMs'),
          orderBy('completedAt'),
          orderBy('__name__'),
        ]
      : [orderBy('received_at', 'desc'), orderBy('__name__', 'desc')]),
  ];
  let position = cursor?.snapshot ?? null;
  const seen = new Set(cursor?.seen ?? []);
  let count = cursor?.count ?? 0,
    rank = cursor?.rank ?? 0,
    previous = cursor?.previous ?? null;
  const items = [];
  let boundary = null;
  while (true) {
    const page = await withDeadline(
      getDocs(
        query(
          collection(db, 'typingResults'),
          ...constraints,
          ...(position ? [startAfter(position)] : []),
          limit(size + 1),
        ),
      ),
    );
    for (const snapshot of page.docs) {
      position = snapshot;
      const item = decodeTyping(snapshot);
      let itemRank = null;
      if (ranking) {
        if (item.verificationStatus === 'rejected') continue;
        const key = JSON.stringify([
          item.challengeId,
          item.practice === true,
          String(item.participantId).normalize('NFKC').trim(),
        ]);
        if (seen.has(key)) continue;
        seen.add(key);
        count++;
        if (
          !previous ||
          item.score !== previous.score ||
          item.errors !== previous.errors ||
          item.elapsedMs !== previous.elapsedMs
        )
          rank = count;
        previous = { score: item.score, errors: item.errors, elapsedMs: item.elapsedMs };
        itemRank = rank;
      }
      if (
        term &&
        !matchingIds.has(item.participantId) &&
        !`${item.participantId} ${item.displayName}`.toLocaleLowerCase().includes(term)
      )
        continue;
      if (items.length === size) return { items, cursor: boundary, hasNext: true };
      items.push({ ...item, rank: itemRank });
      boundary = { snapshot, seen: ranking ? [...seen] : [], count, rank, previous };
    }
    if (page.docs.length < size + 1) return { items, cursor: boundary, hasNext: false };
  }
}
function letterEdit(input) {
  const { value, error } = validateSubmission({
    nickname: input.nickname ?? '',
    content: input.content,
    consentToPublish: true,
    submissionKey: crypto.randomUUID(),
  });
  if (!value) throw new ClientError(error, 400);
  const published = input.published_content
    ? normalizeText(input.published_content) || null
    : null;
  if (published && unicodeLength(published) > 700)
    throw new ClientError('공개용 본문은 700자 이내입니다.', 400);
  if (
    !['pending', 'approved', 'rejected'].includes(input.status) ||
    (input.publish_order !== null &&
      (!Number.isInteger(input.publish_order) ||
        input.publish_order < 0 ||
        input.publish_order > 1000000))
  )
    throw new ClientError('검수 상태와 공개 순서를 확인해 주세요.', 400);
  return {
    nickname: value.nickname || null,
    content: value.content,
    published_content: published,
    status: input.status,
    publish_order: input.publish_order,
  };
}
function publicLetter(id, data) {
  return {
    id,
    nickname: data.nickname || '익명',
    content: data.published_content || data.content,
    order: data.publish_order,
    sort_order: data.publish_order ?? 1000001,
  };
}
async function letterOperator(db) {
  const context = await adminContext();
  if (context.db !== db)
    throw new ClientError('관리자 연결이 변경되었습니다. 다시 로그인하세요.', 403);
  return context.uid;
}
function writeLetterLog(tx, db, logId, letterId, operatorUid, action, before, after) {
  tx.set(doc(db, 'letterLogs', logId), {
    letter_id: letterId,
    operator_uid: operatorUid,
    action,
    before,
    after,
    created_at: serverTimestamp(),
  });
}
// 생성 요청 재시도에는 같은 creationKey를 사용합니다.
export async function saveLetter(db, uid, id, input, creationKey = crypto.randomUUID()) {
  const operatorUid = await letterOperator(db);
  const data = letterEdit(input);
  const key = id ?? creationKey;
  const logId = crypto.randomUUID();
  if (!UUID_PATTERN.test(key)) throw new ClientError('글 ID가 올바르지 않습니다.', 400);
  await withDeadline(
    runTransaction(db, async (tx) => {
      const ref = doc(db, 'letters', key);
      const previous = await tx.get(ref);
      const trash = await tx.get(doc(db, 'letterTrash', key));
      if (trash.exists())
        throw new ClientError('휴지통에 있는 글입니다. 먼저 복원하세요.', 409);
      if (id && !previous.exists())
        throw new ClientError('이미 삭제된 글입니다. 목록을 새로고침해 주세요.', 404);
      const after = previous.exists()
        ? {
            ...previous.data(),
            ...data,
            reviewed_at: serverTimestamp(),
          }
        : {
            ...data,
            id: key,
            owner_uid: uid,
            submission_key: key,
            consent_to_publish: 1,
            created_at: serverTimestamp(),
            reviewed_at: serverTimestamp(),
          };
      after.last_history_id = logId;
      tx.set(ref, after);
      writeLetterLog(
        tx,
        db,
        logId,
        key,
        operatorUid,
        previous.exists() ? 'edit' : 'create',
        previous.exists() ? previous.data() : null,
        after,
      );
      const publicRef = doc(db, 'publicLetters', key);
      if (data.status === 'approved') tx.set(publicRef, publicLetter(key, data));
      else tx.delete(publicRef);
    }),
  );
  return decodeLetter(await withDeadline(getDoc(doc(db, 'letters', key))));
}
export async function reviewLetter(db, id, patch) {
  if (!UUID_PATTERN.test(id) || !['pending', 'approved', 'rejected'].includes(patch.status))
    throw new ClientError('글과 검수 상태를 확인하세요.', 400);
  const operatorUid = await letterOperator(db);
  const logId = crypto.randomUUID();
  await withDeadline(
    runTransaction(db, async (tx) => {
      const ref = doc(db, 'letters', id);
      const saved = await tx.get(ref);
      if (!saved.exists()) throw new ClientError('글을 찾을 수 없습니다.', 404);
      const before = saved.data();
      const after = {
        ...before,
        status: patch.status,
        reviewed_at: serverTimestamp(),
        last_history_id: logId,
      };
      tx.set(ref, after);
      const publicRef = doc(db, 'publicLetters', id);
      if (after.status === 'approved') tx.set(publicRef, publicLetter(id, after));
      else tx.delete(publicRef);
      writeLetterLog(tx, db, logId, id, operatorUid, 'review', before, after);
    }),
  );
  return decodeLetter(await withDeadline(getDoc(doc(db, 'letters', id))));
}
export async function reviewLetters(db, ids, status) {
  if (!Array.isArray(ids) || ids.length > 100)
    throw new ClientError('한 번에 최대 100건을 선택하세요.', 400);
  let count = 0;
  for (const id of new Set(ids)) {
    try {
      await reviewLetter(db, id, { status });
      count++;
    } catch (error) {
      throw new ClientError(
        `${count}건 처리 후 중단되었습니다. ${error.message}`,
        error.status ?? 500,
      );
    }
  }
  return count;
}
export async function deleteLetter(db, id) {
  if (!UUID_PATTERN.test(id)) throw new ClientError('글 ID를 확인하세요.', 400);
  const uid = await letterOperator(db),
    logId = crypto.randomUUID();
  await withDeadline(
    runTransaction(db, async (tx) => {
      const ref = doc(db, 'letters', id),
        trashRef = doc(db, 'letterTrash', id);
      const [saved, trash] = await Promise.all([tx.get(ref), tx.get(trashRef)]);
      if (!saved.exists()) {
        if (trash.exists()) return;
        throw new ClientError('글을 찾을 수 없습니다.', 404);
      }
      if (trash.exists())
        throw new ClientError('휴지통에 같은 글이 있습니다. 새로고침하세요.', 409);
      tx.set(trashRef, {
        letter: saved.data(),
        trashed_at: serverTimestamp(),
        trashed_by: uid,
        last_history_id: logId,
      });
      tx.delete(ref);
      tx.delete(doc(db, 'publicLetters', id));
      writeLetterLog(tx, db, logId, id, uid, 'trash', saved.data(), null);
    }),
  );
}
export async function restoreLetter(db, id) {
  if (!UUID_PATTERN.test(id)) throw new ClientError('글 ID를 확인하세요.', 400);
  const uid = await letterOperator(db);
  await withDeadline(
    runTransaction(db, async (tx) => {
      const ref = doc(db, 'letters', id),
        trashRef = doc(db, 'letterTrash', id);
      const [saved, trash] = await Promise.all([tx.get(ref), tx.get(trashRef)]);
      if (!trash.exists()) throw new ClientError('휴지통에서 글을 찾을 수 없습니다.', 404);
      if (saved.exists())
        throw new ClientError('같은 글이 이미 복원되었습니다. 새로고침하세요.', 409);
      const before = trash.data().letter,
        logId = `${trash.data().last_history_id}-restore`;
      const after = {
        ...before,
        status: 'pending',
        reviewed_at: serverTimestamp(),
        last_history_id: logId,
      };
      tx.set(ref, after);
      tx.delete(trashRef);
      tx.delete(doc(db, 'publicLetters', id));
      writeLetterLog(tx, db, logId, id, uid, 'restore', before, after);
    }),
  );
}
export async function purgeLetter(db, id) {
  if (!UUID_PATTERN.test(id)) throw new ClientError('글 ID를 확인하세요.', 400);
  const uid = await letterOperator(db);
  await withDeadline(
    runTransaction(db, async (tx) => {
      const ref = doc(db, 'letterTrash', id),
        trash = await tx.get(ref);
      if (!trash.exists()) throw new ClientError('휴지통에서 글을 찾을 수 없습니다.', 404);
      const logId = `${trash.data().last_history_id}-purge`;
      tx.delete(ref);
      writeLetterLog(tx, db, logId, id, uid, 'purge', trash.data().letter, null);
    }),
  );
}
export async function readLetterHistory(db, id, { cursor = null, pageSize = 20 } = {}) {
  if (id !== null && !UUID_PATTERN.test(id)) throw new ClientError('글 ID를 확인하세요.', 400);
  const size = Math.max(1, Math.min(100, pageSize));
  const page = await withDeadline(
    getDocs(
      query(
        collection(db, 'letterLogs'),
        ...(id ? [where('letter_id', '==', id)] : []),
        orderBy('created_at', 'desc'),
        orderBy('__name__', 'desc'),
        ...(cursor ? [startAfter(cursor)] : []),
        limit(size + 1),
      ),
    ),
  );
  return {
    items: page.docs.slice(0, size).map((snapshot) => ({
      ...snapshot.data(),
      id: snapshot.id,
      created_at: dateString(snapshot.data().created_at),
    })),
    cursor: page.docs[Math.min(size, page.docs.length) - 1] ?? null,
    hasNext: page.docs.length > size,
  };
}
export async function synchronizePublicLetters(db) {
  const letters = await readLetters(db);
  let count = 0;
  for (let offset = 0; offset < letters.length; offset += 8) {
    const batch = writeBatch(db);
    for (const letter of letters.slice(offset, offset + 8)) {
      const ref = doc(db, 'publicLetters', letter.id);
      if (letter.status === 'approved' && letter.consent_to_publish === 1) {
        batch.set(ref, publicLetter(letter.id, letter));
        count++;
      } else batch.delete(ref);
    }
    await withDeadline(batch.commit());
  }
  return count;
}
export async function readPublicLetters(db, cursor) {
  const page = await withDeadline(
    getDocs(
      query(
        collection(db, 'publicLetters'),
        orderBy('sort_order'),
        orderBy('__name__'),
        ...(cursor ? [startAfter(cursor)] : []),
        limit(21),
      ),
    ),
  );
  return {
    letters: page.docs.slice(0, 20).map((snapshot) => {
      const data = snapshot.data();
      return {
        id: snapshot.id,
        nickname: data.nickname,
        content: data.content,
        order: data.order,
      };
    }),
    cursor: page.docs[19],
    hasNext: page.docs.length > 20,
  };
}
export async function reviewTyping(db, id, patch) {
  if (!UUID_PATTERN.test(id)) throw new ClientError('기록 ID가 올바르지 않습니다.', 400);
  await withDeadline(
    updateDoc(doc(db, 'typingResults', id), {
      ...patch,
      reviewed_at: serverTimestamp(),
    }),
  );
}
export async function readEvent(db) {
  const snapshot = await withDeadline(getDoc(doc(db, 'settings', 'event')));
  const phase = snapshot.data()?.phase;
  if (!['A', 'B', 'C'].includes(phase))
    throw new ClientError(
      '운영 설정이 준비되지 않았습니다. 운영진에게 문의하세요.',
      503,
      'SETUP_REQUIRED',
    );
  return {
    phase,
    typingEnabled: phase === 'A' && snapshot.data()?.typingEnabled !== false,
    submissionsEnabled: phase === 'A' && snapshot.data()?.submissionsEnabled !== false,
    welcomeEnabled: snapshot.data()?.welcomeEnabled ?? phase === 'C',
    activeChallengeId: snapshot.data()?.activeChallengeId || CHALLENGE.challengeId,
    backend: 'firebase',
  };
}
export async function setEvent(db, phase, options) {
  await withDeadline(
    runTransaction(db, async (tx) => {
      const ref = doc(db, 'challenges', options?.activeChallengeId || CHALLENGE.challengeId);
      const challenge = await tx.get(ref);
      if (!challenge.exists()) {
        if (options?.activeChallengeId && options.activeChallengeId !== CHALLENGE.challengeId)
          throw new ClientError('사용할 대회 문구를 먼저 등록해 주세요.', 400);
        tx.set(ref, {
          text: CHALLENGE.text,
          referenceKeystrokes: CHALLENGE.referenceKeystrokes,
          errorPenalty: CHALLENGE.errorPenalty,
          practice: true,
          enabled: true,
        });
      } else if (challenge.data().enabled !== true || challenge.data().deleted === true) {
        throw new ClientError('사용할 문구의 접수를 먼저 켜 주세요.', 400);
      }
      tx.set(doc(db, 'settings', 'event'), {
        phase,
        ...(options ?? {}),
        updated_at: serverTimestamp(),
      });
    }),
  );
}
export async function readChallenge(db, id) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id))
    throw new ClientError('문구 ID가 올바르지 않습니다.', 400);
  const snapshot = await withDeadline(getDoc(doc(db, 'challenges', id)));
  if (!snapshot.exists())
    throw new ClientError('대회 문구를 찾을 수 없습니다. 문구 설정을 확인해 주세요.', 400);
  const data = snapshot.data();
  return {
    challengeId: id,
    title: data.title || (id === CHALLENGE.challengeId ? CHALLENGE.title : id),
    text: data.text,
    referenceKeystrokes: data.referenceKeystrokes,
    errorPenalty: data.errorPenalty ?? 20, // Older saved challenges used 20 points.
    practice: data.practice,
    enabled: data.enabled,
    deleted: data.deleted === true,
  };
}
export async function readChallenges(db) {
  return (await allDocuments(db, 'challenges')).map((snapshot) => {
    const data = snapshot.data();
    return {
      challengeId: snapshot.id,
      title:
        data.title || (snapshot.id === CHALLENGE.challengeId ? CHALLENGE.title : snapshot.id),
      text: data.text,
      referenceKeystrokes: data.referenceKeystrokes,
      errorPenalty: data.errorPenalty ?? 20, // Older saved challenges used 20 points.
      practice: data.practice,
      enabled: data.enabled,
      deleted: data.deleted === true,
    };
  });
}
export async function saveChallenge(db, input, previous, creationKey = crypto.randomUUID()) {
  const title = normalizeText(input.title);
  const text = normalizeText(input.text).replace(/\s+/g, ' ');
  const errorPenalty = input.errorPenalty;
  if (!title || unicodeLength(title) > 80 || !text || unicodeLength(text) > 1000)
    throw new ClientError('제목은 1~80자, 문구는 1~1,000자로 입력해 주세요.', 400);
  if (!Number.isInteger(errorPenalty) || errorPenalty < 0 || errorPenalty > 100)
    throw new ClientError('오타 감점은 0~100 사이의 정수로 입력해 주세요.', 400);

  // Changing the text, practice mode or penalty creates a new immutable scoring version.
  if (
    previous &&
    previous.text === text &&
    previous.practice === input.practice &&
    previous.errorPenalty === errorPenalty
  ) {
    await withDeadline(updateDoc(doc(db, 'challenges', previous.challengeId), { title }));
    return previous.challengeId;
  }

  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(creationKey))
    throw new ClientError('문구 ID가 올바르지 않습니다.', 400);
  await withDeadline(
    setDoc(doc(db, 'challenges', creationKey), {
      title,
      text,
      practice: input.practice,
      errorPenalty,
      referenceKeystrokes: countKeystrokes(text),
      enabled: previous?.enabled ?? true,
      deleted: false,
    }),
  );
  return creationKey;
}
export async function changeChallenge(db, id, patch) {
  await withDeadline(updateDoc(doc(db, 'challenges', id), patch));
}
export async function saveTyping(db, uid, id, input, creationKey = crypto.randomUUID()) {
  const challenge = await readChallenge(db, input.challengeId);
  const computed = calculateScore(challenge.referenceKeystrokes, input.elapsedMs, input.errors, challenge.errorPenalty);
  const data = {
    ...input,
    ...computed,
    participantId: normalizeText(input.participantId),
    displayName: normalizeText(input.displayName),
    practice: challenge.practice,
    verificationStatus: input.verificationStatus ?? 'pending',
  };
  if (
    !data.participantId ||
    !data.displayName ||
    unicodeLength(data.participantId) > 30 ||
    unicodeLength(data.displayName) > 30 ||
    input.elapsedMs > 3600000 ||
    input.errors > 10000 ||
    (input.prizeReceived && (challenge.practice || data.verificationStatus !== 'verified'))
  )
    throw new ClientError('참가 정보·시간·오타와 상품 수령 조건을 확인해 주세요.', 400);
  const key = id ?? creationKey;
  if (!UUID_PATTERN.test(key)) throw new ClientError('기록 ID가 올바르지 않습니다.', 400);
  const ref = doc(db, 'typingResults', key);
  await withDeadline(
    runTransaction(db, async (tx) => {
      const previous = await tx.get(ref);
      if (id && !previous.exists())
        throw new ClientError('이미 삭제된 기록입니다. 목록을 새로고침해 주세요.', 404);
      tx.set(
        ref,
        previous.exists()
          ? { ...previous.data(), ...data, reviewed_at: serverTimestamp() }
          : {
              ...data,
              id: key,
              owner_uid: uid,
              completedAt: new Date().toISOString(),
              received_at: serverTimestamp(),
              reviewed_at: serverTimestamp(),
            },
      );
    }),
  );
  return key;
}
export async function deleteTyping(db, id) {
  await withDeadline(deleteDoc(doc(db, 'typingResults', id)));
}
export function encodeFirestore(value) {
  if (value instanceof Timestamp)
    return {
      __firestoreTimestamp: true,
      seconds: value.seconds,
      nanoseconds: value.nanoseconds,
    };
  if (Array.isArray(value)) return value.map(encodeFirestore);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, encodeFirestore(item)]),
    );
  return value;
}
export async function createPrivateBackup(db) {
  const collections = {};
  for (const name of [
    'letters',
    'typingResults',
    'receipts',
    'challenges',
    'publicLetters',
    'students',
    'moderationLogs',
    'letterTrash',
    'letterLogs',
  ]) {
    collections[name] = (await allDocuments(db, name)).map((snapshot) => ({
      id: snapshot.id,
      data: encodeFirestore(snapshot.data()),
    }));
  }
  const settings = await Promise.all(
    ['event', 'sessionPolicy'].map((id) => withDeadline(getDoc(doc(db, 'settings', id)))),
  );
  collections.settings = settings
    .filter((snapshot) => snapshot.exists())
    .map((snapshot) => ({ id: snapshot.id, data: encodeFirestore(snapshot.data()) }));
  return {
    schemaVersion: 4,
    includesAuthentication: false,
    backend: 'firebase',
    projectId: db.app.options.projectId,
    exportedAt: new Date().toISOString(),
    collections,
  };
}
export async function exportFirebase(scope, format) {
  const { db } = await adminContext();
  let content;
  if (scope === 'public')
    content = JSON.stringify(makePublicData(await readLetters(db)), null, 2);
  else if (format === 'csv') {
    const letters = await readLetters(db);
    content = toCsv([
      [
        'ID',
        '작성 계정 UID',
        '별명',
        '원문',
        '공개용 본문',
        '공개 동의',
        '검수 상태',
        '공개 순서',
        '접수 키',
        '작성 시각(UTC)',
        '검수 시각(UTC)',
      ],
      ...letters.map((letter) => [
        letter.id,
        letter.owner_uid,
        letter.nickname,
        letter.content,
        letter.published_content,
        letter.consent_to_publish,
        letter.status,
        letter.publish_order,
        letter.submission_key,
        letter.created_at,
        letter.reviewed_at,
      ]),
    ]);
  } else {
    content = JSON.stringify(await createPrivateBackup(db), null, 2);
  }
  return {
    filename: `ohsung-${scope}-${new Date().toISOString().slice(0, 10)}.${format}`,
    content,
    mime: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json',
  };
}
