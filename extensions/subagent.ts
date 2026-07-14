/**
 * Amplike subagent entry — tidy-style RPC children with per-child modes.
 *
 * Registers `subagent` + `subagent_control` via vendored pi-tidy-subagents.
 * Amplike-only policy: optional per-child `mode`, Amp fail-closed bash in
 * children (via spawn gate), no tidy routing, no `/btw`.
 */

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { expandAgentModes } from "./lib/subagent-mode.js";
import {
	buildMixedEnvelope,
	publicChild,
	SessionCoordinator,
} from "./vendor/pi-tidy-subagents/coordinator.js";
import { buildEnvelope } from "./vendor/pi-tidy-subagents/envelope.js";
import {
	CHILD_SKIP_DIAGNOSTIC,
	isChildRpcProcess,
} from "./vendor/pi-tidy-subagents/index.js";
import { ToolSnapshotComponent } from "./vendor/pi-tidy-subagents/render.js";
import {
	resolveBatchRuntime,
	wrapPiRegistry,
	type ModelAuthRegistry,
} from "./vendor/pi-tidy-subagents/runtime.js";
import { concurrencyCap, Scheduler } from "./vendor/pi-tidy-subagents/scheduler.js";
import { createRunStore } from "./vendor/pi-tidy-subagents/store.js";
import type { ChildState, DeliveryPolicy, RunDetails } from "./vendor/pi-tidy-subagents/types.js";
import {
	BackgroundStampComponent,
	ManagementOverlay,
	managementItems,
} from "./vendor/pi-tidy-subagents/ui.js";

export { buildEnvelope } from "./vendor/pi-tidy-subagents/envelope.js";
export { buildChildArgs, launchRuntime, resolveBashGatePath, CHILD_BUILTIN_TOOLS } from "./vendor/pi-tidy-subagents/runner.js";
export { expandAgentModes } from "./lib/subagent-mode.js";

/** Exact model field guidance (amplike: modes replace tidy routing). */
const MODEL_FIELD_DESCRIPTION =
	"Exact registered provider/model-id (split at first '/'). Omit inherits parent (or mode). No aliases, profiles, or fuzzy patterns. Prefer inherit or amplike mode; pass exact id only when capability or cost warrants.";

/** Thinking field guidance (closed Pi levels; inheritance default). */
const THINKING_FIELD_DESCRIPTION =
	"Pi thinking level: off|minimal|low|medium|high|xhigh|max. Omit inherits parent (or mode). Primary per-child control: minimal/low for bounded or mechanical work; medium for ordinary review; high+ for architecture, concurrency, hard diagnosis. Explicit unsupported fails preflight; inherited clamps.";

function publicDetails(details: RunDetails): RunDetails {
	return { ...details, children: details.children.map(publicChild) };
}

function registryFromContext(ctx: {
	modelRegistry?: {
		find(provider: string, modelId: string): { provider: string; id: string } | undefined | null;
		hasConfiguredAuth(model: { provider: string; id: string }): boolean;
	};
}): ModelAuthRegistry | undefined {
	if (!ctx.modelRegistry) return undefined;
	return wrapPiRegistry(ctx.modelRegistry);
}

function parentBatchKey(ctx: { sessionManager?: { getLeafId?(): unknown } }): string | undefined {
	const leafId = ctx.sessionManager?.getLeafId?.();
	return typeof leafId === "string" && leafId.length > 0 ? leafId : undefined;
}

const ThinkingEnum = Type.Union(
	[
		Type.Literal("off"),
		Type.Literal("minimal"),
		Type.Literal("low"),
		Type.Literal("medium"),
		Type.Literal("high"),
		Type.Literal("xhigh"),
		Type.Literal("max"),
	],
	{ description: THINKING_FIELD_DESCRIPTION },
);

const ExecutionEnum = Type.Union([Type.Literal("foreground"), Type.Literal("background")], {
	description:
		"Ownership mode. Omit for synchronous foreground execution; background returns after durable registration.",
});

const Parameters = Type.Object({
	agents: Type.Array(
		Type.Object({
			label: Type.Optional(Type.String({ description: "Short display label; defaults to agent" })),
			reason: Type.String({
				description: "Short present-tense intent shown in the transcript (ideally ≤12 words, no period)",
			}),
			prompt: Type.String({
				description:
					"Full context, skills, objective, and output expectations sent verbatim to the child",
			}),
			mode: Type.Optional(
				Type.String({
					description:
						"Amplike mode name from modes.json (e.g. 'rush', 'smart', 'deep'). Only when the user explicitly requests a mode. Expanded to model/thinking before launch (parent → mode → model → thinking).",
				}),
			),
			model: Type.Optional(
				Type.String({
					description: MODEL_FIELD_DESCRIPTION,
				}),
			),
			thinking: Type.Optional(ThinkingEnum),
			execution: Type.Optional(ExecutionEnum),
		}),
		{ minItems: 1 },
	),
});

const ControlActionEnum = Type.Union([
	Type.Literal("background"),
	Type.Literal("steer"),
	Type.Literal("cancel"),
	Type.Literal("inspect"),
	Type.Literal("status"),
	Type.Literal("set_delivery"),
	Type.Literal("collect"),
]);
const DeliveryEnum = Type.Union([Type.Literal("auto"), Type.Literal("manual")]);
const ControlParameters = Type.Object({
	action: ControlActionEnum,
	target: Type.Optional(
		Type.String({
			description: "Canonical <run-id>:<child-id> target or one unambiguous eligible label",
		}),
	),
	message: Type.Optional(
		Type.String({ description: "Non-empty native Pi steering instruction; valid only for steer" }),
	),
	delivery: Type.Optional(DeliveryEnum),
});

function validateControlInput(params: {
	action: string;
	target?: string;
	message?: string;
	delivery?: DeliveryPolicy;
}): void {
	const fields = [
		params.target !== undefined ? "target" : "",
		params.message !== undefined ? "message" : "",
		params.delivery !== undefined ? "delivery" : "",
	].filter(Boolean);
	const allowed =
		params.action === "status"
			? []
			: params.action === "steer"
				? ["target", "message"]
				: params.action === "set_delivery"
					? ["target", "delivery"]
					: ["target"];
	const irrelevant = fields.filter((field) => !allowed.includes(field));
	if (irrelevant.length) throw new Error(`${params.action} does not accept ${irrelevant.join(", ")}`);
	if (params.action !== "status" && !params.target?.trim()) throw new Error(`${params.action} requires target`);
	if (params.action === "steer" && !params.message?.trim()) throw new Error("steer requires a non-empty message");
	if (params.action === "set_delivery" && !params.delivery) {
		throw new Error("set_delivery requires delivery=auto or delivery=manual");
	}
}

const PROMPT_GUIDELINES = [
	"Use subagent only for independent work. Concurrent children share the working tree; assign non-overlapping mutation scopes or read-only objectives.",
	"Thinking is the primary per-child control. Prefer omit thinking to inherit parent; otherwise pick a closed Pi level for the task shape.",
	"Prefer omit model (inherit parent). Pass an exact registered provider/model-id only when capability or cost warrants. No aliases, profiles, or fuzzy patterns.",
	"Optional per-child mode from amplike modes.json: parent session → mode → explicit model → explicit thinking. Unknown mode fails the whole batch.",
	"Children run isolated RPC processes with built-in tools only (read, write, edit, bash, grep, find, ls). Bash is fail-closed Amp policy (never prompts); YOLO on parent allows all child bash.",
	"Use subagent execution=background only when the parent can proceed without the result; omission stays foreground and synchronous.",
	"Use subagent_control to inspect, background, steer, cancel, change delivery, or collect one session child by canonical target or unambiguous label.",
	"Subagent results use tidy envelopes and agent-dir artifacts (child-*.md, run.json, events); they are not Pi session .jsonl files for session_query.",
];

export default function (pi: ExtensionAPI): void {
	// Nested fan-out disabled only in true child RPC processes (env + --mode rpc).
	if (isChildRpcProcess()) {
		console.warn(CHILD_SKIP_DIAGNOSTIC);
		delete process.env.PI_TIDY_SUBAGENT_CHILD;
		return;
	}

	const scheduler = new Scheduler(concurrencyCap());
	const coordinator = new SessionCoordinator(pi, scheduler);

	pi.on("session_start", (_event, ctx) => coordinator.attachContext(ctx as any));
	pi.on("session_shutdown", async () => coordinator.shutdown());
	pi.registerEntryRenderer?.("pi-tidy-subagent-stamp", (entry, options, theme) =>
		new BackgroundStampComponent(entry.data as any, options.expanded, theme),
	);

	const openManagement = async (ctx: any): Promise<void> => {
		coordinator.attachContext(ctx);
		if (ctx.mode !== "tui") {
			ctx.ui.notify(
				"/subagents management overlay is available in TUI mode; use subagent_control in headless modes.",
				"warning",
			);
			return;
		}
		const status = await coordinator.control("status");
		const items = managementItems(status.details as any);
		const choice = await ctx.ui.custom(
			(tui: any, theme: any, _keybindings: any, done: any) =>
				new ManagementOverlay(items, theme, done, () => tui.requestRender()),
			{
				overlay: true,
				overlayOptions: {
					anchor: "right-center",
					width: "70%",
					minWidth: 54,
					maxHeight: "80%",
					margin: 1,
				},
			},
		);
		if (!choice) return;
		let message: string | undefined;
		let delivery: DeliveryPolicy | undefined;
		if (choice.action === "steer") {
			message = await ctx.ui.editor(`Steer ${choice.target}`, "");
			if (!message?.trim()) return;
		}
		if (choice.action === "set_delivery") {
			const selected = items.find((item) => item.child.target === choice.target)?.child;
			delivery = selected?.deliveryPolicy === "manual" ? "auto" : "manual";
		}
		try {
			const result = await coordinator.control(choice.action, choice.target, message, delivery, "user");
			ctx.ui.notify(result.content[0]?.text ?? "Subagent action accepted", "info");
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	};

	pi.registerCommand("subagents", {
		description: "Manage active and completed session subagents",
		handler: async (_args, ctx) => openManagement(ctx),
	});
	pi.registerShortcut?.("ctrl+shift+b", {
		description: "Manage session subagents",
		handler: async (ctx) => openManagement(ctx),
	});

	pi.registerTool({
		name: "subagent",
		label: "subagent",
		renderShell: "self",
		executionMode: "parallel",
		description:
			"Launch ordered foreground and background child Pi agents. Omitted execution remains synchronous foreground. Background children are session-scoped, share the same scheduler and working tree, and return durable acknowledgements rather than partial output. Optional per-child mode expands via amplike modes.json.",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: Parameters,
		execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
			if (!ctx.model) throw new Error("subagent requires a resolved parent model");
			coordinator.attachContext(ctx as any);
			const parentProvider = ctx.model.provider;
			const parentModelId = ctx.model.id;
			const parentThinking = pi.getThinkingLevel();
			const parentModel = `${parentProvider}/${parentModelId}`;

			// Expand mode → model/thinking seeds before tidy batch preflight.
			const expandedAgents = await expandAgentModes({
				cwd: ctx.cwd,
				modelRegistry: ctx.modelRegistry,
				parentModel: { provider: parentProvider, id: parentModelId },
				parentThinking,
				agents: params.agents,
			});

			// Complete preflight before run artifacts or child execution.
			const plans = resolveBatchRuntime(
				expandedAgents,
				{ provider: parentProvider, modelId: parentModelId, thinking: parentThinking },
				registryFromContext(ctx),
			);
			if (ctx.mode === "print" && expandedAgents.some((request) => request.execution === "background")) {
				throw new Error("Print mode cannot launch background subagents because no session owner remains");
			}

			const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
			const runDir = await createRunStore(getAgentDir(), runId);
			// tools/approved recorded for details; spawn path always isolates via buildChildArgs.
			const shared = {
				cwd: ctx.cwd,
				tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
				runDir,
				approved: true,
			};
			const children: ChildState[] = expandedAgents.map((request, index) => {
				const id = `child-${String(index + 1).padStart(3, "0")}`;
				const runtimePlan = plans[index]!;
				const ownership = request.execution ?? "foreground";
				return {
					index,
					id,
					target: `${runId}:${id}`,
					label: request.label || "agent",
					reason: request.reason,
					prompt: request.prompt,
					status: signal?.aborted && ownership === "foreground" ? "not-started" : "queued",
					...(signal?.aborted && ownership === "foreground"
						? { error: "Cancelled before start", endedAt: Date.now() }
						: {}),
					requestedExecution: ownership,
					ownership,
					ownershipChangedAt: Date.now(),
					ownershipReason: "direct-launch",
					deliveryPolicy: ownership === "background" ? "auto" : undefined,
					deliveryState: ownership === "background" ? "pending" : "none",
					model: runtimePlan.modelId,
					thinking: runtimePlan.thinking,
					runtimePlan,
					toolCount: 0,
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					providerTraffic: 0,
					tokens: 0,
					activities: [],
					activeTools: [],
					eventCount: 0,
					response: "",
					artifactPath: join(runDir, `${id}.md`),
				};
			});
			const details: RunDetails = {
				schemaVersion: 3,
				runId,
				runDir,
				cwd: ctx.cwd,
				createdAt: new Date().toISOString(),
				cap: scheduler.cap,
				runtime: {
					provider: parentProvider,
					modelId: parentModelId,
					model: parentModel,
					thinking: parentThinking,
					activeTools: shared.tools,
					projectTrusted: true,
				},
				children,
			};
			let updateTimer: ReturnType<typeof setTimeout> | undefined;
			let callActive = true;
			const emit = () => {
				if (!callActive) return;
				if (updateTimer) clearTimeout(updateTimer);
				updateTimer = undefined;
				onUpdate?.({
					content: [{ type: "text", text: "Subagents running" }],
					details: publicDetails(details),
				});
			};
			const changed = (immediate = false) => {
				if (!callActive) return;
				if (immediate) emit();
				else if (!updateTimer) {
					updateTimer = setTimeout(emit, 100);
					updateTimer.unref?.();
				}
			};
			emit();
			const records = await coordinator.launchRun(details, shared, ctx.mode, changed, parentBatchKey(ctx));
			const abort = () => coordinator.cancelForeground(records);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			try {
				await coordinator.waitForForeground(records);
				const fatal = coordinator.foregroundFatalError(records);
				if (fatal) throw fatal;
			} finally {
				callActive = false;
				if (updateTimer) clearTimeout(updateTimer);
				signal?.removeEventListener("abort", abort);
			}
			return {
				content: [{ type: "text", text: buildMixedEnvelope(children) }],
				details: publicDetails(details),
			};
		},
		renderCall: () => new Container(),
		renderResult: (result, options, theme) => {
			const details = result.details as RunDetails | undefined;
			const hasFailure =
				details?.children.some(
					(child) =>
						child.ownership !== "background" &&
						["failed", "cancelled", "not-started"].includes(child.status),
				) ?? false;
			const background = options.isPartial
				? "toolPendingBg"
				: hasFailure
					? "toolErrorBg"
					: "toolSuccessBg";
			return new ToolSnapshotComponent(details, options.expanded, (text) => theme.bg(background, text));
		},
	});

	pi.registerTool({
		name: "subagent_control",
		label: "subagent control",
		executionMode: "parallel",
		description:
			"Control one session-scoped child: background, steer through Pi's native queue, cancel, inspect, list status, set automatic/manual delivery, or collect a bounded terminal result.",
		promptGuidelines: [
			"Use subagent_control canonical targets when labels may be ambiguous. Background ownership is one-way and print mode cannot own background work.",
		],
		parameters: ControlParameters,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			coordinator.attachContext(ctx as any);
			validateControlInput(params);
			return coordinator.control(
				params.action,
				params.target,
				params.message,
				params.delivery,
				"agent",
				parentBatchKey(ctx),
			);
		},
	});
}
