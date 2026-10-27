import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";

export interface RemoteProvisioning {
  modelsYml: string;
  settings: Record<string, unknown>;
  brokerToken: string;
}
export const MIRRORED_MODEL_SETTINGS = ["model", "modelRoles", "disabledProviders", "thinking", "tier", "auth"] as const;
/** The target edits only Studio's private agent profile; remote project settings remain native. */
export async function applyRemoteProvisioning(state: string, brokerUrl: string, input: RemoteProvisioning): Promise<void> {
  const directory = join(state, "agent"); await mkdir(directory, { recursive: true, mode: 0o700 });
  const models = parse(input.modelsYml || "providers: {}\n");
  if (!models || typeof models !== "object" || Array.isArray(models)) throw new Error("模型配置必须为 YAML 对象");
  const path = join(directory, "config.yml");
  const config = parse(await readFile(path, "utf8").catch(error => { if (error.code === "ENOENT") return "{}"; throw error; })) as Record<string, unknown> ?? {};
  for (const key of MIRRORED_MODEL_SETTINGS) {
    if (key === "auth") continue;
    if (Object.hasOwn(input.settings, key)) config[key] = input.settings[key]; else delete config[key];
  }
  // Native discovery delegates refresh to the local vault. Refresh tokens never enter this file.
  process.env.OMP_AUTH_BROKER_URL = brokerUrl;
  process.env.OMP_AUTH_BROKER_TOKEN = input.brokerToken;
  const broker = { url: brokerUrl, token: input.brokerToken };
  const auth = config.auth && typeof config.auth === "object" ? config.auth as Record<string, unknown> : {};
  config.auth = { ...auth, broker };
  const save = async (file: string, contents: string) => { const temporary = `${file}.studio-tmp`; await writeFile(temporary, contents, { mode: 0o600 }); await rename(temporary, file); };
  await save(join(directory, "models.yml"), stringify(models)); await save(path, stringify(config));
}
