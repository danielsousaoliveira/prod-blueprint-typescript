import { NavLink, Outlet } from 'react-router-dom';
import type { NavEntry } from '../../registry';
import { useLogout } from '../api/hooks';

export interface AppLayoutProps {
  readonly navEntries: readonly NavEntry[];
  readonly onLogout?: (() => void) | undefined;
}

/**
 * The authenticated shell: header, navigation, sign-out, and the routed page below it.
 *
 * Navigation is built from `navEntries` plus the one link the starter itself owns
 * (Settings) — never from a hardcoded list of screens, so this component keeps working
 * unchanged whether the demonstration registry holds zero routes or several.
 */
export function AppLayout({ navEntries, onLogout }: AppLayoutProps) {
  const logout = useLogout(onLogout);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:py-12">
      <header className="mb-8 flex flex-wrap items-baseline justify-between gap-3 border-b border-slate-200 pb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Appointment scheduler
          </h1>
          <nav aria-label="Main" className="mt-3 flex gap-4 text-sm font-medium">
            {navEntries.map((entry) => (
              <NavLink
                key={entry.path}
                to={entry.path}
                className={({ isActive }) =>
                  isActive
                    ? 'text-slate-900 underline underline-offset-4'
                    : 'text-slate-500 hover:text-slate-900'
                }
              >
                {entry.label}
              </NavLink>
            ))}
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                isActive
                  ? 'text-slate-900 underline underline-offset-4'
                  : 'text-slate-500 hover:text-slate-900'
              }
            >
              Settings
            </NavLink>
          </nav>
        </div>
        <button
          type="button"
          onClick={() => logout.mutate()}
          disabled={logout.isPending}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
        >
          {logout.isPending ? 'Signing out…' : 'Sign out'}
        </button>
      </header>

      <Outlet />
    </main>
  );
}
