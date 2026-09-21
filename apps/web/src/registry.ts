import type { ComponentType } from 'react';

/**
 * The one sanctioned edge from the starter frontend to the demonstration frontend.
 *
 * There is no starter/demonstration split in `apps/web` yet, and no router — both land
 * in a later phase. This file only fixes the shape that phase will populate, so routes
 * and navigation entries have one declared home from the start rather than being
 * invented ad hoc once a router exists.
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
  routes: [],
  navEntries: [],
};
