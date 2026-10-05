import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { after, before } from 'node:test';
import { createServer } from 'node:http';

// 使用独立数据库并手动装配路由处理器，避免与默认全局 store 相互污染。
import { Store } from '../store.js';
import { Service } from '../service.js';

let base: string;
let server: ReturnType<typeof createServer>;
let store: Store;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gshare-api-'));
  store = new Store(join(dir, 'api.sqlite'));
  const service = new Service(store);
  // 复用 server.ts 的路由较复杂，这里通过动态 import 并设置 GSHARE_DB 后获取实例。
  process.env.GSHARE_DB = join(dir, 'api2.sqlite');
  const mod = await import('../server.js');
  server = mod.server;
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
  void service;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
});

test('健康检查', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean };
  assert.equal(body.ok, true);
});

test('端到端：保存轨迹→创建运行→推进→步骤/表/统计/报告', async () => {
  const createTrace = await fetch(`${base}/api/traces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'api',
      branches: [
        { pc: 4096, taken: true },
        { pc: 4096, taken: false },
      ],
    }),
  });
  assert.equal(createTrace.status, 201);
  const trace = (await createTrace.json()) as { id: number };

  const createRun = await fetch(`${base}/api/traces/${trace.id}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ k: 2 }),
  });
  assert.equal(createRun.status, 201);
  const run = (await createRun.json()) as { run: { id: number }; finished: boolean };
  assert.equal(run.finished, false);

  const adv = await fetch(`${base}/api/runs/advance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId: run.run.id, count: 1 }),
  });
  assert.equal(adv.status, 200);
  const advBody = (await adv.json()) as { processed: number; finished: boolean };
  assert.equal(advBody.processed, 1);
  assert.equal(advBody.finished, false);

  const table = await fetch(`${base}/api/runs/${run.run.id}/table`).then((r) => r.json());
  assert.equal(table.size, 4);

  const stats = await fetch(`${base}/api/runs/${run.run.id}/stats`).then((r) => r.json());
  assert.equal(stats.processed, 1);
  assert.equal(typeof stats.accuracy, 'number');

  const report = await fetch(`${base}/api/runs/${run.run.id}/report`).then((r) => r.json());
  assert.ok('baselineAlwaysNotTaken' in report);

  // 跑完剩余。
  await fetch(`${base}/api/runs/advance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId: run.run.id }),
  });
  const again = await fetch(`${base}/api/runs/advance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId: run.run.id, count: 1 }),
  });
  assert.equal(again.status, 409);
  const errBody = (await again.json()) as { error: { code: string } };
  assert.equal(errBody.error.code, 'RUN_FINISHED');
});

test('非法输入返回 400 与稳定错误码', async () => {
  const res = await fetch(`${base}/api/traces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ branches: [{ pc: 1, taken: true }] }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, 'PC_MISALIGNED');
});

test('空轨迹统计正确率为无数据（null）而非 NaN', async () => {
  const traceRes = await fetch(`${base}/api/traces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ branches: [] }),
  });
  const trace = (await traceRes.json()) as { id: number };
  const runRes = await fetch(`${base}/api/traces/${trace.id}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ k: 1 }),
  });
  const run = (await runRes.json()) as { run: { id: number } };
  const stats = (await fetch(`${base}/api/runs/${run.run.id}/stats`).then((r) =>
    r.json(),
  )) as { accuracy: number | null; hasData: boolean };
  assert.equal(stats.accuracy, null);
  assert.equal(stats.hasData, false);
});
