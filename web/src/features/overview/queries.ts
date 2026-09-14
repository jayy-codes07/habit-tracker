import { keepPreviousData, useQuery } from "@tanstack/react-query";

import * as api from "./api";
import type { IsoDate, IsoMonth } from "../../types";

/**
 * placeholderData keeps the previous day on screen while the next one loads,
 * so stepping through days does not blank the layout. The caller dims it with
 * isPlaceholderData rather than pretending it is current.
 */
export const useDay = (date: IsoDate) =>
  useQuery({
    queryKey: ["day", date],
    queryFn: () => api.getDay(date),
    placeholderData: keepPreviousData,
  });

/**
 * Same placeholder trick as the day: changing the range keeps the old grid on
 * screen, dimmed, rather than collapsing the page to a skeleton and back.
 */
export const useGrid = (weeks: number) =>
  useQuery({
    queryKey: ["grid", weeks],
    queryFn: () => api.getGrid(weeks),
    placeholderData: keepPreviousData,
  });

/** Stepping months keeps the previous one on screen, as stepping days does. */
export const useReview = (month: IsoMonth) =>
  useQuery({
    queryKey: ["review", month],
    queryFn: () => api.getReview(month),
    placeholderData: keepPreviousData,
  });
