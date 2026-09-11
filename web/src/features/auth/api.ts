/**
 * GET /api/session sits behind requireAuth: it 401s when logged out rather than
 * answering { authenticated: false }. Any error means "not logged in".
 */
import { request, sendJson } from "../../lib/api-client";
import type { Session } from "../../types";

export const getSession = () => request<Session>("/session");

export const login = (password: string) =>
  sendJson<{ authenticated: true }>("POST", "/login", { password });

export const logout = () => sendJson<{ authenticated: false }>("POST", "/logout");
