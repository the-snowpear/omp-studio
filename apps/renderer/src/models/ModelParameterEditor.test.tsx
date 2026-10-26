import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { ModelAdaptationInput, ModelAdaptationResult, StudioClient } from "@omp-studio/client-contract";
import { ModelParameterEditor } from "./ModelParameterEditor";
import { createModelParameterDraft, effectiveModelParameters, effectiveParameterSources, type ModelParameterDraft } from "./modelParameterDraft";
import { selectOption } from "../test/selectOption";

beforeAll(() => { Element.prototype.scrollIntoView = () => undefined; });
afterEach(cleanup);

const result: ModelAdaptationResult = {
  catalogVersion: "v1", status: "matched", candidates: [{ key: "official/example", provider: "official", api: "openai-completions", id: "example", name: "Example", values: { contextWindow: 200000 } }],
  values: { contextWindow: 200000, maxTokens: 32000, reasoning: true, thinkingConfig: { mode: "budget", efforts: ["low", "high"], defaultLevel: "high" } },
  sources: { contextWindow: { source: "catalog", catalogVersion: "v1" }, maxTokens: { source: "endpoint" }, reasoning: { source: "catalog" }, thinkingConfig: { source: "catalog" } },
};
const identity = { providerId: "gateway", api: "openai-completions", modelId: "example" };

function Editor({ client, input = identity, preview = false, initial }: { client: StudioClient; input?: ModelAdaptationInput; preview?: boolean; initial?: ModelParameterDraft }) {
  const [draft, setDraft] = useState(initial ?? createModelParameterDraft());
  return <><ModelParameterEditor client={client} input={input} value={draft} onChange={setDraft} preview={preview} /><output data-testid="effective">{JSON.stringify(effectiveModelParameters(draft))}</output><output data-testid="sources">{JSON.stringify(effectiveParameterSources(draft))}</output></>;
}

it("saves gray recommendations as effective values and preserves manual overrides when recommendations are reapplied", async () => {
  const query = vi.fn().mockResolvedValue(result);
  render(<Editor client={{ query } as unknown as StudioClient} />);
  const context = screen.getByRole("spinbutton", { name: "上下文窗口" }) as HTMLInputElement;
  await waitFor(() => expect(context.placeholder).toBe("200000"));
  expect(context.value).toBe("");
  expect(JSON.parse(screen.getByTestId("effective").textContent!)).toMatchObject(result.values);
  fireEvent.change(context, { target: { value: "100000" } });
  expect(JSON.parse(screen.getByTestId("sources").textContent!).contextWindow.source).toBe("manual");
  fireEvent.click(screen.getByRole("button", { name: "重新应用推荐" }));
  await waitFor(() => expect(query).toHaveBeenCalledTimes(2));
  expect(context.value).toBe("100000");
  expect(JSON.parse(screen.getByTestId("effective").textContent!).contextWindow).toBe(100000);
});

it("requires choosing between different matches before recommending their parameters", async () => {
  const candidates = [result.candidates[0]!, { ...result.candidates[0]!, key: "other/example", provider: "other", values: { contextWindow: 64000 } }];
  const query = vi.fn().mockResolvedValue({ ...result, status: "ambiguous", candidates, values: {}, sources: {} });
  render(<Editor client={{ query } as unknown as StudioClient} />);
  const select = await screen.findByRole("combobox", { name: "选择目录模型" });
  expect(JSON.parse(screen.getByTestId("effective").textContent!)).toEqual({});
  selectOption(select, "other / example");
  await waitFor(() => expect(JSON.parse(screen.getByTestId("effective").textContent!).contextWindow).toBe(64000));
});

it("ignores a response for an earlier model identity", async () => {
  let resolveOld!: (result: ModelAdaptationResult) => void;
  const query = vi.fn().mockImplementationOnce(() => new Promise<ModelAdaptationResult>(resolve => { resolveOld = resolve; })).mockResolvedValue({ ...result, values: { contextWindow: 64000 } });
  const client = { query } as unknown as StudioClient;
  const view = render(<Editor client={client} />);
  await waitFor(() => expect(query).toHaveBeenCalledTimes(1));
  view.rerender(<Editor client={client} input={{ ...identity, modelId: "new-model" }} />);
  await waitFor(() => expect(JSON.parse(screen.getByTestId("effective").textContent!).contextWindow).toBe(64000));
  resolveOld(result);
  await Promise.resolve();
  expect(JSON.parse(screen.getByTestId("effective").textContent!).contextWindow).toBe(64000);
});

it("uses preview recommendations without calling the Host", async () => {
  const query = vi.fn(), command = vi.fn();
  render(<Editor preview client={{ query, command } as unknown as StudioClient} input={{ ...identity, modelId: "gpt-4.1" }} />);
  await waitFor(() => expect(JSON.parse(screen.getByTestId("effective").textContent!).contextWindow).toBe(1047576));
  expect(query).not.toHaveBeenCalled(); expect(command).not.toHaveBeenCalled();
});

it("keeps saved automatic parameters fixed when only the display name changes", async () => {
  const query = vi.fn().mockResolvedValue(result);
  const client = { query } as unknown as StudioClient;
  const initial: ModelParameterDraft = { values: { contextWindow: 90000 }, sources: { contextWindow: { source: "catalog", catalogVersion: "old" } } };
  const view = render(<Editor client={client} initial={initial} />);
  await waitFor(() => expect(query).toHaveBeenCalledTimes(1));
  view.rerender(<Editor client={client} initial={initial} input={{ ...identity, name: "A personal display name" }} />);
  await waitFor(() => expect(query).toHaveBeenCalledTimes(2));
  expect(JSON.parse(screen.getByTestId("effective").textContent!).contextWindow).toBe(90000);
  fireEvent.click(screen.getByRole("button", { name: "重新应用推荐" }));
  await waitFor(() => expect(JSON.parse(screen.getByTestId("effective").textContent!).contextWindow).toBe(200000));
});
