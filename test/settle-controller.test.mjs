/**
 * Deterministic regression test for createSettleController (the subagent
 * completion barrier). No LLM / network — drives a fake event timeline against
 * a controllable `isBusy()` and asserts when `done` resolves.
 *
 * Run: npm test   (or: node test/settle-controller.test.mjs)
 *
 * The barrier is timer-sensitive and has a history of subtle races, so this
 * exercises the three shapes that matter:
 *   1. normal:          stream then idle -> settles after settleMs
 *   2. overflow+retry:  must NOT settle during the ~100ms continue gap; only
 *                       after the continued turn finishes
 *   3. overflow+no-op:  compaction_end{willRetry} with no continuation ->
 *                       released by the grace timer (never hangs)
 */

import { createJiti } from "@mariozechner/jiti";

const jiti = createJiti(import.meta.url);
const { createSettleController } = await jiti.import("../extensions/lib/subagent-core.ts");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond) => {
	console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
	if (!cond) failures++;
};

/**
 * Run a scripted scenario. Each step: { at, busy?, event?, kick?, assertResolved? }.
 * `busy` sets the session-level busy flag; `event` is fed to controller.onEvent.
 */
async function scenario(name, script, opts = {}) {
	const settleMs = opts.settleMs ?? 40;
	const graceMs = opts.graceMs ?? 120;
	const busyRef = { v: false };
	const c = createSettleController({ isBusy: () => busyRef.v, settleMs, graceMs, drain: opts.drain });
	let resolved = false;
	c.done.then(() => {
		resolved = true;
	});
	const t0 = Date.now();
	for (const step of script) {
		const wait = step.at - (Date.now() - t0);
		if (wait > 0) await sleep(wait);
		if ("busy" in step) busyRef.v = step.busy;
		if (step.event) c.onEvent(step.event);
		if (step.kick) c.kick();
		if (step.assertResolved !== undefined) {
			check(`${name} @${step.at}ms resolved==${step.assertResolved}`, resolved === step.assertResolved);
		}
	}
	c.dispose();
}

// 1. Normal turn.
await scenario("normal", [
	{ at: 0, busy: true, event: { type: "agent_start" } },
	{ at: 10, event: { type: "message_end" } },
	{ at: 20, busy: false, kick: true },
	{ at: 45, assertResolved: false }, // still within settle window
	{ at: 130, assertResolved: true }, // settled
]);

// 2. Overflow with a real retry: pendingContinue must bridge the gap where the
//    session is briefly not busy before the continuation's agent_start.
await scenario(
	"overflow+retry",
	[
		{ at: 0, busy: true, event: { type: "agent_start" } },
		{ at: 10, event: { type: "message_end" } },
		{ at: 20, event: { type: "agent_end" } },
		{ at: 25, busy: false, event: { type: "compaction_start" } },
		{ at: 30, event: { type: "compaction_end", willRetry: true } }, // pendingContinue
		{ at: 90, assertResolved: false }, // gap: held by pendingContinue despite !busy
		{ at: 100, busy: true, event: { type: "agent_start" } }, // continuation starts
		{ at: 120, event: { type: "message_end" } },
		{ at: 130, busy: false, kick: true },
		{ at: 160, assertResolved: false },
		{ at: 240, assertResolved: true },
	],
	{ settleMs: 40, graceMs: 300 },
);

// 3. Silent / no-op overflow: willRetry announced but no continuation ever
//    starts; the grace timer must release us (no hang).
await scenario(
	"overflow+noop",
	[
		{ at: 0, busy: true, event: { type: "agent_start" } },
		{ at: 10, event: { type: "message_end" } },
		{ at: 20, busy: false, event: { type: "compaction_end", willRetry: true } },
		{ at: 70, assertResolved: false }, // within grace
		{ at: 260, assertResolved: true }, // grace + settle expired
	],
	{ settleMs: 40, graceMs: 120 },
);

// 4. A rejecting drain must not strand `done`.
await scenario(
	"rejecting-drain",
	[
		{ at: 0, busy: true, event: { type: "agent_start" } },
		{ at: 20, busy: false, kick: true },
		{ at: 130, assertResolved: true },
	],
	{ settleMs: 40, graceMs: 120, drain: async () => { throw new Error("drain boom"); } },
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
