import { join } from "node:path";
import { RuntimeInstaller, type ActivateOptions, type RuntimeInstallerOptions } from "@omp-studio/runtime-installer";
import type { RuntimePreference, SessionBinding } from "@omp-studio/studio-protocol";
import { resolveRuntime, type RuntimeResolution, type RuntimeResolverEnvironment } from "./runtime-resolver.js";
import { ThreadBindingStore } from "./thread-binding-store.js";

export interface HostBackendOptions {
  stateDirectory: string;
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
    this.bindings = new ThreadBindingStore(join(options.stateDirectory, "thread-bindings.json"));
    this.installer = new RuntimeInstaller(join(options.stateDirectory, "runtimes"), {
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
      managedLookup: { current: async () => await this.installer.currentManifest() },
    });
  }

  async install(artifactDirectory: string) {
    return await this.installer.install(artifactDirectory);
  }

  async activate(runtimeVersion: string, options?: ActivateOptions) {
    return await this.installer.activate(runtimeVersion, options);
  }

  async bind(binding: SessionBinding, executableIdentity: string): Promise<void> {
    await this.bindings.bind(binding, executableIdentity);
  }

  async unbind(binding: SessionBinding): Promise<void> {
    await this.bindings.unbind(binding.threadId);
  }
}
