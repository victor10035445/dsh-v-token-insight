/**
 * dsh-token-insight — 客户端源码（由 build.mjs 用 esbuild 打包成
 * factory 形式的 lib/client.js；react/@deepseek-ai/* 全部 external）。
 *
 * 注册点（探索阶段已核到代码级，均为现成缝隙、零内核改动）：
 *  1. conversation.view —— 第三页签「Token 统计」
 *     （仿 ui-trajectory 的注册形态：{name, id, order, locale, label} + 组件；
 *      chat=0 / trajectory=10 / 本插件=20；条目级 inject 提供 loadOlder）。
 *  2. conversation.chat.assistant-actions —— 回复结尾功能行内的轻量 token 显示
 *     （list 槽，渲染于 复制/反馈 之后、分支/timeEnd 之前；list 全条目并存，
 *     不参与 turnTail chain 的单选举，避开与「产出文件」条目的位置竞争；
 *     常态显示 耗时·费用·token，完整计价依据悬停查看）。
 *  3. sidebar.footer.action —— 侧栏底部动作座位「Token统计」（list 槽、root
 *     作用域，order 20 落 cordis 座位之后、紧邻设置座位上方相邻行；wide 双形态
 *     图标按钮；ui-cordis 面板座位同款先例）。点击开关 Token统计总览页。
 *  4. shell.overlay × 2 —— 框架级浮层 list 槽（root 作用域，层容器
 *     pointer-events:none、直接子元素 auto）：
 *     · Token统计总览整页帧（order 40）：覆盖会话列与右栏、避让侧栏
 *       （[data-slot="sidebar"] 出口父列测量 + ResizeObserver 跟踪，降级
 *       inset:0 全覆盖 + 页内提示）；打开/关闭零选择状态副作用；ESC 分层。
 *     · 价目表编辑弹窗（order 50）：总览页「价格表」页签与会话页签共用。
 *
 * 数据面（杂交方案）：
 *  - 会话页签/chip：useProjection（tokenUsage/sessionStats/…，宿主唯一计算点）
 *    + useSession 窗口节点 → stats-fold.mjs 折叠 + loadOlder 逼近全量；
 *  - 总览页 Tier 0：useSessions 列表行投影（projectionValues.tokenUsage，全会话
 *    权威、含归档、投影推送实时刷新）+ useWorkspaces（archivedSessionIds）→
 *    rows-aggregate.mjs 聚合；
 *  - 总览页 Tier 1：ledger.mjs 本地逐步账本（页签/chip 沉淀 + 按会话 opt-in 的
 *    session.history 深度补全），费用只在账本覆盖段按逐步语义计费（不猜价）；
 *  - 跳回对话页：对话页签是会话视图环的 order 0 条目——点击页签栏首个
 *    tab（DOM 级，零内核改动）；滚动定位用 chat.locations.getTurn(turn)
 *    的首键 → 聊天流 [data-chat-anchor-key] 行。
 */
import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
// 纯函数模块：计价 / 折叠 / 持久化 / 图表布局（node 下可直接单测）。
import {
  BUCKETS,
  DEFAULT_PRICE_TABLE,
  displayCurrencyOf,
  formatMoney,
  priceTurnRows,
  validatePriceTable
} from "./pricing.mjs";
import {
  billedInputTokens,
  cacheHitPercent,
  foldHistoryEvents,
  foldTurns,
  formatTokens,
  joinRequestInsights
} from "./stats-fold.mjs";
import {
  LEDGER_STORE_KEY,
  aggregateLedgerViews,
  clearAllLedger,
  clearSessionLedger,
  isPartialCoverage,
  emptyLedger,
  loadLedger,
  persistLedger,
  priceDailyCost,
  recordDeepCoverage,
  upsertSessionEntries
} from "./ledger.mjs";
import {
  aggregateByTime,
  aggregateKpi,
  aggregateSessions,
  aggregateWorkspaces,
  archivedMissingFromList,
  expandRows,
  groupCostByGranularity,
  totalTokens as totalTokensBuckets
} from "./rows-aggregate.mjs";
import {
  PRICES_CHANGED_EVENT,
  PRICES_EDIT_EVENT,
  loadPriceTable,
  savePriceTable
} from "./price-store.mjs";
import { BUCKET_SEGMENTS, contextBreakdownLayout, formatAxisTokens, hBarsLayout, lineLayout, stackedBarsLayout } from "./charts.mjs";
import { Card, ChartCard, Footnote, KpiCard, StatBadge } from "./stats-ui.jsx";

const PLUGIN_ID = "dsh-token-insight";
const NS = "token-insight";

/* ------------------------------------------------------------------ *
 * 文案
 * ------------------------------------------------------------------ */

const zh = {
  "view.tokenStats": "会话Token统计",
  "stats.title": "会话Token统计",
  "stats.kpi.total": "计费 Token（全会话）",
  "stats.kpi.billedIn": "计费输入（全会话）",
  "stats.kpi.out": "输出（全会话）",
  "stats.kpi.cacheHit": "缓存命中（全会话）",
  "stats.kpi.ttft": "首字延迟均值（全会话）",
  "stats.kpi.speed": "生成速度（全会话）",
  "stats.kpi.cost": "折算费用（已加载窗口）",
  "stats.window": "明细覆盖已加载窗口：{loaded} 轮 / 全会话 {total} 轮，可用「加载更早」逼近全量。",
  "stats.windowFull": "明细已覆盖全会话：{loaded} 轮。",
  "stats.coverage.window": "{loaded}/{total} 轮",
  "stats.coverage.windowOnly": "仅窗口 {loaded} 轮",
  "stats.col.turn": "轮",
  "stats.col.time": "时间",
  "stats.col.title": "对话标题",
  "stats.col.model": "模型",
  "stats.col.in": "输入",
  "stats.col.out": "输出",
  "stats.col.cache": "缓存%",
  "stats.col.cost": "费用",
  "stats.noprice": "未定价",
  "stats.empty": "本会话暂无 token 消耗明细。",
  "stats.disclaimer": "费用按当前价目表即时折算，仅供参考；价目表修改后历史轮随之重算。",
  "stats.jumpHint": "点击行跳回对话页该轮",
  "stats.loadOlder": "加载更早",
  "stats.loadingOlder": "加载中…",
  "stats.context.title": "上下文占用（参考）",
  "stats.context.figures": "下次请求约 {used} / 窗口 {window}（{percent}%）",
  "stats.context.note": "官方投影为启发式参考值，非原子观察；构成条为组成近似，不与占用值求和一致。",
  "stats.context.system": "系统",
  "stats.context.tools": "工具",
  "stats.context.messages": "会话",
  "stats.chart.tokensTitle": "每轮 token 构成（已加载窗口）",
  "stats.chart.modelsTitle": "模型分布（按 token，已加载窗口）",
  "stats.chart.costTitle": "累计费用（按已定价轮）",
  "stats.chart.tableAlt": "表格替代",
  "stats.chart.unpricedSkipped": "未定价轮未计入折线：{count} 轮。",
  "stats.step.noUsage": "无 usage（中断/失败）",
  "stats.step.config": "调用参数",
  "stats.step.timing": "首字 {ttft} · 解码 {decode}",
  "stats.step.tierDefault": "默认档",
  "stats.step.tierCtx": "上下文 ≥{tokens}",
  "stats.step.tierCumulative": "累计 ≥{tokens}",
  "chip.label": "本轮 token",
  "chip.models": "模型",
  "settings.title": "Token 价格表",
  "settings.note": "{count} 个价格条目 · 显示币种 {currency}",
  "settings.edit": "编辑价目表",
  "editor.title": "Token 价目表",
  "editor.entries": "价格条目",
  "editor.entry.model": "模型 / 通配（如 deepseek-*）",
  "editor.catalog.current": "当前会话模型：{provider} / {model}",
  "editor.catalog.apply": "填入条目",
  "editor.catalog.unavailable": "子会话或目录不可用，请手动输入模型名。",
  "editor.entry.provider": "provider（留空 = 任意路由）",
  "editor.entry.currency": "币种",
  "editor.buckets": "四桶单价（每百万 token）",
  "editor.defaultTier": "默认档单价",
  "editor.tiers": "分档 tiers（阈值升序，取最后一个满足全部已声明阈值者）",
  "editor.tier.add": "添加档位",
  "editor.tier.ctx": "minContextTokens",
  "editor.tier.cumulative": "minCumulativeTokens",
  "editor.timeWindows": "时段折扣（HH:mm，支持跨午夜；from 含、to 不含）",
  "editor.timeWindow.add": "添加时段",
  "editor.discount": "条目折扣",
  "editor.addEntry": "添加条目",
  "editor.remove": "删除",
  "editor.importExport": "导入 / 导出（JSON）",
  "editor.export": "导出到文本框",
  "editor.import": "从文本框导入",
  "editor.reset": "恢复默认",
  "editor.invalid": "JSON 无效或结构不符，未导入。",
  "editor.save": "保存",
  "editor.cancel": "取消",
  "editor.preview": "实时预览（当前会话样例 · 保存后全局生效）",
  "editor.previewEmpty": "当前会话无已加载样例步。",
  "editor.entry": "条目 {index}",
  "editor.bucket.input": "未命中输入",
  "editor.bucket.cacheRead": "缓存读",
  "editor.bucket.cacheWrite": "缓存写",
  "editor.bucket.output": "输出",

  "dash.title": "Token统计总览",
  "dash.seat": "Token统计",
  "dash.seat.aria": "打开 Token 统计总览",
  "dash.close": "关闭总览",
  "dash.degraded": "侧栏几何测量不可用：已退化为全帧覆盖（临时降级，恢复后自动回到侧栏避让形态）。",
  "dash.tab.overview": "总览",
  "dash.tab.workspaces": "按工作区",
  "dash.tab.sessions": "按会话",
  "dash.tab.time": "按时间",
  "dash.tab.models": "按模型",
  "dash.tab.pricing": "价格表",
  "dash.kpi.total": "计费 Token（全会话）",
  "dash.kpi.billedIn": "计费输入（全会话）",
  "dash.kpi.out": "输出（全会话）",
  "dash.kpi.cacheHit": "缓存命中（全会话）",
  "dash.kpi.sessions": "会话计数",
  "dash.kpi.sessionsSub": "总数 {total} · 归档 {archived} · 运行中 {running}（空会话不计）",
  "dash.kpi.cost": "费用（账本覆盖段）",
  "dash.kpi.costSub": "逐步计费合计 · {covered}/{count} 会话已覆盖",
  "dash.tier0.note": "Tier 0：合计来自会话列表行投影（宿主权威值，含归档会话，实时刷新）；个别行投影缺席时按零计入，以上次计算为准。",
  "dash.tier1.note": "Tier 1：明细与费用仅覆盖本地账本覆盖段（打开过统计页签或执行过「补全」的会话），未覆盖显示「—」。费用按当前价目表即时折算，仅供参考。",
  "dash.archivedMissing": "归档会话不含于当前数据面：归档集合非空，但会话列表未携带归档行。",
  "dash.chart.trend": "消耗趋势（按日，四桶堆叠）",
  "dash.chart.trendSub": "账本覆盖段按步发生时刻 · 其余按会话最近活动",
  "dash.chart.models": "模型分布（按 token）",
  "dash.chart.modelsSub": "仅账本覆盖段有模型归属 · 未覆盖计入「未分类」",
  "dash.chart.projects": "项目占比（按 token）",
  "dash.chart.projectsSub": "cwd 归组 · 子会话缺失 cwd 回退父会话",
  "dash.chart.activity": "活跃 / 归档构成",
  "dash.chart.activitySub": "按会话数（空会话不计）",
  "dash.chart.dailyCost": "费用趋势（账本覆盖段）",
  "dash.chart.dailyCostSub": "按步发生时刻 · 逐步计费",
  "dash.model.unclassified": "未分类",
  "dash.workspace.unknown": "未知",
  "dash.col.workspace": "项目",
  "dash.col.sessions": "会话数",
  "dash.col.running": "运行中",
  "dash.col.total": "计费 Token",
  "dash.col.status": "状态",
  "dash.col.activity": "最近活动",
  "dash.col.hit": "命中率",
  "dash.filter.all": "全部",
  "dash.filter.active": "活跃",
  "dash.filter.archived": "归档",
  "dash.search": "搜索标题 / 项目…",
  "dash.sort.recent": "最近活动",
  "dash.sort.tokens": "计费 Token",
  "dash.badge.running": "运行中",
  "dash.badge.archived": "归档",
  "dash.badge.subagent": "子会话",
  "dash.badge.completed": "已完成",
  "dash.empty": "暂无会话数据。",
  "dash.date.older": "更早",
  "dash.time.caliber": "双口径：账本覆盖段按步发生时刻分桶；未覆盖会话按最近活动（updatedAt）整桶计入，以「按最近活动」徽标区分。颗粒度窗口：按日近 30 天、按月近 12 个月、按年不限，超出窗口的消耗归入「更早」。",
  "dash.time.byRecent": "按最近活动",
  "dash.time.granularity": "统计颗粒度",
  "dash.time.g.day": "按日",
  "dash.time.g.month": "按月",
  "dash.time.g.year": "按年",
  "dash.time.trendTitle.day": "消耗趋势（按日，四桶堆叠）",
  "dash.time.trendTitle.month": "消耗趋势（按月，四桶堆叠）",
  "dash.time.trendTitle.year": "消耗趋势（按年，四桶堆叠）",
  "dash.time.costTitle.day": "费用趋势（按日）",
  "dash.time.costTitle.month": "费用趋势（按月）",
  "dash.time.costTitle.year": "费用趋势（按年）",
  "dash.models.caliber": "仅账本覆盖的消耗有模型归属；「未分类」= 会话权威总量 − 账本已覆盖量，不虚构模型归属。",
  "dash.cost.none": "—",
  "dash.cost.covered": "≈ {cost}",
  "dash.cost.partial": "部分覆盖（{note}）",
  "dash.cost.hover": "打开该会话统计页签或执行「补全」后可折算",
  "dash.row.expand": "展开账本明细",
  "dash.ledger.none": "该会话暂无账本覆盖：费用与模型归属需先打开其统计页签或执行补全。",
  "dash.ledger.clearSession": "清除此会话账本",
  "dash.ledger.cleared": "已清除。",
  "dash.deep.run": "补全此会话",
  "dash.deep.running": "补全中…（第 {page} 页）",
  "dash.deep.done": "已补全 {entries} 步。",
  "dash.deep.donePartial": "已补全 {entries} 步（达预算上限，部分覆盖）。",
  "dash.deep.failed": "补全失败：{message}",
  "dash.deep.unavailable": "深度补全会话历史不可用（会话未在数据面或 RPC 失败）。",
  "dash.drill.hint": "点击选中行 · 右键打开菜单（跳转 / 复制 ID）",
  "dash.row.menu.jump": "跳转到会话",
  "dash.row.menu.copy": "复制会话 ID",
  "dash.row.menu.copied": "已复制会话 ID：{id}",
  "dash.row.copy.failed": "复制失败：浏览器拒绝了剪贴板访问",
  "dash.colgrip.hint": "拖拽调整列宽 · 双击复位",
  "dash.drill.fallback": "打开会话失败（归档会话可能不可恢复）：已在页内展开其账本明细。",
  "dash.ledger.manage": "本地账本",
  "dash.ledger.manageNote": "逐步明细沉淀于本机 localStorage（{key}），随使用积累；仅统计四桶与模型时刻，不含会话正文。",
  "dash.ledger.clearAll": "清空全部账本",
  "dash.ledger.rebuildAll": "重建全部账本",
  "dash.ledger.rebuildAllHint": "逐会话从宿主会话历史重建本地账本（已完整覆盖的自动跳过，可中途停止）",
  "dash.ledger.rebuild.stop": "停止重建",
  "dash.ledger.rebuild.running": "重建中 {done}/{total} · 部分覆盖 {partial} · 失败 {failed}…",
  "dash.ledger.rebuild.done": "重建完成：{done} 个会话 · 部分覆盖 {partial} · 失败 {failed}。",
  "dash.ledger.rebuild.stopped": "已停止：完成 {done}/{total}。",
  "dash.ledger.rebuild.none": "无需重建：可见会话均已完整覆盖或没有可补全会话。",
  "dash.ledger.emptyHint": "账本为空：费用与模型归属需从会话历史重建——点「重建全部账本」。",
  "dash.ledger.export": "导出账本备份",
  "dash.ledger.export.done": "已导出账本备份（{sessions} 个会话）。",
  "dash.ledger.export.failed": "导出失败：浏览器拒绝了下载。",
  "dash.ledger.import": "导入账本备份",
  "dash.ledger.import.ok": "已导入账本：{sessions} 个会话，费用已按当前价目重算。",
  "dash.ledger.import.bad": "导入失败：不是有效的账本备份（需 v1 账本 JSON）。",
  "dash.ledger.persistError": "本地存储配额不足：账本本次仅保存在内存中。",
  "dash.datefmt": "{y}-{m}-{d}",
  "dash.datetimefmt": "{y}-{m}-{d} {hh}:{mm}"
};

const en = {
  "view.tokenStats": "Session Token Stats",
  "stats.title": "Session Token Stats",
  "stats.kpi.total": "Billed tokens (session)",
  "stats.kpi.billedIn": "Billed input (session)",
  "stats.kpi.out": "Output (session)",
  "stats.kpi.cacheHit": "Cache hit (session)",
  "stats.kpi.ttft": "Avg TTFT (session)",
  "stats.kpi.speed": "Throughput (session)",
  "stats.kpi.cost": "Est. cost (loaded window)",
  "stats.window": "Details cover the loaded window: {loaded} of {total} session turns; use \"Load older\" to extend.",
  "stats.windowFull": "Details cover the whole session: {loaded} turns.",
  "stats.coverage.window": "{loaded}/{total} turns",
  "stats.coverage.windowOnly": "Window only · {loaded} turns",
  "stats.col.turn": "Turn",
  "stats.col.time": "Time",
  "stats.col.title": "Conversation",
  "stats.col.model": "Model",
  "stats.col.in": "Input",
  "stats.col.out": "Output",
  "stats.col.cache": "Cache %",
  "stats.col.cost": "Cost",
  "stats.noprice": "unpriced",
  "stats.empty": "No token usage details in this session yet.",
  "stats.disclaimer": "Costs are derived on the fly from the current price table; for reference only.",
  "stats.jumpHint": "Click a row to open that turn in the chat view",
  "stats.loadOlder": "Load older",
  "stats.loadingOlder": "Loading…",
  "stats.context.title": "Context pressure (reference)",
  "stats.context.figures": "Next request ≈ {used} / window {window} ({percent}%)",
  "stats.context.note": "Host projections are heuristic references, not atomic observations; the composition bar approximates makeup and will not sum to the occupancy figure.",
  "stats.context.system": "System",
  "stats.context.tools": "Tools",
  "stats.context.messages": "Messages",
  "stats.chart.tokensTitle": "Per-turn token composition (loaded window)",
  "stats.chart.modelsTitle": "Model distribution (by tokens, loaded window)",
  "stats.chart.costTitle": "Cumulative cost (priced turns)",
  "stats.chart.tableAlt": "Table alternative",
  "stats.chart.unpricedSkipped": "{count} unpriced turn(s) are not part of the line.",
  "stats.step.noUsage": "No usage (interrupted/failed)",
  "stats.step.config": "Request config",
  "stats.step.timing": "TTFT {ttft} · decode {decode}",
  "stats.step.tierDefault": "Default tier",
  "stats.step.tierCtx": "context ≥{tokens}",
  "stats.step.tierCumulative": "cumulative ≥{tokens}",
  "chip.label": "Turn tokens",
  "chip.models": "Models",
  "settings.title": "Token price table",
  "settings.note": "{count} entries · display currency {currency}",
  "settings.edit": "Edit price table",
  "editor.title": "Token price table",
  "editor.entries": "Entries",
  "editor.entry.model": "Model / wildcard (e.g. deepseek-*)",
  "editor.catalog.current": "Current session model: {provider} / {model}",
  "editor.catalog.apply": "Apply to entry",
  "editor.catalog.unavailable": "Manual input (subagent session or catalog unavailable).",
  "editor.entry.provider": "provider (empty = any route)",
  "editor.entry.currency": "Currency",
  "editor.buckets": "Four-bucket unit prices (per million tokens)",
  "editor.defaultTier": "Default tier prices",
  "editor.tiers": "Tiers (ascending thresholds; last tier satisfying all declared thresholds wins)",
  "editor.tier.add": "Add tier",
  "editor.tier.ctx": "minContextTokens",
  "editor.tier.cumulative": "minCumulativeTokens",
  "editor.timeWindows": "Time-window discounts (HH:mm, cross-midnight OK; from inclusive, to exclusive)",
  "editor.timeWindow.add": "Add window",
  "editor.discount": "Entry discount",
  "editor.addEntry": "Add entry",
  "editor.remove": "Remove",
  "editor.importExport": "Import / export (JSON)",
  "editor.export": "Export to textbox",
  "editor.import": "Import from textbox",
  "editor.reset": "Restore defaults",
  "editor.invalid": "Invalid JSON or structure; nothing imported.",
  "editor.save": "Save",
  "editor.cancel": "Cancel",
  "editor.preview": "Live preview (current session sample · applies after save)",
  "editor.previewEmpty": "No loaded sample steps in the current session.",
  "editor.entry": "Entry {index}",
  "editor.bucket.input": "Uncached input",
  "editor.bucket.cacheRead": "Cache read",
  "editor.bucket.cacheWrite": "Cache write",
  "editor.bucket.output": "Output",

  "dash.title": "Token Stats Overview",
  "dash.seat": "Token Stats",
  "dash.seat.aria": "Open the token stats overview",
  "dash.close": "Close overview",
  "dash.degraded": "Sidebar geometry measurement unavailable: temporarily covering the full frame (degraded; returns to sidebar-aware layout once measurable).",
  "dash.tab.overview": "Overview",
  "dash.tab.workspaces": "By workspace",
  "dash.tab.sessions": "By session",
  "dash.tab.time": "By time",
  "dash.tab.models": "By model",
  "dash.tab.pricing": "Price table",
  "dash.kpi.total": "Billed tokens (all sessions)",
  "dash.kpi.billedIn": "Billed input (all sessions)",
  "dash.kpi.out": "Output (all sessions)",
  "dash.kpi.cacheHit": "Cache hit (all sessions)",
  "dash.kpi.sessions": "Sessions",
  "dash.kpi.sessionsSub": "{total} total · {archived} archived · {running} running (blank excluded)",
  "dash.kpi.cost": "Cost (ledger-covered)",
  "dash.kpi.costSub": "Per-step pricing total · {covered}/{count} sessions covered",
  "dash.tier0.note": "Tier 0: totals come from session-list row projections (host authority, archived sessions included, live refresh); rows missing projections count as zero, values are as-of last computation.",
  "dash.tier1.note": "Tier 1: details and costs cover only the local ledger (sessions whose stats tab was opened or that were deep-completed); uncovered entries show \"—\". Costs are derived on the fly from the current price table; for reference only.",
  "dash.archivedMissing": "Archived sessions are not part of the current data plane: the archive set is non-empty but the session list carries no archived rows.",
  "dash.chart.trend": "Consumption trend (daily, four-bucket stacked)",
  "dash.chart.trendSub": "Ledger-covered spans by step time · the rest by last session activity",
  "dash.chart.models": "Model distribution (by tokens)",
  "dash.chart.modelsSub": "Only ledger-covered usage carries model attribution · the rest lands in \"Unclassified\"",
  "dash.chart.projects": "Project share (by tokens)",
  "dash.chart.projectsSub": "Grouped by cwd · subagents without cwd fall back to their parent",
  "dash.chart.activity": "Active / archived composition",
  "dash.chart.activitySub": "By session count (blank excluded)",
  "dash.chart.dailyCost": "Cost trend (ledger-covered)",
  "dash.chart.dailyCostSub": "By step time · per-step pricing",
  "dash.model.unclassified": "Unclassified",
  "dash.workspace.unknown": "Unknown",
  "dash.col.workspace": "Project",
  "dash.col.sessions": "Sessions",
  "dash.col.running": "Running",
  "dash.col.total": "Billed tokens",
  "dash.col.status": "Status",
  "dash.col.activity": "Last activity",
  "dash.col.hit": "Hit rate",
  "dash.filter.all": "All",
  "dash.filter.active": "Active",
  "dash.filter.archived": "Archived",
  "dash.search": "Search title / project…",
  "dash.sort.recent": "Last activity",
  "dash.sort.tokens": "Billed tokens",
  "dash.badge.running": "Running",
  "dash.badge.archived": "Archived",
  "dash.badge.subagent": "Subagent",
  "dash.badge.completed": "Completed",
  "dash.empty": "No session data yet.",
  "dash.date.older": "Older",
  "dash.time.caliber": "Dual caliber: ledger-covered spans bucket by step time; uncovered sessions bucket whole by last activity (updatedAt), marked by the \"by last activity\" badge. Granularity windows: daily = last 30 days, monthly = last 12 calendar months, yearly = unlimited; usage beyond the window lands in \"Older\".",
  "dash.time.byRecent": "by last activity",
  "dash.time.granularity": "Granularity",
  "dash.time.g.day": "Daily",
  "dash.time.g.month": "Monthly",
  "dash.time.g.year": "Yearly",
  "dash.time.trendTitle.day": "Consumption trend (daily, four-bucket stacked)",
  "dash.time.trendTitle.month": "Consumption trend (monthly, four-bucket stacked)",
  "dash.time.trendTitle.year": "Consumption trend (yearly, four-bucket stacked)",
  "dash.time.costTitle.day": "Cost trend (daily)",
  "dash.time.costTitle.month": "Cost trend (monthly)",
  "dash.time.costTitle.year": "Cost trend (yearly)",
  "dash.models.caliber": "Only ledger-covered usage carries model attribution; \"Unclassified\" = session authority totals − ledger-covered amounts, never a fabricated attribution.",
  "dash.cost.none": "—",
  "dash.cost.covered": "≈ {cost}",
  "dash.cost.partial": "Partial coverage ({note})",
  "dash.cost.hover": "Open this session's stats tab or run \"Complete\" to price it",
  "dash.row.expand": "Expand ledger details",
  "dash.ledger.none": "No ledger coverage for this session yet: cost and model attribution require opening its stats tab or running completion.",
  "dash.ledger.clearSession": "Clear this session's ledger",
  "dash.ledger.cleared": "Cleared.",
  "dash.deep.run": "Complete this session",
  "dash.deep.running": "Completing… (page {page})",
  "dash.deep.done": "Completed {entries} steps.",
  "dash.deep.donePartial": "Completed {entries} steps (budget limit reached, partial coverage).",
  "dash.deep.failed": "Completion failed: {message}",
  "dash.deep.unavailable": "Session history is unavailable (not in the data plane or RPC failed).",
  "dash.drill.hint": "Click to select a row · right-click for menu (jump / copy ID)",
  "dash.row.menu.jump": "Jump to session",
  "dash.row.menu.copy": "Copy session ID",
  "dash.row.menu.copied": "Copied session ID: {id}",
  "dash.row.copy.failed": "Copy failed: clipboard access was denied",
  "dash.colgrip.hint": "Drag to resize column · double-click to reset",
  "dash.drill.fallback": "Opening the session failed (archived sessions may not be restorable): its ledger details are expanded inline instead.",
  "dash.ledger.manage": "Local ledger",
  "dash.ledger.manageNote": "Per-step details accumulate in this browser's localStorage ({key}); usage buckets and model/timing facts only — no conversation content.",
  "dash.ledger.clearAll": "Clear entire ledger",
  "dash.ledger.rebuildAll": "Rebuild entire ledger",
  "dash.ledger.rebuildAllHint": "Rebuild the local ledger session-by-session from host session history (fully covered sessions are skipped; can be stopped midway)",
  "dash.ledger.rebuild.stop": "Stop rebuild",
  "dash.ledger.rebuild.running": "Rebuilding {done}/{total} · partial {partial} · failed {failed}…",
  "dash.ledger.rebuild.done": "Rebuild finished: {done} sessions · partial {partial} · failed {failed}.",
  "dash.ledger.rebuild.stopped": "Stopped: {done}/{total} done.",
  "dash.ledger.rebuild.none": "Nothing to rebuild: visible sessions are fully covered (or nothing to complete).",
  "dash.ledger.emptyHint": "Ledger is empty: costs and model attribution must be rebuilt from session history — click \"Rebuild entire ledger\".",
  "dash.ledger.export": "Export ledger backup",
  "dash.ledger.export.done": "Ledger backup exported ({sessions} sessions).",
  "dash.ledger.export.failed": "Export failed: the browser denied the download.",
  "dash.ledger.import": "Import ledger backup",
  "dash.ledger.import.ok": "Ledger imported: {sessions} sessions; costs recomputed with the current price table.",
  "dash.ledger.import.bad": "Import failed: not a valid ledger backup (v1 ledger JSON expected).",
  "dash.ledger.persistError": "Local storage quota exceeded: the ledger lives in memory for this page session.",
  "dash.datefmt": "{y}-{m}-{d}",
  "dash.datetimefmt": "{y}-{m}-{d} {hh}:{mm}"
};

/* ------------------------------------------------------------------ *
 * 样式：全部走 --dsw-alias-* 令牌随官方主题与风格插件联动（铁律），
 * 浅色/深色均可读；数字一律 tabular-nums。
 * ------------------------------------------------------------------ */

const CSS = `
/* T0 基座（design D2）：画布 bg-base / 卡面 bg-layer-1 / 描边 border-l2→l3 hover /
   焦点 brand 环 / 过渡 150–200ms；锚点与既有 tsn-* 类名零移除零改名。 */
.tsn-root{background:var(--dsw-alias-bg-base);flex-direction:column;flex:auto;min-height:0;padding:16px calc(var(--dsh-composer-side-clearance, 0px) + 16px);overflow-y:auto;display:flex}
.tsn-inner{max-width:var(--dsh-chat-content-width);flex-direction:column;gap:14px;width:100%;margin:0 auto;display:flex}
.tsn-head{align-items:center;gap:10px;flex-wrap:wrap;display:flex}
.tsn-title{color:var(--dsw-alias-label-primary);font-size:16px;font-weight:600;line-height:24px}
.tsn-note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.tsn-kpis{grid-template-columns:repeat(4, minmax(0, 1fr));gap:8px;display:grid}
.tsn-kpi{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));border-radius:12px;padding:10px 12px;transition:border-color .15s ease, background-color .15s ease}
.tsn-kpi:hover{border-color:var(--dsw-alias-border-l3)}
.tsn-kpi-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.tsn-kpi-value{color:var(--dsw-alias-label-primary);font-size:20px;font-weight:600;font-variant-numeric:tabular-nums;line-height:26px}
/* KPI 占比条（用户反馈 #6）：按数值比例填充的迷你占比条，替代不可读的环/圆点。 */
.tsn-kpi-meter{margin-top:2px;display:block}
.tsn-kpi-meter-track{background:var(--dsw-alias-border-l2);border-radius:999px;height:4px;gap:1px;overflow:hidden;display:flex}
.tsn-kpi-meter-track i{border-radius:999px;height:100%;min-width:2px;display:block}
/* 会话页次级指标条（tsn-kpis--compact）：TTFT/速度/费用降权呈现，值区允许换行。 */
.tsn-kpis.tsn-kpis--compact{grid-template-columns:repeat(3, minmax(0, 1fr));gap:2px;background:var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:4px}
.tsn-kpis--compact .tsn-kpi{background:transparent;border:none;border-radius:8px;padding:6px 10px;min-width:0}
.tsn-kpis--compact .tsn-kpi:hover{border:none}
.tsn-kpis--compact .tsn-kpi-label{font-size:11px;line-height:16px}
.tsn-kpis--compact .tsn-kpi-value{font-size:13px;font-weight:600;line-height:18px;white-space:normal;overflow-wrap:anywhere}
.tsn-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px;transition:border-color .15s ease, background-color .15s ease}
.tsn-card:hover{border-color:var(--dsw-alias-border-l3)}
.tsn-card-title{color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:600;line-height:18px}
.tsn-table-wrap{overflow-x:auto}
.tsn-table-scroll{max-height:60vh;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:12px}
.tsn-table{border-collapse:collapse;width:100%;font-size:12px;line-height:20px}
.tsn-table th{color:var(--dsw-alias-label-secondary);text-align:left;border-bottom:1px solid var(--dsw-alias-border-l2);padding:6px 10px;font-weight:500;white-space:nowrap}
.tsn-table td{color:var(--dsw-alias-label-primary);border-bottom:1px solid var(--dsw-alias-border-l1);padding:6px 10px;font-variant-numeric:tabular-nums;vertical-align:top;transition:background-color .15s ease}
.tsn-table .tsn-num{text-align:right}
.tsn-table-scroll .tsn-table th{position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-base)}
.tsn-table td.tsn-title-cell{color:var(--dsw-alias-label-secondary);max-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tsn-row{cursor:pointer}
/* 双色斑马纹（用户反馈 #1）：偶数行 interactive-hover 档 tint，行悬停升 active 档
   （浅色主题 layer 令牌全为白色不可见，interactive 半透明 tint 两主题均有层次）。 */
.tsn-table tbody tr:nth-child(even):not(.tsn-step-row) td{background:var(--dsw-alias-interactive-bg-hover)}
.tsn-table tbody tr.tsn-row:hover td{background:var(--dsw-alias-interactive-bg-active)}
/* token 数值色条（#4）：色条长度=列内占比，数字叠于色条之上加粗。 */
.tsn-databar{position:relative;width:76px;max-width:100%;justify-content:flex-end;align-items:center;display:inline-flex}
.tsn-databar-fill{position:absolute;left:0;top:18%;bottom:18%;border-radius:2px;opacity:.24;max-width:100%}
.tsn-databar-value{position:relative;font-weight:600}
/* 金额强调（#7）：亮金 + 加粗；浅色取 amber-600（更深的金），深色主题取 amber-400。 */
.tsn-money{color:var(--dsw-static-amber-600);font-weight:700}
body[data-ds-dark-theme] .tsn-money{color:var(--dsw-static-amber-400)}
/* 可排序表头（#5）。 */
.tsn-sort{align-items:center;cursor:pointer;color:inherit;background:0 0;border:none;gap:3px;padding:0;font:inherit;display:inline-flex}
.tsn-sort:hover{color:var(--dsw-alias-label-primary)}
.tsn-sort:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;border-radius:4px}
.tsn-sort svg{opacity:.3;flex:none;transition:transform .15s ease}
.tsn-sort[data-active="true"]{color:var(--dsw-alias-brand-primary)}
.tsn-sort[data-active="true"] svg{opacity:1}
.tsn-row-cell{align-items:center;justify-content:flex-end;gap:4px;display:flex}
.tsn-drill{color:var(--dsw-alias-label-tertiary);align-items:center;opacity:0;transition:opacity .15s ease;display:inline-flex}
.tsn-row:hover .tsn-drill{opacity:1}
.tsn-table tbody tr.tsn-row[data-selected="true"] td{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent)}
.tsn-colgrip{position:absolute;top:0;right:-3px;width:7px;height:100%;cursor:col-resize;user-select:none;touch-action:none;z-index:2}
.tsn-colgrip::after{content:"";position:absolute;top:22%;bottom:22%;left:3px;width:2px;border-radius:1px;background:transparent}
.tsn-table th:hover>.tsn-colgrip::after,.tsn-colgrip[data-active="true"]::after{background:var(--dsw-alias-brand-primary)}
body.tsn-colresizing{cursor:col-resize!important;user-select:none}
.tsn-ctxmenu{position:fixed;z-index:60;min-width:180px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:4px;display:flex;flex-direction:column}
.tsn-ctxmenu button{cursor:pointer;padding:7px 10px;border:0;border-radius:6px;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;text-align:left}
.tsn-ctxmenu button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tsn-ctxmenu .tsn-ctxmenu-id{color:var(--dsw-alias-label-tertiary);font-size:11px;padding:4px 10px 6px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tsn-model{align-items:center;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;font-size:11px;line-height:18px;padding:0 8px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-flex}
.tsn-indent{position:relative;max-width:100%;display:inline-block}
.tsn-indent--on::before{content:"";position:absolute;left:2px;top:-3px;bottom:-3px;width:1px;background:var(--dsw-alias-border-l2);border-radius:1px}
.tsn-expand{width:20px;height:20px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:8px;flex:none;place-items:center;padding:0;display:inline-grid;transition:background-color .15s ease, color .15s ease}
.tsn-expand svg{transition:transform .18s ease}
.tsn-expand[aria-expanded="true"] svg{transform:rotate(180deg)}
.tsn-expand:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.tsn-expand:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.tsn-muted{color:var(--dsw-alias-label-tertiary)}
.tsn-step-row td{background:var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));box-shadow:inset 3px 0 0 var(--dsw-alias-brand-primary);padding:8px 12px}
.tsn-step{flex-direction:column;gap:6px;display:flex}
.tsn-step-head{align-items:center;gap:8px;display:flex;flex-wrap:wrap}
.tsn-step-no{color:var(--dsw-alias-label-tertiary);font-size:12px}
.tsn-step-model{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:500}
.tsn-badge{color:var(--dsw-alias-state-warn-primary);border:1px solid var(--dsw-alias-state-warn-primary);border-radius:999px;font-size:11px;line-height:16px;padding:0 8px}
.tsn-step-buckets{align-items:center;gap:12px;display:flex;flex-wrap:wrap}
.tsn-step-bucket{align-items:center;gap:5px;color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums;display:inline-flex}
.tsn-step-bucket i{border-radius:2px;width:8px;height:8px;display:inline-block}
.tsn-step-meta{align-items:center;gap:12px;display:flex;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums}
.tsn-cfg{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-markdown-code-block, var(--dsw-alias-interactive-bg-hover));border-radius:4px;padding:0 4px}
.tsn-cfg b{color:var(--dsw-alias-label-tertiary);font-weight:400}
.tsn-charts{gap:12px;grid-template-columns:repeat(2, minmax(0, 1fr));display:grid}
.tsn-charts > .tsn-span2{grid-column:1/-1}
.tsn-chart{width:100%;height:auto;display:block}
.tsn-grid{stroke:var(--dsw-alias-border-l1);stroke-width:1;stroke-dasharray:2 3}
.tsn-tick{fill:var(--dsw-alias-label-tertiary);font-size:10px;font-variant-numeric:tabular-nums}
.tsn-anno{fill:var(--dsw-alias-label-primary);font-size:10px;font-variant-numeric:tabular-nums}
.tsn-bar{cursor:pointer;transition:opacity .15s ease}
.tsn-bar:hover{opacity:.85}
/* 悬停高亮联动（渐进增强）：支持 :has 时压暗其余条元，降级为上方单条 hover。 */
.tsn-chart:has(.tsn-bar:hover) .tsn-bar:not(:hover){opacity:.35}
.tsn-chart:has(.tsn-bar:hover) .tsn-bar:hover{opacity:1}
.tsn-line{fill:none;stroke:var(--dsw-alias-brand-primary);stroke-width:1.5}
/* 渐隐面积：fill 走 SVG defs 渐变 tsn-grad-cost（stop 色经 style 应用 brand 令牌）。 */
.tsn-line-area{fill:url(#tsn-grad-cost)}
.tsn-dot{fill:var(--dsw-alias-brand-primary)}
.tsn-alt{color:var(--dsw-alias-label-tertiary);font-size:12px}
.tsn-alt summary{cursor:pointer;user-select:none}
.tsn-alt table{margin-top:6px}
.tsn-hbars{flex-direction:column;gap:6px;display:flex}
.tsn-hbar-row{align-items:center;gap:8px;display:flex}
.tsn-hbar-label{color:var(--dsw-alias-label-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:130px;flex:none}
.tsn-hbar-track{background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;height:10px;overflow:hidden;flex:1;min-width:0;display:block}
.tsn-hbar-fill{border-radius:999px;height:100%;display:block;min-width:2px}
.tsn-hbar-value{color:var(--dsw-alias-label-primary);font-size:12px;font-variant-numeric:tabular-nums;width:56px;flex:none;text-align:right}
.tsn-ctxbar{background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;gap:1px;height:6px;overflow:hidden;display:flex}
.tsn-ctxseg{border-radius:1px;flex:none;min-width:2px;height:100%}
/* 上下文压力分档（design D9）：仅百分比文本与占用条状态描边着色，构成段色不变。 */
.tsn-card[data-level="warn"] .tsn-kpi-value{color:var(--dsw-alias-state-warn-primary)}
.tsn-card[data-level="error"] .tsn-kpi-value{color:var(--dsw-alias-state-error-primary)}
.tsn-card[data-level="warn"] .tsn-ctxbar{box-shadow:inset 0 0 0 1px var(--dsw-alias-state-warn-primary)}
.tsn-card[data-level="error"] .tsn-ctxbar{box-shadow:inset 0 0 0 1px var(--dsw-alias-state-error-primary)}
.tsn-ctxlegend{flex-direction:column;gap:2px;margin:0;padding:0;display:flex}
.tsn-ctxrow{justify-content:space-between;align-items:center;gap:12px;padding:2px 0;display:flex}
.tsn-ctxrow dt{color:var(--dsw-alias-label-secondary)}
.tsn-ctxrow dd{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;margin:0;font-weight:500}
.tsn-ctx-pct{color:var(--dsw-alias-label-tertiary);font-weight:400}
.tsn-swatch{border-radius:2px;width:8px;height:8px;margin-right:6px;display:inline-block}
.tsn-load{align-items:center;gap:8px;display:flex}
/* 覆盖度胶囊（N/M 轮 + 微型进度；仅窗口口径时无进度条）。 */
.tsn-pill{align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 10px;font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;white-space:nowrap;display:inline-flex}
.tsn-pill-track{background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;width:48px;height:4px;overflow:hidden;flex:none;display:inline-block}
.tsn-pill-fill{background:var(--dsw-alias-brand-primary);border-radius:999px;height:100%;display:block}
/* 虚线空态卡（会话页/总览页共用）。 */
.tsn-empty{border:1.5px dashed var(--dsw-alias-border-l2);border-radius:12px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;padding:28px 16px;text-align:center}
.tsn-btn{align-items:center;cursor:pointer;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);border:none;border-radius:8px;gap:8px;height:32px;padding:0 14px;font-size:13px;line-height:20px;display:inline-flex;transition:background-color .15s ease, color .15s ease}
.tsn-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tsn-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.tsn-btn-small{height:26px;border-radius:8px;padding:0 10px;font-size:12px}
.tsn-chip{color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap;display:inline-flex;align-items:center}
.tsn-token{font-weight:600}
.tsn-chip-dot{color:var(--dsw-alias-separator-primary);margin:0 6px}
.tsn-pricing-row{align-items:center;gap:12px;display:flex;flex-wrap:wrap}
.tsn-modal-root{position:absolute;inset:0;align-items:center;justify-content:center;display:flex;z-index:1100}
.tsn-modal-mask{background:var(--dsw-alias-bg-mask-1);position:absolute;inset:0}
.tsn-modal{position:relative;background:var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));border:1px solid var(--dsw-alias-border-l2);border-radius:16px;box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);width:min(92vw, 780px);max-height:86vh;flex-direction:column;display:flex}
.tsn-modal-head{border-bottom:1px solid var(--dsw-alias-border-l2);justify-content:space-between;align-items:center;gap:8px;padding:12px 16px;display:flex}
.tsn-modal-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:20px}
.tsn-modal-close{width:28px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:999px;place-items:center;display:grid;transition:background-color .15s ease, color .15s ease}
.tsn-modal-close:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tsn-modal-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.tsn-modal-body{overflow-y:auto;flex-direction:column;gap:16px;padding:16px;display:flex}
.tsn-modal-foot{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 16px;display:flex}
.tsn-section{flex-direction:column;gap:8px;display:flex}
.tsn-section-label{color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:600;line-height:18px}
.tsn-entry-list{flex-direction:column;gap:4px;display:flex}
.tsn-entry-row{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;align-items:center;gap:8px;cursor:pointer;padding:6px 10px;display:flex}
.tsn-entry-row[data-active="true"]{border-color:var(--dsw-alias-state-business-primary)}
.tsn-entry-model{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tsn-entry-meta{color:var(--dsw-alias-label-tertiary);font-size:12px}
.tsn-form-grid{gap:8px 12px;grid-template-columns:repeat(4, minmax(0, 1fr));display:grid}
.tsn-field{flex-direction:column;gap:3px;display:flex;min-width:0}
.tsn-field label{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.tsn-input{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);height:28px;padding:0 8px;font-size:12px;min-width:0}
.tsn-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.tsn-tier-row{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;flex-direction:column;gap:6px;padding:8px;display:flex}
.tsn-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.tsn-textarea{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:12px;min-height:88px;padding:8px;resize:vertical;width:100%}
.tsn-preview{flex-direction:column;gap:4px;display:flex}
.tsn-row-actions{align-items:center;gap:8px;display:flex;flex-wrap:wrap}

/* ---- Token统计总览（shell.overlay 整页帧 + 座位） ---- */
.tsn-dash-frame{position:absolute;top:0;right:0;bottom:0;z-index:1000;background:var(--dsw-alias-bg-base);border-left:1px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-shadow-lv2);flex-direction:column;min-width:0;display:flex;outline:none}
.tsn-dash-frame[data-degraded="true"]{left:0;box-shadow:none;border-left:none}
.tsn-dash-head{border-bottom:1px solid var(--dsw-alias-border-l2);justify-content:space-between;align-items:center;gap:12px;padding:12px 16px;display:flex;flex-wrap:wrap}
.tsn-dash-title{color:var(--dsw-alias-label-primary);font-size:16px;font-weight:600;line-height:24px}
.tsn-dash-head-actions{align-items:center;gap:8px;display:flex;flex-wrap:wrap}
.tsn-dash-close{width:28px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:999px;place-items:center;display:grid;transition:background-color .15s ease, color .15s ease}
.tsn-dash-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.tsn-dash-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.tsn-dash-body{flex-direction:column;gap:14px;overflow-y:auto;flex:1;min-height:0;padding:14px 16px 20px;display:flex}
.tsn-dash-kpis{grid-template-columns:repeat(6, minmax(0, 1fr));gap:8px;display:grid}
.tsn-kpi-sub{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.tsn-dash-tabs{border-bottom:1px solid var(--dsw-alias-border-l2);gap:2px;display:flex;flex-wrap:wrap}
.tsn-dash-tab{color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-bottom:2px solid transparent;margin-bottom:-1px;padding:8px 12px;font-size:13px;line-height:20px;transition:background-color .15s ease, color .15s ease, border-color .15s ease}
.tsn-dash-tab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);border-radius:6px 6px 0 0}
.tsn-dash-tab[data-active="true"]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}
.tsn-dash-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;border-radius:6px}
.tsn-card-head{justify-content:space-between;align-items:flex-start;gap:8px;display:flex}
.tsn-card-head-text{flex-direction:column;gap:2px;min-width:0;display:flex}
.tsn-card-actions{flex:none}
.tsn-card-subtitle{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.tsn-caliber-badge{color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;font-size:11px;line-height:16px;padding:0 8px;width:fit-content}
/* 11px 脚注升 secondary（任务 5.4）：浅色主题 tertiary ≈3.7:1 < 4.5:1，
   口径脚注/含数副注以 secondary 呈现；tertiary 保留给辅助说明（D2）。 */
.tsn-footnote{font-size:11px;color:var(--dsw-alias-label-secondary)}
.tsn-bucket-legend{align-items:center;gap:12px;display:flex;flex-wrap:wrap}
.tsn-badge2{align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;padding:0 8px;white-space:nowrap;display:inline-flex}
/* 状态徽标 = 圆点 + 文字（运行=success / 归档=tertiary / 子会话=warn）。 */
.tsn-badge2::before{content:"";background:currentColor;border-radius:999px;width:6px;height:6px;flex:none}
.tsn-badge2[data-kind="running"]{color:var(--dsw-alias-state-success-primary, var(--dsw-alias-label-primary));border-color:currentColor}
.tsn-badge2[data-kind="archived"]{color:var(--dsw-alias-label-tertiary)}
.tsn-badge2[data-kind="subagent"]{color:var(--dsw-alias-state-warn-primary);border-color:currentColor}
.tsn-segbar{background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;gap:1px;height:10px;overflow:hidden;display:flex}
.tsn-segbar span{border-radius:1px;height:100%;min-width:2px}
/* 图表卡网格（design D3）：6 列栅格；默认每卡 span 2（等宽三联），
   首卡与 .tsn-dash-grid-span 卡跨全宽（1/-1），卡片缺席不留空洞。 */
.tsn-dash-grid{gap:12px;grid-template-columns:repeat(6, minmax(0, 1fr));display:grid}
.tsn-dash-grid .tsn-card{min-width:0}
.tsn-dash-grid > .tsn-card{grid-column:span 2}
.tsn-dash-grid > .tsn-dash-grid-span{grid-column:1/-1}
.tsn-dash-grid > .tsn-card:first-child{grid-column:1/-1}
/* 筛选分段控件 + 搜索框图标位。 */
.tsn-seg{align-items:center;background:var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));border:1px solid var(--dsw-alias-border-l2);border-radius:8px;gap:2px;padding:2px;display:inline-flex}
.tsn-seg .tsn-btn{background:transparent;border-radius:6px;height:24px;padding:0 10px}
.tsn-seg .tsn-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tsn-seg .tsn-btn[data-active="true"]{background:var(--dsw-alias-interactive-bg-active, var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-label-primary)}
.tsn-searchbox{position:relative;align-items:center;min-width:0;display:inline-flex}
.tsn-searchbox > svg{position:absolute;left:8px;color:var(--dsw-alias-label-tertiary);pointer-events:none}
.tsn-searchbox .tsn-dash-search{padding-left:26px}
.tsn-dash-toolbar{align-items:center;gap:8px;display:flex;flex-wrap:wrap}
.tsn-dash-select{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);height:28px;padding:0 8px;font-size:12px}
.tsn-dash-search{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);height:28px;padding:0 10px;font-size:12px;min-width:180px}
.tsn-dash-search:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.tsn-dash-indent{padding-left:0}
.tsn-dash-note-ok{color:var(--dsw-alias-label-tertiary);font-size:12px}
/* 口径信息条（双口径脚注合并，带图标）。 */
.tsn-info-bar{align-items:flex-start;background:var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-secondary);gap:8px;padding:8px 12px;display:flex}
.tsn-info-bar > svg{color:var(--dsw-alias-label-tertiary);flex:none;margin-top:2px}
.tsn-info-bar .tsn-info-text{flex-direction:column;gap:4px;min-width:0;display:flex}
/* 警示条 warn 样式统一：tint 底（state-warn-tertiary 随主题）+ warn 描边。 */
.tsn-degraded-note{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-state-warn-tertiary, var(--dsw-alias-state-warn-secondary));border:1px solid var(--dsw-alias-state-warn-secondary);border-radius:8px;font-size:12px;line-height:18px;padding:8px 12px}

/* ---- 侧栏座位（sidebar.footer.action，双形态）----
   样式逐值镜像官方「设置」座位触发器（ui-settings-general SettingsRoot.module.css
   的 .trigger / .rail），保证与设置座位同款同排版；关键点：border:none ——
   缺省按钮边框是「突兀线框」的来源。 */
.tsn-seat{display:contents}
.tsn-seat-row{box-sizing:border-box;cursor:pointer;width:calc(100% + 4px);height:42px;color:var(--dsw-alias-label-primary);background:0 0;border:none;border-radius:12px;flex:none;align-items:center;gap:8px;margin:4px -2px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden}
.tsn-seat-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tsn-seat-row:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}
.tsn-seat-label{white-space:nowrap;overflow:hidden}
.tsn-seat-rail{box-sizing:border-box;cursor:pointer;color:var(--dsw-alias-label-primary);background:0 0;border:none;border-radius:50%;justify-content:center;align-items:center;gap:0;width:36px;height:36px;margin:8px 0 10px;padding:0;display:flex}
.tsn-seat-rail:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tsn-seat-rail:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:2px}
.tsn-seat[data-active="true"] .tsn-seat-row,
.tsn-seat[data-active="true"] .tsn-seat-rail{color:var(--dsw-alias-state-business-primary)}
/* ≤900px 单列化（design D3 断点细则）：显式单列下 span 2 会制造隐式列轨，
   必须同步重置各卡 grid-column 为 auto；首卡/跨全宽卡的 1/-1 在单列下安全。 */
@media (max-width: 900px){.tsn-kpis{grid-template-columns:repeat(2, minmax(0, 1fr))}.tsn-kpis.tsn-kpis--compact{grid-template-columns:repeat(3, minmax(0, 1fr))}.tsn-charts{grid-template-columns:1fr}.tsn-charts > .tsn-card{grid-column:auto}.tsn-dash-kpis{grid-template-columns:repeat(3, minmax(0, 1fr))}.tsn-dash-grid{grid-template-columns:1fr}.tsn-dash-grid > .tsn-card{grid-column:auto}.tsn-dash-grid > .tsn-card:first-child{grid-column:auto}}
@media (max-width: 480px){.tsn-form-grid{grid-template-columns:repeat(2, minmax(0, 1fr))}.tsn-hbar-label{width:88px}.tsn-dash-kpis{grid-template-columns:repeat(2, minmax(0, 1fr))}.tsn-dash-search{min-width:120px}.tsn-kpis.tsn-kpis--compact{grid-template-columns:repeat(3, minmax(0, 1fr))}}
@media (prefers-reduced-motion: reduce){.tsn-bar,.tsn-btn,.tsn-modal-close,.tsn-expand,.tsn-expand svg,.tsn-card,.tsn-kpi,.tsn-dash-tab,.tsn-row td,.tsn-seg .tsn-btn,.tsn-drill,.tsn-sort svg{transition:none}}
`;

function installStyles(ctx) {
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.dataset.plugin = PLUGIN_ID;
    tag.dataset.pluginCss = PLUGIN_ID + "/main.css";
    tag.textContent = CSS;
    document.head.appendChild(tag);
    return () => tag.remove();
  }, "token-insight: stylesheet");
}

/* ------------------------------------------------------------------ *
 * 显示辅助
 * ------------------------------------------------------------------ */

/** HH:MM 显示（表格用）。 */
function fmtTime(ms) {
  if (typeof ms !== "number") return "—";
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 时长显示（对齐官方 formatDuration：45.2s / 2m42s）。 */
function fmtDuration(ms) {
  const s = ms / 1e3;
  if (s < 60) return `${Math.round(s * 10) / 10}s`;
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)}m${whole % 60}s`;
}

/** 速度显示（对齐官方 formatTokensPerSecond：≥10 取整，否则 1 位小数）。 */
function fmtSpeed(tokensPerSecond) {
  const clamped = Math.max(0, tokensPerSecond);
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
}

/** 命中档说明（tooltip/步明细用）。 */
function tierLabel(tier, t) {
  if (!tier) return t("stats.step.tierDefault");
  const parts = [];
  if (typeof tier.minContextTokens === "number") parts.push(t("stats.step.tierCtx", { tokens: formatTokens(tier.minContextTokens) }));
  if (typeof tier.minCumulativeTokens === "number") parts.push(t("stats.step.tierCumulative", { tokens: formatTokens(tier.minCumulativeTokens) }));
  return parts.length > 0 ? parts.join(" & ") : t("stats.step.tierDefault");
}

function multiplierLabel(multiplier) {
  return multiplier === 1 || multiplier === void 0 ? null : `×${Math.round(multiplier * 100) / 100}`;
}

/** 价目变更订阅：编辑器保存后广播，统计页/chip/settings 行重算。 */
function usePriceVersion() {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const onChange = () => setVersion((value) => value + 1);
    window.addEventListener(PRICES_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(PRICES_CHANGED_EVENT, onChange);
  }, []);
  return version;
}

function currentPriceTable(version) {
  return useMemo(() => loadPriceTable(typeof localStorage === "undefined" ? null : localStorage), [version]);
}

/* ------------------------------------------------------------------ *
 * Token统计总览：模块级开关 store 与共享运行时
 * ------------------------------------------------------------------ */

/** 总览页开关（模块级 store，座位与 overlay 两个条目共享；price-store 同款模式）。 */
const dashboardOpenStore = {
  open: false,
  listeners: new Set(),
  getSnapshot() {
    return this.open;
  },
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  },
  set(open) {
    if (this.open === open) return;
    this.open = open;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        /* 订阅者异常不阻断其余通知 */
      }
    }
  }
};

function useDashboardOpen() {
  return useSyncExternalStore(
    (listener) => dashboardOpenStore.subscribe(listener),
    () => dashboardOpenStore.getSnapshot()
  );
}

/** 座位按钮元素（关闭页面时焦点返还座位；规格「焦点管理」）。 */
let dashboardSeatElement = null;

/** 页内弹窗深度（价目表编辑器打开时 ESC 只关弹窗不关页面——分层语义）。 */
let priceEditorDepth = 0;

/* ------------------------------------------------------------------ *
 * 本地账本运行时（Tier 1）：加载 / 幂等沉淀 / 防抖持久化 / 版本广播
 * ------------------------------------------------------------------ */

const LEDGER_CHANGED_EVENT = "dsh-token-insight:ledger-changed";
const LEDGER_SAVE_DEBOUNCE_MS = 1500;
const LEDGER_INGEST_DEBOUNCE_MS = 600;

const ledgerRuntime = {
  loaded: false,
  data: null,
  version: 0,
  saveTimer: 0,
  persistError: false
};

function ledgerNow() {
  try {
    return loadLedger(typeof localStorage === "undefined" ? null : localStorage);
  } catch {
    return loadLedger(null);
  }
}

/** 账本单例（惰性加载，损坏已由 loadLedger 回退空账本）。 */
function ledgerData() {
  if (!ledgerRuntime.loaded) {
    ledgerRuntime.data = ledgerNow();
    ledgerRuntime.loaded = true;
  }
  return ledgerRuntime.data;
}

/** 用一份已校验的账本整体替换内存单例（导入恢复用）；调用方负责随后持久化与通知。 */
function replaceLedgerData(next) {
  ledgerRuntime.data =
    next && typeof next === "object" && next.v === 1 && typeof next.sessions === "object" && next.sessions !== null
      ? next
      : emptyLedger();
  ledgerRuntime.loaded = true;
  ledgerRuntime.persistError = false;
}

function notifyLedgerChanged() {
  ledgerRuntime.version += 1;
  try {
    window.dispatchEvent(new CustomEvent(LEDGER_CHANGED_EVENT));
  } catch {
    /* 非浏览器环境静默 */
  }
}

function scheduleLedgerSave() {
  if (ledgerRuntime.saveTimer !== 0) return;
  ledgerRuntime.saveTimer = setTimeout(() => {
    ledgerRuntime.saveTimer = 0;
    const ledger = ledgerData();
    const activeIds = collectActiveSessionIds();
    const result = persistLedger(
      typeof localStorage === "undefined" ? null : localStorage,
      ledger,
      { nowMs: Date.now(), table: loadPriceTable(typeof localStorage === "undefined" ? null : localStorage), activeIds }
    );
    ledgerRuntime.persistError = !result.ok;
    if (result.aged) notifyLedgerChanged();
  }, LEDGER_SAVE_DEBOUNCE_MS);
}

/** 当前列表会话 id 集（孤儿 GC 的 activeIds；服务缺席时 null = 跳过 GC）。 */
function collectActiveSessionIds() {
  try {
    const snapshot = pluginCtx?.get?.("sessions")?.list?.getSnapshot?.();
    return snapshot ? new Set(Object.keys(snapshot.byId ?? {})) : null;
  } catch {
    return null;
  }
}

const ledgerIngestTimers = new Map();

/**
 * 沉淀一个会话的折叠行（会话页签 / chip 共用入口）。
 * 按会话防抖合并（foldTurns 在每次渲染都会跑，避免高频 upsert）；
 * upsert 幂等（last-wins），无变化不触发保存。
 */
function ledgerIngest(sessionId, rows, { windowFull = true } = {}) {
  if (!sessionId || !Array.isArray(rows) || rows.length === 0) return;
  const existing = ledgerIngestTimers.get(sessionId);
  if (existing !== void 0) clearTimeout(existing);
  const timer = setTimeout(() => {
    ledgerIngestTimers.delete(sessionId);
    try {
      const changed = upsertSessionEntries(ledgerData(), sessionId, rows, { windowFull, nowMs: Date.now() });
      if (changed > 0) {
        scheduleLedgerSave();
        notifyLedgerChanged();
      }
    } catch {
      /* 沉淀失败不影响统计渲染（账本是尽力而为的旁路） */
    }
  }, LEDGER_INGEST_DEBOUNCE_MS);
  ledgerIngestTimers.set(sessionId, timer);
}

/** useLedgerVersion：账本变更版本号（沉淀/老化/清除后重算总览聚合）。 */
function useLedgerVersion() {
  const [version, setVersion] = useState(ledgerRuntime.version);
  useEffect(() => {
    const onChange = () => setVersion(ledgerRuntime.version);
    window.addEventListener(LEDGER_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(LEDGER_CHANGED_EVENT, onChange);
  }, []);
  return version;
}

/* ------------------------------------------------------------------ *
 * 深度补全（按会话 opt-in）：session.history 离线折算入账本
 * ------------------------------------------------------------------ */

const DEEP_COMPLETION_MAX_PAGES = 20;
const DEEP_COMPLETION_PAGE_MESSAGES = 200;

/**
 * 拉取并离线折算一个会话的完整历史（不打开会话）。
 * @returns {entries, truncated, pages}（foldHistoryEvents 的产物汇总）。
 * 失败抛错（调用方 fail-soft 展示，不影响其他会话）。
 */
async function ledgerDeepComplete(sessionId, onProgress, { maxPages = DEEP_COMPLETION_MAX_PAGES } = {}) {
  const api = pluginCtx?.get?.("connection")?.api;
  if (!api?.sessions?.history) throw new Error("history RPC unavailable");
  const pages = [];
  let beforeSeq;
  let truncated = true;
  let pagesDone = 0;
  while (pagesDone < maxPages) {
    pagesDone += 1;
    onProgress?.(pagesDone);
    const { result } = await api.sessions.history({
      sessionId,
      maxMessages: DEEP_COMPLETION_PAGE_MESSAGES,
      ...beforeSeq === void 0 ? {} : { beforeSeq }
    });
    if (!result?.ok) throw new Error(result?.error?.message ?? "history request failed");
    pages.push(result.value.events ?? []);
    if (!result.value.hasMore) {
      truncated = false;
      break;
    }
    const firstSeq = result.value.events?.[0]?.event?.seq;
    if (!Number.isFinite(firstSeq)) {
      /* 无 seq 可翻页：视为到头（避免死循环）。 */
      truncated = false;
      break;
    }
    beforeSeq = firstSeq;
  }
  const folded = foldHistoryEvents(pages);
  const changed = upsertSessionEntries(ledgerData(), sessionId, folded.rows, { windowFull: false, nowMs: Date.now() });
  recordDeepCoverageLocal(sessionId, folded, truncated);
  if (changed > 0) {
    scheduleLedgerSave();
    notifyLedgerChanged();
  }
  const entries = folded.rows.reduce((sum, row) => sum + row.steps.length, 0);
  return { entries, truncated, pages: pagesDone };
}

function recordDeepCoverageLocal(sessionId, folded, truncated) {
  try {
    recordDeepCoverage(ledgerData(), sessionId, {
      fromSeq: folded.fromSeq,
      toSeq: folded.toSeq,
      truncated
    }, { nowMs: Date.now() });
  } catch {
    /* 覆盖区间记录失败不影响条目本身 */
  }
}

/* ------------------------------------------------------------------ *
 * 账本备份（导出 / 导入）。
 * 账本沉淀于浏览器 localStorage——已核实客户端插件作用域没有宿主侧可写存储
 * 缝隙（storageDomain 仅宿主侧），也没有宿主半边插件机制；而账本是会话历史
 * （宿主磁盘持久）的派生折叠，丢失可经「重建全部账本」自愈，备份用于免重扫。
 * ------------------------------------------------------------------ */

function ledgerBackupName() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `token-insight-ledger-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.json`;
}

/** 导出当前账本为 JSON 备份（浏览器下载）。@returns {ok, sessions} */
function exportLedgerBackup() {
  try {
    const text = JSON.stringify(ledgerData(), null, 2);
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = ledgerBackupName();
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
    return { ok: true, sessions: Object.keys(ledgerData().sessions).length };
  } catch {
    return { ok: false, sessions: 0 };
  }
}

/**
 * 解析账本备份文本：先按 loadLedger 同一判据做结构预检（区分「非法」与
 * 「合法但为空」），再经 loadLedger 逐会话净化。
 * @returns {ok, ledger, sessions}
 */
function parseLedgerBackup(text) {
  try {
    const parsed = JSON.parse(text);
    const valid =
      typeof parsed === "object" && parsed !== null && parsed.v === 1 && typeof parsed.sessions === "object" && parsed.sessions !== null;
    if (!valid) return { ok: false, ledger: null, sessions: 0 };
    const ledger = loadLedger({ getItem: () => text });
    return { ok: true, ledger, sessions: Object.keys(ledger.sessions).length };
  } catch {
    return { ok: false, ledger: null, sessions: 0 };
  }
}

/* ------------------------------------------------------------------ *
 * 钻取：关页面 → 打开会话 → 自动切其 Token 统计页签
 * ------------------------------------------------------------------ */

function switchToStatsTabWithRetry() {
  if (typeof requestAnimationFrame !== "function") return;
  let tries = 40;
  const step = () => {
    let tab = null;
    try {
      const tabs = document.querySelector('[role="tablist"]')?.querySelectorAll('button[role="tab"]');
      for (const candidate of tabs ?? []) {
        if ((candidate.textContent ?? "").includes("Token")) {
          tab = candidate;
          break;
        }
      }
    } catch {
      tab = null;
    }
    if (tab) {
      if (tab.getAttribute("aria-selected") !== "true") tab.click();
      return;
    }
    if (tries-- > 0) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/**
 * 明细行钻取主路径：关闭总览 → sessions.open（子会话优先父地址语义）→
 * 自动切该会话 Token 统计页签。失败返回 false（调用方降级页内展开）。
 */
function drillToSession(sessionId) {
  const sessions = pluginCtx?.get?.("sessions");
  if (!sessions) return false;
  try {
    const address = sessions.subagentAddress?.(sessionId);
    if (address) sessions.openSubagent?.(address);
    else sessions.open?.(sessionId);
  } catch {
    return false;
  }
  dashboardClosedViaDrill = true;
  dashboardOpenStore.set(false);
  switchToStatsTabWithRetry();
  return true;
}

/** 关闭语义标记：钻取关闭时不把焦点抢回座位。 */
let dashboardClosedViaDrill = false;

/* ------------------------------------------------------------------ *
 * 跳回对话页（2.2）：视图环切换 + 轮定位
 * ------------------------------------------------------------------ */

/** 会话页签栏的首个 tab = conversation.view 的 order 0 条目（chat）。 */
function switchToChatTab() {
  try {
    const tablist = document.querySelector('[role="tablist"]');
    const first = tablist?.querySelector('button[role="tab"]');
    if (!first) return;
    if (first.getAttribute("aria-selected") === "true") return;
    first.click();
  } catch {
    /* DOM 不可用则静默放弃——跳转是尽力而为的导航 */
  }
}

/** 在聊天流中定位该轮首行（data-chat-anchor-key = chat.locations 的节点键）。 */
function scrollToAnchorKey(key) {
  if (!key || typeof requestAnimationFrame !== "function") return;
  let tries = 30;
  const step = () => {
    let row = null;
    try {
      row = document.querySelector(`[data-chat-anchor-key="${CSS.escape(key)}"]`);
    } catch {
      row = null;
    }
    if (row) {
      row.scrollIntoView({ block: "start" });
      return;
    }
    if (tries-- > 0) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ------------------------------------------------------------------ *
 * 视图 0：Token统计总览（sidebar.footer.action 座位 + shell.overlay 整页帧）
 * ------------------------------------------------------------------ */

/** 座位图标（手写 SVG，currentColor 随主题）。 */
function SeatIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="8" width="3" height="6" rx="1" fill="currentColor" />
      <rect x="6.5" y="4" width="3" height="10" rx="1" fill="currentColor" />
      <rect x="11" y="1.5" width="3" height="12.5" rx="1" fill="currentColor" opacity="0.55" />
    </svg>
  );
}

/* ---- SVG 图标（任务 1.5：文本字形 ✕ / ▸▾ 一律换 SVG，禁止 emoji/字形图标）---- */

/** 关闭图标（总览页 ✕ / 价目表弹窗 ✕ 共用；aria 语义由按钮 aria-label 承担）。 */
function CloseIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** 展开/收起箭头（展开态由 .tsn-expand[aria-expanded] 旋转 180°）。 */
function ChevronIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M3 4.25L6 7.25l3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 钻取箭头（按会话表行 hover 浮现）。 */
function DrillArrowIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M4 2.5L7.5 6 4 9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 搜索图标（按会话表搜索框装饰位）。 */
function SearchIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <circle cx="5" cy="5" r="3.25" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7.5 7.5l2.5 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** 信息图标（口径信息条）。 */
function InfoIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="5.75" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7 6.4v3.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="7" cy="4.3" r="0.8" fill="currentColor" />
    </svg>
  );
}

/**
 * KPI 迷你占比条（用户反馈 #6 复审：迷你环/圆点示意不可读 → 改为按数值比例
 * 填充的占比条，段的宽度即比例，语义自明）。segments：[{ratio, color, title}]，
 * ratio ∈ [0,1] 相对轨道；ratio=0 的段不渲染；纯装饰（外层 aria-hidden），
 * 数值文本仍是唯一无障碍信息源；色值一律经 style 应用 var 令牌。
 */
function MiniMeter({ segments }) {
  const visible = segments.filter((segment) => segment.ratio > 0);
  if (visible.length === 0) return null;
  return (
    <span className="tsn-kpi-meter-track">
      {visible.map((segment, index) => (
        <i
          key={index}
          style={{ width: `${Math.min(100, Math.max(2, segment.ratio * 100))}%`, background: segment.color }}
          title={segment.title}
        />
      ))}
    </span>
  );
}

/**
 * 数值色条（用户反馈 #4）：token 列数值附比例色条，长度=列内占比，
 * 数字叠于色条之上加粗（#7）。ratio ∈ [0,1]；tone 用桶语义色/brand 令牌。
 */
function DataBar({ ratio, tone = "var(--dsw-alias-brand-primary)", children }) {
  const pct = Math.max(0, Math.min(100, Math.round((Number(ratio) || 0) * 100)));
  return (
    <span className="tsn-databar">
      {pct > 0 ? <i className="tsn-databar-fill" style={{ width: `${pct}%`, background: tone }} aria-hidden="true" /> : null}
      <span className="tsn-databar-value">{children}</span>
    </span>
  );
}

/**
 * 可排序表头（用户反馈 #5）：表头点击排序，aria-sort 语义；
 * 激活列 brand 色 + 方向箭头（asc 时箭头向上翻转）。
 */
function SortHeader({ label, sortKey, sort, onSort, className = "", style, dataCol, grip }) {
  const active = sort.key === sortKey;
  return (
    <th className={className} style={style} data-col={dataCol} aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
      <button type="button" className="tsn-sort" data-active={active || void 0} onClick={() => onSort(sortKey)}>
        {label}
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden="true"
          style={active && sort.dir === "asc" ? { transform: "rotate(180deg)" } : void 0}
        >
          <path d="M2 6.25L5 3.25l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {grip}
    </th>
  );
}

/* ------------------------------------------------------------------ *
 * 会话列表交互增强：右键菜单复制 / 列宽拖拽持久化
 * ------------------------------------------------------------------ */

/** 剪贴板兜底复制：clipboard API 优先，失败回退 execCommand。 */
async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* 继续走兜底 */ }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

const COLWIDTHS_KEY = "dsh-token-insight.colwidths.v2";
const COL_MIN_PCT = 3; /* 单列最小占比（%），防止拖没 */
const COL_MAX_PCT = 85;

function loadColWidthsAll() {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(COLWIDTHS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    /* 只接受百分比表（v2 语义）：每个值都必须在 (0, 100] */
    for (const widths of Object.values(parsed)) {
      if (!widths || typeof widths !== "object") return {};
      for (const value of Object.values(widths)) {
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 100) return {};
      }
    }
    return parsed;
  } catch {
    return {};
  }
}

/**
 * 列宽拖拽状态（按 tableKey 持久化于 localStorage，v2 = 百分比语义）。
 * widths 为 null 时保持浏览器 auto 布局；首次「拖动」以当下各列渲染宽度占表宽的
 * 比例归一化切入 fixed 布局——列宽全部为百分比且零和分配：拖宽某列的量按比例
 * 从其余列让出，表格总宽恒等于容器 100%，绝不产生横向滚动条，窗口缩放自适应。
 * 双击 grip 复位该列（全部复位即回到 auto 布局）。
 */
function useColumnWidths(tableKey) {
  const [widths, setWidths] = useState(null);
  const widthsRef = useRef(null);
  widthsRef.current = widths;
  const persist = (next) => {
    widthsRef.current = next;
    setWidths(next);
    try {
      const all = loadColWidthsAll();
      if (next && Object.keys(next).length > 0) all[tableKey] = next;
      else delete all[tableKey];
      if (typeof localStorage !== "undefined") localStorage.setItem(COLWIDTHS_KEY, JSON.stringify(all));
    } catch {
      /* 配额/隐私模式失败：仅本页生效 */
    }
  };
  const startDrag = (key, th, startClientX) => {
    const table = th.closest("table");
    const tableW = table?.offsetWidth ?? 0;
    if (!(tableW > 0)) return;
    /* 基线：各列渲染宽度占表宽的比例，归一化到 100% */
    const norm = {};
    let sum = 0;
    for (const el of th.parentElement.children) {
      const k = el?.dataset?.col;
      if (!k) continue;
      norm[k] = el.offsetWidth;
      sum += el.offsetWidth;
    }
    if (!(sum > 0)) return;
    for (const k of Object.keys(norm)) norm[k] = (norm[k] / sum) * 100;
    const others = Object.keys(norm).filter((k) => k !== key);
    const othersBase = others.reduce((s, k) => s + norm[k], 0) || 1;
    let dragPct = norm[key];
    let last = startClientX;
    let started = false;
    const apply = () => {
      const next = { ...norm };
      const shift = norm[key] - dragPct; /* 拖出（正）/拖入（负）的量，按比例从其余列让出/还给 */
      for (const k of others) next[k] = Math.max(COL_MIN_PCT, norm[k] + (shift * norm[k]) / othersBase);
      next[key] = dragPct;
      persist(next);
    };
    const onMove = (event) => {
      dragPct = Math.max(COL_MIN_PCT, Math.min(COL_MAX_PCT, dragPct + ((event.clientX - last) / tableW) * 100));
      last = event.clientX;
      if (!started) {
        started = true; /* 首次拖动才切入 fixed 布局——单纯点按把手不改变布局 */
        document.body.classList.add("tsn-colresizing");
      }
      apply();
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("tsn-colresizing");
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const gripProps = (key) => ({
    onPointerDown: (event) => {
      event.preventDefault();
      event.stopPropagation();
      const th = event.currentTarget.closest("th");
      if (th) startDrag(key, th, event.clientX);
    },
    onDoubleClick: (event) => {
      event.preventDefault();
      event.stopPropagation();
      const next = { ...(widthsRef.current ?? {}) };
      delete next[key];
      persist(Object.keys(next).length > 0 ? next : null);
    }
  });
  return {
    widths,
    tableStyle: widths ? { tableLayout: "fixed", width: "100%" } : void 0,
    /* 渲染时再归一化一次：钳位导致的漂移不影响「总宽=容器」的保证 */
    styleOf: (key) => {
      if (!widths || typeof widths[key] !== "number") return void 0;
      const total = Object.values(widths).reduce((s, v) => s + v, 0) || 1;
      return { width: `${((widths[key] / total) * 100).toFixed(3)}%`, boxSizing: "border-box" };
    },
    gripProps
  };
}

/** 列宽拖拽把手（置于 th 右缘；拖拽调宽，双击复位该列）。 */
const ColResizer = function ColResizer(props) {
  return <span className="tsn-colgrip" {...props} />;
};

/**
 * 侧栏底部动作座位（sidebar.footer.action 条目组件）。
 * owner props：{ wide }（侧栏展开=图标+文字，56px 导轨=纯图标）；root 作用域
 * 标准 props 的 useSessions/useWorkspaces 本条目用不到，不声明。
 * DOM 结构与样式镜像官方「设置」座位（SettingsRoot trigger + TriggerContent）：
 * wide 图标 16px / 导轨图标 18px，按钮 chrome 与设置触发器同值同排版。
 */
const DashboardSeat = function DashboardSeat({ wide, t }) {
  const open = useDashboardOpen();
  const toggle = () => {
    const next = !dashboardOpenStore.getSnapshot();
    dashboardOpenStore.set(next);
    if (!next) dashboardSeatElement?.focus?.();
  };
  const ref = (element) => {
    dashboardSeatElement = element;
  };
  if (wide) {
    return (
      <div className="tsn-seat" data-active={open || void 0}>
        <button
          type="button"
          className="tsn-seat-row"
          ref={ref}
          data-plugin-anchor="token-insight:seat"
          aria-expanded={open}
          onClick={toggle}
        >
          <SeatIcon size={16} />
          <span className="tsn-seat-label">{t("dash.seat")}</span>
        </button>
      </div>
    );
  }
  return (
    <div className="tsn-seat" data-active={open || void 0}>
      <button
        type="button"
        className="tsn-seat-rail"
        ref={ref}
        data-plugin-anchor="token-insight:seat"
        aria-label={t("dash.seat.aria")}
        aria-expanded={open}
        title={t("dash.seat")}
        onClick={toggle}
      >
        <SeatIcon size={18} />
      </button>
    </div>
  );
};

/** 本地时区日期显示（YYYY-MM-DD / HH:mm）。 */
function fmtDate(ms) {
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function fmtDateTime(ms) {
  if (typeof ms !== "number") return "—";
  return `${fmtDate(ms)} ${fmtTime(ms)}`;
}

/** 四桶堆叠条（按日；复用 charts.mjs stackedBarsLayout，标签取首尾）。 */
function DailyStackedChart({ days, ariaLabel }) {
  const layout = useMemo(() => stackedBarsLayout(days.map((day) => ({ turn: day.day, usage: day.buckets }))), [days]);
  if (days.length === 0) return null;
  const first = days[0].day;
  const last = days[days.length - 1].day;
  return (
    <svg className="tsn-chart" viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label={ariaLabel ?? first}>
      {layout.ticks.map((tick) => (
        <g key={tick.y}>
          <line x1={layout.pad.left} x2={layout.width - layout.pad.right} y1={tick.y} y2={tick.y} className="tsn-grid" />
          <text x={layout.pad.left - 4} y={tick.y + 3} textAnchor="end" className="tsn-tick">
            {formatAxisTokens(tick.value)}
          </text>
        </g>
      ))}
      {layout.bars.map((bar) => (
        <g key={bar.turn} className="tsn-bar">
          <title>{`${bar.turn} · ${formatTokens(bar.total)}`}</title>
          {bar.segments.map((segment) => (
            <rect key={segment.key} x={bar.x} y={segment.y} width={bar.w} height={segment.h} rx="2" style={{ fill: segment.color }}>
              <title>{`${segment.label} ${formatTokens(segment.value)}`}</title>
            </rect>
          ))}
        </g>
      ))}
      <text x={layout.pad.left} y={layout.height - 6} textAnchor="start" className="tsn-tick">
        {first}
      </text>
      {last !== first ? (
        <text x={layout.width - layout.pad.right} y={layout.height - 6} textAnchor="end" className="tsn-tick">
          {last}
        </text>
      ) : null}
    </svg>
  );
}

/** 通用横向条形（模型分布 / 项目占比共用）。 */
function HBars({ items }) {
  const layout = useMemo(() => hBarsLayout(items), [items]);
  if (layout.rows.length === 0) return null;
  return (
    <div className="tsn-hbars">
      {layout.rows.map((item) => (
        <div className="tsn-hbar-row" key={item.label}>
          <span className="tsn-hbar-label" title={item.label}>{item.label}</span>
          <span className="tsn-hbar-track">
            <span className="tsn-hbar-fill" style={{ width: `${(item.w / item.trackW) * 100}%`, background: item.color }} />
          </span>
          <span className="tsn-hbar-value">{formatTokens(item.value)}</span>
        </div>
      ))}
    </div>
  );
}

/** 累计/按日费用折线（按日；复用 lineLayout）。渐变 defs id 确定性命名（D6）：
    与会话页 CostLineChart 同色共享 id 无冲突。 */
function DailyCostChart({ points, currency }) {
  const layout = useMemo(() => lineLayout(points.map((point, index) => ({ ...point, turn: index }))), [points]);
  if (points.length === 0) return null;
  const last = layout.dots[layout.dots.length - 1] ?? null;
  return (
    <svg className="tsn-chart" viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label={points[0]?.day ?? ""}>
      <defs>
        <linearGradient id="tsn-grad-cost" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: "var(--dsw-alias-brand-primary)", stopOpacity: 0.18 }} />
          <stop offset="1" style={{ stopColor: "var(--dsw-alias-brand-primary)", stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      {layout.ticks.map((tick) => (
        <g key={tick.y}>
          <line x1={layout.pad.left} x2={layout.width - layout.pad.right} y1={tick.y} y2={tick.y} className="tsn-grid" />
          <text x={layout.pad.left - 4} y={tick.y + 3} textAnchor="end" className="tsn-tick">
            {formatMoney(tick.cost, currency)}
          </text>
        </g>
      ))}
      {layout.area ? <path d={layout.area} className="tsn-line-area" /> : null}
      <path d={layout.path} className="tsn-line" />
      {layout.dots.map((dot, index) => (
        <circle key={index} cx={dot.x} cy={dot.y} r="2.5" className="tsn-dot">
          <title>{`${points[index]?.day} · ${formatMoney(dot.cost, currency)}`}</title>
        </circle>
      ))}
      {last ? (
        <text x={last.x} y={Math.max(10, last.y - 6)} textAnchor="end" className="tsn-anno">
          {formatMoney(last.cost, currency)}
        </text>
      ) : null}
      <text x={layout.pad.left} y={layout.height - 6} textAnchor="start" className="tsn-tick">
        {points[0]?.day}
      </text>
      {points.length > 1 ? (
        <text x={layout.width - layout.pad.right} y={layout.height - 6} textAnchor="end" className="tsn-tick">
          {points[points.length - 1]?.day}
        </text>
      ) : null}
    </svg>
  );
}

/** 活跃/归档构成条（两会段）。 */
function ActivityBar({ kpi, t }) {
  const total = Math.max(1, kpi.sessions);
  const activeWidth = Math.max(2, ((kpi.sessions - kpi.archived) / total) * 100);
  return (
    <div className="tsn-segbar" role="img" aria-label={`${kpi.sessions - kpi.archived} / ${kpi.archived}`}>
      <span style={{ width: `${activeWidth}%`, background: "var(--dsw-static-green-500)" }}>
        <title>{`${kpi.sessions - kpi.archived} · ${t("dash.filter.active")}`}</title>
      </span>
      <span style={{ width: `${Math.max(2, 100 - activeWidth)}%`, background: "var(--dsw-static-neutral-bluish-600)" }}>
        <title>{`${kpi.archived} · ${t("dash.filter.archived")}`}</title>
      </span>
    </div>
  );
}

/**
 * 总览页几何帧：[data-slot="sidebar"] 出口的父列（真实盒子；出口本身
 * display:contents 无盒）右缘测量 + ResizeObserver 跟踪（拖拽/折叠/56px 导轨）。
 * 测量不可用（90 帧内未命中）→ 降级 inset:0 全覆盖 + 页内提示。
 */
function useSidebarLeft(frameRef, measuredRef) {
  const [left, setLeft] = useState(null);
  useEffect(() => {
    let ro = null;
    let raf = 0;
    let tries = 90;
    let disposed = false;
    let currentLeft = -1;
    const sidebarColumn = () => {
      try {
        const anchor = document.querySelector('[data-slot="sidebar"]');
        return anchor?.parentElement ?? null;
      } catch {
        return null;
      }
    };
    const apply = () => {
      const column = sidebarColumn();
      /* 页面帧的父元素即 shell.overlay 层容器（inset:0 于 AppFrame）——
         以其左缘为原点，避免 AppFrame 不在视口原点时的坐标漂移。 */
      const overlay = frameRef.current?.parentElement ?? null;
      if (!column || !overlay) return false;
      const rect = column.getBoundingClientRect();
      const base = overlay.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) return false;
      const next = Math.max(0, Math.round(rect.right - base.left));
      if (next !== currentLeft) {
        currentLeft = next;
        measuredRef.current = next;
        setLeft(next);
      }
      return true;
    };
    const scheduleApply = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        apply();
      });
    };
    const tick = () => {
      if (disposed) return;
      if (apply()) {
        const column = sidebarColumn();
        if (column && typeof ResizeObserver !== "undefined") {
          ro = new ResizeObserver(scheduleApply);
          ro.observe(column);
        }
        window.addEventListener("resize", scheduleApply);
        return;
      }
      if (tries-- > 0) raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener("resize", scheduleApply);
    };
  }, []);
  return left;
}

/** 总览整页帧（shell.overlay 条目组件；open=false 时渲染 null）。 */
const StatsOverviewOverlay = function StatsOverviewOverlay({ useSessions, useWorkspaces, t }) {
  const open = useDashboardOpen();
  if (!open) return null;
  return <DashboardSurface useSessions={useSessions} useWorkspaces={useWorkspaces} t={t} />;
};

const DASH_TABS = ["overview", "workspaces", "sessions", "time", "models", "pricing"];

function DashboardSurface({ useSessions, useWorkspaces, t }) {
  const frameRef = useRef(null);
  const measuredRef = useRef(null);
  const measuredLeft = useSidebarLeft(frameRef, measuredRef);
  const degraded = measuredLeft === null;
  const [tab, setTab] = useState("overview");
  const [ledgerNote, setLedgerNote] = useState(null);

  /* 数据面（root 标准 props：useSessions/useWorkspaces）+ 账本 + 价目版本。 */
  const sessions = useSessions((s) => s);
  const workspaces = useWorkspaces((s) => s);
  const priceVersion = usePriceVersion();
  const table = currentPriceTable(priceVersion);
  const ledgerVersion = useLedgerVersion();

  const rows = useMemo(
    () => (sessions?.ids ?? []).map((id) => sessions.byId?.[id]).filter((row) => typeof row?.id === "string"),
    [sessions]
  );
  const expanded = useMemo(() => expandRows(rows), [rows]);
  const archivedIds = useMemo(() => new Set(workspaces?.archivedSessionIds ?? []), [workspaces]);
  /* 聚合签名：行数 + 权威总量（投影推送不改变总量时跳过重的账本重聚合）。 */
  const rowsSignature = useMemo(
    () => `${rows.length}:${expanded.reduce((sum, item) => sum + (item.usage === null ? 0 : totalTokensBuckets(item.usage)), 0)}`,
    [rows, expanded]
  );
  const views = useMemo(
    () => aggregateLedgerViews(ledgerData(), table, expanded),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ledgerVersion, table, rowsSignature]
  );
  const dailyCost = useMemo(() => priceDailyCost(ledgerData(), table), [ledgerVersion, table]);
  const kpi = useMemo(() => {
    let cost = 0;
    let covered = 0;
    for (const result of views.bySession.values()) {
      if (!result.covered) continue;
      covered += 1;
      if (result.cost !== null) cost += result.cost;
    }
    return aggregateKpi(expanded, archivedIds, views.anyCovered ? { amount: cost, currency: displayCurrencyOf(table), covered, count: expanded.length } : null);
  }, [views, expanded, archivedIds, table]);
  const workspaceRows = useMemo(() => aggregateWorkspaces(expanded, workspaces), [expanded, workspaces]);
  const trendRows = useMemo(() => aggregateByTime(expanded, views.daily, views.coveredIds), [expanded, views]);
  const trendCostPoints = useMemo(() => {
    const days = new Set([...trendRows.map((row) => row.day), ...dailyCost.keys()]);
    const sorted = [...days].filter((day) => day !== "older").sort();
    return sorted.map((day) => ({ day, cost: dailyCost.get(day)?.cost ?? 0 }));
  }, [trendRows, dailyCost]);
  /* 按时间页签的颗粒度（day/month/year）：消耗分桶与费用线都按所选颗粒度重组
     （总览页签恒为按日，不受影响）。 */
  const [timeGranularity, setTimeGranularity] = useState("day");
  const timeTrendRows = useMemo(
    () => aggregateByTime(expanded, views.daily, views.coveredIds, { granularity: timeGranularity }),
    [expanded, views, timeGranularity]
  );
  const timeCostPoints = useMemo(() => groupCostByGranularity(trendCostPoints, timeGranularity), [trendCostPoints, timeGranularity]);
  const costCurrency = kpi.cost?.currency ?? displayCurrencyOf(table);

  /* 焦点管理：打开移焦入页；关闭返还座位（钻取关闭例外——保持会话内焦点）。 */
  useEffect(() => {
    frameRef.current?.focus();
    return () => {
      if (!dashboardClosedViaDrill) dashboardSeatElement?.focus?.();
      dashboardClosedViaDrill = false;
    };
  }, []);

  /* ESC 分层：先页内弹窗（价目表编辑器自关）后页面。 */
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape" && priceEditorDepth === 0) dashboardOpenStore.set(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const close = () => dashboardOpenStore.set(false);

  const modelBars = useMemo(
    () =>
      views.byModel.map((row) => ({
        label: row.model === null || row.model === "" ? t("dash.model.unclassified") : row.model,
        value: row.total
      })),
    [views, t]
  );
  const workspaceBars = useMemo(() => {
    /* 同名 basename（不同 cwd）在图表中合并为一条；明细表保持逐 cwd 行。 */
    const merged = new Map();
    for (const row of workspaceRows) {
      const label = row.name ?? t("dash.workspace.unknown");
      merged.set(label, (merged.get(label) ?? 0) + row.total);
    }
    return [...merged.entries()].map(([label, value]) => ({ label, value }));
  }, [workspaceRows, t]);

  return (
    <div
      ref={frameRef}
      className="tsn-dash-frame"
      data-plugin-anchor="token-insight:overview"
      data-degraded={degraded || void 0}
      style={degraded ? void 0 : { left: `${measuredLeft}px` }}
      role="region"
      aria-label={t("dash.title")}
      tabIndex={-1}
    >
      <header className="tsn-dash-head">
        <div className="tsn-dash-title">{t("dash.title")}</div>
        <div className="tsn-dash-head-actions">
          <button type="button" className="tsn-dash-close" aria-label={t("dash.close")} title={t("dash.close")} onClick={close}>
            <CloseIcon />
          </button>
        </div>
      </header>
      <div className="tsn-dash-body">
        {degraded ? <div className="tsn-degraded-note">{t("dash.degraded")}</div> : null}
        {archivedMissingFromList(expanded, archivedIds) ? <div className="tsn-degraded-note">{t("dash.archivedMissing")}</div> : null}

        <div className="tsn-dash-kpis">
          <KpiCard
            label={t("dash.kpi.total")}
            value={kpi.hasAnyUsage ? formatTokens(kpi.billedTotal) : "—"}
          />
          <KpiCard
            label={t("dash.kpi.billedIn")}
            value={kpi.hasAnyUsage ? formatTokens(kpi.billedIn) : "—"}
          />
          <KpiCard label={t("dash.kpi.out")} value={kpi.hasAnyUsage ? formatTokens(kpi.output) : "—"} />
          <KpiCard
            label={t("dash.kpi.cacheHit")}
            value={kpi.hasAnyUsage && kpi.cacheHit !== null ? `${Math.round(kpi.cacheHit * 10) / 10}%` : "—"}
            meter={
              kpi.hasAnyUsage && kpi.cacheHit !== null ? (
                <MiniMeter segments={[{ ratio: kpi.cacheHit / 100, color: "var(--dsw-static-green-500)" }]} />
              ) : null
            }
          />
          <KpiCard
            label={t("dash.kpi.sessions")}
            value={String(kpi.sessions)}
            sub={t("dash.kpi.sessionsSub", { total: kpi.sessions, archived: kpi.archived, running: kpi.running })}
            meter={
              kpi.sessions > 0 ? (
                <MiniMeter
                  segments={[
                    {
                      ratio: (kpi.sessions - kpi.archived) / kpi.sessions,
                      color: "var(--dsw-static-green-500)",
                      title: `${t("dash.filter.active")} · ${kpi.sessions - kpi.archived}`
                    },
                    {
                      ratio: kpi.archived / kpi.sessions,
                      color: "var(--dsw-static-neutral-bluish-400)",
                      title: `${t("dash.filter.archived")} · ${kpi.archived}`
                    }
                  ]}
                />
              ) : null
            }
          />
          <KpiCard
            label={t("dash.kpi.cost")}
            value={
              kpi.cost && kpi.cost.covered > 0 ? (
                <span className="tsn-money">{formatMoney(kpi.cost.amount, kpi.cost.currency)}</span>
              ) : (
                "—"
              )
            }
            sub={t("dash.kpi.costSub", { covered: kpi.cost?.covered ?? 0, count: kpi.cost?.count ?? expanded.length })}
          />
        </div>

        <div className="tsn-dash-tabs" role="tablist" aria-label={t("dash.title")}>
          {DASH_TABS.map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              className="tsn-dash-tab"
              data-active={tab === key || void 0}
              aria-selected={tab === key}
              onClick={() => setTab(key)}
            >
              {t(`dash.tab.${key}`)}
            </button>
          ))}
        </div>

        {/* 双口径脚注合并为带图标的口径信息条（任务 3.5；文案语义不变）。 */}
        <div className="tsn-info-bar">
          <InfoIcon />
          <div className="tsn-info-text">
            <span className="tsn-note tsn-footnote">{t("dash.tier0.note")}</span>
            <span className="tsn-note tsn-footnote">{t("dash.tier1.note")}</span>
          </div>
        </div>
        {ledgerRuntime.persistError ? <Footnote>{t("dash.ledger.persistError")}</Footnote> : null}

        {rows.length === 0 ? (
          <div className="tsn-note tsn-empty">{t("dash.empty")}</div>
        ) : tab === "overview" ? (
          <OverviewTab
            t={t}
            trendRows={trendRows}
            trendCostPoints={trendCostPoints}
            costCurrency={costCurrency}
            modelBars={modelBars}
            workspaceBars={workspaceBars}
            kpi={kpi}
            anyCovered={views.anyCovered}
          />
        ) : tab === "workspaces" ? (
          <WorkspacesTab t={t} rows={workspaceRows} />
        ) : tab === "sessions" ? (
          <SessionsTab
            t={t}
            sessionRows={aggregateSessions(expanded, archivedIds, views.bySession)}
            onDrill={drillToSession}
            onLedgerCleared={() => {
              setLedgerNote(t("dash.ledger.cleared"));
              notifyLedgerChanged();
            }}
            ledgerNote={ledgerNote}
          />
        ) : tab === "time" ? (
          <TimeTab
            t={t}
            trendRows={timeTrendRows}
            trendCostPoints={timeCostPoints}
            costCurrency={costCurrency}
            anyCovered={views.anyCovered}
            granularity={timeGranularity}
            onGranularityChange={setTimeGranularity}
          />
        ) : tab === "models" ? (
          <ModelsTab t={t} rows={views.byModel} currency={costCurrency} />
        ) : (
          <PricingTab t={t} ledgerNote={ledgerNote} onLedgerCleared={() => { setLedgerNote(t("dash.ledger.cleared")); notifyLedgerChanged(); }} onNote={setLedgerNote} />
        )}
      </div>
    </div>
  );
}

/* 总览页签：图表卡网格（消耗趋势 / 模型分布 / 项目占比 / 活跃归档构成 / 费用趋势）。 */
function OverviewTab({ t, trendRows, trendCostPoints, costCurrency, modelBars, workspaceBars, kpi, anyCovered }) {
  const mixedCaliber = trendRows.some((row) => row.source === "recent");
  const trendAlt = (
    <table className="tsn-table">
      <thead>
        <tr>
          <th>{t("dash.col.activity")}</th>
          {BUCKET_SEGMENTS.map((segment) => (
            <th key={segment.key} className="tsn-num">{segment.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {trendRows.map((row) => (
          <tr key={row.day}>
            <td>{row.day === "older" ? t("dash.date.older") : row.day}</td>
            {BUCKET_SEGMENTS.map((segment) => (
              <td key={segment.key} className="tsn-num">{formatTokens(row.buckets[segment.key] ?? 0)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <>
      <div className="tsn-dash-grid">
        <ChartCard
          title={t("dash.chart.trend")}
          subtitle={t("dash.chart.trendSub")}
          caliber={mixedCaliber ? t("dash.time.byRecent") : null}
          alt={{ summaryLabel: t("stats.chart.tableAlt"), table: trendAlt }}
        >
          <DailyStackedChart days={trendRows} />
        </ChartCard>
        <ChartCard title={t("dash.chart.models")} subtitle={t("dash.chart.modelsSub")} alt={{ summaryLabel: t("stats.chart.tableAlt"), table: <ModelsAltTable rows={modelBars} /> }}>
          <HBars items={modelBars} />
        </ChartCard>
        <ChartCard title={t("dash.chart.projects")} subtitle={t("dash.chart.projectsSub")} alt={{ summaryLabel: t("stats.chart.tableAlt"), table: <ModelsAltTable rows={workspaceBars} /> }}>
          <HBars items={workspaceBars} />
        </ChartCard>
        <ChartCard title={t("dash.chart.activity")} subtitle={t("dash.chart.activitySub")}>
          <ActivityBar kpi={kpi} t={t} />
          <table className="tsn-table">
            <tbody>
              <tr>
                <td>{t("dash.filter.active")}</td>
                <td className="tsn-num">{kpi.sessions - kpi.archived}</td>
              </tr>
              <tr>
                <td>{t("dash.filter.archived")}</td>
                <td className="tsn-num">{kpi.archived}</td>
              </tr>
              <tr>
                <td>{t("dash.kpi.sessions")}</td>
                <td className="tsn-num">{kpi.sessions}</td>
              </tr>
            </tbody>
          </table>
        </ChartCard>
        {anyCovered ? (
          <ChartCard
            title={t("dash.chart.dailyCost")}
            subtitle={t("dash.chart.dailyCostSub")}
            className="tsn-dash-grid-span"
          >
            <DailyCostChart points={trendCostPoints} currency={costCurrency} />
          </ChartCard>
        ) : null}
      </div>
    </>
  );
}

function ModelsAltTable({ rows }) {
  return (
    <table className="tsn-table">
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <td>{row.label}</td>
            <td className="tsn-num">{formatTokens(row.value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* 按工作区页签：项目归组表（token 列附比例色条）。 */
function WorkspacesTab({ t, rows }) {
  const bucketMax = useMemo(() => {
    const maxes = {};
    for (const segment of BUCKET_SEGMENTS) {
      maxes[segment.key] = rows.reduce((max, row) => Math.max(max, row.buckets?.[segment.key] ?? 0), 0);
    }
    return maxes;
  }, [rows]);
  const totalMax = useMemo(() => rows.reduce((max, row) => Math.max(max, row.total ?? 0), 0), [rows]);
  return (
    <div className="tsn-table-wrap">
      <table className="tsn-table">
        <thead>
          <tr>
            <th>{t("dash.col.workspace")}</th>
            <th className="tsn-num">{t("dash.col.sessions")}</th>
            <th className="tsn-num">{t("dash.col.running")}</th>
            {BUCKET_SEGMENTS.map((segment) => (
              <th key={segment.key} className="tsn-num">{segment.label}</th>
            ))}
            <th className="tsn-num">{t("dash.col.total")}</th>
            <th className="tsn-num">{t("dash.col.hit")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.cwd ?? "__unknown__"}>
              <td className="tsn-title-cell" title={row.cwd ?? ""}>{row.name ?? t("dash.workspace.unknown")}</td>
              <td className="tsn-num">{row.sessions}</td>
              <td className="tsn-num">{row.running}</td>
              {BUCKET_SEGMENTS.map((segment) => (
                <td key={segment.key} className="tsn-num">
                  <DataBar
                    ratio={bucketMax[segment.key] > 0 ? (row.buckets?.[segment.key] ?? 0) / bucketMax[segment.key] : 0}
                    tone={segment.color}
                  >
                    {formatTokens(row.buckets?.[segment.key] ?? 0)}
                  </DataBar>
                </td>
              ))}
              <td className="tsn-num">
                <DataBar ratio={totalMax > 0 ? (row.total ?? 0) / totalMax : 0}>
                  {formatTokens(row.total ?? 0)}
                </DataBar>
              </td>
              <td className="tsn-num">{row.cacheHit === null ? "—" : `${Math.round(row.cacheHit)}%`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* 会话页明细表排序（用户反馈 #5）：表头点击排序；默认按轮号升序（时间线语义）。 */
const DETAIL_SORT_DIR = {
  turn: "asc",
  time: "desc",
  title: "asc",
  model: "asc",
  in: "desc",
  out: "desc",
  cache: "desc",
  cost: "desc"
};

function sortValueOfDetail(row, key) {
  switch (key) {
    case "turn":
      return row.turn;
    case "time":
      return row.startTime;
    case "title":
      return row.title ?? null;
    case "model":
      return row.models.length > 0 ? row.models.join(", ") : null;
    case "in":
      return billedInputTokens(row.usage);
    case "out":
      return row.usage.outputTokens ?? 0;
    case "cache":
      return cacheHitPercent(row.usage);
    case "cost":
      return row.cost;
    default:
      return null;
  }
}

/* 按会话页签排序（用户反馈 #5）：表头点击排序；nullish 恒排末尾。 */
const SESSION_SORT_DIR = {
  title: "asc",
  cwd: "asc",
  activity: "desc",
  inputTokens: "desc",
  cacheWriteTokens: "desc",
  cacheReadTokens: "desc",
  outputTokens: "desc",
  hit: "desc",
  cost: "desc"
};

function sortValueOfSession(row, key) {
  switch (key) {
    case "title":
      return row.title ?? null;
    case "cwd":
      return row.groupName ?? null;
    case "activity":
      return row.updatedAt;
    case "hit":
      return row.cacheHit;
    case "cost":
      return row.covered ? row.cost : null;
    default:
      return row.usage?.[key] ?? 0;
  }
}

/* 按会话页签：明细表（筛选/搜索/表头点击排序/徽标/选中+右键菜单/列宽拖拽/展开账本明细/深度补全）。 */
function SessionsTab({ t, sessionRows, onDrill, onLedgerCleared, ledgerNote }) {
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState({ key: "activity", dir: "desc" });
  const [expandedId, setExpandedId] = useState(null);
  const [drillFailedId, setDrillFailedId] = useState(null);
  const [deep, setDeep] = useState({});
  const [selectedId, setSelectedId] = useState(null);
  const [menu, setMenu] = useState(null); /* { x, y, id } */
  const [rebuild, setRebuild] = useState({ running: false, done: 0, total: 0, partial: 0, failed: 0, note: null });
  const rebuildRunningRef = useRef(false);
  const rebuildCancelRef = useRef(false);
  const colctl = useColumnWidths("dash-sessions");

  /* 右键菜单：点外部 / Esc / 窗口缩放时关闭（菜单内部点击不关闭，交给菜单项自己的动作）。 */
  useEffect(() => {
    if (!menu) return;
    const close = (event) => {
      if (event.target?.closest?.(".tsn-ctxmenu")) return;
      setMenu(null);
    };
    const onKey = (event) => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return sessionRows.filter((row) => {
      if (filter === "active" && row.archived) return false;
      if (filter === "archived" && !row.archived) return false;
      if (query !== "" && !`${row.title}\n${row.cwd ?? ""}`.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [sessionRows, filter, search]);

  const visible = useMemo(() => {
    const factor = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const va = sortValueOfSession(a, sort.key);
      const vb = sortValueOfSession(b, sort.key);
      const aNull = va === null || va === void 0;
      const bNull = vb === null || vb === void 0;
      if (aNull || bNull) return aNull && bNull ? 0 : aNull ? 1 : -1;
      if (typeof va === "string" || typeof vb === "string") return factor * String(va).localeCompare(String(vb), "zh");
      return factor * (va - vb);
    });
  }, [filtered, sort]);

  const toggleSort = (key) => {
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: SESSION_SORT_DIR[key] ?? "desc" }
    );
  };

  /* token 色条列内占比基准（用户反馈 #4）。 */
  const bucketMax = useMemo(() => {
    const maxes = {};
    for (const segment of BUCKET_SEGMENTS) {
      maxes[segment.key] = filtered.reduce((max, row) => Math.max(max, row.usage?.[segment.key] ?? 0), 0);
    }
    return maxes;
  }, [filtered]);

  const runDeep = async (id) => {
    setDeep((prev) => ({ ...prev, [id]: { busy: true, page: 0 } }));
    try {
      const result = await ledgerDeepComplete(id, (page) => setDeep((prev) => ({ ...prev, [id]: { busy: true, page } })));
      setDeep((prev) => ({
        ...prev,
        [id]: {
          busy: false,
          message: result.truncated
            ? t("dash.deep.donePartial", { entries: result.entries })
            : t("dash.deep.done", { entries: result.entries })
        }
      }));
    } catch (error) {
      setDeep((prev) => ({
        ...prev,
        [id]: { busy: false, message: t("dash.deep.failed", { message: String(error?.message ?? error) }) }
      }));
    }
  };

  /* 一键重建：逐会话深度补全（预算放宽到 50 页），已完整覆盖的会话自动跳过。 */
  const runRebuildAll = async () => {
    if (rebuildRunningRef.current) {
      rebuildCancelRef.current = true;
      return;
    }
    const targets = visible.filter((row) => {
      const session = ledgerData().sessions[row.id];
      if (!session || (session.entries.length === 0 && session.buckets.length === 0)) return true;
      const coverage = session.coverage ?? {};
      /* 已完整覆盖（深补走完且未截断）的跳过；部分覆盖/未覆盖的重建 */
      return !(coverage.deepTruncated === false && coverage.windowFull === true);
    });
    if (targets.length === 0) {
      setRebuild({ running: false, done: 0, total: 0, partial: 0, failed: 0, note: t("dash.ledger.rebuild.none") });
      return;
    }
    rebuildRunningRef.current = true;
    rebuildCancelRef.current = false;
    let done = 0;
    let partial = 0;
    let failed = 0;
    setRebuild({ running: true, done: 0, total: targets.length, partial: 0, failed: 0, note: null });
    for (const row of targets) {
      if (rebuildCancelRef.current) break;
      try {
        const result = await ledgerDeepComplete(row.id, () => {}, { maxPages: 50 });
        if (result?.truncated === true) partial += 1;
      } catch {
        failed += 1; /* 单会话失败不影响其余（fail-soft） */
      }
      done += 1;
      const cancelled = rebuildCancelRef.current;
      setRebuild({
        running: !cancelled && done < targets.length,
        done,
        total: targets.length,
        partial,
        failed,
        note: cancelled
          ? t("dash.ledger.rebuild.stopped", { done, total: targets.length })
          : done >= targets.length
            ? t("dash.ledger.rebuild.done", { done, partial, failed })
            : null
      });
    }
    rebuildRunningRef.current = false;
    rebuildCancelRef.current = false;
  };

  const gripOf = (key) => <ColResizer {...colctl.gripProps(key)} title={t("dash.colgrip.hint")} />;

  return (
    <>
      <div className="tsn-dash-toolbar">
        <div className="tsn-seg" role="group" aria-label={t("dash.col.status")}>
          {["all", "active", "archived"].map((key) => (
            <button
              key={key}
              type="button"
              className="tsn-btn tsn-btn-small"
              data-active={filter === key || void 0}
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              {t(`dash.filter.${key}`)}
            </button>
          ))}
        </div>
        <span className="tsn-searchbox">
          <SearchIcon />
          <input
            className="tsn-dash-search"
            type="search"
            placeholder={t("dash.search")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </span>
        <button
          type="button"
          className="tsn-btn tsn-btn-small"
          onClick={runRebuildAll}
          title={t("dash.ledger.rebuildAllHint")}
        >
          {rebuild.running ? t("dash.ledger.rebuild.stop") : t("dash.ledger.rebuildAll")}
        </button>
        {rebuild.running ? (
          <span className="tsn-note">
            {t("dash.ledger.rebuild.running", { done: rebuild.done, total: rebuild.total, partial: rebuild.partial, failed: rebuild.failed })}
          </span>
        ) : null}
        {!rebuild.running && rebuild.note ? <span className="tsn-note">{rebuild.note}</span> : null}
        {!rebuild.running && rebuild.note === null && Object.keys(ledgerData().sessions).length === 0 && sessionRows.length > 0 ? (
          <span className="tsn-note">{t("dash.ledger.emptyHint")}</span>
        ) : null}
        {ledgerNote ? <span className="tsn-note">{ledgerNote}</span> : null}
      </div>
      <div className="tsn-table-wrap tsn-table-scroll">
        <table className="tsn-table" style={colctl.tableStyle}>
          <thead>
            <tr>
              <SortHeader label={t("stats.col.title")} sortKey="title" sort={sort} onSort={toggleSort} dataCol="title" style={colctl.styleOf("title")} grip={gripOf("title")} />
              <SortHeader label={t("dash.col.workspace")} sortKey="cwd" sort={sort} onSort={toggleSort} dataCol="cwd" style={colctl.styleOf("cwd")} grip={gripOf("cwd")} />
              <th data-col="status" style={colctl.styleOf("status")}>
                {t("dash.col.status")}
                {gripOf("status")}
              </th>
              <SortHeader label={t("dash.col.activity")} sortKey="activity" sort={sort} onSort={toggleSort} dataCol="activity" style={colctl.styleOf("activity")} grip={gripOf("activity")} />
              {BUCKET_SEGMENTS.map((segment) => (
                <SortHeader key={segment.key} className="tsn-num" label={segment.label} sortKey={segment.key} sort={sort} onSort={toggleSort} dataCol={segment.key} style={colctl.styleOf(segment.key)} grip={gripOf(segment.key)} />
              ))}
              <SortHeader className="tsn-num" label={t("dash.col.hit")} sortKey="hit" sort={sort} onSort={toggleSort} dataCol="hit" style={colctl.styleOf("hit")} grip={gripOf("hit")} />
              <SortHeader className="tsn-num" label={t("stats.col.cost")} sortKey="cost" sort={sort} onSort={toggleSort} dataCol="cost" style={colctl.styleOf("cost")} grip={gripOf("cost")} />
              <th data-col="actions" aria-label="actions" style={colctl.styleOf("actions")} />
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const expandedRow = expandedId === row.id;
              const deepState = deep[row.id];
              return (
                <Fragment key={row.id}>
                  <tr
                    className="tsn-row"
                    data-selected={selectedId === row.id || void 0}
                    title={t("dash.drill.hint")}
                    onClick={() => setSelectedId(row.id)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setSelectedId(row.id);
                      setMenu({
                        x: event.clientX,
                        y: Math.min(event.clientY, Math.max(0, window.innerHeight - 150)),
                        id: row.id
                      });
                    }}
                  >
                    <td className="tsn-title-cell" title={row.title}>
                      <span className={row.depth > 0 ? "tsn-indent tsn-indent--on" : "tsn-indent"} style={row.depth > 0 ? { paddingLeft: `${row.depth * 14}px` } : void 0}>{row.title}</span>
                    </td>
                    <td className="tsn-title-cell" title={row.cwd ?? ""}>
                      {row.groupName ?? t("dash.workspace.unknown")}
                    </td>
                    <td>
                      {row.running ? <StatBadge kind="running">{t("dash.badge.running")}</StatBadge> : null}
                      {row.archived ? <StatBadge kind="archived">{t("dash.badge.archived")}</StatBadge> : null}
                      {row.isSub ? <StatBadge kind="subagent">{t("dash.badge.subagent")}</StatBadge> : null}
                      {!row.running && !row.archived && !row.isSub ? (row.completed ? t("dash.badge.completed") : "·") : null}
                    </td>
                    <td>{row.updatedAt === null ? "—" : fmtDateTime(row.updatedAt)}</td>
                    {BUCKET_SEGMENTS.map((segment) => (
                      <td key={segment.key} className="tsn-num">
                        <DataBar
                          ratio={bucketMax[segment.key] > 0 ? (row.usage?.[segment.key] ?? 0) / bucketMax[segment.key] : 0}
                          tone={segment.color}
                        >
                          {formatTokens(row.usage?.[segment.key] ?? 0)}
                        </DataBar>
                      </td>
                    ))}
                    <td className="tsn-num">{row.cacheHit === null ? "—" : `${Math.round(row.cacheHit)}%`}</td>
                    <td className="tsn-num" title={row.covered ? void 0 : t("dash.cost.hover")}>
                      {!row.covered ? (
                        <span className="tsn-muted">{t("dash.cost.none")}</span>
                      ) : row.cost !== null ? (
                        <span className="tsn-money">{formatMoney(row.cost, row.currency)}</span>
                      ) : (
                        <span className="tsn-muted">
                          {t("stats.noprice")}
                          {row.unmatched.length > 0 ? ` (${row.unmatched.join(", ")})` : ""}
                        </span>
                      )}
                    </td>
                    <td className="tsn-row-cell">
                      <span className="tsn-drill" aria-hidden="true">
                        <DrillArrowIcon />
                      </span>
                      <button
                        type="button"
                        className="tsn-expand"
                        aria-expanded={expandedRow}
                        aria-label={t("dash.row.expand")}
                        onClick={(event) => {
                          event.stopPropagation();
                          setExpandedId(expandedRow ? null : row.id);
                        }}
                      >
                        <ChevronIcon />
                      </button>
                    </td>
                  </tr>
                  {drillFailedId === row.id ? (
                    <tr>
                      <td colSpan={9}>
                        <div className="tsn-note">{t("dash.drill.fallback")}</div>
                      </td>
                    </tr>
                  ) : null}
                  {expandedRow ? (
                    <tr className="tsn-step-row">
                      <td colSpan={9}>
                        <SessionLedgerDetail
                          t={t}
                          row={row}
                          deepState={deepState}
                          onDeep={() => runDeep(row.id)}
                          onClear={() => {
                            clearSessionLedger(ledgerData(), row.id);
                            scheduleLedgerSave();
                            onLedgerCleared();
                          }}
                        />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {menu ? (
        <div className="tsn-ctxmenu" role="menu" style={{ left: menu.x, top: menu.y }} onContextMenu={(event) => event.preventDefault()}>
          <div className="tsn-ctxmenu-id" title={menu.id}>{menu.id}</div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(null);
              if (!onDrill(menu.id)) {
                setDrillFailedId(menu.id);
                setExpandedId(menu.id);
              } else {
                setDrillFailedId(null);
              }
            }}
          >
            {t("dash.row.menu.jump")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={async () => {
              const ok = await copyTextToClipboard(menu.id);
              setMenu(null);
              setLedgerNote(ok ? t("dash.row.menu.copied", { id: menu.id }) : t("dash.row.copy.failed"));
            }}
          >
            {t("dash.row.menu.copy")}
          </button>
        </div>
      ) : null}
    </>
  );
}

/** 行内展开：账本覆盖状态 + 深度补全 + 逐步条目 + 单会话清除。 */
function SessionLedgerDetail({ t, row, deepState, onDeep, onClear }) {
  const session = ledgerData().sessions[row.id];
  const entries = session?.entries ?? [];
  const buckets = session?.buckets ?? [];
  const coverage = session?.coverage ?? {};
  const partial = isPartialCoverage(coverage);
  return (
    <div className="tsn-step">
      <div className="tsn-step-head">
        {!row.covered ? <span className="tsn-note">{t("dash.ledger.none")}</span> : null}
        {row.covered && partial ? (
          <span className="tsn-badge">{t("dash.cost.partial", { note: coverageNote(coverage, t) })}</span>
        ) : null}
        <button type="button" className="tsn-btn tsn-btn-small" disabled={deepState?.busy === true} onClick={onDeep}>
          {deepState?.busy === true ? t("dash.deep.running", { page: deepState.page }) : t("dash.deep.run")}
        </button>
        <button type="button" className="tsn-btn tsn-btn-small" onClick={onClear}>
          {t("dash.ledger.clearSession")}
        </button>
        {deepState?.message ? <span className="tsn-note">{deepState.message}</span> : null}
      </div>
      {entries.length > 0 || buckets.length > 0 ? (
        <div className="tsn-table-wrap">
          <table className="tsn-table">
            <thead>
              <tr>
                <th>{t("stats.col.turn")}</th>
                <th>{t("stats.col.model")}</th>
                {BUCKET_SEGMENTS.map((segment) => (
                  <th key={segment.key} className="tsn-num">{segment.label}</th>
                ))}
                <th>{t("stats.col.time")}</th>
              </tr>
            </thead>
            <tbody>
              {entries.slice(-40).map((entry) => {
                const [turn, step] = entry.k.split(":");
                return (
                  <tr key={entry.k}>
                    <td>#{turn}.{step}</td>
                    <td>{entry.m || "—"}</td>
                    {BUCKET_SEGMENTS.map((segment) => (
                      <td key={segment.key} className="tsn-num">{formatTokens(entry.u[segment.key] ?? 0)}</td>
                    ))}
                    <td>{fmtDateTime(entry.st ?? entry.t)}</td>
                  </tr>
                );
              })}
              {buckets.map((bucket) => (
                <tr key={`aged:${bucket.d}:${bucket.m}`}>
                  <td title={t("dash.chart.dailyCostSub")}>{bucket.d}（老化桶 ×{bucket.n}）</td>
                  <td>{bucket.m || "—"}</td>
                  {BUCKET_SEGMENTS.map((segment) => (
                    <td key={segment.key} className="tsn-num">{formatTokens(bucket.u[segment.key] ?? 0)}</td>
                  ))}
                  <td>{bucket.d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function coverageNote(coverage, t) {
  const parts = [];
  if (coverage.windowFull === false) parts.push(`${t("stats.col.turn")} ${coverage.turnFrom ?? "?"}–${coverage.turnTo ?? "?"}`);
  if (coverage.deepFromSeq !== void 0 || coverage.deepToSeq !== void 0) {
    parts.push(`seq ${coverage.deepFromSeq ?? "?"}–${coverage.deepToSeq ?? "?"}`);
  }
  return parts.join(" · ") || "—";
}

/* 按时间页签：颗粒度切换（日/月/年）+ 双口径分桶 + 账本费用线。
   颗粒度只改变分桶键与窗口（日=近30天 / 月=近12个自然月 / 年=不限），
   双口径语义与费用逐步计费口径不变。 */
const TIME_GRANULARITIES = ["day", "month", "year"];

function TimeTab({ t, trendRows, trendCostPoints, costCurrency, anyCovered, granularity = "day", onGranularityChange }) {
  return (
    <>
      <Footnote>{t("dash.time.caliber")}</Footnote>
      <div className="tsn-dash-toolbar">
        <div className="tsn-seg" role="group" aria-label={t("dash.time.granularity")}>
          {TIME_GRANULARITIES.map((key) => (
            <button
              key={key}
              type="button"
              className="tsn-btn tsn-btn-small"
              data-active={granularity === key || void 0}
              aria-pressed={granularity === key}
              onClick={() => onGranularityChange?.(key)}
            >
              {t(`dash.time.g.${key}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="tsn-dash-grid">
        <ChartCard
          title={t(`dash.time.trendTitle.${granularity}`)}
          subtitle={t("dash.chart.trendSub")}
          alt={{ summaryLabel: t("stats.chart.tableAlt"), table: <TimeAltTable t={t} rows={trendRows} /> }}
        >
          <DailyStackedChart days={trendRows} ariaLabel={t(`dash.time.trendTitle.${granularity}`)} />
        </ChartCard>
        {anyCovered ? (
          <ChartCard title={t(`dash.time.costTitle.${granularity}`)} subtitle={t("dash.chart.dailyCostSub")} className="tsn-dash-grid-span">
            <DailyCostChart points={trendCostPoints} currency={costCurrency} />
            <table className="tsn-table">
              <tbody>
                {trendCostPoints.map((point) => (
                  <tr key={point.day}>
                    <td>{point.day}</td>
                    <td className="tsn-num"><span className="tsn-money">{formatMoney(point.cost, costCurrency)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ChartCard>
        ) : null}
      </div>
    </>
  );
}

function TimeAltTable({ t, rows }) {
  return (
    <table className="tsn-table">
      <thead>
        <tr>
          <th>{t("dash.col.activity")}</th>
          {BUCKET_SEGMENTS.map((segment) => (
            <th key={segment.key} className="tsn-num">{segment.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.day}>
            <td>
              {row.day === "older" ? t("dash.date.older") : row.day}
              {row.source === "recent" ? `（${t("dash.time.byRecent")}）` : ""}
            </td>
            {BUCKET_SEGMENTS.map((segment) => (
              <td key={segment.key} className="tsn-num">{formatTokens(row.buckets[segment.key] ?? 0)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* 按模型页签：账本聚合 + 「未分类」行（token 列附比例色条）。 */
function ModelsTab({ t, rows, currency }) {
  const bucketMax = useMemo(() => {
    const maxes = {};
    for (const segment of BUCKET_SEGMENTS) {
      maxes[segment.key] = rows.reduce((max, row) => Math.max(max, row.buckets?.[segment.key] ?? 0), 0);
    }
    return maxes;
  }, [rows]);
  const totalMax = useMemo(() => rows.reduce((max, row) => Math.max(max, row.total ?? 0), 0), [rows]);
  return (
    <>
      <Footnote>{t("dash.models.caliber")}</Footnote>
      <div className="tsn-table-wrap">
        <table className="tsn-table">
          <thead>
            <tr>
              <th>{t("stats.col.model")}</th>
              {BUCKET_SEGMENTS.map((segment) => (
                <th key={segment.key} className="tsn-num">{segment.label}</th>
              ))}
              <th className="tsn-num">{t("dash.col.total")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.model ?? "__unclassified__"}>
                <td className="tsn-title-cell">{row.model === null || row.model === "" ? t("dash.model.unclassified") : row.model}</td>
                {BUCKET_SEGMENTS.map((segment) => (
                  <td key={segment.key} className="tsn-num">
                    <DataBar
                      ratio={bucketMax[segment.key] > 0 ? (row.buckets?.[segment.key] ?? 0) / bucketMax[segment.key] : 0}
                      tone={segment.color}
                    >
                      {formatTokens(row.buckets?.[segment.key] ?? 0)}
                    </DataBar>
                  </td>
                ))}
                <td className="tsn-num">
                  <DataBar ratio={totalMax > 0 ? (row.total ?? 0) / totalMax : 0}>
                    {formatTokens(row.total ?? 0)}
                  </DataBar>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="tsn-hbars">
        <HBars items={rows.map((row) => ({ label: row.model === null || row.model === "" ? t("dash.model.unclassified") : row.model, value: row.total }))} />
      </div>
    </>
  );
}

/* 价格表页签（归宿 A）：维护入口 + 账本管理（备份 / 恢复）。 */
function PricingTab({ t, onLedgerCleared, ledgerNote, onNote }) {
  const ledger = ledgerData();
  const sessionCount = Object.keys(ledger.sessions).length;
  const fileInputRef = useRef(null);
  return (
    <>
      <Card title={t("settings.title")}>
        <PriceSettingsRow t={t} />
      </Card>
      <Card title={t("dash.ledger.manage")} subtitle={t("dash.ledger.manageNote", { key: LEDGER_STORE_KEY })}>
        <div className="tsn-row-actions">
          <span className="tsn-note">
            {t("dash.kpi.costSub", { covered: sessionCount, count: sessionCount })}
          </span>
          <button
            type="button"
            className="tsn-btn tsn-btn-small"
            onClick={() => {
              const result = exportLedgerBackup();
              onNote?.(result.ok ? t("dash.ledger.export.done", { sessions: result.sessions }) : t("dash.ledger.export.failed"));
            }}
          >
            {t("dash.ledger.export")}
          </button>
          <button type="button" className="tsn-btn tsn-btn-small" onClick={() => fileInputRef.current?.click()}>
            {t("dash.ledger.import")}
          </button>
          <button
            type="button"
            className="tsn-btn tsn-btn-small"
            onClick={() => {
              clearAllLedger(ledgerData());
              scheduleLedgerSave();
              onLedgerCleared();
            }}
          >
            {t("dash.ledger.clearAll")}
          </button>
          {ledgerNote ? <span className="tsn-note">{ledgerNote}</span> : null}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          style={{ display: "none" }}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file || !onNote) return;
            file
              .text()
              .then((text) => {
                const parsed = parseLedgerBackup(text);
                if (!parsed.ok) {
                  onNote(t("dash.ledger.import.bad"));
                  return;
                }
                replaceLedgerData(parsed.ledger);
                scheduleLedgerSave();
                notifyLedgerChanged();
                onNote(t("dash.ledger.import.ok", { sessions: parsed.sessions }));
              })
              .catch(() => onNote(t("dash.ledger.import.bad")));
          }}
        />
      </Card>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 视图 1：第三页签「Token 统计」
 * ------------------------------------------------------------------ */

/* 视图 1 的 KPI 卡已统一到共享套件 stats-ui.jsx 的 KpiCard（视觉同款 + 副注）。 */

/**
 * 上下文压力分档（design D9）：宿主档位字段（level/stage）优先——已核实当前
 * contextPressure 投影 schema .strict() 不携带该字段，恒走插件阈值回退
 * （70% warn / 90% error，design D9 默认值）。
 */
function pressureLevelOf(pressure, percent) {
  const hostLevel =
    typeof pressure?.level === "string" ? pressure.level : typeof pressure?.stage === "string" ? pressure.stage : null;
  if (hostLevel) {
    const normalized = hostLevel.toLowerCase();
    if (normalized === "error" || normalized === "critical") return "error";
    if (normalized === "warn" || normalized === "warning") return "warn";
    return "ok";
  }
  if (percent === null) return "ok";
  if (percent >= 90) return "error";
  if (percent >= 70) return "warn";
  return "ok";
}

function ContextCard({ pressure, breakdown, t }) {
  const used = pressure?.projectedTokens ?? pressure?.pressureTokens;
  const window = pressure?.contextWindow;
  const percent =
    typeof used === "number" && typeof window === "number" && window > 0
      ? Math.min(100, Math.round((used / window) * 100))
      : null;
  const level = pressureLevelOf(pressure, percent);
  const layout = contextBreakdownLayout(breakdown);
  return (
    <div className="tsn-card" data-level={level !== "ok" ? level : void 0}>
      <div className="tsn-card-title">{t("stats.context.title")}</div>
      <div className="tsn-kpi-value">
        {percent === null
          ? "—"
          : t("stats.context.figures", { used: formatTokens(used), window: formatTokens(window), percent })}
      </div>
      <div className="tsn-ctxbar" role="img" aria-label={t("stats.context.title")}>
        {layout.segments.map((segment) => (
          <span
            key={segment.key}
            className="tsn-ctxseg"
            style={{ width: `${Math.max(2, segment.percent)}%`, background: segment.color }}
          >
            <title>{`${segment.label} ${formatTokens(segment.value)}`}</title>
          </span>
        ))}
      </div>
      <dl className="tsn-ctxlegend">
        {layout.segments.map((segment) => (
          <div className="tsn-ctxrow" key={segment.key}>
            <dt>
              <i className="tsn-swatch" style={{ background: segment.color }} />
              {segment.label}
            </dt>
            <dd>
              {formatTokens(segment.value)}
              <span className="tsn-ctx-pct"> · {Math.round(segment.percent)}%</span>
            </dd>
          </div>
        ))}
      </dl>
      <div className="tsn-note">{t("stats.context.note")}</div>
    </div>
  );
}

function StackedBarsChart({ rows, onJump, t }) {
  const layout = useMemo(() => stackedBarsLayout(rows), [rows]);
  if (layout.bars.length === 0) return null;
  return (
    <svg
      className="tsn-chart"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="img"
      aria-label={t("stats.chart.tokensTitle")}
    >
      {layout.ticks.map((tick) => (
        <g key={tick.y}>
          <line x1={layout.pad.left} x2={layout.width - layout.pad.right} y1={tick.y} y2={tick.y} className="tsn-grid" />
          <text x={layout.pad.left - 4} y={tick.y + 3} textAnchor="end" className="tsn-tick">
            {formatAxisTokens(tick.value)}
          </text>
        </g>
      ))}
      {layout.bars.map((bar) => (
        <g key={bar.turn} className="tsn-bar" onClick={() => onJump(bar.turn)}>
          <title>{`#${bar.turn} · ${formatTokens(bar.total)}`}</title>
          {bar.segments.map((segment) => (
            <rect key={segment.key} x={bar.x} y={segment.y} width={bar.w} height={segment.h} rx="2" style={{ fill: segment.color }}>
              <title>{`${segment.label} ${formatTokens(segment.value)}`}</title>
            </rect>
          ))}
        </g>
      ))}
      {layout.xLabels.map((label) => (
        <text key={label.turn} x={label.x} y={label.y} textAnchor="middle" className="tsn-tick">
          #{label.turn}
        </text>
      ))}
    </svg>
  );
}

function ModelBarsChart({ rows }) {
  const layout = useMemo(() => {
    const totals = new Map();
    for (const row of rows) {
      for (const step of row.steps) {
        if (!step.usage || !step.model) continue;
        const usage = step.usage;
        const total =
          (usage.inputTokens ?? 0) +
          (usage.cacheReadTokens ?? 0) +
          (usage.cacheWriteTokens ?? 0) +
          (usage.outputTokens ?? 0);
        totals.set(step.model, (totals.get(step.model) ?? 0) + total);
      }
    }
    return hBarsLayout([...totals.entries()].map(([label, value]) => ({ label, value })));
  }, [rows]);
  if (layout.rows.length === 0) return null;
  return (
    <div className="tsn-hbars">
      {layout.rows.map((item) => (
        <div className="tsn-hbar-row" key={item.label}>
          <span className="tsn-hbar-label" title={item.label}>{item.label}</span>
          <span className="tsn-hbar-track">
            <span className="tsn-hbar-fill" style={{ width: `${(item.w / item.trackW) * 100}%`, background: item.color }} />
          </span>
          <span className="tsn-hbar-value">{formatTokens(item.value)}</span>
        </div>
      ))}
    </div>
  );
}

function CostLineChart({ rows, currency, t }) {
  const skipped = rows.filter((row) => row.cost === null).length;
  const layout = useMemo(() => {
    let acc = 0;
    const points = [];
    for (const row of rows) {
      if (row.cost === null) continue;
      acc += row.cost;
      points.push({ turn: row.turn, cost: acc });
    }
    return lineLayout(points);
  }, [rows]);
  if (layout.dots.length === 0) return null;
  const last = layout.dots[layout.dots.length - 1];
  return (
    <>
      <svg
        className="tsn-chart"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label={t("stats.chart.costTitle")}
      >
        <defs>
          {/* 渐变 defs id 确定性命名（design D6）：与会话页/总览页两处
              费用折线同色共享 id 无冲突；stop 色经 style 应用 brand 令牌。 */}
          <linearGradient id="tsn-grad-cost" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: "var(--dsw-alias-brand-primary)", stopOpacity: 0.18 }} />
            <stop offset="1" style={{ stopColor: "var(--dsw-alias-brand-primary)", stopOpacity: 0 }} />
          </linearGradient>
        </defs>
        {layout.ticks.map((tick) => (
          <g key={tick.y}>
            <line x1={layout.pad.left} x2={layout.width - layout.pad.right} y1={tick.y} y2={tick.y} className="tsn-grid" />
            <text x={layout.pad.left - 4} y={tick.y + 3} textAnchor="end" className="tsn-tick">
              {formatMoney(tick.cost, currency)}
            </text>
          </g>
        ))}
        {layout.area ? <path d={layout.area} className="tsn-line-area" /> : null}
        <path d={layout.path} className="tsn-line" />
        {layout.dots.map((dot) => (
          <circle key={dot.turn} cx={dot.x} cy={dot.y} r="2.5" className="tsn-dot">
            <title>{`#${dot.turn} · ${formatMoney(dot.cost, currency)}`}</title>
          </circle>
        ))}
        {/* 末点累计值标注（仅已定价轮——layout.dots 只含已定价点，任务 4.3）。 */}
        <text x={last.x} y={Math.max(10, last.y - 6)} textAnchor="end" className="tsn-anno">
          {formatMoney(last.cost, currency)}
        </text>
        <text x={layout.dots[0].x} y={layout.height - 6} textAnchor="middle" className="tsn-tick">
          #{layout.dots[0].turn}
        </text>
        <text x={layout.dots[layout.dots.length - 1].x} y={layout.height - 6} textAnchor="middle" className="tsn-tick">
          #{layout.dots[layout.dots.length - 1].turn}
        </text>
      </svg>
      {skipped > 0 ? <div className="tsn-note">{t("stats.chart.unpricedSkipped", { count: skipped })}</div> : null}
    </>
  );
}

/** 展开态的单步明细行（2.6）。 */
function StepDetailRow({ row, step, stepIndex, stepPrice, t }) {
  const usage = step.usage;
  const ttftMs =
    step.timing && typeof step.timing.stepStartTime === "number" && typeof step.timing.firstTokenTime === "number"
      ? Math.max(0, step.timing.firstTokenTime - step.timing.stepStartTime)
      : null;
  const decodeMs =
    step.timing && typeof step.timing.firstTokenTime === "number"
      ? Math.max(0, step.timing.completedTime - step.timing.firstTokenTime)
      : null;
  const config = step.requestConfig ?? null;
  /* 金额部分亮金强调（用户反馈 #7）；档位/倍数保持正文色。 */
  const priceNode = stepPrice ? (
    <span>
      {"≈ "}
      <span className="tsn-money">{formatMoney(stepPrice.cost, row.currency)}</span>
      {` · ${tierLabel(stepPrice.tier, t)}`}
      {multiplierLabel(stepPrice.multiplier) ? ` · ${multiplierLabel(stepPrice.multiplier)}` : ""}
    </span>
  ) : usage ? (
    <span>
      {t("stats.noprice")}
      {row.unmatched.length > 0 ? ` (${row.unmatched.join(", ")})` : ""}
    </span>
  ) : null;
  return (
    <tr className="tsn-step-row">
      <td colSpan={9}>
        <div className="tsn-step">
          <div className="tsn-step-head">
            <span className="tsn-step-no">step {stepIndex + 1}{step.time ? ` · ${fmtTime(step.time)}` : ""}</span>
            <span className="tsn-step-model">
              {step.model ?? "—"}
              {step.provider ? ` · ${step.provider}` : ""}
            </span>
            {!usage ? <span className="tsn-badge">{t("stats.step.noUsage")}</span> : null}
          </div>
          {usage ? (
            <div className="tsn-step-buckets">
              {BUCKET_SEGMENTS.map((segment) => (
                <span className="tsn-step-bucket" key={segment.key}>
                  <i style={{ background: segment.color }} />
                  {segment.label} {formatTokens(usage[segment.key] ?? 0)}
                </span>
              ))}
            </div>
          ) : null}
          <div className="tsn-step-meta">
            {ttftMs !== null ? <span>{t("stats.step.timing", { ttft: fmtDuration(ttftMs), decode: decodeMs !== null ? fmtDuration(decodeMs) : "—" })}</span> : null}
            {priceNode}
            {config
              ? Object.entries(config).map(([key, value]) => (
                  <span className="tsn-cfg" key={key}>
                    <b>{t("stats.step.config")}: </b>
                    {key}: {Array.isArray(value) ? value.join(", ") : String(value)}
                  </span>
                ))
              : null}
          </div>
        </div>
      </td>
    </tr>
  );
}

/**
 * Token 统计页签（conversation.view 条目组件）。
 * 标准槽 props：sessionId、useSession（会话快照）、useProjection（宿主投影）、
 * t（文案）；条目 inject 提供 loadOlder（经 ctx.get("sessions") 的 SessionFace 调用）。
 * 该页签的折叠结果同时幂等沉淀入本地账本（Tier 1 喂食来源 A，窗口口径）。
 */
const TokenStatsView = function TokenStatsView({ sessionId, useSession, useProjection, t, loadOlder }) {
  const nodes = useSession((s) => s.chat.legacy.nodes);
  const locations = useSession((s) => s.chat.locations);
  const hasMore = useSession((s) => s.hasMore);
  const loadingOlder = useSession((s) => s.loadingOlder);
  /* 轨迹视图快照：requests[] 按 (turn, step) 携带 provenance/requestConfig
     （message.source 在 legacy 节点上被省略，模型信息从这里 join 补全）。 */
  const inspection = useSession((s) => s.views.get("trajectory"));
  const sessionUsage = useProjection("tokenUsage");
  const sessionStats = useProjection("sessionStats");
  const contextPressure = useProjection("contextPressure");
  const contextBreakdown = useProjection("contextBreakdown");

  const priceVersion = usePriceVersion();
  const table = currentPriceTable(priceVersion);
  const [expandedTurn, setExpandedTurn] = useState(null);
  const sentinelRef = useRef(null);

  const rows = useMemo(
    () => joinRequestInsights(foldTurns(nodes), inspection?.requests),
    [nodes, inspection]
  );
  const pricedRows = useMemo(() => priceTurnRows(rows, table), [rows, table]);

  const totalTokens =
    sessionUsage === void 0 ? null : billedInputTokens(sessionUsage) + (sessionUsage.outputTokens ?? 0);
  const cacheHit = sessionUsage === void 0 ? null : cacheHitPercent(sessionUsage);
  const ttftAvg =
    sessionStats && sessionStats.ttftSteps > 0 ? sessionStats.ttftMs / sessionStats.ttftSteps : null;
  const speed =
    sessionStats && sessionStats.decodeMs > 0
      ? sessionStats.decodeTokens / (sessionStats.decodeMs / 1e3)
      : null;
  const pricedValues = pricedRows.filter((row) => row.cost !== null);
  const windowCost = pricedValues.reduce((sum, row) => sum + row.cost, 0);
  const costCurrency = pricedValues[0]?.currency ?? displayCurrencyOf(table);
  const totalTurns = sessionStats?.turns ?? null;
  const loadedTurns = rows.length;

  /* 明细表排序（用户反馈 #5）：仅排序明细表；图表保持时间线（pricedRows 原序）。 */
  const [detailSort, setDetailSort] = useState({ key: "turn", dir: "asc" });
  const toggleDetailSort = (key) => {
    setDetailSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: DETAIL_SORT_DIR[key] ?? "desc" }
    );
  };
  const sortedRows = useMemo(() => {
    const factor = detailSort.dir === "asc" ? 1 : -1;
    return [...pricedRows].sort((a, b) => {
      const va = sortValueOfDetail(a, detailSort.key);
      const vb = sortValueOfDetail(b, detailSort.key);
      const aNull = va === null || va === void 0;
      const bNull = vb === null || vb === void 0;
      if (aNull || bNull) return aNull && bNull ? 0 : aNull ? 1 : -1;
      if (typeof va === "string" || typeof vb === "string") return factor * String(va).localeCompare(String(vb), "zh");
      return factor * (va - vb);
    });
  }, [pricedRows, detailSort]);
  const inMax = useMemo(() => pricedRows.reduce((max, row) => Math.max(max, billedInputTokens(row.usage)), 0), [pricedRows]);
  const outMax = useMemo(() => pricedRows.reduce((max, row) => Math.max(max, row.usage.outputTokens ?? 0), 0), [pricedRows]);

  /* 账本沉淀（喂食来源 A）：折叠行按 (turn, step) 幂等 upsert，窗口完备性
     随快照 hasMore 记录；防抖在 ledgerIngest 内部。 */
  useEffect(() => {
    if (sessionId && rows.length > 0) ledgerIngest(sessionId, rows, { windowFull: !hasMore });
  }, [sessionId, rows, hasMore]);

  /* 2.1 触底自动加载：明细滚动到底部（含缓冲）时按需 loadOlder。 */
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && hasMore && !loadingOlder) loadOlder?.();
        }
      },
      { rootMargin: "160px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadingOlder, loadOlder]);

  const jumpToTurn = (turn) => {
    let key = null;
    try {
      key = locations?.getTurn?.(turn)?.[0] ?? null;
    } catch {
      key = null;
    }
    switchToChatTab();
    scrollToAnchorKey(key);
  };

  if (sessionUsage === void 0 && loadedTurns === 0) {
    return (
      <div className="tsn-root" data-plugin-anchor="token-insight:session-view">
        <div className="tsn-inner">
          <div className="tsn-note tsn-empty">{t("stats.empty")}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="tsn-root" data-plugin-anchor="token-insight:session-view">
      <div className="tsn-inner">
        <div className="tsn-head">
          <div className="tsn-title">{t("stats.title")}</div>
          {/* 覆盖度胶囊（任务 2.2）：N/M 轮 + 微型进度；全量轮数不可知时如实
              呈现仅窗口口径（无进度条、不伪装全覆盖）。口径声明保留在下方相邻
              提示行（stats.window / stats.disclaimer 语义不变）。 */}
          {loadedTurns > 0 ? (
            <span className="tsn-pill">
              {totalTurns === null
                ? t("stats.coverage.windowOnly", { loaded: loadedTurns })
                : t("stats.coverage.window", { loaded: loadedTurns, total: totalTurns })}
              {totalTurns !== null && totalTurns > 0 ? (
                <span className="tsn-pill-track" aria-hidden="true">
                  <span
                    className="tsn-pill-fill"
                    style={{ width: `${Math.min(100, Math.max(2, Math.round((loadedTurns / totalTurns) * 100)))}%` }}
                  />
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
        <div className="tsn-kpis">
          <KpiCard label={t("stats.kpi.total")} value={totalTokens === null ? "—" : formatTokens(totalTokens)} />
          <KpiCard
            label={t("stats.kpi.billedIn")}
            value={sessionUsage === void 0 ? "—" : formatTokens(billedInputTokens(sessionUsage))}
          />
          <KpiCard
            label={t("stats.kpi.out")}
            value={sessionUsage === void 0 ? "—" : formatTokens(sessionUsage.outputTokens ?? 0)}
          />
          <KpiCard
            label={t("stats.kpi.cacheHit")}
            value={cacheHit === null ? "—" : `${Math.round(cacheHit * 10) / 10}%`}
          />
        </div>
        <div className="tsn-kpis tsn-kpis--compact">
          <KpiCard label={t("stats.kpi.ttft")} value={ttftAvg === null ? "—" : fmtDuration(ttftAvg)} />
          <KpiCard label={t("stats.kpi.speed")} value={speed === null ? "—" : `${fmtSpeed(speed)} tok/s`} />
          <KpiCard
            label={t("stats.kpi.cost")}
            value={
              pricedValues.length > 0 ? (
                <span className="tsn-money">{formatMoney(windowCost, costCurrency)}</span>
              ) : loadedTurns > 0 ? (
                t("stats.noprice")
              ) : (
                "—"
              )
            }
          />
        </div>
        <ContextCard pressure={contextPressure} breakdown={contextBreakdown} t={t} />
        <div className="tsn-note">
          {totalTurns === null
            ? t("stats.windowFull", { loaded: loadedTurns })
            : t("stats.window", { loaded: loadedTurns, total: totalTurns })}{" "}
          {t("stats.disclaimer")}
        </div>
        <div className="tsn-load">
          {hasMore ? (
            <button type="button" className="tsn-btn tsn-btn-small" disabled={loadingOlder} onClick={() => loadOlder?.()}>
              {loadingOlder ? t("stats.loadingOlder") : t("stats.loadOlder")}
            </button>
          ) : null}
        </div>

        {pricedRows.length > 0 ? (
          <div className="tsn-charts">
            <section className="tsn-card tsn-span2">
              <div className="tsn-card-title">{t("stats.chart.tokensTitle")}</div>
              <StackedBarsChart rows={rows} onJump={jumpToTurn} t={t} />
              <details className="tsn-alt">
                <summary>{t("stats.chart.tableAlt")}</summary>
                <table className="tsn-table">
                  <thead>
                    <tr>
                      <th>{t("stats.col.turn")}</th>
                      {BUCKET_SEGMENTS.map((segment) => (
                        <th key={segment.key}>{segment.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.turn}>
                        <td>#{row.turn}</td>
                        {BUCKET_SEGMENTS.map((segment) => (
                          <td key={segment.key}>{formatTokens(row.usage[segment.key] ?? 0)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </section>
            <section className="tsn-card">
              <div className="tsn-card-title">{t("stats.chart.modelsTitle")}</div>
              <ModelBarsChart rows={rows} />
              <details className="tsn-alt">
                <summary>{t("stats.chart.tableAlt")}</summary>
                <table className="tsn-table">
                  <tbody>
                    {[...new Map(rows.flatMap((row) => row.steps).filter((step) => step.usage && step.model).map((step) => {
                      const usage = step.usage;
                      return [step.model, (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + (usage.outputTokens ?? 0)];
                    })).entries()].map(([model, value]) => (
                      <tr key={model}>
                        <td>{model}</td>
                        <td className="tsn-num">{formatTokens(value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </section>
            <section className="tsn-card">
              <div className="tsn-card-title">{t("stats.chart.costTitle")}</div>
              <CostLineChart rows={pricedRows} currency={costCurrency} t={t} />
              <details className="tsn-alt">
                <summary>{t("stats.chart.tableAlt")}</summary>
                <table className="tsn-table">
                  <tbody>
                    {(() => {
                      let acc = 0;
                      return pricedRows
                        .filter((row) => row.cost !== null)
                        .map((row) => {
                          acc += row.cost;
                          return (
                            <tr key={row.turn}>
                              <td>#{row.turn}</td>
                              <td className="tsn-num"><span className="tsn-money">{formatMoney(acc, costCurrency)}</span></td>
                            </tr>
                          );
                        });
                    })()}
                  </tbody>
                </table>
              </details>
            </section>
          </div>
        ) : null}

        <div className="tsn-table-wrap">
          <table className="tsn-table">
            <thead>
              <tr>
                <th aria-label="expand" />
                <SortHeader label={t("stats.col.turn")} sortKey="turn" sort={detailSort} onSort={toggleDetailSort} />
                <SortHeader label={t("stats.col.time")} sortKey="time" sort={detailSort} onSort={toggleDetailSort} />
                <SortHeader label={t("stats.col.title")} sortKey="title" sort={detailSort} onSort={toggleDetailSort} />
                <SortHeader label={t("stats.col.model")} sortKey="model" sort={detailSort} onSort={toggleDetailSort} />
                <SortHeader className="tsn-num" label={t("stats.col.in")} sortKey="in" sort={detailSort} onSort={toggleDetailSort} />
                <SortHeader className="tsn-num" label={t("stats.col.out")} sortKey="out" sort={detailSort} onSort={toggleDetailSort} />
                <SortHeader className="tsn-num" label={t("stats.col.cache")} sortKey="cache" sort={detailSort} onSort={toggleDetailSort} />
                <SortHeader className="tsn-num" label={t("stats.col.cost")} sortKey="cost" sort={detailSort} onSort={toggleDetailSort} />
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row) => {
                const hit = cacheHitPercent(row.usage);
                const expanded = expandedTurn === row.turn;
                return (
                  <Fragment key={row.turn}>
                    <tr
                      className="tsn-row"
                      title={t("stats.jumpHint")}
                      onClick={() => jumpToTurn(row.turn)}
                    >
                      <td>
                        <button
                          type="button"
                          className="tsn-expand"
                          aria-expanded={expanded}
                          aria-label={t("stats.col.turn") + " " + row.turn}
                          onClick={(event) => {
                            event.stopPropagation();
                            setExpandedTurn(expanded ? null : row.turn);
                          }}
                        >
                          <ChevronIcon />
                        </button>
                      </td>
                      <td>#{row.turn}</td>
                      <td>{fmtTime(row.startTime)}</td>
                      <td className="tsn-title-cell">{row.title}</td>
                      <td>
                        {row.models.length > 0 ? (
                          <span className="tsn-model" title={row.models.join(", ")}>
                            {row.models.join(", ")}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="tsn-num">
                        <DataBar ratio={inMax > 0 ? billedInputTokens(row.usage) / inMax : 0}>
                          {formatTokens(billedInputTokens(row.usage))}
                        </DataBar>
                      </td>
                      <td className="tsn-num">
                        <DataBar ratio={outMax > 0 ? (row.usage.outputTokens ?? 0) / outMax : 0}>
                          {formatTokens(row.usage.outputTokens)}
                        </DataBar>
                      </td>
                      <td className="tsn-num">{hit === null ? "—" : `${Math.round(hit)}%`}</td>
                      <td className="tsn-num">
                        {row.cost === null ? (
                          <span className="tsn-muted">
                            {t("stats.noprice")}
                            {row.unmatched.length > 0 ? ` (${row.unmatched.join(", ")})` : ""}
                          </span>
                        ) : (
                          <span className="tsn-money">{formatMoney(row.cost, row.currency ?? costCurrency)}</span>
                        )}
                      </td>
                    </tr>
                    {expanded
                      ? row.steps.map((step, index) => (
                          <StepDetailRow
                            key={`${row.turn}:${index}`}
                            row={row}
                            step={step}
                            stepIndex={index}
                            stepPrice={row.stepPrices[index] ?? null}
                            t={t}
                          />
                        ))
                      : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <div ref={sentinelRef} aria-hidden="true" />
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ *
 * 视图 2：回复结尾的轻量 token 显示（turnTail chain 条目）
 * ------------------------------------------------------------------ */

/** chip 悬停摘要：模型、四桶、费用与命中档/折扣（规格「悬停查看该轮计价依据」）。 */
function chipSummary(row, priced, t) {
  const usage = row.usage;
  const lines = [
    `${t("chip.models")}: ${row.models.join(", ") || "—"}`,
    `${t("stats.col.in")} ${formatTokens(billedInputTokens(usage))}` +
      `（${formatTokens(usage.inputTokens ?? 0)} + ${formatTokens(usage.cacheReadTokens ?? 0)} + ${formatTokens(usage.cacheWriteTokens ?? 0)}）` +
      ` · ${t("stats.col.out")} ${formatTokens(usage.outputTokens ?? 0)}`
  ];
  if (priced.cost !== null) {
    const hits = priced.stepPrices.filter(Boolean);
    const tiers = [...new Set(hits.map((step) => tierLabel(step.tier, t)))];
    const multipliers = [...new Set(hits.map((step) => multiplierLabel(step.multiplier)).filter(Boolean))];
    lines.push(
      `≈ ${formatMoney(priced.cost, priced.currency)}` +
        (tiers.length > 0 ? ` · ${tiers.join(" / ")}` : "") +
        (multipliers.length > 0 ? ` · ${multipliers.join(" / ")}` : "")
    );
  } else {
    lines.push(
      `${t("stats.noprice")}${priced.unmatched.length > 0 ? ` (${priced.unmatched.join(", ")})` : ""}`
    );
  }
  return lines.join("\n");
}

/**
 * 轮尾部 token 显示（conversation.chat.assistant-actions 列表槽条目）。
 * 槽 owner：{ messageId }（轮尾收束消息的稳定 id）+ 标准 props（useSession…）。
 * 渲染在官方功能行内部：复制 → [反馈按钮(order 10)] → [本 chip(order 20)] → 分支 →
 * timeEnd（时钟·耗时·首字·速度）。list 槽全部条目并存渲染，不经 chain 选举，
 * 与 turnTail 上的「产出文件」条目互不抢占。
 * 常态显示三段：耗时（轮起点→终点，turnTimings，与官方 runMs 同源）·
 * ≈费用 · token 总量（↑计费输入 ↓输出）；完整计价依据（模型、四桶、命中档/
 * 折扣）在悬停 title。该轮无 usage 报告（中断/失败/纯命令轮）→ 不渲染。
 */
const AssistantActionsTokenChip = function AssistantActionsTokenChip({ sessionId, messageId, useSession, t }) {
  const nodes = useSession((s) => s.chat.legacy.nodes);
  const turnTimings = useSession((s) => s.turnTimings);
  const inspection = useSession((s) => s.views.get("trajectory"));
  const priceVersion = usePriceVersion();
  /* messageId → 轮号：收束消息的节点反查（finalized assistant 节点携带 messageId）。 */
  const turnNo = useMemo(() => {
    for (const node of nodes) {
      if (node.kind === "assistant" && node.messageId === messageId) return node.turn;
    }
    return null;
  }, [nodes, messageId]);
  const row = useMemo(() => {
    if (turnNo === null) return null;
    const joined = joinRequestInsights(foldTurns(nodes), inspection?.requests);
    return joined.find((item) => item.turn === turnNo) ?? null;
  }, [nodes, inspection, turnNo]);
  const table = currentPriceTable(priceVersion);
  /* 账本沉淀（喂食来源 A 的旁路）：chip 所在会话未打开统计页签时也能逐轮
     沉淀（windowFull=null = 不携带窗口完备性信息，不改动既有覆盖标注）。 */
  useEffect(() => {
    if (sessionId && row) ledgerIngest(sessionId, [row], { windowFull: null });
  }, [sessionId, row]);
  if (!row || !row.hasUsage) return null;
  const priced = priceTurnRows([row], table)[0];
  const timing = turnNo === null ? void 0 : turnTimings?.get(turnNo);
  const runMs =
    timing && typeof timing.endTime === "number" ? Math.max(0, timing.endTime - timing.startTime) : null;
  const inTokens = billedInputTokens(row.usage);
  const outTokens = row.usage.outputTokens ?? 0;
  const dot = (
    <span className="tsn-chip-dot" aria-hidden="true">
      ·
    </span>
  );
  return (
    <span className="tsn-chip" title={chipSummary(row, priced, t)}>
      {runMs !== null ? (
        <>
          ⏱{fmtDuration(runMs)}
          {dot}
        </>
      ) : null}
      {priced.cost !== null ? (
        <span className="tsn-money">≈{formatMoney(priced.cost, priced.currency ?? "CNY")}</span>
      ) : (
        t("stats.noprice")
      )}
      {dot}
      <span className="tsn-token">{formatTokens(inTokens + outTokens)}</span>{" "}
      <span aria-hidden="true">(↑{formatTokens(inTokens)} ↓{formatTokens(outTokens)})</span>
    </span>
  );
};

/* ------------------------------------------------------------------ *
 * 视图 3：价格表维护入口（总览页「价格表」页签专用；原 settings.general.item
 * 行契约随入口迁移废弃——卡片标题由外层 Card 承担，行内不再重复标题，
 * 编辑按钮置于行首左侧。）
 * ------------------------------------------------------------------ */

const PriceSettingsRow = function PriceSettingsRow({ t }) {
  const priceVersion = usePriceVersion();
  const table = currentPriceTable(priceVersion);
  return (
    <div className="tsn-pricing-row">
      <button
        type="button"
        className="tsn-btn"
        onClick={() => window.dispatchEvent(new CustomEvent(PRICES_EDIT_EVENT))}
      >
        {t("settings.edit")}
      </button>
      <span className="tsn-note">
        {t("settings.note", { count: table.length, currency: displayCurrencyOf(table) })}
      </span>
    </div>
  );
};

/* ------------------------------------------------------------------ *
 * 视图 4：价目表编辑弹窗（shell.overlay 条目，tasks 3.1-3.4）
 * ------------------------------------------------------------------ */

/** apply 时捕获的插件 ctx（编辑器的会话样例采样用；root 作用域无 useSession）。 */
let pluginCtx = null;

function cloneTable(table) {
  return JSON.parse(JSON.stringify(table));
}

function updateEntry(draft, index, updater) {
  return draft.map((entry, i) => (i === index ? updater(entry) : entry));
}

function updateTierPrices(tier, bucket, value) {
  return { ...tier, [bucket]: value };
}

const PriceEditorOverlay = function PriceEditorOverlay({ useSessions, t }) {
  const currentId = useSessions((s) => s.current);
  const addressedSubagent = useSessions((s) => s.currentAddress !== void 0);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(null);
  const [selected, setSelected] = useState(0);
  const [importText, setImportText] = useState("");
  const [error, setError] = useState(null);
  const [catalog, setCatalog] = useState(null);

  useEffect(() => {
    const onEdit = () => {
      setDraft(cloneTable(loadPriceTable(typeof localStorage === "undefined" ? null : localStorage)));
      setSelected(0);
      setImportText("");
      setError(null);
      setOpen(true);
    };
    window.addEventListener(PRICES_EDIT_EVENT, onEdit);
    return () => window.removeEventListener(PRICES_EDIT_EVENT, onEdit);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  /* ESC 分层标记：编辑器在场时总览页的页面级 ESC 不动作（先内层弹窗后页面）。 */
  useEffect(() => {
    if (!open) return void 0;
    priceEditorDepth += 1;
    return () => {
      priceEditorDepth = Math.max(0, priceEditorDepth - 1);
    };
  }, [open]);

  /* 模型目录（对齐 DSH 配置的模型清单）：session.models RPC，普通会话可用，
     addressed 子会话拒绝（agent-busy）——回退手动输入。失败静默降级。 */
  useEffect(() => {
    if (!open || !currentId || addressedSubagent || !pluginCtx) {
      setCatalog(null);
      return;
    }
    let alive = true;
    try {
      pluginCtx
        .get("connection")
        ?.api?.sessions?.models({ sessionId: currentId })
        .then(({ result }) => {
          if (alive) setCatalog(result?.ok ? result.value : null);
        })
        .catch(() => {
          if (alive) setCatalog(null);
        });
    } catch {
      setCatalog(null);
    }
    return () => {
      alive = false;
    };
  }, [open, currentId, addressedSubagent]);

  /* 3.4 实时预览：打开时对当前会话的已加载窗口折叠一次，随草稿重算。 */
  const sampleRows = useMemo(() => {
    if (!open) return [];
    try {
      const snapshot = pluginCtx?.get?.("sessions")?.binding?.(currentId)?.session?.getSnapshot?.();
      return foldTurns(snapshot?.chat?.legacy?.nodes ?? []);
    } catch {
      return [];
    }
  }, [open, currentId]);
  const previewRows = useMemo(
    () => (open && draft ? priceTurnRows(sampleRows, draft) : []),
    [open, sampleRows, draft]
  );

  if (!open || !draft) return null;

  const entry = draft[Math.min(selected, draft.length - 1)];
  const entryIndex = draft.indexOf(entry);

  const numberValue = (event) => {
    const parsed = Number(event.target.value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const save = () => {
    if (savePriceTable(typeof localStorage === "undefined" ? null : localStorage, draft)) {
      window.dispatchEvent(new CustomEvent(PRICES_CHANGED_EVENT));
      setOpen(false);
    } else {
      setError(t("editor.invalid"));
    }
  };

  const doImport = () => {
    try {
      const parsed = validatePriceTable(JSON.parse(importText));
      if (!parsed) {
        setError(t("editor.invalid"));
        return;
      }
      setDraft(parsed);
      setSelected(0);
      setError(null);
    } catch {
      setError(t("editor.invalid"));
    }
  };

  return (
    <div className="tsn-modal-root" role="dialog" aria-modal="true" aria-label={t("editor.title")} data-plugin-anchor="token-insight:price-editor">
      <div className="tsn-modal-mask" onClick={() => setOpen(false)} />
      <div className="tsn-modal">
        <div className="tsn-modal-head">
          <div className="tsn-modal-title">{t("editor.title")}</div>
          <button type="button" className="tsn-modal-close" aria-label={t("editor.cancel")} onClick={() => setOpen(false)}>
            <CloseIcon />
          </button>
        </div>
        <div className="tsn-modal-body">
          <section className="tsn-section">
            <div className="tsn-section-label">{t("editor.entries")}</div>
            <div className="tsn-entry-list">
              {draft.map((item, index) => (
                <div
                  className="tsn-entry-row"
                  key={`${item.model}:${index}`}
                  data-active={index === entryIndex}
                  onClick={() => setSelected(index)}
                >
                  <span className="tsn-entry-model">{item.model || "—"}</span>
                  <span className="tsn-entry-meta">
                    {item.currency}
                    {item.provider ? ` · ${item.provider}` : ""}
                  </span>
                  <button
                    type="button"
                    className="tsn-btn tsn-btn-small"
                    onClick={(event) => {
                      event.stopPropagation();
                      if (draft.length > 1) {
                        setDraft(draft.filter((_, i) => i !== index));
                        setSelected(0);
                      }
                    }}
                  >
                    {t("editor.remove")}
                  </button>
                </div>
              ))}
            </div>
            <div className="tsn-row-actions">
              <button
                type="button"
                className="tsn-btn tsn-btn-small"
                onClick={() => {
                  setDraft([
                    ...draft,
                    {
                      model: "*",
                      provider: "",
                      currency: displayCurrencyOf(draft),
                      unit: "MTok",
                      defaultTier: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
                      tiers: [],
                      timeWindows: [],
                      discount: 1
                    }
                  ]);
                  setSelected(draft.length);
                }}
              >
                {t("editor.addEntry")}
              </button>
            </div>
          </section>

          <section className="tsn-section">
            <div className="tsn-section-label">{t("editor.entry", { index: entryIndex + 1 })}</div>
            {catalog ? (
              <>
                <datalist id="tsn-model-options">
                  {catalog.groups.flatMap((group) =>
                    (group.models ?? []).map((model) => (
                      <option key={`${group.id}:${model.id}`} value={model.id}>
                        {group.name} · {model.name}
                      </option>
                    ))
                  )}
                </datalist>
                {catalog.current ? (
                  <div className="tsn-row-actions">
                    <span className="tsn-note">
                      {t("editor.catalog.current", {
                        provider: catalog.current.provider,
                        model: catalog.current.model
                      })}
                    </span>
                    <button
                      type="button"
                      className="tsn-btn tsn-btn-small"
                      onClick={() =>
                        setDraft(
                          updateEntry(draft, entryIndex, (item) => ({
                            ...item,
                            model: catalog.current.model,
                            provider: catalog.current.provider
                          }))
                        )
                      }
                    >
                      {t("editor.catalog.apply")}
                    </button>
                  </div>
                ) : null}
              </>
            ) : addressedSubagent ? (
              <div className="tsn-note">{t("editor.catalog.unavailable")}</div>
            ) : null}
            <div className="tsn-form-grid">
              <div className="tsn-field">
                <label>{t("editor.entry.model")}</label>
                <input
                  className="tsn-input"
                  list={catalog ? "tsn-model-options" : void 0}
                  value={entry.model}
                  onChange={(event) =>
                    setDraft(updateEntry(draft, entryIndex, (item) => ({ ...item, model: event.target.value })))
                  }
                />
              </div>
              <div className="tsn-field">
                <label>{t("editor.entry.provider")}</label>
                <input
                  className="tsn-input"
                  value={entry.provider}
                  onChange={(event) =>
                    setDraft(updateEntry(draft, entryIndex, (item) => ({ ...item, provider: event.target.value })))
                  }
                />
              </div>
              <div className="tsn-field">
                <label>{t("editor.entry.currency")}</label>
                <input
                  className="tsn-input"
                  value={entry.currency}
                  onChange={(event) =>
                    setDraft(
                      updateEntry(draft, entryIndex, (item) => ({
                        ...item,
                        currency: event.target.value.toUpperCase()
                      }))
                    )
                  }
                />
              </div>
              <div className="tsn-field">
                <label>{t("editor.discount")}</label>
                <input
                  className="tsn-input"
                  type="number" min="0" step="0.05"
                  value={entry.discount}
                  onChange={(event) =>
                    setDraft(updateEntry(draft, entryIndex, (item) => ({ ...item, discount: numberValue(event) })))
                  }
                />
              </div>
            </div>
            <div className="tsn-section-label">{t("editor.defaultTier")} · {t("editor.buckets")}</div>
            <div className="tsn-form-grid">
              {BUCKETS.map((bucket) => (
                <div className="tsn-field" key={bucket}>
                  <label>{t(`editor.bucket.${bucket}`)}</label>
                  <input
                    className="tsn-input"
                    type="number" min="0" step="any"
                    value={entry.defaultTier?.[bucket] ?? 0}
                    onChange={(event) =>
                      setDraft(
                        updateEntry(draft, entryIndex, (item) => ({
                          ...item,
                          defaultTier: updateTierPrices(item.defaultTier ?? {}, bucket, numberValue(event))
                        }))
                      )
                    }
                  />
                </div>
              ))}
            </div>
          </section>

          <section className="tsn-section">
            <div className="tsn-section-label">{t("editor.tiers")}</div>
            {(entry.tiers ?? []).map((tier, tierIndex) => (
              <div className="tsn-tier-row" key={tierIndex}>
                <div className="tsn-form-grid">
                  <div className="tsn-field">
                    <label>{t("editor.tier.ctx")}</label>
                    <input
                      className="tsn-input"
                      type="number" min="0" step="any"
                      value={tier.minContextTokens ?? ""}
                      onChange={(event) =>
                        setDraft(
                          updateEntry(draft, entryIndex, (item) => ({
                            ...item,
                            tiers: item.tiers.map((current, i) =>
                              i === tierIndex
                                ? { ...current, minContextTokens: event.target.value === "" ? null : numberValue(event) }
                                : current
                            )
                          }))
                        )
                      }
                    />
                  </div>
                  <div className="tsn-field">
                    <label>{t("editor.tier.cumulative")}</label>
                    <input
                      className="tsn-input"
                      type="number" min="0" step="any"
                      value={tier.minCumulativeTokens ?? ""}
                      onChange={(event) =>
                        setDraft(
                          updateEntry(draft, entryIndex, (item) => ({
                            ...item,
                            tiers: item.tiers.map((current, i) =>
                              i === tierIndex
                                ? { ...current, minCumulativeTokens: event.target.value === "" ? null : numberValue(event) }
                                : current
                            )
                          }))
                        )
                      }
                    />
                  </div>
                  {BUCKETS.map((bucket) => (
                    <div className="tsn-field" key={bucket}>
                      <label>{t(`editor.bucket.${bucket}`)}</label>
                      <input
                        className="tsn-input"
                        type="number" min="0" step="any"
                        value={tier[bucket] ?? 0}
                        onChange={(event) =>
                          setDraft(
                            updateEntry(draft, entryIndex, (item) => ({
                              ...item,
                              tiers: item.tiers.map((current, i) =>
                                i === tierIndex ? updateTierPrices(current, bucket, numberValue(event)) : current
                              )
                            }))
                          )
                        }
                      />
                    </div>
                  ))}
                </div>
                <div className="tsn-row-actions">
                  <button
                    type="button"
                    className="tsn-btn tsn-btn-small"
                    onClick={() =>
                      setDraft(
                        updateEntry(draft, entryIndex, (item) => ({
                          ...item,
                          tiers: item.tiers.filter((_, i) => i !== tierIndex)
                        }))
                      )
                    }
                  >
                    {t("editor.remove")}
                  </button>
                </div>
              </div>
            ))}
            <div className="tsn-row-actions">
              <button
                type="button"
                className="tsn-btn tsn-btn-small"
                onClick={() =>
                  setDraft(
                    updateEntry(draft, entryIndex, (item) => ({
                      ...item,
                      tiers: [
                        ...(item.tiers ?? []),
                        { minContextTokens: null, minCumulativeTokens: null, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
                      ]
                    }))
                  )
                }
              >
                {t("editor.tier.add")}
              </button>
            </div>
          </section>

          <section className="tsn-section">
            <div className="tsn-section-label">{t("editor.timeWindows")}</div>
            {(entry.timeWindows ?? []).map((window, windowIndex) => (
              <div className="tsn-form-grid" key={windowIndex}>
                <div className="tsn-field">
                  <label>from</label>
                  <input
                    className="tsn-input"
                    placeholder="23:00"
                    value={window.from}
                    onChange={(event) =>
                      setDraft(
                        updateEntry(draft, entryIndex, (item) => ({
                          ...item,
                          timeWindows: item.timeWindows.map((current, i) =>
                            i === windowIndex ? { ...current, from: event.target.value } : current
                          )
                        }))
                      )
                    }
                  />
                </div>
                <div className="tsn-field">
                  <label>to</label>
                  <input
                    className="tsn-input"
                    placeholder="08:30"
                    value={window.to}
                    onChange={(event) =>
                      setDraft(
                        updateEntry(draft, entryIndex, (item) => ({
                          ...item,
                          timeWindows: item.timeWindows.map((current, i) =>
                            i === windowIndex ? { ...current, to: event.target.value } : current
                          )
                        }))
                      )
                    }
                  />
                </div>
                <div className="tsn-field">
                  <label>multiplier</label>
                  <input
                    className="tsn-input"
                    type="number" min="0" step="0.05"
                    value={window.multiplier}
                    onChange={(event) =>
                      setDraft(
                        updateEntry(draft, entryIndex, (item) => ({
                          ...item,
                          timeWindows: item.timeWindows.map((current, i) =>
                            i === windowIndex ? { ...current, multiplier: numberValue(event) } : current
                          )
                        }))
                      )
                    }
                  />
                </div>
                <div className="tsn-field">
                  <label> </label>
                  <button
                    type="button"
                    className="tsn-btn tsn-btn-small"
                    onClick={() =>
                      setDraft(
                        updateEntry(draft, entryIndex, (item) => ({
                          ...item,
                          timeWindows: item.timeWindows.filter((_, i) => i !== windowIndex)
                        }))
                      )
                    }
                  >
                    {t("editor.remove")}
                  </button>
                </div>
              </div>
            ))}
            <div className="tsn-row-actions">
              <button
                type="button"
                className="tsn-btn tsn-btn-small"
                onClick={() =>
                  setDraft(
                    updateEntry(draft, entryIndex, (item) => ({
                      ...item,
                      timeWindows: [...(item.timeWindows ?? []), { from: "23:00", to: "08:30", multiplier: 0.5 }]
                    }))
                  )
                }
              >
                {t("editor.timeWindow.add")}
              </button>
            </div>
          </section>

          <section className="tsn-section">
            <div className="tsn-section-label">{t("editor.preview")}</div>
            {previewRows.length === 0 ? (
              <div className="tsn-note">{t("editor.previewEmpty")}</div>
            ) : (
              <div className="tsn-preview tsn-table-wrap">
                <table className="tsn-table">
                  <tbody>
                    {previewRows.slice(0, 8).map((row) => (
                      <tr key={row.turn}>
                        <td>#{row.turn}</td>
                        <td className="tsn-title-cell">{row.title}</td>
                        <td className="tsn-num">
                          {row.cost === null ? (
                            <span className="tsn-muted">
                              {t("stats.noprice")}
                              {row.unmatched.length > 0 ? ` (${row.unmatched.join(", ")})` : ""}
                            </span>
                          ) : (
                            <span className="tsn-money">{formatMoney(row.cost, row.currency)}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="tsn-section">
            <div className="tsn-section-label">{t("editor.importExport")}</div>
            <textarea
              className="tsn-textarea"
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
              spellCheck="false"
            />
            <div className="tsn-row-actions">
              <button type="button" className="tsn-btn tsn-btn-small" onClick={() => setImportText(JSON.stringify(draft, null, 2))}>
                {t("editor.export")}
              </button>
              <button type="button" className="tsn-btn tsn-btn-small" onClick={doImport}>
                {t("editor.import")}
              </button>
              <button
                type="button"
                className="tsn-btn tsn-btn-small"
                onClick={() => {
                  setDraft(cloneTable(DEFAULT_PRICE_TABLE));
                  setSelected(0);
                  setError(null);
                }}
              >
                {t("editor.reset")}
              </button>
              {error ? <span className="tsn-error">{error}</span> : null}
            </div>
          </section>
        </div>
        <div className="tsn-modal-foot">
          <button type="button" className="tsn-btn tsn-btn-small" onClick={() => setOpen(false)}>
            {t("editor.cancel")}
          </button>
          <button type="button" className="tsn-btn" onClick={save}>
            {t("editor.save")}
          </button>
        </div>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ *
 * 注册
 * ------------------------------------------------------------------ */

/** 需要的服务：slots（注册点）、locale（文案）、sessions（loadOlder / 列表快照 /
    深补翻页 / 钻取）、connection（编辑器模型目录 RPC + session.history）。 */
export const inject = ["slots", "locale", "sessions", "connection"];

export function apply(ctx) {
  installStyles(ctx);
  pluginCtx = ctx;
  ctx.effect(() => () => {
    pluginCtx = null;
  }, "token-insight: ctx capture");

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "token-insight: dictionaries");
  const t = ctx.locale.bind(NS);

  /* 1. 第三页签「Token 统计」（仿 ui-trajectory 的 conversation.view 注册形态）。
     条目 inject：loadOlder 经 sessions 服务的 SessionFace 调用（2.1）。 */
  ctx.slots.inject("conversation.view", () =>
    ctx.slots.register(
      {
        name: "conversation.view",
        id: "token-stats",
        order: 20,
        locale: NS,
        label: () => t("view.tokenStats"),
        inject: (sessionId) => ({
          loadOlder: () => {
            try {
              ctx.get("sessions")?.binding?.(sessionId)?.session?.loadOlder?.();
            } catch {
              /* 会话未实例化/服务缺席时静默放弃（按钮与触底触发都会重试） */
            }
          }
        })
      },
      TokenStatsView
    )
  );

  /* 2. 回复结尾轻量显示：assistant-actions 列表槽条目（官方功能行内部：
     复制 → 反馈(10) → 本 chip(20) → 分支 → timeEnd）。list 槽全条目并存，
     不参与 turnTail chain 的单选举，与「产出文件」条目互不抢占。 */
  ctx.slots.inject("conversation.chat.assistant-actions", () =>
    ctx.slots.register(
      {
        name: "conversation.chat.assistant-actions",
        id: "token-insight-chip",
        order: 20,
        locale: NS
      },
      AssistantActionsTokenChip
    )
  );

  /* 3. 侧栏底部动作座位「Token统计」（sidebar.footer.action，list 槽、root
     作用域；order 20 落 cordis 座位（默认 0）之后、紧邻设置座位上方相邻行；
     ui-cordis 面板座位同款先例；wide 双形态由 owner props 提供）。 */
  ctx.slots.inject("sidebar.footer.action", () =>
    ctx.slots.register(
      {
        name: "sidebar.footer.action",
        id: "token-stats-overview",
        order: 20,
        locale: NS
      },
      DashboardSeat
    )
  );

  /* 4. Token统计总览整页帧（shell.overlay，root 作用域，order 40 —
     价目表编辑器（50）在其上层）。打开/关闭零选择状态副作用；几何
     跟踪与降级见 useSidebarLeft。 */
  ctx.slots.inject("shell.overlay", () =>
    ctx.slots.register(
      {
        name: "shell.overlay",
        id: "token-insight-dashboard",
        order: 40,
        locale: NS
      },
      StatsOverviewOverlay
    )
  );

  /* 5. 价目表编辑弹窗：shell.overlay 框架浮层条目（root 作用域）。
     入口自 settings.general.item 迁入总览页「价格表」页签（归宿 A），
     编辑器本体不变、两处共用。 */
  ctx.slots.inject("shell.overlay", () =>
    ctx.slots.register(
      {
        name: "shell.overlay",
        id: "token-insight-price-editor",
        order: 50,
        locale: NS
      },
      PriceEditorOverlay
    )
  );
}
