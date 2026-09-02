/**
 * dsh-v-token-insight — pricing.mjs 单测（tasks 5.1）。
 * 覆盖：档位边界（恰 128k）、跨午夜边界（23:00/08:30 端点）、多模型累计分档、
 * 币种混合（不符步判未定价）、未定价不猜价、中断步不计费、formatMoney。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PRICE_TABLE,
  displayCurrencyOf,
  formatMoney,
  matchPriceEntry,
  priceTurnRows,
  promptTokens,
  resolveTier,
  stepCost,
  timeMultiplier,
  validatePriceTable
} from "../src/pricing.mjs";

const usage = (over = {}) => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...over
});

/** 构造一步（foldTurns 行 steps 的最小形状）。 */
const step = (model, usage, extra = {}) => ({
  provider: null,
  model,
  usage,
  time: extra.time ?? null,
  startTime: extra.startTime ?? null
});

const row = (turn, steps, extra = {}) => ({
  turn,
  startTime: 0,
  endTime: 0,
  title: `t${turn}`,
  steps,
  usage: steps.reduce(
    (acc, s) => ({
      inputTokens: acc.inputTokens + (s.usage?.inputTokens ?? 0),
      cacheReadTokens: acc.cacheReadTokens + (s.usage?.cacheReadTokens ?? 0),
      cacheWriteTokens: acc.cacheWriteTokens + (s.usage?.cacheWriteTokens ?? 0),
      outputTokens: acc.outputTokens + (s.usage?.outputTokens ?? 0)
    }),
    { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
  ),
  hasUsage: steps.some((s) => s.usage),
  models: [...new Set(steps.map((s) => s.model).filter(Boolean))],
  ...extra
});

/* ---------------------------------------------------------------- *
 * 条目匹配：精确 > 最长前缀
 * ---------------------------------------------------------------- */

test("精确匹配压过通配", () => {
  const table = [
    { model: "deepseek-*", currency: "CNY", defaultTier: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 }, tiers: [], timeWindows: [], discount: 1 },
    { model: "deepseek-chat", currency: "USD", defaultTier: { input: 9, cacheRead: 0, cacheWrite: 0, output: 9 }, tiers: [], timeWindows: [], discount: 1 }
  ];
  assert.equal(matchPriceEntry(table, "deepseek-chat").currency, "USD");
  assert.equal(matchPriceEntry(table, "deepseek-r2").model, "deepseek-*");
});

test("最长前缀胜出", () => {
  const table = [
    { model: "deepseek-*", currency: "CNY", defaultTier: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 }, tiers: [], timeWindows: [], discount: 1 },
    { model: "deepseek-chat-v2*", currency: "USD", defaultTier: { input: 2, cacheRead: 0, cacheWrite: 0, output: 2 }, tiers: [], timeWindows: [], discount: 1 }
  ];
  assert.equal(matchPriceEntry(table, "deepseek-chat-v2-exp").model, "deepseek-chat-v2*");
});

test("provider 限定：留空匹配任意路由，非空必须相等", () => {
  const table = [
    { model: "m1", provider: "volc", currency: "CNY", defaultTier: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 }, tiers: [], timeWindows: [], discount: 1 }
  ];
  assert.equal(matchPriceEntry(table, "m1", "volc"), table[0]);
  assert.equal(matchPriceEntry(table, "m1", "other"), null);
});

test("无匹配返回 null（不猜价）", () => {
  assert.equal(matchPriceEntry(DEFAULT_PRICE_TABLE, "gpt-99"), null);
});

/* ---------------------------------------------------------------- *
 * 分档：恰 128k 边界 / 双维度 / defaultTier 兜底
 * ---------------------------------------------------------------- */

const tieredEntry = {
  model: "tiered",
  currency: "CNY",
  defaultTier: { input: 2, cacheRead: 0.2, cacheWrite: 0, output: 3 },
  tiers: [{ minContextTokens: 128_000, input: 4, cacheRead: 0.4, cacheWrite: 0, output: 8 }],
  timeWindows: [],
  discount: 1
};

test("恰 128k 命中高档（>= 语义），60k 留在默认档", () => {
  const at = resolveTier(tieredEntry, { contextTokens: 128_000 });
  const below = resolveTier(tieredEntry, { contextTokens: 127_999 });
  const low = resolveTier(tieredEntry, { contextTokens: 60_000 });
  assert.equal(at.input, 4);
  assert.equal(below.input, 2);
  assert.equal(low.input, 2);
});

test("双维度档需同时满足；无声明阈值维度不拦截", () => {
  const entry = {
    ...tieredEntry,
    tiers: [{ minContextTokens: 100_000, minCumulativeTokens: 500_000, input: 9, cacheRead: 0, cacheWrite: 0, output: 9 }]
  };
  assert.equal(resolveTier(entry, { contextTokens: 150_000, cumulativeTokens: 100_000 }).input, 2);
  assert.equal(resolveTier(entry, { contextTokens: 150_000, cumulativeTokens: 500_000 }).input, 9);
});

test("promptTokens = 三桶输入之和（桶互斥）", () => {
  assert.equal(promptTokens(usage({ inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 12 })), 42);
});

/* ---------------------------------------------------------------- *
 * 时段折扣：跨午夜端点（23:00 含 / 08:30 不含）
 * ---------------------------------------------------------------- */

const windowEntry = {
  model: "w",
  currency: "CNY",
  defaultTier: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
  tiers: [],
  timeWindows: [{ from: "23:00", to: "08:30", multiplier: 0.5 }],
  discount: 1
};

const at = (h, m) => new Date(2026, 0, 1, h, m);

test("跨午夜窗口：02:00 命中 0.5×，12:00 不受影响", () => {
  assert.equal(timeMultiplier(windowEntry, at(2, 0)), 0.5);
  assert.equal(timeMultiplier(windowEntry, at(12, 0)), 1);
});

test("端点：23:00 落入窗口（from 含），08:30 不落入（to 不含）", () => {
  assert.equal(timeMultiplier(windowEntry, at(23, 0)), 0.5);
  assert.equal(timeMultiplier(windowEntry, at(8, 30)), 1);
  assert.equal(timeMultiplier(windowEntry, at(8, 29)), 0.5);
});

test("时段折扣优先步请求开始时刻，缺失回退落盘时刻（priceTurnRows 内实现）", () => {
  // 请求开始 02:00（半价），落盘 12:00 → 应按 02:00 计
  const rows = [
    row(1, [
      step("w", usage({ inputTokens: 1_000_000 }), { time: at(12, 0).getTime(), startTime: at(2, 0).getTime() })
    ])
  ];
  const priced = priceTurnRows(rows, [windowEntry]);
  assert.equal(priced[0].cost, 0.5);
  // 无 startTime → 回退落盘 12:00 → 全价
  const rows2 = [
    row(1, [step("w", usage({ inputTokens: 1_000_000 }), { time: at(12, 0).getTime(), startTime: null })])
  ];
  assert.equal(priceTurnRows(rows2, [windowEntry])[0].cost, 1);
});

/* ---------------------------------------------------------------- *
 * 逐步计费 + 累计分档
 * ---------------------------------------------------------------- */

const cumulativeEntry = {
  model: "bulk",
  currency: "CNY",
  defaultTier: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
  tiers: [{ minCumulativeTokens: 1_000_000, input: 0.5, cacheRead: 0, cacheWrite: 0, output: 0.5 }],
  timeWindows: [],
  discount: 1
};

test("累计分档随步递推：跨过阈值后的步用高档（不含当前步）", () => {
  const rows = [
    row(1, [step("bulk", usage({ inputTokens: 600_000 }))]),
    row(2, [step("bulk", usage({ inputTokens: 600_000 }))])
  ];
  const priced = priceTurnRows(rows, [cumulativeEntry]);
  // 第 1 步累计 0 → 默认档 1/M → 0.6；第 2 步累计 600k < 1M → 仍默认档
  assert.ok(Math.abs(priced[0].cost - 0.6) < 1e-9);
  assert.ok(Math.abs(priced[1].cost - 0.6) < 1e-9);
  const rows2 = [
    ...rows,
    row(3, [step("bulk", usage({ inputTokens: 100_000 }))])
  ];
  const priced2 = priceTurnRows(rows2, [cumulativeEntry]);
  // 第 3 步前累计 1.2M ≥ 1M → 高档 0.5/M → 0.05
  assert.ok(Math.abs(priced2[2].cost - 0.05) < 1e-9);
});

test("多模型累计分档互不混计", () => {
  const rows = [
    row(1, [step("bulk", usage({ inputTokens: 900_000 }))]),
    row(2, [step("other", usage({ inputTokens: 2_000_000 }))]),
    row(3, [step("bulk", usage({ inputTokens: 200_000 }))])
  ];
  const priced = priceTurnRows(rows, [cumulativeEntry, {
    model: "other", currency: "CNY",
    defaultTier: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
    tiers: [], timeWindows: [], discount: 1
  }]);
  // bulk: 900k(默认 0.9) → 200k(累计 900k < 1M 默认 0.2)
  assert.ok(Math.abs(priced[0].cost - 0.9) < 1e-9);
  assert.ok(Math.abs(priced[2].cost - 0.2) < 1e-9);
});

test("中断/失败步（无 usage）不计费、不破坏轮聚合", () => {
  const rows = [
    row(1, [
      step("bulk", null),
      step("bulk", usage({ inputTokens: 500_000 }))
    ])
  ];
  const priced = priceTurnRows(rows, [cumulativeEntry]);
  assert.ok(Math.abs(priced[0].cost - 0.5) < 1e-9);
  assert.equal(priced[0].stepPrices[0], null);
});

test("reasoning 已含于输出，不重复计价（桶字段不含 reasoning 单价）", () => {
  const result = stepCost(
    { model: "m", currency: "CNY", defaultTier: { input: 1, cacheRead: 0, cacheWrite: 0, output: 2 }, tiers: [], timeWindows: [], discount: 1 },
    usage({ outputTokens: 1_000_000, reasoningTokens: 999_999 })
  );
  assert.ok(Math.abs(result.cost - 2) < 1e-9);
});

/* ---------------------------------------------------------------- *
 * 未定价 / 币种一致性
 * ---------------------------------------------------------------- */

test("轮内混入无价目步 → 该轮未定价并标注模型", () => {
  const rows = [
    row(1, [
      step("deepseek-chat", usage({ inputTokens: 100_000 })),
      step("mystery-model", usage({ inputTokens: 100_000 }))
    ])
  ];
  const priced = priceTurnRows(rows, DEFAULT_PRICE_TABLE);
  assert.equal(priced[0].cost, null);
  assert.deepEqual(priced[0].unmatched, ["mystery-model:无价目"]);
});

test("币种混合：显示币种取首条目，不符步判未定价（币种不符）", () => {
  const table = [
    { model: "cny-m", currency: "CNY", defaultTier: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 }, tiers: [], timeWindows: [], discount: 1 },
    { model: "usd-m", currency: "USD", defaultTier: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 }, tiers: [], timeWindows: [], discount: 1 }
  ];
  const rows = [
    row(1, [step("cny-m", usage({ inputTokens: 1_000_000 }))]),
    row(2, [step("usd-m", usage({ inputTokens: 1_000_000 }))])
  ];
  const priced = priceTurnRows(rows, table);
  assert.equal(displayCurrencyOf(table), "CNY");
  assert.ok(Math.abs(priced[0].cost - 1) < 1e-9);
  assert.equal(priced[1].cost, null);
  assert.deepEqual(priced[1].unmatched, ["usd-m:币种不符(USD)"]);
});

test("空轮（无步）cost = 0 而非未定价", () => {
  const priced = priceTurnRows([row(1, [])], DEFAULT_PRICE_TABLE);
  assert.equal(priced[0].cost, 0);
});

/* ---------------------------------------------------------------- *
 * formatMoney / validatePriceTable
 * ---------------------------------------------------------------- */

test("formatMoney：≥1 两位小数，小金额四位，未知币种无符号", () => {
  assert.equal(formatMoney(1.5, "CNY"), "¥1.50");
  assert.equal(formatMoney(0.0144, "CNY"), "¥0.0144");
  assert.equal(formatMoney(2, "USD"), "$2.00");
  assert.equal(formatMoney(3, "EUR"), "3.00");
  assert.equal(formatMoney(NaN, "CNY"), "¥—");
});

test("validatePriceTable：合法表保留，结构损坏返回 null", () => {
  assert.ok(validatePriceTable(DEFAULT_PRICE_TABLE).length === 19);
  assert.equal(validatePriceTable("nope"), null);
  assert.equal(validatePriceTable([]), null);
  assert.equal(validatePriceTable([{ model: "" }]), null);
  const cleaned = validatePriceTable([
    { model: " m1 ", currency: "usd", defaultTier: { input: "x" }, tiers: [{ minContextTokens: "oops" }], timeWindows: [{ from: "99:99", to: "08:00", multiplier: 1 }], discount: -3 }
  ]);
  assert.equal(cleaned.length, 1);
  assert.equal(cleaned[0].model, "m1");
  assert.equal(cleaned[0].currency, "USD");
  assert.equal(cleaned[0].defaultTier.input, 0);
  assert.equal(cleaned[0].tiers.length, 0);
  assert.equal(cleaned[0].timeWindows.length, 0);
  assert.equal(cleaned[0].discount, 1);
});
