import { mountObyeol } from './obyeol.js?v=typing-certificate-1';
import { mountRecordCard } from './record-card.js?v=typing-certificate-1';
import { getPublicDb, errorMessage } from '../db/firebase.js?v=typing-certificate-1';
import { readEvent, readChallenge, readTypingCertificate } from '../db/database.js?v=typing-certificate-1';
import { mountLogin } from '../login.js?v=typing-certificate-1';
import { downloadFile } from '../common.js?v=typing-certificate-1';
import {
  initialInputState,
  commitInput,
  compositionStart,
  compositionEnd,
  isComplete,
} from './engine.js?v=typing-certificate-1';
import { calculateScore, EVENT_ERROR_PENALTY } from './scoring.js?v=typing-certificate-1';
import { saveResult } from './storage.js?v=typing-certificate-1';

const elements = Object.fromEntries(
  [
    'event-status',
    'reload',
    'challenge-title',
    'attempt-status',
    'elapsed',
    'errors',
    'score',
    'challenge',
    'typing-input',
    'feedback',
    'result',
    'retry',
    'rescue',
    'rescue-confirm',
  ].map((id) => [id, document.getElementById(id)]),
);

const obyeol = mountObyeol(document.getElementById('obyeol'), document.getElementById('obyeol-message'));
const recordCard = mountRecordCard();

let config = null;
let challenge = null;
let attempt = null;
let participant = null;
let status = 'ready';
let loading = false;
let saving = false;
let engine = initialInputState();
let startedAt = null;
let elapsed = 0;
let result = null;
let spans = [];
let timer = null;
let sessionVersion = 0;
let needsBackup = false;
let filePrepared = false;
let failureReason = '';
let pendingEdit = null;
let deletionKey = '';

function message(text, isError = false) {
  elements.feedback.textContent = text;
  elements.feedback.classList.toggle('error', isError);
}

function updateControls() {
  const active = status === 'armed' || status === 'running';
  elements['typing-input'].disabled = !participant || loading || !active;
  elements.retry.hidden = status !== 'failed';
  elements.rescue.hidden = status !== 'failed' || !needsBackup;
  elements['rescue-confirm'].hidden = status !== 'failed' || !needsBackup || !filePrepared;
  elements['attempt-status'].textContent = {
    ready: '',
    armed: '',
    running: '',
    saving: '저장 중',
    saved: '저장 완료',
    failed: '저장 실패',
    invalid: '중단',
  }[status];
}

function transition(next) {
  status = next;
  if (next !== 'running') {
    clearInterval(timer);
    timer = null;
  }
  updateControls();
  recordCard.status(next, needsBackup, filePrepared, failureReason);
}

function showChallenge(current) {
  elements['challenge-title'].textContent = current.title;
  elements.challenge.setAttribute('aria-label', `입력할 문구: ${current.text}`);
  spans = Array.from(current.text, (character) => {
    const span = document.createElement('span');
    span.textContent = character;
    return span;
  });
  elements.challenge.replaceChildren(...spans);
  highlight('');
}

function highlight(value) {
  const chars = Array.from(value);
  const target = Array.from((attempt ?? challenge)?.text ?? '');
  spans.forEach((span, index) => {
    span.className =
      index < chars.length
        ? chars[index] === target[index]
          ? 'correct'
          : 'incorrect'
        : index === chars.length
          ? 'cursor'
          : '';
  });
}

function eventStatus() {
  if (!config || !challenge) return;
  elements['event-status'].textContent = '';
  elements['event-status'].hidden = true;
}

async function refresh() {
  loading = true;
  elements.reload.hidden = true;
  updateControls();
  try {
    const deviceDb = await getPublicDb();
    const nextConfig = await readEvent(deviceDb);
    const nextChallenge = await readChallenge(deviceDb, nextConfig.activeChallengeId);
    config = nextConfig;
    challenge = nextChallenge;
    if (!attempt) showChallenge(challenge);
    eventStatus();
    return { config, challenge };
  } catch (reason) {
    config = null;
    challenge = null;
    elements['event-status'].hidden = false;
    elements['event-status'].textContent = errorMessage(reason);
    elements.reload.hidden = false;
    throw reason;
  } finally {
    loading = false;
    updateControls();
  }
}

function beginTiming() {
  if (status !== 'armed') return;
  startedAt = performance.now();
  transition('running');
  timer = setInterval(() => {
    elapsed = performance.now() - startedAt;
    elements.elapsed.textContent = (elapsed / 1000).toFixed(1);
    if (elapsed > 3600000) invalidate('제한 시간 1시간을 초과했습니다.');
  }, 100);
}

async function persist(record) {
  if (saving) return;
  saving = true;
  failureReason = '';
  const version = sessionVersion;
  transition('saving');
  message('기록 저장 중');
  try {
    await saveResult(record);
    if (version !== sessionVersion) return;
    needsBackup = false;
    transition('saved');
    message('저장 완료');
    participant = null;
    result = null;
    login.finish();
  } catch (reason) {
    if (version === sessionVersion) {
      failureReason = errorMessage(reason);
      needsBackup = reason.backupSaved === false;
      transition('failed');
      message(
        needsBackup
          ? '기록을 보관하지 못했습니다. 파일로 저장한 뒤 운영진에게 전달하세요.'
          : errorMessage(reason),
        true,
      );
    }
  } finally {
    saving = false;
  }
}

function process(value, endedComposition = false, edit) {
  if (!['armed', 'running'].includes(status) || !attempt) return;
  if (value.length) beginTiming();
  const previousEngine = engine;
  engine = endedComposition
    ? compositionEnd(engine, value, attempt.text)
    : commitInput(engine, value, attempt.text, edit);
  obyeol.react(previousEngine, engine, edit);
  elements.errors.textContent = engine.errors;
  highlight(value);
  message(`입력 ${Array.from(value).length} / ${Array.from(attempt.text).length}자`);
  if (!isComplete(engine, attempt.text) || startedAt === null) return;
  elapsed = Math.max(1, performance.now() - startedAt);
  result = {
    id: crypto.randomUUID(),
    participantId: participant.studentNumber,
    displayName: participant.name,
    owner_uid: null,
    entry_mode: 'record',
    challengeId: attempt.challengeId,
    elapsedMs: elapsed,
    ...calculateScore(
      attempt.referenceKeystrokes,
      elapsed,
      engine.errors,
      EVENT_ERROR_PENALTY,
    ),
    errors: engine.errors,
    completedAt: new Date().toISOString(),
    prizeReceived: false,
    practice: false,
  };
  elements.elapsed.textContent = (elapsed / 1000).toFixed(2);
  elements.score.textContent = result.score;
  elements.result.textContent = `${result.speed}타/분 · 오타 ${result.errors}회 · ${result.score}점`;
  elements.result.hidden = false;
  // Start the existing save flow before opening presentation UI.
  void persist(result);
  obyeol.complete();
  recordCard.show(result);
}

function invalidate(reason) {
  if (!['armed', 'running'].includes(status)) return;
  obyeol.pause();
  transition('invalid');
  message(reason, true);
}

async function prepareAttempt() {
  if (!participant || loading || status !== 'ready') return;
  const version = sessionVersion;
  loading = true;
  elements.reload.hidden = true;
  updateControls();
  try {
    const previous = await readTypingCertificate(await getPublicDb(), participant);
    if (version !== sessionVersion) return;
    if (previous) {
      showCompletedRecord(previous);
      return;
    }
    const current = await refresh();
    if (version !== sessionVersion) return;
    if (current.challenge.deleted) throw new Error('사용할 문구가 삭제되었습니다. 운영진에게 알려 주세요.');
    attempt = { ...current.challenge, practice: false, errorPenalty: EVENT_ERROR_PENALTY };
    engine = initialInputState();
    startedAt = null;
    elapsed = 0;
    result = null;
    obyeol.reset();
    recordCard.reset();
    elements['typing-input'].value = '';
    elements.elapsed.textContent = '0.0';
    elements.errors.textContent = '0';
    elements.score.textContent = '—';
    elements.result.hidden = true;
    showChallenge(attempt);
    transition('armed');
    message('');
    elements['typing-input'].focus();
  } catch (reason) {
    if (version !== sessionVersion) return;
    elements.reload.hidden = false;
    message(errorMessage(reason), true);
  } finally {
    if (version === sessionVersion) {
      loading = false;
      updateControls();
    }
  }
}

function showCompletedRecord(record) {
  attempt = {challengeId:record.challengeId, title:record.title, text:record.text,
    referenceKeystrokes:record.referenceKeystrokes, practice:false, errorPenalty:EVENT_ERROR_PENALTY};
  showChallenge(attempt);
  elements['typing-input'].value = record.text;
  highlight(record.text);
  elapsed = record.elapsedMs;
  elements.elapsed.textContent = (elapsed / 1000).toFixed(2);
  elements.errors.textContent = record.errors;
  elements.score.textContent = record.score;
  elements.result.textContent = `${record.speed}타/분 · 오타 ${record.errors}회 · ${record.score}점`;
  elements.result.hidden = false;
  elements['event-status'].hidden = true;
  elements.reload.hidden = true;
  needsBackup = false;
  filePrepared = false;
  failureReason = '';
  participant = null;
  result = null;
  obyeol.complete();
  recordCard.show(record, 'saved');
  transition('saved');
  message('저장 완료');
  login.finish();
}

const input = elements['typing-input'];
input.addEventListener('keydown', (event) => {
  deletionKey = event.key === 'Backspace'
    ? 'deleteContentBackward'
    : event.key === 'Delete' ? 'deleteContentForward' : '';
});
input.addEventListener('keyup', () => { deletionKey = ''; });
for (const name of ['paste', 'drop'])
  input.addEventListener(name, (event) => {
    event.preventDefault();
    message('직접 입력하세요.', true);
  });
input.addEventListener('beforeinput', (event) => {
  const type = event.inputType ?? '';
  pendingEdit = null;
  if (/Paste|Drop|Replacement|history|Yank/i.test(type)) {
    event.preventDefault();
    message('직접 입력하세요.', true);
  } else {
    pendingEdit = {
      inputType: deletionKey || type,
      start: input.selectionStart,
      end: input.selectionEnd,
    };
    if (pendingEdit.inputType.startsWith('insert')) beginTiming();
  }
});
input.addEventListener('compositionstart', () => {
  if (!['armed', 'running'].includes(status)) return;
  if (!deletionKey) beginTiming();
  engine = compositionStart(engine, { start: input.selectionStart, end: input.selectionEnd });
});
input.addEventListener('compositionend', () => {
  // Some IMEs end composition before dispatching the final input event.
  const edit = pendingEdit ?? (deletionKey ? { inputType: deletionKey } : null);
  if (edit && engine.composing && attempt)
    engine = commitInput(engine, input.value, attempt.text, edit);
  pendingEdit = null;
  process(input.value, true);
});
input.addEventListener('input', (event) => {
  const edit = pendingEdit ?? { inputType: deletionKey || event.inputType || '' };
  pendingEdit = null;
  process(input.value, false, edit);
});
window.addEventListener('blur', () => {
  if (status === 'running') invalidate('창 이탈로 중단했습니다. 기록은 저장하지 않았습니다.');
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && status === 'running')
    invalidate('창 이탈로 중단했습니다. 기록은 저장하지 않았습니다.');
});
window.addEventListener('beforeunload', (event) => {
  if (!['running', 'saving', 'failed'].includes(status)) return;
  event.preventDefault();
  event.returnValue = '';
});

elements.reload.addEventListener('click', () => {
  void prepareAttempt();
});
elements.retry.addEventListener('click', () => {
  if (result) void persist(result);
});
elements.rescue.addEventListener('click', async () => {
  if (!result || !needsBackup) return;
  try {
    const projectId = (await getPublicDb()).app.options.projectId;
    downloadFile(
      `typing-${result.id}.json`,
      JSON.stringify(
        { schemaVersion: 1, projectId, results: [{ ...result, syncState: 'pending' }] },
        null,
        2,
      ),
      'application/json',
    );
    filePrepared = true;
    updateControls();
  } catch (reason) {
    message(errorMessage(reason), true);
  }
});
elements['rescue-confirm'].addEventListener('click', () => {
  if (!filePrepared) return;
  needsBackup = false;
  updateControls();
  message('저장한 기록 파일을 운영진에게 전달하세요.');
  recordCard.status(status, needsBackup, filePrepared, failureReason);
});
function clearAttempt() {
  obyeol.reset();
  recordCard.reset();
  document.body.classList.remove('has-participant');
  pendingEdit = null;
  deletionKey = '';
  attempt = null;
  engine = initialInputState();
  startedAt = null;
  result = null;
  needsBackup = false;
  filePrepared = false;
  failureReason = '';
  elapsed = 0;
  loading = false;
  input.value = '';
  elements.elapsed.textContent = '0.0';
  elements.errors.textContent = '0';
  elements.score.textContent = '—';
  elements.result.hidden = true;
  transition('ready');
  message('');
}
const login = mountLogin({
  container: document.querySelector('#login'),
  adminPath: './admin/',
  onStudent(student) {
    const entering = !participant || participant.sessionId !== student.sessionId;
    if (entering) sessionVersion++;
    participant = student;
    document.body.classList.add('has-participant');
    document.querySelector('#student-view').hidden = false;
    updateControls();
    if (entering) void prepareAttempt();
  },
  canLogout() {
    if (loading || saving) return false;
    if (needsBackup)
      return confirm(
        '파일로 보관하지 않은 기록이 있습니다. 기록을 남기지 않고 로그아웃할까요?',
      );
    if (['running', 'failed'].includes(status))
      return confirm('진행 중인 기록을 닫고 로그아웃할까요?');
    return true;
  },
  canAutoLogout() {
    return !loading && !saving && !needsBackup && status !== 'running';
  },
  onLogout() {
    sessionVersion++;
    participant = null;
    document.querySelector('#student-view').hidden = true;
    clearAttempt();
  },
});
updateControls();
