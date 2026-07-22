/**
 * Unit tests for live subagent transcript formatter + accumulator.
 *
 * Run: node test/transcript.test.mjs
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "@mariozechner/jiti";

const jiti = createJiti(import.meta.url);
const transcript = await jiti.import("../extensions/vendor/pi-tidy-subagents/transcript.ts");

const {
	ASSISTANT_TEXT_LIMIT,
	STREAM_FLUSH_MS,
	THINKING_LIMIT,
	TOOL_RESULT_LIMIT,
	TranscriptAccumulator,
	TranscriptWriter,
	formatTranscript,
	initialTranscriptModel,
	transcriptPathFor,
	truncateUtf8,
	writeTerminalTranscript,
	writeTranscriptFile,
} = transcript;

let failures = 0;
const eq = (name, got, want) => {
	const ok = got === want;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
	if (!ok) failures++;
};
const ok = (name, cond, detail = "") => {
	console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : detail ? ` (${detail})` : ""}`);
	if (!cond) failures++;
};
const includes = (name, haystack, needle) => {
	ok(name, typeof haystack === "string" && haystack.includes(needle), `missing ${JSON.stringify(needle)}`);
};

// --- path helper ---
eq(
	"transcriptPathFor sibling naming",
	transcriptPathFor("/runs/r1", "child-001"),
	join("/runs/r1", "child-001.transcript.md"),
);

// --- truncation ---
{
	const small = truncateUtf8("hello", 100);
	eq("truncate short text unchanged", small.text, "hello");
	eq("truncate short not marked", small.truncated, false);
}
{
	const huge = "x".repeat(100);
	const cut = truncateUtf8(huge, 20);
	ok("truncate marks overflow", cut.truncated);
	includes("truncate marker present", cut.text, "… (truncated)");
	ok("truncate respects budget", Buffer.byteLength(cut.text, "utf8") <= 20);
}
{
	const empty = truncateUtf8("abc", 0);
	eq("zero budget empty text", empty.text, "");
	eq("zero budget truncated", empty.truncated, true);
}

// --- formatter: header + empty prompt + no turns ---
{
	const md = formatTranscript({
		header: { label: "scout", target: "run:child-001", status: "queued", model: "haiku", thinking: "low" },
		prompt: "",
		entries: [],
	});
	includes("header label", md, "# Subagent transcript: scout");
	includes("header target", md, "run:child-001");
	includes("header status", md, "queued");
	includes("header model", md, "haiku");
	includes("header thinking", md, "low");
	includes("empty prompt marker", md, "_(empty)_");
	includes("no turns marker", md, "_(no turns yet)_");
}

// --- formatter: thinking + tools + steer + truncation markers ---
{
	const bigResult = "R".repeat(TOOL_RESULT_LIMIT + 200);
	const bigThinking = "T".repeat(THINKING_LIMIT + 50);
	const bigText = "A".repeat(ASSISTANT_TEXT_LIMIT + 50);
	const md = formatTranscript({
		header: {
			label: "worker",
			target: "r:child-002",
			status: "running",
			model: "sonnet",
			thinking: "high",
			error: "still going",
		},
		prompt: "Do the thing",
		entries: [
			{ type: "assistant", thinking: bigThinking, text: bigText, partial: true },
			{ type: "tool", id: "t1", name: "bash", args: { command: "ls" }, done: false },
			{
				type: "tool",
				id: "t2",
				name: "read",
				args: { path: "/tmp/x" },
				done: true,
				isError: false,
				result: bigResult.slice(0, TOOL_RESULT_LIMIT) + "… (truncated)",
			},
			{ type: "steer", message: "focus on tests" },
		],
	});
	includes("prompt body", md, "Do the thing");
	includes("error in header", md, "still going");
	includes("streaming marker", md, "(streaming)");
	includes("thinking section", md, "#### Thinking");
	includes("text section", md, "#### Text");
	includes("thinking truncated", md, "… (truncated)");
	includes("text truncated", md, "… (truncated)");
	includes("tool running", md, "Tool `bash` (running)");
	includes("tool done", md, "Tool `read` (done)");
	includes("tool args json fence", md, "```json");
	includes("steer section", md, "### 4. Steering");
	includes("steer message", md, "focus on tests");
}

// --- accumulator: event sequence ---
{
	const acc = new TranscriptAccumulator({
		header: { label: "a", target: "r:c", status: "running", model: "m", thinking: "low" },
		prompt: "go",
	});

	eq("ignore unknown event", acc.applyEvent({ type: "response", id: "1" }), "none");

	eq(
		"thinking delta streams",
		acc.applyEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "think " },
		}),
		"stream",
	);
	eq(
		"text delta streams",
		acc.applyEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "hello " },
		}),
		"stream",
	);

	let model = acc.model();
	eq("partial assistant entry", model.entries.length, 1);
	eq("partial flag", model.entries[0].partial, true);
	eq("partial thinking", model.entries[0].thinking, "think ");
	eq("partial text", model.entries[0].text, "hello ");

	eq(
		"message_end finalizes",
		acc.applyEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "think more" },
					{ type: "text", text: "hello world" },
				],
			},
		}),
		"immediate",
	);
	model = acc.model();
	eq("finalized not partial", model.entries[0].partial, false);
	// Prefer canonical message_end parts over partial stream buffers.
	eq("finalized thinking from message", model.entries[0].thinking, "think more");
	eq("finalized text from message", model.entries[0].text, "hello world");

	eq(
		"tool start immediate",
		acc.applyEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: { command: "pwd" } }),
		"immediate",
	);
	eq(
		"tool end immediate",
		acc.applyEvent({
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "bash",
			isError: false,
			result: { content: [{ type: "text", text: "/tmp\n" }] },
		}),
		"immediate",
	);
	model = acc.model();
	const tool = model.entries.find((e) => e.type === "tool");
	ok("tool entry present", tool && tool.done);
	eq("tool result extracted", tool.result, "/tmp\n");

	eq("steer immediate", acc.recordSteer("try again"), "immediate");
	model = acc.model();
	ok(
		"steer entry present",
		model.entries.some((e) => e.type === "steer" && e.message === "try again"),
	);

	eq("queue_update is none (not rendered)", acc.applyEvent({ type: "queue_update", steering: ["x"] }), "none");
	eq("agent_settled immediate", acc.applyEvent({ type: "agent_settled" }), "immediate");
}

// --- tool interleave must not replay full assistant message ---
{
	const acc = new TranscriptAccumulator({
		header: { label: "t", status: "running", model: "m", thinking: "low" },
		prompt: "p",
	});
	acc.applyEvent({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "before tool" },
	});
	acc.applyEvent({ type: "tool_execution_start", toolCallId: "1", toolName: "bash", args: {} });
	acc.applyEvent({
		type: "tool_execution_end",
		toolCallId: "1",
		toolName: "bash",
		result: "ok",
	});
	acc.applyEvent({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "after tool" },
	});
	acc.applyEvent({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "before toolafter tool" }],
		},
	});
	const entries = acc.model().entries;
	const assistants = entries.filter((e) => e.type === "assistant");
	eq("interleave assistant segments", assistants.length, 2);
	eq("pre-tool segment", assistants[0].text, "before tool");
	eq("post-tool segment", assistants[1].text, "after tool");
	ok(
		"no full-message replay",
		!assistants.some((e) => e.text === "before toolafter tool"),
	);
	ok(
		"tool between assistant segments",
		entries[1]?.type === "tool" && entries[1]?.name === "bash",
	);
}

// --- edge cases ---
{
	const acc = new TranscriptAccumulator({
		header: { label: "e", status: "running", model: "m", thinking: "off" },
		prompt: "",
	});
	// Missing fields should not throw
	eq("tool start missing ids", acc.applyEvent({ type: "tool_execution_start" }), "immediate");
	eq("tool end missing ids", acc.applyEvent({ type: "tool_execution_end", isError: true }), "immediate");
	eq("message_update empty", acc.applyEvent({ type: "message_update" }), "none");
	eq(
		"huge tool result truncated on end",
		acc.applyEvent({
			type: "tool_execution_end",
			toolCallId: "big",
			toolName: "read",
			result: "Z".repeat(TOOL_RESULT_LIMIT + 5000),
		}),
		"immediate",
	);
	const tool = acc.model().entries.find((e) => e.type === "tool" && e.id === "big");
	ok("huge result marked truncated", tool?.result?.includes("… (truncated)"));
	ok(
		"huge result within budget",
		Buffer.byteLength(tool?.result ?? "", "utf8") <= TOOL_RESULT_LIMIT + 20,
	);

	// message_end without prior deltas uses content parts
	const acc2 = new TranscriptAccumulator({
		header: { label: "e2", status: "running", model: "m", thinking: "low" },
		prompt: "p",
	});
	acc2.applyEvent({
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "only end" },
				{ type: "text", text: "final only" },
			],
		},
	});
	const entry = acc2.model().entries[0];
	eq("message_end without deltas thinking", entry.thinking, "only end");
	eq("message_end without deltas text", entry.text, "final only");

	// Cancelled mid-flight: partial open message remains visible as partial until settled
	const acc3 = new TranscriptAccumulator({
		header: { label: "c", status: "running", model: "m", thinking: "low" },
		prompt: "p",
	});
	acc3.applyEvent({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "partial..." },
	});
	acc3.updateHeader({ status: "cancelled", error: "Cancelled" });
	const cancelled = acc3.model();
	eq("cancelled header status", cancelled.header.status, "cancelled");
	eq("cancelled header error", cancelled.header.error, "Cancelled");
	eq("cancelled keeps partial stream", cancelled.entries[0]?.partial, true);
	eq("cancelled partial text", cancelled.entries[0]?.text, "partial...");
}

// --- empty/whitespace delta + tool boundary must not drop message_end content ---
{
	const acc = new TranscriptAccumulator({
		header: { label: "empty-delta", status: "running", model: "m", thinking: "low" },
		prompt: "p",
	});
	acc.applyEvent({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "" },
	});
	acc.applyEvent({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "   " },
	});
	acc.applyEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
	acc.applyEvent({
		type: "tool_execution_end",
		toolCallId: "t1",
		toolName: "bash",
		result: "ok",
	});
	acc.applyEvent({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "recovered after empty stream" }],
		},
	});
	const assistants = acc.model().entries.filter((e) => e.type === "assistant");
	ok("empty-delta+tool retains message_end text", assistants.some((e) => e.text === "recovered after empty stream"));
}

// --- thinking stream + tool + message_end text without post-tool deltas ---
{
	const acc = new TranscriptAccumulator({
		header: { label: "mid-tool-tail", status: "running", model: "m", thinking: "low" },
		prompt: "p",
	});
	acc.applyEvent({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "plan it" },
	});
	acc.applyEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
	acc.applyEvent({
		type: "tool_execution_end",
		toolCallId: "t1",
		toolName: "bash",
		result: "ok",
	});
	// No post-tool deltas — final text arrives only on message_end (cumulative).
	acc.applyEvent({
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "plan it" },
				{ type: "text", text: "done via tools" },
			],
		},
	});
	const assistants = acc.model().entries.filter((e) => e.type === "assistant");
	eq("thinking+tool keeps pre-tool segment", assistants[0]?.thinking, "plan it");
	ok("thinking+tool retains message_end text tail", assistants.some((e) => e.text === "done via tools"));
	ok(
		"thinking+tool does not replay full thinking",
		assistants.filter((e) => e.thinking === "plan it").length === 1,
	);
}

// --- multi-turn residual must not treat prior turns as committed prefix ---
{
	const acc = new TranscriptAccumulator({
		header: { label: "multi-turn", status: "running", model: "m", thinking: "low" },
		prompt: "p",
	});
	// Turn 1: complete assistant message with text that would poison a full-history residual.
	acc.applyEvent({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "Hello world" },
	});
	acc.applyEvent({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Hello world" }],
		},
	});
	// Turn 2: thinking stream → tool → text only on message_end (non-prefix-safe vs turn 1).
	acc.applyEvent({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "plan turn2" },
	});
	acc.applyEvent({ type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: {} });
	acc.applyEvent({
		type: "tool_execution_end",
		toolCallId: "t2",
		toolName: "bash",
		result: "ok",
	});
	acc.applyEvent({
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "plan turn2" },
				{ type: "text", text: "Hello" },
			],
		},
	});
	const entries = acc.model().entries;
	const assistants = entries.filter((e) => e.type === "assistant");
	eq("multi-turn keeps turn1 text", assistants[0]?.text, "Hello world");
	eq("multi-turn keeps turn2 thinking segment", assistants[1]?.thinking, "plan turn2");
	ok("multi-turn retains turn2 residual text", assistants.some((e) => e.text === "Hello"));
	ok(
		"multi-turn does not replay turn1 after tool",
		assistants.filter((e) => e.text === "Hello world").length === 1,
	);
	ok("multi-turn has tool between turn2 segments", entries.some((e) => e.type === "tool" && e.name === "bash"));
}

// --- empty/whitespace post-tool deltas must not drop residual message_end text ---
{
	const acc = new TranscriptAccumulator({
		header: { label: "post-tool-empty", status: "running", model: "m", thinking: "low" },
		prompt: "p",
	});
	acc.applyEvent({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "plan" },
	});
	acc.applyEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
	acc.applyEvent({
		type: "tool_execution_end",
		toolCallId: "t1",
		toolName: "bash",
		result: "ok",
	});
	// Empty/whitespace deltas after the tool must not force an empty push that skips residual.
	acc.applyEvent({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "" },
	});
	acc.applyEvent({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "   " },
	});
	acc.applyEvent({
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "plan" },
				{ type: "text", text: "done via tools" },
			],
		},
	});
	const assistants = acc.model().entries.filter((e) => e.type === "assistant");
	eq("post-tool empty keeps pre-tool thinking", assistants[0]?.thinking, "plan");
	ok("post-tool empty retains residual text", assistants.some((e) => e.text === "done via tools"));
	ok(
		"post-tool empty does not push empty assistant row",
		!assistants.some((e) => !e.thinking?.trim() && !e.text?.trim()),
	);
}

// --- whitespace post-tool delta vs cumulative text (no full replay, keep residual tail) ---
{
	const acc = new TranscriptAccumulator({
		header: { label: "post-tool-ws", status: "running", model: "m", thinking: "low" },
		prompt: "p",
	});
	acc.applyEvent({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "before" },
	});
	acc.applyEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
	acc.applyEvent({
		type: "tool_execution_end",
		toolCallId: "t1",
		toolName: "bash",
		result: "ok",
	});
	acc.applyEvent({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "   " },
	});
	acc.applyEvent({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "beforeAFTER" }],
		},
	});
	const assistants = acc.model().entries.filter((e) => e.type === "assistant");
	eq("post-tool ws keeps pre-tool text", assistants[0]?.text, "before");
	ok("post-tool ws residual is AFTER only", assistants.some((e) => e.text === "AFTER"));
	ok(
		"post-tool ws no full-message replay",
		!assistants.some((e) => e.text === "beforeAFTER"),
	);
}

// --- truncation × residual: oversized pre-tool stream must not replay full message_end ---
{
	const acc = new TranscriptAccumulator({
		header: { label: "trunc-residual", status: "running", model: "m", thinking: "low" },
		prompt: "p",
	});
	const chunk = "X".repeat(8 * 1024);
	for (let i = 0; i < 12; i++) {
		acc.applyEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: chunk },
		});
	}
	const preToolOpen = acc.model().entries[0]?.text ?? "";
	ok("trunc-residual pre-tool already bounded", preToolOpen.includes("… (truncated)"));
	acc.applyEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
	acc.applyEvent({
		type: "tool_execution_end",
		toolCallId: "t1",
		toolName: "bash",
		result: "ok",
	});
	// message_end carries the full untruncated cumulative text — residual must not re-append it.
	const full = chunk.repeat(12);
	acc.applyEvent({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: full }],
		},
	});
	const assistants = acc.model().entries.filter((e) => e.type === "assistant");
	eq("trunc-residual single assistant segment", assistants.length, 1);
	includes("trunc-residual keeps truncation marker", assistants[0]?.text ?? "", "… (truncated)");
	ok(
		"trunc-residual no second near-full replay",
		assistants.length === 1 &&
			Buffer.byteLength(assistants[0]?.text ?? "", "utf8") <= ASSISTANT_TEXT_LIMIT + 32,
	);
}

// --- multi-tool commits over single-block budget must not residual-replay ---
{
	const acc = new TranscriptAccumulator({
		header: { label: "multi-tool-over", status: "running", model: "m", thinking: "low" },
		prompt: "p",
	});
	const segment = "A".repeat(40 * 1024);
	// Segment 1 (~40KB) → tool → segment 2 (~40KB) → tool → message_end with same cumulative text.
	acc.applyEvent({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: segment },
	});
	acc.applyEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
	acc.applyEvent({
		type: "tool_execution_end",
		toolCallId: "t1",
		toolName: "bash",
		result: "ok",
	});
	acc.applyEvent({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: segment },
	});
	acc.applyEvent({ type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: {} });
	acc.applyEvent({
		type: "tool_execution_end",
		toolCallId: "t2",
		toolName: "bash",
		result: "ok",
	});
	const full = segment + segment;
	acc.applyEvent({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: full }],
		},
	});
	const entries = acc.model().entries;
	const assistants = entries.filter((e) => e.type === "assistant");
	eq("multi-tool over-budget assistant segments", assistants.length, 2);
	eq("multi-tool over-budget pre-tool1 text length", assistants[0]?.text?.length, segment.length);
	eq("multi-tool over-budget pre-tool2 text length", assistants[1]?.text?.length, segment.length);
	ok(
		"multi-tool over-budget no third residual replay",
		assistants.length === 2,
		`got ${assistants.length} assistant rows`,
	);
	ok(
		"multi-tool over-budget tools interleaved",
		entries.filter((e) => e.type === "tool").length === 2,
	);
}

// --- multi-tool thinking over THINKING_LIMIT must not residual-replay ---
{
	const acc = new TranscriptAccumulator({
		header: { label: "multi-tool-think", status: "running", model: "m", thinking: "low" },
		prompt: "p",
	});
	const segment = "T".repeat(20 * 1024);
	acc.applyEvent({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: segment },
	});
	acc.applyEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
	acc.applyEvent({
		type: "tool_execution_end",
		toolCallId: "t1",
		toolName: "bash",
		result: "ok",
	});
	acc.applyEvent({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: segment },
	});
	acc.applyEvent({ type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: {} });
	acc.applyEvent({
		type: "tool_execution_end",
		toolCallId: "t2",
		toolName: "bash",
		result: "ok",
	});
	acc.applyEvent({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "thinking", thinking: segment + segment }],
		},
	});
	const assistants = acc.model().entries.filter((e) => e.type === "assistant");
	eq("multi-tool thinking over-budget segments", assistants.length, 2);
	ok(
		"multi-tool thinking no third residual replay",
		assistants.length === 2 &&
			!assistants.some((e) => (e.thinking?.length ?? 0) > segment.length + 32),
	);
}

// --- non-empty post-tool open buffers still merge residual (message_end-only thinking) ---
{
	const acc = new TranscriptAccumulator({
		header: { label: "merge-residual", status: "running", model: "m", thinking: "low" },
		prompt: "p",
	});
	acc.applyEvent({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "before" },
	});
	acc.applyEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
	acc.applyEvent({
		type: "tool_execution_end",
		toolCallId: "t1",
		toolName: "bash",
		result: "ok",
	});
	// Post-tool text deltas only — thinking arrives solely on message_end.
	acc.applyEvent({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "after" },
	});
	acc.applyEvent({
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "used the tool carefully" },
				{ type: "text", text: "beforeafter" },
			],
		},
	});
	const assistants = acc.model().entries.filter((e) => e.type === "assistant");
	eq("merge-residual pre-tool text", assistants[0]?.text, "before");
	eq("merge-residual post-tool text", assistants[1]?.text, "after");
	eq("merge-residual keeps message_end thinking", assistants[1]?.thinking, "used the tool carefully");
	ok(
		"merge-residual no full-message text replay",
		!assistants.some((e) => e.text === "beforeafter"),
	);
}

// --- incomplete post-tool open text prefers residual suffix from message_end ---
{
	const acc = new TranscriptAccumulator({
		header: { label: "prefer-residual", status: "running", model: "m", thinking: "low" },
		prompt: "p",
	});
	acc.applyEvent({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "before" },
	});
	acc.applyEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
	acc.applyEvent({
		type: "tool_execution_end",
		toolCallId: "t1",
		toolName: "bash",
		result: "ok",
	});
	// Incomplete post-tool stream — message_end carries the full cumulative text.
	acc.applyEvent({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "aft" },
	});
	acc.applyEvent({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "beforeafter" }],
		},
	});
	const assistants = acc.model().entries.filter((e) => e.type === "assistant");
	eq("prefer-residual pre-tool text", assistants[0]?.text, "before");
	eq("prefer-residual post-tool prefers full residual", assistants[1]?.text, "after");
	ok(
		"prefer-residual does not keep incomplete open only",
		!assistants.some((e) => e.text === "aft"),
	);
}

// --- in-memory stream buffers stay within formatter budgets ---
{
	const acc = new TranscriptAccumulator({
		header: { label: "bound", status: "running", model: "m", thinking: "low" },
		prompt: "p",
	});
	const chunk = "X".repeat(8 * 1024);
	for (let i = 0; i < 20; i++) {
		acc.applyEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: chunk },
		});
	}
	const partial = acc.model().entries[0];
	ok(
		"open text buffer bounded",
		Buffer.byteLength(partial?.text ?? "", "utf8") <= ASSISTANT_TEXT_LIMIT + 32,
		`bytes=${Buffer.byteLength(partial?.text ?? "", "utf8")}`,
	);
	includes("open text shows truncation marker", partial?.text ?? "", "… (truncated)");
}

// --- initial model helper ---
{
	const model = initialTranscriptModel({
		label: "init",
		target: "r:c",
		status: "queued",
		model: "m",
		thinking: "low",
		prompt: "hello",
	});
	eq("initial entries empty", model.entries.length, 0);
	eq("initial prompt", model.prompt, "hello");
	eq("initial status", model.header.status, "queued");
}

// --- atomic write ---
{
	const dir = await mkdtemp(join(tmpdir(), "pi-transcript-"));
	try {
		const path = transcriptPathFor(dir, "child-001");
		await writeTranscriptFile(
			path,
			initialTranscriptModel({
				label: "w",
				status: "queued",
				model: "m",
				thinking: "low",
				prompt: "p",
			}),
		);
		const body = await readFile(path, "utf8");
		includes("written file has header", body, "# Subagent transcript: w");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

// --- writer throttle: structured immediate vs stream scheduling ---
{
	const dir = await mkdtemp(join(tmpdir(), "pi-transcript-w-"));
	try {
		const path = join(dir, "child-001.transcript.md");
		let snapshots = 0;
		const acc = new TranscriptAccumulator({
			header: { label: "thr", status: "running", model: "m", thinking: "low" },
			prompt: "p",
		});
		const writer = new TranscriptWriter(path, () => {
			snapshots++;
			return acc.model();
		});
		await writer.flushNow();
		const afterInitial = snapshots;
		ok("initial flush wrote once", afterInitial >= 1);

		// Burst of stream events should not write more than ~1 immediately + trailing
		acc.applyEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "a" },
		});
		writer.schedule("stream");
		acc.applyEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "b" },
		});
		writer.schedule("stream");
		acc.applyEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "c" },
		});
		writer.schedule("stream");
		// First stream may flush immediately (lastFlush just happened); subsequent are throttled.
		await new Promise((r) => setTimeout(r, STREAM_FLUSH_MS + 50));
		await writer.dispose();
		const body = await readFile(path, "utf8");
		includes("throttled writer captured text", body, "abc");
		// Ceiling: initial + at most one immediate stream flush + one trailing coalesced flush.
		ok("stream burst coalesces tightly", snapshots <= afterInitial + 2, `snapshots=${snapshots} afterInitial=${afterInitial}`);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

// --- structured flush on tool boundary ---
{
	const dir = await mkdtemp(join(tmpdir(), "pi-transcript-s-"));
	try {
		const path = join(dir, "child-002.transcript.md");
		const acc = new TranscriptAccumulator({
			header: { label: "s", status: "running", model: "m", thinking: "low" },
			prompt: "p",
		});
		const writer = new TranscriptWriter(path, () => acc.model());
		const mode = acc.applyEvent({
			type: "tool_execution_start",
			toolCallId: "1",
			toolName: "find",
			args: { pattern: "x" },
		});
		eq("tool start mode immediate", mode, "immediate");
		writer.schedule(mode);
		await writer.dispose();
		const body = await readFile(path, "utf8");
		includes("structured flush has tool", body, "Tool `find`");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

// --- queued cancel: initial write → terminal rewrite shows cancelled on disk ---
{
	const dir = await mkdtemp(join(tmpdir(), "pi-transcript-q-"));
	try {
		const child = {
			id: "child-001",
			label: "queued-cancel",
			target: "run:child-001",
			status: "queued",
			model: "m",
			thinking: "low",
			prompt: "wait",
			transcriptPath: transcriptPathFor(dir, "child-001"),
		};
		await writeTranscriptFile(child.transcriptPath, initialTranscriptModel(child));
		let body = await readFile(child.transcriptPath, "utf8");
		includes("queued initial status", body, "**Status:** queued");

		// Simulate coordinator terminalization that never attached a runner writer.
		child.status = "cancelled";
		child.error = "Cancelled";
		await writeTerminalTranscript(child, dir);
		body = await readFile(child.transcriptPath, "utf8");
		includes("queued cancel final status", body, "**Status:** cancelled");
		includes("queued cancel error line", body, "**Error:** Cancelled");
		includes("queued cancel still no turns", body, "_(no turns yet)_");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

// --- writer dispose flushes final cancelled header (runner abort path) ---
{
	const dir = await mkdtemp(join(tmpdir(), "pi-transcript-d-"));
	try {
		const path = join(dir, "child-abort.transcript.md");
		const header = { label: "abort", status: "running", model: "m", thinking: "low" };
		const acc = new TranscriptAccumulator({ header, prompt: "p" });
		const writer = new TranscriptWriter(path, () => {
			acc.updateHeader(header);
			return acc.model();
		});
		await writer.flushNow();
		acc.applyEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "working" },
		});
		writer.schedule("stream");
		// Mirror requestAbort: status + error flip before dispose.
		header.status = "cancelled";
		header.error = "Cancelled";
		await writer.dispose();
		const body = await readFile(path, "utf8");
		includes("dispose cancel status", body, "**Status:** cancelled");
		includes("dispose cancel error", body, "**Error:** Cancelled");
		includes("dispose keeps partial text", body, "working");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

if (failures > 0) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nAll transcript tests passed.");
