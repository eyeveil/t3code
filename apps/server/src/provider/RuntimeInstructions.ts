import { buildKiStackInstructions } from "./KiStackSkills.ts";
import { resolveKiCadRuntime } from "../kicad/KiCadExecutable.ts";
const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.
</pull_request_linking>`;

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 * `modelName` is the display name users see in the model picker; `model` is the slug.
 */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const kicad = resolveKiCadRuntime(runtime.environment ?? process.env);
  const command = JSON.stringify(kicad.executable);
  const basics = `Use the selected KiCad CLI at \`${kicad.executable}\` for KiCad work. Check \`${command} --version\` and subcommand \`--help\`. Export with \`${command} sch export\` or \`${command} pcb export\`; run checks with \`${command} sch erc\` and \`${command} pcb drc\`. Use the full path when invoking it, quoting paths for your shell.`;
  const kicadInstructions = kicad.fork
    ? `${basics} This is Backplane KiCad ${kicad.fork.version}, source commit ${kicad.fork.sourceCommit}. For programmatic PCB/schematic edits, start \`${command} api-server <project-or-file> --socket <unique-socket>\` and stop your server when finished. This is NNG/protobuf IPC, not HTTP. Read the matching guide ${kicad.fork.guideUrl} and examples ${kicad.fork.examplesUrl}; protocol definitions are under api/proto at that revision. A Python IPC client is not preinstalled: when needed, use BACKPLANE_PYTHON if set to create an isolated virtualenv, install protobuf==5.29.6, pynng==0.9.0 and grpcio-tools==1.71.0, then generate matching bindings with \`python -m grpc_tools.protoc\` following the examples. Headless IPC has no interactive canvas; ERC/DRC use the CLI above. Preserve any \`<native-filename>.backplane.json\` companion metadata when moving or saving project files.`
    : `${basics} No matching Backplane fork manifest was found; check available capabilities before using fork-specific API/IPC commands.`;
  return `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}\n\n<kicad_runtime>${kicadInstructions}</kicad_runtime>\n\n${buildKiStackInstructions()}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
