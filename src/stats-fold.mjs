/**
 * dsh-token-insight — 会话窗口节点 → 每轮聚合（纯函数、零依赖，node 可单测）。
 *
 * 输入：客户端会话快照的 legacy 节点（dsh-client-runtime conversation.d.ts 的
 * ConversationNode，经 useSession((s) => s.chat.legacy.nodes) 取得）：
 *  - UserMessageNode / SteeringMessageNode：轮标题来源（content 文本截断）；
 *    注意二者没有 turn 字段，轮归属靠「其后首个 assistant 节点」推断；
 *  - AssistantMessageNode：turn/step、usage（TokenUsage 形状，可能缺省——
 *    中断/失败步不报告）、provenance {provider, model}、time、timing
 *    {stepStartTime, firstTokenTime, completedTime}、requestConfig、interrupted；
 *  - CompactionSummaryNode（kind:"compaction"）：压缩检查点——落盘的检查点
 *    user 消息在此节点（kind 已改写为 compaction，不再是 user），其指令文本
 *    是写给模型的，绝不能被选为轮标题（实装核对：dsh-client-ui-conversation
 *    registerCompactionConversationNode —— 「The framed checkpoint payload is
 *    an instruction envelope written for the model and never renders」）。
 *    折叠层显式跳过该类节点（tasks 1.6）。
 *
 * 窗口语义（杂交方案）：这里只覆盖已加载分页（50 条消息/页）。页首「全会话」
 * KPI 必须来自 useProjection 的宿主投影（tokenUsage / sessionStats，全量权威，
 * 不受分页与 compaction 影响）；当明细轮数 < 投影轮数时，UI 应提示用
 * loadOlder() 逼近全量。
 */

/** 从消息节点 content 提取纯文本（text/reasoning 块拼接，忽略其余块）。 */
export function nodeText(node) {
  let text = "";
  for (const block of node?.content ?? []) {
    if ((block.type === "text" || block.type === "reasoning") && typeof block.text === "string") {
      text += (text ? "\n" : "") + block.text;
    }
  }
  return text;
}

/** 截断为单行标题（空白折叠 + 省略号）。 */
export function titleOf(node, maxLength = 60) {
  const line = nodeText(node).replace(/\s+/g, " ").trim();
  return line.length > maxLength ? line.slice(0, maxLength - 1) + "…" : line;
}

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

/**
 * 一步的 TTFT / 解码时长 / 输出 token（对齐官方 assistantStepReading 语义：
 * ui-conversation turn-metrics.js —— ttft = firstTokenTime - stepStartTime，
 * decode = completedTime - firstTokenTime；任一端点缺失为 null）。
 */
export function stepReading(node) {
  const timing = node?.timing;
  const ttftMs =
    timing !== void 0 &&
    typeof timing.stepStartTime === "number" &&
    typeof timing.firstTokenTime === "number"
      ? Math.max(0, timing.firstTokenTime - timing.stepStartTime)
      : null;
  const decodeMs =
    timing !== void 0 && typeof timing.firstTokenTime === "number"
      ? Math.max(0, timing.completedTime - timing.firstTokenTime)
      : null;
  const outputTokens =
    typeof node?.usage === "object" && node.usage !== null &&
    typeof node.usage.outputTokens === "number" && Number.isFinite(node.usage.outputTokens) &&
    node.usage.outputTokens >= 0
      ? node.usage.outputTokens
      : null;
  return { ttftMs, decodeMs, outputTokens };
}

/** 调用参数展示所需的 requestConfig 已报告项（缺省项省略）。 */
function requestConfigOf(node) {
  const rc = node?.requestConfig;
  if (typeof rc !== "object" || rc === null) return null;
  const picked = {};
  if (typeof rc.provider === "string" && rc.provider) picked.provider = rc.provider;
  if (typeof rc.model === "string" && rc.model) picked.model = rc.model;
  if (typeof rc.purpose === "string" && rc.purpose) picked.purpose = rc.purpose;
  if (typeof rc.thinking === "string" && rc.thinking) picked.thinking = rc.thinking;
  if (typeof rc.reasoningEffort === "string" && rc.reasoningEffort) picked.reasoningEffort = rc.reasoningEffort;
  if (typeof rc.temperature === "number") picked.temperature = rc.temperature;
  if (typeof rc.maxTokens === "number") picked.maxTokens = rc.maxTokens;
  if (Array.isArray(rc.stop) && rc.stop.length > 0) picked.stop = rc.stop;
  return Object.keys(picked).length > 0 ? picked : null;
}

/**
 * 按轮折叠窗口节点。
 *
 * 轮标题取该轮首个非空 user/steering 文本；仅含命令/上下文注入/压缩检查点
 * 而无 assistant 步的轮不产生明细行（与官方 StatsLine/投影的轮口径一致：
 * 全命令轮、压缩落点轮计入投影轮数但不产生行——覆盖提示 N < M 属预期）。
 *
 * 每轮附 TTFT 与吞吐（对齐官方 deriveTurnMetrics 语义：TTFT 取该轮最低 step
 * 的读数；吞吐 = Σ输出 token ÷ Σ解码时长，只计同时具备两者的步）。
 *
 * @param nodes - useSession 快照的 legacy 节点数组。
 * @param options.titleMaxLength - 标题截断长度（字符）。
 * @returns 按轮升序的行数组：{ turn, startTime, endTime, title,
 *   steps: [{provider, model, usage|null, time, startTime, timing, requestConfig, interrupted}],
 *   usage（聚合四桶）, hasUsage, models, ttftMs|null, tokensPerSecond|null }。
 */
export function foldTurns(nodes, { titleMaxLength = 60 } = {}) {
  const rows = new Map();
  let pendingTitle = "";
  let pendingTime = null;
  for (const node of nodes ?? []) {
    if (node.kind === "user" || node.kind === "steering") {
      const text = titleOf(node, titleMaxLength);
      if (text && !pendingTitle) {
        pendingTitle = text;
        pendingTime = node.time ?? null;
      }
      continue;
    }
    /* 压缩检查点（指令信封，非用户输入）与上下文注入不参与轮标题（tasks 1.6）。 */
    if (node.kind === "compaction" || node.kind === "context") continue;
    if (node.kind !== "assistant") continue;
    const turn = node.turn;
    let row = rows.get(turn);
    if (!row) {
      row = {
        turn,
        startTime: pendingTime ?? node.time,
        endTime: node.time,
        title: pendingTitle || `（第 ${turn} 轮）`,
        steps: [],
        usage: emptyBuckets(),
        hasUsage: false,
        models: [],
        firstStep: null,
        firstStepTtftMs: null,
        decodeMs: 0,
        decodeTokens: 0,
        decodeSampled: false,
        ttftMs: null,
        tokensPerSecond: null
      };
      rows.set(turn, row);
    }
    row.endTime = node.time;
    const model = node.provenance?.model ?? null;
    if (model && !row.models.includes(model)) row.models.push(model);
    const usage = typeof node.usage === "object" && node.usage !== null ? node.usage : null;
    if (usage) {
      addBuckets(row.usage, usage);
      row.hasUsage = true;
    }
    const reading = stepReading(node);
    if (row.firstStep === null || node.step < row.firstStep) {
      row.firstStep = node.step;
      row.firstStepTtftMs = reading.ttftMs;
    }
    if (reading.decodeMs !== null && reading.outputTokens !== null) {
      row.decodeMs += reading.decodeMs;
      row.decodeTokens += reading.outputTokens;
      row.decodeSampled = true;
    }
    row.steps.push({
      provider: node.provenance?.provider ?? null,
      model,
      step: node.step,
      messageId: node.messageId ?? null,
      usage,
      time: node.time,
      /* 请求开始时刻：时段折扣的账单口径（pricing 侧优先用它，缺失回退 time）。 */
      startTime: node.timing?.stepStartTime ?? null,
      timing: node.timing ?? null,
      requestConfig: requestConfigOf(node),
      interrupted: node.interrupted === true
    });
    /* 标题消费一次即清：后续同轮 steering 不改标题；下一轮由新 user 消息重新累积。 */
    pendingTitle = "";
    pendingTime = null;
  }
  const result = [...rows.values()].sort((a, b) => a.turn - b.turn);
  for (const row of result) {
    if (row.firstStepTtftMs !== null) row.ttftMs = row.firstStepTtftMs;
    if (row.decodeSampled && row.decodeMs > 0) {
      row.tokensPerSecond = row.decodeTokens / (row.decodeMs / 1e3);
    }
    delete row.firstStep;
    delete row.firstStepTtftMs;
    delete row.decodeSampled;
  }
  return result;
}

/** 窗口内汇总四桶（与全会话投影相区分：这是「已加载」总量）。 */
export function sumUsage(rows) {
  const totals = emptyBuckets();
  for (const row of rows ?? []) addBuckets(totals, row.usage ?? {});
  return totals;
}

/**
 * 用 trajectory 视图快照的请求清单补全每步的模型/路由/调用参数。
 *
 * 背景（实机核实，0.1.1-rc.2）：`assistant/message` 事件的 `message.source`
 * 是必填的 {provider, model}（"Required source of an assistant message
 * produced by a routed model"），但 ui-conversation 构造 legacy
 * AssistantMessageNode 时未拷贝该字段——窗口节点上拿不到模型。trajectory
 * 视图（views.get("trajectory")）自己的 fold 会填：其 requests[] 按
 * (turn, step) 携带 provenance {provider, model}、requestConfig、usage、
 * status。本函数把该清单按 (turn, step) join 进折叠行：
 *  - 只补缺（节点自身 provenance 优先——将来宿主版本若填了则以节点为准）；
 *  - 同 (turn, step) 多条请求（重试）时取最后一条（最终尝试 = 产出最终
 *    消息的那次）；
 *  - models 列表按补全后的步骤重算（保持首次出现顺序）。
 * @param rows - foldTurns 产物。
 * @param requests - views.get("trajectory")?.requests（RequestView[]；可缺省）。
 * @returns 新的行数组（不改传入值）。
 */
export function joinRequestInsights(rows, requests) {
  if (!Array.isArray(rows) || rows.length === 0) return rows ?? [];
  if (!Array.isArray(requests) || requests.length === 0) return rows;
  const byKey = new Map();
  for (const request of requests) {
    if (!request || request.purpose !== "assistant") continue;
    if (typeof request.turn !== "number" || typeof request.step !== "number") continue;
    /* last-wins：重试链的最终尝试才有 provenance/结果。 */
    byKey.set(`${request.turn}:${request.step}`, request);
  }
  if (byKey.size === 0) return rows;
  let anyTouched = false;
  const next = rows.map((row) => {
    let touched = false;
    const steps = row.steps.map((step) => {
      const request = byKey.get(`${row.turn}:${step.step}`);
      if (!request) return step;
      const provider = step.provider ?? request.provenance?.provider ?? null;
      const model = step.model ?? request.provenance?.model ?? null;
      const requestConfig =
        step.requestConfig ??
        (typeof request.requestConfig === "object" && request.requestConfig !== null
          ? request.requestConfig
          : null);
      if (provider === step.provider && model === step.model && requestConfig === step.requestConfig) {
        return step;
      }
      touched = true;
      return { ...step, provider, model, requestConfig };
    });
    if (!touched) return row;
    anyTouched = true;
    return {
      ...row,
      steps,
      models: [...new Set(steps.map((step) => step.model).filter(Boolean))]
    };
  });
  return anyTouched ? next : rows;
}

/**
 * 计费输入 = 三桶输入之和（桶互斥，与官方 StatsLine 的口径一致）。
 * 双形状兼容：窗口节点 usage 用 `inputTokens`，宿主投影 tokenUsage 用
 * `uncachedInputTokens`（官方 billedInputTokens 即三桶求和，字段名随形状）。
 */
export function billedInputTokens(usage) {
  const uncached =
    usage?.uncachedInputTokens ?? usage?.inputTokens ?? 0;
  return uncached + (usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0);
}

/** 缓存命中率（0-100 数字或 null）：命中 / 计费输入；无输入返回 null。 */
export function cacheHitPercent(usage) {
  const billed = billedInputTokens(usage);
  return billed > 0 ? ((usage.cacheReadTokens ?? 0) / billed) * 100 : null;
}

/** token 数显示：0 / 980 / 9.8k / 18k / 999k / 1.00M（999.5k 以上进位为 M，避免 1000k）。 */
export function formatTokens(count) {
  const n = count ?? 0;
  if (n < 1000) return String(n);
  if (n < 999_500) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + "k";
  return (n / 1_000_000).toFixed(2) + "M";
}

/**
 * 离线折叠 session.history 事件页 → 账本沉淀行（深度补全用，不打开会话）。
 *
 * usage 双载体口径（与宿主 token-meter 一致，dsh-client-connection usageSampleOf
 * 实装核对）：
 *  - `assistant/chunk` 且 `data.chunk.type === "usage"` → `data.chunk.usage`；
 *  - `assistant/message` → `data.usage`；
 *  同一 (turn, step) 多个样本按 last-sample-replacing 取最后一个
 *  （message 是该步的最终样本，天然覆盖 interim chunk 样本）。
 * 模型来源：`assistant/message` 的 `data.message.source {provider, model}`
 * （wire 必填）；仅出现 chunk-usage 而无 message 的步（中断）模型未知 → 空串。
 * 请求开始时刻：`step/start` 事件时刻（时段折扣的账单口径，缺失回退事件时刻）。
 *
 * @param pages - 每页 session.history 响应的 events 数组（[{event} | event]），
 *   按拉取顺序（新→旧或旧→新均可；函数内部按 (seq) 排序后重放）。
 * @returns { rows, fromSeq, toSeq }：rows 与 foldTurns 行同形（upsert 可直接吃），
 *   仅含 usage 非空步；fromSeq/toSeq 为本批事件 seq 区间（无事件为 null）。
 */
export function foldHistoryEvents(pages) {
  const events = [];
  for (const page of pages ?? []) {
    for (const item of page ?? []) {
      const event = item?.event ?? item;
      if (event && typeof event.type === "string" && Number.isFinite(event.seq)) events.push(event);
    }
  }
  events.sort((a, b) => a.seq - b.seq);
  const stepStart = new Map(); /* "turn:step" → step/start 事件时刻 */
  const samples = new Map(); /* "turn:step" → 最终样本（last-wins） */
  let fromSeq = null;
  let toSeq = null;
  for (const event of events) {
    fromSeq = fromSeq === null ? event.seq : Math.min(fromSeq, event.seq);
    toSeq = toSeq === null ? event.seq : Math.max(toSeq, event.seq);
    const data = event.data ?? {};
    const turn = data.turn;
    const step = data.step;
    if (event.type === "step/start" && typeof turn === "number" && typeof step === "number") {
      stepStart.set(`${turn}:${step}`, event.time);
      continue;
    }
    if (typeof turn !== "number" || typeof step !== "number") continue;
    let usage = null;
    if (event.type === "assistant/chunk" && data.chunk?.type === "usage") usage = data.chunk.usage;
    else if (event.type === "assistant/message") usage = data.usage;
    if (typeof usage !== "object" || usage === null) continue;
    const source = event.type === "assistant/message" ? data.message?.source ?? null : null;
    samples.set(`${turn}:${step}`, {
      turn,
      step,
      usage,
      time: event.time,
      source,
      seq: event.seq
    });
  }
  const byTurn = new Map();
  for (const sample of samples.values()) {
    if (sample.source === null) {
      /* 无 message 载体的步（中断）：沿用该轮已知的 source（同轮多步常同模型）。 */
      for (let probe = sample.step - 1; probe >= 0 && sample.source === null; probe -= 1) {
        sample.source = samples.get(`${sample.turn}:${probe}`)?.source ?? null;
      }
    }
    let row = byTurn.get(sample.turn);
    if (row === void 0) {
      row = { turn: sample.turn, steps: [] };
      byTurn.set(sample.turn, row);
    }
    row.steps.push({
      step: sample.step,
      provider: sample.source?.provider ?? "",
      model: sample.source?.model ?? "",
      usage: {
        inputTokens: sample.usage.inputTokens ?? 0,
        cacheReadTokens: sample.usage.cacheReadTokens ?? 0,
        cacheWriteTokens: sample.usage.cacheWriteTokens ?? 0,
        outputTokens: sample.usage.outputTokens ?? 0
      },
      time: sample.time,
      startTime: stepStart.get(`${sample.turn}:${sample.step}`) ?? null
    });
  }
  const rows = [...byTurn.values()].sort((a, b) => a.turn - b.turn);
  for (const row of rows) row.steps.sort((a, b) => a.step - b.step);
  return { rows, fromSeq, toSeq };
}
