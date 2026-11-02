/**
 * dsh-v-token-insight — rows-aggregate.mjs 单测（tasks 3.1 / 7.2）。
 * 覆盖：cwd 归组与「未知」、子会话独立成行 + 父 cwd 回退、归档交集、
 * blank 排除、投影缺席降级（零计入 / 全缺席「—」）、命中率、时间分桶双口径、
 * 归档数据面缺失守卫、depth 计算；fix-partial-coverage：趋势余量
 * （computeTrendRemainders 截零/全零不入/fork 排除 + aggregateByTime 余量归并、
 * 老化桶重新入柱、「更早」窗口）与一致性断言（趋势合计 ≡ 投影合计 − fork）。
 * hide-trend-older-bar：chartTrendRows 展示层过滤（older 剔除 / 仅 older 保留 /
 * 空集 / 无 older 等价）与 aggregateByTime 数据层行为锁定（折叠 unshift 首位、
 * 全零不入）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  aggregateByModel,
  aggregateByTime,
  aggregateKpi,
  aggregateSessions,
  aggregateWorkspaces,
  archivedMissingFromList,
  billedIn,
  bucketsOfProjection,
  chartTrendRows,
  computeTrendRemainders,
  dayKeyOf,
  expandRows,
  groupCostByGranularity,
  hitPercent,
  projectNameOf,
  timeKeyOf,
  totalTokens
} from "../src/rows-aggregate.mjs";

const usage = (input = 0, cacheRead = 0, cacheWrite = 0, output = 0) => ({
  uncachedInputTokens: input,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
  outputTokens: output
});

const row = (over = {}) => ({
  id: "s1",
  displayTitle: "会话一",
  running: false,
  completed: false,
  blank: false,
  updatedAt: 1_700_000_000_000,
  projectionValues: { tokenUsage: usage(100, 300, 20, 50) },
  ...over
});

/* ---------------------------------------------------------------- *
 * 桶记法与基础量
 * ---------------------------------------------------------------- */

test("bucketsOfProjection：双形状兼容（uncachedInputTokens / inputTokens）", () => {
  assert.deepEqual(bucketsOfProjection(usage(1, 2, 3, 4)), { inputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4 });
  assert.deepEqual(bucketsOfProjection({ inputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }).inputTokens, 5);
  assert.equal(bucketsOfProjection(void 0), null);
  assert.equal(bucketsOfProjection(null), null);
});

test("billedIn / totalTokens / hitPercent 基础口径", () => {
  const buckets = bucketsOfProjection(usage(100, 300, 20, 50));
  assert.equal(billedIn(buckets), 420);
  assert.equal(totalTokens(buckets), 470);
  assert.equal(Math.round(hitPercent(buckets) * 1000) / 1000, Math.round((300 / 420) * 100 * 1000) / 1000);
  assert.equal(hitPercent({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 }), null);
});

test("projectNameOf：basename（含尾分隔符与混合斜杠）", () => {
  assert.equal(projectNameOf("F:\\project\\dsh-v-token-insight"), "dsh-v-token-insight");
  assert.equal(projectNameOf("/home/u/proj/"), "proj");
  assert.equal(projectNameOf(""), null);
  assert.equal(projectNameOf(void 0), null);
});

/* ---------------------------------------------------------------- *
 * expandRows：blank 排除 / 子会话 / depth / 父 cwd 回退
 * ---------------------------------------------------------------- */

test("expandRows：blank 行被排除，不参与任何聚合", () => {
  const expanded = expandRows([row({ id: "a", blank: true }), row({ id: "b" })]);
  assert.equal(expanded.length, 1);
  assert.equal(expanded[0].id, "b");
});

test("expandRows：子会话独立成行并带 depth，不混计父行", () => {
  const parent = row({ id: "p" });
  const child = row({ id: "c", parentId: "p", origin: "subagent" });
  const expanded = expandRows([parent, child]);
  assert.equal(expanded.length, 2);
  const childRow = expanded.find((item) => item.id === "c");
  assert.equal(childRow.isSub, true);
  assert.equal(childRow.depth, 1);
  assert.equal(childRow.usage.inputTokens, 100); /* 自身四桶，不叠父行 */
});

test("expandRows：子会话 cwd 缺失回退父会话 cwd；无父可回退归「未知」", () => {
  const parent = row({ id: "p", cwd: "F:\\proj\\alpha" });
  const child = row({ id: "c", parentId: "p" });
  const orphan = row({ id: "o", parentId: "ghost" });
  const expanded = expandRows([parent, child, orphan]);
  assert.equal(expanded.find((i) => i.id === "c").cwd, "F:\\proj\\alpha");
  assert.equal(expanded.find((i) => i.id === "c").groupName, "alpha");
  assert.equal(expanded.find((i) => i.id === "o").cwd, null);
  assert.equal(expanded.find((i) => i.id === "o").groupName, null);
});

test("expandRows：lineage 环不悬挂（depth 有穷）", () => {
  const a = row({ id: "a", parentId: "b" });
  const b = row({ id: "b", parentId: "a" });
  const expanded = expandRows([a, b]);
  assert.ok(expanded.every((item) => Number.isFinite(item.depth)));
});

test("expandRows：标题回退 displayTitle → id；投影缺席 hasUsage=false", () => {
  const expanded = expandRows([
    { id: "x", displayTitle: void 0, running: false, blank: false },
    row({ id: "y", projectionValues: {} }),
    row({ id: "z", projectionValues: void 0 })
  ]);
  assert.equal(expanded.find((i) => i.id === "x").title, "x");
  assert.equal(expanded.find((i) => i.id === "y").hasUsage, false);
  assert.equal(expanded.find((i) => i.id === "z").usage, null);
  assert.equal(expanded.find((i) => i.id === "z").hasUsage, false);
});

/* ---------------------------------------------------------------- *
 * KPI：合计 / 归档计入 / 空会话不计 / 缺席降级
 * ---------------------------------------------------------------- */

test("aggregateKpi：归档计入合计与计数；运行中如实计数", () => {
  const expanded = expandRows([
    row({ id: "a", running: true }),
    row({ id: "b", projectionValues: { tokenUsage: usage(10, 0, 0, 5) } }),
    row({ id: "c", blank: true })
  ]);
  const kpi = aggregateKpi(expanded, ["b"]);
  assert.equal(kpi.sessions, 2);
  assert.equal(kpi.archived, 1);
  assert.equal(kpi.running, 1);
  assert.equal(kpi.billedIn, 430); /* a: 420（三桶输入）+ b: 10 */
  assert.equal(kpi.billedTotal, 485); /* + a 输出 50 + b 输出 5 */
});

test("aggregateKpi：全部行投影缺席 → hasAnyUsage=false（KPI 显示「—」）", () => {
  const expanded = expandRows([row({ id: "a", projectionValues: void 0 }), row({ id: "b", projectionValues: {} })]);
  const kpi = aggregateKpi(expanded, []);
  assert.equal(kpi.hasAnyUsage, false);
  assert.equal(kpi.billedTotal, 0);
  assert.equal(kpi.cacheHit, null);
});

test("aggregateKpi：个别行缺席按零计入", () => {
  const expanded = expandRows([row({ id: "a", projectionValues: void 0 }), row({ id: "b" })]);
  const kpi = aggregateKpi(expanded, []);
  assert.equal(kpi.hasAnyUsage, true);
  assert.equal(kpi.billedTotal, 470);
});

/* ---------------------------------------------------------------- *
 * 按工作区归组
 * ---------------------------------------------------------------- */

test("aggregateWorkspaces：同项目聚合、无 cwd 归「未知」、workspace 标题优先", () => {
  const expanded = expandRows([
    row({ id: "a", cwd: "F:\\proj\\alpha" }),
    row({ id: "b", cwd: "F:\\proj\\alpha" }),
    row({ id: "c" })
  ]);
  const groups = aggregateWorkspaces(expanded, {
    items: [{ path: "F:\\proj\\alpha", title: "Alpha 工作区" }]
  });
  assert.equal(groups.length, 2);
  assert.equal(groups[0].name, "Alpha 工作区");
  assert.equal(groups[0].sessions, 2);
  assert.equal(groups[0].total, 940); /* 两行各 470，降序在首 */
  const unknown = groups.find((group) => group.cwd === null);
  assert.equal(unknown.name, null);
  assert.equal(unknown.sessions, 1);
});

test("aggregateWorkspaces：子会话并入父项目（父 cwd 回退）", () => {
  const expanded = expandRows([
    row({ id: "p", cwd: "/w/beta" }),
    row({ id: "c", parentId: "p", origin: "subagent" })
  ]);
  const groups = aggregateWorkspaces(expanded, null);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, "beta");
  assert.equal(groups[0].sessions, 2);
});

test("aggregateWorkspaces：按工作区费用求和（已定价合计 + 未定价计数 + 无覆盖「—」）", () => {
  const expanded = expandRows([
    row({ id: "a", cwd: "F:\\proj\\alpha" }),
    row({ id: "b", cwd: "F:\\proj\\alpha" }),
    row({ id: "c", cwd: "F:\\proj\\alpha" }),
    row({ id: "d", cwd: "F:\\proj\\beta" })
  ]);
  const ledgerBySession = new Map([
    ["a", { covered: true, cost: 1.25, currency: "CNY", unmatched: [], coverage: {} }],
    ["b", { covered: true, cost: 2.5, currency: "CNY", unmatched: [], coverage: {} }],
    /* 覆盖但未定价（如未知模型）：计入 costUnpriced，不计入金额 */
    ["c", { covered: true, cost: null, currency: "CNY", unmatched: ["未知模型:无价目"], coverage: {} }],
    /* d 无账本覆盖：不参与 */
  ]);
  const groups = aggregateWorkspaces(expanded, null, ledgerBySession);
  const alpha = groups.find((group) => group.cwd === "F:\\proj\\alpha");
  assert.equal(alpha.cost, 3.75);
  assert.equal(alpha.costPriced, 2);
  assert.equal(alpha.costUnpriced, 1);
  assert.equal(alpha.currency, "CNY");
  const beta = groups.find((group) => group.cwd === "F:\\proj\\beta");
  assert.equal(beta.cost, null); /* 无任何已定价会话 → 「—」 */
  assert.equal(beta.costPriced, 0);
  assert.equal(beta.costUnpriced, 0);
  /* 未传账本面（旧调用形状）→ cost = null，其余字段不受影响 */
  const plain = aggregateWorkspaces(expanded, null);
  assert.equal(plain.find((group) => group.cwd === "F:\\proj\\alpha").cost, null);
  assert.equal(plain.find((group) => group.cwd === "F:\\proj\\alpha").total, 3 * 470);
});

test("aggregateWorkspaces：fork 行不参与归组合计", () => {
  const expanded = expandRows([
    row({ id: "p", cwd: "/w/x" }),
    row({ id: "f", parentId: "p", cwd: "/w/x" })
  ]);
  const groups = aggregateWorkspaces(expanded, null);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].sessions, 1); /* fork 不进组 */
  assert.equal(groups[0].total, 470);
});

test("expandRows：fork 分支识别（parentId 且非 subagent）；KPI 排除其副本消耗", () => {
  const expanded = expandRows([
    row({ id: "p" }),
    row({ id: "f", parentId: "p" }),
    row({ id: "c", parentId: "p", origin: "subagent" })
  ]);
  const fork = expanded.find((item) => item.id === "f");
  const sub = expanded.find((item) => item.id === "c");
  assert.equal(fork.isFork, true);
  assert.equal(fork.isSub, true);
  assert.equal(sub.isFork, false); /* subagent 委派子会话不是 fork */
  assert.equal(sub.isSub, true);
  const kpi = aggregateKpi(expanded, []);
  assert.equal(kpi.billedTotal, 940); /* p + c 各 470；f 是父会话消耗的副本，不计入 */
  assert.equal(kpi.sessions, 3); /* fork 仍是会话，计数保留 */
});

test("aggregateSessions：fork 行透传 isFork（行保留可查）", () => {
  const expanded = expandRows([row({ id: "f", parentId: "p" })]);
  const rows = aggregateSessions(expanded, [], null);
  assert.equal(rows[0].isFork, true);
  assert.equal(rows[0].covered, false);
});

/* ---------------------------------------------------------------- *
 * 按会话明细
 * ---------------------------------------------------------------- */

test("aggregateSessions：归档徽标位、命中率、账本面缺省「—」", () => {
  const expanded = expandRows([row({ id: "a" }), row({ id: "b" })]);
  const rows = aggregateSessions(expanded, ["a"], null);
  const archivedRow = rows.find((item) => item.id === "a");
  assert.equal(archivedRow.archived, true);
  assert.equal(archivedRow.covered, false);
  assert.equal(archivedRow.cost, null);
  assert.ok(archivedRow.cacheHit > 0);
});

test("aggregateSessions：账本面透传（费用/币种/覆盖）", () => {
  const expanded = expandRows([row({ id: "a" })]);
  const rows = aggregateSessions(expanded, [], new Map([["a", { covered: true, cost: 0.5, currency: "CNY", unmatched: [], coverage: {} }]]));
  assert.equal(rows[0].cost, 0.5);
  assert.equal(rows[0].currency, "CNY");
  assert.equal(rows[0].covered, true);
});

/* ---------------------------------------------------------------- *
 * 按时间分桶（双口径）
 * ---------------------------------------------------------------- */

test("aggregateByTime：账本覆盖会话按步时刻、未覆盖按 updatedAt，口径标注", () => {
  const now = Date.now();
  const day = dayKeyOf(now);
  const expanded = expandRows([
    row({ id: "covered", updatedAt: now }),
    row({ id: "plain", updatedAt: now })
  ]);
  const ledgerDaily = new Map([[day, { buckets: { inputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } }]]);
  const rows = aggregateByTime(expanded, ledgerDaily, new Set(["covered"]));
  const merged = rows.find((item) => item.day === day);
  assert.ok(merged);
  assert.equal(merged.source, "mixed"); /* 同日双口径合并为一条，徽标注 mixed */
  /* covered 会话不计 updatedAt 桶：当天仅账本 7 + 未覆盖 plain 470 */
  assert.equal(totalTokens(merged.buckets), 477);
});

test("aggregateByTime：超出窗口归「更早」桶", () => {
  const now = Date.now();
  const old = now - 400 * 86_400_000;
  const expanded = expandRows([row({ id: "old", updatedAt: old }), row({ id: "new", updatedAt: now })]);
  const rows = aggregateByTime(expanded, new Map(), new Set(), { days: 30 });
  assert.equal(rows[0].day, "older");
  assert.equal(rows[0].source, "recent");
  assert.equal(rows.length, 2);
});

test("dayKeyOf：本地时区日键与非法输入", () => {
  assert.match(dayKeyOf(0), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(dayKeyOf(Number.NaN), null);
});

/* ---------------------------------------------------------------- *
 * 按时间分桶：颗粒度（日 / 月 / 年）
 * ---------------------------------------------------------------- */

test("timeKeyOf：日键 → 月/年桶键，非法输入 null", () => {
  assert.equal(timeKeyOf("2026-09-15", "day"), "2026-09-15");
  assert.equal(timeKeyOf("2026-09-15", "month"), "2026-09");
  assert.equal(timeKeyOf("2026-09-15", "year"), "2026");
  assert.equal(timeKeyOf("2026-9-15", "month"), null);
  assert.equal(timeKeyOf(void 0, "month"), null);
});

test("aggregateByTime：按月颗粒度同月日键合并（双口径混算标注 mixed）", () => {
  const now = Date.now();
  const month = dayKeyOf(now).slice(0, 7);
  const expanded = expandRows([row({ id: "plain", updatedAt: now })]);
  const ledgerDaily = new Map([[dayKeyOf(now), { buckets: { inputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } }]]);
  const rows = aggregateByTime(expanded, ledgerDaily, new Set(), { granularity: "month" });
  const merged = rows.find((item) => item.day === month);
  assert.ok(merged);
  assert.equal(merged.source, "mixed");
  assert.equal(totalTokens(merged.buckets), 477); /* 账本 7 + 未覆盖 plain 470 */
});

test("aggregateByTime：按年颗粒度不同年各自成行，且不设窗口（无「更早」）", () => {
  const now = Date.now();
  const year = String(new Date(now).getFullYear());
  const ancient = now - 400 * 86_400_000; /* 400 天必落上一年 */
  const expanded = expandRows([row({ id: "recent", updatedAt: now }), row({ id: "ancient", updatedAt: ancient })]);
  const rows = aggregateByTime(expanded, new Map(), new Set(), { granularity: "year" });
  assert.equal(rows.some((item) => item.day === "older"), false);
  assert.equal(rows.length, 2); /* 两个年份行，升序 */
  const current = rows.find((item) => item.day === year);
  assert.ok(current);
  assert.equal(current.source, "recent");
});

test("aggregateByTime：按月颗粒度超 12 个自然月归「更早」", () => {
  const now = Date.now();
  const old = now - 400 * 86_400_000; /* > 12 个月 */
  const expanded = expandRows([row({ id: "old", updatedAt: old }), row({ id: "new", updatedAt: now })]);
  const rows = aggregateByTime(expanded, new Map(), new Set(), { granularity: "month" });
  assert.equal(rows[0].day, "older");
  assert.equal(rows.length, 2);
});

test("aggregateByTime：maxBuckets 桶数上限——超限最旧桶并入「更早」，不足上限全量显示", () => {
  const now = Date.now();
  /* 5 个不同年份（365 天步进必跨年），上限 3 桶。 */
  const expanded = expandRows(
    [0, 1, 2, 3, 4].map((index) => row({ id: `y${index}`, updatedAt: now - index * 365 * 86_400_000 }))
  );
  const rows = aggregateByTime(expanded, new Map(), new Set(), { granularity: "year", maxBuckets: 3 });
  assert.equal(rows[0].day, "older"); /* 最旧 2 个年份（5 − 3）并入「更早」 */
  assert.equal(totalTokens(rows[0].buckets), 940); /* 2 × 470 */
  assert.equal(rows.length, 4); /* 「更早」+ 3 个年份行 */
  assert.deepEqual(
    rows.slice(1).map((item) => item.day),
    [2, 1, 0].map((index) => String(new Date(now - index * 365 * 86_400_000).getFullYear()))
  );
  /* 不足上限：全量显示、无「更早」。 */
  const all = aggregateByTime(expanded, new Map(), new Set(), { granularity: "year", maxBuckets: 10 });
  assert.equal(all.length, 5);
  assert.equal(all.some((item) => item.day === "older"), false);
});

test("aggregateByTime：默认颗粒度保持按日既有行为（日键原样）", () => {
  const now = Date.now();
  const day = dayKeyOf(now);
  const expanded = expandRows([row({ id: "plain", updatedAt: now })]);
  const rows = aggregateByTime(expanded, new Map(), new Set());
  assert.deepEqual(rows.map((item) => item.day), [day]);
});

test("groupCostByGranularity：日点归并为月点/年点（求和、升序）；day 原样透传", () => {
  const points = [
    { day: "2026-01-02", cost: 1 },
    { day: "2026-01-20", cost: 2 },
    { day: "2026-02-03", cost: 4 },
    { day: "2025-12-31", cost: 8 }
  ];
  assert.deepEqual(groupCostByGranularity(points, "month"), [
    { day: "2025-12", cost: 8 },
    { day: "2026-01", cost: 3 },
    { day: "2026-02", cost: 4 }
  ]);
  assert.deepEqual(groupCostByGranularity(points, "year"), [
    { day: "2025", cost: 8 },
    { day: "2026", cost: 7 }
  ]);
  assert.deepEqual(groupCostByGranularity(points, "day"), points);
});

/* ---------------------------------------------------------------- *
 * 按模型与归档守卫
 * ---------------------------------------------------------------- */

test("aggregateByModel：附加「未分类」行（余量）", () => {
  const rows = aggregateByModel([{ model: "m1", buckets: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 }, total: 15 }], {
    inputTokens: 3,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 2
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].model, "m1");
  assert.equal(rows[1].model, null);
  assert.equal(rows[1].total, 5);
});

test("aggregateByModel：零余量不加「未分类」行", () => {
  const rows = aggregateByModel([{ model: "m1", buckets: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, total: 1 }], {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0
  });
  assert.equal(rows.length, 1);
});

test("aggregateByModel：费用字段透传；「未分类」行 cost 恒 null", () => {
  const rows = aggregateByModel(
    [
      { model: "m1", buckets: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 }, total: 15, cost: 0.75, avgCost: 0.05, currency: "CNY", unmatched: [] },
      { model: "m2", buckets: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, total: 1, cost: null, avgCost: null, currency: "CNY", unmatched: [] }
    ],
    {
      inputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 2
    }
  );
  assert.equal(rows[0].cost, 0.75);
  assert.equal(rows[0].avgCost, 0.05);
  assert.equal(rows.find((r) => r.model === "m2").cost, null);
  assert.equal(rows.find((r) => r.model === null).cost, null); /* 未分类行不可归因 */
  assert.equal(rows.find((r) => r.model === null).avgCost, null);
});

test("archivedMissingFromList：归档集合非空但列表不携带 → 数据面缺失", () => {
  const expanded = expandRows([row({ id: "a" })]);
  assert.equal(archivedMissingFromList(expanded, ["ghost"]), true);
  assert.equal(archivedMissingFromList(expandRows([row({ id: "a" }), row({ id: "g" })]), ["g"]), false);
  assert.equal(archivedMissingFromList(expanded, []), false);
});

test("expandRows：投影缺席回退账本四桶（usageSource 口径标记；投影在场一律投影优先）", () => {
  const fallback = new Map([
    ["s-absent", { inputTokens: 11, cacheReadTokens: 22, cacheWriteTokens: 3, outputTokens: 44 }],
    ["s-both", { inputTokens: 999, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 999 }]
  ]);
  const rows = [
    row({ id: "s-proj", projectionValues: { tokenUsage: usage(100, 300, 20, 50) } }),
    row({ id: "s-absent", projectionValues: void 0 }),
    row({ id: "s-both", projectionValues: { tokenUsage: usage(0, 0, 0, 0) } }),
    row({ id: "s-none", projectionValues: void 0 })
  ];
  const byId = new Map(expandRows(rows, fallback).map((item) => [item.id, item]));
  assert.equal(byId.get("s-proj").usageSource, "projection");
  assert.equal(byId.get("s-proj").usage.inputTokens, 100);
  assert.equal(byId.get("s-absent").usageSource, "ledger");
  assert.equal(byId.get("s-absent").usage.cacheReadTokens, 22);
  assert.equal(byId.get("s-both").usageSource, "projection"); /* 投影在场含真零也以投影为准 */
  assert.equal(byId.get("s-both").usage.inputTokens, 0);
  assert.equal(byId.get("s-none").usageSource, "none");
  assert.equal(byId.get("s-none").usage, null);
  /* 既有单参签名行为不变：无兜底时缺席即 none */
  const bare = new Map(expandRows(rows).map((item) => [item.id, item]));
  assert.equal(bare.get("s-absent").usageSource, "none");
  assert.equal(bare.get("s-absent").usage, null);
});

/* ---------------------------------------------------------------- *
 * 趋势余量：computeTrendRemainders + aggregateByTime 归并
 * （fix-partial-coverage 1.4）
 * ---------------------------------------------------------------- */

const bucketRow = (input = 0, cacheRead = 0, cacheWrite = 0, output = 0) => ({
  inputTokens: input,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
  outputTokens: output
});

test("computeTrendRemainders：投影 − 已按日入柱，逐桶截零", () => {
  const dailyBucketsBySession = new Map([["s1", bucketRow(120, 300, 20, 30)]]);
  const expanded = expandRows([row({ id: "s1", projectionValues: { tokenUsage: usage(100, 300, 20, 50) } })]);
  const remainders = computeTrendRemainders(expanded, dailyBucketsBySession);
  /* 输入 −120 截零；输出 +20 保留。 */
  assert.deepEqual(remainders.get("s1"), { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20 });
});

test("computeTrendRemainders：全零不入；无键（未覆盖）不产生余量", () => {
  const dailyBucketsBySession = new Map([
    ["s-zero", bucketRow(100, 300, 20, 50)], /* 投影 == 账本 → 全零 */
    ["s-covered", bucketRow(1, 0, 0, 0)]
  ]);
  const expanded = expandRows([
    row({ id: "s-zero" }),
    row({ id: "s-uncovered", updatedAt: 1_700_000_000_000 }),
    row({ id: "s-covered", projectionValues: { tokenUsage: usage(5, 0, 0, 0) } })
  ]);
  const remainders = computeTrendRemainders(expanded, dailyBucketsBySession);
  assert.equal(remainders.size, 1);
  assert.deepEqual(remainders.get("s-covered"), bucketRow(4, 0, 0, 0));
  assert.equal(remainders.has("s-zero"), false);
  assert.equal(remainders.has("s-uncovered"), false); /* 无键走既有整桶路径 */
});

test("computeTrendRemainders：fork 行排除（其投影本就全量排除）", () => {
  const dailyBucketsBySession = new Map([["p", bucketRow(0, 0, 0, 0)], ["f", bucketRow(0, 0, 0, 0)]]);
  const expanded = expandRows([row({ id: "p" }), row({ id: "f", parentId: "p" })]);
  const remainders = computeTrendRemainders(expanded, dailyBucketsBySession);
  assert.equal(remainders.has("f"), false);
  assert.ok(remainders.has("p"));
});

test("aggregateByTime：余量并入——覆盖段按步归日 + 余量整桶落 updatedAt（「按最近活动」徽标）", () => {
  const now = Date.now();
  const today = dayKeyOf(now);
  const yesterday = dayKeyOf(now - 86_400_000);
  const expanded = expandRows([row({ id: "partial", updatedAt: now })]);
  const ledgerDaily = new Map([[yesterday, { buckets: bucketRow(200, 0, 0, 0) }]]);
  const remainders = new Map([["partial", bucketRow(270, 0, 0, 0)]]);
  const rows = aggregateByTime(expanded, ledgerDaily, new Set(["partial"]), { remainders });
  const coveredRow = rows.find((item) => item.day === yesterday);
  const remainderRow = rows.find((item) => item.day === today);
  assert.equal(totalTokens(coveredRow.buckets), 200); /* 覆盖段按步发生时刻归日 */
  assert.equal(coveredRow.source, "ledger");
  assert.equal(totalTokens(remainderRow.buckets), 270); /* 余量整桶落 updatedAt */
  assert.equal(remainderRow.source, "recent"); /* 与未覆盖会话共用「按最近活动」徽标 */
});

test("aggregateByTime：余量与覆盖段同日 → 合并桶标 mixed", () => {
  const now = Date.now();
  const today = dayKeyOf(now);
  const expanded = expandRows([row({ id: "partial", updatedAt: now })]);
  const ledgerDaily = new Map([[today, { buckets: bucketRow(200, 0, 0, 0) }]]);
  const remainders = new Map([["partial", bucketRow(270, 0, 0, 0)]]);
  const rows = aggregateByTime(expanded, ledgerDaily, new Set(["partial"]), { remainders });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].day, today);
  assert.equal(rows[0].source, "mixed");
  assert.equal(totalTokens(rows[0].buckets), 470);
});

test("aggregateByTime：全零余量不入（covered 行照旧跳过）；缺省 remainders 行为不变", () => {
  const now = Date.now();
  const today = dayKeyOf(now);
  const expanded = expandRows([row({ id: "covered", updatedAt: now })]);
  const rows = aggregateByTime(expanded, new Map(), new Set(["covered"]), {
    remainders: new Map([["covered", bucketRow(0, 0, 0, 0)]])
  });
  assert.equal(rows.length, 0); /* 全零余量：不产生任何桶 */
  /* 缺省 remainders（旧调用形状）：covered 行整行跳过，既有行为不变。 */
  const legacy = aggregateByTime(expanded, new Map([[today, { buckets: bucketRow(7, 0, 0, 0) }]]), new Set(["covered"]));
  assert.equal(legacy.length, 1);
  assert.equal(totalTokens(legacy[0].buckets), 7);
  assert.equal(legacy[0].source, "ledger");
});

test("aggregateByTime：updatedAt === null 的余量行照旧跳过", () => {
  const expanded = expandRows([{ id: "no-time", displayTitle: "x", running: false, blank: false, updatedAt: void 0, projectionValues: { tokenUsage: usage(100, 0, 0, 0) } }]);
  const rows = aggregateByTime(expanded, new Map(), new Set(["no-time"]), {
    remainders: new Map([["no-time", bucketRow(100, 0, 0, 0)]])
  });
  assert.equal(rows.length, 0);
});

test("aggregateByTime：含 fork 行时其余量不并入（投影副本不进趋势）", () => {
  const now = Date.now();
  const today = dayKeyOf(now);
  const expanded = expandRows([row({ id: "p", updatedAt: now }), row({ id: "f", parentId: "p", updatedAt: now })]);
  const rows = aggregateByTime(expanded, new Map(), new Set(["p", "f"]), {
    /* 防御性构造：即便上游误传 fork 余量，也不得入桶。 */
    remainders: new Map([["f", bucketRow(999, 0, 0, 0)], ["p", bucketRow(100, 0, 0, 0)]])
  });
  assert.equal(rows.length, 1);
  assert.equal(totalTokens(rows[0].buckets), 100); /* 只有 p 的余量 */
});

test("aggregateByTime：含老化桶会话——老化段经余量重新入柱、费用线不受余量影响", () => {
  const now = Date.now();
  const today = dayKeyOf(now);
  const expanded = expandRows([row({ id: "aging", updatedAt: now })]);
  /* 仅老化桶会话：dailyBuckets 占位全零键（aggregateLedgerViews 产物形状）。 */
  const dailyBucketsBySession = new Map([["aging", bucketRow(0, 0, 0, 0)]]);
  const remainders = computeTrendRemainders(expanded, dailyBucketsBySession);
  assert.deepEqual(remainders.get("aging"), bucketRow(100, 300, 20, 50)); /* 全投影成为余量 */
  const rows = aggregateByTime(expanded, new Map(), new Set(["aging"]), { remainders });
  assert.equal(rows.length, 1);
  assert.equal(totalTokens(rows[0].buckets), 470); /* 老化段经余量按最近活动重新入柱 */
  /* 费用线不因余量变化：费用点 = 日键并集 ∪ dailyCost，值只读 dailyCost
     （与 client.jsx trendCostPoints 同式）——余量日费用恒 0，不虚构金额。 */
  const dailyCost = new Map([[today, { cost: 2, currency: "CNY" }]]);
  const points = [...new Set(rows.map((item) => item.day))].filter((day) => day !== "older").sort()
    .map((day) => ({ day, cost: dailyCost.get(day)?.cost ?? 0 }));
  assert.deepEqual(points, [{ day: today, cost: 2 }]); /* 只含账本覆盖段费用 */
});

test("aggregateByTime：余量落超窗 updatedAt → 「更早」桶（窗口行为不变）", () => {
  const now = Date.now();
  const old = now - 400 * 86_400_000;
  const expanded = expandRows([row({ id: "aging", updatedAt: old }), row({ id: "new", updatedAt: now })]);
  const remainders = new Map([["aging", bucketRow(470, 0, 0, 0)]]);
  const rows = aggregateByTime(expanded, new Map(), new Set(["aging"]), { remainders });
  assert.equal(rows[0].day, "older");
  assert.equal(rows[0].source, "recent");
  assert.equal(totalTokens(rows[0].buckets), 470);
  assert.equal(rows.length, 2);
});

/* ---------------------------------------------------------------- *
 * 一致性断言（fix-partial-coverage 1.5，验收核心）：
 * 覆盖 / 部分覆盖 / 未覆盖 / 含老化桶 / fork 混合，投影全部在场、无孤儿——
 * 趋势行合计（含「更早」）≡ 投影合计 − fork 投影 ≡ KPI token 合计。
 * ---------------------------------------------------------------- */

test("一致性断言：趋势行合计（含「更早」）≡ 投影合计 − fork 投影（混合人群）", () => {
  const now = Date.now();
  const dayOf = (offset) => dayKeyOf(now - offset * 86_400_000);
  const projection = usage(100, 300, 20, 50); /* 四桶总量 470 */
  const expanded = expandRows([
    row({ id: "s-full", updatedAt: now, projectionValues: { tokenUsage: projection } }),
    row({ id: "s-partial", updatedAt: now, projectionValues: { tokenUsage: projection } }),
    row({ id: "s-uncovered", updatedAt: now - 400 * 86_400_000, projectionValues: { tokenUsage: projection } }),
    row({ id: "s-aging", updatedAt: now, projectionValues: { tokenUsage: projection } }),
    row({ id: "s-parent", updatedAt: now, projectionValues: { tokenUsage: projection } }),
    row({ id: "s-fork", parentId: "s-parent", updatedAt: now, projectionValues: { tokenUsage: projection } })
  ]);
  /* dailyBucketsBySession：s-full 全覆盖、s-partial 部分（逐桶 270/470）、
     s-aging 仅老化桶（全零占位）；s-uncovered/s-fork 无键；s-parent 覆盖段在
     ledgerDaily。s-partial 的覆盖段逐桶一致（投影的子集）。 */
  const dailyBucketsBySession = new Map([
    ["s-full", bucketRow(100, 300, 20, 50)],
    ["s-partial", bucketRow(100, 150, 0, 20)],
    ["s-aging", bucketRow(0, 0, 0, 0)],
    ["s-parent", bucketRow(100, 300, 20, 50)]
  ]);
  const ledgerDaily = new Map([
    [dayOf(1), { buckets: bucketRow(100, 300, 20, 50) }], /* s-full 覆盖段 */
    [dayOf(2), { buckets: bucketRow(100, 150, 0, 20) }], /* s-partial 覆盖段 */
    [dayOf(3), { buckets: bucketRow(100, 300, 20, 50) }] /* s-parent 覆盖段 */
  ]);
  const coveredIds = new Set(dailyBucketsBySession.keys());
  const remainders = computeTrendRemainders(expanded, dailyBucketsBySession);
  assert.deepEqual(remainders.get("s-partial"), bucketRow(0, 150, 20, 30)); /* 部分覆盖余量 200 */
  assert.deepEqual(remainders.get("s-aging"), bucketRow(100, 300, 20, 50)); /* 老化段余量 */
  assert.equal(remainders.has("s-full"), false);
  assert.equal(remainders.has("s-uncovered"), false);
  assert.equal(remainders.has("s-fork"), false);
  const trendRows = aggregateByTime(expanded, ledgerDaily, coveredIds, { remainders });
  const trendTotal = trendRows.reduce((sum, item) => sum + item.total, 0); /* 含「更早」 */
  const projectionTotal = expanded.reduce((sum, item) => sum + (item.isFork ? 0 : totalTokens(item.usage)), 0);
  const kpi = aggregateKpi(expanded, [], null);
  assert.equal(projectionTotal, 5 * 470); /* 5 个非 fork 会话 */
  assert.equal(kpi.billedTotal, projectionTotal); /* KPI 同值 */
  assert.equal(trendTotal, projectionTotal); /* 趋势（含「更早」）同值——缺陷指纹断言 */
  /* 超窗的未覆盖会话落「更早」，老会话不再从趋势中消失。 */
  assert.equal(trendRows.some((item) => item.day === "older" && totalTokens(item.buckets) === 470), true);
  /* 颗粒度升档（年，无窗口）恒等依旧成立。 */
  const yearRows = aggregateByTime(expanded, ledgerDaily, coveredIds, { remainders, granularity: "year" });
  assert.equal(yearRows.reduce((sum, item) => sum + item.total, 0), projectionTotal);
});

/* ---------------------------------------------------------------- *
 * hide-trend-older-bar：数据层行为锁定（过滤只在展示层，产物不变）
 * ---------------------------------------------------------------- */

test("aggregateByTime：超窗折叠产出「更早」行并 unshift 首位；「更早」全零不入", () => {
  const now = Date.now();
  const today = dayKeyOf(now);
  const oldDay = dayKeyOf(now - 400 * 86_400_000); /* 必超 30 天窗口 */
  const expanded = expandRows([row({ id: "a", updatedAt: now })]);
  const coveredIds = new Set(["a"]); /* 覆盖段按步归日，updatedAt 路径跳过 */
  const ledgerDaily = new Map([
    [oldDay, { buckets: bucketRow(1000, 0, 0, 0) }],
    [today, { buckets: bucketRow(7, 0, 0, 0) }]
  ]);
  const rows = aggregateByTime(expanded, ledgerDaily, coveredIds);
  /* 超窗桶折叠为唯一「更早」行，unshift 到数组首位（渲染为最左柱）。 */
  assert.deepEqual(rows.map((item) => item.day), ["older", today]);
  assert.equal(rows[0].source, "ledger");
  assert.equal(totalTokens(rows[0].buckets), 1000);
  /* 全零：「更早」合计为零时不产生该行（全零不入规则）。 */
  const zeroLedger = new Map([
    [oldDay, { buckets: bucketRow(0, 0, 0, 0) }],
    [today, { buckets: bucketRow(7, 0, 0, 0) }]
  ]);
  const noOlder = aggregateByTime(expanded, zeroLedger, coveredIds);
  assert.equal(noOlder.some((item) => item.day === "older"), false);
  assert.deepEqual(noOlder.map((item) => item.day), [today]);
});

/* ---------------------------------------------------------------- *
 * hide-trend-older-bar：展示层过滤 chartTrendRows
 * ---------------------------------------------------------------- */

test("chartTrendRows：含「更早」且窗口内有桶 → 剔除该行、桶序不变、数据层原集不动", () => {
  const rows = [
    { day: "older", buckets: bucketRow(999), total: 999, source: "ledger" },
    { day: "2026-09-01", buckets: bucketRow(10), total: 10, source: "ledger" },
    { day: "2026-09-02", buckets: bucketRow(20), total: 20, source: "recent" }
  ];
  const chartRows = chartTrendRows(rows);
  assert.deepEqual(chartRows.map((item) => item.day), ["2026-09-01", "2026-09-02"]);
  assert.equal(chartRows.some((item) => item.day === "older"), false);
  /* 纯函数：数据层原集（替代表格/双口径判定的输入）不被改动。 */
  assert.equal(rows.length, 3);
  assert.equal(rows[0].day, "older");
});

test("chartTrendRows：仅含「更早」行 → 原样返回（保留唯一柱，整图不消失）", () => {
  const rows = [{ day: "older", buckets: bucketRow(470), total: 470, source: "recent" }];
  const chartRows = chartTrendRows(rows);
  assert.equal(chartRows.length, 1);
  assert.equal(chartRows[0].day, "older");
  assert.equal(chartRows[0].total, 470);
});

test("chartTrendRows：空集进出皆空（无任何入桶消耗维持既有空态）", () => {
  assert.deepEqual(chartTrendRows([]), []);
  assert.deepEqual(chartTrendRows(null), []);
  assert.deepEqual(chartTrendRows(void 0), []);
});

test("chartTrendRows：无「更早」的行集逐值等价返回", () => {
  const rows = [
    { day: "2026-09", buckets: bucketRow(10), total: 10, source: "ledger" },
    { day: "2026-10", buckets: bucketRow(20), total: 20, source: "mixed" }
  ];
  assert.deepEqual(chartTrendRows(rows), rows);
});
