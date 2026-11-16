// Verifies frozen legacy data stays readable during cutover without permitting legacy writes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const projectId = 'demo-oshs-compat-rules';
const rules = await readFile(new URL('../db/firestore.compat.rules', import.meta.url), 'utf8');
const env = await initializeTestEnvironment({ projectId, firestore: { host: '127.0.0.1', port: 8088, rules } });
const anon = env.unauthenticatedContext().firestore();
const other = env.authenticatedContext('ordinary-user').firestore();
const legacyAdmin = env.authenticatedContext('legacy-admin').firestore();
const doc = (db, path) => db.doc(path);
let passed = 0;
try {
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await doc(db, 'admins/legacy-admin').set({ enabled: true, email: 'admin@example.invalid' });
    await doc(db, 'admins/other-admin').set({ enabled: true, email: 'other@example.invalid' });
    await doc(db, 'settings/event').set({ phase: 'B', welcomeEnabled: false });
    await doc(db, 'typingResults/result-1').set({ id: 'result-1', private: true });
    await doc(db, 'letters/letter-1').set({ id: 'letter-1', private: true });
    await doc(db, 'publicLetters/public-1').set({ id: 'public-1', content: 'public' });
    await doc(db, 'receipts/00000000-0000-4000-8000-000000000001').set({
      id: '00000000-0000-4000-8000-000000000001', owner_uid: null, entry_mode: 'record',
      kind: 'typing', payload_hash: 'a'.repeat(64), created_at: new Date(),
    });
    await doc(db, 'receipts/official-20261123-20101').set({
      id: 'official-20261123-20101', kind: 'typingEntry', student_number: '20101', result_id: 'result-1',
    });
  });

  await assertSucceeds(doc(anon, 'settings/event').get());
  await assertSucceeds(doc(anon, 'challenges/challenge-1').get());
  await assertSucceeds(doc(anon, 'receipts/00000000-0000-4000-8000-000000000001').get());
  await assertFails(doc(anon, 'typingResults/result-1').get());
  await assertFails(doc(other, 'letters/letter-1').get());
  await assertFails(doc(anon, 'publicLetters/public-1').get());
  await assertSucceeds(doc(legacyAdmin, 'typingResults/result-1').get());
  await assertSucceeds(doc(legacyAdmin, 'letters/letter-1').get());
  await assertSucceeds(doc(legacyAdmin, 'publicLetters/public-1').get());
  await assertSucceeds(doc(legacyAdmin, 'admins/legacy-admin').get());
  await assertFails(doc(other, 'admins/legacy-admin').get());
  await assertFails(doc(anon, 'receipts/official-20261123-20101').get());
  passed++;

  // The compatibility window is explicitly read-only for every old app path.
  await assertFails(doc(legacyAdmin, 'settings/event').set({ phase: 'C' }));
  await assertFails(doc(legacyAdmin, 'typingResults/result-1').delete());
  await assertFails(doc(legacyAdmin, 'letters/letter-1').update({ status: 'approved' }));
  await assertFails(doc(legacyAdmin, 'receipts/00000000-0000-4000-8000-000000000001').delete());
  await assertFails(doc(legacyAdmin, 'admins/new-admin').set({ enabled: true }));
  passed++;
  console.log(`legacy compatibility rules: ${passed} emulator groups passed`);
} finally { await env.cleanup(); }
