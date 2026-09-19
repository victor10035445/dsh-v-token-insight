/**
 * dsh-v-token-insight — Tier 0：sessions 列表行聚合（纯函数、零依赖，node 可单测）。
 *
 * 输入三快照（均来自宿主标准 props / 服务，零内核改动）：
 *  - rows：useSessions((s) => s.ids.map((id) => s.byId[id])) 的列表行。行形状
 *    （dsh-client-runtime projectList 实装核对）：
 *      { id, displayTitle, title?, cwd?, parentId?, origin? ("subagent"),
 *        running, blank, completed?, updatedAt, projectionValues? }
 *    其中 projectionValues.tokenUsage = { uncachedInputTokens, outputTokens,
 *    cacheReadTokens, cacheWriteTokens }（宿主 dsh-token-meter 投影，权威）。
 *  - workspaces：useWorkspaces((s) => s) 快照（{ items, archivedSessionIds }）。
 *  - 语义（token-stats-overview 规格）：
 *      · blank 空会话不入计数、不在明细表成行；
 *      · 归档会话照常计入与成行（archivedSessionIds 交集）；
 *      · 行投影缺席按零计入，全部缺席 KPI 显示「—」（调用方据 hasAnyUsage 判断）；
 *      · 子会话（parentId 或 origin==="subagent"）独立成行，不混计父行；
 *        cwd 缺失时按工作区归组回退父会话 cwd，仍无归「未知」。
 *  - 输出全部是纯数据（KPI / 工作区归组 / 会话明细 / 时间分桶），渲染层只做展示。
 */

const emptyBuckets = () => ({
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0
});

function addBuckets(totals, usage) {
  totals.inputTokens += usage.inputTokens ?? 0;
  totals.cacheReadTokens += usage.cacheReadTokens ?? 0;
  totals.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
  totals.outputTokens += usage.outputTokens ?? 0;
}

/** 投影 tokenUsage → 桶记法（未命中输入字段双形状兼容：uncachedInputTokens / inputTokens）。 */
export function bucketsOfProjection(usage) {
  if (typeof usage !== "object" || usage === null) return null;
  return {
    inputTokens: usage.uncachedInputTokens ?? usage.inputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0
  };
}

/** 计费输入 = 三桶输入之和（桶互斥）。 */
export function billedIn(buckets) {
  return (buckets?.inputTokens ?? 0) + (buckets?.cacheReadTokens ?? 0) + (buckets?.cacheWriteTokens ?? 0);
}

/** 四桶总量。 */
export function totalTokens(buckets) {
  return billedIn(buckets) + (buckets?.outputTokens ?? 0);
}

/** 缓存命中率（0-100 数字或 null：无输入返回 null）。 */
export function hitPercent(buckets) {
  const billed = billedIn(buckets);
  return billed > 0 ? ((buckets.cacheReadTokens ?? 0) / billed) * 100 : null;
}

/** cwd 的显示项目名：目录 basename（尾部分隔符归一）。 */
export function projectNameOf(cwd) {
  if (typeof cwd !== "string" || cwd === "") return null;
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const base = trimmed.split(/[\\/]/).pop();
  return base || trimmed;
}

function blankRow(row) {
  return row?.blank === true;
}

function subagentRow(row) {
  return row?.origin === "subagent" || typeof row?.parentId === "string";
}

/**
 * 按行展开聚合输入：blank 排除、四桶解析、深度计算（parentId 链）、
 * 工作区归组键（子会话 cwd 缺失回退父会话 cwd）。
 * @param rows - useSessions 列表行。
 * @param fallbackBuckets - 投影缺席时的账本四桶兜底（Map<sessionId, 四桶>，可缺省；
 *   仅在列表行完全未携带 tokenUsage 时启用，投影在场（含真零）一律以投影为准）。
 * @returns 与可用行平行的展开行数组（原始行 + 解析字段 + usageSource 口径标记）。
 */
export function expandRows(rows, fallbackBuckets = null) {
  const list = (rows ?? []).filter((row) => typeof row?.id === "string" && !blankRow(row));
  const byId = new Map(list.map((row) => [row.id, row]));
  const depthCache = new Map();
  const depthOf = (row) => {
    const path = [];
    let current = row;
    let depth = 0;
    while (current !== void 0) {
      if (depthCache.has(current.id)) {
        depth += depthCache.get(current.id);
        break;
      }
      if (path.includes(current.id)) break; /* 防线：异常 lineage 环 */
      path.push(current.id);
      const parent = typeof current.parentId === "string" ? byId.get(current.parentId) : void 0;
      if (parent === void 0) break;
      current = parent;
      depth += 1;
    }
    for (const id of path) depthCache.set(id, depth);
    return depth;
  };
  return list.map((row) => {
    const projectionUsage = bucketsOfProjection(row.projectionValues?.tokenUsage);
    /* 投影缺席（宿主列表行未携带，如升级后投影检查点版本门槛）→ 回退账本覆盖段
       四桶（usageSource="ledger"，与「未分类」余量公式天然自洽：账本−账本=0）。 */
    const fallbackUsage = projectionUsage === null && fallbackBuckets !== null ? fallbackBuckets.get(row.id) ?? null : null;
    const usage = projectionUsage ?? fallbackUsage;
    const isSub = subagentRow(row);
    const parent = typeof row.parentId === "string" ? byId.get(row.parentId) : void 0;
    /* 分支会话（fix: fork 去重）：有 parentId 但不是 subagent 委派子会话 = 用户 fork 的
       分支副本。fork 日志通过 seed 原样复制父会话的全部事件（含 usage），其投影与
       父会话重复计数，聚合时 MUST 排除（badge 单独标注，行保留可查）。 */
    const isFork = isSub && row.origin !== "subagent";
    /* 按工作区归组键：自身 cwd → 父会话 cwd → 未知。 */
    const cwd = typeof row.cwd === "string" && row.cwd !== "" ? row.cwd : typeof parent?.cwd === "string" && parent.cwd !== "" ? parent.cwd : null;
    return {
      row,
      id: row.id,
      title: typeof row.title === "string" && row.title !== "" ? row.title : row.displayTitle ?? row.id,
      cwd,
      groupName: cwd === null ? null : projectNameOf(cwd),
      running: row.running === true,
      completed: row.completed === true,
      isSub,
      isFork,
      depth: isSub ? depthOf(row) : 0,
      updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : null,
      usage,
      hasUsage: usage !== null,
      usageSource: projectionUsage !== null ? "projection" : fallbackUsage !== null ? "ledger" : "none"
    };
  });
}

/** 空的 KPI 结构（全部缺席语义）。 */
const emptyKpi = () => ({
  hasAnyUsage: false,
  buckets: emptyBuckets(),
  billedTotal: 0,
  billedIn: 0,
  output: 0,
  cacheHit: null,
  sessions: 0,
  archived: 0,
  running: 0
});

/**
 * 全会话 KPI 合计。
 * @param expanded - expandRows 产物。
 * @param archivedIds - 归档会话 id 集合（数组或 Set）。
 * @param cost - 账本覆盖段费用（{amount, currency} | null），渲染层直接展示。
 */
export function aggregateKpi(expanded, archivedIds, cost = null) {
  const archived = archivedIds instanceof Set ? archivedIds : new Set(archivedIds ?? []);
  const kpi = emptyKpi();
  for (const item of expanded) {
    if (item.usage !== null) {
      if (!item.isFork) {
        /* 分支会话的投影是其父会话消耗的副本（seed 复制），不计入 KPI 合计。 */
        addBuckets(kpi.buckets, item.usage);
        kpi.hasAnyUsage = true;
      }
    }
    kpi.sessions += 1;
    if (archived.has(item.id)) kpi.archived += 1;
    if (item.running) kpi.running += 1;
  }
  kpi.billedTotal = totalTokens(kpi.buckets);
  kpi.billedIn = billedIn(kpi.buckets);
  kpi.output = kpi.buckets.outputTokens;
  kpi.cacheHit = hitPercent(kpi.buckets);
  kpi.cost = cost;
  return kpi;
}

/**
 * 按工作区/项目归组（cwd basename 项目名；无 cwd「未知」；子会话回退父 cwd，
 * 已由 expandRows 归一）。按四桶总量降序。
 * 附按工作区费用求和（fix-ledger-attribution 同期的费用列扩展）：
 * `ledgerBySession` 传 `views.bySession`（aggregateLedgerViews 产物）时，逐会话
 * 费用按工作区求和——仅计入已定价会话；账本覆盖但「未定价」的会话如实计数
 * （costUnpriced）并在 UI 披露，绝不跨币种求和（币种取显示币种，账本面已守卫）；
 * 无任何已定价会话时 cost = null（显示「—」）。
 */
export function aggregateWorkspaces(expanded, workspaces, ledgerBySession) {
  const titleByPath = new Map(
    (workspaces?.items ?? [])
      .filter((item) => typeof item?.path === "string")
      .map((item) => [item.path, item.title])
  );
  const groups = new Map();
  for (const item of expanded) {
    /* 分支会话不参与工作区归组合计（其 token 是父会话消耗的副本）。 */
    if (item.isFork) continue;
    const key = item.cwd ?? "";
    let group = groups.get(key);
    if (group === void 0) {
      group = { key, cwd: item.cwd, name: null, buckets: emptyBuckets(), sessions: 0, running: 0, archivedIds: new Set() };
      groups.set(key, group);
    }
    addBuckets(group.buckets, item.usage ?? {});
    group.sessions += 1;
    if (item.running) group.running += 1;
    group.archivedIds.add(item.id);
  }
  const result = [...groups.values()].map((group) => {
    let costSum = 0;
    let costPriced = 0;
    let costUnpriced = 0;
    let currency = null;
    if (ledgerBySession != null) {
      for (const id of group.archivedIds) {
        const priced = ledgerBySession.get?.(id);
        if (!priced?.covered) continue;
        if (priced.cost !== null && Number.isFinite(priced.cost)) {
          costSum += priced.cost;
          costPriced += 1;
          currency = priced.currency ?? currency;
        }
        /* 步级语义：含未定价步的会话（含整体未定价）计数披露，金额口径不变。 */
        if (priced.cost === null || (priced.unmatched?.length ?? 0) > 0) {
          costUnpriced += 1;
        }
      }
    }
    return {
      ...group,
      name: group.cwd === null ? null : titleByPath.get(group.cwd) ?? projectNameOf(group.cwd),
      total: totalTokens(group.buckets),
      cacheHit: hitPercent(group.buckets),
      cost: costPriced > 0 ? costSum : null,
      costPriced,
      costUnpriced,
      currency
    };
  });
  result.sort((a, b) => b.total - a.total);
  return result;
}

/**
 * 按会话明细行（升序输入保持展开顺序，渲染层自行排序/筛选）。
 * 附账本面：cost（null = 无覆盖「—」）、costNote、coverage。
 */
export function aggregateSessions(expanded, archivedIds, ledgerBySession) {
  const archived = archivedIds instanceof Set ? archivedIds : new Set(archivedIds ?? []);
  return expanded.map((item) => {
    const ledger = ledgerBySession?.get?.(item.id) ?? null;
    return {
      ...item,
      archived: archived.has(item.id),
      cacheHit: hitPercent(item.usage),
      total: item.usage === null ? 0 : totalTokens(item.usage),
      cost: ledger?.cost ?? null,
      currency: ledger?.currency ?? null,
      unmatched: ledger?.unmatched ?? [],
      covered: ledger !== null,
      coverage: ledger?.coverage ?? null
    };
  });
}

/** 日键 → 颗粒度桶键：day 原样、month 截 "YYYY-MM"、year 截 "YYYY"；非法日键 null。 */
export function timeKeyOf(dayKey, granularity) {
  if (typeof dayKey !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return null;
  if (granularity === "month") return dayKey.slice(0, 7);
  if (granularity === "year") return dayKey.slice(0, 4);
  return dayKey;
}

/** 桶键的起始时刻（本地时区；day/month/year 三种形状；非法 NaN）。 */
function timeKeyStartMs(key) {
  if (typeof key !== "string") return Number.NaN;
  if (/^\d{4}$/.test(key)) return Date.parse(`${key}-01-01T00:00:00`);
  if (/^\d{4}-\d{2}$/.test(key)) return Date.parse(`${key}-01T00:00:00`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return Date.parse(`${key}T00:00:00`);
  return Number.NaN;
}

/**
 * 颗粒度窗口下限（早于该时刻的桶归「更早」）：
 *  - day：近 days 天（默认 30）；
 *  - month：近 months 个自然月（含当月，默认 12，按当月 1 日 0 点回退）；
 *  - year：不限（-Infinity，永不归「更早」）。
 */
function timeCutoffMs(granularity, { days = 30, months = 12 } = {}) {
  if (granularity === "year") return Number.NEGATIVE_INFINITY;
  const now = Date.now();
  if (granularity === "month") {
    const first = new Date(now);
    first.setDate(1);
    first.setHours(0, 0, 0, 0);
    first.setMonth(first.getMonth() - (Math.max(1, months) - 1));
    return first.getTime();
  }
  return now - days * 86_400_000;
}

/**
 * 按时间分桶（双口径 × 颗粒度）：
 *  - 账本覆盖段：按步发生时刻（调用方传入 ledgerDaily：日 → {buckets, cost?}）；
 *  - 未覆盖段：按会话最近活动（updatedAt）整桶计入，标注「按最近活动」；
 *  - granularity：day（默认）/ month / year——日键归并为月键/年键后分桶；
 *  - 窗口：day 近 30 天、month 近 12 个自然月、year 不限，超出归「更早」桶。
 * @param expanded - expandRows 产物。
 * @param ledgerDaily - Map<"YYYY-MM-DD", {buckets, byModel}>（账本按步时刻聚合，可缺省）。
 * @param coveredIds - 账本覆盖的会话 id 集合（这些会话不再按 updatedAt 计入）。
 * @param options.granularity - "day" | "month" | "year"（默认 day，即既有行为）。
 * @param options.days - day 颗粒度保留天数（默认 30，更早归「更早」桶）。
 * @param options.months - month 颗粒度保留月数（默认 12，更早归「更早」桶）。
 * @param options.maxBuckets - 时间桶数上限（用户反馈：x 轴至多 30 条，不含「更早」
 *   聚合约；不足上限全量显示，超限的最旧桶并入「更早」——年档不限窗时截断；
 *   缺省 null 不设限，即既有行为）。
 * @param options.remainders - Map<sid, 四桶>（fix-partial-coverage 1.2：已覆盖会话的
 *   未覆盖余量，computeTrendRemainders 产物——投影 − 已按日入柱，逐桶截零、全零
 *   不入）。covered 行不再整行跳过：有非零余量时按 updatedAt 整桶并入、sources 记
 *   "recent"（与未覆盖会话共用「按最近活动」徽标与 mixed 判定）；updatedAt ===
 *   null 与 fork 行照旧跳过；未覆盖会话既有整桶路径不变。余量只进 token 柱，
 *   费用线不因余量变化（费用仅在账本覆盖段显示）。缺省 null = 既有行为。
 */
export function aggregateByTime(expanded, ledgerDaily, coveredIds, { days = 30, months = 12, granularity = "day", maxBuckets = null, remainders = null } = {}) {
  const covered = coveredIds instanceof Set ? coveredIds : new Set(coveredIds ?? []);
  const remainderMap = remainders instanceof Map ? remainders : null;
  const byKey = new Map();
  const bucketFor = (key) => {
    let bucket = byKey.get(key);
    if (bucket === void 0) {
      bucket = { buckets: emptyBuckets(), sources: new Set() };
      byKey.set(key, bucket);
    }
    return bucket;
  };
  for (const [day, bucket] of ledgerDaily ?? []) {
    const key = timeKeyOf(day, granularity);
    if (key === null) continue;
    const target = bucketFor(key);
    addBuckets(target.buckets, bucket.buckets ?? {});
    target.sources.add("ledger");
  }
  for (const item of expanded) {
    if (item.isFork) continue; /* 分支会话的副本消耗不进时间分桶（余量亦然） */
    if (covered.has(item.id)) {
      /* 部分覆盖余量归并（fix-partial-coverage D1）：覆盖段已按步入柱（ledgerDaily），
         未覆盖余量没有逐步时刻，本质是会话级整桶——与「未覆盖会话压 updatedAt」
         同语义，按 updatedAt 整桶并入。余量全零不入（computeTrendRemainders 已
         截零过滤，这里再守一道）；updatedAt 缺失无处落桶，照旧跳过。 */
      if (remainderMap === null || item.updatedAt === null) continue;
      const remainder = remainderMap.get(item.id);
      if (remainder === void 0 || totalTokens(remainder) <= 0) continue;
      const key = timeKeyOf(dayKeyOf(item.updatedAt), granularity);
      if (key === null) continue;
      const target = bucketFor(key);
      addBuckets(target.buckets, remainder);
      target.sources.add("recent");
      continue;
    }
    if (item.updatedAt === null) continue;
    const key = timeKeyOf(dayKeyOf(item.updatedAt), granularity);
    if (key === null) continue;
    const target = bucketFor(key);
    addBuckets(target.buckets, item.usage ?? {});
    target.sources.add("recent");
  }
  const cutoff = timeCutoffMs(granularity, { days, months });
  const older = { buckets: emptyBuckets(), sources: new Set() };
  const sourceLabel = (sources) => (sources.size > 1 ? "mixed" : [...sources][0] ?? "recent");
  const rest = [];
  for (const [key, bucket] of byKey) {
    const ts = timeKeyStartMs(key);
    if (Number.isFinite(ts) && ts < cutoff) {
      addBuckets(older.buckets, bucket.buckets);
      for (const source of bucket.sources) older.sources.add(source);
    } else {
      rest.push({ day: key, buckets: { ...bucket.buckets }, total: totalTokens(bucket.buckets), source: sourceLabel(bucket.sources) });
    }
  }
  rest.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  /* 桶数上限（用户反馈）：x 轴时间桶至多 maxBuckets 个（「更早」聚合约不计入），
     超限的最旧桶并入「更早」；不足上限全量显示。日(近30天)/月(近12月) 天然在
     限内，年档不限窗时截断。folded 行的 source 标签还原回原始源集合再统一取标签。 */
  if (maxBuckets != null && rest.length > maxBuckets) {
    for (const row of rest.splice(0, rest.length - maxBuckets)) {
      addBuckets(older.buckets, row.buckets);
      if (row.source === "mixed") {
        older.sources.add("ledger");
        older.sources.add("recent");
      } else {
        older.sources.add(row.source);
      }
    }
  }
  if (totalTokens(older.buckets) > 0) {
    rest.unshift({ day: "older", buckets: { ...older.buckets }, total: totalTokens(older.buckets), source: sourceLabel(older.sources) });
  }
  return rest;
}

/**
 * 趋势余量（fix-partial-coverage 1.3，纯函数，node 可单测）：已覆盖会话的
 * 「未按日入柱」余量。余量 = 行投影逐桶 − dailyBucketsBySession（已按日入柱量，
 * aggregateLedgerViews 产物）——基线取已按日入柱而非 coveredBuckets（D2 审阅修订）：
 * 压缩老化桶未按日入柱，取 coveredBuckets 会令老化段继续消失、恒等式对含老化
 * 账本为假；取已按日入柱基后老化段经余量按最近活动重新入柱，趋势恒等无条件成立。
 *  - 逐桶 max(0, ·) 截零（投影滞后于账本时不虚报负量）、四桶全零不入；
 *  - fork 行排除（其投影本就全量排除，余量亦然）；
 *  - 无键会话（从未覆盖 / 空键）不产生余量——其整桶走 aggregateByTime 既有
 *    updatedAt 路径，覆盖段 / 部分覆盖 / 未覆盖三路径互斥不重复计；
 *  - 投影缺席回退（usageSource="ledger"）的行同样可算：usage 基线即账本覆盖段，
 *    余量 = 老化桶段，趋势恒等在回退人群内成立（D3 豁免 ②）；
 *  - usage === null（投影与兜底均缺席）无从取基，跳过。
 * @param expanded - expandRows 产物。
 * @param dailyBucketsBySession - aggregateLedgerViews 产物（Map<sid, 四桶>）。
 * @returns Map<sid, 四桶>（仅含非零余量会话）。
 */
export function computeTrendRemainders(expanded, dailyBucketsBySession) {
  const remainders = new Map();
  if (!(dailyBucketsBySession instanceof Map)) return remainders;
  for (const item of expanded ?? []) {
    if (item.isFork) continue; /* fork 副本不参与时间分桶，余量亦然 */
    const daily = dailyBucketsBySession.get(item.id);
    if (daily === void 0) continue; /* 未覆盖（无键）走既有整桶路径 */
    if (item.usage === null) continue; /* 投影与兜底均缺席：无基线可算 */
    const remainder = emptyBuckets();
    addBuckets(remainder, item.usage);
    let any = false;
    for (const field of ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"]) {
      remainder[field] = Math.max(0, remainder[field] - (daily[field] ?? 0));
      if (remainder[field] > 0) any = true;
    }
    if (any) remainders.set(item.id, remainder);
  }
  return remainders;
}

/**
 * 费用点按颗粒度归并（按时间页签费用线）：输入按日点 [{day:"YYYY-MM-DD", cost}]，
 * 归并为 [{day: 桶键, cost}] 升序（month/year 内求和）；day 颗粒度原样拷贝透传。
 * month 颗粒度沿用同一 12 个自然月窗口：超窗日点不入线（与按日口径一致——
 * 费用线不画「更早」点）；year 颗粒度无窗口，全部年份保留。
 */
export function groupCostByGranularity(points, granularity, { days = 30, months = 12 } = {}) {
  if (granularity !== "month" && granularity !== "year") {
    return [...(points ?? [])].map((point) => ({ ...point }));
  }
  const cutoff = timeCutoffMs(granularity, { days, months });
  const totals = new Map();
  for (const point of points ?? []) {
    const key = timeKeyOf(point?.day, granularity);
    if (key === null) continue;
    const start = timeKeyStartMs(key);
    if (Number.isFinite(start) && start < cutoff) continue;
    totals.set(key, (totals.get(key) ?? 0) + (Number.isFinite(point.cost) ? point.cost : 0));
  }
  return [...totals.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([day, cost]) => ({ day, cost }));
}

/** 本地时区的 YYYY-MM-DD 日键（账期分日以本地时区为准）。 */
export function dayKeyOf(ms) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 按模型视图（账本聚合）：输入账本按模型聚合的条目 + 未覆盖余量。
 * 「未分类」行 = Σ 会话 Tier0 总量 − Σ 账本已覆盖量（逐桶，负值截 0）。
 */
export function aggregateByModel(modelRows, uncoveredBuckets) {
  const rows = [...(modelRows ?? [])].sort((a, b) => b.total - a.total);
  const out = rows.map((row) => ({ ...row }));
  const uncovered = { ...uncoveredBuckets };
  if (totalTokens(uncovered) > 0) {
    out.push({ model: null, buckets: uncovered, total: totalTokens(uncovered), cost: null, avgCost: null, currency: null, unmatched: [] });
  }
  return out;
}

/** 归档可见性守卫：归档集合非空但列表行一个都未携带 → 数据面缺失明示。 */
export function archivedMissingFromList(expanded, archivedIds) {
  const archived = archivedIds instanceof Set ? archivedIds : new Set(archivedIds ?? []);
  if (archived.size === 0) return false;
  return !expanded.some((item) => archived.has(item.id));
}
