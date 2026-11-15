import { mountObyeol } from './obyeol.js?v=db-schema-5';

// Presentation only: saving, retries and backups stay in app.js/storage.js.
export function mountRecordCard() {
  const dialog = document.getElementById('record-dialog');
  const button = document.getElementById('show-record');
  const saveStatus = document.getElementById('record-save-status');
  const close = document.getElementById('record-close');
  const back = document.getElementById('record-return');
  let record = null;
  let state = 'saving';
  let restoreFocus = null;
  mountObyeol(document.getElementById('record-obyeol'));
  function open() {
    if (!record || dialog.open) return;
    restoreFocus = document.activeElement;
    dialog.showModal();
  }
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll('button:not(:disabled), [href], input:not(:disabled), [tabindex="0"]')];
    if (!controls.length) return;
    const current = controls.indexOf(document.activeElement);
    const next = current < 0 ? (event.shiftKey ? controls.length - 1 : 0)
      : (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
    // Explicit cycling also supports Safari when macOS skips buttons on Tab.
    event.preventDefault();
    controls[next].focus();
  });
  close.addEventListener('click', () => dialog.close());
  back.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right ||
      event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
  });
  dialog.addEventListener('close', () => {
    // A failed record must lead straight back to the existing recovery controls.
    const retry = document.getElementById('retry');
    const target = state === 'failed' && !retry.hidden ? retry :
      !button.hidden ? button : restoreFocus;
    if (target?.isConnected && !target.closest('[hidden]') && !target.disabled) target.focus();
  });
  button.addEventListener('click', open);
  return {
    show(value) {
      record = { ...value };
      for (const [field, text] of Object.entries({
        student: record.participantId,
        name: record.displayName,
        score: record.score,
        speed: record.speed,
        errors: record.errors,
        time: (record.elapsedMs / 1000).toFixed(2),
      })) document.getElementById(`record-${field}`).textContent = text;
      button.hidden = false;
      this.status('saving');
      open();
    },
    status(next, needsBackup = false, filePrepared = false, failureReason = '') {
      if (!record) return;
      state = next;
      saveStatus.dataset.state = next;
      saveStatus.textContent = {
        saving: '서버에 기록을 저장하고 있어요.',
        saved: '서버에 기록이 저장되었어요. 운영진 확인을 기다려 주세요.',
        failed: needsBackup
          ? '서버 저장과 기기 보관에 실패했어요. 기록 화면에서 파일로 저장해 주세요.'
          : filePrepared
            ? '서버 저장은 완료되지 않았어요. 저장한 기록 파일을 운영진에게 전달해 주세요.'
            : '서버 저장에 실패했어요. 기기에 보관 중이며, 기록 화면에서 다시 시도할 수 있어요.',
      }[next] ?? '기록 화면에서 저장 상태를 확인해 주세요.';
      if (next === 'failed' && failureReason) saveStatus.textContent = `${failureReason} ${saveStatus.textContent}`;
      back.textContent = next === 'failed' ? '저장·백업 화면으로 돌아가기' : '기록 화면으로 돌아가기';
    },
    reset() {
      record = null;
      button.hidden = true;
      if (dialog.open) dialog.close();
      for (const field of ['student', 'name', 'score', 'speed', 'errors', 'time'])
        document.getElementById(`record-${field}`).textContent = '';
    },
  };
}
