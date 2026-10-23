// Links a Child turn that an agent-called action starts, such as summon's run,
// into the calling turn's stream. It reuses the subagent_start and
// subagent_result shape that execute_subagent publishes, so the chat shows the
// Child as a live subagent chip that opens its trace.

import type { ActionEvent, SubagentResultEvent, SubagentStartEvent } from "@rome-os/app-runtime";
import { ActionCancelledError } from "../actions/action-errors.js";
import type { ActionRunObserver } from "../actions/runtime-events.js";
import type { ActionResult } from "../actions/types.js";

/** The action event that announces a Child turn. summon publishes it as
 * `SummonSessionStartedEvent`. Only an event that names both the session and
 * the turn opens a link. */
const CHILD_SESSION_STARTED = "rome_session_started";

interface ChildTurnRef {
  agentName: string;
  sessionId: string;
  turnId: string;
}

function childTurnRef(event: ActionEvent): ChildTurnRef | undefined {
  if (event.type !== CHILD_SESSION_STARTED) return undefined;
  const { agentName, romeSession, turnId } = event as {
    agentName?: unknown;
    romeSession?: { _romeSessionId?: unknown };
    turnId?: unknown;
  };
  const sessionId = romeSession?._romeSessionId;
  if (typeof agentName !== "string" || typeof sessionId !== "string") return undefined;
  if (typeof turnId !== "string" || turnId.length === 0) return undefined;
  return { agentName, sessionId, turnId };
}

/**
 * Tracks the Child turns started during one agent-called action run.
 *
 * Pass `observer` to that run. Each announced Child turn publishes one
 * `subagent_start` right away. Call `settle` or `settleThrown` exactly once
 * when the run ends. Each started Child then gets one `subagent_result`
 * carrying the run's outcome, before the caller hands the result back to the
 * provider.
 */
export class ActionChildTurns {
  private readonly started = new Map<string, SubagentStartEvent>();
  private settled = false;

  readonly observer: ActionRunObserver = {
    onRuntimeEvent: (event) => {
      if (event.type !== "action_event" || this.settled) return;
      const ref = childTurnRef(event.event);
      if (!ref) return;
      // The provider's tool_use id is not visible here. One action execution
      // announces at most one Child, so its execution id keys the link.
      const toolUseId = `action:${event.sourceExecutionId}`;
      if (this.started.has(toolUseId)) return;
      const start: SubagentStartEvent = {
        type: "subagent_start",
        toolUseId,
        ...ref,
        input: this.input,
        startedAt: new Date().toISOString(),
      };
      this.started.set(toolUseId, start);
      this.publish(start);
    },
  };

  constructor(
    private readonly input: unknown,
    private readonly publish: (event: SubagentStartEvent | SubagentResultEvent) => void,
  ) {}

  settle(result: ActionResult): void {
    if (result.status === "error") {
      this.finish({ status: "failed", error: { message: result.error } });
    } else {
      this.finish({ status: "completed", output: result.status === "ok" ? result.data : result });
    }
  }

  settleThrown(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.finish({
      status: err instanceof ActionCancelledError ? "cancelled" : "failed",
      error: { message },
    });
  }

  private finish(
    outcome:
      | { status: "completed"; output: unknown }
      | { status: "failed" | "cancelled"; error: { message: string } },
  ): void {
    if (this.settled) return;
    this.settled = true;
    const endedAt = new Date().toISOString();
    for (const start of this.started.values()) {
      const common = {
        type: "subagent_result" as const,
        toolUseId: start.toolUseId,
        agentName: start.agentName,
        sessionId: start.sessionId,
        turnId: start.turnId,
        endedAt,
      };
      this.publish(
        outcome.status === "completed"
          ? { ...common, status: "completed", output: outcome.output }
          : { ...common, status: outcome.status, error: outcome.error },
      );
    }
  }
}
