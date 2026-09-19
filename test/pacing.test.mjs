/**
 * dsh-v-token-insight — pacing.mjs 单测（fix-deep-completion-host-pressure tasks 1.2）。
 * 覆盖：EWMA 平滑与首样行为、升档序列 40→80→…→1500 封顶不再增长、
 * 低于回落阈值逐半步回落至 40、临界区（750–1500）维持、确定性（同输入同输出）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  PAGE_GAP_BASE_MS,
  PAGE_GAP_FACTOR,
  PAGE_GAP_MAX_MS,
  RTT_BACKOFF_THRESHOLD_MS,
  RTT_EWMA_ALPHA,
  RTT_RECOVER_THRESHOLD_MS,
  nextGapMs,
  smoothRtt
} from "../src/pacing.mjs";

/* --------------------------------------------------------------- *
 * smoothRtt — EWMA 平滑与首样行为
 * --------------------------------------------------------------- */

test("smoothRtt: 首样原样返回（不做半程偏低）", () => {
  assert.equal(smoothRtt(null, 900), 900);
  assert.equal(smoothRtt(undefined, 123.5), 123.5);
});

test("smoothRtt: EWMA 加权按 α=0.25", () => {
  assert.equal(RTT_EWMA_ALPHA, 0.25);
  const ewma = smoothRtt(1000, 600);
  assert.equal(ewma, 0.25 * 600 + 0.75 * 1000);
});

test("smoothRtt: 连续平滑收敛于样本水平", () => {
  let ewma = smoothRtt(null, 2000);
  for (let i = 0; i < 40; i++) ewma = smoothRtt(ewma, 100);
  assert.ok(ewma < 150, `EWMA 应收敛接近 100，实际 ${ewma}`);
});

test("smoothRtt: 非法样本视为无样本（返回 prev）", () => {
  assert.equal(smoothRtt(800, Number.NaN), 800);
  assert.equal(smoothRtt(800, -5), 800);
  assert.equal(smoothRtt(null, Number.NaN), null);
});

/* --------------------------------------------------------------- *
 * nextGapMs — 升档序列与封顶
 * --------------------------------------------------------------- */

test("nextGapMs: 常量初值与设计一致（唯一源）", () => {
  assert.equal(PAGE_GAP_BASE_MS, 40);
  assert.equal(PAGE_GAP_FACTOR, 2);
  assert.equal(PAGE_GAP_MAX_MS, 1500);
  assert.equal(RTT_BACKOFF_THRESHOLD_MS, 1500);
  assert.equal(RTT_RECOVER_THRESHOLD_MS, 750);
});

test("nextGapMs: 升档序列 40→80→…→1500 封顶不再增长", () => {
  const congested = RTT_BACKOFF_THRESHOLD_MS + 1; /* 1501：严格越过即升 */
  let gap = PAGE_GAP_BASE_MS;
  const seen = [];
  for (let i = 0; i < 12; i++) {
    gap = nextGapMs(congested, gap);
    seen.push(gap);
  }
  assert.deepEqual(seen, [80, 160, 320, 640, 1280, 1500, 1500, 1500, 1500, 1500, 1500, 1500]);
});

test("nextGapMs: 已封顶时同输入同输出（不再增长）", () => {
  assert.equal(nextGapMs(5000, PAGE_GAP_MAX_MS), PAGE_GAP_MAX_MS);
  assert.equal(nextGapMs(5000, PAGE_GAP_MAX_MS), nextGapMs(5000, PAGE_GAP_MAX_MS));
});

/* --------------------------------------------------------------- *
 * nextGapMs — 回落与临界维持
 * --------------------------------------------------------------- */

test("nextGapMs: 低于回落阈值逐半步回落至 BASE(40)", () => {
  const healthy = RTT_RECOVER_THRESHOLD_MS - 1; /* 749：严格低于才回落 */
  let gap = PAGE_GAP_MAX_MS;
  const seen = [];
  while (gap > PAGE_GAP_BASE_MS && seen.length < 12) {
    gap = nextGapMs(healthy, gap);
    seen.push(gap);
  }
  assert.deepEqual(seen, [750, 375, 187.5, 93.75, 46.875, 40]);
  assert.equal(nextGapMs(healthy, PAGE_GAP_BASE_MS), PAGE_GAP_BASE_MS); /* 触底维持 */
});

test("nextGapMs: 临界区 [750,1500] 维持当前档（滞回）", () => {
  for (const ewma of [RTT_RECOVER_THRESHOLD_MS, 900, RTT_BACKOFF_THRESHOLD_MS]) {
    assert.equal(nextGapMs(ewma, 640), 640, `ewma=${ewma} 应维持`);
    assert.equal(nextGapMs(ewma, 1280), 1280, `ewma=${ewma} 应维持`);
  }
});

test("nextGapMs: 无样本（null EWMA）维持当前档", () => {
  assert.equal(nextGapMs(null, 320), 320);
  assert.equal(nextGapMs(undefined, PAGE_GAP_BASE_MS), PAGE_GAP_BASE_MS);
});

test("nextGapMs: 非法当前档按 BASE 归一", () => {
  assert.equal(nextGapMs(100, Number.NaN), PAGE_GAP_BASE_MS);
  assert.equal(nextGapMs(100, 10), PAGE_GAP_BASE_MS); /* 低于 BASE 归一 */
});

/* --------------------------------------------------------------- *
 * 确定性
 * --------------------------------------------------------------- */

test("nextGapMs/smoothRtt: 同输入同输出（确定性）", () => {
  for (const ewma of [null, 100, 800, 1200, 2000, 9000]) {
    for (const gap of [40, 80, 640, 1500, 3000]) {
      assert.equal(nextGapMs(ewma, gap), nextGapMs(ewma, gap));
    }
  }
  assert.equal(smoothRtt(777, 123), smoothRtt(777, 123));
});
