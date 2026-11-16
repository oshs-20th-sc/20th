import { validateParticipant, UUID_PATTERN } from '../common.js';

// Exact school number + normalized name lookup, not an authentication credential.
// Only this small certificate projection is readable; private result lists stay private.
export async function typingCertificateKey(studentNumber, name) {
  const { value, error } = validateParticipant({ studentNumber, name });
  if (!value) throw new Error(error);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${value.studentNumber}\n${value.name}`),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export function typingCertificate(record, challenge = null) {
  return {
    id: record.id,
    participantId: record.participantId,
    displayName: record.displayName,
    challengeId: record.challengeId,
    elapsedMs: record.elapsedMs,
    speed: record.speed,
    errors: record.errors,
    score: record.score,
    completedAt: record.completedAt,
    text: challenge?.text ?? '',
    title: challenge?.title ?? '타자 대회',
    referenceKeystrokes: challenge?.referenceKeystrokes ?? 0,
  };
}

export function validTypingCertificate(value) {
  return (
    !!value &&
    UUID_PATTERN.test(value.id ?? '') &&
    !!validateParticipant({
      studentNumber: value.participantId,
      name: value.displayName,
    }).value &&
    typeof value.challengeId === 'string' &&
    /^[a-zA-Z0-9_-]{1,100}$/.test(value.challengeId) &&
    Number.isFinite(value.elapsedMs) &&
    value.elapsedMs > 0 &&
    value.elapsedMs <= 3600000 &&
    ['speed', 'errors', 'score'].every(
      (key) => Number.isInteger(value[key]) && value[key] >= 0,
    ) &&
    Number.isFinite(Date.parse(value.completedAt)) &&
    typeof value.text === 'string' &&
    Array.from(value.text).length <= 1000 &&
    typeof value.title === 'string' &&
    Array.from(value.title).length > 0 &&
    Array.from(value.title).length <= 100 &&
    Number.isInteger(value.referenceKeystrokes) &&
    value.referenceKeystrokes >= 0 &&
    value.referenceKeystrokes <= 5000
  );
}
