/**
 * Finding and understanding the past — the flows that only exist in a browser.
 *
 * Everything the server can be held to is held to it by `npm test` in server/,
 * which is faster and needs no browser. What is here is the part above the API:
 * a result that has to open the right screen, a jump that has to move both the
 * stream and the drawing, and a comparison that has to stay silent when there
 * is nothing from a year ago to compare with.
 *
 * Fixtures go in through the API and come out again, so the suite leaves the
 * development database as it found it. Everything it writes carries the same
 * `E2E ` marker the regression suite uses, and is swept before each test rather
 * than only after: a test that exceeds its timeout is torn down mid-flight and
 * its cleanup may not finish.
 *
 *   docker compose up -d && cd web && npm run test:e2e
 */
import { expect, test, type Page } from "@playwright/test";
import { addDays, monthOf } from "../src/lib/dates";
import type { IsoDate } from "../src/types";

/** As documented in .env.example; see the regression suite's note on this. */
const PASSWORD = "dev-password-change-me";

const PREFIX = "E2E ";

/**
 * A word that appears nowhere in a real record, put into every fixture so one
 * search reaches all four sources at once. It is also what the sweep recognises
 * journal entries by — a journal row has no name to prefix.
 */
const TOKEN = "zarquon";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function api<T>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const response = await page.request.fetch(`/api${path}`, {
    method,
    ...(data === undefined ? {} : { data }),
  });
  expect(response.ok(), `${method} ${path} answered ${response.status()}`).toBeTruthy();
  return response.status() === 204 ? (undefined as T) : ((await response.json()) as T);
}

const signedIn = (page: Page) => page.getByRole("link", { name: "Pattern", exact: true });

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    signedIn(page),
    "could not sign in — is the API up, and does .env still use the password in PASSWORD above?",
  ).toBeVisible();
  await sweep(page);
}

/** The server's today, in APP_TIMEZONE — never the runner's clock. */
const serverToday = (page: Page) =>
  api<{ today: IsoDate }>(page, "GET", "/tasks").then((body) => body.today);

type Export = {
  habits: { id: string; name: string }[];
  habit_logs: { habit_id: string; date: IsoDate }[];
  journal: { date: IsoDate; kind: "day" | "month"; entry: string }[];
  leetcode_problems: { id: string; title: string }[];
};

/** The export is the one read that carries every table, which is what a sweep needs. */
async function sweep(page: Page) {
  const data = await api<Export>(page, "GET", "/export");

  for (const habit of data.habits.filter((row) => row.name.startsWith(PREFIX))) {
    // Logs cascade on delete, so they go first — a habit with any left is a 409.
    for (const log of data.habit_logs.filter((row) => row.habit_id === habit.id)) {
      await page.request.fetch(`/api/habits/${habit.id}/logs/${log.date}`, { method: "DELETE" });
    }
    await page.request.fetch(`/api/habits/${habit.id}`, { method: "DELETE" });
  }

  for (const entry of data.journal.filter((row) => row.entry.startsWith(PREFIX))) {
    const path =
      entry.kind === "month"
        ? `/api/journal/month/${monthOf(entry.date)}`
        : `/api/journal/day/${entry.date}`;
    await page.request.fetch(path, { method: "DELETE" });
  }

  for (const problem of data.leetcode_problems.filter((row) => row.title.startsWith(PREFIX))) {
    // A problem with notes on it refuses to delete, so its record is cleared
    // first — the fixture below writes an approach.
    await page.request.fetch(`/api/leetcode/${problem.id}`, {
      method: "PATCH",
      data: { approach: null, solution: null },
    });
    await page.request.fetch(`/api/leetcode/${problem.id}`, { method: "DELETE" });
  }
}

/**
 * One of everything the search reaches, all carrying TOKEN.
 *
 * Dated well back from today so nothing lands on a day the person using this
 * database has actually written on, and so the habit spans more than one year —
 * which is what makes the history screen offer its year chips at all.
 */
async function seedRecord(page: Page) {
  const today = await serverToday(page);
  const noteOn = addDays(today, -40);
  const wroteOn = addDays(today, -41);
  const solvedOn = addDays(today, -42);

  const { habit } = await api<{ habit: { id: string } }>(page, "POST", "/habits", {
    name: `${PREFIX}findable`,
    color_token: "chart-2",
    start_date: addDays(today, -400),
    schedule: { schedule_kind: "fixed", schedule_days: [1, 2, 3, 4, 5, 6, 7] },
  });

  await api(page, "PUT", `/habits/${habit.id}/logs/${noteOn}`, {
    status: "done",
    note: `${PREFIX}the ${TOKEN} was in my knee again`,
  });

  await api(page, "PUT", `/journal/day/${wroteOn}`, {
    entry: `${PREFIX}a day with a ${TOKEN} in it`,
  });

  await api(page, "PUT", `/journal/month/${monthOf(wroteOn)}`, {
    entry: `${PREFIX}a month of ${TOKEN}`,
  });

  const { problem } = await api<{ problem: { id: string } }>(page, "POST", "/leetcode", {
    title: `${PREFIX}${TOKEN} traversal`,
    difficulty: "medium",
    topics: ["graphs"],
    solved_on: solvedOn,
    approach: `${PREFIX}walked the ${TOKEN} depth first`,
  });

  return { today, habitId: habit.id, problemId: problem.id, noteOn, wroteOn, solvedOn };
}

/** The Find screen's box, with a search already typed into it. */
async function searchFor(page: Page, query: string) {
  await page.goto("/search");
  await page.getByLabel("Search", { exact: true }).fill(query);
}

// ---------------------------------------------------------------------------
// Find
// ---------------------------------------------------------------------------

test("the empty state says what is searched, rather than showing nothing", async ({ page }) => {
  await signIn(page);
  await page.goto("/search");

  await expect(page.getByRole("heading", { name: "Find", level: 1 })).toBeVisible();
  await expect(page.getByText("Day entries, habit notes, monthly reflections")).toBeVisible();
  await expect(page.getByRole("list")).toHaveCount(0);

  // One character is not a search, and the screen has to say so rather than
  // firing a request that would match most of the record.
  await page.getByLabel("Search", { exact: true }).fill("a");
  await expect(page.getByText("Type at least 2 characters")).toBeVisible();
});

test("one search reaches journal, habit notes, reflections and problems at once", async ({
  page,
}) => {
  await signIn(page);
  await seedRecord(page);

  try {
    await searchFor(page, TOKEN);

    const results = page.getByRole("listitem");
    await expect(results).toHaveCount(4);

    // Each row says what it is. Four kinds that all look like a date and a
    // sentence is the pile this screen exists to replace.
    for (const kind of ["Day entry", "Habit note", "Reflection", "Problem"]) {
      await expect(page.getByText(kind, { exact: false }).first()).toBeVisible();
    }

    // Newest first, whatever table each came from: the note is the most recent
    // fixture, then the day entry, then the solve.
    await expect(results.first()).toContainText("Habit note");
  } finally {
    await sweep(page);
  }
});

test("a result opens the screen its thing actually lives on", async ({ page }) => {
  await signIn(page);
  const seeded = await seedRecord(page);

  try {
    // A day entry goes to its day.
    await searchFor(page, TOKEN);
    await page.getByRole("listitem").filter({ hasText: "Day entry" }).getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/day/${seeded.wroteOn}$`));
    await expect(page.getByText(`${PREFIX}a day with a ${TOKEN} in it`)).toBeVisible();

    // A habit note goes to its day too — that is where the note is editable.
    await searchFor(page, TOKEN);
    await page.getByRole("listitem").filter({ hasText: "Habit note" }).getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/day/${seeded.noteOn}$`));
    await expect(page.getByText(`${PREFIX}the ${TOKEN} was in my knee again`)).toBeVisible();

    // A problem goes to the workspace, with that problem open.
    await searchFor(page, TOKEN);
    await page.getByRole("listitem").filter({ hasText: "Problem" }).getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/leetcode/${seeded.problemId}$`));
    await expect(page.getByText(`${PREFIX}${TOKEN} traversal`).first()).toBeVisible();

    // And a reflection goes to the review of its month, which is the only
    // screen that can show one.
    await searchFor(page, TOKEN);
    await page.getByRole("listitem").filter({ hasText: "Reflection" }).getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/review/${monthOf(seeded.wroteOn)}$`));
  } finally {
    await sweep(page);
  }
});

test("the query is in the URL, so Back returns to the results", async ({ page }) => {
  await signIn(page);
  const seeded = await seedRecord(page);

  try {
    await searchFor(page, TOKEN);
    await expect(page).toHaveURL(new RegExp(`\\?q=${TOKEN}$`));

    await page.getByRole("listitem").filter({ hasText: "Day entry" }).getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/day/${seeded.wroteOn}$`));

    await page.goBack();
    await expect(page.getByRole("listitem")).toHaveCount(4);
  } finally {
    await sweep(page);
  }
});

// ---------------------------------------------------------------------------
// Getting back into a long history
// ---------------------------------------------------------------------------

/**
 * A habit with a year behind it had one way back to its first month: press
 * Older until you got there. The jump has to move what is being READ, which
 * means the stream and the sheet both — a screen that says it went to last year
 * while the drawing still shows this week is giving two answers to one question.
 */
test("the habit history can jump to an old date without pressing Older", async ({ page }) => {
  await signIn(page);
  const today = await serverToday(page);
  const old = addDays(today, -300);
  const recent = addDays(today, -3);

  const { habit } = await api<{ habit: { id: string } }>(page, "POST", "/habits", {
    name: `${PREFIX}long runner`,
    color_token: "chart-3",
    start_date: addDays(today, -400),
    schedule: { schedule_kind: "fixed", schedule_days: [1, 2, 3, 4, 5, 6, 7] },
  });

  try {
    await api(page, "PUT", `/habits/${habit.id}/logs/${old}`, {
      status: "done",
      note: `${PREFIX}a note from long ago`,
    });
    await api(page, "PUT", `/habits/${habit.id}/logs/${recent}`, {
      status: "done",
      note: `${PREFIX}a note from this week`,
    });

    await page.goto(`/habits/${habit.id}`);
    const stream = page.getByRole("region", { name: "What happened" });
    // The record reads backwards, so the newest writing leads. Both notes fit
    // on one page here — what the jump changes is where the reading STARTS.
    await expect(stream.getByRole("listitem").first()).toContainText("a note from this week");

    // The date field is the precise way in, and it is a native input.
    await page.getByLabel("Or a date").fill(old);
    await expect(stream).toContainText("a note from long ago");
    await expect(stream).not.toContainText("a note from this week");
    await expect(page.getByText("Reading back from")).toBeVisible();

    // It survives a reload, because it is in the URL.
    await expect(page).toHaveURL(new RegExp(`\\?on=${old}$`));
    await page.reload();
    await expect(stream).toContainText("a note from long ago");

    // And "latest" is the way back.
    await page.getByRole("button", { name: "latest" }).click();
    await expect(stream).toContainText("a note from this week");
  } finally {
    await page.request.fetch(`/api/habits/${habit.id}/logs/${old}`, { method: "DELETE" });
    await page.request.fetch(`/api/habits/${habit.id}/logs/${recent}`, { method: "DELETE" });
    await page.request.fetch(`/api/habits/${habit.id}`, { method: "DELETE" });
  }
});

test("a habit spanning more than a year offers its years as one tap each", async ({ page }) => {
  await signIn(page);
  const today = await serverToday(page);

  const { habit } = await api<{ habit: { id: string } }>(page, "POST", "/habits", {
    name: `${PREFIX}two year habit`,
    color_token: "chart-4",
    start_date: addDays(today, -400),
    schedule: { schedule_kind: "fixed", schedule_days: [1, 2, 3, 4, 5, 6, 7] },
  });

  try {
    await page.goto(`/habits/${habit.id}`);

    const lastYear = Number(addDays(today, -400).slice(0, 4));
    const group = page.getByRole("group", { name: "Jump to a year" });
    await expect(group).toBeVisible();

    await group.getByLabel(`Jump to the end of ${lastYear}`).click({ force: true });
    await expect(page).toHaveURL(new RegExp(`\\?on=${lastYear}-12-31$`));
    await expect(page.getByText("Reading back from")).toBeVisible();
  } finally {
    await page.request.fetch(`/api/habits/${habit.id}`, { method: "DELETE" });
  }
});

// ---------------------------------------------------------------------------
// The same month, a year apart
// ---------------------------------------------------------------------------

test("the review compares with last year only when there is a last year", async ({ page }) => {
  await signIn(page);
  const today = await serverToday(page);
  const month = monthOf(today);
  const yearAgo = `${Number(month.slice(0, 4)) - 1}-${month.slice(5)}`;
  const yearAgoDay = `${yearAgo}-15`;

  try {
    await sweep(page);
    await page.goto(`/review/${month}`);
    // Nothing is claimed about a year with no record in it: a column of zeroes
    // reads as a year that went badly, which is not what no data means.
    await expect(page.getByRole("heading", { name: "A year ago" })).toHaveCount(0);

    await api(page, "PUT", `/journal/day/${yearAgoDay}`, {
      entry: `${PREFIX}something happened last year`,
    });

    await page.goto(`/review/${month}`);
    const section = page.getByRole("region", { name: "A year ago" });
    await expect(section).toBeVisible();
    await expect(section).toContainText("days written");
    await expect(section).toContainText(yearAgo.slice(0, 4));

    // Counts, and nothing that grades them. No arrow, no percentage, no word
    // saying which year was better.
    await expect(section).not.toContainText("%");
    await expect(section).not.toContainText("better");
    await expect(section).not.toContainText("worse");
  } finally {
    await page.request.fetch(`/api/journal/day/${yearAgoDay}`, { method: "DELETE" });
  }
});

// ---------------------------------------------------------------------------
// Reading the record across years
// ---------------------------------------------------------------------------

test("Pattern offers multi-year ranges on a wide screen, and draws one", async ({ page }) => {
  await signIn(page);
  const today = await serverToday(page);

  const { habit } = await api<{ habit: { id: string } }>(page, "POST", "/habits", {
    name: `${PREFIX}long record`,
    color_token: "chart-5",
    start_date: addDays(today, -800),
    schedule: { schedule_kind: "fixed", schedule_days: [1, 2, 3, 4, 5, 6, 7] },
  });

  try {
    await page.goto("/grid?weeks=261");
    const block = page.locator("section", { hasText: `${PREFIX}long record` }).first();
    await expect(block).toBeVisible();

    // The range switch reads the URL, so a linked range is the selected one.
    await expect(page.getByRole("group", { name: "Range" })).toContainText("5y");
    await expect(page.getByLabel("Last 5 years")).toBeChecked();

    // The sheet is a scroller, which is the whole reason a five-year range can
    // exist: the columns get further away, never smaller.
    const scroller = page.locator("div.overflow-x-auto").first();
    const overflow = await scroller.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    );
    expect(overflow, "five years must be wider than the viewport").toBeGreaterThan(0);

    // The long ranges are desktop ones — below md the squares stop resolving,
    // so the chip is not offered rather than offered and unreadable.
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto("/grid?weeks=12");
    await expect(page.getByLabel("Last 5 years")).toBeHidden();
  } finally {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.request.fetch(`/api/habits/${habit.id}`, { method: "DELETE" });
  }
});
