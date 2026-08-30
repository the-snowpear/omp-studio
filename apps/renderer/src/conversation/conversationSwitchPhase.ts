/**
 * 会话切换的过场编排（纯状态机，无 React 依赖）。
 *
 * 切换会话时 transcript 必然经过一段空窗：engine 按 identity 重建，第一份快照是
 * `idle/loading` 且零行，真实内容要等 IPC 读完才到。之前这段空窗直接硬切成居中的
 * "正在准备对话"占位，于是一次切换要闪两次版式——进占位、出占位——而且无论读取
 * 是 30ms 还是 6s 都闪。
 *
 * 这里改成 fade-through：上一段 transcript 原地淡出（`leaving`），骨架无限期兜住
 * 空窗（`waiting`），新 transcript 隐身完成测高与贴底（`settling`），再叠着骨架淡入
 *（`revealing`）。只有 `leaving` 与 `revealing` 有时限，`waiting` 没有——这正是
 * 同一套过场能同时适配"归档会话瞬读完"
 * 和"冷 Runtime 开半天"的原因：
 *   - 读取在淡出窗口内完成 → 走 leaving → settling → revealing，骨架根本不出现；
 *   - 稍慢一点 → 骨架淡入 60ms 延迟未到就被撤销，只留一次呼吸感；
 *   - 很慢 → 骨架完整显示并自己解释在等什么，读完再交叉溶解。
 */

/** 淡出上一段 transcript 的时长；短到不像等待，长到能看出是"离场"而非"消失"。 */
export const SWITCH_LEAVE_MS = 140;
/** 新 transcript 隐身完成虚拟列表测高与贴底的帧数。 */
export const SWITCH_SETTLE_FRAMES = 2;
/** 新 transcript 淡入（与骨架淡出重叠）的时长。 */
export const SWITCH_REVEAL_MS = 320;

export type ConversationSwitchPhase = "idle" | "leaving" | "waiting" | "settling" | "revealing";

export type ConversationSwitchState = {
  readonly phase: ConversationSwitchPhase;
  /** 当前过场归属的会话键；它变化才算一次切换。 */
  readonly key: string;
  /** 每次进入新阶段自增，用来让上一阶段的定时器失效。 */
  readonly seq: number;
  /** 骨架是否在屏上——决定它该淡出还是直接卸载。 */
  readonly veil: boolean;
};

export type ConversationSwitchEvent =
  /** 会话键变了。`paintable`：新会话此刻已有可画内容；`canFade`：上一屏还留着，可以淡出。 */
  | { readonly type: "identity"; readonly key: string; readonly paintable: boolean; readonly canFade: boolean }
  /** 会话键变了，但屏上的面没变（欢迎页 → 欢迎页，如 session.create 回执把
   *  identity 从 null 换成新会话）：只换 key，不重跑淡出/淡入，否则同一块
   *  欢迎页会自己闪一遍。阶段与骨架保持原样，由既有事件继续推进。 */
  | { readonly type: "adopt"; readonly key: string }
  /** 同一个会话自己回到了"没东西可画"（reload 清空重读、resync 后重建）。
   *  不走这条就会露出真空白：正文没得画，而过场机还停在 idle。 */
  | { readonly type: "pending"; readonly canFade: boolean }
  /** 等待中的会话读到内容了。 */
  | { readonly type: "paintable" }
  /** 新 transcript 已经在不可见状态完成测高与贴底，可以开始淡入。 */
  | { readonly type: "settled"; readonly seq: number }
  /** 阶段计时到点；`seq` 不匹配即为过期定时器。 */
  | { readonly type: "elapsed"; readonly seq: number; readonly paintable: boolean };

export const IDLE_CONVERSATION_SWITCH: ConversationSwitchState = { phase: "idle", key: "", seq: 0, veil: false };

/** 阶段时长；`null` 表示阶段由外部事件推进（`waiting` 等 IPC，`settling` 等两帧，`idle` 是终态）。 */
export function switchPhaseMs(phase: ConversationSwitchPhase, reducedMotion = false): number | null {
  if (phase === "leaving") return reducedMotion ? 0 : SWITCH_LEAVE_MS;
  if (phase === "revealing") return reducedMotion ? 0 : SWITCH_REVEAL_MS;
  return null;
}

/** 骨架是否正在退场：`waiting` / `settling` 时挂着，`revealing` 时才开始淡出。 */
export function switchVeilLeaving(state: ConversationSwitchState): boolean {
  return state.veil && state.phase === "revealing";
}

export function nextConversationSwitch(
  state: ConversationSwitchState,
  event: ConversationSwitchEvent,
): ConversationSwitchState {
  if (event.type === "adopt") {
    if (event.key === state.key) return state;
    return { ...state, key: event.key };
  }
  if (event.type === "identity") {
    if (event.key === state.key) return state;
    // 骨架已经在屏上：换目标不重启过场，让同一片骨架继续兜着。反复点侧边栏
    // 切会话时，这一条是"不闪"的全部原因。
    if (state.phase === "waiting") return { ...state, key: event.key };
    // 新正文还不可见时换目标：有现成内容就重新稳定两帧；没有就回同一片骨架等待。
    if (state.phase === "settling") {
      return event.paintable
        ? { ...state, key: event.key, seq: state.seq + 1 }
        : { phase: "waiting", key: event.key, seq: state.seq + 1, veil: true };
    }
    // 淡出进行中：保留正在跑的那个定时器（不动 seq），否则每次改目标都会重新
    // 计时，上一屏迟迟淡不完。
    if (state.phase === "leaving") return { ...state, key: event.key };
    if (event.canFade) return { phase: "leaving", key: event.key, seq: state.seq + 1, veil: false };
    if (event.paintable) return { phase: "settling", key: event.key, seq: state.seq + 1, veil: false };
    return { phase: "waiting", key: event.key, seq: state.seq + 1, veil: true };
  }
  if (event.type === "pending") {
    // leaving / waiting 已经在处理"没东西可画"；revealing 则是刚淡入的内容又被抽走
    // （同一会话 reload 清空重读），必须接管，否则正文渲染成 null 就是一片真空白。
    if (state.phase === "leaving" || state.phase === "waiting") return state;
    if (state.phase === "settling") {
      return { phase: "waiting", key: state.key, seq: state.seq + 1, veil: true };
    }
    return event.canFade
      ? { phase: "leaving", key: state.key, seq: state.seq + 1, veil: false }
      : { phase: "waiting", key: state.key, seq: state.seq + 1, veil: true };
  }
  if (event.type === "paintable") {
    if (state.phase !== "waiting") return state;
    return { phase: "settling", key: state.key, seq: state.seq + 1, veil: true };
  }
  if (event.type === "settled") {
    if (event.seq !== state.seq || state.phase !== "settling") return state;
    return { phase: "revealing", key: state.key, seq: state.seq + 1, veil: state.veil };
  }
  if (event.seq !== state.seq) return state;
  if (state.phase === "leaving") {
    return event.paintable
      ? { phase: "settling", key: state.key, seq: state.seq + 1, veil: false }
      : { phase: "waiting", key: state.key, seq: state.seq + 1, veil: true };
  }
  if (state.phase === "revealing") return { phase: "idle", key: state.key, seq: state.seq + 1, veil: false };
  return state;
}
