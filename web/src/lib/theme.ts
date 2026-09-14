/**
 * Dark-first, remembered on the device.
 *
 * The choice is a browser preference, not app data: it belongs to the phone you
 * are holding, not to the habits, so it never goes near the API. index.html
 * ships `data-theme="dark"` so the first paint is already right for the default,
 * and main.tsx corrects it before rendering for anyone who chose light.
 *
 * localStorage throws outright when site data is blocked, and a theme is not
 * worth a white screen — hence the guards.
 */
export type Theme = "dark" | "light";

/**
 * index.css --c-canvas, per theme. The installed app paints its status bar and
 * task-switcher card from this, so a stale value shows as a light strip above a
 * dark screen — which is why it is rewritten on every theme change rather than
 * left to the static tag in index.html.
 */
const CANVAS: Record<Theme, string> = { dark: "#15151b", light: "#fbfbfd" };

export function readTheme(): Theme {
  try {
    return localStorage.getItem("theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", CANVAS[theme]);
  try {
    localStorage.setItem("theme", theme);
  } catch {
    // Applied for this session; it just will not be remembered.
  }
}
