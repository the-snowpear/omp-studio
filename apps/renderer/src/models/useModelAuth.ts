import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientBootstrap, StudioClient } from "@omp-studio/client-contract";
import type { ModelAuthProvider, ModelAuthProvidersResult, ModelAuthLoginResult } from "@omp-studio/studio-protocol";
import { PREVIEW_MODEL_AUTH } from "../preview/modelServicesPreview";
import { hostErrorMessage, waitReceipt } from "../hostError";

export interface ModelServiceContext {
  client: StudioClient | null;
  sessionId?: string | undefined;
  available?: boolean | undefined;
  capabilities?: ClientBootstrap["capabilityManifest"] | undefined;
}
export function modelServiceAvailable(context: ModelServiceContext, name: string): boolean {
  return !!context.sessionId && context.available === true && context.capabilities?.capabilities.some(row => row.id === name && row.grade !== "unavailable") === true;
}

/** The native sign-in waits at most 600 s; the receipt gets a little longer so the Runtime reports the timeout. */
export const NATIVE_LOGIN_WAIT_MS = 600_000;
const LOGIN_RECEIPT_MS = NATIVE_LOGIN_WAIT_MS + 15_000;

/** Native login/credential discovery only while the corresponding model surface is visible. */
export function useModelAuth(context: ModelServiceContext, preview: boolean, visible: boolean) {
  const { client, sessionId, available } = context;
  const [providers, setProviders] = useState<ModelAuthProvider[]>();
  const [busyProvider, setBusyProvider] = useState<string>();
  const [loginStartedAt, setLoginStartedAt] = useState<number>();
  const [error, setError] = useState("");
  const generation = useRef(0);
  const pending = useRef<string | undefined>(undefined);
  const loginPending = useRef<string | undefined>(undefined);
  const supported = preview || modelServiceAvailable(context, "models.auth.providers.read");
  const canLogin = preview || modelServiceAvailable(context, "models.auth.login");
  const canEdit = preview || modelServiceAvailable(context, "models.auth.key.set");
  const canUnpause = preview || modelServiceAvailable(context, "models.auth.unpause");
  const reload = useCallback(async () => {
    if (!visible || !supported || preview || !sessionId || !client) return;
    const epoch = generation.current;
    try {
      const result = await client.query("models.auth.providers.read", { sessionId });
      if (epoch === generation.current) { setProviders(result.providers); setError(""); }
    } catch (cause) { if (epoch === generation.current) { setProviders(undefined); setError(hostErrorMessage(cause, "Native credential status unavailable")); } }
  }, [client, sessionId, visible, supported, preview]);
  useEffect(() => {
    generation.current++;
    setProviders(preview ? PREVIEW_MODEL_AUTH.map(row => ({ ...row, credentials: [...row.credentials] })) : undefined);
    setBusyProvider(undefined); setLoginStartedAt(undefined); setError("");
    if (visible) void reload();
    return () => {
      generation.current++;
      const providerId = loginPending.current;
      pending.current = undefined;
      loginPending.current = undefined;
      if (!preview && providerId && sessionId && client) void client.command("models.auth.cancel", { sessionId, providerId }).catch(() => {});
    };
  }, [client, preview, sessionId, visible, available, reload, canLogin, canEdit]);

  const cancel = async () => {
    const providerId = loginPending.current;
    if (!providerId || preview || !sessionId || !client) return;
    const handle = await client.command("models.auth.cancel", { sessionId, providerId });
    await waitReceipt(client, handle.requestId);
  };
  const login = async (providerId: string): Promise<boolean> => {
    if (!visible || !canLogin || pending.current) return false;
    pending.current = providerId;
    loginPending.current = providerId;
    setBusyProvider(providerId); setLoginStartedAt(Date.now()); setError("");
    const epoch = generation.current;
    try {
      if (preview) {
        setProviders(rows => rows?.map(row => row.id === providerId ? { ...row, authenticated: true } : row));
        return true;
      }
      if (!client) return false;
      const handle = await client.command("models.auth.login", { sessionId: sessionId!, providerId });
      const result = await waitReceipt<ModelAuthLoginResult>(client, handle.requestId, LOGIN_RECEIPT_MS);
      if (epoch !== generation.current) return false;
      await reload();
      return !result.cancelled && result.authenticated;
    } catch (cause) { if (epoch === generation.current) setError(hostErrorMessage(cause, "Native login failed")); return false; }
    finally { if (epoch === generation.current) { pending.current = undefined; loginPending.current = undefined; setBusyProvider(undefined); setLoginStartedAt(undefined); } }
  };
  /** Only an explicit operator action accepts the pause warning; reads and logins never do. */
  const unpause = async (providerId: string): Promise<boolean> => {
    if (!visible || !canUnpause || pending.current) return false;
    pending.current = providerId; setBusyProvider(providerId); setError("");
    const epoch = generation.current;
    try {
      if (preview) {
        setProviders(rows => rows?.map(row => {
          if (row.id !== providerId) return row;
          const { paused: _paused, pauseReason: _reason, ...rest } = row;
          return rest;
        }));
        return true;
      }
      if (!client) return false;
      const handle = await client.command("models.auth.unpause", { sessionId: sessionId!, providerId, scope: "global", confirmed: true });
      const result = await waitReceipt<ModelAuthProvidersResult>(client, handle.requestId);
      if (epoch === generation.current) setProviders(result.providers);
      return epoch === generation.current;
    } catch (cause) { if (epoch === generation.current) setError(hostErrorMessage(cause, "Could not resume the provider")); return false; }
    finally { if (epoch === generation.current) { pending.current = undefined; setBusyProvider(undefined); } }
  };
  const key = async (providerId: string, apiKey: string | undefined, credentialId?: number): Promise<boolean> => {
    if (!visible || !canEdit || pending.current) return false;
    pending.current = providerId; setBusyProvider(providerId); setError("");
    const epoch = generation.current;
    try {
      if (preview) {
        setProviders(rows => rows?.map(row => {
          if (row.id !== providerId) return row;
          const credentials = apiKey === undefined ? row.credentials.filter(credential => credential.id !== credentialId) : [...row.credentials, { id: -Date.now(), label: "API key", type: "api_key" as const }];
          return { ...row, authenticated: credentials.length > 0, credentials };
        }));
        return true;
      }
      if (!client) return false;
      const handle = apiKey === undefined
        ? await client.command("models.auth.key.remove", { sessionId: sessionId!, providerId, credentialId: credentialId! })
        : await client.command("models.auth.key.set", { sessionId: sessionId!, providerId, apiKey });
      const result = await waitReceipt<ModelAuthProvidersResult>(client, handle.requestId);
      if (epoch === generation.current) setProviders(result.providers);
      return epoch === generation.current;
    } catch (cause) { if (epoch === generation.current) setError(hostErrorMessage(cause, "Credential update failed")); return false; }
    finally { if (epoch === generation.current) { pending.current = undefined; setBusyProvider(undefined); } }
  };
  return { providers, supported, canLogin, canEdit, canUnpause, busyProvider, loginPending: loginStartedAt !== undefined, loginStartedAt, error, reload, login, cancel, key, unpause };
}
export type ModelAuthController = {
  providers: ModelAuthProvider[] | undefined;
  supported: boolean;
  canLogin: boolean;
  canEdit: boolean;
  canUnpause?: boolean;
  busyProvider: string | undefined;
  loginPending?: boolean;
  loginStartedAt?: number | undefined;
  error: string;
  reload(): Promise<void>;
  login(providerId: string): Promise<boolean>;
  cancel(): Promise<void>;
  key(providerId: string, apiKey: string | undefined, credentialId?: number): Promise<boolean>;
  unpause?(providerId: string): Promise<boolean>;
};
