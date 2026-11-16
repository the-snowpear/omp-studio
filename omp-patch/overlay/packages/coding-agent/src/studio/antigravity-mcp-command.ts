import { configureAntigravityMcpCommand } from "@oh-my-pi/pi-ai/providers/antigravity-cli/host";
import { isCompiledBinary, isExecutable, stripWindowsExtendedLengthPathPrefix } from "@oh-my-pi/pi-utils";
import { resolveCliEntryCmd } from "../subprocess/worker-client";
import { ANTIGRAVITY_MCP_WORKER_ARG } from "./antigravity-mcp-worker";

/** The MCP subprocess always re-enters this Runtime, never a second omp from PATH. */
export function installStudioAntigravityMcp(): void {
	if (isCompiledBinary() && !isExecutable(stripWindowsExtendedLengthPathPrefix(process.execPath))) {
		throw new Error("The running Runtime executable is no longer available for its Antigravity MCP worker");
	}
	configureAntigravityMcpCommand([...resolveCliEntryCmd(), ANTIGRAVITY_MCP_WORKER_ARG]);
}
