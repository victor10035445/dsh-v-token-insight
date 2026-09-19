/**
 * dsh-v-token-insight — charts.mjs 单测（任务 4.2 / 4.4 / 5.1）。
 * 覆盖：轮次刻度稀疏化（每 ⌈n/8⌉ 取一、至多 8 个）、堆叠条段间 1px 留隙
 * （最底段贴基线满高，上方段底边削 1px）、图表用色全走 --dsw-* 令牌
 * （硬编码色清零守卫；tools 段 #a78bfa 回归哨兵，design D7/D8）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { BUCKET_SEGMENTS, contextBreakdownLayout, dualAxisTrendLayout, formatAxisTokens, lineLayout, stackedBarsLayout } from "../src/charts.mjs";

/* stackedBarsLayout 默认几何：width 640 / height 150 / pad {top:8,right:8,bottom:20,left:44}。 */
const INNER_H = 150 - 8 - 20;

const row = (turn, input, output) => ({
  turn,
  usage: { inputTokens: input, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: output }
});

test("stackedBarsLayout：轮次刻度稀疏化——n ≤ 8 时全保留（stride=1）", () => {
  const rows = Array.from({ length: 8 }, (_, i) => row(i + 1, 10, 5));
  const layout = stackedBarsLayout(rows);
  assert.equal(layout.stride, 1);
  assert.equal(layout.xLabels.length, 8);
  assert.equal(layout.xLabels[0].turn, 1);
  assert.equal(layout.xLabels[7].turn, 8);
});

test("stackedBarsLayout：轮次刻度稀疏化——每 ⌈n/8⌉ 取一，首刻度恒保留", () => {
  const rows = Array.from({ length: 20 }, (_, i) => row(i + 1, 10, 5));
  const layout = stackedBarsLayout(rows);
  assert.equal(layout.stride, Math.ceil(20 / 8));
  assert.equal(layout.xLabels.length, Math.ceil(20 / layout.stride));
  assert.ok(layout.xLabels.length <= 8);
  assert.deepEqual(
    layout.xLabels.map((label) => label.turn),
    [1, 4, 7, 10, 13, 16, 19]
  );
  /* 刻度 x 与对应条的几何一致（取该条中心）。 */
  assert.equal(layout.xLabels[1].x, layout.bars[3].x + layout.bars[3].w / 2);
});

test("stackedBarsLayout：轮次刻度稀疏化——长窗口刻度数不超过 8", () => {
  const rows = Array.from({ length: 800 }, (_, i) => row(i + 1, 10, 5));
  const layout = stackedBarsLayout(rows);
  assert.equal(layout.stride, Math.ceil(800 / 8));
  assert.equal(layout.xLabels.length, 8);
  assert.equal(layout.xLabels[0].turn, 1);
  assert.equal(layout.xLabels[7].turn, 701);
});

test("stackedBarsLayout：单行有刻度、空输入安全（stride 回退 1）", () => {
  const one = stackedBarsLayout([row(1, 10, 5)]);
  assert.equal(one.xLabels.length, 1);
  const empty = stackedBarsLayout([]);
  assert.equal(empty.xLabels.length, 0);
  assert.equal(empty.stride, 1);
});

test("stackedBarsLayout：堆叠段段间 1px 留隙——最底段满高贴基线，上方段底边削 1px", () => {
  const layout = stackedBarsLayout([row(1, 600, 400)]);
  const segments = layout.bars[0].segments;
  assert.equal(segments.length, 2);
  /* 自底向上 push：input 为最底段（满高），output 为上方段（削 1px）。 */
  const rawBottom = (600 / layout.yMax) * INNER_H;
  const rawTop = (400 / layout.yMax) * INNER_H;
  assert.ok(Math.abs(segments[0].h - rawBottom) < 1e-9);
  assert.ok(Math.abs(segments[1].h - (rawTop - 1)) < 1e-9);
  /* 顶段底边与底段顶边之间空出 1px。 */
  assert.ok(Math.abs(segments[1].y + segments[1].h - (segments[0].y - 1)) < 1e-9);
  /* 最底段仍贴基线。 */
  assert.ok(Math.abs(segments[0].y + segments[0].h - (150 - 20)) < 1e-9);
});

test("stackedBarsLayout：单段条不留隙（段高不削）", () => {
  const layout = stackedBarsLayout([row(1, 1000, 0)]);
  const segments = layout.bars[0].segments;
  assert.equal(segments.length, 1);
  assert.ok(Math.abs(segments[0].h - INNER_H) < 1e-9);
});

test("stackedBarsLayout：Y 轴整刻度（1/2/5×10^k 步进，yMax 取整到步进倍数）", () => {
  /* 峰值柱 total = 3500（其余远小）→ 步进 1000（整千），yMax 4000 覆盖数据。 */
  const rows = [
    row(1, 120, 80),
    row(2, 90, 60),
    row(3, 200, 100),
    row(4, 150, 90),
    row(5, 180, 70),
    row(6, 3_000, 500)
  ];
  const layout = stackedBarsLayout(rows);
  assert.equal(layout.yStep, 1000);
  assert.equal(layout.yMax, 4000);
  assert.deepEqual(
    layout.ticks.map((tick) => tick.value),
    [4000, 3000, 2000, 1000, 0]
  );
  for (const tick of layout.ticks) {
    assert.ok(Number.isInteger(tick.value), "token 刻度恒为整数");
    assert.equal(tick.value % layout.yStep, 0);
  }
});

test("lineLayout：Y 轴整刻度覆盖数据最大值且为步进整数倍", () => {
  const layout = lineLayout([
    { turn: 1, cost: 3.2 },
    { turn: 2, cost: 9.4 },
    { turn: 3, cost: 12.5 }
  ]);
  assert.ok(layout.yMax >= 12.5);
  for (const tick of layout.ticks) {
    assert.ok(Math.abs(tick.cost % layout.yStep) < 1e-9);
    assert.ok(tick.cost >= 0 && tick.cost <= layout.yMax);
  }
  /* 刻度覆盖最高点。 */
  assert.equal(layout.ticks[0].cost, layout.yMax);
});

test("formatAxisTokens：Y 轴 token 刻度整数化（无小数填充，用户反馈）", () => {
  assert.equal(formatAxisTokens(0), "0");
  assert.equal(formatAxisTokens(500), "500");
  assert.equal(formatAxisTokens(1500), "1500");
  assert.equal(formatAxisTokens(2500), "2500");
  assert.equal(formatAxisTokens(12000), "12k");
  assert.equal(formatAxisTokens(18000), "18k");
  assert.equal(formatAxisTokens(500_000), "500k");
  assert.equal(formatAxisTokens(1_000_000), "1M");
  assert.equal(formatAxisTokens(1_500_000), "1.5M");
  assert.equal(formatAxisTokens(2_000_000), "2M");
  assert.equal(formatAxisTokens(2_500_000), "2.5M");
  /* 绝无两位小数（"1.00M" 式）标签。 */
  assert.ok(!/\.\d{2}/.test(formatAxisTokens(1_000_000)));
  assert.ok(!/\.\d{2}/.test(formatAxisTokens(2_500_000)));
});

test("图表用色硬编码色清零（任务 5.1）：四桶与上下文构成段全部为 --dsw-* 令牌", () => {
  for (const segment of BUCKET_SEGMENTS) {
    assert.match(segment.color, /^var\(--dsw-/);
  }
  const breakdown = contextBreakdownLayout({ systemTokens: 10, toolsTokens: 20, messageTokens: 30 });
  assert.equal(breakdown.segments.length, 3);
  for (const segment of breakdown.segments) {
    assert.match(segment.color, /^var\(--dsw-/);
  }
  /* 「工具」段回归哨兵：应为主题令牌，而非硬编码 #a78bfa（design D7/D8）。 */
  const tools = breakdown.segments.find((segment) => segment.key === "toolsTokens");
  assert.equal(tools.color, "var(--dsw-static-deepseek-400)");
});

/* ---- dualAxisTrendLayout：双轴合并趋势（柱=token 左轴，线=费用 右轴）---- */

const trendRow = (day, total, older = false) => ({
  day,
  buckets: { inputTokens: total, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
  total,
  source: older ? "recent" : "step"
});

test("dualAxisTrendLayout：费用点对齐柱位中心（x=柱中心，y 随费用单调）", () => {
  const rows = [trendRow("d1", 1000), trendRow("d2", 2000), trendRow("d3", 3000)];
  const costByKey = new Map([["d1", 1], ["d2", 3], ["d3", 2]]);
  const layout = dualAxisTrendLayout(rows, costByKey);
  assert.equal(layout.hasCost, true);
  assert.equal(layout.costDots.length, 3);
  /* 回归哨兵（用户反馈：此前透传 {day,buckets} 导致柱高全零、页面只剩折线）：
     柱状体必须真实消费 buckets——段非空、高度为正、yMax 随数据缩放。 */
  assert.equal(layout.yMax >= 3000, true);
  for (const bar of layout.bars) {
    assert.equal(bar.segments.length, 1);
    assert.ok(bar.h > 0);
  }
  layout.costDots.forEach((dot, index) => {
    assert.equal(dot.day, rows[index].day);
    /* x = 柱位中心（与 xLabels 刻度同一锚点）。 */
    const bar = layout.bars[index];
    assert.ok(Math.abs(dot.x - (bar.x + bar.w / 2)) < 1e-9);
  });
  /* y 随费用单调递减（费用高 → y 小）。 */
  const byDay = new Map(layout.costDots.map((dot) => [dot.day, dot.y]));
  assert.ok(byDay.get("d2") < byDay.get("d3"));
  assert.ok(byDay.get("d3") < byDay.get("d1"));
  /* 右轴刻度：minStep 0（金额允许小数），同为 1/2/5×10^k 步进、覆盖最高费用。 */
  assert.ok(layout.costYMax >= 3);
  for (const tick of layout.costTicks) {
    assert.ok(Math.abs(tick.cost % layout.costYStep) < 1e-9);
    assert.ok(tick.cost >= 0 && tick.cost <= layout.costYMax);
  }
  assert.equal(layout.costTicks[0].cost, layout.costYMax);
});

test("dualAxisTrendLayout：无费用桶折线断开（分段路径，不跨洞插值）", () => {
  const rows = [trendRow("d1", 1000), trendRow("d2", 2000), trendRow("d3", 1500), trendRow("d4", 800)];
  const costByKey = new Map([["d1", 1], ["d3", 2], ["d4", 0.5]]);
  const layout = dualAxisTrendLayout(rows, costByKey);
  assert.equal(layout.costDots.length, 3);
  /* d2 缺费用 → 恰好两段：[d1] 与 [d3,d4]。 */
  assert.equal(layout.costPaths.length, 2);
  assert.ok(layout.costPaths[0].startsWith("M"));
  assert.ok(!layout.costPaths[0].includes("L"), "单点段只有 M 指令");
  assert.equal(layout.costPaths[1].split("L").length, 2);
});

test("dualAxisTrendLayout：桶键严格对齐——桶集外的费用键被忽略，右轴不被撑爆", () => {
  const rows = [trendRow("older", 500, true), trendRow("d2", 1000)];
  /* "2035-01-01"（超窗日键）不在桶集：不得折入「older」，也不得进入右轴刻度
     （用户反馈：超窗合计折入单点会把右轴撑爆，逐日点全部贴底）。 */
  const costByKey = new Map([["older", 2.5], ["d2", 1], ["2035-01-01", 999]]);
  const layout = dualAxisTrendLayout(rows, costByKey);
  assert.equal(layout.costDots.length, 2);
  assert.equal(layout.costDots[0].day, "older");
  assert.ok(Math.abs(layout.costDots[0].x - (layout.bars[0].x + layout.bars[0].w / 2)) < 1e-9);
  assert.equal(layout.costPaths.length, 1, "older 与 d2 连续 → 单段");
  /* 右轴按桶内费用（max 2.5）缩放，而非被桶外 999 撑爆。 */
  assert.ok(layout.costYMax >= 2.5);
  assert.ok(layout.costYMax < 10);
});

test("dualAxisTrendLayout：无任何费用时退化为纯柱状（hasCost=false，柱几何不变）", () => {
  const rows = [trendRow("d1", 1000), trendRow("d2", 2000)];
  const dual = dualAxisTrendLayout(rows, new Map());
  assert.equal(dual.hasCost, false);
  assert.deepEqual(dual.costDots, []);
  assert.deepEqual(dual.costPaths, []);
  assert.deepEqual(dual.costTicks, []);
  /* 柱几何与同 pad 的 stackedBarsLayout 完全一致（pad.right 默认 64 为右轴留位；
     对照基准同样按 {turn, usage} 归一，与布局内部归一规则一致）。 */
  const pad = { top: 8, right: 64, bottom: 20, left: 44 };
  const base = stackedBarsLayout(rows.map((r) => ({ turn: r.day, usage: r.buckets })), { pad });
  assert.deepEqual(dual.bars, base.bars);
  assert.deepEqual(dual.ticks, base.ticks);
  /* 零/负/非有限费用一律视为缺席。 */
  const weird = dualAxisTrendLayout(rows, new Map([["d1", 0], ["d2", Number.NaN]]));
  assert.equal(weird.hasCost, false);
  /* 空行安全。 */
  const empty = dualAxisTrendLayout([], new Map());
  assert.equal(empty.hasCost, false);
  assert.equal(empty.bars.length, 0);
});

/* ---- dualAxisTrendLayout：会话页 turn 形行（rework-kpi-charts 任务 1.4）---- */

const turnRow = (turn, input, output) => ({
  turn,
  usage: { inputTokens: input, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: output }
});

test("dualAxisTrendLayout：turn 形行费用线渲染 + 点键唯一（费用路径行键归一，评审修正）", () => {
  const rows = [turnRow(1, 1000, 100), turnRow(2, 800, 50), turnRow(3, 1200, 200)];
  const costByKey = new Map([[1, 0.3], [2, 0.05], [3, 0.2]]);
  const layout = dualAxisTrendLayout(rows, costByKey);
  /* 评审修正前费用路径只认 row?.day：turn 形行恒 undefined，费用线整条不渲染。
     修正后：hasCost=true、逐点取值、点键唯一。 */
  assert.equal(layout.hasCost, true);
  assert.equal(layout.costDots.length, 3);
  assert.deepEqual(
    layout.costDots.map((dot) => dot.key),
    [1, 2, 3]
  );
  assert.equal(new Set(layout.costDots.map((dot) => dot.key)).size, 3, "点键唯一");
  assert.equal(layout.costDots[0].turn, 1);
  assert.equal(layout.costDots[0].day, undefined);
  /* 单段连续路径（无断轮）：3 点 = M + 2×L。 */
  assert.equal(layout.costPaths.length, 1);
  assert.equal(layout.costPaths[0].split("L").length, 3);
  /* 未定价轮（缺键）断线：2 号轮缺费用 → 两段。 */
  const gapped = dualAxisTrendLayout(rows, new Map([[1, 0.3], [3, 0.2]]));
  assert.equal(gapped.costDots.length, 2);
  assert.deepEqual(
    gapped.costDots.map((dot) => dot.key),
    [1, 3]
  );
  assert.equal(gapped.costPaths.length, 2);
});

test("dualAxisTrendLayout：day 形行为回归不变（key=day、dot.day 保留）", () => {
  const rows = [trendRow("d1", 1000), trendRow("d2", 2000)];
  const layout = dualAxisTrendLayout(rows, new Map([["d1", 1], ["d2", 3]]));
  assert.equal(layout.hasCost, true);
  assert.deepEqual(
    layout.costDots.map((dot) => dot.key),
    ["d1", "d2"]
  );
  assert.deepEqual(
    layout.costDots.map((dot) => dot.day),
    ["d1", "d2"]
  );
  assert.equal(layout.costDots[0].turn, undefined);
});

/* ---- 目标参考柱（token-stats-plan 消费方）：今日桶位叠加计划值轮廓柱 ---- */

test("stackedBarsLayout：目标柱参与 y 轴缩放，几何与数据柱同位同宽、自基线起算", () => {
  const rows = [row(1, 1000, 0), row(2, 2000, 0)];
  const withoutTarget = stackedBarsLayout(rows);
  const layout = stackedBarsLayout(rows, { target: { key: 2, value: 5000 } });
  /* 目标值抬高 yMax（5000 > 数据峰值 2000），轮廓柱不出界。 */
  assert.ok(layout.yMax >= 5000);
  assert.ok(layout.yMax > withoutTarget.yMax);
  const bar = layout.bars[1];
  assert.equal(layout.targetBar.key, 2);
  assert.equal(layout.targetBar.value, 5000);
  /* 与数据柱同 x/w（同槽位参考柱；轮廓/外扩呈现属渲染侧）。 */
  assert.equal(layout.targetBar.x, bar.x);
  assert.equal(layout.targetBar.w, bar.w);
  /* 高度按同一 yOf 缩放且自基线起算（底边贴 pad.top+innerH）。 */
  assert.ok(Math.abs(layout.targetBar.h - (5000 / layout.yMax) * INNER_H) < 1e-9);
  assert.ok(Math.abs(layout.targetBar.y + layout.targetBar.h - (150 - 20)) < 1e-9);
});

test("stackedBarsLayout：键不匹配/未设置/非法值 → 无目标柱且 yMax 不被扰动", () => {
  const rows = [row(1, 1000, 0), row(2, 2000, 0)];
  const withoutTarget = stackedBarsLayout(rows);
  /* key 不在行集（如今日桶不在趋势窗口）→ 不产出。 */
  assert.equal(stackedBarsLayout(rows, { target: { key: 99, value: 5000 } }).targetBar, null);
  /* 「未设置是一等状态（区别于 0）」：null / 0 / 负数 / NaN 一律视为缺席。 */
  for (const bad of [null, undefined, { key: 2, value: 0 }, { key: 2, value: -5 }, { key: 2, value: Number.NaN }]) {
    const layout = stackedBarsLayout(rows, { target: bad });
    assert.equal(layout.targetBar, null);
    assert.equal(layout.yMax, withoutTarget.yMax);
  }
  /* 极小目标值：h 下限 1px 保证轮廓可读可悬停。 */
  const tiny = stackedBarsLayout([row(1, 1_000_000, 0)], { target: { key: 1, value: 1 } });
  assert.equal(tiny.targetBar.h, 1);
});

test("dualAxisTrendLayout：target 透传（day 形行键匹配今日桶），无目标零回归", () => {
  const rows = [trendRow("2026-09-04", 1000), trendRow("2026-09-05", 3000)];
  const layout = dualAxisTrendLayout(rows, new Map([["2026-09-05", 1.2]]), { target: { key: "2026-09-05", value: 8000 } });
  assert.equal(layout.hasCost, true);
  assert.ok(layout.targetBar !== null);
  assert.equal(layout.targetBar.key, "2026-09-05");
  assert.equal(layout.targetBar.x, layout.bars[1].x);
  assert.equal(layout.targetBar.w, layout.bars[1].w);
  assert.ok(layout.yMax >= 8000);
  /* 无目标（未设计划/月年颗粒度）：targetBar=null，其余产物不变。 */
  const plain = dualAxisTrendLayout(rows, new Map([["2026-09-05", 1.2]]));
  assert.equal(plain.targetBar, null);
  assert.equal(plain.hasCost, true);
  assert.deepEqual(plain.costDots, layout.costDots);
});

/* ---- 月键目标参考柱（add-monthly-plan）：月颗粒度「本月」桶位叠加每月计划 ---- */

test("dualAxisTrendLayout：月键目标柱（YYYY-MM 行键）与月行同位同宽、自基线起算", () => {
  /* 月颗粒度趋势行：row.day 装 YYYY-MM 月键（布局层颗粒度无关，键匹配同式）。 */
  const rows = [trendRow("2026-07", 4000), trendRow("2026-08", 6000), trendRow("2026-09", 5000)];
  const layout = dualAxisTrendLayout(rows, new Map([["2026-09", 1.2]]), { target: { key: "2026-09", value: 60_000_000 } });
  assert.ok(layout.targetBar !== null);
  assert.equal(layout.targetBar.key, "2026-09");
  assert.equal(layout.targetBar.value, 60_000_000);
  /* 与本月数据柱同 x/w（同槽位参考柱；轮廓/外扩呈现属渲染侧）。 */
  assert.equal(layout.targetBar.x, layout.bars[2].x);
  assert.equal(layout.targetBar.w, layout.bars[2].w);
  /* 高度按同一 yOf 缩放且自基线起算（底边贴 pad.top+innerH；默认几何 innerH=122）。 */
  assert.ok(Math.abs(layout.targetBar.h - (60_000_000 / layout.yMax) * INNER_H) < 1e-9);
  assert.ok(Math.abs(layout.targetBar.y + layout.targetBar.h - (150 - 20)) < 1e-9);
});

test("dualAxisTrendLayout：月目标值参与左轴 token 缩放（yMax 抬高，柱不出界）", () => {
  const rows = [trendRow("2026-08", 6000), trendRow("2026-09", 5000)];
  const withoutTarget = dualAxisTrendLayout(rows, new Map([["2026-09", 1.2]]));
  const layout = dualAxisTrendLayout(rows, new Map([["2026-09", 1.2]]), { target: { key: "2026-09", value: 60_000_000 } });
  /* 目标值 60M 抬高 yMax（月计划远大于历史月消耗为既定取舍，niceScale 保证刻度可读）。 */
  assert.ok(layout.yMax >= 60_000_000);
  assert.ok(layout.yMax > withoutTarget.yMax);
  assert.ok(layout.targetBar.y >= 8); /* 顶部不出绘图区（pad.top=8） */
  /* 反向：仅设月值且数据峰值高于计划时目标柱仍按同刻度起算（不贴底失真）。 */
  const small = dualAxisTrendLayout(rows, new Map([["2026-09", 1.2]]), { target: { key: "2026-09", value: 5000 } });
  assert.ok(small.yMax >= 6000);
  assert.ok(Math.abs(small.targetBar.h - (5000 / small.yMax) * INNER_H) < 1e-9);
});

test("dualAxisTrendLayout：月键不匹配任何行 → targetBar 为 null（本月桶缺席同规则）", () => {
  const rows = [trendRow("2026-07", 4000), trendRow("2026-08", 6000)];
  const layout = dualAxisTrendLayout(rows, new Map(), { target: { key: "2026-09", value: 60_000_000 } });
  assert.equal(layout.targetBar, null); /* 当月无消耗（行集无本月桶）→ 不渲染月目标柱 */
  /* 布局层既有契约：目标值先参与缩放、后做键匹配（键不匹配仅 targetBar=null，
     yMax 已按目标值抬高）——「缺席桶不渲染」由调用方守卫（OverviewTab 仅在行集
     含桶时传 target，见 token-stats-overview 规格目标柱条款），与本断言互补。 */
});
