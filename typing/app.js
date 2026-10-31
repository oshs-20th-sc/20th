import { getClients, errorMessage } from '../db/firebase.js';
import { readEvent, readChallenge } from '../db/database.js';
import { mountLogin } from '../login.js';
import { downloadFile } from '../common.js';
import {
  initialInputState,
  commitInput,
  compositionStart,
  compositionEnd,
  isComplete,
} from './engine.js';
import { calculateScore } from './scoring.js';
import { saveResult } from './storage.js';

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
}

function showChallenge(current) {
  elements['challenge-title'].textContent = current.title;
  elements['reference-keys'].textContent = current.referenceKeystrokes;
  elements['error-penalty'].textContent = current.errorPenalty ?? 20;
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
  elements['event-status'].textContent = !config.typingEnabled
    ? '접수 마감'
    : !challenge.enabled || challenge.deleted
      ? '문구 접수 중지'
      : `${challenge.practice ? '연습' : '공식'} · ${challenge.referenceKeystrokes}타`;
}

async function refresh() {
  loading = true;
  elements.reload.hidden = true;
  updateControls();
  try {
    const { deviceDb } = await getClients();
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

function process(value, endedComposition = false) {
  if (!['armed', 'running'].includes(status) || !attempt) return;
  if (value.length) beginTiming();
  engine = endedComposition
    ? compositionEnd(engine, value, attempt.text)
    : commitInput(engine, value, attempt.text);
  elements.errors.textContent = engine.errors;
  highlight(value);
  message(`입력 ${Array.from(value).length} / ${Array.from(attempt.text).length}자`);
  if (!isComplete(engine, attempt.text) || startedAt === null) return;
  elapsed = Math.max(1, performance.now() - startedAt);
  result = {
    id: crypto.randomUUID(),
    participantId: participant.studentId,
    displayName: participant.name,
    owner_uid: participant.uid,
    challengeId: attempt.challengeId,
    elapsedMs: elapsed,
    ...calculateScore(
      attempt.referenceKeystrokes,
      elapsed,
      engine.errors,
      attempt.errorPenalty,
    ),
    errors: engine.errors,
    completedAt: new Date().toISOString(),
    prizeReceived: false,
    practice: attempt.practice,
  };
  elements.elapsed.textContent = (elapsed / 1000).toFixed(2);
  elements.score.textContent = result.score;
  elements.result.textContent = `${result.speed}타/분 · 오타 ${result.errors}회 · ${result.score}점`;
  elements.result.hidden = false;
  void persist(result);
}

function invalidate(reason) {
  if (!['armed', 'running'].includes(status)) return;
  transition('invalid');
  message(reason, true);
}

async function prepareAttempt() {
  if (!participant || loading || status !== 'ready') return;
  const version = sessionVersion;
  try {
    const current = await refresh();
    if (version !== sessionVersion) return;
    if (
      !current.config.typingEnabled ||
      !current.challenge.enabled ||
      current.challenge.deleted
    ) {
      message('현재 접수할 수 없습니다.', true);
      return;
    }
    attempt = { ...current.challenge };
    engine = initialInputState();
    startedAt = null;
    elapsed = 0;
    result = null;
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
for (const name of ['paste', 'drop'])
  input.addEventListener(name, (event) => {
    event.preventDefault();
    message('직접 입력하세요.', true);
  });
input.addEventListener('beforeinput', (event) => {
  const type = event.inputType ?? '';
  if (/Paste|Drop|Replacement|history|Yank/i.test(type)) {
    event.preventDefault();
    message('직접 입력하세요.', true);
  } else if (type.startsWith('insert')) beginTiming();
});
input.addEventListener('compositionstart', () => {
  if (!['armed', 'running'].includes(status)) return;
  beginTiming();
  engine = compositionStart(engine);
});
input.addEventListener('compositionend', () => process(input.value, true));
input.addEventListener('input', () => process(input.value));
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
    const { projectId } = await getClients();
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
});
function clearAttempt() {
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
mountLogin({
  container: document.querySelector('#login'),
  adminPath: './admin/',
  onStudent(student) {
    const entering = !participant || participant.uid !== student.uid;
    if (entering) sessionVersion++;
    participant = student;
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
