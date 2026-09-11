/**
 * Journal routes.
 *
 * The interesting rule is that there is no such thing as an empty entry:
 * journal_entry_not_blank makes one unstorable, so clearing the box has to mean
 * DELETE. The other is that a daily and a monthly entry can share the 1st of a
 * month without colliding.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { withApi } from "./helpers/api.js";
import { closePool } from "./helpers/db.js";

after(closePool);

const DATE = "2026-01-05";
const MONTH = "2026-01";

describe("daily entries", () => {
  it("saves, reads back and overwrites", async () => {
    await withApi(async ({ api }) => {
      const saved = await api(`/api/journal/day/${DATE}`, {
        method: "PUT",
        body: { entry: "Good day. Ran early." },
      });
      assert.equal(saved.status, 200);
      assert.equal((await saved.json()).entry.entry, "Good day. Ran early.");

      const read = await (await api(`/api/journal/day/${DATE}`)).json();
      assert.equal(read.entry.entry, "Good day. Ran early.");
      assert.equal(read.entry.kind, "day");
      assert.equal(read.entry.date, DATE);

      await api(`/api/journal/day/${DATE}`, { method: "PUT", body: { entry: "Rewritten." } });
      const again = await (await api(`/api/journal/day/${DATE}`)).json();
      assert.equal(again.entry.entry, "Rewritten.");
    });
  });

  it("returns null for a day never written", async () => {
    await withApi(async ({ api }) => {
      const response = await api(`/api/journal/day/${DATE}`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).entry, null);
    });
  });

  /** Clearing the box is a delete, because a blank entry cannot be stored. */
  it("clears an entry, idempotently", async () => {
    await withApi(async ({ api }) => {
      await api(`/api/journal/day/${DATE}`, { method: "PUT", body: { entry: "Something." } });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await api(`/api/journal/day/${DATE}`, { method: "DELETE" });
        assert.equal(response.status, 204, `attempt ${attempt + 1}`);
      }

      assert.equal((await (await api(`/api/journal/day/${DATE}`)).json()).entry, null);
    });
  });

  it("rejects a blank entry with 400 rather than a constraint violation", async () => {
    await withApi(async ({ api }) => {
      for (const entry of ["", "   ", "\n\t "]) {
        const response = await api(`/api/journal/day/${DATE}`, { method: "PUT", body: { entry } });
        assert.equal(response.status, 400, JSON.stringify(entry));
        assert.equal((await response.json()).error, "Invalid request");
      }
    });
  });

  it("trims what it stores", async () => {
    await withApi(async ({ api }) => {
      const response = await api(`/api/journal/day/${DATE}`, {
        method: "PUT",
        body: { entry: "  Padded.  " },
      });
      assert.equal((await response.json()).entry.entry, "Padded.");
    });
  });

  it("rejects an impossible date", async () => {
    await withApi(async ({ api }) => {
      const response = await api("/api/journal/day/2026-02-31", {
        method: "PUT",
        body: { entry: "Never happened." },
      });
      assert.equal(response.status, 400);
    });
  });
});

describe("monthly entries", () => {
  it("anchors to the first of the month", async () => {
    await withApi(async ({ api }) => {
      const saved = await api(`/api/journal/month/${MONTH}`, {
        method: "PUT",
        body: { entry: "A consistent month." },
      });

      const entry = (await saved.json()).entry;
      assert.equal(entry.date, "2026-01-01", "monthly entries live on the 1st");
      assert.equal(entry.kind, "month");
    });
  });

  /** Both kinds share (date, kind), so the 1st can hold one of each. */
  it("coexists with a daily entry on the same first of the month", async () => {
    await withApi(async ({ api }) => {
      await api("/api/journal/day/2026-01-01", { method: "PUT", body: { entry: "New year." } });
      await api(`/api/journal/month/${MONTH}`, { method: "PUT", body: { entry: "Month ahead." } });

      const day = await (await api("/api/journal/day/2026-01-01")).json();
      const month = await (await api(`/api/journal/month/${MONTH}`)).json();

      assert.equal(day.entry.entry, "New year.");
      assert.equal(month.entry.entry, "Month ahead.");
    });
  });

  it("clears independently of the daily entry", async () => {
    await withApi(async ({ api }) => {
      await api("/api/journal/day/2026-01-01", { method: "PUT", body: { entry: "New year." } });
      await api(`/api/journal/month/${MONTH}`, { method: "PUT", body: { entry: "Month ahead." } });

      await api(`/api/journal/month/${MONTH}`, { method: "DELETE" });

      assert.equal((await (await api(`/api/journal/month/${MONTH}`)).json()).entry, null);
      assert.ok((await (await api("/api/journal/day/2026-01-01")).json()).entry, "day survives");
    });
  });

  it("rejects a malformed month", async () => {
    await withApi(async ({ api }) => {
      for (const month of ["2026-13", "2026-1", "2026", "2026-01-01"]) {
        const response = await api(`/api/journal/month/${month}`, {
          method: "PUT",
          body: { entry: "x" },
        });
        assert.equal(response.status, 400, month);
      }
    });
  });
});

describe("the auth boundary", () => {
  it("refuses journal routes without a session", async () => {
    await withApi(async ({ request }) => {
      for (const [method, path] of [
        ["GET", `/api/journal/day/${DATE}`],
        ["PUT", `/api/journal/day/${DATE}`],
        ["DELETE", `/api/journal/day/${DATE}`],
        ["GET", `/api/journal/month/${MONTH}`],
        ["PUT", `/api/journal/month/${MONTH}`],
      ]) {
        assert.equal((await request(path, { method })).status, 401, `${method} ${path}`);
      }
    });
  });
});
