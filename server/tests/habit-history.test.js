/**
 * GET /api/habits/:id/history — one habit's whole life.
 *
 * The rules worth holding this endpoint to are the ones that make it different
 * from every other read in the app: it is the only one that returns notes in
 * bulk, so its cursor has to page the whole record without skipping or
 * repeating a day; and it is the only one about a single habit over its whole
 * life, so its spine has to start where the habit started and stop where the
 * habit stopped.
 *
 *   docker compose exec api node --test --import ./tests/helpers/env.js \
 *     tests/habit-history.test.js
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { addDays, startOfWeek, today } from "../src/lib/dates.js";
import { withApi } from "./helpers/api.js";
import { closePool, makeHabit, makeLog, makeSchedule } from "./helpers/db.js";

after(closePool);

const get = async (api, id, search = "") => {
  const response = await api(`/api/habits/${id}/history${search}`);
  assert.equal(response.status, 200);
  return response.json();
};

describe("a habit's history", () => {
  it("runs whole weeks from the habit's start to today", async () => {
    await withApi(async ({ api }) => {
      const start = addDays(today(), -20);
      const habit = await makeHabit({ start_date: start });

      const body = await get(api, habit.id);

      assert.equal(body.start, startOfWeek(start), "starts on the Monday of the first week");
      assert.equal(body.cells.length, body.weeks * 7, "always whole weeks");
      assert.equal(body.today, today());
      // Days before the habit existed are inactive, not unlogged failures.
      assert.match(body.cells.slice(0, 1), /-|d/);
    });
  });

  /*
   * An archived habit stops where it was archived. Running the spine on to
   * today would paint the weeks since as days it failed to show up for.
   */
  it("stops at the archive date", async () => {
    await withApi(async ({ api }) => {
      const start = addDays(today(), -60);
      const habit = await makeHabit({ start_date: start });
      await api(`/api/habits/${habit.id}`, { method: "PATCH", body: { archived: true } });

      const body = await get(api, habit.id);
      assert.ok(body.end < addDays(today(), 7), "does not run past the week it was archived in");
      assert.ok(body.habit.archived_on, "and says when it stopped");
    });
  });

  it("reports every schedule version, oldest first", async () => {
    await withApi(async ({ api }) => {
      const start = addDays(today(), -40);
      const habit = await makeHabit({ start_date: start, schedule: { schedule_days: [1, 3, 5] } });
      await makeSchedule(habit.id, {
        effective_from: addDays(start, 14),
        schedule_kind: "paused",
        schedule_days: null,
      });

      const body = await get(api, habit.id);

      assert.equal(body.versions.length, 2);
      assert.deepEqual(body.versions[0].schedule_days, [1, 3, 5]);
      assert.equal(body.versions[1].schedule_kind, "paused");
      assert.ok(body.versions[0].effective_from < body.versions[1].effective_from);
    });
  });

  /*
   * The whole reason this endpoint exists: notes were readable one date at a
   * time and nowhere else. The cursor has to walk the record exactly once.
   */
  describe("the notes cursor", () => {
    it("pages backwards without skipping or repeating a day", async () => {
      await withApi(async ({ api }) => {
        const start = addDays(today(), -9);
        const habit = await makeHabit({ start_date: start });

        const dates = [];
        for (let offset = 0; offset < 10; offset++) {
          const date = addDays(start, offset);
          dates.push(date);
          await makeLog(habit.id, { date, status: "done", note: `day ${offset}` });
        }

        const seen = [];
        let before = "";
        let pages = 0;

        for (;;) {
          const body = await get(api, habit.id, `?limit=4${before}`);
          seen.push(...body.notes.map((note) => note.date));
          pages += 1;
          if (!body.next_before) break;
          before = `&before=${body.next_before}`;
          assert.ok(pages < 10, "the cursor must terminate");
        }

        assert.equal(pages, 3, "10 notes at 4 a page");
        assert.deepEqual(seen, [...dates].reverse(), "newest first, each day once");
      });
    });

    it("leaves out days that were logged without a note", async () => {
      await withApi(async ({ api }) => {
        const start = addDays(today(), -4);
        const habit = await makeHabit({ start_date: start });
        await makeLog(habit.id, { date: start, status: "done", note: "wrote something" });
        await makeLog(habit.id, { date: addDays(start, 1), status: "done" });
        await makeLog(habit.id, { date: addDays(start, 2), status: "missed" });

        const body = await get(api, habit.id);

        assert.equal(body.notes.length, 1);
        assert.equal(body.notes[0].note, "wrote something");
        assert.equal(body.next_before, null, "nothing older to ask for");
      });
    });

    /* A skipped or missed day can carry writing too, and often the writing that
       matters most — it is not a log of successes. */
    it("keeps notes on days that were not done", async () => {
      await withApi(async ({ api }) => {
        const habit = await makeHabit({ start_date: addDays(today(), -3) });
        await makeLog(habit.id, {
          date: addDays(today(), -1),
          status: "skipped",
          note: "ill, and that is allowed",
        });

        const body = await get(api, habit.id);
        assert.equal(body.notes[0].status, "skipped");
        assert.equal(body.notes[0].note, "ill, and that is allowed");
      });
    });
  });

  it("404s for a habit that does not exist", async () => {
    await withApi(async ({ api }) => {
      const response = await api("/api/habits/999999999/history");
      assert.equal(response.status, 404);
    });
  });

  it("rejects a malformed cursor with a 400, not a 500", async () => {
    await withApi(async ({ api }) => {
      const habit = await makeHabit();
      const response = await api(`/api/habits/${habit.id}/history?before=2026-02-31`);
      assert.equal(response.status, 400);
    });
  });
});
