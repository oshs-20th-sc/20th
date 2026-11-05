import { getPublicDb, getDoc, doc, sessionPolicy, loginAdmin, errorMessage } from './db/firebase.js';
import { escapeHtml as html, localHref, validateParticipant } from './common.js?v=record-entry-1';

// 참가 정보만 메모리에 보관합니다. 학생 Auth 계정이나 로그인 토큰을 만들지 않습니다.
export function mountLogin({
  container,
  adminPath,
  onStudent,
  onLogout,
  canLogout = () => true,
  canAutoLogout = () => true,
}) {
  let participant = null;
  let entered = false;
  let busy = false;
  let policy = { boothMode: true, idleMinutes: 10 };
  let lastActivity = Date.now();
  container.innerHTML = `<section id="login-panel" class="panel login-panel">
    <h2>로그인</h2><form id="entry-form" autocomplete="off">
      <label>학번<input name="studentNumber" required maxlength="254" autocomplete="off" /></label>
      <label>이름<input name="name" type="text" required maxlength="30" autocomplete="off" /></label>
      <p id="login-error" class="error" role="alert" hidden></p>
      <button type="submit">로그인</button>
    </form>
    <a id="admin-help" href="${html(localHref(adminPath))}" hidden>비밀번호 재설정</a>
  </section>
  <div id="student-session" class="section-top" hidden><span id="student-name"></span><button id="student-logout" type="button">로그아웃</button></div>`;
  const $ = (selector) => container.querySelector(selector);
  const form = $('#entry-form');
  const error = $('#login-error');
  const adminHelp = $('#admin-help');
  const identity = () => form.elements.studentNumber.value.normalize('NFKC').trim();
  const isAdminEmail = () => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity());
  function updateCredential() {
    const admin = isAdminEmail();
    if (form.elements.name.type === 'password' && !admin) form.elements.name.value = '';
    form.elements.name.type = admin ? 'password' : 'text';
    form.elements.name.maxLength = admin ? 4096 : 30;
    adminHelp.hidden = true;
  }
  form.elements.studentNumber.addEventListener('input', updateCredential);

  function logout({ force = false, cause = '' } = {}) {
    if (!force && !canLogout()) return false;
    const previous = entered;
    entered = false;
    participant = null;
    form.reset();
    updateCredential();
    error.textContent = '';
    error.hidden = true;
    $('#student-name').textContent = '';
    $('#student-session').hidden = true;
    $('#login-panel').hidden = false;
    $('#student-logout').textContent = '로그아웃';
    if (previous) onLogout(cause);
    if (cause !== 'pagehide') form.elements.studentNumber.focus();
    return true;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (entered || busy) return;
    error.hidden = true;
    adminHelp.hidden = true;
    if (isAdminEmail()) {
      busy = true;
      const email = identity();
      const password = form.elements.name.value;
      form.elements.name.type = 'password';
      container.querySelectorAll('input, button').forEach((control) => { control.disabled = true; });
      try {
        await loginAdmin(email, password);
        form.reset();
        updateCredential();
        location.assign(localHref(adminPath));
      } catch (value) {
        form.elements.name.value = '';
        error.textContent = errorMessage(value);
        error.hidden = false;
        adminHelp.hidden = false;
      } finally {
        busy = false;
        container.querySelectorAll('input, button').forEach((control) => { control.disabled = false; });
      }
      return;
    }
    const checked = validateParticipant(Object.fromEntries(new FormData(form)));
    if (!checked.value) {
      error.textContent = checked.error;
      error.hidden = false;
      return;
    }
    participant = { ...checked.value, sessionId: crypto.randomUUID() };
    entered = true;
    form.reset();
    updateCredential();
    error.hidden = true;
    $('#login-panel').hidden = true;
    $('#student-session').hidden = false;
    $('#student-name').textContent = `${participant.studentNumber} ${participant.name}`;
    lastActivity = Date.now();
    onStudent({ ...participant });
  });
  $('#student-logout').addEventListener('click', () => logout());
  const activity = () => { lastActivity = Date.now(); };
  for (const event of ['pointerdown', 'keydown', 'touchstart'])
    container.ownerDocument.addEventListener(event, activity, { passive: true });
  const timer = setInterval(() => {
    if (entered && policy.boothMode && Date.now() - lastActivity >= policy.idleMinutes * 60000 && canAutoLogout())
      logout({ force: true, cause: 'idle' });
  }, 5000);
  window.addEventListener('pagehide', () => {
    clearInterval(timer);
    for (const event of ['pointerdown', 'keydown', 'touchstart'])
      container.ownerDocument.removeEventListener(event, activity);
    logout({ force: true, cause: 'pagehide' });
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) location.reload();
  });
  // 관리자와 공유하는 미사용 정책만 읽으며, 학생 인증·명부 조회는 하지 않습니다.
  void getPublicDb()
    .then((db) => getDoc(doc(db, 'settings', 'sessionPolicy')))
    .then((snapshot) => { policy = sessionPolicy(snapshot.data()); })
    .catch(() => {});
  return {
    current: () => participant ? { ...participant } : null,
    policy: () => ({ ...policy }),
    logout,
    finish() {
      participant = null;
      form.reset();
      $('#student-name').textContent = '';
      $('#student-logout').textContent = '다음 참가자';
    },
  };
}
