import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationEvent,
  OrchestrationThread as OrchestrationThreadSchema,
  type OrchestrationThread,
  ProviderInstanceId,
  ServerProvider,
  ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  AutoFallbackCoordinator,
  AutoFallbackCoordinatorLive,
  type AutoFallbackCoordinatorShape,
} from "./AutoFallbackCoordinator.ts";
import { AutoFallbackCooldownTracker, AutoFallbackCooldownTrackerLive } from "./CooldownTracker.ts";

const now = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-1");
const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeThread = Schema.decodeUnknownSync(OrchestrationThreadSchema);

const codexUsageLimitDetail = {
  error: {
    message: "You've hit your usage limit.",
    codexErrorInfo: "usageLimitExceeded",
    additionalDetails: null,
  },
  threadId: "provider-thread",
  turnId: "1",
  willRetry: false,
};

function makeThread(modelSelection: ModelSelection): OrchestrationThread {
  return decodeThread({
    id: threadId,
    projectId: "project-1",
    title: "Thread",
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: {
      threadId,
      status: "error",
      providerName: "codex",
      providerInstanceId: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: "You've hit your usage limit.",
      updatedAt: now,
    },
  });
}

function makeProviderSnapshot(input: {
  readonly instanceId: string;
  readonly driver?: string;
  readonly enabled?: boolean;
  readonly authStatus?: "authenticated" | "unauthenticated" | "unknown";
  readonly models?: ReadonlyArray<string>;
}): ServerProvider {
  return decodeProvider({
    instanceId: input.instanceId,
    driver: input.driver ?? "codex",
    enabled: input.enabled ?? true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: input.authStatus ?? "authenticated" },
    checkedAt: now,
    models: (input.models ?? ["gpt-5-codex", "gpt-5.5"]).map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
    })),
  });
}

let eventCounter = 0;
function turnStartEvent(input?: {
  readonly modelSelection?: ModelSelection;
  readonly messageId?: string;
}): Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }> {
  eventCounter += 1;
  return {
    sequence: eventCounter,
    eventId: EventId.make(`evt-turn-start-${eventCounter}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.turn-start-requested",
    occurredAt: now,
    commandId: CommandId.make(`cmd-turn-start-${eventCounter}`),
    causationEventId: null,
    correlationId: CommandId.make(`cmd-turn-start-${eventCounter}`),
    metadata: {},
    payload: {
      threadId,
      messageId: MessageId.make(input?.messageId ?? "message-1"),
      ...(input?.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: now,
    },
  } as Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>;
}

const codexSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
  options: [{ id: "reasoningEffort", value: "high" }],
} as ModelSelection;

const selectionOn = (instanceId: string): ModelSelection =>
  ({ ...codexSelection, instanceId: ProviderInstanceId.make(instanceId) }) as ModelSelection;

interface HarnessOptions {
  readonly autoFallbackBetweenAccounts?: boolean;
  readonly providerInstances?: Record<string, unknown>;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly threadSelection?: ModelSelection;
}

function makeHarness(options?: HarnessOptions) {
  const dispatched: OrchestrationCommand[] = [];
  const settings = decodeSettings({
    autoFallbackBetweenAccounts: options?.autoFallbackBetweenAccounts ?? true,
    providerInstances: options?.providerInstances ?? {
      codex: { driver: "codex", config: {} },
      "codex-2": { driver: "codex", config: { homePath: "/homes/codex-2" } },
    },
  });
  const providers = options?.providers ?? [
    makeProviderSnapshot({ instanceId: "codex" }),
    makeProviderSnapshot({ instanceId: "codex-2" }),
  ];
  const thread = makeThread(options?.threadSelection ?? codexSelection);

  const layer = AutoFallbackCoordinatorLive.pipe(
    Layer.provideMerge(AutoFallbackCooldownTrackerLive),
    Layer.provideMerge(
      Layer.mock(OrchestrationEngineService)({
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadDetailById: () => Effect.succeed(Option.some(thread)),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ProviderRegistry)({
        getProviders: Effect.succeed(providers),
        refreshInstance: () => Effect.succeed(providers),
      }),
    ),
    Layer.provideMerge(ServerSettingsService.layerTest(settings)),
    Layer.provideMerge(NodeServices.layer),
  );

  return { layer, dispatched };
}

const failWithUsageLimit = (coordinator: AutoFallbackCoordinatorShape, instanceId = "codex") =>
  coordinator.onProviderTurnFailure({
    threadId,
    driver: "codex",
    providerInstanceId: instanceId,
    message: "You've hit your usage limit.",
    detail: codexUsageLimitDetail,
    createdAt: now,
  });

describe("AutoFallbackCoordinator", () => {
  it.effect("re-routes a limit-killed turn to the sibling instance exactly once", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const coordinator = yield* AutoFallbackCoordinator;
      yield* coordinator.noteTurnStartRequested(turnStartEvent({ modelSelection: codexSelection }));

      yield* failWithUsageLimit(coordinator);

      const types = harness.dispatched.map((command) => command.type);
      expect(types).toEqual([
        "thread.session.stop",
        "thread.meta.update",
        "thread.activity.append",
        "thread.turn.redispatch",
      ]);

      const metaUpdate = harness.dispatched.find(
        (command) => command.type === "thread.meta.update",
      );
      expect(metaUpdate?.type === "thread.meta.update" && metaUpdate.modelSelection).toEqual({
        instanceId: "codex-2",
        model: "gpt-5-codex",
        options: [{ id: "reasoningEffort", value: "high" }],
      });

      const redispatch = harness.dispatched.find(
        (command) => command.type === "thread.turn.redispatch",
      );
      if (redispatch?.type !== "thread.turn.redispatch") {
        throw new Error("expected a redispatch command");
      }
      expect(redispatch.messageId).toBe("message-1");
      expect(redispatch.modelSelection?.instanceId).toBe("codex-2");
      expect(redispatch.modelSelection?.model).toBe("gpt-5-codex");

      const activity = harness.dispatched.find(
        (command) => command.type === "thread.activity.append",
      );
      if (activity?.type !== "thread.activity.append") {
        throw new Error("expected an activity command");
      }
      expect(activity.activity.kind).toBe("provider.fallback.switched");
      expect(activity.activity.tone).toBe("info");
      expect(activity.activity.summary).toContain("Usage limit on codex");
      expect(activity.activity.summary).toContain("continued on codex-2");

      // Duplicate terminal surfaces of the same death must not double-dispatch.
      yield* failWithUsageLimit(coordinator);
      expect(harness.dispatched).toHaveLength(4);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("ignores non-limit failures entirely", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const coordinator = yield* AutoFallbackCoordinator;
      const tracker = yield* AutoFallbackCooldownTracker;
      yield* coordinator.noteTurnStartRequested(turnStartEvent({ modelSelection: codexSelection }));

      yield* coordinator.onProviderTurnFailure({
        threadId,
        driver: "codex",
        providerInstanceId: "codex",
        message: "Internal server error",
        detail: { error: { message: "Internal server error", codexErrorInfo: "other" } },
        createdAt: now,
      });
      expect(harness.dispatched).toHaveLength(0);
      expect(yield* tracker.isCoolingDown("codex")).toBe(false);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("appends a work-log hint when no eligible candidate exists", () => {
    const harness = makeHarness({
      providers: [
        makeProviderSnapshot({ instanceId: "codex" }),
        makeProviderSnapshot({ instanceId: "codex-2", authStatus: "unauthenticated" }),
      ],
    });
    return Effect.gen(function* () {
      const coordinator = yield* AutoFallbackCoordinator;
      yield* coordinator.noteTurnStartRequested(turnStartEvent({ modelSelection: codexSelection }));

      yield* failWithUsageLimit(coordinator);

      expect(harness.dispatched).toHaveLength(1);
      const activity = harness.dispatched[0]!;
      if (activity.type !== "thread.activity.append") {
        throw new Error("expected an activity command");
      }
      expect(activity.activity.kind).toBe("provider.fallback.unavailable");
      expect(activity.activity.summary).toContain("no eligible fallback instance");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("refuses fallback when the sibling cannot resolve the identical model", () => {
    const customSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "my-custom-model",
    } as ModelSelection;
    const harness = makeHarness({
      threadSelection: customSelection,
      providers: [
        makeProviderSnapshot({ instanceId: "codex", models: ["my-custom-model"] }),
        makeProviderSnapshot({ instanceId: "codex-2", models: ["gpt-5-codex"] }),
      ],
    });
    return Effect.gen(function* () {
      const coordinator = yield* AutoFallbackCoordinator;
      yield* coordinator.noteTurnStartRequested(
        turnStartEvent({ modelSelection: customSelection }),
      );

      yield* failWithUsageLimit(coordinator);

      const types = harness.dispatched.map((command) => command.type);
      expect(types).toEqual(["thread.activity.append"]);
      const activity = harness.dispatched[0]!;
      if (activity.type !== "thread.activity.append") {
        throw new Error("expected an activity command");
      }
      expect(activity.activity.kind).toBe("provider.fallback.unavailable");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("records the cooldown but does not redispatch when the global toggle is off", () => {
    const harness = makeHarness({ autoFallbackBetweenAccounts: false });
    return Effect.gen(function* () {
      const coordinator = yield* AutoFallbackCoordinator;
      const tracker = yield* AutoFallbackCooldownTracker;
      yield* coordinator.noteTurnStartRequested(turnStartEvent({ modelSelection: codexSelection }));

      yield* failWithUsageLimit(coordinator);

      expect(harness.dispatched).toHaveLength(0);
      expect(yield* tracker.isCoolingDown("codex")).toBe(true);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("skips siblings that opted out via participateInFallback", () => {
    const harness = makeHarness({
      providerInstances: {
        codex: { driver: "codex", config: {} },
        "codex-2": { driver: "codex", participateInFallback: false, config: {} },
      },
    });
    return Effect.gen(function* () {
      const coordinator = yield* AutoFallbackCoordinator;
      yield* coordinator.noteTurnStartRequested(turnStartEvent({ modelSelection: codexSelection }));

      yield* failWithUsageLimit(coordinator);

      const types = harness.dispatched.map((command) => command.type);
      expect(types).toEqual(["thread.activity.append"]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("hops through the candidate list, each instance at most once per turn", () => {
    const harness = makeHarness({
      providerInstances: {
        codex: { driver: "codex", config: {} },
        "codex-2": { driver: "codex", config: {} },
        "codex-3": { driver: "codex", config: {} },
      },
      providers: [
        makeProviderSnapshot({ instanceId: "codex" }),
        makeProviderSnapshot({ instanceId: "codex-2" }),
        makeProviderSnapshot({ instanceId: "codex-3" }),
      ],
    });
    return Effect.gen(function* () {
      const coordinator = yield* AutoFallbackCoordinator;

      // Hop 1: codex → codex-2.
      yield* coordinator.noteTurnStartRequested(turnStartEvent({ modelSelection: codexSelection }));
      yield* failWithUsageLimit(coordinator, "codex");
      let redispatches = harness.dispatched.filter(
        (command) => command.type === "thread.turn.redispatch",
      );
      expect(redispatches).toHaveLength(1);

      // The redispatch's own turn-start-requested (same message) re-arms the record.
      yield* coordinator.noteTurnStartRequested(
        turnStartEvent({ modelSelection: selectionOn("codex-2") }),
      );

      // Hop 2: codex-2 → codex-3 (codex is cooling down and already attempted).
      yield* failWithUsageLimit(coordinator, "codex-2");
      redispatches = harness.dispatched.filter(
        (command) => command.type === "thread.turn.redispatch",
      );
      expect(redispatches).toHaveLength(2);
      const secondHop = redispatches[1]!;
      if (secondHop.type !== "thread.turn.redispatch") {
        throw new Error("expected a redispatch command");
      }
      expect(secondHop.modelSelection?.instanceId).toBe("codex-3");
      expect(secondHop.messageId).toBe("message-1");

      // Hop 3: everything attempted → hint activity, no further redispatch.
      yield* coordinator.noteTurnStartRequested(
        turnStartEvent({ modelSelection: selectionOn("codex-3") }),
      );
      yield* failWithUsageLimit(coordinator, "codex-3");
      redispatches = harness.dispatched.filter(
        (command) => command.type === "thread.turn.redispatch",
      );
      expect(redispatches).toHaveLength(2);
      const lastCommand = harness.dispatched[harness.dispatched.length - 1]!;
      expect(lastCommand.type).toBe("thread.activity.append");
      if (lastCommand.type === "thread.activity.append") {
        expect(lastCommand.activity.kind).toBe("provider.fallback.unavailable");
      }
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("ignores stale failure surfaces from an instance the turn is no longer on", () => {
    const harness = makeHarness({
      providerInstances: {
        codex: { driver: "codex", config: {} },
        "codex-2": { driver: "codex", config: {} },
        "codex-3": { driver: "codex", config: {} },
      },
      providers: [
        makeProviderSnapshot({ instanceId: "codex" }),
        makeProviderSnapshot({ instanceId: "codex-2" }),
        makeProviderSnapshot({ instanceId: "codex-3" }),
      ],
    });
    return Effect.gen(function* () {
      const coordinator = yield* AutoFallbackCoordinator;
      yield* coordinator.noteTurnStartRequested(turnStartEvent({ modelSelection: codexSelection }));
      yield* failWithUsageLimit(coordinator, "codex");
      // The redispatch's turn-start re-arms the record onto codex-2 …
      yield* coordinator.noteTurnStartRequested(
        turnStartEvent({ modelSelection: selectionOn("codex-2") }),
      );
      const dispatchCount = harness.dispatched.length;
      // … so a straggler error from the dead codex session must be ignored.
      yield* failWithUsageLimit(coordinator, "codex");
      expect(harness.dispatched).toHaveLength(dispatchCount);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("does nothing when no turn dispatch was tracked for the thread", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const coordinator = yield* AutoFallbackCoordinator;
      const tracker = yield* AutoFallbackCooldownTracker;
      yield* failWithUsageLimit(coordinator);
      expect(harness.dispatched).toHaveLength(0);
      // The cooldown badge state is still recorded.
      expect(yield* tracker.isCoolingDown("codex")).toBe(true);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("treats any terminal error as a limit when the dev force flag is set", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const coordinator = yield* AutoFallbackCoordinator;
      yield* coordinator.noteTurnStartRequested(turnStartEvent({ modelSelection: codexSelection }));

      process.env.T3CODE_FORCE_LIMIT_FALLBACK = "1";
      yield* coordinator
        .onProviderTurnFailure({
          threadId,
          driver: "codex",
          providerInstanceId: "codex",
          message: "Some unrelated failure",
          createdAt: now,
        })
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              delete process.env.T3CODE_FORCE_LIMIT_FALLBACK;
            }),
          ),
        );
      const types = harness.dispatched.map((command) => command.type);
      expect(types).toContain("thread.turn.redispatch");
    }).pipe(Effect.provide(harness.layer));
  });
});
