/** Admin views and actions for typing records. */
import { adminContext } from '../db/firebase.js?v=ops-20261113';
import {
  deleteTyping,
  readTyping,
  reviewTyping,
} from '../db/database.js?v=typing-fix-20261113';
import { downloadFile, escapeHtml as html } from '../common.js';
import {
  importResultFile,
  diagnosePendingResults,
  listLocalResults,
  pendingResults,
  resultsCsv,
  synchronizePending,
} from '../typing/storage.js?v=typing-fix-20261113';
import {
  $,
  confirmDiscard,
  cursorPagination,
  data,
  field,
  invalidateListCache,
  resetResultPages,
  run,
  select,
  setStatus,
  submit,
  verification,
} from './shared.js?v=typing-fix-20261113';
import { renderTab } from './shared.js?v=typing-fix-20261113';
import { state } from './state.js?v=typing-fix-20261113';

const CURRENT_STUDENT_NUMBER = /^[1-3][0-9]{4}$/;

function isRecordEntry(result) {
  return result?.entryMode === 'record' ||
    result?.entry_mode === 'record' ||
    CURRENT_STUDENT_NUMBER.test(result?.participantId ?? '');
}

function pendingDiagnosisText(item, index) {
  const id = String(item.id ?? '');
  const label = `기록 ${index + 1}${id ? ` · ${id.slice(0, 8)}` : ''}: `;
  switch (item.kind) {
    case 'already_saved':
      return `${label}이 UUID의 영수증과 서버 기록이 일치합니다. 이미 접수됐습니다.`;
    case 'receipt_without_result':
      return `${label}영수증은 이 내용과 일치하지만 서버 기록 문서는 없습니다. 접수 후 기록이 삭제됐거나 서버 상태가 달라졌을 수 있어 운영진 확인이 필요합니다.`;
    case 'receipt_mismatch':
      return `${label}같은 UUID에 다른 내용의 접수 영수증이 있습니다. 이 백업을 다시 전송하지 말고 운영진에게 확인해 주세요.`;
    case 'claim_used':
      return `${label}공식 참여 키가 다른 접수 ID에 이미 연결되어 있습니다. ${item.resultExists ? '기존 서버 기록이 남아 있습니다.' : '연결된 서버 기록은 현재 없지만 참여 키는 남아 있습니다.'} 중복 제한에 따라 이 전송은 거부됩니다.`;
    case 'claim_points_here':
      return `${label}공식 참여 키는 이 접수 ID를 가리키지만 UUID 영수증은 없습니다. 서버 데이터가 일치하지 않아 운영진 확인이 필요합니다.`;
    case 'claim_inconsistent':
      return `${label}공식 참여 키의 내용이 예상 형식과 다릅니다. 운영진 확인이 필요합니다.`;
    case 'challenge_changed':
      return `${label}현재 선택된 대회 문구가 이 기록의 문구와 다릅니다. 저장 당시 설정은 관리자 기록으로 확인해 주세요.`;
    case 'challenge_unavailable':
      return `${label}현재 문구가 비활성화되었거나 삭제 상태입니다. 저장 당시 설정은 관리자 기록으로 확인해 주세요.`;
    case 'challenge_reference_mismatch':
      return `${label}현재 문구의 기준 타수가 문구 내용에서 다시 계산한 값과 다릅니다. 문구 설정을 확인해 주세요.`;
    case 'invalid_payload':
      return `${label}기기 기록이 현재 서버 검증을 통과하지 못합니다: ${item.reason}`;
    case 'rules_rejection_unresolved':
      return `${label}영수증과 공식 참여 키가 없고 현재 문구·점수 검증은 통과합니다. 저장 당시 원인은 현재 정보만으로 확정할 수 없습니다. 배포된 Firestore 규칙과 프로젝트 설정을 확인해 주세요.`;
    case 'not_record_entry':
      return `${label}이 진단은 학번·이름 직접 입력 기록만 지원합니다. 기존 계정 백업은 별도로 확인해 주세요.`;
    case 'invalid_local_id':
      return `${label}기기 백업의 접수 ID 형식이 올바르지 않습니다.`;
    case 'invalid_local_identity':
      return `${label}기기 백업의 학번 또는 이름 형식이 올바르지 않습니다.`;
    case 'read_failed':
      return `${label}관리자 읽기 확인에 실패했습니다: ${item.reason}`;
    default:
      return `${label}원인을 분류하지 못했습니다. 운영진에게 확인해 주세요.`;
  }
}

function showPendingDiagnoses(result) {
  const output = $('#pending-diagnostics');
  output.replaceChildren();
  output.hidden = false;
  if (!result.total) {
    output.textContent = '기기에서 미전송 기록을 찾지 못했습니다.';
    return;
  }
  const list = document.createElement('ul');
  result.diagnostics.forEach((item, index) => {
    const line = document.createElement('li');
    line.textContent = pendingDiagnosisText(item, index);
    list.append(line);
  });
  if (result.omitted) {
    const line = document.createElement('li');
    line.textContent = `기기 기록 ${result.omitted}건은 한 번에 최대 50건까지만 확인했습니다.`;
    list.append(line);
  }
  output.append(list);
}

export async function recordsView() {
  $('#view').innerHTML =
    `<div class="actions"><button id="reload">새로고침</button><button id="result-csv">CSV</button><button id="result-json">JSON</button></div>
    <form id="result-filter" class="toolbar">${field('query', '학번·이름 검색', state.resultFilter.query)}
      ${select('version', '문구', state.resultFilter.version, [
        ['', '전체 문구 · 전체 시도'],
        ...state.challenges.map((item) => [
          item.challengeId,
          item.title,
        ]),
      ])}
      ${select('verification', '확인 상태', state.resultFilter.verification, [['all', '전체'], ...Object.entries(verification)])}
      ${select('view', '보기', state.resultFilter.view, [
        ['ranking', '학번별 최고 기록'],
        ['attempts', '전체 시도'],
      ])}<button>검색</button></form>
    <div class="table-scroll" id="result-list"></div><div class="actions" id="pagination"></div>
    <details class="panel"><summary>기기 백업</summary><p id="pending-count"></p><div class="actions"><button id="sync-pending">미전송 기록 전송</button><button id="diagnose-pending">저장 실패 원인 확인</button><button id="local-json">기기 JSON</button><button id="import-results">기록 파일 불러오기</button><input id="result-file" type="file" accept=".json,application/json" hidden /></div><div id="pending-diagnostics" role="status" aria-live="polite" hidden></div></details>`;
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
      const all = await readTyping(db);
      downloadFile(
        'typing.csv',
        resultsCsv(scopedResults(all), {
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
        `${result.synced}건 저장 · ${result.remaining}건 미전송${result.error ? ` · ${result.error}` : ''}`,
      );
    });
  $('#diagnose-pending').onclick = () =>
    void run(async () => {
      const result = await diagnosePendingResults();
      showPendingDiagnoses(result);
      setStatus('읽기 전용 원인 확인 완료');
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
      setStatus(`${count}건을 불러왔습니다. 미전송 기록 전송으로 서버에 저장하세요.`);
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

export function scopedResults(records = state.results) {
  return records
    .filter(
      (item) =>
        (!state.resultFilter.version || item.challengeId === state.resultFilter.version) &&
        (state.resultFilter.verification === 'all' ||
          item.verificationStatus === state.resultFilter.verification),
    )
    .map((item) => ({
      ...item,
      loginId: isRecordEntry(item) ? item.participantId : null,
    }));
}

export async function reloadResults() {
  invalidateListCache('records');
  resetResultPages();
  await renderTab();
}

export function renderResults() {
  const records = scopedResults();
  const ranking = state.resultFilter.view !== 'attempts';
  const officialCounts = new Map();
  records.forEach((item) => {
    if (!item.practice && CURRENT_STUDENT_NUMBER.test(item.participantId ?? '')) {
      const key = `${item.challengeId}:${item.participantId}`;
      officialCounts.set(key, (officialCounts.get(key) ?? 0) + 1);
    }
  });
  $('#result-list').innerHTML =
    `<table><caption>${ranking ? '학번별 최고 기록 · 점수 → 오타 → 시간' : '전체 시도 · 최근순'}</caption><thead><tr>${ranking ? '<th>순위</th>' : ''}<th>참가자</th><th>점수</th><th>타수·오타</th><th>시간</th><th>확인</th><th>상품</th><th>관리</th></tr></thead><tbody>${
      records
        .map(
          (item) => {
            const duplicateKey = `${item.challengeId}:${item.participantId}`;
            const duplicate = !item.practice &&
              (Boolean(item.duplicateOf) || (officialCounts.get(duplicateKey) ?? 0) > 1);
            const identity = item.loginId || (isRecordEntry(item) ? '—' : '기존 계정');
            const identityNote = isRecordEntry(item) ? `${identity} · 직접 입력` : identity;
            return `<tr>
    ${ranking ? `<td>${item.rank ?? '—'}</td>` : ''}<td>${html(item.displayName)}<small>${html(identityNote)}${duplicate ? ' · 학번 중복 확인' : ''}</small></td><td>${item.score}</td><td>${item.speed} / ${item.errors}</td><td>${(item.elapsedMs / 1000).toFixed(2)}초</td>
    <td>${select(`review-${item.id}`, '확인', item.verificationStatus ?? 'pending', Object.entries(verification))}</td>
    <td><button data-prize="${item.id}"${item.practice || item.verificationStatus !== 'verified' ? ' disabled' : ''}>${item.prizeReceived ? '수령' : '미수령'}</button></td>
    <td><button class="danger" data-delete="${item.id}">기록 삭제</button></td></tr>`;
          },
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
