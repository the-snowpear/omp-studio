import { isZh } from "../i18n";

export function getPreviewNextMessages(zh = isZh()): string[] {
  return zh
    ? [
        "请检查这次修改并运行相关测试。",
        "继续实现下一步。",
        "解释一下这里的取舍。",
        "补充边界情况的验证。",
      ]
    : [
        "Please review this change and run the relevant tests.",
        "Continue implementing the next step.",
        "Explain the trade-offs here.",
        "Add edge-case verification.",
      ];
}

export const PREVIEW_NEXT_MESSAGES = getPreviewNextMessages();
