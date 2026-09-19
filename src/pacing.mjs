/**
 * dsh-v-token-insight — 深补节奏控制（纯函数、零依赖，node 可单测）。
 *
 * 背景（fix-deep-completion-host-pressure）：宿主进程（dsh web）在「重建/自动深补 ×
 * 子会话风暴」负载叠加下两次 OOM。插件能做的是削减自身负载的峰值与最坏时机：
 * 页间让出（D4 常规档间隙）+ RTT 感知指数退避（D6）。本模块是常量唯一源——
 * `client.jsx` 导入 `PAGE_GAP_BASE_MS` 消费，不重复定义（杜绝双源漂移）。
 *
 * 采样纪律（D6，防误触发）：
 *  - cursor 探测请求排除在采样外——它是冷会话的首个 `page` 调用，承载全量解压+
 *    物化成本（秒级属正常），衡量的是磁盘与 CPU 而非拥塞；若计入，重建逐会话
 *    探测会把 EWMA 反复抬过阈值，退避在健康宿主上误触发。探测后 LRU 必热
 *    （同会话串行翻页期间条目为最近触碰，5 槽内不被挤出），翻页样本干净。
 *  - EWMA 状态随单次深补调用存续（逐会话重置）：单会话内吸收偶发毛刺；跨会话
 *    不携带陈旧水位，拥塞若持续，新会话数页内重新升档。
 *  - 已知残留误报方向（接受）：采样含浏览器侧事件循环延迟——总览页重渲染繁忙
 *    时 RTT 虚高，退避方向只会「更慢」不会「出错」。
 *
 * 全部决策为确定性纯函数：同输入同输出，无时钟、无随机、无外部状态。
 */

/** 常规档页间隙（ms，D4）：相邻 page 请求之间的最小让出；实测后可调（沿
 *  LEDGER_RAW_RETENTION_DAYS 先例，常量导出即调参面）。 */
export const PAGE_GAP_BASE_MS = 40;

/** 指数底（D6）：升档时间隙 ×FACTOR，降档时间隙 /FACTOR（半步回落）。 */
export const PAGE_GAP_FACTOR = 2;

/** 退避封顶（ms，D6）：50 页会话最坏 +~75s，可接受且可中止——深补不被无限拖延。 */
export const PAGE_GAP_MAX_MS = 1500;

/** 升档阈值（ms，D6）：EWMA 严格越过即升档。初值偏保守，实测基线后可回调
 *  （tasks 5.1：探测与翻页 RTT 分开记录核对）。 */
export const RTT_BACKOFF_THRESHOLD_MS = 1500;

/** 降档滞回阈值（ms，D6）：EWMA 严格低于才回落，防临界抖动（750–1500 维持）。 */
export const RTT_RECOVER_THRESHOLD_MS = 750;

/** EWMA 平滑系数（D6）：ewma = α·sample + (1−α)·prev；α 越小越抗毛刺。 */
export const RTT_EWMA_ALPHA = 0.25;

/**
 * RTT 样本平滑（EWMA）。
 * @param prev - 既有 EWMA 值（number | null/undefined = 尚无样本）。
 * @param sample - 本次翻页请求往返延迟（ms）。
 * @returns 新 EWMA 值；首样原样返回（不做半程偏低）；样本非法（非有限/负数）
 *   时视为无样本——返回既有 prev（number）或 null。
 */
export function smoothRtt(prev, sample) {
  const value = Number(sample);
  if (!Number.isFinite(value) || value < 0) {
    return typeof prev === "number" && Number.isFinite(prev) ? prev : null;
  }
  if (typeof prev !== "number" || !Number.isFinite(prev)) return value; /* 首样原样返回 */
  return RTT_EWMA_ALPHA * value + (1 - RTT_EWMA_ALPHA) * prev;
}

/**
 * 下一页间隙决策（D6：升档 min(×FACTOR, MAX)、降档 max(BASE, /FACTOR) 半步回落、
 * 临界维持；阈值比较为严格不等——恰在阈值上（含 750–1500 闭区间）维持，滞回防抖）。
 *
 * @param ewma - 平滑 RTT（ms；null = 尚无翻页样本，维持当前档）。
 * @param currentGap - 当前页间隙（ms；非法时按 BASE 归一）。
 * @returns 下一页间隙（ms），确定性。
 */
export function nextGapMs(ewma, currentGap) {
  let gap = Number(currentGap);
  if (!Number.isFinite(gap) || gap < PAGE_GAP_BASE_MS) gap = PAGE_GAP_BASE_MS;
  if (typeof ewma !== "number" || !Number.isFinite(ewma)) return gap; /* 无样本：维持 */
  if (ewma > RTT_BACKOFF_THRESHOLD_MS) return Math.min(gap * PAGE_GAP_FACTOR, PAGE_GAP_MAX_MS);
  if (ewma < RTT_RECOVER_THRESHOLD_MS) return Math.max(PAGE_GAP_BASE_MS, gap / PAGE_GAP_FACTOR);
  return gap; /* 临界区维持 */
}
