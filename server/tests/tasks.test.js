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

import { addDays, today } from "../src/lib/dates.js";
import { withApi } from "./helpers/api.js";
import { closePool } from "./helpers/db.js";

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

  it("hides an archived task from every list", async () => {
    await withApi(async ({ api }) => {
      const task = await create(api, { title: "Cancelled" });
      await api(`/api/tasks/${task.id}`, { method: "PATCH", body: { archived: true } });

      assert.equal((await list(api)).length, 0, "open list");
      assert.equal((await list(api, "?scope=all")).length, 0, "all list");
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
