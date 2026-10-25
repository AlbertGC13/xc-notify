import { openSync, closeSync, readSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const applicationId = 0x58434d49; // XCMI: exclusively owned synthetic Meta inbox.
const version = 1;
const schema = 'CREATE TABLE meta_receipts (sha256 TEXT PRIMARY KEY NOT NULL, body BLOB NOT NULL CHECK(typeof(body)=\'blob\')) WITHOUT ROWID';

function checkHeader(path) {
  if (!lstatSync(path).isFile()) throw new Error('Invalid inbox');
  const fd = openSync(path, 'r');
  try {
    const header = Buffer.alloc(100);
    if (readSync(fd, header, 0, 100, 0) !== 100 ||
        header.subarray(0, 16).toString('binary') !== 'SQLite format 3\0' ||
        header[18] !== 1 || header[19] !== 1 ||
        header.readUInt32BE(68) !== applicationId || header.readUInt32BE(60) !== version) {
      throw new Error('Invalid inbox');
    }
  } finally { closeSync(fd); }
}

function checkSchema(db) {
  const rows = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name').all();
  if (rows.length !== 1 || rows[0].type !== 'table' || rows[0].name !== 'meta_receipts' ||
      rows[0].tbl_name !== 'meta_receipts' || rows[0].sql !== schema ||
      db.prepare('PRAGMA application_id').get().application_id !== applicationId ||
      db.prepare('PRAGMA user_version').get().user_version !== version) {
    throw new Error('Invalid inbox');
  }
}

export function openInbox(path) {
  let fresh = false, db;
  try {
    // Never truncate an existing file. An interrupted, unmarked initialization is
    // deliberately left in place and rejected on the next start, not repaired.
    try { const fd = openSync(path, 'wx', 0o600); closeSync(fd); fresh = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!fresh) {
      // Reject foreign databases BEFORE any SQLite engine open (including read-only).
      checkHeader(path);
      const reader = new DatabaseSync(path, { readOnly: true });
      try { checkSchema(reader); } finally { reader.close(); }
    }
    db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;');
    if (fresh) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(`${schema}; PRAGMA application_id=${applicationId}; PRAGMA user_version=${version}; COMMIT;`);
      } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    }
    const insert = db.prepare('INSERT INTO meta_receipts (sha256, body) VALUES (?, ?) ON CONFLICT(sha256) DO NOTHING');
    const count = db.prepare('SELECT count(*) AS count FROM meta_receipts');
    const find = db.prepare('SELECT body FROM meta_receipts WHERE sha256=?');
    return {
      record(body) {
        const sha256 = createHash('sha256').update(body).digest('hex');
        db.exec('BEGIN IMMEDIATE');
        try {
          insert.run(sha256, body);
          db.exec('COMMIT'); // Must finish before the receiver can acknowledge.
        } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
      },
      count: () => ({ count: count.get().count }),
      receipt(sha256) {
        const row = find.get(sha256);
        if (!row) return null;
        // Diagnostics prove stored bytes, not merely the requested/stored key.
        return { sha256: createHash('sha256').update(row.body).digest('hex'), bytes: row.body.byteLength };
      },
      close: () => db.close()
    };
  } catch (error) { if (db) db.close(); throw error; }
}
