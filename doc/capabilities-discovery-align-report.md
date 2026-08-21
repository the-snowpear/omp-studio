# 能力中心 Skills / Plugins 识别范围对齐 OMP — 执行审核报告

- 计划：local Claude plan (not in this repository)
- 执行时间：2026-08-14
- 基线：`4e15ba1`（工作区含用户未提交改动，未动）
- 任务前备份：`backup/2026-08-14/capabilities-discovery-align-005622/`（含 README.md）

---

## 1. 变更文件清单

### 新建

| 文件 | 做了什么 |
|---|---|
| `packages/host-client-api/src/omp-discovery/plugin-roots.ts` | 共享插件根枚举：`listOmpPluginRoots`（用户 + 项目根，deps ∪ lock 并集，项目 shadow 用户，enabled 规则）、`listSettingsExtensionRoots`（settings.json extensions）、`resolvePluginSkillDirs`（默认 `skills/` + plugin.json 声明路径，越界丢弃 + warning） |
| `packages/host-client-api/src/omp-discovery/agent-plugin.ts` | 最小 Agent Plugins 分类：`classifyAgentPluginRoot`（plugin.json `$schema` 前缀匹配）+ `legacyProviderAllowed`（standard 根对 skills 独占） |
| `packages/host-client-api/test/omp-discovery.test.ts` | 新 fixture 测试，覆盖验收标准 11 项（见 §4） |
| `capabilities-discovery-align-report.md` | 本报告 |

### 修改

| 文件 | 做了什么 |
|---|---|
| `packages/host-client-api/src/omp-discovery/providers.ts` | 删除 `loadGeminiSkills`；codex priority 60→70；native / omp-plugins / managed 开 `requireDescription: true`；新增 `loadOpencodeSkills`（55）、`loadClaudePluginsSkills`（70）、`loadAgentPluginsSkills`（75）；`loadOmpPluginsSkills` 改走共享根枚举 + settings extension 根 + `legacyProviderAllowed` 门 |
| `packages/host-client-api/src/omp-discovery/index.ts` | `discoverSkills` 换 provider 列表（10 个）；`discoverPlugins` 改走 `listOmpPluginRoots` + `listClaudePluginRoots`（realpath 去重），吃掉旧 L189 plugin.json TODO（`skills` 字段进 `skillDirs`，默认含 `<root>/skills`） |
| `packages/host-client-api/src/omp-discovery/types.ts` | 新增 `SkillDiscoveryFilters`（字段全部注释保留）；`DiscoveryOptions` 加 `filters?`；`DiscoveredPlugin` 加 `hasOmpManifest`（内部类型，非 client-contract） |
| `packages/host-client-api/src/omp-discovery/registry.ts` | `deduplicateSkills` 返回 `{ skills, warnings }`；被丢弃的同名 skill 产生 `name collision: "<name>" already loaded from <winner.path>, skipping this one` warning；同 priority 内仍按 name 排序 first-wins |
| `packages/host-client-api/src/omp-extensibility-adapter.ts` | 文件头改为诚实描述（10 provider + Not Runtime loadSkills()）；`toPluginRecord` 无 omp/pi manifest → `status: "error"` + `err: "package.json 缺少 omp/pi"`（sanitizeDisplayText，不带路径） |
| `packages/host-client-api/test/omp-extensibility-adapter.test.ts` | 修与新语义冲突的旧断言（commit-msg / toolItems 等，见 §4）；新增「无 omp/pi → error」用例 |
| `apps/renderer/src/CapabilitiesPage.tsx` (~L500) | 文案改为「Skills / Plugins 扫描 OMP / Claude / Agents / Codex / OpenCode / GitHub / 插件与市场（configured 库存，非 Runtime loaded）」 |
| `apps/renderer/src/SkillsDrawer.tsx` (~L268) | 空态文案改为「已扫描 OMP 兼容目录与已安装插件（configured 库存）」 |
| `FRONTEND_UI_PROGRESS.md` (L76 / L128) | 范围描述与上表一致，不写「已覆盖 Runtime effective」 |

### 未改动（约束确认）

`apps/desktop/**`、`packages/client-contract/**`、`omp-patch/**`（vendor 只读）、preview fixtures、`packages/host-client-api/src/omp-discovery/helpers.ts`（现有 `scanSkillsFromDir` / `listClaudePluginRoots` / `resolveActiveProjectRegistryPath` 直接复用，containment 小 helper 放在 `plugin-roots.ts:resolvePluginSkillDirs`）。

---

## 2. Provider 对照表（完成后的真实代码）

| providerId | priority | requireDescription | 实际扫描函数（file:line） | 已挂进 `discoverSkills` |
|---|---|---|---|---|
| `native` | 100 | **true**（原 false） | `loadNativeSkills`（providers.ts:29） | 是 |
| `omp-plugins` | 90 | **true**（原 false） | `loadOmpPluginsSkills`（providers.ts:94） | 是 |
| `claude` | 80 | false | `loadClaudeSkills`（providers.ts:134） | 是（路径未动） |
| `agent-plugins` | 75 | false | `loadAgentPluginsSkills`（providers.ts:180） | 是（**新增**） |
| `claude-plugins` | 70 | false | `loadClaudePluginsSkills`（providers.ts:241） | 是（**新增 skill 扫描**，原来只列插件） |
| `agents` | 70 | false | `loadAgentsSkills`（providers.ts:373） | 是（未动） |
| `codex` | **70**（原 60） | false | `loadCodexSkills`（providers.ts:275） | 是（只改 priority） |
| `opencode` | 55 | false | `loadOpencodeSkills`（providers.ts:315） | 是（**新增**） |
| `github` | 30 | true | `loadGithubSkills`（providers.ts:354） | 是（未动） |
| `omp-managed` | 5 | **true**（原 false） | `loadManagedSkills`（providers.ts:74） | 是 |
| `gemini` | — | — | **已删除**（`loadGeminiSkills` 及 `discoverSkills` 调用均移除；`.gemini/skills` 不再扫描） | 否 |

不扫：cursor / windsurf / cline / vscode / AGENTS.md（OMP 未注册对应 skill provider）。

---

## 3. 插件根对照

### `listOmpPluginRoots(home, cwd)`（plugin-roots.ts:138）

```ts
export async function listOmpPluginRoots(home: string, cwd: string): Promise<{
  roots: OmpPluginRoot[];
  warnings: DiscoveryWarning[];
}>
```

实际读取的文件（每个根）：

1. **用户根** `getPluginsDir(home)`（`~/.omp/plugins` 或 XDG）：`package.json`、`omp-plugins.lock.json`、`installed_plugins.json`（仅用于把同名依赖分类为 `marketplace`，保持旧行为）
2. **项目根** `<projectAnchor>/.omp/plugins`：anchor 由现有 `helpers.ts:resolveActiveProjectRegistryPath(cwd)` 给出（先找最近 `.omp/`，否则最近 `.git/`，停在 home 前），项目根 = 返回路径的 dirname；与用户根相同则跳过（vendor 同）
3. **overrides** `<cwd>/.omp/plugin-overrides.json` 的 `disabled` 数组（现有行为，未改路径）

规则：

- **并集**：`package.json#dependencies` ∪ `omp-plugins.lock.json#plugins`（lock-only 条目以空 spec 补入，不再漏）
- **shadow**：`Map<name, OmpPluginRoot>` 项目后写覆盖用户（`collectPluginsAtRoot` 后按 name 合并）
- **enabled** = lock 中 `enabled !== false`（缺省 true）且不在 overrides `disabled` 数组
- 每项读 `<root>/node_modules/<name>/package.json` 得 `version`（缺省 `"0.0.0"`）、`hasOmpManifest`（omp/pi 是否存在）、`manifest`（`parseManifest`）
- `sourceKind` 沿用从 index.ts 挪来的 `classifyPluginSource(spec, marketplace)`（npm / link / git / marketplace）

### `listSettingsExtensionRoots(home, cwd)`（plugin-roots.ts:201）

```ts
export async function listSettingsExtensionRoots(home: string, cwd: string): Promise<Array<{
  path: string;
  level: "user" | "project";
}>>
```

- 读 `<cwd>/.omp/settings.json`（project）与 `getAgentDir(home)/settings.json`（user）的 `extensions` 字符串数组
- `~` 展开（对 home），相对路径相对 `cwd` 解析；**只返回存在的目录**（vendor 行为）；project 先、first-seen-wins 去重

### `discoverPlugins`（index.ts:77）

- `listOmpPluginRoots` 每条 → `DiscoveredPlugin`（含 `skillDirs` = `resolvePluginSkillDirs`）
- `listClaudePluginRoots`（helpers.ts，三层 registry 栈 + local scope 过滤，未动）→ 用 `fs.realpath` 规范化路径与 omp 根去重，未覆盖的补 `sourceKind: "marketplace"` 记录
- `.claude-plugin/plugin.json`：读 `version` + `skills`（`string | string[]`，`resolvePluginSkillDirs` plugin-roots.ts:229）；解析为绝对路径后 `path.relative(pluginRoot, abs)` 以 `..` 开头则丢弃 + warning；默认始终包含 `<root>/skills`

---

## 4. 测试结果

### `npm test -w @omp-studio/host-client-api`（完整输出）

```
> @omp-studio/host-client-api@0.1.0 test
> npm run build && node --test "dist/test/*.test.js"


> @omp-studio/host-client-api@0.1.0 build
> tsc -p tsconfig.json

▶ omp-discovery scope alignment
  ✔ does not scan .gemini/skills (gemini provider removed) (14.4307ms)
  ✔ scans opencode user (~/.config/opencode) and project (.opencode) skills (19.5576ms)
  ✔ scans marketplace plugin skills plus plugin.json-declared dirs (claude-plugins) (12.4905ms)
  ✔ agent-plugins roots contribute skills exclusively via the agent-plugins provider (17.677ms)
  ✔ project plugins root lists lock-only packages (npm ∪ lock union) (11.8468ms)
  ✔ settings extensions contribute skills to the omp-plugins scan (12.196ms)
  ✔ native skills without description are dropped (5.9105ms)
  ✔ managed skills without description are dropped (5.9621ms)
  ✔ priority order: project native 100 > omp-plugins 90 > claude 80 > managed 5 (13.6999ms)
  ✔ project plugin shadows user plugin of the same name (10.8303ms)
  ✔ lock-disabled plugins stay listed as disabled and their skills are not scanned (8.4376ms)
  ✔ frontmatter enabled: false skills are never listed (4.9459ms)
✔ omp-discovery scope alignment (138.6383ms)
▶ createOmpExtensibilityService
  ✔ returns empty inventory when the home tree is missing (9.7536ms)
  ✔ reads user, project, managed skills and prefers the project winner (21.347ms)
  ✔ lists plugins from package.json, lock, and project overrides (10.1428ms)
  ✔ lists packages without omp/pi as error with a path-free err (6.3273ms)
✔ createOmpExtensibilityService (50.0147ms)
ℹ tests 16
ℹ suites 2
ℹ pass 16
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 240.2913
```

### `npm run typecheck -w @omp-studio/host-client-api`（完整输出）

```
> @omp-studio/host-client-api@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit
```

（无输出，退出码 0）

另跑 `npm run typecheck -w @omp-studio/renderer`（`tsc -b`）通过 —— UI 文案改动未破坏 renderer。

### 新用例列表（`test/omp-discovery.test.ts`）与验收标准对应

| 用例 | 对应验收标准（计划 Step 10） |
|---|---|
| does not scan `.gemini/skills`（项目 + 用户两个 fixture 均不出现） | 1 |
| scans opencode user / project skills（scope、sourceLabel 断言） | 2 |
| scans marketplace plugin skills + plugin.json-declared dirs（`sourceKind === "plugin"`、声明目录 `mkt2` 出现、越界 `../outside` 丢弃 + warning、插件记录 `marketplace` / version 9.9.9 / configured） | 3 |
| agent-plugins roots contribute skills exclusively（内部 `providerId === "agent-plugins"`、显示层 `sourceKind === "plugin"`；若 omp-plugins(90)/claude-plugins(70) 误扫同根，winner 会是它们而非 75，故 providerId 断言即独占性证明） | 4 |
| project plugins root lists lock-only packages（`listOmpPluginRoots` scope === "project"；`discoverAll` 列出；hasOmpManifest） | 5 |
| settings extensions contribute skills to omp-plugins scan | 6 |
| native skills without description are dropped | 7 |
| managed skills without description are dropped | 8 |
| priority order: project native 100 > omp-plugins 90 > claude 80 > managed 5（`a`→项目、`b`→插件、`c`→用户/global） | 9 |
| project plugin shadows user plugin（同名 1.0.0 vs 2.0.0 → 2.0.0） | 10（项目 shadow） |
| lock-disabled plugins stay listed as disabled and their skills are not scanned | 10（overrides 回归）+ 11 |
| frontmatter `enabled: false` skills are never listed | 11 |

另在 `test/omp-extensibility-adapter.test.ts` 新增：`lists packages without omp/pi as error with a path-free err`（status "error"、err 恰为 `package.json 缺少 omp/pi`、不含 home 路径）—— 对应 Step 8 行为。

### 旧测试改了什么、为什么（对照 Step 1 基线）

基线（改前 `npm test`）2 红 1 绿：

1. **`reads user, project, managed skills and prefers the project winner` 红**：与计划预测一致 —— fixture `commit-msg` 写 `enabled: false`，扫描器本来就跳过它，测试却断言它存在且 `enabled === false`。改为：期望列表 `["oss-audit", "shared"]`，显式断言 `commit-msg` 不出现；`oss-audit` 补上 `description` 后继续作为 managed 出现（`error` 不再出现）；collision warning 含 `shared` 的断言保留（现由 registry warning 提供）。
2. **`lists plugins from package.json, lock, and project overrides` 红**：`toolItems` 期望 `["tools"]`，实际 `["dist/tools.ts"]`。这是**计划外**的既有红断言：`collectDeclaredItems` 按 manifest 声明原样收集条目名（`PluginRecord` 文档即「declared entry names」），测试期望 basename 是错的。按实际语义修正为 `["dist/tools.ts"]`、`["commands/worktree.md"]`、`["dist/hooks.ts"]`、`["ui/sidebar.ts"]`（不改扫描器/collectDeclaredItems）。

未为迁就旧测试而改回 `requireDescription: false`，也未把 `enabled: false` skill 重新列出。

---

## 5. 行为变化（breaking）

- **缺 description 的 native / omp-plugins / managed skill**：从「带着 `error: "SKILL.md 缺少 description"` 显示」变为「**不出现**」（requireDescription 对齐 OMP；github 原本就是 true）
- **`enabled: false` 的 skill**：仍不出现（扫描器未改，保持）
- **`.gemini/skills`**：不再出现（provider 删除）
- **无 `omp`/`pi` 的 npm/link/git 插件包**：从「configured 或不存在」变为 `status: "error"` + `err: "package.json 缺少 omp/pi"`（不带路径；marketplace 安装保持 `configured`，见 §7）
- **插件列表新增来源**：项目插件根 `<projectAnchor>/.omp/plugins`、lock-only 链接（deps ∪ lock 并集）、项目 shadow 用户 —— 之前只有用户根 deps
- **codex priority 60 → 70**：codex 与 claude-plugins/agents 同 priority，赢过 opencode(55)/github(30)
- **新出现的 skill 来源**：opencode（`~/.config/opencode/skills`、`<cwd>/.opencode/skills`）、claude-plugins（marketplace `skills/` + plugin.json 声明路径）、agent-plugins（standard 根 `skills/`）
- **collision warning**：同名被更高 priority 覆盖时，warnings 出现 `name collision: "<name>" already loaded from …`（适配器 redactText 后最多 32 条，绝对路径不泄漏）

---

## 6. Known gaps（相对完整 OMP `loadSkills`）

- **settings 过滤未接**：`SkillDiscoveryFilters` 字段已声明（types.ts），`discover*` 本轮忽略；`skills.enabled` / `ignoredSkills` / `includeSkills` / `customDirectories` / `disabledExtensions` 均未读
- **`--plugin-dir`、CLI `--extension` / `-e` 未做**（vendor 的 `injectOmpExtensionCliRoots` 未移植）
- **desktop cwd 仍是 `process.cwd()`**：`apps/desktop/src/host-composition.ts:232` `extensibility: seams.extensibility ?? createOmpExtensibilityService()` → 适配器 `cwd = process.cwd()` = Electron Main 启动目录（开发时常为仓库根，打包后为安装目录），**不是用户工作区**。后果：项目级 `.omp/skills`、`.claude/skills`、`.opencode/skills`、项目 plugins 根只在 Main cwd 恰等于该项目时出现；用户级不受影响；测试显式传 `{home, cwd}` 不受影响。下轮应改为 `createOmpExtensibilityService({ cwd: workspacePath })`（本轮按计划禁止改 desktop）
- **`skillsManifestReplacesFallback` 未做**：本轮**永远**扫默认 `skills/` + manifest 声明路径（并集），不做 marketplace.json `source: "./"` 时的替换语义
- **WSL 第二 home 未做**（agents provider）
- **agent-plugins 未做完整 schema / containRoot / `${PLUGIN_DATA}` / closed-schema 校验**（最小实现：仅 `$schema` 前缀分类 + 独占）
- **不是 Runtime effective/loaded**：UI 明示 configured 库存，`SkillRecord` 无 `loaded` 字段，未宣称 Runtime 加载

---

## 7. 主动偏离计划的地方

1. **marketplace 插件记录 `hasOmpManifest` 恒为 true → `status` 保持 `"configured"`**（index.ts:141 附近注释）。计划说「无 omp/pi 的包 → error」，但 marketplace 安装本来就有自己的 manifest 且旧行为是 configured（计划亦说「有 manifest 的保持 configured」）；error 规则只作用于 npm/link/git 包。影响：验收标准里「无 omp/pi → error」仅对 npm/link/git 生效。
2. **`discoverPlugins` 保持返回 `DiscoveredPlugin[]`**，枚举期 warnings（如 malformed JSON）被丢弃 —— 与旧实现丢弃 `listClaudePluginRoots` warnings 的行为一致；collision warning 仍走 skills 侧进 `DiscoveryResult.warnings`。
3. **`listSettingsExtensionRoots` 直接过滤为「存在的目录」**（vendor 行为）；非目录条目静默跳过，不返回也不 warning。
4. **omp-plugins skill 的 `scope` 保持 `"builtin"`**（含项目根插件，旧行为不变）；settings extension 目录按 project → `"workspace"` / user → `"builtin"` 映射。
5. **agent-plugins 候选中的 omp plugin package dirs 只取 `enabled` 的**（vendor `listInstalledPluginRoots` 同语义）。
6. **containment 小 helper 放在 `plugin-roots.ts:resolvePluginSkillDirs` 而非 helpers.ts**（计划说 helpers「需要的话加」，等价）。
7. **`.claude-plugin/plugin.json` JSON 解析失败静默忽略**（旧代码同样 catch；不额外 warning）。
8. 计划建议的旧测试改写里「managed 缺 description 被丢弃」我放在了新文件 `omp-discovery.test.ts`（旧文件 fixture 的 `oss-audit` 补了 description 保留断言）；覆盖等价。

以上均不影响验收表中的目录集合语义。

---

## 8. 建议审核方抽查的 5 个点

1. **`packages/host-client-api/src/omp-discovery/plugin-roots.ts:138`** `listOmpPluginRoots` —— 并集（deps ∪ lock）、项目 shadow 用户、enabled 判定（lock `enabled !== false` + overrides `disabled`）三条规则是否与计划一致
2. **`packages/host-client-api/src/omp-discovery/providers.ts:94`** `loadOmpPluginsSkills` —— 是否走共享根枚举 + settings extension 根，且每个根先过 `legacyProviderAllowed(root, "skills")`
3. **`packages/host-client-api/src/omp-discovery/providers.ts:180`** `loadAgentPluginsSkills` —— 候选根 = marketplace ∪ enabled omp 包 ∪ settings extensions；仅 `kind === "standard"` 扫 `skills/`；独占性
4. **`packages/host-client-api/src/omp-discovery/index.ts:77`** `discoverPlugins` —— marketplace 根 realpath 去重、`.claude-plugin/plugin.json` `skills` 进 `skillDirs`、默认含 `<root>/skills`
5. **`packages/host-client-api/src/omp-discovery/registry.ts:14`** `deduplicateSkills` —— 同 priority 内 name 排序 first-wins 保持确定性，被丢者产生 `name collision` warning（不进 UI 合同新字段）

约束复核：未改 vendor、未 import vendor；未改 desktop / host-composition；未扩 client-contract；`filters?` 已留且被忽略；UI 无「已与 Runtime 一致 / 已加载」；无 `any`；无新依赖（仅 node:fs/promises + 既有 yaml）。
