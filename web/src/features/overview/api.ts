/**
 * The screen reads: endpoints that own no tables and compose everything else,
 * mirroring server/src/modules/overview. /grid and /review join /day here.
 */
import { request } from "../../lib/api-client";
import type { DayPayload, GridPayload, IsoDate, IsoMonth, ReviewPayload } from "../../types";

export const getDay = (date: IsoDate) => request<DayPayload>(`/day/${date}`);

/** `end` is left to the server, which defaults it to today in APP_TIMEZONE. */
export const getGrid = (weeks: number) => request<GridPayload>(`/grid?weeks=${weeks}`);

export const getReview = (month: IsoMonth) => request<ReviewPayload>(`/review/${month}`);
