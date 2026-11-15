// Add missing minimal certificates for existing official records. Never rewrite results.
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateOutput } from './private-files.mjs';
import { decodeValue, encodeValue, fieldsEqual } from './migrate-schema.mjs';
import {
  decodeData,
  encodeData,
  documentPath,
  collectionPath,
} from '../schema.js';
import {
  typingCertificateKey,
  typingCertificate,
  validTypingCertificate,
} from '../typing-certificate.js';

const base = (project) => `projects/${project}/databases/(default)/documents`;
const fields = (data) =>
  Object.fromEntries(
    Object.entries(data ?? {}).map(([k, v]) => [k, encodeValue(v)]),
  );
const decoded = (kind, document) =>
  document
    ? decodeData(
        kind,
        Object.fromEntries(
          Object.entries(document.fields ?? {}).map(([k, v]) => [
            k,
            decodeValue(v),
          ]),
        ),
      )
    : null;
async function getMany(api, project, names, transaction) {
  return (
    await api.post(base(project) + ':batchGet', {
      documents: names,
      ...(transaction ? { transaction } : {}),
    })
  ).body;
}
function planFor(project, recordDoc, related, key) {
  const record = decoded('typingResults', recordDoc);
  if (!record || record.entry_mode !== 'record' || record.practice !== false)
    return { status: 'skipped' };
  const byName = new Map(
    related.filter((r) => r.found).map((r) => [r.found.name, r.found]),
  );
  const claim = decoded(
    'typingEntries',
    byName.get(
      base(project) + '/' + documentPath('typingEntries', record.participantId),
    ),
  );
  if (
    claim?.kind !== 'typingEntry' ||
    claim.student_number !== record.participantId ||
    claim.result_id !== record.id
  )
    return { status: 'skipped' };
  const rawChallenge = byName.get(
    base(project) + '/' + documentPath('challenges', record.challengeId),
  );
  const challenge = decoded('challenges', rawChallenge);
  if (challenge && !challenge.title) challenge.title = record.challengeId;
  const value = typingCertificate(record, challenge);
  if (!validTypingCertificate(value)) throw Error('INVALID_SOURCE_RECORD');
  const path = documentPath('typingCertificates', key);
  const existing = decoded(
    'typingCertificates',
    byName.get(base(project) + '/' + path),
  );
  if (existing) {
    if (!validTypingCertificate(existing)) throw Error('CERTIFICATE_CONFLICT');
    // Keep the original passage snapshot if a passage was subsequently edited.
    const keys = [
      'id',
      'participantId',
      'displayName',
      'challengeId',
      'elapsedMs',
      'speed',
      'errors',
      'score',
      'completedAt',
    ];
    if (keys.some((k) => existing[k] !== value[k]))
      throw Error('CERTIFICATE_CONFLICT');
    encodeData('typingCertificates', existing);
    return { status: 'unchanged', path };
  }
  return {
    status: 'create',
    path,
    fields: fields(encodeData('typingCertificates', value)),
  };
}
export async function backfillCertificates(
  api,
  project,
  { apply = false, backupPath } = {},
) {
  const records = [];
  let pageToken = '';
  do {
    const response = (
      await api.get(
        base(project) +
          '/' +
          collectionPath('typingResults')
            .split('/')
            .map(encodeURIComponent)
            .join('/') +
          '?pageSize=200' +
          (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''),
      )
    ).body;
    records.push(...(response.documents ?? []));
    pageToken = response.nextPageToken ?? '';
  } while (pageToken);
  const candidates = [],
    backup = [];
  for (const raw of records) {
    const record = decoded('typingResults', raw);
    if (record.entry_mode !== 'record' || record.practice !== false) continue;
    const key = await typingCertificateKey(
      record.participantId,
      record.displayName,
    );
    const names = [
      raw.name,
      base(project) + '/' + documentPath('typingEntries', record.participantId),
      base(project) + '/' + documentPath('challenges', record.challengeId),
      base(project) + '/' + documentPath('typingCertificates', key),
    ];
    const related = await getMany(api, project, names);
    const live = related.find((r) => r.found?.name === raw.name)?.found;
    const plan = planFor(project, live, related, key);
    candidates.push({ key, names, sourceName: raw.name, plan });
    backup.push(...related);
  }
  if (!backupPath) throw Error('PRIVATE_BACKUP_REQUIRED');
  const target = await privateOutput(resolve(backupPath));
  await writeFile(
    target,
    JSON.stringify(
      {
        projectId: project,
        exportedAt: new Date().toISOString(),
        includesAuthentication: false,
        documents: backup,
      },
      null,
      2,
    ),
    { flag: 'wx', mode: 0o600 },
  );
  let created = 0;
  if (apply)
    for (const candidate of candidates) {
      if (candidate.plan.status !== 'create') continue;
      const transaction = (
        await api.post(base(project) + ':beginTransaction', {})
      ).body.transaction;
      try {
        const related = await getMany(
          api,
          project,
          candidate.names,
          transaction,
        );
        const raw = related.find(
          (r) => r.found?.name === candidate.sourceName,
        )?.found;
        const plan = planFor(project, raw, related, candidate.key);
        if (plan.status === 'create') {
          await api.post(base(project) + ':commit', {
            transaction,
            writes: [
              {
                update: {
                  name: base(project) + '/' + plan.path,
                  fields: plan.fields,
                },
                currentDocument: { exists: false },
              },
            ],
          });
          created++;
        } else await api.post(base(project) + ':rollback', { transaction });
      } catch (error) {
        await api
          .post(base(project) + ':rollback', { transaction })
          .catch(() => {});
        throw error;
      }
    }
  // Exact post-write check for every newly prepared projection.
  if (apply)
    for (const candidate of candidates.filter(
      (c) => c.plan.status === 'create',
    )) {
      const out = await getMany(api, project, [
        base(project) + '/' + candidate.plan.path,
      ]);
      const actual = out.find((r) => r.found)?.found;
      if (!actual || !fieldsEqual(actual.fields, candidate.plan.fields))
        throw Error('CERTIFICATE_VERIFICATION_FAILED');
    }
  return {
    sourceResults: records.length,
    eligibleRecords: candidates.length,
    plannedCreates: candidates.filter((c) => c.plan.status === 'create').length,
    created,
    unchanged: candidates.filter((c) => c.plan.status === 'unchanged').length,
    skipped: candidates.filter((c) => c.plan.status === 'skipped').length,
    applied: apply,
  };
}
async function run() {
  const options = { apply: false };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--apply') options.apply = true;
    else if (key === '--dry-run') options.apply = false;
    else if (
      ['--project', '--firebase-tools-dir', '--backup'].includes(key) &&
      args[i + 1]
    )
      options[key.slice(2)] = args[++i];
    else throw Error('INVALID_ARGUMENTS');
  }
  if (
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options.project ?? '') ||
    !options['firebase-tools-dir'] ||
    !options.backup
  )
    throw Error('PROJECT_TOOLS_AND_PRIVATE_BACKUP_REQUIRED');
  const require = createRequire(
    resolve(options['firebase-tools-dir'], '__certificate_backfill.cjs'),
  );
  const auth = require('firebase-tools/lib/auth'),
    o = { project: options.project, nonInteractive: true };
  const account = auth.getGlobalDefaultAccount();
  if (!account) throw Error('FIREBASE_LOGIN_REQUIRED');
  auth.setActiveAccount(o, account);
  await require('firebase-tools/lib/requireAuth').requireAuth(o);
  const { Client } = require('firebase-tools/lib/apiv2');
  const api = new Client({
    auth: true,
    apiVersion: 'v1',
    urlPrefix: 'https://firestore.googleapis.com',
  });
  console.log(
    JSON.stringify(
      await backfillCertificates(api, options.project, {
        apply: options.apply,
        backupPath: options.backup,
      }),
    ),
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  run().catch((error) => {
    console.error(
      /^[A-Z_]+$/.test(error.message ?? '')
        ? error.message
        : 'CERTIFICATE_BACKFILL_FAILED',
    );
    process.exitCode = 1;
  });
