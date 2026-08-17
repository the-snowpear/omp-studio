export interface StudioLiveState {
	status: "off" | "connecting" | "active" | "stopping" | "failed";
	deviceId?: string;
}

export interface StudioLiveSessionPort {
	start(): Promise<void>;
	stop(): Promise<void>;
}

export interface StudioLiveSessionFactory {
	create(options: { deviceId?: string; onActive(): void; onTerminal(error?: Error): void }): StudioLiveSessionPort;
}

export class StudioLiveError extends Error {
	constructor(
		readonly code: "CAPABILITY_UNAVAILABLE" | "COMMAND_BLOCKED" | "INVALID_ARGUMENT",
		message: string,
	) {
		super(message);
		this.name = "StudioLiveError";
	}
}

/**
 * Presentation-neutral Live control plane. Media ownership is injected by
 * WP-061; without it start fails closed and never publishes a fake active state.
 */
export class StudioLiveService {
	#state: StudioLiveState = { status: "off" };
	#session: StudioLiveSessionPort | undefined;
	#startPromise: Promise<StudioLiveState> | undefined;
	#stopPromise: Promise<{ stopped: boolean }> | undefined;
	readonly #listeners = new Set<(state: StudioLiveState) => void>();

	constructor(private readonly factory?: StudioLiveSessionFactory) {}

	state(): StudioLiveState {
		return structuredClone(this.#state);
	}

	onChange(listener: (state: StudioLiveState) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	start(deviceId?: string): Promise<StudioLiveState> {
		if (deviceId !== undefined && deviceId.trim().length === 0) {
			throw new StudioLiveError("INVALID_ARGUMENT", "Live device id must not be empty");
		}
		if (this.factory === undefined) {
			throw new StudioLiveError(
				"CAPABILITY_UNAVAILABLE",
				"Live media sideband is unavailable until a frontend audio device is attached",
			);
		}
		if (this.#state.status !== "off") {
			throw new StudioLiveError("COMMAND_BLOCKED", "A Live session is already active or stopping");
		}
		if (this.#startPromise !== undefined) return this.#startPromise;
		this.#setState({ status: "connecting", ...(deviceId === undefined ? {} : { deviceId }) });
		let session: StudioLiveSessionPort;
		session = this.factory.create({
			...(deviceId === undefined ? {} : { deviceId }),
			onActive: () => {
				if (this.#session === session && this.#state.status === "connecting") {
					this.#setState({ status: "active", ...(deviceId === undefined ? {} : { deviceId }) });
				}
			},
			onTerminal: error => {
				if (this.#session !== session) return;
				this.#session = undefined;
				this.#setState(
					error === undefined
						? { status: "off" }
						: { status: "failed", ...(deviceId === undefined ? {} : { deviceId }) },
				);
			},
		});
		this.#session = session;
		this.#startPromise = session
			.start()
			.then(() => {
				if (this.#session === session && this.#state.status === "connecting") {
					this.#setState({ status: "active", ...(deviceId === undefined ? {} : { deviceId }) });
				}
				return this.state();
			})
			.catch(error => {
				if (this.#session === session) {
					this.#session = undefined;
					this.#setState({ status: "failed", ...(deviceId === undefined ? {} : { deviceId }) });
				}
				throw error;
			})
			.finally(() => {
				this.#startPromise = undefined;
			});
		return this.#startPromise;
	}

	stop(): Promise<{ stopped: boolean }> {
		if (this.#stopPromise !== undefined) return this.#stopPromise;
		const session = this.#session;
		if (session === undefined) {
			if (this.#state.status !== "off") this.#setState({ status: "off" });
			return Promise.resolve({ stopped: false });
		}
		this.#setState({
			status: "stopping",
			...(this.#state.deviceId === undefined ? {} : { deviceId: this.#state.deviceId }),
		});
		this.#stopPromise = session
			.stop()
			.then(() => ({ stopped: true }))
			.finally(() => {
				if (this.#session === session) this.#session = undefined;
				this.#setState({ status: "off" });
				this.#stopPromise = undefined;
			});
		return this.#stopPromise;
	}

	dispose(): void {
		void this.stop().catch(() => {});
		this.#listeners.clear();
	}

	#setState(state: StudioLiveState): void {
		this.#state = structuredClone(state);
		for (const listener of this.#listeners) {
			try {
				listener(this.state());
			} catch {
				/* Presentation listener isolation. */
			}
		}
	}
}
