import assert from "node:assert/strict";
import test from "node:test";
import {
  briefingAgeHours,
  isBriefingFresh,
  MAX_BRIEFING_AGE_HOURS,
} from "../../features/briefing/server/briefing";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");

test("keeps briefing stories within the 72-hour freshness window", () => {
  const boundary = new Date(NOW - MAX_BRIEFING_AGE_HOURS * 3_600_000).toISOString();
  const stale = new Date(NOW - (MAX_BRIEFING_AGE_HOURS + 1) * 3_600_000).toISOString();
  assert.equal(isBriefingFresh(boundary, NOW), true);
  assert.equal(isBriefingFresh(stale, NOW), false);
});

test("treats invalid publication dates as stale", () => {
  assert.equal(briefingAgeHours("unknown", NOW), Number.POSITIVE_INFINITY);
  assert.equal(isBriefingFresh("unknown", NOW), false);
});
