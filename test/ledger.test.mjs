/**
 * dsh-v-token-insight — ledger.mjs 单测（tasks 4.1 / 7.2；fix-ledger-quota-budget 4.1/4.2）。
 * 覆盖：幂等沉淀（last-wins / 重试取终值）、窗口完备性合并（含 null 语义）、
 * 深补覆盖区间与截断标注、损坏回退、压缩老化按「日 × 模型 × 折扣窗口命中」
 * 分桶（L3 语义保留）、孤儿 GC 宽限期、手动清除、固化随持久化执行 + 总量预算
 * 收缩阶梯（persistLedger）、紧凑编码读写与旧格式双兼容、导出旧格式兼容、
 * estimateLedgerBytes 与尺寸缓存、费用部分覆盖口径（priceLedgerSession / priceDailyCost）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  COVERAGE_GAP_THRESHOLD,
  LEDGER_EVICT_HEADROOM_BYTES,
  LEDGER_ESTIMATE_INDEX_PER_SESSION_BYTES,
  LEDGER_ESTIMATE_OVERHEAD_BYTES,
  LEDGER_INDEX_KEY_V2,
  LEDGER_ORPHAN_GRACE_DAYS,
  LEDGER_RAW_RETENTION_DAYS,
  LEDGER_STORE_KEY,
  LEDGER_TOTAL_BUDGET_BYTES,
  aggregateLedgerViews,
  ageLedger,
  clearAllLedger,
  clearSessionLedger,
  createLedgerNotifier,
  emptyLedger,
  estimateLedgerBytes,
  isPartialCoverage,
  ledgerCoverageGaps,
  ledgerLegacyBackup,
  ledgerSessionKeyV2,
  loadLedger,
  persistLedger,
  priceDailyCost,
  priceLedgerSession,
  recordDeepCoverage,
  saveLedger,
  sessionsWithUnattributedEntries,
  upsertSessionEntries,
  ledgerSessionBuckets,
  ledgerTokensForDay
} from "../src/ledger.mjs";
import { DEFAULT_PRICE_TABLE, bucketSetCost, stepCost } from "../src/pricing.mjs";
import { foldHistoryEvents, foldTurns, joinRequestInsights } from "../src/stats-fold.mjs";
import { aggregateByTime, aggregateKpi, computeTrendRemainders, dayKeyOf, expandRows } from "../src/rows-aggregate.mjs";

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

test("upsertSessionEntries：模型未知的步以空模型沉淀（覆盖不被吞掉、可被自动修复发现）", () => {
  const ledger = emptyLedger();
  upsertSessionEntries(ledger, "s1", [
    turnRow(1, [
      step(0),
      step(1, { model: "" }),
      /* helper 的 ?? 会把 null 吃掉，这里手工构造 null 形状（foldTurns 产物即此形状） */
      { step: 2, provider: "deepseek", model: null, usage: usage(100, 50, 0, 20), time: 1_700_000_000_000, startTime: null }
    ])
  ], { nowMs: 1 });
  assert.deepEqual(ledger.sessions.s1.entries.map((entry) => entry.k), ["1:0", "1:1", "1:2"]);
  /* 空模型/空 provider 的步以空串沉淀，token 与发生时刻照常入账。 */
  assert.equal(ledger.sessions.s1.entries[1].m, "");
  assert.equal(ledger.sessions.s1.entries[2].m, "");
  assert.equal(ledger.sessions.s1.entries[2].u.inputTokens, 100);
  /* 空模型会话可被自动修复发现（覆盖缺口修复的入口）。 */
  assert.deepEqual(sessionsWithUnattributedEntries(ledger), ["s1"]);
});

test("upsertSessionEntries：模型归因后再次沉淀补齐（last-wins，空模型不丢失 token）", () => {
  const ledger = emptyLedger();
  upsertSessionEntries(ledger, "s1", [turnRow(1, [step(0, { model: "" })])], { nowMs: 1 });
  assert.equal(ledger.sessions.s1.entries.length, 1);
  assert.equal(ledger.sessions.s1.entries[0].m, "");
  upsertSessionEntries(ledger, "s1", [turnRow(1, [step(0, { model: "glm-5.3-flash", provider: "codemaker" })])], { nowMs: 2 });
  assert.equal(ledger.sessions.s1.entries.length, 1);
  assert.equal(ledger.sessions.s1.entries[0].m, "glm-5.3-flash");
});

test("账本自愈（fix-trajectory-join-contract）：契约迁移期空模型沉淀 → join 修复后重开页签幂等回填并恢复计价", () => {
  /* 0.2.x 形状节点：legacy 节点不带 provenance/providerMetadata（运行时未填充）。 */
  const nodes = [
    {
      kind: "assistant",
      seq: 1,
      time: 1_700_000_000_000,
      turn: 1,
      step: 1,
      blocks: [],
      usage: usage(1_000_000, 0, 0, 0)
    }
  ];
  const ledger = emptyLedger();
  /* ① 迁移期：join 解析不到模型 → 以空模型沉淀（token/时刻照常入账，可被自动修复发现）。 */
  const rowsBefore = joinRequestInsights(foldTurns(nodes), []);
  assert.equal(rowsBefore[0].steps[0].model, null);
  upsertSessionEntries(ledger, "s1", rowsBefore, { nowMs: 1 });
  assert.equal(ledger.sessions.s1.entries.length, 1);
  assert.equal(ledger.sessions.s1.entries[0].m, "");
  assert.equal(ledger.sessions.s1.entries[0].u.inputTokens, 1_000_000);
  assert.deepEqual(sessionsWithUnattributedEntries(ledger), ["s1"]);
  const before = priceLedgerSession(ledger, "s1", DEFAULT_PRICE_TABLE);
  assert.equal(before.cost, null);
  /* ② 修复后重开页签：0.2.x providerMetadata 到位 → 同键 upsert 回填真实模型，token 不丢。 */
  const rowsAfter = joinRequestInsights(foldTurns(nodes), [
    { purpose: "assistant", turn: 1, step: 1, providerMetadata: { provider: "deepseek", model: "deepseek-chat" } }
  ]);
  assert.equal(rowsAfter[0].steps[0].model, "deepseek-chat");
  upsertSessionEntries(ledger, "s1", rowsAfter, { nowMs: 2 });
  assert.equal(ledger.sessions.s1.entries.length, 1); /* 幂等：同键覆盖不新增 */
  assert.equal(ledger.sessions.s1.entries[0].m, "deepseek-chat");
  assert.equal(ledger.sessions.s1.entries[0].p, "deepseek");
  assert.equal(ledger.sessions.s1.entries[0].u.inputTokens, 1_000_000);
  assert.deepEqual(sessionsWithUnattributedEntries(ledger), []);
  /* ③ 总览费用恢复增量计价（deepseek-chat：输入 ¥2/MTok）。 */
  const after = priceLedgerSession(ledger, "s1", DEFAULT_PRICE_TABLE);
  assert.equal(after.covered, true);
  assert.equal(after.cost, 2);
});

test("sessionsWithUnattributedEntries：检测空模型条目/桶，干净会话不报", () => {
  const ledger = emptyLedger();
  upsertSessionEntries(ledger, "clean", [turnRow(1, [step(0)])], { nowMs: 1 });
  ledger.sessions.poisoned = {
    lastSeen: 1,
    coverage: {},
    entries: [{ k: "1:1", p: "codemaker", m: "", u: usage(10, 0, 0, 5), t: 1, st: null }],
    buckets: []
  };
  ledger.sessions.poisonedBucket = {
    lastSeen: 1,
    coverage: {},
    entries: [],
    buckets: [{ d: "2026-09-01", m: "", p: "codemaker", w: null, u: usage(10, 0, 0, 5), n: 1 }]
  };
  assert.deepEqual(sessionsWithUnattributedEntries(ledger), ["poisoned", "poisonedBucket"]);
  assert.deepEqual(sessionsWithUnattributedEntries(emptyLedger()), []);
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
  storage.setItem("dsh-v-token-insight.ledger.v1", "{not json");
  assert.deepEqual(loadLedger(storage), emptyLedger());
  storage.setItem("dsh-v-token-insight.ledger.v1", JSON.stringify({ v: 2 }));
  assert.deepEqual(loadLedger(storage), emptyLedger());
  storage.setItem("dsh-v-token-insight.ledger.v1", JSON.stringify({ v: 1, sessions: { s: { entries: [{ k: "bogus", u: {} }], buckets: [], lastSeen: 1 } } }));
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

test("persistLedger：满盘（setItem 恒抛）下收缩阶梯先行，如实落内存模式", () => {
  const storage = fakeStorage();
  storage.setItem = () => {
    throw new Error("quota");
  };
  const ledger = emptyLedger();
  const old = Date.now() - (LEDGER_RAW_RETENTION_DAYS + 5) * 86_400_000;
  upsertSessionEntries(ledger, "s1", [turnRow(1, [step(0, { time: old })])], { nowMs: Date.now() });
  const result = persistLedger(storage, ledger, { nowMs: Date.now(), activeIds: ["s1"] });
  assert.equal(result.ok, false);
  assert.equal(result.aged, true);
  assert.ok(result.collapsed >= 1); /* 常规固化已随持久化执行（不再仅作配额失败兜底） */
  assert.equal(result.evicted, false); /* 收缩后水位内：无需逐出 */
  assert.deepEqual(result.evictedSessions, []);
  /* 常规固化把陈旧原始步卷为桶（内存内），条目数为 0 */
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

test("priceLedgerSession：空模型条目/桶 → 「未知模型」标注（可解释的未定价）", () => {
  const ledger = emptyLedger();
  /* 空模型条目只能由旧版本账本遗留（现版本沉淀已跳过），直接构造账本面。 */
  ledger.sessions.s1 = {
    lastSeen: 1,
    coverage: {},
    entries: [{ k: "1:1", p: "codemaker", m: "", u: usage(1_000_000, 0, 0, 0), t: 1, st: null }],
    buckets: []
  };
  const priced = priceLedgerSession(ledger, "s1", DEFAULT_PRICE_TABLE);
  assert.equal(priced.covered, true);
  assert.equal(priced.cost, null);
  assert.deepEqual(priced.unmatched, ["未知模型:无价目"]);
  ledger.sessions.s2 = {
    lastSeen: 1,
    coverage: {},
    entries: [],
    buckets: [{ d: "2026-09-01", m: "", p: "codemaker", w: null, u: usage(1_000_000, 0, 0, 0), n: 2 }]
  };
  const priced2 = priceLedgerSession(ledger, "s2", DEFAULT_PRICE_TABLE);
  assert.equal(priced2.cost, null);
  assert.deepEqual(priced2.unmatched, ["未知模型:无价目"]);
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

test("priceLedgerSession：byModel 按模型归因已定价费用与 token（条目 + 老化桶）", () => {
  const ledger = emptyLedger();
  upsertSessionEntries(ledger, "s1", [
    turnRow(1, [step(0, { model: "deepseek-chat", usage: usage(1_000_000, 0, 0, 0) })]),
    turnRow(2, [step(0, { model: "glm-5.3-flash", usage: usage(1_000_000, 0, 0, 0) })])
  ], { nowMs: 1 });
  ledger.sessions.s1.buckets.push({ d: "2026-09-01", m: "deepseek-chat", p: "deepseek", w: null, u: usage(500_000, 0, 0, 0), n: 1 });
  const priced = priceLedgerSession(ledger, "s1", DEFAULT_PRICE_TABLE);
  const ds = priced.byModel.get("deepseek-chat");
  assert.equal(ds.cost, 2 + 1); /* 1M 输入 ¥2/MTok + 老化桶 0.5M ¥1 */
  assert.equal(ds.tokens.inputTokens, 1_500_000);
  const glm = priced.byModel.get("glm-5.3-flash");
  assert.equal(glm.cost, 0.8); /* 1M 输入 × ¥0.8/MTok（5 折促销已到期） */
  assert.equal(glm.tokens.inputTokens, 1_000_000);
  assert.equal(priced.byModel.size, 2);
});

test("aggregateLedgerViews：byModel 行携带 cost 与 avgCost（百万 token 均价）", () => {
  const ledger = emptyLedger();
  upsertSessionEntries(ledger, "s1", [
    turnRow(1, [step(0, { model: "deepseek-chat", usage: usage(1_000_000, 0, 0, 0) })]),
    turnRow(2, [step(0, { model: "glm-5.3-flash", usage: usage(1_000_000, 0, 0, 0) })])
  ], { nowMs: 1 });
  const views = aggregateLedgerViews(ledger, DEFAULT_PRICE_TABLE, []);
  const ds = views.byModel.find((row) => row.model === "deepseek-chat");
  assert.equal(ds.cost, 2);
  assert.equal(ds.avgCost, 2); /* 1M 输入 ¥2 → ¥2/百万Token */
  const glm = views.byModel.find((row) => row.model === "glm-5.3-flash");
  assert.equal(glm.cost, 0.8);
  assert.equal(glm.avgCost, 0.8);
  /* 无已定价费用的模型（如空模型遗留条目）→ cost 与 avgCost 均 null */
  ledger.sessions.s2 = {
    lastSeen: 1,
    coverage: {},
    entries: [{ k: "1:1", p: "codemaker", m: "", u: usage(1_000_000, 0, 0, 0), t: 1, st: null }],
    buckets: []
  };
  const views2 = aggregateLedgerViews(ledger, DEFAULT_PRICE_TABLE, []);
  const unknown = views2.byModel.find((row) => row.model === "");
  assert.equal(unknown.cost, null);
  assert.equal(unknown.avgCost, null);
});

test("aggregateLedgerViews：excludeIds 排除 fork 会话的模型聚合（bySession 行保留）", () => {
  const ledger = emptyLedger();
  upsertSessionEntries(ledger, "orig", [turnRow(1, [step(0, { model: "deepseek-chat", usage: usage(1_000_000, 0, 0, 0) })])], { nowMs: 1 });
  upsertSessionEntries(ledger, "fork", [turnRow(1, [step(0, { model: "deepseek-chat", usage: usage(1_000_000, 0, 0, 0) })])], { nowMs: 1 });
  const views = aggregateLedgerViews(ledger, DEFAULT_PRICE_TABLE, [], new Set(["fork"]));
  assert.equal(views.byModel.find((r) => r.model === "deepseek-chat").cost, 2); /* 只计 orig */
  assert.ok(views.bySession.get("fork").covered); /* fork 行数据保留供逐行查看 */
  const viewsAll = aggregateLedgerViews(ledger, DEFAULT_PRICE_TABLE, []);
  assert.equal(viewsAll.byModel.find((r) => r.model === "deepseek-chat").cost, 4); /* 不排除时双份 */
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

test("priceDailyCost：excludeIds 排除 fork 会话的按日费用（分支继承父历史，不排除则重复计价）", () => {
  const ledger = emptyLedger();
  const day1 = new Date(2026, 0, 10, 9, 0, 0).getTime();
  upsertSessionEntries(ledger, "orig", [turnRow(1, [step(0, { usage: usage(1_000_000, 0, 0, 0), time: day1, startTime: day1 })])], { nowMs: 1 });
  upsertSessionEntries(ledger, "fork", [turnRow(1, [step(0, { usage: usage(1_000_000, 0, 0, 0), time: day1, startTime: day1 })])], { nowMs: 1 });
  /* 不排除：父 + fork 双份（fork 继承父历史消耗）。 */
  const daily = priceDailyCost(ledger, DEFAULT_PRICE_TABLE);
  assert.equal(daily.get(dayKeyOf(day1)).cost, 4);
  /* 排除 fork：只计父会话，与 KPI / 合计的排除口径对齐。 */
  const dailyEx = priceDailyCost(ledger, DEFAULT_PRICE_TABLE, null, 0, new Set(["fork"]));
  assert.equal(dailyEx.get(dayKeyOf(day1)).cost, 2);
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

test("foldHistoryEvents：0.1.2-rc.1 事件窗口混合条目——chunks 压缩行跳过、event 条目折算", () => {
  const stepStart = { type: "step/start", seq: 1, time: 1000, data: { turn: 2, step: 0 } };
  const message = { type: "assistant/message", seq: 2, time: 1200, data: { turn: 2, step: 0, usage: usage(7, 0, 0, 3), message: { source: { provider: "p", model: "m" } } } };
  const chunkRow = { type: "chunks", event: { type: "chunkrow/assistant-delta", seq: 50, time: 1100, data: {} } };
  const folded = foldHistoryEvents([[{ type: "event", event: stepStart }, chunkRow, { type: "event", event: message }]]);
  assert.equal(folded.fromSeq, 1); /* 压缩行 seq 不进入覆盖区间 */
  assert.equal(folded.toSeq, 2);
  assert.equal(folded.rows.length, 1);
  assert.equal(folded.rows[0].steps[0].model, "m");
  assert.equal(folded.rows[0].steps[0].usage.inputTokens, 7);
});

test("stepCost 回归确认（老化桶对照基准）", () => {
  const entry = DEFAULT_PRICE_TABLE[0];
  const result = stepCost(entry, usage(1_000_000, 0, 0, 0), { time: 1_700_000_000_000 });
  assert.equal(result.cost, 2);
});

/* ---------------------------------------------------------------- *
 * 账本版本通知（perf-hot-path-optimization 任务 4.2，D3）
 * ---------------------------------------------------------------- */

/** fake 定时器（注入 createLedgerNotifier，node 可单测）。 */
function fakeTimers() {
  const pending = [];
  let seq = 0;
  return {
    schedule: (fn) => {
      seq += 1;
      pending.push({ fn, id: seq });
      return seq;
    },
    cancel: (id) => {
      const index = pending.findIndex((timer) => timer.id === id);
      if (index >= 0) pending.splice(index, 1);
    },
    get pendingCount() {
      return pending.length;
    },
    fireAll() {
      while (pending.length > 0) pending.shift().fn();
    }
  };
}

test("4.2 通知合并：版本即增；挂起期间吸收后续通知（多次合并为一次尾随派发）", () => {
  const timers = fakeTimers();
  const dispatched = [];
  const notifier = createLedgerNotifier({ schedule: timers.schedule, cancel: timers.cancel, dispatch: (v) => dispatched.push(v), coalesceMs: 500 });
  notifier.notify({ coalesce: true }); /* v1 → 挂起派发 */
  notifier.notify({ coalesce: true }); /* v2 → 吸收 */
  notifier.notify({ coalesce: true }); /* v3 → 吸收 */
  assert.equal(notifier.version, 3); /* 版本号即增（唯一事实源） */
  assert.equal(dispatched.length, 0); /* 挂起未派发 */
  assert.equal(timers.pendingCount, 1);
  timers.fireAll();
  assert.deepEqual(dispatched, [3]); /* 尾随派发带最新版本：合并后最终一致 */
});

test("4.2 立即派发（用户可见变更）取消挂起合并派发", () => {
  const timers = fakeTimers();
  const dispatched = [];
  const notifier = createLedgerNotifier({ schedule: timers.schedule, cancel: timers.cancel, dispatch: (v) => dispatched.push(v), coalesceMs: 500 });
  notifier.notify({ coalesce: true }); /* v1 挂起 */
  notifier.notify(); /* v2 立即（导入/清除/重建落定） */
  assert.deepEqual(dispatched, [2]);
  assert.equal(timers.pendingCount, 0); /* 挂起定时器已取消 */
  notifier.notify({ coalesce: true }); /* v3 重新挂起 */
  timers.fireAll();
  assert.deepEqual(dispatched, [2, 3]);
});

test("4.2 挂载初值直读当前版本（防抖挂起不丢状态）；未合并通知只算增量（缓存语义另测）", () => {
  const timers = fakeTimers();
  const notifier = createLedgerNotifier({ schedule: timers.schedule, cancel: timers.cancel, dispatch: () => {}, coalesceMs: 500 });
  notifier.notify({ coalesce: true });
  notifier.notify({ coalesce: true });
  /* useLedgerVersion 的 useState 初值读 notifier.version： */
  assert.equal(notifier.version, 2);
});

/* ---------------------------------------------------------------- *
 * 存储分片 v2（perf-hot-path-optimization 任务 5.1-5.4，D4/R4）
 * ---------------------------------------------------------------- */

/** 可枚举 fake storage（浏览器 localStorage 同款 length/key(i) 枚举面）。 */
function enumerableFakeStorage() {
  const map = new Map();
  const storage = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null
  };
  return storage;
}

test("5.1 v1→v2 迁移：分片+索引写入、v1 键删除、内存内容逐会话一致、可幂等重载", () => {
  const storage = fakeStorage();
  const v1 = emptyLedger();
  upsertSessionEntries(v1, "s1", [turnRow(1, [step(0, { model: "m1" })])], { nowMs: 5 });
  upsertSessionEntries(v1, "s2", [turnRow(2, [step(3, { model: "m2" })])], { nowMs: 6 });
  storage.setItem(LEDGER_STORE_KEY, JSON.stringify(v1)); /* 旧版本布局 */
  const loaded = loadLedger(storage);
  assert.deepEqual(Object.keys(loaded.sessions).sort(), ["s1", "s2"]);
  assert.equal(loaded.sessions.s1.entries[0].m, "m1");
  assert.equal(loaded.sessions.s2.entries[0].k, "2:3");
  /* v1 已删、v2 在：分片 + 索引 */
  assert.equal(storage.getItem(LEDGER_STORE_KEY), null);
  assert.ok(storage.getItem(LEDGER_INDEX_KEY_V2) !== null);
  assert.ok(storage.getItem(ledgerSessionKeyV2("s1")) !== null);
  assert.ok(storage.getItem(ledgerSessionKeyV2("s2")) !== null);
  /* 再次加载（v2 模式）逐会话一致 */
  const again = loadLedger(storage);
  assert.deepEqual(again, loaded);
});

test("5.1 迁移中断注入：单会话分片写入失败即中止、v1 键保留、幂等可重试", () => {
  const storage = fakeStorage();
  const v1 = emptyLedger();
  upsertSessionEntries(v1, "s1", [turnRow(1, [step(0)])], { nowMs: 5 });
  upsertSessionEntries(v1, "s2", [turnRow(1, [step(0)])], { nowMs: 6 });
  storage.setItem(LEDGER_STORE_KEY, JSON.stringify(v1));
  const origSet = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    if (key === ledgerSessionKeyV2("s2")) throw new Error("quota");
    origSet(key, value);
  };
  const loaded = loadLedger(storage);
  assert.deepEqual(Object.keys(loaded.sessions).sort(), ["s1", "s2"]); /* 内容照常返回 */
  assert.ok(storage.getItem(LEDGER_STORE_KEY) !== null); /* v1 保留（失败当次停留 v1） */
  /* 下次启动重试（不再注入失败）→ 迁移完成 */
  storage.setItem = origSet;
  loadLedger(storage);
  assert.equal(storage.getItem(LEDGER_STORE_KEY), null);
  assert.ok(storage.getItem(LEDGER_INDEX_KEY_V2) !== null);
});

test("5.1 模式优先级：v1 与 v2 并存 → v1 权威重迁移（覆盖 v2、残留分片对账删除）", () => {
  const storage = fakeStorage();
  const v1 = emptyLedger();
  upsertSessionEntries(v1, "from-v1", [turnRow(1, [step(0, { model: "v1-model" })])], { nowMs: 5 });
  storage.setItem(LEDGER_STORE_KEY, JSON.stringify(v1));
  /* 预置 v2 残留（回滚旧版本后升级的场景） */
  storage.setItem(
    ledgerSessionKeyV2("from-v2"),
    JSON.stringify({ lastSeen: 9, coverage: {}, entries: [{ k: "1:1", p: "p", m: "v2-model", u: usage(1, 0, 0, 0), t: 1, st: null }], buckets: [] })
  );
  storage.setItem(LEDGER_INDEX_KEY_V2, JSON.stringify({ v: 2, sessions: { "from-v2": { lastSeen: 9, coverage: {} } } }));
  const loaded = loadLedger(storage);
  assert.deepEqual(Object.keys(loaded.sessions), ["from-v1"]); /* v1 权威 */
  assert.equal(loaded.sessions["from-v1"].entries[0].m, "v1-model");
  assert.equal(storage.getItem(LEDGER_STORE_KEY), null); /* v1 已删 */
  assert.equal(storage.getItem(ledgerSessionKeyV2("from-v2")), null); /* v2 残留对账删除 */
  assert.deepEqual(loadLedger(storage), loaded);
});

test("5.2 保存只写变化会话分片 + 必要索引（其余分片不重写）", () => {
  const storage = fakeStorage();
  const ledger = emptyLedger();
  upsertSessionEntries(ledger, "s1", [turnRow(1, [step(0)])], { nowMs: 5 });
  upsertSessionEntries(ledger, "s2", [turnRow(1, [step(0)])], { nowMs: 6 });
  assert.equal(saveLedger(storage, ledger, null), true); /* 全量初存（v2 模式） */
  const s2Shard = storage.getItem(ledgerSessionKeyV2("s2"));
  const writes = [];
  const origSet = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    writes.push(key);
    origSet(key, value);
  };
  upsertSessionEntries(ledger, "s1", [turnRow(2, [step(0)])], { nowMs: 7 });
  assert.equal(saveLedger(storage, ledger, ["s1"]), true);
  storage.setItem = origSet;
  assert.deepEqual(writes, [ledgerSessionKeyV2("s1"), LEDGER_INDEX_KEY_V2]); /* 变化分片 + 索引 */
  const loaded = loadLedger(storage);
  assert.equal(loaded.sessions.s1.entries.length, 2);
  assert.equal(loaded.sessions.s2.entries.length, 1);
  assert.equal(storage.getItem(ledgerSessionKeyV2("s2")), s2Shard); /* 未重写 */
});

test("5.2 删除对账：清除/GC 后保存删除对应分片键（孤儿分片不残留）", () => {
  const storage = fakeStorage();
  const ledger = emptyLedger();
  upsertSessionEntries(ledger, "s1", [turnRow(1, [step(0)])], { nowMs: 5 });
  upsertSessionEntries(ledger, "s2", [turnRow(1, [step(0)])], { nowMs: 6 });
  saveLedger(storage, ledger, null);
  clearSessionLedger(ledger, "s2");
  saveLedger(storage, ledger, ["s1"]);
  assert.equal(storage.getItem(ledgerSessionKeyV2("s2")), null);
  const loaded = loadLedger(storage);
  assert.deepEqual(Object.keys(loaded.sessions), ["s1"]);
});

test("5.2 persistLedger（v2 分片 + 变化会话）：写入失败先按会话粒度收紧重试（规格保留条款）", () => {
  const storage = fakeStorage();
  const ledger = emptyLedger();
  const old = Date.now() - (LEDGER_RAW_RETENTION_DAYS + 5) * 86_400_000;
  upsertSessionEntries(ledger, "stale", [turnRow(1, [step(0, { time: old })])], { nowMs: Date.now() });
  upsertSessionEntries(ledger, "fresh", [turnRow(1, [step(0, { time: Date.now(), startTime: Date.now() })])], { nowMs: Date.now() });
  let failFirst = true;
  const origSet = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    if (failFirst) {
      failFirst = false;
      throw new Error("quota");
    }
    origSet(key, value);
  };
  const result = persistLedger(storage, ledger, { nowMs: Date.now(), table: null, activeIds: ["stale", "fresh"], changedSids: ["stale"] });
  assert.equal(result.ok, true);
  assert.equal(result.aged, true);
  assert.ok(result.collapsed >= 1);
  assert.equal(result.evicted, false);
  assert.deepEqual(result.evictedSessions, []);
  /* 只收紧了变化会话：stale 的陈旧步卷桶，fresh 的今日原始条目保留 */
  assert.equal(ledger.sessions.stale.entries.length, 0);
  assert.equal(ledger.sessions.stale.buckets.length, 1);
  assert.equal(ledger.sessions.fresh.entries.length, 1);
});

test("5.3 会话分片损坏：仅该会话回退空账本并清坏键，其余会话与索引不受影响", () => {
  const storage = fakeStorage();
  const ledger = emptyLedger();
  upsertSessionEntries(ledger, "good", [turnRow(1, [step(0, { model: "m1" })])], { nowMs: 5 });
  upsertSessionEntries(ledger, "bad", [turnRow(1, [step(0, { model: "m2" })])], { nowMs: 6 });
  saveLedger(storage, ledger, null);
  storage.setItem(ledgerSessionKeyV2("bad"), "{corrupted");
  const loaded = loadLedger(storage);
  assert.equal(loaded.sessions.good.entries[0].m, "m1");
  assert.equal(loaded.sessions.bad.entries.length, 0); /* 分片粒度回退 */
  assert.equal(loaded.sessions.bad.lastSeen, 6); /* 索引元数据保留（在册空会话） */
  assert.equal(storage.getItem(ledgerSessionKeyV2("bad")), null); /* 坏键尽力清除 */
  assert.ok(storage.getItem(LEDGER_INDEX_KEY_V2) !== null);
});

test("5.3 索引损坏：扫描 .s. 前缀枚举重建（旧格式分片自洽携带元数据）", () => {
  const storage = enumerableFakeStorage();
  /* 旧格式分片（升级前写入）：内嵌 lastSeen/coverage，索引损坏时独立恢复。 */
  storage.setItem(
    ledgerSessionKeyV2("r1"),
    JSON.stringify({ lastSeen: 5, coverage: { windowFull: true }, entries: [{ k: "1:0", p: "deepseek", m: "m1", u: usage(100, 50, 0, 20), t: 1_700_000_000_000, st: null }], buckets: [] })
  );
  storage.setItem(
    ledgerSessionKeyV2("r2"),
    JSON.stringify({ lastSeen: 6, coverage: {}, entries: [{ k: "2:0", p: "deepseek", m: "m2", u: usage(100, 50, 0, 20), t: 1_700_000_000_000, st: null }], buckets: [] })
  );
  storage.setItem(LEDGER_INDEX_KEY_V2, "{broken");
  const loaded = loadLedger(storage);
  assert.deepEqual(Object.keys(loaded.sessions).sort(), ["r1", "r2"]);
  assert.equal(loaded.sessions.r1.entries[0].m, "m1");
  assert.equal(loaded.sessions.r1.lastSeen, 5); /* 元数据从分片恢复 */
  assert.equal(loaded.sessions.r2.lastSeen, 6);
});

test("5.3 索引损坏且无枚举面（node fake）→ 降级空账本，不抛错", () => {
  const storage = fakeStorage(); /* 无 key()/length 枚举面 */
  storage.setItem(
    ledgerSessionKeyV2("x"),
    JSON.stringify({ lastSeen: 1, coverage: {}, entries: [{ k: "1:1", p: "p", m: "m", u: usage(1, 0, 0, 0), t: 1, st: null }], buckets: [] })
  );
  storage.setItem(LEDGER_INDEX_KEY_V2, "{broken");
  const loaded = loadLedger(storage);
  assert.deepEqual(loaded, emptyLedger());
});

test("5.3 会话分片缺席（索引在册）→ 按索引元数据回退空会话", () => {
  const storage = fakeStorage();
  storage.setItem(LEDGER_INDEX_KEY_V2, JSON.stringify({ v: 2, sessions: { ghost: { lastSeen: 7, coverage: { windowFull: true } } } }));
  const loaded = loadLedger(storage);
  assert.equal(loaded.sessions.ghost.lastSeen, 7);
  assert.deepEqual(loaded.sessions.ghost.coverage, { windowFull: true });
  assert.equal(loaded.sessions.ghost.entries.length, 0);
});

test("5.4 v1 模式保存：迁移失败当次停留 v1 单键保存（不做双写）", () => {
  const storage = fakeStorage();
  const v1 = emptyLedger();
  upsertSessionEntries(v1, "s1", [turnRow(1, [step(0, { model: "m" })])], { nowMs: 5 });
  storage.setItem(LEDGER_STORE_KEY, JSON.stringify(v1));
  const origSet = storage.setItem.bind(storage);
  let failAll = true;
  storage.setItem = (key, value) => {
    if (failAll) throw new Error("quota");
    origSet(key, value);
  };
  const loaded = loadLedger(storage); /* 迁移失败 → v1 保留 */
  assert.ok(storage.getItem(LEDGER_STORE_KEY) !== null);
  assert.equal(storage.getItem(ledgerSessionKeyV2("s1")), null);
  failAll = false;
  /* 保存路径：检测到 v1 在册 → 整本写 v1，不写 v2 分片 */
  upsertSessionEntries(loaded, "s1", [turnRow(2, [step(0, { model: "m" })])], { nowMs: 6 });
  assert.equal(saveLedger(storage, loaded), true);
  assert.equal(storage.getItem(ledgerSessionKeyV2("s1")), null); /* 未做双写 */
  const written = JSON.parse(storage.getItem(LEDGER_STORE_KEY));
  assert.equal(written.sessions.s1.entries.length, 2); /* v1 键内容已更新 */
  /* v1 模式读回一致 */
  failAll = true;
  assert.equal(loadLedger(storage).sessions.s1.entries.length, 2);
});

test("5.4 导入预检路径：只读 fake（无 setItem）载入备份文本不触发迁移写、不抛错", () => {
  const ledger = emptyLedger();
  upsertSessionEntries(ledger, "s1", [turnRow(1, [step(0, { model: "m" })])], { nowMs: 5 });
  const readonly = { getItem: () => JSON.stringify(ledger) };
  const loaded = loadLedger(readonly);
  assert.equal(loaded.sessions.s1.entries[0].m, "m");
});

test("5.4 备份 JSON 保持整体账本格式：v2 分片存储导出形状 = {v:1, sessions}", () => {
  const storage = fakeStorage();
  const ledger = emptyLedger();
  upsertSessionEntries(ledger, "s1", [turnRow(1, [step(0, { model: "m" })])], { nowMs: 5 });
  saveLedger(storage, ledger, null); /* v2 分片持久化 */
  const loaded = loadLedger(storage);
  /* 导出 = 内存账本整体序列化（与 v1 时代完全同形） */
  assert.equal(loaded.v, 1);
  assert.deepEqual(Object.keys(loaded.sessions), ["s1"]);
  assert.deepEqual(loaded.sessions.s1.coverage, { turnFrom: 1, turnTo: 1, windowFull: true });
  const roundtrip = loadLedger({ getItem: () => JSON.stringify(loaded) });
  assert.deepEqual(roundtrip, loaded);
});

test("ledgerSessionBuckets：entries + 老化桶四桶合计（投影缺席的 Tier 1 兜底数据源）", () => {
  const ledger = {
    v: 1,
    sessions: {
      s1: { entries: [{ u: usage(10, 20, 0, 5) }, { u: usage(1, 2, 0, 3) }], buckets: [{ u: usage(100, 0, 0, 50) }] },
      s2: { entries: [], buckets: [] }
    }
  };
  const map = ledgerSessionBuckets(ledger);
  assert.equal(map.size, 1); /* 无可计桶的会话不入表 */
  const totals = map.get("s1");
  assert.equal(totals.inputTokens, 111);
  assert.equal(totals.cacheReadTokens, 22);
  assert.equal(totals.cacheWriteTokens, 0);
  assert.equal(totals.outputTokens, 58);
});

/* ---------------------------------------------------------------- *
 * 覆盖缺口检测与趋势余量（fix-partial-coverage 2.1/2.2/2.4）。
 * ---------------------------------------------------------------- */

/** 列表行构造（与 expandRows 输入同形的最小形状；投影四桶总量 470）。 */
const listRow = (over = {}) => ({
  id: "s1",
  displayTitle: "会话",
  running: false,
  completed: false,
  blank: false,
  updatedAt: 1_700_000_000_000,
  projectionValues: { tokenUsage: { uncachedInputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 20, outputTokens: 50 } },
  ...over
});
const listRowUsage = (input, cacheRead = 0, cacheWrite = 0, output = 0) => ({
  ...listRow(),
  projectionValues: { tokenUsage: { uncachedInputTokens: input, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, outputTokens: output } }
});
const zeroBuckets = () => ({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });

test("ledgerCoverageGaps：阈值边界——恰好等于阈值入选、差一位不入选", () => {
  assert.equal(COVERAGE_GAP_THRESHOLD, 100_000);
  const dailyBucketsBySession = new Map([["edge", zeroBuckets()], ["below", zeroBuckets()]]);
  const expanded = expandRows([
    { ...listRowUsage(100_000), id: "edge" },
    { ...listRowUsage(99_999), id: "below" }
  ]);
  assert.deepEqual(ledgerCoverageGaps(expanded, dailyBucketsBySession), ["edge"]);
  /* 自定义阈值同语义。 */
  const small = expandRows([
    { ...listRowUsage(100), id: "edge-s" },
    { ...listRowUsage(99), id: "below-s" }
  ]);
  const smallDaily = new Map([["edge-s", zeroBuckets()], ["below-s", zeroBuckets()]]);
  assert.deepEqual(ledgerCoverageGaps(small, smallDaily, 100), ["edge-s"]);
});

test("ledgerCoverageGaps：从未覆盖（无键）不入选；fork 行不入选；投影缺席（回退/缺席）不入选", () => {
  const dailyBucketsBySession = new Map([["s-covered", zeroBuckets()]]);
  const expanded = expandRows([
    { ...listRowUsage(600_000), id: "s-never" }, /* 无键：从未覆盖 */
    { ...listRowUsage(600_000), id: "s-fork", parentId: "p" }, /* fork 副本 */
    { ...listRow(), id: "s-absent", projectionValues: void 0 }, /* 投影缺席（无兜底） */
    { ...listRowUsage(600_000), id: "s-covered" } /* 在键、投影 600k → 入选 */
  ]);
  const gaps = ledgerCoverageGaps(expanded, dailyBucketsBySession);
  assert.deepEqual(gaps, ["s-covered"]);
});

test("ledgerCoverageGaps：账本领先滞后投影（负差截零）不入选", () => {
  const dailyBucketsBySession = new Map([["s-ahead", { inputTokens: 500_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }]]);
  const expanded = expandRows([{ ...listRowUsage(100_000), id: "s-ahead" }]);
  assert.deepEqual(ledgerCoverageGaps(expanded, dailyBucketsBySession), []);
});

test("ledgerCoverageGaps：缺口基线=账本总覆盖（原始条目+老化桶）——桶覆盖会话不误报、真缺口仍入选、深补后收敛（2.4 冒烟；fix-ledger-quota-budget 修正）", () => {
  const ledger = emptyLedger();
  /* 空键会话：分片损坏回退/清除断尾遗留——有键无条目无桶。 */
  ledger.sessions["s-empty"] = { lastSeen: 1, coverage: {}, entries: [], buckets: [] };
  /* 仅老化桶会话 A：桶覆盖 ≈ 全投影（已固化覆盖）→ 总覆盖基线下不误报为缺口。 */
  ledger.sessions["s-aged-full"] = {
    lastSeen: 1,
    coverage: {},
    entries: [],
    buckets: [{ d: "2020-01-01", m: "deepseek-chat", p: "deepseek", w: null, u: usage(600_000, 0, 0, 0), n: 3 }]
  };
  /* 仅老化桶会话 B：桶只覆盖一半 → 真缺口 300k ≥ 阈值 → 入选。 */
  ledger.sessions["s-aged-partial"] = {
    lastSeen: 1,
    coverage: {},
    entries: [],
    buckets: [{ d: "2020-01-01", m: "deepseek-chat", p: "deepseek", w: null, u: usage(300_000, 0, 0, 0), n: 3 }]
  };
  const expanded = expandRows([
    { ...listRowUsage(600_000), id: "s-empty", updatedAt: 1_700_000_000_000 },
    { ...listRowUsage(600_000), id: "s-aged-full", updatedAt: 1_700_000_000_000 },
    { ...listRowUsage(600_000), id: "s-aged-partial", updatedAt: 1_700_000_000_000 }
  ]);
  const views = aggregateLedgerViews(ledger, DEFAULT_PRICE_TABLE, expanded);
  /* 空键会话 covered=false → 无键；桶覆盖会话有键且值为桶合计（非全零占位）。 */
  assert.equal(views.coveredBucketsBySession.has("s-empty"), false);
  assert.deepEqual(views.coveredBucketsBySession.get("s-aged-full"), usage(600_000, 0, 0, 0));
  /* 按日基线：老化桶按其聚合日（2020-01-01）入柱（fix-ledger-storm 对账），
     两个会话的桶同日 → 该日 900k。 */
  assert.deepEqual(views.dailyBucketsBySession.get("s-aged-full"), usage(600_000, 0, 0, 0));
  assert.deepEqual(views.daily.get("2020-01-01")?.buckets, usage(900_000, 0, 0, 0));
  /* 缺口（总覆盖基线）：桶覆盖 ≈ 投影 → 不入选（修正前按日基线误报全量缺口，
     触发自动深补风暴）；桶只覆盖一半 → 真缺口入选；空键不入选。 */
  assert.deepEqual(ledgerCoverageGaps(expanded, views.coveredBucketsBySession), ["s-aged-partial"]);
  /* 趋势余量：桶覆盖 ≈ 投影 → 无余量（token 已在真实日期入柱）；
     半覆盖会话余量 = 投影 − 桶 = 300k。 */
  const remainders = computeTrendRemainders(expanded, views.dailyBucketsBySession);
  assert.equal(remainders.has("s-empty"), false);
  assert.equal(remainders.has("s-aged-full"), false);
  assert.deepEqual(remainders.get("s-aged-partial"), { inputTokens: 300_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
  /* 2.4 冒烟：模拟定向深补修复——历史步按发生时刻拉回原始条目。 */
  const day1 = new Date(2026, 0, 10, 9, 0, 0).getTime();
  const day2 = new Date(2026, 0, 11, 9, 0, 0).getTime();
  upsertSessionEntries(ledger, "s-aged-partial", [
    turnRow(1, [step(0, { usage: usage(300_000, 0, 0, 0), time: day1, startTime: day1 })]),
    turnRow(2, [step(0, { usage: usage(300_000, 0, 0, 0), time: day2, startTime: day2 })])
  ], { nowMs: 2 });
  const views2 = aggregateLedgerViews(ledger, DEFAULT_PRICE_TABLE, expanded);
  /* 总覆盖 = 拉回条目 600k + 既有桶 300k ≥ 投影 → 缺口退出候选集（收敛）。 */
  assert.deepEqual(ledgerCoverageGaps(expanded, views2.coveredBucketsBySession), []);
  /* 历史步按发生时刻重新入柱：daily 出现拉回的两个日桶。 */
  assert.equal(views2.daily.get(dayKeyOf(day1)).buckets.inputTokens, 300_000);
  assert.equal(views2.daily.get(dayKeyOf(day2)).buckets.inputTokens, 300_000);
});

test("fix-partial-coverage 端到端等价：真实账本混合人群下趋势合计 ≡ KPI 合计（含 fork/部分覆盖/未覆盖/老化桶）", () => {
  const now = Date.now();
  const day1 = new Date(2026, 0, 10, 9, 0, 0).getTime();
  const ledger = emptyLedger();
  /* s-full：完全覆盖（470，逐桶同投影）；s-partial：部分覆盖（账本 270 / 投影 470，
     覆盖段逐桶为投影子集）；s-parent + s-fork：fork 副本经 excludeIds 排除；
     s-aging：仅老化桶。 */
  const fullStep = usage(100, 300, 20, 50);
  const partialStep = usage(50, 200, 0, 20);
  upsertSessionEntries(ledger, "s-full", [turnRow(1, [step(0, { usage: fullStep, time: day1, startTime: day1 })])], { nowMs: 1 });
  upsertSessionEntries(ledger, "s-partial", [turnRow(1, [step(0, { usage: partialStep, time: day1, startTime: day1 })])], { nowMs: 1 });
  upsertSessionEntries(ledger, "s-parent", [turnRow(1, [step(0, { usage: fullStep, time: day1, startTime: day1 })])], { nowMs: 1 });
  upsertSessionEntries(ledger, "s-fork", [turnRow(1, [step(0, { usage: fullStep, time: day1, startTime: day1 })])], { nowMs: 1 });
  ledger.sessions["s-aging"] = {
    lastSeen: 1,
    coverage: {},
    entries: [],
    /* 桶形状与投影逐桶一致（真实数据中桶必源自同样的步）——不一致会在
       「桶按聚合日入柱 + 逐桶余量」下产生幻影 token。 */
    buckets: [{ d: "2020-01-01", m: "deepseek-chat", p: "deepseek", w: null, u: usage(100, 300, 20, 50), n: 3 }]
  };
  const projection = { uncachedInputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 20, outputTokens: 50 };
  const expanded = expandRows([
    { ...listRow(), id: "s-full", projectionValues: { tokenUsage: projection } },
    { ...listRow(), id: "s-partial", projectionValues: { tokenUsage: projection } },
    { ...listRow(), id: "s-uncovered", projectionValues: { tokenUsage: projection } },
    { ...listRow(), id: "s-aging", projectionValues: { tokenUsage: projection } },
    { ...listRow(), id: "s-parent", projectionValues: { tokenUsage: projection } },
    { ...listRow(), id: "s-fork", parentId: "s-parent", projectionValues: { tokenUsage: projection } }
  ]);
  const forkIds = new Set(["s-fork"]);
  const views = aggregateLedgerViews(ledger, DEFAULT_PRICE_TABLE, expanded, forkIds);
  /* fork 副本无键（聚合排除）、s-uncovered 无键（从未覆盖）。 */
  assert.equal(views.dailyBucketsBySession.has("s-fork"), false);
  assert.equal(views.dailyBucketsBySession.has("s-uncovered"), false);
  const remainders = computeTrendRemainders(expanded, views.dailyBucketsBySession);
  /* s-partial 余量 200（470 − 270，逐桶投影子集）；s-aging 的老化桶按聚合日
     （2020-01-01）直接入柱（fix-ledger-storm 对账）→ 覆盖即全投影，无余量。 */
  assert.deepEqual(remainders.get("s-partial"), { inputTokens: 50, cacheReadTokens: 100, cacheWriteTokens: 20, outputTokens: 30 });
  assert.equal(remainders.has("s-aging"), false);
  assert.deepEqual(views.dailyBucketsBySession.get("s-aging"), usage(100, 300, 20, 50));
  assert.deepEqual(views.daily.get("2020-01-01")?.buckets, usage(100, 300, 20, 50));
  const trendRows = aggregateByTime(expanded, views.daily, views.coveredIds, { remainders, granularity: "year" });
  const trendTotal = trendRows.reduce((sum, item) => sum + item.total, 0);
  const kpi = aggregateKpi(expanded, [], null);
  /* 验收核心：趋势行合计 ≡ 投影合计 − fork 投影 ≡ KPI token 合计（5 × 470）。 */
  assert.equal(kpi.billedTotal, 5 * 470);
  assert.equal(trendTotal, kpi.billedTotal);
});

/* ---------------------------------------------------------------- *
 * fix-ledger-quota-budget：固化优先 + 总量预算 + 编码紧凑化（tasks 4.1/4.2）
 * ---------------------------------------------------------------- */

/** 容量上限 fake storage（模拟满盘：超限 setItem 抛错；removeItem 恒可用）。 */
function cappedFakeStorage(capBytes) {
  const map = new Map();
  const total = () => [...map.values()].reduce((sum, text) => sum + text.length, 0);
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      const text = String(value);
      const prev = map.has(key) ? map.get(key).length : 0;
      if (total() - prev + text.length > capBytes) throw new Error("quota exceeded");
      map.set(key, text);
    },
    removeItem: (key) => map.delete(key)
  };
}

/** 构造 n 步单轮会话（紧凑编码尺寸随 n 线性增长；startTime 缺省 null 保持尺寸确定）。 */
function fillSession(ledger, sid, n, { lastSeen, time }) {
  const steps = [];
  for (let i = 0; i < n; i++) steps.push(step(i, { time }));
  upsertSessionEntries(ledger, sid, [turnRow(1, steps)], { nowMs: lastSeen });
}

test("预算常量：固化窗口 2 天、水位 5MB 字符口径、headroom 256KB（design D1/D2）", () => {
  assert.equal(LEDGER_RAW_RETENTION_DAYS, 2);
  assert.equal(LEDGER_TOTAL_BUDGET_BYTES, 5 * 1024 * 1024);
  assert.equal(LEDGER_EVICT_HEADROOM_BYTES, 256 * 1024);
});

test("estimateLedgerBytes：分片尺寸缓存求和 + 索引/开销常数", () => {
  assert.equal(estimateLedgerBytes(new Map()), LEDGER_ESTIMATE_OVERHEAD_BYTES);
  assert.equal(estimateLedgerBytes(null), LEDGER_ESTIMATE_OVERHEAD_BYTES);
  const sizes = new Map([["a", 100], ["b", 200]]);
  assert.equal(estimateLedgerBytes(sizes), LEDGER_ESTIMATE_OVERHEAD_BYTES + 2 * LEDGER_ESTIMATE_INDEX_PER_SESSION_BYTES + 300);
});

test("尺寸缓存：loadLedger 预热、saveLedger 更新、persist 剔除幽灵项（design D3）", () => {
  const storage = fakeStorage();
  const sizes = new Map();
  const ledger = emptyLedger();
  upsertSessionEntries(ledger, "s1", [turnRow(1, [step(0)])], { nowMs: 5 });
  upsertSessionEntries(ledger, "s2", [turnRow(1, [step(0)])], { nowMs: 6 });
  assert.equal(saveLedger(storage, ledger, null, sizes), true);
  /* saveLedger 更新：缓存值 = 写入分片的真实字符数 */
  assert.equal(sizes.get("s1"), storage.getItem(ledgerSessionKeyV2("s1")).length);
  assert.equal(sizes.get("s2"), storage.getItem(ledgerSessionKeyV2("s2")).length);
  /* loadLedger 初始化：清空后按存储真实分片长度重预热 */
  const reloaded = loadLedger(storage, sizes);
  assert.deepEqual(reloaded, ledger);
  assert.equal(sizes.get("s1"), storage.getItem(ledgerSessionKeyV2("s1")).length);
  assert.equal(sizes.get("s2"), storage.getItem(ledgerSessionKeyV2("s2")).length);
  /* persist 卫生：已不存在的会话尺寸被剔除 */
  sizes.set("ghost", 99999);
  const result = persistLedger(storage, ledger, { nowMs: 1_700_000_100_000, activeIds: ["s1", "s2"], sizeCache: sizes });
  assert.equal(result.ok, true);
  assert.equal(sizes.has("ghost"), false);
  assert.equal(sizes.size, 2);
});

test("固化随成功持久化执行：窗口外卷桶、今日原始条目保留、座位仪表数据源不受影响、落盘往返一致", () => {
  const storage = fakeStorage();
  const ledger = emptyLedger();
  const now = Date.now();
  const old = now - (LEDGER_RAW_RETENTION_DAYS + 3) * 86_400_000;
  upsertSessionEntries(ledger, "s1", [
    turnRow(1, [step(0, { time: old, startTime: old })]),
    turnRow(2, [step(0, { time: now, startTime: now })])
  ], { nowMs: now });
  const result = persistLedger(storage, ledger, { nowMs: now, activeIds: ["s1"] });
  assert.equal(result.ok, true);
  assert.equal(result.aged, true);
  assert.equal(result.collapsed, 1); /* 常规固化窗口（2 天）外的步即卷桶 */
  assert.equal(result.evicted, false);
  /* 今日原始条目保留；窗口外步已卷桶 */
  assert.equal(ledger.sessions.s1.entries.length, 1);
  assert.equal(ledger.sessions.s1.buckets.length, 1);
  /* 座位仪表只读今日原始条目（ledgerTokensForDay 不含老化桶）：不受固化影响 */
  const dayTokens = ledgerTokensForDay(ledger, dayKeyOf(now));
  assert.deepEqual(dayTokens, usage(100, 50, 0, 20));
  /* 固化随保存落盘：重载逐值一致 */
  assert.deepEqual(loadLedger(storage), ledger);
});

test("ageLedger 返回 touchedSids：坍缩会话与 GC 会话均在集合内、无关会话不在（design D6）", () => {
  const ledger = emptyLedger();
  const now = Date.now();
  upsertSessionEntries(ledger, "old-sid", [turnRow(1, [step(0, { time: now - 10 * 86_400_000 })])], { nowMs: now });
  ledger.sessions["gc-sid"] = { lastSeen: now - (LEDGER_ORPHAN_GRACE_DAYS + 2) * 86_400_000, coverage: {}, entries: [], buckets: [] };
  ledger.sessions["untouched"] = { lastSeen: now, coverage: {}, entries: [], buckets: [] };
  const { collapsed, gcSessions, touchedSids } = ageLedger(ledger, { nowMs: now, activeIds: ["old-sid", "untouched"] });
  assert.equal(collapsed, 1);
  assert.equal(gcSessions, 1);
  assert.ok(touchedSids instanceof Set);
  assert.ok(touchedSids.has("old-sid"));
  assert.ok(touchedSids.has("gc-sid"));
  assert.equal(touchedSids.has("untouched"), false);
  assert.equal(ledger.sessions["gc-sid"], void 0);
});

test("persistLedger：固化 touchedSids 并入脏集——未在 changedSids 的会话分片也随保存落盘", () => {
  const storage = fakeStorage();
  const ledger = emptyLedger();
  const now = Date.now();
  const old = now - (LEDGER_RAW_RETENTION_DAYS + 3) * 86_400_000;
  upsertSessionEntries(ledger, "stale-sid", [turnRow(1, [step(0, { time: old })])], { nowMs: now });
  upsertSessionEntries(ledger, "changed-sid", [turnRow(1, [step(0, { time: now })])], { nowMs: now });
  assert.equal(saveLedger(storage, ledger, null), true);
  const staleShardBefore = storage.getItem(ledgerSessionKeyV2("stale-sid"));
  upsertSessionEntries(ledger, "changed-sid", [turnRow(2, [step(0, { time: now })])], { nowMs: now });
  const result = persistLedger(storage, ledger, { nowMs: now, activeIds: ["stale-sid", "changed-sid"], changedSids: ["changed-sid"] });
  assert.equal(result.ok, true);
  /* stale-sid 不在变化集，但固化使其实际变化 → 并入脏集随保存更新 */
  assert.notEqual(storage.getItem(ledgerSessionKeyV2("stale-sid")), staleShardBefore);
  const reloaded = loadLedger(storage);
  assert.equal(reloaded.sessions["stale-sid"].entries.length, 0);
  assert.equal(reloaded.sessions["stale-sid"].buckets.length, 1);
  assert.equal(reloaded.sessions["changed-sid"].entries.length, 2);
});

test("persistLedger：孤儿 GC 会话的分片键与索引条目随保存对账删除", () => {
  const storage = fakeStorage();
  const ledger = emptyLedger();
  const now = Date.now();
  const goneTime = now - (LEDGER_ORPHAN_GRACE_DAYS + 2) * 86_400_000;
  upsertSessionEntries(ledger, "gone", [turnRow(1, [step(0, { time: goneTime })])], { nowMs: goneTime });
  upsertSessionEntries(ledger, "live", [turnRow(1, [step(0, { time: now })])], { nowMs: now });
  assert.equal(saveLedger(storage, ledger, null), true);
  assert.ok(storage.getItem(ledgerSessionKeyV2("gone")) !== null);
  const result = persistLedger(storage, ledger, { nowMs: now, activeIds: ["live"] });
  assert.equal(result.ok, true);
  assert.equal(result.aged, true); /* GC 属于 aged（调用方重算聚合） */
  assert.equal(storage.getItem(ledgerSessionKeyV2("gone")), null); /* 分片键删除 */
  const reloaded = loadLedger(storage);
  assert.deepEqual(Object.keys(reloaded.sessions), ["live"]);
  const index = JSON.parse(storage.getItem(LEDGER_INDEX_KEY_V2));
  assert.deepEqual(Object.keys(index.sessions), ["live"]); /* 索引条目同步删除 */
});

test("persistLedger：未超水位时增量保存仍只写变化会话（4.2 零回归锁定）", () => {
  const storage = fakeStorage();
  const ledger = emptyLedger();
  const now = Date.now();
  upsertSessionEntries(ledger, "s1", [turnRow(1, [step(0, { time: now })])], { nowMs: now });
  upsertSessionEntries(ledger, "s2", [turnRow(1, [step(0, { time: now })])], { nowMs: now });
  assert.equal(saveLedger(storage, ledger, null), true);
  const s2Shard = storage.getItem(ledgerSessionKeyV2("s2"));
  const writes = [];
  const origSet = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    writes.push(key);
    origSet(key, value);
  };
  upsertSessionEntries(ledger, "s1", [turnRow(2, [step(0, { time: now })])], { nowMs: now });
  const result = persistLedger(storage, ledger, { nowMs: now, activeIds: ["s1", "s2"], changedSids: ["s1"] });
  storage.setItem = origSet;
  assert.equal(result.ok, true);
  assert.deepEqual(writes, [ledgerSessionKeyV2("s1"), LEDGER_INDEX_KEY_V2]); /* 变化分片 + 索引 */
  assert.equal(storage.getItem(ledgerSessionKeyV2("s2")), s2Shard); /* 未重写 */
});

test("水位触发全固化档：仅今日原始条目保留，重估后保存成功、无需逐出（design D4③）", () => {
  const storage = fakeStorage();
  const ledger = emptyLedger();
  const now = Date.now();
  const stale = now - 36 * 3_600_000; /* 36h 前：常规档（2 天）保留、全固化档（今日）卷桶 */
  fillSession(ledger, "s-old", 40, { lastSeen: now, time: stale });
  fillSession(ledger, "s-today", 10, { lastSeen: now, time: now });
  /* 估算超小水位 → 全固化档收缩 40 步 → 回到水位内 → 保存成功 */
  const result = persistLedger(storage, ledger, { nowMs: now, activeIds: ["s-old", "s-today"], budgetBytes: 3000, headroomBytes: 500 });
  assert.equal(result.ok, true);
  assert.equal(result.aged, true);
  assert.equal(result.collapsed, 40);
  assert.equal(result.evicted, false);
  assert.deepEqual(result.evictedSessions, []);
  assert.equal(ledger.sessions["s-old"].entries.length, 0);
  assert.equal(ledger.sessions["s-old"].buckets.length, 1);
  assert.equal(ledger.sessions["s-today"].entries.length, 10); /* 今日条目恒保留 */
  assert.deepEqual(loadLedger(storage), ledger);
});

test("逐出确定性：lastSeen 升序（0 视为最旧）整会话逐出至预算−headroom 内，分片键与索引对账清理（design D4④）", () => {
  const storage = fakeStorage();
  const ledger = emptyLedger();
  const now = Date.now();
  fillSession(ledger, "a", 20, { lastSeen: 0, time: now }); /* 0 视为最旧 */
  fillSession(ledger, "b", 20, { lastSeen: 100, time: now });
  fillSession(ledger, "c", 20, { lastSeen: 100, time: now }); /* 与 b 并列：稳定序 */
  fillSession(ledger, "d", 20, { lastSeen: now, time: now });
  const result = persistLedger(storage, ledger, { nowMs: now, activeIds: ["a", "b", "c", "d"], budgetBytes: 3000, headroomBytes: 500 });
  assert.equal(result.ok, true);
  assert.equal(result.aged, true);
  assert.equal(result.evicted, true);
  /* 今日条目全固化档无收缩空间 → 整会话逐出：a（0）→ b → c（lastSeen 升序，并列按插入序） */
  assert.deepEqual(result.evictedSessions, ["a", "b", "c"]);
  assert.deepEqual(Object.keys(ledger.sessions), ["d"]); /* 近期会话不受影响 */
  assert.equal(storage.getItem(ledgerSessionKeyV2("a")), null);
  assert.equal(storage.getItem(ledgerSessionKeyV2("b")), null);
  assert.equal(storage.getItem(ledgerSessionKeyV2("c")), null);
  assert.ok(storage.getItem(ledgerSessionKeyV2("d")) !== null);
  const index = JSON.parse(storage.getItem(LEDGER_INDEX_KEY_V2));
  assert.deepEqual(Object.keys(index.sessions), ["d"]);
  assert.deepEqual(loadLedger(storage), ledger);
});

test("满盘（配额按字节模拟）下收缩后保存成功：账本回到水位内、其他租户写入恢复（spec 满盘自愈）", () => {
  const storage = cappedFakeStorage(6000);
  const ledger = emptyLedger();
  const now = Date.now();
  const old = now - 5 * 86_400_000;
  fillSession(ledger, "s-old", 40, { lastSeen: old, time: old });
  fillSession(ledger, "s-today", 150, { lastSeen: now, time: now });
  /* 小水位注入：常规保存必失败，收缩阶梯自愈 */
  const result = persistLedger(storage, ledger, { nowMs: now, activeIds: ["s-old", "s-today"], budgetBytes: 5000, headroomBytes: 800 });
  assert.equal(result.ok, true);
  assert.equal(result.evicted, true);
  assert.deepEqual(result.evictedSessions, ["s-old", "s-today"]); /* 最旧优先 */
  assert.deepEqual(ledger.sessions, {});
  assert.equal(storage.getItem(ledgerSessionKeyV2("s-old")), null); /* 分片键对账清理 */
  assert.equal(storage.getItem(ledgerSessionKeyV2("s-today")), null);
  /* 收缩释放容量后，非账本租户（如月计划）的存储写入随之恢复 */
  storage.setItem("dsh-v-token-insight.plan.test", "x".repeat(2000));
  assert.ok(storage.getItem("dsh-v-token-insight.plan.test") !== null);
});

test("收缩后仍失败如实落内存模式：ok=false 与逐出披露字段如实（spec 收缩后仍失败）", () => {
  const storage = fakeStorage();
  storage.setItem = () => {
    throw new Error("quota");
  };
  const ledger = emptyLedger();
  const now = Date.now();
  fillSession(ledger, "s1", 20, { lastSeen: 0, time: now });
  fillSession(ledger, "s2", 20, { lastSeen: now, time: now });
  const result = persistLedger(storage, ledger, { nowMs: now, activeIds: ["s1", "s2"], budgetBytes: 2000, headroomBytes: 500 });
  assert.equal(result.ok, false);
  assert.equal(result.aged, true);
  assert.equal(result.evicted, true);
  assert.deepEqual(result.evictedSessions, ["s1", "s2"]);
  assert.equal(result.collapsed, 0); /* 今日条目无可固化 */
  /* 逐出已在内存账本生效（如实反映，披露由调用方呈现） */
  assert.deepEqual(ledger.sessions, {});
});

test("紧凑编码读写：分片收敛为 {字典, entries, buckets}、无 lastSeen/coverage 双写、重载逐值一致（design D5）", () => {
  const storage = fakeStorage();
  const ledger = emptyLedger();
  const now = 1_700_000_000_000;
  upsertSessionEntries(ledger, "s1", [
    turnRow(1, [step(0, { model: "m1" }), step(1, { model: "m1", startTime: now - 500 })]),
    turnRow(2, [step(0, { model: "m2" })])
  ], { nowMs: now });
  assert.equal(saveLedger(storage, ledger, null), true);
  const shard = JSON.parse(storage.getItem(ledgerSessionKeyV2("s1")));
  assert.deepEqual(Object.keys(shard).sort(), ["buckets", "c", "entries"]); /* 无 lastSeen/coverage 双写 */
  assert.deepEqual(shard.c, [["deepseek", "m1"], ["deepseek", "m2"]]); /* (p,m) 去重字典 */
  assert.ok(Array.isArray(shard.entries[0]));
  assert.equal(shard.entries[0].length, 7); /* st 缺席：偏移位省略 */
  assert.equal(shard.entries[1].length, 8); /* st 相对偏移在位 */
  assert.equal(shard.entries[1][7], -500);
  assert.equal(shard.entries[2][1], 1); /* 字典序号引用 */
  assert.deepEqual(loadLedger(storage), ledger); /* 重载逐值一致 */
});

test("旧格式双兼容：旧对象编码分片 + 索引权威元数据，读取逐值一致", () => {
  const storage = fakeStorage();
  storage.setItem(
    ledgerSessionKeyV2("legacy"),
    JSON.stringify({
      lastSeen: 99, /* 内嵌元数据被忽略：索引为权威 */
      coverage: { windowFull: false },
      entries: [{ k: "1:1", p: "p1", m: "m1", u: usage(10, 20, 0, 5), t: 1000, st: 900 }],
      buckets: [{ d: "2023-11-14", m: "m1", p: "p1", w: null, u: usage(7, 0, 0, 0), n: 1 }]
    })
  );
  storage.setItem(LEDGER_INDEX_KEY_V2, JSON.stringify({ v: 2, sessions: { legacy: { lastSeen: 7, coverage: { windowFull: true } } } }));
  const loaded = loadLedger(storage);
  assert.equal(loaded.sessions.legacy.lastSeen, 7);
  assert.deepEqual(loaded.sessions.legacy.coverage, { windowFull: true });
  assert.deepEqual(loaded.sessions.legacy.entries[0], { k: "1:1", p: "p1", m: "m1", u: usage(10, 20, 0, 5), t: 1000, st: 900 });
  assert.equal(loaded.sessions.legacy.buckets[0].n, 1);
});

test("旧格式双兼容：不含内嵌元数据的分片形态（索引为权威）", () => {
  const storage = fakeStorage();
  storage.setItem(
    ledgerSessionKeyV2("bare"),
    JSON.stringify({ entries: [{ k: "1:0", p: "p", m: "m", u: usage(1, 2, 3, 4), t: 10, st: null }], buckets: [] })
  );
  storage.setItem(LEDGER_INDEX_KEY_V2, JSON.stringify({ v: 2, sessions: { bare: { lastSeen: 42, coverage: { turnFrom: 1 } } } }));
  const loaded = loadLedger(storage);
  assert.equal(loaded.sessions.bare.lastSeen, 42);
  assert.deepEqual(loaded.sessions.bare.coverage, { turnFrom: 1 });
  assert.deepEqual(loaded.sessions.bare.entries[0], { k: "1:0", p: "p", m: "m", u: usage(1, 2, 3, 4), t: 10, st: null });
});

test("索引损坏枚举重建：紧凑分片 lastSeen 回退 0（元数据以索引为权威），条目逐值解码", () => {
  const storage = enumerableFakeStorage();
  storage.setItem(
    ledgerSessionKeyV2("compact"),
    JSON.stringify({ c: [["p2", "m2"]], entries: [["2:0", 0, 1, 2, 3, 4, 5000, -100]], buckets: [] })
  );
  storage.setItem(LEDGER_INDEX_KEY_V2, "{broken");
  const loaded = loadLedger(storage);
  assert.deepEqual(Object.keys(loaded.sessions), ["compact"]);
  assert.equal(loaded.sessions.compact.lastSeen, 0);
  assert.deepEqual(loaded.sessions.compact.entries[0], { k: "2:0", p: "p2", m: "m2", u: usage(1, 2, 3, 4), t: 5000, st: 4900 });
  /* GC 守卫：lastSeen 0（新近性未知）不因宽限期被孤儿 GC 误删——元数据缺失
     不得被放大为整本清除；体量由逐出阶梯兜底（0 视为最旧）。 */
  const { gcSessions } = ageLedger(loaded, { nowMs: Date.now(), activeIds: [] });
  assert.equal(gcSessions, 0);
});

test("导入双兼容：备份内条目为新旧编码均接受（task 2.2）", () => {
  const legacy = {
    v: 1,
    sessions: { a: { lastSeen: 1, coverage: {}, entries: [{ k: "1:0", p: "p", m: "m", u: usage(1, 0, 0, 0), t: 5, st: null }], buckets: [] } }
  };
  const compact = {
    v: 1,
    sessions: { b: { lastSeen: 2, coverage: {}, c: [["p", "m"]], entries: [["1:0", 0, 1, 0, 0, 0, 5]], buckets: [] } }
  };
  const fromLegacy = loadLedger({ getItem: () => JSON.stringify(legacy) });
  const fromCompact = loadLedger({ getItem: () => JSON.stringify(compact) });
  assert.deepEqual(fromLegacy.sessions.a.entries[0], { k: "1:0", p: "p", m: "m", u: usage(1, 0, 0, 0), t: 5, st: null });
  assert.deepEqual(fromCompact.sessions.b.entries[0], { k: "1:0", p: "p", m: "m", u: usage(1, 0, 0, 0), t: 5, st: null });
});

test("导出旧格式兼容：ledgerLegacyBackup 产物全为旧对象编码且可重载（task 2.2）", () => {
  const ledger = emptyLedger();
  const now = 1_700_000_000_000;
  upsertSessionEntries(ledger, "s1", [turnRow(1, [step(0, { startTime: now - 5 })])], { nowMs: now });
  const backup = ledgerLegacyBackup(ledger);
  for (const session of Object.values(backup.sessions)) {
    for (const entry of session.entries) {
      assert.equal(Array.isArray(entry), false); /* 旧对象编码 */
    }
  }
  assert.equal(backup.v, 1);
  assert.deepEqual(backup, ledger); /* 内存账本本就为旧编码：归一为恒等 */
  /* 旧格式导入路径接受新备份 */
  assert.deepEqual(loadLedger({ getItem: () => JSON.stringify(backup) }), ledger);
});
