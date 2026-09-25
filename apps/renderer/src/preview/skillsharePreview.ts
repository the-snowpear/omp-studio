import type { SkillshareResultMap } from "@omp-studio/studio-protocol";
const hit = { package: "@studio/service-review", description: "检查服务配置与运行日志，保存配置后由使用者明确启动。", version: "1.2.0", downloads: 184, updatedAt: 1789948800000 };
export const PREVIEW_SKILLSHARE_STATUS: SkillshareResultMap["skillshare.status"] = { registry: "https://skills.omp.sh", accountAuthenticated: true, publishAuthenticated: true, privateTokenChannel: true, actions: [] };
export const PREVIEW_SKILLSHARE_SEARCH: SkillshareResultMap["skillshare.search"] = { hits: [hit], total: 1, page: 0, perPage: 20 };
export const PREVIEW_SKILLSHARE_PACKAGE: SkillshareResultMap["skillshare.package"] = {
  package: hit.package, description: hit.description, keywords: ["services", "review"], owners: ["studio"], tags: { latest: "1.2.0", stable: "1.1.0" }, totalVersions: 2,
  versions: [{ version: "1.2.0", integrity: "sha512-demo", bytes: 4120, fileCount: 2, hasScripts: true, yanked: false, publishedAt: hit.updatedAt }, { version: "1.1.0", integrity: "sha512-demo-previous", bytes: 3000, fileCount: 1, hasScripts: false, yanked: false, publishedAt: hit.updatedAt - 86400000 }],
  selected: { version: { version: "1.2.0", integrity: "sha512-demo", bytes: 4120, fileCount: 2, hasScripts: true, yanked: false, publishedAt: hit.updatedAt }, files: [{ path: "SKILL.md", size: 3800, executable: false }, { path: "scripts/check.sh", size: 320, executable: true }], publisher: "studio", provenance: "演示：来自已验证的发布工作流" },
};
export const PREVIEW_SKILLSHARE_INSTALLED: SkillshareResultMap["skillshare.installed"] = { total: 1, skills: [{ package: hit.package, scope: "project", range: "^1.0.0", version: "1.1.0", stored: true }] };
export const PREVIEW_SKILLSHARE_TOKENS: SkillshareResultMap["skillshare.tokens"] = { tokens: [{ id: "demo-ci", name: "Release CI", packages: [hit.package], createdAt: hit.updatedAt - 86400000, expiresAt: hit.updatedAt + 2592000000 }] };
