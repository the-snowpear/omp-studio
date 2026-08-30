import { describe, expect, it } from "vitest";
import {
  IDLE_CONVERSATION_SWITCH,
  SWITCH_LEAVE_MS,
  SWITCH_REVEAL_MS,
  nextConversationSwitch,
  switchPhaseMs,
  switchVeilLeaving,
  type ConversationSwitchState,
} from "./conversationSwitchPhase";

function toSession(
  state: ConversationSwitchState,
  key: string,
  { paintable = false, canFade = true }: { paintable?: boolean; canFade?: boolean } = {},
): ConversationSwitchState {
  return nextConversationSwitch(state, { type: "identity", key, paintable, canFade });
}

function elapse(state: ConversationSwitchState, paintable: boolean): ConversationSwitchState {
  return nextConversationSwitch(state, { type: "elapsed", seq: state.seq, paintable });
}

function settle(state: ConversationSwitchState): ConversationSwitchState {
  return nextConversationSwitch(state, { type: "settled", seq: state.seq });
}

describe("conversationSwitchPhase", () => {
  it("fades the painted transcript out before anything else happens", () => {
    const leaving = toSession(IDLE_CONVERSATION_SWITCH, "b");
    expect(leaving).toMatchObject({ phase: "leaving", key: "b", veil: false });
    expect(switchPhaseMs(leaving.phase)).toBe(SWITCH_LEAVE_MS);
  });

  it("skips the skeleton when the read lands inside the fade-out window", () => {
    const stabilizing = elapse(toSession(IDLE_CONVERSATION_SWITCH, "b"), true);
    expect(stabilizing).toMatchObject({ phase: "settling", veil: false });
    const revealing = settle(stabilizing);
    expect(revealing).toMatchObject({ phase: "revealing", veil: false });
    expect(switchPhaseMs(revealing.phase)).toBe(SWITCH_REVEAL_MS);
    expect(elapse(revealing, true).phase).toBe("idle");
  });

  it("holds the skeleton with no deadline until content arrives", () => {
    const waiting = elapse(toSession(IDLE_CONVERSATION_SWITCH, "b"), false);
    expect(waiting).toMatchObject({ phase: "waiting", veil: true });
    // 这是"任意加载时长都适配"的全部机制：waiting 没有时限。
    expect(switchPhaseMs(waiting.phase)).toBeNull();
    expect(switchVeilLeaving(waiting)).toBe(false);

    const stabilizing = nextConversationSwitch(waiting, { type: "paintable" });
    expect(stabilizing).toMatchObject({ phase: "settling", veil: true });
    expect(switchVeilLeaving(stabilizing)).toBe(false);
    const revealing = settle(stabilizing);
    expect(revealing).toMatchObject({ phase: "revealing", veil: true });
    // 骨架留着淡出，与正文淡入交叠。
    expect(switchVeilLeaving(revealing)).toBe(true);
    expect(elapse(revealing, true)).toMatchObject({ phase: "idle", veil: false });
  });

  it("goes straight to the skeleton when there is nothing painted to fade", () => {
    expect(toSession(IDLE_CONVERSATION_SWITCH, "b", { canFade: false })).toMatchObject({
      phase: "waiting",
      veil: true,
    });
  });

  it("reveals without fading when the incoming session is already paintable", () => {
    expect(toSession(IDLE_CONVERSATION_SWITCH, "b", { canFade: false, paintable: true })).toMatchObject({
      phase: "settling",
      veil: false,
    });
  });

  it("keeps one running fade-out when the target changes mid-fade", () => {
    const leaving = toSession(IDLE_CONVERSATION_SWITCH, "b");
    const retargeted = toSession(leaving, "c");
    expect(retargeted).toMatchObject({ phase: "leaving", key: "c" });
    // seq 不动：正在跑的定时器继续有效，否则连点侧边栏时旧 transcript 永远淡不完。
    expect(retargeted.seq).toBe(leaving.seq);
  });

  it("lets one skeleton ride through a burst of switches", () => {
    let state = elapse(toSession(IDLE_CONVERSATION_SWITCH, "b"), false);
    for (const key of ["c", "d", "e"]) {
      state = toSession(state, key);
      expect(state).toMatchObject({ phase: "waiting", key, veil: true });
    }
    expect(nextConversationSwitch(state, { type: "paintable" }).phase).toBe("settling");
  });

  it("ignores timers left over from an abandoned phase", () => {
    const waiting = elapse(toSession(IDLE_CONVERSATION_SWITCH, "b"), false);
    const stale = nextConversationSwitch(waiting, { type: "elapsed", seq: waiting.seq - 1, paintable: true });
    expect(stale).toBe(waiting);
  });

  it("does nothing when the session has not actually changed", () => {
    const waiting = elapse(toSession(IDLE_CONVERSATION_SWITCH, "b"), false);
    expect(toSession(waiting, "b")).toBe(waiting);
    expect(nextConversationSwitch(waiting, { type: "paintable" }).phase).toBe("settling");
  });

  it("covers a same-session reload that clears its rows", () => {
    // 同一个会话自己回到 loading（reload 清空重读）：不接管就会露出真空白。
    const leaving = nextConversationSwitch({ ...IDLE_CONVERSATION_SWITCH, key: "b" }, { type: "pending", canFade: true });
    expect(leaving).toMatchObject({ phase: "leaving", key: "b" });
    const waiting = elapse(leaving, false);
    expect(waiting).toMatchObject({ phase: "waiting", key: "b", veil: true });
    expect(nextConversationSwitch(waiting, { type: "pending", canFade: true })).toBe(waiting);
  });

  it("takes the hidden settling phase back to waiting when content is pulled", () => {
    const revealing = toSession(IDLE_CONVERSATION_SWITCH, "b", { canFade: false, paintable: true });
    expect(nextConversationSwitch(revealing, { type: "pending", canFade: true })).toMatchObject({ phase: "waiting", veil: true });
    expect(nextConversationSwitch(revealing, { type: "pending", canFade: false })).toMatchObject({
      phase: "waiting",
      veil: true,
    });
  });

  it("collapses the timed phases under reduced motion", () => {
    expect(switchPhaseMs("leaving", true)).toBe(0);
    expect(switchPhaseMs("revealing", true)).toBe(0);
    expect(switchPhaseMs("waiting", true)).toBeNull();
    expect(switchPhaseMs("settling", true)).toBeNull();
    expect(switchPhaseMs("idle", true)).toBeNull();
  });

  it("adopts a new key without replaying the choreography", () => {
    // 欢迎页 → 欢迎页：屏上的面没变，只换目标 key，阶段原样。
    const idle: ConversationSwitchState = { phase: "idle", key: "", seq: 4, veil: false };
    const adopted = nextConversationSwitch(idle, { type: "adopt", key: "b" });
    expect(adopted).toMatchObject({ phase: "idle", key: "b", veil: false });
    expect(adopted.seq).toBe(idle.seq);
    expect(nextConversationSwitch(idle, { type: "adopt", key: idle.key })).toBe(idle);
  });

  it("keeps the waiting skeleton rideable after an adopt", () => {
    // 等待中换目标（面仍是欢迎页）：骨架不重建，paintable 仍能把过场推进到 settling。
    const waiting = elapse(toSession(IDLE_CONVERSATION_SWITCH, "b"), false);
    const adopted = nextConversationSwitch(waiting, { type: "adopt", key: "c" });
    expect(adopted).toMatchObject({ phase: "waiting", key: "c", veil: true });
    expect(nextConversationSwitch(adopted, { type: "paintable" }).phase).toBe("settling");
  });
});
