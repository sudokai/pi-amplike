/**
 * Subagent extension - run in-process subagents with summarized context.
 *
 * Instead of trying to reuse the main agent's exact tools and message prefix
 * (which is fragile and can't include extension tools), the subagent:
 * 1. Generates a context summary (same mechanism as handoff) that distills
 *    the conversation into focused context for the task
 * 2. Starts a fresh agent loop with its own tools (the 4 built-in tools)
 *    and the summary as the initial user message
 *
 * This is simpler, more robust, and naturally supports all the context the
 * subagent needs without worrying about tool set matching or cache alignment.
 *
 * Supports:
 *   - Single: { task: "..." }
 *   - Parallel: { tasks: [{ task: "..." }, ...] }
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import { resolveModelAndThinking } from "./lib/mode-utils.js";
import {
	type SingleResult,
	type SubagentDetails,
	emptyUsage,
	mapWithConcurrency,
	renderResults,
	runSubagent,
} from "./lib/subagent-core.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const SubagentParams = Type.Object({
	tasks: Type.Array(Type.String(), {
		description: "Task prompts for subagents (as many subagents as tasks provided are spawned). A subagent has no conversation history — include all relevant context (file paths, decisions, requirements) and exact task description in this prompt.",
	}),
	mode: Type.Optional(Type.String({ description: "Amplike mode name for the subagent (e.g. 'rush', 'smart', 'deep'), only based on explicit user instructions." })),
	model: Type.Optional(Type.String({ description: "Model for the subagent, as provider/modelId (e.g. 'anthropic/claude-haiku-4-5'), only based on explicit user instructions." })),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Run isolated subagents with built-in tools (read, write, edit, bash).",
			"Subagents have two benefits - quickly perform parallel tasks, and save space in your context window.",
			"Subagents are suitable for independent, well-defined, context-hungry subtasks that don't need back-and-forth with the user, such as research or refactoring.",
			"The downside is they are non-interactive for the user; use them only when explicitly asked or when you can show that the benefits are situationally very strong."
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!params.tasks || params.tasks.length === 0) {
				return {
					content: [{ type: "text", text: "Provide at least one task." }],
					details: { results: [] },
				};
			}

			// --- Resolve model ---
			const { model: targetModel, thinkingLevel: targetThinkingLevel } = await resolveModelAndThinking(
				ctx.cwd,
				ctx.modelRegistry,
				ctx.model,
				pi.getThinkingLevel(),
				{ mode: params.mode, model: params.model },
			);

			if (!targetModel) {
				return {
					content: [{ type: "text", text: "No model available." }],
					details: { results: [] },
				};
			}

			// --- Build tools: fresh built-in tools only ---
			const tools: AgentTool<any>[] = [
				createReadTool(ctx.cwd),
				createBashTool(ctx.cwd),
				createEditTool(ctx.cwd),
				createWriteTool(ctx.cwd),
			];

			// --- System prompt from main agent ---
			const systemPrompt = ctx.getSystemPrompt();

			// --- API key resolver ---
			const apiKeyResolver = async (_provider: string) => {
				return ctx.modelRegistry.getApiKey(targetModel!);
			};

			const makeDetails = (results: SingleResult[]): SubagentDetails => ({ results });

			const allResults: SingleResult[] = params.tasks.map((task) => ({
				task,
				exitCode: -1, // running
				displayItems: [],
				finalOutput: "",
				usage: emptyUsage(),
			}));

			const emitUpdate = () => {
				if (!onUpdate) return;
				const done = allResults.filter((r) => r.exitCode !== -1).length;
				const running = allResults.length - done;
				const statusText = allResults.length === 1
					? (allResults[0].finalOutput || "(running...)")
					: `${done}/${allResults.length} done, ${running} running...`;
				onUpdate({
					content: [{ type: "text", text: statusText }],
					details: makeDetails([...allResults]),
				});
			};

			const results = await mapWithConcurrency(params.tasks, MAX_CONCURRENCY, async (task, index) => {
				const result = await runSubagent(
					systemPrompt,
					task,
					tools,
					targetModel!,
					targetThinkingLevel,
					apiKeyResolver,
					signal,
					(r) => {
						allResults[index] = r;
						emitUpdate();
					},
				);
				allResults[index] = result;
				emitUpdate();
				return result;
			});

			const successCount = results.filter((r) => r.exitCode === 0).length;
			const failCount = results.length - successCount;
			const summaries = results.map((r) => {
				const preview = r.finalOutput.slice(0, 200) + (r.finalOutput.length > 200 ? "..." : "");
				return `[${r.exitCode === 0 ? "✓" : "✗"}] ${preview || "(no output)"}`;
			});

			const isError = results.length === 1 ? results[0].exitCode !== 0 : failCount === results.length;
			return {
				content: [{ type: "text", text: `${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}` }],
				details: makeDetails(results),
				isError,
			};
		},

		// --- Rendering ---

		renderCall(args, theme) {
			const tasks: string[] = args.tasks ?? [];
			let text = theme.fg("toolTitle", theme.bold("subagent "));
			if (args.mode) text += theme.fg("muted", `[${args.mode}] `);
			else if (args.model) text += theme.fg("muted", `[${args.model}] `);

			if (tasks.length <= 1) {
				const task = tasks[0] ?? "...";
				// Single line — no truncation, let terminal wrap naturally
				text += theme.fg("dim", task);
			} else {
				text += theme.fg("accent", `${tasks.length} tasks`);
				for (const t of tasks.slice(0, 3)) {
					text += `\n  ${theme.fg("dim", t)}`;
				}
				if (tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${tasks.length - 3} more`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			return renderResults(details.results, { expanded, label: "subagent" }, theme);
		},
	});
}
