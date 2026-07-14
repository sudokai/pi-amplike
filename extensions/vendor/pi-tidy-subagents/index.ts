/**
 * Vendored pi-tidy-subagents public surface (library-only in pi-amplike).
 *
 * Parent registration lives in extensions/subagent.ts (modes, no routing).
 * Nested under extensions/vendor/ so Pi does not auto-discover this module.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export { buildEnvelope } from "./envelope.js";
export { concurrencyCap, Scheduler } from "./scheduler.js";
export { renderLines, renderBackgroundAcknowledgementLines, ToolSnapshotComponent } from "./render.js";
export { BackgroundStampComponent, BackgroundWidgetComponent, ManagementOverlay, managementActions, managementItems, renderBackgroundWidgetLines, renderManagementLines } from "./ui.js";
export { SessionCoordinator, backgroundAcknowledgement, buildMixedEnvelope, publicChild } from "./coordinator.js";
export { buildChildArgs, buildChildEnv, launchRuntime } from "./runner.js";
export { inheritRuntimePlan, isThinkingLevel, THINKING_LEVELS } from "./types.js";
export { parseExactModelRef, resolveBatchRuntime, wrapPiRegistry, RuntimeResolutionError } from "./runtime.js";
export {
	buildDefaultRoutingConfig,
	clearRoutingConfig,
	defaultThinkingForTask,
	formatRoutingGuidance,
	listAuthenticatedModels,
	loadRoutingConfig,
	resolveTaskSelection,
	routingConfigPath,
	saveRoutingConfig,
	STANDARD_TASK_CLASSES,
	ROUTING_CONFIG_VERSION,
} from "./config.js";
export type { ChildRuntimePlan, RuntimeProvenance, ThinkingAdjustment, ThinkingLevel } from "./types.js";
export type { ModelAuthRegistry, ThinkingCapableModel } from "./runtime.js";
export type { AuthModelRef, RoutingConfig, RoutingSelection, TaskClass } from "./config.js";

/** Exact model field guidance (amplike: modes replace tidy routing). */
export const MODEL_FIELD_DESCRIPTION =
	"Exact registered provider/model-id (split at first '/'). Omit inherits parent (or mode). No aliases, profiles, or fuzzy patterns. Prefer inherit or amplike mode; pass exact id only when capability or cost warrants.";

/** Short, stable thinking field guidance (closed levels; inheritance default; brief task shapes). */
export const THINKING_FIELD_DESCRIPTION =
	"Pi thinking level: off|minimal|low|medium|high|xhigh|max. Omit inherits parent. Primary per-child control: minimal/low for bounded or mechanical work; medium for ordinary review; high+ for architecture, concurrency, hard diagnosis. Explicit unsupported fails preflight; inherited clamps.";

/** One-line startup diagnostic when registration is intentionally skipped in a child RPC process. */
export const CHILD_SKIP_DIAGNOSTIC =
	"pi-tidy-subagents: skipping registration in child RPC process (nested subagents disabled)";

/** Child-RPC predicate (`PI_TIDY_SUBAGENT_CHILD=1` and `--mode rpc`). */
export { isChildRpcProcess } from "../../lib/permissions-core.js";

/**
 * Library-only entry. Do not register this path as a Pi extension.
 * Use extensions/subagent.ts for amplike subagent registration.
 */
export default function extension(_pi: ExtensionAPI): void {
	throw new Error(
		"pi-tidy-subagents vendor snapshot is library-only in pi-amplike; load extensions/subagent.ts instead",
	);
}
