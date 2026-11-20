/** Event, session, and typing challenge settings. */
import { adminContext } from '../db/firebase.js?v=record-time-1';
import {
  deleteChallenge,
  readChallenges,
  readEvent,
  saveChallenge,
  selectChallenge,
  setEvent,
} from '../db/database.js?v=record-time-1';
import { countKeystrokes } from '../typing/scoring.js';
import { escapeHtml as html } from '../common.js';
import { readSessionPolicy, saveSessionPolicy } from '../db/database.js?v=record-time-1';
import {
  $,
  area,
  checkbox,
  closeEditor,
  confirmDiscard,
  field,
  invalidateListCache,
  resetResultPages,
  run,
  select,
  setStatus,
  submit,
} from './shared.js?v=record-time-1';
import { state, feature } from './state.js?v=record-time-1';

export function settingsView() {
  const eventSettings = feature === 'typing'
    ? `<form class="panel" id="typing-challenge-settings"><h2>사용 문구</h2>
      ${select(
        'activeChallengeId',
        '현재 문구',
        state.config?.activeChallengeId ?? '',
        state.challenges
          .filter((item) => !item.deleted)
          .map((item) => [item.challengeId, item.title]),
      )}
      <button${state.challenges.some((item) => !item.deleted) ? '' : ' disabled'}>적용</button></form>`
    : `<form class="panel" id="event-settings"><h2>운영 설정</h2>
      ${select('phase', '단계', state.config?.phase ?? 'B', [
        ['A', 'A · 접수'],
        ['B', 'B · 마감'],
        ['C', 'C · 공개'],
      ])}
      ${checkbox('submissionsEnabled', '글 접수', state.config?.submissionsEnabled)}${checkbox('welcomeEnabled', '승인 글 공개', state.config?.welcomeEnabled)}
      <p class="muted">행사일 2026. 11. 23.(월) · 점심시간 현장 참여</p>
      <p class="muted">정확한 점심시간은 운영진 현장 안내에 따릅니다.</p><button>저장</button></form>`;
  $('#view').innerHTML = `${eventSettings}
    <form class="panel" id="session-policy"><h2>공용 기기 설정</h2>
    ${checkbox('boothMode', '공용 기기 모드', state.sessionPolicy.boothMode)}
    ${field('idleMinutes', '미사용 로그아웃 (분)', state.sessionPolicy.idleMinutes, 'number', 'required min="1" max="120" step="1"')}
    <button>저장</button></form>
    ${feature === 'typing' ? '<section class="panel"><h2>문구</h2><button id="new-challenge">추가</button><div id="challenges"></div></section><div id="editor"></div>' : ''}`;
  if (feature === 'typing') {
    submit($('#typing-challenge-settings'), async (values) => {
      const { db } = await adminContext();
      await selectChallenge(db, values.activeChallengeId);
      state.config = await readEvent(db);
      state.challenges = await readChallenges(db);
      invalidateListCache('records');
      settingsView();
      setStatus('사용 문구 변경 완료');
    });
  } else {
    submit($('#event-settings'), async (values) => {
      const { db } = await adminContext();
      const options = {
        submissionsEnabled: !!values.submissionsEnabled,
        welcomeEnabled: !!values.welcomeEnabled,
      };
      if (state.config?.activeChallengeId)
        options.activeChallengeId = state.config.activeChallengeId;
      await setEvent(db, values.phase, options);
      state.config = await readEvent(db);
      setStatus('저장 완료');
    });
  }
  submit($('#session-policy'), async (values) => {
    const { db } = await adminContext();
    await saveSessionPolicy(db, { ...values, boothMode: !!values.boothMode });
    state.sessionPolicy = await readSessionPolicy(db);
    setStatus('로그인 설정 저장 완료');
  });
  if (feature !== 'typing') return;
  $('#new-challenge').onclick = () => challengeEditor();
  renderChallenges();
}

export function renderChallenges() {
  $('#challenges').innerHTML = state.challenges
    .filter((item) => !item.deleted)
    .map(
      (
        item,
      ) => `<article class="record"><strong>${html(item.title)}</strong> · ${item.referenceKeystrokes}타 · 오타당 3점 감점
    <p class="letter-content">${html(item.text)}</p><small>${html(item.challengeId)}</small><div class="actions">
    <button data-edit="${item.challengeId}">수정</button><button class="danger" data-delete="${item.challengeId}"${item.challengeId === state.config?.activeChallengeId ? ' disabled' : ''}>영구 삭제</button></div></article>`,
    )
    .join('');
  $('#challenges').onclick = (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const id = Object.values(button.dataset)[0];
    const item = state.challenges.find((item) => item.challengeId === id);
    if (button.dataset.edit) {
      challengeEditor(item);
      return;
    }
    if (!confirmDiscard()) return;
    if (
      button.dataset.delete &&
      !confirm(
        '문구를 영구 삭제할까요? 기존 타자 기록은 보존되지만 이 문구로 새 기록을 저장할 수 없습니다.',
      )
    )
      return;
    void run(async () => {
      const { db } = await adminContext();
      if (button.dataset.delete) {
        await deleteChallenge(db, id);
        if (state.resultFilter.version === id) {
          state.resultFilter.version = '';
          state.resultFilter.view = 'attempts';
          resetResultPages();
        }
      }
      invalidateListCache('records');
      state.challenges = await readChallenges(db);
      settingsView();
      setStatus('문구 영구 삭제 완료 · 기존 기록 보존');
    });
  };
}

export function challengeEditor(challenge) {
  if (!confirmDiscard($('#editor')) || !confirmDiscard($('#typing-challenge-settings'))) return;
  const creationKey = challenge ? undefined : crypto.randomUUID();
  $('#editor').innerHTML =
    `<form id="challenge-editor" class="panel"><h2>문구 ${challenge ? '수정' : '추가'}</h2>
    ${field('title', '제목', challenge?.title, 'text', 'required maxlength="80"')}${area('text', '문구', challenge?.text)}
    <p class="muted">오타당 3점 감점합니다.</p>
    <p id="keys"></p><div class="actions"><button>${challenge ? '수정 저장' : '추가'}</button><button type="button" id="close-editor">취소</button></div></form>`;
  $('#editor').scrollIntoView({ block: 'start' });
  $('#close-editor').onclick = closeEditor;
  $('#challenge-editor').oninput = (event) => {
    $('#keys').textContent =
      `${countKeystrokes(event.currentTarget.elements.text.value.trim().replace(/\s+/g, ' '))}타`;
  };
  submit($('#challenge-editor'), async (values) => {
    const { db } = await adminContext();
    await saveChallenge(
      db,
      {
        title: values.title,
        text: values.text,
        practice: false,
      },
      challenge,
      creationKey,
    );
    state.challenges = await readChallenges(db);
    invalidateListCache('records');
    settingsView();
    setStatus(challenge ? '문구 수정 완료' : '문구 추가 완료');
  });
}
