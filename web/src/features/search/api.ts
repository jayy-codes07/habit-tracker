/**
 * Search: one endpoint, and a feature that owns no tables — the same standing
 * overview/ has, mirroring server/src/modules/search.
 */
import { request } from "../../lib/api-client";
import type { SearchPayload } from "../../types";

/** `q` is user text and goes through encodeURIComponent, never a template. */
export const search = (q: string) => request<SearchPayload>(`/search?q=${encodeURIComponent(q)}`);
