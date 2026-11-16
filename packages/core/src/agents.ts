import type { SessionSummary } from "./repository.js";

/**
 * The multi-agent view: what the sessions of several agents (Claude Code, Codex, anything run through `ard run`) add up to,
 * a filter by agent, and the link between a wrapper session and the hook sessions that ran inside it. Pure functions over
 * the session list the review UI already loads, so they are easy to test and the page only has to draw the result.
 */

export interface AgentSummary {
  agent: string;
  sessions: number;
  toolCalls: number;
  commands: number;
  fileChanges: number;
  approved: number;
  rejected: number;
  /** Sessions nobody has decided on yet. */
  notReviewed: number;
  /** Calls that were rejected by a reviewer, by policy or by timeout. */
  blocked: number;
  /** Approval requests waiting for a human right now. */
  waiting: number;
  lastEventAt: string;
}

/** One row per agent, the most recently active agent first. */
export function summarizeByAgent(sessions: SessionSummary[]): AgentSummary[] {
  const byAgent = new Map<string, AgentSummary>();
  for (const s of sessions) {
    let row = byAgent.get(s.agent);
    if (!row) {
      row = { agent: s.agent, sessions: 0, toolCalls: 0, commands: 0, fileChanges: 0, approved: 0, rejected: 0, notReviewed: 0, blocked: 0, waiting: 0, lastEventAt: s.lastEventAt };
      byAgent.set(s.agent, row);
    }
    row.sessions++;
    row.toolCalls += s.counts.toolCalls;
    row.commands += s.counts.commands;
    row.fileChanges += s.counts.fileChanges;
    if (s.review?.decision === "approved") row.approved++;
    else if (s.review?.decision === "rejected") row.rejected++;
    else row.notReviewed++;
    row.blocked += s.blocked;
    row.waiting += s.pendingApprovals;
    if (Date.parse(s.lastEventAt) > Date.parse(row.lastEventAt)) row.lastEventAt = s.lastEventAt;
  }
  return [...byAgent.values()].sort((a, b) => Date.parse(b.lastEventAt) - Date.parse(a.lastEventAt) || a.agent.localeCompare(b.agent));
}

/** The sessions of one agent, or all of them when `agent` is empty. An agent that does not exist gives an empty list, never an error. */
export function filterByAgent(sessions: SessionSummary[], agent: string | null | undefined): SessionSummary[] {
  return agent ? sessions.filter((s) => s.agent === agent) : sessions;
}

export interface LinkedSessions {
  /** The `ard run` session this one ran inside, when it is in the list. */
  wrapper: SessionSummary | null;
  /** Hook sessions (Claude Code, Codex) that ran inside this wrapper session. */
  hooks: SessionSummary[];
}

/**
 * `ard run -- codex` records the run from outside (files changed, via git), and the agent's hooks record from inside
 * (commands, tool calls). They are two sessions that the recorder links through `wrapperSessionId`; this finds the other side.
 */
export function linkedSessions(all: SessionSummary[], session: SessionSummary): LinkedSessions {
  const wrapper = session.wrapperSessionId && session.wrapperSessionId !== session.id ? (all.find((s) => s.id === session.wrapperSessionId) ?? null) : null;
  const hooks = all.filter((s) => s.id !== session.id && s.wrapperSessionId === session.id).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  return { wrapper, hooks };
}

export const hasLinks = (links: LinkedSessions): boolean => links.wrapper !== null || links.hooks.length > 0;
