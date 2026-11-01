/** Admin views and actions for student records and history. */
import { adminContext } from '../db/firebase.js';
import {
  canResetStudentPassword,
  moderateStudent,
  readStudent,
  readStudentHistoryPage,
  readStudentLetter,
  readStudents,
  resetStudentPassword,
  studentGrade,
  writeRestricted,
} from '../db/students.js';
import { escapeHtml as html, koreanDate, normalizeText } from '../common.js';
import {
  $,
  alertError,
  area,
  checkbox,
  confirmDiscard,
  data,
  field,
  invalidateListCache,
  labels,
  paginate,
  resetLetterPages,
  resetResultPages,
  run,
  select,
  setStatus,
  submit,
} from './shared.js';
import { renderTab } from './shared.js';
import { state } from './state.js';

export function clearStudentRoster() {
  invalidateListCache();
  state.rosterRevision++;
  state.rosterCache = null;
  state.rosterExpiresAt = 0;
  state.rosterRequest = null;
  state.students = [];
  state.studentFilter = { query: '', grade: '', unlinkedOnly: false };
  state.studentPage = 1;
  state.studentDetailSequence++;
  state.pendingStudentDetail = null;
  resetLetterPages();
  resetResultPages();
}

export function loadStudentRoster(db, force = false) {
  if (force) {
    state.rosterRevision++;
    state.rosterCache = null;
    state.rosterExpiresAt = 0;
    state.rosterRequest = null;
  }
  if (state.rosterCache && Date.now() < state.rosterExpiresAt)
    return Promise.resolve(state.rosterCache);
  if (state.rosterRequest) return state.rosterRequest;
  const revision = state.rosterRevision;
  const uid = state.session.uid;
  const request = readStudents(db)
    .then((records) => {
      if (
        revision !== state.rosterRevision ||
        !state.session.authenticated ||
        state.session.uid !== uid
      )
        throw new Error('관리자 세션이 변경되었습니다. 다시 로그인하세요.');
      state.rosterCache = records;
      state.rosterExpiresAt = Date.now() + 60000;
      return records;
    })
    .finally(() => {
      if (state.rosterRequest === request) state.rosterRequest = null;
    });
  state.rosterRequest = request;
  return request;
}

export function updateStudentRoster(studentId, saved) {
  invalidateListCache();
  // 저장 전에 시작된 명부 요청이 정정한 상태를 덮어쓰지 않게 합니다.
  state.rosterRevision++;
  state.rosterRequest = null;
  const update = (records) =>
    records.map((item) => (item.student_id === studentId ? { ...saved, id: studentId } : item));
  state.students = update(state.students);
  if (state.rosterCache) state.rosterCache = update(state.rosterCache);
}

export function studentsView() {
  state.studentDetailSequence++;
  $('#view').innerHTML = `<form id="student-filter" class="toolbar">
    ${field('query', '학번·이름 검색', state.studentFilter.query)}
    ${select('grade', '학년', state.studentFilter.grade, [
      ['', '전체'],
      ['1', '1학년'],
      ['2', '2학년'],
      ['3', '3학년'],
      ['other', '그 외'],
    ])}
    ${checkbox('unlinkedOnly', '미연결만', state.studentFilter.unlinkedOnly)}
    <button>검색</button><button id="reload-students" type="button">새로고침</button></form><p id="student-links" class="muted"></p><div class="table-scroll" id="student-list"></div>
    <div class="actions" id="pagination"></div><div id="student-detail"></div>`;
  $('#student-filter').onsubmit = (event) => {
    event.preventDefault();
    state.studentFilter = {
      ...data(event.currentTarget),
      unlinkedOnly: event.currentTarget.elements.unlinkedOnly.checked,
    };
    state.studentPage = 1;
    renderStudents();
  };
  $('#student-filter [name=unlinkedOnly]').onchange = () =>
    $('#student-filter').requestSubmit();
  $('#reload-students').onclick = () => renderTab(true);
  renderStudents();
}

export function renderStudents() {
  const query = normalizeText(state.studentFilter.query).toLocaleLowerCase();
  const filtered = state.students.filter((student) => {
    const grade = studentGrade(student, state.sessionPolicy.academicYear);
    return (
      (!state.studentFilter.unlinkedOnly || !student.login_id) &&
      `${student.login_id ?? ''} ${student.student_id} ${student.student_name}`
        .toLocaleLowerCase()
        .includes(query) &&
      (!state.studentFilter.grade ||
        (state.studentFilter.grade === 'other'
          ? grade === null
          : grade === Number(state.studentFilter.grade)))
    );
  });
  const linked = state.students.filter((student) => !!student.login_id).length;
  $('#student-links').textContent =
    `전체 ${state.students.length}명 · 연결 ${linked}명 · 미연결 ${state.students.length - linked}명`;
  state.studentPage = Math.min(state.studentPage, Math.max(1, Math.ceil(filtered.length / 50)));
  $('#student-list').innerHTML =
    `<table><caption>${filtered.length}명 · ${state.sessionPolicy.academicYear}학년도</caption>
    <thead><tr><th>학번</th><th>이름</th><th>학년</th><th>계정</th><th>글 작성</th><th>관리</th></tr></thead><tbody>${filtered
      .slice((state.studentPage - 1) * 50, state.studentPage * 50)
      .map(
        (student) => `<tr>
      <td>${html(student.login_id || '미연결')}</td><td>${html(student.student_name)}</td>
      <td>${studentGrade(student, state.sessionPolicy.academicYear) ?? '—'}</td>
      <td>${student.is_active ? '활성' : '비활성'}</td><td>${writeRestricted(student) ? '제한' : '허용'}</td>
      <td><button data-student="${html(student.student_id)}">상세</button></td></tr>`,
      )
      .join('')}</tbody></table>`;
  document.querySelectorAll('[data-student]').forEach((button) => {
    button.onclick = () => {
      if (!confirmDiscard($('#student-detail'))) return;
      void studentDetail(button.dataset.student).catch(alertError);
    };
  });
  paginate(filtered.length, 50, state.studentPage, (page) => {
    state.studentPage = page;
    renderStudents();
  });
}

export const moderationLabels = {
  block_write: '글 작성 제한',
  unblock_write: '글 작성 제한 해제',
  deactivate: '계정 비활성화',
  activate: '계정 재활성화',
  reset_password: '비밀번호 재발급',
};

export async function studentDetail(studentId, relatedLetterId = '') {
  const detailSequence = ++state.studentDetailSequence;
  const sequence = state.viewSequence;
  const container = $('#student-detail');
  container.textContent = '학생 정보 불러오는 중';
  container.scrollIntoView({ block: 'start' });
  const { db } = await adminContext();
  const [student, letterHistory, moderationHistory, relatedLetter, passwordReady] =
    await Promise.all([
      readStudent(db, studentId),
      readStudentHistoryPage(db, studentId, 'letters'),
      readStudentHistoryPage(db, studentId, 'logs'),
      relatedLetterId ? readStudentLetter(db, studentId, relatedLetterId) : null,
      canResetStudentPassword(),
    ]);
  if (
    sequence !== state.viewSequence ||
    detailSequence !== state.studentDetailSequence ||
    !state.session.authenticated
  )
    return;
  if (!student) throw new Error('학생 정보를 찾지 못했습니다. 새로 불러오세요.');
  const history = { letters: letterHistory.items, logs: moderationHistory.items };
  const relatedOptions = [...history.letters];
  if (relatedLetter && !relatedOptions.some((item) => item.id === relatedLetter.id))
    relatedOptions.push(relatedLetter);
  container.innerHTML = `<section class="panel"><h2>${html(student.login_id || '현재 학번 미연결')} ${html(student.student_name)}</h2>
    <p>${student.is_active ? '활성' : '비활성'} · 글 작성 ${writeRestricted(student) ? '제한' : '허용'}${student.blocked_until ? ` · 제한 종료 ${html(koreanDate(student.blocked_until.toDate().toISOString()))}` : ''}</p>
    <div id="student-actions"></div><div id="student-history"></div></section>`;
  $('#student-actions').innerHTML = `<form id="student-moderation">
    ${select('action', '조치', student.write_blocked ? 'unblock_write' : 'block_write', [
      ['block_write', '글 작성 제한'],
      ['unblock_write', '글 작성 제한 해제'],
      [
        student.is_active ? 'deactivate' : 'activate',
        student.is_active ? '계정 비활성화' : '계정 재활성화',
      ],
    ])}
    ${field('blocked_until', '제한 종료 (비워두면 직접 해제)', '', 'datetime-local')}
    ${select('related_letter_id', '관련 글', relatedLetter?.id ?? '', [['', '없음'], ...relatedOptions.map((letter) => [letter.id, `${koreanDate(letter.created_at?.toDate().toISOString() ?? '')} · ${letter.id}`])])}
    ${area('reason', '조치 사유', '', 3)}<button>적용</button></form>
    <form id="student-password"><h3>비밀번호 재발급</h3>${area('reason', '재발급 사유', '', 2)}<button${passwordReady ? '' : ' disabled'}>임시 비밀번호 발급</button>${passwordReady ? '' : '<p class="muted">비밀번호 재발급은 현재 보류 중입니다.</p>'}
    <p id="temporary-password" role="status" hidden></p><button id="clear-temporary-password" type="button" hidden>임시 비밀번호 숨기기</button></form>`;
  for (const form of [$('#student-moderation'), $('#student-password')]) {
    form.elements.reason.required = true;
    form.elements.reason.maxLength = 500;
  }
  const until = $('#student-moderation').elements.blocked_until;
  until.disabled = student.write_blocked;
  $('#student-moderation').elements.action.addEventListener('change', (event) => {
    until.disabled = event.currentTarget.value !== 'block_write';
  });
  submit($('#student-moderation'), async (values) => {
    const operatorUid = state.session.uid;
    const saved = await moderateStudent(studentId, values);
    if (!state.session.authenticated || state.session.uid !== operatorUid) return false;
    updateStudentRoster(studentId, saved);
    renderStudents();
    await studentDetail(studentId);
    setStatus('학생 상태 저장 완료');
  });
  submit($('#student-password'), async (values) => {
    const result = await resetStudentPassword(studentId, values.reason);
    const output = $('#temporary-password');
    if (
      sequence !== state.viewSequence ||
      detailSequence !== state.studentDetailSequence ||
      !output
    )
      return;
    output.textContent = `임시 비밀번호: ${result.password}`;
    output.hidden = false;
    $('#clear-temporary-password').hidden = false;
    $('#student-password').reset();
    setStatus('임시 비밀번호 재발급 완료');
  });
  $('#clear-temporary-password').onclick = () => {
    $('#temporary-password').textContent = '';
    $('#temporary-password').hidden = true;
    $('#clear-temporary-password').hidden = true;
  };
  $('#student-history').innerHTML =
    `<h3>작성 내역</h3><div id="student-letters">${studentHistoryItems('letters', history.letters)}</div><button id="more-student-letters"${letterHistory.hasNext ? '' : ' hidden'}>작성 내역 더 보기</button>
    <h3>관리 기록</h3><div id="student-logs">${studentHistoryItems('logs', history.logs)}</div><button id="more-student-logs"${moderationHistory.hasNext ? '' : ' hidden'}>관리 기록 더 보기</button>`;
  for (const [kind, first] of [
    ['letters', letterHistory],
    ['logs', moderationHistory],
  ]) {
    let cursor = first.cursor;
    $(`#more-student-${kind}`).onclick = () =>
      void run(async () => {
        const next = await readStudentHistoryPage((await adminContext()).db, studentId, kind, {
          cursor,
        });
        if (
          sequence !== state.viewSequence ||
          detailSequence !== state.studentDetailSequence ||
          !state.session.authenticated
        )
          return;
        $(`#student-${kind}`).insertAdjacentHTML(
          'beforeend',
          studentHistoryItems(kind, next.items),
        );
        cursor = next.cursor;
        $(`#more-student-${kind}`).hidden = !next.hasNext;
        if (kind === 'letters')
          for (const letter of next.items) {
            const choices = $('#student-moderation').elements.related_letter_id;
            if ([...choices.options].some((option) => option.value === letter.id)) continue;
            const option = document.createElement('option');
            option.value = letter.id;
            option.textContent = `${koreanDate(letter.created_at?.toDate().toISOString() ?? '')} · ${letter.id}`;
            choices.append(option);
          }
        setStatus();
      });
  }
}

export function studentHistoryItems(kind, items) {
  if (!items.length) return `<p>${kind === 'letters' ? '작성 내역' : '관리 기록'} 없음</p>`;
  return items
    .map((item) =>
      kind === 'letters'
        ? `<article class="record"><strong>${html(labels[item.status] ?? item.status)}</strong> · ${html(koreanDate(item.created_at?.toDate().toISOString() ?? ''))}<p class="letter-content">${html(item.content)}</p><small>접수번호 ${html(item.id)} · 별명 ${html(item.nickname || '익명')}</small></article>`
        : `<article class="record"><strong>${html(moderationLabels[item.action] ?? item.action)}</strong> · ${html(koreanDate(item.created_at?.toDate().toISOString() ?? ''))}<p>${html(item.reason)}</p><small>관리자 ${html(item.operator_uid)}${item.related_letter_id ? ` · 관련 글 ${html(item.related_letter_id)}` : ''}</small></article>`,
    )
    .join('');
}
