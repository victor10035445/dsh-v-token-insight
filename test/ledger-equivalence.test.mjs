/**
 * dsh-v-token-insight — 账本聚合等价性护栏（perf-hot-path-optimization 任务 1.1/1.2/3.3/3.4/3.5）。
 *
 * 语义不变承诺的固化：固定 seed 账本（test/ledger-seed.mjs）上，
 *  - 基线快照（test/fixtures/ledger-baseline.json）= 重构前「两遍路径」
 *    （aggregateLedgerViews + priceDailyCost 各自全量重放）的输出，生成后冻结；
 *  - 任务 3 重构后：aggregateLedgerViews / priceDailyCost 改为消费逐会话计价产物
 *    （单遍重放 + 缓存），本文件把产物路径与基线快照逐值对照（含未定价原因、
 *    按日桶、按模型归因、未分类余量、浮点求和次序），并保留两遍对照实现
 *    priceDailyCostTwoPass 做双实现互证。
 * 重构只许改变「何时算、算几遍」，不许改变「算出什么」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  aggregateLedgerViews,
  ageLedger,
  clearAllLedger,
  clearSessionLedger,
  createPriceCache,
  priceArtifactOf,
  priceDailyCost,
  priceDailyCostTwoPass,
  upsertSessionEntries
} from "../src/ledger.mjs";
import {
  SEED_TABLE,
  buildSeedLedger,
  seedExpandedRows,
  seedForkIds,
  serializeDaily,
  serializeViews
} from "./ledger-seed.mjs";

const BASELINE = JSON.parse(readFileSync(new URL("./fixtures/ledger-baseline.json", import.meta.url), "utf8"));

/** 用当前实现产出 seed 的序列化视图 + 日费用。 */
function computeActual() {
  const ledger = buildSeedLedger();
  const views = aggregateLedgerViews(ledger, SEED_TABLE, seedExpandedRows(), seedForkIds());
  const daily = priceDailyCost(ledger, SEED_TABLE);
  return { ledger, views, daily };
}

/* ---------------------------------------------------------------- *
 * 任务 1.1：基线快照（固化当前输出）
 * ---------------------------------------------------------------- */

test("1.1 基线快照：seed 夹具上 aggregateLedgerViews 输出与基线逐值相等", () => {
  const { views } = computeActual();
  assert.deepEqual(serializeViews(views), BASELINE.views);
});

test("1.1 基线快照：seed 夹具上 priceDailyCost 输出与基线逐值相等", () => {
  const { daily } = computeActual();
  assert.deepEqual(serializeDaily(daily), BASELINE.daily);
});

/* ---------------------------------------------------------------- *
 * 任务 1.2：等价性测试骨架（先以现状两遍实现互证，供任务 3 重构后对照）
 * ---------------------------------------------------------------- */

/** 两遍路径参照：重构后为保留的对照实现 priceDailyCostTwoPass；重构前回落到当时的 priceDailyCost。 */
const twoPassDaily = (ledger, table) =>
  typeof priceDailyCostTwoPass === "function" ? priceDailyCostTwoPass(ledger, table) : priceDailyCost(ledger, table);
const twoPassViews = (ledger, table, expanded, excludeIds) => aggregateLedgerViews(ledger, table, expanded, excludeIds);

test("1.2 等价性骨架：两遍路径（对照实现）与基线快照逐值相等", () => {
  const views = twoPassViews(buildSeedLedger(), SEED_TABLE, seedExpandedRows(), seedForkIds());
  assert.deepEqual(serializeViews(views), BASELINE.views);
  assert.deepEqual(serializeDaily(twoPassDaily(buildSeedLedger(), SEED_TABLE)), BASELINE.daily);
});

/* ---------------------------------------------------------------- *
 * 任务 3.3：单遍产物路径 vs 基线（含未定价原因 / 按日桶 / 按模型归因 / 未分类余量）
 * ---------------------------------------------------------------- */

test("3.3 单遍产物路径：aggregateLedgerViews（产物消费）与基线逐值相等", () => {
  const ledger = buildSeedLedger();
  const views = aggregateLedgerViews(ledger, SEED_TABLE, seedExpandedRows(), seedForkIds(), createPriceCache(), 1);
  assert.deepEqual(serializeViews(views), BASELINE.views);
});

test("3.3 单遍产物路径：priceDailyCost（产物组装）与基线 / 两遍对照逐值相等", () => {
  const daily = priceDailyCost(buildSeedLedger(), SEED_TABLE, createPriceCache(), 1);
  assert.deepEqual(serializeDaily(daily), BASELINE.daily);
  assert.deepEqual(serializeDaily(daily), serializeDaily(twoPassDaily(buildSeedLedger(), SEED_TABLE)));
});

test("3.3 等价性专项：未定价原因 / 累计分档漂移 / 老化桶 / fork 去重 / 未分类余量", () => {
  const { views } = computeActual();
  /* 未定价原因：无价目 / 币种不符 / 空模型（未知模型） */
  assert.deepEqual(views.bySession.get("s-unpriced").unmatched, ["unknown-model:无价目"]);
  assert.deepEqual(views.bySession.get("s-currency").unmatched, ["usd-model:币种不符(USD)"]);
  assert.deepEqual(views.bySession.get("s-repair").unmatched, ["未知模型:无价目"]);
  assert.equal(views.bySession.get("s-unpriced").cost, null);
  /* 累计分档漂移：s-live 第 2 步跨 1M 阈值翻档（2.3 + 1.02）；glm 桶外时段 ×1 */
  assert.equal(views.bySession.get("s-live").cost, 4.92);
  assert.equal(views.bySession.get("s-live").byModel.get("deepseek-chat").cost, 3.32);
  /* 老化桶计费：s-aged = 条目 0.65 + 夜窗桶 2.5（×0.5）+ glm 桶 2.8
     （期望值按同一求和次序书写，浮点逐位一致） */
  assert.equal(views.bySession.get("s-aged").cost, 0.65 + 2.5 + 2.8);
  /* fork 副本不进模型/日聚合，但 bySession 行保留供逐行查看 */
  assert.ok(views.bySession.get("s-fork").covered);
  assert.equal(views.coveredIds.has("s-fork"), false);
  const classified = views.byModel.find((row) => row.model === "deepseek-chat");
  assert.equal(classified.cost, 6.47); /* 只计 s-live + s-aged */
  const unclassified = views.byModel.find((row) => row.model === null);
  assert.equal(unclassified.total, 2_350_000); /* Tier0 − 账本覆盖（逐桶截 0） */
});

/* ---------------------------------------------------------------- *
 * 任务 3.1/3.4：priceArtifactOf 缓存语义（签名 / 价目版本 / 增量重算）
 * ---------------------------------------------------------------- */

test("3.1 priceArtifactOf：签名与价目版本未变 → 产物引用相等（不重算）", () => {
  const ledger = buildSeedLedger();
  const cache = createPriceCache();
  const first = priceArtifactOf(ledger, "s-live", SEED_TABLE, cache, 1);
  const second = priceArtifactOf(ledger, "s-live", SEED_TABLE, cache, 1);
  assert.equal(second, first);
});

test("3.4 价目版本变化 → 全量失效，按新价目重算", () => {
  const ledger = buildSeedLedger();
  const cache = createPriceCache();
  const before = priceArtifactOf(ledger, "s-live", SEED_TABLE, cache, 1);
  assert.equal(before.priced.cost, 4.92);
  const doubled = SEED_TABLE.map((entry) => ({
    ...entry,
    defaultTier: Object.fromEntries(Object.entries(entry.defaultTier).map(([key, value]) => [key, value * 2]))
  }));
  const after = priceArtifactOf(ledger, "s-live", doubled, cache, 2);
  assert.notEqual(after, before);
  /* 仅 defaultTier 翻倍：第 1/3 步按默认档翻倍（4.6 + 3.2）；第 2 步命中 tiers
     高档（未翻倍）保持 1.02 → 合计 8.82。 */
  assert.equal(after.priced.cost, 8.82);
  /* 会话缓存槽位记录最新 (sig, tableVersion)：切回旧版本即按旧价重算（不残留新价产物） */
  const backToV1 = priceArtifactOf(ledger, "s-live", SEED_TABLE, cache, 1);
  assert.notEqual(backToV1, after);
  assert.equal(backToV1.priced.cost, 4.92);
  assert.equal(priceArtifactOf(ledger, "s-live", SEED_TABLE, cache, 1), backToV1);
});

test("3.4 流式沉淀只重算变化会话：未变会话产物引用不变", () => {
  const ledger = buildSeedLedger();
  const cache = createPriceCache();
  aggregateLedgerViews(ledger, SEED_TABLE, seedExpandedRows(), seedForkIds(), cache, 1);
  const liveBefore = priceArtifactOf(ledger, "s-live", SEED_TABLE, cache, 1);
  const agedBefore = priceArtifactOf(ledger, "s-aged", SEED_TABLE, cache, 1);
  /* 流式沉淀：仅 s-live 追加一步 */
  upsertSessionEntries(
    ledger,
    "s-live",
    [
      {
        turn: 9,
        steps: [
          {
            step: 0,
            provider: "deepseek",
            model: "deepseek-chat",
            usage: { inputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000 },
            time: 1_700_000_000_000,
            startTime: null
          }
        ]
      }
    ],
    { windowFull: null, nowMs: 1_700_000_100_000 }
  );
  const liveAfter = priceArtifactOf(ledger, "s-live", SEED_TABLE, cache, 1);
  const agedAfter = priceArtifactOf(ledger, "s-aged", SEED_TABLE, cache, 1);
  assert.notEqual(liveAfter, liveBefore); /* 变化会话重算 */
  assert.equal(agedAfter, agedBefore); /* 未变会话命中缓存 */
  /* 重聚合复用未变会话的产物（priced 行引用保持） */
  const views = aggregateLedgerViews(ledger, SEED_TABLE, seedExpandedRows(), seedForkIds(), cache, 1);
  assert.equal(views.bySession.get("s-aged"), agedBefore.priced);
});

test("3.4 R2 专项：定向修复仅回填模型名 → 签名变化、会话费用恢复", () => {
  const ledger = buildSeedLedger();
  const cache = createPriceCache();
  const before = priceArtifactOf(ledger, "s-repair", SEED_TABLE, cache, 1);
  assert.equal(before.priced.cost, null); /* 空模型 → 整会话「未定价」 */
  assert.deepEqual(before.priced.unmatched, ["未知模型:无价目"]);
  /* 修复路径：仅回填 m（其余字段全不变——v1 的「数值滚动和」签名方案在此必然碰撞） */
  ledger.sessions["s-repair"].entries[0].m = "deepseek-chat";
  const after = priceArtifactOf(ledger, "s-repair", SEED_TABLE, cache, 1);
  assert.notEqual(after, before); /* 标识性内容进哈希 → 签名必须变化 → 重算 */
  assert.equal(after.priced.cost, 0.22); /* (80k×2 + 20k×3)/1e6，费用恢复 */
  assert.deepEqual(after.priced.unmatched, []);
});

/* ---------------------------------------------------------------- *
 * 任务 3.5：缓存失效卫生（清除 / GC / 导入替换）
 * ---------------------------------------------------------------- */

test("3.5 clearSessionLedger / clearAllLedger 同步失效对应缓存；清除后重算正常", () => {
  const ledger = buildSeedLedger();
  const cache = createPriceCache();
  aggregateLedgerViews(ledger, SEED_TABLE, seedExpandedRows(), seedForkIds(), cache, 1);
  assert.ok(cache.size > 0);
  clearSessionLedger(ledger, "s-live", cache);
  assert.equal(cache.has("s-live"), false);
  assert.ok(cache.has("s-aged"));
  clearAllLedger(ledger, cache);
  assert.equal(cache.size, 0);
  const views = aggregateLedgerViews(ledger, SEED_TABLE, seedExpandedRows(), seedForkIds(), cache, 1);
  assert.equal(views.anyCovered, false);
});

test("3.5 孤儿 GC 删除会话时显式失效缓存；重算后正常", () => {
  const ledger = buildSeedLedger();
  const cache = createPriceCache();
  aggregateLedgerViews(ledger, SEED_TABLE, seedExpandedRows(), seedForkIds(), cache, 1);
  const { gcSessions } = ageLedger(ledger, { nowMs: Date.now(), activeIds: ["s-live"], cache });
  assert.ok(gcSessions >= 1);
  assert.equal(cache.has("s-empty"), false);
  assert.equal(ledger.sessions["s-empty"], void 0);
  const views = aggregateLedgerViews(ledger, SEED_TABLE, seedExpandedRows(), seedForkIds(), cache, 1);
  assert.equal(views.bySession.has("s-empty"), false);
  assert.ok(views.bySession.has("s-live"));
});
