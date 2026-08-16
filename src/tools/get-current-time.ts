import { getCachedHAConfig } from "../cache.js";
import { config } from "../config.js";
import { formatInTimeZone } from "date-fns-tz";

export const GET_CURRENT_TIME_TOOL = {
  name: "ha_history_get_current_time",
  description:
    `Returns the current date and time from the Home Assistant server (${config.haName}).\n` +
    `Call this before time-based queries that use relative or named periods such as\n` +
    `"last month", "this winter", "yesterday", or "recently".\n` +
    `Do not rely on your training data to infer the current date — it will often be wrong.\n` +
    `Skip only if an absolute ISO date range has already been stated in this conversation.`,
  inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
};

export function handleGetCurrentTime(): string {
  const haConfig = getCachedHAConfig();
  const tz = config.haTimezone ?? haConfig?.timezone ?? "UTC";
  const now = new Date();
  const iso = formatInTimeZone(now, tz, "yyyy-MM-dd'T'HH:mm:ssxxx");
  const friendly = formatInTimeZone(now, tz, "EEEE d MMMM yyyy");
  // "RRRR" is the ISO week-numbering year — it differs from the calendar year
  // around New Year (Dec 31 can be week 1 of the NEXT ISO year).
  const week = formatInTimeZone(now, tz, "I 'of' RRRR");
  const offset = formatInTimeZone(now, tz, "xxx");

  return [
    `Current time: ${iso}`,
    `Date: ${friendly}`,
    `UTC offset: ${offset}`,
    `Week: ${week}`,
    `Home: ${config.haName}`,
  ].join("\n");
}
