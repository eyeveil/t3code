import { ThreadId, type OrchestrationCheckpointSummary } from "@t3tools/contracts";
import { useLocalSearchParams, useRouter } from "expo-router";
import Stack from "expo-router/stack";
import { SymbolView } from "expo-symbols";
import { memo, type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  InteractionManager,
  type ListRenderItemInfo,
  Pressable,
  ScrollView,
  Text as NativeText,
  type ViewToken,
  useColorScheme,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../../components/AppText";
import { cn } from "../../../lib/cn";
import { useThemeColor } from "../../../lib/useThemeColor";
import { getEnvironmentClient } from "../../../state/use-remote-environment-registry";
import { useSelectedThreadDetail } from "../../../state/use-thread-detail";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useThreadDraftForThread } from "../use-thread-composer-state";
import {
  getCachedReviewParsedDiff,
  setReviewGitSections,
  setReviewSelectedSectionId,
  setReviewTurnDiff,
  updateReviewExpandedFileIds,
  updateReviewRevealedLargeFileIds,
  useReviewCacheForThread,
} from "./reviewState";
import {
  buildReviewListItems,
  getReadyReviewCheckpoints,
  buildReviewSectionItems,
  getDefaultReviewSectionId,
  getReviewFilePreviewState,
  getReviewSectionIdForCheckpoint,
  type ReviewListItem,
  type ReviewParsedDiff,
  type ReviewRenderableFile,
  type ReviewRenderableLineRow,
} from "./reviewModel";
import {
  clearReviewHighlightFileCache,
  getCachedHighlightedReviewFile,
  highlightReviewFile,
  type ReviewDiffTheme,
  type ReviewHighlightedFile,
  type ReviewHighlightedToken,
} from "./shikiReviewHighlighter";
import {
  buildReviewCommentTarget,
  clearReviewCommentTarget,
  countReviewCommentContexts,
  formatReviewSelectedRangeLabel,
  getReviewUnifiedLineNumber,
  setReviewCommentTarget,
  type ReviewCommentTarget,
  useReviewCommentTarget,
} from "./reviewCommentSelection";
import {
  changeTone,
  DiffTokenText,
  REVIEW_MONO_FONT_FAMILY,
  ReviewChangeBar,
} from "./reviewDiffRendering";

interface PendingCommentSelection {
  readonly sectionTitle: string;
  readonly filePath: string;
  readonly lines: ReadonlyArray<ReviewRenderableLineRow>;
  readonly anchorIndex: number;
}

interface ReviewLineActionInput {
  readonly sectionTitle: string;
  readonly filePath: string;
  readonly lines: ReadonlyArray<ReviewRenderableLineRow>;
  readonly lineIndex: number;
}

const IOS_NAV_BAR_HEIGHT = 44;
const REVIEW_HEADER_SPACING = 0;
const REVIEW_LINE_GUTTER_WIDTH = 62;
const REVIEW_CHARACTER_WIDTH_ESTIMATE = 8.4;
const REVIEW_MAX_CONTENT_WIDTH = 4_800;
const REVIEW_INITIAL_HIGHLIGHT_FILE_COUNT = 2;
const REVIEW_HIGHLIGHT_BACKTRACK_COUNT = 0;
const REVIEW_HIGHLIGHT_LOOKAHEAD_COUNT = 1;
const loggedMissingReviewTokenKeys = new Set<string>();

function isReviewDiffDebugLoggingEnabled(): boolean {
  return typeof __DEV__ !== "undefined" ? __DEV__ : false;
}

function logReviewDiffDiagnostic(message: string, details?: Record<string, unknown>): void {
  if (!isReviewDiffDebugLoggingEnabled()) {
    return;
  }

  if (details) {
    console.log(`[review-sheet] ${message}`, details);
    return;
  }

  console.log(`[review-sheet] ${message}`);
}

function getFileHeaderChrome(changeType: ReviewRenderableFile["changeType"]): {
  readonly rail: string;
  readonly dot: string;
} {
  switch (changeType) {
    case "new":
      return {
        rail: "bg-emerald-400",
        dot: "bg-emerald-400",
      };
    case "deleted":
      return {
        rail: "bg-rose-400",
        dot: "bg-rose-400",
      };
    case "rename-pure":
      return {
        rail: "bg-amber-400",
        dot: "bg-amber-400",
      };
    case "rename-changed":
      return {
        rail: "bg-sky-400",
        dot: "bg-sky-400",
      };
    default:
      return {
        rail: "bg-sky-400",
        dot: "bg-sky-400",
      };
  }
}

function formatHeaderDiffSummary(parsedDiff: ReviewParsedDiff): {
  readonly additions: string | null;
  readonly deletions: string | null;
} {
  if (parsedDiff.kind !== "files") {
    return { additions: null, deletions: null };
  }

  return {
    additions: `+${parsedDiff.additions}`,
    deletions: `-${parsedDiff.deletions}`,
  };
}

function computeReviewListContentWidth(
  items: ReadonlyArray<ReviewListItem>,
  viewportWidth: number,
): number {
  let maxTextLength = 0;

  items.forEach((item) => {
    switch (item.kind) {
      case "file-header":
        maxTextLength = Math.max(
          maxTextLength,
          item.file.path.length,
          item.file.previousPath?.length ?? 0,
        );
        break;
      case "file-suppressed":
        maxTextLength = Math.max(maxTextLength, item.message.length, item.actionLabel?.length ?? 0);
        break;
      case "hunk":
        maxTextLength = Math.max(
          maxTextLength,
          item.row.header.length + (item.row.context ? item.row.context.length + 1 : 0),
        );
        break;
      case "line":
        maxTextLength = Math.max(maxTextLength, item.row.content.length);
        break;
    }
  });

  return Math.max(
    viewportWidth,
    Math.min(
      REVIEW_MAX_CONTENT_WIDTH,
      Math.ceil(REVIEW_LINE_GUTTER_WIDTH + 48 + maxTextLength * REVIEW_CHARACTER_WIDTH_ESTIMATE),
    ),
  );
}

function getDefaultExpandedFileIds(
  files: ReadonlyArray<ReviewRenderableFile>,
): ReadonlyArray<string> {
  return files.map((file) => file.id);
}

function getHighlightedTokensForLine(
  line: ReviewRenderableLineRow,
  highlightedFile: ReviewHighlightedFile | null,
): ReadonlyArray<ReviewHighlightedToken> | null {
  if (!highlightedFile) {
    return null;
  }

  if (line.additionTokenIndex !== null) {
    return highlightedFile.additionLines[line.additionTokenIndex] ?? null;
  }

  if (line.deletionTokenIndex !== null) {
    return highlightedFile.deletionLines[line.deletionTokenIndex] ?? null;
  }

  return null;
}

const ReviewLineRow = memo(function ReviewLineRow(props: {
  readonly line: ReviewRenderableLineRow;
  readonly tokens: ReadonlyArray<ReviewHighlightedToken> | null;
  readonly viewportWidth: number;
  readonly selectionState: "anchor" | "selected" | null;
  readonly onComment: () => void;
  readonly onStartRangeSelection: () => void;
}) {
  const lineNumber = getReviewUnifiedLineNumber(props.line);

  return (
    <Pressable
      className={cn(
        "flex-row items-start",
        changeTone(props.line.change),
        props.selectionState === "anchor" && "bg-sky-500/16",
        props.selectionState === "selected" && "bg-amber-300/28",
      )}
      accessibilityRole="button"
      accessibilityLabel={
        lineNumber !== null
          ? props.selectionState === "anchor"
            ? `Range starts on line ${lineNumber}`
            : `Add comment on line ${lineNumber}`
          : "Add comment on line"
      }
      delayLongPress={220}
      onLongPress={props.onStartRangeSelection}
      onPress={props.onComment}
      style={{ minWidth: props.viewportWidth }}
    >
      <ReviewChangeBar change={props.line.change} />
      <Text
        className="w-9 py-1 pr-1 text-right text-[11px] font-t3-medium text-foreground-muted"
        style={{ fontFamily: REVIEW_MONO_FONT_FAMILY }}
      >
        {lineNumber ?? ""}
      </Text>
      <View className="min-w-0 flex-1 flex-shrink-0 px-1 py-1">
        <DiffTokenText
          tokens={props.tokens}
          fallback={props.line.content}
          change={props.line.change}
        />
      </View>
    </Pressable>
  );
});

const ReviewFileCard = memo(function ReviewFileCard(props: {
  readonly file: ReviewRenderableFile;
  readonly fileId: string;
  readonly expanded: boolean;
  readonly viewportWidth: number;
  readonly onToggleFile: (fileId: string) => void;
}) {
  const chrome = getFileHeaderChrome(props.file.changeType);

  return (
    <View
      className="border-b border-border/70 bg-card"
      style={{
        zIndex: 1,
        width: props.viewportWidth,
        shadowColor: "#000000",
        shadowOpacity: 0.08,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: 6 },
        elevation: 4,
      }}
    >
      <Pressable className="flex-row items-center" onPress={() => props.onToggleFile(props.fileId)}>
        <View className={cn("w-1 self-stretch", chrome.rail)} />
        <View className="flex-1 flex-row items-center px-3 py-1.5">
          <View className="size-7 items-center justify-center rounded-full bg-subtle">
            <SymbolView
              name={props.expanded ? "chevron.down" : "chevron.right"}
              size={12}
              tintColor="#8a8a8a"
              type="monochrome"
            />
          </View>
          <View className="ml-2 min-w-0 flex-1 flex-row items-center gap-2">
            <View className={cn("size-2 rounded-full", chrome.dot)} />
            <View className="min-w-0 flex-1">
              <Text className="font-mono text-[13px] leading-[18px] text-foreground">
                {props.file.path}
              </Text>
              {props.file.previousPath && props.file.previousPath !== props.file.path ? (
                <Text className="font-mono text-[10px] leading-[14px] text-foreground-muted">
                  {props.file.previousPath}
                </Text>
              ) : null}
            </View>
          </View>
          <View className="ml-3 flex-row items-center justify-end gap-2">
            <Text className="font-mono text-[12px] font-t3-bold text-emerald-600 dark:text-emerald-300">
              +{props.file.additions}
            </Text>
            <Text className="font-mono text-[12px] font-t3-bold text-rose-600 dark:text-rose-300">
              -{props.file.deletions}
            </Text>
          </View>
        </View>
      </Pressable>
    </View>
  );
});

const ReviewFileSuppressedBody = memo(function ReviewFileSuppressedBody(props: {
  readonly message: string;
  readonly actionLabel?: string | null;
  readonly fileId: string;
  readonly viewportWidth: number;
  readonly onLoadDiffFile?: (fileId: string) => void;
}) {
  return (
    <View
      className="gap-2 border-b border-border bg-card px-4 py-3"
      style={{ minWidth: props.viewportWidth }}
    >
      <Text className="text-[12px] leading-[18px] text-foreground-muted">{props.message}</Text>
      {props.actionLabel && props.onLoadDiffFile ? (
        <Pressable
          className="self-start rounded-full bg-subtle px-3 py-2"
          onPress={() => props.onLoadDiffFile?.(props.fileId)}
        >
          <Text className="text-[12px] font-t3-bold text-foreground">{props.actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
});

const ReviewHunkRow = memo(function ReviewHunkRow(props: {
  readonly header: string;
  readonly context: string | null;
  readonly viewportWidth: number;
}) {
  return (
    <View
      className="border-b border-border/60 bg-sky-500/10 px-2 py-2"
      style={{ minWidth: props.viewportWidth }}
    >
      <Text className="font-mono text-[12px] leading-[18px] text-sky-700 dark:text-sky-300">
        {props.header}
        {props.context ? ` ${props.context}` : ""}
      </Text>
    </View>
  );
});

const ReviewNotice = memo(function ReviewNotice(props: { readonly notice: string }) {
  return (
    <View className="border-b border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-900/60 dark:bg-amber-950/40">
      <Text className="text-[12px] font-t3-bold uppercase text-amber-700 dark:text-amber-300">
        Partial diff
      </Text>
      <Text className="text-[12px] leading-[18px] text-amber-800 dark:text-amber-200">
        {props.notice}
      </Text>
    </View>
  );
});

function ReviewSelectionActionBar(props: {
  readonly target: ReviewCommentTarget | null;
  readonly bottomInset: number;
  readonly onOpenComment: () => void;
  readonly onClear: () => void;
}) {
  if (!props.target || props.target.startIndex === props.target.endIndex) {
    return null;
  }

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: 18,
        right: 18,
        bottom: Math.max(props.bottomInset, 10) + 18,
        flexDirection: "row",
        justifyContent: "center",
        gap: 10,
      }}
    >
      <Pressable
        className="min-h-[48px] flex-1 flex-row items-center justify-center gap-2 rounded-full bg-blue-600 px-5"
        onPress={props.onOpenComment}
      >
        <SymbolView name="text.bubble" size={16} tintColor="#ffffff" type="monochrome" />
        <Text className="text-[15px] font-t3-bold text-white">
          Comment on {formatReviewSelectedRangeLabel(props.target)}
        </Text>
      </Pressable>

      <Pressable
        className="h-12 w-12 items-center justify-center rounded-full bg-blue-600"
        onPress={props.onClear}
      >
        <SymbolView name="xmark" size={16} tintColor="#ffffff" type="monochrome" />
      </Pressable>
    </View>
  );
}

export function ReviewSheet() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const colorScheme = useColorScheme();
  const headerForeground = String(useThemeColor("--color-foreground"));
  const headerMuted = String(useThemeColor("--color-foreground-muted"));
  const headerIcon = String(useThemeColor("--color-icon"));
  const { environmentId, threadId } = useLocalSearchParams<{
    environmentId: string;
    threadId: string;
  }>();
  const { draftMessage } = useThreadDraftForThread({ environmentId, threadId });
  const reviewCache = useReviewCacheForThread({ environmentId, threadId });
  const { selectedThreadProject } = useThreadSelection();
  const selectedThread = useSelectedThreadDetail();
  const [loadingTurnIds, setLoadingTurnIds] = useState<Record<string, boolean>>({});
  const [loadingGitDiffs, setLoadingGitDiffs] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingCommentSelection, setPendingCommentSelection] =
    useState<PendingCommentSelection | null>(null);
  const [highlightedFilesById, setHighlightedFilesById] = useState<
    Record<string, ReviewHighlightedFile | null>
  >({});
  const [visibleFileIds, setVisibleFileIds] = useState<ReadonlyArray<string>>([]);
  const activeCommentTarget = useReviewCommentTarget();
  const selectedTheme = (colorScheme === "dark" ? "dark" : "light") satisfies ReviewDiffTheme;
  const highlightQueueRef = useRef<string[]>([]);
  const highlightRequestedFileIdsRef = useRef<Set<string>>(new Set());
  const highlightQueueGenerationRef = useRef(0);
  const highlightQueueActiveRef = useRef(false);
  const highlightableFilesByIdRef = useRef<ReadonlyMap<string, ReviewRenderableFile>>(new Map());
  const selectedThemeRef = useRef<ReviewDiffTheme>(selectedTheme);

  const cwd = selectedThread?.worktreePath ?? selectedThreadProject?.workspaceRoot ?? null;
  const readyCheckpoints = useMemo(
    () => getReadyReviewCheckpoints(selectedThread?.checkpoints ?? []),
    [selectedThread?.checkpoints],
  );

  const checkpointBySectionId = useMemo(() => {
    return Object.fromEntries(
      readyCheckpoints.map((checkpoint) => [
        getReviewSectionIdForCheckpoint(checkpoint),
        checkpoint,
      ]),
    ) as Record<string, OrchestrationCheckpointSummary>;
  }, [readyCheckpoints]);

  const reviewSections = useMemo(
    () =>
      buildReviewSectionItems({
        checkpoints: readyCheckpoints,
        gitSections: reviewCache.gitSections,
        turnDiffById: reviewCache.turnDiffById,
        loadingTurnIds,
      }),
    [loadingTurnIds, readyCheckpoints, reviewCache.gitSections, reviewCache.turnDiffById],
  );

  const selectedSection =
    reviewSections.find((section) => section.id === reviewCache.selectedSectionId) ??
    reviewSections[0] ??
    null;
  const topContentInset = insets.top + IOS_NAV_BAR_HEIGHT;
  const parsedDiff = useMemo(
    () =>
      getCachedReviewParsedDiff({
        threadKey: reviewCache.threadKey,
        sectionId: selectedSection?.id ?? null,
        diff: selectedSection?.diff,
      }),
    [reviewCache.threadKey, selectedSection?.diff, selectedSection?.id],
  );
  const headerDiffSummary = useMemo(() => formatHeaderDiffSummary(parsedDiff), [parsedDiff]);
  const pendingReviewCommentCount = useMemo(
    () => countReviewCommentContexts(draftMessage),
    [draftMessage],
  );

  const expandedFileIds = useMemo(
    () =>
      selectedSection?.id && parsedDiff.kind === "files"
        ? (reviewCache.expandedFileIdsBySection[selectedSection.id] ??
          getDefaultExpandedFileIds(parsedDiff.files))
        : [],
    [parsedDiff, reviewCache.expandedFileIdsBySection, selectedSection?.id],
  );
  const revealedLargeFileIds = useMemo(
    () =>
      selectedSection?.id
        ? (reviewCache.revealedLargeFileIdsBySection[selectedSection.id] ?? [])
        : [],
    [reviewCache.revealedLargeFileIdsBySection, selectedSection?.id],
  );
  const reviewListItems = useMemo(
    () =>
      selectedSection && parsedDiff.kind === "files"
        ? buildReviewListItems({
            files: parsedDiff.files,
            expandedFileIds,
            revealedLargeFileIds,
          })
        : [],
    [expandedFileIds, parsedDiff, revealedLargeFileIds, selectedSection],
  );
  const reviewFileById = useMemo(() => {
    if (parsedDiff.kind !== "files") {
      return new Map<string, ReviewRenderableFile>();
    }

    return new Map(parsedDiff.files.map((file) => [file.id, file] as const));
  }, [parsedDiff]);
  const reviewLineRowsByFileId = useMemo(() => {
    if (parsedDiff.kind !== "files") {
      return new Map<string, ReadonlyArray<ReviewRenderableLineRow>>();
    }

    return new Map(
      parsedDiff.files.map((file) => [
        file.id,
        file.rows.filter((row): row is ReviewRenderableLineRow => row.kind === "line"),
      ]),
    );
  }, [parsedDiff]);
  const reviewLineIndexByRowId = useMemo(() => {
    const map = new Map<string, number>();

    reviewLineRowsByFileId.forEach((rows) => {
      rows.forEach((row, index) => {
        map.set(row.id, index);
      });
    });

    return map;
  }, [reviewLineRowsByFileId]);
  const highlightableFiles = useMemo(() => {
    if (parsedDiff.kind !== "files") {
      return [] as ReadonlyArray<ReviewRenderableFile>;
    }

    const expandedFileIdSet = new Set(expandedFileIds);
    const revealedLargeFileIdSet = new Set(revealedLargeFileIds);

    return parsedDiff.files.filter((file) => {
      if (!expandedFileIdSet.has(file.id)) {
        return false;
      }

      const previewState = getReviewFilePreviewState(file);
      return (
        previewState.kind === "render" ||
        (previewState.reason === "large" && revealedLargeFileIdSet.has(file.id))
      );
    });
  }, [expandedFileIds, parsedDiff, revealedLargeFileIds]);
  const highlightableFileIds = useMemo(
    () => new Set(highlightableFiles.map((file) => file.id)),
    [highlightableFiles],
  );
  const priorityHighlightFileIds = useMemo(() => {
    if (parsedDiff.kind !== "files" || highlightableFiles.length === 0) {
      return [] as ReadonlyArray<string>;
    }

    const fileIdsInPriorityOrder =
      visibleFileIds.length > 0
        ? visibleFileIds.filter((fileId) => highlightableFileIds.has(fileId))
        : parsedDiff.files
            .slice(0, REVIEW_INITIAL_HIGHLIGHT_FILE_COUNT)
            .map((file) => file.id)
            .filter((fileId) => highlightableFileIds.has(fileId));

    if (fileIdsInPriorityOrder.length === 0) {
      return [] as ReadonlyArray<string>;
    }

    const firstVisibleIndex = parsedDiff.files.findIndex(
      (file) => file.id === fileIdsInPriorityOrder[0],
    );
    const lastVisibleIndex = parsedDiff.files.findIndex(
      (file) => file.id === fileIdsInPriorityOrder[fileIdsInPriorityOrder.length - 1],
    );

    if (firstVisibleIndex < 0 || lastVisibleIndex < 0) {
      return fileIdsInPriorityOrder;
    }

    const startIndex = Math.max(0, firstVisibleIndex - REVIEW_HIGHLIGHT_BACKTRACK_COUNT);
    const endIndex = Math.min(
      parsedDiff.files.length - 1,
      lastVisibleIndex + REVIEW_HIGHLIGHT_LOOKAHEAD_COUNT,
    );

    const queuedIds: string[] = [];
    for (let index = startIndex; index <= endIndex; index += 1) {
      const fileId = parsedDiff.files[index]?.id;
      if (fileId && highlightableFileIds.has(fileId)) {
        queuedIds.push(fileId);
      }
    }

    return queuedIds;
  }, [highlightableFileIds, highlightableFiles.length, parsedDiff, visibleFileIds]);
  const viewportWidth = Math.max(width, 280);
  const reviewListContentWidth = useMemo(
    () => computeReviewListContentWidth(reviewListItems, viewportWidth),
    [reviewListItems, viewportWidth],
  );
  const loadGitDiffs = useCallback(async () => {
    if (!environmentId || !cwd) {
      return;
    }

    const client = getEnvironmentClient(environmentId);
    if (!client) {
      setError("Remote connection is not ready.");
      return;
    }

    setLoadingGitDiffs(true);
    setError(null);
    try {
      const result = await client.git.getReviewDiffs({ cwd });
      if (reviewCache.threadKey) {
        setReviewGitSections(reviewCache.threadKey, result.sections);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load review diffs.");
    } finally {
      setLoadingGitDiffs(false);
    }
  }, [cwd, environmentId, reviewCache.threadKey]);

  const loadTurnDiff = useCallback(
    async (checkpoint: OrchestrationCheckpointSummary, force = false) => {
      if (!environmentId || !threadId) {
        return;
      }

      const sectionId = getReviewSectionIdForCheckpoint(checkpoint);
      if (reviewCache.threadKey) {
        setReviewSelectedSectionId(reviewCache.threadKey, sectionId);
      }

      if (!force && reviewCache.turnDiffById[sectionId] !== undefined) {
        return;
      }

      const client = getEnvironmentClient(environmentId);
      if (!client) {
        setError("Remote connection is not ready.");
        return;
      }

      setLoadingTurnIds((current) => ({ ...current, [sectionId]: true }));
      setError(null);
      try {
        const result = await client.orchestration.getTurnDiff({
          threadId: ThreadId.make(threadId),
          fromTurnCount: Math.max(0, checkpoint.checkpointTurnCount - 1),
          toTurnCount: checkpoint.checkpointTurnCount,
        });
        if (reviewCache.threadKey) {
          setReviewTurnDiff(reviewCache.threadKey, sectionId, result.diff);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Failed to load turn diff.");
      } finally {
        setLoadingTurnIds((current) => {
          const next = { ...current };
          delete next[sectionId];
          return next;
        });
      }
    },
    [environmentId, reviewCache.threadKey, reviewCache.turnDiffById, threadId],
  );

  useEffect(() => {
    void loadGitDiffs();
  }, [loadGitDiffs]);

  useEffect(() => {
    selectedThemeRef.current = selectedTheme;
  }, [selectedTheme]);

  useEffect(() => {
    highlightableFilesByIdRef.current = new Map(highlightableFiles.map((file) => [file.id, file]));
  }, [highlightableFiles]);

  const startHighlightQueueRunner = useCallback(function startHighlightQueueRunner() {
    if (highlightQueueActiveRef.current) {
      return;
    }

    const generation = highlightQueueGenerationRef.current;
    highlightQueueActiveRef.current = true;

    void (async () => {
      try {
        while (generation === highlightQueueGenerationRef.current) {
          const nextFileId = highlightQueueRef.current.shift();
          if (!nextFileId) {
            break;
          }

          const file = highlightableFilesByIdRef.current.get(nextFileId);
          if (!file) {
            continue;
          }

          const theme = selectedThemeRef.current;
          const cached = getCachedHighlightedReviewFile(file, theme);
          if (cached) {
            logReviewDiffDiagnostic("using cached highlighted file", {
              fileId: file.id,
              filePath: file.path,
              theme,
            });
            setHighlightedFilesById((current) =>
              current[file.id] === cached ? current : { ...current, [file.id]: cached },
            );
            continue;
          }

          logReviewDiffDiagnostic("requesting highlighted file", {
            fileId: file.id,
            filePath: file.path,
            theme,
          });

          try {
            await new Promise<void>((resolve) => {
              InteractionManager.runAfterInteractions(() => resolve());
            });
            const result = await highlightReviewFile(file, theme);
            if (generation !== highlightQueueGenerationRef.current) {
              logReviewDiffDiagnostic("discarding highlighted file after cancellation", {
                fileId: file.id,
                filePath: file.path,
              });
              return;
            }

            logReviewDiffDiagnostic("received highlighted file", {
              fileId: file.id,
              filePath: file.path,
              additionLines: result.additionLines.length,
              deletionLines: result.deletionLines.length,
            });
            setHighlightedFilesById((current) => {
              if (current[file.id] === result) {
                return current;
              }
              return { ...current, [file.id]: result };
            });
          } catch (error) {
            logReviewDiffDiagnostic("highlight request failed", {
              fileId: file.id,
              filePath: file.path,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } finally {
        highlightQueueActiveRef.current = false;
        if (
          generation === highlightQueueGenerationRef.current &&
          highlightQueueRef.current.length > 0
        ) {
          startHighlightQueueRunner();
        }
      }
    })();
  }, []);

  useEffect(() => {
    if (reviewSections.length === 0) {
      return;
    }

    const fallbackId = getDefaultReviewSectionId(reviewSections);
    if (
      reviewCache.threadKey &&
      (!reviewCache.selectedSectionId ||
        !reviewSections.some((section) => section.id === reviewCache.selectedSectionId))
    ) {
      setReviewSelectedSectionId(reviewCache.threadKey, fallbackId);
    }
  }, [reviewCache.selectedSectionId, reviewCache.threadKey, reviewSections]);

  useEffect(() => {
    const latest = readyCheckpoints[0];
    if (!latest) {
      return;
    }

    const latestId = getReviewSectionIdForCheckpoint(latest);
    if (reviewCache.turnDiffById[latestId] !== undefined || loadingTurnIds[latestId]) {
      return;
    }

    void loadTurnDiff(latest);
  }, [loadTurnDiff, loadingTurnIds, readyCheckpoints, reviewCache.turnDiffById]);

  useEffect(() => {
    if (!selectedSection || selectedSection.kind !== "turn" || selectedSection.diff !== null) {
      return;
    }

    const checkpoint = checkpointBySectionId[selectedSection.id];
    if (checkpoint && !loadingTurnIds[selectedSection.id]) {
      void loadTurnDiff(checkpoint);
    }
  }, [checkpointBySectionId, loadTurnDiff, loadingTurnIds, selectedSection]);

  useEffect(() => {
    if (!reviewCache.threadKey || !selectedSection?.id || parsedDiff.kind !== "files") {
      return;
    }

    updateReviewExpandedFileIds(reviewCache.threadKey, selectedSection.id, (existing) => {
      if (existing !== undefined) {
        const validIds = existing.filter((id) => parsedDiff.files.some((file) => file.id === id));
        if (validIds.length === existing.length) {
          return existing;
        }
        return validIds;
      }

      return getDefaultExpandedFileIds(parsedDiff.files);
    });
  }, [parsedDiff, reviewCache.threadKey, selectedSection?.id]);

  useEffect(() => {
    if (!reviewCache.threadKey || !selectedSection?.id || parsedDiff.kind !== "files") {
      return;
    }

    updateReviewRevealedLargeFileIds(reviewCache.threadKey, selectedSection.id, (existing) => {
      if (existing === undefined) {
        return undefined;
      }

      const validIds = existing.filter((id) => parsedDiff.files.some((file) => file.id === id));
      if (validIds.length === existing.length) {
        return existing;
      }

      return validIds;
    });
  }, [parsedDiff, reviewCache.threadKey, selectedSection?.id]);

  useEffect(() => {
    setHighlightedFilesById({});
    setVisibleFileIds([]);
    highlightQueueGenerationRef.current += 1;
    highlightQueueRef.current = [];
    highlightRequestedFileIdsRef.current = new Set();
    highlightQueueActiveRef.current = false;
    clearReviewHighlightFileCache();
    loggedMissingReviewTokenKeys.clear();
    logReviewDiffDiagnostic("reset highlighted files", {
      selectedSectionId: selectedSection?.id ?? null,
      selectedTheme,
    });
  }, [selectedSection?.id, selectedTheme]);

  useEffect(() => {
    if (parsedDiff.kind !== "files") {
      return;
    }

    logReviewDiffDiagnostic("parsed diff files", {
      selectedSectionId: selectedSection?.id ?? null,
      fileCount: parsedDiff.fileCount,
      renderableFileCount: parsedDiff.files.length,
    });
  }, [parsedDiff, selectedSection?.id]);

  useEffect(() => {
    if (priorityHighlightFileIds.length === 0) {
      logReviewDiffDiagnostic("no highlightable files", {
        selectedSectionId: selectedSection?.id ?? null,
        parsedDiffKind: parsedDiff.kind,
        requestedFileCount: 0,
      });
      return;
    }

    const queuedFileIds: string[] = [];
    priorityHighlightFileIds.forEach((fileId) => {
      if (highlightRequestedFileIdsRef.current.has(fileId)) {
        return;
      }

      const file = highlightableFilesByIdRef.current.get(fileId);
      if (!file) {
        return;
      }

      highlightRequestedFileIdsRef.current.add(fileId);
      highlightQueueRef.current.push(fileId);
      queuedFileIds.push(fileId);
    });

    if (queuedFileIds.length === 0) {
      return;
    }

    logReviewDiffDiagnostic("scheduling file highlights", {
      selectedSectionId: selectedSection?.id ?? null,
      fileCount: queuedFileIds.length,
      fileIds: queuedFileIds,
    });
    startHighlightQueueRunner();
  }, [parsedDiff.kind, priorityHighlightFileIds, selectedSection?.id, startHighlightQueueRunner]);

  const refreshSelectedSection = useCallback(async () => {
    if (!selectedSection) {
      return;
    }

    if (selectedSection.kind === "turn") {
      const checkpoint = checkpointBySectionId[selectedSection.id];
      if (checkpoint) {
        await loadTurnDiff(checkpoint, true);
      }
      return;
    }

    await loadGitDiffs();
  }, [checkpointBySectionId, loadGitDiffs, loadTurnDiff, selectedSection]);

  const handleToggleExpandedFile = useCallback(
    (fileId: string) => {
      if (!reviewCache.threadKey || !selectedSection?.id || parsedDiff.kind !== "files") {
        return;
      }

      updateReviewExpandedFileIds(reviewCache.threadKey, selectedSection.id, (existing) => {
        const currentIds = existing ?? getDefaultExpandedFileIds(parsedDiff.files);
        return currentIds.includes(fileId)
          ? currentIds.filter((id) => id !== fileId)
          : [...currentIds, fileId];
      });
    },
    [parsedDiff, reviewCache.threadKey, selectedSection?.id],
  );

  const handleRevealLargeDiff = useCallback(
    (fileId: string) => {
      if (!reviewCache.threadKey || !selectedSection?.id) {
        return;
      }

      updateReviewRevealedLargeFileIds(reviewCache.threadKey, selectedSection.id, (existing) => {
        const currentIds = existing ?? [];
        return currentIds.includes(fileId) ? currentIds : [...currentIds, fileId];
      });
    },
    [reviewCache.threadKey, selectedSection?.id],
  );

  const handlePressLine = useCallback(
    (input: ReviewLineActionInput) => {
      if (pendingCommentSelection) {
        if (
          pendingCommentSelection.sectionTitle === input.sectionTitle &&
          pendingCommentSelection.filePath === input.filePath
        ) {
          setReviewCommentTarget(
            buildReviewCommentTarget(
              {
                sectionTitle: pendingCommentSelection.sectionTitle,
                filePath: pendingCommentSelection.filePath,
                lines: pendingCommentSelection.lines,
              },
              pendingCommentSelection.anchorIndex,
              input.lineIndex,
            ),
          );
          setPendingCommentSelection(null);
          return;
        }

        clearReviewCommentTarget();
        setPendingCommentSelection({
          sectionTitle: input.sectionTitle,
          filePath: input.filePath,
          lines: input.lines,
          anchorIndex: input.lineIndex,
        });
        return;
      }

      setReviewCommentTarget({
        sectionTitle: input.sectionTitle,
        filePath: input.filePath,
        lines: input.lines,
        startIndex: input.lineIndex,
        endIndex: input.lineIndex,
      });
      if (environmentId && threadId) {
        router.push({
          pathname: "/threads/[environmentId]/[threadId]/review-comment",
          params: { environmentId, threadId },
        });
      }
    },
    [environmentId, pendingCommentSelection, router, threadId],
  );

  const handleStartRangeSelection = useCallback((input: ReviewLineActionInput) => {
    clearReviewCommentTarget();
    setPendingCommentSelection({
      sectionTitle: input.sectionTitle,
      filePath: input.filePath,
      lines: input.lines,
      anchorIndex: input.lineIndex,
    });
  }, []);

  const parsedDiffNotice =
    parsedDiff.kind === "files" || parsedDiff.kind === "raw" ? parsedDiff.notice : null;

  const listHeader = useMemo(() => {
    const children: ReactElement[] = [];

    if (error) {
      children.push(
        <View key="review-error" className="border-b border-border bg-card px-4 py-3">
          <Text className="text-[13px] font-t3-bold text-foreground">Review unavailable</Text>
          <Text className="text-[12px] leading-[18px] text-foreground-muted">{error}</Text>
        </View>,
      );
    }

    if (parsedDiffNotice) {
      children.push(<ReviewNotice key="review-notice" notice={parsedDiffNotice} />);
    }

    if (children.length === 0) {
      return null;
    }

    return <>{children}</>;
  }, [error, parsedDiffNotice]);
  const stickyHeaderIndices = useMemo(() => {
    const itemOffset = listHeader ? 1 : 0;

    return reviewListItems.flatMap((item, index) =>
      item.kind === "file-header" ? [index + itemOffset] : [],
    );
  }, [listHeader, reviewListItems]);

  const viewabilityConfigRef = useRef({
    itemVisiblePercentThreshold: 10,
  });
  const onViewableItemsChangedRef = useRef(
    ({
      viewableItems,
    }: {
      readonly viewableItems: Array<ViewToken<ReviewListItem>>;
      readonly changed: Array<ViewToken<ReviewListItem>>;
    }) => {
      const nextVisibleFileIds = Array.from(
        new Set(
          viewableItems
            .filter((token) => token.isViewable && token.item !== undefined)
            .map((token) => token.item.fileId),
        ),
      );

      setVisibleFileIds(nextVisibleFileIds);
    },
  );

  const renderReviewListItem = useCallback(
    ({ item }: ListRenderItemInfo<ReviewListItem>) => {
      if (!selectedSection) {
        return null;
      }

      switch (item.kind) {
        case "file-header":
          return (
            <ReviewFileCard
              file={item.file}
              fileId={item.fileId}
              expanded={item.expanded}
              viewportWidth={reviewListContentWidth}
              onToggleFile={handleToggleExpandedFile}
            />
          );
        case "file-suppressed":
          return (
            <ReviewFileSuppressedBody
              message={item.message}
              actionLabel={item.actionLabel}
              fileId={item.fileId}
              viewportWidth={reviewListContentWidth}
              onLoadDiffFile={handleRevealLargeDiff}
            />
          );
        case "hunk":
          return (
            <ReviewHunkRow
              header={item.row.header}
              context={item.row.context}
              viewportWidth={reviewListContentWidth}
            />
          );
        case "line": {
          const file = reviewFileById.get(item.fileId);
          if (!file) {
            return null;
          }

          const fileLineRows = reviewLineRowsByFileId.get(file.id) ?? [];
          const lineIndex = reviewLineIndexByRowId.get(item.row.id);
          if (lineIndex === undefined) {
            return null;
          }

          const pendingSelectionForFile =
            pendingCommentSelection &&
            pendingCommentSelection.sectionTitle === selectedSection.title &&
            pendingCommentSelection.filePath === file.path
              ? pendingCommentSelection
              : null;
          const selectedTargetForFile =
            activeCommentTarget &&
            activeCommentTarget.sectionTitle === selectedSection.title &&
            activeCommentTarget.filePath === file.path
              ? activeCommentTarget
              : null;
          const highlightedFile =
            highlightedFilesById[file.id] ??
            getCachedHighlightedReviewFile(file, selectedTheme) ??
            null;

          if (highlightedFile === null) {
            const missingTokenKey = `${selectedSection.id}:${file.id}`;
            if (!loggedMissingReviewTokenKeys.has(missingTokenKey)) {
              loggedMissingReviewTokenKeys.add(missingTokenKey);
              logReviewDiffDiagnostic("rendering file without tokens", {
                sectionId: selectedSection.id,
                fileId: file.id,
                filePath: file.path,
                highlightedFileKnownInState: highlightedFilesById[file.id] !== undefined,
              });
            }
          }

          const selectionState =
            pendingSelectionForFile?.anchorIndex === lineIndex
              ? ("anchor" as const)
              : selectedTargetForFile &&
                  lineIndex >= selectedTargetForFile.startIndex &&
                  lineIndex <= selectedTargetForFile.endIndex
                ? ("selected" as const)
                : null;

          return (
            <ReviewLineRow
              line={item.row}
              tokens={getHighlightedTokensForLine(item.row, highlightedFile)}
              viewportWidth={reviewListContentWidth}
              selectionState={selectionState}
              onComment={() =>
                handlePressLine({
                  sectionTitle: selectedSection.title,
                  filePath: file.path,
                  lines: fileLineRows,
                  lineIndex,
                })
              }
              onStartRangeSelection={() =>
                handleStartRangeSelection({
                  sectionTitle: selectedSection.title,
                  filePath: file.path,
                  lines: fileLineRows,
                  lineIndex,
                })
              }
            />
          );
        }
      }
    },
    [
      activeCommentTarget,
      handlePressLine,
      handleRevealLargeDiff,
      handleStartRangeSelection,
      handleToggleExpandedFile,
      highlightedFilesById,
      pendingCommentSelection,
      reviewFileById,
      reviewLineIndexByRowId,
      reviewLineRowsByFileId,
      reviewListContentWidth,
      selectedSection,
      selectedTheme,
    ],
  );

  return (
    <>
      <Stack.Screen
        options={{
          headerTransparent: true,
          headerShadowVisible: false,
          headerTintColor: headerIcon,
          headerStyle: {
            backgroundColor: "transparent",
          },
          headerTitle: () => (
            <View style={{ alignItems: "center" }}>
              <NativeText
                numberOfLines={1}
                style={{
                  fontFamily: "DMSans_700Bold",
                  fontSize: 18,
                  fontWeight: "900",
                  color: headerForeground,
                  letterSpacing: -0.4,
                }}
              >
                Files Changed
              </NativeText>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  flexWrap: "wrap",
                }}
              >
                {headerDiffSummary.additions && headerDiffSummary.deletions ? (
                  <>
                    <NativeText
                      style={{
                        fontFamily: "DMSans_700Bold",
                        fontSize: 12,
                        fontWeight: "700",
                        color: "#16a34a",
                      }}
                    >
                      {headerDiffSummary.additions}
                    </NativeText>
                    <NativeText
                      style={{
                        fontFamily: "DMSans_700Bold",
                        fontSize: 12,
                        fontWeight: "700",
                        color: "#e11d48",
                      }}
                    >
                      {headerDiffSummary.deletions}
                    </NativeText>
                    {pendingReviewCommentCount > 0 ? (
                      <NativeText
                        style={{
                          fontFamily: "DMSans_700Bold",
                          fontSize: 12,
                          fontWeight: "700",
                          color: "#b45309",
                        }}
                      >
                        {pendingReviewCommentCount} pending
                      </NativeText>
                    ) : null}
                  </>
                ) : (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <NativeText
                      numberOfLines={1}
                      style={{
                        fontFamily: "DMSans_700Bold",
                        fontSize: 12,
                        fontWeight: "700",
                        color: headerMuted,
                      }}
                    >
                      {selectedSection?.title ?? "Review changes"}
                    </NativeText>
                    {pendingReviewCommentCount > 0 ? (
                      <NativeText
                        style={{
                          fontFamily: "DMSans_700Bold",
                          fontSize: 12,
                          fontWeight: "700",
                          color: "#b45309",
                        }}
                      >
                        {pendingReviewCommentCount} pending
                      </NativeText>
                    ) : null}
                  </View>
                )}
              </View>
            </View>
          ),
        }}
      />

      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon="ellipsis.circle" title="Select diff" separateBackground>
          {reviewSections.map((section) => (
            <Stack.Toolbar.MenuAction
              key={section.id}
              icon={section.id === selectedSection?.id ? "checkmark" : "circle"}
              onPress={() => {
                if (reviewCache.threadKey) {
                  setReviewSelectedSectionId(reviewCache.threadKey, section.id);
                }
              }}
              subtitle={section.subtitle ?? undefined}
            >
              <Stack.Toolbar.Label>{section.title}</Stack.Toolbar.Label>
            </Stack.Toolbar.MenuAction>
          ))}
          <Stack.Toolbar.MenuAction
            icon="arrow.clockwise"
            disabled={
              loadingGitDiffs ||
              (selectedSection?.kind === "turn" && loadingTurnIds[selectedSection.id] === true)
            }
            onPress={() => void refreshSelectedSection()}
            subtitle="Reload current diff"
          >
            <Stack.Toolbar.Label>Refresh</Stack.Toolbar.Label>
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>

      <View className="flex-1 bg-sheet">
        {selectedSection && parsedDiff.kind === "files" ? (
          <FlatList
            style={{ flex: 1 }}
            contentInsetAdjustmentBehavior="never"
            contentInset={{ top: topContentInset }}
            contentOffset={{ x: 0, y: -topContentInset }}
            scrollIndicatorInsets={{ top: topContentInset }}
            data={reviewListItems}
            renderItem={renderReviewListItem}
            keyExtractor={(item) => item.id}
            keyboardShouldPersistTaps="handled"
            ListHeaderComponent={listHeader}
            stickyHeaderIndices={stickyHeaderIndices}
            removeClippedSubviews={false}
            initialNumToRender={24}
            maxToRenderPerBatch={16}
            updateCellsBatchingPeriod={16}
            windowSize={10}
            scrollEventThrottle={16}
            onViewableItemsChanged={onViewableItemsChangedRef.current}
            viewabilityConfig={viewabilityConfigRef.current}
            contentContainerStyle={{
              paddingTop: REVIEW_HEADER_SPACING,
              paddingBottom: Math.max(insets.bottom, 18) + 18,
            }}
          />
        ) : (
          <ScrollView
            contentInsetAdjustmentBehavior="never"
            contentInset={{ top: topContentInset }}
            contentOffset={{ x: 0, y: -topContentInset }}
            scrollIndicatorInsets={{ top: topContentInset }}
            showsVerticalScrollIndicator={false}
            style={{ flex: 1 }}
            contentContainerStyle={{
              paddingTop: REVIEW_HEADER_SPACING,
              paddingBottom: Math.max(insets.bottom, 18) + 18,
            }}
          >
            {listHeader}
            {!selectedSection ? (
              <View className="border-b border-border bg-card px-4 py-5">
                <Text className="text-[14px] font-t3-bold text-foreground">No review diffs</Text>
                <Text className="text-[12px] leading-[18px] text-foreground-muted">
                  This thread has no ready turn diffs and the worktree diff is empty.
                </Text>
              </View>
            ) : selectedSection.isLoading && selectedSection.diff === null ? (
              <View className="items-center gap-3 border-b border-border bg-card px-4 py-6">
                <ActivityIndicator size="small" />
                <Text className="text-[12px] text-foreground-muted">Loading diff…</Text>
              </View>
            ) : parsedDiff.kind === "empty" ? (
              <View className="border-b border-border bg-card px-4 py-5">
                <Text className="text-[14px] font-t3-bold text-foreground">No changes</Text>
                <Text className="text-[12px] leading-[18px] text-foreground-muted">
                  {selectedSection.subtitle ?? "This diff is empty."}
                </Text>
              </View>
            ) : parsedDiff.kind === "raw" ? (
              <View className="gap-3 border-b border-border bg-card px-4 py-4">
                <Text className="text-[12px] leading-[18px] text-foreground-muted">
                  {parsedDiff.reason}
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
                  <Text selectable className="font-mono text-[12px] leading-[19px] text-foreground">
                    {parsedDiff.text}
                  </Text>
                </ScrollView>
              </View>
            ) : null}
          </ScrollView>
        )}

        <ReviewSelectionActionBar
          target={activeCommentTarget}
          bottomInset={insets.bottom}
          onOpenComment={() => {
            if (activeCommentTarget && environmentId && threadId) {
              router.push({
                pathname: "/threads/[environmentId]/[threadId]/review-comment",
                params: { environmentId, threadId },
              });
            }
          }}
          onClear={() => {
            clearReviewCommentTarget();
            setPendingCommentSelection(null);
          }}
        />
      </View>
    </>
  );
}
