import { DesktopSession } from "@oh-my-pi/pi-natives";
import type {
	DesktopCapabilities,
	DesktopCapture,
	DesktopDisplay,
	DesktopWindow,
	DesktopScreenState,
	DesktopObservation,
	AxSnapshotOptions,
} from "@oh-my-pi/pi-natives";
import type { ComputerStructureNode } from "../computer-workspace-protocol";

/** Local compatibility adapter until the host native binding has been rebuilt. Probe the getter, never assume an ignored option worked. */
export interface ComputerObserver {
	readonly observationOnly?: boolean;
	readonly capabilities: DesktopCapabilities;
	readonly screenState: DesktopScreenState;
	listDisplays(): Promise<DesktopDisplay[]>;
	listWindows(): Promise<DesktopWindow[]>;
	capture(target: string, caps?: { maxWidth?: number; maxHeight?: number }): Promise<DesktopCapture>;
	observe(
		target: string,
		caps?: { maxWidth?: number; maxHeight?: number },
		options?: AxSnapshotOptions,
	): Promise<DesktopObservation & { nodes?: ComputerStructureNode[] | null; coordinateSpace?: string | null }>;
	cancel(): void;
	close(): Promise<void>;
}
export function createComputerObserver(): ComputerObserver {
	const options = { display: "all", observationOnly: true };
	return new DesktopSession(options);
}
