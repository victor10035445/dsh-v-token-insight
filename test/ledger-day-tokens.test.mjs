/**
 * dsh-v-token-insight — 座位速度仪表当日合计纯函数（add-seat-speed-ring 任务 1.2）。
 *
 * 固化 design D2 的口径承诺：
 *  - `ledgerTokensForDay`：原始条目按 `st ?? t` 归日直接求和当日四桶——
 *    当日合计 / 跨天边界 / fork 剔除 / 未定价步计入 token / 老化桶不计入 / 空账本；
 *  - 与 `aggregateLedgerViews().daily` 的同日桶**同值**（同条目源、同归日定义、
 *    同 fork 剔除规则）——「仪表读数 = 总览趋势今日桶」的等价性断言；
 *  - `seatSpeedGauge`：投影比公式（design D1）——用户示例验算（计划 100、18 点、
 *    耗 20 → 26.7% → 悬停 27%）、凌晨 1h 下限、150% 满格、无标尺/无数据返回 null。
 *
 * 确定性约定：全部时刻取本地时区墙钟锚定（同 test/ledger-seed.mjs）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { aggregateLedgerViews, emptyLedger, ledgerTokensForDay, seatSpeedGauge, upsertSessionEntries } from "../src/ledger.mjs";
import { totalTokens } from "../src/rows-aggregate.mjs";
import { SEED_TABLE, buildSeedLedger, seedExpandedRows, seedForkIds } from "./ledger-seed.mjs";

/** 本地墙钟锚定时刻。 */
const at = (day, h, min) => new Date(2026, 0, day, h, min, 0, 0).getTime();
const usage = (input, cacheRead, cacheWrite, output) => ({
  inputTokens: input,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
  outputTokens: output
});
const step = (idx, over = {}) => ({
  step: idx,
  provider: "deepseek",
  model: "deepseek-chat",
  usage: over.usage ?? usage(100, 0, 0, 20),
  time: over.time,
  startTime: over.startTime === void 0 ? over.time : over.startTime
});
const turnRow = (turn, steps) => ({ turn, steps });

test("当日合计：当日四桶直接求和（st 在场 / st=null 回退 t）", () => {
  const ledger = emptyLedger();
  upsertSessionEntries(
    ledger,
    "s-a",
    [
      turnRow(1, [step(0, { usage: usage(1_000, 200, 30, 40), time: at(10, 9, 0), startTime: at(10, 9, 0) })]),
      /* st=null → 回退 t，仍归当日 */
      turnRow(2, [step(0, { usage: usage(500, 0, 0, 60), time: at(10, 18, 0), startTime: null })])
    ],
    { windowFull: true, nowMs: at(10, 18, 0) }
  );
  upsertSessionEntries(
    ledger,
    "s-b",
    [turnRow(1, [step(0, { usage: usage(10, 0, 5, 1), time: at(10, 23, 59), startTime: at(10, 23, 59) })])],
    { windowFull: true, nowMs: at(10, 23, 59) }
  );
  assert.deepEqual(ledgerTokensForDay(ledger, "2026-01-10"), usage(1_510, 200, 35, 101));
});

test("跨天边界：23:59 与次日 00:00 分属两日（dayKey 归属）", () => {
  const ledger = emptyLedger();
  upsertSessionEntries(
    ledger,
    "s-a",
    [
      turnRow(1, [step(0, { usage: usage(100, 0, 0, 10), time: at(10, 23, 59), startTime: at(10, 23, 59) })]),
      turnRow(2, [step(0, { usage: usage(200, 0, 0, 20), time: at(11, 0, 0), startTime: at(11, 0, 0) })])
    ],
    { windowFull: true, nowMs: at(11, 0, 0) }
  );
  assert.deepEqual(ledgerTokensForDay(ledger, "2026-01-10"), usage(100, 0, 0, 10));
  assert.deepEqual(ledgerTokensForDay(ledger, "2026-01-11"), usage(200, 0, 0, 20));
  assert.deepEqual(ledgerTokensForDay(ledger, "2026-01-12"), usage(0, 0, 0, 0));
});

test("fork 剔除：excludeIds 会话不计入当日合计", () => {
  const ledger = buildSeedLedger();
  /* seed day1 原始条目：s-live(2M/200k/0/100k) + s-unpriced(100k) + s-currency(50k) + s-fork(同 s-live day1)。 */
  const withFork = ledgerTokensForDay(ledger, "2026-01-10");
  assert.deepEqual(withFork, usage(4_150_000, 400_000, 0, 200_000));
  const withoutFork = ledgerTokensForDay(ledger, "2026-01-10", seedForkIds());
  assert.deepEqual(withoutFork, usage(2_150_000, 200_000, 0, 100_000));
});

test("未定价步照常计入 token；老化聚合桶不计入（原始条目口径）", () => {
  const ledger = buildSeedLedger();
  /* s-unpriced（无价目模型）与 s-currency（币种不符）的 token 都计入； */
  const day1 = ledgerTokensForDay(ledger, "2026-01-10", seedForkIds());
  assert.equal(day1.inputTokens, 2_150_000); /* 含 s-unpriced 100k + s-currency 50k */
  /* s-aged 的 2026-01-10 老化桶（2M/500k/0/300k）不入当日合计——今日条目永不老化。 */
  assert.deepEqual(day1, usage(2_150_000, 200_000, 0, 100_000));
});

test("空账本：全零且不抛错", () => {
  assert.deepEqual(ledgerTokensForDay(emptyLedger(), "2026-01-10"), usage(0, 0, 0, 0));
  assert.deepEqual(ledgerTokensForDay(emptyLedger(), "2026-01-10", new Set(["x"])), usage(0, 0, 0, 0));
});

test("与 aggregateLedgerViews().daily 同日桶同值（条目按步日 + 老化桶按聚合日的复合口径）", () => {
  const ledger = buildSeedLedger();
  const forkIds = seedForkIds();
  const views = aggregateLedgerViews(ledger, SEED_TABLE, seedExpandedRows(), forkIds);
  assert.ok(views.daily.size >= 2);
  /* 期望值独立重算：原始条目按 st ?? t 归日 + 老化桶按聚合日入柱（fork 剔除）——
     fix-ledger-storm 对账：趋势 token 与费用线（账面价逐日，含桶日期）同基。 */
  const expected = new Map();
  const addDay = (day, u) => {
    let bucket = expected.get(day);
    if (bucket === void 0) {
      bucket = usage(0, 0, 0, 0);
      expected.set(day, bucket);
    }
    bucket.inputTokens += u.inputTokens ?? 0;
    bucket.cacheReadTokens += u.cacheReadTokens ?? 0;
    bucket.cacheWriteTokens += u.cacheWriteTokens ?? 0;
    bucket.outputTokens += u.outputTokens ?? 0;
  };
  for (const [sid, session] of Object.entries(ledger.sessions)) {
    if (forkIds.has(sid)) continue;
    for (const entry of session.entries ?? []) addDay(dayKeyOfShim(entry.st ?? entry.t), entry.u);
    for (const bucket of session.buckets ?? []) addDay(bucket.d, bucket.u);
  }
  assert.deepEqual(
    new Map([...views.daily].map(([day, value]) => [day, value.buckets])),
    expected
  );
  /* 账本中出现过的每一天（条目日或桶日）都被 views.daily 覆盖（无第二份口径的暗日）。 */
  for (const day of expected.keys()) assert.ok(views.daily.has(day), `views.daily 缺 ${day}`);
});

test("今日等价（仪表读数 = 趋势今日桶）：今日条目永不老化，无桶日两口径同值", () => {
  const now = Date.now();
  const ledger = emptyLedger();
  upsertSessionEntries(
    ledger,
    "s-a",
    [turnRow(1, [step(0, { usage: usage(1_000, 200, 30, 40), time: now, startTime: now })])],
    { windowFull: true, nowMs: now }
  );
  const views = aggregateLedgerViews(ledger, SEED_TABLE, [], new Set());
  const today = dayKeyOfShim(now);
  assert.deepEqual(ledgerTokensForDay(ledger, today), views.daily.get(today)?.buckets);
});

/** 测试内联日键（与 dayKeyOf 同式，避免为断言引入被测模块外的实现漂移）。 */
function dayKeyOfShim(ms) {
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

test("用户示例验算（design D1）：计划 100、18 点、耗 20 → 26.7% → 悬停 27%", () => {
  const gauge = seatSpeedGauge(20, 18, 100);
  assert.equal(Math.round(gauge.r * 1000) / 10, 26.7);
  assert.equal(gauge.speedPct, 27);
  /* 填充前沿落在 0–25% 与 25–50% 分区交界附近：r=26.7% → 轨道 17.8% ≈ 16.7% 交界。 */
  assert.ok(Math.abs(gauge.fillPct - 17.8) <= 0.5);
});

test("分区落位（design D4）：25%→16.7、50%→33.3、100%→66.7（最绿点）、≥150%→满格", () => {
  const fillOf = (total, plan = 100, hours = 24) => seatSpeedGauge(total, hours, plan).fillPct;
  assert.ok(Math.abs(fillOf(25) - 16.7) <= 0.5);
  assert.ok(Math.abs(fillOf(50) - 33.3) <= 0.5);
  assert.ok(Math.abs(fillOf(100) - 66.7) <= 0.5);
  assert.equal(fillOf(150), 100);
  assert.equal(fillOf(300), 100);
});

test("凌晨下限与无标尺/无数据：小时 <1 按 1 计；total ≤ 0 或计划非正 → null（不渲染）", () => {
  /* 00:30 首笔 20 token、计划 100：已过小时按下限 1 → r = 480%。 */
  const gauge = seatSpeedGauge(20, 0.5, 100);
  assert.equal(gauge.speedPct, 480);
  assert.equal(gauge.fillPct, 100);
  assert.equal(seatSpeedGauge(0, 18, 100), null);
  assert.equal(seatSpeedGauge(-1, 18, 100), null);
  assert.equal(seatSpeedGauge(20, 18, 0), null); /* 计划绝不被当作 0 参与计算 */
  assert.equal(seatSpeedGauge(20, 18, Number.NaN), null);
  assert.equal(totalTokens(ledgerTokensForDay(emptyLedger(), "2026-01-10")), 0);
});
