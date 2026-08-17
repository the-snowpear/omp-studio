import type { ClientInteraction } from "@omp-studio/client-contract";

export type ApprovalRisk = "high" | "medium" | "low";

export type ApprovalView = {
  readonly title: string;
  readonly toolLabel: string;
  readonly risk: ApprovalRisk;
  readonly command?: string;
  readonly path?: string;
  readonly language?: string;
  readonly reason?: string;
  readonly scope?: string;
  readonly extra?: string;
};

const TOOL_LABELS: Record<string, string> = {
  bash: "Bash",
  write: "Write",
  edit: "Edit",
  ast_edit: "AST Edit",
  eval: "Eval",
  computer: "Computer",
  browser: "Browser",
  debug: "Debug",
  github: "GitHub",
};

const TOOL_TITLES: Record<string, string> = {
  bash: "OMP 想要执行 Bash 命令",
  write: "OMP 想要写入文件",
  edit: "OMP 想要编辑文件",
  ast_edit: "OMP 想要做 AST 编辑",
  eval: "OMP 想要执行代码",
  computer: "OMP 想要操作桌面",
  browser: "OMP 想要操作浏览器",
  debug: "OMP 想要使用调试器",
  github: "OMP 想要调用 GitHub",
};

function toolKey(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function riskOf(value: string | undefined): ApprovalRisk {
  if (value === "high") return "high";
  if (value === "medium" || value === "med") return "medium";
  return "low";
}

function stringDetail(detail: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = detail[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseLabeledLines(summary: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = summary.split("\n");
  let current: string | undefined;
  const chunks: string[] = [];
  const flush = () => {
    if (!current) return;
    out[current] = chunks.join("\n").trim();
    chunks.length = 0;
    current = undefined;
  };
  for (const line of lines) {
    const labeled = /^(Allow tool|Origin|Reason|Command|Path|File|Content|Language|Code|Pattern|Replacement|Paths):\s*(.*)$/.exec(line);
    if (labeled) {
      flush();
      current = labeled[1]!;
      const rest = labeled[2] ?? "";
      if (rest) chunks.push(rest);
      continue;
    }
    if (current) chunks.push(line);
  }
  flush();
  return out;
}

function defaultScope(tool: string, explicit?: string): string | undefined {
  if (explicit === "mcp") return "MCP 工具";
  if (explicit) return explicit;
  if (tool === "bash") return "工作区内 · Shell";
  if (tool === "write" || tool === "edit" || tool === "ast_edit") return "工作区内 · 文件";
  if (tool === "eval") return "工作区内 · 代码执行";
  if (tool === "browser") return "受控浏览器";
  if (tool === "computer") return "本机桌面";
  return undefined;
}

/** Shape Host `approval` details (OMP formatApprovalPrompt + wrapper fields) into the ver1 card. */
export function approvalFromInteraction(
  interaction: Extract<ClientInteraction, { kind: "approval" }>,
): ApprovalView {
  const detail = interaction.detail;
  const tool = toolKey(stringDetail(detail, "toolName") ?? interaction.approvalType);
  const summary = stringDetail(detail, "summary") ?? "";
  const labeled = summary ? parseLabeledLines(summary) : {};
  const labeledEmpty = Object.keys(labeled).length === 0;
  const command = stringDetail(detail, "command")
    ?? labeled.Command
    ?? (labeledEmpty && tool === "bash" && summary ? summary : undefined);
  const path = stringDetail(detail, "path") ?? labeled.Path ?? labeled.File;
  const language = labeled.Language;
  const reason = stringDetail(detail, "reason") ?? labeled.Reason;
  const extraBits = [labeled.Content, labeled.Code, labeled.Pattern, labeled.Replacement, labeled.Paths]
    .filter((value): value is string => Boolean(value));
  const unlabeledExtra = labeledEmpty && tool !== "bash" && summary && !command && !path ? summary : undefined;
  const extra = extraBits.length > 0 ? extraBits.join("\n") : unlabeledExtra;
  const title = TOOL_TITLES[tool] ?? interaction.title ?? `Allow ${interaction.approvalType}?`;
  const scope = defaultScope(tool, stringDetail(detail, "scope"));
  return {
    title,
    toolLabel: TOOL_LABELS[tool] ?? interaction.approvalType,
    risk: riskOf(stringDetail(detail, "risk")),
    ...(command ? { command } : {}),
    ...(path ? { path } : {}),
    ...(language ? { language } : {}),
    ...(reason ? { reason } : {}),
    ...(scope ? { scope } : {}),
    ...(extra ? { extra } : {}),
  };
}
