import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const VERSION = 1;
const APPLICATION_ID = 0x44595045;

function corrupt(message) {
  return Object.assign(new Error(message), { code: 'PERSONA_STATE' });
}

function existingFile(file) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw corrupt('人格证据数据库必须是普通文件。');
  return true;
}

function openJournal(file, readOnly) {
  const database = new DatabaseSync(file, { readOnly });
  try {
    database.exec('PRAGMA busy_timeout=1500');
    const id = database.prepare('PRAGMA application_id').get().application_id;
    const version = database.prepare('PRAGMA user_version').get().user_version;
    if (id !== APPLICATION_ID || version !== VERSION) throw corrupt('人格证据数据库格式无效。');
    return database;
  } catch (error) { database.close(); throw error; }
}

export function readEvidenceJournal(file, consume) {
  if (!existingFile(file)) return null;
  const database = openJournal(file, true);
  try {
    let last = 0;
    const digest = createHash('sha256');
    for (const row of database.prepare('SELECT seq, entries FROM changes ORDER BY seq').iterate()) {
      const changes = JSON.parse(row.entries);
      if (row.seq !== last + 1 || !Array.isArray(changes) || changes.length === 0) throw corrupt('人格证据续写记录不完整。');
      consume(changes);
      digest.update(row.entries).update('\0');
      last = row.seq;
    }
    if (!last) throw corrupt('人格证据数据库缺少续写记录。');
    return { count: last, digest: digest.digest('hex') };
  } finally { database.close(); }
}

export { existingFile as hasEvidenceJournal };

export function appendEvidenceJournal(file, changes) {
  const body = JSON.stringify(changes);
  if (existingFile(file)) {
    const database = openJournal(file, false);
    try { database.prepare('INSERT INTO changes(entries) VALUES (?)').run(body); }
    finally { database.close(); }
    return;
  }

  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.closeSync(fs.openSync(temporary, 'wx', 0o600));
  try {
    const database = new DatabaseSync(temporary);
    try {
      database.exec(`BEGIN IMMEDIATE;
        PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${VERSION};
        CREATE TABLE changes(seq INTEGER PRIMARY KEY, entries TEXT NOT NULL CHECK(json_valid(entries)));`);
      database.prepare('INSERT INTO changes(entries) VALUES (?)').run(body);
      database.exec('COMMIT');
    } finally { database.close(); }
    fs.linkSync(temporary, file);
  } finally { fs.unlinkSync(temporary); }
}
