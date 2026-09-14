/**
 * Task routes.
 *
 * The decisions worth pinning here: there is no hard delete, an archived task
 * disappears from every list including overdue, and nothing ever rewrites a due
 * date behind the user's back.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { config } from "../src/config/index.js";
import { addDays, today, todayIn } from "../src/lib/dates.js";
import { withApi } from "./helpers/api.js";
import { closePool, makeTask } from "./helpers/db.js";

after(closePool);

async function create(api, body) {
  const response = await api("/api/tasks", { method: "POST", body });
  assert.equal(response.status, 201, "task creation should succeed");
  return (await response.json()).task;
}

const list = async (api, query = "") => (await (await api(`/api/tasks${query}`)).json()).tasks;

describe("creating a task", () => {
  it("stores a title and an optional due date", async () => {
    await withApi(async ({ api }) => {
      const dated = await create(api, { title: "Call Mum", due_date: "2026-01-05" });
      assert.equal(dated.title, "Call Mum");
      assert.equal(dated.due_date, "2026-01-05");
      assert.equal(dated.completed, false);
      assert.equal(dated.completed_at, null);

      const undated = await create(api, { title: "Plan weekend trip" });
      assert.equal(undated.due_date, null, "a someday task has no due date");
    });
  });

  it("trims the title and rejects an empty one", async () => {
    await withApi(async ({ api }) => {
      assert.equal((await create(api, { title: "  Tidy up  " })).title, "Tidy up");

      for (const body of [{ title: "   " }, { title: "" }, {}, { title: "x".repeat(201) }]) {
        const response = await api("/api/tasks", { method: "POST", body });
        assert.equal(response.status, 400, JSON.stringify(body));
      }
    });
  });

  it("rejects an impossible due date", async () => {
    await withApi(async ({ api }) => {
      const response = await api("/api/tasks", {
        method: "POST",
        body: { title: "Whenever", due_date: "2026-02-31" },
      });
      assert.equal(response.status, 400);
    });
  });
});

describe("listing tasks", () => {
  it("shows open tasks by default and completed ones on request", async () => {
    await withApi(async ({ api }) => {
      const open = await create(api, { title: "Open" });
      const done = await create(api, { title: "Done" });
      await api(`/api/tasks/${done.id}`, { method: "PATCH", body: { completed: true } });

      assert.deepEqual(
        (await list(api)).map((task) => task.title),
        ["Open"],
      );
      assert.equal((await list(api, "?scope=all")).length, 2);
      assert.equal(open.id !== done.id, true);
    });
  });

  it("rejects an unknown scope", async () => {
    await withApi(async ({ api }) => {
      assert.equal((await api("/api/tasks?scope=everything")).status, 400);
    });
  });
});

describe("updating a task", () => {
  it("completes and uncompletes, keeping completed_at consistent", async () => {
    await withApi(async ({ api }) => {
      const task = await create(api, { title: "Renew membership" });

      const completed = await api(`/api/tasks/${task.id}`, {
        method: "PATCH",
        body: { completed: true },
      });
      const done = (await completed.json()).task;
      assert.equal(done.completed, true);
      assert.ok(done.completed_at, "completed_at must be set with completed");

      const reopened = await api(`/api/tasks/${task.id}`, {
        method: "PATCH",
        body: { completed: false },
      });
      const open = (await reopened.json()).task;
      assert.equal(open.completed, false);
      assert.equal(open.completed_at, null, "and cleared with it");
    });
  });

  it("keeps the original completion moment when completed again", async () => {
    await withApi(async ({ api }) => {
      const task = await create(api, { title: "Twice" });
      const first = await api(`/api/tasks/${task.id}`, {
        method: "PATCH",
        body: { completed: true },
      });
      const firstAt = (await first.json()).task.completed_at;

      const again = await api(`/api/tasks/${task.id}`, {
        method: "PATCH",
        body: { completed: true },
      });
      assert.equal((await again.json()).task.completed_at, firstAt);
    });
  });

  /** COALESCE alone cannot tell "leave it alone" from "clear it", hence the flag. */
  it("distinguishes an omitted due date from an explicit null", async () => {
    await withApi(async ({ api }) => {
      const task = await create(api, { title: "Dated", due_date: "2026-01-05" });

      const renamed = await api(`/api/tasks/${task.id}`, {
        method: "PATCH",
        body: { title: "Renamed" },
      });
      assert.equal((await renamed.json()).task.due_date, "2026-01-05", "omitted leaves it alone");

      const cleared = await api(`/api/tasks/${task.id}`, {
        method: "PATCH",
        body: { due_date: null },
      });
      assert.equal((await cleared.json()).task.due_date, null, "explicit null clears it");
    });
  });

  it("rejects an empty patch and an unknown task", async () => {
    await withApi(async ({ api }) => {
      const task = await create(api, { title: "Something" });
      assert.equal((await api(`/api/tasks/${task.id}`, { method: "PATCH", body: {} })).status, 400);
      assert.equal(
        (await api("/api/tasks/999999", { method: "PATCH", body: { title: "x" } })).status,
        404,
      );
    });
  });
});

/**
 * Archiving is the only way to remove a task. The schema carries archived_at and
 * the partial index on open tasks says nothing about it, so every read has to
 * filter it explicitly or an archived task haunts the overdue list for ever.
 */
describe("archiving a task", () => {
  it("has no DELETE route at all", async () => {
    await withApi(async ({ api }) => {
      const task = await create(api, { title: "Not deletable" });
      const response = await api(`/api/tasks/${task.id}`, { method: "DELETE" });
      assert.ok(response.status === 404 || response.status === 405, `got ${response.status}`);

      assert.equal((await list(api)).length, 1, "the task must survive");
    });
  });

  it("hides an archived task from the working lists", async () => {
    await withApi(async ({ api }) => {
      const task = await create(api, { title: "Cancelled" });
      await api(`/api/tasks/${task.id}`, { method: "PATCH", body: { archived: true } });

      assert.equal((await list(api)).length, 0, "open list");
      assert.equal((await list(api, "?scope=all")).length, 0, "all list");
    });
  });

  /**
   * The recovery path. Without it archiving is one-way from the interface's
   * point of view: PATCH { archived: false } works, but nothing hands back the
   * id to send it for, so a task removed and then navigated away from exists
   * only in the export.
   */
  it("lists archived tasks under scope=archived, and only those", async () => {
    await withApi(async ({ api }) => {
      const kept = await create(api, { title: "Still here" });
      const removed = await create(api, { title: "Removed" });
      await api(`/api/tasks/${removed.id}`, { method: "PATCH", body: { archived: true } });

      const archived = await list(api, "?scope=archived");
      assert.deepEqual(
        archived.map((task) => task.title),
        ["Removed"],
      );
      assert.ok(archived[0].archived_at !== null, "the row carries when it was removed");

      // The working lists are untouched by the new scope.
      assert.deepEqual(
        (await list(api)).map((task) => task.id),
        [kept.id],
      );
    });
  });

  it("includes a completed task in scope=archived", async () => {
    await withApi(async ({ api }) => {
      const task = await create(api, { title: "Done then removed" });
      await api(`/api/tasks/${task.id}`, { method: "PATCH", body: { completed: true } });
      await api(`/api/tasks/${task.id}`, { method: "PATCH", body: { archived: true } });

      const archived = await list(api, "?scope=archived");
      assert.equal(archived.length, 1, "completion must not hide it from recovery");
      assert.equal(archived[0].completed, true);
    });
  });

  /**
   * Most recently removed first — a recovery list is read from the top.
   *
   * The timestamps are written by the fixture, not by archiving through the
   * API. now() is transaction start time, and this harness runs each test
   * inside one transaction, so two PATCHes here would stamp the *same*
   * archived_at and this would silently be testing the id tiebreak instead.
   */
  it("orders archived tasks by when they were removed, newest first", async () => {
    await withApi(async ({ api }) => {
      await makeTask({ title: "Removed in January", archived_at: "2026-01-05T09:00:00Z" });
      await makeTask({ title: "Removed in March", archived_at: "2026-03-22T09:00:00Z" });
      await makeTask({ title: "Removed in February", archived_at: "2026-02-11T09:00:00Z" });

      assert.deepEqual(
        (await list(api, "?scope=archived")).map((task) => task.title),
        ["Removed in March", "Removed in February", "Removed in January"],
      );
    });
  });

  /**
   * archived_at is an instant; archived_on is the calendar day it fell on, and
   * which day that is depends on the zone the app lives in. 23:30Z is still the
   * 22nd in UTC and already the 23rd in Asia/Kolkata, so a client that sliced
   * the instant's own ISO string would label this removal a day early for
   * everyone living east of Greenwich.
   */
  it("reports archived_on as the day the removal fell on in APP_TIMEZONE", async () => {
    const original = config.timezone;
    try {
      await withApi(async ({ api }) => {
        await makeTask({ title: "Removed late", archived_at: "2026-03-22T23:30:00Z" });

        config.timezone = "Asia/Kolkata"; // UTC+05:30 — 05:00 on the 23rd
        assert.equal((await list(api, "?scope=archived"))[0].archived_on, "2026-03-23");

        config.timezone = "Etc/UTC";
        assert.equal((await list(api, "?scope=archived"))[0].archived_on, "2026-03-22");
      });
    } finally {
      config.timezone = original;
    }
  });

  /**
   * Two removals in the same instant still need a stable order, or the list
   * reshuffles between reads. Newest id first keeps it consistent with the
   * timestamp ordering above.
   */
  it("breaks a same-instant tie by id, newest first", async () => {
    await withApi(async ({ api }) => {
      const at = "2026-04-01T12:00:00Z";
      await makeTask({ title: "Earlier row", archived_at: at });
      await makeTask({ title: "Later row", archived_at: at });

      assert.deepEqual(
        (await list(api, "?scope=archived")).map((task) => task.title),
        ["Later row", "Earlier row"],
      );
    });
  });

  it("restores a task listed under scope=archived", async () => {
    await withApi(async ({ api }) => {
      const task = await create(api, { title: "Fished back out" });
      await api(`/api/tasks/${task.id}`, { method: "PATCH", body: { archived: true } });

      // Exactly what the screen does: read the id from the archived list, then
      // send it back. Nothing else is needed to recover a removal.
      const [found] = await list(api, "?scope=archived");
      await api(`/api/tasks/${found.id}`, { method: "PATCH", body: { archived: false } });

      assert.deepEqual(
        (await list(api)).map((row) => row.title),
        ["Fished back out"],
      );
      assert.equal(
        (await list(api, "?scope=archived")).length,
        0,
        "and it leaves the removed list",
      );
    });
  });

  /** The bug the archived_at filter exists to prevent. */
  it("keeps an archived overdue task out of the day screen", async () => {
    await withApi(async ({ api }) => {
      const task = await create(api, { title: "Long abandoned", due_date: addDays(today(), -40) });

      const before = await (await api(`/api/day/${today()}`)).json();
      assert.equal(before.tasks.overdue.length, 1, "it is overdue before archiving");

      await api(`/api/tasks/${task.id}`, { method: "PATCH", body: { archived: true } });

      const after = await (await api(`/api/day/${today()}`)).json();
      assert.equal(after.tasks.overdue.length, 0, "and gone after");
    });
  });

  it("can be unarchived", async () => {
    await withApi(async ({ api }) => {
      const task = await create(api, { title: "Back again" });
      await api(`/api/tasks/${task.id}`, { method: "PATCH", body: { archived: true } });
      await api(`/api/tasks/${task.id}`, { method: "PATCH", body: { archived: false } });

      assert.equal((await list(api)).length, 1);
    });
  });
});

/**
 * A due date is only overdue relative to a current date, so the list has to say
 * which one it was graded against — otherwise the client picks, and a phone in
 * another zone files a task due today under "Overdue" while /day still calls it
 * due. Same reason /day and /grid carry it.
 */
describe("the today the tasks list is graded against", () => {
  it("rides along on every scope", async () => {
    await withApi(async ({ api }) => {
      for (const scope of ["", "?scope=all", "?scope=archived"]) {
        const payload = await (await api(`/api/tasks${scope}`)).json();
        assert.equal(payload.today, today(), `scope "${scope || "open"}"`);
      }
    });
  });

  /**
   * The container runs UTC, so a server-clock "today" would pass a naive test
   * and still be wrong for part of every day anywhere else. These two zones are
   * 26 hours apart and therefore never on the same date as each other, which is
   * what makes the assertion independent of when the suite happens to run.
   *
   * config is mutated rather than process.env: it is a boot-time snapshot, and
   * today() reads config.timezone at call time.
   */
  it("follows APP_TIMEZONE and not the process clock", async () => {
    const original = config.timezone;
    try {
      await withApi(async ({ api }) => {
        config.timezone = "Pacific/Kiritimati"; // UTC+14
        const ahead = (await (await api("/api/tasks")).json()).today;

        config.timezone = "Etc/GMT+12"; // UTC-12
        const behind = (await (await api("/api/tasks")).json()).today;

        assert.equal(ahead, todayIn("Pacific/Kiritimati"));
        assert.equal(behind, todayIn("Etc/GMT+12"));
        assert.notEqual(ahead, behind, "26 hours apart: these can never be the same date");
      });
    } finally {
      config.timezone = original;
    }
  });

  /**
   * The grouping the payload exists to drive. Overdue is strictly before today
   * and "due today" is not overdue — the boundary the whole fix turns on.
   */
  it("puts the boundary where the screen groups on it", async () => {
    await withApi(async ({ api }) => {
      const now = today();
      await create(api, { title: "Yesterday", due_date: addDays(now, -1) });
      await create(api, { title: "Today", due_date: now });
      await create(api, { title: "Tomorrow", due_date: addDays(now, 1) });

      const { tasks, today: served } = await (await api("/api/tasks")).json();
      const overdue = tasks.filter((task) => task.due_date !== null && task.due_date < served);

      assert.deepEqual(
        overdue.map((task) => task.title),
        ["Yesterday"],
      );
    });
  });
});

describe("the auth boundary", () => {
  it("refuses task routes without a session", async () => {
    await withApi(async ({ request }) => {
      for (const [method, path] of [
        ["GET", "/api/tasks"],
        ["POST", "/api/tasks"],
        ["PATCH", "/api/tasks/1"],
      ]) {
        assert.equal((await request(path, { method })).status, 401, `${method} ${path}`);
      }
    });
  });
});
