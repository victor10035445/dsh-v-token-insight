/**
 * dsh-token-insight — charts.mjs 单测（任务 4.2 / 4.4 / 5.1）。
 * 覆盖：轮次刻度稀疏化（每 ⌈n/8⌉ 取一、至多 8 个）、堆叠条段间 1px 留隙
 * （最底段贴基线满高，上方段底边削 1px）、图表用色全走 --dsw-* 令牌
 * （硬编码色清零守卫；tools 段 #a78bfa 回归哨兵，design D7/D8）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { BUCKET_SEGMENTS, contextBreakdownLayout, formatAxisTokens, lineLayout, stackedBarsLayout } from "../src/charts.mjs";

/* stackedBarsLayout 默认几何：width 640 / height 150 / pad {top:8,right:8,bottom:20,left:44}。 */
const INNER_H = 150 - 8 - 20;

const row = (turn, input, output) => ({
  turn,
  usage: { inputTokens: input, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: output }
});

test("stackedBarsLayout：轮次刻度稀疏化——n ≤ 8 时全保留（stride=1）", () => {
  const rows = Array.from({ length: 8 }, (_, i) => row(i + 1, 10, 5));
  const layout = stackedBarsLayout(rows);
  assert.equal(layout.stride, 1);
  assert.equal(layout.xLabels.length, 8);
  assert.equal(layout.xLabels[0].turn, 1);
  assert.equal(layout.xLabels[7].turn, 8);
});

test("stackedBarsLayout：轮次刻度稀疏化——每 ⌈n/8⌉ 取一，首刻度恒保留", () => {
  const rows = Array.from({ length: 20 }, (_, i) => row(i + 1, 10, 5));
  const layout = stackedBarsLayout(rows);
  assert.equal(layout.stride, Math.ceil(20 / 8));
  assert.equal(layout.xLabels.length, Math.ceil(20 / layout.stride));
  assert.ok(layout.xLabels.length <= 8);
  assert.deepEqual(
    layout.xLabels.map((label) => label.turn),
    [1, 4, 7, 10, 13, 16, 19]
  );
  /* 刻度 x 与对应条的几何一致（取该条中心）。 */
  assert.equal(layout.xLabels[1].x, layout.bars[3].x + layout.bars[3].w / 2);
});

test("stackedBarsLayout：轮次刻度稀疏化——长窗口刻度数不超过 8", () => {
  const rows = Array.from({ length: 800 }, (_, i) => row(i + 1, 10, 5));
  const layout = stackedBarsLayout(rows);
  assert.equal(layout.stride, Math.ceil(800 / 8));
  assert.equal(layout.xLabels.length, 8);
  assert.equal(layout.xLabels[0].turn, 1);
  assert.equal(layout.xLabels[7].turn, 701);
});

test("stackedBarsLayout：单行有刻度、空输入安全（stride 回退 1）", () => {
  const one = stackedBarsLayout([row(1, 10, 5)]);
  assert.equal(one.xLabels.length, 1);
  const empty = stackedBarsLayout([]);
  assert.equal(empty.xLabels.length, 0);
  assert.equal(empty.stride, 1);
});

test("stackedBarsLayout：堆叠段段间 1px 留隙——最底段满高贴基线，上方段底边削 1px", () => {
  const layout = stackedBarsLayout([row(1, 600, 400)]);
  const segments = layout.bars[0].segments;
  assert.equal(segments.length, 2);
  /* 自底向上 push：input 为最底段（满高），output 为上方段（削 1px）。 */
  const rawBottom = (600 / layout.yMax) * INNER_H;
  const rawTop = (400 / layout.yMax) * INNER_H;
  assert.ok(Math.abs(segments[0].h - rawBottom) < 1e-9);
  assert.ok(Math.abs(segments[1].h - (rawTop - 1)) < 1e-9);
  /* 顶段底边与底段顶边之间空出 1px。 */
  assert.ok(Math.abs(segments[1].y + segments[1].h - (segments[0].y - 1)) < 1e-9);
  /* 最底段仍贴基线。 */
  assert.ok(Math.abs(segments[0].y + segments[0].h - (150 - 20)) < 1e-9);
});

test("stackedBarsLayout：单段条不留隙（段高不削）", () => {
  const layout = stackedBarsLayout([row(1, 1000, 0)]);
  const segments = layout.bars[0].segments;
  assert.equal(segments.length, 1);
  assert.ok(Math.abs(segments[0].h - INNER_H) < 1e-9);
});

test("stackedBarsLayout：Y 轴整刻度（1/2/5×10^k 步进，yMax 取整到步进倍数）", () => {
  /* 峰值柱 total = 3500（其余远小）→ 步进 1000（整千），yMax 4000 覆盖数据。 */
  const rows = [
    row(1, 120, 80),
    row(2, 90, 60),
    row(3, 200, 100),
    row(4, 150, 90),
    row(5, 180, 70),
    row(6, 3_000, 500)
  ];
  const layout = stackedBarsLayout(rows);
  assert.equal(layout.yStep, 1000);
  assert.equal(layout.yMax, 4000);
  assert.deepEqual(
    layout.ticks.map((tick) => tick.value),
    [4000, 3000, 2000, 1000, 0]
  );
  for (const tick of layout.ticks) {
    assert.ok(Number.isInteger(tick.value), "token 刻度恒为整数");
    assert.equal(tick.value % layout.yStep, 0);
  }
});

test("lineLayout：Y 轴整刻度覆盖数据最大值且为步进整数倍", () => {
  const layout = lineLayout([
    { turn: 1, cost: 3.2 },
    { turn: 2, cost: 9.4 },
    { turn: 3, cost: 12.5 }
  ]);
  assert.ok(layout.yMax >= 12.5);
  for (const tick of layout.ticks) {
    assert.ok(Math.abs(tick.cost % layout.yStep) < 1e-9);
    assert.ok(tick.cost >= 0 && tick.cost <= layout.yMax);
  }
  /* 刻度覆盖最高点。 */
  assert.equal(layout.ticks[0].cost, layout.yMax);
});

test("formatAxisTokens：Y 轴 token 刻度整数化（无小数填充，用户反馈）", () => {
  assert.equal(formatAxisTokens(0), "0");
  assert.equal(formatAxisTokens(500), "500");
  assert.equal(formatAxisTokens(1500), "1500");
  assert.equal(formatAxisTokens(2500), "2500");
  assert.equal(formatAxisTokens(12000), "12k");
  assert.equal(formatAxisTokens(18000), "18k");
  assert.equal(formatAxisTokens(500_000), "500k");
  assert.equal(formatAxisTokens(1_000_000), "1M");
  assert.equal(formatAxisTokens(1_500_000), "1.5M");
  assert.equal(formatAxisTokens(2_000_000), "2M");
  assert.equal(formatAxisTokens(2_500_000), "2.5M");
  /* 绝无两位小数（"1.00M" 式）标签。 */
  assert.ok(!/\.\d{2}/.test(formatAxisTokens(1_000_000)));
  assert.ok(!/\.\d{2}/.test(formatAxisTokens(2_500_000)));
});

test("图表用色硬编码色清零（任务 5.1）：四桶与上下文构成段全部为 --dsw-* 令牌", () => {
  for (const segment of BUCKET_SEGMENTS) {
    assert.match(segment.color, /^var\(--dsw-/);
  }
  const breakdown = contextBreakdownLayout({ systemTokens: 10, toolsTokens: 20, messageTokens: 30 });
  assert.equal(breakdown.segments.length, 3);
  for (const segment of breakdown.segments) {
    assert.match(segment.color, /^var\(--dsw-/);
  }
  /* 「工具」段回归哨兵：应为主题令牌，而非硬编码 #a78bfa（design D7/D8）。 */
  const tools = breakdown.segments.find((segment) => segment.key === "toolsTokens");
  assert.equal(tools.color, "var(--dsw-static-deepseek-400)");
});
