/**
 * Deterministic regression test for the subagent resume-decision logic:
 * lastAssistantText / isTerminalThresholdCompaction / decideResume.
 *
 * These encode the handling for "a threshold compaction ended the subagent turn
 * before a final answer" — the runtime won't auto-continue a willRetry:false
 * compaction and there's no human to press enter, so the harness nudges and, as
 * a last resort, surfaces the compaction summary. No LLM / session needed.
 *
 * Run: node test/resume-decision.test.mjs   (also wired into npm test)
 */

import { createJiti } from "@mariozechner/jiti";

const jiti = createJiti(import.meta.url);
const { lastAssistantText, isTerminalThresholdCompaction, decideResume } = await jiti.import(
	"../extensions/lib/subagent-core.ts",
);

let failures = 0;
const eq = (name, got, want) => {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
	if (!ok) failures++;
};

// --- lastAssistantText -----------------------------------------------------
const A = (content, extra = {}) => ({ role: "assistant", content, ...extra });
const txt = (t) => ({ type: "text", text: t });
const tool = (name) => ({ type: "toolCall", name, arguments: {} });

eq("text: empty when no messages", lastAssistantText([]), "");
eq("text: empty when assistant has only tool/thinking", lastAssistantText([A([tool("read"), { type: "thinking", thinking: "x" }])]), "");
eq("text: joins text parts of LATEST assistant", lastAssistantText([A([txt("old answer")]), { role: "user", content: [] }, A([txt("new "), txt("answer")])]), "new answer");
// The bug guard: an intermediate text preamble must NOT survive into a later
// text-less terminal turn.
eq(
	"text: latest text-less turn yields empty (ignores earlier preamble)",
	lastAssistantText([A([txt("Let me inspect…"), tool("read")]), A([{ type: "thinking", thinking: "…" }])]),
	"",
);

// --- isTerminalThresholdCompaction ----------------------------------------
const ok = { willRetry: false, reason: "threshold", aborted: false, summary: "S" };
eq("terminal: successful threshold w/ summary", isTerminalThresholdCompaction(ok), true);
eq("terminal: undefined", isTerminalThresholdCompaction(undefined), false);
eq("terminal: overflow willRetry", isTerminalThresholdCompaction({ ...ok, willRetry: true }), false);
eq("terminal: aborted", isTerminalThresholdCompaction({ ...ok, aborted: true }), false);
eq("terminal: failed (no summary)", isTerminalThresholdCompaction({ ...ok, summary: undefined }), false);
eq("terminal: wrong reason", isTerminalThresholdCompaction({ ...ok, reason: "overflow" }), false);

// --- decideResume ----------------------------------------------------------
const base = { finalText: "", lastCompaction: ok, nudges: 0, maxNudges: 3, stopReason: "length", aborted: false };

eq("decide: final text -> done", decideResume({ ...base, finalText: "the answer" }), { action: "done", output: "the answer" });
eq("decide: stalled w/ budget -> nudge", decideResume(base), { action: "nudge" });
eq("decide: budget exhausted -> fallback summary", decideResume({ ...base, nudges: 3 }), { action: "fallback", output: "S" });
eq("decide: failed compaction -> empty (no nudge, no fallback)", decideResume({ ...base, lastCompaction: { ...ok, summary: undefined } }), { action: "empty" });
eq("decide: overflow compaction -> empty", decideResume({ ...base, lastCompaction: { ...ok, willRetry: true } }), { action: "empty" });
eq("decide: aborted -> empty (clean abort, no fabricated summary)", decideResume({ ...base, aborted: true }), { action: "empty" });
eq("decide: error stopReason -> empty (clean failure, no fabricated summary)", decideResume({ ...base, stopReason: "error" }), { action: "empty" });
eq("decide: aborted stopReason (signal not yet set) -> empty", decideResume({ ...base, stopReason: "aborted" }), { action: "empty" });
eq("decide: no compaction at all -> empty", decideResume({ ...base, lastCompaction: undefined }), { action: "empty" });

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
