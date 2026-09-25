import type { ComponentType } from 'react';
import { SchedulerPage } from './demonstration/scheduler/SchedulerPage';

/**
 * The one sanctioned edge from the starter frontend to the demonstration frontend.
 *
 * `starter/` (sign-in, the authenticated layout, navigation, settings, the router) never
 * imports `demonstration/` directly. This file is the seam: it imports the demonstration
 * screens and hands the starter router their routes and nav entries as plain data.
 */

export interface RouteEntry {
  readonly path: string;
  readonly component: ComponentType;
}

export interface NavEntry {
  readonly label: string;
  readonly path: string;
}

export interface DemonstrationRegistry {
  readonly routes: readonly RouteEntry[];
  readonly navEntries: readonly NavEntry[];
}

export const demonstrationRegistry: DemonstrationRegistry = {
  routes: [{ path: '/', component: SchedulerPage }],
  navEntries: [{ label: 'Scheduler', path: '/' }],
};
