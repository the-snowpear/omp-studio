import type { CommandName, ConfigWriteResult, ModelDiscoveryResult, ModelProviderProbeInput, ModelProviderTestResult, StudioClient } from "@omp-studio/client-contract";
import { waitReceipt } from "../../hostError";

export async function runWrite<T extends Extract<CommandName, `models.${string}`>>(
  client: StudioClient,
  name: T,
  input: Parameters<StudioClient["command"]>[1] extends never ? never : unknown,
): Promise<ConfigWriteResult> {
  const handle = await client.command(name, input as never);
  return waitReceipt<ConfigWriteResult>(client, handle.requestId);
}

export async function runTest(
  client: StudioClient,
  input: { readonly providerId?: string; readonly api?: string; readonly endpointUrl?: string; readonly apiKey?: string },
): Promise<ModelProviderTestResult> {
  const handle = await client.command("models.provider.test", input as never);
  return waitReceipt<ModelProviderTestResult>(client, handle.requestId);
}

export async function runProbe(
  client: StudioClient,
  input: ModelProviderProbeInput,
): Promise<ModelDiscoveryResult> {
  const handle = await client.command("models.provider.probe", input as never);
  return waitReceipt<ModelDiscoveryResult>(client, handle.requestId);
}
