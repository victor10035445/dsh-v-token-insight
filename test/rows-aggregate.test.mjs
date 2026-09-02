/**
 * dsh-token-insight — rows-aggregate.mjs 单测（tasks 3.1 / 7.2）。
 * 覆盖：cwd 归组与「未知」、子会话独立成行 + 父 cwd 回退、归档交集、
 * blank 排除、投影缺席降级（零计入 / 全缺席「—」）、命中率、时间分桶双口径、
 * 归档数据面缺失守卫、depth 计算。
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
  assert.equal(projectNameOf("F:\\project\\dsh-token-insight"), "dsh-token-insight");
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
    row({ id: "c", parentId: "p" })
  ]);
  const groups = aggregateWorkspaces(expanded, null);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, "beta");
  assert.equal(groups[0].sessions, 2);
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

test("archivedMissingFromList：归档集合非空但列表不携带 → 数据面缺失", () => {
  const expanded = expandRows([row({ id: "a" })]);
  assert.equal(archivedMissingFromList(expanded, ["ghost"]), true);
  assert.equal(archivedMissingFromList(expandRows([row({ id: "a" }), row({ id: "g" })]), ["g"]), false);
  assert.equal(archivedMissingFromList(expanded, []), false);
});
