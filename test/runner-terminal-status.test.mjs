/**
 * Unit tests for finalizeChildTerminalStatus (Pi RPC settlement + assistant stopReason).
 *
 * Run: node test/runner-terminal-status.test.mjs
 */

import { createJiti } from "@mariozechner/jiti";

const jiti = createJiti(import.meta.url);
const { finalizeChildTerminalStatus } = await jiti.import(
	"../extensions/vendor/pi-tidy-subagents/runner.ts",
);

let failures = 0;
const eq = (name, got, want) => {
	const ok = got === want;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
	if (!ok) failures++;
};

const baseChild = (response = "done") => ({
	index: 0,
	id: "c1",
	label: "agent",
	reason: "test",
	prompt: "go",
	status: "running",
	model: "m",
	thinking: "low",
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
	response,
	artifactPath: "/tmp/x",
});

const settledOk = {
	cancelled: false,
	promptFailure: "",
	promptSent: true,
	settled: true,
	stderr: "",
	exitCode: 0,
};

{
	const child = baseChild("partial output");
	finalizeChildTerminalStatus(child, {
		...settledOk,
		stopReason: "error",
		errorMessage: "terminated",
	});
	eq("stopReason error + terminated → failed", child.status, "failed");
	eq("surfaces errorMessage", child.error, "terminated");
}

{
	const child = baseChild("hello");
	finalizeChildTerminalStatus(child, { ...settledOk, stopReason: "stop" });
	eq("stopReason stop with text → completed", child.status, "completed");
}

{
	const child = baseChild("");
	finalizeChildTerminalStatus(child, { ...settledOk, stopReason: "stop" });
	eq("settled empty response → warning", child.status, "warning");
}

{
	const child = baseChild("x");
	finalizeChildTerminalStatus(child, { ...settledOk, stopReason: "aborted" });
	eq("stopReason aborted → failed", child.status, "failed");
}

{
	const child = baseChild("partial");
	finalizeChildTerminalStatus(child, {
		...settledOk,
		stopReason: "error",
		errorMessage: "   ",
	});
	eq("error without message → failed", child.status, "failed");
	eq("error fallback message", child.error, "Agent stopped with error");
}

{
	const child = baseChild("still here");
	finalizeChildTerminalStatus(child, {
		cancelled: true,
		promptFailure: "",
		promptSent: true,
		settled: true,
		stderr: "",
		exitCode: 0,
		stopReason: "error",
		errorMessage: "terminated",
	});
	eq("cancelled takes precedence over assistant error stopReason", child.status, "cancelled");
}

{
	const child = baseChild("x");
	finalizeChildTerminalStatus(child, {
		...settledOk,
		settled: false,
		exitCode: 1,
		stopReason: "error",
		errorMessage: "terminated",
	});
	eq("unsettled RPC takes precedence over stopReason", child.status, "failed");
	eq("unsettled error mentions exit", child.error.includes("before settling"), true);
}

{
	const child = baseChild("truncated answer");
	finalizeChildTerminalStatus(child, { ...settledOk, stopReason: "length" });
	eq("stopReason length → warning", child.status, "warning");
	eq("length warning message", child.error.includes("length limit"), true);
}

if (failures > 0) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nAll runner terminal status tests passed.");