/**
 * Preview Deck cards. Ask payload follows the OMP ask-tool questions schema.
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
    kind: "ask",
    id: "preview:deck:ask:inertia",
    meta: "preview 子 Agent · 14:08",
    question: {
      id: "inertia",
      question: "缩放交互确认：拖拽平移是否需要惯性？",
      header: "惯性",
      recommended: 0,
      options: [
        {
          label: "需要惯性",
          description: "松手后继续滑行，大图定位更轻松。",
          preview: "velocity *= 0.92; pan += velocity",
        },
        {
          label: "不需要",
          description: "松手即停，像素级对齐更稳。",
        },
        {
          label: "做成设置项",
          description: "默认关闭，Preview 面板里可打开。",
        },
      ],
    },
  },
  {
    kind: "ask",
    id: "preview:deck:ask:default",
    meta: "preview 子 Agent · 14:08",
    question: {
      id: "default",
      question: "如果做成设置项，**默认值**怎么定？",
      header: "默认",
      recommended: 1,
      options: [
        { label: "默认开", description: "新会话直接带惯性。" },
        { label: "默认关", description: "保持现在的精确拖拽。" },
      ],
    },
  },
];
