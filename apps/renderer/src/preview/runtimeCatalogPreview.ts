import type { McpAuthResult, McpRuntimeStatus, PromptTemplateRow } from "@omp-studio/studio-protocol";
import { isZh } from "../i18n";

/** Display fixtures only. Real template expansion always runs in the native Runtime. */
function buildTemplates(zh: boolean) {
  return [
    {
      name: "review-change",
      description: zh ? "检查变更中的行为、验证和风险" : "Review behavior, verification, and risks in changes",
      source: "(project)",
      content: zh
        ? "检查以下变更：$ARGUMENTS\n\n说明可观察行为、已有验证和需要补充的测试。"
        : "Review the following changes: $ARGUMENTS\n\nExplain observable behavior, existing verification, and tests to add.",
    },
    {
      name: "write-tests",
      description: zh ? "为指定模块补齐用户行为测试" : "Add user-behavior tests for a specified module",
      source: "(project:frontend)",
      content: zh
        ? "为 $1 编写测试。\n\n重点验证：$2\n优先覆盖用户可观察行为，并说明如何运行测试。"
        : "Write tests for $1.\n\nFocus on verifying: $2\nPrioritize user-observable behavior and explain how to run the tests.",
    },
    {
      name: "explain-code",
      description: zh ? "解释模块职责、调用链与关键设计" : "Explain module responsibilities, call chains, and key design",
      source: "(user)",
      content: zh
        ? "解释 $1 的职责与调用链。\n\n结合代码说明关键设计，并给出一个简短的使用示例。"
        : "Explain the responsibilities and call chain of $1.\n\nHighlight key design choices against the code and provide a brief usage example.",
    },
    {
      name: "session-notes",
      description: zh ? "整理本次会话的结论和后续工作" : "Summarize conclusions and next steps from this session",
      source: "(user)",
      content: zh
        ? "整理本次会话的关键结论、已完成工作和下一步。\n\n使用简洁的条目，并保留必要的文件与验证信息。"
        : "Summarize key conclusions, completed work, and next steps from this session.\n\nUse concise bullet points and keep essential file and verification details.",
    },
  ];
}

export function getPreviewTemplates(zh = isZh()): PromptTemplateRow[] {
  return buildTemplates(zh).map((template, index) => ({
    id: index === 0 ? "demo-template" : `demo-template-${index}`,
    name: template.name,
    description: template.description,
    source: template.source,
    version: String(index).repeat(64),
  }));
}

export const PREVIEW_TEMPLATES: PromptTemplateRow[] = getPreviewTemplates();
export const PREVIEW_TEMPLATE = PREVIEW_TEMPLATES[0]!;
export const PREVIEW_TEMPLATE_TEXT = buildTemplates(isZh())[0]!.content;

export function getPreviewTemplateContent(id: string, zh = isZh()): string {
  const templates = buildTemplates(zh);
  const rows = getPreviewTemplates(zh);
  return templates[rows.findIndex((template) => template.id === id)]!.content;
}

/** The native default quoting rules, limited to arguments used by these display fixtures. */
function previewArguments(text: string): string[] {
  const args: string[] = [];
  let current = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if ((char === '"' || char === "'") && (!current || current.endsWith("="))) {
      let close = index + 1;
      while (close < text.length && !(text[close] === char && (close + 1 === text.length || text[close + 1] === " " || text[close + 1] === "\t"))) close++;
      if (close < text.length) { current += text.slice(index + 1, close); index = close; }
      else current += char;
    } else if (char === " " || char === "\t") {
      if (current) args.push(current);
      current = "";
    } else current += char;
  }
  if (current) args.push(current);
  return args;
}

export function preparePreviewTemplate(id: string, argumentsText: string, zh = isZh()): string {
  const content = getPreviewTemplateContent(id, zh);
  const args = previewArguments(argumentsText);
  const all = args.join(" ");
  const usesArguments = /\$ARGUMENTS|\$\d+/.test(content);
  const expanded = content.replace(/\$ARGUMENTS|\$(\d+)/g, (_, position: string | undefined) => position ? (args[Number(position) - 1] ?? "") : all);
  return !usesArguments && all ? `${expanded}\n\n${all}` : expanded;
}

type Tool = NonNullable<McpRuntimeStatus["servers"][number]["toolInfo"]>[number];
const tool = (server: string, name: string, description: string, readOnlyHint: boolean): Tool => ({ name: `mcp_${server}_${name}`, mcpServerName: server, mcpToolName: name, description, readOnlyHint });

function buildFilesystemTools(zh: boolean): Tool[] {
  return [
    tool("filesystem", "read_file", zh ? "读取文件内容" : "Read file contents", true),
    tool("filesystem", "read_multiple_files", zh ? "批量读取文件" : "Read multiple files", true),
    tool("filesystem", "write_file", zh ? "创建文件或写入内容" : "Create or write a file", false),
    tool("filesystem", "edit_file", zh ? "按文本片段编辑文件" : "Edit a file by text snippet", false),
    tool("filesystem", "create_directory", zh ? "创建目录" : "Create a directory", false),
    tool("filesystem", "list_directory", zh ? "查看目录内容" : "List directory contents", true),
    tool("filesystem", "directory_tree", zh ? "查看目录结构" : "Inspect directory tree", true),
    tool("filesystem", "move_file", zh ? "移动文件或目录" : "Move a file or directory", false),
    tool("filesystem", "search_files", zh ? "按名称搜索文件" : "Search files by name", true),
    tool("filesystem", "get_file_info", zh ? "读取文件元信息" : "Read file metadata", true),
    tool("filesystem", "list_allowed_directories", zh ? "查看已授权的目录" : "List allowed directories", true),
  ];
}

function buildConnectedTools(zh: boolean): Record<string, Tool[]> {
  return {
    filesystem: buildFilesystemTools(zh),
    github: [
      tool("github", "get_pull_request", zh ? "读取 Pull Request" : "Read Pull Request", true),
      tool("github", "list_issues", zh ? "查看仓库 Issue" : "List repository issues", true),
      tool("github", "get_file_contents", zh ? "读取仓库文件" : "Read repository file", true),
      tool("github", "create_issue", zh ? "创建 Issue" : "Create an issue", false),
    ],
    docs: [
      tool("docs", "search_docs", zh ? "搜索项目文档" : "Search project documentation", true),
      tool("docs", "read_document", zh ? "读取文档正文" : "Read document contents", true),
    ],
  };
}

export function getPreviewMcpRuntime(zh = isZh()): McpRuntimeStatus {
  return {
    available: true,
    startupTimeoutMs: 250,
    ready: false,
    settled: false,
    total: 4,
    servers: [
      { name: "node_repl", replacedByBuiltin: "node_repl", state: "disconnected", transport: "stdio", tools: 0 },
      { name: "filesystem", evalNamespaceUri: "xd://eval/filesystem", state: "ready", transport: "stdio", source: { providerName: "OMP", level: "project" }, tools: 11, toolInfo: buildFilesystemTools(zh) },
      { name: "github", state: "pending", transport: "http", source: { providerName: "OMP", level: "user" }, tools: 0 },
      { name: "docs", state: "failed", transport: "sse", source: { providerName: "OMP", level: "project" }, tools: 0, error: zh ? "连接超时：文档服务未在等待期限内响应。" : "Connection timed out: docs server did not respond before deadline." },
    ],
  };
}

export const PREVIEW_MCP_RUNTIME: McpRuntimeStatus = getPreviewMcpRuntime();

export function applyPreviewMcpAction(status: McpRuntimeStatus, result: McpAuthResult, zh = isZh()): McpRuntimeStatus {
  if (!["authorized", "connected", "removed"].includes(result.status)) return status;
  const connectedTools = buildConnectedTools(zh);
  const servers = status.servers.map((server) => {
    if (server.name !== result.name) return server;
    const tools = result.status === "removed" ? [] : connectedTools[server.name]!;
    const updated = { ...server, state: result.status === "removed" ? "disconnected" as const : "ready" as const, tools: tools.length, toolInfo: tools };
    delete updated.error;
    return updated;
  });
  return { ...status, servers, ready: servers.every((server) => server.state === "ready"), settled: !servers.some((server) => server.state === "pending") };
}
