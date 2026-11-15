/** Align Studio user-bubble Restore with OMP `/tree` on a user node. */

import { isZh } from "../i18n";

export type UserMessageTreeConfirmKind = "restore" | "branch";

export type UserMessageTreeConfirmCopy = {
  readonly kicker: string;
  readonly title: string;
  readonly body: string;
  readonly hint: string;
  readonly hintPreview: string;
  readonly action: string;
};

export const USER_MESSAGE_RESTORE_CONFIRM_COPY: UserMessageTreeConfirmCopy = {
  kicker: "CONVERSATION",
  title: "确认恢复",
  body: "将回退对话到这条消息之前，这条消息会回到输入框。",
  hint: "之后的回合会离开当前分支，仍可从会话树找回。",
  hintPreview: "演示：只改本页对话，不会调用 Host。",
  action: "恢复",
};

export const USER_MESSAGE_RESTORE_CONFIRM_COPY_EN: UserMessageTreeConfirmCopy = {
  kicker: "CONVERSATION",
  title: "Confirm restore",
  body: "Rollback the conversation to before this message; its contents will be placed back in the composer.",
  hint: "Later turns will leave the current branch, though you can still recover them from the session tree.",
  hintPreview: "Demo: updates only the conversation in this view without calling Host.",
  action: "Restore",
};

export const USER_MESSAGE_BRANCH_CONFIRM_COPY: UserMessageTreeConfirmCopy = {
  kicker: "CONVERSATION",
  title: "确认新建会话",
  body: "将从这条消息新建会话并切换过去，原文（和图片）会回到输入框。",
  hint: "原来的会话文件保留，不会被覆盖或删除。",
  hintPreview: "演示：只改本页对话，不会调用 Host。",
  action: "新建会话",
};

export const USER_MESSAGE_BRANCH_CONFIRM_COPY_EN: UserMessageTreeConfirmCopy = {
  kicker: "CONVERSATION",
  title: "Confirm new branched session",
  body: "Create and switch to a new session from this message; its text (and images) will be placed back in the composer.",
  hint: "The original session file is preserved and will not be overwritten or deleted.",
  hintPreview: "Demo: updates only the conversation in this view without calling Host.",
  action: "New session",
};

export function userMessageTreeConfirmCopy(kind: UserMessageTreeConfirmKind, zh = isZh()): UserMessageTreeConfirmCopy {
  if (kind === "restore") return zh ? USER_MESSAGE_RESTORE_CONFIRM_COPY : USER_MESSAGE_RESTORE_CONFIRM_COPY_EN;
  return zh ? USER_MESSAGE_BRANCH_CONFIRM_COPY : USER_MESSAGE_BRANCH_CONFIRM_COPY_EN;
}

export type UserMessageRestoreDisableInput = {
  readonly preview: boolean;
  readonly running: boolean;
  readonly compacting: boolean;
  readonly resyncRequired: boolean;
  readonly sessionCreating: boolean;
  readonly gated: boolean;
  readonly canNavigateTree: boolean;
};

export type UserMessageEditorFill = {
  readonly text?: string;
  readonly images?: ReadonlyArray<{
    readonly type: "image";
    readonly mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/svg+xml";
    readonly data: string;
  }>;
};

export function userMessageRestoreDisabledReason(input: UserMessageRestoreDisableInput, zh = isZh()): string | undefined {
  if (input.sessionCreating) return zh ? "创建中" : "Creating";
  if (input.resyncRequired) return zh ? "同步中" : "Syncing";
  if (input.running) return zh ? "进行中" : "In progress";
  if (input.compacting) return zh ? "压缩中" : "Compacting";
  if (input.preview) return undefined;
  if (input.gated) return zh ? "无法操作" : "Unavailable";
  if (!input.canNavigateTree) return zh ? "当前 Runtime 不支持会话树操作" : "Current Runtime does not support session tree actions";
  return undefined;
}

function fillFrom(fallbackText: string, receipt?: UserMessageEditorFill): UserMessageEditorFill {
  const text = receipt?.text !== undefined ? receipt.text : fallbackText;
  const images = receipt?.images;
  return images === undefined || images.length === 0 ? { text } : { text, images };
}

export async function executeUserMessageRestore(input: {
  readonly preview: boolean;
  readonly itemId: string;
  readonly text: string;
  readonly confirm: () => boolean | Promise<boolean>;
  readonly restorePreview: (itemId: string) => boolean;
  readonly navigate: (targetId: string) => Promise<UserMessageEditorFill | undefined>;
  readonly reload: () => Promise<void>;
  readonly fillComposer: (fill: UserMessageEditorFill) => void;
  readonly clearQueued: () => void;
}): Promise<"cancelled" | "ok" | "failed"> {
  if (!(await input.confirm())) return "cancelled";
  if (input.preview) {
    if (!input.restorePreview(input.itemId)) return "failed";
    input.fillComposer({ text: input.text });
    input.clearQueued();
    return "ok";
  }
  const receipt = await input.navigate(input.itemId);
  if (receipt === undefined) return "failed";
  await input.reload();
  input.fillComposer(fillFrom(input.text, receipt));
  input.clearQueued();
  return "ok";
}

export async function executeUserMessageBranch(input: {
  readonly preview: boolean;
  readonly itemId: string;
  readonly text: string;
  readonly confirm: () => boolean | Promise<boolean>;
  readonly restorePreview: (itemId: string) => boolean;
  readonly branch: (targetId: string) => Promise<(UserMessageEditorFill & { readonly sessionId?: string }) | undefined>;
  readonly selectSession: (sessionId: string) => Promise<boolean>;
  readonly reload: () => Promise<void>;
  readonly fillComposer: (fill: UserMessageEditorFill) => void;
  readonly stashComposerFill: (sessionId: string, fill: UserMessageEditorFill) => void;
  readonly clearQueued: () => void;
  readonly onPreviewDone?: () => void;
}): Promise<"cancelled" | "ok" | "failed"> {
  if (!(await input.confirm())) return "cancelled";
  if (input.preview) {
    if (!input.restorePreview(input.itemId)) return "failed";
    input.fillComposer({ text: input.text });
    input.clearQueued();
    input.onPreviewDone?.();
    return "ok";
  }
  const receipt = await input.branch(input.itemId);
  if (receipt === undefined) return "failed";
  const fill = fillFrom(input.text, receipt);
  const sessionId = receipt.sessionId;
  if (sessionId !== undefined && sessionId.length > 0) {
    input.stashComposerFill(sessionId, fill);
    const selected = await input.selectSession(sessionId);
    if (!selected) input.fillComposer(fill);
  } else {
    await input.reload();
    input.fillComposer(fill);
  }
  input.clearQueued();
  return "ok";
}
