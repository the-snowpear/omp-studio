import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OperatorCommandManifest, OperatorCommandManifestEntry } from "@omp-studio/studio-protocol";
import type { StudioClient } from "@omp-studio/client-contract";
import { CapabilitiesPage } from "./CapabilitiesPage";
import type { StudioSlashCommand } from "./composer/commands";
import { PreviewModeProvider } from "./preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "./preview/mode";

beforeAll(() => {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
  window.matchMedia = (query: string) =>
    ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }) as unknown as MediaQueryList;
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(PREVIEW_MODE_STORAGE_KEY);
  vi.restoreAllMocks();
});

function entry(overrides: Partial<OperatorCommandManifestEntry> = {}): OperatorCommandManifestEntry {
  return {
    id: "skill.only",
    name: "only",
    aliases: [],
    description: "Runtime-only command",
    source: "skill",
    implementation: "headless-handle",
    interactionKinds: [],
    presentation: "native",
    availability: "available",
    risk: "normal",
    effect: "read",
    contractTestId: "test.only",
    ...overrides,
  };
}

function manifest(commands: OperatorCommandManifestEntry[]): OperatorCommandManifest {
  return {
    generatedAt: "2026-08-23T00:00:00.000Z",
    upstreamCommit: "test",
    hash: "test",
    commands,
    unclassifiedBuiltins: [],
  };
}

function fakeClient(commandManifest: OperatorCommandManifest) {
  const query = vi.fn(async (name: string) => {
    if (name === "commands.getManifest") return commandManifest;
    if (name === "skills.get") return { skills: [], plugins: [], warnings: [], generatedAt: commandManifest.generatedAt };
    if (name === "mcp.get") return { servers: [], warnings: [], generatedAt: commandManifest.generatedAt };
    throw new Error(`unexpected query ${name}`);
  });
  return { query, command: vi.fn() } as unknown as StudioClient & { query: typeof query; command: ReturnType<typeof vi.fn> };
}

function renderPage(preview: boolean, client: StudioClient, onRunSlash?: (command: StudioSlashCommand, args: string) => Promise<boolean>, onPinCompleted?: () => Promise<void>) {
  window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, preview ? "1" : "0");
  render(
    <PreviewModeProvider switchEnabled>
      <CapabilitiesPage
        client={client}
        {...(onRunSlash === undefined ? {} : { onRunSlash })}
        {...(onPinCompleted === undefined ? {} : { onPinCompleted })}
      />
    </PreviewModeProvider>,
  );
}

describe("CapabilitiesPage command manifest", () => {
  it("queries and renders only Runtime manifest commands, including dynamic commands", async () => {
    const client = fakeClient(manifest([
      entry(),
      entry({ id: "extension.review", name: "review", source: "extension", description: "Extension command" }),
    ]));
    const onRunSlash = vi.fn(async () => true);
    renderPage(false, client, onRunSlash);

    await waitFor(() => expect(client.query).toHaveBeenCalledWith("commands.getManifest", {}));
    fireEvent.click(screen.getByRole("tab", { name: /Slash Commands/ }));
    expect(screen.getByText("/only")).toBeTruthy();
    expect(screen.getByText("/review")).toBeTruthy();
    expect(screen.queryByText("/compact")).toBeNull();

    const row = document.querySelector('[data-name="/only"]');
    expect(row).toBeInstanceOf(HTMLElement);
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "执行" }));
    await waitFor(() => expect(onRunSlash).toHaveBeenCalledWith(expect.objectContaining({ invokeId: "skill.only" }), ""));
  });

  it("refreshes the caller after an authoritative /pin action", async () => {
    const client = fakeClient(manifest([entry({ id: "builtin.pin", name: "pin", source: "builtin" })]));
    const onRunSlash = vi.fn(async () => true);
    const onPinCompleted = vi.fn(async () => undefined);
    renderPage(false, client, onRunSlash, onPinCompleted);
    await waitFor(() => expect(client.query).toHaveBeenCalledWith("commands.getManifest", {}));
    fireEvent.click(screen.getByRole("tab", { name: /Slash Commands/ }));
    const row = document.querySelector('[data-name="/pin"]');
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "执行" }));
    await waitFor(() => expect(onPinCompleted).toHaveBeenCalledTimes(1));
  });

  it("keeps preview fixtures and does not query the Runtime manifest", async () => {
    const client = fakeClient(manifest([entry({ id: "skill.only", name: "only" })]));
    renderPage(true, client);
    fireEvent.click(screen.getByRole("tab", { name: /Slash Commands/ }));
    expect(screen.getByText("/compact")).toBeTruthy();
    expect(client.query).not.toHaveBeenCalled();
  });
});
