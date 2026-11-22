/**
 * dsh-v-token-insight — top-seat-follow.mjs 单测
 * （harden-top-seat-chain-follow tasks 1.2）。
 *
 * 覆盖：到达 / 未到达 / 恰好槽位 / 越过 / 不可测对齐 / 1px 容差边界（容差内与容差外）。
 * 槽位口径 = 宿主末按钮右缘 + 既有按钮间距；到达或越过均算对齐（`>=`），容差 1px。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { CHAIN_SETTLE_TOLERANCE_PX, isChainSettled } from "../src/top-seat-follow.mjs";

const HOST_RIGHT = 900;
const GAP = 2;
const SLOT_LEFT = HOST_RIGHT + GAP; /* 902：锚点左缘的槽位 */

test("容差常量与自校正一致（1px，唯一源）", () => {
  assert.equal(CHAIN_SETTLE_TOLERANCE_PX, 1);
});

test("到达：锚点左缘越过槽位 → 已对齐", () => {
  assert.equal(isChainSettled(SLOT_LEFT + 40, true, HOST_RIGHT, GAP), true);
});

test("恰好槽位：左缘 = 宿主右缘 + 间距 → 已对齐（到达即算）", () => {
  assert.equal(isChainSettled(SLOT_LEFT, true, HOST_RIGHT, GAP), true);
});

test("越过：左缘远超槽位 → 仍算已对齐（>= 而非等值）", () => {
  assert.equal(isChainSettled(SLOT_LEFT + 500, true, HOST_RIGHT, GAP), true);
});

test("未到达：左缘在槽位左侧 → 未对齐", () => {
  assert.equal(isChainSettled(SLOT_LEFT - 40, true, HOST_RIGHT, GAP), false);
});

test("1px 容差边界内：欠 1px 仍算落位", () => {
  /* left + 1 = hostRight + gap → 成立（容差恰为 1px） */
  assert.equal(isChainSettled(SLOT_LEFT - 1, true, HOST_RIGHT, GAP), true);
});

test("1px 容差边界外：欠 1.5px 即未对齐", () => {
  assert.equal(isChainSettled(SLOT_LEFT - 1.5, true, HOST_RIGHT, GAP), false);
  assert.equal(isChainSettled(SLOT_LEFT - 2, true, HOST_RIGHT, GAP), false);
});

test("锚点不可测 → 视为对齐（回落路径语义不变）", () => {
  assert.equal(isChainSettled(0, false, HOST_RIGHT, GAP), true);
  assert.equal(isChainSettled(Number.NaN, false, HOST_RIGHT, GAP), true);
  assert.equal(isChainSettled(undefined, false, HOST_RIGHT, GAP), true);
});

test("非有限几何按不可测处理 → 对齐（不空转复测）", () => {
  assert.equal(isChainSettled(Number.NaN, true, HOST_RIGHT, GAP), true);
  assert.equal(isChainSettled(SLOT_LEFT, true, Number.POSITIVE_INFINITY, GAP), true);
  assert.equal(isChainSettled(SLOT_LEFT, true, HOST_RIGHT, undefined), true);
});

test("槽位口径含间距：同一左缘在更大间距下未对齐", () => {
  assert.equal(isChainSettled(SLOT_LEFT, true, HOST_RIGHT, GAP), true);
  assert.equal(isChainSettled(SLOT_LEFT, true, HOST_RIGHT, GAP + 8), false);
});
