#!/usr/bin/env node
/**
 * 命令行：保存轨迹、创建运行、单步/有限步推进、查看步骤、
 * 查询预测表、统计正确率、导出报告、重建演示数据。
 *
 * 展示类选项（--limit、--explain）只影响显示，不改变任何实际训练。
 */
import { AppError, StepResult, toBinary } from './core.js';
import { readFileSync } from 'node:fs';
import { getStore } from './store.js';
import { Service } from './service.js';
import { demoTraces } from './demo-data.js';

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}

function flagString(flags: Map<string, string | boolean>, key: string): string | undefined {
  const v = flags.get(key);
  return typeof v === 'string' ? v : undefined;
}

function flagNumber(flags: Map<string, string | boolean>, key: string): number | undefined {
  const v = flags.get(key);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new AppError('INVALID_QUERY', `--${key} 必须是数字`);
  return n;
}

const boolZh = (b: boolean): string => (b ? '是' : '否');
const takenZh = (b: boolean): string => (b ? '跳转T' : '不跳N');

function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

function explainStep(s: StepResult, k: number): string {
  const lines: string[] = [];
  lines.push(`步骤 #${s.seq}  PC=0x${s.pc.toString(16).padStart(8, '0')}  实际=${takenZh(s.taken)}`);
  lines.push(
    `  旧历史=${toBinary(s.oldHistory, k)}  PC>>2=${toBinary(s.pcWord, k)}(低${k}位)`,
  );
  lines.push(
    `  XOR   =${toBinary((s.pcWord ^ s.oldHistory) & ((1 << k) - 1), k)}  -> 索引=${s.index} (二进制 ${toBinary(s.index, k)})`,
  );
  lines.push(
    `  计数器[${s.index}]: ${s.counterBefore} -> ${s.counterAfter}  ` +
      `预测=${takenZh(s.prediction)} 命中=${boolZh(s.hit)}`,
  );
  lines.push(`  新历史=${toBinary(s.newHistory, k)}`);
  return lines.join('\n');
}

const HELP = `
gshare 分支预测回放 CLI（仅后端，数据保存在项目 data/ 目录）

用法:
  node dist/cli.js demo [--json]
      重建演示轨迹与运行（一直跳转 / 交替 / 有意混叠），并全部训练，打印对照。

  node dist/cli.js trace-save --name <名称> --branches '<JSON数组>'
      例: --branches "[{\\"pc\\":4096,\\"taken\\":true}]"
      也可用 --file <path.json> 读取 { "name"?, "branches":[...] }。

  node dist/cli.js trace-list [--json]
  node dist/cli.js trace <traceId> [--json]

  node dist/cli.js run-create <traceId> --k <1..10> [--json]
  node dist/cli.js run <runId> [--json]
  node dist/cli.js step <runId>                 单步训练一条
  node dist/cli.js advance <runId> [--count N]  有限步推进（不给 count 则到结束）
  node dist/cli.js steps <runId> [--limit N] [--explain]
  node dist/cli.js step-view <runId> <seq> [--explain]
  node dist/cli.js table <runId>
  node dist/cli.js stats <runId> [--json]
  node dist/cli.js report <runId> [--json]

选项:
  --limit N    仅限制展示条数，不影响训练状态
  --explain    以二进制展示索引形成过程与计数器变化
  --json       以 JSON 输出，便于脚本处理
  --db <path>  指定 SQLite 文件（默认 data/gshare.sqlite）
`.trimStart();

function loadService(flags: Map<string, string | boolean>): Service {
  return new Service(getStore(flagString(flags, 'db') ?? undefined));
}

function printRunStatus(view: {
  total: number;
  processed: number;
  finished: boolean;
  remaining: number;
}): string {
  const status = view.finished
    ? `已结束（${view.processed}/${view.total}）`
    : `尚未结束（已处理 ${view.processed}/${view.total}，剩余 ${view.remaining}）`;
  return status;
}

function buildDemo(service: Service, asJson: boolean): void {
  const results = demoTraces().map((demo) => {
    const trace = service.saveTrace(demo.name, demo.branches);
    const run = service.createRun(trace.id, demo.k);
    const advanced = service.advance(run.run.id);
    const report = service.getReport(run.run.id);
    return { demo, trace, run, advanced, report };
  });

  if (asJson) {
    printJson(results);
    return;
  }
  for (const { demo, trace, run, advanced, report } of results) {
    process.stdout.write(`\n=== ${demo.name}（k=${demo.k}，traceId=${trace.id}，runId=${run.run.id}）===\n`);
    process.stdout.write(demo.description + '\n');
    for (const s of advanced.steps) {
      process.stdout.write(explainStep(s, demo.k) + '\n');
    }
    process.stdout.write(`状态: ${printRunStatus(run)}\n`);
    const g = report.gshare;
    const b = report.baselineAlwaysNotTaken;
    process.stdout.write(
      `gshare 正确率=${g.hasData ? (g.accuracy! * 100).toFixed(1) + '%' : '无数据'} ` +
        `(${g.hits}/${g.processed})；始终不跳基准=${
          b.hasData ? (b.accuracy! * 100).toFixed(1) + '%' : '无数据'
        }\n`,
    );
    process.stdout.write('按地址汇总:\n');
    for (const row of report.byAddress) {
      process.stdout.write(
        `  PC=0x${row.pc.toString(16).padStart(8, '0')} 访问=${row.visits} 误预测=${row.mispredictions}\n`,
      );
    }
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const service = loadService(args.flags);
  const asJson = args.flags.has('json');

  switch (args.command) {
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return;

    case 'demo':
      buildDemo(service, asJson);
      return;

    case 'trace-save': {
      let body: unknown;
      const file = flagString(args.flags, 'file');
      if (file) {
        body = JSON.parse(readFileSync(file, 'utf-8'));
      } else {
        body = {
          name: flagString(args.flags, 'name') ?? null,
          branches: JSON.parse(flagString(args.flags, 'branches') ?? '[]'),
        };
      }
      const obj = body as { name?: string | null; branches?: unknown };
      const trace = service.saveTrace(obj.name ?? null, obj.branches);
      printJson(trace);
      return;
    }

    case 'trace-list':
      if (asJson) printJson({ traces: service.listTraces() });
      else {
        for (const t of service.listTraces()) {
          process.stdout.write(`#${t.id} ${t.name ?? '(未命名)'} 记录数=${t.length}\n`);
        }
      }
      return;

    case 'trace':
      printJson(service.getTrace(Number(args.positional[0])));
      return;

    case 'run-create': {
      const traceId = Number(args.positional[0]);
      const k = flagNumber(args.flags, 'k');
      if (k === undefined) throw new AppError('INVALID_K', '必须提供 --k');
      printJson(service.createRun(traceId, k));
      return;
    }

    case 'run': {
      const view = service.getRun(Number(args.positional[0]));
      if (asJson) printJson(view);
      else process.stdout.write(printRunStatus(view) + '\n');
      return;
    }

    case 'step': {
      const view = service.advance(Number(args.positional[0]), 1);
      const s = view.steps[0]!;
      process.stdout.write(explainStep(s, view.run.k) + '\n');
      process.stdout.write(printRunStatus(view) + '\n');
      if (asJson) printJson(view);
      return;
    }

    case 'advance': {
      const runId = Number(args.positional[0]);
      const count = flagNumber(args.flags, 'count');
      const view = service.advance(runId, count);
      if (asJson) printJson(view);
      else {
        for (const s of view.steps) process.stdout.write(explainStep(s, view.run.k) + '\n');
        process.stdout.write(printRunStatus(view) + '\n');
      }
      return;
    }

    case 'steps': {
      const runId = Number(args.positional[0]);
      const limit = flagNumber(args.flags, 'limit');
      const steps = service.listSteps(runId, limit);
      const k = service.getRun(runId).run.k;
      if (args.flags.has('explain')) {
        for (const s of steps) process.stdout.write(explainStep(s, k) + '\n');
      } else {
        printJson({ steps });
      }
      return;
    }

    case 'step-view': {
      const s = service.getStep(Number(args.positional[0]), Number(args.positional[1]));
      if (args.flags.has('explain')) {
        const k = service.getRun(Number(args.positional[0])).run.k;
        process.stdout.write(explainStep(s, k) + '\n');
      } else {
        printJson(s);
      }
      return;
    }

    case 'table':
      printJson(service.getTable(Number(args.positional[0])));
      return;

    case 'stats':
      printJson(service.getStats(Number(args.positional[0])));
      return;

    case 'report':
      printJson(service.getReport(Number(args.positional[0])));
      return;

    default:
      throw new AppError('UNKNOWN_COMMAND', `未知命令：${args.command}（见 help）`);
  }
}

try {
  main();
} catch (err) {
  if (err instanceof AppError) {
    process.stderr.write(`错误[${err.code}] ${err.message}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(`错误 ${String(err)}\n`);
    process.exitCode = 1;
  }
}
