import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import type { StudioWebMcpCatalog, WebMcpToolRecord } from "@omp-studio/studio-protocol";
import { WebMcpPane } from "./WebMcpPane";

afterEach(cleanup);

it("keeps all page tools selectable and ignores metadata for an earlier selection", async () => {
  const tools: WebMcpToolRecord[] = ["alpha", "beta"].map(name => ({ name, description: name, frameId: "main", origin: "https://example.com", untrusted: true }));
  const catalog: StudioWebMcpCatalog = { pageId: "page", documentId: "document", status: "ready", tools, truncated: false, untrusted: true, invocationAvailable: true };
  const pending = new Map<string, (value: StudioWebMcpCatalog) => void>();
  const query = vi.fn(async (_kind: string, input: { options?: { name: string } }) => input.options
    ? new Promise<StudioWebMcpCatalog>(resolve => pending.set(input.options!.name, resolve)) : catalog);
  render(<WebMcpPane client={{ query } as unknown as StudioClient} sessionId="session" pageId="page" visible agentControl copy={(_zh, en) => en} onBack={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "alpha" }));
  fireEvent.click(screen.getByRole("button", { name: "beta" }));
  await act(async () => pending.get("beta")!({ ...catalog, tools: [{ ...tools[1]!, description: "Beta parameters" }] }));
  expect(screen.getByText("Beta parameters")).toBeTruthy();
  expect(screen.getByRole("button", { name: "alpha" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "beta" })).toBeTruthy();
  await act(async () => pending.get("alpha")!({ ...catalog, tools: [{ ...tools[0]!, description: "Alpha parameters" }] }));
  expect(screen.getByText("Beta parameters")).toBeTruthy();
  expect(screen.queryByText("Alpha parameters")).toBeNull();
});
