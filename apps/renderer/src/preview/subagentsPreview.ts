/**
 * Preview fixtures for the model-config 子代理 tab.
 * Display-only; stories follow OMP bundled agents plus one user custom.
 */

import type { AgentDefinitionRecord, AgentDefinitionsReadModel } from "@omp-studio/client-contract";

export const AGENT_BUILTIN_TOOLS = [
  "read",
  "bash",
  "edit",
  "ast_grep",
  "ast_edit",
  "ask",
  "debug",
  "eval",
  "github",
  "glob",
  "grep",
  "lsp",
  "inspect_image",
  "browser",
  "computer",
  "checkpoint",
  "rewind",
  "security_scan",
  "task",
  "hub",
  "todo",
  "web_search",
  "write",
  "memory_edit",
  "retain",
  "recall",
  "reflect",
  "learn",
  "manage_skill",
] as const;

export const AGENT_ROLE_ALIASES = [
  "@default",
  "@smol",
  "@slow",
  "@vision",
  "@plan",
  "@designer",
  "@commit",
  "@tiny",
  "@task",
  "@advisor",
] as const;

export const AGENT_THINKING = [
  { id: "", label: "继承" },
  { id: "auto", label: "Auto" },
  { id: "off", label: "Off" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "XHigh" },
  { id: "max", label: "Max" },
] as const;

function agent(partial: AgentDefinitionRecord): AgentDefinitionRecord {
  return partial;
}

export function createPreviewAgentDefinitions(now = "2026-08-14T08:00:00.000Z"): AgentDefinitionsReadModel {
  return {
    agents: [
      agent({
        name: "notes",
        description: "Use this agent when capturing a concise research memo the parent can reuse.",
        systemPrompt: "Write a short, structured memo. Prefer citations over speculation.",
        tools: ["read", "grep", "glob", "web_search", "yield"],
        model: ["@smol"],
        thinkingLevel: "low",
        source: "user",
        sourceLabel: "用户",
        editable: true,
        canDelete: true,
        canFork: false,
        disabled: false,
      }),
      agent({
        name: "scout",
        description: "MUST be used for exploratory codebase research, rapid code analysis, and broad pattern searches.",
        systemPrompt: "",
        tools: ["read", "grep", "glob", "web_search", "yield"],
        model: ["@smol"],
        thinkingLevel: "medium",
        readSummarize: false,
        source: "bundled",
        sourceLabel: "内置",
        editable: false,
        canDelete: false,
        canFork: true,
        disabled: false,
        promptPacked: true,
      }),
      agent({
        name: "reviewer",
        description: "Code review specialist for quality/security analysis",
        systemPrompt: "",
        tools: ["read", "grep", "glob", "bash", "lsp", "web_search", "ast_grep", "yield"],
        spawns: ["scout"],
        model: ["@slow"],
        source: "bundled",
        sourceLabel: "内置",
        editable: false,
        canDelete: false,
        canFork: true,
        disabled: false,
        promptPacked: true,
      }),
      agent({
        name: "task",
        description: "General-purpose subagent with full capabilities for delegated multi-step tasks",
        systemPrompt: "",
        spawns: "*",
        model: ["@task"],
        thinkingLevel: "auto",
        source: "bundled",
        sourceLabel: "内置",
        editable: false,
        canDelete: false,
        canFork: true,
        disabled: true,
        promptPacked: true,
      }),
    ],
    warnings: [],
    builtinToolNames: [...AGENT_BUILTIN_TOOLS],
    roleAliases: [...AGENT_ROLE_ALIASES],
    projectScopeAvailable: true,
    generatedAt: now,
  };
}
