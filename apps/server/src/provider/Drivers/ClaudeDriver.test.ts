import { assert, describe, it } from "@effect/vitest";
import type { ServerProvider } from "@t3tools/contracts";

import { resolveRetainedClaudeUsage } from "./ClaudeDriver.ts";

const usage = [
  {
    id: "five_hour",
    label: "5h",
    usedPercent: 32,
    resetsAt: "2030-03-17T17:46:40.000Z",
  },
] satisfies NonNullable<ServerProvider["usage"]>;

describe("resolveRetainedClaudeUsage", () => {
  it("retains the last successful probe for the same account", () => {
    const previous = {
      accountIdentity: "claude@example.com",
      usage,
    };

    assert.deepStrictEqual(resolveRetainedClaudeUsage(previous, "claude@example.com", undefined), {
      retained: previous,
      usage,
    });
  });

  it("does not leak retained usage across accounts", () => {
    assert.deepStrictEqual(
      resolveRetainedClaudeUsage(
        {
          accountIdentity: "first@example.com",
          usage,
        },
        "second@example.com",
        undefined,
      ),
      {
        retained: undefined,
        usage: undefined,
      },
    );
  });

  it("replaces retained usage after a successful probe", () => {
    const next = [
      {
        id: "seven_day",
        label: "Weekly",
        usedPercent: 18,
      },
    ] satisfies NonNullable<ServerProvider["usage"]>;

    assert.deepStrictEqual(resolveRetainedClaudeUsage(undefined, "claude@example.com", next), {
      retained: {
        accountIdentity: "claude@example.com",
        usage: next,
      },
      usage: next,
    });
  });
});
