export const initialInputState = () => ({ committed: '', errors: 0, composing: false });

function codePointOffset(text, utf16Offset) {
  const offset = Number.isInteger(utf16Offset)
    ? Math.max(0, Math.min(text.length, utf16Offset))
    : text.length;
  return Array.from(text.slice(0, offset)).length;
}

function commitInsertedRange(state, next, target, start, end) {
  if (next === state.committed) return state;
  const oldChars = Array.from(state.committed);
  const newChars = Array.from(next);
  const targetChars = Array.from(target);
  const startIndex = Math.min(oldChars.length, codePointOffset(state.committed, start));
  const endIndex = Math.max(startIndex, Math.min(oldChars.length, codePointOffset(state.committed, end)));
  const replacedLength = endIndex - startIndex;
  const insertedLength = Math.max(0, newChars.length - (oldChars.length - replacedLength));
  let errors = state.errors;

  for (let index = startIndex; index < startIndex + insertedLength; index++) {
    if (newChars[index] !== targetChars[index]) errors++;
  }
  return { ...state, committed: next, errors };
}

/**
 * Assess only newly inserted characters. Pass the beforeinput metadata when available:
 * `{ inputType, start, end }`, with selection offsets captured before the edit.
 * The 3-argument form keeps the original diff-based fallback for existing callers.
 */
export function commitInput(state, next, target, edit) {
  if (state.composing) {
    const inputType = edit && typeof edit.inputType === 'string' ? edit.inputType : '';
    if (!inputType) return state;
    return {
      ...state,
      compositionHasInsertion: state.compositionHasInsertion || inputType.startsWith('insert'),
      compositionHasDeletion: state.compositionHasDeletion || inputType.startsWith('delete'),
    };
  }
  if (next === state.committed) return state;

  if (edit && typeof edit.inputType === 'string') {
    // Browser deletion and replacement-by-deletion (including Korean IME backspace)
    // changes the displayed value but never adds an error.
    if (edit.inputType.startsWith('delete')) return { ...state, committed: next };
    if (Number.isInteger(edit.start) && Number.isInteger(edit.end)) {
      return commitInsertedRange(state, next, target, edit.start, edit.end);
    }
  }

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

export function compositionStart(state, selection) {
  const range = selection && Number.isInteger(selection.start) && Number.isInteger(selection.end)
    ? { start: selection.start, end: selection.end }
    : null;
  return {
    ...state,
    composing: true,
    compositionRange: range,
    compositionHasInsertion: false,
    compositionHasDeletion: false,
  };
}
export function compositionEnd(state, next, target) {
  if (!state.composing) return commitInput(state, next, target);
  const {
    compositionRange: range,
    compositionHasInsertion,
    compositionHasDeletion,
    ...base
  } = state;
  const settled = { ...base, composing: false };
  // Reopening a committed syllable and only deleting its final jamo is an edit,
  // not a newly typed typo. A later insertion in the same composition makes the
  // final composed text count once, even when a deletion event followed it.
  if (compositionHasDeletion && !compositionHasInsertion) {
    return { ...settled, committed: next };
  }
  return range
    ? commitInsertedRange(settled, next, target, range.start, range.end)
    : commitInput(settled, next, target);
}
export function isComplete(state, target) {
  return !state.composing && state.committed === target;
}
