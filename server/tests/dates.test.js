/**
 * Calendar date arithmetic, and where "today" comes from.
 *
 * Pure functions, so this file touches no database and needs no fixtures. It is
 * also the cheapest place to pin the rules the rest of Step 4 rests on: every
 * streak, grid range and consistency denominator is built out of these, and a
 * date helper that is wrong by one day does not throw — it quietly reports the
 * wrong streak.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  addDays,
  addMonths,
  daysBetween,
  eachDay,
  endOfWeek,
  instantOn,
  isIsoDate,
  isIsoMonth,
  isoWeekday,
  monthOf,
  monthRange,
  startOfWeek,
  todayIn,
} from "../src/lib/dates.js";

const run = promisify(execFile);
const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("date validation", () => {
  it("accepts real calendar days", () => {
    for (const date of ["2026-01-05", "2024-02-29", "2026-12-31", "1999-06-30"]) {
      assert.equal(isIsoDate(date), true, `${date} should be valid`);
    }
  });

  it("rejects days that do not exist", () => {
    // The pattern alone accepts all of these; Date.UTC silently rolls them
    // forward. Without the round-trip check they would reach Postgres and come
    // back as a 500 instead of a 400.
    for (const date of ["2026-02-31", "2026-02-30", "2025-02-29", "2026-13-01", "2026-04-31"]) {
      assert.equal(isIsoDate(date), false, `${date} should be rejected`);
    }
  });

  it("rejects anything that is not a padded YYYY-MM-DD string", () => {
    for (const value of ["2026-1-5", "26-01-05", "2026/01/05", "", "today", null, 20260105, {}]) {
      assert.equal(isIsoDate(value), false, `${JSON.stringify(value)} should be rejected`);
    }
  });

  it("rejects a two-digit year rather than silently meaning 1950", () => {
    // Date.UTC(50, ...) maps to 1950. The round-trip check is what catches it.
    assert.equal(isIsoDate("0050-01-01"), false);
  });

  it("validates months", () => {
    assert.equal(isIsoMonth("2026-09"), true);
    assert.equal(isIsoMonth("2026-13"), false);
    assert.equal(isIsoMonth("2026-00"), false);
    assert.equal(isIsoMonth("2026-9"), false);
    assert.equal(isIsoMonth("2026-09-01"), false);
  });
});

describe("date arithmetic", () => {
  it("crosses month and year boundaries", () => {
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2027-01-01", -1), "2026-12-31");
    assert.equal(addDays("2026-01-31", 1), "2026-02-01");
  });

  it("handles leap years in both directions", () => {
    assert.equal(addDays("2024-02-28", 1), "2024-02-29");
    assert.equal(addDays("2024-02-29", 1), "2024-03-01");
    assert.equal(addDays("2025-02-28", 1), "2025-03-01");
  });

  /**
   * The reason every operation is anchored at noon UTC. Midnight-anchored
   * arithmetic lands on 23:00 the previous day across a spring-forward and
   * silently reports the wrong date.
   */
  it("is unaffected by DST transitions", () => {
    for (const [from, to] of [
      ["2026-03-28", "2026-03-29"], // EU spring forward
      ["2026-03-29", "2026-03-30"],
      ["2026-10-24", "2026-10-25"], // EU fall back
      ["2026-11-01", "2026-11-02"], // US fall back
    ]) {
      assert.equal(addDays(from, 1), to, `${from} + 1 day`);
      assert.equal(addDays(to, -1), from, `${to} - 1 day`);
    }
  });

  it("counts whole days between dates, signed", () => {
    assert.equal(daysBetween("2026-01-01", "2026-12-31"), 364);
    assert.equal(daysBetween("2026-12-31", "2026-01-01"), -364);
    assert.equal(daysBetween("2026-01-05", "2026-01-05"), 0);
    assert.equal(daysBetween("2024-02-28", "2024-03-01"), 2); // leap year
  });

  it("throws on a date that does not exist rather than guessing", () => {
    assert.throws(() => addDays("2026-02-31", 1), TypeError);
    assert.throws(() => isoWeekday("nonsense"), TypeError);
  });
});

describe("ISO weeks", () => {
  it("numbers weekdays Monday=1 through Sunday=7", () => {
    // 2026-01-05 is a Monday.
    const expected = [1, 2, 3, 4, 5, 6, 7];
    expected.forEach((weekday, offset) => {
      assert.equal(isoWeekday(addDays("2026-01-05", offset)), weekday);
    });
  });

  it("anchors weeks to Monday and Sunday", () => {
    // Every day of one week resolves to the same Monday and the same Sunday.
    for (let offset = 0; offset < 7; offset += 1) {
      const day = addDays("2026-09-07", offset);
      assert.equal(startOfWeek(day), "2026-09-07", `startOfWeek(${day})`);
      assert.equal(endOfWeek(day), "2026-09-13", `endOfWeek(${day})`);
    }
  });

  it("is idempotent on the boundaries themselves", () => {
    assert.equal(startOfWeek("2026-09-07"), "2026-09-07");
    assert.equal(endOfWeek("2026-09-13"), "2026-09-13");
  });

  /**
   * Weeks are plain Monday anchors, never ISO week *numbers*. That is what keeps
   * the year boundary from being a special case: no week 53, and no "January 1st
   * belongs to last year's week" rule to get wrong.
   */
  it("spans the year boundary without a special case", () => {
    assert.equal(startOfWeek("2027-01-01"), "2026-12-28");
    assert.equal(endOfWeek("2026-12-28"), "2027-01-03");
    assert.equal(eachDay(startOfWeek("2027-01-01"), endOfWeek("2027-01-01")).length, 7);
  });
});

describe("date ranges", () => {
  it("is inclusive at both ends", () => {
    assert.deepEqual(eachDay("2026-01-30", "2026-02-02"), [
      "2026-01-30",
      "2026-01-31",
      "2026-02-01",
      "2026-02-02",
    ]);
    assert.deepEqual(eachDay("2026-01-05", "2026-01-05"), ["2026-01-05"]);
  });

  it("returns nothing when the range is reversed", () => {
    assert.deepEqual(eachDay("2026-02-02", "2026-01-30"), []);
  });

  /** The grid's core invariant: a week-aligned range is always weeks * 7 cells. */
  it("yields exactly weeks * 7 days for a Monday-to-Sunday span", () => {
    for (const weeks of [1, 4, 12, 53]) {
      const end = endOfWeek("2026-09-11");
      const start = addDays(startOfWeek("2026-09-11"), -(weeks - 1) * 7);
      assert.equal(eachDay(start, end).length, weeks * 7, `${weeks} weeks`);
    }
  });

  it("produces the documented 12-week grid range", () => {
    // 2026-09-11 is a Friday; the grid ends on that week's Sunday.
    assert.equal(endOfWeek("2026-09-11"), "2026-09-13");
    assert.equal(addDays(startOfWeek("2026-09-11"), -11 * 7), "2026-06-22");
  });
});

describe("months", () => {
  it("reads the month a date falls in", () => {
    assert.equal(monthOf("2026-09-11"), "2026-09");
    assert.equal(monthOf("2026-01-01"), "2026-01");
    assert.throws(() => monthOf("2026-02-31"), TypeError);
  });

  it("shifts months across year boundaries", () => {
    assert.equal(addMonths("2026-01", -1), "2025-12");
    assert.equal(addMonths("2026-12", 1), "2027-01");
    assert.equal(addMonths("2026-03", -14), "2025-01");
    assert.equal(addMonths("2026-09", 0), "2026-09");
  });

  it("bounds a month, including short and leap ones", () => {
    assert.deepEqual(monthRange("2026-09"), { start: "2026-09-01", end: "2026-09-30" });
    assert.deepEqual(monthRange("2024-02"), { start: "2024-02-01", end: "2024-02-29" });
    assert.deepEqual(monthRange("2025-02"), { start: "2025-02-01", end: "2025-02-28" });
    assert.deepEqual(monthRange("2026-12"), { start: "2026-12-01", end: "2026-12-31" });
  });

  it("rejects a month that does not exist", () => {
    assert.throws(() => monthRange("2026-13"), TypeError);
  });
});

describe("today", () => {
  it("returns a well-formed, zero-padded date for any zone", () => {
    for (const zone of ["UTC", "Asia/Kolkata", "America/New_York", "Pacific/Kiritimati"]) {
      const date = todayIn(zone);
      assert.match(date, /^\d{4}-\d{2}-\d{2}$/, `${zone} produced ${date}`);
      assert.equal(isIsoDate(date), true, `${zone} produced ${date}`);
    }
  });

  /**
   * Cross-checks the formatToParts assembly against an independent formatter.
   * 'sv-SE' renders dates as YYYY-MM-DD, so the two must agree exactly.
   */
  it("agrees with an independently formatted date", () => {
    const now = new Date();
    for (const zone of ["UTC", "Asia/Kolkata", "America/Los_Angeles", "Australia/Sydney"]) {
      assert.equal(todayIn(zone), now.toLocaleDateString("sv-SE", { timeZone: zone }), zone);
    }
  });

  /**
   * The whole reason the zone is configurable: the extremes disagree about what
   * day it is for most of the day.
   *
   * The spread is up to two calendar dates, not one. UTC-11 and UTC+14 are 25
   * hours apart, so for the hour between 10:00 and 11:00 UTC the earlier zone is
   * still on yesterday while the later one has already reached tomorrow.
   */
  it("moves with the zone, and UTC sits between the extremes", () => {
    const earliest = todayIn("Pacific/Niue"); // UTC-11
    const latest = todayIn("Pacific/Kiritimati"); // UTC+14
    const utc = todayIn("UTC");

    assert.ok(latest >= earliest, `${latest} should not precede ${earliest}`);
    assert.ok(daysBetween(earliest, latest) <= 2, `${earliest} -> ${latest} spans over two days`);
    assert.ok(utc >= earliest && utc <= latest, `UTC ${utc} outside ${earliest}..${latest}`);
  });
});

describe("event instants", () => {
  it("anchors a calendar day at noon UTC", () => {
    assert.equal(instantOn("2026-09-11"), "2026-09-11T12:00:00.000Z");
  });
});

describe("timezone configuration", () => {
  /**
   * Spawned rather than imported: config snapshots the environment the first
   * time it loads, so a bad value can only be observed in a fresh process. The
   * point of the check is that this fails at boot rather than as a 500 on the
   * first request that needs today's date.
   */
  it("refuses to boot on an invalid time zone", async () => {
    await assert.rejects(
      run(
        process.execPath,
        ["--input-type=module", "-e", "await import('./src/config/index.js')"],
        {
          cwd: serverDir,
          env: { ...process.env, APP_TIMEZONE: "Not/AZone" },
        },
      ),
      (error) => {
        assert.match(error.stderr, /APP_TIMEZONE is not a valid IANA time zone/);
        // The message names the offending value, which is not a secret.
        assert.match(error.stderr, /Not\/AZone/);
        return true;
      },
    );
  });

  it("boots with a valid zone, and defaults to UTC when unset", async () => {
    const script =
      "await import('./src/config/index.js').then(m => console.log(m.config.timezone))";

    const withZone = await run(process.execPath, ["--input-type=module", "-e", script], {
      cwd: serverDir,
      env: { ...process.env, APP_TIMEZONE: "Asia/Kolkata" },
    });
    assert.equal(withZone.stdout.trim(), "Asia/Kolkata");

    const unset = { ...process.env };
    delete unset.APP_TIMEZONE;
    const withoutZone = await run(process.execPath, ["--input-type=module", "-e", script], {
      cwd: serverDir,
      env: unset,
    });
    assert.equal(withoutZone.stdout.trim(), "UTC");
  });
});
