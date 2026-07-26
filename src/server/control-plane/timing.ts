import type { IsoTimestamp } from '#shared/protocol';

const QUARTER_HOUR_MS = 15 * 60 * 1_000;

function asIso(value: Date): IsoTimestamp {
  return value.toISOString() as IsoTimestamp;
}

export function agentForecastFrom(
  startedAt: IsoTimestamp,
  expectedAgentMinutes: number,
): IsoTimestamp {
  const start = Date.parse(startedAt);
  const raw = start + expectedAgentMinutes * 60 * 1_000;
  if (!Number.isFinite(start) || !Number.isFinite(raw) || Math.abs(raw) > 8.64e15) {
    throw new RangeError('AGENT_FORECAST_OUT_OF_RANGE');
  }
  return asIso(new Date(Math.ceil(raw / QUARTER_HOUR_MS) * QUARTER_HOUR_MS));
}

export function shiftAgentForecast(
  expectedCompletedAt: IsoTimestamp,
  pausedAt: IsoTimestamp,
  resumedAt: IsoTimestamp,
): IsoTimestamp {
  const pausedMs = Math.max(0, Date.parse(resumedAt) - Date.parse(pausedAt));
  const shifted = Date.parse(expectedCompletedAt) + pausedMs;
  if (!Number.isFinite(pausedMs) || !Number.isFinite(shifted) || Math.abs(shifted) > 8.64e15) {
    throw new RangeError('AGENT_FORECAST_OUT_OF_RANGE');
  }
  return asIso(new Date(Math.ceil(shifted / QUARTER_HOUR_MS) * QUARTER_HOUR_MS));
}
