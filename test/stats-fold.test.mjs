/**
 * dsh-v-token-insight — stats-fold.mjs 单测（tasks 5.1）。
 * 覆盖：formatTokens 边界（999_499→999k / 999_500→1.00M）、loadOlder 前后
 * 累计分档漂移、轮标题（steering 不覆盖、compaction 不选为标题）、
 * 无 usage 步不计聚合、TTFT/吞吐口径、投影双形状 billedInputTokens、
 * 价目损坏回退（price-store）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  billedInputTokens,
  cacheHitPercent,
  foldTurns,
  formatTokens,
  joinRequestInsights,
  sumUsage
} from "../src/stats-fold.mjs";
import { priceTurnRows } from "../src/pricing.mjs";
import { PRICE_STORE_KEY, loadPriceTable, savePriceTable } from "../src/price-store.mjs";
import { DEFAULT_PRICE_TABLE } from "../src/pricing.mjs";

/* ---------------------------------------------------------------- *
 * formatTokens 边界
 * ---------------------------------------------------------------- */

test("formatTokens 边界：999_499→999k，999_500→1.00M", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1.0k");
  assert.equal(formatTokens(9800), "9.8k");
  assert.equal(formatTokens(999_499), "999k");
  assert.equal(formatTokens(999_500), "1.00M");
  assert.equal(formatTokens(1_234_567), "1.23M");
  assert.equal(formatTokens(undefined), "0");
});

/* ---------------------------------------------------------------- *
 * 节点构造辅助
 * ---------------------------------------------------------------- */

const userNode = (text, time) => ({ kind: "user", seq: 1, time, content: [{ type: "text", text }] });
const steerNode = (text, time) => ({ kind: "steering", messageId: "m", seq: 2, time, content: [{ type: "text", text }] });
const compactionNode = (time) => ({
  kind: "compaction", seq: 3, time, summary: "压缩摘要", summaryEventSeq: 9,
  shadowedItemCount: 10, shadowedTokenCount: 12345
});
const assistantNode = (turn, stepIdx, over = {}) => ({
  kind: "assistant",
  seq: 10 + stepIdx,
  time: over.time ?? 1_000,
  turn,
  step: stepIdx,
  blocks: [],
  ...over
});

/* ---------------------------------------------------------------- *
 * 折叠语义
 * ---------------------------------------------------------------- */

test("一轮一行：标题取首个用户文本，steering 不覆盖标题", () => {
  const nodes = [
    userNode("帮我统计这个月的开销", 100),
    assistantNode(1, 1, { provenance: { provider: "deepseek", model: "deepseek-chat" }, usage: { inputTokens: 10, outputTokens: 20 } }),
    steerNode("顺便把图表也画了", 150),
    assistantNode(1, 2, { provenance: { provider: "deepseek", model: "deepseek-reasoner" }, usage: { inputTokens: 30, outputTokens: 40 } })
  ];
  const rows = foldTurns(nodes);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].turn, 1);
  assert.equal(rows[0].title, "帮我统计这个月的开销");
  assert.deepEqual(rows[0].models, ["deepseek-chat", "deepseek-reasoner"]);
  assert.equal(rows[0].usage.inputTokens, 40);
  assert.equal(rows[0].usage.outputTokens, 60);
  assert.equal(rows[0].startTime, 100);
  assert.equal(rows[0].endTime, 1_000);
});

test("无用户文本时回退「（第 N 轮）」", () => {
  const rows = foldTurns([assistantNode(7, 1, {})]);
  assert.equal(rows[0].title, "（第 7 轮）");
});

test("压缩检查点（compaction）与上下文注入不选为轮标题、不产生明细行（tasks 1.6）", () => {
  const nodes = [
    userNode("真实问题", 100),
    assistantNode(1, 1, { provenance: { provider: "p", model: "m" }, usage: { inputTokens: 5, outputTokens: 6 } }),
    compactionNode(200),
    { kind: "context", seq: 4, time: 210, content: [{ type: "text", text: "系统注入，不是用户输入" }] },
    assistantNode(2, 1, { provenance: { provider: "p", model: "m" }, usage: { inputTokens: 7, outputTokens: 8 } })
  ];
  const rows = foldTurns(nodes);
  assert.equal(rows.length, 2);
  // 第 2 轮无新 user 文本 → 回退轮号标题，绝不吸收 compaction/上下文文本
  assert.equal(rows[1].title, "（第 2 轮）");
});

test("无 usage 步计入轮存在但不计入 token 聚合", () => {
  const nodes = [
    userNode("q", 100),
    assistantNode(1, 1, { interrupted: true, provenance: { provider: "p", model: "m" } }),
    assistantNode(1, 2, { provenance: { provider: "p", model: "m" }, usage: { inputTokens: 10, outputTokens: 5 } })
  ];
  const rows = foldTurns(nodes);
  assert.equal(rows[0].steps.length, 2);
  assert.equal(rows[0].hasUsage, true);
  assert.equal(rows[0].usage.inputTokens, 10);
  assert.equal(rows[0].steps[0].usage, null);
  assert.equal(rows[0].steps[0].interrupted, true);
});

test("纯命令轮（无 assistant 步）不产生明细行", () => {
  const rows = foldTurns([userNode("/compact", 100), compactionNode(200)]);
  assert.equal(rows.length, 0);
});

test("TTFT 取最低 step 读数；吞吐 = Σ输出 ÷ Σ解码（官方 deriveTurnMetrics 口径）", () => {
  const nodes = [
    assistantNode(1, 2, {
      time: 1_000,
      timing: { stepStartTime: 0, firstTokenTime: 500, completedTime: 1_500 },
      usage: { inputTokens: 1, outputTokens: 100 }
    }),
    assistantNode(1, 1, {
      time: 900,
      timing: { stepStartTime: 0, firstTokenTime: 200, completedTime: 800 },
      usage: { inputTokens: 1, outputTokens: 200 }
    })
  ];
  const rows = foldTurns(nodes);
  assert.equal(rows[0].ttftMs, 200);
  // Σdecode = 300 + 1000? step1 decode = 800-200=600, step2 decode = 1500-500=1000 → 1600ms
  assert.equal(rows[0].decodeMs, 1600);
  assert.equal(rows[0].decodeTokens, 300);
  assert.ok(Math.abs(rows[0].tokensPerSecond - 300 / 1.6) < 1e-9);
});

test("requestConfig 已报告项被采集，缺省项省略（2.6）", () => {
  const nodes = [
    assistantNode(1, 1, {
      requestConfig: { provider: "ds", model: "deepseek-chat", purpose: "agent", temperature: 0.7, stop: ["END"] }
    })
  ];
  const rows = foldTurns(nodes);
  assert.deepEqual(rows[0].steps[0].requestConfig, { provider: "ds", model: "deepseek-chat", purpose: "agent", temperature: 0.7, stop: ["END"] });
});

/* ---------------------------------------------------------------- *
 * 聚合与投影形状
 * ---------------------------------------------------------------- */

test("sumUsage 汇总窗口四桶", () => {
  const rows = foldTurns([
    userNode("q", 1),
    assistantNode(1, 1, { usage: { inputTokens: 1, outputTokens: 2 } }),
    assistantNode(1, 2, { usage: { cacheReadTokens: 3, cacheWriteTokens: 4, outputTokens: 5 } })
  ]);
  const totals = sumUsage(rows);
  assert.deepEqual(totals, { inputTokens: 1, cacheReadTokens: 3, cacheWriteTokens: 4, outputTokens: 7 });
});

test("billedInputTokens 双形状：节点 inputTokens / 投影 uncachedInputTokens", () => {
  assert.equal(billedInputTokens({ inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30 }), 60);
  assert.equal(billedInputTokens({ uncachedInputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30 }), 60);
});

test("cacheHitPercent：命中 / 计费输入；无输入 null", () => {
  assert.equal(cacheHitPercent({ uncachedInputTokens: 25, cacheReadTokens: 75, cacheWriteTokens: 0 }), 75);
  assert.equal(cacheHitPercent({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), null);
});

/* ---------------------------------------------------------------- *
 * loadOlder 前后累计分档漂移（规格「窗口增长引起累计分档重算」）
 * ---------------------------------------------------------------- */

const bulkEntry = {
  model: "bulk",
  currency: "CNY",
  defaultTier: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
  tiers: [{ minCumulativeTokens: 1_000_000, input: 0.5, cacheRead: 0, cacheWrite: 0, output: 0.5 }],
  timeWindows: [],
  discount: 1
};

function windowRows(turnCount, tokensPerTurn) {
  const nodes = [];
  let turn = 1;
  for (let i = 0; i < turnCount; i++, turn++) {
    nodes.push(userNode(`问题 ${turn}`, i * 1_000));
    nodes.push(
      assistantNode(turn, 1, {
        time: i * 1_000 + 500,
        provenance: { provider: "p", model: "bulk" },
        usage: { inputTokens: tokensPerTurn, outputTokens: 0 }
      })
    );
  }
  return foldTurns(nodes);
}

test("loadOlder 漂移：窗口后移使同轮累计分档键增大并翻档重算", () => {
  // 每轮 600k：窗口 [3,4]（2 轮）→ 第 4 轮步前累计 600k < 1M → 默认档 0.6
  const tail = windowRows(4, 600_000).filter((r) => r.turn >= 3);
  const before = priceTurnRows(tail, [bulkEntry]);
  assert.ok(Math.abs(before[1].cost - 0.6) < 1e-9);
  // loadOlder 后窗口 [1..4]（4 轮）→ 第 4 轮步前累计 1.8M ≥ 1M → 高档 0.3
  const full = windowRows(4, 600_000);
  const after = priceTurnRows(full, [bulkEntry]);
  assert.ok(Math.abs(after[3].cost - 0.3) < 1e-9);
});

/* ---------------------------------------------------------------- *
 * 价目持久化：损坏回退（规格「存储损坏回退」）
 * ---------------------------------------------------------------- */

function fakeStorage(initial) {
  const map = new Map(initial ? [[PRICE_STORE_KEY, initial]] : []);
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key)
  };
}

test("缺省/损坏/非法存储均回退内置默认表，不抛错", () => {
  assert.deepEqual(loadPriceTable(fakeStorage(null)), DEFAULT_PRICE_TABLE);
  assert.deepEqual(loadPriceTable(fakeStorage("{oops")), DEFAULT_PRICE_TABLE);
  assert.deepEqual(loadPriceTable(fakeStorage('{"not":"an array"}')), DEFAULT_PRICE_TABLE);
  assert.deepEqual(loadPriceTable(fakeStorage("[]")), DEFAULT_PRICE_TABLE);
});

test("合法存储读回保存的表；写入非法表被拒绝", () => {
  const storage = fakeStorage();
  const table = [{ model: "custom", currency: "USD", defaultTier: { input: 1, cacheRead: 0, cacheWrite: 0, output: 2 }, tiers: [], timeWindows: [], discount: 1 }];
  assert.equal(savePriceTable(storage, table), true);
  const loaded = loadPriceTable(storage);
  assert.equal(loaded[0].model, "custom");
  assert.equal(savePriceTable(storage, []), false);
});

/* ---------------------------------------------------------------- *
 * joinRequestInsights：trajectory requests → 每步模型/路由/调用参数
 * ---------------------------------------------------------------- */

test("join 按 (turn, step) 补全 model/provider/requestConfig，并重算 models", () => {
  const rows = foldTurns([
    userNode("q", 1),
    assistantNode(1, 1, { usage: { inputTokens: 10, outputTokens: 5 }, messageId: "m1" }),
    assistantNode(1, 2, { usage: { inputTokens: 10, outputTokens: 5 }, messageId: "m2" })
  ]);
  const requests = [
    { purpose: "assistant", turn: 1, step: 1, provenance: { provider: "ds", model: "deepseek-chat" }, requestConfig: { provider: "ds", model: "deepseek-chat", temperature: 0.7 } },
    { purpose: "assistant", turn: 1, step: 2, provenance: { provider: "ds", model: "deepseek-reasoner" } }
  ];
  const joined = joinRequestInsights(rows, requests);
  assert.equal(joined[0].steps[0].model, "deepseek-chat");
  assert.equal(joined[0].steps[0].provider, "ds");
  assert.equal(joined[0].steps[0].requestConfig.temperature, 0.7);
  assert.equal(joined[0].steps[1].model, "deepseek-reasoner");
  assert.deepEqual(joined[0].models, ["deepseek-chat", "deepseek-reasoner"]);
  // 计价匹配随之激活：join 后能按模型命中价目
  const priced = priceTurnRows(joined, DEFAULT_PRICE_TABLE);
  assert.notEqual(priced[0].cost, null);
});

test("join 不覆盖节点自带 provenance；同键重试取最后一条（last-wins）", () => {
  const rows = foldTurns([
    assistantNode(1, 1, { provenance: { provider: "p", model: "node-model" }, usage: { inputTokens: 1 } })
  ]);
  const requests = [
    { purpose: "assistant", turn: 1, step: 1, provenance: { provider: "ds", model: "attempt-1" }, status: "error" },
    { purpose: "assistant", turn: 1, step: 1, provenance: { provider: "ds", model: "attempt-2" }, status: "complete" }
  ];
  const joined = joinRequestInsights(rows, requests);
  assert.equal(joined[0].steps[0].model, "node-model");
  const rows2 = foldTurns([assistantNode(1, 1, { usage: { inputTokens: 1 } })]);
  const joined2 = joinRequestInsights(rows2, requests);
  assert.equal(joined2[0].steps[0].model, "attempt-2");
});

test("requests 缺省/空/仅 compaction 时不改行（引用相等）；忽略缺坐标条目", () => {
  const rows = foldTurns([assistantNode(1, 1, { usage: { inputTokens: 1 } })]);
  assert.equal(joinRequestInsights(rows, void 0), rows);
  assert.equal(joinRequestInsights(rows, []), rows);
  assert.equal(joinRequestInsights(rows, [{ purpose: "compaction", turn: 1, step: 0 }]), rows);
  assert.equal(joinRequestInsights(rows, [{ purpose: "assistant", turn: 9, step: 1 }]), rows);
  // 未命中行的行对象保持原引用
  const joined = joinRequestInsights(rows, [{ purpose: "assistant", turn: 1, step: 2 }]);
  assert.equal(joined[0], rows[0]);
});
