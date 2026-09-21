/**
 * The proxy.
 *
 * dsh already speaks ACP — `dsh --profile acp` is first-party. T3 already
 * speaks ACP too. What the two do not share is the handful of Cursor-specific
 * gestures T3's host driver makes, so the bridge sits in the middle of the
 * stdio pipe and translates exactly those:
 *
 *   T3 gesture                      becomes
 *   ------------------------------  --------------------------------------
 *   initialize                      forwarded; `cursor_login` added to the
 *                                   agent's empty `authMethods`
 *   authenticate                    answered here; dsh has no auth surface
 *   cursor/list_available_models    answered here from the learned catalog
 *   session/set_model <id>          session/set_config_option model=
 *                                   ["<provider>","<id>"]
 *   session/load                    session/resume (dsh advertises resume,
 *                                   not load, and T3's Cursor path uses load)
 *
 * Everything else — prompts, streamed updates, tool calls, permission
 * requests, terminals, MCP — passes through untouched, because both ends
 * already agree about it.
 */
import { spawn } from "node:child_process";

import { log } from "./log.ts";

import { dshArgs, dshCommand, type BridgeConfig } from "./config.ts";
import {
  findModelConfigOption,
  modelsFromConfigOption,
  readCachedModels,
  unwrapModelOptionValues,
  wrapModelValue,
  writeCachedModels,
  type CatalogModel,
  type DshConfigOption,
} from "./catalog.ts";

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

const EFFORT_CONFIG_ID = "reasoning_effort";

/** Report the effort the bridge is about to set, not the one it is replacing. */
function withDefaultEffort(
  result: Record<string, unknown>,
  effort: string,
): Record<string, unknown> {
  const configOptions = result.configOptions as ReadonlyArray<DshConfigOption> | undefined;
  if (!Array.isArray(configOptions) || !effort) return result;
  return {
    ...result,
    configOptions: configOptions.map((option) =>
      option.id === EFFORT_CONFIG_ID && option.options?.some((entry) => entry.value === effort)
        ? { ...option, currentValue: effort }
        : option,
    ),
  };
}

const CURSOR_AUTH_METHOD = {
  id: "cursor_login",
  name: "Log in",
  description: "The harness authenticates with its own DeepSeek credential.",
};

function lineReader(onMessage: (message: JsonRpcMessage) => void, onGarbage?: (line: string) => void) {
  let buffer = "";
  return (chunk: Buffer | string): void => {
    buffer += chunk.toString();
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line) as JsonRpcMessage);
      } catch {
        onGarbage?.(line);
      }
    }
  };
}

export function runProxy(config: BridgeConfig): void {
  const launch = dshCommand(config);
  log("spawn ", { command: launch.command, args: [...launch.prefix, ...dshArgs(config)] });
  const child = spawn(launch.command, [...launch.prefix, ...dshArgs(config)], {
    cwd: config.harnessDir,
    env: {
      ...process.env,
      ...(config.apiKey ? { DEEPSEEK_API_KEY: config.apiKey } : {}),
    },
    stdio: ["pipe", "pipe", "inherit"],
  });

  const toAgent = (message: JsonRpcMessage): void => {
    log("-> dsh", message);
    child.stdin.write(JSON.stringify(message) + "\n");
  };
  const toClient = (message: JsonRpcMessage): void => {
    log("-> t3 ", message);
    process.stdout.write(JSON.stringify(message) + "\n");
  };

  /** Ids the bridge minted itself, kept in a string namespace so they can
   * never collide with T3's numeric ones. */
  let bridgeSeq = 0;
  const bridgeCalls = new Map<string, (message: JsonRpcMessage) => void>();
  const callAgent = (
    method: string,
    params: Record<string, unknown>,
    onReply: (message: JsonRpcMessage) => void,
  ): void => {
    const id = `dshb-${++bridgeSeq}`;
    bridgeCalls.set(id, onReply);
    toAgent({ jsonrpc: "2.0", id, method, params });
  };

  const initializeIds = new Set<string | number>();
  const sessionOpenIds = new Set<string | number>();
  let models: ReadonlyArray<CatalogModel> = readCachedModels();

  const learnCatalog = (result: unknown): void => {
    const configOptions = (result as { configOptions?: ReadonlyArray<DshConfigOption> })
      ?.configOptions;
    const option = findModelConfigOption(configOptions);
    if (!option) return;
    const learned = modelsFromConfigOption(option);
    if (learned.length === 0) return;
    models = learned;
    writeCachedModels(learned);
  };

  /**
   * Tell dsh about the standing effort as soon as a session exists. A client
   * that picks its own effort (T3 does, from the thread's model selection)
   * overwrites this a moment later; one that does not now gets `max` instead of
   * dsh's provider default.
   */
  const applyDefaultEffort = (result: Record<string, unknown>): void => {
    const sessionId = result.sessionId;
    const effort = config.defaultEffort;
    if (typeof sessionId !== "string" || !effort) return;
    const option = (result.configOptions as ReadonlyArray<DshConfigOption> | undefined)?.find(
      (entry) => entry.id === EFFORT_CONFIG_ID,
    );
    if (!option || option.currentValue === effort) return;
    if (!option.options?.some((entry) => entry.value === effort)) return;
    callAgent(
      "session/set_config_option",
      { sessionId, configId: EFFORT_CONFIG_ID, value: effort },
      () => {},
    );
  };

  const fromClient = lineReader((message) => {
    log("<- t3 ", message);
    const { method, id, params } = message;

    if (method === "initialize") {
      if (id !== undefined) initializeIds.add(id);
      toAgent(message);
      return;
    }

    if (method === "session/new") {
      if (id !== undefined) sessionOpenIds.add(id);
      toAgent(message);
      return;
    }

    // dsh advertises no auth methods and needs none: its credential comes from
    // the harness. T3 always sends one authenticate, so answer it here.
    if (method === "authenticate") {
      if (id !== undefined) toClient({ jsonrpc: "2.0", id, result: {} });
      return;
    }

    if (method === "cursor/list_available_models") {
      if (id !== undefined) {
        toClient({ jsonrpc: "2.0", id, result: { models: models.map((m) => ({ ...m })) } });
      }
      return;
    }

    if (method === "session/set_model") {
      const requested = typeof params?.modelId === "string" ? params.modelId : undefined;
      if (id === undefined) return;
      if (!requested) {
        toClient({ jsonrpc: "2.0", id, result: {} });
        return;
      }
      callAgent(
        "session/set_config_option",
        {
          sessionId: params?.sessionId,
          configId: "model",
          value: wrapModelValue(config.provider, requested),
        },
        (reply) => {
          if (reply.result !== undefined) learnCatalog(reply.result);
          // A model the gateway has not enabled must not kill the session:
          // report success and let the prompt surface the real error.
          toClient({ jsonrpc: "2.0", id, result: {} });
        },
      );
      return;
    }

    // T3 drives its model picker either way round: `session/set_model` when
    // the agent advertises one, and a plain `session/set_config_option` on the
    // "model" option it saw in `session/new`. Both arrive carrying a bare
    // model id, which dsh rejects — it wants the provider-qualified array.
    if (method === "session/set_config_option" && params?.configId === "model") {
      const raw = typeof params.value === "string" ? params.value : undefined;
      if (raw && !raw.trim().startsWith("[")) {
        toAgent({
          ...message,
          params: { ...params, value: wrapModelValue(config.provider, raw.trim()) },
        });
        return;
      }
    }

    // T3's Cursor path resumes with session/load; dsh implements session/resume.
    if (method === "session/load") {
      if (id === undefined) return;
      callAgent("session/resume", { ...(params ?? {}) }, (reply) => {
        if (reply.result !== undefined) {
          learnCatalog(reply.result);
          toClient({ jsonrpc: "2.0", id, result: unwrapModelOptionValues(reply.result) });
        } else {
          toClient({ jsonrpc: "2.0", id, error: reply.error });
        }
      });
      return;
    }

    toAgent(message);
  });

  const fromAgent = lineReader((message) => {
    log("<- dsh", message);
    const { id } = message;

    if (id !== undefined && typeof id === "string" && bridgeCalls.has(id)) {
      const handler = bridgeCalls.get(id)!;
      bridgeCalls.delete(id);
      handler(message);
      return;
    }

    if (id !== undefined && initializeIds.has(id) && message.result !== undefined) {
      initializeIds.delete(id);
      const result = message.result as Record<string, unknown>;
      const advertised = Array.isArray(result.authMethods) ? result.authMethods : [];
      const patched = {
        ...result,
        authMethods: advertised.length > 0 ? advertised : [CURSOR_AUTH_METHOD],
      };
      toClient({ ...message, result: patched });
      return;
    }

    if (message.result !== undefined) {
      learnCatalog(message.result);
      const result = unwrapModelOptionValues(message.result) as Record<string, unknown>;
      if (id !== undefined && sessionOpenIds.has(id)) {
        sessionOpenIds.delete(id);
        toClient({ ...message, result: withDefaultEffort(result, config.defaultEffort) });
        applyDefaultEffort(result);
        return;
      }
      toClient({ ...message, result });
      return;
    }
    toClient(message);
  });

  process.stdin.on("data", fromClient);
  child.stdout.on("data", fromAgent);

  // stdin EOF is the harness's own shutdown signal; pass it along and let dsh
  // drain its agents before the process exits.
  process.stdin.on("end", () => child.stdin.end());
  child.on("exit", (code) => process.exit(code ?? 0));
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => child.kill(signal));
  }
}
