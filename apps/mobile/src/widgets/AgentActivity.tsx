import { HStack, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import { font, foregroundStyle, lineLimit, padding, widgetURL } from "@expo/ui/swift-ui/modifiers";
import {
  createLiveActivity,
  type LiveActivityComponent,
  type LiveActivityLayout,
} from "expo-widgets";

type LiveActivityEnvironment = Parameters<LiveActivityComponent<AgentActivityProps>>[1];

export type AgentActivityPhase =
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "stale";

export interface AgentActivityRowProps {
  readonly environmentId: string;
  readonly threadId: string;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly modelTitle: string;
  readonly phase: AgentActivityPhase;
  readonly status: string;
  readonly updatedAt: string;
  readonly deepLink: string;
}

export interface AgentActivityProps {
  readonly title: string;
  readonly subtitle: string;
  readonly activeCount: number;
  readonly updatedAt: string;
  readonly activities: ReadonlyArray<AgentActivityRowProps>;
}

// This function is serialized into the widget extension's JS bundle, so it
// must stay self-contained: no references to module-scope helpers, only the
// imported view/modifier factories.
export function AgentActivity(
  props: AgentActivityProps,
  environment: LiveActivityEnvironment,
): LiveActivityLayout {
  "widget";

  const isLight = environment.colorScheme === "light";
  const primaryForeground = isLight ? "#262626" : "#f5f5f5";
  const secondaryForeground = isLight ? "#525252" : "#a3a3a3";
  const mutedForeground = isLight ? "#737373" : "#8e8e93";

  const phaseTint = (phase: AgentActivityPhase | undefined): string => {
    if (environment.isLuminanceReduced) {
      return secondaryForeground;
    }
    if (phase === "waiting_for_approval" || phase === "waiting_for_input") {
      return "#f97316";
    }
    if (phase === "failed") {
      return "#ef4444";
    }
    return "#14b8a6";
  };

  const row0 = props.activities[0];
  const row1 = props.activities[1];
  const row2 = props.activities[2];
  const attentionRow = props.activities.find(
    (row) => row.phase === "waiting_for_approval" || row.phase === "waiting_for_input",
  );
  const failedRow = props.activities.find((row) => row.phase === "failed");
  const tint = phaseTint((attentionRow ?? failedRow ?? row0)?.phase);

  // Any registered scheme variant routes back to this app; taps are delivered
  // to the widget's containing app, so the prod scheme is safe for all builds.
  const deepLinkRow = attentionRow ?? row0;
  const deepLink =
    deepLinkRow && deepLinkRow.deepLink.startsWith("/") && !deepLinkRow.deepLink.startsWith("//")
      ? `t3code://${deepLinkRow.deepLink.slice(1)}`
      : null;

  const updatedDate = new Date(props.updatedAt);
  const updatedMinutes = updatedDate.getMinutes();
  const updatedAt = Number.isNaN(updatedDate.getTime())
    ? "now"
    : `${updatedDate.getHours() % 12 || 12}:${updatedMinutes < 10 ? "0" : ""}${updatedMinutes}`;
  const activeLabel = `${props.activeCount} active`;
  const overflowCount = props.activeCount - Math.min(props.activities.length, 3);

  const renderRow = (row: AgentActivityRowProps) => (
    <HStack modifiers={[padding({ vertical: 4 })]}>
      <VStack>
        <Text
          modifiers={[
            font({ weight: "bold", size: 13 }),
            foregroundStyle(primaryForeground),
            lineLimit(1),
          ]}
        >
          {row.threadTitle}
        </Text>
        <Text modifiers={[font({ size: 11 }), foregroundStyle(secondaryForeground), lineLimit(1)]}>
          {row.projectTitle} - {row.modelTitle}
        </Text>
      </VStack>
      <Spacer minLength={8} />
      <Text
        modifiers={[font({ weight: "semibold", size: 11 }), foregroundStyle(phaseTint(row.phase))]}
      >
        {row.status}
      </Text>
    </HStack>
  );

  return {
    banner: (
      <VStack
        modifiers={deepLink ? [padding({ all: 14 }), widgetURL(deepLink)] : [padding({ all: 14 })]}
      >
        <HStack>
          <VStack>
            <Text
              modifiers={[font({ weight: "bold", size: 15 }), foregroundStyle(primaryForeground)]}
            >
              {props.title}
            </Text>
            <Text
              modifiers={[font({ size: 12 }), foregroundStyle(secondaryForeground), lineLimit(1)]}
            >
              {props.subtitle}
            </Text>
          </VStack>
          <Spacer minLength={8} />
          <Text modifiers={[font({ weight: "semibold", size: 12 }), foregroundStyle(tint)]}>
            {activeLabel}
          </Text>
        </HStack>
        {row0 ? renderRow(row0) : null}
        {row1 ? renderRow(row1) : null}
        {row2 ? renderRow(row2) : null}
        <Text modifiers={[font({ size: 11 }), foregroundStyle(mutedForeground)]}>
          {overflowCount > 0 ? `+${overflowCount} more - Updated ` : "Updated "}
          {updatedAt}
        </Text>
      </VStack>
    ),
    bannerSmall: (
      <VStack modifiers={[padding({ all: 12 })]}>
        <HStack>
          <Text
            modifiers={[font({ weight: "bold", size: 13 }), foregroundStyle(primaryForeground)]}
          >
            {props.title}
          </Text>
          <Spacer minLength={6} />
          <Text modifiers={[font({ weight: "semibold", size: 12 }), foregroundStyle(tint)]}>
            {activeLabel}
          </Text>
        </HStack>
        {row0 ? (
          <VStack>
            <Text
              modifiers={[
                font({ weight: "bold", size: 12 }),
                foregroundStyle(primaryForeground),
                lineLimit(1),
              ]}
            >
              {row0.threadTitle}
            </Text>
            <Text
              modifiers={[font({ size: 11 }), foregroundStyle(secondaryForeground), lineLimit(1)]}
            >
              {row0.projectTitle} - {row0.status}
            </Text>
          </VStack>
        ) : null}
      </VStack>
    ),
    compactLeading: (
      <Text modifiers={[font({ weight: "bold", size: 11 }), foregroundStyle(tint)]}>T3</Text>
    ),
    compactTrailing: (
      <Text modifiers={[font({ weight: "semibold", size: 11 }), foregroundStyle(tint)]}>
        {attentionRow
          ? attentionRow.phase === "waiting_for_approval"
            ? "Approval"
            : "Input"
          : activeLabel}
      </Text>
    ),
    minimal: (
      <Text modifiers={[font({ weight: "bold", size: 11 }), foregroundStyle(tint)]}>T3</Text>
    ),
    expandedLeading: (
      <VStack modifiers={[padding({ all: 8 })]}>
        <Text modifiers={[font({ weight: "bold", size: 12 }), foregroundStyle(tint)]}>
          {activeLabel}
        </Text>
      </VStack>
    ),
    expandedCenter: row0 ? (
      <VStack>
        <Text
          modifiers={[
            font({ weight: "bold", size: 12 }),
            foregroundStyle(primaryForeground),
            lineLimit(1),
          ]}
        >
          {row0.threadTitle}
        </Text>
        <Text modifiers={[font({ size: 11 }), foregroundStyle(secondaryForeground), lineLimit(1)]}>
          {row0.projectTitle} - {row0.status}
        </Text>
      </VStack>
    ) : null,
    expandedTrailing: (
      <Text modifiers={[font({ size: 11 }), foregroundStyle(secondaryForeground)]}>
        Updated {updatedAt}
      </Text>
    ),
    expandedBottom: (
      <VStack modifiers={[padding({ all: 8 })]}>
        {row0 ? renderRow(row0) : null}
        {row1 ? renderRow(row1) : null}
        {row2 ? renderRow(row2) : null}
      </VStack>
    ),
  };
}

export default createLiveActivity<AgentActivityProps>("AgentActivity", AgentActivity);
