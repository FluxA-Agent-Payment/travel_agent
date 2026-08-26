/**
 * Process-wide state that survives module duplication.
 *
 * Next.js compiles each route handler as its own module graph, and hot reload
 * re-evaluates modules on every edit. A plain module-level `Map` is therefore
 * *not* shared between `/api/chat` and `/api/orders` — a draft created by an
 * agent tool is invisible to the route that places the order, which is exactly
 * the "draft has expired" failure this exists to fix.
 *
 * Hanging the maps off `globalThis` gives one instance per process regardless
 * of how many times the module is evaluated.
 *
 * Scope note: this is per-process. It is right for a single-server demo and
 * wrong for multi-instance deployment, where these belong in Redis or a
 * database. The booking provider is the only consumer, so that swap is
 * contained to this file.
 */

const KEY = Symbol.for('flightdesk.store');

interface Store {
  maps: Map<string, Map<string, unknown>>;
}

function store(): Store {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  if (!g[KEY]) g[KEY] = { maps: new Map() };
  return g[KEY]!;
}

/**
 * A named Map shared across every module instance in this process.
 *
 * Callers get the same object back for the same name, so state written by one
 * route is readable by another.
 */
export function sharedMap<V>(name: string): Map<string, V> {
  const { maps } = store();
  let map = maps.get(name);
  if (!map) {
    map = new Map();
    maps.set(name, map);
  }
  return map as Map<string, V>;
}

/** Counter that likewise survives module reloads (used for offer handles). */
export function nextSeq(name: string): number {
  const counters = sharedMap<number>('__counters');
  const value = (counters.get(name) ?? 0) + 1;
  counters.set(name, value);
  return value;
}
