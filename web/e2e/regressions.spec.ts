/**
 * Regressions that only a browser can catch.
 *
 * Each test below is a bug that shipped, named by what went wrong rather than
 * by the function that was changed — the point is to fail again if the
 * behaviour comes back, whatever the code looks like by then.
 *
 * Fixtures go in through the API and come out again at the end, so the suite
 * leaves the development database as it found it. They deliberately start a
 * month ago: a schedule set today and paused today collide on the same
 * effective_from, where the server's upsert replaces the first version outright.
 *
 *   docker compose up -d && cd web && npm run test:e2e
 */
import { expect, test, type Page } from "@playwright/test";
import { addDays } from "../src/lib/dates";
import type { IsoDate, ScheduleInput } from "../src/types";

/**
 * The throwaway development password, as .env.example documents it. If your
 * .env carries a different AUTH_PASSWORD_HASH, change this line — signIn()
 * fails with a message saying so rather than leaving you to guess.
 */
const PASSWORD = "dev-password-change-me";

const TUE_THU: ScheduleInput = { schedule_kind: "fixed", schedule_days: [2, 4] };

/** Every fixture habit is named with this, so a sweep can recognise its own. */
const PREFIX = "E2E ";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** The tab that only exists once a session does. */
const signedIn = (page: Page) => page.getByRole("link", { name: "Grid" });

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    signedIn(page),
    `could not sign in — is the API up, and does .env still use the password in PASSWORD above?`,
  ).toBeVisible();
  await sweepFixtures(page);
}

/** page.request shares the browser's cookie jar, so this rides the UI session. */
async function api<T>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const response = await page.request.fetch(`/api${path}`, {
    method,
    ...(data === undefined ? {} : { data }),
  });
  expect(response.ok(), `${method} ${path} answered ${response.status()}`).toBeTruthy();
  return response.status() === 204 ? (undefined as T) : ((await response.json()) as T);
}

/** The server's today, in APP_TIMEZONE — never the runner's clock. */
const serverToday = (page: Page) =>
  api<{ today: IsoDate }>(page, "GET", "/tasks").then((body) => body.today);

async function makeHabit(page: Page, name: string, schedule: ScheduleInput) {
  const today = await serverToday(page);
  const { habit } = await api<{ habit: { id: string } }>(page, "POST", "/habits", {
    name: `${PREFIX}${name}`,
    color_token: "chart-1",
    start_date: addDays(today, -30),
    schedule,
  });
  return { id: habit.id, today };
}

/**
 * Clears fixtures an earlier run left behind, before each test rather than only
 * after: a test that exceeds its timeout is torn down mid-flight and its finally
 * block may not finish, and one orphan then fails the next run for a reason that
 * has nothing to do with the code. The export is the one read that carries the
 * logs, which have to go before a habit will delete.
 */
async function sweepFixtures(page: Page) {
  const data = await api<{
    habits: { id: string; name: string }[];
    habit_logs: { habit_id: string; date: IsoDate }[];
  }>(page, "GET", "/export");

  for (const habit of data.habits.filter((row) => row.name.startsWith(PREFIX))) {
    const dates = data.habit_logs.filter((log) => log.habit_id === habit.id).map((log) => log.date);
    await removeHabit(page, habit.id, dates);
  }
}

const pause = (page: Page, id: string) =>
  api(page, "POST", `/habits/${id}/schedule`, { schedule_kind: "paused" });

/** Logs cascade on delete, so they go first — and a habit with any left is a 409. */
async function removeHabit(page: Page, id: string, loggedOn: IsoDate[] = []) {
  for (const date of loggedOn) {
    await page.request.fetch(`/api/habits/${id}/logs/${date}`, { method: "DELETE" });
  }
  await page.request.fetch(`/api/habits/${id}`, { method: "DELETE" });
}

const scheduleOf = async (page: Page, id: string) => {
  const { habits } = await api<{
    habits: { id: string; schedule: { schedule_kind: string } | null }[];
  }>(page, "GET", "/habits");
  return habits.find((habit) => habit.id === id)?.schedule;
};

/**
 * The row on the Day screen, including the ones folded under "not scheduled" —
 * which is where anything paused lives.
 *
 * The wait is load-bearing. count() does not retry, so asking for the fold
 * before the day has painted samples the skeleton, finds nothing, skips the
 * click and then waits out the whole timeout on a button inside a fold that was
 * never opened. Waiting for a control that only exists once habits have arrived
 * makes the check ask about the real list.
 */
async function openSheet(page: Page, name: string) {
  await expect(page.getByRole("button", { name: "New habit" })).toBeVisible();

  const fold = page.locator("summary", { hasText: "not scheduled" });
  if (await fold.count()) await fold.click();

  await page.getByRole("button", { name: `More options for ${name}` }).click();
  await expect(page.locator("dialog[open]")).toBeVisible();
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * clear() removed the session query from the cache and left App's observer
 * pointing at a query that no longer existed, so neither direction ever
 * re-rendered: signing in left the login form up after a successful POST, and
 * signing out left the signed-in interface up over a destroyed cookie. Only a
 * manual reload escaped either one.
 */
test("signing in and out moves the app, with no reload", async ({ page }) => {
  await signIn(page);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("button", { name: "Sign in" }),
    "signing out must return to the login form",
  ).toBeVisible();

  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(signedIn(page), "signing in must enter the app").toBeVisible();
});

// ---------------------------------------------------------------------------
// Habit notes
// ---------------------------------------------------------------------------

/**
 * Tapping a done habit cleared its log, and clearing deletes the row the note
 * lives on. The tick came back with the next tap, so nothing looked wrong — the
 * writing was simply gone. A habit carrying a note now opens the sheet instead.
 */
test("tapping a habit that carries a note cannot destroy the note", async ({ page }) => {
  await signIn(page);
  const { id, today } = await makeHabit(page, "note keeper", {
    schedule_kind: "fixed",
    schedule_days: [1, 2, 3, 4, 5, 6, 7],
  });

  try {
    await api(page, "PUT", `/habits/${id}/logs/${today}`, {
      status: "done",
      note: "Finished chapter 8.",
    });

    await page.goto(`/day/${today}`);
    const row = page.locator("li", { hasText: "E2E note keeper" }).first();
    await expect(row).toContainText("Finished chapter 8.");

    // The old untick-then-retick gesture, twice over.
    for (let tap = 0; tap < 2; tap += 1) {
      await row.locator("button[aria-pressed]").click();
      await expect(page.locator("dialog[open]")).toBeVisible();
      await page.getByRole("button", { name: "Close" }).click();
      await expect(page.locator("dialog[open]")).toHaveCount(0);
    }

    const { habits } = await api<{ habits: { id: string; status: string; note: string }[] }>(
      page,
      "GET",
      `/day/${today}`,
    );
    const logged = habits.find((habit) => habit.id === id);
    expect(logged?.status, "the tick is untouched").toBe("done");
    expect(logged?.note, "and so is the note").toBe("Finished chapter 8.");
  } finally {
    await removeHabit(page, id, [today]);
  }
});

// ---------------------------------------------------------------------------
// Pause and resume
// ---------------------------------------------------------------------------

/**
 * The client had no way to know what a paused habit was, so it guessed
 * every-day. Resuming a Tue/Thu habit turned it into one that then failed five
 * days a week, and the picker pre-ticked all seven so the change looked
 * deliberate. It now opens on the server's resumes_to.
 */
test("resuming from the habit editor restores the schedule, not every day", async ({ page }) => {
  await signIn(page);
  const { id } = await makeHabit(page, "Tue/Thu", TUE_THU);

  try {
    await pause(page, id);
    await page.goto("/habits");

    const row = page.locator("li", { hasText: "E2E Tue/Thu" }).first();
    await expect(row).toContainText("Paused");
    await row.locator("button").first().click();

    const dialog = page.locator("dialog[open]");
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByLabel("Tuesday"),
      "the picker must open on what the pause interrupted",
    ).toBeChecked();
    await expect(dialog.getByLabel("Thursday")).toBeChecked();
    await expect(dialog.getByLabel("Monday"), "not on every day").not.toBeChecked();

    await dialog.locator("label", { hasText: "Paused" }).locator("input").uncheck();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);

    const schedule = await scheduleOf(page, id);
    expect(schedule).toMatchObject({ schedule_kind: "fixed", schedule_days: [2, 4] });
  } finally {
    await removeHabit(page, id);
  }
});

/**
 * The day sheet read the weekly target off `week`, which a paused week never
 * scores, so every weekly habit resumed at three a week whatever it had been.
 */
test("resuming from the day sheet restores the weekly target, not three", async ({ page }) => {
  await signIn(page);
  const { id, today } = await makeHabit(page, "five a week", {
    schedule_kind: "weekly",
    weekly_target: 5,
  });

  try {
    await pause(page, id);
    await page.goto(`/day/${today}`);
    await openSheet(page, "E2E five a week");

    await page.getByRole("button", { name: "Resume this habit" }).click();
    await expect(
      page.locator("dialog[open]").getByLabel("5 times a week"),
      "the picker must open on the target the pause interrupted",
    ).toBeChecked();

    await page.getByRole("button", { name: "Resume habit" }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);

    const schedule = await scheduleOf(page, id);
    expect(schedule).toMatchObject({ schedule_kind: "weekly", weekly_target: 5 });
  } finally {
    await removeHabit(page, id);
  }
});

/**
 * Paused-ness was read off `verdict`, but a paused day that was worked reports
 * "bonus" — so pausing a habit on a day you had already ticked hid the pause
 * completely: the sheet described the week, offered "Pause" a second time, and
 * gave no way back at all.
 */
test("a habit paused on a day it was ticked still reads as paused, and still resumes", async ({
  page,
}) => {
  await signIn(page);
  const { id, today } = await makeHabit(page, "worked then paused", TUE_THU);

  try {
    await api(page, "PUT", `/habits/${id}/logs/${today}`, { status: "done" });
    await pause(page, id);

    await page.goto(`/day/${today}`);
    const row = page.locator("li", { hasText: "E2E worked then paused" }).first();
    await expect(row, "the row must say it is paused").toContainText("Paused");

    await openSheet(page, "E2E worked then paused");
    const dialog = page.locator("dialog[open]");
    await expect(dialog.getByRole("button", { name: "Resume this habit" })).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Pause this habit" }),
      "and must not offer to pause an already-paused habit",
    ).toHaveCount(0);

    await dialog.getByRole("button", { name: "Resume this habit" }).click();
    await page.getByRole("button", { name: "Resume habit" }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);

    expect(await scheduleOf(page, id)).toMatchObject({
      schedule_kind: "fixed",
      schedule_days: [2, 4],
    });
  } finally {
    await removeHabit(page, id, [today]);
  }
});

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Each habit block is a grid item, and a grid item's default min-width:auto
 * refuses to shrink below its content — 706px for a year of columns. The block's
 * own scroller therefore never scrolled and the whole page took that width,
 * stranding the nav and the heading in the left 360px.
 */
test("the grid never makes the page scroll sideways on a phone", async ({ page }) => {
  await signIn(page);

  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 780 });

    for (const weeks of [4, 12, 26, 52]) {
      await page.goto(`/grid?weeks=${weeks}`);
      await expect(page.getByRole("heading", { name: "Consistency" })).toBeVisible();

      const page_ = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(page_.scroll, `${weeks}w at ${width}px overflows the page`).toBe(page_.client);
    }
  }
});

// ---------------------------------------------------------------------------
// Archiving
// ---------------------------------------------------------------------------

/**
 * "Archiving takes the habit off your list" was not true for the rest of the
 * day you did it on: the habit stayed in the Day list, still tickable, until
 * midnight — so the archive looked as though it had failed. The Grid and Review
 * keep it, because those are records rather than lists, and a row that simply
 * stops with nothing to explain it reads as a habit that was dropped.
 */
test("archiving a habit clears it from Day but keeps it, marked, in Grid and Review", async ({
  page,
}) => {
  await signIn(page);
  const { id, today } = await makeHabit(page, "cold shower", {
    schedule_kind: "fixed",
    schedule_days: [1, 2, 3, 4, 5, 6, 7],
  });
  const yesterday = addDays(today, -1);

  try {
    await api(page, "PUT", `/habits/${id}/logs/${yesterday}`, { status: "done" });

    await page.goto(`/day/${today}`);
    const onDay = page.locator("li", { hasText: "E2E cold shower" });
    await expect(onDay, "it is on today's list to begin with").toHaveCount(1);

    // Archive it the way the interface does, from the habit editor.
    await page.goto("/habits");
    await page
      .locator("li", { hasText: "E2E cold shower" })
      .first()
      .locator("button")
      .first()
      .click();
    await expect(page.locator("dialog[open]")).toBeVisible();
    await page.getByRole("button", { name: "Archive this habit" }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);

    await page.goto(`/day/${today}`);
    await expect(page.getByRole("button", { name: "New habit" })).toBeVisible();
    // toHaveCount counts attached elements, so this fails if the habit were
    // merely folded away rather than absent from the payload.
    await expect(onDay, "and gone from it at once, not at midnight").toHaveCount(0);

    // Yesterday is a record of a day that was lived, so it keeps the habit.
    await page.goto(`/day/${yesterday}`);
    await expect(
      page.locator("li", { hasText: "E2E cold shower" }),
      "a past day still carries it",
    ).toHaveCount(1);

    await page.goto("/grid?weeks=4");
    const block = page.locator("section", { hasText: "E2E cold shower" }).first();
    await expect(block, "the grid says when it was archived").toContainText("Archived");

    await page.goto("/review");
    const row = page.locator("li", { hasText: "E2E cold shower" }).first();
    await expect(row, "and the review reports the date, not a 0% failure").toContainText(
      "archived",
    );
    await expect(row).not.toContainText("consistency");
  } finally {
    await removeHabit(page, id, [yesterday]);
  }
});

/**
 * The figures are measured to the end of the window the review loaded, so what
 * they are called has to change with the month. They were always labelled
 * "Streak now", which is only true of the current one.
 */
test("the review names the streak for the month it is showing", async ({ page }) => {
  await signIn(page);

  await page.goto("/review");
  await expect(page.locator("main")).toContainText("Streak now");

  await page.getByRole("button", { name: "Previous month" }).click();
  await expect(page.locator("main")).toContainText("Streak at month end");
  await expect(page.locator("main")).not.toContainText("Streak now");
});
