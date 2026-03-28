import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import os from 'os';

const DB_PATH = path.join(os.homedir(), 'projects', 'slack-sync', 'data', 'slack.db');

export function openDb(): Database.Database {
  const db = new Database(DB_PATH);
  sqliteVec.load(db);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  initSchema(db);
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      channel_name TEXT,
      user_id TEXT,
      username TEXT,
      ts TEXT NOT NULL,
      thread_ts TEXT,
      is_thread_root INTEGER DEFAULT 0,
      reply_count INTEGER DEFAULT 0,
      text TEXT,
      raw_json TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id);
    CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_ts);

    CREATE TABLE IF NOT EXISTS sync_state (
      channel_id TEXT PRIMARY KEY,
      last_ts TEXT,
      last_sync INTEGER
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS message_embeddings USING vec0(
      id TEXT PRIMARY KEY,
      embedding FLOAT[768]
    );
  `);
}
