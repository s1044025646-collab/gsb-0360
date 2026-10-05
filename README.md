# gshare 分支预测模拟器（教学用后端）

用 TypeScript + Node.js + SQLite 实现的教学用 gshare 条件分支预测模拟服务，只提供 HTTP API 与 CLI，无前端。
输入是有序的分支记录（四字节对齐地址 + 实际是否跳转），模拟预测器在看到实际结果**之前**给出的预测，以及事后训练过程。

## 模型说明

- 全局历史寄存器 `k` 位（`k` 取值 1 到 10，创建运行时固定，中途不可改），初始为 0。
- 预测表 `2^k` 项二位饱和计数器，初始全部为 1。
- 表索引：`((PC >>> 2) XOR history)` 的低 `k` 位（无符号口径，最高地址位不会变负）。
- 计数器 0、1 预测不跳；2、3 预测跳转。
- 每一步顺序固定：先用旧历史与旧计数器预测，再按实际结果将计数器向 0 或 3 饱和更新（不绕回），最后把实际结果移入历史并保留低 `k` 位。训练使用旧历史算出的索引，不会用更新后的历史去训练另一个表项。
- 不同地址可能映射到同一表项（混叠），报告会展示；但地址相同不保证索引相同，因为全局历史也参与索引。

## 为什么它不能代表现代 CPU

本模型只分析已给出的分支序列：不执行机器码、不读取真实 CPU 计数器、不模拟指令流水线、不做目标地址预测（BTB）、不模拟推测执行与回滚，也没有返回地址栈、间接分支预测、多级或混合预测器（TAGE、感知机等）。现代 CPU 的预测器结构、历史长度和更新时机均为未公开实现细节，且与流水线深度耦合。因此这里的正确率只用于教学对照，不代表任何真实硬件行为。

## 环境要求

- Windows 本地，Node.js 22 及以上（使用内置 `node:sqlite`，无需 Docker、WSL、外部服务或原生编译）。
- 首次准备：`npm install`

## 可运行命令

```
npm run build     # 编译 TypeScript 到 dist/
npm test          # 编译并运行全部测试
npm start         # 启动 HTTP 服务（默认选择空闲端口；--port=8080 指定端口）
npm run demo      # 写入可重建演示轨迹（一直跳转 / 交替 / 两地址有意混叠）
node dist/cli.js  # CLI 用法帮助
```

数据保存在项目内 `data/gshare.db`，已处理位置、历史、表项与每一步都在事务中原子写入；重启后继续运行与不中断运行结果完全相同。

## CLI

```
node dist/cli.js demo                          写入演示轨迹
node dist/cli.js add-trace <file> [--name=N]   从 JSON 导入轨迹（{"records":[{address,taken},...]}）
node dist/cli.js traces                        列出轨迹
node dist/cli.js create-run --trace=ID --k=K   用固定 k 创建运行（同一轨迹可用不同 k 建独立对照）
node dist/cli.js step <runId> [n]              推进 n 步（默认单步；达到预算未读完会提示尚未结束）
node dist/cli.js show-step <runId> <branchNo>  查看指定步骤：索引的二进制形成过程与表项变化
node dist/cli.js steps <runId> [--limit=N]     列出步骤（limit 只限制展示，不影响训练）
node dist/cli.js table <runId> [--limit=N]     查看预测表
node dist/cli.js stats <runId>                 正确率统计（零记录显示无数据，不产生 NaN）
node dist/cli.js report <runId>                按地址汇总并与基准比较，列出混叠表项
```

基准为“始终预测不跳转”，仅作参照，gshare 不保证在每个输入上都优于它。

## HTTP API

默认绑定空闲端口，启动日志打印实际地址。所有错误返回 `{"error":{"code","message"}}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/traces` | 保存轨迹 `{name, records:[{address, taken}]}`，地址为无符号 32 位且四字节对齐（数字或 `"0x..."`） |
| GET | `/traces`、`/traces/:id` | 列出轨迹、查看记录 |
| POST | `/runs` | 创建运行 `{traceId, k}` |
| POST | `/runs/:id/step` | 单步训练 |
| POST | `/runs/:id/advance` | 有限步推进 `{n}`，返回 `finished` 表示轨迹是否读完 |
| GET | `/runs/:id` | 运行状态与统计 |
| GET | `/runs/:id/steps/:n` | 查看指定步骤（旧历史、索引、计数器前后值、预测、实际、命中、新历史） |
| GET | `/runs/:id/steps?limit=N` | 列出步骤 |
| GET | `/runs/:id/table` | 查询预测表 |
| GET | `/runs/:id/stats` | 正确率（空轨迹返回 `accuracy:null, noData:true`） |
| GET | `/runs/:id/report` | 按地址汇总与基准比较 |
| GET | `/runs/:id/aliases` | 混叠表项（同一索引出现多个地址） |

错误码：`INVALID_ADDRESS`、`INVALID_ALIGNMENT`、`INVALID_K`、`INVALID_INPUT`、`INVALID_COUNTER`、`INVALID_JSON`、`NOT_FOUND`、`RUN_FINISHED`（轨迹结束后拒绝追加训练）。

## 演示数据

`npm run demo` 写入三条可重建轨迹：

- `always-taken`：一直跳转。可看到计数器从 1 饱和升到 3，其中包含“预测正确但计数器仍训练”的步骤（计数器 2 预测跳转且命中，仍训练到 3）。
- `alternating`：结果交替，展示二位计数器在强交替序列上的固有误预测。
- `aliasing`：`0x1000` 与 `0x1040` 在 `k=4` 时 `(PC>>2)` 低 4 位相同，前两条记录历史均为 0，直观展示两个地址共享同一表项的混叠。

## 测试覆盖

`npm test` 覆盖：四种计数器值乘两种结果的全部转换、历史遮罩无残留、不同 PC 的混叠与同地址不同历史、`k` 边界（1 与 10）、空输入无数据状态、最高合法地址 `0xFFFFFFFC` 的无符号处理、短记录手工展开逐步断言、逐步与批量一致性、保存重启后恢复一致性、命中加失败等于处理数、按地址汇总一致、结束后追加训练被拒绝。

## 限制

- 仅后端（API 与 CLI），无前端界面。
- `node:sqlite` 在 Node 25 仍打印 ExperimentalWarning，不影响功能。
- 单进程服务，无鉴权，仅供本地教学使用。
