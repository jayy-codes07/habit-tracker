/**
 * The LeetCode workspace.
 *
 * The decisions worth pinning here: "needs review" is derived from two columns
 * and never stored, marking something reviewed twice does not move the date, a
 * problem that has become a record can only be archived, and a screenshot is
 * checked against its own bytes before it is stored and served back.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { today } from "../src/lib/dates.js";
import { withApi } from "./helpers/api.js";
import { closePool, makeProblem } from "./helpers/db.js";

after(closePool);

/**
 * A real 1x1 PNG, not a stub: the service checks the signature, so a buffer
 * that merely starts with the right eight bytes would pass a test that the
 * browser's own decoder would then fail.
 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Enough of a JPEG and a WebP for the signature check, which is all the server
 * reads. Named for what they are so nobody mistakes them for decodable images.
 */
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const WEBP_SIGNATURE = Buffer.concat([
  Buffer.from("RIFF", "latin1"),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from("WEBPVP8 ", "latin1"),
]);

async function create(api, body) {
  const response = await api("/api/leetcode", { method: "POST", body });
  assert.equal(response.status, 201, "problem creation should succeed");
  return (await response.json()).problem;
}

const list = async (api, query = "") =>
  (await (await api(`/api/leetcode${query}`)).json()).problems;

const detail = async (api, id) => (await (await api(`/api/leetcode/${id}`)).json()).problem;

const patch = (api, id, body) => api(`/api/leetcode/${id}`, { method: "PATCH", body });

const upload = (api, id, bytes, type) =>
  api(`/api/leetcode/${id}/screenshot`, {
    method: "PUT",
    body: bytes,
    headers: { "content-type": type },
  });

/** The queue, computed the one way the product defines it. */
const needsReview = (problems) =>
  problems.filter((problem) => problem.ai_assisted && problem.reviewed_on === null);

const SOLID = { title: "LRU Cache", difficulty: "medium" };

describe("recording a problem", () => {
  it("stores everything a solve is, and defaults the rest", async () => {
    await withApi(async ({ api }) => {
      const problem = await create(api, {
        number: 146,
        title: "LRU Cache",
        difficulty: "medium",
        topics: ["hash-table", "design"],
        url: "https://leetcode.com/problems/lru-cache/",
        solved_on: "2026-03-04",
        ai_assisted: true,
        approach: "Map to node, doubly linked list for recency.",
        solution: "class LRUCache: ...",
      });

      assert.equal(problem.number, 146);
      assert.equal(problem.title, "LRU Cache");
      assert.equal(problem.difficulty, "medium");
      assert.deepEqual(problem.topics, ["hash-table", "design"]);
      assert.equal(problem.url, "https://leetcode.com/problems/lru-cache/");
      assert.equal(problem.solved_on, "2026-03-04");
      assert.equal(problem.ai_assisted, true);
      assert.equal(problem.approach, "Map to node, doubly linked list for recency.");
      assert.equal(problem.solution, "class LRUCache: ...");
      assert.equal(problem.reviewed_on, null, "a new problem has never been reviewed");
      assert.equal(problem.screenshot_bytes, null, "and carries no screenshot yet");
    });
  });

  it("solves today, in the app's zone, when no date is given", async () => {
    await withApi(async ({ api }) => {
      const problem = await create(api, SOLID);
      assert.equal(problem.solved_on, today());
      assert.equal(problem.ai_assisted, false, "unassisted unless it says otherwise");
      assert.deepEqual(problem.topics, []);
    });
  });

  it("records a problem that has no number and no link", async () => {
    await withApi(async ({ api }) => {
      // A contest question. Both columns are genuinely optional, and an entry
      // with neither is the case that proves it.
      const problem = await create(api, {
        title: "Weekly contest — grid paths",
        difficulty: "hard",
      });
      assert.equal(problem.number, null);
      assert.equal(problem.url, null);
    });
  });

  it("normalises topics so one tag typed three ways is one tag", async () => {
    await withApi(async ({ api }) => {
      const problem = await create(api, {
        ...SOLID,
        topics: ["  Graph  ", "graph", "BFS"],
      });
      assert.deepEqual(problem.topics, ["graph", "bfs"]);
    });
  });

  it("refuses what the record cannot mean", async () => {
    await withApi(async ({ api }) => {
      const bad = [
        ["a blank title", { title: "  ", difficulty: "easy" }],
        ["no title", { difficulty: "easy" }],
        ["an over-long title", { title: "x".repeat(201), difficulty: "easy" }],
        ["no difficulty", { title: "Two Sum" }],
        ["a difficulty that is not one of three", { ...SOLID, difficulty: "expert" }],
        ["problem number zero", { ...SOLID, number: 0 }],
        ["a fractional problem number", { ...SOLID, number: 1.5 }],
        ["nine topics", { ...SOLID, topics: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] }],
        ["an over-long topic", { ...SOLID, topics: ["x".repeat(31)] }],
        ["a date that does not exist", { ...SOLID, solved_on: "2026-02-31" }],
      ];

      for (const [description, body] of bad) {
        const response = await api("/api/leetcode", { method: "POST", body });
        assert.equal(response.status, 400, description);
      }
    });
  });

  it("refuses a URL that is not somewhere you can go", async () => {
    await withApi(async ({ api }) => {
      // The one validation here that is a security control: this value is
      // rendered into an href, and a javascript: URL in one runs on click.
      for (const url of [
        "javascript:alert(1)",
        "JavaScript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "/problems/two-sum/",
        "leetcode.com/problems/two-sum/",
        // Uppercased scheme: the matching CHECK constraint is case-sensitive,
        // so the API has to be too or this is a 500 instead of a 400.
        "HTTPS://leetcode.com/problems/two-sum/",
      ]) {
        const response = await api("/api/leetcode", { method: "POST", body: { ...SOLID, url } });
        assert.equal(response.status, 400, url);
      }
    });
  });
});

describe("the working list", () => {
  it("is newest solve first, and never shows an archived problem", async () => {
    await withApi(async ({ api }) => {
      await makeProblem({ title: "Older", solved_on: "2026-01-02" });
      await makeProblem({ title: "Newest", solved_on: "2026-03-09" });
      await makeProblem({ title: "Middle", solved_on: "2026-02-14" });
      await makeProblem({ title: "Retired", solved_on: "2026-03-11", archived_at: new Date() });

      const problems = await list(api);
      assert.deepEqual(
        problems.map((problem) => problem.title),
        ["Newest", "Middle", "Older"],
      );
    });
  });

  it("leaves the long columns out of the list and keeps them on the problem", async () => {
    await withApi(async ({ api }) => {
      const created = await create(api, {
        ...SOLID,
        approach: "Two pointers from the shorter side.",
        solution: "def trap(h): ...",
      });

      const [row] = await list(api);
      assert.equal(
        Object.hasOwn(row, "approach"),
        false,
        "the index renders a title, so it must not carry a page of prose per row",
      );
      assert.equal(Object.hasOwn(row, "solution"), false);

      const full = await detail(api, created.id);
      assert.equal(full.approach, "Two pointers from the shorter side.");
      assert.equal(full.solution, "def trap(h): ...");
    });
  });

  it("carries the app's own today, so nothing is graded against a browser clock", async () => {
    await withApi(async ({ api }) => {
      const body = await (await api("/api/leetcode")).json();
      assert.equal(body.today, today());
    });
  });

  it("answers the archived scope with only archived rows, and says when", async () => {
    await withApi(async ({ api }) => {
      await makeProblem({ title: "Still here" });
      await makeProblem({ title: "Gone", archived_at: new Date() });

      const archived = await list(api, "?scope=archived");
      assert.deepEqual(
        archived.map((problem) => problem.title),
        ["Gone"],
      );
      assert.equal(
        archived[0].archived_on,
        today(),
        "the calendar day it was removed, cast in the app's zone",
      );
    });
  });

  it("rejects a scope it does not have", async () => {
    await withApi(async ({ api }) => {
      // In particular there is no scope=review: the queue is derived on the
      // client from rows the active list already carries, and a second server
      // read of the same rows is a second answer that can disagree.
      assert.equal((await api("/api/leetcode?scope=review")).status, 400);
    });
  });
});

describe("one problem", () => {
  it("is reachable by id, archived or not", async () => {
    await withApi(async ({ api }) => {
      const gone = await makeProblem({ title: "Gone", archived_at: new Date() });

      // A bookmark to an archived problem must keep working: it is the only
      // screen there is to restore one from.
      const problem = await detail(api, gone.id);
      assert.equal(problem.title, "Gone");
      assert.equal(problem.archived_on, today());
    });
  });

  it("is a 404 when it does not exist, and a 400 when the id is not one", async () => {
    await withApi(async ({ api }) => {
      assert.equal((await api("/api/leetcode/99999999")).status, 404);
      assert.equal((await api("/api/leetcode/not-an-id")).status, 400);
    });
  });
});

describe("the review queue", () => {
  it("is two facts and nothing stored", async () => {
    await withApi(async ({ api }) => {
      await makeProblem({ title: "Had help", ai_assisted: true });
      await makeProblem({ title: "Had help, went back", ai_assisted: true, reviewed_on: today() });
      await makeProblem({ title: "Solved alone" });

      assert.deepEqual(
        needsReview(await list(api)).map((problem) => problem.title),
        ["Had help"],
      );
    });
  });

  it("marks a problem reviewed on the day you went back to it", async () => {
    await withApi(async ({ api }) => {
      const problem = await makeProblem({ ai_assisted: true });

      const response = await patch(api, problem.id, { reviewed: true });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).problem.reviewed_on, today());

      assert.deepEqual(needsReview(await list(api)), [], "and it leaves the queue");
    });
  });

  it("keeps the day you first went back, however often the button is pressed", async () => {
    await withApi(async ({ api }) => {
      const problem = await makeProblem({ ai_assisted: true, reviewed_on: "2026-01-09" });

      await patch(api, problem.id, { reviewed: true });

      assert.equal(
        (await detail(api, problem.id)).reviewed_on,
        "2026-01-09",
        "the answer to when I went back over this is the first time, not the last click",
      );
    });
  });

  it("puts it back when the review is undone", async () => {
    await withApi(async ({ api }) => {
      const problem = await makeProblem({ ai_assisted: true, reviewed_on: "2026-01-09" });

      await patch(api, problem.id, { reviewed: false });

      assert.equal((await detail(api, problem.id)).reviewed_on, null);
      assert.equal(needsReview(await list(api)).length, 1, "back in the queue, not a third state");
    });
  });

  it("empties the queue when the claim of help is withdrawn", async () => {
    await withApi(async ({ api }) => {
      const problem = await makeProblem({ ai_assisted: true });

      await patch(api, problem.id, { ai_assisted: false });

      const [row] = await list(api);
      assert.equal(row.ai_assisted, false);
      assert.equal(row.reviewed_on, null, "unreviewed, and no longer waiting to be");
      assert.deepEqual(needsReview(await list(api)), []);
    });
  });

  it("lets a problem you solved alone be marked reviewed anyway", async () => {
    await withApi(async ({ api }) => {
      // Going back over a hard one you got unaided is a real thing to do. The
      // queue is what ai_assisted drives; reviewed_on is just a fact.
      const problem = await makeProblem({ ai_assisted: false });
      await patch(api, problem.id, { reviewed: true });
      assert.equal((await detail(api, problem.id)).reviewed_on, today());
    });
  });
});

describe("editing a problem", () => {
  it("changes only what was sent", async () => {
    await withApi(async ({ api }) => {
      const problem = await create(api, {
        ...SOLID,
        number: 146,
        topics: ["design"],
        approach: "First pass.",
      });

      await patch(api, problem.id, { approach: "Second pass, with the sentinel nodes." });

      const updated = await detail(api, problem.id);
      assert.equal(updated.approach, "Second pass, with the sentinel nodes.");
      assert.equal(updated.number, 146, "untouched");
      assert.equal(updated.title, "LRU Cache", "untouched");
      assert.deepEqual(updated.topics, ["design"], "untouched");
    });
  });

  it("tells clearing a field apart from leaving it alone", async () => {
    await withApi(async ({ api }) => {
      const problem = await create(api, {
        ...SOLID,
        number: 146,
        url: "https://leetcode.com/problems/lru-cache/",
        approach: "Something.",
        solution: "Something else.",
      });

      await patch(api, problem.id, {
        number: null,
        url: null,
        approach: null,
        solution: null,
      });

      const cleared = await detail(api, problem.id);
      assert.equal(cleared.number, null);
      assert.equal(cleared.url, null);
      assert.equal(cleared.approach, null);
      assert.equal(cleared.solution, null);
      assert.equal(cleared.title, "LRU Cache", "and the fields it said nothing about are intact");
    });
  });

  it("clears every tag with an empty list, never with null", async () => {
    await withApi(async ({ api }) => {
      const problem = await create(api, { ...SOLID, topics: ["graph", "bfs"] });

      await patch(api, problem.id, { topics: [] });
      assert.deepEqual((await detail(api, problem.id)).topics, []);

      // The column is NOT NULL with a '{}' default, so null is not a way to
      // say "no tags" — it is a 400 rather than a constraint violation and a 500.
      assert.equal((await patch(api, problem.id, { topics: null })).status, 400);
    });
  });

  it("refuses an empty patch and an unknown problem", async () => {
    await withApi(async ({ api }) => {
      const problem = await makeProblem();
      assert.equal((await patch(api, problem.id, {})).status, 400);
      assert.equal((await patch(api, "99999999", { title: "Ghost" })).status, 404);
    });
  });
});

describe("archiving a problem", () => {
  it("takes it off the list without destroying it", async () => {
    await withApi(async ({ api }) => {
      const problem = await create(api, { ...SOLID, approach: "Worth keeping." });

      await patch(api, problem.id, { archived: true });

      assert.deepEqual(await list(api), [], "gone from the workspace");

      const [archived] = await list(api, "?scope=archived");
      assert.equal(archived.id, problem.id);
      assert.equal(
        (await detail(api, problem.id)).approach,
        "Worth keeping.",
        "and every word of it still there",
      );
    });
  });

  it("restores it to where it was", async () => {
    await withApi(async ({ api }) => {
      const problem = await makeProblem({ title: "Back", archived_at: new Date() });

      await patch(api, problem.id, { archived: false });

      assert.deepEqual(
        (await list(api)).map((row) => row.title),
        ["Back"],
      );
      assert.deepEqual(await list(api, "?scope=archived"), []);
    });
  });

  it("does not move the moment it was removed when archived twice", async () => {
    await withApi(async ({ api }) => {
      const at = new Date("2026-01-09T10:00:00Z");
      const problem = await makeProblem({ archived_at: at });

      await patch(api, problem.id, { archived: true });

      const [archived] = await list(api, "?scope=archived");
      assert.equal(new Date(archived.archived_at).toISOString(), at.toISOString());
    });
  });
});

describe("deleting a problem", () => {
  it("removes one that never became a record", async () => {
    await withApi(async ({ api }) => {
      const problem = await create(api, SOLID);

      const response = await api(`/api/leetcode/${problem.id}`, { method: "DELETE" });
      assert.equal(response.status, 204);

      assert.deepEqual(await list(api), []);
      assert.equal((await api(`/api/leetcode/${problem.id}`)).status, 404);
    });
  });

  it("refuses one that carries anything worth keeping", async () => {
    await withApi(async ({ api }) => {
      // The habits rule, applied to what this table records: you can delete a
      // mistake, you must archive a record.
      for (const keeper of [{ approach: "An idea." }, { solution: "def f(): ..." }]) {
        const problem = await create(api, { ...SOLID, ...keeper });
        const response = await api(`/api/leetcode/${problem.id}`, { method: "DELETE" });

        assert.equal(response.status, 409, JSON.stringify(keeper));
        assert.match((await response.json()).error, /Archive it instead/);
        assert.equal((await detail(api, problem.id)).title, "LRU Cache", "and it is still there");
      }
    });
  });

  it("refuses one that carries a screenshot, until the screenshot goes", async () => {
    await withApi(async ({ api }) => {
      const problem = await create(api, SOLID);
      await upload(api, problem.id, PNG, "image/png");

      assert.equal((await api(`/api/leetcode/${problem.id}`, { method: "DELETE" })).status, 409);

      await api(`/api/leetcode/${problem.id}/screenshot`, { method: "DELETE" });
      assert.equal((await api(`/api/leetcode/${problem.id}`, { method: "DELETE" })).status, 204);
    });
  });

  it("is a 404 for a problem that is not there", async () => {
    await withApi(async ({ api }) => {
      assert.equal((await api("/api/leetcode/99999999", { method: "DELETE" })).status, 404);
    });
  });
});

describe("the screenshot", () => {
  it("stores the bytes and serves them back as what they are", async () => {
    await withApi(async ({ api }) => {
      const problem = await create(api, SOLID);

      const put = await upload(api, problem.id, PNG, "image/png");
      assert.equal(put.status, 200);
      assert.equal((await put.json()).problem.screenshot_bytes, PNG.length);

      const response = await api(`/api/leetcode/${problem.id}/screenshot`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "image/png");
      assert.equal(response.headers.get("content-disposition"), "inline");
      assert.equal(
        response.headers.get("cache-control"),
        "private, no-cache",
        "revalidate every time: the URL does not change when the image is replaced",
      );

      const served = Buffer.from(await response.arrayBuffer());
      assert.ok(served.equals(PNG), "byte for byte what was uploaded");
    });
  });

  it("takes a JPEG and a WebP too", async () => {
    await withApi(async ({ api }) => {
      const jpeg = await create(api, SOLID);
      assert.equal((await upload(api, jpeg.id, JPEG_SIGNATURE, "image/jpeg")).status, 200);

      const webp = await create(api, SOLID);
      assert.equal((await upload(api, webp.id, WEBP_SIGNATURE, "image/webp")).status, 200);
    });
  });

  it("is a 404 until there is one", async () => {
    await withApi(async ({ api }) => {
      const problem = await create(api, SOLID);
      assert.equal((await api(`/api/leetcode/${problem.id}/screenshot`)).status, 404);
      assert.equal((await api("/api/leetcode/99999999/screenshot")).status, 404);
    });
  });

  it("replaces the one that was there", async () => {
    await withApi(async ({ api }) => {
      const problem = await create(api, SOLID);

      await upload(api, problem.id, PNG, "image/png");
      await upload(api, problem.id, JPEG_SIGNATURE, "image/jpeg");

      const response = await api(`/api/leetcode/${problem.id}/screenshot`);
      assert.equal(response.headers.get("content-type"), "image/jpeg");
      assert.equal((await detail(api, problem.id)).screenshot_bytes, JPEG_SIGNATURE.length);
    });
  });

  it("can be removed without removing the problem", async () => {
    await withApi(async ({ api }) => {
      const problem = await create(api, SOLID);
      await upload(api, problem.id, PNG, "image/png");

      const removed = await api(`/api/leetcode/${problem.id}/screenshot`, { method: "DELETE" });
      assert.equal(removed.status, 204);

      assert.equal((await api(`/api/leetcode/${problem.id}/screenshot`)).status, 404);
      assert.equal((await detail(api, problem.id)).screenshot_bytes, null);
      assert.equal((await detail(api, problem.id)).title, "LRU Cache", "the problem is untouched");
    });
  });

  it("does not believe the Content-Type over the bytes", async () => {
    await withApi(async ({ api }) => {
      const problem = await create(api, SOLID);

      // The header is a claim. This column is echoed back into a response
      // Content-Type, so a file that is not what it says it is must not be
      // stored as though it were.
      const lying = await upload(api, problem.id, JPEG_SIGNATURE, "image/png");
      assert.equal(lying.status, 400);

      const notAnImage = await upload(api, problem.id, Buffer.from("<svg/>"), "image/png");
      assert.equal(notAnImage.status, 400);

      assert.equal(
        (await detail(api, problem.id)).screenshot_bytes,
        null,
        "and nothing was written on the way to being refused",
      );
    });
  });

  it("refuses a format it will not serve, and an empty body", async () => {
    await withApi(async ({ api }) => {
      const problem = await create(api, SOLID);

      // SVG can carry script and this app serves the bytes from its own origin.
      // It is refused at the parser, before a byte is buffered.
      for (const type of ["image/svg+xml", "image/gif", "application/pdf", "text/plain"]) {
        assert.equal((await upload(api, problem.id, PNG, type)).status, 400, type);
      }

      assert.equal((await upload(api, problem.id, Buffer.alloc(0), "image/png")).status, 400);
    });
  });

  it("answers a screenshot that is too big with 413, not a 500", async () => {
    await withApi(async ({ api }) => {
      const problem = await create(api, SOLID);

      // A body-parser rejection is neither AppError nor ZodError. Without the
      // branch in error-handler.js it was logged as an unhandled bug and
      // answered 500 — an incident report for a file someone dragged in.
      const huge = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]);
      const response = await upload(api, problem.id, huge, "image/png");

      assert.equal(response.status, 413);
      assert.match((await response.json()).error, /too large/i);
    });
  });

  it("refuses an upload sent as anything but the image itself", async () => {
    await withApi(async ({ api }) => {
      const problem = await create(api, SOLID);
      const response = await api(`/api/leetcode/${problem.id}/screenshot`, {
        method: "PUT",
        body: { screenshot: PNG.toString("base64") },
      });
      assert.equal(response.status, 400);
    });
  });
});

describe("the auth boundary", () => {
  it("refuses every leetcode route without a session", async () => {
    await withApi(async ({ request }) => {
      for (const [method, path] of [
        ["GET", "/api/leetcode"],
        ["POST", "/api/leetcode"],
        ["GET", "/api/leetcode/1"],
        ["PATCH", "/api/leetcode/1"],
        ["DELETE", "/api/leetcode/1"],
        ["GET", "/api/leetcode/1/screenshot"],
        ["PUT", "/api/leetcode/1/screenshot"],
        ["DELETE", "/api/leetcode/1/screenshot"],
      ]) {
        assert.equal((await request(path, { method })).status, 401, `${method} ${path}`);
      }
    });
  });
});
