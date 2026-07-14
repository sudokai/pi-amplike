/**
 * Child-only Amp bash gate for RPC subagents.
 *
 * Loaded via `--no-extensions -e <this-file>` so children do not discover parent
 * package extensions. Fail-closed: never prompts; YOLO allows all; allow runs;
 * ask/deny/reject block with a clear error.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	loadAmplikeSettings,
	resolveBashAction,
	type AmplikeSettings,
} from "./permissions-core.js";

export const BLOCK_REASON =
	"Blocked by Amp fail-closed subagent bash policy (ask/deny/reject never prompts in children). Use an allowed command, adjust amp.permissions/allowlist, or parent YOLO via /permissions.";

/**
 * Pure bash gate decision (no ExtensionAPI, no settings I/O).
 * Used by the child extension handler and hermetic unit tests.
 */
export function decideBash(
	command: string,
	cwd: string,
	amplikeSettings: AmplikeSettings,
): { block: false } | { block: true; reason: string } {
	if (amplikeSettings.permissions?.mode === "yolo") return { block: false };
	const action = resolveBashAction(command, cwd);
	if (action === "allow") return { block: false };
	return { block: true, reason: BLOCK_REASON };
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const decision = decideBash(
			String((event.input as { command?: unknown })?.command ?? ""),
			ctx.cwd,
			loadAmplikeSettings(),
		);
		if (!decision.block) return undefined;
		return { block: true, reason: decision.reason };
	});
}
