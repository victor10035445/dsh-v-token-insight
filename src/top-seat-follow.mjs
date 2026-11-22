/**
 * dsh-v-token-insight — 顶部菜单「用量」链式让位跟随判据（纯函数、零依赖，node 可单测）。
 *
 * 背景（harden-top-seat-chain-follow）：让位基线读 dsh-v-cosmos「星群」锚点的实时 rect，
 * 其 DOM 位移经对方 React 异步提交，可能迟于本插件单次收敛窗口
 * （TOP_SEAT_SETTLE_MAX_ROUNDS）。旧口径以「坐标键稳定」作停机判据——迟到位移在停机后
 * 发生即无触发器可纠，形成持久错位。本模块把停机判据中的「对齐」部分抽成不变式：
 * 锚点左缘已到达或越过其槽位（宿主末按钮右缘 + 既有按钮间距）才算对齐；读数为纯几何
 * 比较、确定性、无副作用，口径可单测。
 *
 * 口径：
 *  - 到达或越过（`>=`）均算对齐：对「星群」被合法放得更远（未来其他插件再让位、右侧
 *    契约漂移）天然宽容，只精准拒绝「滞后」这一种失败形态；
 *  - 容差 1px 与 TopMenuSeat 包含块自校正容差一致（实测 |dx| / |dy| ≤ 1 视为无偏差）；
 *  - 锚点不可测（缺席 / 宽高为 0 / 查询异常 / 非有限几何）→ 视为对齐：让位回落现状
 *    基线，既有「让位与回落都重读实时 rect」语义不变，也不为空转复测。
 */

/** 判据容差（px）：与 TopMenuSeat 自校正容差一致（实测偏差 ≤ 1px 视为落位）。 */
export const CHAIN_SETTLE_TOLERANCE_PX = 1;

/**
 * 链式让位不变式：锚点左缘是否已到达或越过其槽位。
 *
 * @param chainRectLeft - 让位锚点（cosmos「星群」）实时左缘（视口坐标 px）。
 * @param chainMeasurable - 锚点在场且几何可测（宽高 > 0）；false = 缺席 / 不可测。
 * @param hostRight - 宿主菜单「编辑」（末位）按钮实时右缘（视口坐标 px）。
 * @param gap - 既有按钮间距（宿主 [role=menubar] gap，px）。
 * @returns true = 已对齐（含不可测回落）；false = 锚点仍滞后于其槽位。
 */
export function isChainSettled(chainRectLeft, chainMeasurable, hostRight, gap) {
  if (!chainMeasurable) return true;
  if (
    typeof chainRectLeft !== "number" ||
    typeof hostRight !== "number" ||
    typeof gap !== "number" ||
    !Number.isFinite(chainRectLeft) ||
    !Number.isFinite(hostRight) ||
    !Number.isFinite(gap)
  ) {
    /* 非有限几何按不可测处理（与查询异常同口径：回落现状、不空转复测）。 */
    return true;
  }
  return chainRectLeft + CHAIN_SETTLE_TOLERANCE_PX >= hostRight + gap;
}
