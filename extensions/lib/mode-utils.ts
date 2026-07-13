/**
 * Shared mode/model resolution utilities.
 *
 * Used by handoff and subagent to resolve mode, model, and thinkingLevel
 * parameters against modes.json.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

export type ModeSpec = {
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
};

/**
 * Load a mode spec from modes.json by name.
 * Checks project-level .pi/modes.json first, then global ~/.pi/agent/modes.json.
 * Returns the spec if found, or undefined.
 */
export async function loadModeSpec(
	cwd: string,
	modeName: string,
): Promise<ModeSpec | undefined> {
	const expandUser = (p: string) => {
		if (p === "~") return os.homedir();
		if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
		return p;
	};

	const agentDir = process.env.PI_CODING_AGENT_DIR
		? expandUser(process.env.PI_CODING_AGENT_DIR)
		: path.join(os.homedir(), ".pi", "agent");

	const candidates = [
		path.join(cwd, ".pi", "modes.json"),
		path.join(agentDir, "modes.json"),
	];

	for (const modesPath of candidates) {
		try {
			const raw = fs.readFileSync(modesPath, "utf8");
			const parsed = JSON.parse(raw);
			if (parsed.modes && typeof parsed.modes === "object" && parsed.modes[modeName]) {
				const spec = parsed.modes[modeName];
				return {
					provider: typeof spec.provider === "string" ? spec.provider : undefined,
					modelId: typeof spec.modelId === "string" ? spec.modelId : undefined,
					thinkingLevel: typeof spec.thinkingLevel === "string" ? spec.thinkingLevel : undefined,
				};
			}
		} catch {
			continue;
		}
	}
	return undefined;
}

export type ResolveModelAndThinkingParams = {
	mode?: string;
	model?: string;
	/** Explicit thinking level; wins over mode preset thinking. Values: off, minimal, low, medium, high, xhigh */
	thinkingLevel?: string;
};

/**
 * Resolve a target model and thinking level from mode/model/thinkingLevel parameters.
 *
 * Precedence (later steps override earlier for that dimension only):
 * 1. Start from `currentModel` and `currentThinkingLevel` (parent session).
 * 2. `mode` — may set model and thinking from modes.json.
 * 3. `model` — overrides model only (provider/modelId).
 * 4. `thinkingLevel` — overrides thinking only (wins over mode's thinkingLevel).
 */
export async function resolveModelAndThinking(
	cwd: string,
	modelRegistry: any,
	currentModel: any,
	currentThinkingLevel: string,
	params: ResolveModelAndThinkingParams,
): Promise<{ model: any; thinkingLevel: string }> {
	let targetModel = currentModel;
	let targetThinkingLevel = currentThinkingLevel;

	if (params.mode) {
		const spec = await loadModeSpec(cwd, params.mode);
		if (spec) {
			if (spec.provider && spec.modelId) {
				const m = modelRegistry.find(spec.provider, spec.modelId);
				if (m) targetModel = m;
			}
			if (spec.thinkingLevel) targetThinkingLevel = spec.thinkingLevel;
		}
	}

	if (params.model) {
		const slashIdx = params.model.indexOf("/");
		if (slashIdx > 0) {
			const m = modelRegistry.find(
				params.model.slice(0, slashIdx),
				params.model.slice(slashIdx + 1),
			);
			if (m) targetModel = m;
		}
	}

	if (params.thinkingLevel) {
		targetThinkingLevel = params.thinkingLevel;
	}

	return { model: targetModel, thinkingLevel: targetThinkingLevel };
}
