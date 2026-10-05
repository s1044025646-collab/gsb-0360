/**
 * SQLite 持久层（Node 内置 node:sqlite，无需本地编译）。
 *
 * 原子性：run 的 position/history 与 counters、steps 的写入放在同一个事务中，
 * 因此重启恢复后的状态与不中断运行严格一致。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  AppError,
  BranchRecord,
  GshareState,
  StepResult,
} from './core.js';

export interface TraceRow {
  id: number;
  name: string | null;
  branches: BranchRecord[];
  createdAt: string;
}

export interface RunRow {
  id: number;
  traceId: number;
  k: number;
  position: number;
  history: number;
  counters: number[];
  createdAt: string;
}

export class Store {
  readonly db: DatabaseSync;
  private open = true;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS traces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        branches TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id INTEGER NOT NULL UNIQUE,
        k INTEGER NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        history INTEGER NOT NULL DEFAULT 0,
        counters TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (trace_id) REFERENCES traces(id)
      );
      CREATE TABLE IF NOT EXISTS steps (
        run_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        pc INTEGER NOT NULL,
        pc_word INTEGER NOT NULL,
        taken INTEGER NOT NULL,
        old_history INTEGER NOT NULL,
        idx INTEGER NOT NULL,
        counter_before INTEGER NOT NULL,
        prediction INTEGER NOT NULL,
        hit INTEGER NOT NULL,
        counter_after INTEGER NOT NULL,
        new_history INTEGER NOT NULL,
        PRIMARY KEY (run_id, seq),
        FOREIGN KEY (run_id) REFERENCES runs(id)
      );
    `);
  }

  // ---------- traces ----------

  createTrace(name: string | null, branches: BranchRecord[]): TraceRow {
    const stmt = this.db.prepare(
      'INSERT INTO traces (name, branches) VALUES (?, ?)',
    );
    const info = stmt.run(name, JSON.stringify(branches));
    return this.getTrace(Number(info.lastInsertRowid))!;
  }

  getTrace(id: number): TraceRow | null {
    const row = this.db
      .prepare('SELECT id, name, branches, created_at FROM traces WHERE id = ?')
      .get(id) as
      | {
          id: number;
          name: string | null;
          branches: string;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      branches: JSON.parse(row.branches) as BranchRecord[],
      createdAt: row.created_at,
    };
  }

  listTraces(): Array<Pick<TraceRow, 'id' | 'name' | 'createdAt'> & {
    length: number;
  }> {
    const rows = this.db
      .prepare('SELECT id, name, branches, created_at FROM traces ORDER BY id')
      .all() as Array<{
      id: number;
      name: string | null;
      branches: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      length: (JSON.parse(r.branches) as BranchRecord[]).length,
      createdAt: r.created_at,
    }));
  }

  // ---------- runs ----------

  createRun(traceId: number, k: number): RunRow {
    const trace = this.getTrace(traceId);
    if (!trace) {
      throw new AppError('TRACE_NOT_FOUND', `轨迹不存在：id=${traceId}`);
    }
    const exists = this.db
      .prepare('SELECT id FROM runs WHERE trace_id = ?')
      .get(traceId);
    if (exists) {
      throw new AppError(
        'RUN_EXISTS',
        `该轨迹已存在运行（一个轨迹对应一个固定 k 的运行；如需对照请另存轨迹）`,
      );
    }
    const counters = new Array<number>(1 << k).fill(1);
    const info = this.db
      .prepare(
        'INSERT INTO runs (trace_id, k, position, history, counters) VALUES (?, ?, 0, 0, ?)',
      )
      .run(traceId, k, JSON.stringify(counters));
    return this.getRun(Number(info.lastInsertRowid))!;
  }

  getRun(id: number): RunRow | null {
    const row = this.db
      .prepare(
        `SELECT id, trace_id, k, position, history, counters, created_at
         FROM runs WHERE id = ?`,
      )
      .get(id) as
      | {
          id: number;
          trace_id: number;
          k: number;
          position: number;
          history: number;
          counters: string;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      traceId: row.trace_id,
      k: row.k,
      position: row.position,
      history: row.history,
      counters: JSON.parse(row.counters) as number[],
      createdAt: row.created_at,
    };
  }

  /** 从持久化行重建内存预测状态。 */
  loadState(run: RunRow): GshareState {
    return { k: run.k, history: run.history, counters: [...run.counters] };
  }

  /**
   * 原子追加若干已处理步骤：
   * 更新 run.position/history/counters，并插入对应 step 行，全部在一个事务内。
   */
  appendSteps(
    runId: number,
    state: GshareState,
    newSteps: StepResult[],
  ): void {
    if (newSteps.length === 0) return;
    const updateRun = this.db.prepare(
      'UPDATE runs SET position = ?, history = ?, counters = ? WHERE id = ?',
    );
    const insertStep = this.db.prepare(
      `INSERT INTO steps
       (run_id, seq, pc, pc_word, taken, old_history, idx, counter_before,
        prediction, hit, counter_after, new_history)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const position = this.getRun(runId)!.position + newSteps.length;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      updateRun.run(
        position,
        state.history,
        JSON.stringify(state.counters),
        runId,
      );
      for (const s of newSteps) {
        insertStep.run(
          runId,
          s.seq,
          s.pc,
          s.pcWord,
          s.taken ? 1 : 0,
          s.oldHistory,
          s.index,
          s.counterBefore,
          s.prediction ? 1 : 0,
          s.hit ? 1 : 0,
          s.counterAfter,
          s.newHistory,
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getStep(runId: number, seq: number): StepResult | null {
    const row = this.db
      .prepare('SELECT * FROM steps WHERE run_id = ? AND seq = ?')
      .get(runId, seq) as StepRow | undefined;
    if (!row) return null;
    return this.hydrateStep(row);
  }

  listSteps(runId: number, limit?: number): StepResult[] {
    const sql =
      'SELECT * FROM steps WHERE run_id = ? ORDER BY seq' +
      (limit !== undefined ? ' LIMIT ' + Math.trunc(limit) : '');
    const rows = this.db.prepare(sql).all(runId) as unknown as StepRow[];
    return rows.map((r) => this.hydrateStep(r));
  }

  private hydrateStep(r: StepRow): StepResult {
    return {
      seq: r.seq,
      pc: r.pc,
      pcWord: r.pc_word,
      taken: r.taken === 1,
      oldHistory: r.old_history,
      index: r.idx,
      counterBefore: r.counter_before,
      prediction: r.prediction === 1,
      hit: r.hit === 1,
      counterAfter: r.counter_after,
      newHistory: r.new_history,
    };
  }
}

interface StepRow {
  seq: number;
  pc: number;
  pc_word: number;
  taken: number;
  old_history: number;
  idx: number;
  counter_before: number;
  prediction: number;
  hit: number;
  counter_after: number;
  new_history: number;
}

let defaultStore: Store | null = null;

/** 项目内数据目录，可通过 GSHARE_DB 覆盖。 */
export function defaultDbPath(): string {
  return process.env.GSHARE_DB ?? 'data/gshare.sqlite';
}

export function getStore(dbPath: string = defaultDbPath()): Store {
  if (!defaultStore) {
    defaultStore = new Store(dbPath);
  }
 return defaultStore;
}

export function resetStoreForTest(dbPath: string): Store {
  if (defaultStore) {
    defaultStore.close();
    defaultStore = null;
  }
  defaultStore = new Store(dbPath);
  return defaultStore;
}
