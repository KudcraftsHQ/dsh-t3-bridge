/**
 * The `about` probe.
 *
 * T3 Code health-checks its Cursor driver by running `<binaryPath> about
 * --format json` and parsing the result (`CursorProvider.ts`,
 * `checkCursorProviderStatus`). The bridge answers it so the instance reports
 * as ready. Three fields are load-bearing:
 *
 *  - `cliVersion` must match /^\d{4}\.\d{2}\.\d{2}/ and parse to a date at or
 *    after Cursor's parameterized-model-picker minimum (2026-04-08).
 *  - `userEmail` must be non-empty and must not read as a logged-out marker.
 *  - The whole payload must reach stdout within 8s (ABOUT_TIMEOUT_MS).
 */
export const COMPAT_CLI_VERSION = process.env.DSH_T3_CLI_VERSION ?? "2026.09.12";
export const ACCOUNT_LABEL = process.env.DSH_T3_ACCOUNT ?? "deepseek@local";

export interface AboutPayload {
  cliVersion: string;
  userEmail: string;
  subscriptionTier: string;
}

export function buildAboutPayload(harnessVersion: string): AboutPayload {
  return {
    cliVersion: `${COMPAT_CLI_VERSION}-dsh${harnessVersion}`,
    userEmail: ACCOUNT_LABEL,
    subscriptionTier: "deepseek-harness",
  };
}

/**
 * Key-value rendering for a bare `about`, which T3 falls back to when the CLI
 * did not understand `--format json`. T3 parses with /^<key>\s{2,}(.+)$/m, so
 * the column gap must be at least two spaces.
 */
export function renderAboutText(payload: AboutPayload): string {
  return [
    "About DeepSeek Harness (T3 bridge)",
    "",
    `CLI Version         ${payload.cliVersion}`,
    `User Email          ${payload.userEmail}`,
    `Subscription        ${payload.subscriptionTier}`,
    "",
  ].join("\n");
}
