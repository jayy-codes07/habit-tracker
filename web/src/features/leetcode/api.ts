import { request, send, sendJson } from "../../lib/api-client";
import type {
  Difficulty,
  Id,
  IsoDate,
  Problem,
  ProblemPayload,
  ProblemsPayload,
} from "../../types";

/** What a new entry may say. Everything but the title and difficulty is optional. */
export interface ProblemInput {
  number?: number | null;
  title: string;
  difficulty: Difficulty;
  topics?: string[];
  url?: string | null;
  solved_on?: IsoDate;
  ai_assisted?: boolean;
  approach?: string | null;
  solution?: string | null;
}

/**
 * A partial edit.
 *
 * Sending null CLEARS a field; leaving it out leaves it alone, and the server
 * tells the two apart by presence rather than value. `topics` is the exception —
 * the column is never null, so an empty array is how every tag is removed.
 *
 * `reviewed` and `archived` are booleans here and dates in the table. Problems
 * are archived rather than deleted, hence `archived` rather than a DELETE.
 */
export interface ProblemPatch extends Partial<Omit<ProblemInput, "title">> {
  title?: string;
  reviewed?: boolean;
  archived?: boolean;
}

/** Which view of the table. There is no "needs review" scope — see needsReview(). */
export type ProblemScope = "active" | "archived";

export const getProblems = (scope: ProblemScope = "active") =>
  request<ProblemsPayload>(`/leetcode${scope === "active" ? "" : `?scope=${scope}`}`);

/** The one read that carries `approach` and `solution`. */
export const getProblem = (id: Id) => request<ProblemPayload>(`/leetcode/${id}`);

export const createProblem = (input: ProblemInput) =>
  sendJson<{ problem: Problem }>("POST", "/leetcode", input);

export const patchProblem = (id: Id, patch: ProblemPatch) =>
  sendJson<{ problem: Problem }>("PATCH", `/leetcode/${id}`, patch);

/*
 * There is no screenshotUrl() any more. The image is served from Cloudinary and
 * the row carries the two URLs it is served from — `screenshot_url`, a CDN
 * transformation for display, and `screenshot_full_url`, the original. Building
 * either here would mean this client knowing the cloud name and the transform,
 * which are the server's to change.
 */

/**
 * The upload, as the file itself rather than a form or a base64 string.
 *
 * request() sets a JSON content type for any truthy body but spreads the given
 * headers after it, so naming the file's own type here is what the server
 * receives — and the server checks those bytes against it before storing
 * either.
 */
export const putScreenshot = (id: Id, file: File) =>
  request<{ problem: Problem }>(`/leetcode/${id}/screenshot`, {
    method: "PUT",
    body: file,
    headers: { "Content-Type": file.type },
  });

export const deleteScreenshot = (id: Id) => send("DELETE", `/leetcode/${id}/screenshot`);
