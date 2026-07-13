/**
 * Handoff extension - transfer context to a new focused session
 *
 * Instead of compacting (which is lossy), handoff extracts what matters
 * for your next task and creates a new session with a generated prompt.
 *
 * Provides both:
 * - /handoff command: user types `/handoff <goal>`
 * - handoff tool: agent can call when user explicitly requests a handoff
 *
 * Usage:
 *   /handoff now implement this for teams as well
 *   /handoff -mode rush execute phase one of the plan
 *   /handoff -model anthropic/claude-haiku-4-5 check other places that need this fix
 *   /handoff -thinking high execute phase one of the plan
 *
 * After AI generation, the user reviews the prompt in the editor; on accept,
 * the new session starts and the approved text is sent automatically.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { complete, type Message } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { loadModeSpec, resolveModelAndThinking } from "./lib/mode-utils.js";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type HandoffSelection = {
	provider: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
};

const HANDOFF_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

type HandoffOptions = {
	mode?: string;
	model?: string;
	thinkingLevel?: string;
};

// Command-path handoff after editor accept: newSession() disposes the old extension
// instance. Approved prompt is sent from withSession on the replacement context;
// restore/options are stashed on globalThis for the new instance's session_start
// (ReplacedSessionContext has sendUserMessage but model restore uses the live pi API).
const HANDOFF_GLOBAL_KEY = Symbol.for("pi-amplike-handoff-pending");
type PendingHandoffGlobal = { options?: HandoffOptions; restore?: HandoffSelection } | null;
function getPendingHandoffGlobal(): PendingHandoffGlobal {
	return (globalThis as any)[HANDOFF_GLOBAL_KEY] ?? null;
}
function setPendingHandoffGlobal(data: PendingHandoffGlobal) {
	if (data) {
		(globalThis as any)[HANDOFF_GLOBAL_KEY] = data;
	} else {
		delete (globalThis as any)[HANDOFF_GLOBAL_KEY];
	}
}

// Cross-extension coordination flag, true from the moment a handoff is pending
// until the new session has been (re)started and its prompt dispatched. A
// persistent extension that autonomously triggers turns when the agent is idle
// (the advisor) reads this via the same Symbol.for key and stands down for the
// duration, so it doesn't (a) start a turn that races the handoff's deferred
// sendUserMessage, or (b) inject stray advice into the session that is being
// torn down / replaced. The deferred sendUserMessage below also passes
// deliverAs:"followUp" as a belt-and-suspenders guard against any other source
// of a concurrent turn (e.g. a user-invoked /review).
const HANDOFF_IN_PROGRESS_KEY = Symbol.for("pi-amplike-handoff-in-progress");

// Event-bus channel emitted right after the tool-path handoff replaces the
// session transcript. The tool path uses the low-level sessionManager.newSession(),
// which (unlike the command path's cmdCtx.newSession()) does NOT emit a
// `session_start` event, so persistent extensions that key their transcript
// reset off session_start (the advisor) would otherwise carry stale state into
// the handed-off session. They subscribe to this channel to reset cleanly.
// The EventBus is shared across extensions within a runner, and the tool path
// keeps the runner alive, so this reaches the advisor in-process.
export const HANDOFF_SESSION_REPLACED_CHANNEL = "pi-amplike:handoff-session-replaced";
function setHandoffInProgress(active: boolean): void {
	if (active) {
		(globalThis as any)[HANDOFF_IN_PROGRESS_KEY] = true;
	} else {
		delete (globalThis as any)[HANDOFF_IN_PROGRESS_KEY];
	}
}

const CONTEXT_SUMMARY_SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on user's goal]`;

type HandoffModelContext = {
	cwd: string;
	modelRegistry: ExtensionContext["modelRegistry"];
	model: ExtensionContext["model"];
	hasUI: boolean;
	ui: ExtensionContext["ui"];
	getThinkingLevel(): ThinkingLevel;
	setModel(model: NonNullable<ExtensionContext["model"]>): Promise<boolean>;
	setThinkingLevel(level: ThinkingLevel): void;
};

/**
 * Generate a context summary by asking an LLM to distill the conversation
 * into a focused prompt for a new session.
 *
 * @returns The generated summary text, or null if aborted.
 */
async function generateContextSummary(
	model: NonNullable<ExtensionContext["model"]>,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	messages: AgentMessage[],
	goal: string,
	signal?: AbortSignal,
): Promise<string | null> {
	const conversationText = serializeConversation(convertToLlm(messages));

	const userMessage: Message = {
		role: "user",
		content: [
			{
				type: "text",
				text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`,
			},
		],
		timestamp: Date.now(),
	};

	const response = await complete(
		model,
		{ systemPrompt: CONTEXT_SUMMARY_SYSTEM_PROMPT, messages: [userMessage] },
		{ apiKey, headers, signal },
	);

	if (response.stopReason === "aborted") {
		return null;
	}

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

async function restoreHandoffSelection(
	ctx: HandoffModelContext,
	restore: HandoffSelection,
): Promise<void> {
	const model = ctx.modelRegistry.find(restore.provider, restore.modelId);
	if (!model) {
		if (ctx.hasUI) {
			ctx.ui.notify(`Handoff: could not restore ${restore.provider}/${restore.modelId}; using current session model`, "warning");
		}
	} else {
		const ok = await ctx.setModel(model);
		if (!ok && ctx.hasUI) {
			ctx.ui.notify(`Handoff: no API key for ${restore.provider}/${restore.modelId}; using current session model`, "warning");
		}
	}
	ctx.setThinkingLevel(restore.thinkingLevel);
}

/**
 * Apply -mode, -model, and -thinking options after a session switch.
 * Uses resolveModelAndThinking for precedence; modes extension syncs from model_select.
 */
async function applyHandoffOptions(
	ctx: HandoffModelContext,
	options?: HandoffOptions,
): Promise<void> {
	if (!options || (!options.mode && !options.model && !options.thinkingLevel)) return;

	if (options.mode) {
		const spec = await loadModeSpec(ctx.cwd, options.mode);
		if (!spec) {
			ctx.hasUI && ctx.ui.notify(`Handoff: unknown mode "${options.mode}"`, "warning");
		} else if (spec.provider && spec.modelId && !ctx.modelRegistry.find(spec.provider, spec.modelId)) {
			ctx.hasUI && ctx.ui.notify(`Handoff: mode "${options.mode}" references unknown model ${spec.provider}/${spec.modelId}`, "warning");
		}
	}

	if (options.model) {
		const slashIdx = options.model.indexOf("/");
		if (slashIdx <= 0) {
			ctx.hasUI && ctx.ui.notify(`Handoff: invalid model format "${options.model}", expected provider/modelId`, "warning");
		} else {
			const provider = options.model.slice(0, slashIdx);
			const modelId = options.model.slice(slashIdx + 1);
			if (!ctx.modelRegistry.find(provider, modelId)) {
				ctx.hasUI && ctx.ui.notify(`Handoff: unknown model ${options.model}`, "warning");
			}
		}
	}

	const currentThinking = ctx.getThinkingLevel();

	if (options.thinkingLevel && !HANDOFF_THINKING_LEVELS.includes(options.thinkingLevel as (typeof HANDOFF_THINKING_LEVELS)[number])) {
		ctx.hasUI &&
			ctx.ui.notify(
				`Handoff: unrecognized thinking level "${options.thinkingLevel}"; applying best-effort (allowed: ${HANDOFF_THINKING_LEVELS.join(", ")})`,
				"warning",
			);
	}

	const { model: targetModel, thinkingLevel: targetThinking } = await resolveModelAndThinking(
		ctx.cwd,
		ctx.modelRegistry,
		ctx.model,
		currentThinking,
		{
			mode: options.mode,
			model: options.model,
			thinkingLevel: options.thinkingLevel,
		},
	);

	if ((options.mode || options.model) && targetModel) {
		const ok = await ctx.setModel(targetModel);
		if (!ok && ctx.hasUI) {
			ctx.ui.notify(`Handoff: no API key for ${targetModel.provider}/${targetModel.id}; using current session model`, "warning");
		}
	}

	if (options.thinkingLevel || targetThinking !== currentThinking) {
		ctx.setThinkingLevel(targetThinking as ThinkingLevel);
	}
}

function handoffModelContextFromPi(pi: ExtensionAPI, ctx: ExtensionContext): HandoffModelContext {
	return {
		cwd: ctx.cwd,
		modelRegistry: ctx.modelRegistry,
		model: ctx.model,
		hasUI: ctx.hasUI,
		ui: ctx.ui,
		getThinkingLevel: () => pi.getThinkingLevel(),
		setModel: (model) => pi.setModel(model),
		setThinkingLevel: (level) => pi.setThinkingLevel(level),
	};
}

type HandoffGenerationFailure = "auth" | "aborted" | "error";

function handoffFailureMessage(reason: HandoffGenerationFailure): string {
	switch (reason) {
		case "auth":
			return "Handoff failed: no API key for the current model.";
		case "aborted":
			return "Handoff cancelled.";
		case "error":
			return "Handoff failed: could not generate the handoff prompt.";
	}
}

/**
 * Core handoff logic. Returns an error string on failure, or undefined on success.
 */
async function performHandoff(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	goal: string,
	setPendingHandoff: (v: { prompt: string; parentSession: string | undefined; options?: HandoffOptions } | null) => void,
	fromTool = false,
	options?: HandoffOptions,
): Promise<string | undefined> {
	if (!ctx.hasUI) {
		return "Handoff requires interactive mode.";
	}

	if (!ctx.model) {
		return "No model selected.";
	}

	const branch = ctx.sessionManager.getBranch();
	const messages = branch
		.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
		.map((entry) => entry.message);

	if (messages.length === 0) {
		return "No conversation to hand off.";
	}

	const currentSessionFile = ctx.sessionManager.getSessionFile();

	// Generate the handoff prompt with loader UI
	const result = await ctx.ui.custom<string | HandoffGenerationFailure>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `Generating handoff prompt...`);
		loader.onAbort = () => done("aborted");

		const doGenerate = async (): Promise<string | HandoffGenerationFailure> => {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
			if (!auth.ok) return "auth";
			const summary = await generateContextSummary(ctx.model!, auth.apiKey, auth.headers, messages, goal, loader.signal);
			if (summary === null) return "aborted";
			return summary;
		};

		doGenerate()
			.then(done)
			.catch((err) => {
				console.error("Handoff generation failed:", err);
				done("error");
			});

		return loader;
	});

	if (result === "auth" || result === "aborted" || result === "error") {
		return handoffFailureMessage(result);
	}

	// Build the final prompt with user's goal first for easy identification
	let finalPrompt = result;
	if (currentSessionFile) {
		finalPrompt = `${goal}\n\n/skill:session-query\n\n**Parent session:** \`${currentSessionFile}\`\n\n${result}`;
	} else {
		finalPrompt = `${goal}\n\n${result}`;
	}

	const approvedPrompt = await ctx.ui.editor("Edit handoff prompt", finalPrompt);
	if (approvedPrompt === undefined) {
		return "Handoff cancelled.";
	}

	if (!fromTool && "newSession" in ctx) {
		const cmdCtx = ctx as ExtensionCommandContext;
		const restore = !options?.mode && !options?.model && !options?.thinkingLevel && ctx.model
			? {
				provider: ctx.model.provider,
				modelId: ctx.model.id,
				thinkingLevel: pi.getThinkingLevel(),
			}
			: undefined;

		setPendingHandoffGlobal({ options, restore });
		setHandoffInProgress(true);
		try {
			const newSessionResult = await cmdCtx.newSession({
				parentSession: currentSessionFile,
				withSession: async (replacementCtx) => {
					try {
						await replacementCtx.sendUserMessage(approvedPrompt, { deliverAs: "followUp" });
					} finally {
						setHandoffInProgress(false);
					}
				},
			});
			if (newSessionResult.cancelled) {
				setPendingHandoffGlobal(null);
				setHandoffInProgress(false);
				return "Handoff cancelled.";
			}
		} catch (err) {
			setPendingHandoffGlobal(null);
			setHandoffInProgress(false);
			throw err;
		}
	} else {
		setPendingHandoff({ prompt: approvedPrompt, parentSession: currentSessionFile, options });
		setHandoffInProgress(true);
	}

	return undefined;
}

export default function (pi: ExtensionAPI) {
	// Shared state for tool-path handoff coordination between handlers
	let pendingHandoff: { prompt: string; parentSession: string | undefined; options?: HandoffOptions } | null = null;

	// Timestamp marking when the handoff session switch occurred.
	// Used by the context event handler to filter out pre-handoff messages
	// from agent.state.messages (which aren't cleared by the low-level switch).
	let handoffTimestamp: number | null = null;

	const setPendingHandoff = (v: { prompt: string; parentSession: string | undefined; options?: HandoffOptions } | null) => {
		pendingHandoff = v;
	};

	// --- Event handlers for tool-path handoff ---
	//
	// The /handoff command path sends the approved prompt from newSession's withSession;
	// restore/options are applied in session_start on the new extension instance's pi.
	//
	// The tool path only gets ExtensionContext during execute, which lacks
	// newSession(). It uses a low-level sessionManager.newSession() that doesn't
	// replace the runtime, so the pi reference stays alive. The editor runs in
	// execute before deferring; agent_end performs the switch and send.

	pi.on("agent_end", (_event, ctx) => {
		if (!pendingHandoff) return;

		const { prompt, parentSession, options } = pendingHandoff;
		pendingHandoff = null;

		handoffTimestamp = Date.now();

		try {
			(ctx.sessionManager as any).newSession({ parentSession });
		} catch (err) {
			setHandoffInProgress(false);
			throw err;
		}

		pi.events.emit(HANDOFF_SESSION_REPLACED_CHANNEL, {});

		setTimeout(async () => {
			try {
				await applyHandoffOptions(handoffModelContextFromPi(pi, ctx), options);
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			} finally {
				setHandoffInProgress(false);
			}
		}, 0);
	});

	pi.on("context", (event) => {
		if (handoffTimestamp === null) return;

		const newMessages = event.messages.filter((m: any) => m.timestamp >= handoffTimestamp);
		if (newMessages.length > 0) {
			return { messages: newMessages };
		}
	});

	pi.on("session_start", async (event, ctx) => {
		handoffTimestamp = null;

		if (event.reason === "new") {
			const pending = getPendingHandoffGlobal();
			if (pending) {
				setPendingHandoffGlobal(null);
				const modelCtx = handoffModelContextFromPi(pi, ctx);
				if (pending.restore) {
					await restoreHandoffSelection(modelCtx, pending.restore);
				}
				await applyHandoffOptions(modelCtx, pending.options);
			}
		}
	});

	pi.registerCommand("handoff", {
		description: "Transfer context to a new focused session (-mode <name>, -model <provider/id>, -thinking <level>)",
		handler: async (args, ctx) => {
			const options: HandoffOptions = {};
			let remaining = args;

			const modeMatch = remaining.match(/(?:^|\s)-mode\s+(\S+)/);
			if (modeMatch) {
				options.mode = modeMatch[1];
				remaining = remaining.replace(modeMatch[0], " ");
			}

			const modelMatch = remaining.match(/(?:^|\s)-model\s+(\S+)/);
			if (modelMatch) {
				options.model = modelMatch[1];
				remaining = remaining.replace(modelMatch[0], " ");
			}

			const thinkingMatch = remaining.match(/(?:^|\s)-thinking\s+(\S+)/);
			if (thinkingMatch) {
				options.thinkingLevel = thinkingMatch[1];
				remaining = remaining.replace(thinkingMatch[0], " ");
			}

			const goal = remaining.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /handoff [-mode <name>] [-model <provider/id>] [-thinking <level>] <goal>", "error");
				return;
			}

			const hasOptions = options.mode || options.model || options.thinkingLevel;
			const error = await performHandoff(pi, ctx, goal, setPendingHandoff, false, hasOptions ? options : undefined);
			if (error) {
				ctx.ui.notify(error, error === "Handoff cancelled." ? "info" : "error");
			}
		},
	});

	pi.registerTool({
		name: "handoff",
		label: "Handoff",
		description:
			"Transfer context to a new focused session. ONLY use this when the user explicitly asks for a handoff. Provide a goal describing what the new session should focus on.",
		parameters: Type.Object({
			goal: Type.String({ description: "The goal/task for the new session" }),
			mode: Type.Optional(Type.String({ description: "Amplike mode name to start the new session with (e.g. 'rush', 'smart', 'deep')" })),
			model: Type.Optional(Type.String({ description: "Model to start the new session with, as provider/modelId (e.g. 'anthropic/claude-haiku-4-5')" })),
			thinkingLevel: Type.Optional(Type.String({
				description: "Thinking level for the new session: off, minimal, low, medium, high, or xhigh. Only based on explicit user instructions. Overrides mode preset thinking.",
			})),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const options: HandoffOptions = {};
			if (params.mode) options.mode = params.mode;
			if (params.model) options.model = params.model;
			if (params.thinkingLevel) options.thinkingLevel = params.thinkingLevel;
			const hasOptions = options.mode || options.model || options.thinkingLevel;
			const error = await performHandoff(pi, ctx, params.goal, setPendingHandoff, true, hasOptions ? options : undefined);
			return {
				content: [{
					type: "text",
					text: error ?? "Handoff approved. The session will switch after the current turn completes and start with your approved prompt.",
				}],
			};
		},

		renderCall(args, theme) {
			const parts: string[] = [];

			const goal = (args.goal as string) ?? "";
			const goalLines = goal.split("\n");
			const truncatedGoal = goalLines.length > 5
				? goalLines.slice(0, 5).join("\n") + "\n" + theme.fg("dim", `… (${goalLines.length - 5} more lines)`)
				: goal;

			parts.push(theme.fg("toolTitle", theme.bold("Handoff ")));

			if (args.mode) {
				parts.push(theme.fg("accent", `-mode ${args.mode} `));
			}
			if (args.model) {
				parts.push(theme.fg("accent", `-model ${args.model} `));
			}
			if (args.thinkingLevel) {
				parts.push(theme.fg("accent", `-thinking ${args.thinkingLevel} `));
			}

			parts.push(theme.fg("muted", truncatedGoal));

			return new Text(parts.join(""), 0, 0);
		},
	});
}
