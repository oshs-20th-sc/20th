/** Admin views and actions for typing records. */
import { adminContext } from '../db/firebase.js';
import { calculateScore } from '../typing/scoring.js';
import {
  deleteTyping,
  readTyping,
  readTypingResult,
  reviewTyping,
  saveTyping,
} from '../db/database.js';
import { downloadFile, escapeHtml as html } from '../common.js';
import {
  importResultFile,
  listLocalResults,
  pendingResults,
  resultsCsv,
  synchronizePending,
} from '../typing/storage.js';
import { readStudentByLogin } from '../db/students.js';
import {
  $,
  alertError,
  closeEditor,
  confirmDiscard,
  cursorPagination,
  data,
  field,
  freshEditor,
  invalidateListCache,
  resetResultPages,
  run,
  select,
  setStatus,
  submit,
  verification,
} from './shared.js';
import { loadStudentRoster } from './students.js';
import { renderTab } from './shared.js';
import { state } from './state.js';

export async function recordsView() {
  $('#view').innerHTML =
    `<div class="actions"><button id="new-result">추가</button><button id="reload">새로고침</button><button id="result-csv">CSV</button><button id="result-json">JSON</button></div>
    <div id="editor"></div><form id="result-filter" class="toolbar">${field('query', '학번·이름 검색', state.resultFilter.query)}
      ${select('version', '문구', state.resultFilter.version, [
        ['', '전체 문구 · 전체 시도'],
        ...state.challenges.map((item) => [
          item.challengeId,
          `${item.title} (${item.practice ? '연습' : '공식'})`,
        ]),
      ])}
      ${select('verification', '확인 상태', state.resultFilter.verification, [['all', '전체'], ...Object.entries(verification)])}
      ${select('view', '보기', state.resultFilter.view, [
        ['ranking', '학번별 최고 기록'],
        ['attempts', '전체 시도'],
      ])}<button>검색</button></form>
    <div class="table-scroll" id="result-list"></div><div class="actions" id="pagination"></div>
    <details class="panel"><summary>기기 백업</summary><p id="pending-count"></p><div class="actions"><button id="sync-pending">미전송 기록 접수</button><button id="local-json">기기 JSON</button><button id="import-results">기록 파일 불러오기</button><input id="result-file" type="file" accept=".json,application/json" hidden /></div></details>`;
  $('#new-result').onclick = () => resultEditor();
  $('#reload').onclick = () => renderTab(true);
  $('#result-filter').onsubmit = (event) => {
    event.preventDefault();
    if (state.busy || !confirmDiscard()) return;
    state.resultFilter = data(event.currentTarget);
    if (!state.resultFilter.version) state.resultFilter.view = 'attempts';
    resetResultPages();
    void renderTab();
  };
  $('#result-csv').onclick = () =>
    void run(async () => {
      const { db } = await adminContext();
      const [all, roster] = await Promise.all([readTyping(db), loadStudentRoster(db)]);
      downloadFile(
        'typing.csv',
        resultsCsv(scopedResults(all, roster), {
          rankedOnly: state.resultFilter.view !== 'attempts',
          includeRank: !!state.resultFilter.version,
        }),
        'text/csv;charset=utf-8',
      );
      setStatus('다운로드 완료');
    });
  $('#result-json').onclick = () =>
    void run(async () => {
      const all = await readTyping((await adminContext()).db);
      downloadFile(
        'typing.json',
        JSON.stringify({ schemaVersion: 1, results: all }, null, 2),
        'application/json',
      );
      setStatus('다운로드 완료');
    });
  $('#sync-pending').onclick = () =>
    void run(async () => {
      const result = await synchronizePending();
      await reloadResults();
      setStatus(
        `${result.synced}건 접수 · ${result.remaining}건 미전송${result.error ? ` · ${result.error}` : ''}`,
      );
    });
  $('#local-json').onclick = () =>
    void run(async () => {
      downloadFile(
        'typing-local.json',
        JSON.stringify(
          {
            schemaVersion: 1,
            projectId: (await adminContext()).db.app.options.projectId,
            results: await listLocalResults(),
          },
          null,
          2,
        ),
        'application/json',
      );
      setStatus('다운로드 완료');
    });
  $('#import-results').onclick = () => $('#result-file').click();
  $('#result-file').onchange = (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    void run(async () => {
      if (file.size > 5 * 1024 * 1024) throw new Error('5MB 이하의 기록 파일을 선택하세요.');
      let input;
      try {
        input = JSON.parse(await file.text());
      } catch {
        throw new Error('JSON 기록 파일을 확인하세요.');
      }
      const count = await importResultFile(input);
      await pendingCount();
      setStatus(`${count}건을 불러왔습니다. 미전송 기록 접수로 서버에 저장하세요.`);
    });
  };
  renderResults();
  await pendingCount();
}

export async function pendingCount() {
  const element = $('#pending-count');
  if (!element) return;
  try {
    element.textContent = `미전송 ${(await pendingResults()).length}건`;
  } catch {
    element.textContent = '기기 저장소 사용 불가';
  }
}

export function scopedResults(records = state.results, roster = state.students) {
  const aliases = new Map(roster.map((student) => [student.student_id, student.login_id]));
  return records
    .filter(
      (item) =>
        (!state.resultFilter.version || item.challengeId === state.resultFilter.version) &&
        (state.resultFilter.verification === 'all' ||
          item.verificationStatus === state.resultFilter.verification),
    )
    .map((item) => ({ ...item, loginId: aliases.get(item.participantId) ?? null }));
}

export async function reloadResults() {
  invalidateListCache('records');
  $('#editor')?.replaceChildren();
  resetResultPages();
  await renderTab();
}

export function renderResults() {
  const records = scopedResults();
  const ranking = state.resultFilter.view !== 'attempts';
  $('#result-list').innerHTML =
    `<table><caption>${ranking ? '학번별 최고 기록 · 점수 → 오타 → 시간' : '전체 시도 · 접수 최신순'}</caption><thead><tr>${ranking ? '<th>순위</th>' : ''}<th>참가자</th><th>점수</th><th>타수·오타</th><th>시간</th><th>확인</th><th>상품</th><th>편집</th></tr></thead><tbody>${
      records
        .map(
          (item) => `<tr>
    ${ranking ? `<td>${item.rank ?? '—'}${item.practice ? ' (연습)' : ''}</td>` : ''}<td>${html(item.displayName)}<small>${html(item.loginId || (/^[1-3][0-9]{4}$/.test(item.participantId) ? item.participantId : '미연결'))}</small></td><td>${item.score}</td><td>${item.speed} / ${item.errors}</td><td>${(item.elapsedMs / 1000).toFixed(2)}초</td>
    <td>${select(`review-${item.id}`, '확인', item.verificationStatus ?? 'pending', Object.entries(verification))}</td>
    <td><button data-prize="${item.id}"${item.practice || item.verificationStatus !== 'verified' ? ' disabled' : ''}>${item.prizeReceived ? '수령' : '미수령'}</button></td>
    <td><button data-edit="${item.id}"${state.challenges.some((challenge) => challenge.challengeId === item.challengeId) ? '' : ' disabled title="문구가 삭제되어 점수를 수정할 수 없습니다."'}>수정</button><button class="danger" data-delete="${item.id}">삭제</button></td></tr>`,
        )
        .join('') ||
      `<tr><td colspan="${ranking ? 8 : 7}">${ranking && state.resultFilter.verification === 'rejected' ? '제외 기록은 전체 시도에서 확인할 수 있습니다.' : '기록 없음'}</td></tr>`
    }</tbody></table>`;
  document.querySelectorAll('[name^="review-"]').forEach(
    (control) =>
      (control.onchange = () =>
        void run(async () => {
          const id = control.name.slice(7);
          const patch = {
            verificationStatus: control.value,
            ...(control.value !== 'verified' ? { prizeReceived: false } : {}),
          };
          try {
            await reviewTyping((await adminContext()).db, id, patch);
          } catch (reason) {
            control.value =
              state.results.find((item) => item.id === id)?.verificationStatus ?? 'pending';
            throw reason;
          }
          await reloadResults();
          setStatus('저장 완료');
        })),
  );
  document.querySelectorAll('[data-prize]').forEach(
    (button) =>
      (button.onclick = () =>
        void run(async () => {
          const item = state.results.find((item) => item.id === button.dataset.prize);
          const patch = { prizeReceived: !item.prizeReceived };
          await reviewTyping((await adminContext()).db, item.id, patch);
          await reloadResults();
          setStatus('저장 완료');
        })),
  );
  document
    .querySelectorAll('[data-edit]')
    .forEach(
      (button) =>
        (button.onclick = () =>
          resultEditor(state.results.find((item) => item.id === button.dataset.edit))),
    );
  document.querySelectorAll('[data-delete]').forEach(
    (button) =>
      (button.onclick = () => {
        if (!confirm('기록을 삭제할까요? 되돌릴 수 없습니다.')) return;
        void run(async () => {
          await deleteTyping((await adminContext()).db, button.dataset.delete);
          await reloadResults();
          setStatus('삭제 완료');
        });
      }),
  );
  cursorPagination('records');
}

export function resultEditor(result) {
  freshEditor(result, readTypingResult, openResultEditor);
}

export function openResultEditor(result) {
  const creationKey = crypto.randomUUID();
  const linked = state.students.find((student) => student.student_id === result?.participantId);
  const number =
    linked?.login_id ||
    (/^[1-3][0-9]{4}$/.test(result?.participantId ?? '') ? result.participantId : '');
  $('#editor').innerHTML =
    `<form id="result-editor" class="panel"><h2>${result ? '기록 수정' : '기록 추가'}</h2>
    <div class="form-grid">${field('studentNumber', '학번', number, 'text', `${result ? '' : 'required '}pattern="[1-3][0-9]{4}" maxlength="5"`)}${field('displayName', '이름', result?.displayName, 'text', 'required maxlength="30"')}</div>
    ${select(
      'challengeId',
      '문구',
      result?.challengeId ?? state.resultFilter.version,
      state.challenges.map((item) => [item.challengeId, item.title]),
    )}
    <div class="form-grid">${field('seconds', '시간 (초)', result ? result.elapsedMs / 1000 : '', 'number', 'required min="0.001" max="3600" step="any"')}${field('errors', '오타', result?.errors ?? 0, 'number', 'required min="0" max="10000" step="1"')}</div>
    ${select('verificationStatus', '확인 상태', result?.verificationStatus ?? 'pending', Object.entries(verification))}<p id="score-preview"></p>
    <div class="actions"><button>저장</button><button id="close-editor" type="button">취소</button></div></form>`;
  $('#editor').scrollIntoView({ block: 'start' });
  $('#close-editor').onclick = closeEditor;
  const form = $('#result-editor');
  let studentLookup = 0;
  form.elements.studentNumber.addEventListener('change', async () => {
    const number = form.elements.studentNumber.value;
    const lookup = ++studentLookup,
      sequence = state.viewSequence;
    if (!/^[1-3][0-9]{4}$/.test(number)) return;
    try {
      const student = await readStudentByLogin((await adminContext()).db, number);
      if (
        !form.isConnected ||
        lookup !== studentLookup ||
        sequence !== state.viewSequence ||
        form.elements.studentNumber.value !== number
      )
        return;
      if (student) form.elements.displayName.value = student.student_name;
      else setStatus('현재 학번이 연결된 학생이 없습니다.', true);
    } catch (reason) {
      if (form.isConnected && lookup === studentLookup && sequence === state.viewSequence)
        alertError(reason);
    }
  });
  form.oninput = (event) => {
    if (event.target.name === 'studentNumber') {
      const selected = state.students.find(
        (item) => item.login_id === form.elements.studentNumber.value,
      );
      if (selected) form.elements.displayName.value = selected.student_name;
    }
    const values = data(form);
    const challenge = state.challenges.find((item) => item.challengeId === values.challengeId);
    try {
      const score = calculateScore(
        challenge.referenceKeystrokes,
        Number(values.seconds) * 1000,
        Number(values.errors),
        challenge.errorPenalty,
      );
      $('#score-preview').textContent = `${score.speed}타 · ${score.score}점`;
    } catch {
      $('#score-preview').textContent = '';
    }
  };
  submit(form, async (values) => {
    const { db, uid } = await adminContext();
    const challenge = state.challenges.find((item) => item.challengeId === values.challengeId);
    const student = values.studentNumber
      ? await readStudentByLogin(db, values.studentNumber)
      : null;
    if (values.studentNumber && !student)
      throw new Error('현재 학번이 연결된 학생을 선택하세요.');
    if (!student && !result) throw new Error('학번을 확인하세요.');
    await saveTyping(
      db,
      uid,
      result?.id ?? null,
      {
        participantId: student?.student_id ?? result.participantId,
        displayName: student?.student_name ?? values.displayName,
        challengeId: values.challengeId,
        elapsedMs: Number(values.seconds) * 1000,
        errors: Number(values.errors),
        verificationStatus: values.verificationStatus,
        prizeReceived:
          !!result?.prizeReceived &&
          !challenge.practice &&
          values.verificationStatus === 'verified',
      },
      creationKey,
    );
    await reloadResults();
    setStatus('저장 완료');
  });
}
