/**
 * 仅后端 HTTP API（无前端）。
 * 默认选择空闲端口：端口 0 或未设置 PORT 时由操作系统分配并打印实际端口。
 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { AppError } from './core.js';
import { getStore, defaultDbPath } from './store.js';
import { Service } from './service.js';

const service = new Service(getStore());

interface ErrorBody {
  error: { code: string; message: string };
}

const STATUS_BY_CODE: Record<string, number> = {
  INVALID_K: 400,
  INVALID_PC: 400,
  PC_MISALIGNED: 400,
  PC_OUT_OF_RANGE: 400,
  INVALID_TAKEN: 400,
  INVALID_BRANCHES: 400,
  INVALID_STEP_COUNT: 400,
  INVALID_SEQ: 400,
  INVALID_LIMIT: 400,
  INVALID_JSON: 400,
  INVALID_QUERY: 400,
  INVALID_RUN_ID: 400,
  TRACE_NOT_FOUND: 404,
  RUN_NOT_FOUND: 404,
  STEP_NOT_FOUND: 404,
  RUN_EXISTS: 409,
  RUN_FINISHED: 409,
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof AppError) {
    const status = STATUS_BY_CODE[err.code] ?? 500;
    const body: ErrorBody = { error: { code: err.code, message: err.message } };
    sendJson(res, status, body);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  sendJson(res, 500, { error: { code: 'INTERNAL', message } });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError('INVALID_JSON', '请求体不是合法 JSON');
  }
}

function intParam(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new AppError('INVALID_QUERY', `${name} 必须是整数`);
  }
  return n;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/health') {
      sendJson(res, 200, { ok: true, db: defaultDbPath() });
      return;
    }

    // ---------- traces ----------
    if (method === 'POST' && path === '/api/traces') {
      const body = (await readJson(req)) as {
        name?: unknown;
        branches?: unknown;
      };
      const name =
        typeof body.name === 'string' ? body.name : body.name === undefined ? null : null;
      sendJson(res, 201, service.saveTrace(name, body.branches));
      return;
    }
    if (method === 'GET' && path === '/api/traces') {
      sendJson(res, 200, { traces: service.listTraces() });
      return;
    }
    let m = /^\/api\/traces\/(\d+)$/.exec(path);
    if (method === 'GET' && m) {
      sendJson(res, 200, service.getTrace(Number(m[1])));
      return;
    }

    // ---------- runs ----------
    m = /^\/api\/traces\/(\d+)\/runs$/.exec(path);
    if (method === 'POST' && m) {
      const body = (await readJson(req)) as { k?: unknown };
      sendJson(res, 201, service.createRun(Number(m[1]), body.k));
      return;
    }
    m = /^\/api\/runs\/(\d+)$/.exec(path);
    if (method === 'GET' && m) {
      sendJson(res, 200, service.getRun(Number(m[1])));
      return;
    }
    m = /^\/api\/runs\/(\d+)\/steps$/.exec(path);
    if (method === 'GET' && m) {
      const limit = intParam(url.searchParams.get('limit') ?? undefined, 'limit');
      sendJson(res, 200, { steps: service.listSteps(Number(m[1]), limit) });
      return;
    }
    if (method === 'POST' && path === '/api/runs/advance') {
      const body = (await readJson(req)) as {
        runId?: unknown;
        count?: unknown;
      };
      if (typeof body.runId !== 'number') {
        throw new AppError('INVALID_RUN_ID', 'runId 必须是数字');
      }
      const count =
        body.count === undefined ? undefined : Number(body.count);
      sendJson(res, 200, service.advance(body.runId, count));
      return;
    }
    m = /^\/api\/runs\/(\d+)\/steps\/(\d+)$/.exec(path);
    if (method === 'GET' && m) {
      sendJson(res, 200, service.getStep(Number(m[1]), Number(m[2])));
      return;
    }
    m = /^\/api\/runs\/(\d+)\/table$/.exec(path);
    if (method === 'GET' && m) {
      sendJson(res, 200, service.getTable(Number(m[1])));
      return;
    }
    m = /^\/api\/runs\/(\d+)\/stats$/.exec(path);
    if (method === 'GET' && m) {
      sendJson(res, 200, service.getStats(Number(m[1])));
      return;
    }
    m = /^\/api\/runs\/(\d+)\/report$/.exec(path);
    if (method === 'GET' && m) {
      sendJson(res, 200, service.getReport(Number(m[1])));
      return;
    }

    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `无此路由：${method} ${path}` } });
  } catch (err) {
    sendError(res, err);
  }
});

const requestedPort = Number(process.env.PORT ?? '0');
const port = Number.isInteger(requestedPort) && requestedPort >= 0 ? requestedPort : 0;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  server.listen(port, '127.0.0.1', () => {
    const addr = server.address() as AddressInfo;
    console.log(`gshare API 已启动: http://127.0.0.1:${addr.port}`);
    console.log(`数据文件: ${defaultDbPath()}`);
  });
}

export { server };
