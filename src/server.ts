import * as http from "node:http";
import { AddressInfo } from "node:net";
import { openDb } from "./db";
import { Service } from "./service";
import { ValidationError } from "./predictor";

export function createServer(service: Service): http.Server {
  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    const json = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(json);
  };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";
      const body = await readBody(req);
      const json = body ? JSON.parse(body) : {};

      if (method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });

      if (method === "POST" && url.pathname === "/traces") {
        const id = service.createTrace(json.name, json.records);
        return send(res, 201, { traceId: id });
      }
      if (method === "GET" && url.pathname === "/traces") return send(res, 200, service.listTraces());
      if (method === "GET" && parts[0] === "traces" && parts.length === 2) {
        return send(res, 200, service.getTraceRecords(num(parts[1])));
      }
      if (method === "POST" && url.pathname === "/runs") {
        const id = service.createRun(num(json.traceId), json.k);
        return send(res, 201, { runId: id });
      }
      if (method === "POST" && parts[0] === "runs" && parts[2] === "step") {
        return send(res, 200, service.advance(num(parts[1]), 1));
      }
      if (method === "POST" && parts[0] === "runs" && parts[2] === "advance") {
        return send(res, 200, service.advance(num(parts[1]), num(json.n)));
      }
      if (method === "GET" && parts[0] === "runs" && parts.length === 2) {
        const run = service.getRun(num(parts[1]));
        return send(res, 200, { ...run, stats: service.getStats(run.id) });
      }
      if (method === "GET" && parts[0] === "runs" && parts[2] === "steps" && parts.length === 4) {
        return send(res, 200, service.getStep(num(parts[1]), num(parts[3])));
      }
      if (method === "GET" && parts[0] === "runs" && parts[2] === "steps") {
        const limit = url.searchParams.get("limit");
        return send(res, 200, service.getSteps(num(parts[1]), limit ? num(limit) : undefined));
      }
      if (method === "GET" && parts[0] === "runs" && parts[2] === "table") {
        return send(res, 200, service.getTable(num(parts[1])));
      }
      if (method === "GET" && parts[0] === "runs" && parts[2] === "stats") {
        return send(res, 200, service.getStats(num(parts[1])));
      }
      if (method === "GET" && parts[0] === "runs" && parts[2] === "report") {
        return send(res, 200, service.getReport(num(parts[1])));
      }
      if (method === "GET" && parts[0] === "runs" && parts[2] === "aliases") {
        return send(res, 200, service.getAliases(num(parts[1])));
      }
      return send(res, 404, { error: { code: "NOT_FOUND", message: "未知路由" } });
    } catch (e) {
      if (e instanceof ValidationError) {
        return send(res, 400, { error: { code: e.code, message: e.message } });
      }
      if (e instanceof SyntaxError) {
        return send(res, 400, { error: { code: "INVALID_JSON", message: "请求体不是合法 JSON" } });
      }
      return send(res, 500, { error: { code: "INTERNAL", message: String(e) } });
    }
  });
}

function num(s: unknown): number {
  const n = Number(s);
  if (!Number.isInteger(n)) throw new ValidationError("INVALID_INPUT", `参数必须是整数: ${String(s)}`);
  return n;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

if (require.main === module) {
  const portArg = process.argv.find((a) => a.startsWith("--port="));
  const port = portArg ? Number(portArg.split("=")[1]) : 0; // 默认选择空闲端口
  const server = createServer(new Service(openDb()));
  server.listen(port, () => {
    const addr = server.address() as AddressInfo;
    console.log(`gshare 模拟服务已启动: http://127.0.0.1:${addr.port}`);
  });
}
