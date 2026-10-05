import * as fs from "node:fs";
import { openDb } from "./db";
import { Service } from "./service";
import { historyMask, computeIndex } from "./predictor";
import { seedDemo } from "./demo";

const svc = new Service(openDb());

function bin(n: number, width: number): string {
  return n.toString(2).padStart(width, "0");
}

function explainStep(runId: number, branchNo: number): string {
  const run = svc.getRun(runId);
  const s: any = svc.getStep(runId, branchNo);
  const k = run.k;
  const pcShifted = s.address >>> 2;
  const lines = [
    `分支 #${s.branch_no}  地址 0x${s.address.toString(16).toUpperCase().padStart(8, "0")}`,
    `  PC>>2        = ${bin(pcShifted & historyMask(k), k)} (低 ${k} 位)`,
    `  旧历史       = ${bin(s.old_history, k)}`,
    `  XOR -> 索引  = ${bin(s.idx, k)} (十进制 ${s.idx})`,
    `  计数器 ${s.counter_before} -> 预测${s.prediction ? "跳转" : "不跳"}，实际${s.actual ? "跳转" : "不跳"}，${s.hit ? "命中" : "误预测"}`,
    `  计数器训练为 ${s.counter_after}，新历史 = ${bin(s.new_history, k)}`,
  ];
  return lines.join("\n");
}

function printSteps(runId: number, limit?: number) {
  const steps = svc.getSteps(runId, limit) as any[];
  for (const s of steps) console.log(explainStep(runId, s.branch_no));
  if (limit != null) console.log(`(仅展示前 ${steps.length} 条；展示上限不影响已完成的训练)`);
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const opt = (name: string): string | undefined => {
    const a = args.find((x) => x.startsWith(`--${name}=`));
    return a ? a.split("=")[1] : undefined;
  };
  switch (cmd) {
    case "demo": {
      const ids = seedDemo(svc);
      console.log(`演示数据已写入：${JSON.stringify(ids)}`);
      break;
    }
    case "add-trace": {
      const file = args[0];
      const name = opt("name") ?? file;
      const data = JSON.parse(fs.readFileSync(file, "utf-8"));
      const id = svc.createTrace(name, data.records ?? data);
      console.log(`traceId=${id}`);
      break;
    }
    case "traces":
      console.table(svc.listTraces());
      break;
    case "create-run": {
      const id = svc.createRun(Number(opt("trace")), Number(opt("k")));
      console.log(`runId=${id}`);
      break;
    }
    case "step": {
      const runId = Number(args[0]);
      const n = args[1] ? Number(args[1]) : 1;
      const r = svc.advance(runId, n);
      console.log(`推进 ${r.processed} 步，${r.finished ? "轨迹已结束" : "尚未结束（达到步数预算）"}`);
      break;
    }
    case "show-step":
      console.log(explainStep(Number(args[0]), Number(args[1])));
      break;
    case "steps":
      printSteps(Number(args[0]), opt("limit") ? Number(opt("limit")) : undefined);
      break;
    case "table": {
      const t = svc.getTable(Number(args[0]));
      const limit = opt("limit") ? Number(opt("limit")) : t.size;
      for (let i = 0; i < Math.min(limit, t.size); i++) {
        console.log(`  [${bin(i, t.k)}] = ${t.counters[i]}`);
      }
      if (limit < t.size) console.log(`  ... 共 ${t.size} 项，仅展示 ${limit} 项`);
      break;
    }
    case "stats": {
      const s = svc.getStats(Number(args[0]));
      console.log(JSON.stringify({ ...s, accuracy: s.noData ? "无数据" : s.accuracy }, null, 2));
      break;
    }
    case "report": {
      const r = svc.getReport(Number(args[0]));
      console.log(`运行 ${r.runId} (k=${r.k})  处理 ${r.stats.processed}/${r.stats.traceLength}  ` +
        `正确率 ${r.stats.noData ? "无数据" : (r.stats.accuracy! * 100).toFixed(1) + "%"}`);
      console.log("按地址汇总:");
      for (const a of r.byAddress) {
        console.log(`  0x${a.address.toString(16).toUpperCase().padStart(8, "0")}  访问 ${a.visits}  误预测 ${a.misses}`);
      }
      console.log(`基准(始终不跳): 误预测 ${r.baseline.misses}，正确率 ` +
        (r.baseline.accuracy === null ? "无数据" : (r.baseline.accuracy * 100).toFixed(1) + "%"));
      const aliases = svc.getAliases(r.runId) as any[];
      if (aliases.length > 0) {
        console.log("混叠表项（不同地址共享同一索引）:");
        for (const a of aliases) console.log(`  索引 ${a.idx}: ${a.addresses}`);
      }
      break;
    }
    default:
      console.log(`用法: node dist/cli.js <命令>
  demo                          写入演示轨迹
  add-trace <file> [--name=N]   从 JSON 文件导入轨迹
  traces                        列出轨迹
  create-run --trace=ID --k=K   创建运行
  step <runId> [n]              推进 n 步（默认 1）
  show-step <runId> <branchNo>  查看指定步骤（含索引二进制形成）
  steps <runId> [--limit=N]     列出步骤
  table <runId> [--limit=N]     查看预测表
  stats <runId>                 正确率统计
  report <runId>                按地址汇总并与基准比较`);
  }
}

main();
