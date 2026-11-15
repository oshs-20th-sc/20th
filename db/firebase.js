import {
  deleteApp,
  initializeApp,
} from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js';
import {
  connectFirestoreEmulator,
  getFirestore,
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
  onSnapshot,
} from './store.js?v=typing-certificate-1';
export class ClientError extends Error {
  constructor(message, status = 0, code = 'UNKNOWN') {
    super(message);
    this.name = 'ClientError';
    this.status = status;
    this.code = code;
  }
}
export function firebaseError(error) {
  if (error instanceof ClientError) return error;
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
  if (
    code.includes('invalid-credential') ||
    code.includes('wrong-password') ||
    code.includes('user-disabled') ||
    code.includes('user-not-found')
  )
    return new ClientError(
      '아이디 또는 비밀번호를 확인해 주세요. 등록 문의는 운영진에게 해 주세요.',
      401,
      code,
    );
  if (code.includes('too-many-requests'))
    return new ClientError('로그인 요청이 많습니다. 잠시 후 다시 시도해 주세요.', 429, code);
  if (code.includes('weak-password') || code.includes('password-does-not-meet-requirements'))
    return new ClientError(
      '새 비밀번호가 보안 요구사항을 충족하지 않습니다. 더 긴 비밀번호를 사용해 주세요.',
      400,
      code,
    );
  if (code.includes('email-already-in-use'))
    return new ClientError(
      '이미 사용 중인 이메일입니다. 다른 이메일을 사용하거나 기존 계정 UID로 권한을 추가해 주세요.',
      409,
      code,
    );
  if (code.includes('invalid-email'))
    return new ClientError('이메일 형식을 확인해 주세요.', 400, code);
  if (code.includes('requires-recent-login'))
    return new ClientError('다시 로그인한 뒤 계정 변경을 시도해 주세요.', 401, code);
  if (code.includes('expired-action-code') || code.includes('invalid-action-code'))
    return new ClientError(
      '만료되었거나 이미 사용한 링크입니다. 새 메일을 요청하세요.',
      400,
      code,
    );
  if (code.includes('permission-denied'))
    return new ClientError(
      '저장 권한, 행사 운영 상태 또는 요청 제한을 확인해 주세요. 입력 내용은 유지됩니다.',
      403,
      code,
    );
  if (code.includes('operation-not-allowed'))
    return new ClientError(
      '로그인 서비스가 준비되지 않았습니다. 운영진에게 문의하세요.',
      503,
      code,
    );
  if (code.includes('unavailable') || code.includes('network') || code.includes('deadline'))
    return new ClientError('서버에 연결하지 못했습니다. 잠시 후 다시 시도하세요.', 503, code);
  return new ClientError(
    error instanceof Error ? error.message : '처리에 실패했습니다. 다시 시도해 주세요.',
    500,
    code || 'UNKNOWN',
  );
}
export async function withDeadline(promise, milliseconds = 20000) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new ClientError(
                '응답 확인 시간이 초과되었습니다. 다시 시도하세요.',
                503,
                'DEADLINE',
              ),
            ),
          milliseconds,
        );
      }),
    ]);
  } catch (error) {
    throw firebaseError(error);
  } finally {
    clearTimeout(timeout);
  }
}
export const errorMessage = (error) => firebaseError(error).message;
let clients = null;
let connection = null;
let publicDb = null;
let authSdk;
let authSdkRequest;
function loadAuthSdk() {
  return (authSdkRequest ??=
    import('https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js')
      .then((sdk) => (authSdk = sdk))
      .catch((error) => {
        authSdkRequest = null;
        throw error;
      }));
}
let authGeneration = 0;
const authIntents = { admin: 0 };
let authMutations = Promise.resolve();

function nextLogin(kind) {
  const generation = ++authGeneration;
  authIntents.admin = generation;
  return { kind, generation };
}
function invalidateLogin(kind) {
  authIntents[kind] = ++authGeneration;
  return authIntents[kind];
}
function requireCurrentLogin(intent) {
  if (authIntents[intent.kind] !== intent.generation)
    throw new ClientError(
      '로그인 요청이 취소되었습니다. 다시 로그인하세요.',
      409,
      'AUTH_CANCELLED',
    );
}
function mutateAuth(work) {
  const result = authMutations.then(work, work);
  authMutations = result.catch(() => {});
  return result;
}
async function temporaryLogin(clients, intent, email, password, verify) {
  const app = initializeApp(
    clients.adminDb.app.options,
    `ohsung-login-${intent.kind}-${crypto.randomUUID()}`,
  );
  let auth;
  let closed = false;
  try {
    auth = authSdk.initializeAuth(app, { persistence: authSdk.inMemoryPersistence });
    const db = getFirestore(app);
    if (clients.emulator) {
      authSdk.connectAuthEmulator(auth, 'http://127.0.0.1:9098', { disableWarnings: true });
      connectFirestoreEmulator(db, '127.0.0.1', 8088);
    }
    // The request may finish after our timeout. Only this unobserved memory Auth may change.
    const validation = (async () => {
      const { user } = await authSdk.signInWithEmailAndPassword(auth, email, password);
      requireCurrentLogin(intent);
      if (closed) throw new ClientError('로그인 요청이 만료되었습니다.', 408, 'DEADLINE');
      const session = await verify(user, db);
      requireCurrentLogin(intent);
      if (closed) throw new ClientError('로그인 요청이 만료되었습니다.', 408, 'DEADLINE');
      return { user, session };
    })();
    const { user, session } = await withDeadline(validation);
    return await mutateAuth(async () => {
      requireCurrentLogin(intent);
      const target = clients.adminAuth;
      await authSdk.updateCurrentUser(target, user);
      try {
        requireCurrentLogin(intent);
      } catch (reason) {
        // Finish clearing this publication before a newer login or logout may mutate Auth.
        await authSdk.signOut(target);
        throw reason;
      }
      return session;
    });
  } finally {
    closed = true;
    if (auth) await authSdk.signOut(auth).catch(() => {});
    await deleteApp(app).catch(() => {});
  }
}
async function clearLoginSessions(clients, intent) {
  await mutateAuth(async () => {
    requireCurrentLogin(intent);
    await authSdk.signOut(clients.adminAuth);
    requireCurrentLogin(intent);
  });
}
async function readConnection() {
  const emulator =
    ['localhost', '127.0.0.1'].includes(location.hostname) &&
    new URLSearchParams(location.search).get('emulator') === '1';
  let config;
  if (emulator) {
    config = {
      apiKey: 'demo-ohsung-key',
      projectId: 'demo-ohsung',
      authDomain: 'demo-ohsung.firebaseapp.com',
      appId: '1:123456789:web:demo-ohsung',
    };
  } else {
    const response = await fetch(new URL('./firebase-config.json', import.meta.url), {
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    config = response.ok ? await response.json() : {};
    if (!config.apiKey || !config.projectId || !config.appId)
      throw new ClientError(
        '아직 저장 서버가 연결되지 않았습니다. 운영진에게 알려 주세요.',
        503,
        'FIREBASE_NOT_CONFIGURED',
      );
  }
  return { config, emulator, suffix: `${config.projectId}-${emulator ? 'local' : 'cloud'}` };
}
function getConnection() {
  return (connection ??= readConnection().catch((error) => {
    connection = null;
    throw error;
  }));
}
export function getPublicDb() {
  return (publicDb ??= (async () => {
    const { config, emulator, suffix } = await getConnection();
    const app = initializeApp(config, `ohsung-device-${suffix}`);
    try {
      const db = getFirestore(app);
      if (emulator) connectFirestoreEmulator(db, '127.0.0.1', 8088);
      return db;
    } catch (error) {
      await deleteApp(app).catch(() => {});
      throw error;
    }
  })().catch((error) => {
    publicDb = null;
    throw error;
  }));
}
async function initialize() {
  const [{ config, emulator, suffix }] = await Promise.all([getConnection(), loadAuthSdk()]);
  const apps = [];
  try {
    const adminApp = initializeApp(config, `ohsung-admin-${suffix}`);
    apps.push(adminApp);
    const adminAuth = authSdk.initializeAuth(adminApp, {
      persistence: authSdk.browserSessionPersistence,
    });
    const adminDb = getFirestore(adminApp);
    if (emulator) {
      authSdk.connectAuthEmulator(adminAuth, 'http://127.0.0.1:9098', {
        disableWarnings: true,
      });
      connectFirestoreEmulator(adminDb, '127.0.0.1', 8088);
      await adminAuth.authStateReady();
      try {
        await adminAuth.currentUser?.getIdToken(true);
      } catch (error) {
        if (
          [
            'auth/invalid-refresh-token',
            'auth/user-token-expired',
            'auth/user-not-found',
          ].includes(error.code)
        )
          await authSdk.signOut(adminAuth);
        else throw error;
      }
    }
    return {
      adminAuth,
      adminDb,
      emulator,
      projectId: config.projectId,
    };
  } catch (error) {
    await Promise.allSettled(apps.map((app) => deleteApp(app)));
    throw error;
  }
}
export function getClients() {
  if (!clients)
    clients = initialize().catch((error) => {
      clients = null;
      throw error;
    });
  return clients;
}

export function sessionPolicy(data) {
  return {
    boothMode: data?.boothMode !== false,
    idleMinutes:
      Number.isInteger(data?.idleMinutes) && data.idleMinutes >= 1 && data.idleMinutes <= 120
        ? data.idleMinutes
        : 10,
  };
}
export async function adminSession() {
  const { adminAuth, adminDb } = await getClients();
  await adminAuth.authStateReady();
  const user = adminAuth.currentUser;
  if (!user)
    return {
      authenticated: false,
    };
  const role = await withDeadline(getDoc(doc(adminDb, 'admins', user.uid)));
  return {
    authenticated: role.data()?.enabled === true,
    uid: user.uid,
    email: user.email ?? undefined,
  };
}
export async function adminContext() {
  const session = await adminSession();
  if (!session.authenticated || !session.uid)
    throw new ClientError('관리자 로그인이 필요합니다.', 401, 'UNAUTHENTICATED');
  return {
    uid: session.uid,
    db: (await getClients()).adminDb,
  };
}
export async function loginAdmin(email, password) {
  const intent = nextLogin('admin');
  const clients = await getClients();
  await clearLoginSessions(clients, intent);
  try {
    return await temporaryLogin(clients, intent, email.trim(), password, async (user, db) => {
      const role = await getDoc(doc(db, 'admins', user.uid));
      if (role.data()?.enabled !== true)
        throw new ClientError('관리자 권한이 없는 계정입니다.', 403, 'NOT_ADMIN');
      return { authenticated: true, uid: user.uid, email: user.email ?? undefined };
    });
  } catch (reason) {
    throw firebaseError(reason);
  }
}
export async function logoutAdmin() {
  const generation = invalidateLogin('admin');
  const { adminAuth } = await getClients();
  await mutateAuth(async () => {
    if (authIntents.admin === generation) await authSdk.signOut(adminAuth);
  });
  return {
    authenticated: false,
  };
}
async function reauthenticateAdmin(password) {
  await adminContext();
  const user = (await getClients()).adminAuth.currentUser;
  if (!user.email) throw new ClientError('이메일 계정으로 다시 로그인해 주세요.', 401);
  await withDeadline(
    authSdk.reauthenticateWithCredential(
      user,
      authSdk.EmailAuthProvider.credential(user.email, password),
    ),
  );
  return user;
}
export async function changeAdminPassword(currentPassword, nextPassword) {
  if (nextPassword.length < 12)
    throw new ClientError('새 비밀번호는 12자 이상으로 입력해 주세요.', 400);
  await withDeadline(
    authSdk.updatePassword(await reauthenticateAdmin(currentPassword), nextPassword),
  );
}
export async function changeAdminEmail(currentPassword, email) {
  await withDeadline(
    authSdk.verifyBeforeUpdateEmail(
      await reauthenticateAdmin(currentPassword),
      email.trim(),
      emailActionSettings(),
    ),
  );
}
export async function resetAdminPassword(email) {
  const { adminAuth } = await getClients();
  adminAuth.languageCode = 'ko';
  await withDeadline(
    authSdk.sendPasswordResetEmail(adminAuth, email.trim(), emailActionSettings()),
  );
}
function emailActionSettings() {
  const base = new URL('../../', location.href);
  const pages = ['write/admin/', 'typing/admin/', 'welcome/admin/'].map(
    (path) => new URL(path, base),
  );
  const target = pages.find((page) => page.pathname === location.pathname) ?? pages[0];
  if (!['localhost', '127.0.0.1'].includes(location.hostname)) target.protocol = 'https:';
  if (location.hash === '#account') target.hash = '#account';
  if (
    ['localhost', '127.0.0.1'].includes(location.hostname) &&
    new URLSearchParams(location.search).get('emulator') === '1'
  )
    target.searchParams.set('emulator', '1');
  return { url: target.href, handleCodeInApp: false };
}

export async function createOperator(email, password) {
  const { db } = await adminContext();
  if (password.length < 12)
    throw new ClientError('초기 비밀번호는 12자 이상으로 입력해 주세요.', 400);
  const clients = await getClients();
  const app = initializeApp(
    clients.adminDb.app.options,
    `ohsung-new-operator-${crypto.randomUUID()}`,
  );
  const auth = authSdk.initializeAuth(app, {
    persistence: authSdk.inMemoryPersistence,
  });
  if (clients.emulator)
    authSdk.connectAuthEmulator(auth, 'http://127.0.0.1:9098', {
      disableWarnings: true,
    });
  try {
    const { user } = await withDeadline(
      authSdk.createUserWithEmailAndPassword(auth, email.trim(), password),
    );
    try {
      await withDeadline(
        setDoc(doc(db, 'admins', user.uid), {
          enabled: true,
          email: email.trim(),
          created_at: serverTimestamp(),
        }),
      );
    } catch (error) {
      const role = await withDeadline(getDoc(doc(db, 'admins', user.uid)));
      if (role.data()?.enabled !== true) {
        await authSdk.deleteUser(user);
        throw error;
      }
    }
    return user.uid;
  } finally {
    await authSdk.signOut(auth);
    await deleteApp(app);
  }
}
export async function watchAdminSession(onChange, onError) {
  const { adminAuth, adminDb } = await getClients();
  let sequence = 0;
  let previousUid = null;
  let stopRole = () => {};
  const stopAuth = authSdk.onIdTokenChanged(adminAuth, (user) => {
    const current = ++sequence;
    stopRole();
    stopRole = () => {};
    if (!user || user.uid !== previousUid)
      onChange({
        authenticated: false,
      });
    previousUid = user?.uid ?? null;
    if (!user) return;
    stopRole = onSnapshot(
      doc(adminDb, 'admins', user.uid),
      { includeMetadataChanges: true },
      (snapshot) => {
        if (current !== sequence || snapshot.metadata?.fromCache) return;
        const authenticated = snapshot.data()?.enabled === true;
        onChange({ authenticated, uid: user.uid, email: user.email ?? undefined });
        if (!authenticated)
          void logoutAdmin().catch((error) => {
            if (current === sequence) onError(error);
          });
      },
      (error) => {
        if (current === sequence) onError(error);
      },
    );
  });
  return () => {
    sequence++;
    stopRole();
    stopAuth();
  };
}

export {
  collection,
  deleteDoc,
  doc,
  getDocs,
  getDoc,
  serverTimestamp,
  setDoc,
} from './store.js?v=typing-certificate-1';
