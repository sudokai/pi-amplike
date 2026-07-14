import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { limitRenderedLines, renderLines, SnapshotComponent } from "./render.js";
import type { ChildState, RunDetails } from "./types.js";

const stripPrompt = (child: ChildState): ChildState => ({ ...child, prompt: "", response: "", activities: [...(child.activities ?? [])], activeTools: [...(child.activeTools ?? [])] });
export const MAX_BACKGROUND_WIDGET_LINES = 10;
const details = (children: ChildState[]): RunDetails => ({
 schemaVersion: 3,
 runId: "session-background",
 runDir: "",
 cwd: "",
 createdAt: "",
 cap: 1,
 runtime: { provider: "", modelId: "", model: "", thinking: "off", activeTools: [], projectTrusted: true },
 children,
});

export interface BackgroundStampData {
 kind: "handoff" | "terminal";
 target: string;
 timestamp: number;
 child: ChildState;
 result?: string;
}

export function backgroundWidgetStateKey(children: ChildState[], expanded: boolean, width?: number): string {
 const stableChildren = children
  .filter((child) => ["queued", "starting", "running"].includes(child.status))
  .map(stripPrompt)
  .map((child) => ({ ...child, startedAt: undefined, endedAt: undefined }));
 const lines = [expanded ? "expanded" : "collapsed", ...renderLines(details(stableChildren), expanded, 0, width)];
 return JSON.stringify(width === undefined ? lines : limitRenderedLines(lines, MAX_BACKGROUND_WIDGET_LINES, "hidden"));
}

export class BackgroundWidgetComponent implements Component {
 private readonly renderedAt = Date.now();
 constructor(
  private readonly getChildren: () => ChildState[],
  private readonly theme: Theme,
  private readonly getExpanded: () => boolean = () => false,
  private readonly onLayout?: (width: number, expanded: boolean) => void,
 ) {}
 invalidate(): void {}
 render(width: number): string[] {
  const children = this.getChildren().filter((child) => ["queued", "starting", "running"].includes(child.status));
  if (children.length === 0) return [];
  const expanded = this.getExpanded();
  const max = Math.max(1, width);
  this.onLayout?.(max, expanded);
  const heading = truncateToWidth(this.theme.fg("dim", `background subagents · ctrl+shift+b manage${expanded ? " · expanded" : " · ctrl+o details"}`), max);
  const lines = [heading, ...new SnapshotComponent(details(children.map(stripPrompt)), expanded, undefined, this.renderedAt).render(max)];
  return limitRenderedLines(lines, MAX_BACKGROUND_WIDGET_LINES, "ctrl+shift+b manage")
   .map((line) => truncateToWidth(line, max));
 }
}

export class BackgroundStampComponent implements Component {
 private readonly renderedAt = Date.now();
 constructor(private readonly data: BackgroundStampData, private readonly expanded: boolean, private readonly theme: Theme) {}
 invalidate(): void {}
 render(width: number): string[] {
  const child = stripPrompt(this.data.child);
  const prefix = this.data.kind === "handoff" ? "background handoff" : "background terminal";
  const heading = truncateToWidth(this.theme.fg(this.data.kind === "handoff" ? "accent" : child.status === "failed" ? "error" : child.status === "warning" || child.status === "cancelled" ? "warning" : "success", `${prefix} · ${this.data.target}`), Math.max(1, width));
  const lines = [heading, ...new SnapshotComponent(details([child]), this.expanded, undefined, this.renderedAt).render(width)];
  if (this.expanded) {
   lines.push(truncateToWidth(this.theme.fg("dim", `artifact ${child.artifactPath}`), Math.max(1, width)));
   if (this.data.result) for (const line of this.data.result.split("\n")) lines.push(truncateToWidth(this.theme.fg("customMessageText", line), Math.max(1, width)));
  }
  return lines;
 }
}

export type ManagementGroup = "Active foreground" | "Active background" | "Terminal uncollected";
export type ManagementAction = "background" | "inspect" | "steer" | "cancel" | "set_delivery" | "collect";
export interface ManagementItem { group: ManagementGroup; child: ChildState }
export interface ManagementChoice { target: string; action: ManagementAction }

export function managementItems(status: { activeForeground: ChildState[]; activeBackground: ChildState[]; terminalUncollected: ChildState[] }): ManagementItem[] {
 return [
  ...status.activeForeground.map((child) => ({ group: "Active foreground" as const, child })),
  ...status.activeBackground.map((child) => ({ group: "Active background" as const, child })),
  ...status.terminalUncollected.map((child) => ({ group: "Terminal uncollected" as const, child })),
 ];
}

export function managementActions(item: ManagementItem): ManagementAction[] {
 if (item.group === "Active foreground") return ["background", "inspect", "cancel"];
 if (item.group === "Active background") return item.child.status === "running"
  ? ["inspect", "steer", "cancel", "set_delivery"]
  : ["inspect", "cancel", "set_delivery"];
 return item.child.followUpAcceptedAt === undefined ? ["inspect", "set_delivery", "collect"] : ["inspect", "collect"];
}

export class ManagementOverlay implements Component {
 private selected = 0;
 private readonly renderedAt = Date.now();
 constructor(
  private readonly items: ManagementItem[],
  private readonly theme: Theme,
  private readonly done: (choice: ManagementChoice | null) => void,
  private readonly requestRender: () => void = () => {},
 ) {}
 invalidate(): void {}
 handleInput(data: string): void {
  if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { this.done(null); return; }
  if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
  else if (matchesKey(data, Key.down)) this.selected = Math.min(Math.max(0, this.items.length - 1), this.selected + 1);
  else {
   const selected = this.items[this.selected];
   if (!selected) return;
   const shortcuts: Record<string, ManagementAction> = { b: "background", i: "inspect", s: "steer", c: "cancel", d: "set_delivery", l: "collect" };
   const action = matchesKey(data, Key.enter) ? "inspect" : shortcuts[data];
   if (action && managementActions(selected).includes(action)) { this.done({ target: selected.child.target!, action }); return; }
  }
  this.requestRender();
 }
 render(width: number): string[] {
  const max = Math.max(1, width), inner = Math.max(1, max - 2);
  const border = (text: string) => this.theme.fg("border", text);
  const row = (text: string) => {
   const fitted = truncateToWidth(text, inner);
   return `${border("│")}${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))}${border("│")}`;
  };
  const lines = [border(`╭${"─".repeat(inner)}╮`), row(` ${this.theme.fg("accent", this.theme.bold("Session subagents"))}`)];
  if (this.items.length === 0) lines.push(row(` ${this.theme.fg("dim", "No active children or uncollected results")}`));
  let previous: ManagementGroup | undefined;
  this.items.forEach((item, index) => {
   if (item.group !== previous) { lines.push(row(` ${this.theme.fg("muted", item.group)}`)); previous = item.group; }
   const selected = index === this.selected;
   const child = item.child;
   const delivery = child.ownership === "background" ? ` · ${child.deliveryPolicy ?? "auto"}` : "";
   const terminalMeta = item.group === "Terminal uncollected" ? ` · ${formatAge(child, this.renderedAt)} · ${child.artifactPath}` : "";
   const text = ` ${selected ? "›" : " "} ${child.label} · ${child.status}${delivery} · ${child.target}${terminalMeta}`;
   lines.push(row(selected ? this.theme.fg("accent", text) : text));
   if (selected) lines.push(row(`   ${this.theme.fg("dim", managementActions(item).join(" · "))}`));
  });
  lines.push(row(` ${this.theme.fg("dim", "↑↓ select · b/i/s/c/d/l action · esc close")}`), border(`╰${"─".repeat(inner)}╯`));
  return lines;
 }
}

function formatAge(child: ChildState, now: number): string {
 const elapsed = Math.max(0, now - (child.endedAt ?? child.startedAt ?? child.ownershipChangedAt ?? now));
 if (elapsed < 1_000) return "now";
 if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s ago`;
 if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
 return `${Math.floor(elapsed / 3_600_000)}h ago`;
}

/** Real-renderer helper used by generated visual and contract tests. */
export function renderBackgroundWidgetLines(children: ChildState[], width: number, theme: Theme, expanded = false): string[] {
 return new BackgroundWidgetComponent(() => children, theme, () => expanded).render(width);
}

/** Real-renderer helper for plain semantic snapshots. */
export function renderManagementLines(items: ManagementItem[], width: number, theme: Theme): string[] {
 return new ManagementOverlay(items, theme, () => {}).render(width);
}
