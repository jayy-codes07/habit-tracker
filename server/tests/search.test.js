/**
 * Global search: four sources, one list, newest first.
 *
 * The rules worth holding this to are the ones that are easy to get wrong and
 * silent when they are: the LIKE metacharacters, the snippet that has to cut a
 * 40,000 character solution down to a line, and the fact that a monthly
 * reflection and a day entry share a table but are two different screens.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { withApi } from "./helpers/api.js";
import { closePool, makeHabit, makeJournal, makeLog, makeProblem } from "./helpers/db.js";

after(closePool);

const find = async (api, q, extra = "") => {
  const response = await api(`/api/search?q=${encodeURIComponent(q)}${extra}`);
  assert.equal(response.status, 200);
  return response.json();
};

describe("what it searches", () => {
  it("finds a day entry and links it by date", async () => {
    await withApi(async ({ api }) => {
      await makeJournal({ date: "2026-03-04", entry: "Knee felt better on the hill today." });

      const { results } = await find(api, "knee");
      assert.equal(results.length, 1);
      assert.equal(results[0].kind, "journal");
      assert.equal(results[0].date, "2026-03-04");
      assert.match(results[0].snippet, /Knee felt better/);
    });
  });

  it("tells a monthly reflection apart from a day entry", async () => {
    await withApi(async ({ api }) => {
      await makeJournal({ date: "2026-03-01", kind: "month", entry: "A quiet month of running." });
      await makeJournal({ date: "2026-03-02", kind: "day", entry: "Running again." });

      const { results } = await find(api, "running");
      assert.deepEqual(
        results.map((row) => row.kind),
        ["journal", "reflection"],
      );
    });
  });

  it("finds a habit note and names the habit it belongs to", async () => {
    await withApi(async ({ api }) => {
      const habit = await makeHabit({ name: "Morning run" });
      await makeLog(habit.id, { date: "2026-02-10", note: "Calf was tight the whole way." });

      const { results } = await find(api, "calf");
      assert.equal(results.length, 1);
      assert.equal(results[0].kind, "note");
      assert.equal(results[0].title, "Morning run");
      assert.equal(results[0].id, habit.id);
      assert.equal(results[0].date, "2026-02-10");
    });
  });

  it("finds a problem by title, approach, solution and topic", async () => {
    await withApi(async ({ api }) => {
      await makeProblem({ title: "Sliding window maximum", solved_on: "2026-01-20" });
      await makeProblem({ title: "A", approach: "monotonic deque", solved_on: "2026-01-19" });
      await makeProblem({ title: "B", solution: "def deque_solution():", solved_on: "2026-01-18" });
      await makeProblem({ title: "C", topics: ["deque", "arrays"], solved_on: "2026-01-17" });

      assert.equal((await find(api, "sliding window")).results.length, 1);

      const { results } = await find(api, "deque");
      assert.equal(results.length, 3);
      assert.ok(results.every((row) => row.kind === "problem"));
      // The topic match has no prose to quote, so the tags stand in for one.
      assert.equal(results[2].snippet, "deque, arrays");
    });
  });

  /* Archiving tidies the working list; it does not unmake the record, and the
     record is what this endpoint exists to reach. */
  it("searches archived problems and says that they are archived", async () => {
    await withApi(async ({ api }) => {
      await makeProblem({ title: "Retired trie problem", archived_at: new Date().toISOString() });

      const { results } = await find(api, "trie");
      assert.equal(results.length, 1);
      assert.equal(results[0].archived, true);
    });
  });
});

describe("how it answers", () => {
  it("interleaves every source by date, newest first", async () => {
    await withApi(async ({ api }) => {
      const habit = await makeHabit({ name: "Reading" });
      await makeJournal({ date: "2026-04-02", entry: "Found the rhythm again." });
      await makeLog(habit.id, { date: "2026-04-03", note: "Rhythm of a chapter a night." });
      await makeProblem({ title: "Rhythm", solved_on: "2026-04-01" });

      const { results } = await find(api, "rhythm");
      assert.deepEqual(
        results.map((row) => row.date),
        ["2026-04-03", "2026-04-02", "2026-04-01"],
      );
    });
  });

  /* '%' is a LIKE wildcard: unescaped, a search for "100%" matches every row
     in the table, which is the kind of failure that looks like a feature. */
  it("treats %, _ and a backslash as text rather than as wildcards", async () => {
    await withApi(async ({ api }) => {
      await makeJournal({ date: "2026-05-01", entry: "Hit 100% of the plan." });
      await makeJournal({ date: "2026-05-02", entry: "Nothing to do with numbers." });

      // A literal metacharacter still has to find the row that contains it.
      assert.equal((await find(api, "100%")).results.length, 1);
      assert.equal((await find(api, "0%")).results.length, 1);

      // Unescaped, each of these matches both rows: '%o' is "anything then o",
      // '_o' is "any character then o". Escaped, they are text that is not there.
      assert.equal((await find(api, "%o")).results.length, 0);
      assert.equal((await find(api, "_o")).results.length, 0);
      assert.equal((await find(api, "\\o")).results.length, 0);
    });
  });

  it("matches inside a word, and ignores case", async () => {
    await withApi(async ({ api }) => {
      await makeJournal({ date: "2026-06-01", entry: "Kneeling to weed the beds." });
      assert.equal((await find(api, "KNEE")).results.length, 1);
    });
  });

  it("cuts a long match down to a fragment on one line", async () => {
    await withApi(async ({ api }) => {
      const filler = "x".repeat(500);
      await makeProblem({
        title: "Long one",
        solution: `${filler}\n\n   needle   here\n\n${filler}`,
        solved_on: "2026-07-01",
      });

      const { snippet } = (await find(api, "needle")).results[0];
      assert.ok(snippet.length < 160, `snippet was ${snippet.length} characters`);
      assert.ok(snippet.startsWith("…") && snippet.endsWith("…"));
      assert.match(snippet, /needle here/);
      assert.doesNotMatch(snippet, /\n/);
    });
  });

  it("honours limit and reports that there was more", async () => {
    await withApi(async ({ api }) => {
      for (let day = 1; day <= 5; day += 1) {
        await makeJournal({ date: `2026-08-0${day}`, entry: "Same word: petrichor." });
      }

      const body = await find(api, "petrichor", "&limit=2");
      assert.equal(body.results.length, 2);
      assert.equal(body.truncated, true);
      assert.deepEqual(
        body.results.map((row) => row.date),
        ["2026-08-05", "2026-08-04"],
      );
    });
  });

  it("answers an empty list rather than a 404 when nothing matches", async () => {
    await withApi(async ({ api }) => {
      const body = await find(api, "nothingwhatsoever");
      assert.deepEqual(body.results, []);
      assert.equal(body.truncated, false);
      assert.equal(body.query, "nothingwhatsoever");
    });
  });

  it("rejects a query too short to mean anything", async () => {
    await withApi(async ({ api }) => {
      for (const q of ["", "a", "%20"]) {
        assert.equal((await api(`/api/search?q=${q}`)).status, 400, q);
      }
    });
  });

  it("needs a session", async () => {
    await withApi(async ({ request }) => {
      assert.equal((await request("/api/search?q=anything")).status, 401);
    });
  });
});
