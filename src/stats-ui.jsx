/**
 * dsh-v-token-insight — 共享统计卡片套件（tasks 5.1，规格「视觉与无障碍」）。
 *
 * 总览页与会话页签共用的五件套：Card / KpiCard / ChartCard / StatBadge /
 * 口径脚注。设计约定（与 charts.mjs 一致）：
 *  - 颜色全走 --dsw-alias-* / --dsw-static-* 令牌，随官方主题联动（浅/深均可读，
 *    对比度 ≥ 4.5:1）；卡片用官方层色与描边令牌；
 *  - 数字一律 tabular-nums；
 *  - 每个图表 MUST 配表格替代（ChartCard 的 alt 槽，<details> 折叠）；
 *  - 无入场动画（prefers-reduced-motion 天然满足）。
 *
 * 注意：本文件含 JSX，由 esbuild（build.mjs，jsx automatic）打进 lib/client.js；
 * 纯函数仍留在 charts.mjs / rows-aggregate.mjs / ledger.mjs 供 node 单测。
 */
import { Fragment } from "react";

/** 基础卡片：层色 + 描边 + 圆角，头部标题/副题（复用 tsn-card 语言）。 */
export function Card({ title, subtitle, actions, children, className = "" }) {
  return (
    <section className={`tsn-card ${className}`.trim()}>
      {title !== void 0 || subtitle !== void 0 || actions ? (
        <div className="tsn-card-head">
          <div className="tsn-card-head-text">
            {title !== void 0 ? <div className="tsn-card-title">{title}</div> : null}
            {subtitle !== void 0 ? <div className="tsn-card-subtitle">{subtitle}</div> : null}
          </div>
          {actions ? <div className="tsn-card-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/**
 * KPI 卡：tertiary 小标题 + 大数字（tabular-nums）+ 可选副注 + 可选占比条。
 * @param meter - 可选迷你占比条插槽（总览页命中率/会话构成，按数值比例填充；
 *   用户反馈 #6：环/圆点示意不可读，改为占比条）。纯装饰，容器 aria-hidden，
 *   数值文本仍是唯一无障碍信息源；缺席不渲染。
 */
export function KpiCard({ label, value, sub, meter }) {
  return (
    <div className="tsn-kpi">
      <div className="tsn-kpi-label">{label}</div>
      <div className="tsn-kpi-value">{value}</div>
      {meter ? (
        <div className="tsn-kpi-meter" aria-hidden="true">
          {meter}
        </div>
      ) : null}
      {sub !== void 0 && sub !== null && sub !== "" ? <div className="tsn-kpi-sub">{sub}</div> : null}
    </div>
  );
}

/**
 * 图表卡：卡头（标题+副题+口径徽标）+ 图 + 表格替代（<details>，无障碍）。
 * @param caliber - 口径徽标文本（如「账本覆盖段」「按最近活动」）；空缺不渲染。
 * @param alt - 表格替代节点（等价数据）；空缺不渲染折叠区。
 */
export function ChartCard({ title, subtitle, caliber, children, alt, className = "" }) {
  return (
    <Card title={title} subtitle={subtitle} className={className}>
      {caliber !== void 0 && caliber !== null && caliber !== "" ? (
        <div className="tsn-caliber-badge">{caliber}</div>
      ) : null}
      {children}
      {alt ? (
        <details className="tsn-alt">
          <summary>{alt.summaryLabel}</summary>
          {alt.table}
        </details>
      ) : null}
    </Card>
  );
}

/** 状态徽标：kind = "running"（运行）/ "archived"（归档）/ "subagent"（子会话）/ "warn"。 */
export function StatBadge({ kind, children }) {
  return (
    <span className="tsn-badge2" data-kind={kind}>
      {children}
    </span>
  );
}

/** 口径脚注：双层口径/费用口径等「诚实声明」统一入口。 */
export function Footnote({ children }) {
  return <div className="tsn-note tsn-footnote">{children}</div>;
}

/** 四桶图例行（小色点 + 标签 + 值）；columns 版本用于紧凑并排。 */
export function BucketLegend({ segments, buckets, format }) {
  return (
    <div className="tsn-bucket-legend">
      {segments.map((segment) => (
        <span className="tsn-step-bucket" key={segment.key}>
          <i style={{ background: segment.color }} />
          {segment.label} {format(buckets?.[segment.key] ?? 0)}
        </span>
      ))}
    </div>
  );
}

export { Fragment };
