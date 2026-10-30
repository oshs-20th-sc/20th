import { readFile, writeFile, realpath, rename, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  studentEmail,
  processRoster,
  retryFileOperation,
  outsideSource,
  privateOutput,
  validDocument,
} from './import-students.mjs';

const canonicalId = /^[A-Za-z0-9_-]{20}$/;
const loginId = /^[1-3](?:0[1-9]|[1-9]\d)(?:0[1-9]|[1-9]\d)$/;

// Current class and number must be supplied by a verified roster, never inferred.
export function prepareLoginMappings(input, academicYear) {
  const rows = Array.isArray(input) ? input : input?.students;
  if (!Array.isArray(rows) || !rows.length) throw new Error('EMPTY_MAPPING');
  const identities = new Set(),
    logins = new Set();
  return rows.map((row) => {
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      Object.keys(row).some((key) => !['student_id', 'login_id'].includes(key))
    )
      throw new Error('INVALID_MAPPING_FIELDS');
    const student_id = String(row.student_id ?? '')
      .normalize('NFKC')
      .trim();
    const login_id = String(row.login_id ?? '')
      .normalize('NFKC')
      .trim();
    if (!canonicalId.test(student_id) || !loginId.test(login_id))
      throw new Error('INVALID_MAPPING');
    if (identities.has(student_id)) throw new Error('DUPLICATE_STUDENT_ID');
    if (logins.has(login_id)) throw new Error('DUPLICATE_LOGIN_ID');
    identities.add(student_id);
    logins.add(login_id);
    return { student_id, login_id };
  });
}

async function byEmail(auth, email) {
  try {
    return await auth.getUserByEmail(email);
  } catch (error) {
    if (error.code === 'auth/user-not-found') return null;
    throw error;
  }
}

function profileMatches(data, mapping, academicYear) {
  return (
    validDocument(data, {
      student_id: mapping.student_id,
      student_name: data?.student_name,
      admission_year: data?.admission_year,
    }) &&
    data?.student_id === mapping.student_id &&
    Number.isInteger(data.admission_year) &&
    data.admission_year >= 2000 &&
    data.admission_year <= 2100 &&
    academicYear - data.admission_year + 1 === Number(mapping.login_id[0]) &&
    typeof data.student_name === 'string' &&
    Array.from(data.student_name).length > 0 &&
    Array.from(data.student_name).length <= 30 &&
    typeof data.is_active === 'boolean' &&
    typeof data.write_blocked === 'boolean' &&
    (!Object.hasOwn(data, 'login_id') || data.login_id === mapping.login_id)
  );
}

export async function inspectLoginMapping(auth, db, mapping, projectId, academicYear) {
  const email = studentEmail(mapping.login_id, projectId);
  const [user, profile, admin, emailOwner, aliases] = await Promise.all([
    auth.getUser(mapping.student_id),
    db.doc(`students/${mapping.student_id}`).get(),
    db.doc(`admins/${mapping.student_id}`).get(),
    byEmail(auth, email),
    db.collection('students').where('login_id', '==', mapping.login_id).get(),
  ]);
  if (admin.exists) throw new Error('ADMIN_UID_CONFLICT');
  if (!profile.exists || !profileMatches(profile.data(), mapping, academicYear))
    throw new Error('STUDENT_PROFILE_CONFLICT');
  if (
    user.uid !== mapping.student_id ||
    ![email, studentEmail(mapping.student_id, projectId)].includes(user.email?.toLowerCase())
  )
    throw new Error('AUTH_IDENTITY_CONFLICT');
  if (emailOwner && emailOwner.uid !== mapping.student_id)
    throw new Error('LOGIN_EMAIL_CONFLICT');
  if (aliases.docs.some((snapshot) => snapshot.id !== mapping.student_id))
    throw new Error('LOGIN_PROFILE_CONFLICT');
  const linkedAuth = user.email.toLowerCase() === email;
  const linkedProfile = profile.data().login_id === mapping.login_id;
  return {
    email,
    user,
    profile,
    action:
      linkedAuth && linkedProfile
        ? 'unchanged'
        : linkedAuth
          ? 'recover_profile'
          : linkedProfile
            ? 'recover_auth'
            : 'link',
  };
}

export async function linkStudentLogin(auth, db, mapping, projectId, academicYear, timestamp) {
  const before = await inspectLoginMapping(auth, db, mapping, projectId, academicYear);
  if (before.action === 'unchanged') return 'unchanged';
  // UID and password are deliberately absent: email is the only Auth field changed.
  if (before.user.email.toLowerCase() !== before.email)
    await auth.updateUser(mapping.student_id, { email: before.email });
  await db.runTransaction(async (tx) => {
    const ref = db.doc(`students/${mapping.student_id}`);
    const [profile, admin] = await Promise.all([
      tx.get(ref),
      tx.get(db.doc(`admins/${mapping.student_id}`)),
    ]);
    if (admin.exists) throw new Error('ADMIN_UID_CONFLICT');
    if (!profile.exists || !profileMatches(profile.data(), mapping, academicYear))
      throw new Error('STUDENT_PROFILE_CONFLICT');
    if (profile.data().login_id !== mapping.login_id)
      tx.update(ref, { login_id: mapping.login_id, updated_at: timestamp() });
  });
  if (
    (await inspectLoginMapping(auth, db, mapping, projectId, academicYear)).action !==
    'unchanged'
  )
    throw new Error('POST_LINK_VERIFICATION_FAILED');
  return before.action === 'link' ? 'linked' : 'recovered';
}

function argumentsFrom(args) {
  const options = { apply: false, concurrency: 5 };
  let mode;
  const keys = new Set([
    'input',
    'project',
    'report',
    'only',
    'academic-year',
    'admin-module-dir',
    'credential-module',
    'concurrency',
  ]);
  for (let index = 0; index < args.length; index++) {
    const key = args[index].replace(/^--/, '');
    if (!args[index].startsWith('--')) throw new Error('INVALID_ARGUMENTS');
    if (key === 'apply' || key === 'dry-run') {
      if (mode && mode !== key) throw new Error('CONFLICTING_MODES');
      mode = key;
      options.apply = key === 'apply';
    } else if (keys.has(key) && args[index + 1] && !args[index + 1].startsWith('--'))
      options[key] = args[++index];
    else throw new Error('INVALID_ARGUMENTS');
  }
  options.concurrency = Number(options.concurrency);
  options.academicYear = Number(options['academic-year']);
  if (
    !options.input ||
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options.project ?? '') ||
    !Number.isInteger(options.academicYear) ||
    options.academicYear < 2020 ||
    options.academicYear > 2100
  )
    throw new Error(
      'Usage: node db/scripts/link-student-logins.mjs --input PRIVATE.json --project PROJECT --academic-year YEAR [--dry-run|--apply] [--concurrency 1..10]',
    );
  if (
    !Number.isInteger(options.concurrency) ||
    options.concurrency < 1 ||
    options.concurrency > 10
  )
    throw new Error('INVALID_CONCURRENCY');
  return options;
}

function safeError(error) {
  return /^[A-Z_]+$/.test(error.message ?? '')
    ? error.message
    : String(error.code ?? 'LINK_FAILED');
}

async function run() {
  const options = argumentsFrom(process.argv.slice(2));
  const inputPath = await realpath(resolve(options.input));
  outsideSource(inputPath);
  const reportPath = await privateOutput(
    resolve(options.report ?? `${inputPath}.link-report.json`),
  );
  if (reportPath === inputPath) throw new Error('REPORT_CANNOT_OVERWRITE_MAPPING');
  const all = prepareLoginMappings(
    JSON.parse((await readFile(inputPath, 'utf8')).replace(/^\uFEFF/, '')),
    options.academicYear,
  );
  const rows = options.only ? all.filter((row) => row.student_id === options.only) : all;
  if (!rows.length) throw new Error('NO_SELECTED_STUDENT');
  const dependencyPath = options['admin-module-dir'] ?? process.env.FIREBASE_ADMIN_MODULE_DIR;
  const require = createRequire(
    dependencyPath ? resolve(dependencyPath, '__student_link__.cjs') : import.meta.url,
  );
  let appSdk, authSdk, dbSdk;
  try {
    appSdk = require('firebase-admin/app');
    authSdk = require('firebase-admin/auth');
    dbSdk = require('firebase-admin/firestore');
  } catch {
    throw new Error('FIREBASE_ADMIN_REQUIRED');
  }
  let credential;
  if (options['credential-module']) {
    const path = await realpath(resolve(options['credential-module']));
    outsideSource(path);
    if (path === reportPath) throw new Error('REPORT_CANNOT_OVERWRITE_CREDENTIAL_MODULE');
    const module = await import(pathToFileURL(path).href);
    credential =
      typeof module.default === 'function'
        ? await module.default(options.project)
        : module.default;
    if (typeof credential?.getAccessToken !== 'function')
      throw new Error('INVALID_CREDENTIAL_MODULE');
  }
  const app = appSdk.initializeApp({
    projectId: options.project,
    ...(credential ? { credential } : {}),
  });
  const auth = authSdk.getAuth(app),
    db = dbSdk.getFirestore(app);
  const report = {
    mode: options.apply ? 'apply' : 'dry-run',
    project: options.project,
    academicYear: options.academicYear,
    selected: rows.length,
    concurrency: options.concurrency,
    started_at: new Date().toISOString(),
    phase: 'preflight',
    results: [],
  };
  let checkpoints = Promise.resolve();
  function checkpoint() {
    const body = JSON.stringify(report, null, 2) + '\n';
    checkpoints = checkpoints.then(async () => {
      const temporary = `${reportPath}.checkpoint-${process.pid}`;
      let owned = false;
      try {
        await writeFile(temporary, body, { mode: 0o600, flag: 'wx' });
        owned = true;
        await retryFileOperation(() => rename(temporary, reportPath));
      } catch (error) {
        if (owned) {
          try {
            await retryFileOperation(() => unlink(temporary));
          } catch {
            /* Existing report remains intact. */
          }
        }
        throw error;
      }
    });
    return checkpoints;
  }
  async function phase(apply) {
    return processRoster(
      rows,
      options.concurrency,
      async (row) => {
        try {
          return {
            ...row,
            status: apply
              ? await linkStudentLogin(
                  auth,
                  db,
                  row,
                  options.project,
                  options.academicYear,
                  () => dbSdk.FieldValue.serverTimestamp(),
                )
              : (
                  await inspectLoginMapping(
                    auth,
                    db,
                    row,
                    options.project,
                    options.academicYear,
                  )
                ).action,
          };
        } catch (error) {
          return { ...row, status: 'error', error: safeError(error) };
        }
      },
      async (results) => {
        report.results = results;
        await checkpoint();
      },
    );
  }
  try {
    await checkpoint();
    report.results = await phase(false);
    // No mutation begins until every remote identity and target alias has passed.
    if (options.apply && !report.results.some((row) => row.status === 'error')) {
      report.phase = 'apply';
      report.results = [];
      await checkpoint();
      report.results = await phase(true);
    }
    report.completed_at = new Date().toISOString();
    report.counts = Object.fromEntries(
      [...new Set(report.results.map((row) => row.status))].map((status) => [
        status,
        report.results.filter((row) => row.status === status).length,
      ]),
    );
    await checkpoint();
    console.log(
      JSON.stringify({
        mode: report.mode,
        phase: report.phase,
        selected: rows.length,
        counts: report.counts,
      }),
    );
    if (report.counts.error) process.exitCode = 1;
  } finally {
    await appSdk.deleteApp(app);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  run().catch((error) => {
    console.error(error.message?.startsWith('Usage:') ? error.message : safeError(error));
    process.exitCode = 1;
  });
