import { useQueryClient } from '@tanstack/react-query';
import { useSession } from './starter/api/hooks';
import { LoginPage } from './starter/auth/LoginPage';
import { AppRouter } from './starter/router';
import { demonstrationRegistry } from './registry';

/**
 * The app shell: sign-in gate, then the starter router over the demonstration registry.
 *
 * See `src/registry.ts` for the one sanctioned edge into `demonstration/`. Everything
 * below this component — layout, navigation, settings, the routed screens — is reached
 * through the registry, never through a direct import of a demonstration screen.
 */
export function App() {
  const session = useSession();
  const queryClient = useQueryClient();

  if (session.isPending) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16">
        <p role="status" className="text-slate-500">
          Loading…
        </p>
      </main>
    );
  }

  // No session, or the query failed because we are signed out. Either way: sign in.
  if (!session.data) return <LoginPage />;

  return (
    <AppRouter
      registry={demonstrationRegistry}
      onLogout={() => {
        // Everything cached belongs to the user who just signed out. Leaving domain data
        // in memory for whoever signs in next on this browser is a data leak. The app
        // shell owns this, not the starter, because the starter must not know what
        // domain caches a registered screen keeps.
        queryClient.removeQueries({
          predicate: (query) => query.queryKey[0] !== 'session',
        });
      }}
    />
  );
}
