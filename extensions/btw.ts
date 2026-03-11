/**
 * /btw command — run a subagent in the background while continuing to work.
 *
 * Usage:
 *   /btw check if there are any TODO comments in src/
 *   /btw -mode rush summarize the README
 *   /btw -model anthropic/claude-haiku-4-5 count lines of code
 *
 * Fires off an in-process subagent (same infra as the subagent tool) and
 * shows live progress in a widget above the editor. When finished, the
 * widget is replaced by a fully rendered custom message in the chat
 * (identical to the subagent tool's result rendering).
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
} from "@mariozechner/pi-coding-agent";

import { resolveModelAndThinking } from "./lib/mode-utils.js";
import {
	type SingleResult,
	renderProgressPlainLines,
	renderResults,
	runSubagent,
} from "./lib/subagent-core.js";

// ---------------------------------------------------------------------------
// Custom message type
// ---------------------------------------------------------------------------

const BTW_MESSAGE_TYPE = "btw-result";

interface BtwMessageDetails {
	task: string;
	result: SingleResult;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// --- Filter btw messages out of LLM context (user-facing only) ---
	pi.on("context", (event) => {
		const filtered = event.messages.filter(
			(m: any) => !(m.role === "custom" && m.customType === BTW_MESSAGE_TYPE),
		);
		if (filtered.length !== event.messages.length) {
			return { messages: filtered };
		}
	});

	// --- Custom message renderer: delegates to the same renderResults as subagent ---
	pi.registerMessageRenderer<BtwMessageDetails>(BTW_MESSAGE_TYPE, (message, { expanded }, theme) => {
		const details = message.details;
		if (!details?.result) return undefined;

		return renderResults([details.result], { expanded, label: "btw" }, theme);
	});

	// --- /btw command ---
	pi.registerCommand("btw", {
		description: "Run a subagent in the background (-mode <name>, -model <provider/id>)",
		handler: async (args, ctx) => {
			// Parse optional -mode and -model flags
			let remaining = args;
			let modeOpt: string | undefined;
			let modelOpt: string | undefined;

			const modeMatch = remaining.match(/(?:^|\s)-mode\s+(\S+)/);
			if (modeMatch) {
				modeOpt = modeMatch[1];
				remaining = remaining.replace(modeMatch[0], " ");
			}

			const modelMatch = remaining.match(/(?:^|\s)-model\s+(\S+)/);
			if (modelMatch) {
				modelOpt = modelMatch[1];
				remaining = remaining.replace(modelMatch[0], " ");
			}

			const task = remaining.trim();
			if (!task) {
				ctx.ui.notify("Usage: /btw [-mode <name>] [-model <provider/id>] <prompt>", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected.", "error");
				return;
			}

			// Resolve model/thinking
			const { model: targetModel, thinkingLevel } = await resolveModelAndThinking(
				ctx.cwd,
				ctx.modelRegistry,
				ctx.model,
				pi.getThinkingLevel(),
				{ mode: modeOpt, model: modelOpt },
			);

			if (!targetModel) {
				ctx.ui.notify("No model available.", "error");
				return;
			}

			// Build tools
			const tools: AgentTool<any>[] = [
				createReadTool(ctx.cwd),
				createBashTool(ctx.cwd),
				createEditTool(ctx.cwd),
				createWriteTool(ctx.cwd),
			];

			const systemPrompt = ctx.getSystemPrompt();
			const apiKeyResolver = async (_provider: string) => {
				return ctx.modelRegistry.getApiKey(targetModel!);
			};

			// Show initial status widget
			const taskPreview = task.length > 50 ? `${task.slice(0, 50)}...` : task;
			ctx.ui.setWidget("btw", [`⏳ btw: ${taskPreview}`], { placement: "aboveEditor" });

			// Fire and forget — run in background, update widget on progress
			runSubagent(
				systemPrompt,
				task,
				tools,
				targetModel,
				thinkingLevel,
				apiKeyResolver,
				undefined, // no abort signal — runs to completion
				(progressResult) => {
					// Update widget with live tool call feed
					ctx.ui.setWidget("btw", renderProgressPlainLines(task, progressResult), { placement: "aboveEditor" });
				},
			).then((result) => {
				// Remove progress widget
				ctx.ui.setWidget("btw", undefined);

				// Send fully rendered result as a custom message in the chat.
				// Filtered out of LLM context by the context event handler above.
				const icon = result.exitCode === 0 ? "✓" : "✗";
				pi.sendMessage({
					customType: BTW_MESSAGE_TYPE,
					content: [{ type: "text", text: `[btw ${icon}] ${task}` }],
					display: true,
					details: { task, result } satisfies BtwMessageDetails,
				});
			}).catch((err) => {
				ctx.ui.setWidget("btw", undefined);
				ctx.ui.notify(`btw failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			});

			// Command returns immediately — subagent runs in background
		},
	});
}
