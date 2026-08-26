/**
 * Main-side helper for the native plan save-as picker: converts the absolute
 * path chosen in the dialog into a workspace-relative path with forward
 * slashes, or reports an outside-workspace choice. Runs in Main only
 * (`node:path`); the type lives in `workspace-shell-shared.ts` so preload and
 * renderer can mirror it without importing Node built-ins.
 */

import { basename, isAbsolute, relative, sep } from "node:path";

import { type PlanSavePathPickResult } from "./workspace-shell-shared.js";

export function planSaveRelativeTarget(cwd: string, absolutePath: string): PlanSavePathPickResult {
	const rel = relative(cwd, absolutePath);
	if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
		return { status: "outside-workspace", fileName: basename(absolutePath) };
	}
	return { status: "picked", relativePath: rel.split(sep).join("/") };
}
