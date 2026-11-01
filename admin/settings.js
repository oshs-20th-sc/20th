/** Event, session, and typing challenge settings. */
import { adminContext } from '../db/firebase.js';
import {
  changeChallenge,
  deleteChallenge,
  readChallenges,
  readEvent,
  saveChallenge,
  setEvent,
} from '../db/database.js';
import { countKeystrokes } from '../typing/scoring.js';
import { escapeHtml as html } from '../common.js';
import { readSessionPolicy, saveSessionPolicy } from '../db/students.js';
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
} from './shared.js';
import { state, feature } from './state.js';

export function settingsView() {
  $('#view').innerHTML = `<form class="panel" id="event-settings"><h2>운영 설정</h2>
    ${select('phase', '단계', state.config?.phase ?? 'B', [
      ['A', 'A · 접수'],
      ['B', 'B · 마감'],
      ['C', 'C · 공개'],
    ])}
    ${checkbox('typingEnabled', '타자 접수', state.config?.typingEnabled)}${checkbox('submissionsEnabled', '글 접수', state.config?.submissionsEnabled)}${checkbox('welcomeEnabled', '승인 글 공개', state.config?.welcomeEnabled)}
    ${select(
      'activeChallengeId',
      '사용 문구',
      state.config?.activeChallengeId ?? '',
      state.challenges
        .filter((item) => item.enabled && !item.deleted)
        .map((item) => [
          item.challengeId,
          `${item.title} · 오타당 ${item.errorPenalty ?? 20}점 감점`,
        ]),
    )}
    <p class="muted">접수는 A 단계에서만 가능합니다.</p><button>저장</button></form>
    <form class="panel" id="session-policy"><h2>학생 로그인 설정</h2>
    ${checkbox('boothMode', '공용 기기 모드', state.sessionPolicy.boothMode)}
    ${field('idleMinutes', '미사용 로그아웃 (분)', state.sessionPolicy.idleMinutes, 'number', 'required min="1" max="120" step="1"')}
    ${field('academicYear', '기준 학년도', state.sessionPolicy.academicYear, 'number', 'required min="2020" max="2100" step="1"')}
    <button>저장</button></form>
    ${feature === 'typing' ? '<section class="panel"><h2>문구</h2><button id="new-challenge">추가</button><div id="challenges"></div></section><div id="editor"></div>' : ''}`;
  submit($('#event-settings'), async (values) => {
    await setEvent((await adminContext()).db, values.phase, {
      typingEnabled: !!values.typingEnabled,
      submissionsEnabled: !!values.submissionsEnabled,
      welcomeEnabled: !!values.welcomeEnabled,
      activeChallengeId: values.activeChallengeId,
    });
    state.config = await readEvent((await adminContext()).db);
    invalidateListCache('records');
    if (feature === 'typing') renderChallenges();
    setStatus('저장 완료');
  });
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
      ) => `<article class="record"><strong>${html(item.title)}</strong> · ${item.practice ? '연습' : '공식'} · ${item.referenceKeystrokes}타 · 오타당 ${item.errorPenalty ?? 20}점 감점
    <p class="letter-content">${html(item.text)}</p><small>${html(item.challengeId)}</small><div class="actions">
    <button data-edit="${item.challengeId}">수정</button><button data-toggle="${item.challengeId}"${item.challengeId === state.config?.activeChallengeId ? ' disabled' : ''}>${item.enabled ? '접수 끄기' : '접수 켜기'}</button><button class="danger" data-delete="${item.challengeId}"${item.challengeId === state.config?.activeChallengeId ? ' disabled' : ''}>영구 삭제</button></div></article>`,
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
        '문구를 영구 삭제할까요? 기존 타자 기록은 보존되지만 이 문구로 새 기록을 접수하거나 과거 점수를 수정할 수 없습니다.',
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
      } else await changeChallenge(db, id, { enabled: !item.enabled });
      invalidateListCache('records');
      state.challenges = await readChallenges(db);
      settingsView();
      setStatus(button.dataset.delete ? '문구 영구 삭제 완료 · 기존 기록 보존' : '저장 완료');
    });
  };
}

export function challengeEditor(challenge) {
  if (!confirmDiscard($('#editor'))) return;
  const creationKey = challenge ? undefined : crypto.randomUUID();
  $('#editor').innerHTML =
    `<form id="challenge-editor" class="panel"><h2>문구 ${challenge ? '수정' : '추가'}</h2>
    ${field('title', '제목', challenge?.title, 'text', 'required maxlength="80"')}${area('text', '문구', challenge?.text)}${field('errorPenalty', '오타 1회당 감점', challenge ? (challenge.errorPenalty ?? 20) : 3, 'number', 'required min="0" max="100" step="1"')}${checkbox('practice', '연습', challenge?.practice ?? true)}
    <p id="keys"></p><div class="actions"><button>${challenge ? '수정 저장' : '추가'}</button><button type="button" id="close-editor">취소</button></div></form>`;
  $('#editor').scrollIntoView({ block: 'start' });
  $('#close-editor').onclick = closeEditor;
  $('#challenge-editor').oninput = (event) => {
    $('#keys').textContent =
      `${countKeystrokes(event.currentTarget.elements.text.value.trim().replace(/\s+/g, ' '))}타`;
  };
  submit($('#challenge-editor'), async (values) => {
    if (!confirmDiscard($('#event-settings'))) {
      setStatus();
      return false;
    }
    const { db } = await adminContext();
    await saveChallenge(
      db,
      {
        title: values.title,
        text: values.text,
        practice: !!values.practice,
        errorPenalty: Number(values.errorPenalty),
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
