import { join, resolve } from "node:path";
import { ArtifactLibrary } from "@omp-studio/studio-host";

const libraries = new Map<string, ArtifactLibrary>();
let active: ArtifactLibrary | undefined;
let activeProfile: string | undefined;

/** Facade rebuilds and desktop file/media IPC share one writer for the profile. */
export function artifactLibraryForProfile(profileDirectory: string): ArtifactLibrary {
  const key = resolve(profileDirectory);
  let library = libraries.get(key);
  if (!library) { library = new ArtifactLibrary({ profileDirectory: key }); libraries.set(key, library); }
  active = library; activeProfile = key;
  return library;
}

export function activeArtifactLibrary(): ArtifactLibrary {
  if (!active) throw new Error("The artifact library is not ready");
  return active;
}

export function activeMediaDirectory(): string { if (!activeProfile) throw new Error("Media profile unavailable"); return join(activeProfile, "bridge", "media-v1"); }
