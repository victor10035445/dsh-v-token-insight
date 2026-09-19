/**
 * dsh-v-token-insight — plan-store.mjs 单测（token-stats-plan 规格「计划值持久化与读取契约」，
 * add-monthly-plan 契约：{v:1, daily?, monthly?} 可选字段 + 逐字段可空归一化 + 补丁保存 +
 * 字段级清除）。
 * 覆盖：新旧校验边界（0/负数/NaN/Infinity/字符串/对象）、旧记录天然兼容、字段级/整体
 * 损坏回退、补丁保存不互抹与严格拒绝（非对象/未知键/显式 null）、空补丁无操作、
 * 字段级清除保留另一字段、两字段全空删键、月字段写失败路径。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  PLAN_STORE_KEY,
  PLAN_CHANGED_EVENT,
  validatePlanDaily,
  validatePlanMonthly,
  loadPlanStore,
  savePlanStore,
  clearPlanStore
} from "../src/plan-store.mjs";

/** 最小 localStorage fake（node 无 storage 面；抛错模式用于写失败路径）。 */
function fakeStorage({ throwOnSet = false, throwOnRemove = false } = {}) {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      if (throwOnSet) throw new Error("quota");
      map.set(key, String(value));
    },
    removeItem: (key) => {
      if (throwOnRemove) throw new Error("quota");
      map.delete(key);
    }
  };
}

/* ---------------------------------------------------------------- *
 * 事件名与键名契约
 * ---------------------------------------------------------------- */

test("键名与事件名契约", () => {
  assert.equal(PLAN_STORE_KEY, "dsh-v-token-insight.plan.v1");
  assert.equal(PLAN_CHANGED_EVENT, "dsh-v-token-insight:plan-changed");
});

/* ---------------------------------------------------------------- *
 * 校验边界（正有限数才通过；daily/monthly 同语义、各自独立导出）
 * ---------------------------------------------------------------- */

test("validatePlanDaily 边界：0/负数/NaN/Infinity/字符串/对象/缺省全拒", () => {
  assert.equal(validatePlanDaily(1), true);
  assert.equal(validatePlanDaily(5_000_000), true);
  assert.equal(validatePlanDaily(0.5), true);
  assert.equal(validatePlanDaily(0), false);
  assert.equal(validatePlanDaily(-1), false);
  assert.equal(validatePlanDaily(Number.NaN), false);
  assert.equal(validatePlanDaily(Number.POSITIVE_INFINITY), false);
  assert.equal(validatePlanDaily(Number.NEGATIVE_INFINITY), false);
  assert.equal(validatePlanDaily("5000000"), false);
  assert.equal(validatePlanDaily(""), false);
  assert.equal(validatePlanDaily({ daily: 5 }), false);
  assert.equal(validatePlanDaily(null), false);
  assert.equal(validatePlanDaily(void 0), false);
  assert.equal(validatePlanDaily(true), false);
});

test("validatePlanMonthly 边界：0/负数/NaN/Infinity/字符串/对象/缺省全拒", () => {
  assert.equal(validatePlanMonthly(1), true);
  assert.equal(validatePlanMonthly(60_000_000), true);
  assert.equal(validatePlanMonthly(0.5), true);
  assert.equal(validatePlanMonthly(0), false);
  assert.equal(validatePlanMonthly(-1), false);
  assert.equal(validatePlanMonthly(Number.NaN), false);
  assert.equal(validatePlanMonthly(Number.POSITIVE_INFINITY), false);
  assert.equal(validatePlanMonthly(Number.NEGATIVE_INFINITY), false);
  assert.equal(validatePlanMonthly("60000000"), false);
  assert.equal(validatePlanMonthly(""), false);
  assert.equal(validatePlanMonthly({ monthly: 5 }), false);
  assert.equal(validatePlanMonthly(null), false);
  assert.equal(validatePlanMonthly(void 0), false);
  assert.equal(validatePlanMonthly(true), false);
});

test("savePlanStore 补丁校验失败返回 false 且不落库", () => {
  const storage = fakeStorage();
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "5000000", { daily: 5 }, null]) {
    assert.equal(savePlanStore(storage, { daily: bad }), false, `should reject: ${String(bad)}`);
  }
  assert.equal(loadPlanStore(storage), null);
});

/* ---------------------------------------------------------------- *
 * 缺省 / 损坏回退（「未设置」= null，不抛错；字段级回退）
 * ---------------------------------------------------------------- */

test("loadPlanStore 缺省回退 null", () => {
  assert.equal(loadPlanStore(fakeStorage()), null);
  assert.equal(loadPlanStore(null), null);
  assert.equal(loadPlanStore({}), null);
});

test("loadPlanStore 损坏 JSON 回退 null 不抛错", () => {
  const storage = fakeStorage();
  storage.setItem(PLAN_STORE_KEY, "{not json");
  assert.equal(loadPlanStore(storage), null);
  storage.setItem(PLAN_STORE_KEY, "");
  assert.equal(loadPlanStore(storage), null);
});

test("loadPlanStore 形状非法整体回退 null（v 段/数组/原语/两字段均非法）", () => {
  const storage = fakeStorage();
  const cases = [
    "null",
    "42",
    '"5000000"',
    "[]",
    "{}",
    JSON.stringify({ daily: 5_000_000 }),
    JSON.stringify({ v: 2, daily: 5_000_000 }),
    /* 两字段均无效（缺省/非法）→ 整体 null */
    JSON.stringify({ v: 1 }),
    JSON.stringify({ v: 1, daily: 0 }),
    JSON.stringify({ v: 1, daily: -5 }),
    JSON.stringify({ v: 1, daily: "5000000" }),
    JSON.stringify({ v: 1, daily: Number.NaN }),
    JSON.stringify({ v: 1, daily: null, monthly: null }),
    JSON.stringify({ v: 1, daily: "x", monthly: -1 })
  ];
  for (const raw of cases) {
    storage.setItem(PLAN_STORE_KEY, raw);
    assert.equal(loadPlanStore(storage), null, `should fall back for: ${raw}`);
  }
});

test("旧记录 {v:1, daily} 天然兼容：归一化出 monthly:null，形状恰为双键", () => {
  const storage = fakeStorage();
  storage.setItem(PLAN_STORE_KEY, JSON.stringify({ v: 1, daily: 5_000_000 }));
  const plan = loadPlanStore(storage);
  assert.deepEqual(plan, { v: 1, daily: 5_000_000, monthly: null });
  assert.equal(Object.keys(plan).length, 3); /* 归一化形状恒为 {v, daily, monthly} 双字段 */
  assert.equal(plan.v, 1);
});

test("loadPlanStore 归一化形状：双键恒在场，字段级可空（仅设月值 daily:null）", () => {
  const storage = fakeStorage();
  savePlanStore(storage, { monthly: 60_000_000 });
  const plan = loadPlanStore(storage);
  assert.deepEqual(plan, { v: 1, daily: null, monthly: 60_000_000 });
  assert.equal(Object.keys(plan).length, 3);
});

test("loadPlanStore 字段级损坏回退：monthly 非法仅月字段 null，daily 照常可用", () => {
  const storage = fakeStorage();
  storage.setItem(PLAN_STORE_KEY, JSON.stringify({ v: 1, daily: 5_000_000, monthly: "60000000" }));
  assert.deepEqual(loadPlanStore(storage), { v: 1, daily: 5_000_000, monthly: null });
  storage.setItem(PLAN_STORE_KEY, JSON.stringify({ v: 1, daily: 5_000_000, monthly: 0 }));
  assert.deepEqual(loadPlanStore(storage), { v: 1, daily: 5_000_000, monthly: null });
  /* 反向：daily 非法仅日字段 null，monthly 保留 */
  storage.setItem(PLAN_STORE_KEY, JSON.stringify({ v: 1, daily: null, monthly: 60_000_000 }));
  assert.deepEqual(loadPlanStore(storage), { v: 1, daily: null, monthly: 60_000_000 });
});

test("loadPlanStore 未知字段（未来扩展）忽略不报错", () => {
  const storage = fakeStorage();
  storage.setItem(PLAN_STORE_KEY, JSON.stringify({ v: 1, daily: 5_000_000, yearly: 100_000_000 }));
  assert.deepEqual(loadPlanStore(storage), { v: 1, daily: 5_000_000, monthly: null });
});

/* ---------------------------------------------------------------- *
 * 补丁保存：读取-合并-写回（不互抹）与严格拒绝（全有或全无）
 * ---------------------------------------------------------------- */

test("savePlanStore 补丁保存不互抹：仅存月计划保留每日计划（落库省略未设置字段）", () => {
  const storage = fakeStorage();
  assert.equal(savePlanStore(storage, { daily: 5_000_000 }), true);
  assert.equal(savePlanStore(storage, { monthly: 60_000_000 }), true);
  assert.deepEqual(loadPlanStore(storage), { v: 1, daily: 5_000_000, monthly: 60_000_000 });
  /* 落库形状为可选字段语义：两字段均设置时 4 键 */
  const raw = JSON.parse(storage.getItem(PLAN_STORE_KEY));
  assert.deepEqual(raw, { v: 1, daily: 5_000_000, monthly: 60_000_000 });
  /* 覆盖写（last-wins）：仅更新所涉字段 */
  assert.equal(savePlanStore(storage, { monthly: 61_000_000 }), true);
  assert.deepEqual(loadPlanStore(storage), { v: 1, daily: 5_000_000, monthly: 61_000_000 });
});

test("savePlanStore 仅设月值：落库省略 daily 字段，读取归一化 daily:null", () => {
  const storage = fakeStorage();
  assert.equal(savePlanStore(storage, { monthly: 60_000_000 }), true);
  assert.deepEqual(JSON.parse(storage.getItem(PLAN_STORE_KEY)), { v: 1, monthly: 60_000_000 });
  assert.deepEqual(loadPlanStore(storage), { v: 1, daily: null, monthly: 60_000_000 });
});

test("savePlanStore 补丁含非法字段整体拒绝：部分合法也不写入（既有值不变）", () => {
  const storage = fakeStorage();
  assert.equal(savePlanStore(storage, { monthly: 60_000_000 }), true);
  /* daily 合法 + monthly 非法 → 整体拒绝，月计划原值保留、日计划未被部分写入 */
  assert.equal(savePlanStore(storage, { daily: 5, monthly: -1 }), false);
  assert.equal(savePlanStore(storage, { daily: 5, monthly: 0 }), false);
  assert.equal(savePlanStore(storage, { daily: 5, monthly: Number.NaN }), false);
  assert.deepEqual(loadPlanStore(storage), { v: 1, daily: null, monthly: 60_000_000 });
});

test("savePlanStore 严格契约：非对象补丁/数组/未知键/显式 null 与 undefined 拒绝", () => {
  const storage = fakeStorage();
  assert.equal(savePlanStore(storage, { daily: 5_000_000 }), true);
  /* 非普通对象 */
  for (const bad of [null, 42, "5000000", true, [5_000_000], () => {}]) {
    assert.equal(savePlanStore(storage, bad), false, `should reject: ${String(bad)}`);
  }
  /* 未知键（前向兼容新字段不经补丁通道静默写入） */
  assert.equal(savePlanStore(storage, { yearly: 100_000_000 }), false);
  assert.equal(savePlanStore(storage, { daily: 5_000_000, yearly: 100_000_000 }), false);
  /* 显式 null / undefined 不得经保存通道隐式清除 */
  assert.equal(savePlanStore(storage, { daily: null }), false);
  assert.equal(savePlanStore(storage, { monthly: undefined }), false);
  assert.equal(savePlanStore(storage, { daily: 5_000_000, monthly: null }), false);
  /* 既有值不变 */
  assert.deepEqual(loadPlanStore(storage), { v: 1, daily: 5_000_000, monthly: null });
});

test("savePlanStore 空补丁：无操作（返回 true、不落库、既有状态不变）", () => {
  const storage = fakeStorage();
  assert.equal(savePlanStore(storage, {}), true);
  assert.equal(storage.getItem(PLAN_STORE_KEY), null); /* 未设置时也不落键 */
  assert.equal(savePlanStore(storage, { daily: 5_000_000 }), true);
  assert.equal(savePlanStore(storage, {}), true);
  assert.deepEqual(loadPlanStore(storage), { v: 1, daily: 5_000_000, monthly: null }); /* 既有值不变 */
});

test("savePlanStore 读取现值：损坏旧值归一化 null 视为缺省，补丁照常写入", () => {
  const storage = fakeStorage();
  storage.setItem(PLAN_STORE_KEY, "{not json");
  assert.equal(savePlanStore(storage, { monthly: 60_000_000 }), true);
  assert.deepEqual(loadPlanStore(storage), { v: 1, daily: null, monthly: 60_000_000 });
});

test("savePlanStore 月字段写失败（存储抛错）返回 false，既有值不受影响", () => {
  const storage = fakeStorage();
  assert.equal(savePlanStore(storage, { daily: 5_000_000 }), true);
  const broken = { ...storage, setItem: () => { throw new Error("quota"); } };
  assert.equal(savePlanStore(broken, { monthly: 60_000_000 }), false);
  assert.deepEqual(loadPlanStore(storage), { v: 1, daily: 5_000_000, monthly: null });
});

/* ---------------------------------------------------------------- *
 * 字段级清除：仅移除该字段；两字段均空删除整个键
 * ---------------------------------------------------------------- */

test("clearPlanStore 字段级清除保留另一字段", () => {
  const storage = fakeStorage();
  savePlanStore(storage, { daily: 5_000_000, monthly: 60_000_000 });
  assert.equal(clearPlanStore(storage, "monthly"), true);
  assert.deepEqual(loadPlanStore(storage), { v: 1, daily: 5_000_000, monthly: null });
  assert.equal(clearPlanStore(storage, "daily"), true);
  assert.equal(loadPlanStore(storage), null);
});

test("clearPlanStore 两字段全空删除整个存储键（回到从未设置）", () => {
  const storage = fakeStorage();
  savePlanStore(storage, { monthly: 60_000_000 });
  assert.equal(clearPlanStore(storage, "monthly"), true);
  assert.equal(storage.getItem(PLAN_STORE_KEY), null);
  assert.equal(loadPlanStore(storage), null);
  /* 重复清除幂等 */
  assert.equal(clearPlanStore(storage, "monthly"), true);
  assert.equal(loadPlanStore(storage), null);
});

test("clearPlanStore 非法字段名返回 false（字段名必填）", () => {
  const storage = fakeStorage();
  savePlanStore(storage, { daily: 5_000_000 });
  for (const bad of [void 0, null, "", "yearly", "DAILY", 1, {}]) {
    assert.equal(clearPlanStore(storage, bad), false, `should reject: ${String(bad)}`);
  }
  assert.deepEqual(loadPlanStore(storage), { v: 1, daily: 5_000_000, monthly: null });
});

test("clearPlanStore 写失败路径：回写/删除抛错返回 false 且既有值不受影响", () => {
  const storage = fakeStorage();
  savePlanStore(storage, { daily: 5_000_000, monthly: 60_000_000 });
  /* 剩余字段仍在场：清除月计划走 setItem 回写路径，抛错 → false，既有值不变 */
  const brokenSet = { ...storage, setItem: () => { throw new Error("quota"); } };
  assert.equal(clearPlanStore(brokenSet, "monthly"), false);
  assert.deepEqual(loadPlanStore(storage), { v: 1, daily: 5_000_000, monthly: 60_000_000 });
  /* 清掉月字段后仅剩 daily：再清 daily 走 removeItem 删键路径，抛错 → false，键保留 */
  assert.equal(clearPlanStore(storage, "monthly"), true);
  const brokenRemove = {
    getItem: storage.getItem,
    setItem: storage.setItem,
    removeItem: () => { throw new Error("quota"); }
  };
  assert.equal(clearPlanStore(brokenRemove, "daily"), false);
  assert.deepEqual(loadPlanStore(storage), { v: 1, daily: 5_000_000, monthly: null });
});
