/**
 * Fail-closed Amp bash decisions (permissions-core + permissions extension).
 *
 * Hermetic: pure decideBash + project-local amp.permissions; never mutates
 * ~/.pi/agent/amplike.json.
 *
 * Run: node test/permissions-bash.test.mjs
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti } from "@mariozechner/jiti";

const jiti = createJiti(import.meta.url);
const core = await jiti.import("../extensions/lib/permissions-core.ts");
const permissions = await jiti.import("../extensions/permissions.ts");

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

const { decideBash, FAIL_CLOSED_BASH_REASON, DENIED_BASH_REASON } = core;
const { shouldFailClosedBash } = permissions;
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
	ok("block reason mentions fail-closed policy", typeof d.reason === "string" && d.reason.includes("fail-closed"));
	eq("block reason constant", d.reason, FAIL_CLOSED_BASH_REASON);
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
	const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-amplike-permissions-bash-"));
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
	eq("deny reason shared", denyDecision.reason, DENIED_BASH_REASON);

	const rejectDecision = decideBash("sudo ls", projectRoot, { permissions: { mode: "enabled" } });
	ok("reject blocks without prompt", rejectDecision.block === true);
	eq("reject reason shared", rejectDecision.reason, DENIED_BASH_REASON);

	// YOLO still wins over deny/reject
	const yoloOverDeny = decideBash("rm -rf /tmp/x", projectRoot, { permissions: { mode: "yolo" } });
	ok("yolo overrides deny", yoloOverDeny.block === false);

	fs.rmSync(projectRoot, { recursive: true, force: true });
}

// shouldFailClosedBash predicate used by the extension
{
	ok("fail-closed when no UI", shouldFailClosedBash(false) === true);
	ok("interactive when has UI", shouldFailClosedBash(true) === false);
}

// Extension registers tool_call; non-bash tools pass through
{
	const handlers = [];
	const pi = {
		registerCommand() {},
		on(event, fn) {
			handlers.push({ event, fn });
		},
	};
	permissions.default(pi);
	const toolCall = handlers.find((h) => h.event === "tool_call");
	ok("registers tool_call", !!toolCall);

	const nonBash = await toolCall.fn({ toolName: "read", input: {} }, { hasUI: false, cwd });
	ok("non-bash returns undefined", nonBash === undefined);
}

// decideBash is pure
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
console.log("\nall permissions-bash tests passed");
