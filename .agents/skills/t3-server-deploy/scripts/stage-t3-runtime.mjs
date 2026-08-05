#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const scriptDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repoRoot = NodePath.resolve(scriptDir, "../../../..");
const serverDir = NodePath.join(repoRoot, "apps/server");
const stagedPackage = NodePath.resolve(
  process.env.STAGED_PKG ?? NodePath.join(NodeOS.homedir(), ".local/state/t3-deploy/package"),
);
const stagedParent = NodePath.dirname(stagedPackage);

const requireFromServer = NodeModule.createRequire(NodePath.join(serverDir, "package.json"));
const YAML = requireFromServer("yaml");

function resolveCatalogDependencies(dependencies, catalog, packageName) {
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, spec]) => {
      if (typeof spec !== "string" || !spec.startsWith("catalog:")) return [name, spec];

      const explicitKey = spec.slice("catalog:".length).trim();
      const catalogKey = explicitKey || name;
      const resolved = catalog[catalogKey];
      if (typeof resolved !== "string" || resolved.length === 0) {
        throw new Error(
          `Unable to resolve ${spec} for ${packageName} dependency ${name} (${catalogKey}).`,
        );
      }
      return [name, resolved];
    }),
  );
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed (${signal === null ? `exit ${code}` : signal}).`,
        ),
      );
    });
  });
}

function assertSafeStagePath(target) {
  const relativeToHome = NodePath.relative(NodeOS.homedir(), target);
  if (
    target === NodePath.parse(target).root ||
    relativeToHome === "" ||
    relativeToHome.startsWith(`..${NodePath.sep}`) ||
    NodePath.basename(target) !== "package"
  ) {
    throw new Error(`Refusing unsafe staged package path: ${target}`);
  }
}

assertSafeStagePath(stagedPackage);
await NodeFSP.mkdir(stagedParent, { recursive: true });
const temporaryPackage = await NodeFSP.mkdtemp(NodePath.join(stagedParent, ".package-staging-"));

try {
  const [serverPackageJson, workspaceConfig] = await Promise.all([
    NodeFSP.readFile(NodePath.join(serverDir, "package.json"), "utf8").then(JSON.parse),
    NodeFSP.readFile(NodePath.join(repoRoot, "pnpm-workspace.yaml"), "utf8").then(YAML.parse),
  ]);
  const catalog = workspaceConfig.catalog ?? {};
  const resolvedDependencies = resolveCatalogDependencies(
    serverPackageJson.dependencies ?? {},
    catalog,
    "apps/server",
  );
  const resolvedOverrides = resolveCatalogDependencies(
    workspaceConfig.overrides ?? {},
    catalog,
    "pnpm-workspace.yaml overrides",
  );
  // pnpm supports parent>child removal selectors that npm rejects when they
  // appear in the root manifest. They only trim optional client dependencies;
  // retain the ordinary version overrides needed by the server runtime.
  const npmOverrides = Object.fromEntries(
    Object.entries(resolvedOverrides).filter(([name, spec]) => !name.includes(">") && spec !== "-"),
  );
  const runtimePackageJson = {
    name: serverPackageJson.name,
    version: serverPackageJson.version,
    license: serverPackageJson.license,
    repository: serverPackageJson.repository,
    bin: serverPackageJson.bin,
    files: serverPackageJson.files,
    type: serverPackageJson.type,
    engines: serverPackageJson.engines,
    dependencies: resolvedDependencies,
    ...(Object.keys(npmOverrides).length === 0 ? {} : { overrides: npmOverrides }),
  };

  await Promise.all([
    NodeFSP.cp(NodePath.join(serverDir, "dist"), NodePath.join(temporaryPackage, "dist"), {
      recursive: true,
    }),
    NodeFSP.writeFile(
      NodePath.join(temporaryPackage, "package.json"),
      `${JSON.stringify(runtimePackageJson, null, 2)}\n`,
    ),
  ]);

  // npm cannot consume workspace catalog specs, so install from the resolved
  // manifest. Skip lifecycle scripts: node-pty otherwise requires a host
  // Python/compiler toolchain and its upstream package lacks a Linux prebuild.
  await run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-fund", "--no-audit"], {
    cwd: temporaryPackage,
  });

  // The repository install already built node-pty for this exact host Node ABI.
  // Copy that known-good native package into the self-contained runtime.
  const repoNodePty = await NodeFSP.realpath(NodePath.join(serverDir, "node_modules/node-pty"));
  const stagedNodePty = NodePath.join(temporaryPackage, "node_modules/node-pty");
  await NodeFSP.rm(stagedNodePty, { recursive: true, force: true });
  await NodeFSP.cp(repoNodePty, stagedNodePty, { recursive: true, dereference: true });

  // Import the complete bundle against the staged dependency tree before it can
  // become eligible for a live restart. This catches Effect/API skew early.
  await run(process.execPath, [NodePath.join(temporaryPackage, "dist/bin.mjs"), "--version"], {
    cwd: temporaryPackage,
  });

  const commit = await new Promise((resolve, reject) => {
    let stdout = "";
    const child = NodeChildProcess.spawn("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve(stdout.trim()) : reject(new Error("git rev-parse HEAD failed")),
    );
  });
  await NodeFSP.writeFile(
    NodePath.join(temporaryPackage, ".t3-deploy-runtime.json"),
    `${JSON.stringify({ version: serverPackageJson.version, commit }, null, 2)}\n`,
  );

  await NodeFSP.rm(stagedPackage, { recursive: true, force: true });
  await NodeFSP.rename(temporaryPackage, stagedPackage);
  console.log(`Staged complete t3 runtime at ${stagedPackage}`);
  console.log(`Version ${serverPackageJson.version}; commit ${commit}`);
} catch (error) {
  await NodeFSP.rm(temporaryPackage, { recursive: true, force: true });
  throw error;
}
