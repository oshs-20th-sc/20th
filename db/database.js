import { toCsv, validatePublicData } from '../common.js?v=db-schema-5';
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
} from './store.js?v=db-schema-5';
import {
  normalizeText,
  unicodeLength,
  UUID_PATTERN,
  validateParticipant,
  validateSubmission,
} from '../common.js?v=db-schema-5';
import { calculateScore, countKeystrokes } from '../typing/scoring.js?v=db-schema-5';
import { CHALLENGE } from '../typing/challenge.js?v=db-schema-5';
import { ClientError, withDeadline, adminContext } from './firebase.js?v=db-schema-5';
import { readEvent } from './public.js?v=db-schema-5';
import { COLLECTIONS, SCHEMA_VERSION, encodeData } from './schema.js?v=db-schema-5';
export const PAGE_SIZE = 100;
const OFFICIAL_CLAIM_PREFIX = 'official-20261123-';
export { readEvent, readPublicLetters, readPublicLetter } from './public.js?v=db-schema-5';
export async function payloadHash(payload) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}
function receiptConflict(kind) {
  return new ClientError(
    kind === 'typing'
      ? '서버가 타자 기록 접수를 거부했습니다. 같은 학번의 공식 참여 기록이 이미 있거나 문구·점수·접수 규칙과 맞지 않을 수 있습니다. 운영진에게 확인해 주세요.'
      : '행사 접수가 마감되었거나 이미 처리된 요청입니다. 접수 상태를 확인해 주세요.',
    409,
    kind === 'typing' ? 'TYPING_REJECTED' : 'DUPLICATE_OR_CLOSED',
  );
}

async function existingRecordReceipt(db, id, kind, hash, legacyHash = null) {
  const saved = await withDeadline(getDoc(doc(db, kind === 'letter' ? 'letterReceipts' : 'typingReceipts', id)));
  if (!saved.exists()) return null;
  const data = saved.data();
  if (data.entry_mode === 'record' && data.kind === kind &&
      (data.payload_hash === hash || (legacyHash && data.payload_hash === legacyHash)))
    return { id, replayed: true };
  throw new ClientError(
    '동일 접수번호에 다른 내용이 연결되어 있습니다. 원래 내용으로 다시 시도해 주세요.',
    409,
    'KEY_CONFLICT',
  );
}

// E-mode submissions have no student Auth UID. Record, receipt, and an optional
// official-event claim are committed atomically; retries reuse the same UUID.
async function createRecordOnce(
  db,
  id,
  kind,
  payload,
  { claimStudentNumber = null, asAdmin = false } = {},
) {
  if (!UUID_PATTERN.test(id)) throw new ClientError('접수 ID가 올바르지 않습니다.', 400);
  // Recovery changes only the review timestamp, not the original receipt payload.
  const recovery = asAdmin && kind === 'typing';
  const hash = await payloadHash(recovery ? { ...payload, reviewed_at: null } : payload);
  const legacyHash = recovery ? await payloadHash(payload) : null;
  const replay = await existingRecordReceipt(db, id, kind, hash, legacyHash);
  if (replay) return replay;

  const batch = writeBatch(db);
  let savedPayload = payload;
  if (claimStudentNumber) {
    const claimId = `${OFFICIAL_CLAIM_PREFIX}${claimStudentNumber}`;
    const claimRef = doc(db, 'typingEntries', claimId);
    if (asAdmin) {
      const claim = await withDeadline(getDoc(claimRef));
      if (claim.exists()) {
        const previousResult = claim.data().result_id;
        if (previousResult !== id) savedPayload = { ...payload, duplicate_of: previousResult };
      } else {
        batch.set(claimRef, {
          kind: 'typingEntry',
          result_id: id,
          student_number: claimStudentNumber,
          created_at: serverTimestamp(),
        });
      }
    } else {
      batch.set(claimRef, {
        kind: 'typingEntry',
        result_id: id,
        student_number: claimStudentNumber,
        created_at: serverTimestamp(),
      });
    }
  }
  const timestampField = kind === 'letter' ? 'created_at' : 'received_at';
  batch.set(doc(db, kind === 'letter' ? 'letters' : 'typingResults', id), {
    ...savedPayload,
    owner_uid: null,
    [timestampField]: serverTimestamp(),
  });
  batch.set(doc(db, kind === 'letter' ? 'letterReceipts' : 'typingReceipts', id), {
    id,
    owner_uid: null,
    entry_mode: 'record',
    kind,
    payload_hash: hash,
    created_at: serverTimestamp(),
  });
  try {
    await withDeadline(batch.commit());
    return { id, replayed: false };
  } catch (error) {
    // A timed-out/ambiguous acknowledgement may still have committed. Only an
    // exact receipt match is treated as success; otherwise preserve the error.
    const committed = await existingRecordReceipt(db, id, kind, hash, legacyHash).catch(() => null);
    if (committed) return committed;
    if (error?.code === 'permission-denied') throw receiptConflict(kind);
    throw error;
  }
}

export async function submitLetter(db, participant, input) {
  const identity = validateParticipant(participant);
  if (!identity.value) throw new ClientError(identity.error, 400, 'INVALID_PARTICIPANT');
  const { value, error } = validateSubmission({
    ...input,
    studentNumber: identity.value.studentNumber,
    name: identity.value.name,
  });
  if (!value) throw new ClientError(error, 400, 'VALIDATION_FAILED');
  const payload = {
    id: value.submissionKey,
    entry_mode: 'record',
    student_number: value.studentNumber,
    student_name: value.name,
    nickname: value.nickname || null,
    content: value.content,
    published_content: null,
    consent_to_publish: 1,
    status: 'pending',
    publish_order: null,
    submission_key: value.submissionKey,
    reviewed_at: null,
  };
  return createRecordOnce(db, value.submissionKey, 'letter', payload);
}
export function validateTypingResult(input, challenge = CHALLENGE) {
  const entryMode = input?.entry_mode === 'record' || input?.entryMode === 'record';
  if (
    !UUID_PATTERN.test(input.id) ||
    !normalizeText(input.participantId) ||
    !normalizeText(input.displayName) ||
    unicodeLength(input.participantId) > 30 ||
    unicodeLength(input.displayName) > 30 ||
    input.challengeId !== challenge.challengeId ||
    typeof input.practice !== 'boolean' ||
    (!entryMode && input.practice !== challenge.practice) ||
    input.prizeReceived ||
    !Number.isFinite(Date.parse(input.completedAt)) ||
    input.elapsedMs > 3600000
  )
    throw new ClientError('타자 기록의 형식을 확인해 주세요.', 400, 'INVALID_RESULT');
  if (entryMode && !/^[1-3][0-9]{4}$/.test(input.participantId))
    throw new ClientError('학번은 현재 학년을 포함한 숫자 5자리로 입력해 주세요.', 400, 'INVALID_RESULT');
  const computed = calculateScore(
    challenge.referenceKeystrokes,
    input.elapsedMs,
    input.errors,
    entryMode ? 3 : challenge.errorPenalty,
  );
  if (input.speed !== computed.speed || input.score !== computed.score)
    throw new ClientError('타수와 최종 점수 계산이 일치하지 않습니다.', 400, 'INVALID_SCORE');
}

export async function submitTyping(db, participant, result, { asAdmin = false } = {}) {
  if (!asAdmin) {
    const identity = validateParticipant(participant);
    if (!identity.value) throw new ClientError(identity.error, 400, 'INVALID_PARTICIPANT');
    const challenge = await readChallenge(db, result.challengeId);
    const record = {
      id: result.id,
      entry_mode: 'record',
      owner_uid: null,
      participantId: identity.value.studentNumber,
      displayName: identity.value.name,
      challengeId: result.challengeId,
      elapsedMs: result.elapsedMs,
      speed: result.speed,
      errors: result.errors,
      score: result.score,
      completedAt: result.completedAt,
      practice: false,
      prizeReceived: false,
      verificationStatus: 'pending',
      reviewed_at: null,
    };
    validateTypingResult(record, challenge);
    return createRecordOnce(db, record.id, 'typing', record, {
      claimStudentNumber: identity.value.studentNumber,
    });
  }

  if (result.entry_mode === 'record' || result.entryMode === 'record') {
    const challenge = await readChallenge(db, result.challengeId);
    const identity = validateParticipant({
      studentNumber: result.participantId,
      name: result.displayName,
    });
    if (!identity.value) throw new ClientError(identity.error, 400, 'INVALID_RESULT');
    const record = {
      id: result.id,
      entry_mode: 'record',
      owner_uid: null,
      participantId: identity.value.studentNumber,
      displayName: identity.value.name,
      challengeId: result.challengeId,
      elapsedMs: result.elapsedMs,
      speed: result.speed,
      errors: result.errors,
      score: result.score,
      completedAt: result.completedAt,
      practice: result.practice,
      prizeReceived: false,
      verificationStatus: 'pending',
      reviewed_at: serverTimestamp(),
    };
    validateTypingResult(record, challenge);
    return createRecordOnce(db, record.id, 'typing', record, {
      claimStudentNumber: record.practice ? null : identity.value.studentNumber,
      asAdmin: true,
    });
  }
  const challenge = await readChallenge(db, result.challengeId);
  validateTypingResult(result, challenge);
  const ownerUid = result.owner_uid || result.participantId;
  if (!/^(?:[A-Za-z0-9_-]{20}|[0-9]{7})$/.test(ownerUid) || result.participantId !== ownerUid)
    throw new ClientError('복구할 기록의 원래 참가 정보가 일치하지 않습니다.', 400);
  // Preserve the historical receipt field order/hash for acknowledged UID backups.
  const payload = {
    id: result.id,
    participantId: result.participantId,
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
  const hash = await payloadHash(payload);
  return withDeadline(runTransaction(db, async (tx) => {
    const receiptRef = doc(db, 'typingReceipts', result.id);
    const receipt = await tx.get(receiptRef);
    if (receipt.exists()) {
      if (receipt.data().kind !== 'typing' || receipt.data().payload_hash !== hash)
        throw new ClientError('같은 접수번호에 다른 기록이 있습니다.', 409, 'KEY_CONFLICT');
      return { id: result.id, replayed: true };
    }
    tx.set(receiptRef, { id: result.id, owner_uid: ownerUid, kind: 'typing',
      payload_hash: hash, created_at: serverTimestamp() });
    tx.set(doc(db, 'typingResults', result.id), {
      ...payload, owner_uid: ownerUid, received_at: serverTimestamp(),
    });
    return { id: result.id, replayed: false };
  }));
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
export async function readLetter(db, id) {
  if (!UUID_PATTERN.test(id)) throw new ClientError('글 ID를 확인하세요.', 400);
  const saved = await withDeadline(getDoc(doc(db, 'letters', id)));
  return saved.exists() ? decodeLetter(saved) : null;
}
function decodeLetter(snapshot) {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    entry_mode: data.entry_mode ?? null,
    student_number: data.student_number ?? null,
    student_name: data.student_name ?? null,
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
      `${item.student_number ?? ''} ${item.student_name ?? ''} ${item.nickname ?? ''} ${item.content} ${item.published_content ?? ''}`
        .toLocaleLowerCase()
        .includes(term),
    cursor,
    Math.max(1, Math.min(100, pageSize)),
  );
}
export async function readTyping(db) {
  return (await allDocuments(db, 'typingResults')).map(decodeTyping);
}
export async function readTypingResult(db, id) {
  if (!UUID_PATTERN.test(id)) throw new ClientError('기록 ID를 확인하세요.', 400);
  const saved = await withDeadline(getDoc(doc(db, 'typingResults', id)));
  return saved.exists() ? decodeTyping(saved) : null;
}
function decodeTyping(snapshot) {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    entryMode: data.entry_mode ?? null,
    duplicateOf: data.duplicate_of ?? null,
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
  if (!version && view !== 'attempts') return { items: [], cursor: null, hasNext: false };
  const term = normalizeText(search).toLocaleLowerCase();
  const matchingIds = new Set(participantIds);
  const ranking = view !== 'attempts';
  const size = Math.max(1, Math.min(100, pageSize));
  const constraints = [
    ...(version ? [where('challengeId', '==', version)] : []),
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
  if (published && new TextEncoder().encode(published).byteLength > 131072)
    throw new ClientError('공개용 본문이 저장 가능한 크기를 넘었습니다.', 400);
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
  await reviewLetterStatus(db, id, patch, await letterOperator(db));
  return decodeLetter(await withDeadline(getDoc(doc(db, 'letters', id))));
}
async function reviewLetterStatus(db, id, patch, operatorUid) {
  if (!UUID_PATTERN.test(id) || !['pending', 'approved', 'rejected'].includes(patch.status))
    throw new ClientError('글과 검수 상태를 확인하세요.', 400);
  const logId = crypto.randomUUID();
  return withDeadline(
    runTransaction(db, async (tx) => {
      const ref = doc(db, 'letters', id);
      const saved = await tx.get(ref);
      if (!saved.exists()) throw new ClientError('글을 찾을 수 없습니다.', 404);
      const before = saved.data();
      if (before.status === patch.status) return false;
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
      return true;
    }),
  );
}
export async function reviewLetters(db, ids, status) {
  if (!Array.isArray(ids) || ids.length > 100)
    throw new ClientError('한 번에 최대 100건을 선택하세요.', 400);
  let count = 0;
  const operatorUid = await letterOperator(db);
  for (const id of new Set(ids)) {
    try {
      if (await reviewLetterStatus(db, id, { status }, operatorUid)) count++;
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
  const [letters, published] = await Promise.all([
    readLetters(db),
    allDocuments(db, 'publicLetters'),
  ]);
  const expected = new Map(
    letters
      .filter((letter) => letter.status === 'approved' && letter.consent_to_publish === 1)
      .map((letter) => [letter.id, publicLetter(letter.id, letter)]),
  );
  const existing = new Map(published.map((snapshot) => [snapshot.id, snapshot.data()]));
  const changes = [];
  for (const [id, value] of expected) {
    const saved = existing.get(id);
    if (
      !saved ||
      Object.keys(saved).length !== Object.keys(value).length ||
      Object.entries(value).some(([key, item]) => saved[key] !== item)
    )
      changes.push([id, value]);
  }
  for (const id of existing.keys()) if (!expected.has(id)) changes.push([id, null]);
  // 작은 배치로 기존 보안 규칙의 문서 접근 한도를 지킵니다.
  for (let offset = 0; offset < changes.length; offset += 8) {
    const batch = writeBatch(db);
    for (const [id, value] of changes.slice(offset, offset + 8)) {
      const ref = doc(db, 'publicLetters', id);
      if (value) batch.set(ref, value);
      else batch.delete(ref);
    }
    await withDeadline(batch.commit());
  }
  return changes.length;
}
// Recorded scores, timing and participant identity cannot be edited after submission.
export async function reviewTyping(db, id, patch) {
  if (!UUID_PATTERN.test(id)) throw new ClientError('기록 ID가 올바르지 않습니다.', 400);
  if (!patch || typeof patch !== 'object' || !Object.keys(patch).length ||
      Object.keys(patch).some((key) => !['verificationStatus', 'prizeReceived'].includes(key)) ||
      ('verificationStatus' in patch && !['pending', 'verified', 'rejected'].includes(patch.verificationStatus)) ||
      ('prizeReceived' in patch && typeof patch.prizeReceived !== 'boolean'))
    throw new ClientError('검수·상품 수령 상태만 변경할 수 있습니다.', 400);
  await withDeadline(runTransaction(db, async (tx) => {
    const ref = doc(db, 'typingResults', id);
    const saved = await tx.get(ref);
    if (!saved.exists()) throw new ClientError('이미 삭제된 기록입니다.', 404);
    const before = saved.data();
    const after = { ...patch };
    if ('verificationStatus' in patch && patch.verificationStatus !== 'verified') after.prizeReceived = false;
    if ((after.prizeReceived ?? before.prizeReceived) &&
        (before.practice || (after.verificationStatus ?? before.verificationStatus) !== 'verified'))
      throw new ClientError('확인된 공식 기록만 상품 수령을 표시할 수 있습니다.', 400);
    if (Object.entries(after).every(([key, value]) => before[key] === value)) return;
    tx.update(ref, { ...after, reviewed_at: serverTimestamp() });
  }));
}
export const DEFAULT_SESSION_POLICY = { boothMode: true, idleMinutes: 10 };
export async function readSessionPolicy(db) {
  const saved = await withDeadline(getDoc(doc(db, 'settings', 'sessionPolicy')));
  return saved.exists() ? saved.data() : { ...DEFAULT_SESSION_POLICY };
}
export async function saveSessionPolicy(db, value) {
  const idleMinutes = Number(value.idleMinutes);
  if (!Number.isInteger(idleMinutes) || idleMinutes < 1 || idleMinutes > 120)
    throw new ClientError('미사용 시간은 1~120분으로 입력하세요.', 400);
  await withDeadline(setDoc(doc(db, 'settings', 'sessionPolicy'), {
    boothMode: value.boothMode === true, idleMinutes, updated_at: serverTimestamp(),
  }));
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
          practice: false,
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
// Selecting a typing passage does not open/close writing or public letters.
export async function selectChallenge(db, id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))
    throw new ClientError('문구 ID가 올바르지 않습니다.', 400);
  await withDeadline(runTransaction(db, async (tx) => {
    const eventRef = doc(db, 'settings', 'event');
    const challengeRef = doc(db, 'challenges', id);
    const [event, challenge] = await Promise.all([tx.get(eventRef), tx.get(challengeRef)]);
    if (!challenge.exists() || challenge.data().deleted === true)
      throw new ClientError('사용할 문구를 찾을 수 없습니다.', 404);
    if (!challenge.data().enabled) tx.update(challengeRef, { enabled: true });
    tx.set(eventRef, {
      ...(event.exists() ? event.data() : { phase: 'A' }),
      activeChallengeId: id,
      updated_at: serverTimestamp(),
    });
  }));
}
export async function readChallenge(db, id) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id))
    throw new ClientError('문구 ID가 올바르지 않습니다.', 400);
  const snapshot = await withDeadline(getDoc(doc(db, 'challenges', id)));
  if (!snapshot.exists())
    throw new ClientError('대회 문구를 찾을 수 없습니다. 문구 설정을 확인해 주세요.', 400);
  return decodeChallenge(snapshot);
}
export async function readChallenges(db) {
  return (await allDocuments(db, 'challenges')).map(decodeChallenge);
}
function decodeChallenge(snapshot) {
  const data = snapshot.data();
  const errorPenalty = Object.hasOwn(data, 'errorPenalty') ? data.errorPenalty : 3;
  if (!Number.isInteger(errorPenalty) || errorPenalty < 0 || errorPenalty > 100)
    throw new ClientError('문구의 오타 감점은 0~100 사이의 정수여야 합니다.', 400);
  return {
    challengeId: snapshot.id,
    title:
      data.title || (snapshot.id === CHALLENGE.challengeId ? CHALLENGE.title : snapshot.id),
    text: data.text,
    referenceKeystrokes: data.referenceKeystrokes,
    errorPenalty,
    practice: data.practice,
    enabled: data.enabled,
    deleted: data.deleted === true,
  };
}
export async function saveChallenge(db, input, previous, creationKey) {
  const title = normalizeText(input.title);
  const text = normalizeText(input.text).replace(/\s+/g, ' ');
  const errorPenalty =
    input.errorPenalty === undefined
      ? previous
        ? (previous.errorPenalty ?? 20)
        : 3
      : input.errorPenalty;
  if (!title || unicodeLength(title) > 80 || !text || unicodeLength(text) > 1000)
    throw new ClientError('제목은 1~80자, 문구는 1~1,000자로 입력해 주세요.', 400);
  if (!Number.isInteger(errorPenalty) || errorPenalty < 0 || errorPenalty > 100)
    throw new ClientError('오타 감점은 0~100 사이의 정수로 입력해 주세요.', 400);
  if (typeof input.practice !== 'boolean')
    throw new ClientError('연습 여부를 확인해 주세요.', 400);
  const id = previous ? previous.challengeId : (creationKey ?? crypto.randomUUID());
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id))
    throw new ClientError('문구 ID가 올바르지 않습니다.', 400);
  const data = {
    title,
    text,
    practice: input.practice,
    errorPenalty,
    referenceKeystrokes: countKeystrokes(text),
  };
  const ref = doc(db, 'challenges', id);
  await withDeadline(
    previous ? updateDoc(ref, data) : setDoc(ref, { ...data, enabled: true, deleted: false }),
  );
  return id;
}
export async function changeChallenge(db, id, patch) {
  await withDeadline(updateDoc(doc(db, 'challenges', id), patch));
}
export async function deleteChallenge(db, id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))
    throw new ClientError('문구 ID를 확인하세요.', 400);
  await withDeadline(deleteDoc(doc(db, 'challenges', id)));
}
export async function deleteTyping(db, id) {
  if (!UUID_PATTERN.test(id ?? '')) throw new ClientError('기록 ID가 올바르지 않습니다.', 400);
  try {
    return await withDeadline(runTransaction(db, async (tx) => {
      const resultRef = doc(db, 'typingResults', id);
      const receiptRef = doc(db, 'typingReceipts', id);
      const [result, receipt] = await Promise.all([tx.get(resultRef), tx.get(receiptRef)]);
      if (!result.exists()) return { id, deleted: false, replayed: true };

      const data = result.data();
      const officialRecord = data.entry_mode === 'record' && data.practice === false;
      const typingReceipt = receipt.exists() && receipt.data().kind === 'typing' &&
        (data.entry_mode !== 'record' || receipt.data().entry_mode === 'record');
      if (data.entry_mode === 'record' && receipt.exists() && !typingReceipt)
        throw new ClientError('기록 접수 정보가 일치하지 않아 삭제하지 않았습니다.', 409, 'RECEIPT_MISMATCH');

      let claimRef = null;
      let claim = null;
      if (officialRecord && /^[1-3][0-9]{4}$/.test(data.participantId ?? '')) {
        claimRef = doc(db, 'typingEntries', `${OFFICIAL_CLAIM_PREFIX}${data.participantId}`);
        claim = await tx.get(claimRef);
      }

      tx.delete(resultRef);
      if (typingReceipt) tx.delete(receiptRef);
      const claimData = claim?.exists() ? claim.data() : null;
      const releasedParticipation = !!claimData && claimData.kind === 'typingEntry' &&
        claimData.student_number === data.participantId && claimData.result_id === id;
      if (releasedParticipation) tx.delete(claimRef);
      return { id, deleted: true, releasedParticipation };
    }));
  } catch (error) {
    if (error?.code === 'permission-denied')
      throw new ClientError(
        '기록 삭제가 거부되었습니다. 서버 삭제 규칙이 아직 적용되지 않았거나 관리자 권한이 부족할 수 있습니다. 기록은 삭제되지 않았습니다.',
        403,
        'TYPING_DELETE_REJECTED',
      );
    throw error;
  }
}

// An administrator can repair only a claim whose exact referenced result is
// already absent. The claim and any matching UUID receipt are removed together.
export async function releaseOrphanedTypingClaim(db, studentNumber, expectedResultId) {
  if (!/^[1-3][0-9]{4}$/.test(studentNumber ?? '') || !UUID_PATTERN.test(expectedResultId ?? ''))
    throw new ClientError('참가 학번 또는 기록 ID를 확인하세요.', 400);
  return withDeadline(runTransaction(db, async (tx) => {
    const claimRef = doc(db, 'typingEntries', `${OFFICIAL_CLAIM_PREFIX}${studentNumber}`);
    const resultRef = doc(db, 'typingResults', expectedResultId);
    const receiptRef = doc(db, 'typingReceipts', expectedResultId);
    const [claim, result, receipt] = await Promise.all([
      tx.get(claimRef), tx.get(resultRef), tx.get(receiptRef),
    ]);
    if (!claim.exists()) return { released: false, reason: 'claim_missing' };
    const data = claim.data();
    if (data.kind !== 'typingEntry' || data.student_number !== studentNumber ||
        data.result_id !== expectedResultId)
      return { released: false, reason: 'claim_changed' };
    if (result.exists()) return { released: false, reason: 'result_exists' };
    if (receipt.exists() && (receipt.data().entry_mode !== 'record' || receipt.data().kind !== 'typing'))
      return { released: false, reason: 'receipt_mismatch' };

    tx.delete(claimRef);
    if (receipt.exists()) tx.delete(receiptRef);
    return { released: true, resultId: expectedResultId };
  }));
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
  for (const name of Object.keys(COLLECTIONS).filter(name => name !== 'settings')) {
    collections[name] = (await allDocuments(db, name)).map(snapshot => ({
      id: snapshot.id,
      data: encodeFirestore(encodeData(name, snapshot.data())),
    }));
  }
  const settings = await Promise.all(
    ['event', 'sessionPolicy'].map(id => withDeadline(getDoc(doc(db, 'settings', id)))),
  );
  collections.settings = settings.filter(snapshot => snapshot.exists()).map(snapshot => ({
    id: snapshot.id, data: encodeFirestore(encodeData('settings', snapshot.data())),
  }));
  return {schemaVersion: SCHEMA_VERSION, includesAuthentication: false, backend: 'firebase',
    projectId: db.app.options.projectId, exportedAt: new Date().toISOString(), collections};
}

export async function exportFirebase(scope, format) {
  if (!(
    (scope === 'public' && format === 'json') ||
    (scope === 'all' && ['json', 'csv'].includes(format))
  ))
    throw new ClientError('내보내기 형식을 확인하세요.', 400);
  const { db } = await adminContext();
  let content;
  if (scope === 'public') {
    const letters = (await allDocuments(db, 'publicLetters'))
      .map((snapshot) => {
        const data = snapshot.data();
        return {
          id: snapshot.id,
          nickname: data.nickname,
          content: data.content,
          order: data.order,
        };
      })
      .sort((a, b) => (a.order ?? 1000001) - (b.order ?? 1000001) || a.id.localeCompare(b.id));
    const data = { schemaVersion: 1, publishedAt: new Date().toISOString(), letters };
    if (!validatePublicData(data))
      throw new ClientError(
        '공개 글의 형식을 확인하세요. 공개 내용 동기화 후 다시 내려받으세요.',
        400,
      );
    content = JSON.stringify(data, null, 2);
  } else if (format === 'csv') {
    const letters = await readLetters(db);
    content = toCsv([
      [
        'ID',
        '작성 계정 UID',
        '학번',
        '작성자 이름',
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
        letter.student_number,
        letter.student_name,
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
    filename:
      scope === 'public'
        ? 'letters.json'
        : `ohsung-${scope}-${new Date().toISOString().slice(0, 10)}.${format}`,
    content,
    mime: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json',
  };
}
