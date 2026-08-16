/**
 * Preview Deck cards. Ask payload follows the OMP ask-tool questions schema.
 * Plan payload follows plan-mode review actions. Display only — never sent
 * through Host / Studio Bridge / the command reducer.
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
    }
  | {
      readonly kind: "ask";
      readonly id: string;
      readonly meta?: string;
      readonly questions: readonly PreviewAskQuestion[];
    };

export const PREVIEW_DECK_ITEMS: readonly PreviewDeckItem[] = [
  {
    kind: "plan",
    id: "preview:deck:plan",
    meta: "主 Agent · 14:09",
    title: "Preview 缩放惯性",
    summary: "冻结 Preview 缩放协议，补上拖拽惯性开关，再用类型检查确认 Mermaid 全屏路径。",
  },
  {
    kind: "ask",
    id: "preview:deck:ask",
    meta: "preview 子 Agent · 14:08",
    questions: [
      {
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
      {
        id: "default",
        question: "如果做成设置项，**默认值**怎么定？",
        header: "默认",
        recommended: 1,
        options: [
          { label: "默认开", description: "新会话直接带惯性。" },
          { label: "默认关", description: "保持现在的精确拖拽。" },
        ],
      },
    ],
  },
];
