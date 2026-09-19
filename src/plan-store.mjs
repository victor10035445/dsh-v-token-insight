/**
 * dsh-v-token-insight — 计划消耗持久化（每日/每月；纯函数、storage 注入，node 可单测）。
 *
 * token-stats-plan 规格「计划值持久化与读取契约」（design D1–D4，price-store 同款模式）：
 *  - 持久化于浏览器 localStorage（键 dsh-v-token-insight.plan.v1），形状 {v:1, daily?, monthly?}
 *    （v1 版本位加可选字段：daily 为正有限数（Token/天）、monthly 为正有限数（Token/月），
 *    各自独立设置/清除；两字段均不在场即「未设置」；旧形状 {v:1, daily} 天然兼容零迁移）；
 *  - 「未设置」是一等状态（区别于 0）：读取归一化为 {v:1, daily:number|null, monthly:number|null}
 *    ——某字段非法仅该字段回退 null（字段级回退），JSON 解析失败/v 段非法/两字段均无效
 *    才整体回退 null；未知字段（未来扩展）一律忽略；不抛错、不阻塞渲染；
 *  - 保存 MUST 走补丁语义（严格契约）：补丁为仅含 daily/monthly 已知键的普通对象且键值
 *    均为正有限数；校验全有或全无——非对象/未知键/任一键值非法（含显式 null/undefined）
 *    整体拒绝且既有值不变（null 不得经保存通道隐式清除，清除是恢复「未设置」的唯一动作）；
 *    合法补丁按读取现值-合并-写回执行（保存一个字段不抹掉另一字段），写回省略未设置字段；
 *    空补丁为无操作（返回成功、不落库）；
 *  - 「清除」按字段执行（field ∈ daily|monthly 必填）：仅移除该字段，两字段均空后删除
 *    整个存储键；写入/删除失败（配额/存储不可用）返回 false 由调用方如实提示；
 *  - 读取接口为公开契约：消费方（计划页签、座位速度仪表、总览趋势目标柱等）MUST 经
 *    loadPlanStore 取值，MUST NOT 自行解析 localStorage；保存或清除成功后由调用方广播
 *    PLAN_CHANGED_EVENT（镜像 PRICES_CHANGED_EVENT 的「store 纯函数 + 调用方广播」分工）。
 */

/** localStorage 键（v1）。 */
export const PLAN_STORE_KEY = "dsh-v-token-insight.plan.v1";

/** 计划变更通知事件名（保存/清除成功后广播，订阅方经 usePlanVersion 重算）。 */
export const PLAN_CHANGED_EVENT = "dsh-v-token-insight:plan-changed";

/** 补丁/清除允许的字段集（未知键拒绝；前向兼容的新字段在此显式扩列）。 */
const PLAN_FIELD_SET = new Set(["daily", "monthly"]);

/**
 * 校验每日计划值：正有限数（单位 Token/天）。
 * @returns 通过返回 true；非数字/非有限数/非正数一律 false。
 */
export function validatePlanDaily(daily) {
  return typeof daily === "number" && Number.isFinite(daily) && daily > 0;
}

/**
 * 校验每月计划值：与 validatePlanDaily 同语义（正有限数，单位 Token/月）。
 * 按字段独立导出（design D3：契约可读性优先于去重）。
 * @returns 通过返回 true；非数字/非有限数/非正数一律 false。
 */
export function validatePlanMonthly(monthly) {
  return typeof monthly === "number" && Number.isFinite(monthly) && monthly > 0;
}

/** 逐字段校验器表（loadPlanStore 归一化与 savePlanStore 补丁校验共用）。 */
const FIELD_VALIDATORS = { daily: validatePlanDaily, monthly: validatePlanMonthly };

/**
 * 读取当前计划值（归一化：逐字段可空 + 字段级回退）。
 * @param storage - 注入的存储面（浏览器传 localStorage；node 测试传 fake）。
 * @returns {v:1, daily:number|null, monthly:number|null} | null
 *   —— null 即「未设置」（JSON 损坏/v 段非法/两字段均无效整体回退；不抛错）。
 */
export function loadPlanStore(storage) {
  try {
    const raw = storage?.getItem?.(PLAN_STORE_KEY);
    if (typeof raw === "string" && raw !== "") {
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && parsed.v === 1) {
        /* 字段级归一化：某字段非法仅该字段回退 null；未知字段忽略不报错。 */
        const daily = validatePlanDaily(parsed.daily) ? parsed.daily : null;
        const monthly = validatePlanMonthly(parsed.monthly) ? parsed.monthly : null;
        if (daily !== null || monthly !== null) return { v: 1, daily, monthly };
      }
    }
  } catch {
    /* 损坏即回退「未设置」（规格：不抛错、不阻塞渲染） */
  }
  return null;
}

/**
 * 按「读取现值-合并-写回」落库：省略未设置字段（{v:1, daily?, monthly?} 可选字段语义）。
 * @returns 是否写入成功（存储不可用/配额失败返回 false，调用方自行提示）。
 */
function writeMergedPlanStore(storage, daily, monthly) {
  const record = { v: 1 };
  if (daily !== null) record.daily = daily;
  if (monthly !== null) record.monthly = monthly;
  try {
    if (daily === null && monthly === null) {
      storage?.removeItem?.(PLAN_STORE_KEY);
    } else {
      storage?.setItem?.(PLAN_STORE_KEY, JSON.stringify(record));
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 写入计划值（补丁语义，严格契约：全有或全无）。
 * @param patch - 仅含 daily/monthly 已知键的普通对象，键值均为正有限数。
 *   补丁非普通对象、含未知键或任一键值非法（含显式 null/undefined）时整体拒绝
 *   （返回 false 且既有值不变）；空补丁 {} 为无操作（返回 true、不落库、不广播——
 *   广播由调用方在保存成功后执行，空补丁不应触发）。补丁未涉及字段保持既有值。
 * @returns 是否写入成功（校验失败/存储不可用/配额失败返回 false，调用方自行提示）。
 */
export function savePlanStore(storage, patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return false;
  const keys = Object.keys(patch);
  if (keys.length === 0) return true; /* 空补丁：无操作（不落库、不广播） */
  for (const key of keys) {
    if (!PLAN_FIELD_SET.has(key)) return false; /* 未知键：整体拒绝 */
    if (!FIELD_VALIDATORS[key](patch[key])) return false; /* 非法值（含显式 null/undefined）：整体拒绝 */
  }
  const current = loadPlanStore(storage);
  const daily = "daily" in patch ? patch.daily : current?.daily ?? null;
  const monthly = "monthly" in patch ? patch.monthly : current?.monthly ?? null;
  return writeMergedPlanStore(storage, daily, monthly);
}

/**
 * 字段级清除（恢复该字段「未设置」的唯一动作）。
 * @param field - "daily" | "monthly"（必填；非法字段名返回 false）。
 * 仅移除该字段，两字段均空后删除整个存储键（回到从未设置）。
 * @returns 是否清除成功。
 */
export function clearPlanStore(storage, field) {
  if (field !== "daily" && field !== "monthly") return false;
  const current = loadPlanStore(storage);
  const daily = field === "daily" ? null : current?.daily ?? null;
  const monthly = field === "monthly" ? null : current?.monthly ?? null;
  return writeMergedPlanStore(storage, daily, monthly);
}
