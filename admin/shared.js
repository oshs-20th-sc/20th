/** Shared state helpers and admin UI primitives. */
import { adminContext, errorMessage } from '../db/firebase.js';
import { escapeHtml as html } from '../common.js';
import { state, feature } from './state.js';

export const root = document.querySelector('#admin');

export const featureTitle = { typing: '타자 관리', write: '글 관리', welcome: '공개 글 관리' }[
  feature
];

export const firstTab = feature === 'typing' ? 'records' : 'letters';

export const $ = (selector, scope = document) => scope.querySelector(selector);

export const labels = { pending: '검토 대기', approved: '승인', rejected: '제외' };

export const verification = { pending: '확인 대기', verified: '확인', rejected: '제외' };

export const LIST_CACHE_TTL = 60000;

export const MAX_CACHED_LISTS = 10;

export function invalidateListCache(tab) {
  for (const [key, entry] of state.listCache)
    if (!tab || entry.tab === tab) state.listCache.delete(key);
}

export function listPageKey(tab) {
  return JSON.stringify([
    state.session.uid,
    tab,
    tab === 'letters' ? state.letterFilter : state.resultFilter,
    tab === 'letters' ? state.letterPage : state.resultPage,
  ]);
}

export function cachedList(tab) {
  const key = listPageKey(tab),
    entry = state.listCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt >= LIST_CACHE_TTL) {
    state.listCache.delete(key);
    return null;
  }
  state.listCache.delete(key);
  state.listCache.set(key, entry);
  return entry.loaded;
}

export function rememberList(tab, loaded) {
  const key = listPageKey(tab);
  state.listCache.delete(key);
  state.listCache.set(key, { tab, loaded, fetchedAt: Date.now() });
  while (state.listCache.size > MAX_CACHED_LISTS)
    state.listCache.delete(state.listCache.keys().next().value);
}

export function freshEditor(item, read, open) {
  if (state.busy) return;
  if (!confirmDiscard($('#editor'))) return;
  if (!item) {
    open();
    return;
  }
  const sequence = state.viewSequence,
    uid = state.session.uid;
  void run(async () => {
    const current = await read((await adminContext()).db, item.id);
    if (
      sequence !== state.viewSequence ||
      !state.session.authenticated ||
      state.session.uid !== uid
    )
      return;
    if (!current) throw new Error('항목이 삭제되었습니다. 목록을 새로고침하세요.');
    open(current);
    setStatus();
  });
}

export function resetLetterPages() {
  state.letterPage = 1;
  state.letterCursors = [null];
  state.letterNext = null;
  state.letterHasNext = false;
  state.selectedLetters.clear();
}

export function resetResultPages() {
  state.resultPage = 1;
  state.resultCursors = [null];
  state.resultNext = null;
  state.resultHasNext = false;
}

export function formState(form) {
  return JSON.stringify(
    [...form.elements]
      .filter((control) => control.name)
      .map((control) => [
        control.name,
        control.type === 'checkbox' ? control.checked : control.value,
      ]),
  );
}

export function dirtyForms(container = root) {
  const forms = container?.matches('form')
    ? [container]
    : [...(container?.querySelectorAll('form') ?? [])];
  return forms.filter(
    (form) => state.savedForms.has(form) && state.savedForms.get(form) !== formState(form),
  );
}

export function confirmDiscard(container = root) {
  const forms = dirtyForms(container);
  if (forms.length && !confirm('저장하지 않은 변경을 버릴까요?')) return false;
  forms.forEach((form) => {
    for (const [name, value] of JSON.parse(state.savedForms.get(form))) {
      const control = [...form.elements].find((element) => element.name === name);
      if (control.type === 'checkbox') control.checked = value;
      else control.value = value;
    }
  });
  return true;
}

export function closeEditor() {
  if (confirmDiscard($('#editor'))) $('#editor').replaceChildren();
}

export function restoreHash() {
  const url = new URL(location.href);
  url.hash = state.renderedHash;
  history.replaceState(history.state, '', url);
}

export const field = (name, label, value = '', type = 'text', attrs = '') =>
  `<label>${html(label)}<input name="${name}" type="${type}" value="${html(value)}" ${attrs}></label>`;

export const area = (name, label, value = '', rows = 5) =>
  `<label>${html(label)}<textarea name="${name}" rows="${rows}">${html(value)}</textarea></label>`;

export const select = (name, label, value, options) =>
  `<label>${html(label)}<select name="${name}">${options
    .map(
      ([key, text]) =>
        `<option value="${html(key)}"${String(value) === String(key) ? ' selected' : ''}>${html(text)}</option>`,
    )
    .join('')}</select></label>`;

export const checkbox = (name, label, checked = false) =>
  `<label class="checkbox"><input type="checkbox" name="${name}"${checked ? ' checked' : ''}>${html(label)}</label>`;

export const data = (form) => Object.fromEntries(new FormData(form));

export const alertError = (reason) => setStatus(errorMessage(reason), true);

export function setStatus(text = '', error = false) {
  const element = $('#status');
  if (!element) return;
  element.setAttribute('role', error ? 'alert' : 'status');
  element.textContent = text;
  element.className = error ? 'error' : 'notice';
  element.hidden = !text;
}

export async function run(work) {
  if (state.busy) return;
  state.busy = true;
  root.setAttribute('aria-busy', 'true');
  setStatus('처리 중');
  const controls = [...root.querySelectorAll('button, input, textarea, select')];
  const previous = controls.map((control) => control.disabled);
  controls.forEach((control) => (control.disabled = true));
  try {
    await work();
  } catch (reason) {
    alertError(reason);
  } finally {
    controls.forEach((control, index) => (control.disabled = previous[index]));
    state.busy = false;
    root.setAttribute('aria-busy', 'false');
    if (state.session.authenticated && location.hash !== state.renderedHash) {
      if (confirmDiscard()) void renderTab();
      else restoreHash();
    }
  }
}

export function submit(form, work) {
  if (form.id !== 'login') state.savedForms.set(form, formState(form));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = data(form);
    void run(async () => {
      const saved = await work(values);
      if (saved !== false && form.isConnected) state.savedForms.set(form, formState(form));
    });
  });
}

export function paginate(total, size, page, change) {
  const count = Math.max(1, Math.ceil(total / size));
  $('#pagination').innerHTML =
    `<button id="previous"${page <= 1 ? ' disabled' : ''}>이전</button><span>${page} / ${count} · ${total}건</span><button id="next"${page >= count ? ' disabled' : ''}>다음</button>`;
  $('#previous').onclick = () => change(page - 1);
  $('#next').onclick = () => change(page + 1);
}

export function cursorPagination(kind) {
  const isLetters = kind === 'letters';
  const page = isLetters ? state.letterPage : state.resultPage;
  const hasNext = isLetters ? state.letterHasNext : state.resultHasNext;
  $('#pagination').innerHTML =
    `<button id="previous"${page <= 1 ? ' disabled' : ''}>이전</button><span>${page} 페이지 · 현재 ${isLetters ? state.letters.length : state.results.length}건</span><button id="next"${!hasNext ? ' disabled' : ''}>다음</button>`;
  const move = (offset) => {
    if (state.busy || !confirmDiscard()) return;
    if (isLetters) {
      if (offset > 0) state.letterCursors[state.letterPage] = state.letterNext;
      state.letterPage += offset;
    } else {
      if (offset > 0) state.resultCursors[state.resultPage] = state.resultNext;
      state.resultPage += offset;
    }
    void renderTab();
  };
  $('#previous').onclick = () => move(-1);
  $('#next').onclick = () => move(1);
}
let routeTab = null;
export function bindRenderTab(handler) {
  routeTab = handler;
}
export function renderTab(...args) {
  if (!routeTab) throw new Error('Admin routes are not initialized.');
  return routeTab(...args);
}
