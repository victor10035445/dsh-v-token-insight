/**
 * dsh-v-token-insight — 会话窗口折叠共享缓存（纯函数模块，node 可单测）。
 *
 * 解决的规模问题：会话页签与每个尾部 chip 各自执行
 * `joinRequestInsights(foldTurns(nodes), requests)`——流式生成期间每个 delta
 * 都换新 nodes 快照引用，(K+1)·O(N) 每帧重折（K = 挂载 chip 数）是长会话
 * 卡顿的主因。本模块把 fold + join 收敛为每帧至多一次：
 *
 *   一级缓存：WeakMap<nodes 数组引用, entry{rows, turnByMessageId, joined}>
 *     - 命中时做 O(1) 陈旧校验（length + 首尾节点引用）——防宿主以原地变更
 *       （mutation 而非 immutable 更新）节点对象导致读到陈旧折叠；
 *     - turnByMessageId：messageId → 轮号（首个携带该 messageId 的 assistant
 *       节点胜出，与 chip 原线性扫描语义一致），chip 反查 O(N) → O(1)。
 *   二级缓存：entry.joined: WeakMap<requests 引用, joinedRows>
 *     - joinRequestInsights 是 O(轮×步) 的 map 查找 + 数组重建，若只缓存
 *       fold，K 个 chip × O(轮) 的 join 每帧仍是规模炸弹；
 *     - requests（trajectory 快照）按引用键控，引用变更即重算、语义正确；
 *     - requests 缺席（undefined/null）不进缓存——join 本身对空输入零开销。
 *
 * 键全部为引用：宿主快照策略决定命中率；即使每次推送都重建数组，收益仍为
 * (K+1) → 1 次重算/帧。不做跨引用内容哈希（成本高过收益）。
 */

import { foldTurns, joinRequestInsights } from "./stats-fold.mjs";

const cache = new WeakMap();

/**
 * 取（或计算并缓存）当前窗口的折叠与 join 结果。
 * @param nodes - useSession 快照的 legacy 节点数组（按引用缓存）。
 * @param requests - trajectory 快照的 requests 数组（按引用二级缓存；可空）。
 * @returns { rows, turnByMessageId, rowByTurn }：rows 为 join 后的折分行
 *   （无 requests 时为未 join 的折分行）；turnByMessageId 为 messageId → 轮号
 *   索引；rowByTurn 为轮号 → 折分行索引（chip 取行 O(1)，避免 rows.find O(轮)）。
 */
export function foldedWindowOf(nodes, requests) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return { rows: [], turnByMessageId: new Map(), rowByTurn: new Map() };
  }
  let entry = cache.get(nodes);
  const stale =
    entry === void 0 ||
    entry.length !== nodes.length ||
    entry.first !== nodes[0] ||
    entry.last !== nodes[nodes.length - 1];
  if (stale) {
    const rows = foldTurns(nodes);
    const turnByMessageId = new Map();
    for (const node of nodes) {
      if (
        node?.kind === "assistant" &&
        typeof node.messageId === "string" &&
        node.messageId !== "" &&
        !turnByMessageId.has(node.messageId)
      ) {
        turnByMessageId.set(node.messageId, node.turn);
      }
    }
    const rowByTurn = new Map();
    for (const row of rows) rowByTurn.set(row.turn, row);
    entry = {
      length: nodes.length,
      first: nodes[0],
      last: nodes[nodes.length - 1],
      rows,
      turnByMessageId,
      rowByTurn,
      joined: new WeakMap()
    };
    cache.set(nodes, entry);
  }
  if (!Array.isArray(requests) || requests.length === 0) {
    return { rows: entry.rows, turnByMessageId: entry.turnByMessageId, rowByTurn: entry.rowByTurn };
  }
  let joinedEntry = entry.joined.get(requests);
  if (joinedEntry === void 0) {
    const joinedRows = joinRequestInsights(entry.rows, requests);
    const rowByTurn = new Map();
    for (const row of joinedRows) rowByTurn.set(row.turn, row);
    joinedEntry = { rows: joinedRows, rowByTurn };
    entry.joined.set(requests, joinedEntry);
  }
  return { rows: joinedEntry.rows, turnByMessageId: entry.turnByMessageId, rowByTurn: joinedEntry.rowByTurn };
}
