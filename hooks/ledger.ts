import type { CompactResult } from '../src/types.js';

/**
 * What a compaction did, as one JSON file per event under the ledger
 * directory: a dashboard adds them up, and no two sessions ever write the
 * same file. Sizes only; no message text, no tool input, no path beyond the
 * working directory's last segment.
 */
export type LedgerOutcome = 'compacted' | 'calls-removed' | 'fallback' | 'skipped' | 'excluded';

export type LedgerEvent = {
  v: 1;
  ts: string;
  host: string;
  /** Where the session runs: `t3-code`, or Claude Code's entry point (`cli`, `sdk-ts`, ...). */
  surface?: string;
  session?: string;
  project?: string;
  trigger: string;
  outcome: LedgerOutcome;
  messagesBefore?: number;
  messagesAfter?: number;
  charsBefore?: number;
  charsAfter?: number;
  /** `(charsBefore - charsAfter) / 4`: an estimate, like every size here. */
  tokensFreed?: number;
  calls?: number;
  kept?: number;
  resultsDropped?: number;
  callsStubbed?: number;
  callsDropped?: number;
  requests?: number;
  /** Input tokens Jev reported for the round, or the state estimate when it reported none. */
  jevTokens?: number;
  ms?: number;
  reason?: string;
};

const CHARS_PER_TOKEN = 4;
const REASON_MAX_CHARS = 200;

export function tokensFreed(result: Pick<CompactResult, 'stats'>): number {
  return Math.max(0, Math.round((result.stats.charsBefore - result.stats.charsAfter) / CHARS_PER_TOKEN));
}

/** The sizes of a round Jev answered, for an event of any outcome. */
export function roundFields(
  result: Pick<CompactResult, 'stats'>,
  reportedJevTokens: number,
): Partial<LedgerEvent> {
  const { stats } = result;
  return {
    messagesBefore: stats.messagesBefore,
    messagesAfter: stats.messagesAfter,
    charsBefore: stats.charsBefore,
    charsAfter: stats.charsAfter,
    tokensFreed: tokensFreed(result),
    calls: stats.calls,
    kept: stats.kept,
    resultsDropped: stats.resultsDropped,
    callsStubbed: stats.callsStubbed,
    callsDropped: stats.callsDropped,
    requests: stats.requests,
    jevTokens: reportedJevTokens > 0 ? reportedJevTokens : stats.requests * stats.stateTokens,
    ms: stats.ms,
  };
}

/** The input tokens a Jev response reports, 0 when it reports none. */
export function reportedInputTokens(responseText: string): number {
  try {
    const usage: unknown = (JSON.parse(responseText) as { usage?: unknown }).usage;
    const tokens = (usage as { input_tokens?: unknown } | undefined)?.input_tokens;
    return typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
  } catch {
    return 0;
  }
}

/** `excludePaths` as a list: comma- or newline-separated, blanks dropped. */
export function parseExcludePaths(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** The first `excludePaths` entry found in `cwd` (case-insensitive), if any. */
export function excludedBy(cwd: string, excludePaths: readonly string[]): string | undefined {
  const lower = cwd.toLowerCase();
  return excludePaths.find((part) => lower.includes(part.toLowerCase()));
}

/** The surface a session runs on, from what its environment says. */
export function surfaceName(entrypoint: string | undefined, t3CliPath: string | undefined): string | undefined {
  if (t3CliPath) return 't3-code';
  return entrypoint ? entrypoint.slice(0, 40) : undefined;
}

export function projectName(cwd: string): string {
  return cwd.split('/').filter(Boolean).at(-1) ?? '';
}

export function ledgerFileName(ts: string, nonce: string): string {
  return `${ts.replace(/[^0-9TZ]/g, '')}-${nonce}.json`;
}

export function shortReason(reason: string): string {
  return reason.length > REASON_MAX_CHARS ? `${reason.slice(0, REASON_MAX_CHARS)}…` : reason;
}

function compactNumber(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

export type StatusInput = {
  percent?: number;
  compactAtPercent: number;
  runs: number;
  tokensFreed: number;
  excluded?: string;
  hasKey: boolean;
};

/** The pinned line under the prompt: whether Jev is armed, and what it freed this session. */
export function statusText(input: StatusInput): string {
  if (input.excluded) return `Jev ○ off in this folder (excludePaths: ${input.excluded})`;
  if (!input.hasKey) return 'Jev ○ no TypeSafe key: built-in summary only';
  const context =
    input.percent === undefined
      ? `compacts at ${input.compactAtPercent}%`
      : `context ${Math.round(input.percent)}% · compacts at ${input.compactAtPercent}%`;
  const freed =
    input.runs === 0
      ? 'nothing compacted yet'
      : `freed ~${compactNumber(input.tokensFreed)} tokens in ${input.runs} run${input.runs === 1 ? '' : 's'}`;
  return `Jev ● armed · ${context} · ${freed}`;
}
