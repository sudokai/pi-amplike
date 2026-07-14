/**
 * Per-child mode expansion for tidy-style subagent requests.
 *
 * Precedence (same as handoff / mode-utils): parent → mode → model → thinking.
 * Expands into model/thinking seeds before tidy resolveBatchRuntime so invalid
 * models fail the whole batch cleanly.
 *
 * Only dimensions selected by the request (or contributed by mode) are seeded.
 * Omitted dimensions stay inherited so tidy can clamp thinking; explicit
 * unsupported thinking still hard-fails in tidy preflight.
 */

import { loadModeSpec, resolveModelAndThinking } from "./mode-utils.js";
import { parseExactModelRef } from "../vendor/pi-tidy-subagents/runtime.js";

export type AgentModeRequest = {
	label?: string;
	reason: string;
	prompt: string;
	mode?: string;
	model?: string;
	thinking?: string;
	execution?: "foreground" | "background";
};

export type ExpandedAgentRequest = {
	label?: string;
	reason: string;
	prompt: string;
	model?: string;
	thinking?: string;
	execution?: "foreground" | "background";
};

export type ExpandAgentModesParams = {
	cwd: string;
	modelRegistry: {
		find(provider: string, modelId: string): { provider: string; id: string } | undefined | null;
	};
	parentModel: { provider: string; id: string };
	parentThinking: string;
	agents: AgentModeRequest[];
};

/**
 * Expand per-child `mode` into model/thinking seeds.
 * Unknown mode → throws (batch preflight hard fail).
 * Mode model not in registry (and no explicit model) → throws.
 * Explicit model missing/malformed → throws (never soft-fallback).
 * Seeds only dimensions selected by the request or mode.
 */
export async function expandAgentModes(params: ExpandAgentModesParams): Promise<ExpandedAgentRequest[]> {
	const { cwd, modelRegistry, parentModel, parentThinking, agents } = params;
	const out: ExpandedAgentRequest[] = [];

	for (let index = 0; index < agents.length; index++) {
		const agent = agents[index]!;
		const who = `child[${index}] label=${JSON.stringify(agent.label || "agent")}`;

		let modeContributesModel = false;
		let modeContributesThinking = false;

		if (agent.mode) {
			const spec = await loadModeSpec(cwd, agent.mode);
			if (!spec) {
				throw new Error(`${who}: unknown mode ${JSON.stringify(agent.mode)}`);
			}
			modeContributesModel = Boolean(spec.provider && spec.modelId);
			modeContributesThinking = Boolean(spec.thinkingLevel);
			if (modeContributesModel && !agent.model) {
				const found = modelRegistry.find(spec.provider!, spec.modelId!);
				if (!found) {
					throw new Error(
						`${who}: mode ${JSON.stringify(agent.mode)} model ${JSON.stringify(`${spec.provider}/${spec.modelId}`)} not found in registry`,
					);
				}
			}
		}

		// Explicit model must resolve exactly — never soft-fall back to parent/mode.
		if (agent.model) {
			const parsed = parseExactModelRef(agent.model);
			if (!parsed) {
				throw new Error(
					`${who}: invalid model reference ${JSON.stringify(agent.model)} (expected exact provider/model-id)`,
				);
			}
			const found = modelRegistry.find(parsed.provider, parsed.modelId);
			if (!found) {
				throw new Error(
					`${who}: model ${JSON.stringify(agent.model)} not found in registry`,
				);
			}
		}

		const seedModel = Boolean(agent.model || modeContributesModel);
		const seedThinking = Boolean(agent.thinking || modeContributesThinking);
		const hasOverride = Boolean(agent.mode || agent.model || agent.thinking);

		if (!hasOverride) {
			const { mode: _m, ...rest } = agent;
			out.push(rest);
			continue;
		}

		const resolved = await resolveModelAndThinking(
			cwd,
			modelRegistry,
			parentModel,
			parentThinking,
			{
				mode: agent.mode,
				model: agent.model,
				thinkingLevel: agent.thinking,
			},
		);

		if (seedModel && (!resolved.model?.provider || !resolved.model?.id)) {
			throw new Error(`${who}: no model available after mode/model resolution`);
		}

		// Seed only selected dimensions so tidy inherits/clamps the rest.
		const expanded: ExpandedAgentRequest = {
			label: agent.label,
			reason: agent.reason,
			prompt: agent.prompt,
			...(agent.execution ? { execution: agent.execution } : {}),
		};
		if (seedModel) {
			expanded.model = `${resolved.model.provider}/${resolved.model.id}`;
		}
		if (seedThinking) {
			expanded.thinking = resolved.thinkingLevel;
		}
		out.push(expanded);
	}

	return out;
}
