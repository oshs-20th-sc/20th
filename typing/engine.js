export const initialInputState = () => ({ committed: '', errors: 0, composing: false });

/** Only newly committed characters are assessed; deletions and unchanged suffixes are free. */
export function commitInput(state, next, target) {
  if (state.composing || next === state.committed) return state;
  const oldChars = Array.from(state.committed);
  const newChars = Array.from(next);
  const targetChars = Array.from(target);
  let prefix = 0;
  while (
    prefix < oldChars.length &&
    prefix < newChars.length &&
    oldChars[prefix] === newChars[prefix]
  )
    prefix++;
  let suffix = 0;
  while (
    suffix < oldChars.length - prefix &&
    suffix < newChars.length - prefix &&
    oldChars[oldChars.length - 1 - suffix] === newChars[newChars.length - 1 - suffix]
  )
    suffix++;
  let errors = state.errors;
  const insertionEnd = newChars.length - suffix;
  // Pure deletions, including selections, must never add errors.
  if (insertionEnd > prefix) {
    for (let index = prefix; index < insertionEnd; index++) {
      if (newChars[index] !== targetChars[index]) errors++;
    }
  }
  return { ...state, committed: next, errors };
}

export function compositionStart(state) {
  return { ...state, composing: true };
}
export function compositionEnd(state, next, target) {
  return commitInput({ ...state, composing: false }, next, target);
}
export function isComplete(state, target) {
  return !state.composing && state.committed === target;
}
