// 공개 페이지는 관리자 CRUD·타자 채점 모듈을 불러오지 않습니다.
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
} from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';
import { UUID_PATTERN } from '../common.js';
import { CHALLENGE } from '../typing/challenge.js';
import { ClientError, withDeadline } from './firebase.js';

function publicLetter(snapshot) {
  const data = snapshot.data();
  return { id: snapshot.id, nickname: data.nickname, content: data.content, order: data.order };
}

export async function readPublicLetters(db, cursor) {
  const page = await withDeadline(
    getDocs(
      query(
        collection(db, 'publicLetters'),
        orderBy('sort_order'),
        orderBy('__name__'),
        ...(cursor ? [startAfter(cursor.sortOrder, cursor.id)] : []),
        limit(21),
      ),
    ),
  );
  const last = page.docs[Math.min(20, page.docs.length) - 1];
  return {
    letters: page.docs.slice(0, 20).map(publicLetter),
    cursor: last ? { sortOrder: last.data().sort_order, id: last.id } : null,
    hasNext: page.docs.length > 20,
  };
}

export async function readPublicLetter(db, id) {
  if (typeof id !== 'string' || !UUID_PATTERN.test(id))
    throw new ClientError('글 주소를 확인해 주세요.', 400);
  const saved = await withDeadline(getDoc(doc(db, 'publicLetters', id)));
  return saved.exists() ? publicLetter(saved) : null;
}

export async function readEvent(db) {
  const snapshot = await withDeadline(getDoc(doc(db, 'settings', 'event')));
  const data = snapshot.data();
  const phase = data?.phase;
  if (!['A', 'B', 'C'].includes(phase))
    throw new ClientError(
      '운영 설정이 준비되지 않았습니다. 운영진에게 문의하세요.',
      503,
      'SETUP_REQUIRED',
    );
  return {
    phase,
    typingEnabled: phase === 'A' && data.typingEnabled !== false,
    submissionsEnabled: phase === 'A' && data.submissionsEnabled !== false,
    welcomeEnabled: data.welcomeEnabled ?? phase === 'C',
    activeChallengeId: data.activeChallengeId || CHALLENGE.challengeId,
    updatedAt: data.updated_at?.toDate().toISOString() ?? null,
    backend: 'firebase',
  };
}
