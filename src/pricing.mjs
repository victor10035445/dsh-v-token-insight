/**
 * dsh-v-token-insight — 价格表与计费（纯函数、零依赖，node 下可直接单测）。
 *
 * 设计（探索阶段结论）：
 *  - L1 四桶单价：DSH 的 usage 四桶互斥（dsh-llm TokenUsage）——
 *    input（未命中缓存）/ cacheRead（命中缓存）/ cacheWrite（缓存写入）/
 *    output（输出；reasoning 已含在内，不重复计价）。
 *    单价统一按「每百万 token」（MTok）。
 *  - L2 分档区间，两种维度：
 *      · minContextTokens —— 按该步 prompt 规模（三桶输入之和）分档，
 *        对应 DeepSeek ≤128k/>128k、Gemini 200k 分档这类「按请求规模调价」；
 *      · minCumulativeTokens —— 按会话内该模型的累计消耗分档，作为
 *        「计费周期批发档」的近似（真实批发按账户·周期计，此处明示为近似，
 *        客户端只能以已加载窗口内的累计递推）。
 *    tiers 按阈值升序书写，取「最后一个满足其全部已声明阈值」的档；
 *    无一满足回 defaultTier。
 *  - L3 折扣：timeWindows 时段折扣（如错峰半价，按步事件时间匹配，
 *    支持跨午夜窗口）与条目级 discount 全局折扣（如协议价 9 折），连乘。
 *  - 计费必须逐步（per-step）：同一会话内档位（长会话后半段跨 128k 线）、
 *    时段、模型都可能变化，绝不能「总量 × 单价」。
 *  - 语义约定：
 *      · 无匹配条目 → 该步不计费（未定价步不计入任何费用合计，不猜价）；
 *        轮/会话费用 = 已定价步之和，未定价原因如实披露（fix-step-level-cost）；
 *      · 费用每次按当前价目表即时计算、不落库——价目表修改后历史轮自然
 *        重算，代价是「历史费用随价目漂移」，UI 以「折算值仅供参考」表达；
 *      · 币种跟条目走；v0 全局一个显示币种（UI 层约束），不做自动汇率。
 */

/** 单价计量：每百万 token。 */
export const UNIT = 1_000_000;

/** 桶字段名（校验与编辑器共用）。 */
export const BUCKETS = ["input", "cacheRead", "cacheWrite", "output"];

/**
 * 预置默认价目（底稿：2026-09-16 三厂商官网刊例价，用户可在设置中维护）。
 * cacheWrite=0 表示该厂商不单独收缓存写入费；档位/时段/折扣字段缺省按 1/无 处理。
 *
 * 口径说明（与官网价的对应关系，调价时请对照官网复核）：
 *  - DeepSeek（2026-09-16 对照
 *    https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ 更新）：
 *    V4 系列分高峰/空闲两档，高峰 = 北京时间周一至五 9:00–12:00、14:00–18:00，
 *    空闲为高峰半价。defaultTier 填空闲价、高峰用 timeWindows ×2 还原；
 *    DSH 时段窗口无星期维度，周末白天会被误按高峰计（宁可高估方向）。
 *    缓存命中单独计价、无缓存写入费。
 *    · 现行模型名 `deepseek-flash`（版本 DeepSeek-V4.1-Flash）：空闲
 *      0.02 / 1 / 4，高峰 0.04 / 2 / 8。
 *    · `deepseek-v4-pro`（版本 DeepSeek-V4-Pro-0813）本次单价未变：空闲
 *      0.15 / 4.5 / 13.5，高峰 0.30 / 9.0 / 27.0；官方公告 2026-09-14 后继续
 *      供服且计费方式不变。
 *    · 旧名 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 官方仍接受
 *      调用，但对应模型已下线，请求由 DeepSeek-V4.1-Flash 提供服务并按 Flash
 *      价计费——故与 `deepseek-flash` 同价并列保留（勿删旧名：历史步骤仍需
 *      按其模型名折算，且实测网关仍可能回传旧名）。
 *    · deepseek-chat / deepseek-reasoner 已于 2026-07-24 停用（曾指向
 *      V4-Flash），保留旧价仅为折算停用前的历史步骤。
 *  - Kimi/月之暗面（platform.moonshot.cn）：kimi-k3 官方刊例价 缓存命中 2 /
 *    未命中 20 / 输出 100，无缓存写入费；前提是接入网关按官方刊例计费。
 *  - 千问/百炼：cacheRead 取隐式缓存命中价（约输入 20%）。例外：qwen3.8 系官方
 *    明示命中价非 20% 且未公开——qwen3.8-flash 经确认先按 20% 近似收录（待控制台
 *    准确值校准），qwen3.8-max / qwen3.8-2.4t-a95b 仍未收录（不猜价）；
 *    显式缓存（cache_control）创建按输入 125%，用到时手工改 cacheWrite。
 *    qwen-plus / qwen-turbo 思考模式输出单价更高（8 / 3 元），表中取非思考价。
 *    阶梯按单次请求输入分档：128K=131072、256K=262144。
 *  - 智谱/bigmodel（2026-09-16 对照
 *    https://docs.bigmodel.cn/cn/guide/start/pricing 复核）：缓存命中单独定价
 *    （约为输入 25%）；缓存存储按「百万 token·小时」计费且当前限时免费——
 *    四桶模型表达不了按小时存储费，cacheWrite 填 0。
 *    glm-5.3-flash 的 5 折限时价已于 2026-09-09 到期，现按刊例价
 *    0.8 / 0.23 / 2.8 收录（原 0.4 / 0.115 / 1.4 为过期促销价，已作废）。
 *    glm-4.7 的 ≤32K 档还按输出长度再分档（≤0.2K 输出 2/0.4/8），DSH 无
 *    输出长度维度，取该区间中高档 3 / 0.6 / 14。
 * @type {Array<object>}
 */
export const DEFAULT_PRICE_TABLE = [
  /* —— DeepSeek 停用别名（仅折算历史步骤，勿删）—— */
  {
    model: "deepseek-chat",
    provider: "",
    currency: "CNY",
    unit: "MTok",
    defaultTier: { input: 2, cacheRead: 0.2, cacheWrite: 0, output: 3 },
    tiers: [],
    timeWindows: [],
    discount: 1
  },
  {
    model: "deepseek-reasoner",
    provider: "",
    currency: "CNY",
    unit: "MTok",
    defaultTier: { input: 2, cacheRead: 0.2, cacheWrite: 0, output: 3 },
    tiers: [],
    timeWindows: [],
    discount: 1
  },
  /* —— DeepSeek V4 现行价（defaultTier=空闲档，高峰窗口 ×2）—— */
  {
    model: "deepseek-flash",
    provider: "",
    currency: "CNY",
    unit: "MTok",
    /* 空闲档 0.02 / 1 / 4（缓存命中 / 未命中 / 输出），高峰 ×2。 */
    defaultTier: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 },
    tiers: [],
    timeWindows: [
      { from: "09:00", to: "12:00", multiplier: 2 },
      { from: "14:00", to: "18:00", multiplier: 2 }
    ],
    discount: 1
  },
  {
    /* 旧模型名：官方仍接受调用，实际由 V4.1-Flash 供服、按 Flash 价计费。 */
    model: "deepseek-v4-flash",
    provider: "",
    currency: "CNY",
    unit: "MTok",
    defaultTier: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 },
    tiers: [],
    timeWindows: [
      { from: "09:00", to: "12:00", multiplier: 2 },
      { from: "14:00", to: "18:00", multiplier: 2 }
    ],
    discount: 1
  },
  {
    model: "deepseek-v4-pro",
    provider: "",
    currency: "CNY",
    unit: "MTok",
    /* 本次调价未变：空闲档 0.15 / 4.5 / 13.5，高峰 ×2 = 0.30 / 9.0 / 27.0。 */
    defaultTier: { input: 4.5, cacheRead: 0.15, cacheWrite: 0, output: 13.5 },
    tiers: [],
    timeWindows: [
      { from: "09:00", to: "12:00", multiplier: 2 },
      { from: "14:00", to: "18:00", multiplier: 2 }
    ],
    discount: 1
  },
  {
    /* 旧模型名：同 v4-flash，由 V4.1-Flash 供服并按 Flash 价计费。 */
    model: "deepseek-v4-flash-vision-exp",
    provider: "",
    currency: "CNY",
    unit: "MTok",
    defaultTier: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 },
    tiers: [],
    timeWindows: [
      { from: "09:00", to: "12:00", multiplier: 2 },
      { from: "14:00", to: "18:00", multiplier: 2 }
    ],
    discount: 1
  },
  /* —— 千问 / 阿里云百炼（隐式缓存 cacheRead=输入×20%，cacheWrite=0）—— */
  {
    model: "qwen-max",
    provider: "",
    currency: "CNY",
    unit: "MTok",
    defaultTier: { input: 2.4, cacheRead: 0.48, cacheWrite: 0, output: 9.6 },
    tiers: [],
    timeWindows: [],
    discount: 1
  },
  {
    model: "qwen-plus",
    provider: "",
    currency: "CNY",
    unit: "MTok",
    defaultTier: { input: 0.8, cacheRead: 0.16, cacheWrite: 0, output: 2 },
    tiers: [
      { minContextTokens: 131072, input: 2.4, cacheRead: 0.48, cacheWrite: 0, output: 20 },
      { minContextTokens: 262144, input: 4.8, cacheRead: 0.96, cacheWrite: 0, output: 48 }
    ],
    timeWindows: [],
    discount: 1
  },
  {
    model: "qwen-flash",
    provider: "",
    currency: "CNY",
    unit: "MTok",
    defaultTier: { input: 0.15, cacheRead: 0.03, cacheWrite: 0, output: 1.5 },
    tiers: [
      { minContextTokens: 131072, input: 0.6, cacheRead: 0.12, cacheWrite: 0, output: 6 },
      { minContextTokens: 262144, input: 1.2, cacheRead: 0.24, cacheWrite: 0, output: 12 }
    ],
    timeWindows: [],
    discount: 1
  },
  {
    model: "qwen3.8-flash",
    provider: "",
    currency: "CNY",
    unit: "MTok",
    /* 官方明示缓存命中价非 20% 且未公开——此处 0.16 为经确认的 20% 近似，待控制台校准。 */
    defaultTier: { input: 0.8, cacheRead: 0.16, cacheWrite: 0, output: 2.7 },
    tiers: [],
    timeWindows: [],
    discount: 1
  },
  {
    model: "qwen-turbo",
    provider: "",
    currency: "CNY",
    unit: "MTok",
    defaultTier: { input: 0.3, cacheRead: 0.06, cacheWrite: 0, output: 0.6 },
    tiers: [],
    timeWindows: [],
    discount: 1
  },
  /* —— Kimi / 月之暗面（官方刊例；前提：网关按官方价计费）—— */
  {
    model: "kimi-k3",
    provider: "",
    currency: "CNY",
    unit: "MTok",
    defaultTier: { input: 20, cacheRead: 2, cacheWrite: 0, output: 100 },
    tiers: [],
    timeWindows: [],
    discount: 1
  },
  /* —— 智谱 bigmodel（cacheRead=缓存命中价，cacheWrite=0：存储按小时且限时免费）—— */
  {
    model: "glm-5.3",
    provider: "",
    currency: "CNY",
    unit: "MTok",
    defaultTier: { input: 8, cacheRead: 2, cacheWrite: 0, output: 28 },
    tiers: [],
    timeWindows: [],
    discount: 1
  },
  {
    model: "glm-5.3-flash",
    provider: "",
    currency: "CNY",
    unit: "MTok",
    /* 5 折限时价（0.4/0.115/1.4）已于 2026-09-09 到期，恢复刊例价。 */
    defaultTier: { input: 0.8, cacheRead: 0.23, cacheWrite: 0, output: 2.8 },
    tiers: [],
    timeWindows: [],
    discount: 1
  },
  {
    model: "glm-5.2",
    provider: "",
    currency: "CNY",
    unit: "MTok",
    defaultTier: { input: 8, cacheRead: 2, cacheWrite: 0, output: 28 },
    tiers: [],
    timeWindows: [],
    discount: 1
  },
  {
    model: "glm-5.1",
    provider: "",
    currency: "CNY",
    unit: "MTok",
    defaultTier: { input: 6, cacheRead: 1.3, cacheWrite: 0, output: 24 },
    tiers: [{ minContextTokens: 32768, input: 8, cacheRead: 2, cacheWrite: 0, output: 28 }],
    timeWindows: [],
    discount: 1
  },
  {
    model: "glm-5",
    provider: "",
    currency: "CNY",
    unit: "MTok",
    defaultTier: { input: 4, cacheRead: 1, cacheWrite: 0, output: 18 },
    tiers: [{ minContextTokens: 32768, input: 6, cacheRead: 1.5, cacheWrite: 0, output: 22 }],
    timeWindows: [],
    discount: 1
  },
  {
    model: "glm-5-turbo",
    provider: "",
    currency: "CNY",
    unit: "MTok",
    defaultTier: { input: 5, cacheRead: 1.2, cacheWrite: 0, output: 22 },
    tiers: [{ minContextTokens: 32768, input: 7, cacheRead: 1.8, cacheWrite: 0, output: 26 }],
    timeWindows: [],
    discount: 1
  },
  {
    model: "glm-4.7",
    provider: "",
    currency: "CNY",
    unit: "MTok",
    defaultTier: { input: 3, cacheRead: 0.6, cacheWrite: 0, output: 14 },
    tiers: [{ minContextTokens: 32768, input: 4, cacheRead: 0.8, cacheWrite: 0, output: 16 }],
    timeWindows: [],
    discount: 1
  },
  {
    model: "glm-4.7-flashx",
    provider: "",
    currency: "CNY",
    unit: "MTok",
    defaultTier: { input: 0.5, cacheRead: 0.1, cacheWrite: 0, output: 3 },
    tiers: [],
    timeWindows: [],
    discount: 1
  }
];

/** 条目模式是否为前缀通配（如 "deepseek-*"），返回前缀或 null。 */
function wildcardPrefix(pattern) {
  return typeof pattern === "string" && pattern.endsWith("*") ? pattern.slice(0, -1) : null;
}

/**
 * 匹配价格条目：精确模型名优先；否则取最长前缀通配命中。
 * @param table - 价格条目数组（loadPriceTable 的产物）。
 * @param model - 该步 provenance.model。
 * @param provider - 该步 provenance.provider（条目 provider 留空 = 匹配任意路由）。
 * @returns 命中的条目，或 null（无匹配——调用方不猜价）。
 */
export function matchPriceEntry(table, model, provider = "") {
  let best = null;
  let bestPrefix = -1;
  for (const entry of table ?? []) {
    if (entry.provider && entry.provider !== provider) continue;
    if (entry.model === model) return entry;
    const prefix = wildcardPrefix(entry.model);
    if (prefix !== null && model.startsWith(prefix) && prefix.length > bestPrefix) {
      best = entry;
      bestPrefix = prefix.length;
    }
  }
  return best;
}

/** 该步 prompt 规模（上下文分档的匹配键）：三桶输入之和（桶互斥，直接相加）。 */
export function promptTokens(usage) {
  return (
    (usage?.inputTokens ?? 0) +
    (usage?.cacheReadTokens ?? 0) +
    (usage?.cacheWriteTokens ?? 0)
  );
}

/**
 * 解析该步命中的档位：tiers 顺序即阈值升序，取最后一个满足其全部已声明
 * 阈值者（声明了哪个维度就按哪个维度判，两个都声明则需同时满足）；
 * 无一满足或未声明 tiers 时回 defaultTier。
 * @param entry - 价格条目。
 * @param contextTokens - 该步 prompt 规模。
 * @param cumulativeTokens - 该模型会话内累计消耗。
 */
export function resolveTier(entry, { contextTokens = 0, cumulativeTokens = 0 } = {}) {
  let tier = entry?.defaultTier ?? null;
  for (const candidate of entry?.tiers ?? []) {
    const needContext = candidate.minContextTokens ?? null;
    const needCumulative = candidate.minCumulativeTokens ?? null;
    const ok =
      (needContext === null || contextTokens >= needContext) &&
      (needCumulative === null || cumulativeTokens >= needCumulative);
    if (ok) tier = candidate;
  }
  return tier;
}

/** "HH:mm" → 当日分钟数。 */
function minutesOf(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * 时段折扣系数：命中任一窗口取其 multiplier，否则 1。
 * 窗口支持跨午夜（from > to 视为跨夜，如 23:00–08:30）；
 * 边界约定：from 端含（>= from），to 端不含（< to）——
 * 23:00 落在 23:00–08:30 窗口内，08:30 不落在其中。
 */
export function timeMultiplier(entry, date) {
  if (!entry?.timeWindows?.length || !(date instanceof Date)) return 1;
  const minute = date.getHours() * 60 + date.getMinutes();
  for (const window of entry.timeWindows) {
    const from = minutesOf(window.from);
    const to = minutesOf(window.to);
    const inside = from <= to ? minute >= from && minute < to : minute >= from || minute < to;
    if (inside) return window.multiplier ?? 1;
  }
  return 1;
}

/**
 * 一步的折算费用。
 * @param entry - matchPriceEntry 命中的价格条目；null 直接返回 null。
 * @param usage - 该步 TokenUsage（四桶；缺省字段按 0）。
 * @param options.time - 该步事件时间（Date 或 epoch ms），用于时段折扣。
 * @param options.cumulativeTokens - 该模型在会话内的累计消耗（累计分档键）。
 * @returns { currency, cost, multiplier, timeFactor, tier }，或 null（无条目/无任何 token/无档）。
 *   multiplier = 条目 discount × 时段系数；timeFactor 单独给出（tooltip 追溯用）。
 */
export function stepCost(entry, usage, { time, cumulativeTokens = 0 } = {}) {
  if (!entry) return null;
  const input = usage?.inputTokens ?? 0;
  const cacheRead = usage?.cacheReadTokens ?? 0;
  const cacheWrite = usage?.cacheWriteTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  if (input + cacheRead + cacheWrite + output === 0) return null;
  const tier = resolveTier(entry, { contextTokens: promptTokens(usage), cumulativeTokens });
  if (!tier) return null;
  const date = time instanceof Date ? time : typeof time === "number" ? new Date(time) : null;
  const timeFactor = timeMultiplier(entry, date);
  const multiplier = (entry.discount ?? 1) * timeFactor;
  const cost =
    ((input * (tier.input ?? 0) +
      cacheRead * (tier.cacheRead ?? 0) +
      cacheWrite * (tier.cacheWrite ?? 0) +
      output * (tier.output ?? 0)) /
      UNIT) *
    multiplier;
  return { currency: entry.currency ?? "CNY", cost, multiplier, timeFactor, tier };
}

/**
 * 时段折扣系数（按已判定的命中窗口）：账本老化桶计价用。
 * 老化把「该步命中哪个窗口（from/to 边界）」固化进桶；计价时在当前条目的
 * timeWindows 里重查同边界窗口取其 multiplier（价目编辑后随价目漂移的既有
 * 语义）；窗口已不存在时按 1 处理（命中归属仍在桶上，只是系数消失）。
 * @param entry - 价格条目。
 * @param win - {from, to} | null（null = 无命中窗口，系数 1）。
 */
export function windowFactorOf(entry, win) {
  if (!win || !entry?.timeWindows?.length) return 1;
  for (const window of entry.timeWindows) {
    if (window.from === win.from && window.to === win.to) return window.multiplier ?? 1;
  }
  return 1;
}

/**
 * 账本老化聚合桶的一笔折算费用：defaultTier × 四桶 × 折扣窗口命中系数。
 * 与 stepCost 的差异：老化丢掉了逐步的 prompt 规模与累计量（L2 分档不可
 * 恢复，按 defaultTier 计），L3 时段折扣按记录的命中窗口保留。
 * @param entry - matchPriceEntry 命中的价格条目；null 返回 null。
 * @param buckets - {inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens}。
 * @param options.win - {from, to} | null 老化时记录的命中窗口。
 * @returns { currency, cost, multiplier, timeFactor, tier }，或 null（无条目/无 token/无档）。
 */
export function bucketSetCost(entry, buckets, { win = null } = {}) {
  if (!entry) return null;
  const tier = entry.defaultTier ?? null;
  if (!tier) return null;
  const input = buckets?.inputTokens ?? 0;
  const cacheRead = buckets?.cacheReadTokens ?? 0;
  const cacheWrite = buckets?.cacheWriteTokens ?? 0;
  const output = buckets?.outputTokens ?? 0;
  if (input + cacheRead + cacheWrite + output === 0) return null;
  const timeFactor = windowFactorOf(entry, win);
  const multiplier = (entry.discount ?? 1) * timeFactor;
  const cost =
    ((input * (tier.input ?? 0) +
      cacheRead * (tier.cacheRead ?? 0) +
      cacheWrite * (tier.cacheWrite ?? 0) +
      output * (tier.output ?? 0)) /
      UNIT) *
    multiplier;
  return { currency: entry.currency ?? "CNY", cost, multiplier, timeFactor, tier };
}

const CURRENCY_SYMBOL = { CNY: "¥", USD: "$" };

/** 费用显示：≥1 保留 2 位小数，小金额保留 4 位，带币种符号（未知币种无符号）。 */
export function formatMoney(cost, currency = "CNY") {
  const symbol = CURRENCY_SYMBOL[currency] ?? "";
  if (!Number.isFinite(cost)) return symbol + "—";
  return symbol + (Math.abs(cost) >= 1 ? cost.toFixed(2) : cost.toFixed(4));
}

/**
 * 双轴图右轴金额刻度（rework-kpi-charts D3，自 client.jsx 迁入以供 node 单测）：
 *  - cost ≥ 1（取整后）：整数化并剥 ".00" 尾缀（¥50 而非 ¥50.00，既有行为）；
 *  - 0 < cost < 1：至多 4 位小数剥尾零（0.3 → "¥0.3"、0.05 → "¥0.05"）——
 *    修复既有 bug：先取整后过 formatMoney 小额 4 位小数路径，尾缀剥离正则
 *    匹配不上，轴上悬 "¥0.0000"（MUST NOT 取整坍缩为 0）；
 *  - cost = 0 → "¥0"（调用侧零刻度不渲染文本，兜底形状完整）。
 */
export function formatAxisMoney(cost, currency = "CNY") {
  const symbol = CURRENCY_SYMBOL[currency] ?? "";
  if (!Number.isFinite(cost)) return formatMoney(cost, currency);
  if (Math.round(cost) >= 1) return formatMoney(Math.round(cost), currency).replace(/\.00$/, "");
  if (cost > 0) return symbol + cost.toFixed(4).replace(/\.?0+$/, "");
  return symbol + "0";
}

/** v0 显示币种：价目表首个条目的币种（编辑器落地后由显式设置取代）。 */
export function displayCurrencyOf(table) {
  return table?.[0]?.currency ?? "CNY";
}

/* ------------------------------------------------------------------ *
 * 价目表结构校验（持久化回退与 JSON 导入共用同一守卫）。
 * ------------------------------------------------------------------ */

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sanitizeTier(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  const tier = {};
  if (raw.minContextTokens !== void 0 && raw.minContextTokens !== null) {
    const n = Number(raw.minContextTokens);
    if (!Number.isFinite(n) || n < 0) return null;
    tier.minContextTokens = n;
  }
  if (raw.minCumulativeTokens !== void 0 && raw.minCumulativeTokens !== null) {
    const n = Number(raw.minCumulativeTokens);
    if (!Number.isFinite(n) || n < 0) return null;
    tier.minCumulativeTokens = n;
  }
  if (tier.minContextTokens === void 0 && tier.minCumulativeTokens === void 0) return null;
  for (const bucket of BUCKETS) tier[bucket] = finiteNumber(Number(raw[bucket]));
  return tier;
}

function sanitizeTimeWindow(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (typeof raw.from !== "string" || !timeRe.test(raw.from)) return null;
  if (typeof raw.to !== "string" || !timeRe.test(raw.to)) return null;
  const multiplier = Number(raw.multiplier);
  if (!Number.isFinite(multiplier) || multiplier < 0) return null;
  return { from: raw.from, to: raw.to, multiplier };
}

/**
 * 校验并净化一份价目表（localStorage 读取与 JSON 导入共用）。
 * @returns 净化后的条目数组；结构性不可用（非数组/零条目/条目全非法）返回 null。
 */
export function validatePriceTable(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const table = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    if (typeof raw.model !== "string" || raw.model.trim() === "") continue;
    const currency = typeof raw.currency === "string" && raw.currency.trim() !== "" ? raw.currency.trim().toUpperCase() : "CNY";
    const defaultTierRaw = typeof raw.defaultTier === "object" && raw.defaultTier !== null ? raw.defaultTier : {};
    const defaultTier = {};
    for (const bucket of BUCKETS) defaultTier[bucket] = finiteNumber(Number(defaultTierRaw[bucket]));
    const tiers = Array.isArray(raw.tiers)
      ? raw.tiers.map(sanitizeTier).filter((tier) => tier !== null)
      : [];
    const timeWindows = Array.isArray(raw.timeWindows)
      ? raw.timeWindows.map(sanitizeTimeWindow).filter((window) => window !== null)
      : [];
    const discount = Number(raw.discount);
    table.push({
      model: raw.model.trim(),
      provider: typeof raw.provider === "string" ? raw.provider.trim() : "",
      currency,
      unit: "MTok",
      defaultTier,
      tiers,
      timeWindows,
      discount: Number.isFinite(discount) && discount >= 0 ? discount : 1
    });
  }
  return table.length > 0 ? table : null;
}

/* ------------------------------------------------------------------ *
 * 每轮行计价（统计页与 chip 共用；纯函数便于单测累计分档漂移）。
 * ------------------------------------------------------------------ */

const UNPRICED_NO_ENTRY = "无价目";
const UNPRICED_CURRENCY = (currency) => `币种不符(${currency})`;
/** 账本条目模型名缺失（不可归因）时的展示名（fix-ledger-attribution）。 */
export const UNKNOWN_MODEL_LABEL = "未知模型";

/**
 * 给折叠行逐步计价（per-step；累计分档键 = 窗口内该模型此前步的
 * 输入+输出累计，「批发档」近似语义，见头注）。
 *
 * 步级语义（fix-step-level-cost：轮/会话费用 = 已定价步之和）：
 *  - 步模型无匹配条目 →「无价目」；步命中条目币种 ≠ 显示币种 →「币种不符」
 *    ——未定价步 MUST NOT 计入费用合计（不猜价、绝不跨币种求和、不自动换汇），
 *    但已定价步照常计入轮/会话合计，未定价原因在 unmatched 如实披露；
 *  - 行费用 = 该轮已定价步之和；整轮无任何已定价步时 cost = null（显示「未定价」）；
 *  - 时段折扣时间口径：优先该步请求开始时刻（startTime = timing.stepStartTime），
 *    缺失回退 assistant/message 落盘时刻；
 *  - usage 缺省步（中断/失败）不计费（token-pricing 规格「逐步计费」）。
 *
 * @param rows - foldTurns 产物（升序）。
 * @param table - 价目表。
 * @returns 与 rows 平行的行数组，附 { cost|null, currency, unmatched: ["模型:原因"],
 *   stepPrices: [ {cost|null, currency, tier, timeFactor, multiplier}|null ] }。
 *   stepPrices 与 row.steps 平行：无 usage 步为 null；已定价步含命中档与折扣。
 */
export function priceTurnRows(rows, table) {
  const displayCurrency = displayCurrencyOf(table);
  const cumulative = new Map();
  return (rows ?? []).map((row) => {
    let cost = 0;
    let pricedCount = 0;
    let usageSteps = 0;
    const unmatched = new Map();
    const stepPrices = row.steps.map((step) => {
      if (!step.usage) return null;
      usageSteps += 1;
      const entry = matchPriceEntry(table, step.model ?? "", step.provider ?? "");
      if (!entry) {
        unmatched.set(step.model || UNKNOWN_MODEL_LABEL, UNPRICED_NO_ENTRY);
        return null;
      }
      if (entry.currency !== displayCurrency) {
        unmatched.set(step.model || UNKNOWN_MODEL_LABEL, UNPRICED_CURRENCY(entry.currency));
        return null;
      }
      const key = step.model ?? "";
      const total = cumulative.get(key) ?? 0;
      cumulative.set(key, total + promptTokens(step.usage) + (step.usage.outputTokens ?? 0));
      const result = stepCost(entry, step.usage, {
        time: step.startTime ?? step.time,
        cumulativeTokens: total
      });
      cost += result.cost;
      pricedCount += 1;
      return result;
    });
    return {
      ...row,
      /* 无步 / 仅缺 usage 步 → 0（无未定价问题）；有 usage 步但全未定价 → null（显示「未定价」） */
      cost: usageSteps === 0 ? 0 : pricedCount > 0 ? cost : null,
      currency: displayCurrency,
      unmatched: [...unmatched.entries()].map(([model, reason]) => `${model}:${reason}`),
      stepPrices
    };
  });
}
