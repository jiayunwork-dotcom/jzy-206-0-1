# 泵站与加药系统可用度服务

Node.js 20 + TypeScript + Express + MongoDB 7 的事件溯源后端。输入维修台账事件，服务始终从“当前有效事件集”重新推导设备状态时间线、统计窗口指标、可靠性框图和系统可用度。

## 快速启动

```bash
docker compose up --build
# API: http://localhost:3000
# MongoDB: localhost:27017, database=availability
```

本地开发：

```bash
npm install
npm run dev
npm test
npm run typecheck
npm run build
npm start
```

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 端口 |
| `MONGO_URL` | `mongodb://mongo:27017` | MongoDB 连接串 |
| `MONGO_DB` | `availability` | 数据库名 |

## 数据模型与事件

事件字段：

```json
{
  "eventId": "repair-order-1001",
  "equipmentId": "pump-1",
  "time": 1759000000000,
  "type": "repair_start",
  "recordedAt": 1759100000000
}
```

类型：

- `failure`：故障；
- `repair_start`：维修开始；
- `repair_end`：维修结束；
- `planned_start`：计划检修开始；
- `planned_end`：计划检修结束；
- `void_event`：作废另一条事件，必须给 `targetEventId`。

事件编号全局唯一。重复提交相同编号、相同设备、类型、时刻的事件返回 `duplicate: true`，不重复入账。相同编号但其他关键字段冲突返回 409；改时刻调用更正接口，不允许伪装成新的幂等提交。

更正接口：

```http
PATCH /events/:eventId/correction
{ "time": 1759003600000 }
```

每次更正在 `revisions` 中保留版本和 `recordedAt`。作废不能撤销；作废后该事件从所有“截至作废后”的有效事件集中消失。

## 状态时间线与确定性规则

状态：

- `running` 运行；
- `waiting_repair` 故障待修；
- `under_repair` 维修中；
- `planned_maintenance` 计划检修。

推导是纯函数：取当前有效事件，按以下顺序从头处理：

1. `time` 升序；
2. 同时刻按事件确定性顺序：
   1. `repair_end`
   2. `planned_end`
   3. `failure`
   4. `repair_start`
   5. `planned_start`
3. 再按 `recordedAt`、`eventId` 排序。

因此乱序到达、重复到达、两个班组并发提交，最终结果都与按业务时刻逐条处理一致。服务内部还使用提交串行队列，避免并发写入竞态。

### 矛盾处理规则

矛盾不会被静默修复。矛盾事件列入 `contradictions`，事件编号列入 `ignoredEventIds`，该事件不改变状态。规则如下：

| 当前状态 | 矛盾事件 | 处理 |
| --- | --- | --- |
| `waiting_repair` | 再次 `failure` | 忽略，保持待修 |
| `under_repair` | `failure`、再次 `repair_start`、`planned_start` | 忽略，保持维修中 |
| `running` | `repair_start`、`repair_end`、`planned_end` | 忽略，保持运行 |
| `waiting_repair` | `repair_end`、`planned_start`、`planned_end` | 忽略，保持待修 |
| `planned_maintenance` | 再次 `planned_start`、`repair_end` | 忽略，保持计划检修 |
| `planned_maintenance` | `failure` | 接受，计划检修在该时刻结束，进入待修 |
| `planned_maintenance` | `repair_start` | 接受，故障维修抢占计划检修，进入维修中；之后晚到的 `planned_end` 判为矛盾并忽略 |

没有开始就结束的维修、没有计划开始的计划结束都会进入矛盾清单。窗口结束仍未关闭的维修单不是矛盾，而是右删失数据。

## 窗口统计

设备类别配置：

```json
{ "plannedMaintenanceAsDowntime": true }
```

- `true`：计划检修计入不可用时间；
- `false`：计划检修计入可用时间，但运行暴露时间仍不计入 MTBF 的运行暴露。

窗口为半开区间 `[windowStart, windowEnd)`。指标：

- `mtbfHours`：平均无故障时间；
- `mttrHours`：平均主动修复时间；
- `meanWaitingTimeHours`：故障到维修开始的平均等待时间，独立于 MTTR；
- `steadyStateAvailability`：窗口内稳态可用度估计；
- `inherentAvailability`：`MTBF / (MTBF + MTTR)` 的辅助指标；
- `failureCount`、`completedRepairCount`、`rightCensoredRepairCount`。

### 截断选择：默认按删失数据处理

默认 `truncationMethod=censored`。

- 右边界仍在运行：截到窗口边界的运行时间计入 MTBF 的运行暴露；
- 右边界仍在维修：已观察到的维修时长计入维修暴露，同时记一个“在险维修项”，但不记为完成维修；
- 左边界假设设备处于运行状态；第一条已知事件之前和最后一条事件之后均按运行填充；
- 可用度是完整窗口的状态占比，不因为 MTBF/MTTR 的估计方式而删除实际停机时间。

这样做的方向：

- 直接丢弃边界运行区间会少算无故障暴露，通常使 MTBF 偏低；
- 直接丢弃未完成维修单会少算长维修暴露，通常使 MTTR 偏乐观（偏低）；
- 删失暴露法把已经发生的观察时长纳入估计，但不把未完成维修当作已知完整时长。

也可以传 `truncationMethod=discard` 复现“直接丢弃完整周期以外样本”的旧算法，便于报表对比。构造测试位于 `tests/truncation.test.ts`：

- 一个 2 小时完成维修和一个窗口结束时已观察 15 小时但未完成的维修：
  - discard：MTTR=2h；
  - censored：`(2 + 15) / 2 = 8.5h`；
- 5h、4h 两个完整运行区间加 9h 右删失运行区间：
  - discard：MTBF=`(5 + 4)/2 = 4.5h`；
  - censored：MTBF=`(5 + 4 + 9)/2 = 9h`。

参考值测试：故障在 900h、维修在 1000h 结束，窗口为 `[0,1000h)`，得到 MTBF=900、MTTR=100、可用度=0.9。

## 可靠性框图与版本

节点：

```json
{ "type": "equipment", "equipmentId": "pump-1" }
{ "type": "series", "children": [] }
{ "type": "parallel", "children": [] }
{ "type": "k_of_n", "k": 2, "n": 3, "children": [] }
```

假设设备状态统计独立：

- 串联：`A = Π A_i`；
- 并联：`A = 1 - Π (1-A_i)`；
- n 中取 k：用精确的独立伯努利概率分布，求至少 k 个可用的概率。

参考：

- 三台 0.9 的 2-of-3：0.972；
- 两台 0.9 串联：0.81；
- 两台 0.9 并联：0.99。

结构提交时校验：

- `k` 必须为正整数且 `k <= n`；
- `children.length === n`；
- 叶子设备必须存在；
- 同一结构中同一设备不能重复。

结构按版本保存：

```http
POST /systems/line/structure-versions
{
  "id": "v2",
  "effectiveFrom": 1759000000000,
  "root": { "type": "parallel", "children": [] }
}
```

新增版本若落在当前开放版本区间内，会把旧开放版本的 `effectiveTo` 置为新版本生效时刻。

跨版本窗口的合成方式：

1. 收集窗口内结构版本边界和各设备状态切换边界；
2. 在每个无内部边界的小时段内，设备可用度为常数；
3. 计算该时段结构可用度；
4. 按时长加权平均：`Σ(A_segment × duration_segment) / window_duration`。

若某时段没有已知适用结构版本，该时段 `availability=null`，整个系统也返回 `null`，不猜测结构。

## 按时点重算

所有统计、时间线、结构查询都可传 `asOf`。服务只使用：

- `recordedAt <= asOf` 的事件提交或更正版本；
- `recordedAt <= asOf` 的作废；
- `createdAt <= asOf` 的设备、类别和结构版本。

示例：

```http
POST /equipment/pump-1/recalculation-comparison
{
  "windowStart": 1758345600000,
  "windowEnd": 1760937600000,
  "earlierAsOf": 1761024000000
}
```

返回：

- `earlier`：按上季度报表日数据得到的结果；
- `current`：按今天全部数据得到的结果；
- `effectiveEventDifference.added`：晚到事件；
- `removed`：后来作废的事件；
- `changed`：后来更正的事件，含 `from`、`to`；
- `unchanged`：未变事件。

时间整体平移不变性由纯时间计算保证，测试通过平移所有事件时间和窗口验证。作废某设备全部事件后，窗口内没有任何有效区间，设备恢复为全程运行，可用度为 1。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/categories` | 新增设备类别 |
| GET | `/categories` | 当前类别 |
| PATCH | `/categories/:id` | 更新类别配置（保留历史） |
| POST | `/equipment` | 新增设备 |
| GET | `/equipment` | 当前设备 |
| PATCH | `/equipment/:id` | 更新设备名称或类别（保留历史） |
| POST | `/events` | 提交单条事件 |
| POST | `/events/batch` | 批量提交 |
| PATCH | `/events/:eventId/correction` | 更正时刻/设备/类型 |
| GET | `/equipment/:id/timeline?asOf=` | 时间线 |
| GET | `/equipment/:id/contradictions?asOf=` | 矛盾清单 |
| POST | `/equipment/:id/statistics` | 窗口统计 |
| POST | `/equipment/:id/recalculation-comparison` | 时点重算与差异 |
| POST | `/systems/:systemId/structure-versions` | 新增结构版本 |
| POST | `/systems/:systemId/availability` | 系统可用度 |
| GET | `/health` | 健康检查 |

错误响应：

```json
{ "error": { "code": "INVALID_REQUEST", "message": "..." } }
```

## 模块划分

- `src/repositories`：事件、设备/类别、结构版本存储；MongoDB 实现和测试内存实现共用接口；
- `src/timeline.ts`：事件排序、状态机、矛盾检测；
- `src/statistics.ts`：区间裁剪、删失/discard 估计、可用度；
- `src/rbd.ts`：框图校验与串并联/k-of-n 求值；
- `src/service.ts`：事务性提交语义、版本、按时点查询、系统分段合成；
- `src/validation.ts`：输入校验；
- `src/app.ts`：Express HTTP 适配；
- `src/server.ts`：MongoDB 连接与启动；
- `tests/`：Vitest 单元、服务语义和 HTTP 测试。

## 测试覆盖

```bash
npm test
```

覆盖：

- MTBF=900、MTTR=100、A=0.9；
- 2-of-3=0.972、串联=0.81、并联=0.99；
- 串联 n 台等于单台 n 次方、并联 n 台等于 `1-(1-A)^n`；
- 时间整体平移不变；
- 并联分支互换不变；
- 全部事件作废后回归全程运行；
- 乱序到达与顺序处理一致；
- 重复事件幂等；
- 矛盾识别和确定处理；
- 删失处理与直接丢弃的偏差对比；
- 跨结构变更窗口的分段时长加权；
- 按时点重算一致性、晚到/作废/更正差异清单；
- 并发提交；
- 从同一事件存储重新构造服务模拟重启恢复；
- HTTP 接口；
- 所有指定拒收条件。

## MongoDB 集合

- `events`：事件及作废记录，`eventId` 唯一索引；
- `categories`：类别历史；
- `equipment`：设备历史；
- `structure_versions`：结构版本。

服务重启后不依赖内存缓存，直接从这些集合恢复并重新推导。
