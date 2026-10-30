import { randomBytes, randomUUID } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineString } from 'firebase-functions/params';

initializeApp();
const region = defineString('STUDENT_FUNCTION_REGION', { default: 'asia-northeast3' });

// 비밀번호는 응답에서 한 번만 반환하며, Firestore·로그·환경 변수에 저장하지 않습니다.
export const resetStudentPassword = onCall(
  {
    region,
    memory: '256MiB',
    minInstances: 0,
    maxInstances: 2,
    concurrency: 20,
    timeoutSeconds: 30,
  },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', '관리자 로그인이 필요합니다.');
    const data = request.data;
    if (
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      Object.keys(data).some((key) => !['studentId', 'reason'].includes(key)) ||
      typeof data.studentId !== 'string' ||
      !/^[A-Za-z0-9_-]{20}$/.test(data.studentId) ||
      typeof data.reason !== 'string' ||
      !data.reason.trim() ||
      Array.from(data.reason.trim()).length > 500
    )
      throw new HttpsError('invalid-argument', '학번과 재발급 사유를 확인하세요.');
    const db = getFirestore();
    const auth = getAuth();
    const operatorUid = request.auth.uid;
    const studentId = data.studentId;
    const reason = data.reason.trim();
    const operator = await db.doc(`admins/${operatorUid}`).get();
    if (operator.data()?.enabled !== true)
      throw new HttpsError('permission-denied', '관리자 권한이 필요합니다.');
    const [target, targetRole] = await Promise.all([
      db.doc(`students/${studentId}`).get(),
      db.doc(`admins/${studentId}`).get(),
    ]);
    if (
      !target.exists ||
      target.data().student_id !== studentId ||
      targetRole.data()?.enabled === true
    )
      throw new HttpsError('failed-precondition', '등록된 학생 계정만 재발급할 수 있습니다.');
    const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
    if (!projectId)
      throw new HttpsError('failed-precondition', '서버 프로젝트 설정을 확인하세요.');
    const account = await auth.getUser(studentId).catch(() => null);
    const loginId = target.data().login_id;
    if (
      !account ||
      (loginId != null && !/^[1-3][0-9]{4}$/.test(loginId)) ||
      account.email !== `${loginId || studentId.toLowerCase()}@students.${projectId}.invalid`
    )
      throw new HttpsError('failed-precondition', '학생 Auth 계정과 명부가 일치하지 않습니다.');
    const operationId = randomUUID();
    const lock = db.doc(`_studentPasswordResets/${studentId}`);
    const log = db.doc(`moderationLogs/${operationId}`);
    const now = Date.now();
    await db.runTransaction(async (tx) => {
      const previous = await tx.get(lock);
      if (previous.data()?.locked_until?.toMillis() > now)
        throw new HttpsError(
          'resource-exhausted',
          '재발급 요청을 처리 중입니다. 잠시 후 다시 시도하세요.',
        );
      tx.set(lock, {
        operation_id: operationId,
        operator_uid: operatorUid,
        reason,
        status: 'requested',
        locked_until: Timestamp.fromMillis(now + 60000),
        updated_at: FieldValue.serverTimestamp(),
      });
    });
    const password = randomBytes(18).toString('base64url');
    let changed = false;
    try {
      // 작업 직전에도 운영자 권한과 대상 학생 문서를 다시 확인합니다.
      const [currentRole, currentStudent, currentTargetRole] = await Promise.all([
        db.doc(`admins/${operatorUid}`).get(),
        db.doc(`students/${studentId}`).get(),
        db.doc(`admins/${studentId}`).get(),
      ]);
      if (
        currentRole.data()?.enabled !== true ||
        currentStudent.data()?.student_id !== studentId ||
        currentTargetRole.data()?.enabled === true
      )
        throw new HttpsError(
          'permission-denied',
          '관리자 권한 또는 학생 정보를 다시 확인하세요.',
        );
      await auth.updateUser(studentId, { password });
      changed = true;
      await auth.revokeRefreshTokens(studentId);
      const batch = db.batch();
      batch.create(log, {
        target_student_id: studentId,
        action: 'reset_password',
        reason,
        operator_uid: operatorUid,
        related_letter_id: null,
        created_at: FieldValue.serverTimestamp(),
      });
      batch.update(lock, {
        status: 'completed',
        locked_until: Timestamp.fromMillis(Date.now() + 30000),
        updated_at: FieldValue.serverTimestamp(),
      });
      await batch.commit();
      return { password };
    } catch (error) {
      // Auth와 Firestore 사이의 부분 실패 상태만 남기고 비밀번호는 기록하지 않습니다.
      await lock
        .update({
          status: changed ? 'password_changed_audit_pending' : 'failed',
          locked_until: Timestamp.fromMillis(Date.now() + 30000),
          updated_at: FieldValue.serverTimestamp(),
        })
        .catch(() => {});
      if (error instanceof HttpsError) throw error;
      throw new HttpsError(
        'internal',
        changed
          ? '변경 결과 기록을 확인하지 못했습니다. 잠시 후 새 비밀번호를 다시 재발급하세요.'
          : '비밀번호를 재발급하지 못했습니다. 잠시 후 다시 시도하세요.',
      );
    }
  },
);
