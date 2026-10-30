import {
  loginAdmin,
  loginStudent,
  logoutStudent,
  getClients,
  watchStudentSession,
  watchSessionPolicy,
  errorMessage,
} from './db/firebase.js';
import { escapeHtml as html, localHref } from './common.js';

export function loginKind(value) {
  const id = String(value ?? '')
    .normalize('NFKC')
    .trim();
  if (/^[1-3][0-9]{4}$/.test(id)) return { kind: 'student', id };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id)) return { kind: 'admin', id };
  throw new Error('학번을 확인해 주세요.');
}

export function mountLogin({
  container,
  adminPath,
  onStudent,
  onLogout,
  canLogout = () => true,
  canAutoLogout = () => true,
}) {
  let student = null;
  let busy = false;
  let policy = { boothMode: true, idleMinutes: 10 };
  let lastActivity = Date.now();
  let reason = '';
  let setupPromise;
  container.innerHTML = `<section id="login-panel" class="panel login-panel">
    <h2>로그인</h2><form id="entry-form">
      <label>학번<input name="identity" required maxlength="254" autocomplete="username" /></label>
      <label>비밀번호<input name="credential" type="password" required maxlength="4096" autocomplete="current-password" /></label>
      <p id="login-error" class="error" role="alert" hidden></p>
      <button type="submit">로그인</button>
    </form>
    <a id="admin-help" href="${html(localHref(adminPath))}" hidden>비밀번호 재설정</a>
  </section>
  <div id="student-session" class="section-top" hidden><span id="student-name"></span><button id="student-logout" type="button">로그아웃</button></div>`;
  const $ = (selector) => container.querySelector(selector);
  const form = $('#entry-form');
  const error = $('#login-error');
  function failure(value) {
    error.textContent = errorMessage(value);
    error.hidden = false;
  }
  function lock(value) {
    busy = value;
    container.setAttribute('aria-busy', String(value));
    container.querySelectorAll('input, button').forEach((control) => {
      control.disabled = value;
    });
  }
  function show(value) {
    const previous = student;
    student = value;
    $('#login-panel').hidden = !!value;
    $('#student-session').hidden = !value;
    $('#student-name').textContent = value
      ? `${value.loginId || value.studentId} ${value.name}`
      : '';
    if (value) {
      lastActivity = Date.now();
      onStudent({ ...value });
    } else if (previous) {
      form.reset();
      onLogout(reason);
      reason = '';
    }
  }
  async function setup() {
    if (!setupPromise)
      setupPromise = (async () => {
        const clients = await getClients();
        policy = clients.policy;
        // 이전의 본인 확인 없는 입력 세션은 복원하지 않습니다.
        try {
          sessionStorage.removeItem(`student:${new URL('.', import.meta.url).pathname}`);
        } catch {
          /* 선택 저장소 */
        }
        await watchStudentSession(show, failure);
        await watchSessionPolicy((value) => {
          policy = value;
        }, failure);
      })().catch((value) => {
        setupPromise = null;
        throw value;
      });
    return setupPromise;
  }
  async function logout({ force = false, cause = '' } = {}) {
    if (busy || (!force && !canLogout())) return false;
    lock(true);
    reason = cause;
    try {
      await logoutStudent();
      show(null);
      return true;
    } catch (value) {
      failure(value);
      return false;
    } finally {
      lock(false);
    }
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    const values = new FormData(form);
    let account;
    lock(true);
    error.hidden = true;
    $('#admin-help').hidden = true;
    try {
      account = loginKind(values.get('identity'));
      await setup();
      if (account.kind === 'admin') {
        await logoutStudent();
        await loginAdmin(account.id, values.get('credential'));
        form.reset();
        location.assign(localHref(adminPath));
      } else {
        const profile = await loginStudent(account.id, values.get('credential'));
        form.reset();
        show(profile);
      }
    } catch (value) {
      failure(value);
      form.elements.credential.value = '';
      $('#admin-help').hidden = account?.kind !== 'admin';
    } finally {
      lock(false);
    }
  });
  $('#student-logout').addEventListener('click', () => void logout());
  for (const event of ['pointerdown', 'keydown', 'touchstart'])
    document.addEventListener(
      event,
      () => {
        lastActivity = Date.now();
      },
      { passive: true },
    );
  const timer = setInterval(() => {
    if (
      student &&
      policy.boothMode &&
      !busy &&
      Date.now() - lastActivity >= policy.idleMinutes * 60000 &&
      canAutoLogout()
    )
      void logout({ force: true, cause: 'idle' });
  }, 5000);
  window.addEventListener('pagehide', () => {
    clearInterval(timer);
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) location.reload();
  });
  lock(true);
  void setup()
    .catch(failure)
    .finally(() => lock(false));
  return {
    current: () => (student ? { ...student } : null),
    policy: () => ({ ...policy }),
    logout,
  };
}
