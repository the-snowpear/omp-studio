import { useEffect, useMemo, useRef } from "react";
import type { ClientInteraction } from "@omp-studio/client-contract";
import type {
  FormAnswerData, FormAnswerValue, FormChoiceField, FormOptionNote, FormSubmitValue,
  InteractionForm, InteractionFormField,
} from "@omp-studio/studio-protocol";
import { choiceValue, fieldError, textValue } from "@oh-my-pi/pi-tui/html-form/data";
import { spansText } from "@oh-my-pi/pi-tui/html-form/model";

export type FormInteraction = Extract<ClientInteraction, { kind: "form" }>;
export type ReadInteractionForm = (interaction: FormInteraction, signal: AbortSignal) => Promise<InteractionForm>;
export type FormResponder = (decision: "submit" | "cancel", value?: FormSubmitValue) => void | Promise<boolean>;

export interface FormFieldDraft {
  readonly text: string;
  readonly checked: readonly number[];
  readonly other: string;
  readonly otherEditing: boolean;
  readonly notes: Readonly<Record<number, string>>;
  readonly noteOpen: Readonly<Record<number, boolean>>;
  readonly error?: string | undefined;
}

export interface FormViewState {
  readonly collapsed: boolean;
  readonly expanded: boolean;
  readonly section: number;
  readonly focusField?: string;
  readonly focusVersion: number;
}

export interface FormMetaState {
  readonly phase: "loading" | "open" | "submitting" | "closed";
  readonly filled: number;
  readonly total: number;
  readonly remaining?: number | undefined;
  readonly timedOut?: boolean | undefined;
  readonly error?: string | undefined;
}

type Listener = () => void;
type Surface = { respond: FormResponder; disabled: boolean; active: boolean };
const EMPTY_DRAFT: FormFieldDraft = { text: "", checked: [], other: "", otherEditing: false, notes: {}, noteOpen: {} };

/** One transient owner per native interaction. No persistence, input transport or second timeout owner. */
export class FormSession {
  readonly interaction: FormInteraction;
  form: InteractionForm | undefined;
  #drafts = new Map<string, FormFieldDraft>();
  #fields = new Map<string, InteractionFormField>();
  #fieldListeners = new Map<string, Set<Listener>>();
  #viewListeners = new Set<Listener>();
  #metaListeners = new Set<Listener>();
  #surfaces = new Map<symbol, Surface>();
  #view: FormViewState = { collapsed: false, expanded: false, section: 0, focusVersion: 0 };
  #meta: FormMetaState;
  #deadline = 0;
  #tick: number | undefined;
  #loading: Promise<void> | undefined;
  #reader: ReadInteractionForm | undefined;
  #readAbort = new AbortController();
  #pendingTimeout: FormSubmitValue | undefined;
  #timeoutAttempted = false;
  #countdownStarted = false;

  constructor(interaction: FormInteraction) {
    this.interaction = interaction;
    this.#meta = { phase: "loading", filled: 0, total: interaction.fieldCount };
  }

  getView = (): FormViewState => this.#view;
  getMeta = (): FormMetaState => this.#meta;
  getDraft = (id: string): FormFieldDraft => this.#drafts.get(id) ?? EMPTY_DRAFT;
  subscribeView = (listener: Listener): (() => void) => { this.#viewListeners.add(listener); return () => this.#viewListeners.delete(listener); };
  subscribeMeta = (listener: Listener): (() => void) => { this.#metaListeners.add(listener); return () => this.#metaListeners.delete(listener); };
  subscribeField(id: string, listener: Listener): () => void {
    const listeners = this.#fieldListeners.get(id) ?? new Set<Listener>();
    this.#fieldListeners.set(id, listeners);
    listeners.add(listener);
    return () => { listeners.delete(listener); if (!listeners.size) this.#fieldListeners.delete(id); };
  }

  /** An identical metadata refresh or a Deck remount does not read or initialize the form again. */
  load(readForm: ReadInteractionForm): Promise<void> {
    if (this.#meta.phase === "closed") return Promise.resolve();
    this.#reader = readForm;
    if (this.form) return Promise.resolve();
    if (this.#loading) return this.#loading;
    this.#setMeta({ phase: "loading", error: undefined });
    this.#loading = Promise.resolve().then(() => this.#meta.phase === "closed" ? undefined : readForm(this.interaction, this.#readAbort.signal)).then(form => {
      if (this.#meta.phase === "closed" || !form) return;
      this.form = form;
      for (const field of form.fields) {
        this.#fields.set(field.id, field);
        const checked: number[] = [];
        if (field.kind === "choice") for (let index = 0; index < field.options.length; index++) {
          if (!field.options[index]?.checked) continue;
          if (!field.multi) checked.length = 0; // Native dialog: the last checked radio wins.
          checked.push(index);
        }
        this.#drafts.set(field.id, { ...EMPTY_DRAFT, text: field.kind === "text" ? field.value : "", checked });
      }
      this.#setMeta({ phase: "open", total: form.fields.length, filled: this.#filled() });
      this.#setView({ ...this.#view });
      this.#startCountdown();
    }).catch(error => {
      if (this.#meta.phase !== "closed") {
        this.#loading = undefined;
        this.#setMeta({ error: error instanceof Error ? error.message : "表单读取失败，请重试。" });
      }
    });
    return this.#loading;
  }

  retryRead(): void { if (this.#reader) void this.load(this.#reader); }

  /** Queue changes and layout remounts never restart a presented form's clock. */
  attach(key: symbol, respond: FormResponder, disabled: boolean, active = true): void {
    this.#surfaces.set(key, { respond, disabled, active });
    this.#startCountdown();
    this.#flushTimeout();
  }
  updateSurface(key: symbol, respond: FormResponder, disabled: boolean, active = true): void {
    this.#surfaces.set(key, { respond, disabled, active });
    this.#startCountdown();
    this.#flushTimeout();
  }
  detach(key: symbol): void {
    this.#surfaces.delete(key);
    if (this.#meta.phase === "closed" && !this.#surfaces.size) this.#releaseDrafts();
  }

  touch(): void {
    if (this.#tick === undefined || this.interaction.timeoutMs === undefined) return;
    this.#deadline = Date.now() + this.interaction.timeoutMs;
    this.#setMeta({ remaining: Math.ceil(this.interaction.timeoutMs / 1000) });
  }

  setText(id: string, text: string): void { this.#edit(id, { text }); }
  choose(id: string, index: number): void {
    const field = this.#fields.get(id);
    if (field?.kind !== "choice" || !field.options[index] || field.options[index].disabled) return;
    const draft = this.getDraft(id);
    const checked = field.multi
      ? draft.checked.includes(index) ? draft.checked.filter(value => value !== index) : [...draft.checked, index]
      : [index];
    this.#edit(id, { checked, otherEditing: false });
  }
  openOther(id: string): void { this.#edit(id, { otherEditing: true }); }
  setOther(id: string, other: string): void {
    const field = this.#fields.get(id);
    if (field?.kind !== "choice" || !field.other) return;
    const changed = other !== this.getDraft(id).other;
    this.#edit(id, { other, otherEditing: true, ...(!field.multi && changed && other.trim() ? { checked: [] } : {}) });
  }
  openNote(id: string, index: number): void { this.#edit(id, { noteOpen: { ...this.getDraft(id).noteOpen, [index]: true } }); }
  setNote(id: string, index: number, text: string): void {
    this.#edit(id, { notes: { ...this.getDraft(id).notes, [index]: text } });
  }
  validateField(id: string): void {
    const field = this.#fields.get(id);
    if (field && this.#meta.phase === "open") this.#patch(id, { error: fieldError(field, this.value(field)) });
  }
  otherChosen(field: FormChoiceField): boolean {
    const draft = this.getDraft(field.id);
    return field.other && draft.other.trim() !== "" && (field.multi || draft.checked.length === 0);
  }
  value(field: InteractionFormField): FormAnswerValue | undefined {
    const draft = this.getDraft(field.id);
    return field.kind === "text" ? textValue(field, draft.text)
      : choiceValue(field, new Set(draft.checked), this.otherChosen(field) ? draft.other : undefined);
  }
  payload(timedOut = false): FormSubmitValue {
    // Native HtmlFormDialog starts with hidden controls, then applies only contributing fields in order.
    // Starting with defaultFormData and deleting unchecked names would lose hidden/earlier duplicate values.
    const data: FormAnswerData = Object.fromEntries(this.form?.hidden ?? []);
    const notes: FormOptionNote[] = [];
    for (const field of this.form?.fields ?? []) {
      if (!field.name) continue;
      const value = this.value(field);
      if (value !== undefined) Object.defineProperty(data, field.name, { value, enumerable: true, configurable: true, writable: true });
      if (field.kind !== "choice") continue;
      const draft = this.getDraft(field.id);
      field.options.forEach((option, index) => {
        const text = draft.notes[index]?.trim();
        if (!draft.checked.includes(index) || option.disabled || !text) return;
        notes.push({ name: field.name, question: field.question, option: spansText(option.label).replace(/\s+/g, " ").trim() || option.value, value: option.value, text });
      });
    }
    return { data, ...(notes.length ? { notes } : {}), ...(timedOut ? { timedOut: true } : {}) };
  }

  setCollapsed(collapsed: boolean): void { this.touch(); this.#setView({ ...this.#view, collapsed }); }
  setExpanded(expanded: boolean): void { this.touch(); this.#setView({ ...this.#view, expanded }); }
  setSection(section: number): void { this.touch(); this.#setView({ ...this.#view, section }); }
  focusField(id: string): void {
    const section = this.form?.sections.findIndex(group => group.blocks.some(block => block.kind === "field" && block.fieldId === id)) ?? 0;
    this.#setView({ ...this.#view, collapsed: false, section: Math.max(0, section), focusField: id, focusVersion: this.#view.focusVersion + 1 });
  }

  async submit(timedOut = this.#meta.timedOut === true): Promise<boolean> {
    if (this.#meta.phase !== "open" || !this.form) return false;
    const surface = this.#responseSurface();
    if (!surface) return false;
    if (!timedOut) {
      let first: string | undefined;
      for (const field of this.form.fields) {
        const error = fieldError(field, this.value(field));
        this.#patch(field.id, { error });
        if (error && !first) first = field.id;
      }
      if (first) { this.focusField(first); return false; }
    }
    this.#pendingTimeout = undefined;
    return this.#respond(surface, "submit", this.payload(timedOut));
  }
  async cancel(): Promise<boolean> {
    const surface = this.#responseSurface();
    if (!surface || this.#meta.phase === "submitting" || this.#meta.phase === "closed") return false;
    this.#pendingTimeout = undefined;
    return this.#respond(surface, "cancel");
  }

  /** Terminal/lease fencing stops the only timer and rejects late reads or receipts. */
  close(): void {
    if (this.#meta.phase === "closed") return;
    this.#stopCountdown();
    this.#readAbort.abort();
    this.#reader = undefined;
    this.#pendingTimeout = undefined;
    this.#loading = undefined;
    this.#setMeta({ phase: "closed", remaining: undefined, error: undefined });
    // Keep the already mounted exit picture until it detaches; no closed session can edit/read/respond.
    if (!this.#surfaces.size) this.#releaseDrafts();
  }

  #releaseDrafts(): void { this.form = undefined; this.#drafts.clear(); this.#fields.clear(); }
  #edit(id: string, patch: Partial<FormFieldDraft>): void {
    if (this.#meta.phase !== "open" || !this.#fields.has(id)) return;
    this.touch(); this.#patch(id, { ...patch, error: undefined });
    this.#setMeta({ filled: this.#filled(), error: undefined, timedOut: undefined });
  }
  #patch(id: string, patch: Partial<FormFieldDraft>): void {
    this.#drafts.set(id, { ...this.getDraft(id), ...patch });
    for (const listener of this.#fieldListeners.get(id) ?? []) listener();
  }
  #filled(): number {
    return [...this.#fields.values()].filter(field => {
      if (field.kind === "choice") return this.otherChosen(field) || this.getDraft(field.id).checked.some(index => field.options[index]?.disabled === false);
      return String(this.value(field) ?? "").trim() !== "";
    }).length;
  }
  #setView(view: FormViewState): void { this.#view = view; for (const listener of this.#viewListeners) listener(); }
  #setMeta(patch: Partial<FormMetaState>): void {
    const next = { ...this.#meta, ...patch };
    if (Object.keys(next).every(key => next[key as keyof FormMetaState] === this.#meta[key as keyof FormMetaState])) return;
    this.#meta = next; for (const listener of this.#metaListeners) listener();
  }
  #responseSurface(): Surface | undefined {
    const surfaces = [...this.#surfaces.values()].reverse();
    return surfaces.find(surface => surface.active && !surface.disabled) ?? surfaces.find(surface => !surface.disabled);
  }
  async #respond(surface: Surface, decision: "submit" | "cancel", value?: FormSubmitValue): Promise<boolean> {
    this.#stopCountdown(); this.#setMeta({ phase: "submitting", error: undefined, remaining: undefined });
    try {
      const ok = await surface.respond(decision, value);
      if (ok === false) throw new Error("提交失败，表单与已填写内容已保留。请重试。");
      this.close(); return true;
    } catch (error) {
      if (this.#meta.phase !== "closed") this.#setMeta({ phase: "open", error: error instanceof Error ? error.message : "提交失败，请重试。" });
      return false;
    }
  }
  #startCountdown(): void {
    const timeout = this.interaction.timeoutMs;
    if (this.#countdownStarted || this.#meta.phase !== "open" || ![...this.#surfaces.values()].some(surface => surface.active) || timeout === undefined || timeout <= 0) return;
    this.#countdownStarted = true;
    this.#deadline = Date.now() + timeout;
    this.#setMeta({ remaining: Math.ceil(timeout / 1000) });
    this.#tick = window.setInterval(() => {
      const left = this.#deadline - Date.now();
      if (left <= 0) {
        this.#stopCountdown();
        this.#pendingTimeout = this.payload(true);
        this.#setMeta({ remaining: 0, timedOut: true });
        this.#flushTimeout();
      } else this.#setMeta({ remaining: Math.ceil(left / 1000) });
    }, Math.min(1000, timeout));
  }
  #flushTimeout(): void {
    const value = this.#pendingTimeout;
    const surface = this.#responseSurface();
    if (!value || !surface || this.#timeoutAttempted || this.#meta.phase !== "open") return;
    this.#timeoutAttempted = true;
    this.#pendingTimeout = undefined;
    void this.#respond(surface, "submit", value);
  }
  #stopCountdown(): void { if (this.#tick !== undefined) window.clearInterval(this.#tick); this.#tick = undefined; }
}

/** Active owners and small, scrubbed tombstones prevent an exit/remount from reviving a terminal identity. */
const liveSessions = new Map<string, FormSession>();
const interactionKey = (interaction: Pick<FormInteraction, "sessionId" | "interactionId" | "leaseGeneration">) => `${interaction.sessionId}:${interaction.interactionId}:${interaction.leaseGeneration}`;

export function closeFormSession(interaction: Pick<FormInteraction, "sessionId" | "interactionId" | "leaseGeneration">): void {
  liveSessions.get(interactionKey(interaction))?.close();
}

/** Use at an actual-pending owner, not as an unmount cleanup: layout/route remount is not a terminal event. */
export function useFormInteractionLifecycle(interaction: ClientInteraction | null): void {
  const previous = useRef<FormInteraction | null>(null);
  useEffect(() => {
    const old = previous.current;
    if (old && (interaction?.sessionId !== old.sessionId || interaction?.interactionId !== old.interactionId || interaction?.leaseGeneration !== old.leaseGeneration || interaction?.kind !== "form")) closeFormSession(old);
    previous.current = interaction?.kind === "form" ? interaction : null;
  }, [interaction?.sessionId, interaction?.interactionId, interaction?.leaseGeneration, interaction?.kind]);
}

export function useFormSession(interaction: FormInteraction, readForm: ReadInteractionForm | undefined): FormSession {
  const key = interactionKey(interaction);
  const session = useMemo(() => {
    const existing = liveSessions.get(key);
    if (existing) return existing;
    for (const [previousKey, previous] of liveSessions) {
      if (previous.interaction.sessionId === interaction.sessionId) { previous.close(); liveSessions.delete(previousKey); }
    }
    const created = new FormSession(interaction);
    liveSessions.set(key, created);
    // Only terminal, already scrubbed identities are expendable; active drafts are never evicted.
    if (liveSessions.size > 64) for (const [oldKey, old] of liveSessions) {
      if (old.getMeta().phase === "closed" && !old.form) liveSessions.delete(oldKey);
      if (liveSessions.size <= 64) break;
    }
    return created;
  }, [key]);
  useEffect(() => {
    void session.load(readForm ?? (() => Promise.reject(new Error("当前连接没有表单正文读取能力；请恢复连接或取消提问。"))));
  }, [session, readForm]);
  return session;
}
