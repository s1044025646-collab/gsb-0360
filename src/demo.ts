/**
 * npm run demo：在独立数据库 data/demo.sqlite 上重建并运行全部演示轨迹。
 */
import { getStore, resetStoreForTest } from './store.js';
import { Service } from './service.js';
import { demoTraces } from './demo-data.js';
import { toBinary } from './core.js';

const dbPath = process.env.GSHARE_DEMO_DB ?? 'data/demo.sqlite';

function main(): void {
  // 演示脚本每次重建：关闭默认连接并以演示库重新打开。
  getStore().close();
  const store = resetStoreForTest(dbPath);
  const service = new Service(store);

  for (const demo of demoTraces()) {
    const trace = service.saveTrace(demo.name, demo.branches);
    const run = service.createRun(trace.id, demo.k);
    const advanced = service.advance(run.run.id);
    const report = service.getReport(run.run.id);

    process.stdout.write(
      `\n=== ${demo.name}（k=${demo.k}，traceId=${trace.id}，runId=${run.run.id}）===\n`,
    );
    process.stdout.write(demo.description + '\n');
    for (const s of advanced.steps) {
      process.stdout.write(
        `#${String(s.seq).padStart(2)} PC=0x${s.pc
          .toString(16)
          .padStart(8, '0')} 旧h=${toBinary(s.oldHistory, demo.k)} ` +
          `索引=${toBinary(s.index, demo.k)} 计数器[${s.index}]:${s.counterBefore}->${s.counterAfter} ` +
          `预测=${s.prediction ? 'T' : 'N'} 实际=${s.taken ? 'T' : 'N'} ` +
          `${s.hit ? '命中' : '失败'} 新h=${toBinary(s.newHistory, demo.k)}\n`,
      );
    }
    const g = report.gshare;
    const b = report.baselineAlwaysNotTaken;
    process.stdout.write(
      `正确率 gshare=${g.hasData ? (g.accuracy! * 100).toFixed(1) + '%' : '无数据'} ` +
        `基准(始终不跳)=${b.hasData ? (b.accuracy! * 100).toFixed(1) + '%' : '无数据'}\n`,
    );
    for (const row of report.byAddress) {
      process.stdout.write(
        `  地址 0x${row.pc.toString(16).padStart(8, '0')} 访问=${row.visits} 误预测=${row.mispredictions}\n`,
      );
    }
  }
  store.close();
}

main();
