/**
 * dsh-v-token-insight — Tier 1：本地逐步账本（纯函数 + storage 注入，node 可单测）。
 *
 * 语义（token-stats-overview 规格「本地账本」）：
 *  - 键 (sessionId, turn, step) → {provider, model, 四桶, 发生时刻}；
 *    持久化 localStorage，损坏按分片粒度回退空账本；
 *  - 沉淀：会话页签/chip 的 foldTurns+join 结果按 (turn, step) 幂等 upsert
 *    （last-wins，天然覆盖重试取终值）；
 *  - 深度补全：按会话 opt-in 经 session.history 离线折算（stats-fold 的
 *    foldHistoryEvents），记录覆盖 seq 区间，达预算上限如实标注部分覆盖；
 *  - 费用：仅账本覆盖段按 token-pricing 逐步语义计费（绝不「总量 × 单价」）；
 *    原始条目走 priceTurnRows（档位/币种守卫齐全）；老化桶按 defaultTier +
 *    折扣窗口命中计费（L3 时段折扣语义保留；L2 上下文/累计分档在老化后不可
 *    恢复——原始条目保留窗口内仍逐步精确）；
 *  - 压缩老化（落盘固化）：陈旧步卷为「日（本地时区） × 模型 × 折扣窗口命中」
 *    聚合桶；窗口命中在老化时按当前价目表判定，桶记录命中窗口 {from,to}，
 *    计价时按当前表同窗口重查 multiplier（价目编辑后的既有「随价目漂移」语义）；
 *    老化随持久化编排执行（fix-ledger-quota-budget：成功路径恒运行，不再仅作
 *    配额失败的兜底触发），窗口外原始步「落盘固化」为按日聚合桶；
 *  - 孤儿 GC：已从会话列表消失的会话，宽限期后清理；提供手动清除。
 *  - 总量预算（fix-ledger-quota-budget D2/D4）：持久化前估算序列化水位
 *    （estimateLedgerBytes + 分片尺寸缓存，design D3），超限按确定性阶梯收缩——
 *    全固化档（仅今日原始条目）→ lastSeen 最旧优先整会话逐出 → 内存模式兜底。
 *
 * 存储布局（v2 分片，perf-hot-path-optimization D4/R4；内存形状与导出/导入
 * JSON 完全不变，仍是 {v:1, sessions:{[sid]: …}} 整体形状）：
 *  - 索引键 `dsh-v-token-insight.ledger.v2.index` → {v:2, sessions:{[sid]: {lastSeen,
 *    coverage}}}（O(S) 常小，整写）；
 *  - 会话分片键 `dsh-v-token-insight.ledger.v2.s.<sid>` → 紧凑编码分片（D5）：
 *    {c: [[provider, model]…], entries: [[k, 字典序号, in, cr, cw, out, t, stRel?]],
 *    buckets: […原样…]}——四桶定序数组 + 模型分片字典（分片头部）+ st 相对偏移；
 *    lastSeen/coverage 以索引为权威，分片 MUST NOT 双写。旧版「含内嵌元数据的
 *    完整逐会话形状」分片照常读取（读取双兼容，条目新旧编码均正确净化）；
 *  - 模式优先级：v1 键存在 → v1 权威重迁移（覆盖 v2 后删 v1，R4）；否则 v2；
 *    否则空账本。迁移逐会话写入、单会话失败即中止、失败当次停留在 v1 模式
 *    保存（不做双写）、幂等可重试。
 *
 * 逐会话计价产物缓存（perf-hot-path-optimization D2/R2/R3）：打开总览的
 * 全账本计价重放为单遍（priceArtifactOf 一次遍历同时产出 priceLedgerSession
 * 全字段 + 按日费用桶 + 按日/按模型 token 桶 + coveredBuckets），按
 * （会话、条目签名、价目版本）缓存，未变化会话不重算。
 *
 * 存储形状（v1，字段尽量短以省 localStorage 配额）：
 * { v: 1, sessions: { [sid]: {
 *     lastSeen: epochMs,
 *     coverage: { turnFrom, turnTo, windowFull, deepFromSeq, deepToSeq, deepTruncated },
 *     entries: [ { k: "turn:step", p: provider, m: model,
 *                  u: {inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens},
 *                  t: epochMs, st: epochMs|null } ],
 *     buckets: [ { d: "YYYY-MM-DD", m: model, p: provider, w: {from,to}|null,
 *                  u: {…四桶}, n: 已卷步数 } ] } } }
 */

import {
  UNIT,
  UNKNOWN_MODEL_LABEL,
  displayCurrencyOf,
  matchPriceEntry,
  priceTurnRows,
  bucketSetCost,
  promptTokens,
  resolveTier,
  stepCost,
  timeMultiplier
} from "./pricing.mjs";
import { dayKeyOf } from "./rows-aggregate.mjs";

/** localStorage 键（v1 单键，迁移前的既有布局）。 */
export const LEDGER_STORE_KEY = "dsh-v-token-insight.ledger.v1";

/** localStorage 键（v2 分片布局）：轻量索引键与会话分片键前缀。 */
export const LEDGER_INDEX_KEY_V2 = "dsh-v-token-insight.ledger.v2.index";
export const LEDGER_SESSION_PREFIX_V2 = "dsh-v-token-insight.ledger.v2.s.";

/** v2 会话分片键。 */
export function ledgerSessionKeyV2(sessionId) {
  return LEDGER_SESSION_PREFIX_V2 + sessionId;
}

/**
 * 原始条目保留天数（固化窗口，fix-ledger-quota-budget D1）：窗口外原始步在持久化
 * 时「落盘固化」为「日 × 模型 × 折扣窗口」聚合桶（按日趋势显示数据完整保留，
 * 逐步钻取对固化段退化为桶级）。默认 2 天——下界依据：座位仪表只读今日原始
 * 条目（ledgerTokensForDay 不含老化桶），窗口 ≥1 天即安全；取 2 天容忍跨零点
 * 边界。导出常量，可按实测微调（design 迁移计划）。
 */
export const LEDGER_RAW_RETENTION_DAYS = 2;
/** 孤儿宽限期天数（会话从列表消失后保留多久）。 */
export const LEDGER_ORPHAN_GRACE_DAYS = 14;

/**
 * 账本总量预算（fix-ledger-quota-budget D2，字符口径）：持久化编排的水位判定
 * 阈值——estimateLedgerBytes 估算超过即触发收缩阶梯（全固化档 → 整会话逐出）。
 * 5 MB ≈ localStorage 配额（≈5.24M 字符）的 94%，余量留给非账本租户与索引。
 */
export const LEDGER_TOTAL_BUDGET_BYTES = 5 * 1024 * 1024;
/**
 * 逐出阶梯的目标余量（字符，fix-ledger-quota-budget D2）：整会话逐出执行至
 * 「预算 − headroom」以内——整会话逐出粒度粗、尺寸估算存在偏差，预留余量吸收
 * 临界抖动，避免逐出后立即再次触顶。
 */
export const LEDGER_EVICT_HEADROOM_BYTES = 256 * 1024;
/** 水位估算常数（design D3）：索引 JSON 骨架与键名等固定开销折算。 */
export const LEDGER_ESTIMATE_OVERHEAD_BYTES = 1024;
/**
 * 水位估算常数（design D3）：索引逐会话元数据（lastSeen/coverage JSON + 键名）折算。
 * ledger-recorded-pricing D7 上调（256 → 512）——仅兜「新会话首存前」的估算空窗；
 * 分片一旦写入，尺寸缓存以实测编码长度接管，常数不承载长会话 pricing 的精度。
 */
export const LEDGER_ESTIMATE_INDEX_PER_SESSION_BYTES = 512;

/**
 * 计价引擎版本戳（ledger-recorded-pricing D2）：计价语义/引擎修正时 +1，落盘进每个
 * pricing 快照的 `ev` 字段。启动/展示时 `ev < PRICING_ENGINE_VERSION` → 该会话（及全账本）
 * 标「待重算」：展示仍用旧账面价，仅披露，由用户显式重算刷新。
 * 初值 2：st 污染修正计 +1（相对本提案前的隐含一代引擎）。
 */
export const PRICING_ENGINE_VERSION = 2;

/**
 * 重算启动前预算预检的逐会话 pricing 增量估算常数（ledger-recorded-pricing D4）：
 * 无 pricing 的会话「首算按常数」估其序列化增长量——仅用于「拒绝超水位余量的重算」，
 * 不承载精确尺寸（精确尺寸由分片写入后的实测编码长度接管）。
 * 偏保守（高估）方向：宁可预检拒绝，也不「先重算再触发收缩阶梯」。
 */
export const PRICING_ESTIMATE_PER_SESSION_BYTES = 1024;

const BUCKET_FIELDS = ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"];

const emptyBuckets = () => ({
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0
});

function sanitizeBuckets(raw) {
  const out = emptyBuckets();
  if (typeof raw !== "object" || raw === null) return out;
  for (const field of BUCKET_FIELDS) {
    const value = Number(raw[field]);
    if (Number.isFinite(value) && value >= 0) out[field] = value;
  }
  return out;
}

function isEmptyBuckets(buckets) {
  return BUCKET_FIELDS.every((field) => (buckets[field] ?? 0) === 0);
}

/**
 * 条目净化/解码（双兼容，fix-ledger-quota-budget D5）：
 *  - 旧对象形 {k, p, m, u:{…}, t, st}（内存形状 / 旧分片 / 旧备份）；
 *  - 紧凑数组形 [k, 字典序号, in, cr, cw, out, t, stRel?]（新分片布局；
 *    字典序号经分片头部 catalog 解析模型/路由归属）。
 * 两种编码净化语义逐值一致；空步不记账、非法形状丢弃不抛错。
 * st 语义修正（随紧凑编码归一）：null/缺席保留 null（「无开始时刻」），
 * 不再经 Number(null)=0 强转（epoch 0 会污染 hitWindowOf/归日口径）。
 */
function sanitizeEntry(raw, catalog = null) {
  if (Array.isArray(raw)) return sanitizeCompactEntry(raw, catalog);
  if (typeof raw !== "object" || raw === null) return null;
  if (typeof raw.k !== "string" || !/^-?\d+:-?\d+$/.test(raw.k)) return null;
  const u = sanitizeBuckets(raw.u);
  if (isEmptyBuckets(u)) return null; /* 空步不记账 */
  const t = Number(raw.t);
  if (!Number.isFinite(t)) return null;
  const st = raw.st === null || raw.st === void 0 ? null : Number(raw.st);
  return {
    k: raw.k,
    p: typeof raw.p === "string" ? raw.p : "",
    m: typeof raw.m === "string" ? raw.m : "",
    u,
    t,
    st: st !== null && Number.isFinite(st) ? st : null
  };
}

/** 紧凑条目解码（D5 存储布局扩展）：st 为相对 t 的偏移，偏移位缺席 = null。 */
function sanitizeCompactEntry(raw, catalog) {
  if (raw.length < 7) return null;
  if (typeof raw[0] !== "string" || !/^-?\d+:-?\d+$/.test(raw[0])) return null;
  let p = "";
  let m = "";
  const idx = raw[1];
  if (Array.isArray(catalog) && Number.isInteger(idx) && idx >= 0 && idx < catalog.length && Array.isArray(catalog[idx])) {
    p = typeof catalog[idx][0] === "string" ? catalog[idx][0] : "";
    m = typeof catalog[idx][1] === "string" ? catalog[idx][1] : "";
  }
  const u = sanitizeBuckets({ inputTokens: raw[2], cacheReadTokens: raw[3], cacheWriteTokens: raw[4], outputTokens: raw[5] });
  if (isEmptyBuckets(u)) return null; /* 空步不记账 */
  const t = Number(raw[6]);
  if (!Number.isFinite(t)) return null;
  let st = null;
  if (raw.length >= 8) {
    const rel = Number(raw[7]);
    if (Number.isFinite(rel)) st = t + rel;
  }
  return { k: raw[0], p, m, u, t, st };
}

function sanitizeWin(raw) {
  return typeof raw === "object" && raw !== null &&
    typeof raw.from === "string" && typeof raw.to === "string"
    ? { from: raw.from, to: raw.to }
    : null;
}

function sanitizeBucket(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  if (typeof raw.d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.d)) return null;
  const u = sanitizeBuckets(raw.u);
  if (isEmptyBuckets(u)) return null;
  const n = Number(raw.n);
  return {
    d: raw.d,
    m: typeof raw.m === "string" ? raw.m : "",
    p: typeof raw.p === "string" ? raw.p : "",
    w: sanitizeWin(raw.w),
    u,
    n: Number.isFinite(n) && n >= 0 ? n : 0
  };
}

function sanitizeCoverage(raw) {
  if (typeof raw !== "object" || raw === null) return {};
  const out = {};
  for (const key of ["turnFrom", "turnTo", "deepFromSeq", "deepToSeq"]) {
    const value = Number(raw[key]);
    if (Number.isFinite(value)) out[key] = value;
  }
  if (typeof raw.windowFull === "boolean") out.windowFull = raw.windowFull;
  if (typeof raw.deepTruncated === "boolean") out.deepTruncated = raw.deepTruncated;
  return out;
}

/*
 * pricing 快照（账面价落盘，ledger-recorded-pricing D1/D2）。
 * 每次持久化/重算把 dirty 会话的单遍计价产物（总费用、币种、逐模型归因、逐日费用、
 * 未定价原因）快照进分片 `pricing` 字段，附引擎版本戳（ev）与价目指纹（fp）。
 * 紧凑形状（模型名进 mc 字典、逐日数组化）：
 *   { v:1, ev, fp, cur, cost, mc:[model…], bm:[[mi,cost,in,cr,cw,out]…], dc:[[day,cost]…], um:[reason…] }
 * 无 pricing = 旧分片（软迁移：展示回退现算，首次持久化时落盘）；解析失败按无 pricing 回退不抛错。
 */

/** 会话计价产物 → 紧凑 pricing 快照（落盘用；cost=null 表示全未定价仍落盘占位）。 */
function encodePricing(artifact, table, ev) {
  const priced = artifact.priced;
  const fp = priceTableFingerprint(table);
  const mc = [];
  const modelIndex = new Map();
  const bm = [];
  for (const [model, agg] of priced.byModel) {
    let mi = modelIndex.get(model);
    if (mi === void 0) {
      mi = mc.length;
      mc.push(model);
      modelIndex.set(model, mi);
    }
    const tokens = agg.tokens ?? emptyBuckets();
    bm.push([mi, agg.cost, tokens.inputTokens, tokens.cacheReadTokens, tokens.cacheWriteTokens, tokens.outputTokens]);
  }
  const dc = [];
  for (const [day, cost] of artifact.dailyCost) dc.push([day, cost]);
  return {
    v: 1,
    ev: Number.isFinite(ev) ? ev : PRICING_ENGINE_VERSION,
    fp,
    cur: priced.currency ?? "CNY",
    cost: priced.cost,
    mc,
    bm,
    dc,
    um: Array.isArray(priced.unmatched) ? priced.unmatched : []
  };
}

/** pricing 快照净化：非法/损坏回退 null（按「无 pricing」走现算，不抛错）。
 *  内存形态 = 落盘紧凑形态（mc + bm 索引行），单一形态避免双表示漂移；
 *  bm 展开为 byModel 由 rebuildArtifactFromPricing 按需进行。 */
function sanitizePricing(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  if (raw.v !== 1) return null;
  if (typeof raw.fp !== "string" || raw.fp === "") return null;
  const ev = Number(raw.ev);
  if (!Number.isFinite(ev) || ev < 0) return null;
  const cur = typeof raw.cur === "string" && raw.cur !== "" ? raw.cur : null;
  if (cur === null) return null;
  const costRaw = raw.cost;
  const cost = costRaw === null || costRaw === void 0 ? null : Number(costRaw);
  if (cost !== null && !Number.isFinite(cost)) return null;
  const mc = Array.isArray(raw.mc) ? raw.mc.filter((m) => typeof m === "string") : [];
  const bm = [];
  if (Array.isArray(raw.bm)) {
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    };
    for (const row of raw.bm) {
      if (!Array.isArray(row) || row.length < 6) continue;
      const mi = row[0];
      if (!Number.isInteger(mi) || mi < 0 || mi >= mc.length) continue;
      const bc = Number(row[1]);
      if (!Number.isFinite(bc)) continue;
      bm.push([mi, bc, num(row[2]), num(row[3]), num(row[4]), num(row[5])]);
    }
  }
  const dc = [];
  if (Array.isArray(raw.dc)) {
    for (const row of raw.dc) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const day = row[0];
      const c = Number(row[1]);
      if (typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(c)) dc.push([day, c]);
    }
  }
  const um = Array.isArray(raw.um) ? raw.um.filter((r) => typeof r === "string") : [];
  return {
    v: 1,
    ev,
    fp: raw.fp,
    cur,
    cost,
    mc,
    bm,
    dc,
    um
  };
}

function sanitizeSession(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  /* 紧凑分片/备份的会话级模型字典（旧编码缺席 → 条目按旧对象形净化）。 */
  const catalog = Array.isArray(raw.c) ? raw.c : null;
  const entries = (Array.isArray(raw.entries) ? raw.entries : [])
    .map((entry) => sanitizeEntry(entry, catalog))
    .filter((entry) => entry !== null);
  const buckets = (Array.isArray(raw.buckets) ? raw.buckets : [])
    .map(sanitizeBucket)
    .filter((bucket) => bucket !== null);
  const lastSeen = Number(raw.lastSeen);
  const pricing = sanitizePricing(raw.pricing);
  const session = {
    lastSeen: Number.isFinite(lastSeen) ? lastSeen : 0,
    coverage: sanitizeCoverage(raw.coverage),
    entries,
    buckets
  };
  if (pricing !== null) session.pricing = pricing; /* 无 pricing（旧分片/解析失败）不挂字段 */
  return session;
}

/* ------------------------------------------------------------------ *
 * 存储面小工具（v2 分片共用）
 * ------------------------------------------------------------------ */

function tryGet(storage, key) {
  try {
    const raw = storage?.getItem?.(key);
    return typeof raw === "string" && raw !== "" ? raw : null;
  } catch {
    return null;
  }
}

function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function tryRemove(storage, key) {
  try {
    storage?.removeItem?.(key);
  } catch {
    /* 尽力而为（清除失败不影响其余会话） */
  }
}

/**
 * 存储键枚举面（浏览器 localStorage 恒可枚举 length/key(i)）。
 * @returns 键数组，或 null（注入面缺枚举能力——node fake 的降级分支）。
 */
function storageKeysOf(storage) {
  try {
    const count = storage?.length;
    const keyAt = storage?.key;
    if (typeof count !== "number" || count < 0 || typeof keyAt !== "function") return null;
    const keys = [];
    for (let i = 0; i < count; i++) {
      const key = keyAt.call(storage, i);
      if (typeof key === "string") keys.push(key);
    }
    return keys;
  } catch {
    return null;
  }
}

function parseIndexV2(raw) {
  const parsed = parseJsonOrNull(raw);
  if (typeof parsed !== "object" || parsed === null || parsed.v !== 2 || typeof parsed.sessions !== "object" || parsed.sessions === null) {
    return null;
  }
  return parsed;
}

function indexOfLedger(ledger) {
  const sessions = {};
  for (const [sid, session] of Object.entries(ledger.sessions)) {
    sessions[sid] = { lastSeen: session.lastSeen, coverage: session.coverage };
  }
  return { v: 2, sessions };
}

/* ------------------------------------------------------------------ *
 * 读取：双模读（v2 优先、v1 兜底）+ v1 自动迁移
 * ------------------------------------------------------------------ */

/** 读一个 v2 会话分片；缺席/损坏仅该会话回退空账本并尽力清坏键。
 *  sizeCache（design D3）：分片在册时以真实分片长度初始化尺寸缓存。 */
function sessionShardOf(storage, sid, meta, sizeCache = null) {
  const fallback = () => sanitizeSession({ lastSeen: meta?.lastSeen, coverage: meta?.coverage, entries: [], buckets: [] });
  const raw = tryGet(storage, ledgerSessionKeyV2(sid));
  if (raw === null) {
    sizeCache?.delete(sid); /* 分片缺席：尺寸缓存不留陈旧项 */
    return fallback(); /* 分片缺席（保存中断/手工删除）→ 按索引元数据回退空会话 */
  }
  const parsed = parseJsonOrNull(raw);
  if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.entries) || !Array.isArray(parsed.buckets)) {
    /* 分片损坏：仅该会话回退空账本，尽力清除坏键（规格：分片粒度回退）。 */
    tryRemove(storage, ledgerSessionKeyV2(sid));
    sizeCache?.delete(sid);
    return fallback();
  }
  sizeCache?.set(sid, raw.length);
  /* lastSeen/coverage 以索引 meta 为权威；新分片的会话级字典 c 随条目净化解析
     （旧分片无 c → 条目按旧对象形净化）；pricing（账面价快照）随分片读回。 */
  return sanitizeSession({ ...meta, c: parsed.c, pricing: parsed.pricing, entries: parsed.entries, buckets: parsed.buckets });
}

function sessionWorthKeeping(session) {
  return session !== null && (session.entries.length > 0 || session.buckets.length > 0 || session.lastSeen > 0);
}

/** 索引损坏/缺席时的枚举重建：扫描 `.s.` 前缀分片（旧分片携带完整会话形状可独立
 *  恢复；紧凑分片的 lastSeen/coverage 回退由索引承担，索引损坏时为既有降级语义）。 */
function rebuildFromShards(storage, sizeCache = null) {
  const keys = storageKeysOf(storage);
  if (keys === null) return emptyLedger(); /* 无枚举面：降级空账本（不抛错，沿用损坏回退语义） */
  const sessions = {};
  for (const key of keys) {
    if (typeof key !== "string" || !key.startsWith(LEDGER_SESSION_PREFIX_V2)) continue;
    const sid = key.slice(LEDGER_SESSION_PREFIX_V2.length);
    if (sid === "" || sessions[sid] !== void 0) continue;
    const rawText = tryGet(storage, key);
    const parsed = parseJsonOrNull(rawText);
    if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.entries) || !Array.isArray(parsed.buckets)) {
      tryRemove(storage, key);
      continue;
    }
    sizeCache?.set(sid, rawText.length);
    const session = sanitizeSession(parsed);
    if (sessionWorthKeeping(session)) sessions[sid] = session;
  }
  return { v: 1, sessions };
}

function loadLedgerV2(storage, sizeCache = null) {
  const index = parseIndexV2(tryGet(storage, LEDGER_INDEX_KEY_V2));
  if (index !== null) {
    const sessions = {};
    for (const [sid, meta] of Object.entries(index.sessions)) {
      const session = sessionShardOf(storage, sid, typeof meta === "object" && meta !== null ? meta : {}, sizeCache);
      if (sessionWorthKeeping(session)) sessions[sid] = session;
    }
    return { v: 1, sessions };
  }
  return rebuildFromShards(storage, sizeCache);
}

/**
 * v1 → v2 迁移：逐会话写分片 + 写索引后删 v1 键（全部成功才删，中断时 v1 保留、
 * 幂等可重试；R4：v1 与 v2 并存时 v1 权威——旧版本可能最后写入，重迁移覆盖 v2）。
 * @returns 是否迁移完成（失败当次停留 v1 模式保存，不做双写）。
 */
function migrateV1ToV2(storage, ledger) {
  if (typeof storage?.setItem !== "function" || typeof storage?.removeItem !== "function") return false;
  if (!writeV2ShardsAndIndex(storage, ledger, Object.keys(ledger.sessions))) return false;
  try {
    storage.removeItem(LEDGER_STORE_KEY);
  } catch {
    return false;
  }
  return true;
}

/**
 * 读取账本；缺省/损坏/非法一律回退空账本，不抛错。
 * 双模读（v2 优先、v1 兜底）+ 模式优先级：v1 在册 → v1 权威重迁移（覆盖 v2
 * 后删 v1）；v1 缺席 → v2 索引在册按 v2 读（索引损坏时枚举 `.s.` 前缀重建，
 * 无枚举面降级空账本）；两者缺席 → 空账本。
 * @param storage - 注入的存储面（浏览器传 localStorage；node 测试传 fake）。
 * @param sizeCache - 分片尺寸缓存（fix-ledger-quota-budget D3）：传入 Map 时
 *   先清空再以本次载入内容初始化（真实分片长度 / v1 逐会话量测）。
 */
export function loadLedger(storage, sizeCache = null) {
  const sizes = sizeCache instanceof Map ? sizeCache : null;
  if (sizes !== null) sizes.clear(); /* 载入即重置：以存储当前内容为唯一口径 */
  const v1Raw = tryGet(storage, LEDGER_STORE_KEY);
  if (v1Raw !== null) {
    const parsed = parseJsonOrNull(v1Raw);
    if (typeof parsed === "object" && parsed !== null && parsed.v === 1 && typeof parsed.sessions === "object" && parsed.sessions !== null) {
      const sessions = {};
      for (const [sid, rawSession] of Object.entries(parsed.sessions)) {
        const session = sanitizeSession(rawSession);
        if (sessionWorthKeeping(session)) sessions[sid] = session;
      }
      const ledger = { v: 1, sessions };
      if (sizes !== null) {
        /* v1 单键载入：尺寸缓存按会话量测（迁移分片写入前的保守初始化）。 */
        for (const [sid, session] of Object.entries(ledger.sessions)) {
          sizes.set(sid, JSON.stringify(session).length);
        }
      }
      /* 迁移失败不改变本次返回内容：停留 v1 模式（保存路径仍写 v1 单键），下次启动重试。 */
      migrateV1ToV2(storage, ledger);
      return ledger;
    }
    /* v1 键损坏：尽力清坏键，落到 v2 双模读（损坏的 v1 不得作为权威覆盖 v2）。 */
    tryRemove(storage, LEDGER_STORE_KEY);
  }
  return loadLedgerV2(storage, sizes);
}

/** 空账本。 */
export function emptyLedger() {
  return { v: 1, sessions: {} };
}

/* ------------------------------------------------------------------ *
 * 写入：v1 模式整本单键 / v2 模式按会话分片
 * ------------------------------------------------------------------ */

/**
 * 紧凑编码一个会话分片（fix-ledger-quota-budget D5，写路径唯一出口）：
 * {c: [[provider, model]…], entries: [[k, 字典序号, in, cr, cw, out, t, stRel?]],
 *  buckets: […原样…]}——四桶定序数组 + 模型分片字典（分片头部，(p,m) 去重）+
 * st 相对偏移（缺席偏移位省略）；lastSeen/coverage 以索引为权威，分片不双写。
 */
function encodeSessionShard(session) {
  const catalog = [];
  const catalogIndex = new Map();
  const catalogIdxOf = (p, m) => {
    const key = `${p}\u0000${m}`;
    let idx = catalogIndex.get(key);
    if (idx === void 0) {
      idx = catalog.length;
      catalog.push([p, m]);
      catalogIndex.set(key, idx);
    }
    return idx;
  };
  const entries = [];
  for (const entry of session.entries) {
    const u = entry.u;
    const compact = [
      entry.k,
      catalogIdxOf(entry.p, entry.m),
      u.inputTokens,
      u.cacheReadTokens,
      u.cacheWriteTokens,
      u.outputTokens,
      entry.t
    ];
    if (entry.st !== null && Number.isFinite(entry.st)) compact.push(entry.st - entry.t);
    entries.push(compact);
  }
  const shard = { c: catalog, entries, buckets: session.buckets };
  /* 账面价快照（ledger-recorded-pricing D1）：dirty 会话落盘时随分片写入；
     无 pricing（旧分片/软迁移）则不写该字段——读取双兼容。 */
  if (session.pricing && typeof session.pricing === "object") shard.pricing = session.pricing;
  return JSON.stringify(shard);
}

/**
 * 写 v2 分片 + 索引（sessionIds = 本次要落盘的会话集；删除对账始终全量进行）。
 * 先分片后索引：中断时索引至多陈旧，不会指向未写分片。
 * @param sizeCache - 分片尺寸缓存（design D3）：分片写入即更新、删除对账即清除。
 * @returns 是否全部成功（单会话失败即中止，调用方按失败处理）。
 */
function writeV2ShardsAndIndex(storage, ledger, sessionIds, sizeCache = null) {
  for (const sid of sessionIds) {
    const session = ledger.sessions[sid];
    if (session === void 0) continue;
    const text = encodeSessionShard(session);
    try {
      storage.setItem(ledgerSessionKeyV2(sid), text);
    } catch {
      return false;
    }
    sizeCache?.set(sid, text.length); /* 尺寸缓存随写入更新（design D3） */
  }
  /* 删除对账（清除/GC/导入替换/逐出）：旧索引在册而当前账本不存在的会话 → 删分片；
     索引不可读时退化为枚举对账（有枚举面才做，浏览器恒可枚举）。 */
  const prevIndex = parseIndexV2(tryGet(storage, LEDGER_INDEX_KEY_V2));
  if (prevIndex !== null) {
    for (const sid of Object.keys(prevIndex.sessions)) {
      if (ledger.sessions[sid] === void 0) {
        tryRemove(storage, ledgerSessionKeyV2(sid));
        sizeCache?.delete(sid);
      }
    }
  } else {
    const keys = storageKeysOf(storage);
    if (keys !== null) {
      for (const key of keys) {
        if (typeof key !== "string" || !key.startsWith(LEDGER_SESSION_PREFIX_V2)) continue;
        if (ledger.sessions[key.slice(LEDGER_SESSION_PREFIX_V2.length)] === void 0) {
          tryRemove(storage, key);
          sizeCache?.delete(key.slice(LEDGER_SESSION_PREFIX_V2.length));
        }
      }
    }
  }
  try {
    storage.setItem(LEDGER_INDEX_KEY_V2, JSON.stringify(indexOfLedger(ledger)));
    return true;
  } catch {
    return false;
  }
}

/**
 * 写入账本（v2 分片：只写变化的会话分片 + 必要索引，O(S) 常小）。
 * v1 键仍在册 = v1 模式（迁移失败当次停留 v1 单键保存，不做双写）。
 * @param changedSids - 本轮实际变化的会话 id（Iterable）；null = 全量落盘。
 * @param sizeCache - 分片尺寸缓存（design D3）：v2 按写入文本更新；v1 单键模式
 *   按会话量测折算（缓存先清空，以本次整本为口径）。
 * @returns 是否写入成功（存储不可用/配额失败返回 false）。
 */
export function saveLedger(storage, ledger, changedSids = null, sizeCache = null) {
  if (typeof ledger !== "object" || ledger === null || ledger.v !== 1) return false;
  const sizes = sizeCache instanceof Map ? sizeCache : null;
  try {
    if (tryGet(storage, LEDGER_STORE_KEY) !== null) {
      const text = JSON.stringify(ledger);
      storage?.setItem?.(LEDGER_STORE_KEY, text);
      if (sizes !== null) {
        sizes.clear();
        for (const [sid, session] of Object.entries(ledger.sessions)) {
          sizes.set(sid, JSON.stringify(session).length);
        }
      }
      return true;
    }
    if (typeof storage?.setItem !== "function") return false;
    const sessionIds =
      changedSids === null
        ? Object.keys(ledger.sessions)
        : [...changedSids].filter((sid) => ledger.sessions[sid] !== void 0);
    return writeV2ShardsAndIndex(storage, ledger, sessionIds, sizes);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 沉淀（幂等 upsert）
 * ------------------------------------------------------------------ */

function sessionOf(ledger, sessionId, nowMs) {
  let session = ledger.sessions[sessionId];
  if (session === void 0) {
    session = { lastSeen: 0, coverage: {}, entries: [], buckets: [] };
    ledger.sessions[sessionId] = session;
  }
  if (Number.isFinite(nowMs) && nowMs > session.lastSeen) session.lastSeen = nowMs;
  return session;
}

function compareEntryKeys(a, b) {
  const [at, as] = a.k.split(":").map(Number);
  const [bt, bs] = b.k.split(":").map(Number);
  return at - bt || as - bs;
}

function minNum(prev, next) {
  return typeof prev === "number" ? Math.min(prev, next) : next;
}

function maxNum(prev, next) {
  return typeof prev === "number" ? Math.max(prev, next) : next;
}

/**
 * 幂等沉淀一个会话的折叠行（foldTurns+join 产物或 foldHistoryEvents 产物）。
 * 步的 usage 取窗口节点形状（inputTokens…）；无 usage/全零步不记账。
 * 二次入桶守卫（fix-ledger-storm）：会话已有老化桶时，新键中「时刻早于保留窗」
 * 的步必然已随上次老化卷入桶中（每步要么在条目要么在桶，不并存）——再收就是
 * 重放重复，下次老化会与既有桶累加出 2×/3×（风暴）。守卫放在唯一写入口，
 * 全量重放（深补/重建）经 clearSessionBuckets 清桶后自然解除。键已在条目中的
 * 步不受守卫限制（last-wins 是替换不是新增，无重复入账）。
 * @param options.windowFull - 该次沉淀的窗口是否已覆盖全会话（快照 hasMore 取反）；
 *   多次沉淀按 AND 合并（曾见过不完整即保守标注部分覆盖）；传 null 表示本次
 *   沉淀不携带窗口完备性信息（如 chip 的单轮沉淀），不改动既有标注。
 * @param options.nowMs - lastSeen 时间戳（守卫的「现在」基准）。
 * @returns 本次实际新增/更新的步数（0 = 无变化，调用方可跳过保存）。
 */
export function upsertSessionEntries(ledger, sessionId, rows, { windowFull = true, nowMs } = {}) {
  const session = sessionOf(ledger, sessionId, nowMs);
  const byKey = new Map(session.entries.map((entry) => [entry.k, entry]));
  const guardRetentionMs = session.buckets.length > 0 && Number.isFinite(nowMs)
    ? LEDGER_RAW_RETENTION_DAYS * 86_400_000
    : null;
  let changed = 0;
  for (const row of rows ?? []) {
    if (typeof row?.turn !== "number") continue;
    for (const step of row.steps ?? []) {
      if (typeof step?.step !== "number" || !step.usage) continue;
      /* 模型缺失的步仍沉淀（空模型 m:""），不再整步丢弃（修正 fix-ledger-attribution
         的覆盖缺陷）：实时沉淀时 trajectory join 偶发缺席会导致该步的模型暂未知，
         若整步跳过，则（1）该步的 token/发生时刻不进账本 → 今日DPS、座位速度环、
         趋势「今日」桶全部缺失（覆盖缺口）；（2）sessionsWithUnattributedEntries 只能
         发现「已存在且模型为空」的条目，整步未落盘的会话永远无法被自动修复发现。
         改为以空模型沉淀后：token 与归日照常入账（DPS/速度/趋势桶即有值），逐步
         计费（step-level-cost-semantics）下空模型步仅自身标「未知模型」不入费用、
         不拖累同会话其它已定价步；自动修复（打开总览时）经 sessionsWithUnattributedEntries
         命中该条并深补回填真实模型，last-wins upsert 覆盖。 */
      const buckets = {
        inputTokens: step.usage.inputTokens ?? 0,
        cacheReadTokens: step.usage.cacheReadTokens ?? 0,
        cacheWriteTokens: step.usage.cacheWriteTokens ?? 0,
        outputTokens: step.usage.outputTokens ?? 0
      };
      if (isEmptyBuckets(buckets)) continue;
      const key = `${row.turn}:${step.step}`;
      const prev = byKey.get(key);
      if (prev === void 0 && guardRetentionMs !== null) {
        /* 新键守卫：出保留窗的步内容已在桶中，跳过（与老化同款 ts 口径 st ?? t）。 */
        const ts = Number.isFinite(step.startTime) ? step.startTime : Number.isFinite(step.time) ? step.time : 0;
        if (nowMs - ts > guardRetentionMs) continue;
      }
      const entry = {
        k: key,
        p: step.provider ?? "",
        m: step.model ?? "",
        u: buckets,
        t: Number.isFinite(step.time) ? step.time : 0,
        st: Number.isFinite(step.startTime) ? step.startTime : null
      };
      /* last-wins：同键覆盖（重试取终值语义）；完全相同不计变更。 */
      if (prev !== void 0 && JSON.stringify(prev) === JSON.stringify(entry)) continue;
      byKey.set(key, entry);
      changed += 1;
    }
  }
  session.entries = [...byKey.values()].sort(compareEntryKeys);
  if (changed > 0) {
    /* 条目变化使账面价快照失效（ledger-recorded-pricing D3 vintage 语义）：
       该会话须按当前价目重记账——清除旧 pricing，下次持久化时重新落盘。 */
    delete session.pricing;
  }
  /* 覆盖轮范围扩展（窗口沉淀口径）。 */
  const turns = session.entries.map((entry) => Number(entry.k.split(":")[0]));
  if (turns.length > 0) {
    session.coverage.turnFrom = minNum(session.coverage.turnFrom, Math.min(...turns));
    session.coverage.turnTo = maxNum(session.coverage.turnTo, Math.max(...turns));
  }
  if (windowFull !== null) {
    const seenFull = windowFull === true;
    session.coverage.windowFull = session.coverage.windowFull === void 0 ? seenFull : session.coverage.windowFull && seenFull;
  }
  return changed;
}

/**
 * 检测账本中存在「不可归因条目」（模型名为空）的会话（fix-ledger-attribution）。
 *
 * 这类条目来自旧版本实时沉淀（trajectory join 缺席时写入），会让 priceLedgerSession
 * 把整会话判成「未定价」。总览页据此定向触发深度补全（从会话历史重建模型归属），
 * 而不需要用户逐个手动「补全」。
 * @returns 会话 id 数组（账本插入序）。
 */
export function sessionsWithUnattributedEntries(ledger) {
  const out = [];
  for (const [sid, session] of Object.entries(ledger?.sessions ?? {})) {
    if (session.entries.some((entry) => !entry.m) || session.buckets.some((bucket) => !bucket.m)) {
      out.push(sid);
    }
  }
  return out;
}

/** 覆盖缺口触发阈值（fix-partial-coverage 2.1，导出常量）：投影超出账本总覆盖
 *  （原始条目与老化桶合计）的逐桶差截零合计达到该值才入选定向深补——容忍投影
 *  asOfSeq 滞后噪声与深补翻页预算内的正常部分覆盖，防止把正常部分覆盖当异常
 *  反复拉取。 */
export const COVERAGE_GAP_THRESHOLD = 100_000;

/**
 * 覆盖缺口检测（fix-partial-coverage 2.1；基线修正 fix-ledger-quota-budget，纯函数）：
 * 投影 − 账本「总覆盖」（coveredBucketsBySession = 原始条目 + 老化桶四桶合计）。
 * 输入只吃打开总览的单遍聚合产物（expanded × aggregateLedgerViews().coveredBucketsBySession）
 * ——吃 ledger 会诱发第二次账本重放，MUST NOT。
 * 基线 MUST 为总覆盖而非「已按日入柱」：老化桶是已落盘固化的覆盖量，若不计入，
 * 固化（2 天窗口）会把已覆盖会话误判成全量缺口——自动深补风暴（数百会话背靠背
 * 开帧打爆宿主堆）且收缩后缺口永不收敛。入选 = 非 fork、行投影在场
 * （usageSource === "projection"，缺席回退行无投影基线）、曾实际覆盖
 * （coveredBucketsBySession 有键：键仅发给 covered 会话——原始条目或老化桶非空；
 * 无条目无桶的空键会话 covered=false 无键，从未覆盖会话无键，均不入选）、
 * 逐桶差截零求和 ≥ 阈值。账本领先于滞后投影（负差）截零后不入选。
 * @param expanded - expandRows 产物（Tier 0 行）。
 * @param coveredBucketsBySession - aggregateLedgerViews 产物（逐会话总覆盖量）。
 * @param threshold - 触发阈值（缺省 COVERAGE_GAP_THRESHOLD）。
 * @returns 入选会话 id 数组（expanded 行序）。
 */
export function ledgerCoverageGaps(expanded, coveredBucketsBySession, threshold = COVERAGE_GAP_THRESHOLD) {
  const gaps = [];
  const limit = Number.isFinite(threshold) && threshold > 0 ? threshold : COVERAGE_GAP_THRESHOLD;
  const coveredBySession = coveredBucketsBySession instanceof Map ? coveredBucketsBySession : new Map();
  for (const item of expanded ?? []) {
    if (item.isFork) continue; /* fork 副本投影是父会话的种子复制，永不入选 */
    if (item.usageSource !== "projection") continue; /* 投影缺席（含回退）无投影基线 */
    if (item.usage === null) continue;
    const covered = coveredBySession.get(item.id);
    if (covered === void 0) continue; /* 从未覆盖 / 空键会话（无键）不入选 */
    let gap = 0;
    for (const field of BUCKET_FIELDS) gap += Math.max(0, (item.usage[field] ?? 0) - (covered[field] ?? 0));
    if (gap >= limit) gaps.push(item.id);
  }
  return gaps;
}

/**
 * 记录一次深度补全的覆盖区间（session.history 离线折算后调用）。
 * 深补条目本身经 upsertSessionEntries 写入；本函数只补 seq 区间与截断标注。
 * 深补未截断（hasMore 走完、预算未触顶）→ 覆盖为全会话，窗口完备性同步置满。
 */
export function recordDeepCoverage(ledger, sessionId, { fromSeq, toSeq, truncated }, { nowMs } = {}) {
  const session = sessionOf(ledger, sessionId, nowMs);
  session.coverage.deepFromSeq = minNum(session.coverage.deepFromSeq, fromSeq);
  session.coverage.deepToSeq = maxNum(session.coverage.deepToSeq, toSeq);
  session.coverage.deepTruncated = session.coverage.deepTruncated === true ? true : truncated === true;
  if (truncated === false) session.coverage.windowFull = true;
}

/* ------------------------------------------------------------------ *
 * 压缩老化与 GC
 * ------------------------------------------------------------------ */

/**
 * 该步命中的折扣窗口（按步请求开始时刻，缺失回退落盘时刻；from 含 / to 不含，
 * 支持跨午夜）——老化时的命中判定用当时价目表，桶记录命中窗口 {from,to}。
 * @returns {from,to} | null（无条目/无命中）。
 */
function hitWindowOf(table, entry) {
  const priceEntry = matchPriceEntry(table, entry.m, entry.p);
  if (!priceEntry || !priceEntry.timeWindows?.length) return null;
  const date = new Date(entry.st ?? entry.t);
  if (Number.isNaN(date.getTime())) return null;
  const minute = date.getHours() * 60 + date.getMinutes();
  for (const window of priceEntry.timeWindows) {
    const from = Number(window.from.split(":")[0]) * 60 + Number(window.from.split(":")[1]);
    const to = Number(window.to.split(":")[0]) * 60 + Number(window.to.split(":")[1]);
    const inside = from <= to ? minute >= from && minute < to : minute >= from || minute < to;
    if (inside) return { from: window.from, to: window.to };
  }
  return null;
}

/**
 * 压缩老化 + 孤儿 GC（就地修改）。
 *  - 时刻早于 rawRetentionDays 的原始步卷为聚合桶：键 = 日（本地时区）×
 *    模型 × 折扣窗口命中（命中窗口按 table 判定并记录 {from,to}）；
 *  - 会话已不在 activeIds 且 lastSeen 超出宽限期 → 整会话清理；
 *  - onlySessions：仅收紧老化给定会话（R4 配额兜底的第一级「按会话粒度收紧」），
 *    GC 不受其限制（O(S) 常小，恒全量执行）；
 *  - cache：逐会话计价产物缓存（R3 失效卫生）——GC 删除会话时显式失效；
 *    收紧老化改变条目签名，重算由签名失配自动兜住。
 * @param table - 当前价目表（窗口命中判定用；可缺省 = 无窗口判定）。
 * @returns {collapsed, gcSessions, touchedSids} 变更计数与受影响会话集
 *   （fix-ledger-quota-budget D6：touchedSids = 发生坍缩或 GC 的会话 id Set，
 *   供 persistLedger 组装增量脏集；向后兼容新增字段，既有调用方零适配）。
 */
export function ageLedger(ledger, { nowMs, table = null, rawRetentionDays = LEDGER_RAW_RETENTION_DAYS, orphanGraceDays = LEDGER_ORPHAN_GRACE_DAYS, activeIds = [], onlySessions = null, cache = null } = {}) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const retentionMs = rawRetentionDays * 86_400_000;
  const graceMs = orphanGraceDays * 86_400_000;
  const active = activeIds instanceof Set ? activeIds : new Set(activeIds);
  const only = onlySessions === null ? null : onlySessions instanceof Set ? onlySessions : new Set(onlySessions);
  let collapsed = 0;
  let gcSessions = 0;
  const touchedSids = new Set();
  for (const [sid, session] of Object.entries(ledger.sessions)) {
    /* 孤儿 GC：不在当前列表且宽限期已过。lastSeen 为 0（新近性未知——空在册
       标记/索引损坏后紧凑分片重建的元数据缺失）不参与 GC：保守保留，体量由
       预算阶梯兜底（逐出按 lastSeen 升序，0 视为最旧）——避免元数据丢失被
       GC 放大为整本清除。 */
    if (session.lastSeen > 0 && !active.has(sid) && now - session.lastSeen > graceMs) {
      delete ledger.sessions[sid];
      gcSessions += 1;
      touchedSids.add(sid);
      /* 缓存失效卫生（R3）：杜绝 GC 后 sid 复用场景下的孤儿产物误命中。 */
      if (cache instanceof Map) cache.delete(sid);
      continue;
    }
    if (only !== null && !only.has(sid)) continue;
    const keep = [];
    let sessionCollapsed = 0;
    for (const entry of session.entries) {
      const ts = entry.st ?? entry.t;
      if (now - ts <= retentionMs) {
        keep.push(entry);
        continue;
      }
      const day = dayKeyOf(ts);
      if (day === null) {
        keep.push(entry);
        continue;
      }
      const win = table ? hitWindowOf(table, entry) : null;
      let bucket = session.buckets.find((candidate) => candidate.d === day && candidate.m === entry.m && sameWin(candidate.w, win));
      if (bucket === void 0) {
        bucket = { d: day, m: entry.m, p: entry.p, w: win, u: emptyBuckets(), n: 0 };
        session.buckets.push(bucket);
      }
      for (const field of BUCKET_FIELDS) bucket.u[field] += entry.u[field];
      bucket.n += 1;
      collapsed += 1;
      sessionCollapsed += 1;
    }
    if (sessionCollapsed > 0) {
      touchedSids.add(sid);
      /* 老化坍缩改变条目签名（原步卷桶），账面价快照失效——按当前价目重记账。 */
      delete session.pricing;
    }
    session.entries = keep.sort(compareEntryKeys);
    session.buckets = session.buckets.filter((bucket) => bucket.n > 0 || !isEmptyBuckets(bucket.u));
  }
  return { collapsed, gcSessions, touchedSids };
}

function sameWin(a, b) {
  if (a === b) return true;
  if (a === void 0 || a === null || b === void 0 || b === null) return false;
  return a.from === b.from && a.to === b.to;
}

/** 手动清除一个会话的账本（cache 传入逐会话计价缓存时同步失效，R3）。 */
export function clearSessionLedger(ledger, sessionId, cache = null) {
  if (ledger.sessions[sessionId] !== void 0) {
    delete ledger.sessions[sessionId];
    if (cache instanceof Map) cache.delete(sessionId);
    return true;
  }
  return false;
}

/** 手动清空账本（就地清空，保留对象引用；cache 传入时整体清空，R3）。 */
export function clearAllLedger(ledger, cache = null) {
  ledger.sessions = {};
  if (cache instanceof Map) cache.clear();
}

/**
 * 清空一个会话的老化桶（fix-ledger-storm）：深补/重建「全量重放」的前置——
 * 非截断重放取代一切既有聚合，先清桶再落条目，重放内容经老化按 1× 重新成桶，
 * 从结构上消灭「重放条目 × 既有桶」的二次入桶乘法；同时解除 upsert 的二次入桶
 * 守卫（无桶 → 旧条目照收），并让重放内容有机会修正旧桶的模型归属错乱。
 * 桶费用随之失效：一并清除 pricing 快照，重放落定后按当前价目重新落盘。
 * @returns 是否实际清空（会话缺席或本就无桶无定价 → false）。
 */
export function clearSessionBuckets(ledger, sessionId) {
  const session = ledger?.sessions?.[sessionId];
  if (!session) return false;
  if (session.buckets.length === 0 && session.pricing === void 0) return false;
  session.buckets = [];
  delete session.pricing;
  return true;
}

/* ------------------------------------------------------------------ *
 * 总量预算：水位估算 + 收缩阶梯编排（fix-ledger-quota-budget D2/D3/D4/D9）
 * ------------------------------------------------------------------ */

/**
 * 账本序列化总量估算（字符口径，design D3，纯函数）：分片尺寸缓存求和 +
 * 索引/开销常数。水位判定偏保守——缓存缺席项由 persistLedger 预热补测，索引
 * O(S) 小项按逐会话常数折算，headroom 兜临界抖动。
 * @param sizeCache - Map<sessionId, 分片字符数>（loadLedger 初始化 / saveLedger
 *   更新 / replaceLedgerData 与清空、导入失效）。
 * @returns 估算字符总量。
 */
export function estimateLedgerBytes(sizeCache) {
  const cache = sizeCache instanceof Map ? sizeCache : new Map();
  let total = LEDGER_ESTIMATE_OVERHEAD_BYTES + cache.size * LEDGER_ESTIMATE_INDEX_PER_SESSION_BYTES;
  for (const size of cache.values()) {
    if (Number.isFinite(size) && size > 0) total += size;
  }
  return total;
}

/** 本地零点（当日 00:00）起经过的毫秒数——全固化档「仅今日原始条目保留」的窗口
 *  （保留窗口以天数表达时取该值 / 86_400_000，跨零点边界由当日累计自然覆盖）。 */
function msSinceLocalMidnight(now) {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return Math.max(0, now - midnight.getTime());
}

/**
 * 落盘前为可计价会话快照账面价（ledger-recorded-pricing D1）：对每个待保存且
 * 有 token 事实（条目或桶）的会话，复用既有单遍计价产物（priceArtifactOf 缓存命中
 * → 零重放；签名失配/无缓存 → 必要重算）序列化为 pricing 快照挂在会话上，
 * 随 saveLedger → encodeSessionShard 写入分片。空会话（无条目无桶）不挂 pricing。
 * @param sids - 本次要落盘的会话 id 集（Set/数组）；null = 全量。
 * @param sizeCache - 挂载 pricing 后按实测编码长度回写（pricing 增量计入总量估算，D7）。
 */
function attachPricingForPersist(ledger, sids, table, cache, sizeCache = null) {
  if (!Array.isArray(table)) return; /* 无价目表（node 部分测试）→ 不落 pricing，保持旧行为 */
  const ids = sids === null ? Object.keys(ledger.sessions) : sids;
  for (const sid of ids) {
    const session = ledger.sessions[sid];
    if (session === void 0) continue;
    if (session.entries.length === 0 && session.buckets.length === 0) {
      const had = session.pricing !== void 0;
      delete session.pricing;
      if (had && sizeCache instanceof Map) sizeCache.set(sid, encodeSessionShard(session).length);
      continue;
    }
    const artifact = priceArtifactOf(ledger, sid, table, cache);
    session.pricing = encodePricing(artifact, table, PRICING_ENGINE_VERSION);
    if (sizeCache instanceof Map) sizeCache.set(sid, encodeSessionShard(session).length);
  }
}

/**
 * 持久化编排（fix-ledger-quota-budget D4/D9）——「固化优先 + 总量预算保险网」：
 *  1. 常规固化（LEDGER_RAW_RETENTION_DAYS 窗口）与孤儿 GC 随持久化执行（成功路径
 *     恒运行，兑现规格「MUST NOT 仅作为配额失败的兜底触发」）；受影响会话
 *     （touchedSids）并入脏集走既有增量分片保存；
 *  2. 水位检查：estimateLedgerBytes ≤ LEDGER_TOTAL_BUDGET_BYTES → 既有增量保存；
 *     保存失败且变化会话已知 → 会话粒度收紧老化重试（规格保留条款「按会话粒度
 *     执行」：仅对脏集会话做全固化档收紧）；
 *  3. 超水位（或保存仍失败）→ 全固化档（仅今日原始条目保留）重估后再保存；
 *  4. 仍超水位 → 按 lastSeen 升序（0 视为最旧）整会话逐出至「预算 − headroom」
 *     内 → 全量保存（v2 删除对账自动清分片键与索引；removeItem 不受配额限制，
 *     满盘亦可执行）；
 *  5. 全量保存仍失败（非账本膨胀原因）→ 既有内存模式兜底。
 * @param sizeCache - 分片尺寸缓存（design D3：loadLedger 初始化 / saveLedger 更新 /
 *   替换与清空失效；缺省用临时 Map，本次调用内自暖）。
 * @param budgetBytes/headroomBytes - 水位与逐出余量（缺省导出常量；node 单测可注入）。
 * @returns {ok, aged, evicted, evictedSessions, collapsed}
 *   ok=false 表示全部尝试失败（内存仍可用，UI 提示）；aged = 本次发生固化/GC/收缩
 *   （调用方据此重算聚合）；collapsed = 固化坍缩步数；evicted/evictedSessions =
 *   是否发生整会话逐出与逐出会话 id（lastSeen 升序，0 视为最旧）。
 */
export function persistLedger(storage, ledger, { nowMs, table = null, activeIds = [], changedSids = null, cache = null, sizeCache = null, budgetBytes = LEDGER_TOTAL_BUDGET_BYTES, headroomBytes = LEDGER_EVICT_HEADROOM_BYTES } = {}) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const sizes = sizeCache instanceof Map ? sizeCache : new Map();
  const budget = Number.isFinite(budgetBytes) && budgetBytes > 0 ? budgetBytes : LEDGER_TOTAL_BUDGET_BYTES;
  const headroom = Number.isFinite(headroomBytes) && headroomBytes >= 0 ? headroomBytes : LEDGER_EVICT_HEADROOM_BYTES;
  const target = Math.max(0, budget - headroom);
  const todayRetentionDays = msSinceLocalMidnight(now) / 86_400_000;
  let aged = false;
  let collapsedTotal = 0;
  let dirty = changedSids === null ? null : new Set(changedSids);
  /* 尺寸缓存卫生（design D3）：剔除已消失会话；补测缺失会话的紧凑编码尺寸
     （O(changed)——稳态下缓存已被 load/save 覆盖，仅新建会话需要量测）。 */
  for (const sid of [...sizes.keys()]) {
    if (ledger.sessions[sid] === void 0) sizes.delete(sid);
  }
  const syncSizesOf = (pass) => {
    for (const sid of pass.touchedSids) {
      const session = ledger.sessions[sid];
      if (session === void 0) sizes.delete(sid);
      else sizes.set(sid, encodeSessionShard(session).length);
    }
  };
  const mergeTouched = (pass) => {
    if (dirty === null) return;
    for (const sid of pass.touchedSids) dirty.add(sid);
  };
  for (const [sid, session] of Object.entries(ledger.sessions)) {
    if (!sizes.has(sid)) sizes.set(sid, encodeSessionShard(session).length);
  }
  /* ① 常规固化（2 天窗口）+ 孤儿 GC：成功路径恒执行。 */
  const regular = ageLedger(ledger, { nowMs: now, table, activeIds, cache });
  aged = aged || regular.collapsed > 0 || regular.gcSessions > 0;
  collapsedTotal += regular.collapsed;
  syncSizesOf(regular);
  mergeTouched(regular);
  /* 落盘账面价（D1）：老化后快照，复用既有单遍产物（缓存命中零重放）。 */
  attachPricingForPersist(ledger, dirty, table, cache, sizes);
  /* ② 水位未超 → 既有增量保存。 */
  if (estimateLedgerBytes(sizes) <= budget) {
    if (saveLedger(storage, ledger, dirty, sizes)) {
      return { ok: true, aged, evicted: false, evictedSessions: [], collapsed: collapsedTotal };
    }
    /* 配额失败 → 会话粒度收紧重试（规格保留条款）：仅对脏集会话做全固化档收紧。 */
    if (dirty !== null) {
      const scoped = [...dirty].filter((sid) => ledger.sessions[sid] !== void 0);
      if (scoped.length > 0) {
        const scopedPass = ageLedger(ledger, { nowMs: now, table, activeIds, cache, rawRetentionDays: todayRetentionDays, onlySessions: scoped });
        aged = aged || scopedPass.collapsed > 0 || scopedPass.gcSessions > 0;
        collapsedTotal += scopedPass.collapsed;
        syncSizesOf(scopedPass);
        mergeTouched(scopedPass);
        attachPricingForPersist(ledger, dirty, table, cache, sizes);
        if (saveLedger(storage, ledger, dirty, sizes)) {
          return { ok: true, aged, evicted: false, evictedSessions: [], collapsed: collapsedTotal };
        }
      }
    }
  }
  /* ③ 全固化档：仅今日原始条目保留（本地零点起），重估后再保存。 */
  const full = ageLedger(ledger, { nowMs: now, table, activeIds, cache, rawRetentionDays: todayRetentionDays });
  aged = aged || full.collapsed > 0 || full.gcSessions > 0;
  collapsedTotal += full.collapsed;
  syncSizesOf(full);
  mergeTouched(full);
  attachPricingForPersist(ledger, dirty, table, cache, sizes);
  if (estimateLedgerBytes(sizes) <= budget && saveLedger(storage, ledger, dirty, sizes)) {
    return { ok: true, aged, evicted: false, evictedSessions: [], collapsed: collapsedTotal };
  }
  /* ④ 整会话逐出：lastSeen 升序（0 视为最旧），逐出至「预算 − headroom」内 →
     全量保存（删除对账自动清分片键与索引）。 */
  const evictedSessions = [];
  const byOldest = Object.entries(ledger.sessions)
    .map(([sid, session]) => [sid, Number(session.lastSeen) || 0])
    .sort((a, b) => a[1] - b[1]);
  for (const [sid] of byOldest) {
    if (estimateLedgerBytes(sizes) <= target) break;
    delete ledger.sessions[sid];
    sizes.delete(sid);
    if (cache instanceof Map) cache.delete(sid); /* R3 卫生：逐出即失效计价产物 */
    if (dirty !== null) dirty.delete(sid);
    evictedSessions.push(sid);
  }
  if (evictedSessions.length > 0) aged = true;
  attachPricingForPersist(ledger, null, table, cache, sizes);
  if (saveLedger(storage, ledger, null, sizes)) {
    return { ok: true, aged, evicted: evictedSessions.length > 0, evictedSessions, collapsed: collapsedTotal };
  }
  /* ⑤ 内存模式兜底（既有 persistError 语义；已执行的固化/逐出如实披露）。 */
  return { ok: false, aged, evicted: evictedSessions.length > 0, evictedSessions, collapsed: collapsedTotal };
}

/**
 * 导出备份的条目编码归一（fix-ledger-quota-budget D5，导出兼容旧格式）：内存账本
 * 恒为旧对象编码（紧凑编码仅存在于分片存储布局，读取时已解码），本函数兜底把
 * 可能出现的紧凑数组条目转回旧对象形（经会话级字典解析归属），保证旧版本插件
 * 可导入新备份（回滚安全，规格「导出 SHALL 转换为兼容旧版插件的条目编码」）。
 * @returns 与入参内容等价的旧对象编码账本（{v:1, sessions} 整体形状不变）。
 */
export function ledgerLegacyBackup(ledger) {
  const sessions = {};
  for (const [sid, session] of Object.entries(ledger?.sessions ?? {})) {
    if (typeof session !== "object" || session === null) continue;
    const catalog = Array.isArray(session.c) ? session.c : null;
    let entries = session.entries;
    if (Array.isArray(entries) && entries.some((entry) => Array.isArray(entry))) {
      entries = entries
        .map((entry) => (Array.isArray(entry) ? sanitizeEntry(entry, catalog) : entry))
        .filter((entry) => entry !== null);
    }
    sessions[sid] = { ...session, entries };
  }
  return { v: 1, sessions };
}

/* ------------------------------------------------------------------ *
 * 重算管线（ledger-recorded-pricing D4/D5/D8）：
 * 从 token 事实按当前价目重新导出账面价并回写分片；token 事实零改动。
 * ------------------------------------------------------------------ */

/**
 * 预算预检（ledger-recorded-pricing D4，纯函数）：估算「重算全账本」后总量——
 * 现尺寸 + 每个无 pricing 会话的估算增量（「首算按常数」，已有 pricing 的会话
 * 重写尺寸近似不变、差值按 0 计）。估算总量越过 `预算 − headroom` 水位余量 → 拒绝
 * 启动（提示先清理），MUST NOT 先重算再触发收缩阶梯。
 * @returns {ok, current, estimated, target, unpriced, delta}
 */
export function repriceLedgerBudgetCheck(ledger, sizeCache, { budgetBytes = LEDGER_TOTAL_BUDGET_BYTES, headroomBytes = LEDGER_EVICT_HEADROOM_BYTES } = {}) {
  const budget = Number.isFinite(budgetBytes) && budgetBytes > 0 ? budgetBytes : LEDGER_TOTAL_BUDGET_BYTES;
  const headroom = Number.isFinite(headroomBytes) && headroomBytes >= 0 ? headroomBytes : LEDGER_EVICT_HEADROOM_BYTES;
  const target = Math.max(0, budget - headroom);
  let unpriced = 0;
  for (const session of Object.values(ledger?.sessions ?? {})) {
    if (!session.pricing) unpriced += 1;
  }
  const current = estimateLedgerBytes(sizeCache);
  const delta = unpriced * PRICING_ESTIMATE_PER_SESSION_BYTES;
  const estimated = current + delta;
  return { ok: estimated <= target, current, estimated, target, unpriced, delta };
}

/**
 * 单会话重算（ledger-recorded-pricing D5）：按当前价目重导出该会话账面价并
 * 增量回写分片（saveLedger 只写该会话分片）。桶随会话一并重计（桶价是产物一部分）。
 * MUST NOT 改动 token 事实、覆盖语义。无 token 事实（无条目无桶）的会话不可重算。
 * @param cache - 逐会话计价产物缓存：重算后失效该会话槽位——同指纹重算（如同表
 *   引擎修正）下 sig 与 fp 均未变，不失效会命中陈旧产物（fix-ledger-storm 修正）。
 * @returns {ok, reason}；reason ∈ "missing" | "empty" | "save-failed" | null。
 */
export function repriceLedgerSession(storage, ledger, sessionId, table, sizeCache = null, cache = null) {
  const session = ledger?.sessions?.[sessionId];
  if (session === void 0) return { ok: false, reason: "missing" };
  if (session.entries.length === 0 && session.buckets.length === 0) return { ok: false, reason: "empty" };
  if (!Array.isArray(table)) return { ok: false, reason: "save-failed" };
  /* 现算（当前表，强制重放本会话：重算即「统一到现行价」）。 */
  const artifact = computePriceArtifact(ledger, sessionId, table);
  session.pricing = encodePricing(artifact, table, PRICING_ENGINE_VERSION);
  if (cache instanceof Map) cache.delete(sessionId);
  const ok = saveLedger(storage, ledger, [sessionId], sizeCache);
  return { ok, reason: ok ? null : "save-failed" };
}

/**
 * 全账本重算（ledger-recorded-pricing D4 骨架）：启动前预算预检（超水位余量拒绝）；
 * 逐会话串行、可中途停止（shouldStop）、每会话即算即写（读当前内存账本、增量落盘，
 * 中断不丢已写进度）。只写 pricing，token 事实零改动。
 * @returns {precheck, repriceCount, failedCount, skippedCount, stopped}
 */
export function repriceLedgerAll(storage, ledger, table, { sizeCache = null, budgetBytes = LEDGER_TOTAL_BUDGET_BYTES, headroomBytes = LEDGER_EVICT_HEADROOM_BYTES, shouldStop = null } = {}) {
  const precheck = repriceLedgerBudgetCheck(ledger, sizeCache, { budgetBytes, headroomBytes });
  if (!precheck.ok) {
    return { precheck, repriceCount: 0, failedCount: 0, skippedCount: 0, stopped: false };
  }
  let repriceCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let stopped = false;
  for (const sid of Object.keys(ledger?.sessions ?? {})) {
    if (typeof shouldStop === "function" && shouldStop()) {
      stopped = true;
      break;
    }
    const result = repriceLedgerSession(storage, ledger, sid, table, sizeCache);
    if (result.reason === "missing" || result.reason === "empty") skippedCount += 1;
    else if (result.ok) repriceCount += 1;
    else failedCount += 1;
  }
  return { precheck, repriceCount, failedCount, skippedCount, stopped };
}

/* ------------------------------------------------------------------ *
 * 账本版本通知（perf-hot-path-optimization D3）
 * ------------------------------------------------------------------ */

/**
 * 账本变更通知器：版本号即增（唯一事实源，订阅方挂载初值直读），事件派发分两档——
 *  - 沉淀路径 `{coalesce: true}`：尾随防抖合并派发（挂起期间吸收后续通知，
 *    多次合并为一次；流式持续沉淀时页面按 ~500ms 窗口刷新，不无限推迟）；
 *  - 用户可见变更（导入、清除、重建落定）：立即派发，并取消挂起的合并派发
 *    （挂起期间累计的版本随本次立即派发一并送达）。
 * 定时器经注入（schedule/cancel），node 可单测。防抖不是正确性前提——未合并的
 * 连续通知在逐会话产物缓存（D2）下亦只导致变化会话的重算。
 */
export function createLedgerNotifier({ schedule = (fn, ms) => setTimeout(fn, ms), cancel = (id) => clearTimeout(id), dispatch = () => {}, coalesceMs = 500 } = {}) {
  let version = 0;
  let timer = 0;
  const flush = () => {
    timer = 0;
    dispatch(version);
  };
  return {
    /** 当前版本号（挂载初值直读；防抖挂起不丢状态）。 */
    get version() {
      return version;
    },
    notify({ coalesce = false } = {}) {
      version += 1;
      if (!coalesce) {
        if (timer !== 0) {
          cancel(timer);
          timer = 0;
        }
        dispatch(version);
        return;
      }
      if (timer !== 0) return; /* 挂起期间吸收：合并为一次尾随派发 */
      timer = schedule(flush, coalesceMs);
    }
  };
}

/* ------------------------------------------------------------------ *
 * 费用与视图聚合
 * ------------------------------------------------------------------ */

function rowsOfEntries(entries) {
  const byTurn = new Map();
  for (const entry of entries) {
    const [turn, step] = entry.k.split(":").map(Number);
    let row = byTurn.get(turn);
    if (row === void 0) {
      row = { turn, steps: [] };
      byTurn.set(turn, row);
    }
    row.steps.push({
      provider: entry.p,
      model: entry.m,
      step,
      usage: entry.u,
      time: entry.t,
      startTime: entry.st
    });
  }
  return [...byTurn.values()].sort((a, b) => a.turn - b.turn);
}

/**
 * 一个会话的账本费用（原始条目逐步 + 老化桶）。
 * 原始条目按轮合成 priceTurnRows 的输入（档位/币种守卫齐全）；
 * 老化桶走 bucketSetCost（defaultTier + 记录的窗口命中）。
 * 费用 = 已定价步/桶之和（fix-step-level-cost：未定价步不计入但原因如实披露，
 * 不再把整会话置 null——否则按模型的费用归因总和会大于会话/KPI 总费用）。
 * @returns { covered, cost|null, currency, unmatched[], coverage, byModel }；
 *   cost=null 仅表示无任何已定价步/桶（显示「未定价」），完全无覆盖 covered=false；
 *   byModel: Map<model, {cost, tokens}> 按模型归因的已定价费用与四桶
 *   （fix: 按模型页签费用列与百万 token 均价；行级未定价不影响已定价步的归因）。
 */
export function priceLedgerSession(ledger, sessionId, table) {
  const session = ledger.sessions[sessionId];
  if (session === void 0 || (session.entries.length === 0 && session.buckets.length === 0)) {
    return { covered: false, cost: null, currency: null, unmatched: [], coverage: session?.coverage ?? {}, byModel: new Map() };
  }
  const unmatched = new Map();
  const byModel = new Map();
  const accModel = (model, cost, tokens) => {
    const cur = byModel.get(model);
    if (cur === void 0) {
      const init = { cost, tokens: emptyBuckets() };
      for (const field of BUCKET_FIELDS) init.tokens[field] = tokens?.[field] ?? 0;
      byModel.set(model, init);
      return;
    }
    cur.cost += cost;
    for (const field of BUCKET_FIELDS) cur.tokens[field] += tokens?.[field] ?? 0;
  };
  let anyPriced = false;
  let cost = 0;
  /* 1) 原始条目：按轮合成行（priceTurnRows 的累计分档键在时间序内递推）。 */
  const priced = priceTurnRows(rowsOfEntries(session.entries), table);
  for (const row of priced) {
    for (const reason of row.unmatched) unmatched.set(reason, true);
    if (row.cost !== null) {
      anyPriced = true;
      cost += row.cost;
    }
    /* 逐步归因到模型：行级未定价不影响已定价步的归因（未定价步无 stepPrice，自然跳过）。 */
    for (let i = 0; i < row.steps.length; i++) {
      const sp = row.stepPrices[i];
      if (sp) accModel(row.steps[i].model || UNKNOWN_MODEL_LABEL, sp.cost, row.steps[i].usage);
    }
  }
  /* 2) 老化桶。 */
  const displayCurrency = displayCurrencyOf(table);
  for (const bucket of session.buckets) {
    const entry = matchPriceEntry(table, bucket.m, bucket.p);
    if (!entry) {
      unmatched.set(`${bucket.m || UNKNOWN_MODEL_LABEL}:无价目`, true);
      continue;
    }
    if (entry.currency !== displayCurrency) {
      unmatched.set(`${bucket.m || UNKNOWN_MODEL_LABEL}:币种不符(${entry.currency})`, true);
      continue;
    }
    const result = bucketSetCost(entry, bucket.u, { win: bucket.w });
    if (result === null) {
      unmatched.set(`${bucket.m || UNKNOWN_MODEL_LABEL}:无价目`, true);
      continue;
    }
    anyPriced = true;
    cost += result.cost;
    accModel(bucket.m || UNKNOWN_MODEL_LABEL, result.cost, bucket.u);
  }
  return {
    covered: true,
    cost: anyPriced ? cost : null,
    currency: displayCurrency,
    unmatched: [...unmatched.keys()],
    coverage: session.coverage,
    byModel
  };
}

/** 覆盖是否为部分覆盖（窗口未满载 / 深补截断）。 */
export function isPartialCoverage(coverage) {
  if (typeof coverage !== "object" || coverage === null) return false;
  return coverage.windowFull === false || coverage.deepTruncated === true;
}

/* ------------------------------------------------------------------ *
 * 逐会话计价产物缓存 + 单遍聚合（perf-hot-path-optimization D2/R2/R3）
 * ------------------------------------------------------------------ */

/** 创建逐会话计价产物缓存（客户端持模块级单例；测试按需注入独立实例）。 */
export function createPriceCache() {
  return new Map();
}

const FNV_OFFSET_BASIS = 0x811c9dc5;

function fnv1aRolling(hash, text) {
  let h = hash;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** 价目表指纹（fp，ledger-recorded-pricing D2）记忆化缓存：按价目表数组引用——
 *  价目唯一经 savePriceTable 变更，每次变更产出新数组引用（loadPriceTable 校验产物），
 *  故「同价目版本 = 同数组引用 = 零重复哈希」，与「按 tableVersion 记忆化」语义等价。 */
const priceTableFingerprintMemo = new WeakMap();

/**
 * 价目表内容稳定指纹（ledger-recorded-pricing D2）：FNV-1a 滚动哈希，逐条目按
 * JSON 序列化入哈希（覆盖 model/provider/currency/unit/defaultTier/tiers/timeWindows/
 * discount 全部计价相关字段，键序由 validatePriceTable 与 DEFAULT_PRICE_TABLE 固定，
 * 产物跨会话/跨重启稳定）。按价目数组引用记忆化——渲染路径零重复哈希。
 * @returns 十六进制指纹串（非数组回 "0"）。
 */
export function priceTableFingerprint(table) {
  if (!Array.isArray(table)) return "0";
  const cached = priceTableFingerprintMemo.get(table);
  if (cached !== void 0) return cached;
  let hash = FNV_OFFSET_BASIS;
  for (const entry of table) {
    hash = fnv1aRolling(hash, JSON.stringify(entry) + "\n");
  }
  const fp = hash.toString(16);
  priceTableFingerprintMemo.set(table, fp);
  return fp;
}

/**
 * 会话条目签名（R2）：条目/桶数量 + 末条目键 + FNV-1a 滚动哈希。
 * 哈希逐条目覆盖 k|p|m|四桶|t|st、逐桶覆盖 d|m|p|w|四桶|n——标识性字符串
 * （模型/路由归属）必须进哈希：定向修复（fix-ledger-attribution）对既有条目
 * 仅回填模型名时其余字段全不变，签名 MUST 变化，否则该会话永远显示「未定价」；
 * p/st 影响价目匹配、时段折扣与日桶归属，规格要求「模型/路由归属等标识性内容」
 * 全部覆盖，故一并纳入。哈希碰撞在 length+末键联合守卫下可忽略；即便碰撞，
 * 下一次沉淀/修复即自愈。
 */
function ledgerSessionSignature(session) {
  if (session === void 0) return "0";
  const entries = session.entries;
  const buckets = session.buckets;
  let hash = FNV_OFFSET_BASIS;
  for (const entry of entries) {
    const u = entry.u;
    hash = fnv1aRolling(
      hash,
      `${entry.k}|${entry.p}|${entry.m}|${u.inputTokens}|${u.cacheReadTokens}|${u.cacheWriteTokens}|${u.outputTokens}|${entry.t}|${entry.st}\n`
    );
  }
  for (const bucket of buckets) {
    const u = bucket.u;
    hash = fnv1aRolling(
      hash,
      `${bucket.d}|${bucket.m}|${bucket.p}|${bucket.w ? `${bucket.w.from}~${bucket.w.to}` : "-"}|${u.inputTokens}|${u.cacheReadTokens}|${u.cacheWriteTokens}|${u.outputTokens}|${bucket.n}\n`
    );
  }
  const lastKey = entries.length > 0 ? entries[entries.length - 1].k : "";
  return `${entries.length}:${buckets.length}:${lastKey}:${hash.toString(16)}`;
}

function emptyPriceArtifact(coverage) {
  return {
    priced: { covered: false, cost: null, currency: null, unmatched: [], coverage: coverage ?? {}, byModel: new Map() },
    dailyCost: new Map(),
    dailyTokens: new Map(),
    modelTokens: new Map(),
    coveredBuckets: emptyBuckets()
  };
}

/**
 * 会话 token 事实（与价目无关的一次遍历，ledger-recorded-pricing D6 拆出）：
 *  - dailyTokens：按日 token 桶（原始条目按 st ?? t 归日；老化桶按其聚合日
 *    bucket.d 直接入柱（桶自带日键，fix-ledger-storm 对账）——趋势 token 与
 *    费用线（账面价逐日，本就按桶日期）同基，8/28 式「费用有柱、token 无柱」
 *    的对不上账由此消除；
 *  - modelTokens：按模型 token 桶（首现 provider 随行）；
 *  - coveredBuckets：会话四桶覆盖总量（「未分类」余量读这里）。
 * 这三项不随价目漂移——账面价快照重建产物时须从这里补齐（快照只存费用面）。
 */
function computeTokenFacts(ledger, sessionId) {
  const session = ledger.sessions[sessionId];
  const modelTokens = new Map();
  const accTokens = (model, provider, buckets) => {
    let agg = modelTokens.get(model);
    if (agg === void 0) {
      agg = { provider, buckets: emptyBuckets() };
      modelTokens.set(model, agg);
    }
    for (const field of BUCKET_FIELDS) agg.buckets[field] += buckets?.[field] ?? 0;
  };
  const dailyTokens = new Map();
  const accDay = (ms, buckets) => {
    const day = dayKeyOf(ms);
    if (day === null) return;
    let bucket = dailyTokens.get(day);
    if (bucket === void 0) {
      bucket = emptyBuckets();
      dailyTokens.set(day, bucket);
    }
    for (const field of BUCKET_FIELDS) bucket[field] += buckets?.[field] ?? 0;
  };
  const accDayKey = (day, buckets) => {
    if (typeof day !== "string") return;
    let bucket = dailyTokens.get(day);
    if (bucket === void 0) {
      bucket = emptyBuckets();
      dailyTokens.set(day, bucket);
    }
    for (const field of BUCKET_FIELDS) bucket[field] += buckets?.[field] ?? 0;
  };
  const coveredBuckets = emptyBuckets();
  for (const row of rowsOfEntries(session?.entries ?? [])) {
    for (const step of row.steps) {
      accDay(step.startTime ?? step.time, step.usage);
      accTokens(step.model ?? "", step.provider ?? "", step.usage);
      for (const field of BUCKET_FIELDS) coveredBuckets[field] += step.usage[field] ?? 0;
    }
  }
  for (const bucket of session?.buckets ?? []) {
    accTokens(bucket.m, bucket.p, bucket.u);
    for (const field of BUCKET_FIELDS) coveredBuckets[field] += bucket.u[field] ?? 0;
    accDayKey(bucket.d, bucket.u);
  }
  return { dailyTokens, modelTokens, coveredBuckets };
}

/**
 * 由 pricing 快照重建计价产物（ledger-recorded-pricing D6 第 2 级解析序）：
 * 费用面（cost/currency/byModel/unmatched）+ 按日费用出自快照（账面价，不随价目漂移），
 * token 事实（dailyTokens/modelTokens/coveredBuckets）从会话条目廉价重遍历补齐——
 * 不再执行逐步计价重放（这正是账面价的性能红利）。coverage/covered 取自会话现状。
 */
function rebuildArtifactFromPricing(ledger, sessionId, pricing) {
  const session = ledger.sessions[sessionId];
  const byModel = new Map();
  for (const row of pricing.bm) {
    const tokens = { inputTokens: row[2], cacheReadTokens: row[3], cacheWriteTokens: row[4], outputTokens: row[5] };
    byModel.set(pricing.mc[row[0]], { cost: row[1], tokens });
  }
  const facts = computeTokenFacts(ledger, sessionId);
  const covered = session !== void 0 && (session.entries.length > 0 || session.buckets.length > 0);
  return {
    priced: {
      covered,
      cost: pricing.cost,
      currency: pricing.cur,
      unmatched: pricing.um,
      coverage: session?.coverage ?? {},
      byModel
    },
    dailyCost: new Map(pricing.dc),
    dailyTokens: facts.dailyTokens,
    modelTokens: facts.modelTokens,
    coveredBuckets: facts.coveredBuckets
  };
}

/**
 * 单遍重放一个会话：一次遍历同时产出
 *  - priced：priceLedgerSession 全字段（费用 / 未定价原因 / byModel 归因）；
 *  - dailyCost：该会话的按日费用桶（priceDailyCost 的步级重放并入）；
 *  - dailyTokens：该会话的按日 token 桶（原始条目按 st ?? t 归日，与既有口径一致）；
 *  - modelTokens：该会话的按模型 token 桶（首现 provider 随行）；
 *  - coveredBuckets：会话四桶覆盖总量（「未分类」余量读这里，R3）。
 * 费用按轮分组累加，与两遍对照实现（priceLedgerSession）的浮点求和次序逐位一致。
 */
function computePriceArtifact(ledger, sessionId, table) {
  const session = ledger.sessions[sessionId];
  if (session === void 0 || (session.entries.length === 0 && session.buckets.length === 0)) {
    return emptyPriceArtifact(session?.coverage);
  }
  const displayCurrency = displayCurrencyOf(table);
  const unmatched = new Map();
  const byModel = new Map();
  const accModel = (model, cost, tokens) => {
    const cur = byModel.get(model);
    if (cur === void 0) {
      const init = { cost, tokens: emptyBuckets() };
      for (const field of BUCKET_FIELDS) init.tokens[field] = tokens?.[field] ?? 0;
      byModel.set(model, init);
      return;
    }
    cur.cost += cost;
    for (const field of BUCKET_FIELDS) cur.tokens[field] += tokens?.[field] ?? 0;
  };
  /* token 事实（与价目无关）交由 computeTokenFacts 单遍补齐——计价在此只做费用面。 */
  const facts = computeTokenFacts(ledger, sessionId);
  const dailyCost = new Map();
  const pushDayCost = (day, cost) => {
    if (day === null || !Number.isFinite(cost)) return;
    dailyCost.set(day, (dailyCost.get(day) ?? 0) + cost);
  };
  let anyPriced = false;
  let cost = 0;
  /* 1) 原始条目：单遍重放（与 priceTurnRows 同口径：累计分档键按模型时间序递推；
        未定价步不喂累计键，也不计入费用/日费用，但 token 归日与覆盖桶照常）。 */
  const cumulative = new Map();
  for (const row of rowsOfEntries(session.entries)) {
    row.steps.sort((a, b) => a.step - b.step);
    let rowCost = 0;
    for (const step of row.steps) {
      const entry = matchPriceEntry(table, step.model ?? "", step.provider ?? "");
      if (!entry) {
        unmatched.set(`${step.model || UNKNOWN_MODEL_LABEL}:无价目`, true);
        continue;
      }
      if (entry.currency !== displayCurrency) {
        unmatched.set(`${step.model || UNKNOWN_MODEL_LABEL}:币种不符(${entry.currency})`, true);
        continue;
      }
      const key = step.model ?? "";
      const total = cumulative.get(key) ?? 0;
      cumulative.set(key, total + promptTokens(step.usage) + (step.usage.outputTokens ?? 0));
      const tier = resolveTier(entry, { contextTokens: promptTokens(step.usage), cumulativeTokens: total });
      const result = stepCost(entry, step.usage, { time: step.startTime ?? step.time, cumulativeTokens: total });
      if (tier === null || result === null) continue;
      anyPriced = true;
      rowCost += result.cost;
      accModel(step.model || UNKNOWN_MODEL_LABEL, result.cost, step.usage);
      pushDayCost(dayKeyOf(step.startTime ?? step.time), result.cost);
    }
    cost += rowCost;
  }
  /* 2) 老化桶。 */
  for (const bucket of session.buckets) {
    const entry = matchPriceEntry(table, bucket.m, bucket.p);
    if (!entry) {
      unmatched.set(`${bucket.m || UNKNOWN_MODEL_LABEL}:无价目`, true);
      continue;
    }
    if (entry.currency !== displayCurrency) {
      unmatched.set(`${bucket.m || UNKNOWN_MODEL_LABEL}:币种不符(${entry.currency})`, true);
      continue;
    }
    const result = bucketSetCost(entry, bucket.u, { win: bucket.w });
    if (result === null) {
      unmatched.set(`${bucket.m || UNKNOWN_MODEL_LABEL}:无价目`, true);
      continue;
    }
    anyPriced = true;
    cost += result.cost;
    accModel(bucket.m || UNKNOWN_MODEL_LABEL, result.cost, bucket.u);
    pushDayCost(bucket.d, result.cost);
  }
  return {
    priced: {
      covered: true,
      cost: anyPriced ? cost : null,
      currency: displayCurrency,
      unmatched: [...unmatched.keys()],
      coverage: session.coverage,
      byModel
    },
    dailyCost,
    dailyTokens: facts.dailyTokens,
    modelTokens: facts.modelTokens,
    coveredBuckets: facts.coveredBuckets
  };
}

/**
 * 逐会话计价产物（ledger-recorded-pricing D6 三级解析序，缓存主体）：
 *  1. 内存签名缓存命中（会话 + 条目签名未变）→ 直接返回缓存产物；
 *     不变量：价目编辑不再使缓存失效（费用展示语境下 tableVersion 退出失效职责）——
 *     无 pricing 的会话缓存键含价目指纹（价目编辑显式现算刷新、与旧世界一致），
 *     有 pricing 的会话缓存键仅含签名（账面价冻结，价目编辑不回写历史）。
 *  2. pricing 在册（ev/fp 任意）→ 快照重建成产物形状并写回签名缓存——账面价照常
 *     使用（旧价目/fp 差异/引擎过旧均由脚注披露，D2/D3，不得在此分支触发现算）；
 *  3. 无 pricing / 解析失败 → 现算（computePriceArtifact，当前表）并进缓存；
 *     软迁移会话的现算产物在其首次持久化时落盘为 pricing。
 * @param cache - 调用方持有的 Map（createPriceCache 产物；清除/GC/导入替换时
 *   由调用方同步失效）。缺省（null/非 Map）不缓存。
 * @param tableVersion - 兼容保留（不再参与缓存失效；价目指纹 priceTableFingerprint 取代）。
 * @returns { priced, dailyCost, dailyTokens, modelTokens, coveredBuckets }。
 */
export function priceArtifactOf(ledger, sessionId, table, cache = null, tableVersion = 0) {
  const session = ledger?.sessions?.[sessionId];
  const sig = ledgerSessionSignature(session);
  const pricing = session?.pricing;
  const isMap = cache instanceof Map;
  if (isMap) {
    const cached = cache.get(sessionId);
    if (cached !== void 0 && cached.sig === sig) {
      /* 有 pricing：签名未变即账面价冻结（价目编辑不失效）；无 pricing：还须价目指纹一致。 */
      if (pricing ? cached.fp === pricing.fp : cached.fp === priceTableFingerprint(table)) {
        return cached.artifact;
      }
    }
  }
  let artifact;
  let fp;
  if (pricing) {
    /* 第 2 级：快照重建（廉价形状变换 + token 事实补齐，零计价重放）。 */
    artifact = rebuildArtifactFromPricing(ledger ?? emptyLedger(), sessionId, pricing);
    fp = pricing.fp;
  } else {
    /* 第 3 级：现算（软迁移 / 无 pricing）。 */
    artifact = computePriceArtifact(ledger ?? emptyLedger(), sessionId, table);
    fp = priceTableFingerprint(table);
  }
  if (isMap) cache.set(sessionId, { sig, fp, artifact });
  return artifact;
}

/**
 * 会话账面价披露状态（ledger-recorded-pricing D2/D3，纯函数）：
 *  - staleTable：价目指纹与当前表不一致 →「账面价基于旧价目」；
 *  - needsReprice：引擎版本戳落后 →「待重算」（引擎升级自动全账本标脏）。
 * 无 pricing → null（回退现算，无披露）。
 * @returns {staleTable, needsReprice} | null。
 */
export function pricingStatusOf(ledger, sessionId, table) {
  const pricing = ledger?.sessions?.[sessionId]?.pricing;
  if (!pricing) return null;
  const staleTable = pricing.fp !== priceTableFingerprint(table);
  const needsReprice = !Number.isFinite(pricing.ev) || pricing.ev < PRICING_ENGINE_VERSION;
  return { staleTable, needsReprice };
}

/** 「未分类」余量的零覆盖量（会话不在账本时的既有语义）。 */
const ZERO_COVERED_BUCKETS = emptyBuckets();

/**
 * 总览视图一次性聚合（按模型 / 按时间 token 桶 / 逐会话费用）。
 * 全部数据出自逐会话计价产物（单遍重放）：打开页面的全账本计价重放为单遍，
 * 不再执行「逐会话一遍 + 日费用一遍」的两遍独立重放。
 * 费用线（按日）请用 priceDailyCost（同源产物的兼容出口）。
 * @param ledger - 账本。
 * @param table - 当前价目表。
 * @param expanded - rows-aggregate.expandRows 产物（Tier 0 行，供「未分类」余量）。
 * @param excludeIds - fork 分支副本等排除集（bySession 行保留、聚合排除）。
 * @param cache - 逐会话计价产物缓存（缺省临时缓存：既有纯函数签名兼容）。
 * @param tableVersion - 价目版本计数。
 * @returns {
 *   bySession: Map<sid, priceLedgerSession 结果>,
 *   byModel:   [{model, provider, buckets, total, currency, unmatched, cost|null, avgCost}],
 *   daily:     Map<day, {buckets}>（按步发生时刻 + 老化桶按其聚合日，账本覆盖段）,
 *   dailyBucketsBySession: Map<sid, 四桶>（fix-partial-coverage 1.1：逐会话「已按日
 *     入柱覆盖量」——artifact.dailyTokens 聚合循环处顺手按会话累计，零重算。与
 *     views.daily 同基（原始条目按步日 + 老化桶按聚合日，fix-ledger-storm 对账），
 *     键覆盖全部已覆盖非 fork 会话；趋势余量的基线（余量 = 投影 − 它，仅真正
 *     无日信息的投影超出部分落「按最近活动」），MUST NOT 为其触发第二次账本重放）,
 *   coveredBucketsBySession: Map<sid, 四桶>（fix-ledger-quota-budget 修正：逐会话
 *     「账本总覆盖」= 原始条目 + 老化桶四桶合计，读 artifact.coveredBuckets 零重算；
 *     覆盖缺口检测的基线——老化桶是已固化的覆盖量，缺口 MUST 以总覆盖计，否则
 *     固化会把已覆盖会话误判成全量缺口。仅 covered 会话有键）,
 *   coveredIds: Set<sid>,
 *   anyCovered: boolean
 * }
 */
/**
 * 逐会话四桶合计（entries + 老化桶，纯函数）——投影缺席时的 Tier 1 兜底数据源
 * （dsh-012-compat：升级后投影检查点版本门槛导致冷会话列表行不携带投影）。
 * @param ledger - 内存账本（ledgerData() 形状）。
 * @returns Map<sessionId, {inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens}>，
 *   仅含至少有一条可计桶的会话。
 */
export function ledgerSessionBuckets(ledger) {
  const map = new Map();
  for (const [sid, session] of Object.entries(ledger?.sessions ?? {})) {
    const totals = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
    let any = false;
    for (const entry of session?.entries ?? []) {
      const u = entry?.u;
      if (typeof u !== "object" || u === null) continue;
      for (const field of BUCKET_FIELDS) totals[field] += u[field] ?? 0;
      any = true;
    }
    for (const bucket of session?.buckets ?? []) {
      const u = bucket?.u;
      if (typeof u !== "object" || u === null) continue;
      for (const field of BUCKET_FIELDS) totals[field] += u[field] ?? 0;
      any = true;
    }
    if (any) map.set(sid, totals);
  }
  return map;
}

/**
 * 当日 token 四桶合计（add-seat-speed-ring，design D2 纯函数层）：
 * 逐会话遍历「原始条目」按发生时刻 `st ?? t` 归日直接求和——零计价（token 合计与
 * 价目无关，价目变更 MUST NOT 触发重算）、零缓存（无第二份账本产物缓存，每次
 * 重算 O(当日条目) 次加法，无冷缓存悬崖）。归日定义与 computePriceArtifact 的
 * accDay 逐点一致：null 日跳过、未定价步照常计入 token、不含老化桶——今日条目
 * 永不老化（retention ≥ 14 天），故与 aggregateLedgerViews().daily 同日桶恒等
 * （同条目源、同归日、同剔除），等价性由 test/ledger-day-tokens.test.mjs 固化。
 * @param ledger - 内存账本（ledgerData() 形状）。
 * @param dayKey - 目标日本地时区键（dayKeyOf 产物，YYYY-MM-DD）。
 * @param excludeIds - 排除会话 id 集（fork 分支副本；Set，可缺省）。
 * @returns 四桶合计 {inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens}。
 */
export function ledgerTokensForDay(ledger, dayKey, excludeIds = null) {
  const totals = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  if (typeof dayKey !== "string") return totals;
  const excluded = excludeIds instanceof Set ? excludeIds : null;
  for (const [sid, session] of Object.entries(ledger?.sessions ?? {})) {
    if (excluded !== null && excluded.has(sid)) continue;
    for (const entry of session?.entries ?? []) {
      if (dayKeyOf(entry?.st ?? entry?.t) !== dayKey) continue;
      const u = entry?.u;
      if (typeof u !== "object" || u === null) continue;
      for (const field of BUCKET_FIELDS) totals[field] += u[field] ?? 0;
    }
  }
  return totals;
}

/**
 * 座位速度仪表投影比（add-seat-speed-ring，design D1 纯函数层，node 可单测）：
 * r = (今日累计 ÷ max(已过小时, 1)) ÷ (计划 ÷ 24)——已过小时自当地零点起算、
 * 下限 1h（凌晨首笔不因除以极小小时数爆表）；语义为「按当前节奏跑满 24 小时，
 * 将达每日计划的百分比」。填充 = min(r, 150%)/150%（1% 量化由调用方门闩），
 * 分区边界线性落位：25% → 16.7%、50% → 33.3%、100%（最绿点）→ 66.7%、≥150% 满格。
 * @param total - 今日累计 token 四桶总量（totalTokens(ledgerTokensForDay(…))）。
 * @param elapsedHours - 当地零点起已过小时数（可带小数）。
 * @param planDaily - 每日计划（Token/天，正数）。
 * @returns { r, speedPct, fillPct }；无数据/无标尺（total ≤ 0 或 plan 非正有限）→ null
 *   （调用方以此决定仪表不渲染，MUST NOT 把计划当作 0 参与计算）。
 */
export function seatSpeedGauge(total, elapsedHours, planDaily) {
  if (!Number.isFinite(total) || !(total > 0)) return null;
  if (!Number.isFinite(planDaily) || !(planDaily > 0)) return null;
  const hours = Number.isFinite(elapsedHours) && elapsedHours > 0 ? elapsedHours : 0;
  const r = total / Math.max(hours, 1) / (planDaily / 24);
  return {
    r,
    speedPct: Math.round(r * 100),
    fillPct: Math.round((Math.min(r, 1.5) / 1.5) * 100)
  };
}

export function aggregateLedgerViews(ledger, table, expanded, excludeIds = new Set(), cache = null, tableVersion = 0) {
  const bySession = new Map();
  const modelMap = new Map();
  const daily = new Map();
  const dailyBucketsBySession = new Map();
  const coveredBucketsBySession = new Map();
  const coveredIds = new Set();
  const coveredBySession = new Map();
  /* 缺省临时缓存：既有纯函数测试签名兼容（同调用内逐会话产物仍共享）。 */
  const effectiveCache = cache instanceof Map ? cache : new Map();
  const accumulateDay = (day, buckets) => {
    if (day === null) return;
    let bucket = daily.get(day);
    if (bucket === void 0) {
      bucket = { buckets: emptyBuckets() };
      daily.set(day, bucket);
    }
    for (const field of BUCKET_FIELDS) bucket.buckets[field] += buckets[field] ?? 0;
  };
  for (const sid of Object.keys(ledger.sessions)) {
    const artifact = priceArtifactOf(ledger, sid, table, effectiveCache, tableVersion);
    const priced = artifact.priced;
    bySession.set(sid, priced);
    coveredBySession.set(sid, artifact.coveredBuckets);
    /* 账本「总覆盖」（原始条目 + 老化桶四桶合计，fix-ledger-quota-budget 修正）：
       覆盖缺口检测的基线。老化桶是已落盘固化的覆盖量，MUST 计入——若缺口只看
       「已按日入柱」的原始条目，固化会把已覆盖会话误判成全量缺口（自动深补风暴
       打爆宿主 + 收缩后缺口永不收敛的churn）。仅 covered 会话有键（空键会话/
       从未覆盖不入选的既有判据不变）。 */
    if (priced.covered) coveredBucketsBySession.set(sid, artifact.coveredBuckets);
    if (!priced.covered) continue;
    /* fork 分支副本（fix: fork 去重）——bySession 保留供逐行查看，
       但其消耗（种子副本）不进模型/日聚合。 */
    if (excludeIds.has(sid)) continue;
    coveredIds.add(sid);
    /* 按模型 token 桶（首现 provider 随行）+ 按日 token 桶：同源产物。 */
    for (const [model, agg] of artifact.modelTokens) {
      let row = modelMap.get(model);
      if (row === void 0) {
        row = { model, provider: agg.provider, buckets: emptyBuckets(), currency: priced.currency, unmatched: [...priced.unmatched], cost: null };
        modelMap.set(model, row);
      }
      for (const field of BUCKET_FIELDS) row.buckets[field] += agg.buckets[field];
    }
    /* 逐会话「已按日入柱覆盖量」（fix-partial-coverage 1.1，D2/D4）：在既有
       artifact.dailyTokens 聚合循环处顺手按会话累计，零重算。占位先于循环——
       dailyTokens 恒非空（无条目也有键），使余量归并与缺口检测（有键 = 曾实际
       覆盖）语义完备；未覆盖/空键/排除（fork）会话无键，走各自既有路径。 */
    let sessionDaily = dailyBucketsBySession.get(sid);
    if (sessionDaily === void 0) {
      sessionDaily = emptyBuckets();
      dailyBucketsBySession.set(sid, sessionDaily);
    }
    for (const [day, buckets] of artifact.dailyTokens) {
      accumulateDay(day, buckets);
      for (const field of BUCKET_FIELDS) sessionDaily[field] += buckets[field] ?? 0;
    }
    /* 按模型费用归因合并（fix: 按模型页签费用列与百万 token 均价）。 */
    for (const [m, agg] of priced.byModel) {
      let row = modelMap.get(m);
      if (row === void 0) {
        row = { model: m, provider: "", buckets: emptyBuckets(), currency: priced.currency, unmatched: [...priced.unmatched], cost: null };
        modelMap.set(m, row);
      }
      row.cost = (row.cost ?? 0) + agg.cost;
    }
  }
  /* 「未分类」余量：逐会话 Tier0 总量 − 账本覆盖量（逐桶，负值截 0）。
     读产物 coveredBuckets（R3）：不再对每会话条目做二次全量扫描（O(S×E) → O(S)）。 */
  const uncovered = emptyBuckets();
  for (const item of expanded ?? []) {
    const covered = coveredBySession.get(item.id) ?? ZERO_COVERED_BUCKETS;
    const usage = item.usage ?? emptyBuckets();
    for (const field of BUCKET_FIELDS) {
      uncovered[field] += Math.max(0, (usage[field] ?? 0) - (covered[field] ?? 0));
    }
  }
  const byModel = [...modelMap.values()].map((row) => {
    const total = row.buckets.inputTokens + row.buckets.cacheReadTokens + row.buckets.cacheWriteTokens + row.buckets.outputTokens;
    return {
      ...row,
      total,
      /* 百万 token 成本均值（模型级参考值）：已定价费用 ÷ token 总量 × 10⁶；
         无已定价费用（cost=null）或零 token 时为 null。排序/呈现直接可用。 */
      avgCost: row.cost !== null && row.cost !== void 0 && total > 0 ? (row.cost * UNIT) / total : null
    };
  });
  if (!isEmptyBuckets(uncovered)) {
    byModel.push({
      model: null,
      provider: "",
      buckets: uncovered,
      total: BUCKET_FIELDS.reduce((sum, field) => sum + uncovered[field], 0),
      currency: displayCurrencyOf(table),
      unmatched: [],
      cost: null,
      avgCost: null
    });
  }
  byModel.sort((a, b) => b.total - a.total);
  return { bySession, byModel, daily, dailyBucketsBySession, coveredBucketsBySession, coveredIds, anyCovered: coveredIds.size > 0 };
}

/**
 * 两遍对照实现（等价性护栏专用，任务 1.2/3.3）：逐会话 priceLedgerSession 一遍 +
 * 步级日费用重放一遍。产物组装出口 priceDailyCost 必须与其逐值相等
 * （test/ledger-equivalence.test.mjs 固化）；语义注释见下。
 */
export function priceDailyCostTwoPass(ledger, table) {
  const dailyCost = new Map();
  const displayCurrency = displayCurrencyOf(table);
  const push = (day, cost) => {
    if (day === null || !Number.isFinite(cost)) return;
    const current = dailyCost.get(day) ?? { cost: 0, currency: displayCurrency };
    current.cost += cost;
    dailyCost.set(day, current);
  };
  for (const session of Object.values(ledger.sessions)) {
    if (session.entries.length === 0 && session.buckets.length === 0) continue;
    /* 单步重放（与 priceTurnRows 同口径：累计分档键按模型时间序递推）。 */
    const cumulative = new Map();
    const stepCosts = [];
    for (const row of rowsOfEntries(session.entries)) {
      row.steps.sort((a, b) => a.step - b.step);
      for (const step of row.steps) {
        const entry = matchPriceEntry(table, step.model ?? "", step.provider ?? "");
        /* 未定价步（无条目/币种不符）跳过：不计入该日，也不喂同模型累计键。 */
        if (!entry || entry.currency !== displayCurrency) continue;
        const key = step.model ?? "";
        const total = cumulative.get(key) ?? 0;
        cumulative.set(key, total + promptTokens(step.usage) + (step.usage.outputTokens ?? 0));
        const tier = resolveTier(entry, { contextTokens: promptTokens(step.usage), cumulativeTokens: total });
        const result = stepCost(entry, step.usage, { time: step.startTime ?? step.time, cumulativeTokens: total });
        if (tier === null || result === null) continue;
        stepCosts.push({ day: dayKeyOf(step.startTime ?? step.time), cost: result.cost });
      }
    }
    for (const item of stepCosts) push(item.day, item.cost);
    for (const bucket of session.buckets) {
      const entry = matchPriceEntry(table, bucket.m, bucket.p);
      if (!entry || entry.currency !== displayCurrency) continue;
      const result = bucketSetCost(entry, bucket.u, { win: bucket.w });
      if (result !== null) push(bucket.d, result.cost);
    }
  }
  return dailyCost;
}

/**
 * 按日费用（严格逐步口径，任务 3.2 产物组装出口）：由逐会话计价产物
 * （priceArtifactOf 单遍重放的 dailyCost 桶）组装，与两遍对照实现
 * priceDailyCostTwoPass 逐值相等；未变化的会话直接命中产物缓存。
 * 步级语义（fix-step-level-cost）：未定价步跳过（不计入该日）。
 * @param cache - 逐会话计价产物缓存（缺省临时缓存）；tableVersion - 价目版本。
 * @param excludeIds - Set<会话id> 排除集（fork 副本）：分支继承父会话全部历史
 *   消耗，不排除会把重复计价摊进按日费用，令单日费用超出总费用（用户反馈）——
 *   与 KPI / aggregateLedgerViews 的 fork 排除口径对齐。
 * @returns Map<day, {cost, currency}>。
 */
export function priceDailyCost(ledger, table, cache = null, tableVersion = 0, excludeIds = null) {
  const effectiveCache = cache instanceof Map ? cache : new Map();
  const dailyCost = new Map();
  const displayCurrency = displayCurrencyOf(table);
  for (const sid of Object.keys(ledger.sessions)) {
    if (excludeIds !== null && excludeIds !== void 0 && excludeIds.has(sid)) continue;
    const artifact = priceArtifactOf(ledger, sid, table, effectiveCache, tableVersion);
    for (const [day, cost] of artifact.dailyCost) {
      const current = dailyCost.get(day) ?? { cost: 0, currency: displayCurrency };
      current.cost += cost;
      dailyCost.set(day, current);
    }
  }
  return dailyCost;
}

/** timeMultiplier 的再导出（老化窗口命中的 multiplier 在计价时由 bucketSetCost 按当前表重查）。 */
export { timeMultiplier };
