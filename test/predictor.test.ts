import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAddress, validateK, historyMask, computeIndex, predict, updateCounter, updateHistory, step,
  ValidationError,
} from "../src/predictor";

test("二位饱和计数器：四种值 x 两种结果的全部转换", () => {
  assert.equal(updateCounter(0, true), 1);
  assert.equal(updateCounter(1, true), 2);
  assert.equal(updateCounter(2, true), 3);
  assert.equal(updateCounter(3, true), 3);
  assert.equal(updateCounter(0, false), 0);
  assert.equal(updateCounter(1, false), 0);
  assert.equal(updateCounter(2, false), 1);
  assert.equal(updateCounter(3, false), 2);
  assert.equal(predict(0), false);
  assert.equal(predict(1), false);
  assert.equal(predict(2), true);
  assert.equal(predict(3), true);
});

test("历史遮罩：左移不残留超出 k 位", () => {
  assert.equal(historyMask(1), 0b1);
  assert.equal(historyMask(10), 0b1111111111);
  let h = 0;
  for (let i = 0; i < 20; i++) h = updateHistory(h, true, 4);
  assert.equal(h, 0b1111);
  h = updateHistory(0b1111, false, 4);
  assert.equal(h, 0b1110);
  assert.equal(updateHistory(0b101, true, 3), 0b011);
});

test("地址校验：对齐、范围、无符号", () => {
  assert.equal(parseAddress("0x00001000"), 0x1000);
  assert.equal(parseAddress(4096), 4096);
  assert.equal(parseAddress("0xFFFFFFFC"), 0xfffffffc);
  assert.throws(() => parseAddress("0x1002"), /四字节对齐/);
  assert.throws(() => parseAddress(0x100000000), /超出/);
  assert.throws(() => parseAddress(-4), /超出/);
  assert.throws(() => parseAddress("xyz"), /无法解析/);
});

test("索引计算：无符号口径，最高地址位不变负", () => {
  const idx = computeIndex(0xfffffffc, 0, 10);
  assert.ok(idx >= 0 && idx < 1024);
  assert.equal(idx, (0xfffffffc >>> 2) & 0x3ff);
  const k = 4;
  assert.equal(computeIndex(0x1000, 0, k), computeIndex(0x1040, 0, k));
  assert.notEqual(computeIndex(0x1000, 0b0001, k), computeIndex(0x1000, 0b0010, k));
});

test("k 边界", () => {
  assert.equal(validateK(1), 1);
  assert.equal(validateK(10), 10);
  assert.throws(() => validateK(0), (e) => e instanceof ValidationError && e.code === "INVALID_K");
  assert.throws(() => validateK(11), (e) => e instanceof ValidationError);
  assert.throws(() => validateK(2.5), (e) => e instanceof ValidationError);
});

test("单步：预测先于训练，训练用旧索引", () => {
  const table = new Array(4).fill(1);
  const s = step(0x1000, true, 0, table, 2);
  assert.equal(s.oldHistory, 0);
  assert.equal(s.counterBefore, 1);
  assert.equal(s.prediction, false);
  assert.equal(s.hit, false);
  assert.equal(s.counterAfter, 2);
  assert.equal(s.newHistory, 1);
  assert.equal(table[s.index], 2);
});
