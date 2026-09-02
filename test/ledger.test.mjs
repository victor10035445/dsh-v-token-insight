/**
 * dsh-token-insight — ledger.mjs 单测（tasks 4.1 / 7.2）。
 * 覆盖：幂等沉淀（last-wins / 重试取终值）、窗口完备性合并（含 null 语义）、
 * 深补覆盖区间与截断标注、损坏回退、压缩老化按「日 × 模型 × 折扣窗口命中」
 * 分桶（L3 语义保留）、孤儿 GC 宽限期、手动清除、配额兜底 persistLedger、
 * 费用部分覆盖口径（priceLedgerSession / priceDailyCost）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  LEDGER_ORPHAN_GRACE_DAYS,
  LEDGER_RAW_RETENTION_DAYS_TIGHT,
  aggregateLedgerViews,
  ageLedger,
  clearAllLedger,
  clearSessionLedger,
  emptyLedger,
  isPartialCoverage,
  loadLedger,
  persistLedger,
  priceDailyCost,
  priceLedgerSession,
  recordDeepCoverage,
  saveLedger,
  upsertSessionEntries
} from "../src/ledger.mjs";
import { DEFAULT_PRICE_TABLE, bucketSetCost, stepCost } from "../src/pricing.mjs";
import { foldHistoryEvents } from "../src/stats-fold.mjs";
import { dayKeyOf } from "../src/rows-aggregate.mjs";

/** fake storage（可注入故障）。 */
function fakeStorage({ failSet = false } = {}) {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      if (failSet) throw new Error("quota exceeded");
      map.set(key, value);
    },
    removeItem: (key) => map.delete(key)
  };
}

const usage = (input = 0, cacheRead = 0, cacheWrite = 0, output = 0) => ({
  inputTokens: input,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
  outputTokens: output
});

/** 折叠行构造（与 foldTurns 产物同形的最小形状）。 */
const step = (idx, over = {}) => ({
  step: idx,
  provider: over.provider ?? "deepseek",
  model: over.model ?? "deepseek-chat",
  usage: over.usage === void 0 ? usage(100, 50, 0, 20) : over.usage,
  time: over.time ?? 1_700_000_000_000,
  startTime: over.startTime ?? null
});
const turnRow = (turn, steps, over = {}) => ({ turn, steps, ...over });

/* ---------------------------------------------------------------- *
 * 沉淀：幂等 upsert / last-wins / 无变化不计数
 * ---------------------------------------------------------------- */

test("upsertSessionEntries：幂等——同键完全相同不计变更", () => {
  const ledger = emptyLedger();
  const rows = [turnRow(1, [step(0)])];
  assert.equal(upsertSessionEntries(ledger, "s1", rows, { nowMs: 100 }), 1);
  assert.equal(upsertSessionEntries(ledger, "s1", rows, { nowMs: 200 }), 0);
  assert.equal(ledger.sessions.s1.entries.length, 1);
  assert.equal(ledger.sessions.s1.lastSeen, 200);
});

test("upsertSessionEntries：last-wins——重试后同键覆盖为终值", () => {
  const ledger = emptyLedger();
  upsertSessionEntries(ledger, "s1", [turnRow(1, [step(0, { usage: usage(10) })])], { nowMs: 1 });
  upsertSessionEntries(ledger, "s1", [turnRow(1, [step(0, { usage: usage(99) })])], { nowMs: 2 });
  assert.equal(ledger.sessions.s1.entries[0].u.inputTokens, 99);
  assert.equal(ledger.sessions.s1.entries.length, 1);
});

test("upsertSessionEntries：无 usage / 全零步不记账；键按 (turn, step) 升序", () => {
  const ledger = emptyLedger();
  upsertSessionEntries(ledger, "s1", [
    turnRow(2, [step(0)]),
    turnRow(1, [step(1), step(0, { usage: usage(0, 0, 0, 0) }), step(2, { usage: null })])
  ], { nowMs: 1 });
  assert.deepEqual(ledger.sessions.s1.entries.map((entry) => entry.k), ["1:1", "2:0"]);
});

test("upsertSessionEntries：窗口完备性 AND 合并；null 不改动标注", () => {
  const ledger = emptyLedger();
  upsertSessionEntries(ledger, "s1", [turnRow(1, [step(0)])], { windowFull: false, nowMs: 1 });
  assert.equal(ledger.sessions.s1.coverage.windowFull, false);
  upsertSessionEntries(ledger, "s1", [turnRow(2, [step(0)])], { windowFull: null, nowMs: 2 });
  assert.equal(ledger.sessions.s1.coverage.windowFull, false);
  const ledger2 = emptyLedger();
  upsertSessionEntries(ledger2, "s2", [turnRow(1, [step(0)])], { windowFull: true, nowMs: 1 });
  assert.equal(ledger2.sessions.s2.coverage.windowFull, true);
});

test("recordDeepCoverage：seq 区间取并集；未截断置满覆盖", () => {
  const ledger = emptyLedger();
  recordDeepCoverage(ledger, "s1", { fromSeq: 50, toSeq: 100, truncated: true }, { nowMs: 1 });
  assert.equal(ledger.sessions.s1.coverage.deepFromSeq, 50);
  assert.equal(ledger.sessions.s1.coverage.deepToSeq, 100);
  assert.equal(ledger.sessions.s1.coverage.deepTruncated, true);
  recordDeepCoverage(ledger, "s1", { fromSeq: 10, toSeq: 300, truncated: false }, { nowMs: 2 });
  assert.equal(ledger.sessions.s1.coverage.deepFromSeq, 10);
  assert.equal(ledger.sessions.s1.coverage.deepToSeq, 300);
  assert.equal(ledger.sessions.s1.coverage.deepTruncated, true); /* 截断史保留 */
  assert.equal(ledger.sessions.s1.coverage.windowFull, true); /* 全量深补 = 全覆盖 */
});

/* ---------------------------------------------------------------- *
 * 持久化：损坏回退 / 配额兜底 / 清除
 * ---------------------------------------------------------------- */

test("loadLedger：损坏 JSON / 非法结构回退空账本，不抛错", () => {
  const storage = fakeStorage();
  storage.setItem("dsh-token-insight.ledger.v1", "{not json");
  assert.deepEqual(loadLedger(storage), emptyLedger());
  storage.setItem("dsh-token-insight.ledger.v1", JSON.stringify({ v: 2 }));
  assert.deepEqual(loadLedger(storage), emptyLedger());
  storage.setItem("dsh-token-insight.ledger.v1", JSON.stringify({ v: 1, sessions: { s: { entries: [{ k: "bogus", u: {} }], buckets: [], lastSeen: 1 } } }));
  const ledger = loadLedger(storage);
  /* 非法条目被净化掉；仅剩 lastSeen 的会话保留（孤儿 GC 的在册标记）。 */
  assert.equal(Object.keys(ledger.sessions).length, 1);
  assert.equal(ledger.sessions.s.entries.length, 0);
  assert.equal(ledger.sessions.s.buckets.length, 0);
});

test("loadLedger/saveLedger：合法数据往返", () => {
  const storage = fakeStorage();
  const ledger = emptyLedger();
  upsertSessionEntries(ledger, "s1", [turnRow(1, [step(0)])], { nowMs: 5 });
  assert.equal(saveLedger(storage, ledger), true);
  const loaded = loadLedger(storage);
  assert.equal(loaded.sessions.s1.entries[0].k, "1:0");
});

test("persistLedger：配额失败自动收紧老化重试一次", () => {
  const storage = fakeStorage({ failSet: false });
  storage.setItem = () => {
    throw new Error("quota");
  };
  const ledger = emptyLedger();
  const old = Date.now() - (LEDGER_RAW_RETENTION_DAYS_TIGHT + 5) * 86_400_000;
  upsertSessionEntries(ledger, "s1", [turnRow(1, [step(0, { time: old })])], { nowMs: Date.now() });
  const result = persistLedger(storage, ledger, { nowMs: Date.now(), activeIds: ["s1"] });
  assert.equal(result.ok, false);
  assert.equal(result.aged, true);
  /* 收紧老化已把陈旧原始步卷为桶（内存内），条目数为 0 */
  assert.equal(ledger.sessions.s1.entries.length, 0);
  assert.equal(ledger.sessions.s1.buckets.length, 1);
});

test("clearSessionLedger / clearAllLedger", () => {
  const ledger = emptyLedger();
  upsertSessionEntries(ledger, "a", [turnRow(1, [step(0)])], { nowMs: 1 });
  upsertSessionEntries(ledger, "b", [turnRow(1, [step(0)])], { nowMs: 1 });
  assert.equal(clearSessionLedger(ledger, "a"), true);
  assert.equal(clearSessionLedger(ledger, "a"), false);
  clearAllLedger(ledger);
  assert.equal(Object.keys(ledger.sessions).length, 0);
});

/* ---------------------------------------------------------------- *
 * 压缩老化：日 × 模型 × 折扣窗口命中
 * ---------------------------------------------------------------- */

test("ageLedger：陈旧步卷为聚合桶，保留日/模型/窗口命中与 L3 系数语义", () => {
  const ledger = emptyLedger();
  const table = [
    {
      model: "deepseek-chat",
      provider: "",
      currency: "CNY",
      unit: "MTok",
      defaultTier: { input: 2, cacheRead: 0.2, cacheWrite: 0, output: 3 },
      tiers: [],
      timeWindows: [{ from: "23:00", to: "08:30", multiplier: 0.5 }],
      discount: 1
    }
  ];
  /* 23:30 的一步（命中折扣窗口）与 12:00 的一步（未命中）：同日不同窗口 → 两桶 */
  const lateNight = new Date(); lateNight.setHours(23, 30, 0, 0);
  const noon = new Date(); noon.setHours(12, 0, 0, 0);
  upsertSessionEntries(ledger, "s1", [
    turnRow(1, [step(0, { time: lateNight.getTime(), startTime: lateNight.getTime() }), step(1, { time: noon.getTime(), startTime: noon.getTime() })])
  ], { nowMs: Date.now() });
  const { collapsed, gcSessions } = ageLedger(ledger, { nowMs: Date.now() + 100 * 86_400_000, table, activeIds: ["s1"] });
  assert.equal(collapsed, 2);
  assert.equal(gcSessions, 0);
  assert.equal(ledger.sessions.s1.entries.length, 0);
  const buckets = ledger.sessions.s1.buckets;
  assert.equal(buckets.length, 2);
  const night = buckets.find((bucket) => bucket.w !== null);
  const day = buckets.find((bucket) => bucket.w === null);
  assert.ok(night && day);
  assert.equal(night.w.from, "23:00");
  assert.equal(night.w.to, "08:30");
  /* 老化桶计费 = defaultTier × 窗口系数：夜晚桶恰为白天桶的一半（单价同、token 同） */
  const nightCost = bucketSetCost(table[0], night.u, { win: night.w }).cost;
  const dayCost = bucketSetCost(table[0], day.u, { win: null }).cost;
  assert.equal(Math.round(nightCost * 1e6), Math.round(dayCost * 0.5 * 1e6));
});

test("ageLedger：孤儿 GC——不在列表且超宽限期才清理", () => {
  const ledger = emptyLedger();
  const now = Date.now();
  upsertSessionEntries(ledger, "fresh", [turnRow(1, [step(0)])], { nowMs: now });
  upsertSessionEntries(ledger, "stale", [turnRow(1, [step(0)])], { nowMs: now - (LEDGER_ORPHAN_GRACE_DAYS + 2) * 86_400_000 });
  upsertSessionEntries(ledger, "listed", [turnRow(1, [step(0)])], { nowMs: now - (LEDGER_ORPHAN_GRACE_DAYS + 2) * 86_400_000 });
  const { gcSessions } = ageLedger(ledger, { nowMs: now, activeIds: ["listed"] });
  assert.equal(gcSessions, 1);
  assert.ok(ledger.sessions.fresh !== void 0); /* 不在列表但宽限期内：保留 */
  assert.equal(ledger.sessions.stale, void 0); /* 不在列表且超期：清理 */
  assert.ok(ledger.sessions.listed !== void 0); /* 在列表：永不 GC */
});

test("ageLedger：宽限期内的不在册会话保留", () => {
  const ledger = emptyLedger();
  const now = Date.now();
  upsertSessionEntries(ledger, "gone", [turnRow(1, [step(0)])], { nowMs: now - 86_400_000 });
  ageLedger(ledger, { nowMs: now, activeIds: [] });
  assert.ok(ledger.sessions.gone !== void 0);
});

/* ---------------------------------------------------------------- *
 * 费用：逐步 + 部分覆盖口径
 * ---------------------------------------------------------------- */

test("priceLedgerSession：无覆盖 → covered=false；全覆盖 → 逐步合计", () => {
  const ledger = emptyLedger();
  const none = priceLedgerSession(ledger, "missing", DEFAULT_PRICE_TABLE);
  assert.equal(none.covered, false);
  upsertSessionEntries(ledger, "s1", [
    turnRow(1, [step(0, { usage: usage(1_000_000, 0, 0, 0), time: 1_700_000_000_000 })]),
    turnRow(2, [step(0, { usage: usage(0, 0, 0, 1_000_000), time: 1_700_090_000_000 })])
  ], { nowMs: 1 });
  const priced = priceLedgerSession(ledger, "s1", DEFAULT_PRICE_TABLE);
  assert.equal(priced.covered, true);
  assert.equal(priced.cost, 2 + 3); /* deepseek-chat 默认档：输入 ¥2/MTok、输出 ¥3/MTok */
  assert.equal(priced.currency, "CNY");
});

test("priceLedgerSession：未定价模型 → cost=null + 原因（不猜价）", () => {
  const ledger = emptyLedger();
  upsertSessionEntries(ledger, "s1", [turnRow(1, [step(0, { model: "unknown-model" })])], { nowMs: 1 });
  const priced = priceLedgerSession(ledger, "s1", DEFAULT_PRICE_TABLE);
  assert.equal(priced.covered, true);
  assert.equal(priced.cost, null);
  assert.ok(priced.unmatched.some((reason) => reason.includes("unknown-model")));
});

test("priceLedgerSession：老化桶参与计费（defaultTier + 窗口系数）", () => {
  const ledger = emptyLedger();
  const noon = new Date(); noon.setHours(12, 0, 0, 0);
  upsertSessionEntries(ledger, "s1", [turnRow(1, [step(0, { usage: usage(2_000_000, 0, 0, 0), time: noon.getTime(), startTime: noon.getTime() })])], { nowMs: noon.getTime() });
  ageLedger(ledger, { nowMs: noon.getTime() + 100 * 86_400_000, table: DEFAULT_PRICE_TABLE, activeIds: ["s1"] });
  const priced = priceLedgerSession(ledger, "s1", DEFAULT_PRICE_TABLE);
  assert.equal(priced.covered, true);
  assert.equal(priced.cost, 4); /* 2MTok × ¥2/MTok */
});

test("priceDailyCost：逐步费用按发生时刻分日归桶", () => {
  const ledger = emptyLedger();
  const day1 = new Date(2026, 0, 10, 9, 0, 0).getTime();
  const day2 = new Date(2026, 0, 11, 9, 0, 0).getTime();
  upsertSessionEntries(ledger, "s1", [
    turnRow(1, [step(0, { usage: usage(1_000_000, 0, 0, 0), time: day1, startTime: day1 })]),
    turnRow(2, [step(0, { usage: usage(0, 0, 0, 1_000_000), time: day2, startTime: day2 })])
  ], { nowMs: 1 });
  const daily = priceDailyCost(ledger, DEFAULT_PRICE_TABLE);
  assert.equal(daily.size, 2);
  assert.equal(daily.get(dayKeyOf(day1)).cost, 2);
  assert.equal(daily.get(dayKeyOf(day2)).cost, 3);
});

test("aggregateLedgerViews：byModel 聚合 + 「未分类」= Tier0 − 账本覆盖", () => {
  const ledger = emptyLedger();
  upsertSessionEntries(ledger, "s1", [turnRow(1, [step(0, { usage: usage(100, 0, 0, 0) })])], { nowMs: 1 });
  const expanded = [
    { id: "s1", usage: { inputTokens: 150, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, hasUsage: true },
    { id: "s2", usage: { inputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, hasUsage: true }
  ];
  const views = aggregateLedgerViews(ledger, DEFAULT_PRICE_TABLE, expanded);
  assert.deepEqual([...views.coveredIds], ["s1"]);
  const classified = views.byModel.find((row) => row.model === "deepseek-chat");
  assert.equal(classified.total, 100);
  const unclassified = views.byModel.find((row) => row.model === null);
  assert.equal(unclassified.total, 50 + 60); /* s1 余量 50 + s2 全量 60 */
});

test("isPartialCoverage：窗口未满载 / 深补截断 → 部分", () => {
  assert.equal(isPartialCoverage({ windowFull: false }), true);
  assert.equal(isPartialCoverage({ windowFull: true, deepTruncated: true }), true);
  assert.equal(isPartialCoverage({ windowFull: true, deepTruncated: false }), false);
  assert.equal(isPartialCoverage({}), false);
});

/* ---------------------------------------------------------------- *
 * foldHistoryEvents：深补离线折算（双载体口径）
 * ---------------------------------------------------------------- */

test("foldHistoryEvents：chunk-usage 与 message 双载体 last-wins + source 接续", () => {
  const events = [
    { type: "step/start", seq: 1, time: 1000, data: { turn: 1, step: 0 } },
    { type: "assistant/chunk", seq: 2, time: 1100, data: { turn: 1, step: 0, chunk: { type: "usage", usage: usage(10, 0, 0, 2) } } },
    { type: "assistant/message", seq: 3, time: 1200, data: { turn: 1, step: 0, usage: usage(10, 0, 0, 20), message: { source: { provider: "deepseek", model: "deepseek-chat" } } } },
    { type: "assistant/chunk", seq: 4, time: 1300, data: { turn: 1, step: 1, chunk: { type: "usage", usage: usage(5, 0, 0, 1) } } }
  ];
  const folded = foldHistoryEvents([events.map((event) => ({ event }))]);
  assert.equal(folded.fromSeq, 1);
  assert.equal(folded.toSeq, 4);
  assert.equal(folded.rows.length, 1);
  const [first, second] = folded.rows[0].steps;
  assert.equal(first.usage.outputTokens, 20); /* message 为最终样本（覆盖 chunk interim） */
  assert.equal(first.model, "deepseek-chat");
  assert.equal(first.startTime, 1000);
  assert.equal(second.model, "deepseek-chat"); /* chunk-only 步沿用同轮已知 source */
  assert.equal(second.usage.inputTokens, 5);
});

test("foldHistoryEvents：乱序输入按 seq 重放", () => {
  const events = [
    { type: "assistant/message", seq: 3, time: 1200, data: { turn: 1, step: 0, usage: usage(9, 0, 0, 0), message: { source: { provider: "p", model: "m" } } } },
    { type: "assistant/chunk", seq: 2, time: 1100, data: { turn: 1, step: 0, chunk: { type: "usage", usage: usage(1, 0, 0, 0) } } }
  ];
  const folded = foldHistoryEvents([[{ event: events[0] }], [{ event: events[1] }]]);
  assert.equal(folded.rows[0].steps[0].usage.inputTokens, 9);
});

test("stepCost 回归确认（老化桶对照基准）", () => {
  const entry = DEFAULT_PRICE_TABLE[0];
  const result = stepCost(entry, usage(1_000_000, 0, 0, 0), { time: 1_700_000_000_000 });
  assert.equal(result.cost, 2);
});
