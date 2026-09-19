# dsh-v-token-insight · V TOKEN INSIGHT（Token 洞察）

**简体中文**  | [English](README.en.md)

DeepSeek Harness Web 客户端的 **Token 统计与费用洞察插件**——把会话与工作区的 token 消耗、缓存命中、折算费用与消耗节奏变成随时可见的数据面板。

纯客户端、零内核改动：不替换、不禁用任何官方插件，数据全部来自宿主既有投影、会话窗口与本地逐步账本。

> **宿主版本门槛：DSH 0.1.2-rc.1 及以上**（v0.4.0 起适配 dsh-012 宿主 API：`useChat`/`useTrajectory` 拆分、`ctx.remote` typert 面、`data-shell-overlay` 几何锚；引导基线已清空）。旧版宿主请勿升级。

## 功能一览

| 入口 | 能力 |
|---|---|
| **侧栏座位 → Token统计总览**（整页） | 7 卡 KPI（计费 Token / 今日 DPS / 缓存命中 / 会话计数 / 费用 / 均价·每百万 Token）+ 维度页签：总览双轴图表（消耗趋势 + 费用趋势，颗粒度按日/月/年切换，「今天/本月」计划目标柱，费用卡附逐日金额明细）、按工作区（费用求和列）、按会话（明细表 + 搜索/排序/列宽拖拽/右键跳转，fork 会话「分支」徽标）、按模型（逐模型费用与均价列）、价格表、计划 |
| **座位速度仪表**（纯装饰） | 侧栏展开 = 按钮底边彩虹条；56px 导轨 = 圆钮彩虹环。今日消耗节奏对照每日计划的投影比驱动，零轮询零动画；未设计划静默降级 |
| **会话页第三页签「会话Token统计」** | 单会话 KPI、上下文占用压力条、每轮明细表（四桶/命中率/费用/累计费用，行点击跳回对话对应轮，展开逐步调用明细），与轮尾 chip 共享折叠缓存（长会话零重复折叠） |
| **回复尾部轻量显示** | 官方功能行内追加 `⏱耗时 · ≈费用 · token 总量`，悬停显示完整计价依据 |
| **fork 分支去重** | fork 会话的投影是其父会话消耗的种子副本（宿主 seed 复制），自动排除出所有合计并披露数量；行保留可查、带「分支」徽标 |
| **本地逐步账本 v2** | 分片存储 + 紧凑编码（体积 −62%）+ 5MB 总量预算与整会话逐出 + 2 天固化窗口 + 覆盖缺口自愈；**账面计价**：费用落盘快照，价目编辑不改写历史 |
| **价目表与计划** | 可维护价目表（四桶单价/分档/时段折扣/币种守卫，逐步计费即时重算）；每日/每月计划消耗（Token）设置，驱动目标柱与速度仪表 |

图表全部手写 SVG（零图表库），颜色全走官方主题令牌，尊重 `prefers-reduced-motion`；每图配表格替代（无障碍）。

## 安装

**方式一 · GitHub 地址直装（推荐）**——构建产物 `lib/client.js` 随源码入库，安装无需本地构建：

```
dsh plugin --profile web add "github:victor10035445/dsh-v-token-insight"
```

如需锁定版本：

```
dsh plugin --profile web add "github:victor10035445/dsh-v-token-insight#<commit-sha>"
```

装完**重启 `dsh web`**，刷新页面生效。

**方式二 · 本地 clone + link 直连**（免打包，改动后重启 `dsh web` 生效，适合开发调试）：

```
git clone https://github.com/victor10035445/dsh-v-token-insight.git
dsh plugin --profile web add "link:<克隆路径>"
```

**方式三 · tgz 打包安装**：

```
pnpm install && pnpm build   # 产出 lib/client.js
npm pack                     # 产出 dsh-v-token-insight-0.4.0.tgz
dsh plugin --profile web add "<tgz 的绝对路径>"
```

> **注**：源码（`src/`）经 esbuild 打包为客户端 bundle。直装/直连使用仓库内已构建的 `lib/client.js`；若你修改了 `src/`，需先 `pnpm install && pnpm build` 再重启生效。

## 使用

- 侧栏底部「**Token统计**」座位 → 跨会话总览整页（座位上的彩虹仪表显示今日消耗节奏；归档会话可见可查，fork 分支会话自动去重）；
- 任意会话页顶部第三页签「**会话Token统计**」→ 当前会话的轮级明细与逐步调用；
- 总览页「**计划**」页签设置每日/每月计划消耗（Token），趋势图叠加目标参考柱、座位仪表点亮节奏读数；
- 总览页「**价格表**」页签维护价目表（编辑器可对齐官方模型目录）；费用为账面价——修改价目只影响此后新沉淀的账目，不改写历史；
- 账本沉淀在浏览器 `localStorage`（v2 分片：`dsh-v-token-insight.ledger.v2.index` + 每会话分片键），计划（`dsh-v-token-insight.plan.v1`）、价目表（`dsh-v-token-insight.prices.v1`）、列宽偏好（`dsh-v-token-insight.colwidths.v2`）同样本地持久化；清空浏览器数据后可在总览页一键重建账本。

## 技术原理

| 机制 | 说明 |
|---|---|
| 插件形态 | 纯客户端插件：`cordis.patch.yml` 挂进 cordis loader，client-modules 自动把 `lib/client.js` 编入 `/plugins` 启动图；dsh-012 起 `dsh.client.inject` 引导基线为空，宿主按需自举 |
| 双层数据口径 | Tier 0 = 宿主列表行投影（fork 会话排除）；Tier 1 = 本地逐步账本（键 `(sessionId, turn, step)`，深补走 `ctx.remote` 的 follow 开帧 + page 翻页，页间让出 + RTT 退避） |
| fork 去重 | 有 `parentId` 且非 subagent 的会话判定为 fork 副本（宿主 seed 复制父会话全部事件），聚合层会话级整排、行保留可查、信息条披露 |
| 账本 v2 | 分片存储（索引键 + 每会话分片）、紧凑编码、持久化五步编排（固化 → 水位估算 → 收紧重试 → 全固化档 → 整会话逐出）、5MB 总量预算 |
| 账面计价 | 每次持久化把单遍计价产物快照进分片（引擎版本 + 价目指纹），费用展示读落盘价；价目编辑后可定点重算或全量重导出 |
| 共享折叠 | 双层 WeakMap（窗口快照 → fold → join）+ 内容签名（含原地变异防护），chip 与会话页签复用一次计算，O(1) 轮定位索引 |
| 计费 | L1 四桶单价 → L2 双维度分档 → L3 时段窗口 × 条目折扣，逐步计算；币种不符的步按「未定价」处理 |
| 图表 | 手写 SVG 原语（堆叠条/横条/双轴折线 + `niceScale` 整刻度），颜色全走 `--dsw-alias-*` / `--dsw-static-*` 令牌 |
| 构建 | esbuild → factory 形式 `lib/client.js`；`pricing / stats-fold / charts / pacing / plan-store` 纯函数模块可在 node 下直接单测 |

宿主端 `lib/index.js` 是无逻辑的空插件，仅让 cordis loader 能解析本包。

## 开发

```
pnpm install
pnpm build   # esbuild → lib/client.js
pnpm check   # node --check 两个产物
pnpm test    # node --test 纯函数单测（532 例）
```

## 文件

```
package.json          插件清单（dsh.bundle.patch + dsh.client 声明）
cordis.patch.yml      loader 插入条目
build.mjs             esbuild 构建脚本（src/ → lib/client.js）
lib/index.js          宿主端入口（空插件）
lib/client.js         客户端 bundle（factory 形式，随源码入库）
src/                  客户端源码（client.jsx + pricing/ledger/stats/charts/pacing/plan-store 纯函数模块）
test/                 纯函数单测（node --test，含账本等价性基线 fixture）
docs/                 开发者向内部实现档案（zh / en）
```

更多实现细节（注册点速查、页面锚点与样式钩子、联调风险清单）见 [内部实现档案](docs/zh/internals.md)（[English](docs/en/internals.md)）。

## License

[MIT](LICENSE)
