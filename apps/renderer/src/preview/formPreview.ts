import type { InteractionForm } from "@omp-studio/studio-protocol";
import { isZh } from "../i18n";

/** ver1 Preview inertia/default story, expressed as the native form DTO; never parsed or sent to a Host. */
export function getPreviewFormShort(zh = isZh()): InteractionForm {
  return {
    acceptImages: true,
    sections: [
      { title: [], fieldset: false, blocks: [
        { kind: "text", heading: true, spans: [{ text: zh ? "确认 Preview 拖拽与缩放的默认行为" : "Confirm default Preview pan and zoom behavior" }] },
        {
          kind: "graphic",
          format: "svg",
          alt: zh ? "拖拽结束后保持精确定位，或让画面继续滑行" : "Keep exact placement on release, or let the canvas coast",
          source: zh
            ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 108"><rect x="12" y="16" width="184" height="72" rx="12" fill="var(--surface)" stroke="var(--border)"/><text x="104" y="58" fill="var(--fg)" font-size="14" text-anchor="middle">拖拽平移</text><path d="M210 52h96m-10-6 10 6-10 6" fill="none" stroke="var(--accent)" stroke-width="2"/><rect x="320" y="16" width="184" height="72" rx="12" fill="var(--surface)" stroke="var(--border)"/><text x="412" y="58" fill="var(--fg)" font-size="14" text-anchor="middle">松手后的行为</text></svg>'
            : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 108"><rect x="12" y="16" width="184" height="72" rx="12" fill="var(--surface)" stroke="var(--border)"/><text x="104" y="58" fill="var(--fg)" font-size="14" text-anchor="middle">Drag pan</text><path d="M210 52h96m-10-6 10 6-10 6" fill="none" stroke="var(--accent)" stroke-width="2"/><rect x="320" y="16" width="184" height="72" rx="12" fill="var(--surface)" stroke="var(--border)"/><text x="412" y="58" fill="var(--fg)" font-size="14" text-anchor="middle">After release</text></svg>',
        },
      ] },
      { title: [{ text: zh ? "惯性" : "Inertia" }], fieldset: true, blocks: [
        { kind: "text", heading: false, spans: [{ text: zh ? "拖拽平移是否需要惯性？" : "Should drag panning have inertia?" }] },
        { kind: "field", fieldId: "field:0" },
      ] },
      { title: [{ text: zh ? "默认" : "Default" }], fieldset: true, blocks: [
        { kind: "text", heading: false, spans: [{ text: zh ? "如果做成设置项，默认值怎么定？" : "If exposed as a setting, what should the default be?" }] },
        { kind: "field", fieldId: "field:1" },
      ] },
    ],
    fields: [
      { kind: "choice", id: "field:0", name: "inertia", question: zh ? "拖拽平移是否需要惯性？" : "Should drag panning have inertia?", multi: false, select: false, other: true, label: [], required: true, options: [
        { value: "on", label: [{ text: zh ? "需要惯性" : "Enable inertia" }, { text: zh ? " · 松手后继续滑行" : " · Continue gliding after release", style: "em" }], checked: false, disabled: false },
        { value: "off", label: [{ text: zh ? "不需要" : "No inertia" }, { text: zh ? " · 松手即停，定位更稳" : " · Stop immediately for precise placement", style: "em" }], checked: false, disabled: false },
        { value: "setting", label: [{ text: zh ? "做成设置项" : "Make it a setting" }, { text: zh ? " · 默认关闭，面板里可打开" : " · Off by default, toggleable in the panel", style: "em" }], checked: true, disabled: false },
      ] },
      { kind: "choice", id: "field:1", name: "default", question: zh ? "如果做成设置项，默认值怎么定？" : "If exposed as a setting, what should the default be?", multi: false, select: false, other: true, label: [], required: true, options: [
        { value: "on", label: [{ text: zh ? "默认开" : "Enabled by default" }], checked: false, disabled: false },
        { value: "off", label: [{ text: zh ? "默认关" : "Disabled by default" }], checked: true, disabled: false },
      ] },
    ],
    hidden: [],
    defaults: { inertia: "setting", default: "off" },
  };
}

export const PREVIEW_FORM_SHORT: InteractionForm = getPreviewFormShort();

/** A longer form exercises native fieldsets, single/multiple selects, numeric/text values and hidden defaults. */
export function getPreviewFormLong(zh = isZh()): InteractionForm {
  const short = getPreviewFormShort(zh);
  return {
    acceptImages: true,
    sections: [
      ...short.sections,
      { title: [{ text: zh ? "交互参数" : "Interaction parameters" }], fieldset: true, blocks: [
        { kind: "text", heading: false, spans: [{ text: zh ? "确认惯性衰减与停止阈值，保持定位手感一致。" : "Confirm the inertia decay and stop threshold to keep positioning consistent." }] },
        { kind: "field", fieldId: "field:2" },
        { kind: "field", fieldId: "field:3" },
        { kind: "field", fieldId: "field:4" },
      ] },
      { title: [{ text: zh ? "验收" : "Verification" }], fieldset: true, blocks: [
        { kind: "field", fieldId: "field:5" },
        { kind: "field", fieldId: "field:6" },
      ] },
    ],
    fields: [
      ...short.fields,
      { kind: "text", id: "field:2", name: "decay", question: zh ? "惯性衰减系数" : "Inertia decay factor", label: [{ text: zh ? "惯性衰减系数" : "Inertia decay factor" }], type: "number", multiline: false, value: "0.92", placeholder: zh ? "0 到 1" : "0 to 1", required: true, min: 0, max: 1, rows: 1 },
      { kind: "text", id: "field:3", name: "threshold", question: zh ? "停止阈值" : "Stop threshold", label: [{ text: zh ? "停止阈值" : "Stop threshold" }], type: "number", multiline: false, value: "0.01", placeholder: zh ? "像素 / 帧" : "px / frame", required: true, min: 0, rows: 1 },
      { kind: "choice", id: "field:4", name: "scope", question: zh ? "设置入口" : "Settings entry", label: [{ text: zh ? "设置入口" : "Settings entry" }], multi: false, select: true, other: false, required: true, options: [
        { value: "panel", label: [{ text: zh ? "Preview 面板" : "Preview panel" }], checked: true, disabled: false },
        { value: "appearance", label: [{ text: zh ? "外观与布局" : "Appearance & Layout" }], checked: false, disabled: false },
        { value: "both", label: [{ text: zh ? "两处共用同一设置" : "Share the setting in both places" }], checked: false, disabled: false },
      ] },
      { kind: "choice", id: "field:5", name: "checks", question: zh ? "验收覆盖" : "Verification coverage", label: [{ text: zh ? "验收覆盖" : "Verification coverage" }], multi: true, select: true, other: false, required: false, options: [
        { value: "mouse", label: [{ text: zh ? "鼠标拖拽" : "Mouse drag" }], checked: true, disabled: false },
        { value: "keyboard", label: [{ text: zh ? "键盘定位" : "Keyboard navigation" }], checked: true, disabled: false },
        { value: "touch", label: [{ text: zh ? "触控板" : "Trackpad" }], checked: false, disabled: false },
      ] },
      { kind: "text", id: "field:6", name: "criteria", question: zh ? "验收说明" : "Acceptance criteria", label: [{ text: zh ? "验收说明" : "Acceptance criteria" }], type: "textarea", multiline: true, value: zh ? "关闭惯性时，松手即停。" : "When inertia is off, stop immediately on release.", placeholder: zh ? "补充验收条件…" : "Add acceptance notes…", required: false, rows: 3 },
    ],
    hidden: [["revision", "preview-inertia"]],
    defaults: { ...short.defaults, revision: "preview-inertia", decay: 0.92, threshold: 0.01, scope: "panel", checks: ["mouse", "keyboard"], criteria: zh ? "关闭惯性时，松手即停。" : "When inertia is off, stop immediately on release." },
  };
}

export const PREVIEW_FORM_LONG: InteractionForm = getPreviewFormLong();
