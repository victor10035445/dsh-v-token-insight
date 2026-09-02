/**
 * dsh-token-insight — 宿主端（v0 占位）。
 *
 * 纯客户端插件：全部功能在 lib/client.js——
 *  1. 会话页第三页签「Token 统计」（conversation.view 槽，KPI + 每轮明细）
 *  2. 回复结尾功能区的轻量 token 消耗显示（conversation.chat.turnTail 链）
 *  3. 价格表维护入口（settings.general.item 槽，编辑器待实现）
 *
 * 宿主端仅作为 cordis 注册主体存在：loader 经 cordis.patch.yml 的 insert
 * 发现本包，client-modules 再据 dsh.client 声明把客户端包编入启动图。
 * 将来若需要宿主行为（如价目表跨设备同步、导出 API），在此扩展。
 */

export const name = "dsh-token-insight";

/** v0 无宿主服务依赖；需要时按 cordis 规则在此声明（如 "webServer"）。 */
export const inject = [];

/**
 * 插件体：v0 无宿主行为。
 * @param ctx - cordis 注册上下文。
 */
export function apply(ctx) {
  // v0 占位：纯客户端插件。
  void ctx;
}
