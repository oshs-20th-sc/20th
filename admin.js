import {
  adminContext,
  loginAdmin,
  logoutAdmin,
  watchAdminSession,
  errorMessage,
  resetAdminPassword,
} from './db/firebase.js';
import { readLettersPage, readTypingPage, readChallenges, readEvent } from './db/database.js';
import { readSessionPolicy, readStudentsByIds, findStudentsByLogin } from './db/students.js';
import { escapeHtml as html, localHref } from './common.js';
import { state, feature } from './admin/state.js';
import {
  root,
  featureTitle,
  firstTab,
  $,
  setStatus,
  run,
  submit,
  field,
  confirmDiscard,
  restoreHash,
  dirtyForms,
  alertError,
  invalidateListCache,
  cachedList,
  rememberList,
  resetLetterPages,
  resetResultPages,
  bindRenderTab,
} from './admin/shared.js';
import {
  clearStudentRoster,
  loadStudentRoster,
  studentsView,
  studentDetail,
} from './admin/students.js';
import { lettersView } from './admin/letters.js';
import { recordsView } from './admin/typing.js';
import { settingsView } from './admin/settings.js';
import { accountView } from './admin/account.js';

function applySession(next) {
  const entering = !state.session.authenticated || next.uid !== state.session.uid;
  if (!next.authenticated || next.uid !== state.session.uid) {
    state.viewSequence++;
    clearStudentRoster();
  }
  state.session = next;
  if (!next.authenticated) {
    state.pendingStudentDetail = null;
    state.letters = [];
    state.results = [];
    state.challenges = [];
    state.students = [];
    state.config = undefined;
    if (!$('#login')) showLogin();
  } else if (entering) showAdmin();
  else if ($('#identity')) $('#identity').textContent = next.email ?? '';
}

function sessionFailed(reason) {
  state.viewSequence++;
  clearStudentRoster();
  state.session = { authenticated: false };
  state.letters = [];
  state.results = [];
  state.challenges = [];
  state.students = [];
  state.config = undefined;
  showLogin(errorMessage(reason));
}

function managementLinks() {
  return `<nav class="actions" aria-label="관리 기능">${[
    ['typing', '타자 관리'],
    ['write', '글 관리'],
    ['welcome', '공개 글 관리'],
  ]
    .map(
      ([name, title]) =>
        `<a href="${html(localHref(`../../${name}/admin/`))}"${name === feature ? ' aria-current="page"' : ''}>${title}</a>`,
    )
    .join('')}</nav>`;
}

function showLogin(error = '') {
  state.viewSequence++;
  root.innerHTML = `<header class="page-header"><h1>관리자 로그인</h1><a href="${html(localHref('../'))}">돌아가기</a></header>${managementLinks()}
    <p id="status" role="status" hidden></p><form class="panel" id="login">
      ${field('email', '이메일', '', 'email', 'required autocomplete="username"')}
      ${field('password', '비밀번호', '', 'password', 'required autocomplete="current-password"')}
      <div class="actions"><button type="submit">로그인</button><button type="button" id="reset-password">비밀번호 재설정</button></div></form>`;
  if (error) setStatus(error, true);
  submit($('#login'), async (values) => {
    applySession(await loginAdmin(values.email, values.password));
  });
  $('#reset-password').onclick = () =>
    void run(async () => {
      const email = $('#login [name=email]').value;
      if (!email) throw new Error('이메일을 입력하세요.');
      await resetAdminPassword(email);
      setStatus(
        '등록된 이메일이면 재설정 메일이 전송됩니다. 메일의 링크에서 새 비밀번호를 설정하세요.',
      );
    });
}

function showAdmin() {
  root.innerHTML = `<header class="page-header"><h1>${featureTitle}</h1><a href="${html(localHref('../'))}">돌아가기</a></header>${managementLinks()}
    <div class="section-top"><span id="identity">${html(state.session.email)}</span><button id="logout">로그아웃</button></div>
    <nav class="admin-nav" aria-label="관리자 메뉴"><a href="#${firstTab}">${feature === 'typing' ? '타자 기록' : '글'}</a><a href="#students">학생</a><a href="#settings">설정</a><a href="#account">계정</a></nav>
    <p id="status" role="status" hidden></p><div id="view"></div>`;
  $('#logout').onclick = () =>
    void run(async () => {
      if (!confirmDiscard()) {
        setStatus();
        return;
      }
      await logoutAdmin();
      applySession({ authenticated: false });
    });
  void renderTab();
}

async function renderTab(forceStudents = false) {
  if (!state.session.authenticated || !confirmDiscard()) return;
  const sequence = ++state.viewSequence;
  state.renderedHash = location.hash;
  const tab = ['settings', 'account', 'students', firstTab].includes(location.hash.slice(1))
    ? location.hash.slice(1)
    : firstTab;
  document.querySelectorAll('.admin-nav a').forEach((link) => {
    const active = link.hash === `#${tab}`;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  $('#view').textContent = '불러오는 중';
  $('#view').setAttribute('aria-busy', 'true');
  setStatus();
  try {
    const { db } = await adminContext();
    let loaded;
    let fromCache = false;
    if (forceStudents === true) {
      invalidateListCache();
      resetLetterPages();
      resetResultPages();
    }
    if (['letters', 'records'].includes(tab)) {
      loaded = cachedList(tab);
      fromCache = Boolean(loaded);
    }
    if (tab === 'letters' && !loaded) {
      const page = await readLettersPage(db, {
        ...state.letterFilter,
        status: state.letterFilter.status === 'trash' ? '' : state.letterFilter.status,
        trash: state.letterFilter.status === 'trash',
        cursor: state.letterCursors[state.letterPage - 1],
      });
      loaded = [
        page,
        await readStudentsByIds(
          db,
          page.items.map((item) => item.owner_uid),
        ),
      ];
    }
    if (tab === 'records' && !loaded) {
      const [versions, event] = await Promise.all([
        readChallenges(db),
        readEvent(db).catch(() => null),
      ]);
      if (sequence !== state.viewSequence) return;
      if (state.resultFilter.version === null) {
        state.resultFilter.version =
          event?.activeChallengeId ||
          versions.find((item) => item.enabled && !item.deleted)?.challengeId ||
          versions[0]?.challengeId ||
          '';
      }
      const queryText = state.resultFilter.query.trim().toLowerCase();
      if (!state.resultFilter.version) state.resultFilter.view = 'attempts';
      const matched = await findStudentsByLogin(db, queryText);
      const page = await readTypingPage(db, {
        ...state.resultFilter,
        participantIds: matched.map((item) => item.student_id),
        cursor: state.resultCursors[state.resultPage - 1],
      });
      const ids = [...new Set(page.items.map((item) => item.participantId))];
      const known = matched.filter((student) => ids.includes(student.student_id));
      const missing = ids.filter((id) => !known.some((student) => student.student_id === id));
      loaded = [page, versions, [...known, ...(await readStudentsByIds(db, missing))]];
    }
    if (tab === 'settings') {
      loaded = await Promise.all([
        readEvent(db).catch(() => null),
        readChallenges(db),
        readSessionPolicy(db),
      ]);
    }
    if (tab === 'students') {
      loaded = await Promise.all([
        loadStudentRoster(db, forceStudents === true),
        readSessionPolicy(db),
      ]);
    }
    if (sequence !== state.viewSequence) return;
    if (['letters', 'records'].includes(tab) && !fromCache) rememberList(tab, loaded);
    if (tab === 'letters') {
      const [page, roster] = loaded;
      state.letters = page.items;
      state.students = roster;
      state.letterNext = page.cursor;
      state.letterHasNext = page.hasNext;
      state.selectedLetters.clear();
      lettersView();
    } else if (tab === 'records') {
      const [page, versions, roster] = loaded;
      state.results = page.items;
      state.challenges = versions;
      state.students = roster;
      state.resultNext = page.cursor;
      state.resultHasNext = page.hasNext;
      await recordsView();
    } else if (tab === 'settings') {
      [state.config, state.challenges, state.sessionPolicy] = loaded;
      settingsView();
    } else if (tab === 'students') {
      [state.students, state.sessionPolicy] = loaded;
      studentsView();
      if (state.pendingStudentDetail) {
        const requested = state.pendingStudentDetail;
        state.pendingStudentDetail = null;
        if (state.students.some((student) => student.student_id === requested.id))
          await studentDetail(requested.id, requested.letterId);
      }
    } else await accountView(db, sequence);
  } catch (reason) {
    if (sequence === state.viewSequence) {
      $('#view').innerHTML = '<button id="retry-view">다시 불러오기</button>';
      $('#retry-view').onclick = renderTab;
      alertError(reason);
    }
  } finally {
    if (sequence === state.viewSequence) $('#view')?.setAttribute('aria-busy', 'false');
  }
}

function bindNavigation() {
  window.addEventListener('hashchange', () => {
    if (state.busy) return;
    if (!confirmDiscard()) {
      restoreHash();
      return;
    }
    void renderTab();
  });
  root.addEventListener('click', (event) => {
    if (!event.target.closest('a')) return;
    if (state.busy || !confirmDiscard()) event.preventDefault();
  });
  window.addEventListener('beforeunload', (event) => {
    if (!state.busy && !dirtyForms().length) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

async function startAdmin() {
  bindRenderTab(renderTab);
  bindNavigation();
  try {
    await watchAdminSession(applySession, sessionFailed);
  } catch (reason) {
    sessionFailed(reason);
  }
}

void startAdmin();
