// Shared safeguards for private backup restoration; no student account provisioning.
import { realpath, lstat } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));

export async function processRows(rows, concurrency, work, onResult) {
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
