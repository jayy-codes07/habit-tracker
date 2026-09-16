import { keepPreviousData, useQuery } from "@tanstack/react-query";

import * as api from "./api";

/** The server's own floor. Below it a query matches most of the record. */
export const MIN_QUERY = 2;

/**
 * Results for a query, or nothing at all while it is too short to ask about.
 *
 * `enabled` rather than an early return in the component: a disabled query
 * keeps its place in the cache and simply reports pending, so clearing the box
 * puts the empty state back without unmounting anything.
 *
 * keepPreviousData is what makes typing feel like filtering rather than
 * reloading — the previous list stays while the next one is fetched, and the
 * caller dims it with isPlaceholderData rather than pretending it is current.
 */
export const useSearch = (query: string) =>
  useQuery({
    queryKey: ["search", query],
    queryFn: () => api.search(query),
    enabled: query.length >= MIN_QUERY,
    placeholderData: keepPreviousData,
  });
