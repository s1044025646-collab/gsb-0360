import { DatabaseSync } from "node:sqlite";
import {
  ValidationError, parseAddress, validateK, historyMask, step as predictorStep, StepResult,
} from "./predictor";

export interface RunRow {
  id: number; trace_id: number; k: number; position: number; history: number; counters: string;
}

export class Service {
  constructor(public db: DatabaseSync) {}

  createTrace(name: string, records: Array<{ address: unknown; taken: unknown }>): number {
    if (typeof name !== "string" || name.length === 0) {
      throw new ValidationError("INVALID_INPUT", "轨迹名称不能为空");
    }
    if (!Array.isArray(records)) throw new ValidationError("INVALID_INPUT", "records 必须是数组");
    const parsed = records.map((r, i) => {
      if (typeof r !== "object" || r === null) throw new ValidationError("INVALID_INPUT", `记录 ${i} 非法`);
      const address = parseAddress((r as any).address);
      const taken = (r as any).taken;
      if (typeof taken !== "boolean") throw new ValidationError("INVALID_INPUT", `记录 ${i} 的 taken 必须是布尔值`);
      return { address, taken };
    });
    this.db.exec("BEGIN");
    try {
      const res = this.db.prepare("INSERT INTO traces (name) VALUES (?)").run(name);
      const traceId = Number(res.lastInsertRowid);
      const ins = this.db.prepare("INSERT INTO trace_records (trace_id, seq, address, taken) VALUES (?, ?, ?, ?)");
      parsed.forEach((r, i) => ins.run(traceId, i, r.address, r.taken ? 1 : 0));
      this.db.exec("COMMIT");
      return traceId;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  listTraces() {
    return this.db.prepare(`
      SELECT t.id, t.name, t.created_at, COUNT(r.seq) AS record_count
      FROM traces t LEFT JOIN trace_records r ON r.trace_id = t.id
      GROUP BY t.id ORDER BY t.id`).all();
  }

  getTraceRecords(traceId: number): Array<{ address: number; taken: boolean }> {
    const rows = this.db.prepare("SELECT address, taken FROM trace_records WHERE trace_id = ? ORDER BY seq").all(traceId) as any[];
    if (rows.length === 0 && !this.db.prepare("SELECT id FROM traces WHERE id = ?").get(traceId)) {
      throw new ValidationError("NOT_FOUND", `轨迹不存在: ${traceId}`);
    }
    return rows.map((r) => ({ address: r.address, taken: r.taken === 1 }));
  }

  createRun(traceId: number, k: number): number {
    validateK(k);
    this.getTraceRecords(traceId); // 确认轨迹存在
    const size = 1 << k;
    const counters = JSON.stringify(new Array(size).fill(1));
    const res = this.db.prepare("INSERT INTO runs (trace_id, k, position, history, counters) VALUES (?, ?, 0, 0, ?)")
      .run(traceId, k, counters);
    return Number(res.lastInsertRowid);
  }

  getRun(runId: number): RunRow {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
    if (!row) throw new ValidationError("NOT_FOUND", `运行不存在: ${runId}`);
    return row;
  }

  traceLength(traceId: number): number {
    const r = this.db.prepare("SELECT COUNT(*) AS c FROM trace_records WHERE trace_id = ?").get(traceId) as any;
    return r.c as number;
  }

  /** 推进至多 n 步（n=1 即单步）。原子写入位置、历史、表项与步骤。 */
  advance(runId: number, n: number): { processed: number; finished: boolean; steps: StepResult[] } {
    if (!Number.isInteger(n) || n < 1) throw new ValidationError("INVALID_INPUT", "步数必须是正整数");
    const run = this.getRun(runId);
    const records = this.getTraceRecords(run.trace_id);
    const remaining = records.length - run.position;
    if (remaining === 0) throw new ValidationError("RUN_FINISHED", `运行 ${runId} 已处理完整条轨迹，拒绝追加训练`);
    const count = Math.min(n, remaining);
    const table: number[] = JSON.parse(run.counters);
    let history = run.history;
    const steps: StepResult[] = [];
    this.db.exec("BEGIN");
    try {
      const ins = this.db.prepare(`INSERT INTO steps
        (run_id, branch_no, address, old_history, idx, counter_before, prediction, actual, hit, counter_after, new_history)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (let i = 0; i < count; i++) {
        const rec = records[run.position + i];
        const s = predictorStep(rec.address, rec.taken, history, table, run.k);
        history = s.newHistory;
        steps.push(s);
        ins.run(runId, run.position + i + 1, s.address, s.oldHistory, s.index, s.counterBefore,
          s.prediction ? 1 : 0, s.actual ? 1 : 0, s.hit ? 1 : 0, s.counterAfter, s.newHistory);
      }
      this.db.prepare("UPDATE runs SET position = position + ?, history = ?, counters = ? WHERE id = ?")
        .run(count, history, JSON.stringify(table), runId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    const finished = run.position + count >= records.length;
    return { processed: count, finished, steps };
  }

  getStep(runId: number, branchNo: number) {
    const row = this.db.prepare("SELECT * FROM steps WHERE run_id = ? AND branch_no = ?").get(runId, branchNo);
    if (!row) throw new ValidationError("NOT_FOUND", `运行 ${runId} 不存在步骤 ${branchNo}`);
    return row;
  }

  getSteps(runId: number, limit?: number) {
    this.getRun(runId);
    const sql = limit != null
      ? "SELECT * FROM steps WHERE run_id = ? ORDER BY branch_no LIMIT ?"
      : "SELECT * FROM steps WHERE run_id = ? ORDER BY branch_no";
    return limit != null
      ? this.db.prepare(sql).all(runId, limit)
      : this.db.prepare(sql).all(runId);
  }

  getTable(runId: number) {
    const run = this.getRun(runId);
    const table: number[] = JSON.parse(run.counters);
    return { k: run.k, size: table.length, counters: table };
  }

  /** 统计：空轨迹用 noData 表达，绝不产生 NaN。 */
  getStats(runId: number) {
    const run = this.getRun(runId);
    const total = this.traceLength(run.trace_id);
    const agg = this.db.prepare("SELECT COUNT(*) AS processed, COALESCE(SUM(hit),0) AS hits FROM steps WHERE run_id = ?")
      .get(runId) as any;
    const processed = agg.processed as number;
    const hits = agg.hits as number;
    return {
      runId, k: run.k, traceLength: total, processed, hits,
      misses: processed - hits,
      accuracy: processed === 0 ? null : hits / processed,
      noData: processed === 0,
      finished: processed >= total,
    };
  }

  /** 按地址汇总，并与“始终预测不跳转”基准比较。 */
  getReport(runId: number) {
    const run = this.getRun(runId);
    const stats = this.getStats(runId);
    const byAddress = this.db.prepare(`
      SELECT address, COUNT(*) AS visits, SUM(CASE WHEN hit = 0 THEN 1 ELSE 0 END) AS misses
      FROM steps WHERE run_id = ? GROUP BY address ORDER BY address`).all(runId) as any[];
    const baseline = this.db.prepare(`
      SELECT COUNT(*) AS processed, SUM(actual) AS taken_count FROM steps WHERE run_id = ?`).get(runId) as any;
    const processed = baseline.processed as number;
    const takenCount = (baseline.taken_count ?? 0) as number;
    const baselineMisses = takenCount; // 始终预测不跳：误预测数 = 实际跳转数
    return {
      runId, k: run.k, stats,
      byAddress: byAddress.map((r) => ({ address: r.address, visits: r.visits, misses: r.misses })),
      baseline: {
        name: "always-not-taken",
        misses: baselineMisses,
        accuracy: processed === 0 ? null : (processed - baselineMisses) / processed,
      },
    };
  }

  /** 检测混叠：不同地址映射到同一表项的步骤。 */
  getAliases(runId: number) {
    this.getRun(runId);
    return this.db.prepare(`
      SELECT idx, COUNT(DISTINCT address) AS addr_count,
             GROUP_CONCAT(DISTINCT printf('0x%08X', address)) AS addresses
      FROM steps WHERE run_id = ? GROUP BY idx HAVING addr_count > 1 ORDER BY idx`).all(runId);
  }
}

export { ValidationError, historyMask };
