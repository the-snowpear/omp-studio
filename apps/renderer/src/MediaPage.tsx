import { useCallback, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { MediaKind } from "@omp-studio/studio-protocol";
import { LiveAudioPane } from "./media/LiveAudioPane";
import { ArtifactLibraryPane } from "./media/ArtifactLibraryPane";
import { MediaWorkbench, takeMediaIntent } from "./media/MediaWorkbench";
import { WorkspacePanel, WorkspaceTabs } from "./workspaces/Workspace";
import { useI18n } from "./i18n";
import "./media/media.css";

type MediaView = "generate" | "voice" | "library";
const GENERATION_KINDS: readonly MediaKind[] = ["image", "video"];
const VOICE_KINDS: readonly MediaKind[] = ["transcription", "speech"];
const TRANSCRIPTION_KIND: readonly MediaKind[] = ["transcription"];
const SPEECH_KIND: readonly MediaKind[] = ["speech"];

export function MediaPage({
  client,
  workspaceId,
  sessionId,
  runtimeAvailable = false,
  onInsert,
}: {
  client: StudioClient;
  workspaceId?: string | undefined;
  sessionId?: string | undefined;
  runtimeAvailable?: boolean;
  onInsert?: (text: string) => void;
}) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [intent] = useState(takeMediaIntent);
  const [view, setView] = useState<MediaView>(() =>
    VOICE_KINDS.includes(intent) ? "voice" : "generate",
  );
  const [voiceView, setVoiceView] = useState<
    "transcription" | "speech" | "live"
  >(intent === "speech" ? "speech" : "transcription");
  const [refresh, setRefresh] = useState(0);
  const changed = useCallback(() => setRefresh((value) => value + 1), []);
  const common = {
    client,
    workspaceId,
    sessionId,
    available: runtimeAvailable,
    onInsert,
    onArtifactsChanged: changed,
  };
  return (
    <div className="media-page workspace-page">
      <WorkspaceTabs<MediaView>
        id="media-workspace"
        label={zh ? "媒体工作区" : "Media workspace"}
        value={view}
        onChange={setView}
        items={[
          { id: "generate", icon: "image", label: zh ? "生成" : "Generate" },
          { id: "voice", icon: "message", label: zh ? "语音" : "Voice" },
          { id: "library", icon: "folder", label: zh ? "产物库" : "Library" },
        ]}
      />
      <WorkspacePanel
        id="media-workspace"
        name="generate"
        active={view === "generate"}
      >
        <MediaWorkbench
          {...common}
          kinds={GENERATION_KINDS}
          initialType={GENERATION_KINDS.includes(intent) ? intent : "image"}
          visible={view === "generate"}
          onOpenLibrary={() => setView("library")}
        />
      </WorkspacePanel>
      <WorkspacePanel
        id="media-workspace"
        name="voice"
        active={view === "voice"}
      >
        <WorkspaceTabs<"transcription" | "speech" | "live">
          id="media-voice"
          label={zh ? "语音功能" : "Voice tools"}
          value={voiceView}
          onChange={setVoiceView}
          items={[
            {
              id: "transcription",
              icon: "message",
              label: zh ? "转写音频" : "Transcribe audio",
            },
            {
              id: "speech",
              icon: "message",
              label: zh ? "合成语音" : "Generate speech",
            },
            { id: "live", icon: "message", label: "Live" },
          ]}
        />
        <WorkspacePanel
          id="media-voice"
          name="transcription"
          active={voiceView === "transcription"}
        >
          <MediaWorkbench
            {...common}
            kinds={TRANSCRIPTION_KIND}
            initialType="transcription"
            visible={view === "voice" && voiceView === "transcription"}
            onOpenLibrary={() => setView("library")}
          />
        </WorkspacePanel>
        <WorkspacePanel
          id="media-voice"
          name="speech"
          active={voiceView === "speech"}
        >
          <MediaWorkbench
            {...common}
            kinds={SPEECH_KIND}
            initialType="speech"
            visible={view === "voice" && voiceView === "speech"}
            onOpenLibrary={() => setView("library")}
          />
        </WorkspacePanel>
        <WorkspacePanel
          id="media-voice"
          name="live"
          active={voiceView === "live"}
        >
          <LiveAudioPane
            client={client}
            sessionId={sessionId}
            available={runtimeAvailable}
            visible={view === "voice" && voiceView === "live"}
          />
        </WorkspacePanel>
      </WorkspacePanel>
      <WorkspacePanel
        id="media-workspace"
        name="library"
        active={view === "library"}
      >
        <ArtifactLibraryPane
          client={client}
          workspaceId={workspaceId}
          sessionId={sessionId}
          refreshKey={refresh}
          visible={view === "library"}
        />
      </WorkspacePanel>
    </div>
  );
}
