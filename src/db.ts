import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

export const DATA_DIR = path.join(process.cwd(), "data");
export const DB_PATH = path.join(DATA_DIR, "gshare.db");

export function openDb(dbPath: string = DB_PATH): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS traces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS trace_records (
      trace_id INTEGER NOT NULL REFERENCES traces(id),
      seq INTEGER NOT NULL,
      address INTEGER NOT NULL,
      taken INTEGER NOT NULL,
      PRIMARY KEY (trace_id, seq)
    );
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id INTEGER NOT NULL REFERENCES traces(id),
      k INTEGER NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      history INTEGER NOT NULL DEFAULT 0,
      counters TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS steps (
      run_id INTEGER NOT NULL REFERENCES runs(id),
      branch_no INTEGER NOT NULL,
      address INTEGER NOT NULL,
      old_history INTEGER NOT NULL,
      idx INTEGER NOT NULL,
      counter_before INTEGER NOT NULL,
      prediction INTEGER NOT NULL,
      actual INTEGER NOT NULL,
      hit INTEGER NOT NULL,
      counter_after INTEGER NOT NULL,
      new_history INTEGER NOT NULL,
      PRIMARY KEY (run_id, branch_no)
    );
  `);
  return db;
}
