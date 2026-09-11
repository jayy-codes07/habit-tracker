import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import * as api from "./api";

/**
 * retry:false is not optional. GET /api/session sits behind requireAuth, so a
 * logged-out boot is a 401, and retrying it fires three of them before the
 * login form appears.
 */
export const useSession = () =>
  useQuery({ queryKey: ["session"], queryFn: api.getSession, retry: false, staleTime: Infinity });

export function useLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.login,
    onSuccess: () => client.clear(),
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.logout,
    onSettled: () => client.clear(),
  });
}
