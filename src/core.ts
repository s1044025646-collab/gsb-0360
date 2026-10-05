/**
 * gshare 条件分支预测核心（教学模型，纯函数，无外部状态）。
 *
 * 规则（严格按需求）：
 *  - k 位全局历史 + 2^k 项二位饱和计数器，k ∈ [1,10]
 *  - 初始历史为 0；全部计数器初始为 1（弱不跳）
 *  - 索引 = ((PC >>> 2) XOR history) 的低 k 位
 *  - 计数器 0/1 预测不跳(false)，2/3 预测跳转(true)
 *  - 先依据“旧历史 + 旧计数器”预测；再按实际结果饱和更新同一表项；
 *    最后才把实际结果移入历史。不得用新历史索引训练另一个表项。
 *  - 计数器不绕回；历史只保留低 k 位。
 *  - 全部位运算采用无符号 32 位口径（>>> 与 >>> 0），最高地址位不会变负。
 */

export const MIN_K = 1;
export const MAX_K = 10;
export const U32_MAX = 0xffffffff;

/** 应用错误：携带稳定错误码，供 API/CLI 统一映射。 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** 单条有序分支记录。pc 为无符号 32 位且 4 字节对齐。 */
export interface BranchRecord {
  pc: number;
  taken: boolean;
}

/** 一步执行后完整可核对的状态快照。 */
export interface StepResult {
  seq: number; // 分支编号，从 0 开始
  pc: number;
  pcWord: number; // PC >>> 2
  taken: boolean; // 实际结果
  oldHistory: number;
  index: number;
  counterBefore: number;
  prediction: boolean;
  hit: boolean;
  counterAfter: number;
  newHistory: number;
}

/** 可持久化的运行时状态。 */
export interface GshareState {
  k: number;
  history: number;
  counters: number[]; // 长度 2^k
}

export function validateK(k: number): number {
  if (!Number.isInteger(k)) {
    throw new AppError('INVALID_K', `k 必须是整数，收到 ${String(k)}`);
  }
  if (k < MIN_K || k > MAX_K) {
    throw new AppError(
      'INVALID_K',
      `k 必须在 ${MIN_K}..${MAX_K} 之间，收到 ${k}`,
    );
  }
  return k;
}

/**
 * 校验并规范化 PC。
 * 允许 number 或十进制字符串；拒绝：非整数、超出 [0,2^32-1]、未按 4 字节对齐。
 */
export function validatePc(pcInput: number | string): number {
  const raw = typeof pcInput === 'string' ? pcInput.trim() : pcInput;
  let pc: number;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || !Number.isInteger(raw)) {
      throw new AppError('INVALID_PC', `地址必须是整数，收到 ${String(raw)}`);
    }
    pc = raw;
  } else if (/^\d+$/.test(raw)) {
    pc = Number(raw);
  } else {
    throw new AppError('INVALID_PC', `地址必须是非负十进制整数，收到 "${raw}"`);
  }
  if (pc < 0 || pc > U32_MAX) {
    throw new AppError(
      'PC_OUT_OF_RANGE',
      `地址超出无符号 32 位范围 [0, 4294967295]：${pc}`,
    );
  }
  // 无符号对齐判断，避免 % 对负数的歧义（此处 pc 已非负，保持口径一致）。
  if ((pc >>> 0) % 4 !== 0) {
    throw new AppError('PC_MISALIGNED', `地址必须按 4 字节对齐：${pc}`);
  }
  return pc >>> 0;
}

export function validateTaken(taken: unknown): boolean {
  if (typeof taken !== 'boolean') {
    throw new AppError(
      'INVALID_TAKEN',
      `taken 必须是布尔值，收到 ${typeof taken}`,
    );
  }
  return taken;
}

/** 规范化一整条轨迹输入，返回深拷贝的合法记录数组。 */
export function validateBranches(input: unknown): BranchRecord[] {
  if (!Array.isArray(input)) {
    throw new AppError('INVALID_BRANCHES', 'branches 必须是数组');
  }
  const records: BranchRecord[] = [];
  input.forEach((item, i) => {
    if (typeof item !== 'object' || item === null) {
      throw new AppError('INVALID_BRANCHES', `第 ${i} 条记录不是对象`);
    }
    const rec = item as Record<string, unknown>;
    if (!('pc' in rec)) {
      throw new AppError('INVALID_BRANCHES', `第 ${i} 条记录缺少 pc`);
    }
    if (!('taken' in rec)) {
      throw new AppError('INVALID_BRANCHES', `第 ${i} 条记录缺少 taken`);
    }
    records.push({
      pc: validatePc(rec.pc as number | string),
      taken: validateTaken(rec.taken),
    });
  });
  return records;
}

export function initialState(k: number): GshareState {
  validateK(k);
  return {
    k,
    history: 0,
    counters: new Array<number>(1 << k).fill(1),
  };
}

export function historyMask(k: number): number {
  return (1 << k) - 1;
}

/** 无符号 32 位口径计算表索引：((PC >>> 2) XOR history) & ((1<<k)-1)。 */
export function computeIndex(pc: number, history: number, k: number): number {
  return (((pc >>> 2) ^ history) >>> 0) & historyMask(k);
}

export function predictFromCounter(counter: number): boolean {
  return counter >= 2;
}

/** 二位饱和更新：taken 向 3 加，not-taken 向 0 减，绝不绕回。 */
export function saturate(counter: number, taken: boolean): number {
  if (taken) {
    return counter >= 3 ? 3 : counter + 1;
  }
  return counter <= 0 ? 0 : counter - 1;
}

/** 历史左移一位并在最低位放入实际结果，再遮罩到低 k 位。 */
export function shiftHistory(history: number, taken: boolean, k: number): number {
  return (((history << 1) | (taken ? 1 : 0)) >>> 0) & historyMask(k);
}

/**
 * 执行一步：预测 → 训练同一表项 → 更新历史。
 * 就地修改 state，并返回完整快照。
 */
export function stepOnce(
  state: GshareState,
  record: BranchRecord,
  seq: number,
): StepResult {
  validateK(state.k);
  const pc = validatePc(record.pc);
  const taken = validateTaken(record.taken);
  const { k } = state;

  const oldHistory = state.history >>> 0;
  const index = computeIndex(pc, oldHistory, k);
  const counterBefore = state.counters[index]!;
  const prediction = predictFromCounter(counterBefore);
  const hit = prediction === taken;

  // 训练：只更新由“旧历史”选出的同一个表项。
  const counterAfter = saturate(counterBefore, taken);
  state.counters[index] = counterAfter;

  // 历史更新发生在训练之后。
  const newHistory = shiftHistory(oldHistory, taken, k);
  state.history = newHistory;

  return {
    seq,
    pc,
    pcWord: pc >>> 2,
    taken,
    oldHistory,
    index,
    counterBefore,
    prediction,
    hit,
    counterAfter,
    newHistory,
  };
}

export interface Accuracy {
  processed: number;
  hits: number;
  misses: number;
  /** 0..1；无数据时为 null（明确的无数据状态，不产生 NaN）。 */
  accuracy: number | null;
  hasData: boolean;
}

export function summarize(steps: Pick<StepResult, 'hit'>[]): Accuracy {
  const processed = steps.length;
  const hits = steps.reduce((acc, s) => acc + (s.hit ? 1 : 0), 0);
  const misses = processed - hits;
  return {
    processed,
    hits,
    misses,
    accuracy: processed === 0 ? null : hits / processed,
    hasData: processed > 0,
  };
}

/** “始终预测不跳转”基准：实际 taken 的每一步都误预测。 */
export function baselineAlwaysNotTaken(
  records: BranchRecord[],
  processed: number,
): Accuracy {
  const slice = records.slice(0, processed);
  const takenCount = slice.reduce((acc, r) => acc + (r.taken ? 1 : 0), 0);
  const hits = slice.length - takenCount;
  return {
    processed: slice.length,
    hits,
    misses: takenCount,
    accuracy: slice.length === 0 ? null : hits / slice.length,
    hasData: slice.length > 0,
  };
}

export interface AddressRow {
  pc: number;
  visits: number;
  mispredictions: number;
}

/** 按地址汇总访问次数与误预测次数（处理过的步骤）。 */
export function summarizeByAddress(steps: StepResult[]): AddressRow[] {
  const map = new Map<number, AddressRow>();
  for (const s of steps) {
    let row = map.get(s.pc);
    if (!row) {
      row = { pc: s.pc, visits: 0, mispredictions: 0 };
      map.set(s.pc, row);
    }
    row.visits += 1;
    if (!s.hit) row.mispredictions += 1;
  }
  return [...map.values()].sort((a, b) => a.pc - b.pc);
}

/** 把索引位以 k 位二进制还原，供 CLI/报告展示形成过程。 */
export function toBinary(value: number, width: number): string {
  const masked = value & ((1 << width) - 1);
  return masked.toString(2).padStart(width, '0');
}
