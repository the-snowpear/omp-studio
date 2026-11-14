import { type EvaluationOperation } from "./contracts/evaluation.js";

/** Mirrored by Runtime: no Node, browser, or transport dependencies. */
export class EvaluationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationValidationError";
  }
}

const SHAPES = {
  "browser.evaluate": ["kind", "expression", "target", "timeoutMs"],
  "computer.evaluate": ["kind", "action", "target", "timeoutMs"],
  "image.read": ["kind", "image", "question"],
  "terminal.image": ["kind", "result"],
  "video.metadata": ["kind", "attachmentId"],
  "video.frame": ["kind", "attachmentId", "timestampMs"],
  "eval.agent.start": ["kind", "definition", "assignment", "async"],
  "eval.agent.status": ["kind", "jobId", "expectedGeneration"],
  "eval.agent.wait": ["kind", "jobId", "expectedGeneration", "timeoutMs"],
  "eval.agent.cancel": ["kind", "jobId", "expectedGeneration"],
  "eval.completion.start": ["kind", "prompt", "model", "system", "schema"],
  "eval.completion.status": ["kind", "jobId", "expectedGeneration"],
  "eval.completion.wait": ["kind", "jobId", "expectedGeneration", "timeoutMs"],
  "eval.completion.cancel": ["kind", "jobId", "expectedGeneration"],
  "eval.workpool.status": ["kind", "name", "ownerAgentId"],
} as const;

export function isEvaluationOperationKind(kind: string): kind is EvaluationOperation["kind"] {
  return Object.hasOwn(SHAPES, kind);
}
