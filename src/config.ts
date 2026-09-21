/**
 * Where the harness lives and how it is launched.
 *
 * Every value is overridable from the environment so a T3 provider instance
 * can point at a different harness checkout, profile or patch file without a
 * second copy of the bridge.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BridgeConfig {
  readonly harnessDir: string;
  readonly dshBin: string;
  readonly nodeBin: string;
  readonly profile: string;
  readonly patches: ReadonlyArray<string>;
  readonly provider: string;
  readonly defaultEffort: string;
  readonly apiKey: string | undefined;
}

function firstExisting(...candidates: ReadonlyArray<string>): string | undefined {
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

/**
 * The DeepSeek key. The launch environment wins (dsh resolves credentials the
 * same way), then a key file — pi already keeps one at
 * `~/.pi/agent/deepseek-api-key`, so a machine that runs pi needs no new
 * secret.
 */
function resolveApiKey(): string | undefined {
  const fromEnv = process.env.DEEPSEEK_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  const keyFile = firstExisting(
    process.env.DSH_T3_KEY_FILE ?? "",
    join(homedir(), ".pi", "agent", "deepseek-api-key"),
  );
  if (!keyFile) return undefined;
  const contents = readFileSync(keyFile, "utf8").trim();
  return contents || undefined;
}

/**
 * The node that runs dsh. T3 spawns providers without a login shell, so the
 * `#!/usr/bin/env node` shebang on dsh's own bin cannot be trusted to resolve —
 * the same trap the launcher script works around for bun.
 */
function resolveNode(): string {
  const explicit = process.env.DSH_T3_NODE?.trim();
  if (explicit) return explicit;
  const fromPath = (process.env.PATH ?? "")
    .split(":")
    .map((dir) => join(dir, "node"))
    .find((candidate) => candidate && existsSync(candidate));
  return (
    fromPath ??
    firstExisting(
      join(homedir(), ".local", "bin", "node"),
      join(homedir(), ".hermes", "node", "bin", "node"),
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "/usr/bin/node",
    ) ??
    "node"
  );
}

export function loadConfig(): BridgeConfig {
  const harnessDir =
    process.env.DSH_T3_HARNESS_DIR?.trim() || join(homedir(), "Projects", "dsh-harness");
  const dshBin =
    process.env.DSH_T3_DSH_BIN?.trim() || join(harnessDir, "node_modules", ".bin", "dsh");

  const explicitPatch = process.env.DSH_T3_PATCH?.trim();
  const defaultPatch = join(harnessDir, "acp-patch.yml");
  const patch = explicitPatch || (existsSync(defaultPatch) ? defaultPatch : "");

  return {
    harnessDir,
    dshBin,
    nodeBin: resolveNode(),
    profile: process.env.DSH_T3_PROFILE?.trim() || "acp",
    patches: patch ? [patch] : [],
    provider: process.env.DSH_T3_PROVIDER?.trim() || "deepseek-official",
    // dsh's own default is the provider default ("high"), and its `acp` plugin
    // row takes only provider and model — so the standing effort is set here,
    // on every session the bridge opens, for clients that do not pick one.
    defaultEffort: process.env.DSH_T3_DEFAULT_EFFORT?.trim() || "max",
    apiKey: resolveApiKey(),
  };
}

/**
 * dsh's npm shim is a JS file with a node shebang. Spawning it through an
 * explicitly resolved node keeps the bridge working under T3's bare PATH.
 */
export function dshCommand(config: BridgeConfig): { command: string; prefix: ReadonlyArray<string> } {
  const entry = join(config.harnessDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  if (existsSync(entry)) return { command: config.nodeBin, prefix: [entry] };
  return { command: config.dshBin, prefix: [] };
}

export function dshArgs(config: BridgeConfig): ReadonlyArray<string> {
  return [
    "--profile",
    config.profile,
    ...config.patches.flatMap((patch) => ["--patch", patch]),
  ];
}
