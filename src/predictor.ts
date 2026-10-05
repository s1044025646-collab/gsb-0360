// gshare 预测器纯逻辑：无 IO，便于测试与复用。

export const K_MIN = 1;
export const K_MAX = 10;

export class ValidationError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** 校验并解析无符号 32 位、四字节对齐的地址。接受数字或 "0x..." / 十进制字符串。 */
export function parseAddress(input: unknown): number {
  let value: number;
  if (typeof input === "number") {
    value = input;
  } else if (typeof input === "string") {
    const s = input.trim();
    if (/^0x[0-9a-fA-F]+$/.test(s)) value = Number.parseInt(s.slice(2), 16);
    else if (/^[0-9]+$/.test(s)) value = Number.parseInt(s, 10);
    else throw new ValidationError("INVALID_ADDRESS", `无法解析地址: ${input}`);
  } else {
    throw new ValidationError("INVALID_ADDRESS", `地址必须是数字或字符串: ${String(input)}`);
  }
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new ValidationError("INVALID_ADDRESS", `地址超出无符号 32 位范围: ${String(input)}`);
  }
  if (value % 4 !== 0) {
    throw new ValidationError("INVALID_ALIGNMENT", `地址未四字节对齐: ${String(input)}`);
  }
  return value;
}

export function validateK(k: unknown): number {
  if (typeof k !== "number" || !Number.isInteger(k) || k < K_MIN || k > K_MAX) {
    throw new ValidationError("INVALID_K", `k 必须是 ${K_MIN}..${K_MAX} 的整数，收到: ${String(k)}`);
  }
  return k;
}

/** 历史遮罩：保留低 k 位。 */
export function historyMask(k: number): number {
  return (1 << k) - 1; // k <= 10，安全
}

/**
 * 表索引：((PC >>> 2) XOR history) 的低 k 位。
 * 使用 >>> 保证无符号口径，最高地址位不会变成负数。
 */
export function computeIndex(pc: number, history: number, k: number): number {
  const mask = historyMask(k);
  return (((pc >>> 2) ^ (history & mask)) & mask) >>> 0;
}

/** 二位饱和计数器预测：0、1 不跳；2、3 跳。 */
export function predict(counter: number): boolean {
  return counter >= 2;
}

/** 二位饱和计数器更新：向 0 或 3 饱和，不绕回。 */
export function updateCounter(counter: number, taken: boolean): number {
  if (counter < 0 || counter > 3) throw new ValidationError("INVALID_COUNTER", `计数器非法: ${counter}`);
  return taken ? Math.min(3, counter + 1) : Math.max(0, counter - 1);
}

/** 实际结果移入历史，保留低 k 位。 */
export function updateHistory(history: number, taken: boolean, k: number): number {
  return ((history << 1) | (taken ? 1 : 0)) & historyMask(k);
}

export interface StepResult {
  address: number;
  oldHistory: number;
  index: number;
  counterBefore: number;
  prediction: boolean;
  actual: boolean;
  hit: boolean;
  counterAfter: number;
  newHistory: number;
}

/** 单步：先用旧历史与旧计数器预测，再训练计数器，最后更新历史。 */
export function step(pc: number, taken: boolean, history: number, table: number[], k: number): StepResult {
  const oldHistory = history & historyMask(k);
  const index = computeIndex(pc, oldHistory, k);
  const counterBefore = table[index];
  const prediction = predict(counterBefore);
  const hit = prediction === taken;
  const counterAfter = updateCounter(counterBefore, taken);
  table[index] = counterAfter; // 训练发生在预测之后，且使用旧历史算出的索引
  const newHistory = updateHistory(oldHistory, taken, k);
  return { address: pc, oldHistory, index, counterBefore, prediction, actual: taken, hit, counterAfter, newHistory };
}
