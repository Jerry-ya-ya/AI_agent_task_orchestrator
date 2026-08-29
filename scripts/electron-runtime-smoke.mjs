import { DatabaseSync } from 'node:sqlite';

const database = new DatabaseSync(':memory:');
database.exec('CREATE TABLE smoke (id INTEGER PRIMARY KEY);');
const row = database.prepare('SELECT COUNT(*) AS count FROM smoke').get();
database.close();

if (row?.count !== 0) {
  throw new Error('Electron node:sqlite smoke test returned an unexpected result.');
}

console.log(`Electron ${process.versions.electron}; node:sqlite OK`);
