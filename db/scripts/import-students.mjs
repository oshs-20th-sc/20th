import { readFile, writeFile, realpath, lstat, rename, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const validId = /^\d{2}1(?:0[1-9]|[1-9]\d)(?:0[1-9]|[1-9]\d)$/;
const opaqueUid = /^[A-Za-z0-9_-]{20}$/;
const currentId = /^[1-3](?:0[1-9]|[1-9]\d)(?:0[1-9]|[1-9]\d)$/;
const identity = (student) => student.uid ?? student.student_id;

export function studentEmail(studentId, projectId) {
  return `${studentId.toLowerCase()}@students.${projectId}.invalid`;
}

export function prepareRoster(input) {
  const rows = Array.isArray(input) ? input : input?.students;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('EMPTY_ROSTER');
  const seen = new Set(),
    uids = new Set(),
    logins = new Set(),
    emails = new Set();
  return rows.map((row) => {
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      Object.keys(row).some(
        (key) =>
          !['uid', 'admission_id', 'student_name', 'admission_year', 'login_id'].includes(key),
      )
    )
      throw new Error('INVALID_ROSTER_FIELDS');
    const id = String(row.admission_id ?? '')
      .normalize('NFKC')
      .trim();
    const name = String(row.student_name ?? '')
      .normalize('NFC')
      .trim();
    const year = row.admission_year;
    if (
      typeof row.uid !== 'string' ||
      !opaqueUid.test(row.uid) ||
      !validId.test(id) ||
      !Number.isInteger(year) ||
      year !== 2000 + Number(id.slice(0, 2)) ||
      !name ||
      Array.from(name).length > 30 ||
      /[\p{Cc}\p{Cf}]/u.test(name)
    )
      throw new Error('INVALID_ROSTER_ROW');
    if (seen.has(id)) throw new Error('DUPLICATE_STUDENT_ID');
    if (uids.has(row.uid)) throw new Error('DUPLICATE_UID');
    if (
      row.login_id !== undefined &&
      (typeof row.login_id !== 'string' ||
        !currentId.test(row.login_id) ||
        logins.has(row.login_id))
    )
      throw new Error('INVALID_OR_DUPLICATE_LOGIN_ID');
    const emailKey = row.login_id ?? row.uid.toLowerCase();
    if (emails.has(emailKey)) throw new Error('DUPLICATE_INTERNAL_EMAIL');
    seen.add(id);
    uids.add(row.uid);
    if (row.login_id) logins.add(row.login_id);
    emails.add(emailKey);
    return {
      uid: row.uid,
      admission_id: id,
      student_name: name,
      admission_year: year,
      ...(row.login_id ? { login_id: row.login_id } : {}),
    };
  });
}

function sameIdentity(data, student) {
  return (
    data?.student_id === identity(student) &&
    data?.student_name === student.student_name &&
    data?.admission_year === student.admission_year
  );
}

export function validDocument(data, student) {
  const fields = [
    'student_id',
    'student_name',
    'admission_year',
    'is_active',
    'write_blocked',
    'blocked_until',
    'created_at',
    'updated_at',
  ];
  return (
    sameIdentity(data, student) &&
    fields.every((key) => Object.hasOwn(data, key)) &&
    Object.keys(data).every(
      (key) => fields.includes(key) || key === 'last_moderation_id' || key === 'login_id',
    ) &&
    (!Object.hasOwn(data, 'login_id') ||
      (typeof data.login_id === 'string' && /^[1-3][0-9]{4}$/.test(data.login_id))) &&
    (!Object.hasOwn(data, 'last_moderation_id') ||
      (typeof data.last_moderation_id === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          data.last_moderation_id,
        ))) &&
    typeof data.is_active === 'boolean' &&
    typeof data.write_blocked === 'boolean' &&
    (data.blocked_until === null || typeof data.blocked_until?.toMillis === 'function') &&
    typeof data.created_at?.toMillis === 'function' &&
    typeof data.updated_at?.toMillis === 'function'
  );
}

async function authUser(auth, uid) {
  try {
    return await auth.getUser(uid);
  } catch (error) {
    if (error.code === 'auth/user-not-found') return null;
    throw error;
  }
}

function matchesAuth(user, email, student) {
  return user.uid === identity(student) && user.email?.toLowerCase() === email;
}

export async function inspectStudent(auth, db, student, projectId) {
  const [user, profile, admin] = await Promise.all([
    authUser(auth, identity(student)),
    db.doc(`students/${identity(student)}`).get(),
    db.doc(`admins/${identity(student)}`).get(),
  ]);
  if (admin.exists) throw new Error('ADMIN_UID_CONFLICT');
  if (profile.exists && !validDocument(profile.data(), student))
    throw new Error('STUDENT_DOCUMENT_CONFLICT');
  const email = studentEmail(
    profile.data()?.login_id ?? student.login_id ?? identity(student),
    projectId,
  );
  if (student.login_id && profile.exists && profile.data().login_id !== student.login_id)
    throw new Error('LOGIN_PROFILE_CONFLICT');
  if (user && !matchesAuth(user, email, student)) throw new Error('AUTH_IDENTITY_CONFLICT');
  try {
    const existingEmail = await auth.getUserByEmail(email);
    if (existingEmail.uid !== identity(student)) throw new Error('EMAIL_UID_CONFLICT');
  } catch (error) {
    if (error.code !== 'auth/user-not-found') throw error;
  }
  // This importer creates Auth first. A document without Auth is an external inconsistency.
  if (profile.exists && !user) throw new Error('AUTH_MISSING_FOR_EXISTING_PROFILE');
  return {
    email,
    user,
    profile,
    action: user ? (profile.exists ? 'unchanged' : 'recover_profile') : 'create_account',
  };
}

export async function importStudent(auth, db, student, projectId, timestamp) {
  if (!opaqueUid.test(student.uid ?? '') || !validId.test(student.admission_id ?? ''))
    throw new Error('OPAQUE_UID_REQUIRED');
  const before = await inspectStudent(auth, db, student, projectId);
  if (before.action === 'unchanged') return 'unchanged';
  let created = false;
  if (!before.user) {
    try {
      // Password is derived only here and is never written to a file or Firestore.
      await auth.createUser({
        uid: student.uid,
        email: before.email,
        password: student.admission_id,
        displayName: student.student_name,
        disabled: false,
      });
      created = true;
    } catch (error) {
      if (!['auth/uid-already-exists', 'auth/email-already-exists'].includes(error.code))
        throw error;
      const concurrent = await inspectStudent(auth, db, student, projectId);
      if (!concurrent.user) throw new Error('CONCURRENT_ACCOUNT_CONFLICT');
    }
  }
  // A retry recovers this step without resetting the already-created Auth password.
  await db.runTransaction(async (tx) => {
    const ref = db.doc(`students/${student.uid}`);
    const adminRef = db.doc(`admins/${student.uid}`);
    const [profile, admin] = await Promise.all([tx.get(ref), tx.get(adminRef)]);
    if (admin.exists) throw new Error('ADMIN_UID_CONFLICT');
    if (profile.exists) {
      if (!validDocument(profile.data(), student)) throw new Error('STUDENT_DOCUMENT_CONFLICT');
      return;
    }
    tx.create(ref, {
      student_id: student.uid,
      student_name: student.student_name,
      admission_year: student.admission_year,
      ...(student.login_id ? { login_id: student.login_id } : {}),
      is_active: true,
      write_blocked: false,
      blocked_until: null,
      created_at: timestamp(),
      updated_at: timestamp(),
    });
  });
  const after = await inspectStudent(auth, db, student, projectId);
  if (after.action !== 'unchanged') throw new Error('POST_IMPORT_VERIFICATION_FAILED');
  return created ? 'created' : 'recovered_profile';
}

function argumentsFrom(args) {
  const options = { apply: false, concurrency: 5 };
  let mode;
  const values = new Set([
    'input',
    'project',
    'report',
    'only',
    'admin-module-dir',
    'credential-module',
    'concurrency',
  ]);
  for (let index = 0; index < args.length; index++) {
    if (!args[index].startsWith('--')) throw new Error('INVALID_ARGUMENTS');
    const key = args[index].replace(/^--/, '');
    if (key === 'apply' || key === 'dry-run') {
      if (mode && mode !== key) throw new Error('CONFLICTING_IMPORT_MODES');
      mode = key;
      options.apply = key === 'apply';
    } else if (values.has(key) && args[index + 1] && !args[index + 1].startsWith('--'))
      options[key] = args[++index];
    else throw new Error('INVALID_ARGUMENTS');
  }
  if (!options.input || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options.project ?? ''))
    throw new Error(
      'Usage: node db/scripts/import-students.mjs --input PRIVATE.json --project PROJECT [--dry-run|--apply] [--only ID] [--report PRIVATE.json] [--concurrency 1..10]',
    );
  options.concurrency = Number(options.concurrency);
  if (
    !Number.isInteger(options.concurrency) ||
    options.concurrency < 1 ||
    options.concurrency > 10
  )
    throw new Error('INVALID_CONCURRENCY');
  return options;
}

export async function processRoster(rows, concurrency, work, onResult) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10)
    throw new Error('INVALID_CONCURRENCY');
  const results = new Array(rows.length);
  let next = 0;
  let failure = null;
  async function worker() {
    while (!failure) {
      const index = next++;
      if (index >= rows.length) return;
      try {
        results[index] = await work(rows[index]);
        await onResult(results.filter(Boolean));
      } catch (error) {
        failure ??= error;
      }
    }
  }
  // Always await in-flight rows before closing the SDK, even if a checkpoint fails.
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  if (failure) throw failure;
  return results;
}

export async function retryFileOperation(
  operation,
  pause = (ms) => new Promise((done) => setTimeout(done, ms)),
) {
  const delays = [50, 100, 200, 400, 800, 1000, 1500];
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= delays.length)
        throw error;
      await pause(delays[attempt]);
    }
  }
}

export function outsideSource(path) {
  const child = relative(sourceRoot, path);
  const escapes = child === '..' || child.startsWith('..' + sep) || isAbsolute(child);
  if (!child || !escapes) throw new Error('PRIVATE_FILE_MUST_BE_OUTSIDE_REPOSITORY');
}

export async function privateOutput(path) {
  const actual = resolve(await realpath(dirname(path)), path.split(/[\\/]/).at(-1));
  outsideSource(actual);
  try {
    if ((await lstat(actual)).isSymbolicLink()) throw new Error('REPORT_SYMLINK_NOT_ALLOWED');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return actual;
}

async function run() {
  const options = argumentsFrom(process.argv.slice(2));
  const inputPath = await realpath(resolve(options.input));
  outsideSource(inputPath);
  const reportPath = await privateOutput(
    resolve(options.report ?? `${inputPath}.import-report.json`),
  );
  if (reportPath === inputPath) throw new Error('REPORT_CANNOT_OVERWRITE_ROSTER');
  // Validate the entire input before --only, so duplicate IDs never pass silently.
  const validated = prepareRoster(
    JSON.parse((await readFile(inputPath, 'utf8')).replace(/^\uFEFF/, '')),
  );
  const students = options.only
    ? validated.filter((row) => row.uid === options.only || row.login_id === options.only)
    : validated;
  if (!students.length) throw new Error('NO_SELECTED_STUDENT');
  const dependencyPath = options['admin-module-dir'] ?? process.env.FIREBASE_ADMIN_MODULE_DIR;
  const require = createRequire(
    dependencyPath ? resolve(dependencyPath, '__student_import__.cjs') : import.meta.url,
  );
  let appSdk, authSdk, dbSdk;
  try {
    appSdk = require('firebase-admin/app');
    authSdk = require('firebase-admin/auth');
    dbSdk = require('firebase-admin/firestore');
  } catch {
    throw new Error(
      'FIREBASE_ADMIN_REQUIRED: install firebase-admin outside the repository and pass --admin-module-dir PATH_TO_NODE_MODULES',
    );
  }
  let credential;
  if (options['credential-module']) {
    const credentialPath = await realpath(resolve(options['credential-module']));
    outsideSource(credentialPath);
    if (credentialPath === reportPath)
      throw new Error('REPORT_CANNOT_OVERWRITE_CREDENTIAL_MODULE');
    const module = await import(pathToFileURL(credentialPath).href);
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
    started_at: new Date().toISOString(),
    input_count: validated.length,
    selected_count: students.length,
    concurrency: options.concurrency,
    results: [],
  };
  let checkpoints = Promise.resolve();
  function checkpoint() {
    const snapshot = JSON.stringify(report, null, 2) + '\n';
    checkpoints = checkpoints.then(async () => {
      const temporary = `${reportPath}.checkpoint-${process.pid}`;
      let ownsTemporary = false;
      try {
        await writeFile(temporary, snapshot, { mode: 0o600, flag: 'wx' });
        ownsTemporary = true;
        // Windows readers and antivirus scans can briefly lock the destination.
        await retryFileOperation(() => rename(temporary, reportPath));
      } catch (error) {
        // Never delete the last valid report to make a rename succeed.
        if (ownsTemporary) {
          try {
            await retryFileOperation(() => unlink(temporary));
          } catch {
            /* A locked temporary file may remain for operator recovery. */
          }
        }
        throw error;
      }
    });
    return checkpoints;
  }
  try {
    await checkpoint();
    report.results = await processRoster(
      students,
      options.concurrency,
      async (student) => {
        const item = {
          uid: student.uid,
          ...(student.login_id ? { login_id: student.login_id } : {}),
        };
        try {
          item.status = options.apply
            ? await importStudent(auth, db, student, options.project, () =>
                dbSdk.FieldValue.serverTimestamp(),
              )
            : (await inspectStudent(auth, db, student, options.project)).action;
        } catch (error) {
          item.status = 'error';
          // Deliberately exclude raw API messages, tokens, emails, and password-bearing payloads.
          item.error = /^[A-Z_]+$/.test(error.message ?? '')
            ? error.message
            : String(error.code ?? 'IMPORT_FAILED');
        }
        return item;
      },
      async (results) => {
        report.results = results;
        await checkpoint();
      },
    );
    report.completed_at = new Date().toISOString();
    report.counts = Object.fromEntries(
      [...new Set(report.results.map((item) => item.status))].map((status) => [
        status,
        report.results.filter((item) => item.status === status).length,
      ]),
    );
    await checkpoint();
    console.log(
      JSON.stringify({
        mode: report.mode,
        selected: students.length,
        concurrency: options.concurrency,
        counts: report.counts,
      }),
    );
    if (report.counts.error) process.exitCode = 1;
  } finally {
    await appSdk.deleteApp(app);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    const message = String(error.message ?? 'IMPORT_FAILED');
    console.error(
      message.startsWith('Usage:') ||
        message.startsWith('FIREBASE_ADMIN_REQUIRED:') ||
        /^[A-Z_]+$/.test(message)
        ? message
        : String(error.code ?? 'IMPORT_FAILED'),
    );
    process.exitCode = 1;
  });
}
