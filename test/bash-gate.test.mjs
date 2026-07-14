/**
 * Fail-closed Amp bash gate decisions (subagent-bash-gate.decideBash).
 *
 * Hermetic: pure decideBash + project-local amp.permissions; never mutates
 * ~/.pi/agent/amplike.json.
 *
 * Run: node test/bash-gate.test.mjs
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti } from "@mariozechner/jiti";

const jiti = createJiti(import.meta.url);
const core = await jiti.import("../extensions/lib/permissions-core.ts");
const gate = await jiti.import("../extensions/lib/subagent-bash-gate.ts");

let failures = 0;
const ok = (name, cond, detail = "") => {
	console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : detail ? ` (${detail})` : ""}`);
	if (!cond) failures++;
};
const eq = (name, got, want) => {
	const match = got === want;
	console.log(`${match ? "ok  " : "FAIL"} ${name}${match ? "" : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
	if (!match) failures++;
};

const { decideBash, BLOCK_REASON } = gate;
const cwd = process.cwd();

// YOLO allows everything
{
	const d = decideBash("git push origin main", cwd, { permissions: { mode: "yolo" } });
	ok("yolo allows git push", d.block === false);
}

// Allowlisted / builtin allow
{
	const d = decideBash("git status", cwd, { permissions: { mode: "enabled" } });
	ok("git status allowed", d.block === false);
}

// ask (builtin git push) is blocked without UI
{
	const d = decideBash("git push origin main", cwd, { permissions: { mode: "enabled" } });
	ok("git push blocked fail-closed", d.block === true);
	ok("block reason mentions fail-closed", typeof d.reason === "string" && d.reason.includes("fail-closed"));
	eq("block reason constant", d.reason, BLOCK_REASON);
}

// Unmatched command defaults to ask → block
{
	const d = decideBash("curl https://evil.example", cwd, { permissions: { mode: "enabled" } });
	ok("unmatched curl blocked", d.block === true);
}

// resolveBashAction itself: allow vs ask
eq("resolveBashAction git status", core.resolveBashAction("git status", cwd), "allow");
eq("resolveBashAction git push", core.resolveBashAction("git push origin main", cwd), "ask");

// deny / reject via project-local amp.permissions (no real amplike.json)
{
	const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-amplike-bash-gate-"));
	const agentsDir = path.join(projectRoot, ".agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	fs.writeFileSync(
		path.join(agentsDir, "settings.json"),
		JSON.stringify({
			"amp.permissions": [
				{ tool: "Bash", matches: { cmd: "rm -rf *" }, action: "deny" },
				{ tool: "Bash", matches: { cmd: "sudo *" }, action: "reject" },
			],
		}) + "\n",
	);

	eq("resolveBashAction deny", core.resolveBashAction("rm -rf /tmp/x", projectRoot), "deny");
	eq("resolveBashAction reject", core.resolveBashAction("sudo ls", projectRoot), "reject");

	const denyDecision = decideBash("rm -rf /tmp/x", projectRoot, { permissions: { mode: "enabled" } });
	ok("deny blocks without prompt", denyDecision.block === true);
	ok("deny reason fail-closed", denyDecision.reason?.includes("fail-closed"));

	const rejectDecision = decideBash("sudo ls", projectRoot, { permissions: { mode: "enabled" } });
	ok("reject blocks without prompt", rejectDecision.block === true);
	ok("reject reason fail-closed", rejectDecision.reason?.includes("fail-closed"));

	// YOLO still wins over deny/reject
	const yoloOverDeny = decideBash("rm -rf /tmp/x", projectRoot, { permissions: { mode: "yolo" } });
	ok("yolo overrides deny", yoloOverDeny.block === false);

	fs.rmSync(projectRoot, { recursive: true, force: true });
}

// Gate module loads as default export function; non-bash passthrough
{
	ok("gate default export is function", typeof gate.default === "function");

	const handlers = [];
	const pi = {
		on(event, fn) {
			handlers.push({ event, fn });
		},
	};
	gate.default(pi);
	ok("registers tool_call only", handlers.length === 1 && handlers[0].event === "tool_call");

	const result = await handlers[0].fn(
		{ toolName: "read", input: {} },
		{ cwd },
	);
	ok("non-bash returns undefined", result === undefined);
}

// decideBash is pure: no dependency on real AMPLIKE_SETTINGS_PATH for decisions
{
	ok("decideBash export is function", typeof decideBash === "function");
	const enabled = decideBash("git status", cwd, { permissions: { mode: "enabled" } });
	const yolo = decideBash("git push", cwd, { permissions: { mode: "yolo" } });
	ok("pure decideBash allow", enabled.block === false);
	ok("pure decideBash yolo", yolo.block === false);
}

if (failures > 0) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall bash-gate tests passed");
