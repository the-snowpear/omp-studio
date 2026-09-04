import { describe, expect, it } from "vitest";
import type { EnvironmentReadModel, RuntimeConnection } from "@omp-studio/client-contract";
import { deriveDiagnosticsView, formatRuntimeUnavailableCopy, type I18nT } from "./diagnosticsModel";
import { translate } from "./i18n/I18nContext";
import type { Locale, TranslationParams } from "./i18n/types";

const COMMAND_MANIFEST_DRIFT = "managed runtime command manifest hash drift";

function localized(locale: Locale): I18nT {
  return (key, params) => translate(locale, key, params as TranslationParams | undefined);
}

function driftedRuntime(): RuntimeConnection {
  return {
    status: "unavailable",
    classification: "unavailable",
    unavailableCode: "resolution-rejected",
    unavailableReason: COMMAND_MANIFEST_DRIFT,
  } as RuntimeConnection;
}

function installedEnvironment(): EnvironmentReadModel {
  return {
    platform: "win32",
    arch: "x64",
    authority: {
      authorityId: "auth-1" as EnvironmentReadModel["authority"]["authorityId"],
      authorityEpoch: 1 as EnvironmentReadModel["authority"]["authorityEpoch"],
    },
    runtime: driftedRuntime(),
    installer: { status: "installed", version: "18.0.11-studio.15", signature: "unknown" },
  };
}

describe("diagnostics hero copy", () => {
  // The hero line reported `签名：{sig}` in the field: the template placeholder is
  // `sig` while the caller passed `signature`, and formatTranslation leaves an
  // unmatched placeholder verbatim. Assert on the rendered text, not the params.
  it("substitutes the signature placeholder in every locale", () => {
    for (const locale of ["zh", "en"] as const) {
      const view = deriveDiagnosticsView(
        {
          runtime: driftedRuntime(),
          environment: installedEnvironment(),
          diagnostics: { entries: [], generatedAt: "2026-09-04T13:22:17.000Z" } as never,
        },
        localized(locale),
      );
      expect(view.hero.detail).not.toMatch(/[{}]/u);
      expect(view.hero.detail).toContain(translate(locale, "diagnostics.signatureUnknown"));
    }
  });

  it("localizes a known resolver rejection instead of printing the host sentence", () => {
    for (const locale of ["zh", "en"] as const) {
      const copy = formatRuntimeUnavailableCopy("resolution-rejected", COMMAND_MANIFEST_DRIFT, localized(locale));
      expect(copy.detail).not.toContain(COMMAND_MANIFEST_DRIFT);
      expect(copy.problem).not.toContain(COMMAND_MANIFEST_DRIFT);
      expect(copy.detail).toBe(translate(locale, "diagnostics.rejectedCommandManifestDriftDetail"));
    }
  });

  // Losing a translation is better than losing evidence, so anything unmapped
  // still reaches the operator verbatim.
  it("falls back to the raw reason for an unmapped rejection", () => {
    const copy = formatRuntimeUnavailableCopy("resolution-rejected", "some brand new resolver reason");
    expect(copy.detail).toBe("some brand new resolver reason");
  });
});
