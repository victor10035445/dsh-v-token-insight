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
  formatMillions,
  formatTodayDps,
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
 * formatMillions / formatTodayDps（rework-kpi-charts 任务 1.1 / 1.2）
 * ---------------------------------------------------------------- */

test("formatMillions：≥1M 取整、<1M 一位小数剥尾零（合并卡「115 / 0.2」读数）", () => {
  assert.equal(formatMillions(115_100_000), "115"); // ≥1M 四舍五入取整（1.4M → "1"）
  assert.equal(formatMillions(1_400_000), "1");
  assert.equal(formatMillions(980_000), "1"); // 0.98M → 一位小数 "1.0" → 剥尾零 "1"
  assert.equal(formatMillions(200_000), "0.2");
  assert.equal(formatMillions(0), "0");
  assert.equal(formatMillions(undefined), "0");
  /* 规格场景：计费输入 115.1M、输出 0.2M → 「115 / 0.2」 */
  assert.equal(`${formatMillions(115_100_000)} / ${formatMillions(200_000)}`, "115 / 0.2");
});

test("formatTodayDps：验算例 158,400 / 3,600s → 「44」；<1 → 「<1」；跨零点窗口 → 「—」", () => {
  assert.equal(formatTodayDps(158_400, 3_600_000), "44");
  assert.equal(formatTodayDps(0, 3_600_000), "<1");
  assert.equal(formatTodayDps(500, 3_600_000), "<1");
  assert.equal(formatTodayDps(1_000, 60_000), "17"); // 恰 60s 窗口出口：1000/60 → 16.67 → 17
  assert.equal(formatTodayDps(158_400, 59_999), "—"); // <60s → 「—」（跨零点一个刷新节拍内）
  assert.equal(formatTodayDps(0, 30_000), "—");
  assert.equal(formatTodayDps(158_400, undefined), "—");
  /* 跨零点序列：「—」→「<1」→ 整数（分母自洽重置后依次恢复）。 */
  assert.equal(formatTodayDps(0, 59_000), "—");
  assert.equal(formatTodayDps(50, 61_000), "<1");
  assert.equal(formatTodayDps(1_000_000, 61_000), "16393");
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

/* ---------------------------------------------------------------- *
 * 宿主契约 fixture（fix-trajectory-join-contract）
 * 0.1.x：仅 `provenance`；0.2.x：`providerMetadata`/`requestConfig`、无 `provenance`。
 * ---------------------------------------------------------------- */

test("0.2.x 契约：请求仅 requestConfig 承载身份 → join 后模型可计价（费用非 null）", () => {
  const rows = foldTurns([
    userNode("q", 1),
    assistantNode(1, 1, { usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 }, messageId: "m1" })
  ]);
  /* 0.2.x 形状：无 provenance，身份由 request/header 落盘的计划配置承载。 */
  const requests = [
    {
      purpose: "assistant",
      turn: 1,
      step: 1,
      requestConfig: { provider: "deepseek", model: "deepseek-chat", temperature: 0.7 }
    }
  ];
  const joined = joinRequestInsights(rows, requests);
  assert.equal(joined[0].steps[0].model, "deepseek-chat");
  assert.equal(joined[0].steps[0].provider, "deepseek");
  assert.deepEqual(joined[0].models, ["deepseek-chat"]);
  /* 计价回归：step 模型非空 → 命中价目条目 → 行费用非 null（KPI 恢复金额）。 */
  const priced = priceTurnRows(joined, DEFAULT_PRICE_TABLE);
  assert.notEqual(priced[0].cost, null);
  assert.equal(priced[0].cost, 2 + 3); /* deepseek-chat：输入 ¥2/MTok + 输出 ¥3/MTok */
  assert.deepEqual(priced[0].unmatched, []);
  assert.notEqual(priced[0].stepPrices[0], null);
});

test("0.2.x 契约：providerMetadata 与 requestConfig 模型名不一致 → 取 providerMetadata（最终身份）", () => {
  const rows = foldTurns([assistantNode(1, 1, { usage: { inputTokens: 1 } })]);
  const requests = [
    {
      purpose: "assistant",
      turn: 1,
      step: 1,
      providerMetadata: { provider: "gw", model: "served-model" },
      requestConfig: { provider: "plan", model: "planned-model", temperature: 0.3 }
    }
  ];
  const joined = joinRequestInsights(rows, requests);
  /* 完成请求的最终身份（实际供服）优先于计划配置（网关重路由时按前者计价）。 */
  assert.equal(joined[0].steps[0].model, "served-model");
  assert.equal(joined[0].steps[0].provider, "gw");
  /* 调用参数弹层口径不变：仍取 requestConfig 的已报告字段。 */
  assert.equal(joined[0].steps[0].requestConfig.temperature, 0.3);
  assert.equal(joined[0].steps[0].requestConfig.model, "planned-model");
});

test("载体原子性：providerMetadata.model 无效（空串/非字符串）→ 整体跳过，取 requestConfig 完整配对", () => {
  const rows = foldTurns([
    assistantNode(1, 1, { usage: { inputTokens: 1 } }),
    assistantNode(1, 2, { usage: { inputTokens: 1 } })
  ]);
  const requests = [
    /* 空串模型 */
    {
      purpose: "assistant",
      turn: 1,
      step: 1,
      providerMetadata: { provider: "gw-provider", model: "" },
      requestConfig: { provider: "plan-provider", model: "planned-model" }
    },
    /* 非字符串模型 */
    {
      purpose: "assistant",
      turn: 1,
      step: 2,
      providerMetadata: { provider: "gw-provider", model: 42 },
      requestConfig: { provider: "plan-provider", model: "planned-model" }
    }
  ];
  const joined = joinRequestInsights(rows, requests);
  for (const step of joined[0].steps) {
    /* 无效载体整体缺席 → 采用 requestConfig 的完整配对，MUST NOT 拼配 gw-provider。 */
    assert.equal(step.model, "planned-model");
    assert.equal(step.provider, "plan-provider");
  }
});

test("载体原子性：model 有效而 provider 无效 → (model, null)，不降级到后续载体的计划模型", () => {
  const rows = foldTurns([
    assistantNode(1, 1, { usage: { inputTokens: 1 } }),
    assistantNode(1, 2, { usage: { inputTokens: 1 } })
  ]);
  const requests = [
    /* 空串 provider */
    {
      purpose: "assistant",
      turn: 1,
      step: 1,
      providerMetadata: { provider: "", model: "served-model" },
      requestConfig: { provider: "plan-provider", model: "planned-model" }
    },
    /* 非字符串 provider */
    {
      purpose: "assistant",
      turn: 1,
      step: 2,
      providerMetadata: { provider: 7, model: "served-model" },
      requestConfig: { provider: "plan-provider", model: "planned-model" }
    }
  ];
  const joined = joinRequestInsights(rows, requests);
  for (const step of joined[0].steps) {
    assert.equal(step.model, "served-model");
    assert.equal(step.provider, null); /* 等效匹配任意路由条目 */
  }
});

test("0.1.x 契约（仅 provenance）与修复前基线一致；混装时 provenance 仍居链首", () => {
  const rows = foldTurns([assistantNode(1, 1, { usage: { inputTokens: 10 } })]);
  const requests = [
    { purpose: "assistant", turn: 1, step: 1, provenance: { provider: "ds", model: "deepseek-chat" } }
  ];
  const joined = joinRequestInsights(rows, requests);
  assert.equal(joined[0].steps[0].provider, "ds");
  assert.equal(joined[0].steps[0].model, "deepseek-chat");
  assert.deepEqual(joined[0].models, ["deepseek-chat"]);
  /* 旧契约兼容优先级：provenance 存在时不被新载体覆盖。 */
  const mixed = joinRequestInsights(foldTurns([assistantNode(1, 1, { usage: { inputTokens: 10 } })]), [
    {
      purpose: "assistant",
      turn: 1,
      step: 1,
      provenance: { provider: "legacy", model: "legacy-model" },
      providerMetadata: { provider: "new", model: "new-model" }
    }
  ]);
  assert.equal(mixed[0].steps[0].model, "legacy-model");
  assert.equal(mixed[0].steps[0].provider, "legacy");
});

test("全载体缺席：模型保持 null、该步不计价（「未定价」如实披露）", () => {
  const rows = foldTurns([assistantNode(1, 1, { usage: { inputTokens: 1_000 } })]);
  const joined = joinRequestInsights(rows, [
    {
      purpose: "assistant",
      turn: 1,
      step: 1,
      /* 载体存在但模型无效 = 全部缺席（如无 durable 消息、无 header 落盘的旧会话段）。 */
      providerMetadata: { provider: "gw", model: "" },
      requestConfig: { provider: "plan", model: "" }
    }
  ]);
  assert.equal(joined[0].steps[0].model, null);
  assert.equal(joined[0].steps[0].provider, null);
  const priced = priceTurnRows(joined, DEFAULT_PRICE_TABLE);
  assert.equal(priced[0].cost, null);
  assert.deepEqual(priced[0].unmatched, ["未知模型:无价目"]);
});

test("节点侧身份优先（fill-only-missing）：节点 provenance / 0.2.x providerMetadata 各一例", () => {
  /* 0.1.x 节点 provenance 优先于请求级新载体。 */
  const legacy = joinRequestInsights(
    foldTurns([
      assistantNode(1, 1, { provenance: { provider: "node", model: "node-model" }, usage: { inputTokens: 1 } })
    ]),
    [{ purpose: "assistant", turn: 1, step: 1, providerMetadata: { provider: "req", model: "req-model" } }]
  );
  assert.equal(legacy[0].steps[0].model, "node-model");
  assert.equal(legacy[0].steps[0].provider, "node");
  /* 0.2.x 节点 providerMetadata（类型已声明、宿主未来填充）优先于请求级 requestConfig；
     join 未触及时 fold 层也能直接产出节点身份（row.models）。 */
  const modernRows = foldTurns([
    assistantNode(1, 1, { providerMetadata: { provider: "node", model: "node-model" }, usage: { inputTokens: 1 } })
  ]);
  assert.equal(modernRows[0].steps[0].model, "node-model");
  assert.deepEqual(modernRows[0].models, ["node-model"]);
  const modern = joinRequestInsights(modernRows, [
    { purpose: "assistant", turn: 1, step: 1, requestConfig: { provider: "plan", model: "plan-model" } }
  ]);
  assert.equal(modern[0].steps[0].model, "node-model");
  assert.equal(modern[0].steps[0].provider, "node");
});

test("0.2.x 契约：同键重试链 last-wins（采用最终尝试的 providerMetadata）", () => {
  const rows = foldTurns([assistantNode(1, 1, { usage: { inputTokens: 1 } })]);
  const requests = [
    { purpose: "assistant", turn: 1, step: 1, providerMetadata: { provider: "gw", model: "attempt-1" }, status: "error" },
    { purpose: "assistant", turn: 1, step: 1, providerMetadata: { provider: "gw", model: "attempt-2" }, status: "complete" }
  ];
  assert.equal(joinRequestInsights(rows, requests)[0].steps[0].model, "attempt-2");
});

test("join 形状零变更：steps 字段集合不变；空请求清单返回原引用", () => {
  const rows = foldTurns([assistantNode(1, 1, { usage: { inputTokens: 1 } })]);
  const before = Object.keys(rows[0].steps[0]).sort();
  const joined = joinRequestInsights(rows, [
    { purpose: "assistant", turn: 1, step: 1, providerMetadata: { provider: "gw", model: "m" } }
  ]);
  /* 修复只改取值来源，不新增诊断字段（共享缓存/紧凑编码零波及）。 */
  assert.deepEqual(Object.keys(joined[0].steps[0]).sort(), before);
  assert.equal(joinRequestInsights(rows, []), rows);
});

/* ---------------------------------------------------------------- *
 * 共享折叠产物（perf-hot-path-optimization 任务 2.2，D1/R1）
 * ---------------------------------------------------------------- */

import { foldTurnsShared, joinRequestInsightsShared } from "../src/stats-fold.mjs";

const chipNode = (turn, stepIdx, messageId, usage) =>
  assistantNode(turn, stepIdx, { messageId, provenance: { provider: "ds", model: "deepseek-chat" }, usage });

const multiTurnNodes = () => [
  userNode("第一问", 100),
  chipNode(1, 1, "msg-1", { inputTokens: 10, outputTokens: 5 }),
  chipNode(1, 2, "msg-2", { inputTokens: 8, outputTokens: 3 }),
  userNode("第二问", 200),
  chipNode(2, 1, "msg-3", { inputTokens: 6, outputTokens: 2 }),
  steerNode("补充", 250),
  chipNode(2, 2, "msg-4", { inputTokens: 4, outputTokens: 1 })
];

test("foldTurnsShared：多消费点产物引用相等（缓存命中），内容与 foldTurns 逐值一致", () => {
  const nodes = multiTurnNodes();
  const first = foldTurnsShared(nodes);
  const second = foldTurnsShared(nodes);
  assert.equal(second, first); /* 同窗口引用相等 */
  assert.deepEqual(first.rows, foldTurns(nodes)); /* 输出与独立折叠逐值一致 */
  /* 页签与 chip 共用：join 产物引用相等且 rows 一致 */
  const requests = [{ purpose: "assistant", turn: 1, step: 1, provenance: { provider: "ds", model: "deepseek-chat" } }];
  assert.equal(joinRequestInsightsShared(first, requests), joinRequestInsightsShared(first, requests));
  assert.deepEqual(joinRequestInsightsShared(first, requests).rows, joinRequestInsights(foldTurns(nodes), requests));
});

test("foldTurnsShared：同一数组对象原地变异后重算（签名兜底）", () => {
  /* 末节点变异（宿主流式常态：末节点对象替换） */
  const nodes = multiTurnNodes();
  const before = foldTurnsShared(nodes);
  nodes[nodes.length - 1] = { ...nodes[nodes.length - 1], usage: { inputTokens: 99, outputTokens: 99 } };
  const after = foldTurnsShared(nodes);
  assert.notEqual(after, before);
  assert.equal(after.rows[1].usage.inputTokens, 105); /* 重算反映新内容（6 + 99） */
  /* 首节点前插（loadOlder 常态：数组结构变化） */
  const nodes2 = multiTurnNodes();
  const before2 = foldTurnsShared(nodes2);
  nodes2.unshift(userNode("更早的问题", 50), chipNode(0, 1, "msg-0", { inputTokens: 1, outputTokens: 1 }));
  const after2 = foldTurnsShared(nodes2);
  assert.notEqual(after2, before2);
  assert.equal(after2.rows.length, 3);
  assert.equal(after2.rows[0].turn, 0);
  /* 末尾追加（长度变化） */
  const nodes3 = multiTurnNodes();
  const before3 = foldTurnsShared(nodes3);
  nodes3.push(chipNode(3, 1, "msg-9", { inputTokens: 2, outputTokens: 2 }));
  assert.notEqual(foldTurnsShared(nodes3), before3);
});

test("foldTurnsShared：不同窗口互不串扰；foldTurnsShared 固定默认 titleMaxLength", () => {
  const nodesA = multiTurnNodes();
  const nodesB = multiTurnNodes(); /* 内容相同、数组身份不同 */
  const artifactA = foldTurnsShared(nodesA);
  const artifactB = foldTurnsShared(nodesB);
  assert.notEqual(artifactA, artifactB);
  assert.deepEqual(artifactA.rows, artifactB.rows);
  /* Shared 变体不接受 titleMaxLength 覆盖（options 不进缓存键）：
     长标题按默认 60 截断，与 foldTurns 默认一致。 */
  const longText = "长".repeat(120);
  const longNodes = [userNode(longText, 1), chipNode(1, 1, "m", { inputTokens: 1 })];
  assert.equal(foldTurnsShared(longNodes).rows[0].title, foldTurns(longNodes)[0].title);
  assert.ok(foldTurnsShared(longNodes).rows[0].title.length <= 60);
});

test("joinRequestInsightsShared：不同 requests 互不串扰；未触碰行时 rows 保持 fold 原引用", () => {
  const artifact = foldTurnsShared(multiTurnNodes());
  const untouched = joinRequestInsightsShared(artifact, void 0);
  assert.equal(untouched, artifact); /* 无 requests：fold 产物本身 */
  assert.equal(joinRequestInsightsShared(artifact, []).rows, artifact.rows);
  /* 未命中任何行 → joinRequestInsights 返回原数组 → 产物即 fold 产物 */
  const miss = joinRequestInsightsShared(artifact, [{ purpose: "assistant", turn: 9, step: 1, provenance: { provider: "x", model: "y" } }]);
  assert.equal(miss.rows, artifact.rows);
  /* 不同 requests（同 fold 产物）→ 不同 join 产物（节点无 provenance，join 必触碰） */
  const bare = foldTurnsShared([
    assistantNode(1, 1, { messageId: "b-1", usage: { inputTokens: 1 } }),
    assistantNode(2, 1, { messageId: "b-2", usage: { inputTokens: 2 } })
  ]);
  const r1 = [{ purpose: "assistant", turn: 1, step: 1, provenance: { provider: "ds", model: "model-a" } }];
  const r2 = [{ purpose: "assistant", turn: 1, step: 1, provenance: { provider: "ds", model: "model-b" } }];
  const joined1 = joinRequestInsightsShared(bare, r1);
  const joined2 = joinRequestInsightsShared(bare, r2);
  assert.notEqual(joined1, joined2);
  assert.notEqual(joined1.rows, joined2.rows);
  assert.equal(joined1.rows[0].steps[0].model, "model-a");
  assert.equal(joined2.rows[0].steps[0].model, "model-b");
});

test("轮定位索引：messageId→turn / turn→row 与线性扫描逐一一致（O(1) 取代 O(N) 反查）", () => {
  const nodes = multiTurnNodes();
  const artifact = foldTurnsShared(nodes);
  /* messageId→turn：与 chip 既有线性反查（首个 assistant 命中）一致 */
  for (const node of nodes) {
    if (node.kind !== "assistant") continue;
    const expected = nodes.find((candidate) => candidate.kind === "assistant" && candidate.messageId === node.messageId)?.turn ?? null;
    assert.equal(artifact.turnByMessageId.get(node.messageId) ?? null, expected);
  }
  assert.equal(artifact.turnByMessageId.get("missing"), void 0);
  /* turn→row：与 rows.find 一致 */
  for (const row of artifact.rows) {
    assert.equal(artifact.rowByTurn.get(row.turn), artifact.rows.find((candidate) => candidate.turn === row.turn));
  }
  assert.equal(artifact.rowByTurn.get(99), void 0);
  /* join 触碰行后：rowByTurn 指向 join 后的行对象（chip 取到的行与页签一致） */
  const requests = [{ purpose: "assistant", turn: 1, step: 1, provenance: { provider: "ds", model: "deepseek-chat" } }];
  const joined = joinRequestInsightsShared(artifact, requests);
  for (const row of joined.rows) {
    assert.equal(joined.rowByTurn.get(row.turn), joined.rows.find((candidate) => candidate.turn === row.turn));
  }
  /* 空窗口产物形状完整 */
  const empty = foldTurnsShared([]);
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.turnByMessageId.size, 0);
  assert.equal(empty.rowByTurn.size, 0);
});
