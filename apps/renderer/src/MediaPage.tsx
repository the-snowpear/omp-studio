import { LiveAudioPane } from "./media/LiveAudioPane";
import type { StudioClient } from "@omp-studio/client-contract";
import { ArtifactLibraryPane } from "./media/ArtifactLibraryPane";
import { MediaWorkbench } from "./media/MediaWorkbench";
import { useCallback, useState } from "react";

export function MediaPage({ client, workspaceId, sessionId, runtimeAvailable = false, onInsert }: { client: StudioClient; workspaceId?: string | undefined; sessionId?: string | undefined; runtimeAvailable?: boolean; onInsert?: (text: string) => void }) {
  const [refresh, setRefresh] = useState(0); const changed = useCallback(() => setRefresh(value => value + 1), []);
  return <div className="media-page"><MediaWorkbench client={client} workspaceId={workspaceId} sessionId={sessionId} available={runtimeAvailable} onInsert={onInsert} onArtifactsChanged={changed} /><LiveAudioPane client={client} sessionId={sessionId} available={runtimeAvailable} /><ArtifactLibraryPane client={client} workspaceId={workspaceId} sessionId={sessionId} refreshKey={refresh} /></div>;
}
