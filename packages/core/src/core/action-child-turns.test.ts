import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  StreamAgentEvent,
  SubagentResultEvent,
  SubagentStartEvent,
} from "@rome-os/app-runtime";
import { ActionEngine } from "../actions/engine.js";
import { ActionRegistryImpl } from "../actions/registry.js";
import { callAction } from "../actions/call-action.js";
import { ActionCancelledError } from "../actions/action-errors.js";
import { emitAgentMessage } from "../actions/runtime-events.js";
import type { ActionResult } from "../actions/types.js";
import { SessionsRepository } from "../db/repositories/sessions.js";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { createTestDb, type TestDb, createActionEngineRepos } from "../test/helpers.js";
import { buildAction } from "../test/kit/index.js";
import { createEmptyLegacyArtifactBindings } from "../apps/artifact-id.js";
import { testChannelSurface } from "../test/channel-surface.js";
import { ActionChildTurns } from "./action-child-turns.js";
import { AgentLoader } from "./agent-loader.js";
import { createAgentLifecycleDispatcher } from "./agent-lifecycle.js";
import { createSessionFromRun, type ModelProvider, type ModelRunParams } from "./agent-runner.js";
import { createAgentSessionManager, type AgentSessionManager } from "./agent-session.js";
import { CapabilityDiscovery } from "./capability-discovery.js";
import { createModelResolver } from "./model-resolver.js";
import { PromptBuilder } from "./prompt-builder.js";
import { SessionManager } from "./session-manager.js";
import { SkillCatalog } from "./skill-catalog.js";

const AGENT = "main";
const CHILD_SESSION = { _romeSessionId: "action:exec-1:coding:coding", _type: "action" };

const sessionStarted = (turnId?: string) => ({
  type: "rome_session_started",
  agentName: "coding:coding",
  romeSession: CHILD_SESSION,
  ...(turnId ? { turnId } : {}),
});

describe("ActionChildTurns", () => {
  const record = () => {
    const published: Array<SubagentStartEvent | SubagentResultEvent> = [];
    const turns = new ActionChildTurns({ prompt: "fix it" }, (event) => published.push(event));
    const announce = (event: { type: string }, sourceExecutionId = "exec-1") =>
      turns.observer.onRuntimeEvent?.({ type: "action_event", event, sourceExecutionId });
    return { published, turns, announce };
  };

  it("pairs each announced Child turn with a result carrying the action's outcome", () => {
    const { published, turns, announce } = record();
    announce(sessionStarted("child-turn-1"));
    announce(sessionStarted("child-turn-1"));
    turns.settle({ status: "ok", data: { result: "done" } });

    expect(published).toEqual([
      {
        type: "subagent_start",
        toolUseId: "action:exec-1",
        agentName: "coding:coding",
        sessionId: "action:exec-1:coding:coding",
        turnId: "child-turn-1",
        input: { prompt: "fix it" },
        startedAt: expect.any(String),
      },
      {
        type: "subagent_result",
        toolUseId: "action:exec-1",
        agentName: "coding:coding",
        sessionId: "action:exec-1:coding:coding",
        turnId: "child-turn-1",
        status: "completed",
        output: { result: "done" },
        endedAt: expect.any(String),
      },
    ]);
  });

  it("reports a failed or cancelled run on the Child it started", () => {
    const failed = record();
    failed.announce(sessionStarted("t1"));
    failed.turns.settle({ status: "error", error: "boom" });
    expect(failed.published.at(-1)).toMatchObject({ status: "failed", error: { message: "boom" } });

    const cancelled = record();
    cancelled.announce(sessionStarted("t1"));
    cancelled.turns.settleThrown(new ActionCancelledError());
    expect(cancelled.published.at(-1)).toMatchObject({
      status: "cancelled",
      error: { message: "Action cancelled" },
    });
  });

  it("opens no link for an event that does not name the Child turn", () => {
    const { published, turns, announce } = record();
    announce(sessionStarted());
    announce({ type: "progress" });
    turns.settle({ status: "ok" });
    expect(published).toEqual([]);
  });
});

describe("agent-called action that summons a Child", () => {
  let directory: string;
  let testDb: TestDb;
  let manager: AgentSessionManager;
  let nextRun: (params: ModelRunParams) => AsyncIterable<StreamAgentEvent>;
  let summonResult: () => Promise<ActionResult>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "rome-action-child-turns-"));
    await writeFile(
      join(directory, `${AGENT}.yaml`),
      JSON.stringify({
        name: AGENT,
        description: "Action child turn fixture",
        provider: "anthropic",
        tier: "medium",
        systemPromptPrefix: "Complete the task.",
        tools: [],
        actions: ["coding_task"],
        permissionMode: "default",
      }),
    );
    const artifactIdentity = { legacyBindings: createEmptyLegacyArtifactBindings() };
    const loader = new AgentLoader(artifactIdentity);
    await loader.loadAll(directory);
    testDb = createTestDb();
    const sessionsRepo = new SessionsRepository(testDb.db);
    const provider: ModelProvider = {
      id: "anthropic",
      displayName: "anthropic",
      builtinTools: new Set<string>(),
      openSession: async (params) => createSessionFromRun("anthropic", (p) => nextRun(p), params),
    };
    const state = {
      codex: { loggedIn: false, quotaExhausted: false, solAccess: false, lunaAccess: false },
      claude: { loggedIn: true, quotaExhausted: false },
    };
    summonResult = async () => ({ status: "ok", data: { result: "child done" } });
    const actionRegistry = new ActionRegistryImpl();
    // Stands in for system:summon at its boundary with core: Child messages
    // go through emitAgentMessage and the Child session through an action event.
    actionRegistry.register({
      ...buildAction("summon"),
      execute: async (_args, context) => {
        context?.emitActionEvent(sessionStarted("child-turn-1"));
        emitAgentMessage({ type: "text", content: "child step", agent: "coding:coding" });
        return summonResult();
      },
    });
    // coding_task reaches summon through a nested call, as the coding app does.
    actionRegistry.register(
      buildAction("coding_task", {
        execute: async (args) => callAction("summon", { agentName: "coding", ...args }),
      }),
    );
    const promptBuilder = new PromptBuilder();
    rs.spyOn(promptBuilder, "build").mockReturnValue("Action child turn prompt");
    manager = createAgentSessionManager(
      {
        agentLoader: loader,
        sessionManager: new SessionManager(sessionsRepo, artifactIdentity),
        sessionsRepo,
        webchatRepo: new WebChatRepository(testDb.db),
        promptBuilder,
        actionRegistry,
        actionEngine: new ActionEngine(actionRegistry, createActionEngineRepos(testDb.db)),
        modelResolver: createModelResolver({
          providers: [provider],
          aiToolState: { get: () => state, refresh: async () => state },
        }),
        capabilityDiscovery: new CapabilityDiscovery(),
        skillCatalog: new SkillCatalog(artifactIdentity),
        lifecycleDispatcher: createAgentLifecycleDispatcher(),
        channelSurface: testChannelSurface,
      },
      { keepAliveAcrossTurns: true },
    );
    nextRun = async function* (params) {
      yield { type: "tool_use", id: "tu-1", tool: "coding_task", input: { prompt: "fix it" } };
      const output = await params.executeAction("coding_task", { prompt: "fix it" });
      yield { type: "tool_result", toolUseId: "tu-1", tool: "coding_task", output };
      yield { type: "result", content: "parent done" };
    };
  });

  afterEach(async () => {
    await manager.shutdown();
    testDb.close();
    await rm(directory, { recursive: true, force: true });
    rs.restoreAllMocks();
  });

  const runTurn = async (): Promise<StreamAgentEvent[]> => {
    const session = await manager.acquire({ agentName: AGENT, channelThreadKey: "webchat:child" });
    const events: StreamAgentEvent[] = [];
    for await (const event of session.sendTurn({ prompt: "go" }).events) events.push(event);
    return events;
  };

  it("links the Child on the parent turn while the action is still running", async () => {
    const events = await runTurn();
    const types = events.map((event) => event.type);
    const toolUse = types.indexOf("tool_use");
    const toolResult = types.indexOf("tool_result");

    expect(types.slice(toolUse + 1, toolResult)).toEqual(["subagent_start", "subagent_result"]);
    expect(events[toolUse + 1]).toMatchObject({
      type: "subagent_start",
      agent: `core:${AGENT}`,
      agentName: "coding:coding",
      sessionId: "action:exec-1:coding:coding",
      turnId: "child-turn-1",
      input: { prompt: "fix it" },
    });
    expect(events[toolUse + 2]).toMatchObject({
      type: "subagent_result",
      toolUseId: (events[toolUse + 1] as SubagentStartEvent).toolUseId,
      status: "completed",
      output: { result: "child done" },
    });
    // The Child's own messages stay on its turn stream, not the parent's.
    expect(events.some((event) => event.type === "text")).toBe(false);
  });

  it("closes the link as failed when the action fails", async () => {
    summonResult = async () => ({ status: "error", error: "child failed" });
    const events = await runTurn();

    expect(events.find((event) => event.type === "subagent_result")).toMatchObject({
      status: "failed",
      error: { message: "child failed" },
    });
  });
});
