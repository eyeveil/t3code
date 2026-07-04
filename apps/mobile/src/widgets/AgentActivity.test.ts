import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@expo/ui/swift-ui", () => ({
  HStack: "HStack",
  Spacer: "Spacer",
  Text: "Text",
  VStack: "VStack",
}));

vi.mock("@expo/ui/swift-ui/modifiers", () => ({
  font: (value: unknown) => value,
  foregroundStyle: (value: unknown) => value,
  lineLimit: (value: unknown) => value,
  padding: (value: unknown) => value,
  widgetURL: (value: unknown) => ({ widgetURL: value }),
}));

vi.mock("expo-widgets", () => ({
  createLiveActivity: vi.fn((name: string, layout: unknown) => ({ layout, name })),
}));

import {
  AgentActivity,
  type AgentActivityProps,
  type AgentActivityRowProps,
} from "./AgentActivity";

function makeRow(overrides: Partial<AgentActivityRowProps>): AgentActivityRowProps {
  return {
    environmentId: "env-1",
    threadId: "thread-1",
    projectTitle: "Project",
    threadTitle: "Thread",
    modelTitle: "gpt-5.4",
    phase: "running",
    status: "Working",
    updatedAt: "2026-05-25T13:07:00.000Z",
    deepLink: "/threads/env-1/thread-1",
    ...overrides,
  };
}

const props = {
  title: "T3 Code",
  subtitle: "Agent work in progress",
  activeCount: 1,
  updatedAt: "2026-05-25T13:07:00.000Z",
  activities: [],
} satisfies AgentActivityProps;

const environment = {
  colorScheme: "dark",
  isLuminanceReduced: false,
} as const;

function expectedLocalTime(iso: string): string {
  const date = new Date(iso);
  const minutes = date.getMinutes();
  return `${date.getHours() % 12 || 12}:${minutes < 10 ? "0" : ""}${minutes}`;
}

describe("AgentActivity widget layout", () => {
  it("formats its updated-at label in device-local time", () => {
    expect(JSON.stringify(AgentActivity(props, environment as never))).toContain(
      `"children":["Updated ","${expectedLocalTime(props.updatedAt)}"]`,
    );
    expect(AgentActivity.toString()).not.toContain("formatAgentActivityUpdatedAtLabel");
  });

  it("uses now when the updated-at timestamp is malformed", () => {
    expect(
      JSON.stringify(AgentActivity({ ...props, updatedAt: "not-a-date" }, environment as never)),
    ).toContain('"children":["Updated ","now"]');
  });

  it("tints each row by its own phase", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 2,
        activities: [
          makeRow({}),
          makeRow({ threadId: "thread-2", phase: "waiting_for_approval", status: "Approval" }),
        ],
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner).toContain("#14b8a6");
    expect(banner).toContain("#f97316");
  });

  it("uses the attention tint for the compact presentations when a row needs input", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 2,
        activities: [
          makeRow({}),
          makeRow({ threadId: "thread-2", phase: "waiting_for_input", status: "Input" }),
        ],
      },
      environment as never,
    );
    expect(JSON.stringify(layout.compactLeading)).toContain("#f97316");
    expect(JSON.stringify(layout.compactTrailing)).toContain("Input");
    expect(JSON.stringify(layout.minimal)).toContain("#f97316");
  });

  it("deep links the banner to the row that needs attention", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 2,
        activities: [
          makeRow({}),
          makeRow({
            threadId: "thread-2",
            phase: "waiting_for_approval",
            status: "Approval",
            deepLink: "/threads/env-1/thread-2",
          }),
        ],
      },
      environment as never,
    );
    expect(JSON.stringify(layout.banner)).toContain(
      '"widgetURL":"t3code://threads/env-1/thread-2"',
    );
  });

  it("deep links the banner to the first row when nothing needs attention", () => {
    const layout = AgentActivity({ ...props, activities: [makeRow({})] }, environment as never);
    expect(JSON.stringify(layout.banner)).toContain(
      '"widgetURL":"t3code://threads/env-1/thread-1"',
    );
  });

  it("omits the deep link for unsafe paths and empty aggregates", () => {
    expect(JSON.stringify(AgentActivity(props, environment as never))).not.toContain("widgetURL");
    expect(
      JSON.stringify(
        AgentActivity(
          { ...props, activities: [makeRow({ deepLink: "//evil.example" })] },
          environment as never,
        ),
      ),
    ).not.toContain("widgetURL");
  });

  it("shows an overflow indicator when more activities are active than displayed", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 5,
        activities: [makeRow({}), makeRow({ threadId: "t2" }), makeRow({ threadId: "t3" })],
      },
      environment as never,
    );
    expect(JSON.stringify(layout.banner)).toContain("+2 more - Updated ");
  });
});
