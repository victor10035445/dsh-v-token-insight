/**
 * dsh-v-token-insight — Tier 1：本地逐步账本（纯函数 + storage 注入，node 可单测）。
 *
 * 语义（token-stats-overview 规格「本地账本」）：
 *  - 键 (sessionId, turn, step) → {provider, model, 四桶, 发生时刻}；
 *    持久化 localStorage `dsh-v-token-insight.ledger.v1`，损坏回退空账本；
 *  - 沉淀：会话页签/chip 的 foldTurns+join 结果按 (turn, step) 幂等 upsert
 *    （last-wins，天然覆盖重试取终值）；
 *  - 深度补全：按会话 opt-in 经 session.history 离线折算（stats-fold 的
 *    foldHistoryEvents），记录覆盖 seq 区间，达预算上限如实标注部分覆盖；
 *  - 费用：仅账本覆盖段按 token-pricing 逐步语义计费（绝不「总量 × 单价」）；
 *    原始条目走 priceTurnRows（档位/币种守卫齐全）；老化桶按 defaultTier +
 *    折扣窗口命中计费（L3 时段折扣语义保留；L2 上下文/累计分档在老化后不可
 *    恢复——原始条目保留窗口内仍逐步精确）；
 *  - 压缩老化：陈旧步卷为「日（本地时区） × 模型 × 折扣窗口命中」聚合桶；
 *    窗口命中在老化时按当前价目表判定，桶记录命中窗口 {from,to}，
 *    计价时按当前表同窗口重查 multiplier（价目编辑后的既有「随价目漂移」语义）；
 *  - 孤儿 GC：已从会话列表消失的会话，宽限期后清理；提供手动清除。
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

/** localStorage 键（v1）。 */
export const LEDGER_STORE_KEY = "dsh-v-token-insight.ledger.v1";

/** 原始条目保留天数（超过卷为聚合桶）。 */
export const LEDGER_RAW_RETENTION_DAYS = 60;
/** 老化兜底（配额失败后的二次保存用）保留天数。 */
export const LEDGER_RAW_RETENTION_DAYS_TIGHT = 14;
/** 孤儿宽限期天数（会话从列表消失后保留多久）。 */
export const LEDGER_ORPHAN_GRACE_DAYS = 14;

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

function sanitizeEntry(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  if (typeof raw.k !== "string" || !/^-?\d+:-?\d+$/.test(raw.k)) return null;
  const u = sanitizeBuckets(raw.u);
  if (isEmptyBuckets(u)) return null; /* 空步不记账 */
  const t = Number(raw.t);
  if (!Number.isFinite(t)) return null;
  return {
    k: raw.k,
    p: typeof raw.p === "string" ? raw.p : "",
    m: typeof raw.m === "string" ? raw.m : "",
    u,
    t,
    st: Number.isFinite(Number(raw.st)) ? Number(raw.st) : null
  };
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

function sanitizeSession(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  const entries = (Array.isArray(raw.entries) ? raw.entries : [])
    .map(sanitizeEntry)
    .filter((entry) => entry !== null);
  const buckets = (Array.isArray(raw.buckets) ? raw.buckets : [])
    .map(sanitizeBucket)
    .filter((bucket) => bucket !== null);
  const lastSeen = Number(raw.lastSeen);
  return {
    lastSeen: Number.isFinite(lastSeen) ? lastSeen : 0,
    coverage: sanitizeCoverage(raw.coverage),
    entries,
    buckets
  };
}

/**
 * 读取账本；缺省/损坏/非法一律回退空账本，不抛错。
 * @param storage - 注入的存储面（浏览器传 localStorage；node 测试传 fake）。
 */
export function loadLedger(storage) {
  try {
    const raw = storage?.getItem?.(LEDGER_STORE_KEY);
    if (typeof raw === "string" && raw !== "") {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && parsed.v === 1 && typeof parsed.sessions === "object" && parsed.sessions !== null) {
        const sessions = {};
        for (const [sid, rawSession] of Object.entries(parsed.sessions)) {
          const session = sanitizeSession(rawSession);
          if (session !== null && (session.entries.length > 0 || session.buckets.length > 0 || session.lastSeen > 0)) {
            sessions[sid] = session;
          }
        }
        return { v: 1, sessions };
      }
    }
  } catch {
    /* 损坏即回退空账本（规格：不抛错、不阻塞渲染） */
  }
  return emptyLedger();
}

/** 空账本。 */
export function emptyLedger() {
  return { v: 1, sessions: {} };
}

/**
 * 写入账本。
 * @returns 是否写入成功（存储不可用/配额失败返回 false）。
 */
export function saveLedger(storage, ledger) {
  if (typeof ledger !== "object" || ledger === null || ledger.v !== 1) return false;
  try {
    storage?.setItem?.(LEDGER_STORE_KEY, JSON.stringify(ledger));
    return true;
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
 * @param options.windowFull - 该次沉淀的窗口是否已覆盖全会话（快照 hasMore 取反）；
 *   多次沉淀按 AND 合并（曾见过不完整即保守标注部分覆盖）；传 null 表示本次
 *   沉淀不携带窗口完备性信息（如 chip 的单轮沉淀），不改动既有标注。
 * @param options.nowMs - lastSeen 时间戳。
 * @returns 本次实际新增/更新的步数（0 = 无变化，调用方可跳过保存）。
 */
export function upsertSessionEntries(ledger, sessionId, rows, { windowFull = true, nowMs } = {}) {
  const session = sessionOf(ledger, sessionId, nowMs);
  const byKey = new Map(session.entries.map((entry) => [entry.k, entry]));
  let changed = 0;
  for (const row of rows ?? []) {
    if (typeof row?.turn !== "number") continue;
    for (const step of row.steps ?? []) {
      if (typeof step?.step !== "number" || !step.usage) continue;
      const buckets = {
        inputTokens: step.usage.inputTokens ?? 0,
        cacheReadTokens: step.usage.cacheReadTokens ?? 0,
        cacheWriteTokens: step.usage.cacheWriteTokens ?? 0,
        outputTokens: step.usage.outputTokens ?? 0
      };
      if (isEmptyBuckets(buckets)) continue;
      const key = `${row.turn}:${step.step}`;
      const entry = {
        k: key,
        p: step.provider ?? "",
        m: step.model ?? "",
        u: buckets,
        t: Number.isFinite(step.time) ? step.time : 0,
        st: Number.isFinite(step.startTime) ? step.startTime : null
      };
      const prev = byKey.get(key);
      /* last-wins：同键覆盖（重试取终值语义）；完全相同不计变更。 */
      if (prev !== void 0 && JSON.stringify(prev) === JSON.stringify(entry)) continue;
      byKey.set(key, entry);
      changed += 1;
    }
  }
  session.entries = [...byKey.values()].sort(compareEntryKeys);
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
 *  - 会话已不在 activeIds 且 lastSeen 超出宽限期 → 整会话清理。
 * @param table - 当前价目表（窗口命中判定用；可缺省 = 无窗口判定）。
 * @returns {collapsed, gcSessions} 变更计数。
 */
export function ageLedger(ledger, { nowMs, table = null, rawRetentionDays = LEDGER_RAW_RETENTION_DAYS, orphanGraceDays = LEDGER_ORPHAN_GRACE_DAYS, activeIds = [] } = {}) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const retentionMs = rawRetentionDays * 86_400_000;
  const graceMs = orphanGraceDays * 86_400_000;
  const active = activeIds instanceof Set ? activeIds : new Set(activeIds);
  let collapsed = 0;
  let gcSessions = 0;
  for (const [sid, session] of Object.entries(ledger.sessions)) {
    /* 孤儿 GC：不在当前列表且宽限期已过。 */
    if (!active.has(sid) && now - session.lastSeen > graceMs) {
      delete ledger.sessions[sid];
      gcSessions += 1;
      continue;
    }
    const keep = [];
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
    }
    session.entries = keep.sort(compareEntryKeys);
    session.buckets = session.buckets.filter((bucket) => bucket.n > 0 || !isEmptyBuckets(bucket.u));
  }
  return { collapsed, gcSessions };
}

function sameWin(a, b) {
  if (a === b) return true;
  if (a === void 0 || a === null || b === void 0 || b === null) return false;
  return a.from === b.from && a.to === b.to;
}

/** 手动清除一个会话的账本。 */
export function clearSessionLedger(ledger, sessionId) {
  if (ledger.sessions[sessionId] !== void 0) {
    delete ledger.sessions[sessionId];
    return true;
  }
  return false;
}

/** 手动清空账本（就地清空，保留对象引用）。 */
export function clearAllLedger(ledger) {
  ledger.sessions = {};
}

/**
 * 持久化（配额失败自动收紧老化后重试一次；宽限期不变，只收紧原始条目保留）。
 * @returns {ok, aged} ok=false 表示两次都失败（内存仍可用，UI 提示）。
 */
export function persistLedger(storage, ledger, { nowMs, table = null, activeIds = [] } = {}) {
  if (saveLedger(storage, ledger)) return { ok: true, aged: false };
  ageLedger(ledger, { nowMs, table, rawRetentionDays: LEDGER_RAW_RETENTION_DAYS_TIGHT, activeIds });
  return { ok: saveLedger(storage, ledger), aged: true };
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
 * @returns { covered, cost|null, currency, unmatched[], coverage }；
 *   cost=null 表示存在未定价部分（「—」+ 口径说明），完全无覆盖 covered=false。
 */
export function priceLedgerSession(ledger, sessionId, table) {
  const session = ledger.sessions[sessionId];
  if (session === void 0 || (session.entries.length === 0 && session.buckets.length === 0)) {
    return { covered: false, cost: null, currency: null, unmatched: [], coverage: session?.coverage ?? {} };
  }
  const unmatched = new Map();
  let allPriced = true;
  let cost = 0;
  /* 1) 原始条目：按轮合成行（priceTurnRows 的累计分档键在时间序内递推）。 */
  const priced = priceTurnRows(rowsOfEntries(session.entries), table);
  for (const row of priced) {
    if (row.cost === null) {
      allPriced = false;
      for (const reason of row.unmatched) unmatched.set(reason, true);
    } else {
      cost += row.cost;
    }
  }
  /* 2) 老化桶。 */
  const displayCurrency = displayCurrencyOf(table);
  for (const bucket of session.buckets) {
    const entry = matchPriceEntry(table, bucket.m, bucket.p);
    if (!entry) {
      allPriced = false;
      unmatched.set(`${bucket.m || "?"}:无价目`, true);
      continue;
    }
    if (entry.currency !== displayCurrency) {
      allPriced = false;
      unmatched.set(`${bucket.m || "?"}:币种不符(${entry.currency})`, true);
      continue;
    }
    const result = bucketSetCost(entry, bucket.u, { win: bucket.w });
    if (result === null) {
      allPriced = false;
      unmatched.set(`${bucket.m || "?"}:无价目`, true);
      continue;
    }
    cost += result.cost;
  }
  return {
    covered: true,
    cost: allPriced ? cost : null,
    currency: displayCurrency,
    unmatched: [...unmatched.keys()],
    coverage: session.coverage
  };
}

/** 覆盖是否为部分覆盖（窗口未满载 / 深补截断）。 */
export function isPartialCoverage(coverage) {
  if (typeof coverage !== "object" || coverage === null) return false;
  return coverage.windowFull === false || coverage.deepTruncated === true;
}

function coveredBucketsOf(ledger, sessionId) {
  const covered = emptyBuckets();
  const session = ledger.sessions[sessionId];
  if (session === void 0) return covered;
  for (const entry of session.entries) for (const field of BUCKET_FIELDS) covered[field] += entry.u[field] ?? 0;
  for (const bucket of session.buckets) for (const field of BUCKET_FIELDS) covered[field] += bucket.u[field] ?? 0;
  return covered;
}

/**
 * 总览视图一次性聚合（按模型 / 按时间 token 桶 / 逐会话费用）。
 * 费用线（按日）请用 priceDailyCost（严格逐步口径）。
 * @param ledger - 账本。
 * @param table - 当前价目表。
 * @param expanded - rows-aggregate.expandRows 产物（Tier 0 行，供「未分类」余量）。
 * @returns {
 *   bySession: Map<sid, priceLedgerSession 结果>,
 *   byModel:   [{model, provider, buckets, total, currency, unmatched}],
 *   daily:     Map<day, {buckets}>（按步发生时刻，账本覆盖段）,
 *   coveredIds: Set<sid>,
 *   anyCovered: boolean
 * }
 */
export function aggregateLedgerViews(ledger, table, expanded) {
  const bySession = new Map();
  const modelMap = new Map();
  const daily = new Map();
  const coveredIds = new Set();
  const accumulateDay = (ms, buckets) => {
    const day = dayKeyOf(ms);
    if (day === null) return;
    let bucket = daily.get(day);
    if (bucket === void 0) {
      bucket = { buckets: emptyBuckets() };
      daily.set(day, bucket);
    }
    for (const field of BUCKET_FIELDS) bucket.buckets[field] += buckets[field] ?? 0;
  };
  for (const sid of Object.keys(ledger.sessions)) {
    const priced = priceLedgerSession(ledger, sid, table);
    bySession.set(sid, priced);
    if (!priced.covered) continue;
    coveredIds.add(sid);
    const session = ledger.sessions[sid];
    for (const entry of session.entries) {
      let row = modelMap.get(entry.m);
      if (row === void 0) {
        row = { model: entry.m, provider: entry.p, buckets: emptyBuckets(), currency: priced.currency, unmatched: [...priced.unmatched] };
        modelMap.set(entry.m, row);
      }
      for (const field of BUCKET_FIELDS) row.buckets[field] += entry.u[field] ?? 0;
      accumulateDay(entry.st ?? entry.t, entry.u);
    }
    for (const bucket of session.buckets) {
      let row = modelMap.get(bucket.m);
      if (row === void 0) {
        row = { model: bucket.m, provider: bucket.p, buckets: emptyBuckets(), currency: priced.currency, unmatched: [...priced.unmatched] };
        modelMap.set(bucket.m, row);
      }
      for (const field of BUCKET_FIELDS) row.buckets[field] += bucket.u[field] ?? 0;
    }
  }
  /* 「未分类」余量：逐会话 Tier0 总量 − 账本覆盖量（逐桶，负值截 0）。 */
  const uncovered = emptyBuckets();
  for (const item of expanded ?? []) {
    const covered = coveredBucketsOf(ledger, item.id);
    const usage = item.usage ?? emptyBuckets();
    for (const field of BUCKET_FIELDS) {
      uncovered[field] += Math.max(0, (usage[field] ?? 0) - (covered[field] ?? 0));
    }
  }
  const byModel = [...modelMap.values()].map((row) => ({
    ...row,
    total: row.buckets.inputTokens + row.buckets.cacheReadTokens + row.buckets.cacheWriteTokens + row.buckets.outputTokens
  }));
  if (!isEmptyBuckets(uncovered)) {
    byModel.push({
      model: null,
      provider: "",
      buckets: uncovered,
      total: BUCKET_FIELDS.reduce((sum, field) => sum + uncovered[field], 0),
      currency: displayCurrencyOf(table),
      unmatched: []
    });
  }
  byModel.sort((a, b) => b.total - a.total);
  return { bySession, byModel, daily, coveredIds, anyCovered: coveredIds.size > 0 };
}

/**
 * 按日费用（严格逐步口径）：对每个覆盖会话重放逐步计费，把每步费用归入
 * 该步发生时刻的日桶；老化桶按桶日归入（bucketSetCost）。
 * 未定价（matched 但 cost=null）的会话整体不计入日费用线（口径：费用线只含
 * 已定价覆盖段），由调用方以脚注说明。
 * @returns Map<day, {cost, currency}>。
 */
export function priceDailyCost(ledger, table) {
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
    let priced = true;
    for (const row of rowsOfEntries(session.entries)) {
      row.steps.sort((a, b) => a.step - b.step);
      for (const step of row.steps) {
        const entry = matchPriceEntry(table, step.model ?? "", step.provider ?? "");
        if (!entry || entry.currency !== displayCurrency) {
          priced = false;
          break;
        }
        const key = step.model ?? "";
        const total = cumulative.get(key) ?? 0;
        cumulative.set(key, total + promptTokens(step.usage) + (step.usage.outputTokens ?? 0));
        const tier = resolveTier(entry, { contextTokens: promptTokens(step.usage), cumulativeTokens: total });
        const result = stepCost(entry, step.usage, { time: step.startTime ?? step.time, cumulativeTokens: total });
        if (tier === null || result === null) {
          priced = false;
          break;
        }
        stepCosts.push({ day: dayKeyOf(step.startTime ?? step.time), cost: result.cost });
      }
      if (!priced) break;
    }
    if (!priced) continue;
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

/** timeMultiplier 的再导出（老化窗口命中的 multiplier 在计价时由 bucketSetCost 按当前表重查）。 */
export { timeMultiplier };
