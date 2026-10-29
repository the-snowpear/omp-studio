import type { StudioClient, ClientBootstrap, DiagnosticReadModel, EnvironmentReadModel, HomeReadModel, SessionHistoryReadModel, WorkspaceListReadModel, WorkspaceId } from "@omp-studio/client-contract";
import type { OperatorCommandManifest } from "@omp-studio/studio-protocol";
import { queryWithTimeout } from "./updateCheck";

export interface ShellModel {
  environment?: EnvironmentReadModel;
  capabilities?: ClientBootstrap["capabilityManifest"];
  commandManifest?: OperatorCommandManifest;
  diagnostics?: DiagnosticReadModel;
  history?: SessionHistoryReadModel;
  home?: HomeReadModel;
  workspaces?: WorkspaceListReadModel;
}

export interface ShellModelScope {
  authority: string;
  workspace: string;
  runtime: string;
  environment: string;
  workspaceId?: WorkspaceId | undefined;
  connecting?: boolean;
}

export function createShellModelLoader(client: StudioClient) {
  const pending = new Map<string, Promise<ShellModel>>();
  const committed = new Map<string, string>();
  const selected = new Map<string, string>();
  function once(scope: string, name: string, load: () => Promise<ShellModel>) {
    const key = `${scope}:${name}`;
    let request = pending.get(key);
    if (!request) {
      request = load().finally(() => { if (pending.get(key) === request) pending.delete(key); });
      pending.set(key, request);
    }
    return request;
  }
  return {
    async load(scope: ShellModelScope, route: string, publish: (value: ShellModel) => void | boolean, projectsSettled: () => void) {
      const requests: Promise<unknown>[] = [];
      const add = (name: string, key: string, load: () => Promise<ShellModel>) => {
        selected.set(name, key);
        if (committed.get(name) === key) return Promise.resolve();
        // A transient timeout must not leave a domain permanently empty: retry
        // once, then say so instead of swallowing the failure in allSettled.
        const attempt = (retry: boolean): Promise<void> =>
          once(key, name, load).then(value => {
            if (selected.get(name) !== key) return;
            if (publish(value) !== false) committed.set(name, key);
          }).catch(error => {
            if (selected.get(name) !== key) return;
            if (retry) return attempt(false);
            console.warn(`[omp-studio] shell model ${name} failed`, error);
          });
        const request = attempt(true);
        requests.push(request);
        return request;
      };
      void add("projects", scope.authority, async () => ({ workspaces: await client.query("projects.list", {}) })).then(projectsSettled, projectsSettled);
      if (!scope.connecting) {
        add("capabilities", scope.runtime, async () => ({ capabilities: await client.query("capabilities.get", {}) }));
        add("commands", scope.runtime, async () => ({ commandManifest: await client.query("commands.getManifest", {}) }));
      }
      add("history", scope.workspace, async () => ({ history: await client.query("history.list", { limit: 20, status: "active", ...(scope.workspaceId === undefined ? {} : { workspaceId: scope.workspaceId }) }) }));
      if (!scope.connecting) add("environment", scope.environment, async () => ({ environment: await queryWithTimeout(() => client.query("environment.get", {})) }));
      if (route === "home") add("home", scope.workspace, async () => ({ home: await client.query("home.get", {}) }));
      if (route === "diagnostics") add("diagnostics", scope.environment, async () => ({ diagnostics: await client.query("diagnostics.get", {}) }));
      await Promise.allSettled(requests);
    },
    async page(scope: ShellModelScope, route: string, publish: (value: ShellModel) => void) {
      const run = async (name: string, key: string, load: () => Promise<ShellModel>) => {
        try {
          publish(await once(key, name, load));
        } catch (error) {
          // Page loads are optional; a failure should not surface as an
          // unhandled rejection from the fire-and-forget caller.
          console.warn(`[omp-studio] shell model ${name} failed`, error);
        }
      };
      if (route === "home") await run("home", scope.workspace, async () => ({ home: await client.query("home.get", {}) }));
      if (route === "diagnostics") await run("diagnostics", scope.environment, async () => ({ diagnostics: await client.query("diagnostics.get", {}) }));
    },
  };
}
