import type { InteractionForm } from "@omp-studio/studio-protocol";
import { PREVIEW_FORM_LONG, PREVIEW_FORM_SHORT } from "./formPreview";

/**
 * Preview Deck cards. Native forms use the safe presentation DTO; legacy Ask remains a compatibility surface.
 * Plan payload follows plan-mode review actions. Display only — never sent
 * through Host / Studio Bridge / the command reducer.
 * 每张 ask 卡一个问题（与 ver1「一卡一问 + 队列翻页」一致）：多个提问
 * 各自成卡排队，用右上角队列导航 1/N 切换，不做卡内 tab。
 */

export type PreviewAskOption = {
  readonly label: string;
  readonly description?: string;
  readonly preview?: string;
};

export type PreviewAskQuestion = {
  readonly id: string;
  readonly question: string;
  readonly header?: string;
  readonly options: readonly PreviewAskOption[];
  readonly multi?: boolean;
  readonly acceptImages?: boolean;
  readonly recommended?: number;
};

export type PreviewDeckItem =
  | {
      readonly kind: "plan";
      readonly id: string;
      readonly meta?: string;
      readonly title: string;
      readonly summary: string;
      readonly body: string;
    }
  | {
      readonly kind: "ask";
      readonly id: string;
      readonly meta?: string;
      readonly question: PreviewAskQuestion;
    }
  | {
      readonly kind: "form";
      readonly id: string;
      readonly meta?: string;
      readonly title: string;
      readonly summary: string;
      readonly form: InteractionForm;
    };

export const PREVIEW_DECK_ITEMS: readonly PreviewDeckItem[] = [
  {
    kind: "plan",
    id: "preview:deck:plan",
    meta: "主 Agent · 14:09",
    title: "Preview 缩放惯性",
    summary: "冻结 Preview 缩放协议，补上拖拽惯性开关，再用类型检查确认 Mermaid 全屏路径。",
    body: [
      "## 目标",
      "",
      "冻结 Preview **缩放协议**，补上拖拽惯性开关，再用类型检查确认 Mermaid 全屏路径。",
      "",
      "## 实施步骤",
      "",
      "1. 核对现有 Preview 面板的 pan / zoom 事件，列出惯性开关要接的状态。",
      "2. 默认关闭惯性；打开后松手继续滑行，用 `velocity *= 0.92` 衰减。",
      "3. 全屏 Mermaid 走同一套拖拽协议，避免第二套手势。",
      "4. 跑类型检查，确认 `MermaidBlock` 全屏路径没有回归。",
      "",
      "## 验收",
      "",
      "- 预览开：Plan 卡能读到这份正文，右上角可放大。",
      "- 预览关：不填假计划。",
      "",
      "```ts",
      "if (inertia) {",
      "  velocity *= 0.92;",
      "  pan += velocity;",
      "}",
      "```",
      "",
      "完成后把开关接到 Preview 面板，并在对话里确认 Ask 卡的惯性问题仍然排队在本计划之后。",
    ].join("\n"),
  },
  {
    kind: "form",
    id: "preview:deck:form:inertia",
    meta: "preview 子 Agent · 14:08",
    title: "Agent 提问",
    summary: "确认 Preview 拖拽与缩放的默认行为",
    form: PREVIEW_FORM_SHORT,
  },
  {
    kind: "form",
    id: "preview:deck:form:parameters",
    meta: "preview 子 Agent · 14:08",
    title: "Agent 提问",
    summary: "确认惯性参数、设置入口与验收条件",
    form: PREVIEW_FORM_LONG,
  },
];
