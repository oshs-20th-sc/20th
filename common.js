// Leave room under Firestore's 1 MiB limit for original/published text in
// both before/after audit snapshots, plus metadata.
export const MAX_CONTENT_BYTES = 131072;
export const NICKNAME_MAX = 30;
export const unicodeLength = (value) => Array.from(value).length;
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function normalizeText(value) {
  return value.replace(/\r\n?/g, '\n').normalize('NFC').trim();
}
export function validateParticipant(input) {
  if (!input || typeof input !== 'object')
    return { error: '학번과 이름을 입력해 주세요.' };
  const rawStudentNumber = input.studentNumber;
  const rawName = input.name;
  if (typeof rawStudentNumber !== 'string' || typeof rawName !== 'string')
    return { error: '학번과 이름을 입력해 주세요.' };
  const studentNumber = rawStudentNumber.normalize('NFKC').trim();
  const name = rawName.normalize('NFKC').normalize('NFC').trim();
  if (!/^[1-3][0-9]{4}$/.test(studentNumber))
    return { error: '학번은 현재 학년을 포함한 숫자 5자리로 입력해 주세요.' };
  if (
    unicodeLength(name) < 1 ||
    unicodeLength(name) > 30 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(name)
  )
    return { error: '이름은 줄바꿈 없이 1~30자로 입력해 주세요.' };
  return { value: { studentNumber, name } };
}
export function validateSubmission(input) {
  if (!input || typeof input !== 'object')
    return {
      error: '입력 형식을 확인해 주세요.',
    };
  const data = input;
  if (
    typeof data.content !== 'string' ||
    (data.nickname !== undefined && typeof data.nickname !== 'string')
  ) {
    return {
      error: '본문과 별명은 문자열로 입력해 주세요.',
    };
  }
  const content = normalizeText(data.content);
  const nickname = normalizeText(data.nickname ?? '');
  if (!content) return { error: '본문을 입력해 주세요.' };
  if (new TextEncoder().encode(content).byteLength > MAX_CONTENT_BYTES)
    return { error: '본문이 저장 가능한 크기를 넘었습니다. 내용을 줄여 주세요.' };
  if (unicodeLength(nickname) > NICKNAME_MAX || nickname.includes('\n'))
    return {
      error: '별명은 줄바꿈 없이 30자 이내로 입력해 주세요.',
    };
  if (data.consentToPublish !== true)
    return {
      error: '글 공개에 동의해 주세요.',
    };
  if (typeof data.submissionKey !== 'string' || !UUID_PATTERN.test(data.submissionKey))
    return {
      error: '접수 요청 정보가 올바르지 않습니다. 새 글 작성을 눌러 주세요.',
    };
  const value = {
    content,
    nickname,
    consentToPublish: true,
    submissionKey: data.submissionKey,
  };
  if (data.studentNumber !== undefined || data.name !== undefined) {
    const participant = validateParticipant({
      studentNumber: data.studentNumber,
      name: data.name,
    });
    if (!participant.value) return participant;
    value.studentNumber = participant.value.studentNumber;
    value.name = participant.value.name;
  }
  return {
    value,
  };
}
export function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function toCsv(rows) {
  return '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}
export function downloadFile(filename, contents, mime) {
  const url = URL.createObjectURL(
    new Blob([contents], {
      type: mime,
    }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const dateFormatter = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  dateStyle: 'short',
  timeStyle: 'short',
});
export function koreanDate(date) {
  const timestamp = Date.parse(date);
  return Number.isFinite(timestamp) ? dateFormatter.format(timestamp) : '—';
}
export function makePublicData(letters, now = new Date().toISOString()) {
  return {
    schemaVersion: 1,
    publishedAt: now,
    letters: letters
      .filter(
        (l) =>
          l.status === 'approved' &&
          l.consent_to_publish === 1 &&
          normalizeText(l.published_content || l.content).length > 0,
      )
      .sort(
        (a, b) =>
          (a.publish_order ?? Number.MAX_SAFE_INTEGER) -
            (b.publish_order ?? Number.MAX_SAFE_INTEGER) ||
          a.created_at.localeCompare(b.created_at) ||
          a.id.localeCompare(b.id),
      )
      .map((l) => ({
        id: l.id,
        nickname: l.nickname || '익명',
        content: l.published_content || l.content,
        order: l.publish_order,
      })),
  };
}
export function validatePublicData(input) {
  if (!input || typeof input !== 'object') return false;
  const data = input;
  if (Object.keys(data).some((k) => !['schemaVersion', 'publishedAt', 'letters'].includes(k)))
    return false;
  if (
    data.schemaVersion !== 1 ||
    !Array.isArray(data.letters) ||
    !(
      data.publishedAt === null ||
      (typeof data.publishedAt === 'string' && Number.isFinite(Date.parse(data.publishedAt)))
    )
  )
    return false;
  const ids = new Set();
  return data.letters.every((item) => {
    if (!item || typeof item !== 'object') return false;
    const l = item;
    if (Object.keys(l).sort().join(',') !== 'content,id,nickname,order') return false;
    if (typeof l.id !== 'string' || !UUID_PATTERN.test(l.id) || ids.has(l.id)) return false;
    ids.add(l.id);
    return (
      typeof l.nickname === 'string' &&
      unicodeLength(l.nickname) <= 30 &&
      typeof l.content === 'string' &&
      normalizeText(l.content).length > 0 &&
      new TextEncoder().encode(l.content).byteLength <= MAX_CONTENT_BYTES &&
      (l.order === null || (Number.isInteger(l.order) && l.order >= 0))
    );
  });
}

export function localHref(path) {
  const url = new URL(path, location.href);
  if (
    ['localhost', '127.0.0.1'].includes(location.hostname) &&
    new URLSearchParams(location.search).get('emulator') === '1'
  )
    url.searchParams.set('emulator', '1');
  return url.href;
}
export function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
}
