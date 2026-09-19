// Explicitly run with --apply after reviewing the generated changes.
// Never changes asset names, tag targets, or published download bytes.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const repo = "the-snowpear/omp-studio";
const gh = (...args) => execFileSync("gh", [...args, "--repo", repo], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
if (process.argv.includes("--apply")) {
  const planPath = resolve(process.argv[process.argv.indexOf("--apply") + 1] ?? "");
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  if (plan.repo !== repo || !Array.isArray(plan.releases)) throw new Error("Invalid release edit plan");
  for (const release of plan.releases) {
    const current = JSON.parse(gh("release", "view", release.tagName, "--json", "name,body,assets"));
    if (current.name !== release.original.name || current.body !== release.original.body || JSON.stringify(current.assets.map(a => [a.name, a.id, a.digest]).sort()) !== JSON.stringify(release.original.assets.map(a => [a.name, a.id, a.digest]).sort())) throw new Error(`Release changed since review: ${release.tagName}`);
    gh("release", "edit", release.tagName, "--title", release.title, "--notes-file", release.notesPath);
    console.log(`Updated release text: ${release.tagName}`);
  }
} else {
  const now = new Date(), stamp = now.toISOString().replace(/[:.]/g, "-");
  const directory = resolve("backup", now.toISOString().slice(0, 10), `release-descriptions-${stamp}`);
  await mkdir(directory, { recursive: true });
  const list = JSON.parse(gh("release", "list", "--limit", "100", "--json", "tagName,isDraft"));
  const releases = [];
  for (const row of list) {
    if (row.isDraft || !/^v0\.1\.[0-5]$/.test(row.tagName)) continue;
    const original = JSON.parse(gh("release", "view", row.tagName, "--json", "name,body,assets"));
    const installers = original.assets.filter(a => /^OMP-Studio-Setup-.*\.exe$/i.test(a.name));
    const title = `OMP Studio ${row.tagName}`;
    const notes = `# ${title}\n\n## 安装下载\n\n${installers.map(a => `- [Windows ${a.name.includes("arm64") ? "ARM64" : "x64"} 安装包](${a.url})`).join("\n")}\n\n这是历史版本。新用户请优先使用[最新桌面版](https://github.com/${repo}/releases/latest)。此版本仍使用旧更新机制；新版增量更新功能不适用于此版本。\n\n<details>\n<summary>附件用途：避免误下载</summary>\n\n- **OMP-Studio-Setup-*.exe**：桌面安装包，普通用户使用这个文件。\n- **omp-runtime-*-omp.exe**：内部运行时，不是 OMP Studio 安装包，也不应直接覆盖安装目录。\n- **omp-runtime-*.json**：Runtime 签名及元数据，须配套使用。\n- **omp-studio-app-*.tar.gz**：旧版界面/preload 更新包，不包含完整桌面程序。\n- **update-index*.json / *.blockmap / *.yml**：自动更新元数据，无需手动打开。\n- GitHub 自动提供的 Source code：源码归档，不是可运行安装包。\n\n历史附件和下载链接均保留。\n\n</details>\n\n## 原发行说明\n\n${original.body?.trim() || "该版本未提供详细发行说明。"}\n`;
    const notesPath = join(directory, `${row.tagName}-new.md`);
    await writeFile(notesPath, notes);
    await writeFile(join(directory, `${row.tagName}-original.json`), JSON.stringify(original, null, 2));
    releases.push({ tagName: row.tagName, original, title, notesPath });
  }
  await writeFile(join(directory, "README.md"), `# Release description backup\n\nCreated ${now.toISOString()}. Reason: user requested clearer historical download descriptions.\nOnly titles and bodies change; assets remain unchanged.\nRestore: use each *-original.json name/body with gh release edit --title and --notes-file. Inspect current remote state first.\n`);
  await writeFile(join(directory, "plan.json"), JSON.stringify({ repo, releases }, null, 2));
  console.log(join(directory, "plan.json"));
}
