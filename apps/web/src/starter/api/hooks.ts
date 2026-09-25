import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchSession, login, logout } from './client';

export const sessionKey = ['session'] as const;

/**
 * Who am I?
 *
 * `retry: false` because a 401 here is an ANSWER, not a failure — it means "signed out",
 * and retrying it three times just delays the login screen.
 */
export function useSession() {
  return useQuery({
    queryKey: sessionKey,
    queryFn: fetchSession,
    retry: false,
    staleTime: Infinity,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) =>
      login(input.email, input.password),
    onSuccess: (session) => {
      // Seed the cache directly rather than invalidating: the login response already IS
      // the session, so refetching it would be a second round trip for data in hand.
      queryClient.setQueryData(sessionKey, session);
    },
  });
}

/**
 * A hook a caller can register to clear domain caches on sign-out.
 *
 * The starter's `useLogout` knows about the session cache; it does not know what
 * domain data the registered demonstration screens have cached. Rather than importing
 * demonstration query keys here — the one import direction this codebase forbids — each
 * caller passes its own cleanup.
 */
export function useLogout(onLoggedOut?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: logout,
    onSuccess: () => {
      /**
       * ============================================================================
       * ORDER MATTERS, AND `queryClient.clear()` IS THE WRONG TOOL HERE
       * ============================================================================
       *
       * The obvious implementation is `queryClient.clear()` — wipe everything, the user
       * is gone. It empties the cache correctly, and the UI does not update at all.
       *
       * `clear()` DESTROYS the query objects that mounted observers are bound to. The
       * `useSession` observer is left holding a destroyed query: it neither refetches nor
       * resets, and keeps reporting the last data it saw. A subsequent `setQueryData` then
       * creates a BRAND NEW query that nothing is observing, so it notifies nobody.
       *
       * So: write the session value FIRST, through the live query the observer is
       * actually watching. That notifies it and re-renders straight to the login page.
       * Then let the caller drop whatever domain caches it owns.
       * ============================================================================
       */
      queryClient.setQueryData(sessionKey, null);
      onLoggedOut?.();
    },
  });
}
