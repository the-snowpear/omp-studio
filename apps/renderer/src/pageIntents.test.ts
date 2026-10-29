import { afterEach, expect, it } from "vitest";
import {
  HUB_INTENT_KEY,
  setCapIntent,
  setDiagnosticsIntent,
  setHubIntent,
  setMediaIntent,
  setModelConfigIntent,
  setSettingsIntent,
  takeCapIntent,
  takeDiagnosticsIntent,
  takeMediaIntent,
  takeModelConfigIntent,
  takeSettingsIntent,
} from "./pageIntents";
import { modelConfigHasUnsavedChanges, setModelConfigDirty } from "./models/modelConfigState";

afterEach(() => {
  sessionStorage.clear();
  setModelConfigDirty(false);
});

it("keeps navigation intents until their page consumes them once", () => {
  setModelConfigIntent({ tab: "roles", role: "vision", assign: "provider/model" });
  setCapIntent("mcp", "server");
  setSettingsIntent("permissions");
  setDiagnosticsIntent("check-update");

  expect(takeModelConfigIntent()).toEqual({ tab: "roles", role: "vision", assign: "provider/model" });
  expect(takeCapIntent()).toEqual({ tab: "mcp", name: "server" });
  expect(takeSettingsIntent()).toBe("permissions");
  expect(takeDiagnosticsIntent()).toBe("check-update");
  expect(takeModelConfigIntent()).toBeNull();
  expect(takeCapIntent()).toBeNull();
  expect(takeSettingsIntent()).toBeNull();
  expect(takeDiagnosticsIntent()).toBeNull();
});

it("preserves the hub chat intent and child identity check before the hub loads", () => {
  setHubIntent("Main", "chat");
  expect(sessionStorage.getItem(HUB_INTENT_KEY)).toBeNull();
  setHubIntent("Anna.Bob", "chat");
  expect(JSON.parse(sessionStorage.getItem(HUB_INTENT_KEY)!)).toEqual({ agentId: "Anna.Bob", tab: null, chat: true });
  setHubIntent("Anna.Bob", "btw");
  expect(JSON.parse(sessionStorage.getItem(HUB_INTENT_KEY)!)).toEqual({ agentId: "Anna.Bob", tab: "btw" });
});

it("consumes the selected media surface then returns to the image default", () => {
  setMediaIntent("transcription");
  expect(takeMediaIntent()).toBe("transcription");
  expect(takeMediaIntent()).toBe("image");
});

it("exposes model draft dirtiness to navigation without loading the editor", () => {
  expect(modelConfigHasUnsavedChanges()).toBe(false);
  setModelConfigDirty(true);
  expect(modelConfigHasUnsavedChanges()).toBe(true);
  setModelConfigDirty(false);
  expect(modelConfigHasUnsavedChanges()).toBe(false);
});
