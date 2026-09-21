/**
 * The model catalog.
 *
 * dsh publishes its models as an ACP *config option* (`id: "model"`) whose
 * values are JSON arrays — `["deepseek-official","deepseek-flash"]`. T3's
 * Cursor driver instead asks for a flat list over the `cursor/list_available_models`
 * extension and later selects one with `session/set_model`.
 *
 * So the bridge keeps a flat catalog of bare model ids and does the wrapping
 * in both directions. The catalog is learned from any `session/new` the bridge
 * proxies and cached on disk, because T3's *status probe* asks for the model
 * list without ever opening a session.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CatalogModel {
  readonly value: string;
  readonly name: string;
}

export interface DshSelectOption {
  readonly value?: string;
  readonly name?: string;
  readonly group?: string;
  readonly options?: ReadonlyArray<DshSelectOption>;
}

export interface DshConfigOption {
  readonly id: string;
  readonly name?: string;
  readonly category?: string;
  readonly type?: string;
  readonly currentValue?: string;
  readonly options?: ReadonlyArray<DshSelectOption>;
}

/** Shipped as the answer before the bridge has ever seen a session. */
export const FALLBACK_MODELS: ReadonlyArray<CatalogModel> = [
  { value: "deepseek-flash", name: "DeepSeek V4.1 Flash" },
  { value: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
  { value: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
  { value: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision (exp)" },
];

const CACHE_PATH =
  process.env.DSH_T3_MODEL_CACHE ??
  join(process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"), "t3-bridge-models.json");

/** `["deepseek-official","deepseek-flash"]` -> `deepseek-flash`. */
export function unwrapModelValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith("[")) return trimmed;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const last = parsed[parsed.length - 1];
      return typeof last === "string" ? last : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** `deepseek-flash` -> `["deepseek-official","deepseek-flash"]`. */
export function wrapModelValue(provider: string, model: string): string {
  return JSON.stringify([provider, model]);
}

/** Flatten a dsh `model` config option — its options are grouped by provider. */
export function modelsFromConfigOption(option: DshConfigOption): ReadonlyArray<CatalogModel> {
  const flat: Array<CatalogModel> = [];
  const visit = (entries: ReadonlyArray<DshSelectOption> | undefined): void => {
    for (const entry of entries ?? []) {
      if (entry.options) {
        visit(entry.options);
        continue;
      }
      const value = unwrapModelValue(entry.value);
      if (!value) continue;
      flat.push({ value, name: entry.name?.trim() || value });
    }
  };
  visit(option.options);
  return flat;
}

export function findModelConfigOption(
  options: ReadonlyArray<DshConfigOption> | undefined,
): DshConfigOption | undefined {
  return options?.find(
    (option) => option.id?.trim().toLowerCase() === "model" || option.category === "model",
  );
}

export function readCachedModels(): ReadonlyArray<CatalogModel> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    if (Array.isArray(parsed) && parsed.length > 0) {
      const models = parsed.filter(
        (entry): entry is CatalogModel =>
          typeof entry?.value === "string" && typeof entry?.name === "string",
      );
      if (models.length > 0) return models;
    }
  } catch {
    // No cache yet, or an unreadable one. The fallback list is the answer.
  }
  return FALLBACK_MODELS;
}

export function writeCachedModels(models: ReadonlyArray<CatalogModel>): void {
  if (models.length === 0) return;
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(models, null, 1));
  } catch {
    // A cache miss costs one stale model list, never a failed session.
  }
}

/**
 * Present the model option with bare slugs.
 *
 * T3 validates a config-option value against the option's own `options` list
 * *before* it sends `session/set_config_option` (AcpSessionRuntime.ts:624,
 * "expected one of ..."). Since T3 picks models by the slug it got from
 * `cursor/list_available_models`, the option dsh publishes — whose values are
 * `["deepseek-official","deepseek-flash"]` — fails that check locally and the
 * request never reaches the wire. So the bridge unwraps the values on the way
 * out and re-wraps them on the way in.
 */
export function unwrapModelOptionValues<T>(result: T): T {
  const configOptions = (result as { configOptions?: ReadonlyArray<DshConfigOption> })
    ?.configOptions;
  if (!Array.isArray(configOptions)) return result;

  const rewriteEntry = (entry: DshSelectOption): DshSelectOption =>
    entry.options
      ? { ...entry, options: entry.options.map(rewriteEntry) }
      : { ...entry, value: unwrapModelValue(entry.value) ?? entry.value };

  const rewritten = configOptions.map((option) =>
    option.id?.trim().toLowerCase() === "model" || option.category === "model"
      ? {
          ...option,
          currentValue: unwrapModelValue(option.currentValue) ?? option.currentValue,
          options: option.options?.map(rewriteEntry),
        }
      : option,
  );
  return { ...(result as object), configOptions: rewritten } as T;
}
