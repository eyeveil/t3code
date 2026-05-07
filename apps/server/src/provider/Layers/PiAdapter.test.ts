import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { mapPiDisplayMessageEndEvent } from "./PiAdapter.ts";

describe("mapPiDisplayMessageEndEvent", () => {
  const context = {
    threadId: ThreadId.make("thread-1"),
    providerInstanceId: ProviderInstanceId.make("pi"),
    activeTurnId: TurnId.make("turn-1"),
  };

  it("projects display custom messages from extension commands into assistant output", () => {
    const events = mapPiDisplayMessageEndEvent(context, {
      type: "message_end",
      message: {
        role: "custom",
        customType: "oc",
        content: "Generated output from /oc",
        display: true,
        timestamp: Date.now(),
      },
    } as Extract<AgentSessionEvent, { readonly type: "message_end" }>);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("item.completed");
    if (events[0]?.type !== "item.completed") {
      throw new Error("expected item.completed");
    }
    expect(events[0].turnId).toBe("turn-1");
    expect(events[0].payload.itemType).toBe("assistant_message");
    expect(events[0].payload.detail).toBe("Generated output from /oc");
  });

  it("ignores hidden custom messages", () => {
    const events = mapPiDisplayMessageEndEvent(context, {
      type: "message_end",
      message: {
        role: "custom",
        customType: "context",
        content: "Hidden context",
        display: false,
        timestamp: Date.now(),
      },
    } as Extract<AgentSessionEvent, { readonly type: "message_end" }>);

    expect(events).toEqual([]);
  });
});
