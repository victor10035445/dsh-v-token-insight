/**
 * dsh-v-token-insight — 修复风暴回归测试（fix-ledger-storm）。
 *
 * 固化的不变量：
 *  1. 「老化 → 全量重放 → 再老化」循环任意次，会话 token/步数/账面价恒 1×——
 *     深补/重建清桶前置 + upsert 二次入桶守卫共同封死乘法路径；
 *  2. upsert 守卫：会话已有桶时，出保留窗的新键被跳过（其内容已在桶中）；
 *     无桶（首次入账）与保留窗内的新步照收；
 *  3. clearSessionBuckets：清桶 + 清失效定价；缺席/已空如实返回 false；
 *  4. 趋势对账：老化桶按聚合日入柱 views.daily（与费用线同基），
 *     循环重放后趋势值恒 1×。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  aggregateLedgerViews,
  clearSessionBuckets,
  emptyLedger,
  loadLedger,
  persistLedger,
  priceArtifactOf,
  upsertSessionEntries
} from "../src/ledger.mjs";

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key)
  };
}

const usage = (input = 0, cacheRead = 0, cacheWrite = 0, output = 0) => ({
  inputTokens: input,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
  outputTokens: output
});
const step = (idx, over = {}) => ({
  step: idx,
  provider: "deepseek",
  model: "deepseek-chat",
  usage: over.usage ?? usage(1_000_000, 0, 0, 0),
  time: over.time,
  startTime: over.startTime === void 0 ? over.time : over.startTime
});
const turnRow = (turn, steps) => ({ turn, steps });

const TABLE = [{ model: "deepseek-chat", provider: "", currency: "CNY", unit: "MTok", defaultTier: { input: 2, cacheRead: 0.2, cacheWrite: 0, output: 3 }, tiers: [], timeWindows: [], discount: 1 }];

/** 风暴循环模拟：ingest → persist（老化）→ [清桶重放 → persist] ×N。 */
function stormLoop({ rounds }) {
  const storage = fakeStorage();
  const ledger = emptyLedger();
  const now = Date.now();
  const old = now - 10 * 86_400_000;
  const rows = [turnRow(1, [step(0, { time: old }), step(1, { time: old }), step(2, { time: old })])];
  const snap = () => {
    const s = ledger.sessions["s1"];
    return {
      entries: s.entries.length,
      buckets: s.buckets.length,
      n: s.buckets.reduce((sum, b) => sum + b.n, 0),
      tokens: s.buckets.reduce((sum, b) => sum + b.u.inputTokens, 0),
      cost: s.pricing?.cost ?? null
    };
  };
  upsertSessionEntries(ledger, "s1", rows, { nowMs: now });
  persistLedger(storage, ledger, { nowMs: now, activeIds: ["s1"], table: TABLE });
  const baseline = snap();
  const trendSnapshots = [];
  for (let i = 0; i < rounds; i++) {
    /* 深补全量重放（非截断）＝ clearSessionBuckets + 同一 rows 再次 upsert。 */
    clearSessionBuckets(ledger, "s1");
    upsertSessionEntries(ledger, "s1", rows, { nowMs: now });
    persistLedger(storage, ledger, { nowMs: now, activeIds: ["s1"], table: TABLE });
    const views = aggregateLedgerViews(ledger, TABLE, []);
    trendSnapshots.push(views.daily.get(bucketDay(now, old))?.buckets.inputTokens ?? 0);
  }
  return { baseline, final: snap(), trendSnapshots, oldDay: bucketDay(now, old) };
}

/** 与 dayKeyOf 同式的内联日键（测试独立于被测模块内部实现）。 */
function bucketDay(now, old) {
  const date = new Date(old);
  void now;
  const pad = (v) => String(v).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

test("风暴回归：老化→清桶重放→再老化循环 ×3，步数/token/账面价恒 1×", () => {
  const { baseline, final, trendSnapshots } = stormLoop({ rounds: 3 });
  /* 1× 基线：3 步 × 1M input，老化成 1 个桶（3 步同日同模型同窗口）。 */
  assert.equal(baseline.entries, 0);
  assert.equal(baseline.n, 3);
  assert.equal(baseline.tokens, 3_000_000);
  assert.equal(baseline.cost, 6); /* 3M input × ¥2/MTok */
  /* 循环 3 轮后仍恒 1×：乘法路径被清桶前置 + 守卫封死。 */
  assert.deepEqual(final, baseline);
  for (const trendTokens of trendSnapshots) {
    assert.equal(trendTokens, 3_000_000); /* 趋势（含桶日）恒 1× */
  }
});

test("风暴回归：不清桶的截断式部分重放由守卫拦截，同样不增长", () => {
  const storage = fakeStorage();
  const ledger = emptyLedger();
  const now = Date.now();
  const old = now - 10 * 86_400_000;
  const rows = [turnRow(1, [step(0, { time: old }), step(1, { time: old })])];
  upsertSessionEntries(ledger, "s1", rows, { nowMs: now });
  persistLedger(storage, ledger, { nowMs: now, activeIds: ["s1"], table: TABLE });
  const nBefore = ledger.sessions.s1.buckets.reduce((sum, b) => sum + b.n, 0);
  /* 截断深补：不清桶直接重放（模拟 truncated 路径）→ 守卫拦下出窗旧键。 */
  const changed = upsertSessionEntries(ledger, "s1", rows, { nowMs: now });
  assert.equal(changed, 0); /* 旧键已随老化入桶：跳过 */
  assert.equal(ledger.sessions.s1.entries.length, 0);
  persistLedger(storage, ledger, { nowMs: now, activeIds: ["s1"], table: TABLE });
  assert.equal(ledger.sessions.s1.buckets.reduce((sum, b) => sum + b.n, 0), nBefore);
});

test("upsert 守卫：有桶时出窗新键跳过；无桶（首次入账）照收；窗内新步照收", () => {
  const storage = fakeStorage();
  const ledger = emptyLedger();
  const now = Date.now();
  const old = now - 10 * 86_400_000;
  /* 无桶：旧步首次入账照收（内容尚无任何表示）。 */
  const changedFirst = upsertSessionEntries(ledger, "s1", [turnRow(1, [step(0, { time: old })])], { nowMs: now });
  assert.equal(changedFirst, 1);
  persistLedger(storage, ledger, { nowMs: now, activeIds: ["s1"] }); /* 老化成桶 */
  /* 有桶：另一出窗旧键跳过（同日内容已在桶中）。 */
  const changedOld = upsertSessionEntries(ledger, "s1", [turnRow(2, [step(0, { time: old })])], { nowMs: now });
  assert.equal(changedOld, 0);
  /* 有桶：保留窗内的新步照收（今日内容不在任何桶中）。 */
  const changedFresh = upsertSessionEntries(ledger, "s1", [turnRow(3, [step(0, { time: now, startTime: now })])], { nowMs: now });
  assert.equal(changedFresh, 1);
  assert.equal(ledger.sessions.s1.entries.length, 1); /* 仅今日步在条目中 */
});

test("clearSessionBuckets：清桶并使定价失效；缺席/已空返回 false", () => {
  const ledger = emptyLedger();
  const now = Date.now();
  const old = now - 10 * 86_400_000;
  upsertSessionEntries(ledger, "s1", [turnRow(1, [step(0, { time: old })])], { nowMs: now });
  const storage = fakeStorage();
  persistLedger(storage, ledger, { nowMs: now, activeIds: ["s1"], table: TABLE });
  assert.ok(ledger.sessions.s1.buckets.length > 0);
  assert.ok(ledger.sessions.s1.pricing);
  assert.equal(clearSessionBuckets(ledger, "s1"), true);
  assert.equal(ledger.sessions.s1.buckets.length, 0);
  assert.equal(ledger.sessions.s1.pricing, void 0); /* 桶费用已失效 */
  assert.equal(clearSessionBuckets(ledger, "s1"), false); /* 已空 */
  assert.equal(clearSessionBuckets(ledger, "missing"), false); /* 缺席 */
  /* 清桶后重放：旧条目照收（守卫解除）→ 老化回 1×。 */
  upsertSessionEntries(ledger, "s1", [turnRow(1, [step(0, { time: old })])], { nowMs: now });
  persistLedger(storage, ledger, { nowMs: now, activeIds: ["s1"], table: TABLE });
  assert.equal(ledger.sessions.s1.buckets.reduce((sum, b) => sum + b.n, 0), 1);
});

test("守卫与账面价协同：重放循环后 priceArtifactOf 恒 1×，落盘往返一致", () => {
  const storage = fakeStorage();
  const ledger = emptyLedger();
  const now = Date.now();
  const old = now - 10 * 86_400_000;
  const rows = [turnRow(1, [step(0, { time: old }), step(1, { time: old })])];
  upsertSessionEntries(ledger, "s1", rows, { nowMs: now });
  persistLedger(storage, ledger, { nowMs: now, activeIds: ["s1"], table: TABLE });
  const cost1x = priceArtifactOf(ledger, "s1", TABLE, null).priced.cost;
  assert.equal(cost1x, 4); /* 2M input × ¥2/MTok */
  for (let i = 0; i < 2; i++) {
    clearSessionBuckets(ledger, "s1");
    upsertSessionEntries(ledger, "s1", rows, { nowMs: now });
    persistLedger(storage, ledger, { nowMs: now, activeIds: ["s1"], table: TABLE });
    assert.equal(priceArtifactOf(ledger, "s1", TABLE, null).priced.cost, cost1x);
  }
  assert.deepEqual(loadLedger(storage), ledger); /* 落盘往返逐值一致 */
});
