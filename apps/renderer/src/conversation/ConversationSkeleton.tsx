import { useEffect, useState, type CSSProperties } from "react";

/**
 * 切换会话空窗期的骨架屏。
 *
 * 形状照抄真实 transcript 的节奏——assistant 文档式正文（头部 + 正文行 + 工具卡）
 * 与右对齐的用户气泡交替——所以淡入时读者看到的是"这段对话正在成形"，而不是
 * 一块与最终版式无关的通用占位。
 *
 * 定位见 workbench.css `.convo-veil`：sticky + height:0 + 绝对定位内层，对文档高度
 * 零贡献。这是硬约束：ConversationVirtualList 的 scrollMargin 用 getBoundingClientRect
 * 相对滚动容器量算，骨架一旦占真实高度，虚拟行会被反向补偿，动画期间整段抖动。
 */

type SkeletonGroup =
  | { readonly kind: "assistant"; readonly lines: readonly number[]; readonly card?: boolean }
  | { readonly kind: "user"; readonly width: number };

/** 固定形状而非随机宽度：随机会让每次切换的骨架都不一样，反而像加载失败重画。 */
const SKELETON_GROUPS: readonly SkeletonGroup[] = [
  { kind: "assistant", lines: [96, 88, 62] },
  { kind: "user", width: 44 },
  { kind: "assistant", lines: [92, 74], card: true },
  { kind: "user", width: 30 },
  { kind: "assistant", lines: [90, 66, 38] },
];

/** 超过这个时长才补一行说明；短加载不该看见任何文字。 */
export const SWITCH_SLOW_MS = 2400;

function SkeletonGroupView({ group, index }: { group: SkeletonGroup; index: number }) {
  // --i 驱动逐组的入场延迟与 shimmer 相位差（见 workbench.css）。
  const style = { "--i": index } as CSSProperties;
  if (group.kind === "user") {
    return (
      <div className="cv-group cv-user" style={style}>
        <div className="cv-bubble skeleton" style={{ width: `${group.width}%` }} />
      </div>
    );
  }
  return (
    <div className="cv-group" style={style}>
      <div className="cv-head">
        <div className="cv-avatar skeleton" />
        <div className="cv-name skeleton" />
      </div>
      {group.card === true ? <div className="cv-card skeleton" /> : null}
      {group.lines.map((width, line) => (
        <div key={line} className="cv-line skeleton" style={{ width: `${width}%` }} />
      ))}
    </div>
  );
}

export function ConversationSkeleton({ leaving = false }: { leaving?: boolean }) {
  /**
   * 挂载后的下一拍才置 `data-in`，让入场 transition 有个真实的前值可插值。
   * 用两帧翻类而不是 `@starting-style`，是因为整条入场延迟（60ms 闸门）与可逆性
   * 都压在这一次 transition 上：`@starting-style` 若被构建链或旧内核丢掉，骨架会
   * 直接满亮出现，快加载就闪了。翻类退化最坏也只是没有淡入。
   */
  const [shown, setShown] = useState(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setShown(true);
    const timer = window.setTimeout(() => setSlow(true), SWITCH_SLOW_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    // aria-hidden：骨架是纯装饰，读屏交给 .convo-doc 的 aria-busy 与既有 live region。
    <div
      className="convo-veil"
      aria-hidden="true"
      {...(shown ? { "data-in": "true" } : {})}
      {...(leaving ? { "data-leaving": "true" } : {})}
    >
      <div className="cv-groups">
        {SKELETON_GROUPS.map((group, index) => (
          <SkeletonGroupView key={index} group={group} index={index} />
        ))}
      </div>
      <p className="cv-note" {...(slow ? { "data-on": "true" } : {})}>正在读取会话记录…</p>
    </div>
  );
}
