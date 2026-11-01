/** Admin actions for submitted letters. */
import { adminContext } from '../db/firebase.js';
import {
  deleteLetter,
  exportFirebase,
  purgeLetter,
  readLetter,
  readLetterHistory,
  restoreLetter,
  reviewLetters,
  saveLetter,
  synchronizePublicLetters,
} from '../db/database.js';
import { downloadFile, escapeHtml as html, koreanDate } from '../common.js';
import {
  $,
  area,
  checkbox,
  closeEditor,
  confirmDiscard,
  cursorPagination,
  data,
  field,
  freshEditor,
  invalidateListCache,
  labels,
  resetLetterPages,
  run,
  select,
  setStatus,
  submit,
} from './shared.js';
import { renderTab } from './shared.js';
import { state } from './state.js';

export function lettersView() {
  const trash = state.letterFilter.status === 'trash';
  $('#view').innerHTML =
    `<div class="actions"><button id="new-letter">글 추가</button><button id="reload">새로고침</button><button id="show-letter-history">변경 이력</button></div>
    <section id="all-letter-history" class="panel" aria-label="글 변경 이력" hidden></section>
    <div id="editor"></div><form id="letter-filter" class="toolbar">
      ${field('query', '본문·별명 검색', state.letterFilter.query)}${select('status', '상태', state.letterFilter.status, [['', '전체'], ...Object.entries(labels), ['trash', '휴지통']])}
      ${select('sort', '작성일', state.letterFilter.sort, [
        ['desc', '최신순'],
        ['asc', '오래된 순'],
      ])}<button>검색</button></form>
    ${trash ? '<p class="muted">복원한 글은 검토 대기로 돌아갑니다.</p>' : `<div class="selection-bar"><label class="checkbox"><input type="checkbox" id="select-letters">이 페이지 선택</label><span id="selected-count">0건 선택</span><button id="approve-selected" disabled>선택 승인</button><button id="reject-selected" disabled>선택 제외</button></div>`}
    <div id="letter-list"></div><div id="pagination" class="actions"></div>
    <details class="panel"><summary>백업·내보내기</summary><div class="actions">
      <button data-export="all:json">전체 JSON</button><button data-export="all:csv">글 CSV</button><button data-export="public:json">입학식용 letters.json</button><button id="sync-public">공개 내용 동기화</button></div>
      <p class="muted">letters.json을 welcome/에 넣고 배포하면 DB 없이 열람합니다. 공개 중단·수정도 파일을 바꾸거나 제거한 뒤 재배포해야 합니다.</p></details>`;
  $('#new-letter').onclick = () => letterEditor();
  $('#show-letter-history').onclick = () => toggleLetterHistory(null, $('#all-letter-history'));
  $('#reload').onclick = () => renderTab(true);
  $('#letter-filter').onsubmit = (event) => {
    event.preventDefault();
    if (state.busy || !confirmDiscard()) return;
    state.letterFilter = data(event.currentTarget);
    resetLetterPages();
    void renderTab();
  };
  if (!trash) {
    $('#select-letters').onchange = (event) => {
      state.selectedLetters.clear();
      if (event.currentTarget.checked)
        state.letters.forEach((item) => state.selectedLetters.add(item.id));
      document.querySelectorAll('[data-select-letter]').forEach((control) => {
        control.checked = state.selectedLetters.has(control.dataset.selectLetter);
      });
      updateLetterSelection();
    };
    $('#approve-selected').onclick = () =>
      changeLetterStatus([...state.selectedLetters], 'approved');
    $('#reject-selected').onclick = () =>
      changeLetterStatus([...state.selectedLetters], 'rejected');
  }
  $('#sync-public').onclick = () =>
    void run(async () =>
      setStatus(`${await synchronizePublicLetters((await adminContext()).db)}건 반영`),
    );
  bindExports();
  renderLetters();
  if (!trash) updateLetterSelection();
}

export function bindExports() {
  document.querySelectorAll('[data-export]').forEach(
    (button) =>
      (button.onclick = () =>
        void run(async () => {
          const [scope, format] = button.dataset.export.split(':');
          const file = await exportFirebase(scope, format);
          downloadFile(file.filename, file.content, file.mime);
          setStatus('다운로드 완료');
        })),
  );
}

export function renderLetters() {
  const trash = state.letterFilter.status === 'trash';
  $('#letter-list').innerHTML =
    state.letters
      .map(
        (letter) => `<article class="panel letter-card">
    <div class="section-top"><div class="record-heading">${trash ? '' : `<input type="checkbox" data-select-letter="${letter.id}" aria-label="${html(`${letter.nickname || '익명'} 글 선택`)}">`}<strong>${html(letter.nickname || '익명')}</strong></div><span class="badge" data-status="${html(trash ? 'trash' : letter.status)}">${html(trash ? '휴지통' : labels[letter.status])}</span></div>
    <p class="letter-content">${html(letter.content)}</p><small>${html(koreanDate(letter.created_at))} · 순서 ${letter.publish_order ?? '미지정'}</small>
    <p class="muted">${html(letterAuthor(letter))}</p>
    <div class="actions">${trash ? `<button data-restore-letter="${letter.id}">복원</button><button class="danger" data-purge-letter="${letter.id}">영구 삭제</button>` : `<button data-review-letter="${letter.id}" data-review-status="approved"${letter.status === 'approved' ? ' disabled' : ''}>승인</button><button data-review-letter="${letter.id}" data-review-status="rejected"${letter.status === 'rejected' ? ' disabled' : ''}>제외</button><button data-edit="${letter.id}">수정</button>${state.students.some((student) => student.student_id === letter.owner_uid) ? `<button data-letter-student="${letter.id}">작성 계정</button>` : ''}<button class="danger" data-delete="${letter.id}">휴지통</button>`}<button data-letter-history="${letter.id}">이력</button></div><div data-history-for="${letter.id}" hidden></div></article>`,
      )
      .join('') || '<p>글 없음</p>';
  document.querySelectorAll('[data-select-letter]').forEach((control) => {
    control.onchange = () => {
      if (control.checked) state.selectedLetters.add(control.dataset.selectLetter);
      else state.selectedLetters.delete(control.dataset.selectLetter);
      updateLetterSelection();
    };
  });
  document.querySelectorAll('[data-review-letter]').forEach((button) => {
    button.onclick = () =>
      changeLetterStatus([button.dataset.reviewLetter], button.dataset.reviewStatus);
  });
  document
    .querySelectorAll('[data-edit]')
    .forEach(
      (button) =>
        (button.onclick = () =>
          letterEditor(state.letters.find((item) => item.id === button.dataset.edit))),
    );
  document.querySelectorAll('[data-delete]').forEach(
    (button) =>
      (button.onclick = () => {
        if (!confirmDiscard($('#editor'))) return;
        void run(async () => {
          await deleteLetter((await adminContext()).db, button.dataset.delete);
          await reloadLetters();
          setStatus('휴지통으로 이동 완료');
        });
      }),
  );
  document.querySelectorAll('[data-restore-letter]').forEach((button) => {
    button.onclick = () =>
      void run(async () => {
        await restoreLetter((await adminContext()).db, button.dataset.restoreLetter);
        await reloadLetters();
        setStatus('복원 완료 · 검토 대기');
      });
  });
  document.querySelectorAll('[data-purge-letter]').forEach((button) => {
    button.onclick = () => {
      if (!confirm('휴지통에서 영구 삭제할까요? 글은 복원할 수 없으며 변경 이력은 유지됩니다.'))
        return;
      void run(async () => {
        await purgeLetter((await adminContext()).db, button.dataset.purgeLetter);
        await reloadLetters();
        setStatus('영구 삭제 완료');
      });
    };
  });
  document.querySelectorAll('[data-letter-history]').forEach((button) => {
    button.onclick = () => toggleLetterHistory(button.dataset.letterHistory);
  });
  cursorPagination('letters');
  document.querySelectorAll('[data-letter-student]').forEach((button) => {
    button.onclick = () => {
      if (state.busy || !confirmDiscard()) return;
      const letter = state.letters.find((item) => item.id === button.dataset.letterStudent);
      state.pendingStudentDetail = { id: letter.owner_uid, letterId: letter.id };
      location.hash = '#students';
    };
  });
}

export function updateLetterSelection() {
  const count = state.selectedLetters.size;
  $('#selected-count').textContent = `${count}건 선택`;
  $('#approve-selected').disabled = !count;
  $('#reject-selected').disabled = !count;
  const all = $('#select-letters');
  all.checked = state.letters.length > 0 && count === state.letters.length;
  all.indeterminate = count > 0 && count < state.letters.length;
  all.disabled = !state.letters.length;
}

export async function reloadLetters() {
  invalidateListCache('letters');
  $('#editor')?.replaceChildren();
  resetLetterPages();
  await renderTab();
}

export function changeLetterStatus(ids, status) {
  if (!ids.length || !confirmDiscard($('#editor'))) return;
  void run(async () => {
    let result;
    let failure;
    try {
      result = await reviewLetters((await adminContext()).db, ids, status);
    } catch (reason) {
      failure = reason;
    }
    await reloadLetters();
    if (failure) throw failure;
    setStatus(`${labels[status]} · 변경 ${typeof result === 'number' ? result : ids.length}건`);
  });
}

export function toggleLetterHistory(id, target = $(`[data-history-for="${id}"]`)) {
  if (!target.hidden) {
    target.hidden = true;
    return;
  }
  target.hidden = false;
  target.textContent = '불러오는 중';
  let cursor = null;
  const load = () =>
    void run(async () => {
      const sequence = state.viewSequence;
      const page = await readLetterHistory((await adminContext()).db, id, {
        cursor,
        pageSize: 20,
      });
      if (
        sequence !== state.viewSequence ||
        !target.isConnected ||
        !state.session.authenticated
      )
        return;
      if (!cursor) target.replaceChildren();
      target.querySelector('button')?.remove();
      const actions = {
        create: '추가',
        edit: '수정',
        review: '검수',
        approve: '승인',
        reject: '제외',
        trash: '휴지통 이동',
        restore: '복원',
        purge: '영구 삭제',
      };
      for (const item of page.items) {
        const row = document.createElement('details');
        row.className = 'history-entry';
        row.innerHTML = `<summary>${html(actions[item.action] || item.action)} · ${html(koreanDate(item.created_at))}</summary><small>관리자 ${html(item.operator_uid === state.session.uid ? state.session.email : item.operator_uid)}${id ? '' : ` · 글 ${html(item.letter_id)}`}</small>${id ? '' : `<p class="letter-content">${html(item.after?.content || item.before?.content || '')}</p>`}${letterChanges(item.before, item.after)}`;
        target.append(row);
      }
      if (!target.childNodes.length) target.textContent = '변경 이력 없음';
      cursor = page.cursor;
      if (page.hasNext) {
        const more = document.createElement('button');
        more.textContent = '이력 더 보기';
        more.onclick = load;
        target.append(more);
      }
      setStatus();
    });
  load();
}

export function letterChanges(before, after) {
  return (
    Object.entries({
      nickname: '별명',
      content: '본문',
      published_content: '공개용 본문',
      status: '상태',
      publish_order: '공개 순서',
    })
      .filter(([key]) => (before?.[key] ?? null) !== (after?.[key] ?? null))
      .map(([key, label]) => {
        const value = (record) =>
          key === 'status' ? labels[record?.[key]] || '—' : (record?.[key] ?? '—');
        return `<div class="history-change"><strong>${label}</strong><div class="form-grid"><p class="letter-content"><small>이전</small><br>${html(value(before))}</p><p class="letter-content"><small>이후</small><br>${html(value(after))}</p></div></div>`;
      })
      .join('') || '<p class="muted">본문 변경 없음</p>'
  );
}

export function letterAuthor(letter) {
  const student = state.students.find((item) => item.student_id === letter.owner_uid);
  return student
    ? `작성 계정: ${student.login_id || '현재 학번 미연결'} ${student.student_name}`
    : '명부 연결 전·관리자 작성 기록';
}

export function letterEditor(letter) {
  freshEditor(letter, readLetter, openLetterEditor);
}

export function openLetterEditor(letter) {
  const creationKey = crypto.randomUUID();
  $('#editor').innerHTML =
    `<form id="letter-editor" class="panel"><h2>${letter ? '글 수정' : '글 추가'}</h2>
    ${field('nickname', '별명', letter?.nickname ?? '', 'text', 'maxlength="30"')}${area('content', '본문', letter?.content ?? '')}
    ${area('published_content', '공개용 본문 (비워 두면 본문 사용)', letter?.published_content ?? '')}
    <div class="form-grid">${select('status', '상태', letter?.status ?? 'pending', Object.entries(labels))}${field('publish_order', '공개 순서', letter?.publish_order ?? '', 'number', 'min="0" max="1000000" step="1"')}</div>
    ${letter ? '' : checkbox('consent', '작성자의 공개 동의를 확인했습니다.')}
    <div class="actions"><button>저장</button><button type="button" id="close-editor">취소</button></div></form>`;
  $('#editor').scrollIntoView({ block: 'start' });
  $('#close-editor').onclick = closeEditor;
  submit($('#letter-editor'), async (values) => {
    if (!letter && !values.consent) throw new Error('공개 동의를 확인하세요.');
    const { db, uid } = await adminContext();
    await saveLetter(
      db,
      uid,
      letter?.id ?? null,
      {
        ...values,
        published_content: values.published_content || null,
        publish_order: values.publish_order === '' ? null : Number(values.publish_order),
      },
      creationKey,
    );
    await reloadLetters();
    setStatus('저장 완료');
  });
}
