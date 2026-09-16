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
import { expect, test, type Locator, type Page } from "@playwright/test";
import { addDays, isoWeekday } from "../src/lib/dates";
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
const signedIn = (page: Page) => page.getByRole("link", { name: "Pattern", exact: true });

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

  // Problems too, in both scopes — an archived orphan is still an orphan.
  await sweepProblems(page);
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

  // Sign out lives in Settings, at the foot of Habits, rather than in the tab
  // row — so getting to it is part of what this test covers.
  await page.getByRole("link", { name: "Habits" }).click();
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
// Schedule changes that start later
// ---------------------------------------------------------------------------

/** The Monday the server dates a change of unit to. Today, when today is one. */
const startsOn = (today: IsoDate): IsoDate =>
  isoWeekday(today) === 1 ? today : addDays(today, 8 - isoWeekday(today));

/**
 * Ticks one of the picker's choices. Every control in SchedulePicker is an
 * sr-only input behind a styled label — the platform's semantics with our
 * appearance — so the thing a thumb actually hits is the label, and check()
 * aimed at the input waits out its timeout on a 1x1 box the label covers.
 */
const choose = (dialog: Locator, label: string) =>
  dialog.getByLabel(label, { exact: true }).locator("xpath=..").click();

/**
 * The habit editor, reached the way a thumb reaches it — which is now two taps,
 * not one. A row on /habits goes to that habit's history, and the editor opens
 * from there, so that changing a habit happens on the screen that shows you
 * what you would be changing.
 */
async function openEditor(page: Page, name: string) {
  await page.goto("/habits");
  const row = page.locator("li", { hasText: name }).first();
  await expect(row).toBeVisible();
  await row.getByRole("link").first().click();

  await page.getByRole("button", { name: "Edit habit" }).click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * Moving a habit between certain days and times a week is stored effective the
 * following Monday: a week is scored either as named days or as a count over
 * seven of them, never half of each. The editor closed on save regardless,
 * dropping the person back on a list still showing the old schedule — a
 * successful save that looked exactly like a failed one, with nothing anywhere
 * saying when the new one begins.
 *
 * The date is the server's, read off the response. The client cannot work it
 * out: /habits resolves a schedule as of today and carries no version dated
 * later, and the browser's own clock is not allowed to stand in for the day.
 */
test("switching to times a week says when it starts, instead of looking like it failed", async ({
  page,
}) => {
  await signIn(page);
  const { id, today } = await makeHabit(page, "Tue/Thu", TUE_THU);
  const expected = startsOn(today);

  try {
    const dialog = await openEditor(page, "E2E Tue/Thu");
    await choose(dialog, "A number of times a week");
    await dialog.getByRole("button", { name: "Save changes" }).click();

    const note = dialog.getByRole("status");
    await expect(note, "the dialog must stay open and say what happened").toBeVisible();
    await expect(note).toContainText("3 times a week");
    await expect(note, "the weekday it starts on").toContainText("Monday");
    await expect(note, "the date it starts on").toContainText(String(Number(expected.slice(8))));

    // And it must not claim the change is already in force.
    expect(await scheduleOf(page, id)).toMatchObject(
      expected === today
        ? { schedule_kind: "weekly", weekly_target: 3 }
        : { schedule_kind: "fixed", schedule_days: [2, 4] },
    );

    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
  } finally {
    await removeHabit(page, id);
  }
});

/**
 * And it has to survive the tab being closed. /habits resolved every schedule as
 * of today and carried nothing dated later, so a change that had been saved,
 * confirmed and acknowledged was gone the moment the list refetched — the
 * editor reopened on the old schedule with no sign anything was waiting.
 */
test("a change that starts later is still there after a reload", async ({ page }) => {
  await signIn(page);
  const { id, today } = await makeHabit(page, "Reopened", TUE_THU);
  // A Monday strictly in the future, so the fixture is the same on any day of
  // the week the suite happens to run — including a Monday, when a switch of
  // unit is not deferred at all and there would be nothing upcoming to find.
  const expected = addDays(startsOn(today), 7);

  try {
    await api(page, "POST", `/habits/${id}/schedule`, {
      schedule_kind: "weekly",
      weekly_target: 3,
      effective_from: expected,
    });

    // The list itself says so, before anything is opened.
    await page.goto("/habits");
    const row = page.locator("li", { hasText: "E2E Reopened" }).first();
    await expect(row, "today's schedule is still today's").toContainText("Tue, Thu");
    await expect(row).toContainText("then 3 times a week");

    // And so does the editor, which must open on the current schedule.
    const reopened = await openEditor(page, "E2E Reopened");
    await expect(reopened.getByLabel("Certain days of the week")).toBeChecked();
    await expect(reopened.getByLabel("Tuesday")).toBeChecked();

    const note = reopened.getByRole("status");
    await expect(note).toContainText("Upcoming change");
    await expect(note).toContainText("3 times a week");
    await expect(note).toContainText(String(Number(expected.slice(8))));

    // Opening it must not have started or overwritten anything.
    expect(await scheduleOf(page, id)).toMatchObject({
      schedule_kind: "fixed",
      schedule_days: [2, 4],
    });
  } finally {
    await removeHabit(page, id);
  }
});

test("switching to certain days says when it starts too", async ({ page }) => {
  await signIn(page);
  const { id, today } = await makeHabit(page, "Thrice", {
    schedule_kind: "weekly",
    weekly_target: 3,
  });
  const expected = startsOn(today);

  try {
    const dialog = await openEditor(page, "E2E Thrice");
    await choose(dialog, "Certain days of the week");
    await dialog.getByRole("button", { name: "Save changes" }).click();

    const note = dialog.getByRole("status");
    await expect(note).toContainText("Every day");
    await expect(note).toContainText(String(Number(expected.slice(8))));

    expect(await scheduleOf(page, id)).toMatchObject(
      expected === today ? { schedule_kind: "fixed" } : { schedule_kind: "weekly" },
    );
  } finally {
    await removeHabit(page, id);
  }
});

/** Everything that is not a change of unit still starts today, and still closes. */
test("changing only the days takes effect today", async ({ page }) => {
  await signIn(page);
  const { id } = await makeHabit(page, "Tue/Thu days", TUE_THU);

  try {
    const dialog = await openEditor(page, "E2E Tue/Thu days");
    await choose(dialog, "Monday");
    await dialog.getByRole("button", { name: "Save changes" }).click();

    await expect(page.locator("dialog[open]")).toHaveCount(0);
    expect(await scheduleOf(page, id)).toMatchObject({
      schedule_kind: "fixed",
      schedule_days: [1, 2, 4],
    });
  } finally {
    await removeHabit(page, id);
  }
});

test("changing only the weekly target takes effect today", async ({ page }) => {
  await signIn(page);
  const { id } = await makeHabit(page, "Target", { schedule_kind: "weekly", weekly_target: 3 });

  try {
    const dialog = await openEditor(page, "E2E Target");
    await choose(dialog, "5 times a week");
    await dialog.getByRole("button", { name: "Save changes" }).click();

    await expect(page.locator("dialog[open]")).toHaveCount(0);
    expect(await scheduleOf(page, id)).toMatchObject({
      schedule_kind: "weekly",
      weekly_target: 5,
    });
  } finally {
    await removeHabit(page, id);
  }
});

test("pausing takes effect today", async ({ page }) => {
  await signIn(page);
  const { id } = await makeHabit(page, "Pausable", TUE_THU);

  try {
    const dialog = await openEditor(page, "E2E Pausable");
    await dialog.locator("label", { hasText: "Paused" }).locator("input").check();
    await dialog.getByRole("button", { name: "Save changes" }).click();

    await expect(page.locator("dialog[open]")).toHaveCount(0);
    expect(await scheduleOf(page, id)).toMatchObject({ schedule_kind: "paused" });
  } finally {
    await removeHabit(page, id);
  }
});

/** Nothing to save is not a save: it must not write a version or interrupt. */
test("a save with nothing changed is not offered", async ({ page }) => {
  await signIn(page);
  const { id } = await makeHabit(page, "Unchanged", TUE_THU);

  try {
    const dialog = await openEditor(page, "E2E Unchanged");
    const save = dialog.getByRole("button", { name: "Saved" });
    await expect(save).toBeDisabled();
    await expect(dialog.getByRole("status")).toHaveCount(0);
  } finally {
    await removeHabit(page, id);
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
    await row.getByRole("link").first().click();
    await page.getByRole("button", { name: "Edit habit" }).click();

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
      await expect(page.getByRole("heading", { name: "Pattern" })).toBeVisible();

      const page_ = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(page_.scroll, `${weeks}w at ${width}px overflows the page`).toBe(page_.client);
    }
  }
});

/**
 * Each habit block used to own its own scroller, so seven rows could be parked
 * on seven different weeks. A column then no longer meant a date, and the
 * vertical reading the grid exists for — which day of the week never works —
 * was quietly wrong on every range wide enough to scroll.
 *
 * There is nothing to see in a screenshot when this breaks, and no server test
 * can reach it: it is one DOM node too many.
 */
test("every habit block in the grid shares one scroller", async ({ page }) => {
  await signIn(page);
  const first = await makeHabit(page, "block one", EVERY_DAY_SCHEDULE);
  const second = await makeHabit(page, "block two", EVERY_DAY_SCHEDULE);

  try {
    await page.setViewportSize({ width: 390, height: 780 });
    // The range that has to scroll on a phone, which is where the desync showed.
    await page.goto("/grid?weeks=52");
    await loaded(page);
    // The measurement below needs cells, not a skeleton.
    await expect(page.locator("[data-date]").first()).toBeVisible();

    const probe = await page.evaluate(() => {
      const scrollers = [...document.querySelectorAll("div")].filter(
        (element) =>
          getComputedStyle(element).overflowX === "auto" && element.querySelector("[data-date]"),
      );
      const blocks = [...document.querySelectorAll("section")].filter((section) =>
        section.querySelector("[data-date]"),
      );
      return {
        scrollers: scrollers.length,
        blocks: blocks.length,
        // Where each block's first cell actually sits. One scroller means one
        // offset; one scroller each means as many as there are blocks.
        offsets: blocks.map((block) =>
          Math.round(block.querySelector("[data-date]")!.getBoundingClientRect().x),
        ),
      };
    });

    expect(probe.blocks, "the fixtures should both be on the grid").toBeGreaterThan(1);
    expect(probe.scrollers, "one scroller for the whole sheet").toBe(1);
    expect(new Set(probe.offsets).size, "so every block is parked on the same week").toBe(1);
  } finally {
    await removeHabit(page, first.id);
    await removeHabit(page, second.id);
  }
});

/**
 * The note in the habit sheet saved on blur, and closing the sheet is not a
 * blur: Escape and a tap on the backdrop fire the dialog's own close, which
 * unmounts the field before it ever loses focus. A note typed and then
 * dismissed had been written, looked saved, and was gone.
 */
test("a note written in the sheet survives Escape", async ({ page }) => {
  await signIn(page);
  const { id, today } = await makeHabit(page, "escape note", EVERY_DAY_SCHEDULE);
  const SENTENCE = "Escape must not eat this sentence.";

  try {
    await page.goto(`/day/${today}`);
    await openSheet(page, "E2E escape note");

    const dialog = page.locator("dialog[open]");
    await choose(dialog, "Done");
    await dialog.locator("#log-note").fill(SENTENCE);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // Read back through the API, not off the screen it was typed on.
    await expect
      .poll(
        async () => {
          const { habits } = await api<{ habits: { id: string; note: string | null }[] }>(
            page,
            "GET",
            `/day/${today}`,
          );
          return habits.find((habit) => habit.id === id)?.note;
        },
        { message: "the note should have been written on the way out" },
      )
      .toBe(SENTENCE);
  } finally {
    await removeHabit(page, id, [today]);
  }
});

/**
 * The point of the habit history screen. habit_logs.note holds up to 1000
 * characters per habit per day and was readable one date at a time and nowhere
 * else; this is the only screen that reads them back, and it interleaves them
 * with the habit's own schedule events so the two explain each other.
 */
test("a habit's history reads its notes back, among its schedule changes", async ({ page }) => {
  await signIn(page);
  const { id, today } = await makeHabit(page, "recounted", EVERY_DAY_SCHEDULE);
  const yesterday = addDays(today, -1);

  try {
    await api(page, "PUT", `/habits/${id}/logs/${yesterday}`, {
      status: "done",
      note: "Wrote this a day ago.",
    });

    await page.goto("/habits");
    await page.locator("li", { hasText: "E2E recounted" }).first().getByRole("link").click();

    await expect(page.getByRole("heading", { name: "E2E recounted" })).toBeVisible();
    const stream = page.getByRole("region", { name: "What happened" });
    await expect(stream, "the writing comes back").toContainText("Wrote this a day ago.");
    await expect(stream, "beside the day the habit began").toContainText("Started");

    // And a note is a way back into the day it was written on.
    await stream.getByRole("link").first().click();
    await expect(page).toHaveURL(new RegExp(`/day/${yesterday}$`));
  } finally {
    await removeHabit(page, id, [yesterday]);
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
    await page.locator("li", { hasText: "E2E cold shower" }).first().getByRole("link").click();
    await page.getByRole("button", { name: "Edit habit" }).click();
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

/**
 * The product states what happened; it does not keep records.
 *
 * `longest_streak` is on the review payload and is rendered nowhere — the same
 * standing as `done_of`. A best is a high score in a game with one player, and
 * the moment a screen carries one, deciding to rest costs something, in an app
 * whose entire scoring model exists to make rest cost nothing. The counts, the
 * rates and the CURRENT streak are facts about a month and all stay.
 */
test("no screen reports a personal best", async ({ page }) => {
  await signIn(page);

  for (const path of ["/review", "/grid", "/habits"]) {
    await page.goto(path);
    await loaded(page);

    /*
     * The interface's own words only. A person's note may perfectly well say
     * "best week in a while", and handing that sentence back is the point of
     * the screen — so the serif, which is the voice the user writes in, is
     * excluded rather than the word being banned outright.
     */
    const claims = await page.evaluate(() =>
      [...document.querySelectorAll("p, h1, h2, h3, span, button, a")]
        .filter((element) => !element.closest(".font-serif"))
        .map((element) => element.textContent ?? "")
        .filter((text) => /\bbest\b|\blongest\b|personal record/i.test(text)),
    );
    expect(claims, `${path} must not rank the user against their own past`).toEqual([]);
  }
});

/**
 * Waits for a screen to have real data on it.
 *
 * Every heading in the app is rendered outside the loading branch, so waiting
 * for one samples the skeleton — which fails a measurement that needs content,
 * and silently PASSES a check that looks for something bad. Skeletons are the
 * only animate-pulse in the app, so their absence is the signal.
 */
async function loaded(page: Page) {
  await expect(page.locator("h1").first()).toBeVisible();
  await expect(page.locator(".animate-pulse")).toHaveCount(0);
}

/**
 * A picture that is hidden from the accessibility tree must be hidden from the
 * keyboard too.
 *
 * The habit spine was built with a <Link> in every cell inside an aria-hidden
 * region: a hundred tab stops that no screen reader could name, and a drift
 * from the grid, which has always used non-focusable cells and one delegated
 * listener. The cells stay tappable; the addressable route to a day is the Day
 * screen, and the stream reaches every written day by name.
 */
test("no aria-hidden region contains anything focusable", async ({ page }) => {
  await signIn(page);

  const { habits } = await api<{ habits: { id: string }[] }>(page, "GET", "/habits");
  const paths = ["/", "/grid?weeks=26", "/grid?weeks=52", "/review", "/habits", "/tasks"];
  if (habits[0]) paths.push(`/habits/${habits[0].id}`);

  for (const path of paths) {
    await page.goto(path);
    await loaded(page);

    const trapped = await page.evaluate(() =>
      [...document.querySelectorAll('[aria-hidden="true"]')]
        .flatMap((box) => [
          ...box.querySelectorAll(
            'a[href],button,input,select,textarea,summary,[tabindex]:not([tabindex="-1"])',
          ),
        ])
        .filter((element) => element.getBoundingClientRect().width > 0)
        .map((element) => element.tagName),
    );
    expect(trapped, `${path} puts focusable elements inside aria-hidden`).toEqual([]);
  }

  // And the cells still go where they say they go.
  await page.goto(`/habits/${habits[0]!.id}`);
  const cell = page.locator("[data-date]").last();
  const date = await cell.getAttribute("data-date");
  await cell.click();
  await expect(page).toHaveURL(new RegExp(`/day/${date}$`));
});

/**
 * A pause that starts today has no history behind it.
 *
 * dayVerdict checks paused before future on purpose — a paused habit's rest of
 * the week should read as "nothing is being asked" rather than as a blank — so
 * the cells for days still to come decode as `paused` as well. Counting the
 * whole spine therefore credited a habit paused this morning with five days of
 * pause it had not lived yet.
 */
test("a pause starting today reports no days paused before it", async ({ page }) => {
  await signIn(page);
  const { id } = await makeHabit(page, "paused today", EVERY_DAY_SCHEDULE);

  try {
    await pause(page, id);
    await page.goto(`/habits/${id}`);
    await expect(page.getByRole("heading", { name: "E2E paused today" })).toBeVisible();

    const tally = await page
      .locator("p")
      .filter({ hasText: /\bdone\b/ })
      .first()
      .textContent();

    const paused = Number(/(\d+)\s+days?\s+paused/.exec(tally ?? "")?.[1] ?? 0);
    expect(paused, `"${tally}" counts days that have not happened`).toBeLessThanOrEqual(1);
    // And says it in English. One day is the only case that can show this, and
    // it is the very case the fix above creates.
    if (paused === 1) expect(tally).toContain("1 day paused");
  } finally {
    await removeHabit(page, id);
  }
});

/**
 * One state, one name. The bare tray is a "Rest day" on the Day screen and in
 * every cell's own description; the grid legend used to call the same square
 * "Nothing asked", so the screen taught one word and the tooltip answered with
 * another.
 */
test("the grid legend calls a rest day a rest day", async ({ page }) => {
  await signIn(page);
  await page.goto("/grid?weeks=26");
  await loaded(page);

  const legend = page.locator("ul").filter({ hasText: "Done" }).last();
  await expect(legend).toContainText("Rest day");
  await expect(page.locator("main, body")).not.toContainText("Nothing asked");
});

/**
 * A dimmed control that will not say why is a control that looks broken. When
 * the record does not reach back as far as a longer range, that range is
 * unavailable — and both the chip's own label and a line under the group say so.
 */
test("an unavailable grid range explains itself", async ({ page }) => {
  await signIn(page);
  await page.goto("/grid?weeks=26");
  await loaded(page);
  // Which ranges are unavailable is decided from the cells, so this branch must
  // not be chosen while they are still a skeleton.
  await expect(page.locator("[data-date]").first()).toBeVisible();

  // The page's own header, not a habit block's — every block has one.
  const head = page.locator("header").first();
  const disabled = page.locator('input[name="range"]:disabled');
  if (await disabled.count()) {
    await expect(disabled.first()).toHaveAttribute("aria-label", /no record goes back that far/);
    await expect(head).toContainText("Longer ranges need more history");

    // ...but only where the chip it is about is on screen. Below `md` the year
    // chip is hidden, so the same note would be explaining a dimmed control the
    // reader cannot see.
    const onlyTheYear = (await disabled.count()) === 1;
    await page.setViewportSize({ width: 390, height: 780 });
    if (onlyTheYear) {
      await expect(head.getByText("Longer ranges need more history")).toBeHidden();
    }
  } else {
    // The record reaches the end of this range, so the phone is told where the
    // year view lives instead of being left to look for a chip that is not there.
    await page.setViewportSize({ width: 390, height: 780 });
    await expect(head).toContainText("wider screen");
    await expect(
      page.locator('input[name="range"][aria-label="Last year"]'),
      "and 1y stays off the phone",
    ).toBeHidden();
  }
});

// ---------------------------------------------------------------------------
// Quantity habits
//
// A habit is measured when, and only when, it has a unit. Everything below
// turns on that: the value box, the target box and the review's second figure
// all appear because `unit` is set and for no other reason, and a binary habit
// must come through this whole feature unchanged.
// ---------------------------------------------------------------------------

const EVERY_DAY_SCHEDULE: ScheduleInput = {
  schedule_kind: "fixed",
  schedule_days: [1, 2, 3, 4, 5, 6, 7],
};

/** A measured habit, with an optional target on its first version. */
async function makeMeasured(
  page: Page,
  name: string,
  unit: string,
  target: number | null = null,
  schedule: ScheduleInput = EVERY_DAY_SCHEDULE,
) {
  const today = await serverToday(page);
  const { habit } = await api<{ habit: { id: string } }>(page, "POST", "/habits", {
    name: `${PREFIX}${name}`,
    color_token: "chart-1",
    start_date: addDays(today, -30),
    unit,
    schedule: target === null ? schedule : { ...schedule, target_value: target },
  });
  return { id: habit.id, today };
}

const writeLog = (
  page: Page,
  id: string,
  date: IsoDate,
  body: { status: string; value?: number | null; note?: string | null },
) => api(page, "PUT", `/habits/${id}/logs/${date}`, body);

const habitRow = (page: Page, name: string) => page.locator("li", { hasText: name }).first();

/**
 * A binary habit must not sprout a single quantity control. `unit` is the only
 * marker, so a habit without one has nothing to measure, nothing to aim at, and
 * nowhere to put a number.
 */
test("a binary habit is offered no value and no target", async ({ page }) => {
  await signIn(page);
  const { id, today } = await makeHabit(page, "plain", TUE_THU);

  try {
    const editor = await openEditor(page, "E2E plain");
    await expect(editor.getByLabel("Measured in (optional)")).toHaveValue("");
    await expect(
      editor.getByLabel("Target each time (optional)"),
      "no unit means nothing to set a target in",
    ).toHaveCount(0);
    await editor.getByRole("button", { name: "Cancel" }).click();

    await page.goto(`/day/${today}`);
    await openSheet(page, "E2E plain");
    await expect(page.getByLabel("How much")).toHaveCount(0);
  } finally {
    await removeHabit(page, id);
  }
});

test("a measured habit is offered a value, a target, and shows both on the row", async ({
  page,
}) => {
  await signIn(page);
  const { id, today } = await makeMeasured(page, "run", "km", 5);

  try {
    const editor = await openEditor(page, "E2E run");
    await expect(editor.getByLabel("Measured in (optional)")).toHaveValue("km");
    await expect(editor.getByLabel("Target each time (optional)")).toHaveValue("5");
    await editor.getByRole("button", { name: "Cancel" }).click();

    // The list says what is being asked for, amount included. Reached again on
    // purpose: closing the editor leaves you on the habit's own page now.
    await page.goto("/habits");
    await expect(habitRow(page, "E2E run")).toContainText("5 km");

    await writeLog(page, id, today, { status: "done", value: 3 });
    await page.goto(`/day/${today}`);

    // "3 of 5 km" — what was measured, against what was asked on that day.
    await expect(habitRow(page, "E2E run")).toContainText("3 of 5 km");
  } finally {
    await writeLog(page, id, today, { status: "done" });
    await removeHabit(page, id, [today]);
  }
});

/**
 * Adding measurement to a habit already running is always safe: a binary
 * history holds no values, so there is nothing a new unit could re-mean.
 */
test("a unit can be added to a binary habit that already has history", async ({ page }) => {
  await signIn(page);
  const { id, today } = await makeHabit(page, "becomes measured", EVERY_DAY_SCHEDULE);

  try {
    await writeLog(page, id, today, { status: "done" });

    const editor = await openEditor(page, "E2E becomes measured");
    await expect(
      editor.getByLabel("Target each time (optional)"),
      "the target appears only once there is a unit",
    ).toHaveCount(0);

    await editor.getByLabel("Measured in (optional)").fill("pages");
    await editor.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);

    const { habits } = await api<{ habits: { id: string; unit: string | null }[] }>(
      page,
      "GET",
      "/habits",
    );
    expect(habits.find((habit) => habit.id === id)?.unit).toBe("pages");

    // And now there is something to aim at.
    const reopened = await openEditor(page, "E2E becomes measured");
    await expect(reopened.getByLabel("Target each time (optional)")).toBeVisible();
  } finally {
    await writeLog(page, id, today, { status: "done" });
    await removeHabit(page, id, [today]);
  }
});

/**
 * Once anything has been measured the unit is fixed: every number already
 * recorded is in it, and no row remembers which — so changing it would silently
 * re-mean all of them. The lock is the server's answer, reported as
 * `unit_locked`; the client never works it out for itself.
 */
test("a unit that has measured days cannot be edited, and says why", async ({ page }) => {
  await signIn(page);
  // No target, deliberately: a target would lock the unit on its own, and this
  // test is about the other half of the rule.
  const { id, today } = await makeMeasured(page, "locked", "km");

  try {
    const before = await openEditor(page, "E2E locked");
    await expect(
      before.getByLabel("Measured in (optional)"),
      "no number recorded in it yet, in either sense",
    ).toBeEnabled();
    await before.getByRole("button", { name: "Cancel" }).click();

    await writeLog(page, id, today, { status: "done", value: 4 });

    const editor = await openEditor(page, "E2E locked");
    const field = editor.getByLabel("Measured in (optional)");
    await expect(field).toBeDisabled();
    await expect(editor).toContainText("the unit is now fixed");
    await expect(editor, "and what to do instead").toContainText("archive this habit");

    // The server is still the authority, whatever the interface allows.
    const refused = await page.request.fetch(`/api/habits/${id}`, {
      method: "PATCH",
      data: { unit: "miles" },
    });
    expect(refused.status()).toBe(409);
  } finally {
    await writeLog(page, id, today, { status: "done" });
    await removeHabit(page, id, [today]);
  }
});

/** Changing only the amount is a real decision, and has to be storable as one. */
test("changing only the target is detected as a change and takes effect today", async ({
  page,
}) => {
  await signIn(page);
  const { id } = await makeMeasured(page, "target only", "km", 5);

  try {
    const editor = await openEditor(page, "E2E target only");
    // Nothing touched yet: the button must not offer a save.
    await expect(editor.getByRole("button", { name: "Saved" })).toBeDisabled();

    await editor.getByLabel("Target each time (optional)").fill("8");
    // Committed on blur, as the note field is.
    await editor.getByLabel("Name").click();

    await editor.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);

    expect(await scheduleOf(page, id)).toMatchObject({
      schedule_kind: "fixed",
      target_value: 8,
    });
  } finally {
    await removeHabit(page, id);
  }
});

/**
 * A pause stores no target, so resuming has to restore the one the pause
 * interrupted — the same reason it has to restore the days. Inventing either is
 * how a habit silently becomes a different habit.
 */
test("resuming a measured habit restores its target, not a blank one", async ({ page }) => {
  await signIn(page);
  const { id } = await makeMeasured(page, "paused measured", "km", 7);

  try {
    await pause(page, id);

    const dialog = await openEditor(page, "E2E paused measured");
    await expect(
      dialog.getByLabel("Target each time (optional)"),
      "the picker must open on what the pause interrupted",
    ).toHaveValue("7");

    await dialog.locator("label", { hasText: "Paused" }).locator("input").uncheck();
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);

    expect(await scheduleOf(page, id)).toMatchObject({ target_value: 7 });
  } finally {
    await removeHabit(page, id);
  }
});

/**
 * A change of scoring kind waits for Monday, and the target rides along with the
 * version it belongs to rather than arriving early on its own.
 */
test("a deferred change carries its target into the upcoming panel", async ({ page }) => {
  await signIn(page);
  const { id, today } = await makeMeasured(page, "deferred", "km", 5, TUE_THU);
  const expected = addDays(startsOn(today), 7);

  try {
    await api(page, "POST", `/habits/${id}/schedule`, {
      schedule_kind: "weekly",
      weekly_target: 3,
      target_value: 9,
      effective_from: expected,
    });

    await page.goto("/habits");
    const row = habitRow(page, "E2E deferred");
    await expect(row, "today still asks for the old target").toContainText("5 km");
    await expect(row).toContainText("then 3 times a week · 9 km");

    const editor = await openEditor(page, "E2E deferred");
    const note = editor.getByRole("status");
    await expect(note).toContainText("Upcoming change");
    await expect(note).toContainText("3 times a week · 9 km");
  } finally {
    await removeHabit(page, id);
  }
});

/**
 * PUT replaces the whole log row, so a status written without the measurement
 * would wipe one entered a second earlier — the same trap the note already
 * avoids, and the reason both are carried forward rather than defaulted.
 */
test("entering a value and then marking the day done keeps the value", async ({ page }) => {
  await signIn(page);
  const { id, today } = await makeMeasured(page, "keeps value", "km", 5);

  try {
    // A value needs a log row to live on, so the day starts marked — and marked
    // as something other than done, so the tap under test really is a status
    // change carrying a measurement it did not itself supply.
    await writeLog(page, id, today, { status: "missed", value: 4 });

    await page.goto(`/day/${today}`);
    await openSheet(page, "E2E keeps value");

    /*
     * Held in flight on purpose, and held for longer than the assertions below
     * are allowed to wait. Both halves matter: without the delay the refetch
     * lands first and the test passes on the server's answer, and with a delay
     * shorter than the default retry window it does the same thing a second
     * later. What is being checked is the optimistic patch alone — the half
     * that used to drop the value and show a habit that had suddenly measured
     * nothing.
     */
    const HELD_MS = 6000;
    const WHILE_IN_FLIGHT = { timeout: 2000 };

    await page.route("**/api/habits/*/logs/*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, HELD_MS));
      await route.continue();
    });

    await choose(page.locator("dialog[open]"), "Done");

    const row = habitRow(page, "E2E keeps value");
    // The tick, not the "More options" button beside it: aria-pressed is what
    // makes it the one that carries the day's state.
    await expect(
      row.locator("button[aria-pressed]"),
      "the status is patched at once",
    ).toHaveAttribute("aria-pressed", "true", WHILE_IN_FLIGHT);
    await expect(row, "and the measurement is carried with it").toContainText(
      "4 of 5 km",
      WHILE_IN_FLIGHT,
    );

    await page.unroute("**/api/habits/*/logs/*");

    // Polled rather than read once: unroute does not wait for the request it
    // was holding, so a single read here races the write it is checking.
    await expect
      .poll(
        async () => {
          const { habits } = await api<{
            habits: { id: string; status: string; value: number | null }[];
          }>(page, "GET", `/day/${today}`);
          const stored = habits.find((habit) => habit.id === id);
          return `${stored?.status} ${stored?.value}`;
        },
        { message: "the measurement must survive the status change", timeout: 10_000 },
      )
      .toBe("done 4");
  } finally {
    await writeLog(page, id, today, { status: "done" });
    await removeHabit(page, id, [today]);
  }
});

/**
 * The one (status, value) pair with no reading. The database refuses it too, so
 * this is only about saying so before the round trip rather than after it.
 */
test("a done day cannot be measured as zero", async ({ page }) => {
  await signIn(page);
  const { id, today } = await makeMeasured(page, "no zero", "km", 5);

  try {
    await page.goto(`/day/${today}`);
    await openSheet(page, "E2E no zero");

    const sheet = page.locator("dialog[open]");
    await choose(sheet, "Done");
    await sheet.getByLabel("How much").fill("0");
    await sheet.getByLabel("Note").click();

    await expect(sheet.getByRole("alert")).toContainText("cannot measure zero");

    // And nothing was written.
    const { habits } = await api<{ habits: { id: string; value: number | null }[] }>(
      page,
      "GET",
      `/day/${today}`,
    );
    expect(habits.find((habit) => habit.id === id)?.value).toBeNull();
  } finally {
    await writeLog(page, id, today, { status: "done" });
    await removeHabit(page, id, [today]);
  }
});

/**
 * Two numbers, two questions. Consistency asks whether you showed up as often as
 * you said you would; attainment asks how close you got when you did. A habit
 * can honestly be 100% on one and short on the other, and a reader who takes one
 * for the other has been misled by the layout.
 */
test("the review shows attainment beside consistency, and not for binary habits", async ({
  page,
}) => {
  await signIn(page);
  const measured = await makeMeasured(page, "review measured", "km", 5);
  const { id: binaryId, today } = await makeHabit(page, "review binary", EVERY_DAY_SCHEDULE);

  try {
    // Every day done, every one short: full consistency, 60% attainment.
    await writeLog(page, measured.id, today, { status: "done", value: 3 });
    await writeLog(page, binaryId, today, { status: "done" });

    await page.goto(`/review/${today.slice(0, 7)}`);

    const row = page.locator("li", { hasText: "E2E review measured" }).first();
    await expect(row).toContainText("consistency");
    await expect(row, "the second figure, named so it cannot be read as the first").toContainText(
      "60% of target over 1 session",
    );

    const plain = page.locator("li", { hasText: "E2E review binary" }).first();
    await expect(plain).toContainText("consistency");
    await expect(plain, "a binary habit must invent no quantity at all").not.toContainText(
      "of target",
    );
  } finally {
    await writeLog(page, measured.id, today, { status: "done" });
    await removeHabit(page, measured.id, [today]);
    await removeHabit(page, binaryId, [today]);
  }
});

/**
 * The sentence under the schedule read the wrong variable.
 *
 * `unitChanged` was renamed to `kindChanged` when "unit" came to mean the thing
 * a habit is measured in, and one reference was left behind — the one that
 * renders text. So the Monday warning appeared when the *measured unit* was
 * edited, where nothing is deferred, and was missing on the fixed/weekly switch
 * that actually is: that save promised "takes effect today" and stored the
 * following Monday. The server is the source of truth for both claims, so both
 * tests below check what it stored as well as what was said.
 */
const MONDAY_WARNING = "starts on a Monday";
const IMMEDIATE = "takes effect today";

test("editing the measured unit does not claim a Monday deferral", async ({ page }) => {
  await signIn(page);
  // Target-free, so the unit is still editable: a target locks it.
  const { id } = await makeMeasured(page, "unit reworded", "km");

  try {
    const editor = await openEditor(page, "E2E unit reworded");
    await expect(editor).toContainText(IMMEDIATE);

    await editor.getByLabel("Measured in (optional)").fill("miles");
    await expect(editor, "changing what a habit is measured in defers nothing").not.toContainText(
      MONDAY_WARNING,
    );
    await expect(editor).toContainText(IMMEDIATE);

    await editor.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);

    // And it really was immediate, which is what the sentence promised.
    const { habits } = await api<{ habits: { id: string; unit: string | null }[] }>(
      page,
      "GET",
      "/habits",
    );
    expect(habits.find((habit) => habit.id === id)?.unit).toBe("miles");
  } finally {
    await removeHabit(page, id);
  }
});

test("switching between certain days and times a week says it starts on a Monday", async ({
  page,
}) => {
  await signIn(page);
  const { id, today } = await makeHabit(page, "kind reworded", TUE_THU);

  try {
    const editor = await openEditor(page, "E2E kind reworded");
    await expect(editor, "nothing changed yet").toContainText(IMMEDIATE);

    await choose(editor, "A number of times a week");
    await expect(
      editor,
      "the one change the server does not start when it is asked to",
    ).toContainText(MONDAY_WARNING);

    // Back again: the warning belongs to the change, not to having touched it.
    await choose(editor, "Certain days of the week");
    await expect(editor).toContainText(IMMEDIATE);

    await choose(editor, "A number of times a week");
    await editor.getByRole("button", { name: "Save changes" }).click();

    // The server deferred it — unless today is itself a Monday, when the
    // deferral lands on today and there is nothing to wait for.
    const expected = startsOn(today);
    expect(await scheduleOf(page, id)).toMatchObject(
      expected === today
        ? { schedule_kind: "weekly" }
        : { schedule_kind: "fixed", schedule_days: [2, 4] },
    );
  } finally {
    await removeHabit(page, id);
  }
});

/**
 * The picker was handed the *saved* unit, so a habit only grew a target field
 * one save after it grew a unit — and the create dialog, which passes the unit
 * being typed, disagreed with the editor about the same two fields.
 *
 * The other half matters more: deleting the unit has to take the amount with
 * it. A target with no unit is refused by the schedule endpoint, and on create
 * it used to commit a habit with no schedule version at all.
 */
test("the target field follows the unit being typed, not the one last saved", async ({ page }) => {
  await signIn(page);
  const { id } = await makeHabit(page, "types a unit", EVERY_DAY_SCHEDULE);

  try {
    const editor = await openEditor(page, "E2E types a unit");
    const target = editor.getByLabel("Target each time (optional)");
    await expect(target, "no unit, nothing to aim at").toHaveCount(0);

    await editor.getByLabel("Measured in (optional)").fill("laps");
    await expect(target, "typing a unit makes a target possible at once").toBeVisible();

    await target.fill("4");
    await editor.getByLabel("Name").click();

    // Deleting the unit must take the amount with it, not leave it to be sent
    // at an endpoint that will refuse it.
    await editor.getByLabel("Measured in (optional)").fill("");
    await expect(target).toHaveCount(0);
    await expect(
      editor.getByRole("button", { name: "Saved" }),
      "and with both gone there is nothing left to save",
    ).toBeDisabled();

    // Re-typing it brings the amount back rather than making it retypable only
    // from memory, and the pair saves together in one go.
    await editor.getByLabel("Measured in (optional)").fill("laps");
    await expect(target).toHaveValue("4");
    await editor.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);

    const { habits } = await api<{
      habits: { id: string; unit: string | null; schedule: { target_value: number | null } }[];
    }>(page, "GET", "/habits");
    const saved = habits.find((habit) => habit.id === id);
    expect(saved?.unit, "one save, both halves").toBe("laps");
    expect(saved?.schedule.target_value).toBe(4);
  } finally {
    await removeHabit(page, id);
  }
});

/**
 * A target is history too.
 *
 * The unit used to freeze only once a value was logged, so a habit that asked
 * for 5 km and had simply not been ticked yet could be switched to miles — and
 * every version behind it then read "5 miles", a sentence nobody had written.
 * The lock now covers both kinds of recorded number, and the editor reads the
 * server's answer rather than working either out for itself.
 */
test("a target freezes the unit as surely as a measurement does", async ({ page }) => {
  await signIn(page);
  const { id } = await makeMeasured(page, "target locks", "km", 5);

  try {
    const editor = await openEditor(page, "E2E target locks");
    const field = editor.getByLabel("Measured in (optional)");

    await expect(field, "nothing logged, but 5 km is already on the record").toBeDisabled();
    await expect(editor).toContainText("the unit is now fixed");
    await expect(editor, "and it names both kinds of number").toContainText("targets set in it");
    await expect(editor, "with a way out that does not rewrite anything").toContainText(
      "archive this habit",
    );

    // The server is the authority, whatever the interface allows.
    const refused = await page.request.fetch(`/api/habits/${id}`, {
      method: "PATCH",
      data: { unit: "miles" },
    });
    expect(refused.status()).toBe(409);
  } finally {
    await removeHabit(page, id);
  }
});

// ---------------------------------------------------------------------------
// The LeetCode workspace
//
// Removing a fixture takes three calls, and the shape is removeHabit's: a
// problem can only be deleted while it carries nothing worth keeping, so its
// screenshot and its notes go first and the row follows. Anything left behind
// would sit in the Archived view of a real database for ever — these tests run
// against the development one.
// ---------------------------------------------------------------------------

/** A real 1x1 PNG. Base64, so it can be decoded inside the page with atob(). */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

interface ProblemRow {
  id: string;
  number: number | null;
  title: string;
  ai_assisted: boolean;
  reviewed_on: IsoDate | null;
  screenshot_bytes: number | null;
}

/** Only this suite's own rows, in whichever scope was asked for. */
const problemsNamed = async (page: Page, scope = "") =>
  (await api<{ problems: ProblemRow[] }>(page, "GET", `/leetcode${scope}`)).problems.filter((row) =>
    row.title.startsWith(PREFIX),
  );

async function makeProblem(page: Page, title: string, fields: Record<string, unknown> = {}) {
  const today = await serverToday(page);
  const { problem } = await api<{ problem: ProblemRow }>(page, "POST", "/leetcode", {
    title: `${PREFIX}${title}`,
    difficulty: "medium",
    solved_on: today,
    ...fields,
  });
  return { id: problem.id, today };
}

/**
 * Notes and a screenshot make a problem a record, and a record will not delete —
 * so they go first, exactly as a habit's logs do before the habit.
 */
async function removeProblem(page: Page, id: string) {
  await page.request.fetch(`/api/leetcode/${id}/screenshot`, { method: "DELETE" });
  await page.request.fetch(`/api/leetcode/${id}`, {
    method: "PATCH",
    data: { approach: null, solution: null },
  });
  await page.request.fetch(`/api/leetcode/${id}`, { method: "DELETE" });
}

/** Every problem this suite made, in both scopes — including an archived one. */
async function sweepProblems(page: Page) {
  for (const scope of ["", "?scope=archived"]) {
    for (const problem of await problemsNamed(page, scope)) {
      await removeProblem(page, problem.id);
    }
  }
}

/**
 * Ctrl+V with an image on the clipboard, which is the gesture this whole
 * feature is shaped around.
 *
 * Dispatched on `document` because that is where a real paste lands when no
 * editable element has focus, and because the handler under test listens there
 * for exactly that reason — a React onPaste on a wrapper div never sees an
 * event whose target is body, and reads as though it would. Decoded with atob()
 * rather than fetched from a data: URL so nothing here depends on connect-src.
 */
async function pasteImage(page: Page) {
  await page.evaluate((base64) => {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const file = new File([bytes], "statement.png", { type: "image/png" });

    const transfer = new DataTransfer();
    transfer.items.add(file);
    document.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, PNG_BASE64);
}

/**
 * A screenshot held in the browser is a screenshot that is gone on the next
 * reload.
 *
 * The obvious build of this keeps the pasted image as an object URL or in
 * localStorage, and it demonstrates perfectly — the plate appears the instant
 * you paste. Then you come back three months later and every problem statement
 * is a broken image, which is the one thing the feature existed to prevent. So
 * this walks the real path: record, paste, save, reload, and then read the row
 * back through the API to prove the bytes are on the server rather than in a
 * tab that is about to be closed.
 */
test("a pasted screenshot survives a reload and stays with its problem", async ({ page }) => {
  await signIn(page);

  try {
    await page.goto("/leetcode");
    await loaded(page);
    await page.getByRole("button", { name: "Record a problem" }).click();

    const dialog = page.locator("dialog[open]");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Number", { exact: true }).fill("146");
    await dialog.getByLabel("Title", { exact: true }).fill(`${PREFIX}LRU Cache`);
    await choose(dialog, "medium");
    await dialog.getByLabel("Topics", { exact: true }).fill("hash-table, design");

    await pasteImage(page);
    await expect(
      dialog.getByRole("img", { name: /Chosen screenshot/ }),
      "the paste has to show something, or nobody can tell it landed",
    ).toBeVisible();

    await dialog.getByRole("button", { name: "Record it" }).click();
    await expect(dialog).toHaveCount(0);

    // Recording opens the problem, and the URL IS the problem.
    await expect(page.getByRole("heading", { name: `${PREFIX}LRU Cache` })).toBeVisible();
    await expect(page).toHaveURL(/\/leetcode\/\d+$/);

    const plate = page.getByRole("img", { name: /Problem statement for #146/ });
    await expect(plate, "the plate paints from the server, not from the clipboard").toBeVisible();

    // The whole point: a full reload, with nothing left in memory.
    await page.reload();
    await loaded(page);
    await expect(plate, "and it is still there afterwards").toBeVisible();

    const [saved] = await problemsNamed(page);
    expect(saved?.screenshot_bytes, "the bytes are stored against the row").toBeGreaterThan(0);

    const served = await page.request.fetch(`/api/leetcode/${saved?.id}/screenshot`);
    expect(served.status(), "and come back from the row's own endpoint").toBe(200);
    expect(served.headers()["content-type"], "as what they are").toBe("image/png");
  } finally {
    await sweepProblems(page);
  }
});

/**
 * A deep link has to survive a reload, or a problem is not a place.
 *
 * /leetcode/:id renders the same component as /leetcode with the detail bound
 * to the id, which is only a route away from being a tab that resets to the
 * list every time the page is refreshed — and the whole reason to record a
 * problem is to be able to send yourself back to it months later.
 */
test("a problem opened by its own URL is still there after a reload", async ({ page }) => {
  await signIn(page);
  const { id } = await makeProblem(page, "Trapping Rain Water", { number: 42, difficulty: "hard" });

  try {
    // Straight to the URL, with no list navigated through first.
    await page.goto(`/leetcode/${id}`);
    await loaded(page);
    await expect(page.getByRole("heading", { name: `${PREFIX}Trapping Rain Water` })).toBeVisible();

    await page.reload();
    await loaded(page);
    await expect(
      page.getByRole("heading", { name: `${PREFIX}Trapping Rain Water` }),
      "a reload on a deep link must not fall back to the list",
    ).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/leetcode/${id}$`));
  } finally {
    await sweepProblems(page);
  }
});

/**
 * The review queue is derived, and a derived queue is exactly the one that can
 * be right in the database and wrong on the screen.
 *
 * Marking something reviewed has to take it out of the list you are looking at
 * and undoing has to put it back, both without a reload and both agreeing with
 * what the API says. A stored review_status would let the two drift apart; this
 * walks the whole loop against one row and checks the screen and the server at
 * every step.
 */
test("marking reviewed empties the queue and undoing refills it", async ({ page }) => {
  await signIn(page);
  const { id } = await makeProblem(page, "Word Ladder", { number: 127, ai_assisted: true });

  try {
    await page.goto("/leetcode");
    await loaded(page);

    const queue = page.getByLabel("Needs review", { exact: true }).locator("xpath=..");
    // Scoped to the index: on a wide screen the pane beside it shows the queue
    // as well, so a bare li matches the same problem twice.
    const row = page
      .getByRole("list", { name: "Recorded problems" })
      .locator("li", { hasText: `${PREFIX}Word Ladder` });

    await queue.click();
    await expect(row, "an AI-assisted problem starts in the queue").toHaveCount(1);

    await page.goto(`/leetcode/${id}`);
    await loaded(page);
    await page.getByRole("button", { name: "Mark reviewed" }).click();

    await expect(
      page.getByRole("button", { name: "Undo review" }),
      "the one action becomes its own undo",
    ).toBeVisible();
    await expect
      .poll(async () => (await problemsNamed(page))[0]?.reviewed_on, {
        message: "and the server records the day it happened",
      })
      .toBe(await serverToday(page));

    // Back to the queue, which must have emptied itself without a reload.
    await page.goto("/leetcode");
    await loaded(page);
    await queue.click();
    await expect(row, "a reviewed problem leaves the queue").toHaveCount(0);

    // Undo, and it comes back to exactly where it was.
    await page.goto(`/leetcode/${id}`);
    await loaded(page);
    await page.getByRole("button", { name: "Undo review" }).click();
    await expect(page.getByRole("button", { name: "Mark reviewed" })).toBeVisible();

    await page.goto("/leetcode");
    await loaded(page);
    await queue.click();
    await expect(row, "undoing puts it back rather than inventing a third state").toHaveCount(1);

    expect((await problemsNamed(page))[0]?.reviewed_on, "and clears the date again").toBeNull();
  } finally {
    await sweepProblems(page);
  }
});

/**
 * Archiving has to move a problem between two lists, not just dim it.
 *
 * Every read on the server filters archived_at IS NULL, so a row that stayed in
 * the working list after being archived would be a client cache that never
 * heard about the write — the failure invalidation exists to prevent, and one
 * no server test can see.
 */
test("archiving moves a problem to Archived, and restoring brings it back", async ({ page }) => {
  await signIn(page);
  const { id } = await makeProblem(page, "Palindrome Number", { number: 9, difficulty: "easy" });

  try {
    const all = page.getByLabel("All problems", { exact: true }).locator("xpath=..");
    const archived = page.getByLabel("Archived", { exact: true }).locator("xpath=..");
    const row = page
      .getByRole("list", { name: "Recorded problems" })
      .locator("li", { hasText: `${PREFIX}Palindrome Number` });

    await page.goto(`/leetcode/${id}`);
    await loaded(page);
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(page.getByRole("button", { name: "Restore" })).toBeVisible();

    await page.goto("/leetcode");
    await loaded(page);
    await expect(row, "gone from the working list").toHaveCount(0);

    await archived.click();
    await expect(row, "and found under Archived").toHaveCount(1);

    await page.goto(`/leetcode/${id}`);
    await loaded(page);
    await page.getByRole("button", { name: "Restore" }).click();
    await expect(page.getByRole("button", { name: "Archive", exact: true })).toBeVisible();

    await page.goto("/leetcode");
    await loaded(page);
    await all.click();
    await expect(row, "restoring returns it to where it was").toHaveCount(1);
  } finally {
    await sweepProblems(page);
  }
});

/**
 * Archiving a problem that was still waiting to be reviewed took the whole pane
 * down with it.
 *
 * "Needs review" folds in "and it is in the working list", because a queue must
 * not offer you something you have put away. The review line read that same
 * answer as "this has been reviewed", and went looking for the date it was
 * reviewed on — which was null, so the render threw and the screen went blank
 * on the click that archived it. Two questions, and only one of them is about
 * the date.
 */
test("archiving a problem that still needs review does not blank the page", async ({ page }) => {
  await signIn(page);
  const { id } = await makeProblem(page, "Course Schedule", { number: 207, ai_assisted: true });

  try {
    await page.goto(`/leetcode/${id}`);
    await loaded(page);
    await expect(page.getByRole("button", { name: "Mark reviewed" })).toBeVisible();

    await page.getByRole("button", { name: "Archive", exact: true }).click();

    await expect(
      page.getByRole("button", { name: "Restore" }),
      "the pane has to survive its own archive",
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: `${PREFIX}Course Schedule` }),
      "and still be the problem it was",
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Mark reviewed" }),
      "unreviewed is unreviewed, archived or not",
    ).toBeVisible();
  } finally {
    await sweepProblems(page);
  }
});

/**
 * Notes save when you leave the field, and the field has to belong to the
 * problem that is open.
 *
 * Both note fields are plain local state seeded from the loaded row, which is
 * the shape that carries the last problem's text into the next one — the bug
 * the journal already had once, fixed there with a key on the date. Here the
 * key is the problem, and this is what says so.
 */
test("approach notes save on blur and do not follow you to the next problem", async ({ page }) => {
  await signIn(page);
  const first = await makeProblem(page, "Two Sum", { number: 1, difficulty: "easy" });
  const second = await makeProblem(page, "Number of Islands", { number: 200 });

  try {
    await page.goto(`/leetcode/${first.id}`);
    await loaded(page);

    const approach = page.getByLabel("My approach to this problem");
    await approach.fill("Hash map of complement to index.");
    // Blur is the save. Clicking the heading is what a person does next.
    await page.getByRole("heading", { name: `${PREFIX}Two Sum` }).click();

    await expect
      .poll(
        async () => {
          const { problem } = await api<{ problem: { approach: string | null } }>(
            page,
            "GET",
            `/leetcode/${first.id}`,
          );
          return problem.approach;
        },
        { message: "leaving the field is what saves it" },
      )
      .toBe("Hash map of complement to index.");

    await page.goto(`/leetcode/${second.id}`);
    await loaded(page);
    await expect(
      page.getByLabel("My approach to this problem"),
      "the next problem starts from its own text, not the last one's",
    ).toHaveValue("");
  } finally {
    await sweepProblems(page);
  }
});
