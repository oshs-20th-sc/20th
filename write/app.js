import { errorMessage, getPublicDb } from '../db/firebase.js';
import { readEvent } from '../db/public.js';
import { submitLetter } from '../db/database.js';
import { normalizeText, unicodeLength, validateSubmission } from '../common.js';

const form = document.querySelector('#write-form');
const studentNumber = document.querySelector('#student-number');
const studentName = document.querySelector('#student-name');
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

function showError(message = '') {
  error.textContent = message;
  error.hidden = !message;
}

function hasInput() {
  return !!(
    studentNumber.value ||
    studentName.value ||
    nickname.value ||
    content.value ||
    consent.checked ||
    pending
  );
}

function updateControls() {
  const locked = busy || !!pending;
  for (const input of [studentNumber, studentName, nickname, content, consent])
    input.disabled = locked;
  submitButton.disabled =
    busy || !!eventRequest || (!pending && !config?.submissionsEnabled);
  eventStatus.textContent = eventRequest
    ? '접수 상태 확인 중'
    : config
      ? config.submissionsEnabled
        ? '접수 중'
        : '접수 마감'
      : '접수 상태 확인 실패';
  submitButton.textContent = busy ? '제출 중' : pending ? '다시 제출' : '제출';
  resetButton.disabled = busy || !hasInput();
  pendingStatus.hidden = !pending || busy;
  retryEvent.disabled = !!eventRequest || busy;
  form.setAttribute('aria-busy', String(busy));
  counter.textContent = `${unicodeLength(normalizeText(content.value))}자`;
}

function checkEvent() {
  if (eventRequest) return eventRequest;
  eventRequest = (async () => {
    try {
      config = await readEvent(await getPublicDb());
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
form.addEventListener('change', updateControls);
retryEvent.addEventListener('click', () => {
  showError();
  void checkEvent();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  let validated = { value: pending };
  if (!pending) {
    validated = validateSubmission({
      studentNumber: studentNumber.value,
      name: studentName.value,
      nickname: nickname.value,
      content: content.value,
      consentToPublish: consent.checked,
      submissionKey,
    });
    if (!validated.value) {
      showError(validated.error);
      return;
    }
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
    pending = validated.value;
    updateControls();
    const db = await getPublicDb();
    const participant = {
      studentNumber: pending.studentNumber,
      name: pending.name,
    };
    await submitLetter(db, participant, pending);
    accepted = true;
    pending = null;
    form.reset();
    submissionKey = crypto.randomUUID();
    complete.hidden = false;
    editor.hidden = true;
    eventStatus.hidden = true;
    retryEvent.hidden = true;
    complete.scrollIntoView({ block: 'start' });
    complete.focus({ preventScroll: true });
  } catch (reason) {
    showError(errorMessage(reason));
  } finally {
    busy = false;
    updateControls();
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
  studentNumber.focus();
}

resetButton.addEventListener('click', () => {
  if (busy) return;
  if (pending && !window.confirm('접수가 이미 저장되었을 수 있습니다. 같은 내용으로 다시 제출할 수 없게 초기화할까요?'))
    return;
  reset();
});
document.querySelector('#new-letter').addEventListener('click', reset);
window.addEventListener('beforeunload', (event) => {
  if (!accepted && (busy || hasInput())) {
    event.preventDefault();
    event.returnValue = '';
  }
});

updateControls();
void checkEvent();
