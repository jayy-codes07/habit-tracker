/**
 * The error and validation plumbing every feature route will lean on.
 *
 * Nothing in Step 4 has to invent its own failure shape: an AppError is answered
 * with its own status, a ZodError becomes a 400 naming the offending fields, and
 * anything else stays a logged, opaque 500.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import express from "express";
import { z } from "zod";

import { AppError, badRequest, conflict, notFound } from "../src/lib/errors.js";
import { errorHandler } from "../src/middleware/error-handler.js";

const bodySchema = z.object({
  name: z.string().min(1).max(80),
  weeklyTarget: z.number().int().min(1).max(7),
});

/** A throwaway app carrying only the plumbing under test. */
function buildApp() {
  const app = express();
  app.use(express.json());

  app.get("/bad-request", () => {
    throw badRequest("Schedule days are required for a fixed habit");
  });
  app.get("/not-found", () => {
    throw notFound("No such habit");
  });
  app.get("/not-found-default", () => {
    throw notFound();
  });
  app.get("/conflict", () => {
    throw conflict("That day is already logged", { date: "2026-01-05" });
  });
  app.get("/app-error-500", () => {
    throw new AppError(500, "Deliberate server-side AppError");
  });
  // Deliberately unwrapped. Express 5 forwards a rejected async handler to the
  // error middleware on its own, which is why there is no asyncHandler in this
  // codebase — controllers are plain async functions that throw.
  app.get("/async-throw", async () => {
    await Promise.resolve();
    throw notFound("Vanished mid-flight");
  });
  app.post("/validated", async (req, res) => {
    const parsed = bodySchema.parse(req.body);
    res.json({ ok: true, ...parsed });
  });
  app.get("/boom", () => {
    throw new Error("unexpected failure with a revealing message");
  });

  app.use(errorHandler);
  return app;
}

async function withServer(run) {
  const server = buildApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run((path, options) => fetch(`${base}${path}`, options));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const postJson = (body) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("AppError", () => {
  it("answers 400 with its message", async () => {
    await withServer(async (request) => {
      const response = await request("/bad-request");
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        error: "Schedule days are required for a fixed habit",
      });
    });
  });

  it("answers 404 with its message", async () => {
    await withServer(async (request) => {
      const response = await request("/not-found");
      assert.equal(response.status, 404);
      assert.equal((await response.json()).error, "No such habit");
    });
  });

  it("has a sensible default 404 message", async () => {
    await withServer(async (request) => {
      const response = await request("/not-found-default");
      assert.equal(response.status, 404);
      assert.equal((await response.json()).error, "Not found");
    });
  });

  it("merges extra fields beside the error", async () => {
    await withServer(async (request) => {
      const response = await request("/conflict");
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), {
        error: "That day is already logged",
        date: "2026-01-05",
      });
    });
  });

  it("carries a deliberate 5xx through with its own status", async () => {
    await withServer(async (request) => {
      const response = await request("/app-error-500");
      assert.equal(response.status, 500);
      assert.equal((await response.json()).error, "Deliberate server-side AppError");
    });
  });

  // Not a test of a wrapper — a test of the Express behaviour we deleted the
  // wrapper in favour of. If a future Express stopped forwarding rejections,
  // every async controller would start hanging instead of erroring, and this is
  // what would say so.
  it("is forwarded natively from an unwrapped async handler", async () => {
    await withServer(async (request) => {
      const response = await request("/async-throw");
      assert.equal(response.status, 404);
      assert.equal((await response.json()).error, "Vanished mid-flight");
    });
  });
});

describe("ZodError", () => {
  it("accepts a valid body", async () => {
    await withServer(async (request) => {
      const response = await request("/validated", postJson({ name: "Run", weeklyTarget: 3 }));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, name: "Run", weeklyTarget: 3 });
    });
  });

  it("becomes a 400 naming each offending field", async () => {
    await withServer(async (request) => {
      const response = await request("/validated", postJson({ name: "", weeklyTarget: 99 }));
      assert.equal(response.status, 400);

      const body = await response.json();
      assert.equal(body.error, "Invalid request");
      assert.deepEqual(body.issues.map((issue) => issue.path).sort(), ["name", "weeklyTarget"]);
      for (const issue of body.issues) {
        assert.equal(typeof issue.message, "string");
        assert.ok(issue.message.length > 0);
      }
    });
  });

  it("reports a missing field rather than throwing", async () => {
    await withServer(async (request) => {
      const response = await request("/validated", postJson({ name: "Run" }));
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.deepEqual(
        body.issues.map((issue) => issue.path),
        ["weeklyTarget"],
      );
    });
  });

  it("never echoes the rejected value back", async () => {
    // The guard against reflecting input: issue.input is deliberately dropped,
    // so a bad value cannot bounce off the API into a log or a page.
    await withServer(async (request) => {
      const secret = "super-secret-value-that-must-not-come-back";
      const response = await request("/validated", postJson({ name: secret, weeklyTarget: 99 }));
      const text = await response.text();
      assert.equal(response.status, 400);
      assert.ok(!text.includes(secret), "the response echoed the submitted value");
    });
  });
});

describe("unexpected errors", () => {
  it("stays an opaque 500", async () => {
    await withServer(async (request) => {
      const response = await request("/boom");
      assert.equal(response.status, 500);
      assert.equal((await response.json()).error, "Internal server error");
    });
  });
});
