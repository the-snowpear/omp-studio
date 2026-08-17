import { describe, expect, it } from "vitest";
import type { ClientInteraction, InteractionId, SessionId } from "@omp-studio/client-contract";
import { approvalFromInteraction } from "./approvalContent";

const SESSION = "session-1" as SessionId;

function approval(detail: Record<string, unknown>, title = "Allow bash?"): Extract<ClientInteraction, { kind: "approval" }> {
  return {
    kind: "approval",
    interactionId: "int-approval" as InteractionId,
    sessionId: SESSION,
    leaseGeneration: 1,
    title,
    approvalType: typeof detail.toolName === "string" ? detail.toolName : "bash",
    detail,
  };
}

describe("approvalFromInteraction", () => {
  it("parses OMP labeled summary into the ver1 bash card", () => {
    const view = approvalFromInteraction(approval({
      toolName: "bash",
      summary: "Allow tool: bash\nReason: inspect workspace\nCommand: git status",
      risk: "high",
    }));
    expect(view.title).toBe("OMP 想要执行 Bash 命令");
    expect(view.command).toBe("git status");
    expect(view.reason).toBe("inspect workspace");
    expect(view.risk).toBe("high");
    expect(view.scope).toBe("工作区内 · Shell");
  });

  it("treats an unlabeled bash summary as the command", () => {
    const view = approvalFromInteraction(approval({ toolName: "bash", summary: "git add -A && git commit -m docs" }));
    expect(view.command).toBe("git add -A && git commit -m docs");
  });

  it("maps write Path/Content and File labels", () => {
    const write = approvalFromInteraction(approval({
      toolName: "write",
      summary: "Path: src/app.ts\nContent:\nexport const x = 1;",
      risk: "medium",
    }));
    expect(write.title).toBe("OMP 想要写入文件");
    expect(write.path).toBe("src/app.ts");
    expect(write.extra).toContain("export const x = 1;");
    const edit = approvalFromInteraction(approval({
      toolName: "edit",
      summary: "File: src/app.ts",
    }));
    expect(edit.path).toBe("src/app.ts");
    expect(edit.title).toBe("OMP 想要编辑文件");
  });
});
