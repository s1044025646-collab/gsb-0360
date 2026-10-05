# gshare 分支预测计数器与历史混叠回放后端

教学用 **gshare 条件分支预测器**模拟服务：输入一条有序的分支记录（四字节对齐的程序地址 + 实际是否跳转），按严格规定的顺序重现预测器在“看见实际结果之前”的预测，以及事后的训练（更新）过程。只做 **API 与 CLI**，无前端、无 Docker/WSL、无付费或在线依赖。

> 只分析你给出的分支序列。**不执行机器码、不读取真实 CPU 计数器、不模拟指令流水线、目标地址预测或推测执行回滚。**

## 技术栈与环境

- TypeScript + Node.js（建议 Node ≥ 22.5，开发机实测 Node v25）
- SQLite：使用 Node **内置** `node:sqlite`（`DatabaseSync`），无需本地编译或安装数据库
- 项目内数据目录 `data/`（自动创建），可用环境变量覆盖
- Windows 本地直接运行；不依赖 Docker、WSL 或外部在线 API

启动时会有一条 `ExperimentalWarning: SQLite is an experimental feature`，这是 Node 内置模块的提示，不影响功能。

## 安装与构建

```powershell
npm install
npm run build
```

构建产物输出到 `dist/`。

## 预测模型（严格定义）

- 参数 `k`：全局历史位数，也是预测表索引位数；表有 `2^k` 项，`k ∈ [1,10]`。
- 初始全局历史 `history = 0`；所有二位饱和计数器初始为 `1`（弱“不跳”）。
- 表索引：

  ```
  index = ((PC >>> 2) XOR history) 的低 k 位
  ```

  所有位运算均为 **无符号 32 位** 口径（`>>>`、`>>> 0`），因此最高地址位不会像有符号 `|`/`^` 那样产生负数。
- 计数器语义：`0、1` 预测**不跳**，`2、3` 预测**跳转**。

每条分支严格按以下顺序执行（**预测先于训练**）：

1. 用**旧历史**与**旧计数器**计算索引并给出预测；
2. 看到实际结果后，把**同一个表项**的计数器向 `3`（实际跳转）或 `0`（实际不跳）**饱和**更新，不绕回；
3. 最后才把实际结果移入历史：`history = ((history << 1) | taken) & ((1<<k)-1)`，只保留低 `k` 位。

因此：

- **不会**用更新后的历史再去训练另一个表项；
- 即使预测**正确**，计数器仍可能发生训练（例如计数 `1→0` 或 `2→3`）；
- 不同地址可能因 XOR 后低位相同而映射到**同一表项（混叠/别名）**；反之，同一地址在不同历史下也可能访问**不同索引**。

每一步都保存：分支编号、地址、`PC>>2`、旧历史、索引、计数器前/后值、预测、实际结果、命中与否、新历史。

## 空数据与结束状态

- 零条记录时正确率用 `accuracy: null` 与 `hasData: false` 表达 **无数据**，不会产生 `NaN`。
- 达到步数预算但未读完整个轨迹时 `finished: false`（“尚未结束”），并给出 `remaining`。
- 已处理完全部记录后再训练会被拒绝，错误码 `RUN_FINISHED`（HTTP 409）。

## 运行测试

```powershell
npm test
```

测试覆盖：四种计数器值 × 两种结果的全部饱和转换、历史遮罩、不同 PC 混叠、`k=1/10` 边界及越界、空输入、最高合法地址 `0xFFFFFFFC`、短记录手工展开的索引/状态表断言、逐步与批量等价、关闭重开数据库后的保存恢复等价、命中+失败=处理数、按地址汇总一致、结束后追加被拒绝、HTTP API 端到端。

## 启动 HTTP API

```powershell
# 默认让操作系统选择空闲端口（PORT 未设置或为 0）
npm start

# 也可显式指定端口
$env:PORT=8080; npm start
```

启动后打印实际监听地址，例如 `http://127.0.0.1:62671`。

### 环境变量

- `PORT`：监听端口，默认 `0`（由系统分配空闲端口）。
- `GSHARE_DB`：SQLite 文件路径，默认 `data/gshare.sqlite`。

### 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/api/traces` | 保存轨迹 `{ "name"?: string, "branches": [{pc,taken}, ...] }` |
| GET | `/api/traces` | 列出轨迹 |
| GET | `/api/traces/:traceId` | 查看一条轨迹 |
| POST | `/api/traces/:traceId/runs` | 以固定 `k` 创建运行 `{ "k": 2 }` |
| GET | `/api/runs/:runId` | 运行状态（processed/total/finished/remaining） |
| POST | `/api/runs/advance` | 推进 `{ "runId": 1, "count"?: 1 }`；省略 `count` 跑到结束 |
| GET | `/api/runs/:runId/steps?limit=N` | 步骤列表（limit 仅限制展示） |
| GET | `/api/runs/:runId/steps/:seq` | 查看指定步骤 |
| GET | `/api/runs/:runId/table` | 查询预测表（每项索引/计数器/预测）与当前历史 |
| GET | `/api/runs/:runId/stats` | 正确率统计 |
| GET | `/api/runs/:runId/report` | 导出报告（按地址汇总 + 始终不跳基准对照） |

### 请求示例（PowerShell）

```powershell
$body = @{ name='demo'; branches=@(
  @{ pc=4096; taken=$true },
  @{ pc=4112; taken=$false }
) } | ConvertTo-Json
$trace = Invoke-RestMethod http://127.0.0.1:<port>/api/traces -Method Post -ContentType 'application/json' -Body $body
$run   = Invoke-RestMethod "http://127.0.0.1:<port>/api/traces/$($trace.id)/runs" -Method Post -ContentType 'application/json' -Body (@{k=2}|ConvertTo-Json)
Invoke-RestMethod "http://127.0.0.1:<port>/api/runs/advance" -Method Post -ContentType 'application/json' -Body (@{runId=$run.run.id}|ConvertTo-Json)
Invoke-RestMethod "http://127.0.0.1:<port>/api/runs/$($run.run.id)/report"
```

## CLI

```powershell
node dist/cli.js help

# 重建演示数据并全部训练（一直跳转 / 交替结果 / 两个地址有意混叠）
npm run demo

# 保存轨迹（PowerShell 下推荐用 --file，避免引号转义）
node dist/cli.js trace-save --file trace.json
node dist/cli.js trace-list
node dist/cli.js trace <traceId>

# 创建固定 k 的运行、训练、查询
node dist/cli.js run-create <traceId> --k 2
node dist/cli.js step <runId>                 # 单步训练一条
node dist/cli.js advance <runId> --count 5    # 有限步推进；不给 --count 则到结束
node dist/cli.js run <runId>                  # 状态：已结束/尚未结束
node dist/cli.js steps <runId> --limit 3 --explain
node dist/cli.js step-view <runId> 2 --explain
node dist/cli.js table <runId>
node dist/cli.js stats <runId>
node dist/cli.js report <runId>
```

`trace.json` 形如：

```json
{
  "name": "example",
  "branches": [
    { "pc": 4096, "taken": true },
    { "pc": 4294967292, "taken": false }
  ]
}
```

`--explain` 以二进制展示索引形成过程（`旧历史 XOR (PC>>2) 低 k 位 -> 索引`）与计数器变化；`--limit` 只限制展示条数。**这些展示选项不改变任何实际训练状态。**

`--db <path>` 可指定 SQLite 文件（默认 `data/gshare.sqlite`）；演示脚本使用 `data/demo.sqlite`（`GSHARE_DEMO_DB` 可覆盖）。

## 持久化与对照实验

- 运行的已处理位置、全局历史、全部表项与每一步都保存在 SQLite；推进时这些写入在**同一事务**中原子提交。
- 关闭进程后用同一数据库文件重开再继续，结果与一次性不中断运行**逐位一致**（有专门测试断言）。
- 一条轨迹对应一个固定 `k` 的运行，不能在中途改参数；同一轨迹重复创建运行返回 `RUN_EXISTS`。需要用不同 `k` 做独立对照时，**另存一条相同记录的轨迹**再创建运行。

## 报告与基准

报告按地址汇总访问次数与误预测次数，并附 **“始终预测不跳转”** 简单基准的正确率。基准仅作参照：gshare 依赖历史相关模式，**并不保证在任何输入上都优于基准**（例如刻意构造的混叠序列可能更差，演示中即可看到）。

## 输入校验与错误码

- 地址必须是 `[0, 2^32-1]` 内的非负整数且按 4 字节对齐，否则拒绝：
  - `INVALID_PC`（非整数/非法格式）、`PC_OUT_OF_RANGE`（超出无符号 32 位）、`PC_MISALIGNED`（未对齐）。
- `INVALID_TAKEN`、`INVALID_BRANCHES`、`INVALID_K`、`INVALID_STEP_COUNT`、`INVALID_SEQ`、`INVALID_LIMIT`、`INVALID_JSON`、`INVALID_QUERY`、`INVALID_RUN_ID`。
- 资源与状态：`TRACE_NOT_FOUND`、`RUN_NOT_FOUND`、`STEP_NOT_FOUND`（404），`RUN_EXISTS`、`RUN_FINISHED`（409）。
- 错误响应统一为 `{ "error": { "code", "message" } }`。

## 该模型为何不能代表现代 CPU 的完整行为

这是一个用于教学的简化模型，与真实/现代处理器存在显著差距，包括但不限于：

- 只预测“是否跳转”，**不预测目标地址**（BTB/间接分支、返回栈等未建模）；
- 不模拟取指/译码/执行流水线时序、多级缓存与预测器查表时机；
- 不模拟推测执行、误预测冲刷与回滚、宏观/微码队列等；
- 真实 CPU 常融合多种预测器（如 TAGE/感知机类、循环检测器、选择器/锦标赛元预测），并使用更长的历史与几何索引；
- 表项状态、初始值、替换/老化策略以及上下文切换的影响在不同微架构上差异很大；
- 此处计数器为理想二位饱和器，不考虑实现层面的位宽、别名分区或物理布局效应。

因此输出只反映该 gshare 数学模型在给定序列上的行为，不代表任何具体 CPU 的性能或安全特性。
