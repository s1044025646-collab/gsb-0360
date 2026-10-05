/**
 * 服务层：串联核心预测与持久层，向 API/CLI 暴露统一操作。
 */
import {
  AddressRow,
  AppError,
  Accuracy,
  baselineAlwaysNotTaken,
  BranchRecord,
  initialState,
  StepResult,
  stepOnce,
  summarize,
  summarizeByAddress,
  validateBranches,
  validateK,
} from './core.js';
import { RunRow, Store, TraceRow } from './store.js';

export interface RunView {
  run: RunRow;
  total: number;
  processed: number;
  finished: boolean;
  remaining: number;
}

export interface AdvanceResult extends RunView {
  steps: StepResult[];
  /** true 表示请求了步数但轨迹已结束、无一步可执行（用于明确报错）。 */
}

export interface Report {
  runId: number;
  k: number;
  total: number;
  processed: number;
  finished: boolean;
  gshare: Accuracy;
  baselineAlwaysNotTaken: Accuracy;
  byAddress: AddressRow[];
}

export class Service {
  constructor(private readonly store: Store) {}

  saveTrace(name: string | null, branchesInput: unknown): TraceRow {
    const branches = validateBranches(branchesInput);
    return this.store.createTrace(name, branches);
  }

  listTraces() {
    return this.store.listTraces();
  }

  getTrace(traceId: number): TraceRow {
    const trace = this.store.getTrace(traceId);
    if (!trace) {
      throw new AppError('TRACE_NOT_FOUND', `轨迹不存在：id=${traceId}`);
    }
    return trace;
  }

  createRun(traceId: number, kInput: unknown): RunView {
    const k = validateK(Number(kInput));
    const run = this.store.createRun(traceId, k);
    return this.view(run);
  }

  getRun(runId: number): RunView {
    return this.view(this.requireRun(runId));
  }

  private requireRun(runId: number): RunRow {
    const run = this.store.getRun(runId);
    if (!run) {
      throw new AppError('RUN_NOT_FOUND', `运行不存在：id=${runId}`);
    }
    return run;
  }

  private view(run: RunRow): RunView {
    const trace = this.getTrace(run.traceId);
    const total = trace.branches.length;
    return {
      run,
      total,
      processed: run.position,
      finished: run.position >= total,
      remaining: total - run.position,
    };
  }

  /** 推进 count 步（count 省略表示推进到结束）。 */
  advance(runId: number, count?: number): AdvanceResult {
    const run = this.requireRun(runId);
    const trace = this.getTrace(run.traceId);
    const branches = trace.branches;

    if (run.position >= branches.length) {
      throw new AppError(
        'RUN_FINISHED',
        `运行已处理完全部 ${branches.length} 条记录，不能继续训练`,
      );
    }

    let stepsToRun: number;
    if (count === undefined) {
      stepsToRun = branches.length - run.position;
    } else {
      if (!Number.isInteger(count) || count <= 0) {
        throw new AppError(
          'INVALID_STEP_COUNT',
          `步数必须是正整数，收到 ${String(count)}`,
        );
      }
      stepsToRun = Math.min(count, branches.length - run.position);
    }

    const state = this.store.loadState(run);
    const produced: StepResult[] = [];
    for (let i = 0; i < stepsToRun; i += 1) {
      const seq = run.position + i;
      const record: BranchRecord = branches[seq]!;
      produced.push(stepOnce(state, record, seq));
    }
    this.store.appendSteps(runId, state, produced);

    const refreshed = this.requireRun(runId);
    return { ...this.view(refreshed), steps: produced };
  }

  getStep(runId: number, seqInput: unknown): StepResult {
    const seq = Number(seqInput);
    if (!Number.isInteger(seq) || seq < 0) {
      throw new AppError('INVALID_SEQ', `步骤编号必须是非负整数：${String(seqInput)}`);
    }
    const step = this.store.getStep(runId, seq);
    if (!step) {
      throw new AppError('STEP_NOT_FOUND', `步骤不存在：seq=${seq}`);
    }
    return step;
  }

  listSteps(runId: number, limit?: number): StepResult[] {
    this.requireRun(runId);
    if (limit !== undefined) {
      if (!Number.isInteger(limit) || limit < 0) {
        throw new AppError('INVALID_LIMIT', `limit 必须是非负整数：${String(limit)}`);
      }
    }
    return this.store.listSteps(runId, limit);
  }

  getTable(runId: number) {
    const run = this.requireRun(runId);
    return {
      k: run.k,
      size: 1 << run.k,
      history: run.history,
      position: run.position,
      counters: run.counters.map((counter, index) => ({
        index,
        counter,
        prediction: counter >= 2,
      })),
    };
  }

  getStats(runId: number) {
    const runView = this.getRun(runId);
    const steps = this.store.listSteps(runId);
    return { ...runView, ...summarize(steps) };
  }

  getReport(runId: number): Report {
    const runView = this.getRun(runId);
    const trace = this.getTrace(runView.run.traceId);
    const steps = this.store.listSteps(runId);
    return {
      runId,
      k: runView.run.k,
      total: runView.total,
      processed: runView.processed,
      finished: runView.finished,
      gshare: summarize(steps),
      baselineAlwaysNotTaken: baselineAlwaysNotTaken(
        trace.branches,
        runView.processed,
      ),
      byAddress: summarizeByAddress(steps),
    };
  }
}

export { initialState };
