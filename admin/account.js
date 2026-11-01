/** Administrator account and operator management. */
import {
  adminContext,
  changeAdminEmail,
  changeAdminPassword,
  collection,
  createOperator,
  deleteDoc,
  doc,
  getDocs,
  serverTimestamp,
  setDoc,
  withDeadline,
} from '../db/firebase.js';
import { escapeHtml as html } from '../common.js';
import { $, field, run, setStatus, submit } from './shared.js';
import { state } from './state.js';

export async function accountView(db, sequence = state.viewSequence) {
  const roles = await withDeadline(getDocs(collection(db, 'admins')));
  if (sequence !== state.viewSequence || !state.session.authenticated) return;
  $('#view').innerHTML =
    `<section class="panel"><h2>계정</h2><p>이메일: ${html(state.session.email)}</p><p>UID: <code>${html(state.session.uid)}</code></p>
    <form id="password"><h3>비밀번호 변경</h3>${field('current', '현재 비밀번호', '', 'password', 'required autocomplete="current-password"')}${field('next', '새 비밀번호', '', 'password', 'required minlength="12" autocomplete="new-password"')}${field('confirmation', '새 비밀번호 확인', '', 'password', 'required minlength="12" autocomplete="new-password"')}<button>변경</button></form>
    <form id="email"><h3>이메일 변경</h3>${field('email', '새 이메일', '', 'email', 'required')}${field('current', '현재 비밀번호', '', 'password', 'required autocomplete="current-password"')}<button>확인 메일 전송</button></form></section>
    <section class="panel"><h2>관리자 권한</h2><ul class="review-list" id="operators">${operatorItems(roles)}</ul>
    <form id="operator"><h3>관리자 추가</h3>${field('email', '이메일', '', 'email', 'required maxlength="254"')}${field('password', '초기 비밀번호', '', 'password', 'minlength="12" autocomplete="new-password"')}
    <details><summary>기존 계정에 권한 추가</summary>${field('uid', '기존 UID', '', 'text', 'maxlength="128"')}</details><button>추가</button></form></section>`;
  submit($('#password'), async (values) => {
    if (values.next !== values.confirmation)
      throw new Error('비밀번호 확인이 일치하지 않습니다.');
    await changeAdminPassword(values.current, values.next);
    $('#password').reset();
    setStatus('비밀번호 변경 완료');
  });
  submit($('#email'), async (values) => {
    await changeAdminEmail(values.current, values.email);
    $('#email').reset();
    setStatus('새 이메일에서 확인 후 다시 로그인하세요.');
  });
  submit($('#operator'), async (values) => {
    if (values.uid.trim())
      await withDeadline(
        setDoc(doc((await adminContext()).db, 'admins', values.uid.trim()), {
          enabled: true,
          email: values.email.trim(),
          created_at: serverTimestamp(),
        }),
      );
    else await createOperator(values.email, values.password);
    $('#operator').reset();
    await refreshOperators((await adminContext()).db, sequence);
    setStatus('추가 완료');
  });
  bindOperatorActions(sequence);
}

export function operatorItems(roles) {
  return roles.docs
    .filter((item) => item.data().enabled)
    .map(
      (item) =>
        `<li>${html(item.id === state.session.uid ? state.session.email : item.data().email || item.id)} ${item.id === state.session.uid ? '(현재 계정)' : `<button class="danger" data-revoke="${html(item.id)}">권한 해제</button>`}</li>`,
    )
    .join('');
}

export async function refreshOperators(db, sequence) {
  const roles = await withDeadline(getDocs(collection(db, 'admins')));
  if (sequence !== state.viewSequence || !$('#operators')) return;
  $('#operators').innerHTML = operatorItems(roles);
  bindOperatorActions(sequence);
}

export function bindOperatorActions(sequence) {
  document.querySelectorAll('[data-revoke]').forEach(
    (button) =>
      (button.onclick = () => {
        if (!confirm('관리자 권한을 해제할까요?')) return;
        void run(async () => {
          await withDeadline(
            deleteDoc(doc((await adminContext()).db, 'admins', button.dataset.revoke)),
          );
          await refreshOperators((await adminContext()).db, sequence);
          setStatus('권한 해제 완료');
        });
      }),
  );
}
