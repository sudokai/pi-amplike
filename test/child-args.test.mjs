/**
 * Unit tests for isolated child spawn args (vendored runner.buildChildArgs).
 *
 * Run: node test/child-args.test.mjs
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "@mariozechner/jiti";

const jiti = createJiti(import.meta.url);
const runner = await jiti.import("../extensions/vendor/pi-tidy-subagents/runner.ts");

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

const gateOverride = "/tmp/fake-bash-gate.ts";
const prevGate = process.env.PI_TIDY_SUBAGENT_BASH_GATE;
process.env.PI_TIDY_SUBAGENT_BASH_GATE = gateOverride;

try {
	const args = runner.buildChildArgs({
		model: "anthropic/claude-haiku-4-5",
		thinking: "low",
	});

	eq("starts with --mode rpc", args.slice(0, 2), ["--mode", "rpc"]);
	ok("includes --no-session", args.includes("--no-session"));
	ok("includes --no-extensions", args.includes("--no-extensions"));
	ok("includes --approve always", args.includes("--approve"));
	ok("includes -e flag", args.includes("-e"));
	const eIdx = args.indexOf("-e");
	eq("-e path is gate override", args[eIdx + 1], gateOverride);
	ok("includes --tools", args.includes("--tools"));
	const toolsIdx = args.indexOf("--tools");
	eq(
		"tools are fixed builtins",
		args[toolsIdx + 1],
		"read,write,edit,bash,grep,find,ls",
	);
	eq("model flag", [args[args.indexOf("--model")], args[args.indexOf("--model") + 1]], [
		"--model",
		"anthropic/claude-haiku-4-5",
	]);
	eq("thinking flag", [args[args.indexOf("--thinking")], args[args.indexOf("--thinking") + 1]], [
		"--thinking",
		"low",
	]);
	ok("does not include --no-tools", !args.includes("--no-tools"));
	ok("CHILD_BUILTIN_TOOLS length 7", runner.CHILD_BUILTIN_TOOLS.length === 7);
} finally {
	if (prevGate === undefined) delete process.env.PI_TIDY_SUBAGENT_BASH_GATE;
	else process.env.PI_TIDY_SUBAGENT_BASH_GATE = prevGate;
}

// Default gate path resolves under extensions/lib
delete process.env.PI_TIDY_SUBAGENT_BASH_GATE;
const defaultGate = runner.resolveBashGatePath();
const expectedGate = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../extensions/lib/subagent-bash-gate.ts",
);
eq("default gate path is absolute bash-gate", defaultGate, expectedGate);
ok("default gate path is absolute", path.isAbsolute(defaultGate));

// Child spawn env marks nested-subagent disable
{
	const env = runner.buildChildEnv({ PATH: "/usr/bin", FOO: "bar" });
	eq("PI_TIDY_SUBAGENT_CHILD is 1", env.PI_TIDY_SUBAGENT_CHILD, "1");
	eq("preserves other env", env.FOO, "bar");
	eq("preserves PATH", env.PATH, "/usr/bin");
	ok("does not mutate input env object", !("PI_TIDY_SUBAGENT_CHILD" in { PATH: "/usr/bin" }));
}

if (failures > 0) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall child-args tests passed");
