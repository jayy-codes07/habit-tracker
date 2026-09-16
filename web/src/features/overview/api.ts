/**
 * The screen reads: endpoints that own no tables and compose everything else,
 * mirroring server/src/modules/overview. /grid and /review join /day here.
 */
import { request } from "../../lib/api-client";
import type {
  ComparePayload,
  DayPayload,
  GridPayload,
  IsoDate,
  IsoMonth,
  ReviewPayload,
} from "../../types";

export const getDay = (date: IsoDate) => request<DayPayload>(`/day/${date}`);

/** `end` is left to the server, which defaults it to today in APP_TIMEZONE. */
export const getGrid = (weeks: number) => request<GridPayload>(`/grid?weeks=${weeks}`);

export const getReview = (month: IsoMonth) => request<ReviewPayload>(`/review/${month}`);

/**
 * The same month, a year apart — counts only, and never a difference between
 * them. Its own request rather than a field on the review: the review is one
 * month read in full, and folding a second month's figures into it would make
 * every review pay for a comparison most of them do not show.
 */
export const getCompare = (month: IsoMonth) => request<ComparePayload>(`/compare/${month}`);
