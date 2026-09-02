/**
 * CursorSkills — workspace-aware discovery and native invocation for Cursor.
 *
 * Cursor discovers Agent Skills recursively from user and project roots but
 * its ACP command catalog only appears after opening a real session. Scanning
 * the same roots avoids starting an agent and its MCP servers just to populate
 * a composer menu.
 *
 * @module provider/Drivers/CursorSkills
 */
import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { parse as parseYamlDocument } from "yaml";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const SKILL_MENTION_PATTERN = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;
const HAS_SKILL_MENTION_PATTERN = /(^|\s)\$[a-zA-Z][a-zA-Z0-9:_-]*(?=\s|$)/;
const MAX_SKILL_DEPTH = 10;
const MAX_SKILL_BYTES = FileSystem.Size(1_000_000);

interface CursorSkillFrontmatter {
  readonly description?: string;
  readonly displayName?: string;
  readonly userInvocationOnly?: boolean;
  readonly userInvocable?: boolean;
  readonly cliVisible: boolean;
}

export interface CursorSkillsInspection {
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly errors: ReadonlyArray<PlatformError.PlatformError>;
}

const undefinedOnNotFound = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
): Effect.Effect<A | undefined, PlatformError.PlatformError, R> =>
  effect.pipe(
    Effect.map((value): A | undefined => value),
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound"
          ? Effect.void.pipe(Effect.as(undefined))
          : Effect.fail(error),
    }),
  );

const collectFileSystemError = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
  errors: Array<PlatformError.PlatformError>,
): Effect.Effect<A | undefined, never, R> =>
  undefinedOnNotFound(effect).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        errors.push(error);
        return undefined;
      }),
    ),
  );

function parseFrontmatterBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined;
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "true":
    case "yes":
    case "on":
      return true;
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return undefined;
  }
}

function parseSkillFrontmatter(contents: string): CursorSkillFrontmatter | undefined {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) return { cliVisible: true };

  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const record = parsed as Record<string, unknown>;
  const metadata =
    typeof record.metadata === "object" && record.metadata !== null
      ? (record.metadata as Record<string, unknown>)
      : undefined;
  const rawSurfaces = metadata?.surfaces;
  const surfaces = Array.isArray(rawSurfaces)
    ? rawSurfaces.filter((surface): surface is string => typeof surface === "string")
    : typeof rawSurfaces === "string"
      ? rawSurfaces.split(",")
      : [];
  const description = typeof record.description === "string" ? record.description.trim() : "";
  const displayName = typeof record.name === "string" ? record.name.trim() : "";
  return {
    cliVisible:
      surfaces.length === 0 || surfaces.some((surface) => surface.trim().toLowerCase() === "cli"),
    ...(description ? { description } : {}),
    ...(displayName ? { displayName } : {}),
    ...(parseFrontmatterBoolean(record["disable-model-invocation"]) === true
      ? { userInvocationOnly: true }
      : {}),
    ...(parseFrontmatterBoolean(record["user-invocable"]) === false
      ? { userInvocable: false }
      : {}),
  };
}

const discoverSkillsInRoot = Effect.fn("discoverCursorSkillsInRoot")(function* (input: {
  readonly directory: string;
  readonly scope: "user" | "project";
}): Effect.fn.Return<CursorSkillsInspection, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skills: ServerProviderSkill[] = [];
  const errors: PlatformError.PlatformError[] = [];
  const rootDirectory = yield* collectFileSystemError(fileSystem.realPath(input.directory), errors);
  if (!rootDirectory) return { skills, errors };
  const visitedDirectories = new Set<string>();

  const visit = Effect.fn("visitCursorSkillDirectory")(function* (
    directory: string,
    depth: number,
  ): Effect.fn.Return<void, never> {
    const resolvedDirectory = yield* collectFileSystemError(fileSystem.realPath(directory), errors);
    if (
      !resolvedDirectory ||
      visitedDirectories.has(resolvedDirectory) ||
      (resolvedDirectory !== rootDirectory &&
        !resolvedDirectory.startsWith(`${rootDirectory}${path.sep}`))
    ) {
      return;
    }
    visitedDirectories.add(resolvedDirectory);

    const skillPath = path.join(resolvedDirectory, "SKILL.md");
    const skillInfo = yield* collectFileSystemError(fileSystem.stat(skillPath), errors);
    if (skillInfo?.type === "File" && skillInfo.size <= MAX_SKILL_BYTES) {
      const contents = yield* collectFileSystemError(fileSystem.readFileString(skillPath), errors);
      const frontmatter = contents === undefined ? undefined : parseSkillFrontmatter(contents);
      const name = path.basename(resolvedDirectory).trim();
      if (frontmatter?.cliVisible && name) {
        skills.push({
          name,
          path: skillPath,
          scope: input.scope,
          enabled: true,
          ...(frontmatter.displayName && frontmatter.displayName !== name
            ? { displayName: frontmatter.displayName }
            : {}),
          ...(frontmatter.description ? { description: frontmatter.description } : {}),
          ...(frontmatter.userInvocationOnly ? { userInvocationOnly: true } : {}),
          ...(frontmatter.userInvocable === false ? { userInvocable: false } : {}),
        });
      }
    }

    if (depth >= MAX_SKILL_DEPTH) return;
    const entries =
      (yield* collectFileSystemError(fileSystem.readDirectory(resolvedDirectory), errors)) ?? [];
    for (const entry of [...entries].sort()) {
      const child = path.join(resolvedDirectory, entry);
      const info = yield* collectFileSystemError(fileSystem.stat(child), errors);
      if (info?.type === "Directory") yield* visit(child, depth + 1);
    }
  });

  yield* visit(input.directory, 0);
  return { skills, errors };
});

export const inspectCursorSkills = Effect.fn("inspectCursorSkills")(function* (
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<CursorSkillsInspection, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const userHome = environment.HOME?.trim() || environment.USERPROFILE?.trim() || NodeOS.homedir();
  const roots = [
    { directory: path.join(userHome, ".claude", "skills"), scope: "user" as const },
    { directory: path.join(userHome, ".codex", "skills"), scope: "user" as const },
    { directory: path.join(userHome, ".agents", "skills"), scope: "user" as const },
    { directory: path.join(userHome, ".cursor", "skills"), scope: "user" as const },
    ...(cwd
      ? [
          { directory: path.join(cwd, ".claude", "skills"), scope: "project" as const },
          { directory: path.join(cwd, ".codex", "skills"), scope: "project" as const },
          { directory: path.join(cwd, ".agents", "skills"), scope: "project" as const },
          { directory: path.join(cwd, ".cursor", "skills"), scope: "project" as const },
        ]
      : []),
  ];

  const skillsByName = new Map<string, ServerProviderSkill>();
  const errors: PlatformError.PlatformError[] = [];
  for (const root of roots) {
    const inspection = yield* discoverSkillsInRoot(root);
    errors.push(...inspection.errors);
    for (const skill of inspection.skills) {
      skillsByName.set(skill.name, skill);
    }
  }
  return {
    skills: [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name)),
    errors,
  };
});

export const discoverCursorSkills = Effect.fn("discoverCursorSkills")(function* (
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const inspection = yield* inspectCursorSkills(cwd, environment);
  if (inspection.errors.length > 0) {
    yield* Effect.logWarning("cursor skill discovery was incomplete", {
      causes: inspection.errors,
    });
  }
  return inspection.skills;
});

/** Cursor invokes Agent Skills with `/name`; T3 composers insert `$name`. */
export function hasCursorSkillMention(prompt: string): boolean {
  return HAS_SKILL_MENTION_PATTERN.test(prompt);
}

export function rewriteCursorSkillMentions(
  prompt: string,
  skillNames: ReadonlySet<string>,
): string {
  return prompt.replace(SKILL_MENTION_PATTERN, (match, prefix: string, name: string) =>
    skillNames.has(name) ? `${prefix}/${name}` : match,
  );
}
