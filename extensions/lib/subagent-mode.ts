/**
 * Per-spawn mode expansion for herdr subagent launch requests.
 *
 * Precedence (same as handoff / mode-utils): parent → mode → model → thinking.
 * Expands into model/thinking seeds before herdr launch planning so invalid
 * models fail cleanly.
 *
 * Only dimensions selected by the request (or contributed by mode) are seeded.
 * Omitted dimensions stay inherited so launch can use agent defaults / parent.
 */

import { loadModeSpec, resolveModelAndThinking } from "./mode-utils.js";
import { parseExactModelRef } from "./model-ref.js";

export type SubagentModeLaunchParams = {
	mode?: string;
	model?: string;
	thinking?: string;
};

export type ExpandSubagentModeOptions = {
	cwd: string;
	modelRegistry: {
		find(provider: string, modelId: string): { provider: string; id: string } | undefined | null;
	};
	parentModel: { provider: string; id: string };
	parentThinking: string;
	who?: string;
};

type ModeSeedContext = ExpandSubagentModeOptions & {
	who: string;
	mode?: string;
	model?: string;
	thinking?: string;
};

async function expandModeSeeds(ctx: ModeSeedContext): Promise<{ model?: string; thinking?: string }> {
	const { cwd, modelRegistry, parentModel, parentThinking, who, mode, model, thinking } = ctx;

	let modeContributesModel = false;
	let modeContributesThinking = false;

	if (mode) {
		const spec = await loadModeSpec(cwd, mode);
		if (!spec) {
			throw new Error(`${who}: unknown mode ${JSON.stringify(mode)}`);
		}
		modeContributesModel = Boolean(spec.provider && spec.modelId);
		modeContributesThinking = Boolean(spec.thinkingLevel);
		if (modeContributesModel && !model) {
			const found = modelRegistry.find(spec.provider!, spec.modelId!);
			if (!found) {
				throw new Error(
					`${who}: mode ${JSON.stringify(mode)} model ${JSON.stringify(`${spec.provider}/${spec.modelId}`)} not found in registry`,
				);
			}
		}
	}

	if (model) {
		const parsed = parseExactModelRef(model);
		if (!parsed) {
			throw new Error(
				`${who}: invalid model reference ${JSON.stringify(model)} (expected exact provider/model-id)`,
			);
		}
		const found = modelRegistry.find(parsed.provider, parsed.modelId);
		if (!found) {
			throw new Error(`${who}: model ${JSON.stringify(model)} not found in registry`);
		}
	}

	const seedModel = Boolean(model || modeContributesModel);
	const seedThinking = Boolean(thinking || modeContributesThinking);
	const hasOverride = Boolean(mode || model || thinking);

	if (!hasOverride) {
		return {};
	}

	const resolved = await resolveModelAndThinking(cwd, modelRegistry, parentModel, parentThinking, {
		mode,
		model,
		thinkingLevel: thinking,
	});

	if (seedModel && (!resolved.model?.provider || !resolved.model?.id)) {
		throw new Error(`${who}: no model available after mode/model resolution`);
	}

	const seeds: { model?: string; thinking?: string } = {};
	if (seedModel) {
		seeds.model = `${resolved.model.provider}/${resolved.model.id}`;
	}
	if (seedThinking) {
		seeds.thinking = resolved.thinkingLevel;
	}
	return seeds;
}

/** Expand amplike `mode` / `model` / `thinking` on a herdr subagent spawn request. */
export async function expandSubagentLaunchParams<T extends SubagentModeLaunchParams>(
	params: T,
	options: ExpandSubagentModeOptions,
): Promise<Omit<T, "mode">> {
	const who = options.who ?? "subagent";
	const seeds = await expandModeSeeds({
		...options,
		who,
		mode: params.mode,
		model: params.model,
		thinking: params.thinking,
	});

	const { mode: _mode, ...rest } = params;
	const out = { ...rest } as Omit<T, "mode">;
	if (seeds.model) (out as SubagentModeLaunchParams).model = seeds.model;
	if (seeds.thinking) (out as SubagentModeLaunchParams).thinking = seeds.thinking;
	return out;
}
