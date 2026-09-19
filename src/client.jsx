/**
 * dsh-v-token-insight — 客户端源码（由 build.mjs 用 esbuild 打包成
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
 *       （AppFrame 侧栏列测量 + ResizeObserver 跟踪，降级
 *       inset:0 全覆盖 + 页内提示）；打开/关闭零选择状态副作用；ESC 分层。
 *     · 价目表编辑弹窗（order 50）：总览页「价格表」页签与会话页签共用。
 *
 * 数据面（杂交方案）：
 *  - 会话页签/chip：useProjection（tokenUsage/sessionStats/…，宿主唯一计算点）
 *    + useChat 窗口节点（ChatSnapshot.legacy.nodes——DSH 0.1.2-rc.1 起会话快照
 *    拆分，chat/views/turnTimings 迁入 useChat/useTrajectory）→ stats-fold.mjs
 *    折叠 + loadOlder 逼近全量；
 *  - 总览页 Tier 0：useSessions 列表行投影（projectionValues.tokenUsage，全会话
 *    权威、含归档、投影推送实时刷新）+ useWorkspaces（archivedSessionIds）→
 *    rows-aggregate.mjs 聚合；
 *  - 总览页 Tier 1：ledger.mjs 本地逐步账本（页签/chip 沉淀 + 按会话 opt-in 的
 *    会话绑定事件窗口深度补全），费用只在账本覆盖段按逐步语义计费（不猜价）；
 *  - 跳回对话页：对话页签是会话视图环的 order 0 条目——点击页签栏首个
 *    tab（DOM 级，零内核改动）；滚动定位用 chat.locations.getTurn(turn)
 *    的首键 → 聊天流 [data-chat-anchor-key] 行。
 */
import { Fragment, memo, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
// 纯函数模块：计价 / 折叠 / 持久化 / 图表布局（node 下可直接单测）。
import {
  BUCKETS,
  DEFAULT_PRICE_TABLE,
  UNIT,
  displayCurrencyOf,
  formatAxisMoney,
  formatMoney,
  priceTurnRows,
  validatePriceTable
} from "./pricing.mjs";
import {
  billedInputTokens,
  cacheHitPercent,
  foldHistoryEvents,
  foldTurns,
  foldTurnsShared,
  formatMillions,
  formatTodayDps,
  formatTokens,
  joinRequestInsightsShared
} from "./stats-fold.mjs";
import {
  COVERAGE_GAP_THRESHOLD,
  LEDGER_INDEX_KEY_V2,
  PRICING_ENGINE_VERSION,
  aggregateLedgerViews,
  clearAllLedger,
  clearSessionBuckets,
  clearSessionLedger,
  createLedgerNotifier,
  createPriceCache,
  isPartialCoverage,
  emptyLedger,
  ledgerCoverageGaps,
  ledgerLegacyBackup,
  loadLedger,
  persistLedger,
  priceDailyCost,
  pricingStatusOf,
  recordDeepCoverage,
  repriceLedgerBudgetCheck,
  repriceLedgerSession,
  sessionsWithUnattributedEntries,
  upsertSessionEntries,
  ledgerSessionBuckets,
  ledgerTokensForDay,
  seatSpeedGauge
} from "./ledger.mjs";
import {
  aggregateByTime,
  aggregateKpi,
  aggregateSessions,
  aggregateWorkspaces,
  archivedMissingFromList,
  computeTrendRemainders,
  expandRows,
  groupCostByGranularity,
  dayKeyOf,
  timeKeyOf,
  totalTokens as totalTokensBuckets
} from "./rows-aggregate.mjs";
import {
  PRICES_CHANGED_EVENT,
  PRICES_EDIT_EVENT,
  loadPriceTable,
  savePriceTable
} from "./price-store.mjs";
import { PLAN_CHANGED_EVENT, clearPlanStore, loadPlanStore, savePlanStore } from "./plan-store.mjs";
import { PAGE_GAP_BASE_MS, nextGapMs, smoothRtt } from "./pacing.mjs";
import { BUCKET_SEGMENTS, contextBreakdownLayout, dualAxisTrendLayout, formatAxisTokens, hBarsLayout, lineLayout } from "./charts.mjs";
import { Card, ChartCard, Footnote, KpiCard, StatBadge } from "./stats-ui.jsx";

const PLUGIN_ID = "dsh-v-token-insight";
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
  "stats.chart.dualTitle": "每轮消耗与花费（已加载窗口）",
  "stats.chart.dual.tokens": "Tokens（左轴）",
  "stats.chart.dual.cost": "费用（右轴）",
  "stats.chart.modelsTitle": "模型分布（按 token，已加载窗口）",
  "stats.chart.costTitle": "累计费用（按已定价轮）",
  "stats.chart.tableAlt": "表格替代",
  "stats.chart.unpricedSkipped": "未定价轮未计入折线：{count} 轮。",
  "stats.col.cumulative": "累计费用",
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
  "dash.seat.speedTitle": "当前速度 {value}%",
  "dash.close": "关闭总览",
  "dash.degraded": "侧栏几何测量不可用：已退化为全帧覆盖（临时降级，恢复后自动回到侧栏避让形态）。",
  "dash.tab.overview": "总览",
  "dash.tab.workspaces": "按工作区",
  "dash.tab.sessions": "按会话",
  "dash.tab.models": "按模型",
  "dash.tab.pricing": "价格表",
  "dash.tab.plan": "计划",
  "dash.kpi.total": "计费 Token（全会话）",
  "dash.kpi.cacheHit": "缓存命中（全会话）",
  "dash.kpi.sessions": "会话计数",
  "dash.kpi.sessionsSub": "总数 {total} · 进行中 {running} · 活跃 {active} · 归档 {archived}（空会话不计；活跃=未运行未归档）",
  "dash.kpi.lblRunning": "进行中",
  "dash.kpi.inOut": "输入/输出（M）",
  "dash.kpi.inOutSub": "计费输入 {in} · 输出 {out}（精确值；卡面为百万 Token 缩写）",
  "dash.kpi.dps": "今日DPS",
  "dash.kpi.dpsSub": "今日平均每秒 Token：分子 = 今日消耗（账本覆盖段今日桶四桶总量，fork 剔除；即趋势「今日」桶的账本覆盖段部分）；分母 = 自当地零点已过秒数；与价目无关。趋势「今日」桶 − 本读数 = 按最近活动并入的未覆盖余量。已过不足 60s 显示「—」，比值 <1 显示「<1」。",
  "dash.kpi.dpsMonthly": "每月预估消费 {value}（当前DPS × 2.592 × 当前均价，取整；2.592 = 30天 × 24小时 × 3600秒 ÷ 10⁶，即 DPS 稳定时每月消耗的百万 Token 数——月费用粗略估计，仅供参考）",
  "dash.kpi.cost": "费用（覆盖 {covered}/{count} 会话）",
  "dash.kpi.costSub": "逐步计费合计 · {covered}/{count} 会话已覆盖",
  "dash.kpi.avgCost": "均价（每百万 Token）",
  "dash.kpi.avgCostSub": "仅供参考",
  "dash.kpi.avgCostFull": "已定价覆盖段加权均值 · 仅供参考",
  "dash.tier0.note": "Tier 0：合计来自会话列表行投影（宿主权威值，含归档会话，实时刷新）；个别行投影缺席时按零计入，以上次计算为准。",
  "dash.tier0.fallback": "Tier 0 补充：{count} 个会话宿主投影缺席（升级后投影检查点版本门槛），四桶按本地账本覆盖段口径计入。",
  "dash.tier1.note": "Tier 1：明细与费用仅覆盖本地账本覆盖段（打开过统计页签或执行过「补全」的会话），未覆盖显示「—」。费用按当前价目表即时折算，仅供参考。",
  "dash.caliber.help": "口径说明",
  "dash.archivedMissing": "归档会话不含于当前数据面：归档集合非空，但会话列表未携带归档行。",
  "dash.chart.trendSub": "账本覆盖段按步发生时刻 · 其余按会话最近活动",
  "dash.chart.dual.tokens": "Token（左轴）",
  "dash.chart.dual.cost": "费用（右轴 · 逐步计费）",
  "dash.chart.dual.target": "今日目标（计划）",
  "dash.chart.dual.targetTitle": "今日目标 {value} Token（「计划」页签设置的每日计划消耗）",
  "dash.chart.dual.targetMonth": "本月目标（计划）",
  "dash.chart.dual.targetMonthTitle": "本月目标 {value} Token（「计划」页签设置的每月计划消耗）",
  "dash.chart.models": "模型分布（按 token）",
  "dash.chart.modelsSub": "仅账本覆盖段有模型归属 · 未覆盖计入「未分类」",
  "dash.chart.projects": "项目占比（按 token）",
  "dash.chart.projectsSub": "cwd 归组 · 子会话缺失 cwd 回退父会话",
  "dash.chart.activity": "活跃 / 归档构成",
  "dash.chart.activitySub": "按会话数（空会话不计）",
  "dash.chart.dailyCostSub": "按步发生时刻 · 逐步计费",
  "dash.model.unclassified": "未分类",
  "dash.model.unknown": "未知模型",
  "dash.workspace.unknown": "未知",
  "dash.col.workspace": "项目",
  "dash.col.sessions": "会话数",
  "dash.col.running": "运行中",
  "dash.col.total": "计费 Token",
  "dash.col.status": "状态",
  "dash.col.activity": "最近活动",
  "dash.col.hit": "命中率",
  "dash.col.avgCost": "均价/百万Token",
  "dash.col.cost": "费用",
  "dash.filter.all": "全部",
  "dash.filter.active": "活跃",
  "dash.filter.archived": "归档",
  "dash.search": "搜索标题 / 项目…",
  "dash.sort.recent": "最近活动",
  "dash.sort.tokens": "计费 Token",
  "dash.badge.running": "运行中",
  "dash.badge.archived": "归档",
  "dash.badge.subagent": "子会话",
  "dash.badge.fork": "分支",
  "dash.fork.excluded": "已从各合计中排除 {count} 个分支会话（fork）的重复消耗：分支继承父会话的全部历史消耗，其行数据仍可查看。",
  "dash.badge.completed": "已完成",
  "dash.empty": "暂无会话数据。",
  "dash.date.older": "更早",
  "dash.time.caliber": "双口径：账本覆盖段按步发生时刻分桶（老化桶按其聚合日入柱）；未覆盖会话的整桶与已覆盖会话的未覆盖余量均按最近活动（updatedAt）整桶计入，以「按最近活动」徽标区分。颗粒度窗口：按日近 30 天、按月近 12 个月、按年不限，超出窗口的消耗归入「更早」。",
  "dash.time.byRecent": "按最近活动",
  "dash.time.granularity": "统计颗粒度",
  "dash.time.g.day": "按日",
  "dash.time.g.month": "按月",
  "dash.time.g.year": "按年",
  "dash.time.trendTitle.day": "消耗与费用趋势（按日）",
  "dash.time.trendTitle.month": "消耗与费用趋势（按月）",
  "dash.time.trendTitle.year": "消耗与费用趋势（按年）",
  "dash.plan.title": "计划消耗（每日 / 每月）",
  "dash.plan.label": "每日计划消耗 Token 总量",
  "dash.plan.labelMonthly": "每月计划消耗 Token 总量",
  "dash.plan.save": "保存",
  "dash.plan.clear": "清除",
  "dash.plan.invalid": "非法输入：每日计划消耗须为正数（Token/天），已拒绝保存。",
  "dash.plan.invalidMonthly": "非法输入：每月计划消耗须为正数（Token/月），已拒绝保存。",
  "dash.plan.saved": "已保存。",
  "dash.plan.cleared": "已清除计划。",
  "dash.plan.clearFailed": "清除失败：本地存储不可用或配额不足。",
  "dash.plan.unset": "未设置",
  "dash.plan.unsetDaily": "每日计划未设置",
  "dash.plan.unsetMonthly": "每月计划未设置",
  "dash.plan.hint": "口径：每日 / 每月计划消耗 Token 总量，作为消耗节奏标尺（座位速度仪表读每日值；总览趋势图今日 / 本月目标柱分别读每日 / 每月值）。未设置时依赖计划值的呈现保持无标尺形态，不把计划当作 0 参与计算。",
  "dash.plan.saveFailed": "保存失败：本地存储不可用或配额不足。",
  "dash.plan.current": "当前每日计划：{value} Token/天",
  "dash.plan.currentMonthly": "当前每月计划：{value} Token/月",
  "dash.models.caliber": "仅账本覆盖的消耗有模型归属；「未分类」= 会话权威总量 − 账本已覆盖量，不虚构模型归属。",
  "dash.cost.none": "—",
  "dash.cost.covered": "≈ {cost}",
  "dash.cost.partial": "部分覆盖（{note}）",
  "dash.cost.hover": "打开该会话统计页签或执行「补全」后可折算",
  "dash.ws.unpriced": "含未定价 {count} 个会话",
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
  "dash.ledger.manageNote": "逐步明细沉淀于本机 localStorage（索引键 {key} + 每会话分片键），随使用积累；仅统计四桶与模型时刻，不含会话正文。",
  "dash.ledger.clearAll": "清空全部账本",
  "dash.ledger.rebuildAll": "重建全部账本",
  "dash.ledger.rebuildAllHint": "逐会话从宿主会话历史重建本地账本（已完整覆盖的自动跳过，可中途停止）",
  "dash.ledger.rebuild.stop": "停止重建",
  "dash.ledger.rebuild.running": "重建中 {done}/{total} · 部分覆盖 {partial} · 失败 {failed}…",
  "dash.ledger.rebuild.done": "重建完成：{done} 个会话 · 部分覆盖 {partial} · 失败 {failed}。",
  "dash.ledger.rebuild.stopped": "已停止：完成 {done}/{total}。",
  "dash.ledger.rebuild.batchPaused": "已分批完成 {done}/{total}（宿主负载保护）——再次点击继续重建下一批。",
  "dash.ledger.rebuild.none": "无需重建：可见会话均已完整覆盖或没有可补全会话。",
  "dash.ledger.rebuild.skippedRunning": "跳过 {n} 个运行中会话。",
  "dash.ledger.emptyHint": "账本为空：费用与模型归属需从会话历史重建——点「重建全部账本」。",
  "dash.ledger.export": "导出账本备份",
  "dash.ledger.export.done": "已导出账本备份（{sessions} 个会话）。",
  "dash.ledger.export.failed": "导出失败：浏览器拒绝了下载。",
  "dash.ledger.import": "导入账本备份",
  "dash.ledger.import.ok": "已导入账本：{sessions} 个会话，费用已按当前价目重算。",
  "dash.ledger.import.bad": "导入失败：不是有效的账本备份（需 v1 账本 JSON）。",
  "dash.ledger.persistError": "本地存储配额不足：账本本次仅保存在内存中。",
  "dash.ledger.budget.collapsed": "账本固化：{collapsed} 步原始明细已卷为按日聚合桶（趋势与费用合计不变，逐步钻取对固化段退化为桶级）。",
  "dash.ledger.budget.evicted": "账本超出本地存储预算：已按最旧优先移出 {count} 个会话的明细（可经「重建全部账本」恢复逐步数据）。",
  "dash.repair.running": "检测到 {total} 个会话的账本条目缺少模型归属，正在自动补全恢复（{done}/{total}）…",
  "dash.repair.done": "已自动恢复 {done} 个会话的模型归属，费用已按当前价目重算。",
  "dash.repair.failed": "已自动恢复 {done} 个会话，{failed} 个失败——可稍后对其执行「补全此会话」重试。",
  "dash.repair.gap.running": "检测到 {total} 个会话存在覆盖缺口（投影超出账本覆盖），正在定向深度补全（{done}/{total}）…",
  "dash.repair.gap.done": "已补全 {done} 个覆盖缺口会话，历史步已按发生时刻重新入柱。",
  "dash.repair.gap.failed": "已补全 {done} 个覆盖缺口会话，{failed} 个失败——可稍后对其执行「补全此会话」重试。",
  "dash.remainder.note": "另有 {count} 个会话的 {tokens} token 未覆盖余量按最近活动并入趋势。",
  "dash.datefmt": "{y}-{m}-{d}",
  "dash.datetimefmt": "{y}-{m}-{d} {hh}:{mm}",
  "dash.pricing.staleTable": "账面价基于旧价目：{count} 个会话的落盘费用按此前价目入账，可按需重算。",
  "dash.pricing.needsReprice": "计价引擎已升级：{count} 个会话待重算（展示仍用旧账面价）。",
  "dash.pricing.saveNote": "价目已更新，历史账面价不变，可按需重算。",
  "dash.pricing.repriceAll": "按当前价目重算全账本",
  "dash.pricing.repriceAllHint": "从 token 事实重新导出全部会话的账面价（只改写费用、不改 token；可中途停止）",
  "dash.pricing.repriceAll.stop": "停止重算",
  "dash.pricing.repriceAll.running": "重算中 {done}/{total} · 失败 {failed}…",
  "dash.pricing.repriceAll.done": "重算完成：{count} 个会话 · 失败 {failed}。费用口径已切换至当前价目。",
  "dash.pricing.repriceAll.stopped": "已停止：完成 {done}/{total}。",
  "dash.pricing.repriceAll.none": "没有可重算的会话。",
  "dash.pricing.repriceAll.emptyLedger": "账本为空，没有可重算的 token 事实——先在「按会话」页签执行「重建全部账本」（或导入账本备份）恢复数据，再回到这里重算。",
  "dash.pricing.repriceRejected": "重算被拒绝：估算重算后总量将超出本地存储预算余量，请先清理账本。",
  "dash.pricing.repriceSession": "重算此会话",
  "dash.pricing.repriceSession.done": "已按当前价目重算此会话。",
  "dash.pricing.repriceSession.failed": "重算失败：本地存储不可用。",
  "dash.pricing.repriceSession.empty": "该会话无可重算的 token 事实。"
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
  "stats.chart.dualTitle": "Per-turn usage & cost (loaded window)",
  "stats.chart.dual.tokens": "Tokens (left axis)",
  "stats.chart.dual.cost": "Cost (right axis)",
  "stats.chart.modelsTitle": "Model distribution (by tokens, loaded window)",
  "stats.chart.costTitle": "Cumulative cost (priced turns)",
  "stats.chart.tableAlt": "Table alternative",
  "stats.chart.unpricedSkipped": "{count} unpriced turn(s) are not part of the line.",
  "stats.col.cumulative": "Cumulative",
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
  "dash.seat.speedTitle": "Current speed {value}%",
  "dash.close": "Close overview",
  "dash.degraded": "Sidebar geometry measurement unavailable: temporarily covering the full frame (degraded; returns to sidebar-aware layout once measurable).",
  "dash.tab.overview": "Overview",
  "dash.tab.workspaces": "By workspace",
  "dash.tab.sessions": "By session",
  "dash.tab.models": "By model",
  "dash.tab.pricing": "Price table",
  "dash.tab.plan": "Plan",
  "dash.kpi.total": "Billed tokens (all sessions)",
  "dash.kpi.cacheHit": "Cache hit (all sessions)",
  "dash.kpi.sessions": "Sessions",
  "dash.kpi.sessionsSub": "{total} total · {running} running · {active} active · {archived} archived (blank excluded; active = not running & not archived)",
  "dash.kpi.lblRunning": "Running",
  "dash.kpi.inOut": "Input / Output (M)",
  "dash.kpi.inOutSub": "Billed input {in} · Output {out} (exact values; the card shows per-million abbreviations)",
  "dash.kpi.dps": "Today's DPS",
  "dash.kpi.dpsSub": "Average tokens per second today: numerator = today's consumption (ledger-covered today bucket, all four buckets, forks excluded; the ledger-covered part of the trend \"today\" bucket); denominator = seconds elapsed since local midnight; independent of the price table. Trend \"today\" bucket − this reading = uncovered remainder merged by most-recent activity. Shows \"—\" for the first 60s, \"<1\" when the ratio is below 1.",
  "dash.kpi.dpsMonthly": "Estimated monthly spend {value} (current DPS × 2.592 × avg cost, rounded; 2.592 = 30 days × 24h × 3600s ÷ 10⁶, i.e. millions of tokens per month while the DPS holds — a rough monthly-cost estimate, for reference)",
  "dash.kpi.cost": "Cost (covered {covered}/{count} sessions)",
  "dash.kpi.costSub": "Per-step pricing total · {covered}/{count} sessions covered",
  "dash.kpi.avgCost": "Avg cost (per MTok)",
  "dash.kpi.avgCostSub": "For reference",
  "dash.kpi.avgCostFull": "Weighted mean over priced covered steps · for reference",
  "dash.tier0.note": "Tier 0: totals come from session-list row projections (host authority, archived sessions included, live refresh); rows missing projections count as zero, values are as-of last computation.",
  "dash.tier0.fallback": "Tier 0 addendum: {count} session(s) lack host projections (post-upgrade checkpoint version gate); four buckets fall back to the local ledger caliber.",
  "dash.tier1.note": "Tier 1: details and costs cover only the local ledger (sessions whose stats tab was opened or that were deep-completed); uncovered entries show \"—\". Costs are derived on the fly from the current price table; for reference only.",
  "dash.caliber.help": "Caliber notes",
  "dash.archivedMissing": "Archived sessions are not part of the current data plane: the archive set is non-empty but the session list carries no archived rows.",
  "dash.chart.trendSub": "Ledger-covered spans by step time · the rest by last session activity",
  "dash.chart.dual.tokens": "Tokens (left axis)",
  "dash.chart.dual.cost": "Cost (right axis · per-step)",
  "dash.chart.dual.target": "Today's target (plan)",
  "dash.chart.dual.targetTitle": "Today's target {value} tokens (daily plan set on the Plan tab)",
  "dash.chart.dual.targetMonth": "This month's target (plan)",
  "dash.chart.dual.targetMonthTitle": "This month's target {value} tokens (monthly plan set on the Plan tab)",
  "dash.chart.models": "Model distribution (by tokens)",
  "dash.chart.modelsSub": "Only ledger-covered usage carries model attribution · the rest lands in \"Unclassified\"",
  "dash.chart.projects": "Project share (by tokens)",
  "dash.chart.projectsSub": "Grouped by cwd · subagents without cwd fall back to their parent",
  "dash.chart.activity": "Active / archived composition",
  "dash.chart.activitySub": "By session count (blank excluded)",
  "dash.chart.dailyCostSub": "By step time · per-step pricing",
  "dash.model.unclassified": "Unclassified",
  "dash.model.unknown": "Unknown model",
  "dash.workspace.unknown": "Unknown",
  "dash.col.workspace": "Project",
  "dash.col.sessions": "Sessions",
  "dash.col.running": "Running",
  "dash.col.total": "Billed tokens",
  "dash.col.status": "Status",
  "dash.col.activity": "Last activity",
  "dash.col.hit": "Hit rate",
  "dash.col.avgCost": "Avg / MTok",
  "dash.col.cost": "Cost",
  "dash.filter.all": "All",
  "dash.filter.active": "Active",
  "dash.filter.archived": "Archived",
  "dash.search": "Search title / project…",
  "dash.sort.recent": "Last activity",
  "dash.sort.tokens": "Billed tokens",
  "dash.badge.running": "Running",
  "dash.badge.archived": "Archived",
  "dash.badge.subagent": "Subagent",
  "dash.badge.fork": "Fork",
  "dash.fork.excluded": "{count} fork session(s) excluded from totals: forks inherit their parent's full history consumption; their rows remain inspectable.",
  "dash.badge.completed": "Completed",
  "dash.empty": "No session data yet.",
  "dash.date.older": "Older",
  "dash.time.caliber": "Dual caliber: ledger-covered spans bucket by step time (aged buckets by their aggregate day); whole buckets of uncovered sessions and the uncovered remainder of covered sessions both bucket by last activity (updatedAt), marked by the \"by last activity\" badge. Granularity windows: daily = last 30 days, monthly = last 12 calendar months, yearly = unlimited; usage beyond the window lands in \"Older\".",
  "dash.time.byRecent": "by last activity",
  "dash.time.granularity": "Granularity",
  "dash.time.g.day": "Daily",
  "dash.time.g.month": "Monthly",
  "dash.time.g.year": "Yearly",
  "dash.time.trendTitle.day": "Consumption & cost trend (daily)",
  "dash.time.trendTitle.month": "Consumption & cost trend (monthly)",
  "dash.time.trendTitle.year": "Consumption & cost trend (yearly)",
  "dash.plan.title": "Planned usage (daily / monthly)",
  "dash.plan.label": "Daily planned token usage",
  "dash.plan.labelMonthly": "Monthly planned token usage",
  "dash.plan.save": "Save",
  "dash.plan.clear": "Clear",
  "dash.plan.invalid": "Invalid input: the daily plan must be a positive number of tokens per day; save rejected.",
  "dash.plan.invalidMonthly": "Invalid input: the monthly plan must be a positive number of tokens per month; save rejected.",
  "dash.plan.saved": "Saved.",
  "dash.plan.cleared": "Plan cleared.",
  "dash.plan.clearFailed": "Clear failed: local storage unavailable or quota exceeded.",
  "dash.plan.unset": "Not set",
  "dash.plan.unsetDaily": "Daily plan not set",
  "dash.plan.unsetMonthly": "Monthly plan not set",
  "dash.plan.hint": "Caliber: the daily / monthly planned token totals serve as pace rulers (the seat speed gauge reads the daily value; the trend chart's today / this-month target bars read the daily / monthly values). When unset, plan-dependent views stay ruler-less instead of treating the plan as 0.",
  "dash.plan.saveFailed": "Save failed: local storage unavailable or quota exceeded.",
  "dash.plan.current": "Current daily plan: {value} tokens/day",
  "dash.plan.currentMonthly": "Current monthly plan: {value} tokens/month",
  "dash.models.caliber": "Only ledger-covered usage carries model attribution; \"Unclassified\" = session authority totals − ledger-covered amounts, never a fabricated attribution.",
  "dash.cost.none": "—",
  "dash.cost.covered": "≈ {cost}",
  "dash.cost.partial": "Partial coverage ({note})",
  "dash.cost.hover": "Open this session's stats tab or run \"Complete\" to price it",
  "dash.ws.unpriced": "{count} unpriced",
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
  "dash.ledger.manageNote": "Per-step details accumulate in this browser's localStorage (index key {key} + per-session shard keys); usage buckets and model/timing facts only — no conversation content.",
  "dash.ledger.clearAll": "Clear entire ledger",
  "dash.ledger.rebuildAll": "Rebuild entire ledger",
  "dash.ledger.rebuildAllHint": "Rebuild the local ledger session-by-session from host session history (fully covered sessions are skipped; can be stopped midway)",
  "dash.ledger.rebuild.stop": "Stop rebuild",
  "dash.ledger.rebuild.running": "Rebuilding {done}/{total} · partial {partial} · failed {failed}…",
  "dash.ledger.rebuild.done": "Rebuild finished: {done} sessions · partial {partial} · failed {failed}.",
  "dash.ledger.rebuild.stopped": "Stopped: {done}/{total} done.",
  "dash.ledger.rebuild.batchPaused": "Batch done: {done}/{total} (host load protection) — click again to continue with the next batch.",
  "dash.ledger.rebuild.none": "Nothing to rebuild: visible sessions are fully covered (or nothing to complete).",
  "dash.ledger.rebuild.skippedRunning": "skipped {n} running session(s).",
  "dash.ledger.emptyHint": "Ledger is empty: costs and model attribution must be rebuilt from session history — click \"Rebuild entire ledger\".",
  "dash.ledger.export": "Export ledger backup",
  "dash.ledger.export.done": "Ledger backup exported ({sessions} sessions).",
  "dash.ledger.export.failed": "Export failed: the browser denied the download.",
  "dash.ledger.import": "Import ledger backup",
  "dash.ledger.import.ok": "Ledger imported: {sessions} sessions; costs recomputed with the current price table.",
  "dash.ledger.import.bad": "Import failed: not a valid ledger backup (v1 ledger JSON expected).",
  "dash.ledger.persistError": "Local storage quota exceeded: the ledger lives in memory for this page session.",
  "dash.ledger.budget.collapsed": "Ledger compacted: {collapsed} raw steps were folded into per-day aggregate buckets (trend and cost totals unchanged; per-step drill-down degrades to bucket level for compacted ranges).",
  "dash.ledger.budget.evicted": "Ledger exceeded the local storage budget: {count} oldest session(s) were evicted (\"Rebuild entire ledger\" restores their details).",
  "dash.repair.running": "{total} session(s) carry ledger entries without model attribution; auto-repairing ({done}/{total})…",
  "dash.repair.done": "Model attribution restored for {done} session(s); costs recomputed at current prices.",
  "dash.repair.failed": "Restored {done} session(s); {failed} failed — retry with \"Complete this session\" later.",
  "dash.repair.gap.running": "{total} session(s) have coverage gaps (projection beyond ledger coverage); running targeted deep-completion ({done}/{total})…",
  "dash.repair.gap.done": "Completed {done} coverage-gap session(s); historical steps re-bucketed by occurrence time.",
  "dash.repair.gap.failed": "Completed {done} coverage-gap session(s); {failed} failed — retry with \"Complete this session\" later.",
  "dash.remainder.note": "{tokens} tokens of uncovered remainder from {count} session(s) are merged into the trend by most-recent activity.",
  "dash.datefmt": "{y}-{m}-{d}",
  "dash.datetimefmt": "{y}-{m}-{d} {hh}:{mm}",
  "dash.pricing.staleTable": "Booked costs use an older price table: {count} session(s) were priced at a previous table — reprice as needed.",
  "dash.pricing.needsReprice": "Pricing engine upgraded: {count} session(s) await reprice (still showing previous booked costs).",
  "dash.pricing.saveNote": "Price table updated; historical booked costs are unchanged — reprice as needed.",
  "dash.pricing.repriceAll": "Reprice entire ledger at current table",
  "dash.pricing.repriceAllHint": "Re-derive booked costs for all sessions from token facts (rewrites costs only, never tokens; can be stopped)",
  "dash.pricing.repriceAll.stop": "Stop reprice",
  "dash.pricing.repriceAll.running": "Repricing {done}/{total} · failed {failed}…",
  "dash.pricing.repriceAll.done": "Reprice finished: {count} session(s) · failed {failed}. Cost caliber switched to the current table.",
  "dash.pricing.repriceAll.stopped": "Stopped: {done}/{total} done.",
  "dash.pricing.repriceAll.none": "Nothing to reprice.",
  "dash.pricing.repriceAll.emptyLedger": "Ledger is empty — no token facts to reprice. Run \"Rebuild entire ledger\" (By session tab) or import a backup first, then reprice here.",
  "dash.pricing.repriceRejected": "Reprice rejected: estimated post-reprice size would exceed the local storage budget headroom — clear the ledger first.",
  "dash.pricing.repriceSession": "Reprice this session",
  "dash.pricing.repriceSession.done": "Repriced this session at the current table.",
  "dash.pricing.repriceSession.failed": "Reprice failed: local storage unavailable.",
  "dash.pricing.repriceSession.empty": "This session has no token facts to reprice."
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
/* 计划页签：输入 + 动作行（保存/清除；错误提示复用 .tsn-error）。 */
.tsn-plan-row{align-items:center;gap:8px;display:flex;flex-wrap:wrap}
.tsn-plan-row .tsn-input{max-width:200px}
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
/* x 轴时间标缩字号（用户反馈）：总览整页卡铺满页宽，640 视窗随卡拉伸放大，
   日期行比短轴刻度更显眼——字号退一档弱化存在感（配色/数字字体沿用 .tsn-tick）。 */
.tsn-tick-x{font-size:8px}
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
/* 双轴合并图费用线/点：沿用原费用折线配色（brand 令牌，与会话页费用线同色）；
   四桶柱色不变（红/琥珀/绿/蓝）。 */
.tsn-line-cost{fill:none;stroke:var(--dsw-alias-brand-primary);stroke-width:1.5}
.tsn-dot-cost{fill:var(--dsw-alias-brand-primary)}
/* 今日目标柱（token-stats-plan 消费方）：非实心虚线轮廓框，叠于今日桶柱位——
   与四桶实心段/费用实线在形状上双重区分（虚线 + 空心矩形）；brand 令牌随主题
   联动，浅/深色均可读；语义由图例与悬停 title 承载，颜色不是唯一信息通道。 */
.tsn-bar-target{fill:none;stroke:var(--dsw-alias-brand-primary);stroke-width:1;stroke-dasharray:3 2}
/* 双轴图例（柱色小样 + 线色小样 + 轴语义标注）。 */
.tsn-dual-legend{align-items:center;color:var(--dsw-alias-label-tertiary);gap:14px;font-size:11px;flex-wrap:wrap;display:flex}
.tsn-dual-legend > span{align-items:center;gap:6px;display:inline-flex}
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
.tsn-dash-kpis{grid-template-columns:repeat(7, minmax(0, 1fr));gap:8px;display:grid}
/* 7 卡单行：中宽下收紧内边距与大数字（<1200px），保持扫读层级不变。 */
@media (max-width: 1200px){.tsn-dash-kpis{gap:6px}.tsn-dash-kpis .tsn-kpi{padding:8px 10px}.tsn-dash-kpis .tsn-kpi-value{font-size:17px;line-height:22px}.tsn-dash-kpis .tsn-kpi-label{font-size:11px;line-height:15px}}
.tsn-kpi-sub{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
/* KPI 大字号数值档（用户反馈）：Token 总消耗/总花费数字放大，好用满卡片空间。 */
.tsn-kpi[data-large="true"] .tsn-kpi-value{font-size:24px;line-height:30px}
@media (max-width: 1200px){.tsn-kpi[data-large="true"] .tsn-kpi-value{font-size:20px;line-height:26px}}
/* KPI 数值行内联小件（用户反馈）：三联数字分隔符。 */
.tsn-kpi-sep{color:var(--dsw-alias-label-tertiary);font-weight:400;padding:0 2px}
/* KPI 数值后小字号单位（用户反馈）：今日DPS「token/s」。 */
.tsn-kpi-unit{color:var(--dsw-alias-label-tertiary);font-weight:400;font-size:12px;line-height:16px;margin-left:3px}
@media (max-width: 1200px){.tsn-kpi-unit{font-size:11px;line-height:14px}}
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
.tsn-badge2[data-kind="fork"]{color:var(--dsw-alias-brand-primary);border-color:currentColor}
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
/* 口径说明（? 按钮 + 悬停弹层）：口径脚注收进 tips，不再占用页面空间。
   显示条件 = 按钮 hover / 键盘聚焦（:focus-within）；::after 是按钮与弹层
   之间的隐形桥，防止指针跨 6px 间隙时 hover 断开。 */
.tsn-dash-tabs-row{align-items:flex-end;gap:8px;justify-content:space-between;display:flex}
.tsn-dash-tabs-row .tsn-dash-tabs{flex:1;min-width:0}
.tsn-help{position:relative;flex:none;margin-bottom:7px;display:inline-flex}
.tsn-help-btn{cursor:pointer;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;border-radius:50%;width:22px;height:22px;justify-content:center;align-items:center;padding:0;display:inline-flex}
.tsn-help-btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.tsn-help-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.tsn-help::after{content:"";position:absolute;top:100%;right:0;width:100%;height:6px}
.tsn-help-pop{position:absolute;top:calc(100% + 6px);right:0;z-index:60;visibility:hidden;opacity:0;width:max-content;max-width:min(560px, 72vw);max-height:min(320px, 60vh);overflow:auto;background:var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));border:1px solid var(--dsw-alias-border-l2);border-radius:8px;box-shadow:var(--dsw-shadow-lv2);color:var(--dsw-alias-label-secondary);gap:4px;padding:10px 12px;font-size:12px;line-height:18px;display:flex;flex-direction:column}
.tsn-help:hover .tsn-help-pop,.tsn-help:focus-within .tsn-help-pop{visibility:visible;opacity:1}
/* 警示条 warn 样式统一：tint 底（state-warn-tertiary 随主题）+ warn 描边。 */
.tsn-degraded-note{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-state-warn-tertiary, var(--dsw-alias-state-warn-secondary));border:1px solid var(--dsw-alias-state-warn-secondary);border-radius:8px;font-size:12px;line-height:18px;padding:8px 12px}

/* ---- 侧栏座位（sidebar.footer.action，双形态）----
   样式逐值镜像官方「设置」座位触发器（ui-settings-general SettingsRoot.module.css
   的 .trigger / .rail），保证与设置座位同款同排版；关键点：border:none ——
   缺省按钮边框是「突兀线框」的来源。 */
.tsn-seat{display:contents}
.tsn-seat-row{box-sizing:border-box;cursor:pointer;width:calc(100% + 4px);height:42px;color:var(--dsw-alias-label-primary);background:0 0;border:none;border-radius:12px;flex:none;align-items:center;gap:8px;margin:4px -2px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden;position:relative}
.tsn-seat-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tsn-seat-row:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}
.tsn-seat-label{white-space:nowrap;overflow:hidden}
.tsn-seat-rail{box-sizing:border-box;cursor:pointer;color:var(--dsw-alias-label-primary);background:0 0;border:none;border-radius:50%;justify-content:center;align-items:center;gap:0;width:36px;height:36px;margin:8px 0 10px;padding:0;display:flex;position:relative}
.tsn-seat-rail:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tsn-seat-rail:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:2px}
.tsn-seat[data-active="true"] .tsn-seat-row,
.tsn-seat[data-active="true"] .tsn-seat-rail{color:var(--dsw-alias-state-business-primary)}
/* ---- 座位速度仪表（add-seat-speed-ring，D4/D5/D7）----
   揭示式彩虹：轨道 = 固定彩虹渐变（低不透明度），填充层 = 同一渐变按进度裁切
   （bar 按 width + background-size；ring 按 conic-gradient + mask 角度揭示），
   前沿颜色即当前分区。彩虹各站全取 --dsw-static-* 令牌（蓝/绿/琥珀/红四桶语义
   族；用户期望的粉端以最近蓝族近似，D5）：0% 蓝 → 16.7%(r=25) 浅蓝 →
   33.3%(r=50) 浅绿 → 66.7%(r=100，最绿点) 绿 → 83.3% 琥珀 → 100%(r=150) 红；
   conic 站点角度 = 轨道落位 × 3.6。仪表层 pointer-events:none（不截获指针），
   元素 aria-hidden（JSX）。纯装饰：无入场、无循环动画，仅 180ms 宽度/角度过渡。 */
.tsn-seat{--tsn-speed-rainbow-bar:linear-gradient(90deg,var(--dsw-static-blue-500) 0%,var(--dsw-static-blue-400) 16.7%,var(--dsw-static-green-400) 33.3%,var(--dsw-static-green-500) 66.7%,var(--dsw-static-amber-500) 83.3%,var(--dsw-static-red-400) 100%);--tsn-speed-rainbow-conic:var(--dsw-static-blue-500) 0deg,var(--dsw-static-blue-400) 60deg,var(--dsw-static-green-400) 120deg,var(--dsw-static-green-500) 240deg,var(--dsw-static-amber-500) 300deg,var(--dsw-static-red-400) 360deg}
@property --tsn-p{syntax:"<number>";inherits:true;initial-value:0}
.tsn-seat-speed{position:absolute;left:0;right:0;bottom:0;height:3px;pointer-events:none;overflow:hidden}
.tsn-seat-speed-track{position:absolute;inset:0;background:var(--tsn-speed-rainbow-bar);opacity:.16}
.tsn-seat-speed-fill{position:absolute;left:0;top:0;bottom:0;background:var(--tsn-speed-rainbow-bar);background-repeat:no-repeat;transition:width .18s ease}
.tsn-seat-speedring{position:absolute;inset:2px;pointer-events:none}
.tsn-seat-speedring-track{position:absolute;inset:0;background:conic-gradient(from 0deg,var(--tsn-speed-rainbow-conic));opacity:.16;-webkit-mask:radial-gradient(circle,transparent 0 13px,currentColor 13.5px 16.5px,transparent 17px);mask:radial-gradient(circle,transparent 0 13px,currentColor 13.5px 16.5px,transparent 17px)}
.tsn-seat-speedring-fillwrap{position:absolute;inset:0;pointer-events:none;-webkit-mask:radial-gradient(circle,transparent 0 13px,currentColor 13.5px 16.5px,transparent 17px);mask:radial-gradient(circle,transparent 0 13px,currentColor 13.5px 16.5px,transparent 17px)}
.tsn-seat-speedring-fill{position:absolute;inset:0;background:conic-gradient(from 0deg,var(--tsn-speed-rainbow-conic));-webkit-mask:conic-gradient(currentColor 0 calc(var(--tsn-p,0)*1%),transparent calc(var(--tsn-p,0)*1%));mask:conic-gradient(currentColor 0 calc(var(--tsn-p,0)*1%),transparent calc(var(--tsn-p,0)*1%));transition:--tsn-p .18s ease}
/* D7 降级：mask 不可用环境 → 当前分区色单色环（--tsn-zone 由 JSX 随填充落位
   注入；内缘 cover 掏空成环），MUST NOT 功能缺失。mask 通道用 currentColor/
   transparent（随令牌解析），全仪表零硬编码色值。 */
@supports not ((mask: linear-gradient(#000, #fff)) or (-webkit-mask: linear-gradient(#000, #fff))){.tsn-seat-speedring-track{display:none}.tsn-seat-speedring-fillwrap{-webkit-mask:none;mask:none}.tsn-seat-speedring-fill{-webkit-mask:none;mask:none;background:conic-gradient(from 0deg,var(--tsn-zone,transparent) 0 calc(var(--tsn-p,0)*1%),transparent 0);border-radius:50%}.tsn-seat-speedring-fill::after{content:"";position:absolute;inset:22%;border-radius:50%;background:var(--dsw-alias-bg-base)}}
/* ≤900px 单列化（design D3 断点细则）：显式单列下 span 2 会制造隐式列轨，
   必须同步重置各卡 grid-column 为 auto；首卡/跨全宽卡的 1/-1 在单列下安全。 */
@media (max-width: 900px){.tsn-kpis{grid-template-columns:repeat(2, minmax(0, 1fr))}.tsn-kpis.tsn-kpis--compact{grid-template-columns:repeat(3, minmax(0, 1fr))}.tsn-charts{grid-template-columns:1fr}.tsn-charts > .tsn-card{grid-column:auto}.tsn-dash-kpis{grid-template-columns:repeat(3, minmax(0, 1fr))}.tsn-dash-grid{grid-template-columns:1fr}.tsn-dash-grid > .tsn-card{grid-column:auto}.tsn-dash-grid > .tsn-card:first-child{grid-column:auto}}
@media (max-width: 480px){.tsn-form-grid{grid-template-columns:repeat(2, minmax(0, 1fr))}.tsn-hbar-label{width:88px}.tsn-dash-kpis{grid-template-columns:repeat(2, minmax(0, 1fr))}.tsn-dash-search{min-width:120px}.tsn-kpis.tsn-kpis--compact{grid-template-columns:repeat(3, minmax(0, 1fr))}}
@media (prefers-reduced-motion: reduce){.tsn-bar,.tsn-btn,.tsn-modal-close,.tsn-expand,.tsn-expand svg,.tsn-card,.tsn-kpi,.tsn-dash-tab,.tsn-row td,.tsn-seg .tsn-btn,.tsn-drill,.tsn-sort svg,.tsn-seat-speed-fill,.tsn-seat-speedring-fill{transition:none}}
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

/** 计划变更订阅（镜像 usePriceVersion）：保存/清除成功广播后，计划页签等消费方重算。 */
function usePlanVersion() {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const onChange = () => setVersion((value) => value + 1);
    window.addEventListener(PLAN_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(PLAN_CHANGED_EVENT, onChange);
  }, []);
  return version;
}

function currentPlan(version) {
  return useMemo(() => loadPlanStore(typeof localStorage === "undefined" ? null : localStorage), [version]);
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

const LEDGER_CHANGED_EVENT = "dsh-v-token-insight:ledger-changed";
const LEDGER_SAVE_DEBOUNCE_MS = 1500;
const LEDGER_INGEST_DEBOUNCE_MS = 600;
/* 沉淀路径通知合并窗口（D3）：尾随防抖合并派发。 */
const LEDGER_NOTIFY_COALESCE_MS = 500;

const ledgerNotifier = createLedgerNotifier({
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (id) => clearTimeout(id),
  dispatch: () => {
    try {
      window.dispatchEvent(new CustomEvent(LEDGER_CHANGED_EVENT));
    } catch {
      /* 非浏览器环境静默 */
    }
  },
  coalesceMs: LEDGER_NOTIFY_COALESCE_MS
});

const ledgerRuntime = {
  loaded: false,
  data: null,
  saveTimer: 0,
  persistError: false,
  /* 固化/逐出披露态（fix-ledger-quota-budget D8）：{collapsed, evicted} | null。
     与 persistError 分列——「主动收缩」如实提示，不与「写入失败」混淆；
     随下次成功持久化清除。 */
  budgetNote: null
};

/** 逐会话计价产物缓存（D2，客户端模块级持有）；tableVersion = 价目版本计数器。 */
const priceCache = createPriceCache();

/** 分片尺寸缓存（fix-ledger-quota-budget D3）：loadLedger 初始化 / saveLedger
 *  更新 / 替换与清空、导入失效（R3 失效卫生同款）；estimateLedgerBytes 的
 *  水位判定数据源。 */
const ledgerSizeCache = new Map();

/** 本轮变化的会话集（v2 分片保存只写变化会话）；ledgerDirtyAll = 全量落盘标记。 */
const ledgerDirtySids = new Set();
let ledgerDirtyAll = false;
function markLedgerDirty(sessionId) {
  if (typeof sessionId === "string" && sessionId !== "") ledgerDirtySids.add(sessionId);
  else ledgerDirtyAll = true;
}

function ledgerNow() {
  try {
    return loadLedger(typeof localStorage === "undefined" ? null : localStorage, ledgerSizeCache);
  } catch {
    return loadLedger(null, ledgerSizeCache);
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
  /* 缓存失效卫生（R3）：导入替换整体清空计价产物缓存与尺寸缓存；保存走全量落盘。 */
  priceCache.clear();
  ledgerSizeCache.clear();
  ledgerDirtySids.clear();
  ledgerDirtyAll = true;
}

/**
 * 账本变更通知（D3 分两档）：默认立即派发（导入/清除/重建落定等用户可见变更）；
 * 沉淀路径传 {coalesce: true} 合并派发（~500ms 尾随防抖，挂起期间吸收后续通知）。
 * 版本号即增是唯一事实源——useLedgerVersion 挂载初值直读，防抖挂起不丢状态。
 */
function notifyLedgerChanged(options) {
  ledgerNotifier.notify(options);
}

function scheduleLedgerSave() {
  if (ledgerRuntime.saveTimer !== 0) return;
  ledgerRuntime.saveTimer = setTimeout(() => {
    ledgerRuntime.saveTimer = 0;
    const ledger = ledgerData();
    const activeIds = collectActiveSessionIds();
    /* v2 分片保存只写变化会话（null = 全量）；清空集后再走 v1 兜底也等价。 */
    const changedSids = ledgerDirtyAll ? null : [...ledgerDirtySids];
    ledgerDirtySids.clear();
    ledgerDirtyAll = false;
    const result = persistLedger(
      typeof localStorage === "undefined" ? null : localStorage,
      ledger,
      { nowMs: Date.now(), table: loadPriceTable(typeof localStorage === "undefined" ? null : localStorage), activeIds, changedSids, cache: priceCache, sizeCache: ledgerSizeCache }
    );
    /* 披露态（fix-ledger-quota-budget D8）：固化坍缩/逐出与写入失败分列；
       披露随下次成功持久化清除（失败且未收缩时保留既有披露）。 */
    const prevError = ledgerRuntime.persistError;
    const prevBudget = ledgerRuntime.budgetNote;
    ledgerRuntime.persistError = !result.ok;
    const shrank = result.evicted === true || result.collapsed > 0;
    if (result.ok || shrank) {
      ledgerRuntime.budgetNote = shrank
        ? { collapsed: result.collapsed, evicted: result.evictedSessions.length }
        : null;
    }
    if (result.aged || prevError !== ledgerRuntime.persistError || prevBudget !== ledgerRuntime.budgetNote) {
      notifyLedgerChanged();
    }
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

/* 自动修复节流（fix-ledger-storm）：深补对「空模型桶」会话修不到根（桶不因重放
   消失），若无节流则每开一次总览就全量拉一遍宿主历史——既有深补管线配合老化
   曾经把会话内容垒出 3×/4×。节流按会话持久化（跨页面重载），24h 至多自动尝试
   一次；手动「补全此会话」/「重建全部账本」不受节流限制。 */
const REPAIR_ATTEMPT_KEY = "dsh-v-token-insight.repair-attempt.v1";
const REPAIR_ATTEMPT_TTL_MS = 24 * 3_600_000;

function repairAttemptsRead() {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(REPAIR_ATTEMPT_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function repairAttemptRecord(sid) {
  try {
    if (typeof localStorage === "undefined") return;
    const attempts = repairAttemptsRead();
    attempts[sid] = Date.now();
    localStorage.setItem(REPAIR_ATTEMPT_KEY, JSON.stringify(attempts));
  } catch {
    /* 尽力而为：节流记录失败只影响下次多试一次 */
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
        markLedgerDirty(sessionId);
        scheduleLedgerSave();
        notifyLedgerChanged({ coalesce: true }); /* 沉淀路径：合并派发（D3） */
      }
    } catch {
      /* 沉淀失败不影响统计渲染（账本是尽力而为的旁路） */
    }
  }, LEDGER_INGEST_DEBOUNCE_MS);
  ledgerIngestTimers.set(sessionId, timer);
}

/** useLedgerVersion：账本变更版本号（沉淀/老化/清除后重算总览聚合）。
 *  挂载初值直读当前版本（版本号即增是事实源，通知防抖挂起不丢状态）。 */
function useLedgerVersion() {
  const [version, setVersion] = useState(ledgerNotifier.version);
  useEffect(() => {
    const onChange = () => setVersion(ledgerNotifier.version);
    window.addEventListener(LEDGER_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(LEDGER_CHANGED_EVENT, onChange);
  }, []);
  return version;
}

/* ------------------------------------------------------------------ *
 * 深度补全（按会话 opt-in）：session.history 离线折算入账本
 * ------------------------------------------------------------------ */

const DEEP_COMPLETION_MAX_PAGES = 20;
const DEEP_COMPLETION_PAGE_MESSAGES = 200; /* follow 开帧 / page 翻页的消息页大小（恢复旧预算口径：20 × 200） */

/* 重建分批限流（fix-ledger-storm）：单次「重建全部账本」至多处理的会话数与批内
   逐会话 pacing。全量重建逐会话拉取完整宿主历史，无预算的一次拉完曾把宿主进程
   （dsh web）堆打进 4GB OOM——批间由覆盖判据自然续跑（点继续接着下一批）。 */
const REBUILD_BATCH_SESSIONS = 40;
const REBUILD_PACE_MS = 150;

/**
 * 运行态排除判据（fix-deep-completion-host-pressure D1/D2）：会话是否因「运行中」
 * 被排除出深补候选——「重建全部账本」与定向自动修复共用（显式单会话「补全此
 * 会话」不拦：用户对单个会话的显式知情动作，单会话负载有界，D5）。排除条件 =
 * 自身行 `running === true`，或（仅 subagent 委派子会话行）其父会话行
 * `running === true`——风暴期间父会话与刚落盘的冷子会话同属一个拥堵窗口，且父
 * 运行中时子会话集合仍在增长、覆盖判据不稳定（移动靶不拍）。fork 分支行（有
 * parentId 而 origin 非 "subagent"）豁免父规则：fork 日志不随父会话增长。自身行
 * 或父行在列表快照缺席时 fail-open 不排除——过滤是负载优化，不是正确性前提。
 * 每次调用实时重读列表快照（组装预筛与发起前复核共用同一判据）。
 * @returns {boolean} true = 应排除（不对其发起任何 page 请求）。
 */
function isRunningExcludedSession(sessionId) {
  try {
    const snapshot = pluginCtx?.get?.("sessions")?.list?.getSnapshot?.();
    const row = snapshot?.byId?.[sessionId];
    if (!row) return false;
    if (row.running === true) return true;
    if (row.origin === "subagent" && typeof row.parentId === "string") {
      const parent = snapshot?.byId?.[row.parentId];
      return parent?.running === true;
    }
    return false;
  } catch {
    return false;
  }
}

/** 深补数据源不可用（宿主 typert 面缺席 / 会话地址缺席——如会话不在数据面）。 */
function isHistoryUnavailableError(error) {
  return error?.unavailable === true;
}

/**
 * 拉取并离线折算一个会话的完整历史（不打开会话）。
 * 0.1.2-rc.1：session.history RPC 已移除，且 binding(id).session.loadOlder() 被
 * openState 门控 → 走宿主公开 typert 面。**纯 page 深补（fix-ledger-storm）**：
 * 旧实现先 `follow({address})` 开帧取 cursor——但宿主对 follow 开帧的 prepared
 * 会话执行 retain+promote（后台激活进常驻会话池，流中止不撤销），全量重建把
 * 每个会话都常驻化，宿主（dsh web）堆随重建累计直至 OOM。改为纯
 * `page({address, throughSeq, beforeSeq})` 向前翻页：page 的观测对象每请求
 * dispose（宿主侧逐请求释放，无驻留累积），cursor 由超界探测获得——宿主对
 * throughSeq 超过 cursor 的请求拒绝并在消息中携带真实 cursor
 * （"session page through seq X is past cursor Y"），一次 1 条消息的探测即可定位。
 * records 同为 SessionHistoryRecord（{type:"event"} 提取事件 / {type:"chunks"}
 * 压缩行跳过），按 seq 去重。与 staging 无关，重建全部账本可用。
 * 宿主友好节奏（fix-deep-completion-host-pressure D4/D6）：相邻 page 请求之间保持
 * pacing.mjs 导出的常规档间隙；翻页请求采集 RTT（cursor 探测排除在采样外——其
 * 承载冷会话全量物化成本，属冷加载尖峰非拥塞信号），拥塞时按确定性纯函数
 * nextGapMs 指数退避（封顶可中止）、回落回常规档；页间等待与取消信号竞速。
 * @returns {entries, truncated, pages}（foldHistoryEvents 的产物汇总）。
 * 失败抛错（调用方 fail-soft 展示，不影响其他会话）；地址缺席时抛
 * `unavailable` 错误，调用方按不可用降级提示。
 */
const DEEP_CURSOR_PROBE_SEQ = 2147483647;

async function sessionCursorProbe(remoteSession, address, signal) {
  const result = await remoteSession.page(
    { address, throughSeq: DEEP_CURSOR_PROBE_SEQ, maxMessages: 1 },
    signal
  );
  if (result?.ok) return -1; /* 探测不应成功：真到达说明会话历史空前 */
  const message = String(result?.error?.message ?? "");
  const match = message.match(/past cursor (\d+)/);
  if (!match) throw new Error(`history cursor probe failed: ${message || "unrecognized rejection"}`);
  return Number(match[1]);
}

async function ledgerDeepComplete(sessionId, onProgress, { maxPages = DEEP_COMPLETION_MAX_PAGES } = {}) {
  const sessions = pluginCtx?.get?.("sessions");
  const remoteSession = pluginCtx?.get?.("remote")?.session;
  if (!remoteSession?.page) {
    const error = new Error("history data source unavailable");
    error.unavailable = true;
    throw error;
  }
  /* 子会话须用 subagent 地址变体，且 wire schema 强制要求 mode（"session/follow
     rejected \"request\"" 实机教训——TS 类型未体现该字段）。地址来源：
     subagentAddress()（保留地址，自带 mode）→ 父会话目录条目的 mode（目录缺席时
     先经公开的 refreshSubagents(parentId) 拉取，同父兄弟复用在途/缓存）；普通会话
     与 fork 副本（自有日志）用 session 形态。 */
  const row = sessions?.list?.getSnapshot?.()?.byId?.[sessionId];
  const parentId = typeof row?.parentId === "string" ? row.parentId : void 0;
  let address = { kind: "session", sessionId };
  const sub = sessions?.subagentAddress?.(sessionId);
  if (sub) {
    address = { kind: "subagent", parentSessionId: sub.parentSessionId, childSessionId: sessionId, mode: sub.mode };
  } else if (row?.origin === "subagent" && parentId) {
    try {
      await sessions?.refreshSubagents?.(parentId);
    } catch {
      /* 父目录拉取失败 → 下方目录条目缺席分支如实报错 */
    }
    const entry = sessions?.list
      ?.getSnapshot?.()
      ?.subagentsByParent?.[parentId]?.entries?.find((candidate) => candidate?.kind === "child" && candidate?.id === sessionId);
    if (entry?.mode) {
      address = { kind: "subagent", parentSessionId: parentId, childSessionId: sessionId, mode: entry.mode };
    } else {
      const error = new Error(`subagent durable address unavailable (parent catalog has no entry for ${sessionId})`);
      error.unavailable = true;
      throw error;
    }
  }
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const signal = controller?.signal;
  /* 页间等待与取消信号竞速（fix-deep-completion-host-pressure D4/D6）：abort 后
     立即让出、不再发起后续请求，也不拖延 finally 的清理路径。 */
  const pageGapSleep = (ms) =>
    new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });
  try {
    const cursor = await sessionCursorProbe(remoteSession, address, signal); /* 探测请求：不采样 RTT（冷加载尖峰非拥塞信号，D6） */
    const bySeq = new Map();
    let oldest = cursor;
    const collect = (records) => {
      for (const record of records ?? []) {
        if (record?.type !== "event") continue; /* {type:"chunks"} 压缩 Assistant 增量行：无逐事件语义，跳过 */
        const event = record.event;
        if (!event || !Number.isFinite(event.seq)) continue;
        bySeq.set(event.seq, event);
        oldest = oldest === null ? event.seq : Math.min(oldest, event.seq);
      }
    };
    let hasMore = true;
    let pagesDone = 0;
    /* RTT 退避状态（D6）：EWMA 随单次调用存续（逐会话重置）；仅翻页请求采样，
       nextGapMs 决定下一页间隙——拥塞升档、封顶可中止、回落回常规档。 */
    let ewmaRtt = null;
    let gapMs = PAGE_GAP_BASE_MS;
    let cancelBailed = false;
    while (hasMore && pagesDone < maxPages) {
      pagesDone += 1;
      onProgress?.(pagesDone);
      const beforeSeq = pagesDone === 1 ? void 0 : oldest;
      if (pagesDone > 1 && !Number.isFinite(beforeSeq)) {
        hasMore = false; /* 无 seq 可翻：视为到头（避免死循环） */
        break;
      }
      /* 页间让出（D4）：相邻 page 请求之间的最小间隙（探测与翻页请求亦相邻），
         常规档 PAGE_GAP_BASE_MS（pacing.mjs 唯一源），退避档由 nextGapMs 决定。 */
      await pageGapSleep(gapMs);
      if (signal?.aborted) {
        cancelBailed = true; /* 取消后不再发起后续请求；已收集段按部分覆盖如实标注 */
        break;
      }
      const pageStartedAt = performance.now();
      const result = await remoteSession.page(
        { address, throughSeq: cursor, beforeSeq, maxMessages: DEEP_COMPLETION_PAGE_MESSAGES },
        signal
      );
      ewmaRtt = smoothRtt(ewmaRtt, performance.now() - pageStartedAt); /* 仅翻页样本进 EWMA */
      gapMs = nextGapMs(ewmaRtt, gapMs);
      if (!result?.ok) throw new Error(result?.error?.message ?? "history page request failed");
      const beforeCount = bySeq.size;
      collect(result.value?.records);
      if (bySeq.size <= beforeCount) {
        hasMore = false; /* 翻页无进展：视为到头 */
        break;
      }
      hasMore = result.value?.hasMore === true;
    }
    /* 达预算仍有更早历史（或中途取消让出）→ 如实标注部分覆盖 */
    const truncated = hasMore && (pagesDone >= maxPages || cancelBailed);
    const folded = foldHistoryEvents([[...bySeq.values()]]);
    /* 全量重放先清桶（fix-ledger-storm）：非截断深补取代一切既有聚合——不清桶的话，
       重放条目会在下次老化时与既有桶累加出 2×/3×（风暴）。截断重放不清（会丢
       未重放的更早段），由 upsert 的二次入桶守卫拦住重放段的旧键。 */
    if (!truncated) clearSessionBuckets(ledgerData(), sessionId);
    const changed = upsertSessionEntries(ledgerData(), sessionId, folded.rows, { windowFull: false, nowMs: Date.now() });
    recordDeepCoverageLocal(sessionId, folded, truncated);
    if (changed > 0) {
      markLedgerDirty(sessionId);
      scheduleLedgerSave();
      notifyLedgerChanged({ coalesce: true }); /* 深补亦属沉淀路径：合并派发（D3） */
    }
    const entries = folded.rows.reduce((sum, row) => sum + row.steps.length, 0);
    return { entries, truncated, pages: pagesDone };
  } finally {
    controller?.abort(); /* 中断在途的 history 读取（调用方已放弃本会话时） */
  }
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
    /* 导出兼容旧格式（fix-ledger-quota-budget D5）：条目归一为旧对象编码，
       旧版本插件可导入新备份（回滚安全）。 */
    const text = JSON.stringify(ledgerLegacyBackup(ledgerData()), null, 2);
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

/** 问号图标（口径说明按钮）。 */
function QuestionIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="5.75" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M5.55 5.35c0-.9.65-1.55 1.45-1.55s1.45.58 1.45 1.4c0 .78-.5 1.07-1.02 1.4-.28.19-.43.44-.43.8v.1"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle cx="7" cy="9.95" r="0.8" fill="currentColor" />
    </svg>
  );
}

/**
 * 口径说明（? 按钮）：原口径信息条/各条件脚注收进悬停 tips，不再占用页面空间。
 * 纯 CSS 悬停 + 键盘聚焦（:focus-within）双通道显隐；notes 为过滤后的文案数组，
 * 条目缺失（如无 fork / 无修复）时自然少一行，Tier 0/1 与双口径恒在。
 */
function CaliberHelp({ t, notes }) {
  const items = notes.filter(Boolean);
  return (
    <div className="tsn-help">
      <button type="button" className="tsn-help-btn" aria-label={t("dash.caliber.help")} aria-describedby="tsn-caliber-pop">
        <QuestionIcon />
      </button>
      <div id="tsn-caliber-pop" className="tsn-help-pop" role="tooltip">
        {items.map((note, index) => (
          <span key={index} className="tsn-note tsn-footnote">{note}</span>
        ))}
      </div>
    </div>
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
 * 今日DPS 卡（rework-kpi-charts 2.2/2.3，D2）：今日平均每秒 Token。
 * 父层仅传 todayTokens（views.daily 今日桶，ledger 单遍聚合产物）/ armed，
 * `now` state 由卡内自持——60s 节拍 tick 只重渲染本卡，MUST NOT 落 Dashboard
 * 根组件；总览页关闭即随组件卸载销毁定时器，无后台残留。跨零点无需专用
 * 定时器：elapsed 自洽归零 → 「—」（<60s）→ 满 60s 恢复数值。首帧未 armed
 * 显示「—」（与费用卡首帧行为一致，避免空产物先闪「<1」再跳真值）。
 *
 * 每月预估消费 tips（用户反馈）：DPS 就绪（armed 且已过 60s）且均价可得时，
 * 悬停 tips 追加一行「每月预估消费」= 当前DPS × 2.592 × 当前均价（每百万
 * Token），四舍五入取整——2.592 = 30天 × 24小时 × 3600秒 ÷ 10⁶，即 DPS 稳定
 * 时每月消耗的百万 Token 数（token/s × 2.592M·s = M token/月）。DPS 未就绪
 * 或无均价（无已定价覆盖段）时不追加该行（不虚报 ¥0）；均价随价目表即时联动。
 */
function TodayDpsCard({ todayTokens, armed, avgCost = null, currency, t }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    /* 挂载即对齐一次当前时刻（首帧 useState 初值与节拍间的间隙不再拉大误差），
       其后 60s 节拍驱动分母重算；卸载清理。 */
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const startDate = new Date(now);
  const midnight = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate()).getTime();
  const elapsedMs = Math.max(0, now - midnight);
  const value = armed ? formatTodayDps(todayTokens, elapsedMs) : "—";
  /* 当前DPS 精确比值（卡面只做显示取整）：估计值用未取整比值计算，一次取整
     落在最终金额上（用户口径：当前dps × 2.592 × 当前均价，然后取整）。 */
  const dps = armed && elapsedMs >= 60_000 ? (todayTokens ?? 0) / (elapsedMs / 1000) : null;
  const monthly = dps !== null && Number.isFinite(avgCost) && avgCost > 0 ? Math.round(dps * 2.592 * avgCost) : null;
  const tips =
    monthly === null
      ? t("dash.kpi.dpsSub")
      : `${t("dash.kpi.dpsSub")}\n${t("dash.kpi.dpsMonthly", { value: formatAxisMoney(monthly, currency) })}`;
  /* 单位小字（用户反馈）：数值与「<1」后附小字号「token/s」；「—」为缺席占位，
     不配单位。单位不随语言切换（与会话页速度卡「tok/s」同例）。 */
  return (
    <KpiCard
      label={t("dash.kpi.dps")}
      value={
        value === "—" ? (
          "—"
        ) : (
          <>
            {value}
            <span className="tsn-kpi-unit">token/s</span>
          </>
        )
      }
      title={tips}
    />
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

const COLWIDTHS_KEY = "dsh-v-token-insight.colwidths.v2";
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

/* ---- 座位速度仪表（add-seat-speed-ring，design D1/D3/D4/D7）---- */

/** 当地零点起已过小时数（可带小数；投影比的「已过小时」输入，D1）。 */
function elapsedHoursOfLocalDay(nowMs) {
  const midnight = new Date(nowMs);
  midnight.setHours(0, 0, 0, 0);
  return (nowMs - midnight.getTime()) / 36e5;
}

/** 当前分区色（D7 单色环降级用；按填充落位取彩虹最近站，全令牌）。 */
function seatSpeedZoneColor(fillPct) {
  if (fillPct >= 100) return "var(--dsw-static-red-400)";
  if (fillPct >= 83) return "var(--dsw-static-amber-500)";
  if (fillPct >= 67) return "var(--dsw-static-green-500)";
  if (fillPct >= 33) return "var(--dsw-static-green-400)";
  if (fillPct >= 17) return "var(--dsw-static-blue-400)";
  return "var(--dsw-static-blue-500)";
}

/**
 * wide 底边彩虹条（揭示式，D4）：轨道 = 固定彩虹渐变（低不透明度），填充层 =
 * 同一渐变按进度裁切——width + background-size 技巧（background-size =
 * 100%/fillPct，渐变恒以轨道宽为基准，不随填充压缩，前沿颜色即当前分区）。
 * 纯装饰 aria-hidden；pointer-events:none 由 CSS 保证（不截获指针事件）。
 * fillPct 已按 1% 量化：memo 门闩下未跨档不重渲染本层（D3 量化门闩）。
 */
const SeatSpeedBar = memo(function SeatSpeedBar({ fillPct }) {
  if (!(fillPct > 0)) return null;
  return (
    <span className="tsn-seat-speed" aria-hidden="true">
      <span className="tsn-seat-speed-track" />
      <span
        className="tsn-seat-speed-fill"
        style={{ width: `${fillPct}%`, backgroundSize: `${((100 / fillPct) * 100).toFixed(4)}% 100%` }}
      />
    </span>
  );
});

/**
 * 56px 导轨彩虹环（D4/D7）：conic 彩虹 + 双层 mask 嵌套揭示——外层 fillwrap 环状
 * mask（radial 掏空成 2.5px 圆环，贴 36px 圆钮盒内缘避免宿主溢出裁剪）× 内层
 * fill 角度 mask（conic 楔形，--tsn-p 为填充百分比，经 @property 注册为 <number>
 * 以支持 150–200ms 角度过渡）。mask 不可用环境由 CSS @supports 降级为 zone
 * 分区色单色环（--tsn-zone），非功能缺失。
 */
const SeatSpeedRing = memo(function SeatSpeedRing({ fillPct, zone }) {
  if (!(fillPct > 0)) return null;
  return (
    <span className="tsn-seat-speedring" aria-hidden="true">
      <span className="tsn-seat-speedring-track" />
      <span className="tsn-seat-speedring-fillwrap">
        <span className="tsn-seat-speedring-fill" style={{ "--tsn-p": fillPct, "--tsn-zone": zone }} />
      </span>
    </span>
  );
});

/**
 * 侧栏底部动作座位（sidebar.footer.action 条目组件）。
 * owner props：{ wide }（侧栏展开=图标+文字，56px 导轨=纯图标）；root 作用域
 * 标准 props 的 useSessions 供速度仪表派生 fork 集合（add-seat-speed-ring，
 * StatsOverviewOverlay 同款直接解构，零注册面变化；缺席 → 仪表整体不渲染，D7）。
 * DOM 结构与样式镜像官方「设置」座位（SettingsRoot trigger + TriggerContent）：
 * wide 图标 16px / 导轨图标 18px，按钮 chrome 与设置触发器同值同排版。
 *
 * 速度仪表（纯装饰层，D3 零卡顿预算）：事件驱动零轮询——useLedgerVersion（账本
 * 通知总线，500ms 尾随合并）+ usePlanVersion（计划事件）+ 下一零点单发自重装
 * timeout；无 setInterval/rAF/CSS 循环动画，空闲零 CPU。重算 = ledgerTokensForDay
 * （O(今日条目) 加法，零计价零缓存）+ 一次除法；填充经 1% 量化 + memo 门闩，
 * 未跨档不重渲染仪表层。座位注册、开合、焦点行为全部不变（非侵入约束）。
 */
const DashboardSeat = function DashboardSeat({ wide, t, useSessions }) {
  const open = useDashboardOpen();
  const toggle = () => {
    const next = !dashboardOpenStore.getSnapshot();
    dashboardOpenStore.set(next);
    if (!next) dashboardSeatElement?.focus?.();
  };
  const ref = (element) => {
    dashboardSeatElement = element;
  };

  /* ---- 速度仪表数据面（add-seat-speed-ring）---- */
  const sessions = typeof useSessions === "function" ? useSessions((s) => s) : null;
  const ledgerVersion = useLedgerVersion();
  const planVersion = usePlanVersion();
  const [dayVersion, setDayVersion] = useState(0);
  /* 下一零点单发自重装（D3）：跨零点今日累计归零重算；触发后重新武装下一零点
     （每次仍单发，非轮询）。 */
  useEffect(() => {
    let timer = 0;
    const arm = () => {
      const now = new Date();
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
      timer = setTimeout(() => {
        setDayVersion((value) => value + 1);
        arm();
      }, Math.max(1000, next.getTime() - now.getTime() + 500));
    };
    arm();
    return () => clearTimeout(timer);
  }, []);

  /* fork 集合（D3 联接键门闩）：ids + fork 标志拼接为字符串键，列表推送不改
     ids/fork 标志时不重派生（Set 引用稳定 → 下游 memo 不重算）。fork 判定与
     expandRows 同式：有 parentId 且非 subagent 委派 = 用户 fork 的分支副本。 */
  const forkJoinKey = useMemo(() => {
    if (!sessions) return null;
    const ids = sessions.ids ?? [];
    const byId = sessions.byId ?? {};
    let key = "";
    for (let i = 0; i < ids.length; i += 1) {
      const row = byId[ids[i]];
      if (typeof row?.id !== "string") continue;
      key += `${row.id}:${typeof row.parentId === "string" && row.origin !== "subagent" ? 1 : 0};`;
    }
    return key;
  }, [sessions]);
  const forkIds = useMemo(() => {
    if (forkJoinKey === null) return null;
    const set = new Set();
    const ids = sessions.ids ?? [];
    const byId = sessions.byId ?? {};
    for (let i = 0; i < ids.length; i += 1) {
      const row = byId[ids[i]];
      if (typeof row?.id !== "string") continue;
      if (typeof row.parentId === "string" && row.origin !== "subagent") set.add(row.id);
    }
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forkJoinKey]);

  const plan = currentPlan(planVersion);
  /* 今日累计（D2 口径）：账本/计划/零点事件驱动，零计价、零缓存、fork 剔除。 */
  const todayTokens = useMemo(() => {
    if (forkIds === null) return null;
    try {
      return ledgerTokensForDay(ledgerData(), dayKeyOf(Date.now()), forkIds);
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledgerVersion, dayVersion, forkIds]);

  /* 投影比 + 1% 量化（add-seat-speed-ring D1/D3 + add-monthly-plan D7）：仪表只读
     每日计划——plan?.daily > 0 显式守卫（不依赖 seatSpeedGauge 内部门闩假设），
     未设计划或仅设月值（daily 为 null）时保持无标尺静默形态；今日无覆盖消耗同样
     → null = 仪表不渲染、座位回到现状形态；MUST NOT 把计划当作 0 参与计算。 */
  const gauge = useMemo(() => {
    if (!todayTokens || !(plan?.daily > 0)) return null;
    const result = seatSpeedGauge(totalTokensBuckets(todayTokens), elapsedHoursOfLocalDay(Date.now()), plan.daily);
    if (result === null || !(result.fillPct > 0)) return null;
    return { speedPct: result.speedPct, fillPct: result.fillPct, zone: seatSpeedZoneColor(result.fillPct) };
  }, [plan, todayTokens]);
  /* 悬停读数（D6）：仪表数值的唯一无障碍信息源，追加于座位 title/aria-label。 */
  const speedTitle = gauge === null ? null : t("dash.seat.speedTitle", { value: gauge.speedPct });

  if (wide) {
    return (
      <div className="tsn-seat" data-active={open || void 0}>
        <button
          type="button"
          className="tsn-seat-row"
          ref={ref}
          data-plugin-anchor="token-insight:seat"
          aria-expanded={open}
          title={speedTitle ? `${t("dash.seat")} · ${speedTitle}` : void 0}
          onClick={toggle}
        >
          <SeatIcon size={16} />
          <span className="tsn-seat-label">{t("dash.seat")}</span>
          {gauge === null ? null : <SeatSpeedBar fillPct={gauge.fillPct} />}
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
        aria-label={speedTitle ? `${t("dash.seat.aria")} · ${speedTitle}` : t("dash.seat.aria")}
        aria-expanded={open}
        title={speedTitle ? `${t("dash.seat")} · ${speedTitle}` : t("dash.seat")}
        onClick={toggle}
      >
        <SeatIcon size={18} />
        {gauge === null ? null : <SeatSpeedRing fillPct={gauge.fillPct} zone={gauge.zone} />}
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

/** 右轴金额刻度（rework-kpi-charts D3）：实现与单测在 pricing.mjs（formatAxisMoney），
 *  0<c<1 至多 4 位小数剥尾零、MUST NOT 取整坍缩为 ¥0.0000；本文件仅消费。 */

/**
 * 双轴组合趋势图（总览合并卡 + 会话页「每轮消耗与花费」同款）：
 * token 四桶堆叠柱（左轴）+ 费用折线（右轴），共享同一 x 桶轴——费用点按行键
 * 对齐柱位中心，无费用行折线断开。复用 charts.mjs dualAxisTrendLayout；网格线
 * 只保留左轴一组，右轴只放刻度文本。
 * 零刻度省略（rework-kpi-charts 3.1，D3）：左轴 0 刻度保留基线网格线、跳过轴标
 * 文本；右轴 costTicks 过滤 cost <= 0（纯文本无网格，整条跳过）。省略只在渲染
 * 侧执行——布局产物形状不变（charts.test 回归锁定）。
 * 泛化 props（rework-kpi-charts 4.1，缺省行为不变、总览零回归）：
 *  - onBarClick(turn)：柱点击回调（会话页传 jumpToTurn；缺省无点击行为）；
 *  - xLabelOf(key)：x 轴标格式化（缺省既有日期 labelOf；会话页传 `#${turn}`）；
 *  - sparseX：true 时复用 stackedBarsLayout 既有 xLabels 稀疏刻度（至多 8 个），
 *    false/缺省保持全量 + 交错双行（会话轮数可达数十轮，交错全量会挤爆）；
 *  - target：可选目标参考柱（add-monthly-plan D6：目标对象整体传入）{key, value,
 *    legendKey?, titleKey?}——key/value 为布局几何所需（key 匹配行键 turn|day，
 *    颗粒度无关：日颗粒度即今日日键、月颗粒度即本月月键；value 参与左轴缩放，
 *    几何由布局产出）；legendKey/titleKey 为图例小样与悬停读数的文案键（随颗粒度
 *    区分「今日目标（计划）/ 本月目标（计划）」，缺省回退现日文案键防御）。渲染为
 *    非实心虚线轮廓框（tsn-bar-target），叠于目标桶柱位且外扩 2px 形成「目标框」
 *    ——计划 > 实际时框体高出柱顶直观可读差距，计划 < 实际时框顶线横穿柱体充当
 *    目标刻度线；带原生 title 悬停读数。fill:none 只在描边处命中指针，不遮挡
 *    数据柱的悬停高亮联动。
 *  - smallXTick：x 轴时间标缩字号（用户反馈：总览页签日期标不必突出）——true
 *    时 x 轴标加挂 tsn-tick-x（8px，较 tsn-tick 10px 基线退一档）。总览整页卡
 *    铺满页宽、640 视窗拉伸放大最明显；缺省 false，会话页 sparseX 刻度零回归。
 */
function TrendDualChart({ rows, costByKey, currency, t, ariaLabel, onBarClick, xLabelOf, sparseX, target = null, smallXTick = false }) {
  const staggered = !sparseX && rows.length > 12;
  const layout = useMemo(
    () => dualAxisTrendLayout(rows, costByKey, { pad: { top: 8, right: 64, bottom: staggered ? 34 : 20, left: 44 }, target }),
    [rows, costByKey, staggered, target]
  );
  if (rows.length === 0) return null;
  const labelOf = xLabelOf ?? ((day) => {
    if (day === "older") return t("dash.date.older");
    return day.length > 5 ? day.slice(5) : day;
  });
  const xTickClass = smallXTick ? "tsn-tick tsn-tick-x" : "tsn-tick";
  return (
    <svg className="tsn-chart" viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label={ariaLabel}>
      {/* 左轴刻度（3.1）：0 刻度只画基线网格线、跳过轴标文本。 */}
      {layout.ticks.map((tick) => (
        <g key={tick.y}>
          <line x1={layout.pad.left} x2={layout.width - layout.pad.right} y1={tick.y} y2={tick.y} className="tsn-grid" />
          {tick.value === 0 ? null : (
            <text x={layout.pad.left - 4} y={tick.y + 3} textAnchor="end" className="tsn-tick">
              {formatAxisTokens(tick.value)}
            </text>
          )}
        </g>
      ))}
      {layout.bars.map((bar) => (
        <g key={bar.turn} className="tsn-bar" onClick={onBarClick ? () => onBarClick(bar.turn) : undefined}>
          <title>{`${typeof bar.turn === "number" ? `#${bar.turn}` : bar.turn} · ${formatTokens(bar.total)}`}</title>
          {bar.segments.map((segment) => (
            <rect key={segment.key} x={bar.x} y={segment.y} width={bar.w} height={segment.h} rx="2" style={{ fill: segment.color }}>
              <title>{`${segment.label} ${formatTokens(segment.value)}`}</title>
            </rect>
          ))}
        </g>
      ))}
      {/* 今日/本月目标柱（非实心，add-monthly-plan D6）：布局产出的几何外扩 2px 成
          「目标框」叠于数据柱位；置于柱元之后（描边覆盖实心段可见）、费用线之前
          （不压线）。悬停读数文案随颗粒度（titleKey 缺省回退现日文案键防御）。 */}
      {layout.targetBar ? (
        <rect
          x={layout.targetBar.x - 2}
          y={layout.targetBar.y}
          width={layout.targetBar.w + 4}
          height={layout.targetBar.h}
          rx="3"
          className="tsn-bar-target"
        >
          <title>
            {t(typeof target?.titleKey === "string" ? target.titleKey : "dash.chart.dual.targetTitle", {
              value: formatTokens(layout.targetBar.value)
            })}
          </title>
        </rect>
      ) : null}
      {/* 右轴金额刻度（3.1/3.2）：过滤 cost <= 0（无基线网格可留，整条跳过）；
          小金额窗口刻度走修复后的 formatAxisMoney，有效小数、不坍缩为 ¥0.0000。 */}
      {layout.hasCost
        ? layout.costTicks
            .filter((tick) => tick.cost > 0)
            .map((tick) => (
              <text key={`ct${tick.cost}`} x={layout.width - layout.pad.right + 6} y={tick.y + 3} textAnchor="start" className="tsn-tick">
                {formatAxisMoney(tick.cost, currency)}
              </text>
            ))
        : null}
      {layout.hasCost ? layout.costPaths.map((path, index) => <path key={index} d={path} className="tsn-line-cost" />) : null}
      {layout.hasCost
        ? layout.costDots.map((dot) => (
            <circle key={dot.key} cx={dot.x} cy={dot.y} r="2.5" className="tsn-dot-cost">
              <title>{`${typeof dot.key === "number" ? `#${dot.key}` : dot.key} · ${formatMoney(dot.cost, currency)}`}</title>
            </circle>
          ))
        : null}
      {/* x 轴标：sparseX → 稀疏刻度（stackedBarsLayout stride 语义）；缺省 →
          日期全量铺开（用户反馈）、交错双行（>12 桶）或单行居中；去年留 MM-DD。
          smallXTick → 轴标缩字号（tsn-tick-x，总览专用弱化，见组件 doc）。 */}
      {sparseX
        ? layout.xLabels.map((label) => (
            <text key={`x${label.turn}`} x={label.x} y={label.y} textAnchor="middle" className={xTickClass}>
              {labelOf(label.turn)}
            </text>
          ))
        : layout.bars.map((bar, index) => (
            <text
              key={`x${bar.turn}`}
              x={bar.x + bar.w / 2}
              y={staggered ? (index % 2 === 0 ? layout.height - 24 : layout.height - 12) : layout.height - 6}
              textAnchor="middle"
              className={xTickClass}
            >
              {labelOf(bar.turn)}
            </text>
          ))}
    </svg>
  );
}

/**
 * 双轴图例：柱色小样（四桶色条）+ 费用线小样，标注左右轴语义。
 * 键名参数化（rework-kpi-charts 4.3）：缺省沿用总览既有文案（per-step 口径），
 * 会话页传 `stats.chart.dual.tokens/cost`，不强行复用总览口径字样。
 * target（用户反馈 + add-monthly-plan D6）：目标参考柱在场时追加第三项小样
 * （空心虚线矩形，与 tsn-bar-target 同款式样）——颜色不是目标柱的唯一信息通道。
 * prop 为目标对象 {legendKey?, ...} 或 null（原布尔形态收窄为对象：小样文案经
 * t(target.legendKey) 随颗粒度区分「今日目标（计划）/ 本月目标（计划）」，
 * legendKey 缺省回退现日文案键防御）；null/缺省不渲染小样——会话页签不传
 * target 的用法零变化。
 */
function DualAxisLegend({ t, tokensLabel, costLabel, target = null }) {
  return (
    <div className="tsn-dual-legend">
      <span>
        <svg width="20" height="10" aria-hidden="true">
          {BUCKET_SEGMENTS.map((segment, index) => (
            <rect key={segment.key} x={index * 5} y="0" width="4" height="10" rx="1" style={{ fill: segment.color }} />
          ))}
        </svg>
        {tokensLabel ?? t("dash.chart.dual.tokens")}
      </span>
      <span>
        <svg width="20" height="10" aria-hidden="true">
          <line x1="1" y1="5" x2="19" y2="5" className="tsn-line-cost" strokeWidth="2" />
        </svg>
        {costLabel ?? t("dash.chart.dual.cost")}
      </span>
      {target ? (
        <span>
          <svg width="20" height="10" aria-hidden="true">
            <rect x="4" y="1" width="12" height="8" rx="2" className="tsn-bar-target" />
          </svg>
          {t(typeof target.legendKey === "string" ? target.legendKey : "dash.chart.dual.target")}
        </span>
      ) : null}
    </div>
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
 * 总览页几何帧：AppFrame 三列 grid 的侧栏列（真实盒子：`.sidebarCol` 有背景/
 * 描边，非 display:contents）右缘测量 + ResizeObserver 跟踪（拖拽/折叠/导轨）。
 * 锚定：frame → closest("[data-shell-overlay]")（层容器，inset:0 真实盒）→
 * parentElement（AppFrame frame）→ firstElementChild（sidebarCol——
 * DocumentTitle 渲染 null）。注意 overlay 槽在层容器与条目之间还有一层
 * display:contents 的 SlotOutlet（零 rect），MUST 用属性 closest 定位而非
 * parentElement 计数；旧锚 [data-slot="sidebar"] 已随 0.1.2-rc.1 移除。
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
    const overlayLayer = () => {
      try {
        return frameRef.current?.closest?.("[data-shell-overlay]") ?? null;
      } catch {
        return null;
      }
    };
    const sidebarColumn = () => {
      try {
        return overlayLayer()?.parentElement?.firstElementChild ?? null;
      } catch {
        return null;
      }
    };
    const apply = () => {
      const column = sidebarColumn();
      /* 层容器（[data-shell-overlay]，inset:0 于 AppFrame 的真实盒）为原点——
         以其左缘为原点，避免 AppFrame 不在视口原点时的坐标漂移。 */
      const overlay = overlayLayer();
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

/* 页签结构（design D1）：「按时间」页签删除——颗粒度切换并入总览页签；
   「计划」页签尾插（设置语义归 token-stats-plan 能力，总览承接入口）。BREAKING。 */
const DASH_TABS = ["overview", "workspaces", "sessions", "models", "pricing", "plan"];

/* 首帧让位的空聚合视图（只读共享：下游均为只读消费，见 aggregate* 契约）。 */
const EMPTY_LEDGER_VIEWS = { bySession: new Map(), byModel: [], daily: new Map(), dailyBucketsBySession: new Map(), coveredBucketsBySession: new Map(), coveredIds: new Set(), anyCovered: false };
const EMPTY_DAILY_COST = new Map();

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
  /* 投影缺席兜底（dsh-012-compat 实机修订 3）：升级后投影检查点版本门槛使冷会话
     列表行不携带投影——四桶按账本覆盖段口径回退，脚注明示回退会话数。
     声明顺序：fallbackBuckets 必须先于 expanded（其依赖数组即时求值，TDZ）。 */
  const fallbackBuckets = useMemo(() => ledgerSessionBuckets(ledgerData()), [ledgerVersion]);
  const expanded = useMemo(() => expandRows(rows, fallbackBuckets), [rows, fallbackBuckets]);
  const fallbackCount = useMemo(
    () => expanded.reduce((count, item) => count + (item.usageSource === "ledger" ? 1 : 0), 0),
    [expanded]
  );
  const archivedIds = useMemo(() => new Set(workspaces?.archivedSessionIds ?? []), [workspaces]);
  /* fork 分支副本：投影是父会话消耗的种子复制，聚合时排除（行保留 + 徽标注）。 */
  const forkIds = useMemo(() => new Set(expanded.filter((item) => item.isFork).map((item) => item.id)), [expanded]);
  /* 聚合签名：行数 + 权威总量（投影推送不改变总量时跳过重的账本重聚合）。 */
  const rowsSignature = useMemo(
    () => `${rows.length}:${expanded.reduce((sum, item) => sum + (item.usage === null ? 0 : totalTokensBuckets(item.usage)), 0)}`,
    [rows, expanded]
  );
  /* 首帧让位（D5/R5，tasks 6.1）：宿主 React ≥18 已核实（本文件已使用
     useSyncExternalStore），重聚合输入经 useDeferredValue 包裹让过交互帧；
     挂载首帧 useDeferredValue 不让（初值即同步），另以「下一帧置位」让出
     首帧（空态/骨架先上屏）。useMemo 工厂不可中断——聚合帧开始后仍可能一次
     阻塞，暖缓存（D2 产物缓存）后该帧量级小，目标口径 = 首帧不被挡。 */
  const [aggregateArmed, setAggregateArmed] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setTimeout(() => setAggregateArmed(true), 0));
    return () => cancelAnimationFrame(raf);
  }, []);
  const deferredLedgerVersion = useDeferredValue(ledgerVersion);
  const deferredRowsSignature = useDeferredValue(rowsSignature);
  const views = useMemo(
    () =>
      aggregateArmed
        ? aggregateLedgerViews(ledgerData(), table, expanded, forkIds, priceCache, priceVersion)
        : EMPTY_LEDGER_VIEWS,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [aggregateArmed, deferredLedgerVersion, table, deferredRowsSignature, forkIds, priceVersion]
  );
  const dailyCost = useMemo(
    () => (aggregateArmed ? priceDailyCost(ledgerData(), table, priceCache, priceVersion, forkIds) : EMPTY_DAILY_COST),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [aggregateArmed, deferredLedgerVersion, table, priceVersion, forkIds]
  );
  /* 今日DPS 分子（rework-kpi-charts D2 / 任务 2.2）：views.daily 今日桶四桶总量。
     views.daily 由既有单遍聚合产出且已剔 fork（与趋势「今日」桶构造上同值、与
     座位速度环今日累计同值）——复用既有产物，零新增账本重放、与价目无关
     （价目版本不进依赖，价目变更不触发其重算）。 */
  const dpsTodayTokens = useMemo(
    () => totalTokensBuckets(views.daily.get(dayKeyOf(Date.now()))?.buckets),
    [views]
  );
  const kpi = useMemo(() => {
    let cost = 0;
    let covered = 0;
    for (const [sid, result] of views.bySession) {
      if (forkIds.has(sid)) continue; /* fork 副本费用不计入 KPI */
      if (!result.covered) continue;
      covered += 1;
      if (result.cost !== null) cost += result.cost;
    }
    return aggregateKpi(expanded, archivedIds, views.anyCovered ? { amount: cost, currency: displayCurrencyOf(table), covered, count: expanded.length } : null);
  }, [views, expanded, archivedIds, table, forkIds]);
  const workspaceRows = useMemo(() => aggregateWorkspaces(expanded, workspaces, views.bySession), [expanded, workspaces, views]);
  /* 趋势余量（fix-partial-coverage 1.3）：已覆盖会话的未覆盖余量（投影 − 已按日
     入柱，computeTrendRemainders 纯函数），随 views 单遍产物现算——零第二次账本
     重放。覆盖段（views.daily）/ 部分覆盖余量 / 未覆盖整桶三路径互斥不重复计。 */
  const trendRemainders = useMemo(() => computeTrendRemainders(expanded, views.dailyBucketsBySession), [expanded, views]);
  /* 余量披露（fix-partial-coverage 3.1）：非零会话数与四桶总量，信息条消费。 */
  const remainderStats = useMemo(() => {
    let tokens = 0;
    for (const remainder of trendRemainders.values()) tokens += totalTokensBuckets(remainder);
    return { sessions: trendRemainders.size, tokens };
  }, [trendRemainders]);
  /* 账面价披露（ledger-recorded-pricing D2/D3）：价目指纹不一致 →「旧价目」；
     引擎版本戳落后 →「待重算」。读 ledgerData().sessions 的 pricing 字段 + 当前价目
     指纹，零计价重放（pending 展示口径）。 */
  const pricingDisclosure = useMemo(() => {
    let staleTable = 0;
    let needsReprice = 0;
    for (const sid of Object.keys(ledgerData().sessions)) {
      const status = pricingStatusOf(ledgerData(), sid, table);
      if (!status) continue;
      if (status.staleTable) staleTable += 1;
      if (status.needsReprice) needsReprice += 1;
    }
    return { staleTable, needsReprice };
  }, [table, ledgerVersion]);
  /* D2 三层产物管线（merge-time-tab-add-plan）：颗粒度重排 ≠ 重算——三层皆消费
     views.daily 逐会话缓存产物，颗粒度切换不触发任何步级重放（与「账本聚合计算
     预算」的单遍计价/逐会话缓存语义相容）。
     ① 日粒度基准行（不出图）：仅用于 ② 的费用点日键并集派生——若误用月/年键
        派生日键并集，月/年档费用线会静默丢点。 */
  const dayTrendRows = useMemo(() => aggregateByTime(expanded, views.daily, views.coveredIds, { remainders: trendRemainders }), [expanded, views, trendRemainders]);
  /* ② 费用点日键并集：基准行日键 ∪ dailyCost 键（「更早」不入费用线）。 */
  const trendCostPoints = useMemo(() => {
    const days = new Set([...dayTrendRows.map((row) => row.day), ...dailyCost.keys()]);
    const sorted = [...days].filter((day) => day !== "older").sort();
    return sorted.map((day) => ({ day, cost: dailyCost.get(day)?.cost ?? 0 }));
  }, [dayTrendRows, dailyCost]);
  /* 颗粒度（day/month/year）：原「按时间」页签能力，现为总览页签内嵌控件
     （状态留本层随页面卸载重置，与既有生命周期一致）。 */
  const [timeGranularity, setTimeGranularity] = useState("day");
  /* ③ 颗粒度趋势行：消耗趋势图数据，双口径标记（source === "recent"）在其上判定。 */
  const timeTrendRows = useMemo(
    () => aggregateByTime(expanded, views.daily, views.coveredIds, { granularity: timeGranularity, maxBuckets: 30, remainders: trendRemainders }),
    [expanded, views, timeGranularity, trendRemainders]
  );
  /* ③ 颗粒度费用点：费用趋势图 + 金额明细表（month/year 归并、不画「更早」点）。 */
  const timeCostPoints = useMemo(() => groupCostByGranularity(trendCostPoints, timeGranularity), [trendCostPoints, timeGranularity]);
  const costCurrency = kpi.cost?.currency ?? displayCurrencyOf(table);

  /* 全局均价估计：总费用 ÷ 已定价覆盖段 token 总量 × 10⁶。分子分母取同一人群
     （已定价覆盖会话），覆盖率提升后逼近真实全局均值——若用全会话 token 做分母，
     未覆盖部分会把均值稀释失真。 */
  const pricedTokenTotal = useMemo(() => {
    let sum = 0;
    for (const item of expanded) {
      if (item.isFork) continue; /* fork 副本 token 不进均价分母 */
      const priced = views.bySession.get(item.id);
      if (priced?.covered && priced.cost !== null && item.usage) sum += totalTokensBuckets(item.usage);
    }
    return sum;
  }, [expanded, views]);
  const avgCostPerMTok =
    kpi.cost && kpi.cost.covered > 0 && kpi.cost.amount > 0 && pricedTokenTotal > 0
      ? (kpi.cost.amount * UNIT) / pricedTokenTotal
      : null;

  /* 定向自动修复（fix-ledger-attribution / fix-partial-coverage 2.3）：候选集 =
     「不可归因条目会话」∪「覆盖缺口会话」并集去重。前者：账本存在「模型名为空」
     的条目（旧版本实时沉淀在 trajectory join 缺席时写入），会话被整体判「未定价」；
     后者：会话已有实际覆盖量、其投影超出账本总覆盖（原始条目 + 老化桶，fix-ledger-
     quota-budget 修正基线）的差值合计达阈值（ledgerCoverageGaps）——老化桶是已
     固化的覆盖量，缺口 MUST 以总覆盖计：否则固化会把已覆盖会话误判成全量缺口，
     自动深补风暴（数百会话背靠背 follow/page 开帧）会打爆宿主堆，且固化后缺口
     永不收敛。两者共用同一条既有深补管线（ledgerDeepComplete：follow 开帧 + page
     向后翻页离线折算）。检测输入全部来自打开总览的既有产物：不可归因沿用直读扫描
     （无计价、非重放），覆盖缺口只吃 expanded × views.coveredBucketsBySession
     单遍聚合产物——MUST NOT 引入第二次账本重放。与「重建全部账本」的边界：只碰
     检测出问题的会话，不批量拉取；从未覆盖会话（无键）不构成缺口，不自动拉取。
     串行限速、每会话每次打开总览至多尝试一次（repairTriedRef）、单会话失败
     fail-soft。 */
  const [repair, setRepair] = useState({
    running: false,
    done: 0,
    total: 0,
    failed: 0,
    attribution: { total: 0, done: 0, failed: 0 },
    gap: { total: 0, done: 0, failed: 0 }
  });
  const repairTriedRef = useRef(null);
  const repairBusyRef = useRef(false);
  useEffect(() => {
    if (repairBusyRef.current) return;
    if (repairTriedRef.current === null) repairTriedRef.current = new Set();
    const unattributed = new Set(sessionsWithUnattributedEntries(ledgerData()));
    const gapSessions = ledgerCoverageGaps(expanded, views.coveredBucketsBySession, COVERAGE_GAP_THRESHOLD);
    const attempts = repairAttemptsRead();
    const nowMs = Date.now();
    const targets = [];
    const seen = new Set();
    for (const sid of [...unattributed, ...gapSessions]) {
      if (seen.has(sid) || repairTriedRef.current.has(sid)) continue;
      /* 24h 节流（fix-ledger-storm）：跨重载持久——修不到根的会话不再每次打开总览重拉。 */
      const lastAttempt = Number(attempts[sid]) || 0;
      if (nowMs - lastAttempt < REPAIR_ATTEMPT_TTL_MS) continue;
      /* 运行态剔除（fix-deep-completion-host-pressure D1/D2/D3）：在加入 targets
         （进而加入 repairTriedRef 与 repairAttemptRecord）之前剔除运行中会话——
         不写 24h TTL、不进 once-per-open；其转 idle 后经既有 ledgerVersion 重触发
         机制自然回到候选（会话完成必然推动账本变更 → effect 重跑），兜底 = 下次
         打开总览（repairTriedRef 重建）。 */
      if (isRunningExcludedSession(sid)) continue;
      seen.add(sid);
      /* 同会话两类原因并存时记「不可归因」：一次深补同时修复归属与覆盖。 */
      targets.push({ sid, reason: unattributed.has(sid) ? "attribution" : "gap" });
    }
    if (targets.length === 0) return;
    repairBusyRef.current = true;
    const reasonTotals = {
      attribution: { total: targets.filter((target) => target.reason === "attribution").length, done: 0, failed: 0 },
      gap: { total: targets.filter((target) => target.reason === "gap").length, done: 0, failed: 0 }
    };
    setRepair({ running: true, done: 0, total: targets.length, failed: 0, attribution: { ...reasonTotals.attribution }, gap: { ...reasonTotals.gap } });
    (async () => {
      let done = 0;
      let failed = 0;
      let total = targets.length; /* 发起前复核剔除的目标动态出列（不变量：total − done = 队列中未访问条目数） */
      const byReason = { attribution: { ...reasonTotals.attribution }, gap: { ...reasonTotals.gap } };
      for (const { sid, reason } of targets) {
        /* 发起前 JIT 复核（D1 第二道）：分发期间转运行中的会话跳过不发起、不记账
           ——once-per-open 与 24h TTL 只记「实际发起过深补」的会话（记账紧贴发起），
           转 idle 后自然回到候选。 */
        if (isRunningExcludedSession(sid)) {
          byReason[reason].total -= 1;
          total -= 1;
          setRepair({ running: done < total, done, total, failed, attribution: { ...byReason.attribution }, gap: { ...byReason.gap } });
          continue;
        }
        repairTriedRef.current.add(sid);
        repairAttemptRecord(sid);
        try {
          await ledgerDeepComplete(sid, () => {});
        } catch {
          failed += 1; /* fail-soft：单会话失败（如子会话 RPC 拒绝）不阻塞其余 */
          byReason[reason].failed += 1;
        }
        done += 1;
        byReason[reason].done += 1;
        setRepair({ running: done < total, done, total, failed, attribution: { ...byReason.attribution }, gap: { ...byReason.gap } });
      }
      repairBusyRef.current = false;
    })();
    /* 依赖 views/expanded（单遍聚合产物）：缺口检测随重聚合刷新；once-per-open
       集合保证同会话至多尝试一次，修复成功的会话余量归零后自然退出候选集。 */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledgerVersion, expanded, views]);

  /* 进度/失败提示行（fix-partial-coverage 2.3）：按原因区分——不可归因与覆盖缺口
     各自一条（该原因候选在场才渲染），复用既有信息条位置与风格。 */
  const repairNoteLines = useMemo(() => {
    const line = (kind, r) => {
      if (r.total === 0) return null;
      if (repair.running && r.done < r.total) {
        return t(kind === "gap" ? "dash.repair.gap.running" : "dash.repair.running", { done: r.done, total: r.total });
      }
      if (r.failed > 0) {
        return t(kind === "gap" ? "dash.repair.gap.failed" : "dash.repair.failed", { done: r.done, failed: r.failed });
      }
      return t(kind === "gap" ? "dash.repair.gap.done" : "dash.repair.done", { done: r.done });
    };
    return [line("attribution", repair.attribution), line("gap", repair.gap)];
  }, [repair, t]);

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
  /* 会话三分类（用户反馈）：进行中(运行中) / 活跃(未运行未归档) / 归档，互斥划分
     总数——占比条 3 段与数字 1:1 对应；总数=整条（钳制非负防异常数据越界）。 */
  const sessionActive = Math.max(0, kpi.sessions - kpi.running - kpi.archived);

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
          {/* 卡片顺序（用户反馈）：会话 / 输入 / 输出 / 命中 / 计费token / 花费 / 均价。 */}
          {/* 会话卡（用户反馈三轮）：数字 4 段 = 总会话/进行中/活跃/归档（总数对应
              整条），色彩条 3 段与后三个数字 1:1 同色——进行中=绿、活跃=蓝、
              归档=蓝灰；口径全量收进悬停 tips。 */}
          <KpiCard
            label={t("dash.kpi.sessions")}
            value={
              <>
                <span>{kpi.sessions}</span>
                <span className="tsn-kpi-sep">/</span>
                <span style={{ color: "var(--dsw-static-green-500)" }}>{kpi.running}</span>
                <span className="tsn-kpi-sep">/</span>
                <span style={{ color: "var(--dsw-static-blue-450)" }}>{sessionActive}</span>
                <span className="tsn-kpi-sep">/</span>
                <span style={{ color: "var(--dsw-static-neutral-bluish-400)" }}>{kpi.archived}</span>
              </>
            }
            title={t("dash.kpi.sessionsSub", { total: kpi.sessions, running: kpi.running, active: sessionActive, archived: kpi.archived })}
            meter={
              kpi.sessions > 0 ? (
                <MiniMeter
                  segments={[
                    {
                      ratio: kpi.running / kpi.sessions,
                      color: "var(--dsw-static-green-500)",
                      title: `${t("dash.kpi.lblRunning")} · ${kpi.running}`
                    },
                    {
                      ratio: sessionActive / kpi.sessions,
                      color: "var(--dsw-static-blue-450)",
                      title: `${t("dash.filter.active")} · ${sessionActive}`
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
          {/* 输入/输出合并卡（rework-kpi-charts 2.1，D1）：双值以「/」分隔、百万
              Token 缩写（单位语义由标题「（M）」承载，数值不带后缀）；双值保持
              中性色——计费输入 = 三桶之和，着「未命中输入」红会误读为单桶；
              精确值（formatTokens）收进悬停 tips。 */}
          <KpiCard
            label={t("dash.kpi.inOut")}
            value={
              kpi.hasAnyUsage ? (
                <>
                  <span>{formatMillions(kpi.billedIn)}</span>
                  <span className="tsn-kpi-sep">/</span>
                  <span>{formatMillions(kpi.output)}</span>
                </>
              ) : (
                "—"
              )
            }
            title={t("dash.kpi.inOutSub", { in: formatTokens(kpi.billedIn), out: formatTokens(kpi.output) })}
          />
          <KpiCard
            label={t("dash.kpi.cacheHit")}
            value={kpi.hasAnyUsage && kpi.cacheHit !== null ? `${Math.round(kpi.cacheHit * 10) / 10}%` : "—"}
            meter={
              kpi.hasAnyUsage && kpi.cacheHit !== null ? (
                <MiniMeter segments={[{ ratio: kpi.cacheHit / 100, color: "var(--dsw-static-green-500)" }]} />
              ) : null
            }
          />
          {/* 今日DPS 卡（rework-kpi-charts 2.2/2.3，D2）：位置「缓存命中」后
              「计费 Token」前、regular 尺寸；节拍状态归属独立子组件（tick 只
              重渲染本卡，MUST NOT 落 Dashboard 根组件），页关闭即随组件销毁。
              avgCost/currency 供 tips 的「每月预估消费」估计行（dps×2.592×均价）。 */}
          <TodayDpsCard todayTokens={dpsTodayTokens} armed={aggregateArmed} avgCost={avgCostPerMTok} currency={costCurrency} t={t} />
          <KpiCard
            large
            label={t("dash.kpi.total")}
            value={kpi.hasAnyUsage ? formatTokens(kpi.billedTotal) : "—"}
          />
          {/* 费用卡（用户反馈二轮）：覆盖进度并入标题「费用（覆盖 x/y 会话）」，
              数值行只留金额；口径描述收进悬停 tips。 */}
          <KpiCard
            large
            label={t("dash.kpi.cost", { covered: kpi.cost?.covered ?? 0, count: kpi.cost?.count ?? expanded.length })}
            value={
              kpi.cost && kpi.cost.covered > 0 ? (
                <span className="tsn-money">{formatMoney(kpi.cost.amount, kpi.cost.currency)}</span>
              ) : (
                "—"
              )
            }
            title={t("dash.kpi.costSub", { covered: kpi.cost?.covered ?? 0, count: kpi.cost?.count ?? expanded.length })}
          />
          {/* 均价卡（用户反馈）：副注简略为「仅供参考」，完整口径收进悬停 tips。 */}
          <KpiCard
            label={t("dash.kpi.avgCost")}
            value={
              avgCostPerMTok !== null ? (
                <span className="tsn-money">{formatMoney(avgCostPerMTok, costCurrency)}</span>
              ) : (
                "—"
              )
            }
            sub={t("dash.kpi.avgCostSub")}
            title={t("dash.kpi.avgCostFull")}
          />
        </div>

        <div className="tsn-dash-tabs-row">
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
          {/* 口径脚注收进「?」悬停 tips（Tier 0 / 补充 / Tier 1 / fork 排除 / 自动恢复 / 双口径+颗粒度窗口），
              条件条目缺席时弹层自然少一行，文案语义不变。 */}
          <CaliberHelp
            t={t}
            notes={[
              t("dash.tier0.note"),
              fallbackCount > 0 ? t("dash.tier0.fallback", { count: fallbackCount }) : null,
              t("dash.tier1.note"),
              forkIds.size > 0 ? t("dash.fork.excluded", { count: forkIds.size }) : null,
              /* 余量披露（fix-partial-coverage 3.1）：余量非零时明示「按最近活动并入」，
                 归零后不渲染——与 fork 披露/Tier 0-1 信息条同位同风格。 */
              remainderStats.sessions > 0
                ? t("dash.remainder.note", { count: remainderStats.sessions, tokens: formatTokens(remainderStats.tokens) })
                : null,
              ...repairNoteLines,
              t("dash.time.caliber")
            ]}
          />
        </div>
        {ledgerRuntime.persistError ? <Footnote>{t("dash.ledger.persistError")}</Footnote> : null}
        {/* 账面价披露（ledger-recorded-pricing D2/D3）：旧价目 / 待重算。 */}
        {pricingDisclosure.needsReprice > 0 ? (
          <Footnote>{t("dash.pricing.needsReprice", { count: pricingDisclosure.needsReprice })}</Footnote>
        ) : null}
        {pricingDisclosure.staleTable > 0 ? (
          <Footnote>{t("dash.pricing.staleTable", { count: pricingDisclosure.staleTable })}</Footnote>
        ) : null}
        {/* 固化/逐出披露（fix-ledger-quota-budget D8）：主动收缩的弱化提示，
            与上方「写入失败」提示分列；随下次成功持久化清除。 */}
        {ledgerRuntime.budgetNote ? (
          <Footnote>
            {[
              ledgerRuntime.budgetNote.collapsed > 0
                ? t("dash.ledger.budget.collapsed", { collapsed: ledgerRuntime.budgetNote.collapsed })
                : null,
              ledgerRuntime.budgetNote.evicted > 0
                ? t("dash.ledger.budget.evicted", { count: ledgerRuntime.budgetNote.evicted })
                : null
            ]
              .filter(Boolean)
              .join(" ")}
          </Footnote>
        ) : null}

        {rows.length === 0 ? (
          <div className="tsn-note tsn-empty">{t("dash.empty")}</div>
        ) : tab === "overview" ? (
          <OverviewTab
            t={t}
            trendRows={timeTrendRows}
            trendCostPoints={timeCostPoints}
            costCurrency={costCurrency}
            modelBars={modelBars}
            workspaceBars={workspaceBars}
            kpi={kpi}
            anyCovered={views.anyCovered}
            granularity={timeGranularity}
            onGranularityChange={setTimeGranularity}
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
        ) : tab === "plan" ? (
          <PlanTab t={t} />
        ) : tab === "models" ? (
          <ModelsTab t={t} rows={views.byModel} currency={costCurrency} />
        ) : (
          <PricingTab t={t} ledgerNote={ledgerNote} onLedgerCleared={() => { setLedgerNote(t("dash.ledger.cleared")); notifyLedgerChanged(); }} onNote={setLedgerNote} />
        )}
      </div>
    </div>
  );
}

/* 总览页签：颗粒度切换（日/月/年，原「按时间」页签 seg 控件原样迁移）+
   图表卡网格（消耗趋势 / 模型分布 / 项目占比 / 活跃归档构成 / 费用趋势）。
   颗粒度只改变分桶键与窗口（日=近30天 / 月=近12个自然月 / 年=不限），
   双口径语义与费用逐步计费口径不变。
   目标参考柱（token-stats-plan 消费方，add-monthly-plan D5）：按颗粒度选标尺——
   日颗粒度用每日计划叠「今天」桶、月颗粒度用每月计划叠「本月」月键桶，
   同一目标柱机制（值参与左轴缩放、非实心虚线轮廓）；年颗粒度不设年计划。 */
const TIME_GRANULARITIES = ["day", "month", "year"];

function OverviewTab({ t, trendRows, trendCostPoints, costCurrency, modelBars, workspaceBars, kpi, anyCovered, granularity = "day", onGranularityChange }) {
  /* 双口径标记在颗粒度行上判定（D2）。 */
  const mixedCaliber = trendRows.some((row) => row.source === "recent");
  /* 目标参考柱（token-stats-plan 消费方，add-monthly-plan D5）：计划页签设置的
     每日/每月计划消耗作为对应颗粒度桶的非实心目标参考柱。规则：
     - 日颗粒度：已设每日计划（plan.daily > 0）且趋势行集含「今天」桶；
     - 月颗粒度：已设每月计划（plan.monthly > 0）且趋势行集含「本月」月键桶
       （月键 = timeKeyOf(今日日键, "month")，rows-aggregate 现成导出）；
     - 年颗粒度：不设年计划，天然不渲染；
     - 未设计划（含清除）/键推导失败（null）/对应桶缺席 → 无目标柱
       （「未设置」≠ 0，绝不按 0 画标尺；日/月互不串扰——日档不读月计划、
       月档不读日计划）；
     - 目标键渲染时按当前系统日期即时推导（不持久化「哪一期」），跨零点/跨月
       自动跟随当前期间；
     - 订阅 PLAN_CHANGED_EVENT（usePlanVersion），计划保存/清除即时生效。 */
  const planVersion = usePlanVersion();
  const plan = currentPlan(planVersion);
  const trendTarget = useMemo(() => {
    if (granularity === "day") {
      if (!(plan?.daily > 0)) return null;
      const key = dayKeyOf(Date.now());
      if (key === null || !trendRows.some((row) => row.day === key)) return null;
      return { key, value: plan.daily, legendKey: "dash.chart.dual.target", titleKey: "dash.chart.dual.targetTitle" };
    }
    if (granularity === "month") {
      if (!(plan?.monthly > 0)) return null;
      const todayKey = dayKeyOf(Date.now());
      const key = todayKey === null ? null : timeKeyOf(todayKey, "month");
      if (key === null || !trendRows.some((row) => row.day === key)) return null;
      return { key, value: plan.monthly, legendKey: "dash.chart.dual.targetMonth", titleKey: "dash.chart.dual.targetMonthTitle" };
    }
    return null; /* 年颗粒度：不设年计划 */
  }, [plan, trendRows, granularity]);
  /* 费用点按桶键严格对齐趋势行桶集（双轴合并图的前提）：键不在桶集（按日档
     超窗日键）时直接丢弃——费用线不画「更早」，与原独立费用线同口径。此前把
     超窗日费用合计折入「更早」单点，合计远超逐日值，会把右轴刻度撑爆（逐日
     点全部贴底、右轴数值读起来失真——用户反馈）。month/year 档
     groupCostByGranularity 与趋势行同窗同键，天然对齐不受影响。 */
  const costByKey = useMemo(() => {
    const keys = new Set(trendRows.map((row) => row.day));
    const map = new Map();
    for (const point of trendCostPoints) {
      if (!Number.isFinite(point.cost) || point.cost <= 0) continue;
      if (!keys.has(point.day)) continue;
      map.set(point.day, point.cost);
    }
    return map;
  }, [trendRows, trendCostPoints]);
  /* 桶集外（超窗）费用合计：不入折线，但替代表的「更早」行保留其金额，
     与原金额明细的全量口径衔接。 */
  const olderCost = useMemo(
    () => trendCostPoints.reduce((sum, point) => (Number.isFinite(point.cost) && point.cost > 0 && !costByKey.has(point.day) ? sum + point.cost : sum), 0),
    [trendCostPoints, costByKey]
  );
  /* 表格替代（与原金额明细合并——用户反馈）：每桶一行 = 时间 + 四桶 token + 金额；
     「更早」行金额为超窗费用合计（折线不画该点，表内保留数值）。 */
  const trendAlt = (
    <table className="tsn-table">
      <thead>
        <tr>
          <th>{t("dash.col.activity")}</th>
          {BUCKET_SEGMENTS.map((segment) => (
            <th key={segment.key} className="tsn-num">{segment.label}</th>
          ))}
          <th className="tsn-num">{t("dash.col.cost")}</th>
        </tr>
      </thead>
      <tbody>
        {/* 由近到远排序（用户反馈）：最新桶在最上，「更早」聚合约在最后。 */}
        {[...trendRows].reverse().map((row) => {
          const cost = row.day === "older" ? (olderCost > 0 ? olderCost : null) : (costByKey.get(row.day) ?? null);
          return (
            <tr key={row.day}>
              <td>{row.day === "older" ? t("dash.date.older") : row.day}</td>
              {BUCKET_SEGMENTS.map((segment) => (
                <td key={segment.key} className="tsn-num">{formatTokens(row.buckets[segment.key] ?? 0)}</td>
              ))}
              <td className="tsn-num">
                {cost !== null ? <span className="tsn-money">{formatMoney(cost, costCurrency)}</span> : "—"}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
  return (
    <>
      {/* 双口径/颗粒度窗口脚注已收进页签行「?」按钮的悬停 tips（不再占页面空间）。 */}
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
        {/* 消耗+费用双轴合并卡（用户确认方案）：柱=token（左轴），线=费用（右轴），
            共享 x 桶轴；原独立费用卡整行移除，金额并入表格替代的费用列。
            smallXTick：x 轴日期标缩字号（用户反馈）——整页卡拉伸下日期行不必突出。 */}
        <ChartCard
          title={t(`dash.time.trendTitle.${granularity}`)}
          subtitle={t("dash.chart.trendSub")}
          caliber={mixedCaliber ? t("dash.time.byRecent") : null}
          alt={{ summaryLabel: t("stats.chart.tableAlt"), table: trendAlt }}
        >
          <TrendDualChart
            rows={trendRows}
            costByKey={costByKey}
            currency={costCurrency}
            t={t}
            ariaLabel={t(`dash.time.trendTitle.${granularity}`)}
            target={trendTarget}
            smallXTick
          />
          <DualAxisLegend t={t} target={trendTarget} />
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

/* 按工作区页签：项目归组表（token 列附比例色条；表头点击排序 + 列宽拖拽持久化，与按会话表同交互）。 */
const WORKSPACE_SORT_DIR = {
  workspace: "asc",
  sessions: "desc",
  running: "desc",
  total: "desc",
  hit: "desc",
  cost: "desc"
};

function sortValueOfWorkspace(row, key) {
  switch (key) {
    case "workspace":
      return row.name ?? null;
    case "sessions":
      return row.sessions;
    case "running":
      return row.running;
    case "hit":
      return row.cacheHit;
    case "cost":
      return row.cost;
    case "total":
      return row.total;
    default:
      return row.buckets?.[key] ?? 0; /* 四桶：BUCKET_SEGMENTS 的 segment.key */
  }
}

function WorkspacesTab({ t, rows }) {
  const [sort, setSort] = useState({ key: "total", dir: "desc" });
  const colctl = useColumnWidths("dash-workspaces");

  const visible = useMemo(() => {
    const factor = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = sortValueOfWorkspace(a, sort.key);
      const vb = sortValueOfWorkspace(b, sort.key);
      const aNull = va === null || va === void 0;
      const bNull = vb === null || vb === void 0;
      if (aNull || bNull) return aNull && bNull ? 0 : aNull ? 1 : -1;
      if (typeof va === "string" || typeof vb === "string") return factor * String(va).localeCompare(String(vb), "zh");
      return factor * (va - vb);
    });
  }, [rows, sort]);

  const toggleSort = (key) => {
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: WORKSPACE_SORT_DIR[key] ?? "desc" }
    );
  };

  const gripOf = (key) => <ColResizer {...colctl.gripProps(key)} title={t("dash.colgrip.hint")} />;

  /* token 色条列内占比基准（与按会话表同语义）。 */
  const bucketMax = useMemo(() => {
    const maxes = {};
    for (const segment of BUCKET_SEGMENTS) {
      maxes[segment.key] = rows.reduce((max, row) => Math.max(max, row.buckets?.[segment.key] ?? 0), 0);
    }
    return maxes;
  }, [rows]);
  const totalMax = useMemo(() => rows.reduce((max, row) => Math.max(max, row.total ?? 0), 0), [rows]);
  return (
    <div className="tsn-table-wrap tsn-table-scroll">
      <table className="tsn-table" style={colctl.tableStyle}>
        <thead>
          <tr>
            <SortHeader label={t("dash.col.workspace")} sortKey="workspace" sort={sort} onSort={toggleSort} dataCol="workspace" style={colctl.styleOf("workspace")} grip={gripOf("workspace")} />
            <SortHeader className="tsn-num" label={t("dash.col.sessions")} sortKey="sessions" sort={sort} onSort={toggleSort} dataCol="sessions" style={colctl.styleOf("sessions")} grip={gripOf("sessions")} />
            <SortHeader className="tsn-num" label={t("dash.col.running")} sortKey="running" sort={sort} onSort={toggleSort} dataCol="running" style={colctl.styleOf("running")} grip={gripOf("running")} />
            {BUCKET_SEGMENTS.map((segment) => (
              <SortHeader key={segment.key} className="tsn-num" label={segment.label} sortKey={segment.key} sort={sort} onSort={toggleSort} dataCol={segment.key} style={colctl.styleOf(segment.key)} grip={gripOf(segment.key)} />
            ))}
            <SortHeader className="tsn-num" label={t("dash.col.total")} sortKey="total" sort={sort} onSort={toggleSort} dataCol="total" style={colctl.styleOf("total")} grip={gripOf("total")} />
            <SortHeader className="tsn-num" label={t("dash.col.hit")} sortKey="hit" sort={sort} onSort={toggleSort} dataCol="hit" style={colctl.styleOf("hit")} grip={gripOf("hit")} />
            <SortHeader className="tsn-num" label={t("stats.col.cost")} sortKey="cost" sort={sort} onSort={toggleSort} dataCol="cost" style={colctl.styleOf("cost")} grip={gripOf("cost")} />
          </tr>
        </thead>
        <tbody>
          {visible.map((row) => (
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
              <td className="tsn-num" title={row.cost !== null ? void 0 : t("dash.cost.hover")}>
                {row.cost !== null ? (
                  <>
                    <span className="tsn-money">{formatMoney(row.cost, row.currency)}</span>
                    {row.costUnpriced > 0 ? (
                      <span className="tsn-muted"> · {t("dash.ws.unpriced", { count: row.costUnpriced })}</span>
                    ) : null}
                  </>
                ) : (
                  <span className="tsn-muted">—</span>
                )}
              </td>
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
  const [reprice, setReprice] = useState({});
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
        [id]: {
          busy: false,
          message: isHistoryUnavailableError(error)
            ? t("dash.deep.unavailable")
            : t("dash.deep.failed", { message: String(error?.message ?? error) })
        }
      }));
    }
  };

  /* 单会话重算（ledger-recorded-pricing D5）：重导出账面价并增量回写。 */
  const runReprice = (id) => {
    setReprice((prev) => ({ ...prev, [id]: { busy: true } }));
    try {
      const result = repriceLedgerSession(
        typeof localStorage === "undefined" ? null : localStorage,
        ledgerData(),
        id,
        loadPriceTable(typeof localStorage === "undefined" ? null : localStorage),
        ledgerSizeCache,
        priceCache
      );
      const message = result.ok
        ? t("dash.pricing.repriceSession.done")
        : result.reason === "empty"
          ? t("dash.pricing.repriceSession.empty")
          : t("dash.pricing.repriceSession.failed");
      setReprice((prev) => ({ ...prev, [id]: { busy: false, message } }));
      if (result.ok) notifyLedgerChanged();
    } catch {
      setReprice((prev) => ({ ...prev, [id]: { busy: false, message: t("dash.pricing.repriceSession.failed") } }));
    }
  };

  /* 一键重建：逐会话深度补全（预算放宽到 50 页），已完整覆盖的会话自动跳过；
     运行中会话（含正大量派生子会话的会话家庭）不重建——移动靶不拍，其今日/近期
     消耗已由实时沉淀维护，历史全量待转 idle 后由下一轮自然补齐
     （fix-deep-completion-host-pressure D1/D2/D7）。 */
  const runRebuildAll = async () => {
    if (rebuildRunningRef.current) {
      rebuildCancelRef.current = true;
      return;
    }
    /* 组装预筛（D1 第一道）：先按既有覆盖判据取「本应重建」的候选，再按运行态
       规则剔除——被剔除者计入 skippedRunning。计数口径（D7）：仅「按覆盖判据本
       应重建、因运行态排除」者；本就无需重建（已完整覆盖）的运行中会话不计入，
       避免数字夸大。 */
    const targets = [];
    const skippedRunningIds = new Set(); /* 组装预筛 ∪ 发起前复核，按会话去重 */
    for (const row of visible) {
      const session = ledgerData().sessions[row.id];
      let needed;
      if (!session || (session.entries.length === 0 && session.buckets.length === 0)) {
        needed = true;
      } else {
        const coverage = session.coverage ?? {};
        /* 已完整覆盖（深补走完且未截断）的跳过；部分覆盖/未覆盖的重建 */
        needed = !(coverage.deepTruncated === false && coverage.windowFull === true);
      }
      if (!needed) continue;
      if (isRunningExcludedSession(row.id)) {
        skippedRunningIds.add(row.id);
        continue;
      }
      targets.push(row);
    }
    if (targets.length === 0) {
      setRebuild({
        running: false,
        done: 0,
        total: 0,
        partial: 0,
        failed: 0,
        note:
          skippedRunningIds.size > 0
            ? t("dash.ledger.rebuild.skippedRunning", { n: skippedRunningIds.size })
            : t("dash.ledger.rebuild.none")
      });
      return;
    }
    rebuildRunningRef.current = true;
    rebuildCancelRef.current = false;
    const rebuildErrors = []; /* 首次诊断透出（dsh-012-compat）：前 3 个去重错误随完成提示展示 */
    let done = 0;
    let partial = 0;
    let failed = 0;
    let total = targets.length; /* 发起前复核剔除的目标动态出列，进度/分批按出列后的 total（不变量：total − done = 队列中未访问条目数） */
    const doneNote = () =>
      t("dash.ledger.rebuild.done", { done, partial, failed }) +
      (skippedRunningIds.size > 0 ? " · " + t("dash.ledger.rebuild.skippedRunning", { n: skippedRunningIds.size }) : "") +
      (rebuildErrors.length > 0 ? " · " + rebuildErrors.join(" / ") : "");
    setRebuild({ running: true, done: 0, total, partial: 0, failed: 0, note: null });
    for (const row of targets) {
      if (rebuildCancelRef.current) break;
      /* 分批限流（fix-ledger-storm）：清空后的全量重建会逐会话拉取完整宿主历史
         （每会话至多 50 页 × 200 条完整事件，风暴会话 22 万事件级），一次拉完
         曾把宿主进程（dsh web）堆打进 4GB OOM。单批至多 REBUILD_BATCH_SESSIONS
         个会话，批间由覆盖判据自然续跑（已完成的下轮自动跳过），批内逐会话让出
         事件循环给宿主喘息。发起前被跳过的会话不占分批预算（done 不动）。 */
      if (done >= REBUILD_BATCH_SESSIONS) {
        rebuildRunningRef.current = false;
        rebuildCancelRef.current = false;
        setRebuild({
          running: false,
          done,
          total,
          partial,
          failed,
          note: t("dash.ledger.rebuild.batchPaused", { done, total })
        });
        notifyLedgerChanged();
        return;
      }
      /* 发起前 JIT 复核（D1 第二道）：组装与发起之间可能相隔数十分钟（一批 40
         会话），目标可能在期间开始运行——竞态窗口恰是风暴成形的最危险窗口。
         转运行中的会话发起前跳过、不发起任何针对它的 page 请求、并入
         skippedRunning（Set 按会话去重，与组装预筛合并计数）。 */
      if (isRunningExcludedSession(row.id)) {
        if (!skippedRunningIds.has(row.id)) {
          skippedRunningIds.add(row.id);
          total -= 1;
        }
        setRebuild({ running: done < total, done, total, partial, failed, note: done >= total ? doneNote() : null });
        continue;
      }
      try {
        const result = await ledgerDeepComplete(row.id, () => {}, { maxPages: 50 });
        if (result?.truncated === true) partial += 1;
      } catch (error) {
        failed += 1; /* 单会话失败不影响其余（fail-soft） */
        const message = String(error?.message ?? error);
        if (rebuildErrors.length < 3 && !rebuildErrors.includes(message)) rebuildErrors.push(message);
      }
      done += 1;
      const cancelled = rebuildCancelRef.current;
      setRebuild({
        running: !cancelled && done < total,
        done,
        total,
        partial,
        failed,
        note: cancelled ? t("dash.ledger.rebuild.stopped", { done, total }) : done >= total ? doneNote() : null
      });
      /* 批内限速：逐会话让出事件循环，压低宿主连续供史的压力峰值。 */
      await new Promise((resolve) => setTimeout(resolve, REBUILD_PACE_MS));
    }
    rebuildRunningRef.current = false;
    rebuildCancelRef.current = false;
    /* 重建落定：立即派发（用户可见变更，D3；并取消挂起的合并派发）。 */
    notifyLedgerChanged();
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
                      {row.isSub ? (
                        row.isFork ? (
                          <StatBadge kind="fork">{t("dash.badge.fork")}</StatBadge>
                        ) : (
                          <StatBadge kind="subagent">{t("dash.badge.subagent")}</StatBadge>
                        )
                      ) : null}
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
                        <>
                          <span className="tsn-money">{formatMoney(row.cost, row.currency)}</span>
                          {row.unmatched.length > 0 ? (
                            <span className="tsn-muted">
                              {" "}
                              {t("stats.noprice")}
                              {` (${row.unmatched.join(", ")})`}
                            </span>
                          ) : null}
                        </>
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
                          repriceState={reprice[row.id]}
                          onDeep={() => runDeep(row.id)}
                          onReprice={() => runReprice(row.id)}
                          onClear={() => {
                            clearSessionLedger(ledgerData(), row.id, priceCache);
                            ledgerSizeCache.delete(row.id); /* 尺寸缓存同步失效（R3 卫生同款） */
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
            onClick={() => {
              setMenu(null);
              runReprice(menu.id);
            }}
          >
            {t("dash.pricing.repriceSession")}
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

/** 行内展开：账本覆盖状态 + 深度补全 + 逐步条目 + 单会话清除 + 单会话重算。 */
function SessionLedgerDetail({ t, row, deepState, onDeep, onClear, onReprice, repriceState }) {
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
        <button type="button" className="tsn-btn tsn-btn-small" disabled={repriceState?.busy === true} onClick={onReprice}>
          {t("dash.pricing.repriceSession")}
        </button>
        {repriceState?.message ? <span className="tsn-note">{repriceState.message}</span> : null}
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

/* 按模型页签：账本聚合 + 「未分类」行（token 列附比例色条）。 */
/* 按模型页签排序：表头点击排序（默认按总量降序，与既有排序一致）；nullish 恒排末尾。 */
const MODEL_SORT_DIR = {
  model: "asc",
  total: "desc",
  cost: "desc",
  avg: "desc"
};

function sortValueOfModel(row, key) {
  switch (key) {
    case "model":
      return row.model || null; /* 空模型名（未知模型）与未分类 null 一致排末尾 */
    case "total":
      return row.total;
    case "cost":
      return row.cost;
    case "avg":
      return row.avgCost;
    default:
      return row.buckets?.[key] ?? 0; /* 四桶：BUCKET_SEGMENTS 的 segment.key */
  }
}

function ModelsTab({ t, rows, currency }) {
  const [sort, setSort] = useState({ key: "total", dir: "desc" });
  const colctl = useColumnWidths("dash-models");

  const visible = useMemo(() => {
    const factor = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = sortValueOfModel(a, sort.key);
      const vb = sortValueOfModel(b, sort.key);
      const aNull = va === null || va === void 0;
      const bNull = vb === null || vb === void 0;
      if (aNull || bNull) return aNull && bNull ? 0 : aNull ? 1 : -1;
      if (typeof va === "string" || typeof vb === "string") return factor * String(va).localeCompare(String(vb), "zh");
      return factor * (va - vb);
    });
  }, [rows, sort]);

  const toggleSort = (key) => {
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: MODEL_SORT_DIR[key] ?? "desc" }
    );
  };

  const gripOf = (key) => <ColResizer {...colctl.gripProps(key)} title={t("dash.colgrip.hint")} />;

  /* token 色条列内占比基准（与按会话/工作区表同语义）。 */
  const bucketMax = useMemo(() => {
    const maxes = {};
    for (const segment of BUCKET_SEGMENTS) {
      maxes[segment.key] = rows.reduce((max, row) => Math.max(max, row.buckets?.[segment.key] ?? 0), 0);
    }
    return maxes;
  }, [rows]);
  const totalMax = useMemo(() => rows.reduce((max, row) => Math.max(max, row.total ?? 0), 0), [rows]);
  /* 百万 token 成本均值由数据层提供（byModel 行的 avgCost 字段，已定价费用 ÷ token 总量 × 10⁶）。 */
  return (
    <>
      <Footnote>{t("dash.models.caliber")}</Footnote>
      <div className="tsn-table-wrap tsn-table-scroll">
        <table className="tsn-table" style={colctl.tableStyle}>
          <thead>
            <tr>
              <SortHeader label={t("stats.col.model")} sortKey="model" sort={sort} onSort={toggleSort} dataCol="model" style={colctl.styleOf("model")} grip={gripOf("model")} />
              {BUCKET_SEGMENTS.map((segment) => (
                <SortHeader key={segment.key} className="tsn-num" label={segment.label} sortKey={segment.key} sort={sort} onSort={toggleSort} dataCol={segment.key} style={colctl.styleOf(segment.key)} grip={gripOf(segment.key)} />
              ))}
              <SortHeader className="tsn-num" label={t("dash.col.total")} sortKey="total" sort={sort} onSort={toggleSort} dataCol="total" style={colctl.styleOf("total")} grip={gripOf("total")} />
              <SortHeader className="tsn-num" label={t("stats.col.cost")} sortKey="cost" sort={sort} onSort={toggleSort} dataCol="cost" style={colctl.styleOf("cost")} grip={gripOf("cost")} />
              <SortHeader className="tsn-num" label={t("dash.col.avgCost")} sortKey="avg" sort={sort} onSort={toggleSort} dataCol="avg" style={colctl.styleOf("avg")} grip={gripOf("avg")} />
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const avg = row.avgCost ?? null;
              return (
                <tr key={row.model ?? "__unclassified__"}>
                  <td className="tsn-title-cell">{row.model === null ? t("dash.model.unclassified") : row.model === "" ? t("dash.model.unknown") : row.model}</td>
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
                  <td className="tsn-num" title={row.cost !== null && row.cost !== void 0 ? void 0 : t("dash.cost.hover")}>
                    {row.cost !== null && row.cost !== void 0 ? (
                      <span className="tsn-money">{formatMoney(row.cost, row.currency ?? currency)}</span>
                    ) : (
                      <span className="tsn-muted">—</span>
                    )}
                  </td>
                  <td className="tsn-num" title={avg !== null ? void 0 : t("dash.cost.hover")}>
                    {avg !== null ? (
                      <span className="tsn-money">{formatMoney(avg, row.currency ?? currency)}</span>
                    ) : (
                      <span className="tsn-muted">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="tsn-hbars">
        <HBars items={rows.map((row) => ({ label: row.model === null || row.model === "" ? t("dash.model.unclassified") : row.model, value: row.total }))} />
      </div>
    </>
  );
}

/* 计划页签（merge-time-tab-add-plan D5 + add-monthly-plan D7）：每日 / 每月计划消耗
   Token 总量——两组完全镜像的数字输入 +「保存」+「清除」（独立草稿、独立校验提示、
   独立动作按钮，互不串扰）。设置与持久化语义归 token-stats-plan 能力（页签入口与
   位置由 token-stats-overview 承接，镜像「价格表页签」先例）；「未设置」为一等状态
   （区别于 0）；空输入 + 保存按非法拒绝，「清除」是恢复字段级未设置的唯一动作；
   保存走补丁（仅传所涉字段，不抹另一字段）、清除走字段级 clearPlanStore；保存/清除
   成功广播 PLAN_CHANGED_EVENT（price-store 同款分工：store 纯函数 + 调用方广播）。 */
function PlanTab({ t }) {
  const planVersion = usePlanVersion();
  const plan = currentPlan(planVersion);
  /* 独立草稿与独立提示（每日/每月各一套；null = 输入框跟随当前计划值）。 */
  const [draftDaily, setDraftDaily] = useState(null);
  const [draftMonthly, setDraftMonthly] = useState(null);
  const [noteDaily, setNoteDaily] = useState(null); /* { kind: "ok" | "error", text } | null */
  const [noteMonthly, setNoteMonthly] = useState(null);
  const storage = typeof localStorage === "undefined" ? null : localStorage;
  /* 逐字段可空取值：plan 为 null 或字段为 null（未设置）时输入框清空显示占位。 */
  const dailyValue = draftDaily ?? (plan?.daily != null ? String(plan.daily) : "");
  const monthlyValue = draftMonthly ?? (plan?.monthly != null ? String(plan.monthly) : "");

  const save = (field) => {
    const isDaily = field === "daily";
    const setNote = isDaily ? setNoteDaily : setNoteMonthly;
    const text = (isDaily ? dailyValue : monthlyValue).trim();
    const parsed = Number(text);
    if (text === "" || !Number.isFinite(parsed) || parsed <= 0) {
      setNote({ kind: "error", text: t(isDaily ? "dash.plan.invalid" : "dash.plan.invalidMonthly") });
      return;
    }
    /* 补丁保存：仅传所涉字段，另一字段由 store 保证不互抹。 */
    if (!savePlanStore(storage, { [field]: parsed })) {
      setNote({ kind: "error", text: t("dash.plan.saveFailed") });
      return;
    }
    if (isDaily) setDraftDaily(null);
    else setDraftMonthly(null); /* 输入框回到已保存值 */
    setNote({ kind: "ok", text: t("dash.plan.saved") });
    window.dispatchEvent(new CustomEvent(PLAN_CHANGED_EVENT));
  };

  const clear = (field) => {
    const setNote = field === "daily" ? setNoteDaily : setNoteMonthly;
    if (!clearPlanStore(storage, field)) { /* 字段级清除（失败如实提示，不虚报成功） */
      setNote({ kind: "error", text: t("dash.plan.clearFailed") });
      return;
    }
    if (field === "daily") setDraftDaily(null);
    else setDraftMonthly(null);
    setNote({ kind: "ok", text: t("dash.plan.cleared") });
    window.dispatchEvent(new CustomEvent(PLAN_CHANGED_EVENT));
  };

  return (
    <Card title={t("dash.plan.title")} subtitle={t("dash.plan.hint")}>
      <div className="tsn-field">
        <label htmlFor="tsn-plan-daily">{t("dash.plan.label")}</label>
        <div className="tsn-plan-row">
          <input
            id="tsn-plan-daily"
            className="tsn-input"
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
            value={dailyValue}
            placeholder={t("dash.plan.unset")}
            onChange={(event) => {
              setDraftDaily(event.target.value);
              setNoteDaily(null);
            }}
          />
          <button type="button" className="tsn-btn tsn-btn-small" onClick={() => save("daily")}>
            {t("dash.plan.save")}
          </button>
          <button type="button" className="tsn-btn tsn-btn-small" onClick={() => clear("daily")}>
            {t("dash.plan.clear")}
          </button>
        </div>
        {noteDaily ? (
          <div className={noteDaily.kind === "error" ? "tsn-note tsn-error" : "tsn-note"}>{noteDaily.text}</div>
        ) : null}
      </div>
      <div className="tsn-field">
        <label htmlFor="tsn-plan-monthly">{t("dash.plan.labelMonthly")}</label>
        <div className="tsn-plan-row">
          <input
            id="tsn-plan-monthly"
            className="tsn-input"
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
            value={monthlyValue}
            placeholder={t("dash.plan.unset")}
            onChange={(event) => {
              setDraftMonthly(event.target.value);
              setNoteMonthly(null);
            }}
          />
          <button type="button" className="tsn-btn tsn-btn-small" onClick={() => save("monthly")}>
            {t("dash.plan.save")}
          </button>
          <button type="button" className="tsn-btn tsn-btn-small" onClick={() => clear("monthly")}>
            {t("dash.plan.clear")}
          </button>
        </div>
        {noteMonthly ? (
          <div className={noteMonthly.kind === "error" ? "tsn-note tsn-error" : "tsn-note"}>{noteMonthly.text}</div>
        ) : null}
      </div>
      {/* 当前值注记：双行展示，每日/每月各含「未设置」形态（逐字段可空取值）。 */}
      <div className="tsn-note">
        <div>{plan?.daily != null ? t("dash.plan.current", { value: formatTokens(plan.daily) }) : t("dash.plan.unsetDaily")}</div>
        <div>{plan?.monthly != null ? t("dash.plan.currentMonthly", { value: formatTokens(plan.monthly) }) : t("dash.plan.unsetMonthly")}</div>
      </div>
    </Card>
  );
}

/* 价格表页签（归宿 A）：维护入口 + 账本管理（备份 / 恢复）+ 账面价重算入口。 */
function PricingTab({ t, onLedgerCleared, ledgerNote, onNote }) {
  const ledger = ledgerData();
  const sessionCount = Object.keys(ledger.sessions).length;
  const fileInputRef = useRef(null);
  const [reprice, setReprice] = useState({ running: false, done: 0, total: 0, failed: 0, note: null, rejected: false });
  const repriceCancelRef = useRef(false);

  /* 一键重算全账本（ledger-recorded-pricing D4）：预算预检 → 逐会话即算即写、可中途停止。 */
  const runRepriceAll = async () => {
    if (repriceCancelRef.current) {
      repriceCancelRef.current = false;
      setReprice((prev) => ({ ...prev, running: false }));
      return;
    }
    const storage = typeof localStorage === "undefined" ? null : localStorage;
    const table = loadPriceTable(storage);
    const precheck = repriceLedgerBudgetCheck(ledgerData(), ledgerSizeCache);
    if (!precheck.ok) {
      setReprice({ running: false, done: 0, total: 0, failed: 0, note: t("dash.pricing.repriceRejected"), rejected: true });
      return;
    }
    const ledgerNow = ledgerData();
    const sids = Object.keys(ledgerNow.sessions).filter((sid) => {
      const session = ledgerNow.sessions[sid];
      return session && (session.entries.length > 0 || session.buckets.length > 0);
    });
    if (sids.length === 0) {
      /* 空账本（清除后/首次使用）→ 指引恢复 token 事实：重建（宿主历史为事实源）
         或导入备份。重算只从账本 token 事实重导出价格（D8 分工），不替代重建。 */
      const emptyLedgerCase = Object.keys(ledgerNow.sessions).length === 0;
      setReprice({
        running: false,
        done: 0,
        total: 0,
        failed: 0,
        rejected: false,
        note: t(emptyLedgerCase ? "dash.pricing.repriceAll.emptyLedger" : "dash.pricing.repriceAll.none")
      });
      return;
    }
    repriceCancelRef.current = true;
    setReprice({ running: true, done: 0, total: sids.length, failed: 0, note: null, rejected: false });
    let done = 0;
    let failed = 0;
    for (const sid of sids) {
      if (!repriceCancelRef.current) break; /* 中途停止 */
      const result = repriceLedgerSession(storage, ledgerData(), sid, table, ledgerSizeCache, priceCache);
      if (!result.ok) failed += 1;
      done += 1;
      const cancelled = !repriceCancelRef.current;
      setReprice({
        running: !cancelled && done < sids.length,
        done,
        total: sids.length,
        failed,
        rejected: false,
        note: cancelled
          ? t("dash.pricing.repriceAll.stopped", { done, total: sids.length })
          : done >= sids.length
            ? t("dash.pricing.repriceAll.done", { count: done, failed })
            : null
      });
      /* 串行限速：让出事件循环，避免长账本阻塞 UI；价格缓存失效交由 reprice 自身写回后重载。 */
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    repriceCancelRef.current = false;
    notifyLedgerChanged(); /* 重算落定：立即派发（费用口径切换为用户可见变更） */
  };

  return (
    <>
      <Card title={t("settings.title")}>
        <PriceSettingsRow t={t} />
        <div className="tsn-note">{t("dash.pricing.saveNote")}</div>
      </Card>
      <Card title={t("dash.pricing.repriceAll")} subtitle={t("dash.pricing.repriceAllHint")}>
        <div className="tsn-row-actions">
          <button
            type="button"
            className="tsn-btn tsn-btn-small"
            onClick={runRepriceAll}
            title={t("dash.pricing.repriceAllHint")}
          >
            {reprice.running ? t("dash.pricing.repriceAll.stop") : t("dash.pricing.repriceAll")}
          </button>
          {reprice.running ? (
            <span className="tsn-note">
              {t("dash.pricing.repriceAll.running", { done: reprice.done, total: reprice.total, failed: reprice.failed })}
            </span>
          ) : null}
          {!reprice.running && reprice.note ? <span className="tsn-note">{reprice.note}</span> : null}
        </div>
      </Card>
      <Card title={t("dash.ledger.manage")} subtitle={t("dash.ledger.manageNote", { key: LEDGER_INDEX_KEY_V2 })}>
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
              clearAllLedger(ledgerData(), priceCache);
              ledgerSizeCache.clear(); /* 尺寸缓存整体失效（R3 卫生同款） */
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
      <td colSpan={10}>
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
 * 标准槽 props：sessionId、useSession（会话生命周期快照：hasMore/loadingOlder）、
 * useChat（chat 视图快照：legacy.nodes/locations）、useTrajectory（轨迹快照，
 * requests join）、useProjection（宿主投影）、t（文案）；
 * 条目 inject 提供 loadOlder（经 ctx.get("sessions") 的 SessionFace 调用）。
 * 该页签的折叠结果同时幂等沉淀入本地账本（Tier 1 喂食来源 A，窗口口径）。
 */
const TokenStatsView = function TokenStatsView({ sessionId, useSession, useChat, useTrajectory, useProjection, t, loadOlder }) {
  const nodes = useChat((s) => s.legacy.nodes);
  const locations = useChat((s) => s.locations);
  const hasMore = useSession((s) => s.hasMore);
  const loadingOlder = useSession((s) => s.loadingOlder);
  /* 轨迹视图快照：requests[] 按 (turn, step) 携带 provenance/requestConfig
     （message.source 在 legacy 节点上被省略，模型信息从这里 join 补全）。 */
  const inspection = useTrajectory((s) => s);
  const sessionUsage = useProjection("tokenUsage");
  const sessionStats = useProjection("sessionStats");
  const contextPressure = useProjection("contextPressure");
  const contextBreakdown = useProjection("contextBreakdown");

  const priceVersion = usePriceVersion();
  const table = currentPriceTable(priceVersion);
  const [expandedTurn, setExpandedTurn] = useState(null);
  const sentinelRef = useRef(null);

  /* 共享折叠产物（D1/R1，tasks 2.3）：与轮尾 chip 共享同一次 fold+join（窗口
     身份 + 内容签名缓存）；rows 引用在缓存命中时保持稳定（下游 memo 连带命中）。 */
  const artifact = useMemo(() => foldTurnsShared(nodes), [nodes]);
  const joinedArtifact = useMemo(() => joinRequestInsightsShared(artifact, inspection?.requests), [artifact, inspection]);
  const rows = joinedArtifact.rows;
  const pricedRows = useMemo(() => priceTurnRows(rows, table), [rows, table]);
  /* 每轮费用映射（rework-kpi-charts 4.2，D4）：turn → cost（仅已定价且 >0 的轮，
     与布局费用路径「零/缺席不画点」语义一致）；未定价轮缺键 → 费用线断开。 */
  const turnCostByKey = useMemo(() => {
    const map = new Map();
    for (const row of pricedRows) {
      if (row.cost !== null && Number.isFinite(row.cost) && row.cost > 0) map.set(row.turn, row.cost);
    }
    return map;
  }, [pricedRows]);
  /* 累计费用映射（rework-kpi-charts 4.5，D5）：按 pricedRows 原始轮序（非
     sortedRows）累加已定价轮 → Map(turn → acc)。未定价轮不计入亦不清零
     （该轮查表不中 → 显示「—」）；排序无关性由构造保证——明细表单元格按
     row.turn 查表取值，值随行走，MUST NOT 随排序重算。 */
  const cumulativeByTurn = useMemo(() => {
    const map = new Map();
    let acc = 0;
    for (const row of pricedRows) {
      if (row.cost === null) continue;
      acc += row.cost;
      map.set(row.turn, acc);
    }
    return map;
  }, [pricedRows]);

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
            {/* 每轮消耗与花费双轴卡（rework-kpi-charts 4.2，D4）：与总览双轴卡同款
                （共享 TrendDualChart / DualAxisLegend、基线零刻度省略继承）。柱 =
                全部窗口行（未定价轮也有 token），线 = turn→cost（未定价轮缺键 →
                折线断开）；柱点击跳轮保留；sparseX 稀疏 x 标签（数十轮不挤爆）。
                表格替代：既有「轮# × 四桶」表附「费用」列（cost !== null → 金额，
                否则「—」）。 */}
            <section className="tsn-card tsn-span2">
              <div className="tsn-card-title">{t("stats.chart.dualTitle")}</div>
              <TrendDualChart
                rows={rows}
                costByKey={turnCostByKey}
                currency={costCurrency}
                t={t}
                ariaLabel={t("stats.chart.dualTitle")}
                onBarClick={jumpToTurn}
                xLabelOf={(turn) => `#${turn}`}
                sparseX
              />
              <DualAxisLegend t={t} tokensLabel={t("stats.chart.dual.tokens")} costLabel={t("stats.chart.dual.cost")} />
              <details className="tsn-alt">
                <summary>{t("stats.chart.tableAlt")}</summary>
                <table className="tsn-table">
                  <thead>
                    <tr>
                      <th>{t("stats.col.turn")}</th>
                      {BUCKET_SEGMENTS.map((segment) => (
                        <th key={segment.key}>{segment.label}</th>
                      ))}
                      <th className="tsn-num">{t("stats.col.cost")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pricedRows.map((row) => (
                      <tr key={row.turn}>
                        <td>#{row.turn}</td>
                        {BUCKET_SEGMENTS.map((segment) => (
                          <td key={segment.key}>{formatTokens(row.usage[segment.key] ?? 0)}</td>
                        ))}
                        <td className="tsn-num">
                          {row.cost !== null ? (
                            <span className="tsn-money">{formatMoney(row.cost, row.currency ?? costCurrency)}</span>
                          ) : (
                            "—"
                          )}
                        </td>
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
            {/* 累计费用卡（rework-kpi-charts 4.4，D5）：保留累计折线、面积、末点
                标注与未定价提示，去掉内嵌折叠表格——其表格替代由紧邻明细表的
                「累计费用」列承载（数据等价，「每个图表 MUST 配表格替代」共享
                规则的显式例外落点，已写入 token-stats-tab delta）。 */}
            <section className="tsn-card">
              <div className="tsn-card-title">{t("stats.chart.costTitle")}</div>
              <CostLineChart rows={pricedRows} currency={costCurrency} t={t} />
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
                {/* 累计费用列（rework-kpi-charts 4.5，D5）：纯轮序派生列，不参与表头
                    排序（普通 th，按它排序 ≈ 按轮排序无信息量；展开箭头列先例）；
                    会话明细表无列宽持久化机制，新列随表格自然布局。 */}
                <th className="tsn-num">{t("stats.col.cumulative")}</th>
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
                          <>
                            <span className="tsn-money">{formatMoney(row.cost, row.currency ?? costCurrency)}</span>
                            {row.unmatched.length > 0 ? (
                              <span className="tsn-muted"> · {t("stats.noprice")} ({row.unmatched.join(", ")})</span>
                            ) : null}
                          </>
                        )}
                      </td>
                      {/* 累计费用（4.5）：按 row.turn 查轮序累计表——排序仅改变行
                          顺序，值随行走；未定价轮不计入亦不清零，显示「—」。 */}
                      <td className="tsn-num">
                        {row.cost === null ? (
                          "—"
                        ) : (
                          <span className="tsn-money">{formatMoney(cumulativeByTurn.get(row.turn) ?? 0, costCurrency)}</span>
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
        (multipliers.length > 0 ? ` · ${multipliers.join(" / ")}` : "") +
        /* 步级语义：部分步未定价时，金额为已定价部分，原因如实披露 */
        (priced.unmatched.length > 0 ? ` · ${t("stats.noprice")} (${priced.unmatched.join(", ")})` : "")
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
 * 槽 owner：{ messageId }（轮尾收束消息的稳定 id）+ 标准 props（useChat/
 * useTrajectory…：0.1.2-rc.1 起窗口节点与轮计时迁入 chat 视图快照）。
 * 渲染在官方功能行内部：复制 → [反馈按钮(order 10)] → [本 chip(order 20)] → 分支 →
 * timeEnd（时钟·耗时·首字·速度）。list 槽全部条目并存渲染，不经 chain 选举，
 * 与 turnTail 上的「产出文件」条目互不抢占。
 * 常态显示三段：耗时（轮起点→终点，turnTimings，与官方 runMs 同源）·
 * ≈费用 · token 总量（↑计费输入 ↓输出）；完整计价依据（模型、四桶、命中档/
 * 折扣）在悬停 title。该轮无 usage 报告（中断/失败/纯命令轮）→ 不渲染。
 */
const AssistantActionsTokenChip = function AssistantActionsTokenChip({ sessionId, messageId, useChat, useTrajectory, t }) {
  const nodes = useChat((s) => s.legacy.nodes);
  const turnTimings = useChat((s) => s.legacy.turnTimings);
  const inspection = useTrajectory((s) => s);
  const priceVersion = usePriceVersion();
  /* 共享折叠产物（D1/R1，tasks 2.3）：全部 chip 与统计页签共享同一次 fold+join
     （窗口身份 + 内容签名缓存），单次会话快照更新至多折叠一次全窗口。 */
  const artifact = useMemo(() => foldTurnsShared(nodes), [nodes]);
  const joined = useMemo(() => joinRequestInsightsShared(artifact, inspection?.requests), [artifact, inspection]);
  /* 轮定位走产物内置 O(1) 索引：messageId→turn 取代逐 chip 对全窗口节点的线性反查、
     turn→row 取代对折叠结果数组的 find——消除剩余 O(C×N) 扫描（R1）。 */
  const turnNo = joined.turnByMessageId.get(messageId) ?? null;
  const row = turnNo === null ? null : joined.rowByTurn.get(turnNo) ?? null;
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

  /* 模型目录（对齐 DSH 配置的模型清单）：remote.session.modelCatalog 全局 RPC
     （0.1.2-rc.1：无参数、不区分会话；子会话可用性由本地 currentAddress/
     subagentAddress 判定先行拦截——原会话级 sessions.models RPC 已移除）。
     失败静默降级手动输入。 */
  useEffect(() => {
    if (!open || !currentId || addressedSubagent || !pluginCtx) {
      setCatalog(null);
      return;
    }
    let alive = true;
    try {
      pluginCtx
        .get("remote")
        ?.session?.modelCatalog?.()
        .then((remote) => {
          if (alive) setCatalog(remote?.ok ? remote.value : null);
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

  /* 3.4 实时预览：打开时对当前会话的事件窗口离线折叠一次，随草稿重算
     （0.1.2-rc.1：会话快照不再携带 chat.legacy.nodes，采样改走 eventSource）。 */
  const sampleRows = useMemo(() => {
    if (!open) return [];
    try {
      const binding = pluginCtx?.get?.("sessions")?.binding?.(currentId);
      const entries = binding?.eventSource?.getSnapshot?.()?.entries ?? [];
      const events = entries
        .filter((entry) => entry?.type === "event")
        .map((entry) => entry.event)
        .filter((event) => event && Number.isFinite(event.seq));
      return foldHistoryEvents([events]).rows;
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

/** 需要的服务：slots（注册点）、locale（文案）、sessions（binding 事件窗口 /
    loadOlder / 列表快照 / 深补 / 钻取）、remote + remote.session（编辑器模型
    目录 RPC；0.1.2-rc.1 起 connection.api 已移除）。 */
export const inject = ["slots", "locale", "sessions", "remote", "remote.session"];

export function apply(ctx) {
  installStyles(ctx);
  pluginCtx = ctx;
  /* 一次性探针通道（dsh-012-compat spike 1.1）：控制台经 window.__tokenInsightDebug
     访问插件 ctx，实测 sessions.binding 事件窗口语义；live 确认后移除。 */
  if (typeof window !== "undefined") window.__tokenInsightDebug = ctx;
  ctx.effect(() => () => {
    pluginCtx = null;
    if (typeof window !== "undefined") delete window.__tokenInsightDebug;
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
