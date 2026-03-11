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

import { agentLoop } from "@mariozechner/pi-agent-core";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	convertToLlm,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	getMarkdownTheme,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import * as os from "node:os";

import { resolveModelAndThinking } from "./lib/mode-utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const MINIBOX_LINES = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	task: string;
	exitCode: number;
	displayItems: DisplayItem[];
	finalOutput: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

interface SubagentDetails {
	results: SingleResult[];
}

type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, any> };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function formatTokens(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatUsage(u: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
	if (u.input) parts.push(`↑${formatTokens(u.input)}`);
	if (u.output) parts.push(`↓${formatTokens(u.output)}`);
	if (u.cacheRead) parts.push(`R${formatTokens(u.cacheRead)}`);
	if (u.cacheWrite) parts.push(`W${formatTokens(u.cacheWrite)}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	if (u.contextTokens > 0) parts.push(`ctx:${formatTokens(u.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	fg: (color: any, text: string) => string,
): string {
	switch (toolName) {
		case "bash": {
			let cmd = (args.command as string) || "...";
			const home = os.homedir();
			cmd = cmd.replaceAll(home, "~");
			const firstLine = cmd.split("\n")[0];
			return fg("muted", "$ ") + fg("toolOutput", firstLine);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = fg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return fg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = fg("muted", "write ") + fg("accent", shortenPath(rawPath));
			if (lines > 1) text += fg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return fg("muted", "edit ") + fg("accent", shortenPath(rawPath));
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return fg("accent", toolName) + fg("dim", ` ${preview}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Core: run a single subagent loop
// ---------------------------------------------------------------------------

async function runSubagent(
	systemPrompt: string,
	task: string,
	tools: AgentTool<any>[],
	model: any,
	thinkingLevel: string,
	apiKeyResolver: (provider: string) => Promise<string | undefined>,
	signal: AbortSignal | undefined,
	onProgress: (result: SingleResult) => void,
): Promise<SingleResult> {
	const result: SingleResult = {
		task,
		exitCode: 0,
		displayItems: [],
		finalOutput: "",
		usage: emptyUsage(),
		model: `${model.provider}/${model.id}`,
	};

	const subagentPrompt: AgentMessage = {
		role: "user" as const,
		content: [
			{
				type: "text" as const,
				text: [
					"You are operating as a subagent within a larger agent session.",
					"Complete the following task thoroughly, then provide your final response as text.",
					"Be concise and focused. Do NOT attempt to hand off or spawn further subagents.",
					"",
					task,
				].join("\n"),
			},
		],
		timestamp: Date.now(),
	};

	// Fresh context: just the system prompt, no message history
	const context: AgentContext = {
		systemPrompt,
		messages: [],
		tools,
	};

	const config: AgentLoopConfig = {
		model,
		convertToLlm: (msgs: AgentMessage[]) => convertToLlm(msgs),
		getApiKey: apiKeyResolver,
		reasoning: thinkingLevel !== "off" ? (thinkingLevel as any) : undefined,
	};

	try {
		const stream = agentLoop([subagentPrompt], context, config, signal);

		for await (const event of stream) {
			if (signal?.aborted) break;

			switch (event.type) {
				case "message_end": {
					const msg = event.message as any;
					if (msg.role === "assistant") {
						result.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							result.usage.input += usage.input || 0;
							result.usage.output += usage.output || 0;
							result.usage.cacheRead += usage.cacheRead || 0;
							result.usage.cacheWrite += usage.cacheWrite || 0;
							result.usage.cost += usage.cost?.total || 0;
							result.usage.contextTokens = usage.totalTokens || 0;
						}
						if (msg.model) result.model = msg.model;
						if (msg.stopReason) result.stopReason = msg.stopReason;
						if (msg.errorMessage) result.errorMessage = msg.errorMessage;

						for (const part of msg.content) {
							if (part.type === "text") {
								result.displayItems.push({ type: "text", text: part.text });
								result.finalOutput = part.text;
							} else if (part.type === "toolCall") {
								result.displayItems.push({
									type: "toolCall",
									name: part.name,
									args: part.arguments,
								});
							}
						}
					}
					onProgress(result);
					break;
				}
				case "tool_execution_end": {
					onProgress(result);
					break;
				}
			}
		}

		if (result.stopReason === "error" || result.stopReason === "aborted") {
			result.exitCode = 1;
		}
	} catch (err) {
		result.exitCode = 1;
		result.errorMessage = err instanceof Error ? err.message : String(err);
		if (signal?.aborted) {
			result.stopReason = "aborted";
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// Parallel execution helper
// ---------------------------------------------------------------------------

async function mapWithConcurrency<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

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
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!params.tasks || params.tasks.length === 0) {
				return {
					content: [{ type: "text", text: "Provide at least one task." }],
					details: { results: [] },
				};
			}

			if (params.tasks.length > MAX_PARALLEL_TASKS) {
				return {
					content: [{ type: "text", text: `Too many tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
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
				const preview = task.length > 70 ? `${task.slice(0, 70)}...` : task;
				text += theme.fg("dim", preview);
			} else {
				text += theme.fg("accent", `${tasks.length} tasks`);
				for (const t of tasks.slice(0, 3)) {
					const preview = t.length > 50 ? `${t.slice(0, 50)}...` : t;
					text += `\n  ${theme.fg("dim", preview)}`;
				}
				if (tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${tasks.length - 3} more`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderMinibox = (r: SingleResult, showTask: boolean) => {
				const isRunning = r.exitCode === -1;
				const isError = r.exitCode > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: isError
						? theme.fg("error", "✗")
						: theme.fg("success", "✓");

				const lines: string[] = [];

				if (showTask) {
					const taskPreview = r.task.length > 60 ? `${r.task.slice(0, 60)}...` : r.task;
					lines.push(`${icon} ${theme.fg("dim", taskPreview)}`);
				} else {
					lines.push(icon);
				}

				if (isError && r.errorMessage) {
					lines.push(theme.fg("error", `Error: ${r.errorMessage}`));
				}

				const items = r.displayItems;
				const itemsToShow = expanded ? items : items.slice(-MINIBOX_LINES);
				const skipped = items.length - itemsToShow.length;

				if (skipped > 0) {
					lines.push(theme.fg("muted", `... ${skipped} earlier items`));
				}

				for (const item of itemsToShow) {
					if (item.type === "text") {
						if (expanded) {
							continue;
						}
						const textLines = item.text.split("\n").filter((l) => l.trim());
						const preview = textLines.slice(0, 5).join("\n");
						lines.push(theme.fg("toolOutput", preview));
						if (textLines.length > 5) lines.push(theme.fg("muted", `... +${textLines.length - 5} lines`));
					} else {
						lines.push(
							theme.fg("muted", "→ ") +
								formatToolCall(item.name, item.args, theme.fg.bind(theme)),
						);
					}
				}

				if (!isRunning) {
					const usageStr = formatUsage(r.usage, r.model);
					if (usageStr) lines.push(theme.fg("dim", usageStr));
				}

				return lines.join("\n");
			};

			const running = details.results.filter((r) => r.exitCode === -1).length;
			const successCount = details.results.filter((r) => r.exitCode === 0).length;
			const failCount = details.results.filter((r) => r.exitCode > 0).length;
			const isRunning = running > 0;
			const icon = isRunning
				? theme.fg("warning", "⏳")
				: failCount > 0
					? theme.fg("warning", "◐")
					: theme.fg("success", "✓");
			const status = isRunning
				? `${successCount + failCount}/${details.results.length} done, ${running} running`
				: `${successCount}/${details.results.length} tasks`;

			if (expanded && !isRunning) {
				const container = new Container();
				container.addChild(
					new Text(
						`${icon} ${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", status)}`,
						0, 0,
					),
				);

				for (const r of details.results) {
					const rIcon = r.exitCode === 0
						? theme.fg("success", "✓")
						: theme.fg("error", "✗");

					container.addChild(new Spacer(1));
					const taskPreview = r.task.length > 60 ? `${r.task.slice(0, 60)}...` : r.task;
					container.addChild(
						new Text(`${theme.fg("muted", "─── ")}${rIcon} ${theme.fg("dim", taskPreview)}`, 0, 0),
					);

					for (const item of r.displayItems) {
						if (item.type === "toolCall") {
							container.addChild(new Text(
								theme.fg("muted", "→ ") +
									formatToolCall(item.name, item.args, theme.fg.bind(theme)),
								0, 0,
							));
						}
					}

					if (r.finalOutput) {
						container.addChild(new Spacer(1));
						container.addChild(new Markdown(r.finalOutput.trim(), 0, 0, mdTheme));
					}

					const taskUsage = formatUsage(r.usage, r.model);
					if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
				}

				const totalUsage = aggregateUsage(details.results);
				const totalStr = formatUsage(totalUsage);
				if (totalStr) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", `Total: ${totalStr}`), 0, 0));
				}

				return container;
			}

			// Collapsed / running
			let text = `${icon} ${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", status)}`;
			for (const r of details.results) {
				text += `\n\n${renderMinibox(r, true)}`;
			}
			if (!isRunning) {
				const totalUsage = aggregateUsage(details.results);
				const totalStr = formatUsage(totalUsage);
				if (totalStr) text += `\n\n${theme.fg("dim", `Total: ${totalStr}`)}`;
			}
			if (!expanded && !isRunning) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			return new Text(text, 0, 0);
		},
	});
}

function aggregateUsage(results: SingleResult[]): UsageStats {
	const total = emptyUsage();
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
	}
	return total;
}
