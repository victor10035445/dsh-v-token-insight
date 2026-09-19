/**
 * dsh-v-token-insight — 固定 seed 账本夹具（perf-hot-path-optimization 任务 1.1）。
 *
 * 用途：把 `aggregateLedgerViews` + `priceDailyCost` 在该夹具上的当前输出固化为
 * 基线快照（test/fixtures/ledger-baseline.json），供「两遍路径 vs 单遍产物」
 * 等价性测试对照（任务 1.2/3.3）——重构只许改变「何时算、算几遍」，
 * 不许改变「算出什么」。
 *
 * 确定性约定：全部时刻取「本地时区墙钟锚定」（new Date(y, m, d, h, min)）——
 * 日键（dayKeyOf）与时段折扣窗口命中在任意时区都按同一本地墙钟取值，
 * 基线快照跨机器稳定；老化/比较用的 nowMs 一律显式传入。
 *
 * 覆盖面：多会话、多模型、累计分档漂移（L2）、时段折扣跨午夜窗口（L3）、
 * startTime 缺失回退落盘时刻、老化聚合桶、未定价（无价目 / 币种不符）、
 * 空模型待修复条目（R2 修复路径）、fork 分支副本（排除）、部分覆盖
 * （windowFull=false + deepTruncated）、仅 lastSeen 的在册空会话。
 */
import { emptyLedger, upsertSessionEntries, recordDeepCoverage } from "../src/ledger.mjs";

/** seed 价目表：覆盖累计分档（deepseek-chat）、时段折扣（跨午夜）、币种不符（usd-model）。 */
export const SEED_TABLE = [
  {
    model: "deepseek-chat",
    provider: "",
    currency: "CNY",
    unit: "MTok",
    defaultTier: { input: 2, cacheRead: 0.2, cacheWrite: 0, output: 3 },
    tiers: [{ minCumulativeTokens: 1_000_000, input: 1, cacheRead: 0.1, cacheWrite: 0, output: 1.5 }],
    timeWindows: [{ from: "23:00", to: "08:30", multiplier: 0.5 }],
    discount: 1
  },
  {
    model: "glm-5.3-flash",
    provider: "",
    currency: "CNY",
    unit: "MTok",
    defaultTier: { input: 0.4, cacheRead: 0.115, cacheWrite: 0, output: 1.4 },
    tiers: [],
    timeWindows: [],
    discount: 1
  },
  {
    model: "usd-model",
    provider: "",
    currency: "USD",
    unit: "MTok",
    defaultTier: { input: 1, cacheRead: 0.1, cacheWrite: 0, output: 2 },
    tiers: [],
    timeWindows: [],
    discount: 1
  }
];

/** 本地墙钟锚定时刻（day1 = 2026-01-10）。 */
const at = (day, h, min) => new Date(2026, 0, day, h, min, 0, 0).getTime();
export const SEED_TIMES = {
  day1Am: at(10, 9, 0), /* 2026-01-10 09:00 · 折扣窗口外（×1） */
  day1Night: at(10, 23, 30), /* 2026-01-10 23:30 · 命中 23:00–08:30（×0.5） */
  day2Early: at(11, 8, 0), /* 2026-01-11 08:00 · 跨午夜窗口命中（×0.5） */
  day2Noon: at(11, 12, 0) /* 2026-01-11 12:00 · 窗口外（×1） */
};

const usage = (input, cacheRead, cacheWrite, output) => ({
  inputTokens: input,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
  outputTokens: output
});

/** 折叠行形状（与 foldTurns/foldHistoryEvents 产物同形的最小输入）。 */
const step = (idx, over = {}) => ({
  step: idx,
  provider: over.provider ?? "deepseek",
  model: over.model ?? "deepseek-chat",
  usage: over.usage ?? usage(100, 0, 0, 20),
  time: over.time ?? SEED_TIMES.day1Am,
  startTime: over.startTime === void 0 ? over.time ?? SEED_TIMES.day1Am : over.startTime
});
const turnRow = (turn, steps) => ({ turn, steps });

/**
 * 构建 seed 账本（插入序 = Object.keys 遍历序，等价性测试依赖稳定次序）。
 * @returns {v:1, sessions} 内存账本（形状与既有语义一致）。
 */
export function buildSeedLedger() {
  const ledger = emptyLedger();

  /* s-live：原始条目 · 累计分档漂移（第 2 步跨 1M 阈值翻档）+ 时段折扣（×1）+ st 缺失回退 */
  upsertSessionEntries(
    ledger,
    "s-live",
    [
      turnRow(1, [
        step(0, { usage: usage(1_000_000, 0, 0, 100_000), time: SEED_TIMES.day1Am, startTime: SEED_TIMES.day1Am }),
        step(1, { usage: usage(1_000_000, 200_000, 0, 0), time: SEED_TIMES.day1Am, startTime: SEED_TIMES.day1Am })
      ]),
      turnRow(2, [step(0, { provider: "zhipu", model: "glm-5.3-flash", usage: usage(500_000, 0, 0, 1_000_000), time: SEED_TIMES.day2Noon, startTime: null })])
    ],
    { windowFull: true, nowMs: SEED_TIMES.day2Noon }
  );

  /* s-aged：老化聚合桶（含折扣窗口命中）+ 少量原始条目 + 部分覆盖 */
  upsertSessionEntries(
    ledger,
    "s-aged",
    [turnRow(3, [step(0, { usage: usage(250_000, 0, 0, 50_000), time: SEED_TIMES.day2Noon, startTime: null })])],
    { windowFull: false, nowMs: SEED_TIMES.day2Noon }
  );
  recordDeepCoverage(ledger, "s-aged", { fromSeq: 5, toSeq: 100, truncated: true }, { nowMs: SEED_TIMES.day2Noon });
  ledger.sessions["s-aged"].buckets.push(
    { d: "2026-01-10", m: "deepseek-chat", p: "deepseek", w: { from: "23:00", to: "08:30" }, u: usage(2_000_000, 500_000, 0, 300_000), n: 5 },
    { d: "2026-01-11", m: "glm-5.3-flash", p: "zhipu", w: null, u: usage(0, 0, 0, 2_000_000), n: 3 }
  );

  /* s-unpriced：无价目模型 → 整会话 cost=null（原因如实披露） */
  upsertSessionEntries(
    ledger,
    "s-unpriced",
    [turnRow(1, [step(0, { model: "unknown-model", usage: usage(100_000, 0, 0, 0), time: SEED_TIMES.day1Am, startTime: SEED_TIMES.day1Am })])],
    { windowFull: true, nowMs: SEED_TIMES.day1Am }
  );

  /* s-currency：命中条目币种不符（USD ≠ 显示币种 CNY）→ 未定价披露 */
  upsertSessionEntries(
    ledger,
    "s-currency",
    [turnRow(1, [step(0, { model: "usd-model", usage: usage(50_000, 0, 0, 0), time: SEED_TIMES.day1Night, startTime: SEED_TIMES.day1Night })])],
    { windowFull: true, nowMs: SEED_TIMES.day1Night }
  );

  /* s-repair：模型名为空的不可归因条目（旧版本遗留；R2 定向修复路径的回归点） */
  ledger.sessions["s-repair"] = {
    lastSeen: SEED_TIMES.day1Am,
    coverage: { turnFrom: 1, turnTo: 1, windowFull: false },
    entries: [{ k: "1:0", p: "deepseek", m: "", u: usage(80_000, 0, 0, 20_000), t: SEED_TIMES.day2Noon, st: null }],
    buckets: []
  };

  /* s-fork：fork 分支副本（与 s-live 同源种子消耗；聚合时经 excludeIds 排除） */
  upsertSessionEntries(
    ledger,
    "s-fork",
    [
      turnRow(1, [
        step(0, { usage: usage(1_000_000, 0, 0, 100_000), time: SEED_TIMES.day1Am, startTime: SEED_TIMES.day1Am }),
        step(1, { usage: usage(1_000_000, 200_000, 0, 0), time: SEED_TIMES.day1Am, startTime: SEED_TIMES.day1Am })
      ]),
      turnRow(2, [step(0, { provider: "zhipu", model: "glm-5.3-flash", usage: usage(500_000, 0, 0, 1_000_000), time: SEED_TIMES.day2Noon, startTime: null })])
    ],
    { windowFull: true, nowMs: SEED_TIMES.day2Noon }
  );

  /* s-empty：仅 lastSeen 的在册空会话（孤儿 GC 的在册标记语义） */
  ledger.sessions["s-empty"] = { lastSeen: SEED_TIMES.day2Noon, coverage: {}, entries: [], buckets: [] };

  return ledger;
}

/** fork 排除集（aggregateLedgerViews 的 excludeIds）。 */
export function seedForkIds() {
  return new Set(["s-fork"]);
}

/** Tier 0 展开行（「未分类」余量的输入；覆盖：全量覆盖/部分覆盖/不在账本/空会话/fork）。 */
export function seedExpandedRows() {
  return [
    { id: "s-live", usage: usage(3_000_000, 0, 0, 0), hasUsage: true },
    { id: "s-aged", usage: usage(0, 0, 0, 4_000_000), hasUsage: true },
    { id: "s-unpriced", usage: usage(150_000, 0, 0, 0), hasUsage: true },
    { id: "s-currency", usage: usage(50_000, 0, 0, 0), hasUsage: true },
    { id: "s-repair", usage: usage(80_000, 0, 0, 20_000), hasUsage: true },
    { id: "s-not-in-ledger", usage: usage(70_000, 30_000, 0, 10_000), hasUsage: true },
    { id: "s-fork", usage: usage(2_500_000, 200_000, 0, 1_100_000), hasUsage: true },
    { id: "s-empty", usage: usage(40_000, 0, 0, 0), hasUsage: true }
  ];
}

/* ------------------------------------------------------------------ *
 * 序列化（Map → 平面对象，供基线 JSON 快照与 deepEqual 比较）
 * ------------------------------------------------------------------ */

export function serializeViews(views) {
  return {
    bySession: Object.fromEntries(
      [...views.bySession].map(([sid, priced]) => [
        sid,
        {
          covered: priced.covered,
          cost: priced.cost,
          currency: priced.currency,
          unmatched: priced.unmatched,
          coverage: priced.coverage,
          byModel: Object.fromEntries([...priced.byModel].map(([model, agg]) => [model, { cost: agg.cost, tokens: agg.tokens }]))
        }
      ])
    ),
    byModel: views.byModel.map((row) => ({
      model: row.model,
      provider: row.provider,
      buckets: row.buckets,
      total: row.total,
      currency: row.currency,
      unmatched: row.unmatched,
      cost: row.cost,
      avgCost: row.avgCost
    })),
    daily: Object.fromEntries([...views.daily].map(([day, bucket]) => [day, bucket.buckets])),
    coveredIds: [...views.coveredIds].sort(),
    anyCovered: views.anyCovered
  };
}

export function serializeDaily(daily) {
  return Object.fromEntries([...daily].map(([day, value]) => [day, { cost: value.cost, currency: value.currency }]));
}
