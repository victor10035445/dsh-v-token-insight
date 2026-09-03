/**
 * dsh-v-token-insight — window-fold.mjs 单测（tasks 1.4）。
 * 覆盖：两级缓存命中/失效（同引用命中、新引用重算、陈旧校验触发重算、
 * requests 引用变更重算 join）、turnByMessageId / rowByTurn 索引正确性、
 * 空输入降级。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { foldedWindowOf } from "../src/window-fold.mjs";

const userNode = (text, time) => ({ kind: "user", seq: 1, time, content: [{ type: "text", text }] });
const assistantNode = (turn, step, over = {}) => ({
  kind: "assistant",
  seq: 10 + step,
  time: over.time ?? 1_000,
  turn,
  step,
  blocks: [],
  ...over
});

const nodesFixture = () => [
  userNode("第一轮", 500),
  assistantNode(1, 0, { messageId: "msg-1", usage: { inputTokens: 10, outputTokens: 5 } }),
  userNode("第二轮", 2_000),
  assistantNode(2, 0, { messageId: "msg-2", usage: { inputTokens: 20, outputTokens: 8 } })
];

const requestsFixture = () => [
  {
    purpose: "assistant",
    turn: 2,
    step: 0,
    provenance: { provider: "p", model: "model-b" },
    requestConfig: { temperature: 0.5 }
  }
];

test("空输入降级：非数组/空数组返回空行与空索引", () => {
  for (const nodes of [void 0, null, [], "x"]) {
    const result = foldedWindowOf(nodes, void 0);
    assert.deepEqual(result.rows, []);
    assert.equal(result.turnByMessageId.size, 0);
    assert.equal(result.rowByTurn.size, 0);
  }
});

test("同引用命中：两次调用返回同一 rows 对象（缓存生效）", () => {
  const nodes = nodesFixture();
  const first = foldedWindowOf(nodes, void 0);
  const second = foldedWindowOf(nodes, void 0);
  assert.equal(first.rows, second.rows);
  assert.equal(first.turnByMessageId, second.turnByMessageId);
  assert.equal(first.rowByTurn, second.rowByTurn);
});

test("索引正确性：messageId→轮号（首个胜出）与轮号→行", () => {
  const nodes = [
    assistantNode(3, 0, { messageId: "dup", usage: { inputTokens: 1, outputTokens: 1 } }),
    assistantNode(5, 0, { messageId: "dup", usage: { inputTokens: 1, outputTokens: 1 } })
  ];
  const { turnByMessageId, rowByTurn } = foldedWindowOf(nodes, void 0);
  assert.equal(turnByMessageId.get("dup"), 3); /* 首个胜出，与原线性扫描语义一致 */
  assert.equal(rowByTurn.get(3), foldedWindowOf(nodes, void 0).rows[0]);
  assert.equal(rowByTurn.size, 2);
});

test("新引用重算：同内容不同引用的 nodes 产生新 rows（按引用键控）", () => {
  const a = foldedWindowOf(nodesFixture(), void 0);
  const b = foldedWindowOf(nodesFixture(), void 0);
  assert.notEqual(a.rows, b.rows);
  assert.equal(a.rows.length, b.rows.length);
});

test("陈旧校验：length 或首尾节点引用变化触发重算（防原地变更）", () => {
  const nodes = nodesFixture();
  const before = foldedWindowOf(nodes, void 0);

  /* 原地追加（引用不变、length 变）→ 必须重算 */
  nodes.push(assistantNode(3, 0, { messageId: "msg-3", usage: { inputTokens: 1, outputTokens: 1 } }));
  const afterPush = foldedWindowOf(nodes, void 0);
  assert.equal(afterPush.rows.length, before.rows.length + 1);
  assert.equal(afterPush.turnByMessageId.get("msg-3"), 3);

  /* 原地替换首节点（引用不变、length/last 不变）→ 校验首引用触发重算 */
  const nodes2 = nodesFixture();
  foldedWindowOf(nodes2, void 0);
  nodes2[0] = userNode("被替换的首轮", 999);
  const afterSwap = foldedWindowOf(nodes2, void 0);
  assert.equal(afterSwap.rows[0].title, "被替换的首轮");
});

test("join 二级缓存：同 requests 引用命中；requests 引用变更重算", () => {
  const nodes = nodesFixture();
  const requests = requestsFixture();
  const r1 = foldedWindowOf(nodes, requests);
  const r2 = foldedWindowOf(nodes, requests);
  assert.equal(r1.rows, r2.rows); /* 同 requests 引用命中 join 缓存 */
  assert.equal(r2.rows[1].steps[0].model, "model-b"); /* join 已补模型 */

  const requests2 = requestsFixture();
  requests2[0] = { ...requests2[0], provenance: { provider: "p", model: "model-c" } };
  const r3 = foldedWindowOf(nodes, requests2);
  assert.notEqual(r3.rows, r1.rows);
  assert.equal(r3.rows[1].steps[0].model, "model-c");
});

test("requests 缺席/空数组：返回未 join 的折分行", () => {
  const nodes = nodesFixture();
  const bare = foldedWindowOf(nodes, void 0);
  const empty = foldedWindowOf(nodes, []);
  assert.equal(empty.rows, bare.rows); /* 空数组 requests 不进 join 缓存，返回裸 fold */
  const withReq = foldedWindowOf(nodes, requestsFixture());
  assert.equal(withReq.rows[0].steps[0].model, null); /* 第 1 轮无 request → 模型仍缺 */
  assert.notEqual(withReq.rows, bare.rows); /* join 后是新数组 */
});
