import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChildState } from "./types.js";

/** Tool result / tool args display budget. */
export const TOOL_RESULT_LIMIT = 4 * 1024;
/** Assistant thinking block budget. */
export const THINKING_LIMIT = 32 * 1024;
/** Single assistant text block budget. */
export const ASSISTANT_TEXT_LIMIT = 64 * 1024;
/** Trailing throttle for streaming text/thinking flushes. */
export const STREAM_FLUSH_MS = 300;

const TRUNCATION_MARKER = "… (truncated)";

export function transcriptPathFor(runDir: string, childId: string): string {
	return join(runDir, `${childId}.transcript.md`);
}

/** Byte-budget truncation with an explicit marker when content was cut. */
export function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
	if (maxBytes <= 0) return { text: "", truncated: value.length > 0 };
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };
	const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
	const budget = Math.max(0, maxBytes - markerBytes);
	let text = "";
	for (const character of value) {
		if (Buffer.byteLength(text + character, "utf8") > budget) break;
		text += character;
	}
	return { text: `${text}${TRUNCATION_MARKER}`, truncated: true };
}

function formatJson(value: unknown, maxBytes: number): string {
	let raw: string;
	try {
		raw = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		raw = String(value);
	}
	return truncateUtf8(raw, maxBytes).text;
}

function formatToolResult(result: unknown): string {
	if (result == null) return "";
	if (typeof result === "string") return truncateUtf8(result, TOOL_RESULT_LIMIT).text;
	// Common Pi tool result shape: { content: [{ type: "text", text }], isError? }
	if (typeof result === "object" && result !== null && Array.isArray((result as any).content)) {
		const text = (result as any).content
			.filter((part: any) => part?.type === "text")
			.map((part: any) => String(part.text ?? ""))
			.join("");
		if (text) return truncateUtf8(text, TOOL_RESULT_LIMIT).text;
	}
	return formatJson(result, TOOL_RESULT_LIMIT);
}

export interface TranscriptHeader {
	label: string;
	target?: string;
	status: string;
	model: string;
	thinking: string;
	error?: string;
}

export type TranscriptEntry =
	| { type: "assistant"; thinking: string; text: string; partial?: boolean }
	| { type: "tool"; id: string; name: string; args: unknown; result?: string; isError?: boolean; done: boolean }
	| { type: "steer"; message: string };

export interface TranscriptModel {
	header: TranscriptHeader;
	prompt: string;
	entries: TranscriptEntry[];
}

export function headerFromChild(child: Pick<ChildState, "label" | "target" | "status" | "model" | "thinking" | "error">): TranscriptHeader {
	return {
		label: child.label,
		...(child.target ? { target: child.target } : {}),
		status: child.status,
		model: child.model,
		thinking: child.thinking,
		...(child.error ? { error: child.error } : {}),
	};
}

export function formatTranscript(model: TranscriptModel): string {
	const { header, prompt, entries } = model;
	const lines: string[] = [
		`# Subagent transcript: ${header.label}`,
		"",
		`- **Target:** ${header.target ?? "(none)"}`,
		`- **Status:** ${header.status}`,
		`- **Model:** ${header.model}`,
		`- **Thinking:** ${header.thinking}`,
	];
	if (header.error) lines.push(`- **Error:** ${header.error}`);
	lines.push("", "## Prompt", "", prompt?.trim() ? prompt : "_(empty)_", "");

	if (entries.length === 0) {
		lines.push("## Turns", "", "_(no turns yet)_", "");
		return `${lines.join("\n")}\n`;
	}

	lines.push("## Turns", "");
	let turn = 0;
	for (const entry of entries) {
		if (entry.type === "assistant") {
			turn++;
			const partial = entry.partial ? " (streaming)" : "";
			lines.push(`### ${turn}. Assistant${partial}`, "");
			const thinking = truncateUtf8(entry.thinking ?? "", THINKING_LIMIT).text;
			const text = truncateUtf8(entry.text ?? "", ASSISTANT_TEXT_LIMIT).text;
			if (thinking.trim()) {
				lines.push("#### Thinking", "", thinking, "");
			}
			if (text.trim()) {
				lines.push("#### Text", "", text, "");
			} else if (!thinking.trim()) {
				lines.push("_(empty)_", "");
			}
		} else if (entry.type === "tool") {
			turn++;
			const state = entry.done ? (entry.isError ? "error" : "done") : "running";
			lines.push(`### ${turn}. Tool \`${entry.name}\` (${state})`, "");
			lines.push("#### Args", "", "```json", formatJson(entry.args ?? {}, TOOL_RESULT_LIMIT), "```", "");
			if (entry.done) {
				const result = entry.result?.trim() ? entry.result : "_(empty)_";
				lines.push("#### Result", "", result, "");
			}
		} else if (entry.type === "steer") {
			turn++;
			lines.push(`### ${turn}. Steering`, "", entry.message?.trim() ? entry.message : "_(empty)_", "");
		}
	}
	return `${lines.join("\n")}\n`;
}

/** Apply RPC events into a durable steer-pack model without re-reading jsonl. */
export class TranscriptAccumulator {
	private header: TranscriptHeader;
	private prompt: string;
	private entries: TranscriptEntry[] = [];
	private openThinking = "";
	private openText = "";
	private openMessage = false;
	/** True once this assistant message emitted deltas. */
	private streamedAssistant = false;
	/** True once a stream segment was committed mid-message (e.g. before a tool). */
	private committedStreamSegments = false;
	/** Per-message stream totals committed so far (not full history). Used for residual tails. */
	private committedStreamThinking = "";
	private committedStreamText = "";

	constructor(init: { header: TranscriptHeader; prompt: string }) {
		this.header = { ...init.header };
		this.prompt = init.prompt ?? "";
	}

	updateHeader(partial: Partial<TranscriptHeader>): void {
		this.header = { ...this.header, ...partial };
		// Drop stale error when status returns to a non-error terminal/active state and caller omitted error.
		if (
			partial.error === undefined &&
			partial.status !== undefined &&
			!["failed", "cancelled", "warning"].includes(partial.status)
		) {
			delete this.header.error;
		}
	}

	/** Snapshot for formatting / atomic write. */
	model(): TranscriptModel {
		const entries = this.entries.map((entry) => {
			if (entry.type === "assistant") return { ...entry };
			if (entry.type === "tool") return { ...entry };
			return { ...entry };
		});
		if (this.openMessage) {
			entries.push({
				type: "assistant",
				thinking: boundStreamText(this.openThinking, THINKING_LIMIT),
				text: boundStreamText(this.openText, ASSISTANT_TEXT_LIMIT),
				partial: true,
			});
		}
		return {
			header: { ...this.header },
			prompt: this.prompt,
			entries,
		};
	}

	recordSteer(message: string): "immediate" {
		this.entries.push({ type: "steer", message });
		return "immediate";
	}

	/**
	 * Ingest one raw RPC event.
	 * @returns flush urgency: structured boundaries → immediate; deltas → stream; irrelevant → none
	 */
	applyEvent(raw: any): "immediate" | "stream" | "none" {
		const type = String(raw?.type ?? "");
		if (type === "tool_execution_start") {
			this.flushOpenAssistantIfStreaming();
			const id = String(raw.toolCallId ?? "");
			this.entries.push({
				type: "tool",
				id,
				name: String(raw.toolName ?? "tool"),
				args: raw.args ?? {},
				done: false,
			});
			return "immediate";
		}
		if (type === "tool_execution_end") {
			const id = String(raw.toolCallId ?? "");
			const existing = [...this.entries].reverse().find((entry) => entry.type === "tool" && entry.id === id && !entry.done) as
				| Extract<TranscriptEntry, { type: "tool" }>
				| undefined;
			if (existing) {
				existing.done = true;
				existing.isError = Boolean(raw.isError);
				existing.result = formatToolResult(raw.result);
				if (raw.toolName) existing.name = String(raw.toolName);
			} else {
				this.entries.push({
					type: "tool",
					id,
					name: String(raw.toolName ?? "tool"),
					args: {},
					done: true,
					isError: Boolean(raw.isError),
					result: formatToolResult(raw.result),
				});
			}
			return "immediate";
		}
		if (type === "queue_update") {
			// Queue depth is not rendered in the transcript header; skip no-op rewrites.
			return "none";
		}
		if (type === "message_update") {
			const event = raw.assistantMessageEvent;
			const eventType = event?.type;
			if (eventType === "text_delta") {
				const delta = String(event.delta ?? "");
				this.openText = boundStreamText(this.openText + delta, ASSISTANT_TEXT_LIMIT);
				// Empty/whitespace-only deltas must not open the stream window or claim progress —
				// they would skip residual message_end content after a tool boundary.
				if (this.openText.trim() || this.openThinking.trim()) {
					this.openMessage = true;
					if (this.openText.trim()) this.streamedAssistant = true;
				}
				return "stream";
			}
			if (eventType === "thinking_delta") {
				const delta = String(event.delta ?? "");
				this.openThinking = boundStreamText(this.openThinking + delta, THINKING_LIMIT);
				if (this.openThinking.trim() || this.openText.trim()) {
					this.openMessage = true;
					if (this.openThinking.trim()) this.streamedAssistant = true;
				}
				return "stream";
			}
			// toolcall_* under assistantMessageEvent — tool rows come from tool_execution_*; ignore
			return "none";
		}
		if (type === "message_end" && raw.message?.role === "assistant") {
			const { thinking, text } = extractAssistantParts(raw.message);
			if (this.committedStreamSegments) {
				// Mid-message commits already flushed. Prefer residual tails from cumulative
				// message_end (canonical) when present; otherwise keep non-empty open buffers
				// (e.g. post-tool stream past a truncation budget).
				const residual = residualAssistantParts(
					thinking,
					text,
					this.committedStreamThinking,
					this.committedStreamText,
				);
				const finalThinking = residual.thinking.trim() ? residual.thinking : this.openThinking;
				const finalText = residual.text.trim() ? residual.text : this.openText;
				if (finalThinking.trim() || finalText.trim()) {
					this.pushAssistant(finalThinking, finalText);
				}
			} else if (this.openMessage) {
				// Single segment: prefer canonical message_end parts, fall back to stream buffers.
				this.pushAssistant(thinking || this.openThinking, text || this.openText);
			} else if (!this.streamedAssistant) {
				// No deltas observed — use message content (covers non-streaming RPC).
				if (thinking.trim() || text.trim()) {
					this.pushAssistant(thinking, text);
				}
			}
			// Prior committed stream segments stay as-is (no full-message replay).
			this.openThinking = "";
			this.openText = "";
			this.openMessage = false;
			this.streamedAssistant = false;
			this.committedStreamSegments = false;
			this.committedStreamThinking = "";
			this.committedStreamText = "";
			return "immediate";
		}
		if (type === "agent_settled") {
			this.flushOpenAssistantIfStreaming();
			return "immediate";
		}
		return "none";
	}

	private flushOpenAssistantIfStreaming(): void {
		if (!this.openMessage) return;
		if (!this.openThinking.trim() && !this.openText.trim()) {
			// Nothing to commit — forget the open window so a later message_end can still land.
			// Only clear streamedAssistant when no mid-message segment was already committed.
			if (!this.committedStreamSegments) this.streamedAssistant = false;
			this.openMessage = false;
			this.openThinking = "";
			this.openText = "";
			return;
		}
		// Track per-message committed totals for residual stripping. Re-bound the concatenation
		// so multi-tool segments cannot grow past a single block budget (which would break
		// prefix strip and re-append a near-full residual replay).
		this.committedStreamThinking = boundStreamText(
			this.committedStreamThinking + this.openThinking,
			THINKING_LIMIT,
		);
		this.committedStreamText = boundStreamText(
			this.committedStreamText + this.openText,
			ASSISTANT_TEXT_LIMIT,
		);
		this.pushAssistant(this.openThinking, this.openText);
		this.streamedAssistant = true;
		this.committedStreamSegments = true;
		this.openThinking = "";
		this.openText = "";
		this.openMessage = false;
	}

	private pushAssistant(thinking: string, text: string, partial = false): void {
		this.entries.push({
			type: "assistant",
			thinking: boundStreamText(thinking, THINKING_LIMIT),
			text: boundStreamText(text, ASSISTANT_TEXT_LIMIT),
			partial,
		});
	}
}

/** Keep in-memory stream/commit buffers within the same budgets as the formatter. */
function boundStreamText(value: string, maxBytes: number): string {
	return truncateUtf8(value, maxBytes).text;
}

/**
 * When mid-message segments were already committed, message_end is cumulative.
 * Return only the suffix not already represented in this message's committed stream totals.
 * Compare against the same in-memory bounds so truncation markers do not break prefix strip.
 */
function residualAssistantParts(
	thinking: string,
	text: string,
	committedThinking: string,
	committedText: string,
): { thinking: string; text: string } {
	return {
		thinking: stripCommittedPrefix(boundStreamText(thinking, THINKING_LIMIT), committedThinking),
		text: stripCommittedPrefix(boundStreamText(text, ASSISTANT_TEXT_LIMIT), committedText),
	};
}

function stripCommittedPrefix(full: string, committed: string): string {
	if (!full) return "";
	if (!committed) return full;
	if (full.startsWith(committed)) return full.slice(committed.length);
	// Stream buffers may already hold the full final content (or more after truncation markers).
	if (committed.startsWith(full)) return "";
	// Multi-segment commits can still exceed a single block budget if re-bounding is skipped;
	// when committed already covers the bounded full length, prefer empty over a full replay.
	if (committed.length >= full.length) return "";
	return full;
}

function extractAssistantParts(message: any): { thinking: string; text: string } {
	const content = Array.isArray(message?.content) ? message.content : [];
	let thinking = "";
	let text = "";
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		if (part.type === "thinking" || part.type === "reasoning") {
			thinking += String(part.thinking ?? part.text ?? part.reasoning ?? "");
		} else if (part.type === "text") {
			text += String(part.text ?? "");
		}
	}
	return { thinking, text };
}

/** Atomic markdown write (tmp + rename), same pattern as store.ts. */
export async function writeTranscriptFile(path: string, model: TranscriptModel): Promise<void> {
	const temporaryPath = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
	await writeFile(temporaryPath, formatTranscript(model), "utf8");
	await rename(temporaryPath, path);
}

export function initialTranscriptModel(child: Pick<ChildState, "label" | "target" | "status" | "model" | "thinking" | "error" | "prompt">): TranscriptModel {
	return {
		header: headerFromChild(child),
		prompt: child.prompt ?? "",
		entries: [],
	};
}

/**
 * Best-effort terminal rewrite for paths that never attached a runner-owned writer
 * (queued cancel, missing plan, scheduler reject before runChild).
 */
export async function writeTerminalTranscript(
	child: Pick<ChildState, "label" | "target" | "status" | "model" | "thinking" | "error" | "prompt" | "transcriptPath" | "id">,
	runDir?: string,
): Promise<void> {
	const path = child.transcriptPath ?? (runDir ? transcriptPathFor(runDir, child.id) : undefined);
	if (!path) return;
	try {
		await writeTranscriptFile(path, initialTranscriptModel(child));
	} catch {
		// Transcript is best-effort; durable truth remains jsonl + result md.
	}
}

/**
 * Coalesced live writer: structured events flush immediately; streaming deltas
 * rate-limit to ~STREAM_FLUSH_MS with a trailing edge so continuous streams still update.
 */
export class TranscriptWriter {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private lastFlushAt = 0;
	private chain: Promise<void> = Promise.resolve();
	private closed = false;

	constructor(
		private readonly path: string,
		private readonly getModel: () => TranscriptModel,
	) {}

	schedule(mode: "immediate" | "stream" | "none"): void {
		if (this.closed || mode === "none") return;
		if (mode === "immediate") {
			this.clearTimer();
			this.enqueueFlush();
			return;
		}
		const now = Date.now();
		const elapsed = now - this.lastFlushAt;
		if (this.lastFlushAt === 0 || elapsed >= STREAM_FLUSH_MS) {
			this.clearTimer();
			this.enqueueFlush();
			return;
		}
		if (this.timer) return;
		const wait = Math.max(1, STREAM_FLUSH_MS - elapsed);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.enqueueFlush();
		}, wait);
		this.timer.unref?.();
	}

	/** Final flush; waits for in-flight writes. */
	async dispose(): Promise<void> {
		this.closed = true;
		this.clearTimer();
		this.enqueueFlush();
		await this.chain;
	}

	/** Force a flush now (e.g. initial write) without closing. */
	async flushNow(): Promise<void> {
		this.clearTimer();
		this.enqueueFlush();
		await this.chain;
	}

	private clearTimer(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	private enqueueFlush(): void {
		this.chain = this.chain.then(async () => {
			this.lastFlushAt = Date.now();
			try {
				await writeTranscriptFile(this.path, this.getModel());
			} catch {
				// Transcript is best-effort steerability; durable truth remains jsonl + result md.
			}
		}, async () => {
			this.lastFlushAt = Date.now();
			try {
				await writeTranscriptFile(this.path, this.getModel());
			} catch {
				// ignore
			}
		});
	}
}
