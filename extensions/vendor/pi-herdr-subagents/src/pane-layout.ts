import type { RunningSubagent } from "./watcher.ts";

export interface SubagentPaneSplit {
  split: "right" | "down";
  splitFromPaneId?: string;
}

/**
 * Resolve herdr pane split topology for a new subagent launch.
 *
 * - First subagent: `right` split from the orchestrator (50/50 columns).
 * - Later subagents: `down` split from the most recently launched subagent pane.
 */
export function resolveSubagentPaneSplit(
  running: Iterable<RunningSubagent>,
): SubagentPaneSplit {
  const runningList = [...running];
  if (runningList.length === 0) {
    return { split: "right" };
  }

  const anchor = runningList.reduce((latest, agent) =>
    agent.startTime >= latest.startTime ? agent : latest,
  );
  return { split: "down", splitFromPaneId: anchor.paneId };
}

/** Merge pane split fields into an agent-start payload. */
export function applySubagentPaneSplit<
  T extends { split?: "right" | "down"; splitFromPaneId?: string },
>(agentStart: T, running: Iterable<RunningSubagent>): T {
  const { split, splitFromPaneId } = resolveSubagentPaneSplit(running);
  return { ...agentStart, split, splitFromPaneId };
}
