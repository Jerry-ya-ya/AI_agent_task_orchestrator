import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function lockRuntimeDatabase(databasePath: string): () => void {
  const directory = dirname(databasePath);
  mkdirSync(directory, { recursive: true });
  const canonicalPath = existsSync(databasePath)
    ? realpathSync(databasePath)
    : join(realpathSync(directory), basename(databasePath));
  // Keep the lock in a separate SQLite file so the worker can write to the main database.
  const lock = new DatabaseSync(canonicalPath + '.runtime-lock.sqlite');
  try {
    lock.exec('BEGIN IMMEDIATE');
  } catch (cause) {
    lock.close();
    throw new Error('This database already has a running backend or could not be locked. Close the other backend and try again.', { cause });
  }
  return () => lock.close();
}
