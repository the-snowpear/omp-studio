import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InteractionId, SessionId } from "@omp-studio/client-contract";
import type { FormAnswerData, FormChoiceField, FormTextField, InteractionForm, InteractionFormField } from "@omp-studio/studio-protocol";
import { FormSession, type FormInteraction, type FormResponder, type ReadInteractionForm } from "./FormSession";

const owners: Array<{ session: FormSession; key: symbol }> = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-12T00:00:00Z")); });
afterEach(() => {
  for (const { session, key } of owners.splice(0)) { session.close(); session.detach(key); }
  vi.useRealTimers();
});

function text(id: string, name: string, value = "", type = "text"): FormTextField {
  return { kind: "text", id, name, question: name || "Unnamed", label: [{ text: name || "Unnamed" }], type, multiline: false, value, placeholder: "", required: false, rows: 1 };
}
function choices(id: string, name: string, multi = false, other = true): FormChoiceField {
  return { kind: "choice", id, name, question: name, label: [], required: false, multi, other, select: false, options: [
    { value: "a", label: [{ text: "Alpha" }], checked: false, disabled: false },
    { value: "b", label: [{ text: "Beta" }], checked: false, disabled: false },
  ] };
}
function form(fields: InteractionFormField[], hidden: [string, string][] = [], defaults: FormAnswerData = {}): InteractionForm {
  return { fields, hidden, defaults, sections: [{ title: [{ text: "Details" }], fieldset: true, blocks: fields.map(field => ({ kind: "field", fieldId: field.id })) }] };
}
function interaction(timeoutMs?: number): FormInteraction {
  return { kind: "form", interactionId: "form-session" as InteractionId, sessionId: "session" as SessionId, leaseGeneration: 1, title: "Details", summary: "Details", fieldCount: 1, sectionCount: 1, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}
async function opened(dto: InteractionForm, timeoutMs?: number, active = true) {
  const session = new FormSession(interaction(timeoutMs));
  const key = Symbol("surface");
  const respond = vi.fn<FormResponder>(() => Promise.resolve(true));
  owners.push({ session, key });
  session.attach(key, respond, false, active);
  await session.load(() => Promise.resolve(dto));
  return { session, key, respond };
}

it("preserves native hidden and earlier duplicate contributions instead of deleting unchecked names", async () => {
  const later = choices("later", "shared", true, false);
  later.options = [later.options[0]!]; // A lone checkbox gives a scalar, not an array.
  const enabled = { ...later, id: "enabled", name: "enabled", question: "Enabled" };
  const empty = choices("empty", "empty", true, false);
  const { session } = await opened(form([
    text("qty", "qty", "2", "number"), text("unnamed", "", "private"), text("earlier", "shared", "earlier"), later, enabled, empty,
  ], [["kind", "deploy"], ["enabled", "hidden-off"]], { kind: "deploy", enabled: "hidden-off", qty: 2, shared: "earlier", empty: [] }));
  session.setText("qty", "2.50");
  session.choose("later", 0);
  expect(session.payload().data).toEqual({ kind: "deploy", enabled: "hidden-off", qty: 2.5, shared: "a", empty: [] });
  session.choose("later", 0);
  expect(session.payload().data).toEqual({ kind: "deploy", enabled: "hidden-off", qty: 2.5, shared: "earlier", empty: [] });
});

it("counts a selected empty option value as filled without changing its native submitted value", async () => {
  const choice = choices("choice", "choice", false, false);
  choice.required = true;
  choice.options[1] = { ...choice.options[1]!, value: "" };
  const { session } = await opened(form([choice, { ...text("text", "text"), required: true }], [], { text: "" }));
  session.choose("choice", 1);
  expect(session.getMeta().filled).toBe(1);
  expect(session.payload().data).toEqual({ choice: "", text: "" });
  expect(await session.submit()).toBe(false);
  expect(session.getView().focusField).toBe("text");
});

it("keeps native Other text private after a radio pick and emits notes only for checked options in form order", async () => {
  const { session } = await opened(form([choices("single", "single"), choices("multi", "multi", true)]));
  session.choose("single", 0);
  session.setNote("single", 0, "Only Alpha");
  session.setOther("single", "  Custom storage  ");
  session.choose("multi", 1);
  session.setNote("multi", 1, "Second note");
  session.choose("multi", 0);
  session.setNote("multi", 0, " First note ");
  session.setOther("multi", " Also archive ");
  expect(session.payload()).toEqual({ data: { single: "Custom storage", multi: ["a", "b", "Also archive"] }, notes: [
    { name: "multi", question: "multi", option: "Alpha", value: "a", text: "First note" },
    { name: "multi", question: "multi", option: "Beta", value: "b", text: "Second note" },
  ] });
  session.choose("single", 1);
  expect(session.payload().data.single).toBe("b");
  expect(session.getDraft("single").other).toBe("  Custom storage  ");
  session.choose("single", 0);
  expect(session.payload().notes?.[0]).toMatchObject({ name: "single", text: "Only Alpha" });
});

it("validates near the field, but inactivity submits its current unfinished numeric text rather than defaults", async () => {
  const qty = { ...text("qty", "qty", "2", "number"), required: true, min: 1 };
  const { session, respond } = await opened(form([qty], [], { qty: 2 }), 2000);
  await vi.advanceTimersByTimeAsync(1000);
  session.setText("qty", "-");
  expect(await session.submit()).toBe(false);
  expect(session.getDraft("qty").error).toBe("Enter a number");
  expect(session.getView().focusField).toBe("qty");
  await vi.advanceTimersByTimeAsync(1000);
  session.setCollapsed(true); // Native input activity resets the same countdown even while hidden.
  await vi.advanceTimersByTimeAsync(1999);
  expect(respond).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(respond).toHaveBeenCalledExactlyOnceWith("submit", { data: { qty: "-" }, timedOut: true });
  await vi.advanceTimersByTimeAsync(10000);
  expect(respond).toHaveBeenCalledTimes(1);
});

it("keeps an elapsed deadline across detach and reconnect instead of losing it or starting a second clock", async () => {
  const { session, key, respond } = await opened(form([text("qty", "qty", "2", "number")], [], { qty: 2 }), 2000);
  session.setText("qty", "5");
  await vi.advanceTimersByTimeAsync(1000);
  session.detach(key);
  await vi.advanceTimersByTimeAsync(5000);
  expect(session.getMeta().remaining).toBe(0);
  expect(respond).not.toHaveBeenCalled();
  session.attach(key, respond, true);
  await vi.advanceTimersByTimeAsync(5000);
  expect(respond).not.toHaveBeenCalled();
  session.updateSurface(key, respond, false);
  await Promise.resolve();
  expect(respond).toHaveBeenCalledExactlyOnceWith("submit", { data: { qty: 5 }, timedOut: true });
});

it("does not start inactivity for an unseen queued form", async () => {
  const { session, key, respond } = await opened(form([text("name", "name", "draft")], [], { name: "draft" }), 2000, false);
  await vi.advanceTimersByTimeAsync(10000);
  expect(respond).not.toHaveBeenCalled();
  session.updateSurface(key, respond, false, true);
  await vi.advanceTimersByTimeAsync(2000);
  expect(respond).toHaveBeenCalledExactlyOnceWith("submit", { data: { name: "draft" }, timedOut: true });
});

it("retains failed timeout data without automatic retry storms", async () => {
  const { session, key } = await opened(form([text("name", "name", "draft")], [], { name: "draft" }), 1000);
  const failed = vi.fn<FormResponder>(() => Promise.resolve(false));
  session.updateSurface(key, failed, false);
  session.setText("name", "kept draft");
  await vi.advanceTimersByTimeAsync(1000);
  expect(session.getMeta()).toMatchObject({ phase: "open", timedOut: true });
  expect(session.getMeta().error).toContain("已保留");
  expect(session.getDraft("name").text).toBe("kept draft");
  await vi.advanceTimersByTimeAsync(60000);
  expect(failed).toHaveBeenCalledTimes(1);
});

it("aborts a transient read and never installs its late body or reopens a terminal receipt", async () => {
  const session = new FormSession(interaction(1000));
  const key = Symbol("surface");
  owners.push({ session, key });
  let resolveRead: ((dto: InteractionForm) => void) | undefined;
  const read = vi.fn<ReadInteractionForm>(() => new Promise<InteractionForm>(resolve => { resolveRead = resolve; }));
  const loading = session.load(read);
  await Promise.resolve();
  const signal = read.mock.calls[0]![1];
  session.close();
  resolveRead?.(form([text("name", "name", "late body")]));
  await loading;
  expect(signal.aborted).toBe(true);
  expect(session.form).toBeUndefined();
  expect(session.getMeta().phase).toBe("closed");

  const active = await opened(form([text("name", "name", "initial")], [], { name: "initial" }));
  let resolveResponse: ((ok: boolean) => void) | undefined;
  active.session.updateSurface(active.key, () => new Promise<boolean>(resolve => { resolveResponse = resolve; }), false);
  active.session.setText("name", "old draft");
  const responding = active.session.submit();
  active.session.close(); active.session.detach(active.key);
  resolveResponse?.(false);
  expect(await responding).toBe(false);
  expect(active.session.getMeta().phase).toBe("closed");
  expect(active.session.getMeta().error).toBeUndefined();
  expect(active.session.form).toBeUndefined();
});
