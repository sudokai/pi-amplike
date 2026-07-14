/**
 * Mode expansion for per-child subagent requests.
 *
 * Run: node test/subagent-mode.test.mjs
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti } from "@mariozechner/jiti";

const jiti = createJiti(import.meta.url);
const { expandAgentModes } = await jiti.import("../extensions/lib/subagent-mode.ts");

let failures = 0;
const eq = (name, got, want) => {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
	if (!ok) failures++;
};
const ok = (name, cond, detail = "") => {
	console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : detail ? ` (${detail})` : ""}`);
	if (!cond) failures++;
};

const stubModel = (provider, id) => ({ provider, id });
const registry = {
	find(provider, modelId) {
		if (provider === "anthropic" && modelId === "claude-haiku-4-5") return stubModel("anthropic", "claude-haiku-4-5");
		if (provider === "anthropic" && modelId === "claude-opus-4-6") return stubModel("anthropic", "claude-opus-4-6");
		return undefined;
	},
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-amplike-subagent-mode-"));
const modesDir = path.join(tmpRoot, ".pi");
fs.mkdirSync(modesDir, { recursive: true });
fs.writeFileSync(
	path.join(modesDir, "modes.json"),
	JSON.stringify({
		version: 1,
		currentMode: "rush",
		modes: {
			rush: { provider: "anthropic", modelId: "claude-haiku-4-5", thinkingLevel: "low" },
			smart: { provider: "anthropic", modelId: "claude-opus-4-6", thinkingLevel: "medium" },
			broken: { provider: "anthropic", modelId: "does-not-exist", thinkingLevel: "high" },
			// Model-only mode: thinking should stay omitted for tidy inherit/clamp
			fastmodel: { provider: "anthropic", modelId: "claude-haiku-4-5" },
			// Thinking-only mode: model should stay omitted for tidy inherit
			deepthink: { thinkingLevel: "minimal" },
		},
	}),
);

const parentModel = stubModel("anthropic", "claude-opus-4-6");
const parentThinking = "high";

// No overrides: pass through without seeding model/thinking
{
	const out = await expandAgentModes({
		cwd: tmpRoot,
		modelRegistry: registry,
		parentModel,
		parentThinking,
		agents: [{ reason: "r", prompt: "p", label: "a" }],
	});
	eq("no override omits model/thinking", out, [{ reason: "r", prompt: "p", label: "a" }]);
}

// Mode alone expands model + thinking when mode contributes both
{
	const out = await expandAgentModes({
		cwd: tmpRoot,
		modelRegistry: registry,
		parentModel,
		parentThinking,
		agents: [{ reason: "r", prompt: "p", mode: "rush" }],
	});
	eq("mode expands model+thinking", out, [
		{ reason: "r", prompt: "p", model: "anthropic/claude-haiku-4-5", thinking: "low" },
	]);
}

// mode → model → thinking precedence
{
	const out = await expandAgentModes({
		cwd: tmpRoot,
		modelRegistry: registry,
		parentModel,
		parentThinking,
		agents: [
			{
				reason: "r",
				prompt: "p",
				mode: "rush",
				model: "anthropic/claude-opus-4-6",
				thinking: "minimal",
				execution: "background",
			},
		],
	});
	eq("explicit model/thinking win over mode", out, [
		{
			reason: "r",
			prompt: "p",
			execution: "background",
			model: "anthropic/claude-opus-4-6",
			thinking: "minimal",
		},
	]);
}

// Unknown mode hard-fails
{
	let threw = false;
	try {
		await expandAgentModes({
			cwd: tmpRoot,
			modelRegistry: registry,
			parentModel,
			parentThinking,
			agents: [{ reason: "r", prompt: "p", mode: "nope" }],
		});
	} catch (e) {
		threw = true;
		ok("unknown mode message", String(e.message).includes("unknown mode"), String(e.message));
	}
	ok("unknown mode throws", threw);
}

// Mode with missing registry model hard-fails
{
	let threw = false;
	try {
		await expandAgentModes({
			cwd: tmpRoot,
			modelRegistry: registry,
			parentModel,
			parentThinking,
			agents: [{ reason: "r", prompt: "p", mode: "broken" }],
		});
	} catch (e) {
		threw = true;
		ok("broken mode message", String(e.message).includes("not found in registry"), String(e.message));
	}
	ok("broken mode model throws", threw);
}

// Explicit thinking only seeds thinking (model omitted → tidy inherit/clamp)
{
	const out = await expandAgentModes({
		cwd: tmpRoot,
		modelRegistry: registry,
		parentModel,
		parentThinking,
		agents: [{ reason: "r", prompt: "p", thinking: "off" }],
	});
	eq("thinking-only seeds thinking only", out, [{ reason: "r", prompt: "p", thinking: "off" }]);
}

// Explicit model only seeds model (thinking omitted → tidy inherit/clamp)
{
	const out = await expandAgentModes({
		cwd: tmpRoot,
		modelRegistry: registry,
		parentModel,
		parentThinking,
		agents: [{ reason: "r", prompt: "p", model: "anthropic/claude-haiku-4-5" }],
	});
	eq("model-only seeds model only", out, [
		{ reason: "r", prompt: "p", model: "anthropic/claude-haiku-4-5" },
	]);
	ok("model-only omits thinking field", !("thinking" in out[0]));
}

// Mode model-only leaves thinking omitted for clamp
{
	const out = await expandAgentModes({
		cwd: tmpRoot,
		modelRegistry: registry,
		parentModel,
		parentThinking,
		agents: [{ reason: "r", prompt: "p", mode: "fastmodel" }],
	});
	eq("mode model-only seeds model only", out, [
		{ reason: "r", prompt: "p", model: "anthropic/claude-haiku-4-5" },
	]);
	ok("mode model-only omits thinking", !("thinking" in out[0]));
}

// Mode thinking-only leaves model omitted
{
	const out = await expandAgentModes({
		cwd: tmpRoot,
		modelRegistry: registry,
		parentModel,
		parentThinking,
		agents: [{ reason: "r", prompt: "p", mode: "deepthink" }],
	});
	eq("mode thinking-only seeds thinking only", out, [
		{ reason: "r", prompt: "p", thinking: "minimal" },
	]);
	ok("mode thinking-only omits model", !("model" in out[0]));
}

// Invalid explicit model hard-fails (no soft parent fallback)
{
	let threw = false;
	try {
		await expandAgentModes({
			cwd: tmpRoot,
			modelRegistry: registry,
			parentModel,
			parentThinking,
			agents: [{ reason: "r", prompt: "p", model: "nope/missing" }],
		});
	} catch (e) {
		threw = true;
		ok(
			"invalid model message",
			String(e.message).includes("not found in registry"),
			String(e.message),
		);
	}
	ok("invalid explicit model throws", threw);
}

// Malformed explicit model hard-fails
{
	let threw = false;
	try {
		await expandAgentModes({
			cwd: tmpRoot,
			modelRegistry: registry,
			parentModel,
			parentThinking,
			agents: [{ reason: "r", prompt: "p", model: "not-a-ref" }],
		});
	} catch (e) {
		threw = true;
		ok(
			"malformed model message",
			String(e.message).includes("invalid model reference"),
			String(e.message),
		);
	}
	ok("malformed explicit model throws", threw);
}

fs.rmSync(tmpRoot, { recursive: true, force: true });

if (failures > 0) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall subagent-mode tests passed");
