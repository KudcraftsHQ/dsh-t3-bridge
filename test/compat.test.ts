/**
 * The gates T3 Code imposes on a Cursor-driver binary, encoded.
 *
 * Each expectation is read out of t3code's own source; if T3 tightens one of
 * them, this file is what to update first.
 */
import { describe, expect, it } from "bun:test";

import { buildAboutPayload, renderAboutText } from "../src/about.ts";
import {
  FALLBACK_MODELS,
  modelsFromConfigOption,
  unwrapModelOptionValues,
  unwrapModelValue,
  wrapModelValue,
} from "../src/catalog.ts";

/** CursorProvider.ts: CURSOR_PARAMETERIZED_MODEL_PICKER_MIN_VERSION_DATE. */
const MIN_VERSION_DATE = Date.UTC(2026, 3, 8);

describe("about probe", () => {
  const payload = buildAboutPayload("0.1.5-rc.2");

  it("reports a cliVersion T3 parses as a date at or after the minimum", () => {
    const match = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(payload.cliVersion);
    expect(match).not.toBeNull();
    const [, year, month, day] = match!;
    expect(Date.UTC(Number(year), Number(month) - 1, Number(day))).toBeGreaterThanOrEqual(
      MIN_VERSION_DATE,
    );
  });

  it("reports an account that does not read as logged out", () => {
    expect(payload.userEmail.length).toBeGreaterThan(0);
    expect(payload.userEmail.toLowerCase()).not.toContain("not logged in");
    expect(payload.userEmail.toLowerCase()).not.toContain("login required");
  });

  it("renders the text form with the two-space column gap T3's regex needs", () => {
    const line = renderAboutText(payload)
      .split("\n")
      .find((entry) => entry.startsWith("CLI Version"));
    expect(line).toMatch(/^CLI Version\s{2,}(.+)$/);
  });
});

describe("model value translation", () => {
  it("unwraps dsh's provider-qualified value", () => {
    expect(unwrapModelValue('["deepseek-official","deepseek-flash"]')).toBe("deepseek-flash");
  });

  it("leaves a bare slug alone", () => {
    expect(unwrapModelValue("deepseek-flash")).toBe("deepseek-flash");
  });

  it("round-trips through the wrap dsh expects", () => {
    expect(unwrapModelValue(wrapModelValue("deepseek-official", "deepseek-v4-pro"))).toBe(
      "deepseek-v4-pro",
    );
  });

  it("flattens the grouped option list into a catalog", () => {
    const models = modelsFromConfigOption({
      id: "model",
      options: [
        {
          group: "deepseek-official",
          name: "DeepSeek",
          options: [
            { value: '["deepseek-official","deepseek-flash"]', name: "DeepSeek-V41-Flash" },
            { value: '["deepseek-official","deepseek-v4-pro"]', name: "DeepSeek-V4-Pro" },
          ],
        },
      ],
    });
    expect(models.map((model) => model.value)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
  });

  /**
   * AcpSessionRuntime.ts:624 — T3 validates a select value against the option's
   * own list *before* sending it, so the values it sees must be the slugs it
   * picks from, not dsh's arrays.
   */
  it("presents the model option with bare slugs so T3's own validation passes", () => {
    const rewritten = unwrapModelOptionValues({
      sessionId: "s",
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: '["deepseek-official","deepseek-flash"]',
          options: [
            {
              group: "deepseek-official",
              name: "DeepSeek",
              options: [{ value: '["deepseek-official","deepseek-flash"]', name: "Flash" }],
            },
          ],
        },
        {
          id: "reasoning_effort",
          name: "Reasoning effort",
          category: "thought_level",
          type: "select",
          currentValue: "high",
          options: [{ value: "high", name: "High" }],
        },
      ],
    });
    const model = rewritten.configOptions[0]!;
    expect(model.currentValue).toBe("deepseek-flash");
    expect(model.options![0]!.options![0]!.value).toBe("deepseek-flash");
    // The effort option is dsh's own and T3 matches it on name; leave it alone.
    expect(rewritten.configOptions[1]!.currentValue).toBe("high");
  });

  it("ships a fallback catalog for the status probe, which never opens a session", () => {
    expect(FALLBACK_MODELS.map((model) => model.value)).toContain("deepseek-flash");
  });
});
