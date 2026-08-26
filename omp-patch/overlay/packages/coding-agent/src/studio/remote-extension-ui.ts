import * as crypto from "node:crypto";
import type { ToolCallContext } from "@oh-my-pi/pi-agent-core";
import type {
	AutocompleteProviderFactory,
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionAskDialogResultItem,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
	ExtensionUiComponentFactory,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
	TerminalInputHandler,
} from "../extensibility/extensions/types";
import { getExtensionUISelectOptionLabel } from "../extensibility/extensions/types";
import { defaultThemes } from "../modes/theme/defaults";
import { createTheme } from "../modes/theme/loader";
import type { ThemeJson } from "../modes/theme/schema";
import type { Theme } from "../modes/theme/theme";
import type { ToolUiFactory } from "../tools/context";
import { StudioInteractionError, type StudioInteractionGateway } from "./services/interaction-port";

/**
 * Option identity used by the Studio Remote UI for the Ask "Other (type
 * your own)" entry; the Renderer maps it back to the custom-input editor.
 */
export const REMOTE_CUSTOM_INPUT_ID = "custom-input";
const OPTION_ID_PREFIX = "option:";

function toolCallCommandId(toolCall: ToolCallContext | undefined): string {
	if (toolCall === undefined) return `studio-tool:${crypto.randomUUID()}`;
	const current = toolCall.toolCalls[toolCall.index];
	return `studio-tool:${current?.id ?? "unknown"}`;
}

function isOtherOption(option: ExtensionUISelectItem): boolean {
	return typeof option === "string" ? option === "Other (type your own)" : option.label === "Other (type your own)";
}

function mapSelectValue(value: string | string[] | undefined, options: ExtensionUISelectItem[]): string | undefined {
	if (value === undefined) return undefined;
	const ids = typeof value === "string" ? [value] : value;
	if (ids.length === 0) return undefined;
	if (ids.length > 1) {
		throw new StudioInteractionError(
			"INVALID_ARGUMENT",
			"Select interaction returned multiple values for a single-choice prompt",
		);
	}
	const id = ids[0]!;
	if (id === REMOTE_CUSTOM_INPUT_ID) return "Other (type your own)";
	if (id.startsWith(OPTION_ID_PREFIX)) {
		const index = Number(id.slice(OPTION_ID_PREFIX.length));
		if (Number.isSafeInteger(index) && index >= 0 && index < options.length) {
			return getExtensionUISelectOptionLabel(options[index]!);
		}
		// An out-of-range option reference is a protocol fault, not an answer;
		// echoing it back as free text would surface "option:99" to the tool.
		throw new StudioInteractionError("INVALID_ARGUMENT", "Select interaction returned an unknown option id");
	}
	// Studio Ask card submits the typed custom answer as plain text.
	if (id.trim().length > 0) return id;
	throw new StudioInteractionError("INVALID_ARGUMENT", "Select interaction returned an unknown option id");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mapAskDialogValue(value: unknown, questions: ExtensionAskDialogQuestion[]): ExtensionAskDialogResult {
	if (!isRecord(value) || !Array.isArray(value.results) || value.results.length !== questions.length) {
		throw new StudioInteractionError(
			"INVALID_ARGUMENT",
			"Ask interaction returned a result count that does not match the requested questions",
		);
	}
	const mapped: ExtensionAskDialogResultItem[] = [];
	for (let index = 0; index < questions.length; index++) {
		const question = questions[index]!;
		const raw = value.results[index];
		if (!isRecord(raw) || raw.id !== question.id) {
			throw new StudioInteractionError(
				"INVALID_ARGUMENT",
				"Ask interaction returned results that do not match the requested question order",
			);
		}
		if (!Array.isArray(raw.selectedOptions) || raw.selectedOptions.some(entry => typeof entry !== "string")) {
			throw new StudioInteractionError("INVALID_ARGUMENT", "Ask interaction returned invalid selected options");
		}
		const labels = question.options.map(option => option.label);
		for (const selected of raw.selectedOptions) {
			if (!labels.includes(selected)) {
				throw new StudioInteractionError("INVALID_ARGUMENT", "Ask interaction returned an unknown option");
			}
		}
		const customInput = raw.customInput;
		if (customInput !== undefined && (typeof customInput !== "string" || customInput.trim().length === 0)) {
			throw new StudioInteractionError("INVALID_ARGUMENT", "Ask interaction returned an invalid custom input");
		}
		mapped.push({
			id: question.id,
			question: question.question,
			options: labels,
			multi: question.multi === true,
			selectedOptions: raw.selectedOptions as string[],
			...(typeof customInput === "string" ? { customInput } : {}),
		});
	}
	return { kind: "submit", results: mapped };
}

/**
 * Remote Extension UI adapter for the Studio headless Runtime. Every
 * blocking dialog (select / confirm / input / editor / askDialog) becomes a
 * Remote interaction card on the Bridge. Non-blocking UI capabilities
 * (notify, status, widgets, custom components, terminal input, theme/title
 * manipulation) are safe no-ops or explicit "not supported" failures — they
 * never touch the Bridge.
 */
export class StudioRemoteExtensionUiContext implements ExtensionUIContext {
	#fallbackTheme: Theme | undefined;

	constructor(
		private readonly gateway: StudioInteractionGateway,
		private readonly commandId: string,
	) {}

	async select(
		title: string,
		options: ExtensionUISelectItem[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		const remoteOptions = options.map((option, index) => ({
			id: isOtherOption(option) ? REMOTE_CUSTOM_INPUT_ID : `${OPTION_ID_PREFIX}${index}`,
			label: getExtensionUISelectOptionLabel(option),
			...(typeof option === "object" && option.description !== undefined ? { description: option.description } : {}),
		}));
		const value = await this.#runWithCancel(
			() =>
				this.gateway.select({
					commandId: this.commandId,
					title,
					options: remoteOptions,
				}),
			dialogOptions,
		);
		return mapSelectValue(value, options);
	}

	askDialog = async (
		questions: ExtensionAskDialogQuestion[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<ExtensionAskDialogResult | undefined> => {
		const remoteQuestions = questions.map(question => ({
			id: question.id,
			question: question.question,
			...(question.header?.trim() ? { header: question.header.trim() } : {}),
			options: question.options.map((option, index) => ({
				id: `${OPTION_ID_PREFIX}${index}`,
				label: option.label,
				...(option.description !== undefined ? { description: option.description } : {}),
				...(option.preview !== undefined ? { preview: option.preview } : {}),
			})),
			...(question.multi !== undefined ? { multiple: question.multi } : {}),
			...(question.recommended !== undefined ? { recommended: question.recommended } : {}),
		}));
		const value = await this.#runWithCancel(
			() =>
				this.gateway.ask({
					commandId: this.commandId,
					title: "Agent 提问",
					questions: remoteQuestions,
				}),
			dialogOptions,
		);
		if (value === undefined) return undefined;
		return mapAskDialogValue(value, questions);
	};

	async confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean> {
		return await this.#runWithCancel(
			() => this.gateway.confirm({ commandId: this.commandId, title, message }),
			dialogOptions,
		);
	}

	async input(
		title: string,
		placeholder?: string,
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return await this.#runWithCancel(
			() =>
				this.gateway.input({
					commandId: this.commandId,
					title,
					...(placeholder === undefined ? {} : { placeholder }),
				}),
			dialogOptions,
		);
	}

	async approveTool(
		input: {
			toolName: string;
			toolCallId: string;
			title: string;
			reason?: string;
			details: unknown;
			approvalMode: "always-ask" | "write" | "yolo";
		},
		options?: ExtensionUIDialogOptions,
	): Promise<boolean> {
		return await this.#runWithCancel(
			() =>
				this.gateway.approve({
					commandId: this.commandId,
					title: input.title,
					approvalType: input.toolName,
					details: input.details,
				}),
			options,
		);
	}

	async editor(
		title: string,
		prefill?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined> {
		return await this.#runWithCancel(
			() =>
				this.gateway.editor({
					commandId: this.commandId,
					title,
					...(prefill === undefined ? {} : { content: prefill }),
					...(editorOptions?.promptStyle === undefined ? {} : { promptStyle: editorOptions.promptStyle }),
				}),
			dialogOptions,
		);
	}

	notify(_message: string, _type?: "info" | "warning" | "error"): void {
		// Non-blocking UI is a safe no-op on the Remote surface.
	}

	onTerminalInput(_handler: TerminalInputHandler): () => void {
		return () => {};
	}

	setStatus(_key: string, _text: string | undefined): void {
		// Non-blocking UI is a safe no-op on the Remote surface.
	}

	setWorkingMessage(_message?: string): void {
		// Non-blocking UI is a safe no-op on the Remote surface.
	}

	setWidget(_key: string, _content: ExtensionWidgetContent, _options?: ExtensionWidgetOptions): void {
		// Widgets are not supported on the Remote surface.
	}

	setFooter(_factory: ExtensionUiComponentFactory | undefined): void {
		// Custom footer components are not supported on the Remote surface.
	}

	setHeader(_factory: ExtensionUiComponentFactory | undefined): void {
		// Custom header components are not supported on the Remote surface.
	}

	setTitle(_title: string): void {
		// Title control is not supported on the Remote surface.
	}

	custom<T>(): Promise<T> {
		throw new Error("custom UI is not supported by the Studio remote UI");
	}

	setEditorText(_text: string): void {
		// Editor injection is not supported on the Remote surface.
	}

	pasteToEditor(_text: string): void {
		// Editor injection is not supported on the Remote surface.
	}

	getEditorText(): string {
		return "";
	}

	addAutocompleteProvider(_factory: AutocompleteProviderFactory): void {
		// Autocomplete composition is not supported on the Remote surface.
	}

	setEditorComponent(): void {
		// Custom editor components are not supported on the Remote surface.
	}

	get theme(): Theme {
		// The module-level `theme` singleton is only assigned after TUI theme
		// initialization; headless Studio contexts fall back to a static
		// default so Ask helpers (e.g. the "Done selecting" label) never
		// dereference an uninitialized global.
		if (this.#fallbackTheme === undefined) {
			const firstDefault = Object.values(defaultThemes)[0];
			this.#fallbackTheme = createTheme(firstDefault as ThemeJson);
		}
		return this.#fallbackTheme;
	}

	getAllThemes(): Promise<{ name: string; path: string | undefined }[]> {
		return Promise.resolve([]);
	}

	getTheme(_name: string): Promise<Theme | undefined> {
		return Promise.resolve(undefined);
	}

	setTheme(_theme: string | Theme): Promise<{ success: boolean; error?: string }> {
		return Promise.resolve({ success: false, error: "Theme switching is not supported by the Studio remote UI" });
	}

	getToolsExpanded(): boolean {
		return false;
	}

	setToolsExpanded(_expanded: boolean): void {
		// Tool expansion is not supported on the Remote surface.
	}

	/**
	 * Abort / timeout handling: cancel the Remote interaction and surface an
	 * AbortError so the Ask fallback converges and no card is left behind.
	 */
	async #runWithCancel<T>(run: () => Promise<T>, dialogOptions?: ExtensionUIDialogOptions): Promise<T> {
		const signal = dialogOptions?.signal;
		if (signal === undefined) return await run();
		const abortOutcome = (): "aborted" | "expired" => {
			const reason = signal.reason;
			return reason instanceof DOMException && reason.name === "TimeoutError" ? "expired" : "aborted";
		};
		if (signal.aborted) {
			const outcome = abortOutcome();
			this.#cancel(outcome === "expired" ? "Interaction expired" : "Interaction aborted", outcome);
			throw new DOMException("Aborted", "AbortError");
		}
		let cancelled = false;
		const onAbort = () => {
			cancelled = true;
			const outcome = abortOutcome();
			this.#cancel(outcome === "expired" ? "Interaction expired" : "Interaction aborted", outcome);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			return await run();
		} catch (error) {
			if (cancelled) throw new DOMException("Aborted", "AbortError");
			throw error;
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	#cancel(reason: string, outcome: "aborted" | "expired" = "aborted"): void {
		try {
			this.gateway.cancel(reason, outcome);
		} catch {
			// Interaction already resolved or closed; nothing to cancel.
		}
	}
}

/**
 * Tool UI factory for the Studio headless Runtime (plan §2.4): each tool
 * call gets a Remote UI context bound to an internal `studio-tool:<id>`
 * commandId reused across that call's questions.
 */
export function createStudioRemoteUiFactory(gateway: StudioInteractionGateway): ToolUiFactory {
	return (toolCall?: ToolCallContext) => new StudioRemoteExtensionUiContext(gateway, toolCallCommandId(toolCall));
}
