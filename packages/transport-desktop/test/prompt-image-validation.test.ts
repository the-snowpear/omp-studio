import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";

import {
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_IMAGES,
  MAX_PROMPT_IMAGES_TOTAL_BYTES,
  ValidationError,
  parseClientCommandRequest,
} from "../src/validate-inbound.js";

const IMAGE_DATA = "AQID";

function image(data = IMAGE_DATA, mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" = "image/png") {
  return { type: "image" as const, mimeType, data };
}

function command(commandName: string, input: unknown): unknown {
  return {
    commandName,
    input,
    requestId: "request-image-validation",
    idempotencyKey: "idempotency-image-validation",
  };
}

function assertInvalid(commandName: string, input: unknown, message: RegExp): void {
  assert.throws(
    () => parseClientCommandRequest(command(commandName, input)),
    (error: unknown) => error instanceof ValidationError && message.test(error.message),
  );
}

test("accepts valid images through core prompt modes and agent.send", () => {
  for (const commandName of ["core.prompt", "core.steer", "core.followUp"]) {
    const parsed = parseClientCommandRequest(
      command(commandName, { text: "look", images: [image()] }),
    );
    assert.equal(parsed.commandName, commandName);
  }

  const parsed = parseClientCommandRequest(
    command("agent.send", {
      agentId: "agent-1",
      expectedGeneration: 1,
      text: "look",
      mode: "prompt",
      images: [image("AQID", "image/webp")],
    }),
  );
  assert.equal(parsed.commandName, "agent.send");
});

test("accepts all supported image MIME types and enforces the count cap", () => {
  for (const mimeType of ["image/png", "image/jpeg", "image/gif", "image/webp"] as const) {
    assert.doesNotThrow(() =>
      parseClientCommandRequest(command("core.prompt", { text: "look", images: [image(IMAGE_DATA, mimeType)] })),
    );
  }

  const images = Array.from({ length: MAX_PROMPT_IMAGES }, () => image());
  assert.doesNotThrow(() => parseClientCommandRequest(command("core.prompt", { text: "look", images })));
  assertInvalid(
    "core.prompt",
    { text: "look", images: [...images, image()] },
    /max count/u,
  );
});

test("rejects non-canonical Base64, data URLs, empty data and bad padding", () => {
  const invalidData = [
    "",
    "data:image/png;base64,AQID",
    "A",
    "AQI",
    "AQ=",
    "AQI==",
    "A===",
    "AQ=A",
    "AR==",
    "AAB=",
    "AQID\n",
    "AQ-_",
  ];
  for (const data of invalidData) {
    assertInvalid("core.prompt", { text: "look", images: [image(data)] }, /Base64/u);
    assertInvalid(
      "agent.send",
      {
        agentId: "agent-1",
        expectedGeneration: 1,
        text: "look",
        mode: "followUp",
        images: [image(data)],
      },
      /Base64/u,
    );
  }
});

test("rejects one image above the decoded-byte cap without allocating a decode buffer", () => {
  const tooLarge = Buffer.alloc(MAX_PROMPT_IMAGE_BYTES + 1).toString("base64");
  assertInvalid(
    "core.followUp",
    { text: "look", images: [image(tooLarge)] },
    /decoded data exceeds the max image size/u,
  );
});

test("rejects aggregate decoded bytes above the per-request cap", () => {
  const maxImage = Buffer.alloc(MAX_PROMPT_IMAGE_BYTES).toString("base64");
  const images = Array.from({ length: Math.floor(MAX_PROMPT_IMAGES_TOTAL_BYTES / MAX_PROMPT_IMAGE_BYTES) }, () =>
    image(maxImage),
  );
  images.push(image("AQID"));
  assertInvalid(
    "agent.send",
    {
      agentId: "agent-1",
      expectedGeneration: 1,
      text: "look",
      mode: "steer",
      images,
    },
    /max total size/u,
  );
});
