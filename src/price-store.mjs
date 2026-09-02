/**
 * dsh-v-token-insight — 价目表持久化（纯函数、storage 注入，node 可单测）。
 *
 * v0 语义（token-pricing 规格「价目表维护与持久化」）：
 *  - 持久化于浏览器 localStorage（键 dsh-v-token-insight.prices.v1）；
 *  - 存储损坏（JSON 解析失败 / 结构非法）时回退内置默认表，不抛错；
 *  - 费用每次按当前价目即时计算、不落库——价目修改后历史轮自然重算。
 * 将来如需跨设备同步，迁到宿主端 settings namespace（settingsScope 机制）。
 */

import { DEFAULT_PRICE_TABLE, validatePriceTable } from "./pricing.mjs";

/** localStorage 键（v1）。 */
export const PRICE_STORE_KEY = "dsh-v-token-insight.prices.v1";

/**
 * 读取当前价目表。
 * @param storage - 注入的存储面（浏览器传 localStorage；node 测试传 fake）。
 * @returns 校验通过的价目表；缺省/损坏/非法一律回退内置默认表。
 */
export function loadPriceTable(storage) {
  try {
    const raw = storage?.getItem?.(PRICE_STORE_KEY);
    if (typeof raw === "string" && raw !== "") {
      const parsed = JSON.parse(raw);
      const validated = validatePriceTable(parsed);
      if (validated) return validated;
    }
  } catch {
    /* 损坏即回退默认（规格：不抛错、不阻塞渲染） */
  }
  return DEFAULT_PRICE_TABLE;
}

/**
 * 写入价目表。
 * @returns 是否写入成功（存储不可用/配额失败返回 false，调用方自行提示）。
 */
export function savePriceTable(storage, table) {
  const validated = validatePriceTable(table);
  if (!validated) return false;
  try {
    storage?.setItem?.(PRICE_STORE_KEY, JSON.stringify(validated));
    return true;
  } catch {
    return false;
  }
}

/** 清除持久化（恢复默认表用）。 */
export function clearPriceTable(storage) {
  try {
    storage?.removeItem?.(PRICE_STORE_KEY);
    return true;
  } catch {
    return false;
  }
}

/** 价目变更通知事件名（编辑器保存后广播，统计页/chip 监听重算）。 */
export const PRICES_CHANGED_EVENT = "dsh-v-token-insight:prices-changed";

/** 编辑器打开请求事件名（settings 行 → shell.overlay 编辑器）。 */
export const PRICES_EDIT_EVENT = "dsh-v-token-insight:edit-prices";
