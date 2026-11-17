import { appendFileSync } from "node:fs";
import { readGitHubApi } from "./release-github.mjs";

// Artifact reuse works across refs without storing a large compiler cache for
// every release tag. Only our repository's push/dispatch producers may supply
// native code that the Runtime job will package and sign.
const repo = process.env.GITHUB_REPOSITORY;
const key = process.env.NATIVE_ARTIFACT_KEY;
let runId = "";
if (process.env.REBUILD !== "true") {
  const pages = JSON.parse(await readGitHubApi(["--paginate", "--slurp", `repos/${repo}/actions/artifacts?name=${encodeURIComponent(key)}&per_page=100`], { encoding: "utf8" }));
  for (const artifact of pages.flatMap(page => page.artifacts)) {
    if (artifact.expired) continue;
    const producer = JSON.parse(await readGitHubApi([`repos/${repo}/actions/runs/${artifact.workflow_run.id}`], { encoding: "utf8" }));
    if (!["push", "workflow_dispatch"].includes(producer.event) || producer.head_repository.full_name !== repo) continue;
    runId = String(artifact.workflow_run.id);
    break;
  }
}
appendFileSync(process.env.GITHUB_OUTPUT, `run_id=${runId}\n`);
console.log(runId ? `Reuse ${key} from run ${runId}` : `Build ${key}`);
