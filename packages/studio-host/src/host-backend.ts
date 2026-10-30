import { join } from "node:path";
import { RuntimeInstaller, type ActivateOptions, type RuntimeInstallerOptions } from "@omp-studio/runtime-installer";
import type { RuntimePreference, SessionBinding } from "@omp-studio/studio-protocol";
import {
  resolveRuntime,
  type RuntimeResolution,
  type RuntimeResolverEnvironment,
} from "./runtime-resolver.js";
import { ThreadBindingStore } from "./thread-binding-store.js";

export interface HostBackendOptions {
  stateDirectory: string;
  /**
   * Managed Runtime tree (`versions/` + `current.json`). Defaults to
   * `<stateDirectory>/runtimes`. Packaged desktop sets this to
   * `$INSTDIR/runtime` so the live `omp.exe` sits next to the app.
   */
  runtimeInstallDirectory?: string;
  installer?: Omit<RuntimeInstallerOptions, "isRuntimeReferenced">;
  resolver?: Omit<RuntimeResolverEnvironment, "managedLookup">;
}

/** Presentation-neutral composition root for installer, resolver, and Thread binding references. */
export class HostBackend {
  readonly bindings: ThreadBindingStore;
  readonly installer: RuntimeInstaller;
  readonly #resolver: Omit<RuntimeResolverEnvironment, "managedLookup">;

  constructor(options: HostBackendOptions) {
    if (options.stateDirectory.length === 0) throw new TypeError("Host backend state directory is required");
    const runtimeInstallDirectory = options.runtimeInstallDirectory ?? join(options.stateDirectory, "runtimes");
    if (runtimeInstallDirectory.length === 0) {
      throw new TypeError("Host backend runtime install directory is required");
    }
    this.bindings = new ThreadBindingStore(join(options.stateDirectory, "thread-bindings.json"));
    this.installer = new RuntimeInstaller(runtimeInstallDirectory, {
      ...options.installer,
      isRuntimeReferenced: version => this.bindings.isRuntimeReferenced(version),
    });
    this.#resolver = options.resolver ?? {};
  }

  async initialize(): Promise<void> {
    await this.bindings.load();
  }

  async resolve(preference: RuntimePreference): Promise<RuntimeResolution> {
    return resolveRuntime(preference, {
      ...this.#resolver,
      // The installer answers with the signed entrypoint digest, so the resolver
      // can prove the bytes it is about to execute without trusting the
      // installer's evidence cache.
      managedLookup: { current: async () => await this.installer.currentManifest() },
    });
  }

  /**
   * Forget every piece of Runtime verification evidence the Host holds. Call it
   * after an operation that can change the installed bytes outside this class
   * (`installer.rollback()`, a manual repair, an update that rewrote the
   * version tree): install/activate already do it for themselves.
   */
  invalidateRuntimeVerification(): void {
    this.installer.invalidate();
  }

  async install(artifactDirectory: string, options?: Parameters<RuntimeInstaller["install"]>[1]) {
    try {
      return await this.installer.install(artifactDirectory, options);
    } finally {
      this.invalidateRuntimeVerification();
    }
  }

  async activate(runtimeVersion: string, options?: ActivateOptions) {
    try {
      return await this.installer.activate(runtimeVersion, options);
    } finally {
      this.invalidateRuntimeVerification();
    }
  }

  async bind(binding: SessionBinding, executableIdentity: string): Promise<void> {
    await this.bindings.bind(binding, executableIdentity);
  }

  async unbind(binding: SessionBinding): Promise<void> {
    await this.bindings.unbind(binding.threadId);
  }
}
