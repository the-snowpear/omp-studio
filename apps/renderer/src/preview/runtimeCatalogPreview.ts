import type { McpAuthResult, McpRuntimeStatus, PromptTemplateRow } from "@omp-studio/studio-protocol";

/** Display fixtures only. Real template expansion always runs in the native Runtime. */
const templates = [
  { name: "review-change", description: "检查变更中的行为、验证和风险", source: "(project)", content: "检查以下变更：$ARGUMENTS\n\n说明可观察行为、已有验证和需要补充的测试。" },
  { name: "write-tests", description: "为指定模块补齐用户行为测试", source: "(project:frontend)", content: "为 $1 编写测试。\n\n重点验证：$2\n优先覆盖用户可观察行为，并说明如何运行测试。" },
  { name: "explain-code", description: "解释模块职责、调用链与关键设计", source: "(user)", content: "解释 $1 的职责与调用链。\n\n结合代码说明关键设计，并给出一个简短的使用示例。" },
  { name: "session-notes", description: "整理本次会话的结论和后续工作", source: "(user)", content: "整理本次会话的关键结论、已完成工作和下一步。\n\n使用简洁的条目，并保留必要的文件与验证信息。" },
];

export const PREVIEW_TEMPLATES: PromptTemplateRow[] = templates.map((template, index) => ({
  id: index === 0 ? "demo-template" : `demo-template-${index}`,
  name: template.name,
  description: template.description,
  source: template.source,
  version: String(index).repeat(64),
}));
export const PREVIEW_TEMPLATE = PREVIEW_TEMPLATES[0]!;
export const PREVIEW_TEMPLATE_TEXT = templates[0]!.content;

export function getPreviewTemplateContent(id: string): string {
  return templates[PREVIEW_TEMPLATES.findIndex((template) => template.id === id)]!.content;
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

export function preparePreviewTemplate(id: string, argumentsText: string): string {
  const content = getPreviewTemplateContent(id);
  const args = previewArguments(argumentsText);
  const all = args.join(" ");
  const usesArguments = /\$ARGUMENTS|\$\d+/.test(content);
  const expanded = content.replace(/\$ARGUMENTS|\$(\d+)/g, (_, position: string | undefined) => position ? (args[Number(position) - 1] ?? "") : all);
  return !usesArguments && all ? `${expanded}\n\n${all}` : expanded;
}

type Tool = NonNullable<McpRuntimeStatus["servers"][number]["toolInfo"]>[number];
const tool = (server: string, name: string, description: string, readOnlyHint: boolean): Tool => ({ name: `mcp_${server}_${name}`, mcpServerName: server, mcpToolName: name, description, readOnlyHint });
const filesystemTools = [
  tool("filesystem", "read_file", "读取文件内容", true),
  tool("filesystem", "read_multiple_files", "批量读取文件", true),
  tool("filesystem", "write_file", "创建文件或写入内容", false),
  tool("filesystem", "edit_file", "按文本片段编辑文件", false),
  tool("filesystem", "create_directory", "创建目录", false),
  tool("filesystem", "list_directory", "查看目录内容", true),
  tool("filesystem", "directory_tree", "查看目录结构", true),
  tool("filesystem", "move_file", "移动文件或目录", false),
  tool("filesystem", "search_files", "按名称搜索文件", true),
  tool("filesystem", "get_file_info", "读取文件元信息", true),
  tool("filesystem", "list_allowed_directories", "查看已授权的目录", true),
];
const connectedTools: Record<string, Tool[]> = {
  filesystem: filesystemTools,
  github: [tool("github", "get_pull_request", "读取 Pull Request", true), tool("github", "list_issues", "查看仓库 Issue", true), tool("github", "get_file_contents", "读取仓库文件", true), tool("github", "create_issue", "创建 Issue", false)],
  docs: [tool("docs", "search_docs", "搜索项目文档", true), tool("docs", "read_document", "读取文档正文", true)],
};
export const PREVIEW_MCP_RUNTIME: McpRuntimeStatus = {
  available: true, startupTimeoutMs: 250, ready: false, settled: false, total: 3,
  servers: [
    { name: "filesystem", state: "ready", transport: "stdio", source: { providerName: "OMP", level: "project" }, tools: 11, toolInfo: filesystemTools },
    { name: "github", state: "pending", transport: "http", source: { providerName: "OMP", level: "user" }, tools: 0 },
    { name: "docs", state: "failed", transport: "sse", source: { providerName: "OMP", level: "project" }, tools: 0, error: "连接超时：文档服务未在等待期限内响应。" },
  ],
};

export function applyPreviewMcpAction(status: McpRuntimeStatus, result: McpAuthResult): McpRuntimeStatus {
  if (!["authorized", "connected", "removed"].includes(result.status)) return status;
  const servers = status.servers.map((server) => {
    if (server.name !== result.name) return server;
    const tools = result.status === "removed" ? [] : connectedTools[server.name]!;
    const updated = { ...server, state: result.status === "removed" ? "disconnected" as const : "ready" as const, tools: tools.length, toolInfo: tools };
    delete updated.error;
    return updated;
  });
  return { ...status, servers, ready: servers.every((server) => server.state === "ready"), settled: !servers.some((server) => server.state === "pending") };
}
