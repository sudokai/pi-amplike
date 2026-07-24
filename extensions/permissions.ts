/**
 * Amp Permissions Extension
 *
 * Reads exec permissions from Amp-format settings and intercepts bash tool calls.
 *
 * Settings are loaded from (in order, merged):
 *   ~/.config/amp/settings.json  (global)
 *   .agents/settings.json        (project-local)
 *
 * Relevant settings keys:
 *
 *   "amp.commands.allowlist": ["git", "npm", "./test.sh"]
 *     Base command names that are auto-allowed (checked before permissions rules).
 *     Also matched after stripping a leading "cd <dir> &&" prefix.
 *
 *   "amp.permissions": [
 *     { "tool": "Bash", "matches": { "cmd": "/\\brm\\b/" }, "action": "ask" },
 *     { "tool": "Bash", "matches": { "cmd": "*" },          "action": "allow" }
 *   ]
 *     Ordered rules. First matching Bash rule wins. See lib/permissions-core.ts.
 *
 * Extension settings (~/.pi/agent/amplike.json):
 *   { "permissions": { "mode": "enabled" | "yolo" } }
 *   Persisted by the /permissions command across pi invocations.
 *
 * No-UI sessions never prompt on ask. Parent TUI still uses interactive select on ask.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";

import {
	decideBash,
	DENIED_BASH_REASON,
	GLOBAL_SETTINGS,
	loadAmplikeSettings,
	loadSettings,
	resolveBashAction,
	ruleAppliesToBash,
	saveAmplikeSettings,
} from "./lib/permissions-core.js";

// Permission mode: "enabled" (default) or "yolo" (all commands allowed without checks)
// Loaded from amplike.json on startup; persisted on /permissions toggle.
let permissionMode: "enabled" | "yolo" = loadAmplikeSettings().permissions?.mode ?? "enabled";

/** True when bash must not open an interactive prompt (no UI). */
export function shouldFailClosedBash(hasUI: boolean): boolean {
	return !hasUI;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("permissions", {
		description: "Toggle permission mode between 'enabled' (amp rules) and 'yolo' (all commands allowed)",
		handler: async (_args, ctx) => {
			if (permissionMode === "enabled") {
				permissionMode = "yolo";
				ctx.ui.setStatus("permissions", "YOLO mode");
				ctx.ui.notify("Permissions: switched to YOLO mode — all bash commands allowed without checks", "warning");
			} else {
				permissionMode = "enabled";
				ctx.ui.setStatus("permissions", undefined);
				ctx.ui.notify("Permissions: switched to enabled mode — amp permission rules active", "info");
			}
			const current = loadAmplikeSettings();
			saveAmplikeSettings({ ...current, permissions: { ...current.permissions, mode: permissionMode } });
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// Restore status bar if yolo mode was persisted from a previous session
		if (permissionMode === "yolo") {
			ctx.ui.setStatus("permissions", "YOLO mode");
		}

		// Warn about any non-Bash permission rules in the user's config
		const settings = loadSettings([GLOBAL_SETTINGS, resolve(ctx.cwd, ".agents", "settings.json")]);
		const nonBashRules = (settings["amp.permissions"] ?? []).filter((r) => !ruleAppliesToBash(r));
		if (nonBashRules.length > 0) {
			const tools = [...new Set(nonBashRules.map((r) => r.tool))].join(", ");
			ctx.ui.notify(
				`permissions: ignoring ${nonBashRules.length} non-Bash amp.permissions rule(s) (tools: ${tools})`,
				"warning",
			);
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = String((event.input as { command?: unknown })?.command ?? "");
		if (shouldFailClosedBash(ctx.hasUI)) {
			const decision = decideBash(command, ctx.cwd, {
				permissions: { mode: permissionMode },
			});
			if (!decision.block) return undefined;
			return { block: true, reason: decision.reason };
		}

		if (permissionMode === "yolo") return undefined;

		const action = resolveBashAction(command, ctx.cwd);

		if (action === "allow") return undefined;
		if (action === "deny" || action === "reject") {
			return { block: true, reason: DENIED_BASH_REASON };
		}
		// action === "ask"
		const choice = await ctx.ui.select(
			`⚠️  Permission required:\n\n  ${command}\n\nAllow? (Use /permissions to toggle YOLO mode and skip these checks)`,
			["Yes", "No"],
		);
		if (choice !== "Yes") {
			ctx.abort();
			return { block: true, reason: "Blocked by user" };
		}
		return undefined;
	});
}
