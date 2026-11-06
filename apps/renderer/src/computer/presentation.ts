import type { ComputerAction, ComputerControlState, ComputerFrame, ComputerWorkspaceSnapshot } from "@omp-studio/studio-protocol";

const ACTIONS: Record<string, [string, string]> = {
  screenshot: ["读取画面", "Capture screen"], capture: ["读取画面", "Capture screen"], click: ["点击", "Click"],
  type: ["输入文字", "Type text"], typeText: ["输入文字", "Type text"], scroll: ["滚动", "Scroll"],
  observe: ["观察窗口", "Observe window"], windows: ["查找窗口", "Find windows"], run: ["运行电脑脚本", "Run computer script"],
  sendInput: ["发送原生输入", "Send native input"], axSnapshot: ["读取界面结构", "Read interface structure"],
};
export function actionName(action: ComputerAction, zh: boolean) { return ACTIONS[action.method]?.[zh ? 0 : 1] ?? action.method; }
export function actionStatus(action: ComputerAction, zh: boolean) {
  const labels = { running: ["执行中", "Running"], waiting: ["等待", "Waiting"], completed: ["已完成", "Completed"], failed: ["失败", "Failed"], cancelled: ["已取消", "Cancelled"] };
  return labels[action.status][zh ? 0 : 1];
}
export function controlLabel(control: ComputerControlState | undefined, zh: boolean) {
  if (!control) return zh ? "控制状态未知" : "Control state unknown";
  const labels = { allowed: ["电脑操作未被手动停止", "Computer actions not manually stopped"], stopping: ["停止中", "Stopping"], stopped: ["本会话电脑操作已停止", "Computer actions stopped for this session"], continuing: ["继续请求排队中，尚未恢复", "Continue queued; not resumed"], unconfirmed: ["停止尚未完全确认", "Stop not fully confirmed"] };
  return labels[control.status][zh ? 0 : 1];
}
export function foregroundLabel(control: ComputerControlState | undefined, zh: boolean) {
  const labels = { none: ["未持有前台控制", "No foreground control"], requested: ["等待批准前台控制", "Awaiting foreground approval"], held: ["正在使用前台控制", "Foreground control held"], unknown: ["前台控制状态未知", "Foreground control unknown"] };
  return labels[control?.foreground ?? "unknown"][zh ? 0 : 1];
}
export function frameUnavailable(frame: ComputerFrame, zh: boolean) {
  if (frame.availability === "expired" || frame.expiresAt !== undefined && frame.expiresAt <= Date.now()) return zh ? "图像已过期或未保存。此处不会补拍冒充历史画面。" : "Image expired or was not saved. A new capture will not replace this history.";
  if (frame.availability === "pending") return zh ? "图像仍在交付中，请稍后重试。" : "Image delivery is pending. Try again shortly.";
  if (frame.availability === "unavailable") return zh ? "此步骤的图像不可用；动作记录仍然保留。" : "This image is unavailable; its action record remains.";
  return undefined;
}
export function workspaceEmpty(snapshot: ComputerWorkspaceSnapshot | undefined, zh: boolean): [string, string] {
  if (!snapshot) return [zh ? "等待电脑状态" : "Waiting for Computer state", zh ? "连接支持电脑工作区的 Runtime 后查看真实状态。" : "Connect a Runtime with Computer workspace support to see its state."];
  if (!snapshot.enabled) return [zh ? "本次会话尚未启用电脑操作" : "Computer use is off for this session", zh ? "启用允许代理调用原生电脑能力，具体输入仍需遵守审批。观察目标不是操作授权边界。" : "Enabling allows native computer calls; input approvals still apply. The observation target does not limit input authorization."];
  if (snapshot.screen.locked || snapshot.screen.asleep) return [zh ? snapshot.screen.locked ? "电脑已锁定" : "电脑正在休眠" : snapshot.screen.locked ? "Computer locked" : "Computer asleep", zh ? "已暂停额外观察。请在系统中解锁或唤醒后再刷新；Studio 不会自动唤醒电脑。" : "Extra observation is paused. Unlock or wake the computer yourself, then refresh. Studio will not wake it."];
  if (snapshot.reason) return [zh ? "电脑能力受限" : "Computer capability limited", snapshot.reason];
  if (!snapshot.preludeAvailable) return [zh ? "代理的电脑脚本入口不可用" : "Computer scripting is unavailable to the agent", zh ? "观察通道可以单独使用。请检查 Runtime 与 Eval 配置后，再下达电脑任务。" : "Observation can be used independently. Check the Runtime and Eval configuration before requesting computer tasks."];
  if (!snapshot.capabilities.capture) return [zh ? "屏幕截图暂不可用" : "Screen capture unavailable", zh ? "请检查系统屏幕录制权限与 Runtime 观察能力。输入和辅助功能状态可在详情中分别查看。" : "Check screen recording permission and Runtime observation support. Input and accessibility states are listed separately in Details."];
  return [zh ? "等待代理的第一张画面" : "Waiting for the first agent frame", zh ? "默认只跟随代理已生成的截图。需要另看当前画面时，选择目标后刷新或打开自动观察。" : "By default, follow only frames the agent already generated. Select a target to refresh or explicitly enable automatic observation."];
}
export function frameTime(time: number, zh: boolean) { return new Date(time).toLocaleString(zh ? "zh-CN" : "en-US", { hour12: false }); }

/** Task-facing status. Operator control remains an independent diagnostic, never a fake activity signal. */
export function workspaceStatus(snapshot: ComputerWorkspaceSnapshot | undefined, zh: boolean) {
  if (!snapshot) return zh ? "等待电脑状态" : "Waiting for Computer state";
  if (snapshot.control.status !== "allowed") return controlLabel(snapshot.control, zh);
  if (snapshot.control.foreground === "requested") return zh ? "等待批准前台控制" : "Awaiting foreground approval";
  if (!snapshot.enabled) return zh ? "本次会话尚未启用电脑操作" : "Computer use is off for this session";
  if (snapshot.screen.locked) return zh ? "电脑已锁定" : "Computer locked";
  if (snapshot.screen.asleep) return zh ? "电脑正在休眠" : "Computer asleep";
  if (snapshot.active.some(action => action.status === "running")) return zh ? "正在运行电脑任务" : "Running a computer task";
  if (snapshot.active.some(action => action.status === "waiting")) return zh ? "电脑任务正在等待" : "Computer task waiting";
  if (snapshot.capabilities.capture && !snapshot.capabilities.input) return zh ? "仅可观察" : "Observation only";
  return snapshot.capabilities.capture ? zh ? "等待电脑任务" : "Waiting for a computer task" : zh ? "电脑观察暂不可用" : "Computer observation unavailable";
}
