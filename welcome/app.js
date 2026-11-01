import { UUID_PATTERN, validatePublicData } from '../common.js';

const PAGE_SIZE = 20;
const MAX_CACHED_PAGES = 5;
const PAGE_CACHE_TTL = 60_000;
const MAX_STATIC_FILE_SIZE = 10 * 1024 * 1024;

const status = document.querySelector('#status');
const error = document.querySelector('#error');
const refresh = document.querySelector('#refresh');
const sourceInfo = document.querySelector('#source-info');
const searchArea = document.querySelector('#search-area');
const search = document.querySelector('#search');
const letters = document.querySelector('#letters');
const detail = document.querySelector('#detail');
const detailTitle = document.querySelector('#detail-title');
const detailContent = document.querySelector('#detail-content');
const detailStatus = document.querySelector('#detail-status');
const backToList = document.querySelector('#back-to-list');
const share = document.querySelector('#share');
const shareLinkArea = document.querySelector('#share-link-area');
const shareLink = document.querySelector('#share-link');
const pagination = document.querySelector('#pagination');
const previous = document.querySelector('#previous');
const next = document.querySelector('#next');
const pageLabel = document.querySelector('#page');

let mode = null;
let liveApi = null;
let liveDb = null;
let staticLetters = [];
let staticPublishedAt = null;
let page = 0;
let busy = false;
let routePending = false;
let searchValue = '';
let eventUpdatedAt = null;
const livePages = new Map();
const pageCursors = new Map([[0, undefined]]);

function activeLetterId() {
  return new URLSearchParams(location.hash.slice(1)).get('letter');
}

function setPageControls({ hasPrevious = false, hasNext = false } = {}) {
  const interactive = !busy;
  previous.disabled = !interactive || !hasPrevious;
  next.disabled = !interactive || !hasNext;
  refresh.disabled = !interactive;
}

function clearLiveCache() {
  livePages.clear();
  pageCursors.clear();
  pageCursors.set(0, undefined);
}

function clearDisplay() {
  letters.replaceChildren();
  letters.hidden = true;
  detail.hidden = true;
  pagination.hidden = true;
  searchArea.hidden = true;
  shareLinkArea.hidden = true;
  shareLink.value = '';
  sourceInfo.hidden = true;
}

function showError(reason) {
  clearDisplay();
  status.textContent = '';
  error.textContent =
    reason instanceof Error && reason.message
      ? reason.message
      : '공개 글을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.';
  error.hidden = false;
  refresh.textContent = '다시 불러오기';
}

function showSourceInfo() {
  const date = staticPublishedAt ? new Date(staticPublishedAt).toLocaleDateString('ko-KR') : '';
  sourceInfo.textContent = date ? `공개 기준일: ${date}` : '';
  sourceInfo.hidden = mode !== 'static' || !date;
}

async function readStaticLetters() {
  const response = await fetch(new URL('./letters.json', import.meta.url), {
    cache: 'no-cache',
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`정적 공개본을 불러오지 못했습니다. (${response.status})`);

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_STATIC_FILE_SIZE)
    throw new Error('정적 공개본 파일이 너무 큽니다. 관리자에게 알려 주세요.');
  const raw = await response.text();
  if (
    raw.length > MAX_STATIC_FILE_SIZE ||
    new TextEncoder().encode(raw).byteLength > MAX_STATIC_FILE_SIZE
  )
    throw new Error('정적 공개본 파일이 너무 큽니다. 관리자에게 알려 주세요.');

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('정적 공개본을 읽을 수 없습니다. 파일을 다시 내보내 주세요.');
  }
  if (!validatePublicData(data))
    throw new Error('정적 공개본 형식이 올바르지 않습니다. 파일을 다시 내보내 주세요.');
  return data;
}

async function selectSource() {
  const exported = await readStaticLetters();
  if (exported) {
    mode = 'static';
    staticLetters = exported.letters;
    staticPublishedAt = exported.publishedAt;
    return;
  }

  mode = 'live';
  const [{ getPublicDb }, publicApi] = await Promise.all([
    import('../db/firebase.js'),
    import('../db/public.js'),
  ]);
  liveApi = publicApi;
  liveDb = await getPublicDb();
}

function getStaticMatches() {
  const terms = searchValue
    .normalize('NFC')
    .toLocaleLowerCase('ko-KR')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!terms.length) return staticLetters;
  return staticLetters.filter((letter) => {
    const content = `${letter.nickname}\n${letter.content}`
      .normalize('NFC')
      .toLocaleLowerCase('ko-KR');
    return terms.every((term) => content.includes(term));
  });
}

function letterLink(letter) {
  const link = document.createElement('a');
  link.href = `#letter=${encodeURIComponent(letter.id)}`;
  link.textContent = letter.nickname || '익명';
  link.setAttribute('aria-label', `${letter.nickname || '익명'}의 글 전체 보기`);
  return link;
}

function renderList(items, total, hasNext) {
  letters.replaceChildren();
  for (const item of items) {
    const article = document.createElement('article');
    article.className = 'panel';
    const heading = document.createElement('h2');
    if (UUID_PATTERN.test(item.id)) heading.append(letterLink(item));
    else heading.textContent = item.nickname || '익명';

    const content = document.createElement('p');
    content.className = 'letter-content';
    const characters = Array.from(item.content);
    content.textContent =
      characters.length > 180 ? `${characters.slice(0, 180).join('')}…` : item.content;
    article.append(heading, content);
    letters.append(article);
  }

  letters.hidden = false;
  detail.hidden = true;
  searchArea.hidden = mode !== 'static';
  pagination.hidden = page === 0 && !hasNext;
  pageLabel.textContent =
    mode === 'static' ? `${page + 1} 페이지 · ${total}개` : `${page + 1} 페이지`;
  status.textContent =
    total === 0 ? (searchValue ? '검색 결과가 없습니다.' : '공개된 글이 없습니다.') : '';
  setPageControls({ hasPrevious: page > 0, hasNext });
}

function renderStaticList(targetPage = page) {
  const matches = getStaticMatches();
  const lastPage = Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1);
  page = Math.min(Math.max(0, targetPage), lastPage);
  const start = page * PAGE_SIZE;
  renderList(
    matches.slice(start, start + PAGE_SIZE),
    matches.length,
    start + PAGE_SIZE < matches.length,
  );
}

function renderDetail(letter) {
  letters.hidden = true;
  detail.hidden = false;
  pagination.hidden = true;
  searchArea.hidden = true;
  shareLinkArea.hidden = true;
  shareLink.value = '';
  detailTitle.textContent = letter ? letter.nickname || '익명' : '글을 찾을 수 없습니다.';
  detailStatus.hidden = Boolean(letter);
  detailStatus.textContent = letter ? '' : '삭제되었거나 현재 공개되지 않은 글입니다.';
  detailContent.textContent = letter?.content ?? '';
  share.hidden = !letter;
  if (letter) {
    shareLink.value = new URL(`#letter=${encodeURIComponent(letter.id)}`, location.href).href;
  }
  status.textContent = '';
  detail.focus();
}

async function shareCurrentLetter() {
  const url = shareLink.value;
  if (!url) return;
  try {
    if (navigator.share) {
      await navigator.share({ title: `${detailTitle.textContent}의 글`, url });
      return;
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      status.textContent = '공유 링크를 복사했습니다.';
      return;
    }
  } catch (reason) {
    if (reason?.name === 'AbortError') return;
  }
  shareLinkArea.hidden = false;
  shareLink.focus();
  shareLink.select();
  status.textContent = '공유 링크를 선택했습니다. 복사해서 전달해 주세요.';
}

function setLivePage(targetPage, result) {
  const entry = {
    letters: result.letters,
    hasNext: result.hasNext,
    fetchedAt: Date.now(),
  };
  livePages.delete(targetPage);
  livePages.set(targetPage, entry);
  while (livePages.size > MAX_CACHED_PAGES) {
    const oldestPage = livePages.keys().next().value;
    livePages.delete(oldestPage);
  }
  if (result.hasNext) pageCursors.set(targetPage + 1, result.cursor);
  else {
    for (const cursorPage of pageCursors.keys())
      if (cursorPage > targetPage) pageCursors.delete(cursorPage);
  }
  return entry;
}

function getLivePage(targetPage) {
  const entry = livePages.get(targetPage);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt >= PAGE_CACHE_TTL) {
    livePages.delete(targetPage);
    return null;
  }
  livePages.delete(targetPage);
  livePages.set(targetPage, entry);
  return entry;
}

async function loadLiveRoute(targetPage) {
  const config = await liveApi.readEvent(liveDb);
  if (config.updatedAt !== eventUpdatedAt) {
    const hadCachedPages = livePages.size > 0;
    clearLiveCache();
    if (hadCachedPages) page = 0;
    eventUpdatedAt = config.updatedAt;
  }
  if (!config.welcomeEnabled) {
    clearLiveCache();
    page = 0;
    eventUpdatedAt = config.updatedAt;
    status.textContent = '공개 설정이 열리면 글을 볼 수 있습니다.';
    return;
  }

  const id = activeLetterId();
  if (id !== null) {
    const letter = UUID_PATTERN.test(id) ? await liveApi.readPublicLetter(liveDb, id) : null;
    renderDetail(letter);
    return;
  }

  const requestedPage =
    page === 0 && targetPage > 0 && !pageCursors.has(targetPage) ? 0 : targetPage;
  const cached = getLivePage(requestedPage);
  let entry = cached;
  if (!entry) {
    const startCursor = pageCursors.get(requestedPage);
    if (requestedPage > 0 && !pageCursors.has(requestedPage))
      throw new Error('페이지 정보가 만료되었습니다. 새로고침한 뒤 다시 시도해 주세요.');
    const result = await liveApi.readPublicLetters(liveDb, startCursor);
    entry = setLivePage(requestedPage, result);
  }
  page = requestedPage;
  renderList(entry.letters, entry.letters.length, entry.hasNext);
}

async function load(targetPage = page, { forceSource = false } = {}) {
  if (busy) {
    routePending = true;
    return;
  }
  busy = true;
  error.hidden = true;
  refresh.textContent = '새로고침';
  status.textContent = '불러오는 중';
  clearDisplay();
  setPageControls();
  try {
    if (forceSource) {
      mode = null;
      staticLetters = [];
      staticPublishedAt = null;
      eventUpdatedAt = null;
      clearLiveCache();
      page = 0;
      searchValue = search.value;
    }
    if (!mode) await selectSource();
    showSourceInfo();
    if (mode === 'static') {
      const id = activeLetterId();
      if (id !== null) {
        const letter = UUID_PATTERN.test(id)
          ? (staticLetters.find((item) => item.id === id) ?? null)
          : null;
        renderDetail(letter);
      } else {
        renderStaticList(targetPage);
      }
    } else {
      await loadLiveRoute(targetPage);
    }
  } catch (reason) {
    if (mode === 'live') {
      clearLiveCache();
      eventUpdatedAt = null;
    }
    showError(
      mode === 'live' && String(reason?.code ?? '').includes('permission-denied')
        ? new Error('현재 공개 글을 열람할 수 없습니다. 새로고침해 주세요.')
        : reason,
    );
  } finally {
    busy = false;
    const hasNext =
      mode === 'static'
        ? (page + 1) * PAGE_SIZE < getStaticMatches().length
        : Boolean(livePages.get(page)?.hasNext);
    setPageControls({ hasPrevious: page > 0, hasNext });
    if (routePending) {
      routePending = false;
      void load(page);
    }
  }
}

previous.addEventListener('click', () => {
  if (busy || page === 0) return;
  const target = page - 1;
  if (mode === 'static') renderStaticList(target);
  else void load(target);
  window.scrollTo(0, 0);
});

next.addEventListener('click', () => {
  if (busy) return;
  if (mode === 'static') {
    if ((page + 1) * PAGE_SIZE >= getStaticMatches().length) return;
    renderStaticList(page + 1);
  } else if (livePages.get(page)?.hasNext) {
    void load(page + 1);
  }
  window.scrollTo(0, 0);
});

search.addEventListener('input', () => {
  searchValue = search.value;
  page = 0;
  if (mode === 'static' && !busy && activeLetterId() === null) renderStaticList(0);
});

refresh.addEventListener('click', () => void load(0, { forceSource: true }));
share.addEventListener('click', () => void shareCurrentLetter());
backToList.addEventListener('click', () => {
  if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
  void load(page);
});
window.addEventListener('hashchange', () => void load(page));
window.addEventListener('pageshow', (event) => {
  if (event.persisted && mode === 'live') void load(page);
});

void load(0);
