# dsh-v-token-insight 内部实现档案（Internals）

> 面向插件开发者的实现档案：注册点与数据面速查、页面锚点与样式钩子、版本范围清单、联调风险清单。用户向功能介绍见根目录 [README](../../README.md)（[English](../../README.en.md)）。

## 数据与注册点速查

| 需求 | 缝隙 / 数据源 | 位置 |
|---|---|---|
| 第三页签 | `conversation.view` 列表槽（chat=0 / trajectory=10 / 本插件=20） | ui-conversation / ui-trajectory 先例 |
| 尾部轻量显示 | `conversation.chat.assistant-actions` 列表槽（owner `{messageId}`；复制→反馈(10)→本插件(20)→分支→timeEnd） | TurnTailNodeView 的 MessageIconActions |
| 侧栏座位 | `sidebar.footer.action` 列表槽（root 作用域，owner `{wide}`；order 20 落 cordis 座位后、紧邻设置上方相邻行） | ui-sidebar SidebarRoot / ui-cordis 座位先例 |
| 总览整页帧 | `shell.overlay` 框架浮层（root 作用域，DOM 序即层序：总览页 40 < 编辑器 50） | ui-layout AppFrame |
| 总览几何跟踪 | `closest("[data-shell-overlay]")` 属性锚定 → AppFrame frame → 侧栏列（dsh-012：`[data-slot="sidebar"]` 出口已移除，属性锚定对 display:contents 包装层免疫）`getBoundingClientRect` + ResizeObserver；`[data-sidebar-collapsed]` 折叠判据 | ui-renderer SlotOutlet / ui-layout AppFrame |
| 全会话 KPI（页签） | `useProjection("tokenUsage" / "sessionStats" / "contextPressure" / "contextBreakdown")` | dsh-token-meter / dsh-session-stats |
| 总览 Tier 0（列表行） | `useSessions`（root 标准 props）快照 `byId` 行：`projectionValues / cwd / parentId / origin / running / blank / updatedAt` + `useWorkspaces` 快照 `archivedSessionIds` | runtime refreshList / projectList / WorkspaceManager |
| 总览 Tier 1（账本） | `localStorage: dsh-v-token-insight.ledger.v2.index` + 每会话分片（`dsh-v-token-insight.ledger.v2.s.<sid>`，紧凑编码 + 5MB 总量预算）；页签/chip 沉淀 + `ctx.remote` 的 `session.follow` 开帧 + `session.page` 翻页离线折算（页间让出 + RTT 退避） | 本插件 ledger.mjs / pacing.mjs / dsh-012 `ctx.remote` |
| 每轮明细 | `useChat`（dsh-012 快照拆分）：`usage / timing / interrupted / step / messageId` | 客户端窗口（50 条/页） |
| 每步模型/调用参数 | `useTrajectory`（dsh-012 视图迁移）的 `requests[]` 按 `(turn, step)` join（`message.source` 在 legacy 节点被省略） | ui-trajectory TrajectorySnapshotBuilder |
| 模型目录（编辑器） | `ctx.remote.session.modelCatalog()` + 本地 `subagentAddress` 前置判定；子会话拒绝 → 手输 | dsh-012 `ctx.remote` typert 面 |
| 加载更早 | 快照 `hasMore / loadingOlder` + `ctx.get("sessions").binding(id).session.loadOlder()` | SessionFace（条目 inject 提供） |
| 跳回对应轮 | 页签栏首个 tab（order 0 = chat）DOM 点击 + `chat.locations.getTurn(turn)` 首键 → `[data-chat-anchor-key]` 滚动 | ui-conversation ChatView |
| 钻取（总览→会话） | `ctx.get("sessions").open(id)` / `subagentAddress(id)`+`openSubagent(address)` → 页签栏「Token」tab DOM 点击 | SessionRuntime.select / selectSubagent |
| 价格入口 / 编辑器 | 总览页「价格表」页签（`settings.general.item` 已移除）+ `shell.overlay` 框架浮层（root 作用域） | ui-layout AppFrame |

## 页面锚点与样式钩子（供美化提案定位）

四个界面都带稳定 `data-plugin-anchor` 锚点；既有 `tsn-*` 类名同样是稳定钩子——美化提案按锚点圈定作用域、按类名定位内部结构，不破坏任何行为契约：

| 界面 | 锚点（`[data-plugin-anchor=…]`） | 根节点 | 主要内部结构（稳定类名） |
|---|---|---|---|
| 侧栏座位「Token统计」 | `token-insight:seat` | `.tsn-seat-row`（展开态）/ `.tsn-seat-rail`（56px 导轨） | `.tsn-seat-label`；当前 chrome 逐值镜像官方设置座位 |
| 会话Token统计页（单会话页签） | `token-insight:session-view` | `.tsn-root` > `.tsn-inner` | `.tsn-head`（标题行 + `.tsn-pill` 覆盖度胶囊[N/M 轮 + 微型进度]）、`.tsn-kpis`（计费主卡）+ `.tsn-kpis--compact`（TTFT/速度/费用次级指标条）、`.tsn-card`（上下文卡，`data-level="warn/error"` 压力分档）、`.tsn-charts`（`.tsn-span2` 每轮堆叠跨双列）、`.tsn-table`（明细表：表头 `.tsn-sort` 可点排序、`.tsn-num` 数值右对齐 + `.tsn-databar` token 色条、`.tsn-model` 模型徽标、费用 `.tsn-money` 金色）、`.tsn-step-row`（展开逐步明细）、`.tsn-load`、`.tsn-empty`（虚线空态） |
| Token统计总览页（跨会话整页） | `token-insight:overview` | `.tsn-dash-frame` | `.tsn-dash-head`（标题栏）、`.tsn-dash-kpis`（KPI 行；命中率/会话卡附 `.tsn-kpi-meter` 比例填充条、费用卡金色）、`.tsn-dash-tabs`（维度页签，active brand 下划线）、`.tsn-dash-grid`（6 列图表卡网格）> `Card(.tsn-card)`/`ChartCard`（`.tsn-dash-grid-span` 跨全宽）、`.tsn-info-bar`（双口径信息条）、`.tsn-seg`（筛选分段控件）+ `.tsn-searchbox`（搜索图标）、`.tsn-table`（`.tsn-table-scroll` 内部滚动区 + sticky 表头、`.tsn-sort` 表头点击排序、斑马纹、`.tsn-indent` 子会话缩进导线、`.tsn-drill` 行 hover 钻取箭头、`.tsn-databar` token 色条）、`.tsn-hbars`、`.tsn-degraded-note`（warn 警示条） |
| 价目表编辑弹窗 | `token-insight:price-editor` | `.tsn-modal-root` > `.tsn-modal` | `.tsn-modal-head/.tsn-modal-body/.tsn-modal-foot`、`.tsn-entry-list/.tsn-form-grid/.tsn-tier-row` |

图表侧补充钩子（两页共用）：`.tsn-anno`（费用折线末点累计标注）、SVG defs `id="tsn-grad-cost"`（费用渐隐面积渐变，确定性命名）；堆叠条 `rx=2` 圆角 + 段间 1px 留隙、网格线虚线（Y 轴整刻度）、`:has` 悬停联动（不支持时降级单条 hover）。

命名约定：**座位与总览页 = 跨会话全局面「Token统计」；会话内页签 = 单会话面「会话Token统计」**——两套页面的美化可分别按锚点作用域，互不串扰。

## 版本范围清单

### v0.3

- [x] 共享设计语言（两页统一）：三层信息分级字阶（KPI 20/600 大数字 → 图表 → 表格 12/20）、卡片层色 `bg-layer-1` + 描边 `border-l2→l3` hover、150–200ms 安静动效 + brand 焦点环、`prefers-reduced-motion` 全覆盖、图标一律 SVG（文本字形 ✕/▸▾ 清零）
- [x] 会话Token统计页：KPI 主次分级（计费四卡大数字 + `tsn-kpis--compact` 次级指标条）、覆盖度胶囊（N/M 轮 + 微型进度，仅窗口口径如实呈现）、上下文占用压力分档着色（70%/90%，着色仅百分比文本与占用条描边）、图表区 1+2 重排、明细表行距/右对齐/模型徽标/展开态层色底 + brand 标线 + 箭头旋转、虚线空态卡
- [x] Token统计总览页：命中率/会话计数 KPI 附比例填充条（`tsn-kpi-meter`，段宽=占比，aria-hidden）、图表网格 6 列重排（趋势/费用跨全宽，卡片缺席不留空洞）、页签 active brand 下划线、按会话表筛选分段控件 + 明细表内部滚动区（sticky 表头）+ 子会话缩进导线 + 行 hover 钻取箭头 + 圆点状态徽标、双口径脚注合并为信息条、警示条 warn tint 样式统一
- [x] 图表视觉规范：网格线虚线、堆叠条 rx=2 圆角 + 段间 1px 留隙 + `:has` 悬停联动（渐进增强）、费用折线渐变面积（`tsn-grad-cost`）+ 末点累计标注、轮次刻度稀疏化（每 ⌈n/8⌉ 取一）、Y 轴整刻度（`niceScale`：1/2/5×10^k 步进、yMax 取整到步进倍数，整百/整千）
- [x] 实施反馈修订（用户走查 7 项）：数据表双色斑马纹（interactive hover/active 分档）；总览默认页签 = 总览；token 数值列占比色条（`.tsn-databar`，桶语义色/brand）+ 数字加粗；按会话表与会话页明细表表头点击排序（`.tsn-sort` + aria-sort，缺席值恒排末尾）；KPI 迷你环/圆点改为比例填充条；金额金色加粗（浅 amber-600 / 深 amber-400）+ token 加粗
- [x] 缺陷修复：上下文构成条「工具」段硬编码紫 → `--dsw-static-deepseek-400`（主题核实无紫系令牌，design D7/D8）；补 `.tsn-dash-grid-span` 缺失规则；条元填色迁移为 style 应用 var 令牌；阴影回退 rgba 移除（硬编码色清零）
- [x] 11px 脚注浅色主题对比度（tertiary ≈3.7:1 < 4.5:1）→ 口径脚注/含数副注升 secondary；单测全绿（基线不回退 + charts 新增 9 例）

### v0.2

- [x] 插件骨架、注册点、投影/窗口数据读取、逐步计费纯函数（含币种守卫）
- [x] KPI 卡（含 TTFT 均值 / tokens·s）+ 上下文占用卡（ContextMeter 视觉语言）
- [x] 每轮明细 + 展开逐步调用明细（模型/路由、四桶、耗时/首字、调用参数、无 usage 标注）
- [x] loadOlder 接线（触底 + 手动）与窗口覆盖提示
- [x] 明细行点击跳回对话页对应轮
- [x] 价目表编辑弹窗（条目/档位/时段/折扣、localStorage 持久化、JSON 导入导出、实时预览）
- [x] 图表：四桶堆叠条 / 模型横条 / 累计费用折线（每图配表格替代，颜色全走官方令牌）
- [x] pricing / stats-fold / price-store / rows-aggregate / ledger 单测（`pnpm test`）
- [x] 模型信息 join（trajectory requests → 每步 provider/model/requestConfig）+ 编辑器模型目录下拉（当前会话模型一键填入，子会话回退手输）
- [x] 侧栏座位「Token统计」（`sidebar.footer.action`，wide 双形态）+ 总览整页帧（`shell.overlay`，侧栏避让 + ResizeObserver 跟踪 + 降级全覆盖）
- [x] 全会话 KPI（Tier 0 列表行投影聚合：归档计入 / blank 排除 / 投影缺席降级）与维度页签（总览 / 按工作区 / 按会话 / 按时间 / 按模型 / 价格表）
- [x] 归档可见性（徽标 + 筛选 + 数据面缺失明示）与明细行钻取（sessions.open → 自动切 Token 统计页签，失败页内展开降级）
- [x] 本地逐步账本（幂等沉淀 / session.history 深度补全[预算 + 覆盖区间] / 折扣窗口命中老化分桶 / 孤儿 GC / 损坏回退 / 配额兜底 / 手动清除）
- [x] 共享统计卡片套件 `stats-ui.jsx`（Card / KpiCard / ChartCard / StatBadge / 口径脚注），总览页与会话页签共用
- [x] 价格表入口迁入总览页（`settings.general.item` 注册移除，inject 基线 `+ui-sidebar / −ui-settings(-general)`）

## 联调风险清单（实机验证状态）

1. **turnTail chain / 页签条目的标准 props——框架层已核实**：`standardProps()`（dsh-client-ui-renderer client.js L533-567）对所有 session 作用域条目统一组装 useSession/useProjection/t，chain 条目经 SlotOutlet（L314-318）走同一路径。✅ 已核实；**实机待验**：addressed 子会话页签的投影键携带（若缺席，KPI 显示「—」，属能力缺席降级，不报错）。
   - **chain 条目必须声明 `select`（实机联调发现，已核实）**：chain 槽选举对每条目调用 `entry.select(ownerProps)`（ui-renderer client.js L806-811），未声明时调用抛 TypeError → 按「弃权」处理并刷 console.error，条目永远不渲染。
   - **chain 选举是首个非 null 胜出（框架语义）**：官方 `dsh-client-ui-deliverables` 的 turnTail 条目（产出文件）与本插件 chip 在同一 chain 上单选举互斥。**处置：chip 已迁出 turnTail**，改注册 `conversation.chat.assistant-actions` 列表槽（官方功能行内部：复制 → 反馈(10) → 本 chip(20) → 分支 → timeEnd；list 槽全条目并存渲染，无选举竞争）。assistant-actions 仅在轮尾行渲染（user 消息无 extraActions、assistant 步骤节点无 toolbar，已核实无重复）；唯一边界：无收束文本消息的轮（closing === null，如纯工具轮）该行不渲染，chip 缺席——此类轮 usage 存在但无消息工具栏。
2. **PriceSettingsRow 行契约——随入口迁移重设计（实机反馈驱动）**：原 `settings.general.item` 的官方行契约（border-bottom + title/desc 文本块 + 右侧控件）只在设置页语境有意义；入口迁入总览页「价格表」页签后，卡片标题由共享 Card 承担，行内不再重复标题、不再保留一次性迁移说明，**编辑按钮置于行首左侧**（实机反馈「右侧不直观」）。
3. **locale 插值——已核实**：`translate()` 用 `{name}` 占位符正则替换（dsh-client-locale client.js L1156），`stats.window` 等含参文案与官方语法一致。✅ 无需替换实现。
4. **useProjection 可用性——降级已实现**：tokenUsage 等键由宿主插件注册；个别会话（如 addressed 子会话）未随 baseline 携带时读值为 `undefined`，视图按「能力缺席」显示「—」。**实机待验**（风险 1 同一轮验证）。
5. **子会话——探索阶段已核实**：子会话是独立会话，本插件的页签与 chip 会随同一会话页壳自动出现并只统计该子会话自身的消耗（`openSubagent` 走同一 `Session` 渲染路径）。**实机待验**。
6. **压缩检查点的轮标题——已核实并加固**：检查点 user 消息在会话视图中落为 `CompactionSummaryNode`（kind:"compaction"，"instruction envelope … never renders"），天然不会成为 `user` 节点；`foldTurns` 另显式跳过 compaction/context 节点并有单测兜底。✅
7. **币种规则（已入规格）**：v0 显示币种 = 价目表首个条目的币种；命中条目币种不符的步按「未定价（币种不符）」处理，绝不跨币种求和、不自动换汇。时段折扣优先用请求开始时刻（`timing.stepStartTime`），缺失回退落盘时刻。✅ 单测覆盖。
8. **投影字段名差异（实现期发现，已修复）**：投影 `tokenUsage` 的未命中输入字段是 `uncachedInputTokens`（官方 `billedInputTokens` 口径），与窗口节点 usage 的 `inputTokens` 不同名；`stats-fold.billedInputTokens` 已做双形状兼容并有单测。
9. **模型信息在 legacy 节点缺席（实现期发现，已用 join 解决；0.2.x 契约迁移后启用载体回退链）**：`assistant/message` 事件的 `message.source {provider, model}` 是必填 wire 字段，但 ui-conversation 构造 legacy `AssistantMessageNode` 时未拷贝模型身份字段（类型声明了、赋值零处）——直接读节点全是「—」。解法：`views.get("trajectory").requests[]` 按 `(turn, step)` join 补全身份与调用参数。**dsh 0.2.1-rc.5 契约迁移**：`AssistantRequestView.provenance` 已移除，模型身份改由 `providerMetadata`（完成请求的最终身份，仅在有 durable assistant 节点时附加）与 `requestConfig`（`request/header` 落盘的计划配置，在途/重试中也可用）承载。请求级解析链按 `provenance`（0.1.x 兼容）→ `providerMetadata`（计价语义优先，等价旧契约的 `message.source` 来源）→ `requestConfig`（尽早出模型）回退，并**按载体原子解析**：载体有效性以其中 `model` 为非空字符串为准，`model` 无效（空串/非字符串）的载体整体视为缺席并继续回退、MUST NOT 跨载体拼配 `provider`/`model`（`matchPriceEntry` 的 provider 参与路由匹配，混拼会构造宿主从未真实组合过的路由配对 → 错价）；`model` 有效而 `provider` 无效时取 `(model, null)`（等效匹配任意路由条目），不为凑齐 provider 而降级到后续载体的计划模型。节点侧同步接住 0.2.x 的 `providerMetadata`（`node.providerMetadata` 优先于 `node.provenance`，fill-only-missing），防止宿主未来填充后节点最终身份被请求级计划配置倒挂（0.1.x 行为不变）。只补缺、重试 last-wins、无命中返回原引用（单测覆盖新旧两种契约形状）。边界：join 依赖轨迹视图快照与已加载窗口；全部载体缺席的旧会话段模型保持 `null` → 按「未定价」如实披露（不猜价），迁移期沉淀的空模型账本行由同键幂等 upsert 在后续沉淀时回填。
10. **跳回对话页的实现方式（v0 取舍）**：视图环状态存在 ui-conversation 私有的 per-session chatStore（句柄不导出），插件侧无官方 setView 面；v0 用页签栏首个 tab 的 DOM 点击（order 0 恒为 chat）+ `chat.locations.getTurn()` 键定位滚动。**实机待验**：切换与滚动表现（含旧轮未加载时仅切页不滚动的降级）。
11. **编辑器弹窗宿主（v0 取舍）**：弹窗注册于 `shell.overlay` 框架浮层（root 作用域，层容器 pointer-events:none、子元素 auto，z-index 20）；实时预览经 sessions 服务对当前会话窗口采样。**实机待验**：与设置面板的层叠表现。
12. **价目表人工维护随官方调价漂移**：语义上以「折算值仅供参考」声明；不追求账单级精度。
13. **chip 全窗口折叠的重复计算**：每个 chip 渲染对窗口做一次 `foldTurns`（现另加一次 requests join）；v0 数据量可接受，长会话优化方向为 `chat.locations.getTurn(turn)` 索引。
14. **宿主 `session.list` 是否返回归档会话（实机待验）**：客户端侧不过滤已核实；宿主行为待验。若宿主过滤，总览明示「归档会话不含于当前数据面」（`archivedMissingFromList` 守卫已实现）——这直接关系归档可见性卖点。
15. **归档会话 `sessions.open` 可用性（实机待验）**：`select()` 对不在 summaries 的 id 抛错（已核实），try/catch 捕获后降级页内展开账本明细；主路径成败待实机确认。
16. **座位双形态与排位（实机已验）**：`sidebar.footer.action` owner 仅传 `{wide}`（契约已核）；实机反馈「按钮线框突兀」——根因是座位按钮缺 `border:none`（浏览器默认按钮边框）。**处置：座位按钮 chrome 已逐值镜像官方「设置」座位触发器**（ui-settings-general `SettingsRoot.module.css` 的 `.trigger`/`.rail`：radius 12、高 42、`margin:4px -2px; padding:0 10px 0 8px`；rail 36×36 圆形、图标 16/18px、hover `interactive-bg-hover`），wrapper `display:contents` 直接参与 shell 的 footerActions 排版。
17. **data-slot 测量 spike（实机待验）**：SlotOutlet 锚点为 `display:contents`（无盒），插件测量其父列（`sidebarCol`，真实盒子）右缘——比设计预设的「测出口」更稳；拖拽动画期间 RO 跟帧、折叠/导轨三形态待实机走查；降级 `inset:0` 已备。
18. **overlay 层内 z 序共存（实机已验并修复）**：实机发现总览页右侧被另一 V 系列插件的 dock（`.jyx-dock{position:fixed; z-index:900}`，预览窗 950）盖住——层内子条目自控几何，显式 z-index 者胜。**处置：总览页帧 `z-index:1000`（> dock 900/预览 950，仍低于该插件的交互浮层 menu 10000/refPop 10002，弹层不被吞）**；价目表编辑器 `.tsn-modal-root` 相应升至 `z-index:1100` 保持总览页之上；官方设置面板为 root 语境 `z-index:1000` fixed 层（不在 overlay layer 的 z=20 语境之内），恒在总览页之上，层级关系正确。
19. **列表行投影陈旧度（实机观察）**：投影 seq 只存在 ProjectionValueStore 内部行（`values()` 不含 asOfSeq），列表行拿不到逐键水位——UI 以「以上次计算为准」兜底文案声明，不做客户端重算。
20. **账本老化的 L2 分档退化（实现期取舍）**：原始条目保留固化窗口内逐步精确（v0.4.0 起 2 天，见第 23 条预算编排）；老化桶按 defaultTier + 折扣窗口命中计费（L3 保留、L2 不可恢复）——桶在会话明细与图中均带「老化桶」标注，费用语义如实在册。
21. **深度补全的 RPC 量**：按会话 opt-in、单会话 20 页 × 200 消息预算；「补全全部」不做（v0.4.0 起深补通道改 `ctx.remote` follow+page，见第 25/26 条；运行中会话不参与）。
22. **分支会话祖先消耗的重复计入（已实测确认并修复，`usage-integrity` 规格）**：宿主 `sessions.fork` 以 `seed: events.slice(0, cut)` 把父会话全部事件（含 usage）复制进子会话日志、token-meter 不感知种子边界——实测三个会话 usage 完全一致、按 3 份重复计数。修复：fork 会话（有 `parentId` 且非 subagent）**会话级整排**——投影与账本条目不进 KPI/工作区/按模型/趋势/费用线任一合计（种子段与新增段条目级不可切分，整排为既定取舍，fork 后新增消耗仅在其明细行可见）；行保留 +「分支」徽标 + 信息条披露排除数（`dash.fork.excluded`）。
23. **账本 v2 分片存储与总量预算**：索引键 + 每会话分片 + 紧凑编码（条目体积 ≈ −62%）；持久化五步编排：常规固化（2 天窗口）+ 孤儿 GC → 水位估算（5MB 字符口径 + 分片尺寸缓存）→ 会话粒度收紧重试 → 全固化档重估 → 按 `lastSeen` 整会话逐出至预算 − 256KB headroom；全败落内存模式。`lastSeen = 0`（新近性未知）不参与孤儿 GC（防元数据缺失被放大为整本清除）。
24. **账面计价（落盘费用）**：持久化时把单遍计价产物快照进分片（`{v, ev, fp, cur, cost, mc, bm, dc, um}`，PRICING_ENGINE_VERSION 版本戳 + FNV-1a 价目指纹）；费用展示走三级解析序（账面价 → 会话级定点重算 → 全账本重导出），价目编辑不改写历史；定价快照计入尺寸缓存与总量预算。
25. **dsh-012 宿主迁移三落点**：① 快照拆分——`legacy.nodes`/`locations`/`turnTimings`/trajectory 改读 `useChat`/`useTrajectory` 标准钩子；② `connection.api` 消失——深补改 `ctx.remote.session.follow`（开帧取 cursor）+ `page`（按 seq 翻页，20 页 × 200 消息预算，`binding.loadOlder` 被 openState 门控故弃用）、模型目录改 `remote.session.modelCatalog()`、预览采样走 `eventSource` 离线折算；③ `data-slot="sidebar"` 移除——几何锚改 `closest("[data-shell-overlay]")` 属性锚定。`dsh.client.inject` 基线清空，宿主按需自举。
26. **深补节奏治理（pacing.mjs）**：页间让出（常规 40ms，RTT EWMA >1500ms 升档 ×2 至 1500ms 封顶、<750ms 半步回落、临界维持）——针对「重建/自动深补 × 子会话风暴」两次宿主 OOM 的插件侧止血；运行中会话不参与深补（移动靶）。
