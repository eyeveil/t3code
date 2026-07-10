/**
 * AutoFallbackCoordinator — continue a limit-killed turn on a sibling account.
 *
 * Invoked by `ProviderRuntimeIngestion` (the single choke point where every
 * provider runtime event is translated into orchestration state, and the only
 * altitude where the raw provider error detail is still attached) at the three
 * terminal-failure surfaces: `turn.completed(state=failed)`,
 * `session.state.changed(state=error)` and `runtime.error`.
 *
 * When the failure classifies as a usage/rate limit (see limitClassifier),
 * the coordinator:
 *   1. flags the failed instance in the in-memory cooldown tracker,
 *   2. picks the next same-driver instance (settings order) that is enabled,
 *      authenticated, opted in, not cooling down, not yet attempted this turn,
 *      and resolves the IDENTICAL model,
 *   3. re-routes the thread through the exact mechanism a user-driven
 *      mid-thread switch uses: stop the dead provider session
 *      (`thread.session.stop`), persist the new selection on the thread
 *      (`thread.meta.update` — what the model picker writes), then re-raise
 *      the turn intent for the already-persisted user message
 *      (`thread.turn.redispatch` → `thread.turn-start-requested`), so
 *      `ProviderCommandReactor.ensureSessionForThread` starts a fresh provider
 *      session on the target instance and re-sends the failed turn's input.
 *
 * The thread stays on the target instance afterwards (no ping-pong): the
 * selection is persisted on the thread itself, and a fallback instance that
 * limits out is itself subject to the same flow, hopping through the candidate
 * list with each instance attempted at most once per turn.
 *
 * Exactly-once redispatch: turn dispatches are tracked per thread from
 * `thread.turn-start-requested` domain events; each dispatch gets exactly one
 * failure-handling opportunity (`handledFailure`), so duplicate terminal
 * surfaces of the same death (e.g. `runtime.error` followed by
 * `turn.completed(failed)`) cannot double-redispatch.
 *
 * @module orchestration/autoFallback/AutoFallbackCoordinator
 */
import {
  CommandId,
  EventId,
  isProviderAvailable,
  type MessageId,
  type ModelSelection,
  type OrchestrationEvent,
  ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { deriveProviderInstanceConfigMap } from "../../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { AutoFallbackCooldownTracker } from "./CooldownTracker.ts";
import {
  describeFallbackRejections,
  selectFallbackCandidate,
  type FallbackCandidateInstance,
  type FallbackCandidateSnapshot,
} from "./candidates.ts";
import { isInstanceCoolingDown } from "./cooldown.ts";
import {
  classifyProviderLimitError,
  devForcedLimitClassification,
  type ProviderLimitClassification,
} from "./limitClassifier.ts";

type TurnStartRequestedDomainEvent = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>;

export interface ProviderTurnFailureInput {
  readonly threadId: ThreadId;
  /** Driver kind from the runtime event (`event.provider`). */
  readonly driver: string;
  /** Instance id from the runtime event when the emitter populated it. */
  readonly providerInstanceId?: string | undefined;
  /** Terminal error text (errorMessage / reason / runtime.error message). */
  readonly message?: string | undefined;
  /** Raw provider error detail when the surface carried one. */
  readonly detail?: unknown;
  readonly createdAt: string;
}

export interface AutoFallbackCoordinatorShape {
  /** Track a turn dispatch so its failure can be handled exactly once. */
  readonly noteTurnStartRequested: (event: TurnStartRequestedDomainEvent) => Effect.Effect<void>;
  /** Handle a terminal provider failure; no-op unless it is a limit error. */
  readonly onProviderTurnFailure: (input: ProviderTurnFailureInput) => Effect.Effect<void>;
}

export class AutoFallbackCoordinator extends Context.Service<
  AutoFallbackCoordinator,
  AutoFallbackCoordinatorShape
>()("t3/orchestration/autoFallback/AutoFallbackCoordinator") {}

interface TurnDispatchRecord {
  messageId: MessageId;
  modelSelection: ModelSelection | undefined;
  /**
   * The instance the message was last dispatched to (from the turn-start
   * payload's model selection). Failures reported for a different instance
   * are stale surfaces from an earlier hop and are ignored, so a straggler
   * error from the dead instance can never double-redispatch a turn that is
   * already running on the fallback instance.
   */
  targetInstanceId: string | undefined;
  /** Instances this turn has been dispatched to and that failed with a limit. */
  attempted: Set<string>;
  /** One failure-handling opportunity per dispatch. */
  handledFailure: boolean;
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerRegistry = yield* ProviderRegistry;
  const serverSettingsService = yield* ServerSettingsService;
  const cooldownTracker = yield* AutoFallbackCooldownTracker;

  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));

  const dispatchRecords = new Map<string, TurnDispatchRecord>();

  const noteTurnStartRequested: AutoFallbackCoordinatorShape["noteTurnStartRequested"] = (event) =>
    Effect.sync(() => {
      const threadKey = String(event.payload.threadId);
      const existing = dispatchRecords.get(threadKey);
      const targetInstanceId =
        event.payload.modelSelection !== undefined
          ? String(event.payload.modelSelection.instanceId)
          : undefined;
      if (existing !== undefined && existing.messageId === event.payload.messageId) {
        // Redispatch of the same user message (fallback hop): keep the
        // attempted set so each instance is tried at most once per turn.
        existing.modelSelection = event.payload.modelSelection ?? existing.modelSelection;
        existing.targetInstanceId = targetInstanceId ?? existing.targetInstanceId;
        existing.handledFailure = false;
        return;
      }
      dispatchRecords.set(threadKey, {
        messageId: event.payload.messageId,
        modelSelection: event.payload.modelSelection,
        targetInstanceId,
        attempted: new Set<string>(),
        handledFailure: false,
      });
    });

  const appendActivity = (input: {
    readonly threadId: ThreadId;
    readonly tone: "info" | "error";
    readonly kind: string;
    readonly summary: string;
    readonly payload: unknown;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("auto-fallback-activity"),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: eventId,
            tone: input.tone,
            kind: input.kind,
            summary: input.summary,
            payload: input.payload,
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const classify = (input: ProviderTurnFailureInput): ProviderLimitClassification | null => {
    // Dev-only escape hatch: force every terminal error to classify as a
    // usage limit so the full fallback path can be exercised without a real
    // limit event. Never honored in production builds.
    if (process.env.NODE_ENV !== "production") {
      const forced = devForcedLimitClassification(process.env.T3CODE_FORCE_LIMIT_FALLBACK);
      if (forced !== null) {
        return forced;
      }
    }
    return classifyProviderLimitError({
      driver: input.driver,
      message: input.message,
      detail: input.detail,
    });
  };

  const onProviderTurnFailure = Effect.fn("autoFallbackOnProviderTurnFailure")(function* (
    input: ProviderTurnFailureInput,
  ) {
    const classification = classify(input);
    if (classification === null) {
      return;
    }

    const thread = yield* projectionSnapshotQuery
      .getThreadDetailById(input.threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (!thread) {
      return;
    }

    const failedInstanceId =
      input.providerInstanceId ??
      thread.session?.providerInstanceId ??
      thread.modelSelection.instanceId;

    // Always record the cooldown — it powers the "recently limited" badge
    // even when auto-fallback itself is disabled.
    yield* cooldownTracker.recordLimitHit(String(failedInstanceId), {
      kind: classification.kind,
      resetAt: classification.resetAt,
    });
    // Nudge the registry so decorated snapshots (recentlyLimited) stream to
    // clients promptly. Best-effort; the badge also appears on next poll.
    yield* providerRegistry
      .refreshInstance(ProviderInstanceId.make(String(failedInstanceId)))
      .pipe(Effect.ignoreCause({ log: false }), Effect.forkDetach, Effect.asVoid);

    const settings = yield* serverSettingsService.getSettings;
    if (!settings.autoFallbackBetweenAccounts) {
      return;
    }

    const record = dispatchRecords.get(String(input.threadId));
    if (record === undefined || record.handledFailure) {
      return;
    }
    if (
      record.targetInstanceId !== undefined &&
      record.targetInstanceId !== String(failedInstanceId)
    ) {
      // Stale failure surface from a previous hop's instance — the turn is
      // already running elsewhere. Never redispatch on its account.
      return;
    }
    record.handledFailure = true;
    record.attempted.add(String(failedInstanceId));

    const requiredSelection = record.modelSelection ?? thread.modelSelection;
    const requiredModel = requiredSelection.model;

    const instanceMap = deriveProviderInstanceConfigMap(settings);
    const instances: FallbackCandidateInstance[] = Object.entries(instanceMap).map(
      ([instanceId, envelope]) => ({
        instanceId,
        driver: String(envelope.driver),
        participateInFallback: envelope.participateInFallback,
      }),
    );

    const providers = yield* providerRegistry.getProviders;
    const snapshots = new Map<string, FallbackCandidateSnapshot>(
      providers.map((provider) => [
        String(provider.instanceId),
        {
          instanceId: String(provider.instanceId),
          enabled: provider.enabled,
          available: isProviderAvailable(provider),
          authStatus: provider.auth.status,
          modelSlugs: provider.models.map((model) => model.slug),
        },
      ]),
    );

    const cooldowns = yield* cooldownTracker.snapshot;
    const now = Date.now();
    const { candidate, rejections } = selectFallbackCandidate({
      instances,
      snapshots,
      failedInstanceId: String(failedInstanceId),
      driver: input.driver,
      requiredModel,
      attemptedInstanceIds: record.attempted,
      isCoolingDown: (instanceId) => isInstanceCoolingDown(cooldowns, instanceId, now),
    });

    const displayNameFor = (instanceId: string): string => {
      const snapshotName = providers.find(
        (provider) => String(provider.instanceId) === instanceId,
      )?.displayName;
      const configName = instanceMap[ProviderInstanceId.make(instanceId)]?.displayName;
      return snapshotName ?? configName ?? instanceId;
    };
    const failedName = displayNameFor(String(failedInstanceId));

    if (candidate === null) {
      yield* appendActivity({
        threadId: input.threadId,
        tone: "error",
        kind: "provider.fallback.unavailable",
        summary: `Usage limit reached on ${failedName} — no eligible fallback instance (${describeFallbackRejections(rejections)}). Retry after the limit resets, or add another ${input.driver} account in Settings → Providers.`,
        payload: {
          fromInstanceId: String(failedInstanceId),
          driver: input.driver,
          limitKind: classification.kind,
          ...(classification.resetAt !== undefined ? { resetAt: classification.resetAt } : {}),
          rejections,
        },
        createdAt: input.createdAt,
      });
      return;
    }

    const targetInstanceId = ProviderInstanceId.make(candidate.instanceId);
    const targetName = displayNameFor(candidate.instanceId);
    const targetSelection: ModelSelection = {
      ...requiredSelection,
      instanceId: targetInstanceId,
    };

    yield* Effect.logInfo("auto-fallback rerouting thread after provider usage limit", {
      threadId: input.threadId,
      driver: input.driver,
      fromInstanceId: String(failedInstanceId),
      toInstanceId: candidate.instanceId,
      model: requiredModel,
      limitKind: classification.kind,
      resetAt: classification.resetAt,
    });

    // 1. Stop the dead provider session so the reactor takes the
    //    fresh-session path instead of reusing/resuming account-bound state.
    yield* orchestrationEngine.dispatch({
      type: "thread.session.stop",
      commandId: yield* serverCommandId("auto-fallback-session-stop"),
      threadId: input.threadId,
      createdAt: input.createdAt,
    });

    // 2. Persist the thread's selection on the target instance — the same
    //    write the model picker performs. The thread stays here afterwards.
    yield* orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId: yield* serverCommandId("auto-fallback-model-selection"),
      threadId: input.threadId,
      modelSelection: targetSelection,
    });

    // 3. Work-log entry — plain summary renders fine on old clients.
    yield* appendActivity({
      threadId: input.threadId,
      tone: "info",
      kind: "provider.fallback.switched",
      summary: `Usage limit on ${failedName} — continued on ${targetName}`,
      payload: {
        fromInstanceId: String(failedInstanceId),
        toInstanceId: candidate.instanceId,
        driver: input.driver,
        model: requiredModel,
        limitKind: classification.kind,
        ...(classification.resetAt !== undefined ? { resetAt: classification.resetAt } : {}),
      },
      createdAt: input.createdAt,
    });

    // 4. Re-raise the turn intent for the already-persisted user message —
    //    exactly once, on the target instance, with the identical model.
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.redispatch",
      commandId: yield* serverCommandId("auto-fallback-redispatch"),
      threadId: input.threadId,
      messageId: record.messageId,
      modelSelection: targetSelection,
      createdAt: input.createdAt,
    });
  });

  const onProviderTurnFailureSafely: AutoFallbackCoordinatorShape["onProviderTurnFailure"] = (
    input,
  ) =>
    onProviderTurnFailure(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning("auto-fallback failed to handle provider turn failure", {
          threadId: input.threadId,
          driver: input.driver,
          cause: Cause.pretty(cause),
        });
      }),
    );

  return {
    noteTurnStartRequested,
    onProviderTurnFailure: onProviderTurnFailureSafely,
  } satisfies AutoFallbackCoordinatorShape;
});

export const AutoFallbackCoordinatorLive = Layer.effect(AutoFallbackCoordinator, make);
