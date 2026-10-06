# 设备可用度服务

基于维修事件流重建泵站、加药设备状态时间线，计算 MTBF、MTTR、稳态/观测可用度，并按带版本的可靠性框图计算整线可用度。技术栈：Node.js 20、TypeScript、Express、MongoDB 7、Vitest。

## 启动

```bash
docker compose up --build
# API: http://localhost:3000
```

本地开发：

```bash
npm install
npm run dev          # 无 MONGO_URL 时使用内存仓储，适合纯单元测试
npm test
npm run build
MONGO_URL=mongodb://127.0.0.1:27017 MONGO_DB=availability npm start
```

如本机已有 MongoDB 7，可运行持久化集成测试：

```bash
RUN_MONGO_TESTS=1 MONGO_URL=mongodb://127.0.0.1:27017 npm test
```

## 核心数据模型

事件：

- `eventId`：业务事件编号，全局唯一；重复提交同一编号且内容相同为幂等，内容不同返回 409。
- `deviceId`、`type`、`occurredAt`（设备事件实际发生时刻）、`recordedAt`（入库时刻，默认当前时刻）。
- 类型：`FAULT`、`REPAIR_START`、`REPAIR_END`、`PLANNED_START`、`PLANNED_END`、`VOID`。
- `VOID` 事件带 `targetEventId`，只能作废已存在的事件。作废事件本身也可以再被作废；后一种情况下原事件恢复有效。
- 更正时刻通过“生成一条 VOID + 一条带 `supersedesEventId` 的新事件”表示。原事件未被作废前只取原事件；原事件被作废后自动取新事件。

所有查询结果都由当前有效事件按以下规则重放得到，而不是依赖写入顺序：

1. 取截至查询时点 `recordedAt <= asOf` 的事件，支持“按报表日掌握的数据”重算。
2. 删除被有效 VOID 作废的事件；删除 VOID 事件本身和被更正前的旧事件。
3. 同一事件编号只保留一次。
4. 按 `occurredAt` 升序排序。
5. 同一时刻按 `FAULT → REPAIR_START → REPAIR_END → PLANNED_START → PLANNED_END`，再按 `eventId` 排序。该并列顺序是确定性规则，不改变时间戳。

## 状态机与矛盾处理

状态：`UP`（运行）、`WAITING_REPAIR`（故障待修）、`REPAIR`（维修中）、`PLANNED`（计划检修）。

矛盾不静默修复，会在时间线和 `/api/contradictions` 中列出，同时采用以下确定规则：

| 矛盾 | 处理 |
| --- | --- |
| 非 UP 再次 FAULT | 忽略后一条故障，保留尚未关闭的故障 |
| UP 直接 REPAIR_START | 视为同一时刻发生故障并进入维修，标记 `REPAIR_START_WITHOUT_FAULT` |
| REPAIR 中再次 REPAIR_START | 忽略重复维修开始 |
| PLANNED 中 REPAIR_START | 忽略维修开始，保持计划检修 |
| WAITING_REPAIR 中 REPAIR_END | 接受为零维修时长的故障关闭 |
| REPAIR 中 REPAIR_END | 正常回到 UP |
| UP 中 REPAIR_END | 忽略不匹配的维修结束 |
| PLANNED 中 REPAIR_END | 忽略，保持计划检修 |
| 非 UP 时 PLANNED_START | 忽略计划检修开始，保持当前状态 |
| 非 PLANNED 时 PLANNED_END | 忽略不匹配的计划检修结束 |

## 统计口径

窗口为 `[start, end)`。系统提供两种方法：

- `right_censored`（默认）：采用总试验时间/总在岗时间（TTT）口径。
  - MTBF 分母为窗口内发生的故障数；分子为窗口内实际 UP 暴露时长，包括末端尚未结束的运行区间截至窗口结束的长度。
  - MTTR 分子为窗口内故障停机暴露时长（故障待修 + 维修中），包括窗口结束时未关闭维修单截至窗口结束的长度；分母为与窗口相交的故障停机区间数（已完成区间按完整长度，未完成区间按截至窗口的观察长度）。
  - 这不是把未完成停机“当成完整停机”，只计入已经观察到的长度。故障会立即计入故障数，因此长周期小样本下估计可能偏保守；它不会像丢弃法那样系统性抹掉近期设备和未结工单的信息。
- `drop`：直接丢弃所有截断区间。
  - 只统计完整“维修结束 → 下一次故障”的运行区间。
  - 只统计窗口内开始且窗口内关闭的完整故障/维修区间。
  - 窗口开始前开始、窗口内仍未关闭的初始停机，以及窗口结束仍未关闭的维修单均不进入 MTBF/MTTR。

测试 `tests/statistics.test.ts` 用构造数据展示：一个故障在 100h、200h 修复，另一个故障在 600h、1000h 窗口结束仍未关闭。右删失口径 MTBF 为 `(100 + 400)/2 = 250h`；丢弃法只保留 400h 的完整运行段，得到 400h，漏掉未关闭故障暴露。

稳态可用度：

```text
A = MTBF / (MTBF + MTTR)
```

参考值 MTBF=900h、MTTR=100h 时为 0.9。观测可用度为窗口内 UP 时长 / 计入时钟。计划检修是否计入停机由设备类别 `plannedIsDowntime` 配置，也可在单设备统计接口临时覆盖。无故障数据时稳态值返回 `null`，观测可用度仍可由时间线直接得到。

## 可靠性框图和结构版本

叶子：设备；组合：`series`、`parallel`、`k_of_n`，可任意嵌套。

- 串联：`A = ∏ Aᵢ`，n 台相同设备为 `Aⁿ`。
- 并联：`A = 1 - ∏(1-Aᵢ)`，n 台相同设备为 `1-(1-A)ⁿ`。
- k-of-n：枚举所有工作/失效组合，至少 k 个叶子/子块工作即系统工作。
- 3 台 A=0.9 的设备组成 2-of-3：`3×0.9²×0.1 + 0.9³ = 0.972`。
- 两台串联 0.81；两台并联 0.99。
- 并联分支互换只改变乘法顺序，结果不变。

结构版本带 `validFrom` 和 `recordedAt`。跨版本窗口按 `validFrom` 切成若干时间段，每段用当时有效结构计算，然后按时长加权：

```text
A_window = Σ(Aᵢ × Tᵢ) / Σ(Tᵢ)
```

窗口开始前没有结构的时段，该段可用度为 `null` 且不参与平均；响应会列出每段详情。

拒收规则：k 非正整数或 k>n、引用不存在设备、同一结构中重复出现同一设备、窗口结束不晚于开始、未知事件类型、作废不存在事件。

## 主要 HTTP 接口

| 方法/路径 | 说明 |
| --- | --- |
| `POST /api/categories` | 维护类别及计划检修是否停机 |
| `GET /api/categories` | 类别列表 |
| `POST /api/devices` | 维护设备 |
| `GET /api/devices` | 设备列表 |
| `GET /api/devices/:id` | 设备详情 |
| `POST /api/events` | 提交单条事件 |
| `POST /api/events/batch` | 批量提交；逐条返回成功或错误 |
| `POST /api/events/:id/corrections` | 更正事件（作废旧事件并写入新事件） |
| `GET /api/devices/:id/timeline?start&end&asOf` | 设备时间线 |
| `GET /api/contradictions?start&end&asOf` | 矛盾清单 |
| `GET /api/devices/:id/statistics?start&end&method&asOf&plannedIsDowntime&freeze` | 单设备窗口统计 |
| `GET /api/statistics/windows?start&end&method&asOf&freeze` | 全部设备窗口统计；`freeze=true` 时读取/生成固化报表快照 |
| `POST /api/systems/:systemId/versions` | 新增结构版本 |
| `GET /api/systems/:systemId/versions?asOf` | 结构版本 |
| `GET /api/systems/:systemId/availability?start&end&asOf` | 整线可用度 |
| `GET /api/recalculations?start&end&asOf` | 按某时点重算 |
| `GET /api/recalculations/diff?start&end&baselineAsOf&currentAsOf` | 重算差异及影响事件清单 |

示例：

```bash
curl -X POST http://localhost:3000/api/categories \
  -H 'content-type: application/json' \
  -d '{"name":"pump","plannedIsDowntime":false}'
```

## 并发、重启与一致性

- 两个班组可并发提交；MongoDB 对 `eventId` 建唯一索引，重复编号不会插入两次。
- 批量请求按数组顺序执行，同一批中先提交故障、后提交作废也能正确引用。
- 所有派生结果均由事件存储重放；服务重启后从 MongoDB 的设备、类别、事件和结构版本集合恢复。
- 统计结果另外写入 `derived_snapshots` 作为报表审计快照。普通快照仍可随事件更新；统计请求带 `asOf` 和 `freeze=true` 时，首次计算后固化，之后即使补录该时点之前的数据，也返回当时固化的数值。未固化的 `/api/recalculations` 始终从有效事件重新推导，保证“当前有效事件从头处理”的语义。
