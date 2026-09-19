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
  formatAxisMoney,
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

test("轮内混入无价目步 → 未定价步不计入，已定价步照常合计并标注原因", () => {
  const rows = [
    row(1, [
      step("deepseek-chat", usage({ inputTokens: 100_000 })),
      step("mystery-model", usage({ inputTokens: 100_000 }))
    ])
  ];
  const priced = priceTurnRows(rows, DEFAULT_PRICE_TABLE);
  assert.equal(priced[0].cost, 0.2); /* deepseek-chat 0.1M 输入 × ¥2/MTok；mystery-model 不计入 */
  assert.deepEqual(priced[0].unmatched, ["mystery-model:无价目"]);
});

test("空模型步（不可归因条目）→ 不计入费用，标注「未知模型」", () => {
  const rows = [
    row(1, [
      step("deepseek-chat", usage({ inputTokens: 100_000 })),
      step("", usage({ inputTokens: 100_000 }))
    ])
  ];
  const priced = priceTurnRows(rows, DEFAULT_PRICE_TABLE);
  assert.equal(priced[0].cost, 0.2);
  assert.deepEqual(priced[0].unmatched, ["未知模型:无价目"]);
});

test("整轮全部无价目 → cost = null（显示「未定价」）", () => {
  const rows = [row(1, [step("mystery-model", usage({ inputTokens: 100_000 }))])];
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

test("formatAxisMoney：三档位——≥1 整数化、0<c<1 至多 4 位小数剥尾零、0 → ¥0（rework-kpi-charts 任务 1.3）", () => {
  /* ≥1：整数化剥 .00 尾缀（既有行为不变）。 */
  assert.equal(formatAxisMoney(50, "CNY"), "¥50");
  assert.equal(formatAxisMoney(50.4, "CNY"), "¥50");
  /* 0<c<1：至多 4 位小数剥尾零——MUST NOT 取整坍缩为 ¥0.0000。 */
  assert.equal(formatAxisMoney(0.3, "CNY"), "¥0.3");
  assert.equal(formatAxisMoney(0.05, "CNY"), "¥0.05");
  assert.equal(formatAxisMoney(0.2500001, "CNY"), "¥0.25");
  /* 0 → ¥0（渲染侧零刻度本就不出文本）。 */
  assert.equal(formatAxisMoney(0, "CNY"), "¥0");
  /* 非有限兜底走 formatMoney。 */
  assert.equal(formatAxisMoney(NaN, "CNY"), "¥—");
});

test("validatePriceTable：合法表保留，结构损坏返回 null", () => {
  assert.ok(validatePriceTable(DEFAULT_PRICE_TABLE).length === 20);
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

/* ------------------------------------------------------------------ *
 * DeepSeek 2026-09-16 调价固化
 * （来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/）
 * 现行模型名 deepseek-flash 空闲 0.02/1/4、高峰 ×2；旧名 v4-flash 系同价；
 * deepseek-v4-pro 本次单价未变。价格是纯数据，这里钉住以防回归误改。
 * ------------------------------------------------------------------ */

test("DEFAULT_PRICE_TABLE：deepseek-flash 空闲 0.02/1/4、高峰 ×2（2026-09-16 官方调价）", () => {
  const entry = matchPriceEntry(DEFAULT_PRICE_TABLE, "deepseek-flash");
  assert.ok(entry, "现行模型名 deepseek-flash 必须有价目条目（否则真实会话全部「无价目」）");
  assert.deepEqual(entry.defaultTier, { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 });

  /* 三桶各 1M：空闲 ¥(1+0.02+4) = ¥5.02；高峰 ×2 = ¥10.04。 */
  const oneMtokEach = usage({
    inputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    outputTokens: 1_000_000
  });
  const peak = new Date(2026, 8, 16, 10, 0); /* 周三 10:00，落在 09:00–12:00 高峰窗 */
  assert.equal(timeMultiplier(entry, peak), 2);
  const peakCost = stepCost(entry, oneMtokEach, { time: peak }).cost;
  assert.ok(Math.abs(peakCost - 10.04) < 1e-9, `高峰应为 ¥10.04，实得 ${peakCost}`);

  const offPeak = new Date(2026, 8, 16, 13, 0); /* 周三 13:00，窗口之外 */
  assert.equal(timeMultiplier(entry, offPeak), 1);
  const offCost = stepCost(entry, oneMtokEach, { time: offPeak }).cost;
  assert.ok(Math.abs(offCost - 5.02) < 1e-9, `空闲应为 ¥5.02，实得 ${offCost}`);
});

test("DEFAULT_PRICE_TABLE：旧名 v4-flash / v4-flash-vision-exp 与 Flash 同价（官方仍接受并按 Flash 计费）", () => {
  const flash = matchPriceEntry(DEFAULT_PRICE_TABLE, "deepseek-flash");
  for (const legacy of ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
    const entry = matchPriceEntry(DEFAULT_PRICE_TABLE, legacy);
    assert.ok(entry, `${legacy} 必须保留独立条目（历史步骤折算；网关仍可能回传旧名）`);
    assert.equal(entry.model, legacy, `${legacy} 应命中自身条目`);
    assert.deepEqual(entry.defaultTier, flash.defaultTier, `${legacy} 应与 Flash 同价`);
    assert.deepEqual(entry.timeWindows, flash.timeWindows);
  }
});

test("DEFAULT_PRICE_TABLE：deepseek-v4-pro 本次调价未变（空闲 0.15/4.5/13.5，高峰 ×2）", () => {
  const entry = matchPriceEntry(DEFAULT_PRICE_TABLE, "deepseek-v4-pro");
  assert.ok(entry);
  assert.deepEqual(entry.defaultTier, { input: 4.5, cacheRead: 0.15, cacheWrite: 0, output: 13.5 });
  assert.equal(timeMultiplier(entry, new Date(2026, 8, 16, 10, 0)), 2);
});

test("DEFAULT_PRICE_TABLE：币种与停用别名不受调价影响", () => {
  /* 显示币种取首条目；新增 deepseek-flash 不得挤到首位。 */
  assert.equal(DEFAULT_PRICE_TABLE[0].model, "deepseek-chat");
  assert.equal(displayCurrencyOf(DEFAULT_PRICE_TABLE), "CNY");
  /* 停用别名（deepseek-chat / deepseek-reasoner）保留旧价仅用于历史折算。 */
  for (const retired of ["deepseek-chat", "deepseek-reasoner"]) {
    const entry = matchPriceEntry(DEFAULT_PRICE_TABLE, retired);
    assert.deepEqual(entry.defaultTier, { input: 2, cacheRead: 0.2, cacheWrite: 0, output: 3 });
  }
});

/* ------------------------------------------------------------------ *
 * 智谱 bigmodel 调价固化
 * （来源：https://docs.bigmodel.cn/cn/guide/start/pricing）
 * glm-5.3-flash 的 5 折限时价 2026-09-09 到期，已恢复刊例价。
 * ------------------------------------------------------------------ */

test("DEFAULT_PRICE_TABLE：glm-5.3-flash 恢复刊例价 0.8/0.23/2.8（促销已到期）", () => {
  const entry = matchPriceEntry(DEFAULT_PRICE_TABLE, "glm-5.3-flash");
  assert.ok(entry);
  assert.deepEqual(entry.defaultTier, { input: 0.8, cacheRead: 0.23, cacheWrite: 0, output: 2.8 });
});

test("DEFAULT_PRICE_TABLE：智谱主力模型默认档与官方刊例一致", () => {
  const expected = {
    "glm-5.3": { input: 8, cacheRead: 2, cacheWrite: 0, output: 28 },
    "glm-5.2": { input: 8, cacheRead: 2, cacheWrite: 0, output: 28 },
    "glm-5.1": { input: 6, cacheRead: 1.3, cacheWrite: 0, output: 24 },
    "glm-5": { input: 4, cacheRead: 1, cacheWrite: 0, output: 18 },
    "glm-5-turbo": { input: 5, cacheRead: 1.2, cacheWrite: 0, output: 22 },
    "glm-4.7-flashx": { input: 0.5, cacheRead: 0.1, cacheWrite: 0, output: 3 }
  };
  for (const [model, tier] of Object.entries(expected)) {
    assert.deepEqual(matchPriceEntry(DEFAULT_PRICE_TABLE, model).defaultTier, tier, model);
  }
});

test("DEFAULT_PRICE_TABLE：智谱 ≥32K 输入高档（glm-5.1 / 5 / 5-turbo）", () => {
  const expected = {
    "glm-5.1": { minContextTokens: 32768, input: 8, cacheRead: 2, cacheWrite: 0, output: 28 },
    "glm-5": { minContextTokens: 32768, input: 6, cacheRead: 1.5, cacheWrite: 0, output: 22 },
    "glm-5-turbo": { minContextTokens: 32768, input: 7, cacheRead: 1.8, cacheWrite: 0, output: 26 }
  };
  for (const [model, tier] of Object.entries(expected)) {
    const entry = matchPriceEntry(DEFAULT_PRICE_TABLE, model);
    assert.deepEqual(resolveTier(entry, { contextTokens: 32768 - 1 }), entry.defaultTier, `${model} 32K 以下走默认档`);
    assert.deepEqual(resolveTier(entry, { contextTokens: 32768 }), tier, `${model} 恰 32K 命中高档`);
  }
});
