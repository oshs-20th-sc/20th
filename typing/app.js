import { mountObyeol } from './obyeol.js?v=obyeol-ui-v6';
import { mountRecordCard } from './record-card.js?v=obyeol-ui-v6';
import { getPublicDb, errorMessage } from '../db/firebase.js?v=ops-20261113';
import { readEvent, readChallenge } from '../db/database.js?v=typing-fix-20261113';
import { mountLogin } from '../login.js?v=ops-20261113';
import { downloadFile } from '../common.js?v=record-entry-1';
import {
  initialInputState,
  commitInput,
  compositionStart,
  compositionEnd,
  isComplete,
} from './engine.js?v=typing-fix-20261113';
import { calculateScore, EVENT_ERROR_PENALTY } from './scoring.js?v=record-entry-1';
import { saveResult } from './storage.js?v=typing-fix-20261113';

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
    'reference-keys',
    'error-penalty',
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
    armed: '첫 입력 대기',
    running: '측정 중',
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
  recordCard.status(next, needsBackup, filePrepared);
}

function showChallenge(current) {
  elements['challenge-title'].textContent = current.title;
  elements['reference-keys'].textContent = current.referenceKeystrokes;
  elements['error-penalty'].textContent = EVENT_ERROR_PENALTY;
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
  const range = engine.composing ? engine.compositionRange : null;
  const oldChars = Array.from(engine.committed);
  const composingStart = range ? Array.from(engine.committed.slice(0, range.start)).length : oldChars.length;
  const replacedEnd = range ? Array.from(engine.committed.slice(0, range.end)).length : oldChars.length;
  const composingEnd = chars.length - (oldChars.length - replacedEnd);
  spans.forEach((span, index) => {
    span.className =
      engine.composing && index >= composingStart && index < composingEnd
        ? 'composing'
        : index < chars.length
        ? chars[index] === target[index]
          ? 'correct'
          : 'incorrect'
        : index === chars.length
          ? 'cursor'
          : '';
  });
  // Follow long prompts inside their own panel without scrolling the page or input.
  const cursor = spans[Math.min(chars.length, spans.length - 1)];
  const panel = elements.challenge;
  if (cursor && panel.scrollHeight > panel.clientHeight) {
    const top = cursor.offsetTop;
    if (top < panel.scrollTop || top + cursor.offsetHeight > panel.scrollTop + panel.clientHeight)
      panel.scrollTop = Math.max(0, top - panel.clientHeight / 2);
  }
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
  try {
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
    message('첫 입력부터 측정합니다.');
    elements['typing-input'].focus();
  } catch (reason) {
    message(errorMessage(reason), true);
  }
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
  recordCard.status(status, needsBackup, filePrepared);
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
  elapsed = 0;
  input.value = '';
  elements.elapsed.textContent = '0.0';
  elements.errors.textContent = '0';
  elements.score.textContent = '—';
  elements.result.hidden = true;
  transition('ready');
  message('문구를 입력하면 측정이 시작됩니다.');
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
