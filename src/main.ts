/**
 * Entry point. Argv shapes:
 *
 *   about [--format json]                     the health probe (legacy Cursor host)
 *   [-e <endpoint>] [--force|--auto-review] acp   the ACP session (legacy Cursor host)
 *   (no arguments)                            the ACP session (T3 V2 generic ACP host)
 *
 * T3 prepends flags before `acp` depending on the thread's runtime mode, so
 * argv is scanned rather than matched positionally.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildAboutPayload, renderAboutText } from "./about.ts";
import { loadConfig } from "./config.ts";
import { log } from "./log.ts";
import { runProxy } from "./proxy.ts";

function harnessVersion(harnessDir: string): string {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(join(harnessDir, "node_modules", "@deepseek-ai", "dsh", "package.json"), "utf8"),
    );
    const version = (manifest as { version?: string }).version;
    return version ?? "0";
  } catch {
    return "0";
  }
}

const argv = process.argv.slice(2);
log("argv  ", argv);
const config = loadConfig();

if (argv.includes("about")) {
  const payload = buildAboutPayload(harnessVersion(config.harnessDir));
  const wantsJson = argv.includes("json") || argv.includes("--format=json");
  process.stdout.write(wantsJson ? JSON.stringify(payload) + "\n" : renderAboutText(payload));
  process.exit(0);
}

// T3's generic ACP driver (Orchestrator V2's host for custom agents) spawns
// the executable with the registry entry's arguments, which are empty for the
// entries used to host this bridge, so a bare invocation is an ACP session.
const bare = argv.filter((arg) => !arg.startsWith("-")).length === 0;
if (argv.includes("acp") || bare) {
  runProxy(config);
} else {
  process.stderr.write(
    "dsh-t3-bridge: expected `about [--format json]` or `acp`.\n" +
      `harness: ${config.harnessDir}\nprofile: ${config.profile}\n`,
  );
  process.exit(2);
}
