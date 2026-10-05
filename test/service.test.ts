import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openDb } from "../src/db";
import { Service } from "../src/service";
import { computeIndex, updateCounter, updateHistory } from "../src/predictor";

function freshService(dbPath?: string): Service {
  const p = dbPath ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gshare-test-")), "t.db");
  return new Service(openDb(p));
}

test("手工展开：短记录每一步索引与状态", () => {
  const svc = freshService();
  const k = 2;
  const records = [
    { address: 0x1000, taken: true },
    { address: 0x1000, taken: true },
    { address: 0x1004, taken: false },
  ];
  const traceId = svc.createTrace("manual", records);
  const runId = svc.createRun(traceId, k);
  let history = 0;
  const table = new Array(1 << k).fill(1);
  const expected = records.map((r, i) => {
    const idx = computeIndex(r.address, history, k);
    const before = table[idx];
    const prediction = before >= 2;
    const after = updateCounter(before, r.taken);
    table[idx] = after;
    const newHistory = updateHistory(history, r.taken, k);
    const e = { branch_no: i + 1, idx, counter_before: before, prediction: prediction ? 1 : 0,
      actual: r.taken ? 1 : 0, hit: prediction === r.taken ? 1 : 0, counter_after: after, new_history: newHistory };
    history = newHistory;
    return e;
  });
  svc.advance(runId, 3);
  for (const e of expected) {
    const s: any = svc.getStep(runId, e.branch_no);
    for (const key of Object.keys(e)) assert.equal(s[key], (e as any)[key], `step ${e.branch_no} 字段 ${key}`);
  }
});

test("逐步运行与批量运行结果一致", () => {
  const mk = () => {
    const svc = freshService();
    const traceId = svc.createTrace("t", [
      { address: "0x1000", taken: true }, { address: "0x1040", taken: false },
      { address: "0x1000", taken: true }, { address: "0x1040", taken: true },
    ]);
    return { svc, runId: svc.createRun(traceId, 4) };
  };
  const a = mk();
  for (let i = 0; i < 4; i++) a.svc.advance(a.runId, 1);
  const b = mk();
  b.svc.advance(b.runId, 4);
  assert.deepEqual(a.svc.getTable(a.runId), b.svc.getTable(b.runId));
  assert.deepEqual(a.svc.getSteps(a.runId), b.svc.getSteps(b.runId));
});

test("保存恢复后与不间断运行一致", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gshare-test-"));
  const dbPath = path.join(dir, "t.db");
  const records = Array.from({ length: 10 }, (_, i) => ({ address: 0x2000 + (i % 3) * 4, taken: i % 2 === 0 }));
  let svc = freshService(dbPath);
  const traceId = svc.createTrace("resume", records);
  const runA = svc.createRun(traceId, 3);
  svc.advance(runA, 4);
  svc.db.close();
  svc = freshService(dbPath);
  svc.advance(runA, 6);
  const runB = svc.createRun(traceId, 3);
  svc.advance(runB, 10);
  assert.deepEqual(svc.getTable(runA), svc.getTable(runB));
  const strip = (rows: any[]) => rows.map(({ run_id, ...rest }) => rest);
  assert.deepEqual(strip(svc.getSteps(runA) as any[]), strip(svc.getSteps(runB) as any[]));
  const { runId: _a, ...statsA } = svc.getStats(runA);
  const { runId: _b, ...statsB } = svc.getStats(runB);
  assert.deepEqual(statsA, statsB);
});

test("空输入：无数据状态，不产生 NaN", () => {
  const svc = freshService();
  const traceId = svc.createTrace("empty", []);
  const runId = svc.createRun(traceId, 4);
  const stats = svc.getStats(runId);
  assert.equal(stats.noData, true);
  assert.equal(stats.accuracy, null);
  assert.ok(!Number.isNaN(stats.accuracy));
  assert.throws(() => svc.advance(runId, 1), (e: any) => e.code === "RUN_FINISHED");
});

test("最高合法地址 0xFFFFFFFC", () => {
  const svc = freshService();
  const traceId = svc.createTrace("max", [{ address: "0xFFFFFFFC", taken: true }]);
  const runId = svc.createRun(traceId, 10);
  const r = svc.advance(runId, 1);
  assert.equal(r.finished, true);
  const s: any = svc.getStep(runId, 1);
  assert.equal(s.address, 0xfffffffc);
  assert.ok(s.idx >= 0 && s.idx < 1024);
});

test("命中加失败等于处理数；按地址汇总一致", () => {
  const svc = freshService();
  const traceId = svc.createTrace("agg", Array.from({ length: 12 }, (_, i) => ({
    address: 0x3000 + (i % 2) * 4, taken: i % 3 !== 0,
  })));
  const runId = svc.createRun(traceId, 4);
  svc.advance(runId, 12);
  const stats = svc.getStats(runId);
  assert.equal(stats.hits + stats.misses, stats.processed);
  const report = svc.getReport(runId);
  const visits = report.byAddress.reduce((a: number, b: any) => a + b.visits, 0);
  const misses = report.byAddress.reduce((a: number, b: any) => a + b.misses, 0);
  assert.equal(visits, stats.processed);
  assert.equal(misses, stats.misses);
});

test("结束后追加训练被拒绝", () => {
  const svc = freshService();
  const traceId = svc.createTrace("fin", [{ address: 0x1000, taken: true }]);
  const runId = svc.createRun(traceId, 2);
  svc.advance(runId, 1);
  assert.throws(() => svc.advance(runId, 1), (e: any) => e.code === "RUN_FINISHED");
});

test("混叠检测：不同地址共享表项", () => {
  const svc = freshService();
  const traceId = svc.createTrace("alias", [
    { address: "0x00001000", taken: false },
    { address: "0x00001040", taken: false },
  ]);
  const runId = svc.createRun(traceId, 4);
  svc.advance(runId, 2);
  const aliases: any[] = svc.getAliases(runId);
  assert.equal(aliases.length, 1);
  assert.equal(aliases[0].addr_count, 2);
});

test("预测正确但计数器仍训练", () => {
  const svc = freshService();
  const traceId = svc.createTrace("t", Array.from({ length: 10 }, () => ({ address: 0x1000, taken: true })));
  const runId = svc.createRun(traceId, 4);
  svc.advance(runId, 10);
  const steps = svc.getSteps(runId) as any[];
  const s = steps.find((x) => x.counter_before === 2);
  assert.ok(s, "应存在计数器为 2 的步骤");
  assert.equal(s.hit, 1);          // 计数器 2 预测跳转且实际跳转：命中
  assert.equal(s.counter_after, 3); // 但仍训练到 3
});
