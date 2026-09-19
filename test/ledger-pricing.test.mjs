/**
 * dsh-v-token-insight — ledger-recorded-pricing 单测（tasks 4.1–4.4）。
 * 覆盖：pricing 快照落盘往返（序列化/解析、损坏回退现算不抛错）、账面价稳定性
 * （价目编辑不波动、重算后随现行价、token 事实不变）、引擎版本标脏 / 价目指纹披露、
 * fp 记忆化、预算预检（常数上调 / 重算预检拒绝 / 水位阶梯含 pricing 收缩）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  LEDGER_ESTIMATE_INDEX_PER_SESSION_BYTES,
  LEDGER_SESSION_PREFIX_V2,
  PRICING_ENGINE_VERSION,
  aggregateLedgerViews,
  emptyLedger,
  ledgerSessionKeyV2,
  loadLedger,
  persistLedger,
  priceArtifactOf,
  priceDailyCost,
  priceTableFingerprint,
  pricingStatusOf,
  repriceLedgerAll,
  repriceLedgerBudgetCheck,
  repriceLedgerSession,
  saveLedger,
  upsertSessionEntries
} from "../src/ledger.mjs";
import { displayCurrencyOf, stepCost, DEFAULT_PRICE_TABLE } from "../src/pricing.mjs";

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
/* 近期时刻（避免持久化时的 2 天老化坍缩影响条目数断言）。 */
const RECENT = Date.now();
const step = (idx, over = {}) => ({
  step: idx,
  provider: over.provider ?? "deepseek",
  model: over.model ?? "deepseek-chat",
  usage: over.usage === void 0 ? usage(100, 50, 0, 20) : over.usage,
  time: over.time ?? RECENT,
  startTime: over.startTime ?? RECENT
});
const turnRow = (turn, steps) => ({ turn, steps });

const tableA = [{ model: "deepseek-chat", provider: "", currency: "CNY", unit: "MTok", defaultTier: { input: 2, cacheRead: 0.2, cacheWrite: 0, output: 3 }, tiers: [], timeWindows: [], discount: 1 }];
const tableB = [{ model: "deepseek-chat", provider: "", currency: "CNY", unit: "MTok", defaultTier: { input: 4, cacheRead: 0.4, cacheWrite: 0, output: 6 }, tiers: [], timeWindows: [], discount: 1 }];

/* ---------------------------------------------------------------- *
 * 4.1 落盘往返：pricing 快照随分片写入/读取逐值一致；解析失败回退现算不抛错
 * ---------------------------------------------------------------- */

test("4.1 pricing 落盘往返：persist 后分片携带 pricing，load 逐值一致；fp/ev/cur/cost/bm 正确", () => {
  const storage = fakeStorage();
  const ledger = emptyLedger();
  upsertSessionEntries(ledger, "s1", [turnRow(1, [step(0, { usage: usage(1_000_000, 0, 0, 0) })])], { nowMs: 100 });
  /* 以 tableA 落盘：dirty 会话快照账面价。 */
  persistLedger(storage, ledger, { table: tableA, activeIds: ["s1"], changedSids: ["s1"] });
  const shard = JSON.parse(storage.getItem(ledgerSessionKeyV2("s1")));
  assert.ok(shard.pricing, "分片携带 pricing 字段");
  assert.equal(shard.pricing.v, 1);
  assert.equal(shard.pricing.ev, PRICING_ENGINE_VERSION);
  assert.equal(shard.pricing.fp, priceTableFingerprint(tableA));
  assert.equal(shard.pricing.cur, displayCurrencyOf(tableA));
  assert.equal(shard.pricing.cost, 2); /* 1M 输入 × ¥2/MTok */
  assert.equal(shard.pricing.mc[shard.pricing.bm[0][0]], "deepseek-chat"); /* 模型名进字典 */
  /* 载入后 pricing 在册、展示读账面价（快照重建）。 */
  const loaded = loadLedger(storage);
  assert.ok(loaded.sessions.s1.pricing, "load 后 pricing 在册");
  const artifact = priceArtifactOf(loaded, "s1", tableB, null);
  assert.equal(artifact.priced.cost, 2); /* 账面价冻结：即使以 B 表读取仍回 2 */
  assert.equal(artifact.priced.currency, "CNY");
  assert.equal(artifact.priced.byModel.get("deepseek-chat").cost, 2);
  assert.equal(artifact.dailyCost.size, 1);
});

test("4.1 pricing 解析失败回退现算不抛错（损坏分片 pricing 被丢弃）", () => {
  const storage = fakeStorage();
  const ledger = emptyLedger();
  upsertSessionEntries(ledger, "s1", [turnRow(1, [step(0, { usage: usage(1_000_000, 0, 0, 0) })])], { nowMs: 100 });
  saveLedger(storage, ledger, null);
  /* 直接写入一个损坏的 pricing（v 非法 + fp 缺失）→ sanitizePricing 回 null。 */
  const key = ledgerSessionKeyV2("s1");
  const shard = JSON.parse(storage.getItem(key));
  shard.pricing = { v: 999, ev: "bogus", fp: "", cur: "", cost: "x" };
  storage.setItem(key, JSON.stringify(shard));
  storage.setItem("dsh-v-token-insight.ledger.v2.index", JSON.stringify({ v: 2, sessions: { s1: { lastSeen: 100, coverage: {} } } }));
  /* 无枚举面 fake：索引在册即可读取。 */
  const loaded = loadLedger(storage);
  assert.equal(loaded.sessions.s1.pricing, void 0, "损坏 pricing 被丢弃 → 按无 pricing 回退");
  const artifact = priceArtifactOf(loaded, "s1", tableB, null);
  assert.equal(artifact.priced.cost, 4); /* 回退现算：按当前表 B */
});

test("4.1 旧分片无 pricing（软迁移）→ 回退现算 + 下次持久化落盘", () => {
  const storage = fakeStorage();
  const ledger = emptyLedger();
  upsertSessionEntries(ledger, "s1", [turnRow(1, [step(0, { usage: usage(1_000_000, 0, 0, 0) })])], { nowMs: 100 });
  saveLedger(storage, ledger, null); /* table 缺省 → 不挂 pricing（旧分片等价） */
  assert.equal(JSON.parse(storage.getItem(ledgerSessionKeyV2("s1"))).pricing, void 0);
  const loaded = loadLedger(storage);
  assert.equal(priceArtifactOf(loaded, "s1", tableA, null).priced.cost, 2); /* 现算 */
  /* 下次以 table 落盘 → pricing 落盘。 */
  persistLedger(storage, loaded, { table: tableA, activeIds: ["s1"], changedSids: ["s1"] });
  assert.ok(JSON.parse(storage.getItem(ledgerSessionKeyV2("s1"))).pricing, "落盘后携带 pricing");
});

/* ---------------------------------------------------------------- *
 * 4.2 稳定性：价目编辑不波动 / 重算刷新 / token 事实不变 / 并发沉淀
 * ---------------------------------------------------------------- */

test("4.2 价目编辑后展示费用不变（账面价）；重算后费用 = 现行价重导出", () => {
  const storage = fakeStorage();
  const ledger = emptyLedger();
  upsertSessionEntries(ledger, "s1", [turnRow(1, [step(0, { usage: usage(1_000_000, 0, 0, 0) })])], { nowMs: 100 });
  persistLedger(storage, ledger, { table: tableA, activeIds: ["s1"], changedSids: ["s1"] });
  const loaded = loadLedger(storage);
  /* 价目编辑（改 B）：展示仍账面价（2），不随价目漂移。 */
  assert.equal(priceArtifactOf(loaded, "s1", tableB, null).priced.cost, 2);
  const views = aggregateLedgerViews(loaded, tableB, []);
  assert.equal(views.bySession.get("s1").cost, 2);
  const daily = priceDailyCost(loaded, tableB);
  assert.equal([...daily.values()].reduce((sum, item) => sum + item.cost, 0), 2);
  /* 重算此会话 → 按现行价 B 重导出（4）。 */
  const r = repriceLedgerSession(storage, loaded, "s1", tableB);
  assert.equal(r.ok, true);
  assert.equal(loaded.sessions.s1.pricing.fp, priceTableFingerprint(tableB));
  assert.equal(loaded.sessions.s1.pricing.cost, 4);
  assert.equal(priceArtifactOf(loaded, "s1", tableB, null).priced.cost, 4);
  /* token 事实与覆盖语义逐值不变（重算只写 pricing）。 */
  assert.equal(loaded.sessions.s1.entries.length, 1);
  assert.equal(loaded.sessions.s1.entries[0].u.inputTokens, 1_000_000);
});

test("4.2 沉淀清除定价（vintage 语义）：ingest 变化会话后 pricing 失效按现行价重记账", () => {
  const ledger = emptyLedger();
  upsertSessionEntries(ledger, "s1", [turnRow(1, [step(0, { usage: usage(1_000_000, 0, 0, 0) })])], { nowMs: 100 });
  /* 手工挂一个定价（模拟已落盘账面价）。 */
  const artifact = priceArtifactOf(ledger, "s1", tableA, null);
  ledger.sessions.s1.pricing = { v: 1, ev: PRICING_ENGINE_VERSION, fp: priceTableFingerprint(tableA), cur: "CNY", cost: 2, mc: ["deepseek-chat"], bm: [[0, 2, 1_000_000, 0, 0, 0]], dc: [], um: [] };
  /* 再沉淀新步 → pricing 被清除（entries 变化 → vintage 更新）。 */
  upsertSessionEntries(ledger, "s1", [turnRow(2, [step(0, { usage: usage(1_000_000, 0, 0, 0) })])], { nowMs: 200 });
  assert.equal(ledger.sessions.s1.pricing, void 0, "ingest 清除旧定价");
  /* 现算：2M 输入 → ¥4（当前表 A）。 */
  assert.equal(priceArtifactOf(ledger, "s1", tableA, null).priced.cost, 4);
});

test("4.2 重算进行中沉淀同会话 → 后写者胜、无损坏（token 事实与定价一致）", () => {
  const storage = fakeStorage();
  const ledger = emptyLedger();
  upsertSessionEntries(ledger, "s1", [turnRow(1, [step(0, { usage: usage(1_000_000, 0, 0, 0) })])], { nowMs: 100 });
  /* 重算（写定价）后立即再沉淀（清定价）→ 定价不再指向陈旧条目，现算兜底。 */
  repriceLedgerSession(storage, ledger, "s1", tableA);
  assert.ok(ledger.sessions.s1.pricing, "重算落定价");
  upsertSessionEntries(ledger, "s1", [turnRow(2, [step(0, { usage: usage(1_000_000, 0, 0, 0) })])], { nowMs: 200 });
  assert.equal(ledger.sessions.s1.pricing, void 0, "沉淀后定价失效（后写者胜，无损坏）");
  assert.equal(ledger.sessions.s1.entries.length, 2, "token 事实完好");
});

/* ---------------------------------------------------------------- *
 * 4.3 标脏：引擎版本提升 / 指纹不一致；fp 记忆化
 * ---------------------------------------------------------------- */

test("4.3 引擎版本提升 → 待重算披露（展示仍用旧账面价）；指纹不一致 → 旧价目披露", () => {
  const storage = fakeStorage();
  const ledger = emptyLedger();
  upsertSessionEntries(ledger, "s1", [turnRow(1, [step(0, { usage: usage(1_000_000, 0, 0, 0) })])], { nowMs: 100 });
  persistLedger(storage, ledger, { table: tableA, activeIds: ["s1"], changedSids: ["s1"] });
  const loaded = loadLedger(storage);
  /* 引擎版本落后 → needsReprice。 */
  loaded.sessions.s1.pricing.ev = PRICING_ENGINE_VERSION - 1;
  assert.equal(pricingStatusOf(loaded, "s1", tableA).needsReprice, true);
  assert.equal(pricingStatusOf(loaded, "s1", tableA).staleTable, false);
  /* 展示仍用旧账面价（不自动重算）。 */
  assert.equal(priceArtifactOf(loaded, "s1", tableA, null).priced.cost, 2);
  /* 指纹不一致（换表）→ staleTable。 */
  assert.equal(pricingStatusOf(loaded, "s1", tableB).staleTable, true);
  assert.equal(pricingStatusOf(loaded, "s1", tableB).needsReprice, true);
});

test("4.3 无 pricing 会话无披露（null）", () => {
  const ledger = emptyLedger();
  upsertSessionEntries(ledger, "s1", [turnRow(1, [step(0)])], { nowMs: 100 });
  assert.equal(pricingStatusOf(ledger, "s1", tableA), null);
});

test("4.3 fp 记忆化：同价目数组引用只算一次；不同价目指纹不同", () => {
  const a1 = priceTableFingerprint(tableA);
  const a2 = priceTableFingerprint(tableA);
  assert.equal(a1, a2); /* 同引用 → 命中记忆化 */
  assert.notEqual(a1, priceTableFingerprint(tableB)); /* 不同价目 → 不同指纹 */
  assert.equal(priceTableFingerprint(null), "0");
  /* DEFAULT_PRICE_TABLE 稳定指纹（跨调用一致）。 */
  assert.equal(priceTableFingerprint(DEFAULT_PRICE_TABLE), priceTableFingerprint(DEFAULT_PRICE_TABLE));
});

/* ---------------------------------------------------------------- *
 * 4.4 预算：常数上调 / 重算预检拒绝 / 水位阶梯含 pricing 收缩
 * ---------------------------------------------------------------- */

test("4.4 常数上调：est index per session = 512（fix 后锁定）", () => {
  assert.equal(LEDGER_ESTIMATE_INDEX_PER_SESSION_BYTES, 512);
});

test("4.4 重算预检：估算超水位余量 → 拒绝启动（repriceLedgerAll 拒绝）", () => {
  const storage = fakeStorage();
  const ledger = emptyLedger();
  upsertSessionEntries(ledger, "s1", [turnRow(1, [step(0)])], { nowMs: 100 });
  /* 极小预算强制拒绝：任何定价增量都越界。 */
  const check = repriceLedgerBudgetCheck(ledger, new Map(), { budgetBytes: 10, headroomBytes: 0 });
  assert.equal(check.ok, false);
  const result = repriceLedgerAll(storage, ledger, tableA, { budgetBytes: 10, headroomBytes: 0 });
  assert.equal(result.precheck.ok, false);
  assert.equal(result.repriceCount, 0);
  assert.ok(!ledger.sessions.s1.pricing, "被拒绝时不落定价");
});

test("4.4 重算预检通过 → 重算成功；空会话跳过", () => {
  const storage = fakeStorage();
  const ledger = emptyLedger();
  upsertSessionEntries(ledger, "s1", [turnRow(1, [step(0, { usage: usage(1_000_000, 0, 0, 0) })])], { nowMs: 100 });
  /* 空会话（无条目无桶）不可重算。 */
  ledger.sessions["s2"] = { lastSeen: 1, coverage: {}, entries: [], buckets: [] };
  const result = repriceLedgerAll(storage, ledger, tableA);
  assert.equal(result.precheck.ok, true);
  assert.equal(result.repriceCount, 1);
  assert.equal(result.skippedCount, 1);
  assert.ok(ledger.sessions.s1.pricing, "s1 落定价");
  assert.equal(ledger.sessions.s2.pricing, void 0, "空会话不落定价");
});

test("4.4 水位超限阶梯含 pricing 一并收缩（evicted 会话无分片残留）", () => {
  const storage = fakeStorage();
  const ledger = emptyLedger();
  upsertSessionEntries(ledger, "old", [turnRow(1, [step(0, { usage: usage(1, 0, 0, 0) })])], { nowMs: 1 });
  upsertSessionEntries(ledger, "new", [turnRow(1, [step(0, { usage: usage(1, 0, 0, 0) })])], { nowMs: Date.now() });
  const sizeCache = new Map();
  /* 先以 tableA 落盘：两个会话均携带 pricing（账面价落盘）。 */
  assert.equal(persistLedger(storage, ledger, { table: tableA, activeIds: ["old", "new"], sizeCache }).ok, true);
  assert.ok(ledger.sessions.new.pricing, "落盘后 new 携带定价");
  assert.ok(ledger.sessions.old.pricing, "落盘后 old 携带定价");
  /* 压低预算逼逐出：保留 new（更活跃）所需，逐出最旧的 old 及其分片。 */
  const newShardLen = storage.getItem(ledgerSessionKeyV2("new")).length;
  const budget = 1024 + LEDGER_ESTIMATE_INDEX_PER_SESSION_BYTES + newShardLen + 64;
  const result = persistLedger(storage, ledger, { table: tableA, activeIds: ["old", "new"], sizeCache, budgetBytes: budget, headroomBytes: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.evicted, true);
  assert.ok(ledger.sessions.new !== void 0, "new 保留");
  assert.equal(ledger.sessions.old, void 0, "old 逐出");
  /* 逐出后落盘：new 分片在（含 pricing）、old 分片清除。 */
  const loaded = loadLedger(storage);
  assert.equal(loaded.sessions.old, void 0);
  assert.ok(loaded.sessions.new !== void 0);
  assert.ok(loaded.sessions.new.pricing, "保留会话仍携带定价");
});
