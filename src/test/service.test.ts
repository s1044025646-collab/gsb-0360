import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'node:test';
import {
  AppError,
  BranchRecord,
  initialState,
  stepOnce,
  StepResult,
} from '../core.js';
import { Store } from '../store.js';
import { Service } from '../service.js';

const stores: Store[] = [];

function makeService(): { service: Service; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gshare-'));
  const dbPath = join(dir, 'test.sqlite');
  const store = new Store(dbPath);
  stores.push(store);
  return { service: new Service(store), dbPath };
}

afterEach(() => {
  while (stores.length) {
    const s = stores.pop();
    try {
      s?.close();
    } catch {
      // ignore
    }
  }
});

const sample: BranchRecord[] = [
  { pc: 0x1000, taken: true },
  { pc: 0x2000, taken: false },
  { pc: 0x3000, taken: true },
  { pc: 0x1000, taken: true },
  { pc: 0x0010, taken: false },
  { pc: 0x0000, taken: true },
  { pc: 0x4000, taken: false },
];

/** 用纯核心一次性跑完，作为对照真值。 */
function referenceRun(branches: BranchRecord[], k: number): StepResult[] {
  const state = initialState(k);
  return branches.map((r, i) => stepOnce(state, r, i));
}

test('逐步运行与批量运行结果完全一致', () => {
  const { service } = makeService();
  const trace = service.saveTrace('t', sample);
  const run = service.createRun(trace.id, 3);

  const oneByOne: StepResult[] = [];
  for (let i = 0; i < sample.length; i += 1) {
    oneByOne.push(...service.advance(run.run.id, 1).steps);
  }

  const { service: svc2 } = makeService();
  const trace2 = svc2.saveTrace('t2', sample);
  const run2 = svc2.createRun(trace2.id, 3);
  const batch = svc2.advance(run2.run.id).steps;

  const ref = referenceRun(sample, 3);
  assert.deepEqual(oneByOne, ref);
  assert.deepEqual(batch, ref);
  assert.deepEqual(oneByOne, batch);
});

test('有限步推进在达到预算但未读完时显示尚未结束', () => {
  const { service } = makeService();
  const trace = service.saveTrace('t', sample);
  const run = service.createRun(trace.id, 3);
  const v = service.advance(run.run.id, 2);
  assert.equal(v.processed, 2);
  assert.equal(v.finished, false);
  assert.equal(v.remaining, sample.length - 2);
  const rest = service.advance(run.run.id, 100);
  assert.equal(rest.processed, sample.length);
  assert.equal(rest.steps.length, sample.length - 2);
  assert.equal(rest.finished, true);
});

test('结束后追加训练被拒绝（RUN_FINISHED）', () => {
  const { service } = makeService();
  const trace = service.saveTrace('t', sample);
  const run = service.createRun(trace.id, 2);
  service.advance(run.run.id);
  assert.throws(
    () => service.advance(run.run.id, 1),
    (e: Error) => e instanceof AppError && e.code === 'RUN_FINISHED',
  );
});

test('空轨迹：正确率无数据且推进即报已结束', () => {
  const { service } = makeService();
  const trace = service.saveTrace('empty', []);
  const run = service.createRun(trace.id, 2);
  assert.equal(run.finished, true);
  assert.throws(() => service.advance(run.run.id, 1), (e: unknown) => e instanceof AppError && e.code === 'RUN_FINISHED');
  const stats = service.getStats(run.run.id);
  assert.equal(stats.accuracy, null);
  assert.equal(stats.hasData, false);
});

test('保存恢复（重新打开数据库）后继续与不中断运行完全相同', () => {
  const { service, dbPath } = makeService();
  const trace = service.saveTrace('t', sample);
  const run = service.createRun(trace.id, 4);
  service.advance(run.run.id, 3);

  // 模拟重启：关闭后用同一文件重新打开，再继续跑完。
  const reopened = new Store(dbPath);
  const svcRestored = new Service(reopened);
  const after = svcRestored.advance(run.run.id);
  reopened.close();

  const re2 = new Store(dbPath);
  const svc2 = new Service(re2);
  const allSteps = svc2.listSteps(run.run.id);

  const ref = referenceRun(sample, 4);
  assert.deepEqual(allSteps, ref);
  assert.deepEqual(
    allSteps.slice(3),
    after.steps,
  );

  // 表项与历史也与参考状态一致。
  const finalState = initialState(4);
  ref.forEach((r) => {
    finalState.history = r.newHistory;
    finalState.counters[r.index] = r.counterAfter;
  });
  const table = svc2.getTable(run.run.id);
  assert.equal(table.history, finalState.history);
  assert.deepEqual(
    table.counters.map((c) => c.counter),
    finalState.counters,
  );
  re2.close();
});

test('同一轨迹不能用不同 k 覆盖；需另存轨迹做独立对照', () => {
  const { service } = makeService();
  const trace = service.saveTrace('t', sample);
  service.createRun(trace.id, 2);
  assert.throws(() => service.createRun(trace.id, 3), (e: unknown) => e instanceof AppError && e.code === 'RUN_EXISTS');

  const traceB = service.saveTrace('t-copy', sample);
  const runB = service.createRun(traceB.id, 3);
  assert.equal(runB.run.k, 3);
});

test('k 非法、步数非法、查看越界步骤都带明确错误码', () => {
  const { service } = makeService();
  const trace = service.saveTrace('t', sample);
  assert.throws(() => service.createRun(trace.id, 11), (e: unknown) => e instanceof AppError && e.code === 'INVALID_K');
  const run = service.createRun(trace.id, 2);
  assert.throws(() => service.advance(run.run.id, 0), (e: unknown) => e instanceof AppError && e.code === 'INVALID_STEP_COUNT');
  assert.throws(() => service.getStep(run.run.id, 0), (e: unknown) => e instanceof AppError && e.code === 'STEP_NOT_FOUND');
});

test('非法轨迹记录在保存时被拒绝（对齐/范围/类型）', () => {
  const { service } = makeService();
  assert.throws(
    () => service.saveTrace('x', [{ pc: 1, taken: true }]),
    (e: unknown) => e instanceof AppError && e.code === 'PC_MISALIGNED',
  );
  assert.throws(
    () => service.saveTrace('x', [{ pc: 0x1_0000_0000, taken: true }]),
    (e: unknown) => e instanceof AppError && e.code === 'PC_OUT_OF_RANGE',
  );
  assert.throws(
    () => service.saveTrace('x', [{ pc: 0, taken: 1 }]),
    (e: unknown) => e instanceof AppError && e.code === 'INVALID_TAKEN',
  );
});

test('报告：命中+失败=处理数、按地址汇总一致、含始终不跳基准', () => {
  const { service } = makeService();
  const trace = service.saveTrace('t', sample);
  const run = service.createRun(trace.id, 3);
  service.advance(run.run.id);
  const report = service.getReport(run.run.id);
  assert.equal(report.gshare.hits + report.gshare.misses, report.processed);
  assert.equal(
    report.byAddress.reduce((n, r) => n + r.visits, 0),
    report.processed,
  );
  assert.equal(
    report.byAddress.reduce((n, r) => n + r.mispredictions, 0),
    report.gshare.misses,
  );
  // 基准误预测数 == 实际 taken 的步数。
  const takenCount = sample.filter((r) => r.taken).length;
  assert.equal(report.baselineAlwaysNotTaken.misses, takenCount);
  assert.equal(report.baselineAlwaysNotTaken.processed, sample.length);
});

test('混叠被持久化并可在步骤中核对：不同地址同一索引', () => {
  const branches: BranchRecord[] = [
    { pc: 0x0000, taken: true },
    { pc: 0x0010, taken: false },
  ];
  const { service } = makeService();
  const trace = service.saveTrace('alias', branches);
  const run = service.createRun(trace.id, 2);
  // 让两条在相同历史下执行：单步后历史会变，这里直接核对各自在 h=0 时的索引设计。
  const s0 = service.advance(run.run.id, 1).steps[0]!;
  assert.equal(s0.index, 0);
  // 第二条当时历史=01；(4 XOR 1)&3 = 1，和 A 在 h=01 时的索引相同（可核对公式）。
  const s1 = service.advance(run.run.id, 1).steps[0]!;
  assert.equal(s1.oldHistory, 1);
  assert.equal(s1.index, (4 ^ 1) & 3);
});

test('最高合法地址可端到端保存、运行并查看步骤', () => {
  const { service } = makeService();
  const trace = service.saveTrace('top', [{ pc: 0xfffffffc, taken: true }]);
  const run = service.createRun(trace.id, 10);
  const v = service.advance(run.run.id, 1);
  assert.equal(v.steps[0]!.pc, 0xfffffffc);
  assert.ok(v.steps[0]!.index >= 0);
  const got = service.getStep(run.run.id, 0);
  assert.equal(got.pc, 0xfffffffc);
});
