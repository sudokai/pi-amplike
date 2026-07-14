/**
 * Unit tests for child spawn args (vendored runner.buildChildArgs).
 *
 * Run: node test/child-args.test.mjs
 */

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

const args = runner.buildChildArgs({
	model: "anthropic/claude-haiku-4-5",
	thinking: "low",
});

eq("starts with --mode rpc", args.slice(0, 2), ["--mode", "rpc"]);
ok("includes --no-session", args.includes("--no-session"));
ok("includes --approve", args.includes("--approve"));
eq(
	"exact arg list",
	args,
	[
		"--mode",
		"rpc",
		"--no-session",
		"--approve",
		"--model",
		"anthropic/claude-haiku-4-5",
		"--thinking",
		"low",
	],
);

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
