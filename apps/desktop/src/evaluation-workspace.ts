import { randomUUID } from "node:crypto";
import { join, resolve, basename, extname } from "node:path";
import { createReadStream } from "node:fs";
import {
  EvaluationCoordinator,
  type ArtifactLibrary,
  type EvaluationWorker,
} from "@omp-studio/studio-host";
import type { HostInteractionRespondInput } from "@omp-studio/host-client-api";
import type {
  RequestId,
  StudioOperation,
  EvaluationContext,
  EvaluationWorkspaceOperation,
  JudgmentEvaluationSpec,
  RuntimeModelChoice,
} from "@omp-studio/studio-protocol";
import type { DesktopRuntimeSessionPort } from "./host-composition.js";
import { DesktopInteractionHost } from "./interaction-host.js";

const coordinators = new WeakMap<object, EvaluationCoordinator>();
interface Options {
  profileDirectory: string;
  runtimes: DesktopRuntimeSessionPort | undefined;
  workspace(id: string): Promise<string | undefined>;
  artifacts: ArtifactLibrary;
  revealDirectory?: ((path: string) => Promise<void>) | undefined;
  ensureRuntime(): Promise<void>;
}
export function evaluationsFor(owner: object, options: Options): EvaluationCoordinator {
  const existing = coordinators.get(owner);
  if (existing) return existing;
  const coordinator = new EvaluationCoordinator(
    join(options.profileDirectory, "evaluations", "v1"),
    {
      ...(options.revealDirectory ? { reveal: options.revealDirectory } : {}),
      async open(workspaceId, attachSessionId): Promise<EvaluationWorker> {
        await options.ensureRuntime();
        const cwd = await options.workspace(workspaceId);
        if (!cwd) throw new Error("Select an available workspace before creating an evaluation");
        const session = attachSessionId
          ? options.runtimes?.evaluationSession?.(attachSessionId)
          : await options.runtimes?.openEvaluation?.({ workspaceId, cwd });
        const initial = session?.controller.publication()?.snapshot;
        if (!session || !initial)
          throw new Error("The selected Runtime cannot host background evaluations");
        const interactions = new DesktopInteractionHost({ current: session });
        interactions.attach(session.controller);
        const invoke = async (operation: StudioOperation): Promise<unknown> => {
          const snapshot = session.controller.publication()?.snapshot;
          if (!snapshot || !session.hello()) throw new Error("Evaluation Runtime disconnected");
          const receipt = await session.controller.invoke({
            type: "studio.request",
            requestId: randomUUID() as RequestId,
            runtimeEpoch: snapshot.runtimeEpoch,
            operation,
          });
          if (receipt.status !== "completed")
            throw new Error(receipt.error?.message ?? `Evaluation command ${receipt.status}`);
          return receipt.result;
        };
        return {
          sessionId: initial.sessionId,
          runtimeVersion: session.hello()?.runtimeVersion ?? "unknown",
          async invoke(operation: EvaluationWorkspaceOperation) {
            if (
              operation.kind === "evaluation.runtime.start" &&
              operation.spec.kind === "judgment"
            ) {
              const spec: JudgmentEvaluationSpec = {
                ...operation.spec,
                items: await Promise.all(
                  operation.spec.items.map(async (item) => ({
                    ...item,
                    ...(item.images
                      ? {
                          images: await Promise.all(
                            item.images.map(async (source) =>
                              source.startsWith("artifact://")
                                ? (await options.artifacts.resolve(source.slice(11))).path
                                : source,
                            ),
                          ),
                        }
                      : {}),
                  })),
                ),
              };
              return invoke({ ...operation, spec });
            }
            return invoke(operation);
          },
          async context(): Promise<EvaluationContext> {
            const manifest = session.capabilityManifest();
            if (
              !manifest?.capabilities.some(
                (c) => c.id === "evaluation.runtime.start" && c.grade !== "unavailable",
              )
            )
              return {
                available: false,
                models: [],
                reason: "This Runtime needs the evaluation workspace update",
                runtimeVersion: session.hello()?.runtimeVersion ?? "unknown",
              };
            const models: EvaluationContext["models"] = [];
            let cursor: string | undefined;
            do {
              const page = (await invoke({
                kind: "runtime.models.list",
                ...(cursor ? { cursor } : {}),
                limit: 200,
              })) as { models: RuntimeModelChoice[]; nextCursor?: string };
              models.push(
                ...page.models.map(({ selector, name, provider, kind, image }) => ({
                  selector,
                  name,
                  provider,
                  kind,
                  image,
                })),
              );
              cursor = page.nextCursor;
            } while (cursor);
            return {
              available: true,
              models,
              runtimeVersion: session.hello()?.runtimeVersion ?? "unknown",
            };
          },
          async preserveInputs(spec) {
            if (spec.kind !== "judgment") return spec;
            const images = new Map<string, string>();
            const items = [];
            for (const item of spec.items) {
              const retained: string[] = [];
              for (const source of item.images ?? []) {
                if (source.startsWith("artifact://")) {
                  await options.artifacts.resolve(source.slice(11));
                  retained.push(source);
                  continue;
                }
                let reference = images.get(source);
                if (!reference) {
                  const file = resolve(cwd, source);
                  const mime = {
                    ".png": "image/png",
                    ".jpg": "image/jpeg",
                    ".jpeg": "image/jpeg",
                    ".webp": "image/webp",
                    ".gif": "image/gif",
                    ".svg": "image/svg+xml",
                  }[extname(file).toLowerCase()];
                  if (!mime) throw new Error("Choose a supported judgment image");
                  const artifact = await options.artifacts.register(
                    { kind: "image", name: basename(file), mimeType: mime, workspaceId },
                    createReadStream(file),
                  );
                  reference = `artifact://${artifact.artifactId}`;
                  images.set(source, reference);
                }
                retained.push(reference);
              }
              items.push({ ...item, ...(retained.length ? { images: retained } : {}) });
            }
            return { ...spec, items };
          },
          pending: () => session.controller.publication()?.snapshot?.pendingInteraction,
          respond: (input) => interactions.respond(input as HostInteractionRespondInput),
          subscribe(listener) {
            let previous = JSON.stringify(
              session.controller.publication()?.snapshot?.pendingInteraction,
            );
            const publication = session.onPublication(() => {
                const pending = JSON.stringify(
                  session.controller.publication()?.snapshot?.pendingInteraction,
                );
                if (pending !== previous || !session.hello()) {
                  previous = pending;
                  listener();
                }
              }),
              progress = session.controller.onEvaluationChanged(listener);
            return () => {
              publication();
              progress();
            };
          },
          async release() {
            interactions.attach(undefined);
            if (!attachSessionId) await options.runtimes?.releaseEvaluation?.(initial.sessionId);
          },
        };
      },
    },
    options.artifacts,
  );
  coordinators.set(owner, coordinator);
  return coordinator;
}
export async function closeEvaluations(owner: object): Promise<void> {
  await coordinators.get(owner)?.shutdown();
  coordinators.delete(owner);
}
