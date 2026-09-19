/**
 * dsh-v-token-insight — SVG 图表布局原语（纯函数、零依赖，node 可单测）。
 *
 * 设计约定（探索阶段结论）：
 *  - 手写 SVG，不引入图表库（DSH 自己的 ContextMeter 即手写堆叠条；
 *    Recharts 类库几百 KB，对插件包不友好）；
 *  - 颜色全部走 --dsw-alias-* / --dsw-static-* 令牌，随官方主题与风格插件
 *    联动，禁止硬编码色值（浅色/深色都要可读，对比度 ≥ 4.5:1）；
 *  - 每张图必须提供表格替代（无障碍），颜色不得是唯一信息通道；
 *  - 交互：悬停用 SVG <title>（原生 tooltip，可访问）、条元/点元带数据属性
 *    供点击联动；不做入场动画（prefers-reduced-motion 天然满足）。
 *
 * 本文件只产出「几何 + 文本」的纯布局数据；client.jsx 把布局渲染成 React SVG。
 */

/** 图表用色（官方令牌；模型分布 ≤6 色循环）。浅色/深色均可读的中明度档。 */
export const CHART_COLORS = [
  "var(--dsw-static-blue-500)",
  "var(--dsw-static-green-500)",
  "var(--dsw-static-amber-500)",
  "var(--dsw-static-neutral-bluish-600)",
  "var(--dsw-static-red-400)",
  "var(--dsw-static-deepseek-500)"
];

/** 四桶堆叠段定义（自底向上）：key 对应 usage 字段，label 供图例/表格替代。 */
export const BUCKET_SEGMENTS = [
  { key: "inputTokens", label: "未命中输入", color: "var(--dsw-static-red-400)" },
  { key: "cacheWriteTokens", label: "缓存写", color: "var(--dsw-static-amber-500)" },
  { key: "cacheReadTokens", label: "缓存读", color: "var(--dsw-static-green-500)" },
  { key: "outputTokens", label: "输出", color: "var(--dsw-static-blue-450)" }
];

/**
 * Y 轴取整刻度（用户反馈 #2）：步进取 1/2/5×10^k（不低于 minStep），yMax 向上
 * 取整到步进的整数倍——刻度恒为整数且是步进整数倍（整百/整千），不再出现
 * yMax/3 之类的分数刻度。minStep=1 用于 token（刻度恒为整数）；minStep=0 用于金额。
 */
function niceScale(maxValue, { targetTicks = 4, minStep = 1 } = {}) {
  const value = Math.max(minStep, maxValue > 0 ? maxValue : minStep);
  const rawStep = value / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const norm = rawStep / magnitude;
  const step = Math.max(minStep, (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * magnitude);
  const count = Math.ceil(value / step);
  const yMax = count * step;
  const tickValues = Array.from({ length: count + 1 }, (_, index) => (count - index) * step);
  return { step, yMax, tickValues };
}

/**
 * 每轮四桶堆叠条布局（时间轴）。
 * @param rows - foldTurns 行（升序；读 usage 四桶）。
 * @param options.width/height - 绘图区尺寸（px）。
 * @param options.pad - 内边距 {top,right,bottom,left}。
 * @param options.target - 可选目标参考柱 {key, value}（key = 行键 turn|day，value =
 *   计划值 Token/天，token-stats-plan 消费方；value 非正有限数视为缺席——「未设置」
 *   不是 0，绝不把计划当作 0 参与缩放）。目标值 MUST 参与 Y 轴缩放（与数据同刻度，
 *   否则轮廓柱出界或贴底失真）。
 * @returns { bars, yMax, ticks, xLabels, targetBar }：
 *   bars[i] = { turn, x, y, w, h, total, segments: [{key,label,color,value,y,h}] }；
 *   targetBar = { key, value, x, y, w, h } | null——键匹配行的目标柱几何（x/w 与该
 *   数据柱完全同位同宽，y/h 自基线起算），无匹配行或无有效目标值时为 null；
 *   轮廓（非实心）呈现属渲染侧职责，本函数只产出几何。
 */
export function stackedBarsLayout(rows, { width = 640, height = 150, pad = { top: 8, right: 8, bottom: 20, left: 44 }, target = null } = {}) {
  const list = rows ?? [];
  const innerW = Math.max(10, width - pad.left - pad.right);
  const innerH = Math.max(10, height - pad.top - pad.bottom);
  const totals = list.map((row) => {
    const usage = row?.usage ?? {};
    return (
      (usage.inputTokens ?? 0) +
      (usage.cacheReadTokens ?? 0) +
      (usage.cacheWriteTokens ?? 0) +
      (usage.outputTokens ?? 0)
    );
  });
  /* 目标值有效性门闩：非有限数/非正数一律视为「未设置」（缺席）——计划值契约
     与 plan-store 一致：未设置 ≠ 0。 */
  const targetValue = target !== null && Number.isFinite(target?.value) && target.value > 0 ? target.value : null;
  const scale = niceScale(Math.max(1, ...totals, targetValue ?? 0));
  const yMax = scale.yMax;
  const step = innerW / Math.max(1, list.length);
  const barW = Math.max(2, Math.min(28, step * 0.6));
  const yOf = (value) => pad.top + innerH - (value / yMax) * innerH;
  const bars = list.map((row, index) => {
    const usage = row?.usage ?? {};
    const x = pad.left + index * step + (step - barW) / 2;
    let cursor = pad.top + innerH;
    const segments = [];
    for (const segment of BUCKET_SEGMENTS) {
      const value = usage[segment.key] ?? 0;
      if (value <= 0) continue;
      const h = Math.max(1, (value / yMax) * innerH);
      cursor -= h;
      segments.push({ ...segment, value, y: cursor, h });
    }
    /* 段间 1px 留隙（design D6 / 任务 4.2）：自底向上堆叠，最底段贴基线保持
       满高，其余每段（上方段）自底边削去 1px，在其与下方段之间形成空隙；
       单段不受影响。 */
    for (let i = 1; i < segments.length; i += 1) {
      segments[i] = { ...segments[i], h: Math.max(1, segments[i].h - 1) };
    }
    return { turn: row.turn, x, y: cursor, w: barW, h: pad.top + innerH - cursor, total: totals[index], segments };
  });
  /* Y 轴整刻度（用户反馈 #2）：由 niceScale 生成（1/2/5×10^k 步进，含 0）。 */
  const ticks = scale.tickValues.map((value) => ({ value, y: yOf(value) }));
  /* 目标柱几何（键匹配唯一行；行键 turn|day 双形兼容——总览趋势行经
     dualAxisTrendLayout 归一为 turn，直接调用方传 turn）：与数据柱同 x/w，
     y/h 自基线起算，h 下限 1px 保证极小目标值仍可悬停读取。 */
  let targetBar = null;
  if (targetValue !== null) {
    const index = list.findIndex((row) => (row?.turn ?? row?.day) === target.key);
    if (index >= 0) {
      const bar = bars[index];
      const y = yOf(targetValue);
      targetBar = { key: target.key, value: targetValue, x: bar.x, y, w: bar.w, h: Math.max(1, pad.top + innerH - y) };
    }
  }
  /* 轮次刻度稀疏化（design D6 / 任务 4.4）：每 ⌈n/8⌉ 取一，轴标至多 8 个，
     避免长窗口下刻度拥挤；首刻度恒保留。 */
  const stride = Math.max(1, Math.ceil(list.length / 8));
  const xLabels = [];
  for (let index = 0; index < list.length; index += stride) {
    const row = list[index];
    xLabels.push({
      turn: row.turn,
      x: pad.left + index * step + step / 2,
      y: height - 6
    });
  }
  return { bars, yMax, yStep: scale.step, ticks, xLabels, stride, pad, width, height, targetBar };
}

/**
 * 双轴组合趋势布局（总览页签合并卡）：token 四桶堆叠柱（左轴）+ 费用折线（右轴），
 * 共享同一 x 桶轴。费用点按桶键对齐到柱位中心（取代独立 lineLayout 的按点序号
 * 等距——缺数据日不再产生时间失真）；无已计价费用的桶折线断开（分段路径，
 * 不做跨洞插值）。柱状几何与左轴刻度完全复用 stackedBarsLayout（段间留隙、
 * 刻度稀疏化语义不变）；右轴金额走独立 niceScale（minStep 0），只出刻度文本
 * 不出网格（网格沿用左轴一组，避免双网格打架）。
 * @param rows - 趋势行 [{day, buckets, source}]（"older" 为最左桶，与柱状图同源）；
 *   亦兼容会话页轮行 [{turn, usage}]（rework-kpi-charts D4：行键 day ?? turn 归一，
 *   费用点/柱位对齐与断线语义两形一致）。
 * @param costByKey - Map<桶键, cost>（键必须取自 rows 的行键 day|turn，仅这些键会被读取，
 *   其余键一律忽略——调用方不得把超窗费用合计折入既有桶，否则其合计会撑爆
 *   右轴刻度，令窗口内逐日点全部贴底）。
 * @param options - width/height/pad 同 stackedBarsLayout；pad.right 默认 64，
 *   为右轴金额刻度文本留位。options.target 透传 stackedBarsLayout（今日目标参考
 *   柱 {key, value}，key 须为 rows 的行键 day|turn；缺省 null 不产出目标柱，
 *   总览以外调用方零回归）。
 * @returns stackedBarsLayout 全量产物 + cost 域：{ costDots: [{key,day,turn,cost,x,y}]
 *   （key = day ?? turn 归一行键，供渲染侧 React key；day/turn 保留供悬停 title）,
 *   costPaths: string[]（每连续段一条 M..L.. 路径）, costTicks, costYMax, hasCost }。
 *   无任何已计价费用时 hasCost=false 且 cost 域为空（调用方退化为纯柱状图）。
 */
export function dualAxisTrendLayout(rows, costByKey, { width = 640, height = 150, pad = { top: 8, right: 64, bottom: 20, left: 44 }, target = null } = {}) {
  /* 入参形状归一（回归修复）：总览趋势行是 {day, buckets, source}，而
     stackedBarsLayout 消费 {turn, usage}——此前直接透传导致柱高全零（页面只剩
     折线）。day/turn 与 buckets/usage 双兼容归一后，柱状几何与原四桶图一致。 */
  const list = rows ?? [];
  const base = stackedBarsLayout(
    list.map((row) => ({ turn: row?.turn ?? row?.day, usage: row?.usage ?? row?.buckets ?? {} })),
    { width, height, pad, target }
  );
  const costs = costByKey instanceof Map ? costByKey : new Map(Object.entries(costByKey ?? {}));
  /* 费用路径行键归一（rework-kpi-charts D4 评审修正）：柱路径已双兼容
     （turn: row?.turn ?? row?.day），费用路径此前只认 row?.day——会话行（只有
     turn）恒取 undefined，费用线整条不渲染。rowKey = day ?? turn 与柱键同源。 */
  const rowKeyOf = (row) => row?.day ?? row?.turn;
  const present = list.map((row) => {
    const cost = costs.get(rowKeyOf(row));
    return Number.isFinite(cost) && cost > 0 ? cost : null;
  });
  const hasCost = present.some((cost) => cost !== null);
  if (!hasCost) return { ...base, costDots: [], costPaths: [], costTicks: [], costYMax: 0, costYStep: 0, hasCost: false };
  const innerH = Math.max(10, height - pad.top - pad.bottom);
  const scale = niceScale(Math.max(...present.filter((cost) => cost !== null)), { minStep: 0 });
  const yOf = (cost) => pad.top + innerH - (cost / scale.yMax) * innerH;
  const coords = [];
  const costDots = [];
  list.forEach((row, index) => {
    const cost = present[index];
    if (cost === null) {
      coords.push(null);
      return;
    }
    const bar = base.bars[index];
    const coord = { x: bar.x + bar.w / 2, y: yOf(cost) };
    coords.push(coord);
    /* key = 归一行键（day 形 → 日键 / turn 形 → 轮号）：供渲染侧作 React key；
       day / turn 原样保留（总览悬停 title 用 day，会话页用 turn 出「#N」）。 */
    costDots.push({ key: rowKeyOf(row), day: row?.day, turn: row?.turn, cost, x: coord.x, y: coord.y });
  });
  /* 分段路径：连续有费用桶连成一段，断桶处断开。 */
  const costPaths = [];
  let run = [];
  const flushRun = () => {
    if (run.length > 0) {
      costPaths.push(run.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" "));
      run = [];
    }
  };
  for (const coord of coords) {
    if (coord) run.push(coord);
    else flushRun();
  }
  flushRun();
  const costTicks = scale.tickValues.map((cost) => ({ cost, y: yOf(cost) }));
  return { ...base, costDots, costPaths, costTicks, costYMax: scale.yMax, costYStep: scale.step, hasCost: true };
}

/**
 * 模型分布横向条形布局（降序、≤6 色、带图例）。
 * @param items - [{ label, value }]（调用方按模型聚合 token）。
 * @param options - width / rowHeight / maxBars（默认 6，超出折叠为「其他」）。
 * @returns { rows: [{label, value, color, x, w, index}], maxValue, width }。
 */
export function hBarsLayout(items, { width = 640, rowHeight = 26, maxBars = 6 } = {}) {
  const sorted = [...(items ?? [])].filter((item) => item.value > 0).sort((a, b) => b.value - a.value);
  let list = sorted.slice(0, maxBars);
  if (sorted.length > maxBars) {
    const rest = sorted.slice(maxBars).reduce((sum, item) => sum + item.value, 0);
    if (rest > 0) list = [...list, { label: "其他", value: rest }];
  }
  const maxValue = Math.max(1, ...list.map((item) => item.value));
  const labelWidth = 130;
  const valueWidth = 56;
  const trackW = Math.max(20, width - labelWidth - valueWidth);
  return {
    maxValue,
    width,
    rowHeight,
    rows: list.map((item, index) => ({
      ...item,
      color: CHART_COLORS[index % CHART_COLORS.length],
      x: labelWidth,
      w: Math.max(2, (item.value / maxValue) * trackW),
      trackW,
      valueX: labelWidth + trackW + 8
    }))
  };
}

/**
 * 累计费用折线布局（按轮；只含已定价轮，未定价轮跳过并在图注说明）。
 * @param points - [{ turn, cost }]（已定价轮，升序）。
 * @returns { path, area, dots, ticks, yMax, width, height }。
 */
export function lineLayout(points, { width = 640, height = 140, pad = { top: 8, right: 12, bottom: 20, left: 56 } } = {}) {
  const list = (points ?? []).filter((point) => Number.isFinite(point.cost));
  const innerW = Math.max(10, width - pad.left - pad.right);
  const innerH = Math.max(10, height - pad.top - pad.bottom);
  /* Y 轴整刻度（用户反馈 #2）：金额允许小数步进（minStep 0），但同为 1/2/5×10^k。 */
  const scale = niceScale(Math.max(...list.map((point) => point.cost), 0.0001), { minStep: 0 });
  const yMax = scale.yMax;
  const xOf = (index) => (list.length <= 1 ? pad.left + innerW / 2 : pad.left + (index / (list.length - 1)) * innerW);
  const yOf = (cost) => pad.top + innerH - (cost / yMax) * innerH;
  const coords = list.map((point, index) => ({ ...point, x: xOf(index), y: yOf(point.cost) }));
  const path = coords.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const area =
    coords.length > 0
      ? `${path} L${coords[coords.length - 1].x.toFixed(1)},${(pad.top + innerH).toFixed(1)} L${coords[0].x.toFixed(1)},${(pad.top + innerH).toFixed(1)} Z`
      : "";
  const ticks = scale.tickValues.map((cost) => ({ cost, y: yOf(cost) }));
  return { path, area, dots: coords, ticks, yMax, yStep: scale.step, width, height, pad, firstTurn: coords[0]?.turn ?? null, lastTurn: coords[coords.length - 1]?.turn ?? null };
}

/**
 * Y 轴 token 刻度显示（用户反馈）：只显示整数，不带小数填充——
 *  - <1k → 原始整数（500 / 1500，刻度恒为 niceScale 整数）；
 *  - ≥1k 且为千的整数倍 → 整数 k（12k / 500k；niceScale 步进保证刻度恒为千整数倍，
 *    1500 这类 5×10^m 步进值在 <10k 区间直接显示原始整数，避免 1.5k 四舍五入碰撞）；
 *  - ≥1M → 整数 M 或至多 1 位小数（1M / 1.5M / 2.5M——1/2/5 步进保证 M 档刻度
 *    只会是 x.0/x.5M，绝无 "1.00M" 式两位小数）。
 * 仅用于图表轴标签；表格内数值仍走 formatTokens 保留精度。
 */
export function formatAxisTokens(count) {
  const n = Math.round(count ?? 0);
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1000 && n % 1000 === 0) return `${n / 1000}k`;
  return String(n);
}

/**
 * 上下文占用构成条布局：系统/工具/会话三分。
 * 配色（用户反馈：原三段全为蓝色系难以区分——蓝灰/品牌蓝/蓝）按色相分离重排：
 * 系统=中性灰（无色相，喻固定开销）、工具=品牌蓝（延续 deepseek-400 回归哨兵）、
 * 会话=暖橙（amber）。灰/蓝/橙是色觉障碍友好的经典分离组合；仅 amber 与四桶
 * 图的「缓存写」同色，但两卡各有独立图例，不构成误导。
 * 官方明示：三段为启发式构成，不与 projectedTokens 求和一致；条形为构成近似，
 * 数值以投影原文为准。
 * @param breakdown - contextBreakdown 投影值 {systemTokens, toolsTokens, messageTokens}。
 * @returns { segments: [{key,label,color,value,percent,w}] }（percent 基于三段和）。
 */
export function contextBreakdownLayout(breakdown, { width = 100 } = {}) {
  const rows = [
    { key: "systemTokens", label: "系统", color: "var(--dsw-static-neutral-550)" },
    /* T0 任务 1.3：原为硬编码紫色字面量（主题无紫系 static 令牌，design D7/D8 核实）
       → 回退官方 deepseek-400 中明度蓝，随主题联动（回归哨兵见 charts.test）。 */
    { key: "toolsTokens", label: "工具", color: "var(--dsw-static-deepseek-400)" },
    { key: "messageTokens", label: "会话", color: "var(--dsw-static-amber-500)" }
  ];
  const total = rows.reduce((sum, row) => sum + Math.max(0, breakdown?.[row.key] ?? 0), 0);
  return {
    total,
    width,
    segments: rows
      .map((row) => ({ ...row, value: Math.max(0, breakdown?.[row.key] ?? 0) }))
      .filter((row) => row.value > 0)
      .map((row) => ({ ...row, percent: total > 0 ? (row.value / total) * 100 : 0, w: total > 0 ? (row.value / total) * width : 0 }))
  };
}
