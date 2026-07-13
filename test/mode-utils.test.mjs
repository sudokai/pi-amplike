/**
 * Deterministic regression tests for resolveModelAndThinking precedence.
 *
 * Run: node test/mode-utils.test.mjs   (wired into npm test)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti } from "@mariozechner/jiti";

const jiti = createJiti(import.meta.url);
const { resolveModelAndThinking } = await jiti.import("../extensions/lib/mode-utils.ts");

let failures = 0;
const eq = (name, got, want) => {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
	if (!ok) failures++;
};

const stubModel = (provider, id) => ({ provider, id });
const registry = {
	find(provider, modelId) {
		if (provider === "anthropic" && modelId === "claude-haiku-4-5") return stubModel("anthropic", "claude-haiku-4-5");
		if (provider === "anthropic" && modelId === "claude-opus-4-6") return stubModel("anthropic", "claude-opus-4-6");
		return undefined;
	},
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-amplike-mode-utils-"));
const modesDir = path.join(tmpRoot, ".pi");
fs.mkdirSync(modesDir, { recursive: true });
fs.writeFileSync(
	path.join(modesDir, "modes.json"),
	JSON.stringify({
		version: 1,
		currentMode: "rush",
		modes: {
			rush: { provider: "anthropic", modelId: "claude-haiku-4-5", thinkingLevel: "low" },
			smart: { provider: "anthropic", modelId: "claude-opus-4-6", thinkingLevel: "low" },
		},
	}),
);

const current = stubModel("anthropic", "claude-opus-4-6");
const parentThinking = "medium";

// Default: no params
{
	const r = await resolveModelAndThinking(tmpRoot, registry, current, parentThinking, {});
	eq("default: model unchanged", r.model?.id, "claude-opus-4-6");
	eq("default: thinking unchanged", r.thinkingLevel, "medium");
}

// mode only
{
	const r = await resolveModelAndThinking(tmpRoot, registry, current, parentThinking, { mode: "rush" });
	eq("mode only: model from mode", r.model?.id, "claude-haiku-4-5");
	eq("mode only: thinking from mode", r.thinkingLevel, "low");
}

// mode + thinkingLevel (explicit wins)
{
	const r = await resolveModelAndThinking(tmpRoot, registry, current, parentThinking, {
		mode: "rush",
		thinkingLevel: "high",
	});
	eq("mode+thinking: model from mode", r.model?.id, "claude-haiku-4-5");
	eq("mode+thinking: explicit thinking wins", r.thinkingLevel, "high");
}

// model only
{
	const r = await resolveModelAndThinking(tmpRoot, registry, current, parentThinking, {
		model: "anthropic/claude-haiku-4-5",
	});
	eq("model only: model updated", r.model?.id, "claude-haiku-4-5");
	eq("model only: thinking unchanged", r.thinkingLevel, "medium");
}

// mode + model + thinkingLevel
{
	const r = await resolveModelAndThinking(tmpRoot, registry, current, parentThinking, {
		mode: "rush",
		model: "anthropic/claude-opus-4-6",
		thinkingLevel: "xhigh",
	});
	eq("all three: explicit model wins over mode", r.model?.id, "claude-opus-4-6");
	eq("all three: explicit thinking wins", r.thinkingLevel, "xhigh");
}

// thinkingLevel only
{
	const r = await resolveModelAndThinking(tmpRoot, registry, current, parentThinking, {
		thinkingLevel: "minimal",
	});
	eq("thinking only: model unchanged", r.model?.id, "claude-opus-4-6");
	eq("thinking only: thinking set", r.thinkingLevel, "minimal");
}

// unknown mode: model and thinking unchanged
{
	const r = await resolveModelAndThinking(tmpRoot, registry, current, parentThinking, { mode: "nonexistent" });
	eq("unknown mode: model unchanged", r.model?.id, "claude-opus-4-6");
	eq("unknown mode: thinking unchanged", r.thinkingLevel, "medium");
}

// malformed model: model unchanged, thinkingLevel still applies
{
	const r = await resolveModelAndThinking(tmpRoot, registry, current, parentThinking, {
		model: "no-slash-model",
		thinkingLevel: "high",
	});
	eq("malformed model: model unchanged", r.model?.id, "claude-opus-4-6");
	eq("malformed model: thinking still applied", r.thinkingLevel, "high");
}

try {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {
	/* ignore */
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);