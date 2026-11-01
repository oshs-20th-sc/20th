import { errorMessage, getClients } from '../db/firebase.js';
import { readEvent, submitLetter } from '../db/database.js';
import { normalizeText, unicodeLength, validateSubmission } from '../common.js';
import { mountLogin } from '../login.js';

const form = document.querySelector('#write-form');
const nickname = document.querySelector('#nickname');
const content = document.querySelector('#content');
const consent = document.querySelector('#consent');
const submitButton = document.querySelector('#submit');
const resetButton = document.querySelector('#clear-form');
const error = document.querySelector('#error');
const eventStatus = document.querySelector('#event-status');
const retryEvent = document.querySelector('#retry-event');
const pendingStatus = document.querySelector('#pending-status');
const editor = document.querySelector('#editor');
const complete = document.querySelector('#complete');
const counter = document.querySelector('#content-count');

let submissionKey = crypto.randomUUID();
let pending = null;
let busy = false;
let accepted = false;
let config = null;
let eventRequest = null;
let student = null;
let sessionVersion = 0;
let unblockTimer;

function showError(message = '') {
  error.textContent = message;
  error.hidden = !message;
}

function updateControls() {
  const blocked =
    student?.writeBlocked &&
    (!student.blockedUntil || student.blockedUntil.toMillis() > Date.now());
  const locked = busy || !!pending || !!blocked;
  nickname.disabled = locked;
  content.disabled = locked;
  consent.disabled = locked;
  submitButton.disabled =
    !student || blocked || busy || !!eventRequest || (!pending && !config?.submissionsEnabled);
  eventStatus.textContent = blocked
    ? '글 작성이 제한된 계정입니다. 운영진에게 문의하세요.'
    : eventRequest
      ? '접수 상태 확인 중'
      : config
        ? config.submissionsEnabled
          ? '접수 중'
          : '접수 마감'
        : '접수 상태 확인 실패';
  clearTimeout(unblockTimer);
  if (blocked && student.blockedUntil) {
    const delay = student.blockedUntil.toMillis() - Date.now();
    unblockTimer = setTimeout(updateControls, Math.min(delay + 10, 2147483647));
  }
  submitButton.textContent = busy ? '제출 중' : pending ? '다시 제출' : '제출';
  resetButton.disabled =
    busy || (!nickname.value && !content.value && !consent.checked && !pending);
  pendingStatus.hidden = !pending || busy;
  retryEvent.disabled = !!eventRequest || busy;
  form.setAttribute('aria-busy', String(busy));
  const length = unicodeLength(normalizeText(content.value));
  counter.textContent = `${length} / 700자 · 최소 10자`;
  counter.className = length > 700 ? 'error' : 'muted';
}

function checkEvent() {
  if (eventRequest) return eventRequest;
  eventRequest = (async () => {
    try {
      config = await readEvent((await getClients()).deviceDb);
      retryEvent.hidden = config.submissionsEnabled;
      return config;
    } catch (reason) {
      config = null;
      retryEvent.hidden = false;
      showError(errorMessage(reason));
      return null;
    } finally {
      eventRequest = null;
      updateControls();
    }
  })();
  updateControls();
  return eventRequest;
}

form.addEventListener('input', updateControls);
retryEvent.addEventListener('click', () => {
  showError();
  void checkEvent();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !student) return;
  const version = sessionVersion;
  const expectedUid = student.uid;
  const candidate = pending ?? {
    nickname: nickname.value,
    content: content.value,
    consentToPublish: consent.checked,
    submissionKey,
  };
  const validated = validateSubmission(candidate);
  if (!validated.value) {
    showError(validated.error);
    return;
  }
  busy = true;
  showError();
  updateControls();
  try {
    if (!pending) {
      const latest = await checkEvent();
      if (!latest?.submissionsEnabled) {
        if (latest) showError('접수가 마감되었습니다.');
        return;
      }
    }
    if (version !== sessionVersion) return;
    pending ||= validated.value;
    updateControls();
    const { studentDb: db, studentAuth } = await getClients();
    const uid = studentAuth.currentUser?.uid;
    if (version !== sessionVersion || uid !== expectedUid)
      throw new Error('로그인 계정이 변경되었습니다. 다시 입력하세요.');
    const receipt = await submitLetter(db, uid, pending);
    if (version !== sessionVersion) return;
    accepted = true;
    nickname.value = '';
    content.value = '';
    consent.checked = false;
    pending = null;
    document.querySelector('#receipt').textContent = receipt.id;
    editor.hidden = true;
    complete.hidden = false;
    eventStatus.hidden = true;
    retryEvent.hidden = true;
    complete.scrollIntoView({ block: 'start' });
    complete.focus({ preventScroll: true });
    if (login.policy().boothMode) await login.logout({ force: true, cause: 'submitted' });
  } catch (reason) {
    if (version === sessionVersion) showError(errorMessage(reason));
  } finally {
    if (version === sessionVersion) {
      busy = false;
      updateControls();
    }
  }
});

function reset() {
  form.reset();
  submissionKey = crypto.randomUUID();
  pending = null;
  accepted = false;
  showError();
  complete.hidden = true;
  editor.hidden = false;
  eventStatus.hidden = false;
  updateControls();
  void checkEvent();
  content.focus();
}

resetButton.addEventListener('click', () => {
  const message = pending
    ? '접수가 이미 저장되었을 수 있습니다. 접수 내역을 확인한 뒤 입력을 초기화할까요?'
    : '입력 내용을 초기화할까요?';
  if (!busy && window.confirm(message)) reset();
});
document.querySelector('#new-letter').addEventListener('click', reset);
window.addEventListener('beforeunload', (event) => {
  if (!accepted && (busy || pending || content.value || nickname.value || consent.checked)) {
    event.preventDefault();
    event.returnValue = '';
  }
});

const login = mountLogin({
  container: document.querySelector('#login'),
  adminPath: './admin/',
  onStudent(profile) {
    const entering = student?.uid !== profile.uid;
    student = profile;
    document.querySelector('#student-view').hidden = false;
    document.querySelector('#new-letter').hidden = false;
    if (entering) {
      sessionVersion++;
      busy = false;
      reset();
    } else updateControls();
  },
  canLogout() {
    if (busy) return false;
    return (
      !(pending || content.value || nickname.value || consent.checked) ||
      confirm('입력한 내용을 닫고 로그아웃할까요?')
    );
  },
  canAutoLogout() {
    return !busy && !pending;
  },
  onLogout(cause) {
    sessionVersion++;
    busy = false;
    student = null;
    clearTimeout(unblockTimer);
    form.reset();
    submissionKey = crypto.randomUUID();
    pending = null;
    document.querySelector('#student-view').hidden = true;
    document.querySelector('#new-letter').hidden = true;
    if (cause !== 'submitted') {
      complete.hidden = true;
      document.querySelector('#receipt').textContent = '';
    }
    showError();
    updateControls();
  },
});
updateControls();
