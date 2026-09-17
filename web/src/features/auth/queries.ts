import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import * as api from "./api";

/**
 * retry:false is not optional. GET /api/session sits behind requireAuth, so a
 * logged-out boot is a 401, and retrying it fires three of them before the
 * login form appears.
 */
export const useSession = () =>
  useQuery({ queryKey: ["session"], queryFn: api.getSession, retry: false, staleTime: Infinity });

/**
 * resetQueries(), never clear().
 *
 * Both do the part that is wanted here — drop every cached row, so a session
 * change never leaves the previous one's data in memory. Only resetQueries()
 * also refetches the queries that are currently mounted, and the session query
 * is always one of them: it is what App renders the whole app from.
 *
 * clear() removes it from the cache outright, and the mounted observer then
 * holds a query that no longer exists and never fetches again. Signing in left
 * the login form on screen after a successful POST; signing out left the
 * signed-in interface on screen over a destroyed cookie. Neither recovered,
 * because main.tsx's 401 handler invalidates ["session"] — which by then was
 * not there to invalidate. Only a reload got out of it.
 */
export function useLogin() {
  const client = useQueryClient();
  return useMutation({
    // main.tsx's global 401 handler skips this key; see the note there.
    mutationKey: ["auth"],
    mutationFn: api.login,
    onSuccess: () => client.resetQueries(),
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationKey: ["auth"],
    mutationFn: api.logout,
    onSettled: () => client.resetQueries(),
  });
}
