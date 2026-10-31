const MEDIAL_KEYS = [1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 2, 2, 2, 1, 1, 2, 1];
const FINAL_KEYS = [
  0, 1, 1, 2, 1, 2, 2, 1, 1, 2, 2, 2, 2, 2, 2, 2, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1,
];

/** Dubeolsik keys, excluding modifier keys. Spaces/punctuation each count once. */
export function countKeystrokes(text) {
  return Array.from(text.normalize('NFC')).reduce((sum, char) => {
    const syllable = char.codePointAt(0) - 0xac00;
    if (syllable < 0 || syllable > 11171) return sum + 1;
    return sum + 1 + MEDIAL_KEYS[Math.floor(syllable / 28) % 21] + FINAL_KEYS[syllable % 28];
  }, 0);
}

export function calculateScore(referenceKeystrokes, elapsedMs, errors, errorPenalty) {
  if (
    !Number.isFinite(elapsedMs) ||
    elapsedMs <= 0 ||
    !Number.isInteger(errors) ||
    errors < 0 ||
    !Number.isInteger(referenceKeystrokes) ||
    referenceKeystrokes <= 0 ||
    !Number.isInteger(errorPenalty) ||
    errorPenalty < 0 ||
    errorPenalty > 100
  ) {
    throw new Error('타수 계산에 필요한 값이 올바르지 않습니다.');
  }
  const speed = Math.round((referenceKeystrokes * 60000) / elapsedMs);
  return { speed, score: Math.max(0, speed - errors * errorPenalty) };
}

export function compareScores(a, b) {
  return b.score - a.score || a.errors - b.errors || a.elapsedMs - b.elapsedMs;
}

function compareAttempts(a, b) {
  return (
    compareScores(a, b) || a.completedAt.localeCompare(b.completedAt) || a.id.localeCompare(b.id)
  );
}

function studentKey(result) {
  const studentId = String(result.participantId).normalize('NFKC').trim();
  return JSON.stringify([result.challengeId, result.practice === true, studentId]);
}

// 기록은 모두 보관하고, 같은 문구·구분에서는 학번별 최고 기록만 순위에 반영합니다.
export function rankResults(results) {
  const seen = new Set();
  const sorted = [...results]
    .filter((result) => result.verificationStatus !== 'rejected')
    .sort(compareAttempts)
    .filter((result) => {
      const key = studentKey(result);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  let rank = 0;
  return sorted.map((result, index) => {
    if (index === 0 || compareScores(result, sorted[index - 1]) !== 0) rank = index + 1;
    return { ...result, rank };
  });
}

export function rankedAttempts(results) {
  const ranks = new Map(rankResults(results).map((result) => [result.id, result.rank]));
  return [...results].sort(compareAttempts).map((result) => ({
    ...result,
    rank: ranks.get(result.id) ?? null,
  }));
}
