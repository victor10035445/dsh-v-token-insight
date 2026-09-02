# dsh-v-token-insight · V TOKEN INSIGHT（Token 洞察）

**简体中文**  | [English](README.en.md)

DeepSeek Harness Web 客户端的 **Token 统计与费用洞察插件**——把会话与工作区的 token 消耗、缓存命中与折算费用变成随时可见的数据面板。

纯客户端、零内核改动：不替换、不禁用任何官方插件，数据全部来自宿主既有投影与会话窗口。

## 功能一览

| 入口 | 能力 |
|---|---|
| **侧栏座位 → Token统计总览**（整页） | 全会话 KPI（计费 Token / 计费输入 / 输出 / 缓存命中率 / 会话计数 / 费用）+ 五个维度页签：总览图表（消耗趋势 / 模型分布 / 项目占比 / 费用趋势）、按工作区、按会话（明细表 + 搜索/排序/列宽拖拽/右键跳转）、按时间（双口径）、按模型、价格表 |
| **会话页第三页签「会话Token统计」** | 单会话 KPI（计费四卡 + 首字延迟 / 生成速度）、上下文占用压力条、每轮明细表（四桶 / 命中率 / 折算费用，行点击跳回对话对应轮，行首展开逐步调用明细） |
| **回复尾部轻量显示** | 官方功能行内追加 `⏱耗时 · ≈费用 · token 总量 (↑输入 ↓输出)`，悬停显示完整计价依据 |
| **本地逐步账本** | 逐 (会话, 轮, 步) 沉淀消耗记录，支持按会话深度补全、一键重建、JSON 备份/恢复、压缩老化与孤儿清理——归档会话的消耗也能回溯 |
| **价目表与费用折算** | 可维护价目表（四桶单价 / 分档 / 时段折扣 / 币种守卫），逐步计费即时重算，绝不「总量 × 单价」近似；无匹配条目不显示费用（不猜价） |

图表全部手写 SVG/HTML（零图表库依赖），颜色全走官方主题令牌随明暗主题联动，尊重 `prefers-reduced-motion`；每个图表都配表格替代（无障碍）。

## 安装

**方式一 · GitHub 地址直装（推荐）**——构建产物 `lib/client.js` 随源码入库，安装无需本地构建：

```
dsh plugin --profile web add "github:victor10035445/dsh-v-token-insight"
```

如需锁定版本（后续推送不会悄悄改变实际运行的代码）：

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
npm pack                     # 产出 dsh-v-token-insight-0.3.0.tgz
dsh plugin --profile web add "<tgz 的绝对路径>"
```

> **注**：与零构建的 `dsh-v-theme` 不同，本插件源码（`src/`）经 esbuild 打包为客户端 bundle。直装/直连使用仓库内已构建的 `lib/client.js` 即可；若你修改了 `src/`，需先 `pnpm install && pnpm build` 再重启生效。

## 使用

- 侧栏底部「**Token统计**」座位 → 打开跨会话总览整页（归档会话同样可见可查）；
- 任意会话页顶部第三页签「**会话Token统计**」→ 查看当前会话的轮级明细与逐步调用；
- 回复尾部查看每轮轻量消耗；明细表内右键可跳转会话或复制会话 ID；
- 总览页「**价格表**」页签维护价目表（编辑器内可对齐官方模型目录），费用随价目即时重算；
- 账本沉淀在浏览器 `localStorage`（`dsh-v-token-insight.ledger.v1`），价目表（`dsh-v-token-insight.prices.v1`）与列宽偏好（`dsh-v-token-insight.colwidths.v2`）同样本地持久化——清空浏览器数据后可在总览页一键重建账本。

## 技术原理

| 机制 | 说明 |
|---|---|
| 插件形态 | 纯客户端插件：`cordis.patch.yml` 把插件挂进 cordis loader，`dsh.client.inject` 声明引导基线（runtime / locale / ui-layout / ui-conversation / ui-sidebar），client-modules 自动把 `lib/client.js` 编入 `/plugins` 启动图 |
| 双层数据口径 | Tier 0 = 宿主列表行投影（`tokenUsage` / `sessionStats` 等，O(1) 有界状态、全会话权威总量）；Tier 1 = 本地逐步账本（键 `(sessionId, turn, step)`，支持离线深度补全） |
| 每轮明细 | 读会话窗口节点 `usage / timing`，并从轨迹视图 `requests[]` 按 `(turn, step)` join 补全每步模型与调用参数 |
| 计费 | L1 四桶单价 → L2 双维度分档（上下文规模 / 会话累计）→ L3 时段窗口 × 条目折扣，逐步计算即时呈现不落库，币种不符的步按「未定价」处理 |
| 图表 | 手写 SVG 布局原语（堆叠条 / 横条 / 折线 + `niceScale` 整刻度），零依赖、颜色全走 `--dsw-alias-*` / `--dsw-static-*` 令牌 |
| 构建 | esbuild → factory 形式 `lib/client.js`（react / `@deepseek-ai/*` 全部 external）；`pricing / stats-fold / charts` 等纯函数模块可在 node 下直接单测 |

宿主端 `lib/index.js` 是无逻辑的空插件，仅让 cordis loader 能解析本包。

## 开发

```
pnpm install
pnpm build   # esbuild → lib/client.js
pnpm check   # node --check 两个产物
pnpm test    # node --test 纯函数单测（94 例）
```

## 文件

```
package.json          插件清单（dsh.bundle.patch + dsh.client 声明）
cordis.patch.yml      loader 插入条目
build.mjs             esbuild 构建脚本（src/ → lib/client.js）
lib/index.js          宿主端入口（空插件）
lib/client.js         客户端 bundle（factory 形式，随源码入库）
src/                  客户端源码（client.jsx + pricing/ledger/stats 等纯函数模块）
test/                 纯函数单测（node --test）
docs/                 开发者向内部实现档案（zh / en）
```

更多实现细节（注册点速查、页面锚点与样式钩子、联调风险清单）见 [内部实现档案](docs/zh/internals.md)（[English](docs/en/internals.md)）。

## License

[MIT](LICENSE)
