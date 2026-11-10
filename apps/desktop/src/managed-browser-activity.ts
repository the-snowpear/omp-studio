/** Page activity belongs to its live WebContents, never to the persisted browser catalog. */
type PageActivity = {
  visible: boolean;
  loading: boolean;
  media: boolean;
  audible: boolean;
  devtools: boolean;
  picking: boolean;
};

const IDLE_GRACE_MS = 30_000;

export class BrowserPageActivity {
  readonly #state: PageActivity = { visible: false, loading: false, media: false, audible: false, devtools: false, picking: false };
  #holds = 0;
  #idleSince = Date.now();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #throttled: boolean | undefined;
  #disposed = false;

  constructor(readonly setThrottled: (throttled: boolean) => void) { this.#refresh(); }

  update(state: Partial<PageActivity>): void {
    const wasActive = this.#active();
    Object.assign(this.#state, state);
    if (wasActive && !this.#active()) this.#idleSince = Date.now();
    this.#refresh();
  }

  /** Hold across the entire asynchronous operation; downloads share the same lifetime rule. */
  hold(): () => void {
    this.#holds++;
    this.#refresh();
    return () => {
      this.#holds--;
      if (!this.#active()) this.#idleSince = Date.now();
      this.#refresh();
    };
  }

  #active(): boolean { return this.#holds > 0 || Object.values(this.#state).some(Boolean); }

  #refresh(): void {
    if (this.#disposed) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const active = this.#active();
    const remaining = IDLE_GRACE_MS - (Date.now() - this.#idleSince);
    const throttled = !active && remaining <= 0;
    if (this.#throttled !== throttled) {
      this.#throttled = throttled;
      this.setThrottled(throttled);
    }
    if (!active && remaining > 0) {
      this.#timer = setTimeout(() => this.#refresh(), remaining);
      this.#timer.unref();
    }
  }

  dispose(): void {
    this.#disposed = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
