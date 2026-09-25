import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { validateServiceSpec, type StudioServiceSpec } from "@omp-studio/studio-protocol";

export interface ServiceDefinition { id: string; revision: number; workspaceId: string; updatedAt: string; spec: StudioServiceSpec }
export interface ServiceDefinitionsInput { workspaceId: string; id?: string; revision?: number; spec?: StudioServiceSpec }
export interface SecretCodec { available(): boolean; encrypt(value: string): Buffer; decrypt(value: Buffer): string }
function scope(value: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\u0000-\u001f]/u.test(value)) throw new Error("Invalid workspace identity");
}
export function validateDefinitionInput(raw: unknown, action: "list" | "save" | "remove"): asserts raw is ServiceDefinitionsInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid service definition");
  const value = raw as ServiceDefinitionsInput;
  if (Object.keys(value).some(key => !["workspaceId", "id", "revision", "spec"].includes(key))) throw new Error("Unknown definition field");
  scope(value.workspaceId);
  if (value.id !== undefined && (typeof value.id !== "string" || !/^[a-f0-9-]{36}$/u.test(value.id))) throw new Error("Invalid definition identity");
  if (value.id !== undefined && (!Number.isSafeInteger(value.revision) || value.revision! < 1)) throw new Error("A definition revision is required");
  if (value.id === undefined && value.revision !== undefined) throw new Error("Unexpected revision");
  if (action === "remove" && !value.id) throw new Error("A definition identity is required");
  if (action === "save") validateServiceSpec(value.spec);
  else if (value.spec !== undefined || (action === "list" && value.id !== undefined)) throw new Error("Unexpected definition fields");
}

/** Encrypted local configurations, never an autostart file or a process supervisor. */
export class ServiceDefinitionStore {
  #queue: Promise<unknown> = Promise.resolve();
  constructor(readonly file: string, readonly codec: SecretCodec) {}
  async #read(): Promise<ServiceDefinition[]> {
    if (!this.codec.available()) throw new Error("Secure service configuration storage is unavailable");
    let data: Buffer;
    try { data = await readFile(this.file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    if (data.length > 8 * 1024 * 1024) throw new Error("Service configuration storage exceeds its limit");
    const value: unknown = JSON.parse(this.codec.decrypt(data));
    if (!Array.isArray(value) || value.length > 200) throw new Error("Invalid service configuration storage");
    for (const row of value) { validateDefinitionInput({ workspaceId: row.workspaceId, id: row.id, revision: row.revision, spec: row.spec }, "save"); }
    return value as ServiceDefinition[];
  }
  async list(workspaceId: string): Promise<ServiceDefinition[]> {
    scope(workspaceId); await this.#queue.catch(() => {});
    return (await this.#read()).filter(row => row.workspaceId === workspaceId);
  }
  save(input: ServiceDefinitionsInput): Promise<ServiceDefinition> {
    validateDefinitionInput(input, "save");
    return this.#mutate(async rows => {
      const index = rows.findIndex(row => row.id === input.id && row.workspaceId === input.workspaceId);
      if (input.id && (index < 0 || rows[index]!.revision !== input.revision)) throw new Error("Configuration changed; refresh before saving");
      if (!input.id && rows.length >= 200) throw new Error("Service configuration limit reached");
      const row: ServiceDefinition = { id: input.id ?? randomUUID(), revision: (input.revision ?? 0) + 1,
        workspaceId: input.workspaceId, updatedAt: new Date().toISOString(), spec: structuredClone(input.spec!) };
      if (index >= 0) rows[index] = row; else rows.push(row);
      return row;
    });
  }
  remove(input: ServiceDefinitionsInput): Promise<void> {
    validateDefinitionInput(input, "remove");
    return this.#mutate(async rows => {
      const index = rows.findIndex(row => row.id === input.id && row.workspaceId === input.workspaceId);
      if (index < 0 || rows[index]!.revision !== input.revision) throw new Error("Configuration changed; refresh before deleting");
      rows.splice(index, 1);
    });
  }
  #mutate<T>(change: (rows: ServiceDefinition[]) => Promise<T>): Promise<T> {
    const next = this.#queue.catch(() => {}).then(async () => {
      const rows = await this.#read();
      const result = await change(rows);
      const encrypted = this.codec.encrypt(JSON.stringify(rows));
      if (encrypted.length > 8 * 1024 * 1024) throw new Error("Service configuration storage exceeds its limit");
      await mkdir(dirname(this.file), { recursive: true });
      const temp = this.file + ".tmp";
      await writeFile(temp, encrypted, { mode: 0o600 });
      await rename(temp, this.file);
      return result;
    });
    this.#queue = next;
    return next;
  }
}
