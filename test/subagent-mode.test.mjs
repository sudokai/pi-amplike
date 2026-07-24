/**
 * Mode expansion for herdr subagent spawn requests.
 *
 * Run: node test/subagent-mode.test.mjs
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti } from "@mariozechner/jiti";

const jiti = createJiti(import.meta.url);
const { expandSubagentLaunchParams } = await jiti.import("../extensions/lib/subagent-mode.ts");

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
			fastmodel: { provider: "anthropic", modelId: "claude-haiku-4-5" },
			deepthink: { thinkingLevel: "minimal" },
		},
	}),
);

const parentModel = stubModel("anthropic", "claude-opus-4-6");
const parentThinking = "high";
const baseOptions = {
	cwd: tmpRoot,
	modelRegistry: registry,
	parentModel,
	parentThinking,
};

const expand = (overrides = {}, options = {}) =>
	expandSubagentLaunchParams(
		{ name: "Worker", task: "Do it", ...overrides },
		{ ...baseOptions, ...options },
	);

// No overrides: pass through without seeding model/thinking
{
	const out = await expand();
	eq("no override omits model/thinking", out, { name: "Worker", task: "Do it" });
	ok("no override strips mode", !("mode" in out));
}

// Mode alone expands model + thinking when mode contributes both
{
	const out = await expand({ mode: "rush" });
	eq("mode expands model+thinking", out, {
		name: "Worker",
		task: "Do it",
		model: "anthropic/claude-haiku-4-5",
		thinking: "low",
	});
	ok("mode expansion strips mode", !("mode" in out));
}

// mode → model → thinking precedence
{
	const out = await expand({
		mode: "rush",
		model: "anthropic/claude-opus-4-6",
		thinking: "minimal",
		agent: "scout",
	});
	eq("explicit model/thinking win over mode", out, {
		name: "Worker",
		task: "Do it",
		model: "anthropic/claude-opus-4-6",
		thinking: "minimal",
		agent: "scout",
	});
}

// Unknown mode hard-fails
{
	let threw = false;
	try {
		await expand({ mode: "nope" });
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
		await expand({ mode: "broken" });
	} catch (e) {
		threw = true;
		ok("broken mode message", String(e.message).includes("not found in registry"), String(e.message));
	}
	ok("broken mode model throws", threw);
}

// Explicit thinking only seeds thinking
{
	const out = await expand({ thinking: "off" });
	eq("thinking-only seeds thinking only", out, { name: "Worker", task: "Do it", thinking: "off" });
	ok("thinking-only omits model", !("model" in out));
}

// Explicit model only seeds model
{
	const out = await expand({ model: "anthropic/claude-haiku-4-5" });
	eq("model-only seeds model only", out, {
		name: "Worker",
		task: "Do it",
		model: "anthropic/claude-haiku-4-5",
	});
	ok("model-only omits thinking field", !("thinking" in out));
}

// Mode model-only leaves thinking omitted
{
	const out = await expand({ mode: "fastmodel" });
	eq("mode model-only seeds model only", out, {
		name: "Worker",
		task: "Do it",
		model: "anthropic/claude-haiku-4-5",
	});
	ok("mode model-only omits thinking", !("thinking" in out));
}

// Mode thinking-only leaves model omitted
{
	const out = await expand({ mode: "deepthink" });
	eq("mode thinking-only seeds thinking only", out, {
		name: "Worker",
		task: "Do it",
		thinking: "minimal",
	});
	ok("mode thinking-only omits model", !("model" in out));
}

// Invalid explicit model hard-fails (no soft parent fallback)
{
	let threw = false;
	try {
		await expand({ model: "nope/missing" });
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
		await expand({ model: "not-a-ref" });
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

// Custom who label surfaces in errors
{
	let message = "";
	try {
		await expand({ mode: "nope" }, { who: 'subagent name="Planner"' });
	} catch (e) {
		message = String(e.message);
	}
	ok("custom who in error", message.includes('subagent name="Planner"'), message);
}

fs.rmSync(tmpRoot, { recursive: true, force: true });

if (failures > 0) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall subagent-mode tests passed");
