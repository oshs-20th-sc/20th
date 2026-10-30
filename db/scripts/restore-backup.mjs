import { readFile, stat, writeFile, realpath, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  outsideSource,
  privateOutput,
  retryFileOperation,
  processRoster,
} from './import-students.mjs';

const legacy = [
  'letters',
  'typingResults',
  'receipts',
  'challenges',
  'publicLetters',
  'settings',
];
const current = [...legacy, 'students', 'moderationLogs'];
const audited = [...current, 'letterTrash', 'letterLogs'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function validValue(value, depth = 0) {
  if (depth > 20) throw new Error('BACKUP_TOO_DEEP');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) validValue(item, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') throw new Error('INVALID_BACKUP_VALUE');
  if (Object.hasOwn(value, '__firestoreTimestamp')) {
    if (
      value.__firestoreTimestamp !== true ||
      Object.keys(value).sort().join(',') !== '__firestoreTimestamp,nanoseconds,seconds' ||
      !Number.isInteger(value.seconds) ||
      value.seconds < -62135596800 ||
      value.seconds > 253402300799 ||
      !Number.isInteger(value.nanoseconds) ||
      value.nanoseconds < 0 ||
      value.nanoseconds > 999999999 ||
      value.nanoseconds % 1000 !== 0
    )
      throw new Error('INVALID_TIMESTAMP');
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (
      [
        '__proto__',
        'prototype',
        'constructor',
        'student_pw',
        'password',
        'passwordHash',
        'refresh_token',
        'private_key',
      ].includes(key)
    )
      throw new Error('FORBIDDEN_BACKUP_FIELD');
    validValue(item, depth + 1);
  }
}
export function validateBackup(input) {
  if (
    !input ||
    ![2, 3, 4].includes(input.schemaVersion) ||
    input.backend !== 'firebase' ||
    typeof input.projectId !== 'string' ||
    !input.projectId ||
    input.includesAuthentication === true ||
    !input.collections ||
    typeof input.collections !== 'object' ||
    Array.isArray(input.collections)
  )
    throw new Error('INVALID_BACKUP');
  const allowed =
    input.schemaVersion === 4 ? audited : input.schemaVersion === 3 ? current : legacy;
  const records = [];
  for (const [collection, rows] of Object.entries(input.collections)) {
    if (!allowed.includes(collection) || !Array.isArray(rows))
      throw new Error('UNSUPPORTED_COLLECTION');
    const seen = new Set();
    for (const row of rows) {
      const id = row?.id;
      const validId =
        collection === 'students'
          ? /^(?:[A-Za-z0-9_-]{20}|\d{7})$/.test(id)
          : collection === 'letterLogs'
            ? /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(-restore|-purge)?$/.test(
                id,
              )
            : collection === 'settings'
              ? ['event', 'sessionPolicy'].includes(id)
              : collection === 'challenges'
                ? /^[a-zA-Z0-9_-]{1,100}$/.test(id)
                : uuid.test(id);
      if (
        typeof id !== 'string' ||
        !validId ||
        seen.has(id) ||
        !row.data ||
        typeof row.data !== 'object' ||
        Array.isArray(row.data) ||
        Object.keys(row).some((key) => !['id', 'data'].includes(key))
      )
        throw new Error('INVALID_BACKUP_DOCUMENT');
      seen.add(id);
      validValue(row.data);
      if (JSON.stringify(row.data).length > 900000) throw new Error('DOCUMENT_TOO_LARGE');
      records.push({ collection, id, data: row.data });
      if (records.length > 50000) throw new Error('BACKUP_TOO_LARGE');
    }
  }
  if (!records.length) throw new Error('EMPTY_BACKUP');
  return records;
}
function encode(value) {
  if (value && typeof value.toMillis === 'function' && Number.isInteger(value.seconds))
    return encode({
      __firestoreTimestamp: true,
      seconds: value.seconds,
      nanoseconds: value.nanoseconds,
    });
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, encode(value[key])]),
    );
  return value;
}
function equivalent(a, b) {
  return JSON.stringify(encode(a)) === JSON.stringify(encode(b));
}
function decode(value, Timestamp) {
  if (value && value.__firestoreTimestamp === true)
    return new Timestamp(value.seconds, value.nanoseconds);
  if (Array.isArray(value)) return value.map((item) => decode(item, Timestamp));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, decode(item, Timestamp)]),
    );
  return value;
}
export async function restoreBackup(
  db,
  backup,
  {
    apply = false,
    allowProjectChange = false,
    concurrency = 5,
    Timestamp,
    onProgress = async () => {},
  } = {},
) {
  const records = validateBackup(backup);
  if (backup.projectId !== db.projectId && !allowProjectChange)
    throw new Error('PROJECT_MISMATCH');
  const preflight = await processRoster(
    records,
    concurrency,
    async (row) => {
      const saved = await db.doc(`${row.collection}/${row.id}`).get();
      return {
        collection: row.collection,
        id: row.id,
        status: !saved.exists
          ? 'missing'
          : equivalent(saved.data(), row.data)
            ? 'unchanged'
            : 'conflict',
      };
    },
    onProgress,
  );
  if (!apply || preflight.some((row) => row.status === 'conflict'))
    return { applied: false, includesAuthentication: false, results: preflight };
  if (!Timestamp) throw new Error('TIMESTAMP_SDK_REQUIRED');
  const results = await processRoster(
    records,
    concurrency,
    async (row) => {
      try {
        const status = await db.runTransaction(async (tx) => {
          const ref = db.doc(`${row.collection}/${row.id}`),
            existing = await tx.get(ref);
          if (existing.exists) {
            if (!equivalent(existing.data(), row.data)) throw new Error('DOCUMENT_CONFLICT');
            return 'unchanged';
          }
          tx.create(ref, decode(row.data, Timestamp));
          return 'restored';
        });
        return { collection: row.collection, id: row.id, status };
      } catch (error) {
        return {
          collection: row.collection,
          id: row.id,
          status: 'error',
          error: /^[A-Z_]+$/.test(error.message ?? '') ? error.message : 'RESTORE_FAILED',
        };
      }
    },
    onProgress,
  );
  return { applied: true, includesAuthentication: false, results };
}
async function run() {
  const options = { apply: false, allowProjectChange: false, concurrency: 5 };
  const flags = new Map([
    ['input', 'input'],
    ['project', 'project'],
    ['report', 'report'],
    ['admin-module-dir', 'dependencies'],
    ['credential-module', 'credential'],
  ]);
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (key === 'apply') options.apply = true;
    else if (key === 'dry-run') options.apply = false;
    else if (key === 'allow-project-change') options.allowProjectChange = true;
    else if (key === 'concurrency') options.concurrency = Number(args[++i]);
    else if (flags.has(key) && args[i + 1] && !args[i + 1].startsWith('--'))
      options[flags.get(key)] = args[++i];
    else throw new Error('INVALID_ARGUMENTS');
  }
  if (
    !options.input ||
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options.project ?? '') ||
    !Number.isInteger(options.concurrency) ||
    options.concurrency < 1 ||
    options.concurrency > 10
  )
    throw new Error(
      'Usage: node db/scripts/restore-backup.mjs --input PRIVATE.json --project PROJECT [--dry-run|--apply] [--allow-project-change]',
    );
  const inputPath = await realpath(resolve(options.input));
  outsideSource(inputPath);
  if ((await stat(inputPath)).size > 100 * 1024 * 1024) throw new Error('BACKUP_TOO_LARGE');
  const reportPath = await privateOutput(
    resolve(options.report ?? `${inputPath}.restore-report.json`),
  );
  if (reportPath === inputPath) throw new Error('REPORT_CANNOT_OVERWRITE_BACKUP');
  const backup = JSON.parse((await readFile(inputPath, 'utf8')).replace(/^\uFEFF/, ''));
  validateBackup(backup);
  const require = createRequire(
    options.dependencies ? resolve(options.dependencies, '__restore__.cjs') : import.meta.url,
  );
  const appSdk = require('firebase-admin/app'),
    dbSdk = require('firebase-admin/firestore');
  let credential;
  if (options.credential) {
    const path = await realpath(resolve(options.credential));
    outsideSource(path);
    if (path === reportPath) throw new Error('REPORT_CANNOT_OVERWRITE_CREDENTIAL');
    const provider = await import(pathToFileURL(path).href);
    credential =
      typeof provider.default === 'function'
        ? await provider.default(options.project)
        : provider.default;
  }
  const app = appSdk.initializeApp({
    projectId: options.project,
    ...(credential ? { credential } : {}),
  });
  const report = {
    project: options.project,
    sourceProject: backup.projectId,
    mode: options.apply ? 'apply' : 'dry-run',
    includesAuthentication: false,
    results: [],
  };
  let writes = Promise.resolve();
  const checkpoint = () => {
    const body = JSON.stringify(report, null, 2) + '\n';
    writes = writes.then(async () => {
      const temp = `${reportPath}.checkpoint-${process.pid}-${randomUUID()}`;
      let owned = false;
      try {
        await writeFile(temp, body, { mode: 0o600, flag: 'wx' });
        owned = true;
        await retryFileOperation(() => rename(temp, reportPath));
      } catch (error) {
        if (owned) await retryFileOperation(() => unlink(temp)).catch(() => {});
        throw error;
      }
    });
    return writes;
  };
  try {
    const result = await restoreBackup(dbSdk.getFirestore(app), backup, {
      ...options,
      Timestamp: dbSdk.Timestamp,
      onProgress: async (results) => {
        report.results = results;
        await checkpoint();
      },
    });
    Object.assign(report, result);
    report.completedAt = new Date().toISOString();
    const counts = Object.fromEntries(
      [...new Set(report.results.map((row) => row.status))].map((status) => [
        status,
        report.results.filter((row) => row.status === status).length,
      ]),
    );
    report.counts = counts;
    await checkpoint();
    console.log(
      JSON.stringify({
        project: options.project,
        mode: report.mode,
        includesAuthentication: false,
        counts,
      }),
    );
    if (counts.conflict || counts.error) process.exitCode = 1;
  } finally {
    await writes.catch(() => {});
    await appSdk.deleteApp(app);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  run().catch((error) => {
    console.error(
      error.message?.startsWith('Usage:')
        ? error.message
        : /^[A-Z_]+$/.test(error.message ?? '')
          ? error.message
          : 'RESTORE_FAILED',
    );
    process.exitCode = 1;
  });
