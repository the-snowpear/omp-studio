import type { InteractionForm } from "@omp-studio/studio-protocol";

/** ver1 Preview inertia/default story, expressed as the native form DTO; never parsed or sent to a Host. */
export const PREVIEW_FORM_SHORT: InteractionForm = {
  sections: [
    { title: [], fieldset: false, blocks: [
      { kind: "text", heading: true, spans: [{ text: "确认 Preview 拖拽与缩放的默认行为" }] },
      { kind: "graphic", format: "svg", alt: "拖拽结束后保持精确定位，或让画面继续滑行", source: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 108"><rect x="12" y="16" width="184" height="72" rx="12" fill="var(--surface)" stroke="var(--border)"/><text x="104" y="58" fill="var(--fg)" font-size="14" text-anchor="middle">拖拽平移</text><path d="M210 52h96m-10-6 10 6-10 6" fill="none" stroke="var(--accent)" stroke-width="2"/><rect x="320" y="16" width="184" height="72" rx="12" fill="var(--surface)" stroke="var(--border)"/><text x="412" y="58" fill="var(--fg)" font-size="14" text-anchor="middle">松手后的行为</text></svg>' },
    ] },
    { title: [{ text: "惯性" }], fieldset: true, blocks: [
      { kind: "text", heading: false, spans: [{ text: "拖拽平移是否需要惯性？" }] },
      { kind: "field", fieldId: "field:0" },
    ] },
    { title: [{ text: "默认" }], fieldset: true, blocks: [
      { kind: "text", heading: false, spans: [{ text: "如果做成设置项，默认值怎么定？" }] },
      { kind: "field", fieldId: "field:1" },
    ] },
  ],
  fields: [
    { kind: "choice", id: "field:0", name: "inertia", question: "拖拽平移是否需要惯性？", multi: false, select: false, other: true, label: [], required: true, options: [
      { value: "on", label: [{ text: "需要惯性" }, { text: " · 松手后继续滑行", style: "em" }], checked: false, disabled: false },
      { value: "off", label: [{ text: "不需要" }, { text: " · 松手即停，定位更稳", style: "em" }], checked: false, disabled: false },
      { value: "setting", label: [{ text: "做成设置项" }, { text: " · 默认关闭，面板里可打开", style: "em" }], checked: true, disabled: false },
    ] },
    { kind: "choice", id: "field:1", name: "default", question: "如果做成设置项，默认值怎么定？", multi: false, select: false, other: true, label: [], required: true, options: [
      { value: "on", label: [{ text: "默认开" }], checked: false, disabled: false },
      { value: "off", label: [{ text: "默认关" }], checked: true, disabled: false },
    ] },
  ],
  hidden: [],
  defaults: { inertia: "setting", default: "off" },
};

/** A longer form exercises native fieldsets, single/multiple selects, numeric/text values and hidden defaults. */
export const PREVIEW_FORM_LONG: InteractionForm = {
  sections: [
    ...PREVIEW_FORM_SHORT.sections,
    { title: [{ text: "交互参数" }], fieldset: true, blocks: [
      { kind: "text", heading: false, spans: [{ text: "确认惯性衰减与停止阈值，保持定位手感一致。" }] },
      { kind: "field", fieldId: "field:2" },
      { kind: "field", fieldId: "field:3" },
      { kind: "field", fieldId: "field:4" },
    ] },
    { title: [{ text: "验收" }], fieldset: true, blocks: [
      { kind: "field", fieldId: "field:5" },
      { kind: "field", fieldId: "field:6" },
    ] },
  ],
  fields: [
    ...PREVIEW_FORM_SHORT.fields,
    { kind: "text", id: "field:2", name: "decay", question: "惯性衰减系数", label: [{ text: "惯性衰减系数" }], type: "number", multiline: false, value: "0.92", placeholder: "0 到 1", required: true, min: 0, max: 1, rows: 1 },
    { kind: "text", id: "field:3", name: "threshold", question: "停止阈值", label: [{ text: "停止阈值" }], type: "number", multiline: false, value: "0.01", placeholder: "像素 / 帧", required: true, min: 0, rows: 1 },
    { kind: "choice", id: "field:4", name: "scope", question: "设置入口", label: [{ text: "设置入口" }], multi: false, select: true, other: false, required: true, options: [
      { value: "panel", label: [{ text: "Preview 面板" }], checked: true, disabled: false },
      { value: "appearance", label: [{ text: "外观与布局" }], checked: false, disabled: false },
      { value: "both", label: [{ text: "两处共用同一设置" }], checked: false, disabled: false },
    ] },
    { kind: "choice", id: "field:5", name: "checks", question: "验收覆盖", label: [{ text: "验收覆盖" }], multi: true, select: true, other: false, required: false, options: [
      { value: "mouse", label: [{ text: "鼠标拖拽" }], checked: true, disabled: false },
      { value: "keyboard", label: [{ text: "键盘定位" }], checked: true, disabled: false },
      { value: "touch", label: [{ text: "触控板" }], checked: false, disabled: false },
    ] },
    { kind: "text", id: "field:6", name: "criteria", question: "验收说明", label: [{ text: "验收说明" }], type: "textarea", multiline: true, value: "关闭惯性时，松手即停。", placeholder: "补充验收条件…", required: false, rows: 3 },
  ],
  hidden: [["revision", "preview-inertia"]],
  defaults: { ...PREVIEW_FORM_SHORT.defaults, revision: "preview-inertia", decay: 0.92, threshold: 0.01, scope: "panel", checks: ["mouse", "keyboard"], criteria: "关闭惯性时，松手即停。" },
};
