import { useCallback, type ReactNode } from "react";
import type { CommandInput, StudioClient } from "@omp-studio/client-contract";
import type { RuntimeCatalogResultMap } from "@omp-studio/studio-protocol";
import { waitReceipt } from "../hostError";
import { Icon, type IconName } from "../icons";
import "./runtimeCatalog.css";

export interface RuntimeCatalogProps {
  client: StudioClient;
  sessionId?: string | undefined;
  available: boolean;
  visible?: boolean;
}

export function useRuntimeCatalog(client: StudioClient, sessionId?: string) {
  return useCallback(
    async <K extends keyof RuntimeCatalogResultMap>(kind: K, input: CommandInput<K>): Promise<RuntimeCatalogResultMap[K]> => {
      const handle = await client.command(kind, input);
      return (await waitReceipt<{ result: RuntimeCatalogResultMap[K] }>(client, handle.requestId)).result;
    },
    [client, sessionId],
  );
}

export function CatalogHeading({ title, description, scope, demo, actions }: {
  title: string;
  description: string;
  scope: string;
  demo?: string | undefined;
  actions?: ReactNode;
}) {
  return (
    <header className="runtime-catalog-heading">
      <div>
        <div className="runtime-catalog-scope">{scope}{demo ? <span className="runtime-catalog-demo">{demo}</span> : null}</div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      {actions ? <div className="runtime-catalog-heading-actions">{actions}</div> : null}
    </header>
  );
}

export function CatalogEmpty({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="runtime-catalog-empty">
      <Icon name={icon} />
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
    </div>
  );
}
