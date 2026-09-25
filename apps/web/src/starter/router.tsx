import { Route, Routes } from 'react-router-dom';
import type { DemonstrationRegistry } from '../registry';
import { AppLayout } from './layout/AppLayout';
import { SettingsPage } from './settings/SettingsPage';

export interface AppRouterProps {
  readonly registry: DemonstrationRegistry;
  readonly onLogout?: () => void;
}

/**
 * The starter's router. It consumes the registry's routes and nav entries — it never
 * imports a demonstration screen directly. That is the one sanctioned edge, drawn at
 * `src/registry.ts`, mirroring the backend's starter/demonstration boundary.
 *
 * With an EMPTY registry (no routes registered) the app must still boot to something
 * other than a blank screen, so the index route falls back to a placeholder rather than
 * matching nothing.
 */
export function AppRouter({ registry, onLogout }: AppRouterProps) {
  const hasRoutes = registry.routes.length > 0;

  return (
    <Routes>
      <Route element={<AppLayout navEntries={registry.navEntries} onLogout={onLogout} />}>
        {hasRoutes ? (
          registry.routes.map(({ path, component: Component }) => (
            <Route key={path} path={path} element={<Component />} />
          ))
        ) : (
          <Route index element={<EmptyRegistryPlaceholder />} />
        )}
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<EmptyRegistryPlaceholder />} />
      </Route>
    </Routes>
  );
}

function EmptyRegistryPlaceholder() {
  return (
    <section
      aria-labelledby="no-screens-heading"
      className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
    >
      <h2
        id="no-screens-heading"
        className="text-lg font-semibold tracking-tight text-slate-900"
      >
        No demonstration screens registered
      </h2>
      <p className="mt-2 text-sm text-slate-500">
        This is the starter shell running on its own. Register routes in{' '}
        <code className="text-slate-700">src/registry.ts</code> to add screens here.
      </p>
    </section>
  );
}
