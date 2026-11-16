// Guard the Firestore REST field-path quoting needed for Korean persisted fields.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const files = ['../db/firestore.indexes.json', '../db/firestore.compat.indexes.json'];
const containsHangul = (value) => /[\uac00-\ud7a3]/.test(value);
for (const file of files) {
  const config = JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
  for (const index of config.indexes) {
    for (const { fieldPath } of index.fields) {
      for (const segment of fieldPath.split('.')) {
        if (containsHangul(segment)) assert.match(segment, /^`[^`]+`$/, `${file}: ${fieldPath}`);
        else assert.doesNotMatch(segment, /`/);
      }
    }
  }
  for (const { fieldPath } of config.fieldOverrides) {
    for (const segment of fieldPath.split('.')) {
      if (containsHangul(segment)) assert.match(segment, /^`[^`]+`$/, `${file}: ${fieldPath}`);
      else assert.doesNotMatch(segment, /`/);
    }
  }
}
const legacy = JSON.parse(await readFile(new URL('../db/firestore.compat.indexes.json', import.meta.url), 'utf8'));
assert(legacy.indexes.some((index) => index.collectionGroup === 'typingResults'));
assert(legacy.indexes.some((index) => index.collectionGroup === '기록'));
assert(legacy.fieldOverrides.some((item) => item.collectionGroup === 'receipts'));
assert(legacy.fieldOverrides.some((item) => item.collectionGroup === '접수확인'));
console.log('Firestore index paths: Korean quoting and compat union passed');
