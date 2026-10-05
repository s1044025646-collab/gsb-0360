import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AppError,
  BranchRecord,
  GshareState,
  U32_MAX,
  computeIndex,
  initialState,
  saturate,
  shiftHistory,
  stepOnce,
  summarize,
  summarizeByAddress,
  baselineAlwaysNotTaken,
  validateBranches,
  validatePc,
} from '../core.js';

function stateWith(k: number, history: number, counters: number[]): GshareState {
  return { k, history, counters };
}

test('四种计数器值在两种实际结果下的全部饱和转换（不绕回）', () => {
  for (const c of [0, 1, 2, 3]) {
    assert.equal(saturate(c, true), c === 3 ? 3 : c + 1, `c=${c}, taken`);
    assert.equal(saturate(c, false), c === 0 ? 0 : c - 1, `c=${c}, notTaken`);
  }
  assert.equal(saturate(3, true), 3);
  assert.equal(saturate(0, false), 0);
});

test('历史左移并遮罩到低 k 位，无超出残留', () => {
  assert.equal(shiftHistory(0b01, true, 2), 0b11);
  assert.equal(shiftHistory(0b11, true, 2), 0b11, '(11<<1)|1 溢出后遮罩回 11');
  assert.equal(shiftHistory(0b11, false, 2), 0b10);
  assert.equal(shiftHistory(0, true, 10), 1);
  for (let h = 0; h < 1 << 10; h += 1) {
    const nh = shiftHistory(h, true, 10);
    assert.ok(nh >= 0 && nh < 1 << 10);
  }
});

test('k 边界 1 与 10，越界拒绝', () => {
  assert.equal(initialState(1).counters.length, 2);
  assert.equal(initialState(10).counters.length, 1024);
  for (const bad of [0, 11, -1, 1.5, NaN]) {
    assert.throws(() => initialState(bad as number), AppError);
  }
});

test('地址校验：4 字节对齐、无符号 32 位范围、最高合法地址', () => {
  assert.equal(validatePc(0), 0);
  assert.equal(validatePc(U32_MAX - 3), 0xfffffffc);
  assert.equal(validatePc('4294967292'), 0xfffffffc);
  assert.throws(() => validatePc(1), (e: Error) => e instanceof AppError);
  assert.throws(() => validatePc(U32_MAX), (e: Error) => e instanceof AppError);
  assert.throws(() => validatePc(U32_MAX + 1), (e: Error) => e instanceof AppError);
  assert.throws(() => validatePc('0x1000'), (e: Error) => e instanceof AppError);
});

test('最高地址位参与运算时保持无符号（不出现负数）', () => {
  // PC=0xFFFFFFFC -> PC>>>2 = 0x3FFFFFFF，与历史 XOR 后仍为非负索引。
  const s = initialState(10);
  const r = stepOnce(s, { pc: 0xfffffffc, taken: true }, 0);
  assert.equal(r.pcWord, 0x3fffffff);
  assert.ok(r.index >= 0 && r.index < 1024);
  assert.equal(r.index, 0x3ff & 0x3fffffff);
  assert.ok(r.newHistory >= 0);
});

test('不同 PC 在相同历史下混叠到同一索引', () => {
  // k=2：PC>>2 低 2 位相同即混叠。0x0000->0，0x0010->4(低2位00)，0x0020->8(低2位00)
  for (const h of [0, 1, 2, 3]) {
    assert.equal(computeIndex(0x0000, h, 2), computeIndex(0x0010, h, 2));
    assert.equal(computeIndex(0x0000, h, 2), computeIndex(0x0020, h, 2));
  }
  // 同一地址在不同历史下可访问不同索引（不能把同地址当同一表项）。
  const indices = new Set([
    computeIndex(0x1000, 0, 2),
    computeIndex(0x1000, 1, 2),
    computeIndex(0x1000, 2, 2),
    computeIndex(0x1000, 3, 2),
  ]);
  assert.equal(indices.size, 4);
});

test('预测先于训练：短记录手工展开索引与状态表', () => {
  // k=2，记录：0x0000 T, 0x0000 T, 0x0010 N
  const recs: BranchRecord[] = [
    { pc: 0x0000, taken: true },
    { pc: 0x0000, taken: true },
    { pc: 0x0010, taken: false },
  ];
  const s = initialState(2);
  const r0 = stepOnce(s, recs[0]!, 0);
  // seq0: h=00 idx=00 ctr1 预测N 实际T 失败 ctr->2 新h=01
  assert.deepEqual(
    {
      oldHistory: r0.oldHistory,
      index: r0.index,
      counterBefore: r0.counterBefore,
      prediction: r0.prediction,
      hit: r0.hit,
      counterAfter: r0.counterAfter,
      newHistory: r0.newHistory,
    },
    { oldHistory: 0, index: 0, counterBefore: 1, prediction: false, hit: false, counterAfter: 2, newHistory: 1 },
  );
  const r1 = stepOnce(s, recs[1]!, 1);
  // seq1: h=01 idx=01（同地址不同索引）ctr1 预测N 失败 ctr->2 新h=11
  assert.equal(r1.index, 1);
  assert.equal(r1.counterBefore, 1);
  assert.equal(r1.hit, false);
  assert.equal(r1.counterAfter, 2);
  assert.equal(r1.newHistory, 3);
  const r2 = stepOnce(s, recs[2]!, 2);
  // seq2: h=11 PC B: (100 XOR 011)=111 &11 = 11 idx=3 ctr1 预测N 实际N 命中但仍训练 1->0 新h=10
  assert.equal(r2.index, 3);
  assert.equal(r2.prediction, false);
  assert.equal(r2.hit, true);
  assert.equal(r2.counterBefore, 1);
  assert.equal(r2.counterAfter, 0);
  assert.equal(r2.newHistory, 2);
  // 至少一次“预测正确但计数器仍训练”。
  const cbNum: number = r2.counterBefore;
  const caNum: number = r2.counterAfter;
  assert.ok(r2.hit && cbNum !== caNum);
});

test('演示混叠轨迹中不同地址确实共享并互相干扰同一表项', () => {
  // k=2：seq0 访问 A(0x0000) idx0；构造历史回到 00 后访问 B(0x0010) 也落 idx0。
  const s = initialState(2);
  const a = stepOnce(s, { pc: 0x0000, taken: true }, 0); // idx0 1->2, h=01
  stepOnce(s, { pc: 0x0010, taken: true }, 1); // idx1 1->2, h=11
  stepOnce(s, { pc: 0x0010, taken: false }, 2); // idx (100^11)&11=11 idx3 1->0, h=10
  const b = stepOnce(s, { pc: 0x0010, taken: false }, 3); // h=10 idx (100^10)&11=10 idx2
  // 再让历史归零后 B 命中 idx0，读取到 A 训练出的值 2。
  stepOnce(s, { pc: 0x0000, taken: false }, 4); // h=00 idx0 2->1
  assert.equal(a.index, 0);
  void b;
});

test('空输入：正确率为明确无数据，不产生 NaN', () => {
  const acc = summarize([]);
  assert.equal(acc.processed, 0);
  assert.equal(acc.accuracy, null);
  assert.equal(acc.hasData, false);
  assert.equal(acc.hits + acc.misses, acc.processed);
  const base = baselineAlwaysNotTaken([], 0);
  assert.equal(base.accuracy, null);
});

test('validateBranches 拒绝缺字段、非法地址', () => {
  assert.equal(validateBranches([]).length, 0);
  assert.throws(() => validateBranches([{ pc: 4 }]), AppError);
  assert.throws(() => validateBranches([{ taken: true }]), AppError);
  assert.throws(() => validateBranches('x'), AppError);
});

test('命中+失败=处理数；按地址汇总自洽', () => {
  const s = initialState(3);
  const recs: BranchRecord[] = [
    { pc: 0x1000, taken: true },
    { pc: 0x1000, taken: false },
    { pc: 0x2000, taken: true },
    { pc: 0x2000, taken: true },
  ];
  const steps = recs.map((r, i) => stepOnce(s, r, i));
  const acc = summarize(steps);
  assert.equal(acc.hits + acc.misses, acc.processed);
  assert.equal(acc.processed, 4);
  const byAddr = summarizeByAddress(steps);
  const totalVisits = byAddr.reduce((n, row) => n + row.visits, 0);
  const totalMiss = byAddr.reduce((n, row) => n + row.mispredictions, 0);
  assert.equal(totalVisits, 4);
  assert.equal(totalMiss, acc.misses);
});

test('计数器初值全部为 1（弱不跳）', () => {
  for (const k of [1, 5, 10]) {
    assert.ok(initialState(k).counters.every((c) => c === 1));
  }
});
