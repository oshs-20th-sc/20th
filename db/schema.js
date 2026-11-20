// The only persisted-schema definition. UI/engine objects keep their existing API.
export const SCHEMA_VERSION = 6;
export const TYPING_STORAGE_ID = '기본';
export const WRITING_EVENT_ID = '기본';
const LEGACY_CLAIM_ID = /^official-\d{8}-([1-3][0-9]{4})$/;
export const COLLECTIONS = Object.freeze({
  admins: '관리자',
  settings: '운영설정',
  challenges: `타자대회/${TYPING_STORAGE_ID}/문구`,
  typingResults: `타자대회/${TYPING_STORAGE_ID}/기록`,
  typingEntries: `타자대회/${TYPING_STORAGE_ID}/참여제한`,
  typingReceipts: `타자대회/${TYPING_STORAGE_ID}/접수확인`,
  typingCertificates: `타자대회/${TYPING_STORAGE_ID}/기록증`,
  letters: `글쓰기/${WRITING_EVENT_ID}/접수글`,
  publicLetters: `글쓰기/${WRITING_EVENT_ID}/공개글`,
  letterTrash: `글쓰기/${WRITING_EVENT_ID}/휴지통`,
  letterLogs: `글쓰기/${WRITING_EVENT_ID}/검수이력`,
  letterReceipts: `글쓰기/${WRITING_EVENT_ID}/접수확인`,
  legacyStudents: '보관자료/이전자료/학생명부',
  legacyModerationLogs: '보관자료/이전자료/학생제재이력',
});
export const FIELDS = Object.freeze({
  id: '문서ID',
  owner_uid: '이전계정UID',
  entry_mode: '참가방식',
  student_number: '학번',
  student_name: '이름',
  displayName: '이름',
  participantId: '학번',
  challengeId: '문구ID',
  elapsedMs: '소요시간밀리초',
  speed: '분당타수',
  errors: '누적오타',
  score: '최종점수',
  completedAt: '완료시각',
  received_at: '접수시각',
  created_at: '생성시각',
  reviewed_at: '검수시각',
  prizeReceived: '상품수령여부',
  practice: '연습여부',
  verificationStatus: '검수상태',
  duplicate_of: '원본기록ID',
  nickname: '별명',
  content: '본문',
  published_content: '공개본문',
  consent_to_publish: '공개동의',
  status: '검수상태',
  publish_order: '공개순서',
  submission_key: '접수번호',
  last_history_id: '최근이력ID',
  trashed_at: '삭제시각',
  trashed_by: '삭제관리자UID',
  letter: '글원본',
  before: '변경전',
  after: '변경후',
  operator_uid: '처리관리자UID',
  action: '처리종류',
  letter_id: '글ID',
  order: '공개순서',
  sort_order: '정렬순서',
  text: '문구본문',
  title: '문구제목',
  referenceKeystrokes: '기준타수',
  errorPenalty: '오타감점',
  enabled: '사용여부',
  deleted: '삭제여부',
  email: '이메일',
  phase: '운영단계',
  typingEnabled: '타자접수허용',
  submissionsEnabled: '글접수허용',
  welcomeEnabled: '공개글열람허용',
  activeChallengeId: '선택문구ID',
  updated_at: '수정시각',
  boothMode: '공용기기모드',
  idleMinutes: '자동퇴장대기분',
  academicYear: '학년도',
  kind: '접수종류',
  payload_hash: '내용해시',
  result_id: '기록ID',
});
const KIND_FIELDS = {
  typingCertificates: [
    'id',
    'participantId',
    'displayName',
    'challengeId',
    'elapsedMs',
    'speed',
    'errors',
    'score',
    'completedAt',
    'text',
    'title',
    'referenceKeystrokes',
  ],
  typingResults: [
    'id',
    'owner_uid',
    'entry_mode',
    'participantId',
    'displayName',
    'challengeId',
    'elapsedMs',
    'speed',
    'errors',
    'score',
    'completedAt',
    'received_at',
    'reviewed_at',
    'prizeReceived',
    'practice',
    'verificationStatus',
    'duplicate_of',
  ],
  letters: [
    'id',
    'owner_uid',
    'entry_mode',
    'student_number',
    'student_name',
    'nickname',
    'content',
    'published_content',
    'consent_to_publish',
    'status',
    'publish_order',
    'submission_key',
    'created_at',
    'reviewed_at',
    'last_history_id',
  ],
  publicLetters: ['id', 'nickname', 'content', 'order', 'sort_order'],
  letterTrash: ['letter', 'trashed_at', 'trashed_by', 'last_history_id'],
  letterLogs: [
    'letter_id',
    'operator_uid',
    'action',
    'before',
    'after',
    'created_at',
  ],
  admins: ['enabled', 'email', 'created_at'],
  settings: [
    'phase',
    'typingEnabled',
    'submissionsEnabled',
    'welcomeEnabled',
    'activeChallengeId',
    'updated_at',
    'boothMode',
    'idleMinutes',
    'academicYear',
  ],
  challenges: [
    'text',
    'title',
    'referenceKeystrokes',
    'errorPenalty',
    'enabled',
    'deleted',
    'practice',
  ],
  typingEntries: ['kind', 'student_number', 'result_id', 'created_at'],
  typingReceipts: [
    'id',
    'owner_uid',
    'entry_mode',
    'kind',
    'payload_hash',
    'created_at',
  ],
  letterReceipts: [
    'id',
    'owner_uid',
    'entry_mode',
    'kind',
    'payload_hash',
    'created_at',
  ],
};
export function collectionPath(kind) {
  if (!Object.hasOwn(COLLECTIONS, kind))
    throw new Error(`Unknown data collection: ${kind}`);
  return COLLECTIONS[kind];
}
export function documentPath(kind, id) {
  if (typeof id !== 'string' || !id || id.includes('/'))
    throw new Error('Invalid document ID');
  if (kind === 'settings')
    id = { event: '행사', sessionPolicy: '세션' }[id] ?? id;
  if (kind === 'typingEntries') id = normalizeTypingEntryId(id);
  return `${collectionPath(kind)}/${id}`;
}
function normalizeTypingEntryId(id) {
  return LEGACY_CLAIM_ID.exec(id)?.[1] ?? id;
}
export function logicalId(kind, id) {
  if (kind === 'settings')
    return { 행사: 'event', 세션: 'sessionPolicy' }[id] ?? id;
  if (kind === 'typingEntries') return normalizeTypingEntryId(id);
  return id;
}
export function kindForPath(path) {
  return (
    Object.entries(COLLECTIONS).find(
      ([, prefix]) => path === prefix || path.startsWith(`${prefix}/`),
    )?.[0] ?? null
  );
}
export function fieldPath(field) {
  return field === '__name__'
    ? field
    : field
        .split('.')
        .map((part) => FIELDS[part] ?? part)
        .join('.');
}
function nestedKind(kind, key) {
  return (kind === 'letterTrash' && key === 'letter') ||
    (kind === 'letterLogs' && ['before', 'after'].includes(key))
    ? 'letters'
    : null;
}
export function encodeData(kind, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  if (kind === 'legacyStudents' || kind === 'legacyModerationLogs') return data;
  const allowed = KIND_FIELDS[kind];
  if (!allowed) throw new Error(`Unknown schema kind: ${kind}`);
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => {
      if (!allowed.includes(key))
        throw new Error(`Unknown ${kind} field: ${key}`);
      const target =
        kind === 'typingResults' &&
        key === 'participantId' &&
        data.entry_mode !== 'record'
          ? '이전참가자ID'
          : FIELDS[key];
      const nested = nestedKind(kind, key);
      return [
        target,
        nested && value != null ? encodeData(nested, value) : value,
      ];
    }),
  );
}
export function decodeData(kind, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const reverse = Object.fromEntries(
    (KIND_FIELDS[kind] ?? []).map((key) => [FIELDS[key], key]),
  );
  if (kind === 'typingResults') reverse['이전참가자ID'] = 'participantId';
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => {
      const target = reverse[key] ?? key;
      const nested = nestedKind(kind, target);
      return [
        target,
        nested && value != null ? decodeData(nested, value) : value,
      ];
    }),
  );
}
export function legacyDestination(collection, id, data) {
  if (collection === 'students') collection = 'legacyStudents';
  if (collection === 'moderationLogs') collection = 'legacyModerationLogs';
  if (collection !== 'receipts')
    return { kind: collection, id, path: documentPath(collection, id) };
  const kind =
    data.kind === 'typingEntry'
      ? 'typingEntries'
      : data.kind === 'typing'
        ? 'typingReceipts'
        : data.kind === 'letter'
          ? 'letterReceipts'
          : null;
  if (!kind) throw new Error('Unknown receipt kind');
  return { kind, id, path: documentPath(kind, id) };
}
export const PARENT_DOCUMENTS = Object.freeze({
  [`타자대회/${TYPING_STORAGE_ID}`]: {
    운영명: '타자 대회',
    스키마버전: SCHEMA_VERSION,
  },
  [`글쓰기/${WRITING_EVENT_ID}`]: {
    운영명: '글쓰기',
    스키마버전: SCHEMA_VERSION,
  },
});
