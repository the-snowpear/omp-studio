import type { ServiceDefinition, ServiceDefinitionsInput } from "./service-definitions.js";
export const CHROME_SERVICE_CHANNELS = {
  list: "omp-studio:desktop:service-definitions-list",
  save: "omp-studio:desktop:service-definitions-save",
  remove: "omp-studio:desktop:service-definitions-remove",
} as const;
export type ServiceDefinitionResult = { ok: true; definitions: ServiceDefinition[] } | { ok: false; message: string };
export type { ServiceDefinition, ServiceDefinitionsInput };
