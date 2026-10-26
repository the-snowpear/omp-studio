# OMP 统计：真实能力、Studio 现状与适配清单

> **状态（已落地）**：旧的「6 个标签页全是同一张表」统计页及其读模型已整体删除（`StatisticsPage` 旧实现、`FrustrationPane`、`stats.read` / `stats.frustration`、Desktop `stats-worker.ts`、`studio-protocol` 的 `contracts/stats.ts`）。现在的统计页 = 二级页头以下整块内嵌原生 `omp stats` 仪表盘，入口在首页 Token 用量卡。本文第 3 节描述的断点因此不再有代码路径；保留它是因为第 2 节的上游能力盘点与第 4 节的适配清单仍然有效。
>
> **仍留在 Runtime overlay 里的死代码**：`omp-patch/overlay/packages/coding-agent/src/studio/stats-worker.ts`、`stats-protocol.ts` 以及接缝补丁 `0001-studio-cli-entry.patch` 里的 `__omp_worker_studio_stats` 分支。它们现在没有任何调用方；删除需要跑 `npm run omp:patches:regen` 并重出 Runtime 版本，所以单独作为一次任务处理。

本文回答三个问题：**上游 omp 的"统计"到底做了什么**、**旧统计页当时为什么是半成品**、**要真正接进来需要适配什么**。

证据全部来自本仓库代码与一次在本机真实 `~/.omp/stats.db`（10,443 条请求）上的实测，不是设计推测。上游包逐项清单见 [`tmp/stats-upstream-inventory.md`](../tmp/stats-upstream-inventory.md)（草稿，不入库）。

---

## 1. 结论先行

| 判断 | 依据 |
|---|---|
| 统计入口已从侧栏和二级导航移除，路由本身保留 | `App.tsx` 侧栏 action 行删除；`HomePage.tsx` 的 `PAGE_NAV_DEFS` 删除 `statistics` 项；`pageRoute === "statistics"` 分支与 `Route` 联合类型未动 |
| 现在的统计页不是"没做完"，是**数据源根本没通** | `apps/desktop/src/stats-worker.ts:8` 的版本闸只认 `18.4.4-studio.N≥26`，当前 Runtime 是 `18.12.6-studio.1`，闸门恒假 → worker 永远不启动 |
| 就算闸门放行，当前页面也只会显示 **0** | 实测：本机库 136 个脏小时 > `EXACT_DIRTY_LIMIT=96`，`message_rollup` 为 0 行，`getOverallStats()` 返回全 0，而真实总量是 10,443 请求 / $1121.80 |
| 上游统计能力比 Studio 暴露的多一个数量级 | 11 个原生板块（含 traces 火焰图、请求明细、错误分组、订阅窗口、gain）；Studio 只有 1 个扁平快照 + 500 行截断 |

---

## 2. 上游 `@oh-my-pi/omp-stats` 到底统计了什么

### 2.1 它是什么

Bun-only 本地可观测性包（`omp-patch/vendor/oh-my-pi/packages/stats/`，v18.12.6）：

```
~/.omp/agent/sessions/**/*.jsonl  ──tail parse──▶  ~/.omp/stats.db (bun:sqlite)
                                                       │
                                       hourly rollup ◀─┤
                                                       ▼
                                     Bun.serve 127.0.0.1:3847 → 11 个页面 + JSON API
```

- **数据源**：omp 自己的会话journal。不是埋点，不是上报，全部本地文件。
- **同步语义**：`withFileLock(${statsDbPath}.sync)` + 每文件游标（`offset` + 256 字节 `Bun.hash` 校验点 + `dev/ino/birthtimeMs`），只解析追加的尾巴；512 文件 / 8192 行一批，行与游标同一事务提交。
- **成本口径**：`@oh-my-pi/pi-catalog` 的公开价目表，即 **API 等价估算**，永远不是账单。无法定价的请求用 `cost_unpriced=1` 显式标记，而不是当 0 元。

### 2.2 数据模型（7 张事实/游标表 + 5 张 rollup 表）

| 表 | 粒度 | 关键点 |
|---|---|---|
| `messages` | 一次 provider 请求 | 27 列；token 四桶 + `cost_*` 四桶 + `cost_total` + `premium_requests` + `agent_type` + `service_tier`；`UNIQUE(session_file, entry_id)` |
| `tool_calls` | 一个 toolCall 内容块 | `calls_in_turn` 用于把该轮用量按调用数摊分 |
| `user_messages` | 一条用户输入 | `yelling/profanity/anguish/negation/repetition/blame` + `prose`(≤4000) + `prose_hash` |
| `frustration_verdicts` | 一段 prose | `p_annoyed/p_angry/target/judge/judged_at`；**任何 backfill 都不清** |
| `file_offsets` | 一个 transcript | 增量游标 + `parser_state` JSON |
| `message_rollup` / `tool_rollup` / `session_rollup` | 小时 / 会话 | 触发器维护 `rollup_dirty`、`session_dirty` |
| `meta` | 迁移哨兵 | 每个 backfill 一个键；改指标定义必须换键否则旧行静默保留旧口径 |

### 2.3 能算出来的指标（真实清单）

**请求与错误**：`requests`(COUNT)、`failed`(stop_reason='error')、`errorRate`、`successfulRequests`。
实测本机：10,443 请求 / 239 失败 / 2.29%——`toolUse` 9596、`stop` 487、`error` 239、`aborted` 121。

**Token**：input / output / cache_read / cache_write 四桶，以及 `total_tokens`。
⚠️ `total_tokens` 含 orchestration 余量，四桶之和不含；两个数**天然可能不等**（本机恰好相等，纯属这批数据没触发 orchestration 计费）。

**成本**：`cost_input/output/cache_read/cache_write/cost_total`、`cost_no_cache_input`、`unpricedRequests`、`totalPremiumRequests`。

**缓存**：`cacheRate = cacheRead/(input+cacheRead)`、`cacheSavings = (no_cache_input_cost − cached_prompt_cost)/no_cache_input_cost`。
实测本机：cache rate **73.9%**，cache savings **97.4%**——这才是值得看的大数。

**延迟**：`avgDuration`(13.2s)、`avgTtft`(5.6s)、`avgTokensPerSecond`(55.1)；注意 tps 是"每请求速率的均值"，不是"均值之比"。

**分摊维度**：model / provider / folder / **agent_type**(main 5841、subagent 4599、advisor 3) / session / tool / tool×model。

**时间序列**：5 分钟 / 小时 / 天三种桶；另有本地时区的按小时燃烧直方图、UTC 时区的每日成本序列（两者口径不同，做图必须选对）。

**Judge 相关**：frustration 概率、job 进度、报价；**gain**：snapcompact 省下的 token/字节。

### 2.4 对外暴露的两套接口

1. **HTTP**：26 个端点，`127.0.0.1:3847`，零鉴权；安全模型是回环绑定 + `x-omp-stats-dashboard: 3` 身份头 + 两个花钱 POST 必带 `X-Omp-Stats-Action: 1`（强制 CORS 预检且永不放行）。SSE `/api/events` 携带 `{version, sync, indexingHours}`。
2. **库函数**：`rollup.ts` 的一批同步读、`aggregator.ts` 的 `syncAllSessions/getDashboardStats`、`trace.ts`、`frustration.ts`、`gain-aggregator.ts`、`usage-windows.ts`。

---

## 3. Studio 现在这块为什么是"纯未完成品"

不是页面样式没打磨，是**四层断开**，自下而上：

### 3.1 第一层：Runtime 版本闸恒假（致命）

```ts
// apps/desktop/src/stats-worker.ts:8
export function supportsNativeStatsWorker(version:string):boolean {
 const match=/^18\.4\.4-studio\.(\d+)$/.exec(version);
 return match!==null && Number(match[1])>=26;
}
```

- 当前 Runtime 报的是 `18.12.6-studio.1`（`bridge-server.ts:298` 用 `${VERSION}-${PATCHSET_VERSION}`）
- 正则要求前缀 `18.4.4` → **恒 false** → `statsWorker()` 的 `executable()` 返回 `undefined` → `NativeStatsWorker` 抛 "Managed Runtime unavailable"
- 结果：`stats.read` 永远返回 `emptyStats(filter, "This Runtime does not provide a compatible statistics worker")`

这条闸是当年 18.4.4 时代为防"旧二进制把 worker selector 当 prompt"加的（注释写明），此后每次升级 Runtime 都没人回来改它。**它现在保护的是一个已经不存在的风险**。

### 3.2 第二层：rollup 冷启动返回 0（实测）

```ts
// rollup.ts:112  const EXACT_DIRTY_LIMIT = 96;
// rollup.ts:469  SELECT ... LIMIT 97 → 只有脏小时 ≤96 才走原始行
```

本机真实库：

| 事实 | 数值 |
|---|---|
| `messages` 行 | 10,443 |
| `rollup_dirty` 待建小时 | **136**（> 96） |
| `message_rollup` 行 | **0** |
| `getOverallStats(null)` 返回 | 全 0 |
| 真实总量 | 10,443 请求 / $1121.80 / 74% cache |

原因：脏小时一旦超过 96，读路径放弃"原始行兜底"，只读 `message_rollup`——而它是空的。
实测：先跑 `refreshRollups()`（146–241ms，一次成功）立刻恢复正确；不跑就永远是 0。
而 Studio worker 的 `sync()` 是**异步 fire-and-forget**（`stats-worker.ts:263`），第一次 `read()` 在 rollup 建好之前就返回了，页面拿到 0 且**没有任何"数据未就绪"提示**。

顺带验证：直接跑 `omp stats --json` 同样是全 0（因为它读的是同一个不完整 rollup），所以"改用官方 CLI"并不能绕过。

### 3.3 第三层：协议把上游压成了 7 个数字

```ts
// packages/studio-protocol/src/contracts/stats.ts
export interface StatsRow {id; label; requests; errors; tokens; costEstimate; unpriced}
export interface StatsSnapshot {available; updatedAt; cached; sync; overall; models; providers; projects; tools; frustration?; sessions?}
```

`AggregatedStats` 里有 18 个字段，`row()`（`stats-worker.ts:42`）只留了 4 个数值 + 2 个 id。
于是上游白算的：cacheRate、cacheSavings、avgDuration、avgTtft、tokensPerSecond、errorRate、firstTimestamp/lastTimestamp、premiumRequests、cost 四桶、agent_type 拆分、**全部时间序列**、请求明细、错误分组、traces、订阅窗口、gain——**全部丢弃**。

再加 `validateStatsSnapshot` 硬性 `length>500` 抛错，且切片发生在聚合之后：超过 500 个 folder 的列表被静默砍断，用户看不出被砍了。

### 3.4 第四层：前端只是一张表 × 6 个标签

`StatisticsPage.tsx` 6 个 tab 全是同一个 `table()`：概览/模型/费用/工具/项目/Frustration。没有图、没有趋势、没有下钻。
费用 tab 还写着"统计数据库不提供实时账户额度"——这句话只对 Studio 的适配层成立，上游 `usage-windows.ts` 是有的。

**结论**：这个页面的问题是**数据源闸门 + rollup 冷启动 + 协议窄化**三重断开，重做 UI 解决不了任何一层。

---

## 4. 需要适配什么（按依赖顺序）

### P0 — 让数据能流出来（不做这三件，后面全是空谈）

| # | 事项 | 落点 | 判定标准 |
|---|---|---|---|
| 1 | **版本闸改成能力探测**，不要绑死版本号 | `apps/desktop/src/stats-worker.ts:8` | 拿 `manifest.runtimeVersion` 只做"最低 upstream 版本 + 是否存在 overlay"判断；或改为探测 `__omp_worker_studio_stats` 的 hello 握手（worker 自己会回 `{protocol:1,kind:"studio-stats"}`，这才是真凭据） |
| 2 | **首读前同步建 rollup** | overlay `studio/stats-worker.ts` `sync()` | `read()` 里先 `await refreshRollups()`（实测 241ms/135 小时）；或 `sync()` 改成可 await 并在 snapshot 带 `rollups:{dirtyHours}` |
| 3 | **把"未就绪"如实说出** | `contracts/stats.ts` + `StatisticsPage.tsx` | `sync.state !== "completed" \|\| rollup.dirtyHours > 0` 时显示"正在建立聚合，当前为部分数据"，而不是渲染 0 |

### P1 — 协议扩宽（决定这个页面能长成什么样）

| # | 事项 | 说明 |
|---|---|---|
| 4 | `StatsRow` 补齐上游字段 | 至少加 `cacheRate/cacheSavings/avgDuration/avgTtft/tokensPerSecond/errorRate/premiumRequests/firstTimestamp/lastTimestamp`；`costEstimate` 之外补 cost 四桶 |
| 5 | 新增 `series` 段 | `getTimeSeries` / `getModelTimeSeries` / `getCostTimeSeries` / `getProviderTimeSeries` / `getToolTimeSeries`；桶大小由 range 决定，注意 500 上限要按点而不是按行 |
| 6 | 新增 `agentTypes` 段 | `getStatsByAgentType` — main/subagent/advisor 的 token 与成本分摊，这是"谁在烧钱"最直接的答案 |
| 7 | 去掉"切片即真相" | 500 截断必须回传 `truncated:true` 与真实总数，否则用户拿不到"还有多少" |
| 8 | 统一 token 口径 | 明确定义 `tokens` 是 `SUM(total_tokens)` 还是四桶之和；现在两处口径不一致（`row()` 用四桶，`session_rollup` 用 total） |

### P2 — 新板块（按价值排序，逐项独立可交付）

| 优先级 | 板块 | 上游来源 | 为什么值得做 |
|---|---|---|---|
| 高 | **趋势图 / 概览** | `getTimeSeries` + `getCostTimeSeries` | 统计页没有图等于没有统计 |
| 高 | **Agent 类型分摊** | `getStatsByAgentType` | 本机实测 subagent 吃 25.5% token、advisor 3 次请求烧 $9.75——这种异常现在完全看不见 |
| 高 | **请求明细 + 错误下钻** | `getRecentRequests` / `getRequestDetails` / `getRecentErrors` | 从"239 个失败"到"哪些失败、什么错误签名"是排障刚需 |
| 中 | **缓存效益** | `cacheRate` / `cacheSavings` | 97% 的缓存节省是这套库里最有信息量的数字 |
| 中 | **Traces 火焰图** | `buildSessionTrace` + ETag/304 | 回答"这一轮时间花在哪"；成本最高（要重读 JSONL） |
| 中 | **Provider 订阅窗口** | `getProviderWindowStats` | 能真正回答"额度还剩多少"，现在这格写着做不到 |
| 低 | **Gain** | `getGainDashboardStats` | 依赖 snapcompact 数据存在，受众窄 |
| 低 | **工具×模型 / 参数体积** | `getToolStatsByModel` / `argsChars` | 调优向，非日常 |

### P3 — 工程约束（实现时必须守住的线）

1. **`bun:sqlite` 独占**：不能在 Node 侧直接开写，必须走 worker 子进程（现有 `NativeStatsWorker` 架构是对的，别推翻）。
2. **单一写者**：Studio worker 与 `omp stats` 面板会同时写同一个库，靠 `withStatsSyncLock` + WAL `busy_timeout=5000` 兜；一次全量重解析超过 30s 请求超时会 500（`#request` 的 30s 定时器）。
3. **rollup 版本提升是破坏性的**：`ROLLUP_VERSION` 一动就 DROP 五张表全量重建——升级上游要注意首屏会有一次长时间空白。
4. **时区分裂**：日活按本地时区、成本序列按 UTC；半小时时区偏移会静默回退到原始行。做图必须显式选口径。
5. **fork 去重靠摄入顺序**：fork 比父会话新时，复制出来的条目会算到 fork 头上——总量对，按会话分摊不对。
6. **Judge 花钱且持锁**：`stats.frustration` 整条路径在 `withStatsSyncLock` 里，慢 Judge 会阻塞摄入。

---

## 5. 建议的落地顺序

1. **先修 P0 三件**（版本闸 + 首读建 rollup + 如实空态）。这三件做完，把入口加回去至少能看到正确数字。
2. **再定"统计到底服务谁"**——这决定 P1 扩到哪：
   - 服务**成本控制** → 优先 cost 四桶 + 订阅窗口 + agent 分摊
   - 服务**性能调优** → 优先 latency + tool×model + traces
   - 服务**质量回溯** → 优先错误下钻 + 请求明细 + frustration
3. **最后按板块重做页面**，一个板块一个 PR，别再一次性堆一个 6-tab 大表。

> 在此之前，侧栏入口保持移除状态是对的：一个稳定返回 0 或报错的入口，比没有入口更伤信任。

---

## 6. 本机实测附录

环境：`~/.omp/stats.db`，18.2MB，2026-08-03 → 2026-09-19 的真实使用记录。

```
messages              10,443 行
tool_calls            12,572 行
user_messages            652 行
frustration_verdicts       0 行（从未跑过 Judge）
file_offsets             358 个 transcript
message_rollup             0 行  ← 关键
rollup_dirty             136 小时 ← 关键（>96 上限）
session_dirty            385 个会话（<512，会话级仍走精确路径）

真实总量（原始行直算）
  请求 10,443 · 失败 239 · 错误率 2.29%
  input 270,864,672 · output 7,329,687 · cache_read 767,214,893 · cache_write 0
  total_tokens 1,045,409,258 · 成本 $1,121.80 · unpriced 0 · premium 0
  avgDuration 13,227ms · avgTtft 5,629ms · avgTps 55.06

调 refreshRollups() 后（146–241ms）
  上述数字全部恢复；message_rollup 256 行，dirty 归零
  模型 Top3：opencode-go/deepseek-v4-flash 2910 次 $2.28 cache 98.4%
             sub2api-go/deepseek-v4-flash 2422 次 $1.87 cache 97.3%
             antigravity/gemini-3.7-flash-high 1050 次 $18.21 cache 0.8%

按 agent 类型
  main     5841 次 · 778.5M token · $1041.80
  subagent 4599 次 · 266.9M token · $70.25
  advisor     3 次 ·       6 token · $9.75   ← 见下

advisor 三行原始数据（值得单独看一眼）
  claude-sonnet-4-5/anthropic · 2 token · $0.25
  claude-sonnet-4-5/anthropic · 2 token · $0.50
  claude-sonnet-4-5/anthropic · 2 token · $9.00
```

三行都是 2 个 token 却报了 $0.25 / $0.50 / $9.00——这就是上游 `cost_unpriced` / 时基卡（scheduled card）定价的典型表现：**金额是价目表推算，不是账单**。这类行现在在 Studio 里被折叠成一个 `costEstimate` 标量，完全看不出来。

复现方式（无副作用，用临时 HOME 复制库）：

```bash
mkdir -p /tmp/h/.omp && cp ~/.omp/stats.db /tmp/h/.omp/stats.db
cd omp-patch/vendor/oh-my-pi/packages/stats
HOME=/tmp/h USERPROFILE=/tmp/h bun run src/index.ts --json
```

未跑 `refreshRollups()` 时全 0；跑过之后数字正确——这就是 3.2 节那只 bug 的可复现证据。
