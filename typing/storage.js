import { adminContext, getPublicDb, firebaseError } from '../db/firebase.js';
import { submitTyping, readChallenge, validateTypingResult } from '../db/database.js';

import { toCsv, validateParticipant } from '../common.js';
import { rankResults, rankedAttempts } from './scoring.js';

// Legacy storage identifier is intentionally stable so existing local records survive rebranding.
const DB_NAME = 'osung-typing';
const STORE = 'results';

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB)
      return reject(new Error('이 브라우저에서는 IndexedDB를 사용할 수 없습니다.'));
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new Error('기록 저장소를 열지 못했습니다. 브라우저 저장 공간을 확인해 주세요.'));
    request.onblocked = () => reject(new Error('다른 탭을 닫고 다시 시도해 주세요.'));
  });
}

export async function saveLocalResult(result) {
  const db = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(result);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () =>
        reject(
          new Error('기록을 저장하지 못했습니다. 결과를 내려받고 운영진에게 알려 주세요.'),
        );
    });
  } finally {
    db.close();
  }
}

export async function listLocalResults() {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).getAll();
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(new Error('참가 기록을 읽지 못했습니다.'));
    });
  } finally {
    db.close();
  }
}

async function removeLocalResult(id) {
  const db = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(new Error('기기 기록 정리에 실패했습니다.'));
    });
  } finally {
    db.close();
  }
}

export function resultsCsv(results, { rankedOnly = true, includeRank = true } = {}) {
  const records = includeRank
    ? rankedOnly
      ? rankResults(results)
      : rankedAttempts(results)
    : [...results].sort((a, b) =>
        (b.receivedAt || b.completedAt).localeCompare(a.receivedAt || a.completedAt),
      );
  return toCsv([
    [
      '순위',
      '학번',
      '이름',
      '문구',
      '소요 시간(ms)',
      '타수',
      '오타',
      '점수',
      '완료 시각(UTC)',
      '상품 수령',
      '연습 기록',
      '운영진 확인',
      '참가 방식',
      '중복 원본 기록',
    ],
    ...records.map((r) => [
      includeRank ? r.rank : null,
      r.loginId || (/^[1-3][0-9]{4}$/.test(r.participantId) ? r.participantId : '미연결'),
      r.displayName,
      r.challengeId,
      r.elapsedMs,
      r.speed,
      r.errors,
      r.score,
      r.completedAt,
      r.prizeReceived ? '수령' : '미수령',
      r.practice ? '연습' : '공식',
      r.verificationStatus ?? 'pending',
      r.entryMode === 'record' || r.entry_mode === 'record' ? '학번·이름 입력' : '기존 계정',
      r.duplicateOf || r.duplicate_of || '',
    ]),
  ]);
}

// 서버 접수 전에는 로컬 기록을 전송 대기 상태로 유지합니다.

export async function saveResult(result, asAdmin = false) {
  let backupSaved = true;
  const queued = { ...result, syncState: 'pending' };
  try {
    await saveLocalResult(queued);
  } catch {
    backupSaved = false;
  }
  try {
    let context, participant;
    if (asAdmin) {
      context = await adminContext();
      participant = context.uid;
    }
    else {
      const checked = validateParticipant({ studentNumber: result.participantId, name: result.displayName });
      if (!checked.value || result.entry_mode !== 'record' || result.owner_uid !== null)
        throw new Error('참가 정보가 올바르지 않습니다. 기존 계정의 미전송 기록은 관리자에게 복구를 요청하세요.');
      context = { db: await getPublicDb() };
      participant = checked.value;
    }
    await submitTyping(context.db, participant, result, { asAdmin });
    try {
      // 서버가 확인한 새 참가 기록은 기기에 남기지 않습니다. 실패 기록과 과거 보관함은 유지합니다.
      if (queued.entry_mode === 'record') await removeLocalResult(queued.id);
      else await saveLocalResult({ ...queued, syncState: 'synced', syncError: '' });
      backupSaved = true;
    } catch {
      backupSaved = false;
    }
    return { synced: true, backupSaved };
  } catch (error) {
    try {
      await saveLocalResult({ ...queued, syncError: firebaseError(error).message });
      backupSaved = true;
    } catch {
      /* Result remains in the active UI for emergency download. */
    }
    throw Object.assign(firebaseError(error), { backupSaved });
  }
}
export async function importResultFile(input) {
  const { db } = await adminContext();
  if (
    !input ||
    input.schemaVersion !== 1 ||
    !Array.isArray(input.results) ||
    !input.results.length ||
    input.results.length > 10000
  )
    throw new Error('타자 기록 파일의 형식을 확인하세요.');
  if (input.projectId && input.projectId !== db.app.options.projectId)
    throw new Error('다른 프로젝트의 기록 파일입니다.');
  const challenges = new Map();
  const ids = new Set();
  const records = [];
  for (const item of input.results) {
    if (!item || typeof item !== 'object' || ids.has(item.id) || item.errors > 10000)
      throw new Error('중복되거나 올바르지 않은 기록입니다.');
    ids.add(item.id);
    if (
      item.owner_uid &&
      (!/^(?:[A-Za-z0-9_-]{20}|[0-9]{7})$/.test(item.owner_uid) ||
        item.participantId !== item.owner_uid)
    )
      throw new Error('원래 작성 계정이 다른 기록입니다.');
    if (!challenges.has(item.challengeId))
      challenges.set(item.challengeId, await readChallenge(db, item.challengeId));
    const record = { ...item, prizeReceived: false, syncState: 'pending' };
    validateTypingResult(record, challenges.get(item.challengeId));
    records.push(record);
  }
  // 입력 전체를 검사한 뒤 기기 보관함에 추가합니다. 서버 접수는 별도 작업입니다.
  for (const record of records) await saveLocalResult(record);
  return records.length;
}

export async function pendingResults() {
  return (await listLocalResults()).filter((result) => result.syncState !== 'synced');
}
export async function synchronizePending() {
  await adminContext();
  const pending = await pendingResults();
  let synced = 0;
  let error = '';
  for (const result of pending) {
    try {
      await saveResult({ ...result, prizeReceived: false }, true);
      synced++;
    } catch (reason) {
      error = firebaseError(reason).message;
      break;
    }
  }
  return { synced, remaining: (await pendingResults()).length, error };
}
