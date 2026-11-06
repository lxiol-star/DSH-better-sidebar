/**
 * The inter-session link route of the /sidebar JSON API ('links.edges').
 *
 * The client panel asks "which sessions has THIS session exchanged messages
 * with, in both directions?" and gets back the folded edges from
 * {@link deriveSessionLinks}. All evidence comes from the caller's own stored
 * log, so the route is a single read-only replay of one session — never a scan
 * of the other sessions, and never a write.
 *
 * Read path: `sessionPersistence.open(id, 'read')` (see ./session-store.ts)
 * works while the session is live in this or another process and never takes
 * write ownership, so the panel is correct for the session the reader is
 * looking at right now. A session that cannot be read (absent service, missing
 * file, unsupported legacy format) degrades to an EMPTY result rather than an
 * error: the panel's honest empty state is "本会话暂无跨会话沟通", and a log we
 * cannot read is not evidence of communication either way.
 *
 * Cache: the fold cost is linear in the log length, which for a long session is
 * tens of thousands of events, while the panel may re-mount on every session
 * switch. The cache is therefore keyed by the persistence backend's own
 * `revision` token (`sessionPersistence.stat`, documented as existing for
 * exactly this "derived read-model cache" case) when the host offers it, so an
 * unchanged log never re-reads. Bounds:
 *
 * - at most {@link LINK_CACHE_LIMIT} sessions (LRU by last use);
 * - an entry with a read IN FLIGHT is never evicted (the same rule the module
 *   maps in this repo follow), so a concurrent burst cannot thrash;
 * - when `stat` is unavailable the cache still works but keys on the tail of
 *   the log it had to read anyway — no wrong-hit risk, just no read saving.
 *
 * No timers, no polling, no background work: nothing here runs unless a panel
 * is on screen and asks.
 */
import type { Context, SidebarSessionPersistenceService, SidebarSessionEvent } from './context-types.ts'
import { readPersistedSession } from './session-store.ts'
import { deriveSessionLinks, type SessionLinksResult } from './session-links.ts'
import { requireString } from './wire.ts'

/** How many sessions keep a derived link response. */
export const LINK_CACHE_LIMIT = 32

/** One cached fold: the log identity it was derived from, plus the response. */
interface CachedLinks {
  /** Whatever the backend said identifies this log revision (see the header). */
  readonly key: string
  readonly result: SessionLinksResult
}

/**
 * Derived responses, oldest-used first (Map preserves insertion order and a hit
 * re-inserts, which is the LRU). Module-level on purpose: the sidebar has ONE
 * host process per profile and the panel is per-session, so a per-request cache
 * would defeat the point.
 */
const linkCache = new Map<string, CachedLinks>()

/** Sessions whose fold is running right now — never evicted (see header). */
const inFlight = new Set<string>()

/** Folds running right now, so two callers share one read (see 'links.edges'). */
const activeReads = new Map<string, Promise<SessionLinksResult>>()


/**
 * How many entries the link cache currently holds.
 * Exposed for `tests/session-links.spec.ts`, which is the only way to prove the
 * bound actually holds (the cache is module-level, not injectable).
 */
export function linkCacheSize(): number {
  return linkCache.size
}

/** Empty the link cache (spec isolation; the cache is process-wide). */
export function resetLinkCache(): void {
  linkCache.clear()
  activeReads.clear()
  inFlight.clear()
}

/** Drop cached entries until the map is inside its bound, sparing in-flight reads. */
function trimCache(): void {
  if (linkCache.size <= LINK_CACHE_LIMIT) return
  for (const key of [...linkCache.keys()]) {
    if (linkCache.size <= LINK_CACHE_LIMIT) break
    if (inFlight.has(key)) continue
    linkCache.delete(key)
  }
}

/** Move one entry to the young end of the LRU. */
function touch(key: string, entry: CachedLinks): void {
  linkCache.delete(key)
  linkCache.set(key, entry)
}

/** The cache key for a log with no backend revision token available: the tail
 *  identity of the events we had to read to build it. */
function tailKey(events: readonly SidebarSessionEvent[]): string {
  const last = events[events.length - 1]
  const first = events[0]
  return `${String(events.length)}:${String(first?.seq ?? -1)}:${String(last?.seq ?? -1)}:${String(last?.time ?? -1)}`
}

/** One read-only observation of a stored session's revision, or undefined. */
async function revisionOf(
  persistence: SidebarSessionPersistenceService,
  sessionId: string,
): Promise<string | undefined> {
  const stat = persistence.stat
  if (typeof stat !== 'function') return undefined
  try {
    const snapshot = await stat.call(persistence, sessionId)
    const revision: unknown = snapshot?.revision
    return typeof revision === 'string' ? revision : undefined
  } catch {
    return undefined
  }
}

/** Fold one session's stored log into its link edges (cache aware). */
async function linksOf(
  ctx: Context,
  persistence: SidebarSessionPersistenceService,
  sessionId: string,
): Promise<SessionLinksResult> {
  const revision = await revisionOf(persistence, sessionId)
  if (revision !== undefined) {
    const hit = linkCache.get(sessionId)
    if (hit !== undefined && hit.key === revision) {
      touch(sessionId, hit)
      return hit.result
    }
  }
  const stored = await readPersistedSession(persistence, sessionId)
  const events = stored.events
  const key = revision ?? tailKey(events)
  const existing = linkCache.get(sessionId)
  if (existing !== undefined && existing.key === key) {
    touch(sessionId, existing)
    return existing.result
  }
  // A seeded log replays the ancestor's events as a prefix; those are the
  // ANCESTOR's conversations, so the fold starts after them.
  const result = deriveSessionLinks(sessionId, events, { inheritedEventCount: stored.inheritedEventCount })
  touch(sessionId, { key, result })
  trimCache()
  return result
}

/** The `links.*` route map, spread into the plugin's /sidebar API. */
export interface SidebarLinksRoutes {
  'links.edges'(payload: unknown): Promise<SessionLinksResult>
}

/**
 * Build the inter-session link routes.
 * @param ctx - the host plugin context (resolves `sessionPersistence`).
 * @returns the route handlers.
 */
export function buildLinksApi(ctx: Context): SidebarLinksRoutes {
  return {
    'links.edges': async (payload: unknown): Promise<SessionLinksResult> => {
      const sessionId = requireString(payload, 'sessionId')
      const persistence = ctx.get('sessionPersistence') as SidebarSessionPersistenceService | undefined
      if (persistence === undefined) {
        return { sessionId, edges: [], deliveries: 0, dropped: 0 }
      }
      if (inFlight.has(sessionId)) {
        // A concurrent fold for the same session: share it instead of reading
        // the log twice (two panels can mount for one session after a reload).
        const pending = activeReads.get(sessionId)
        if (pending !== undefined) return pending
      }
      inFlight.add(sessionId)
      const read = linksOf(ctx, persistence, sessionId)
        .catch((): SessionLinksResult => ({ sessionId, edges: [], deliveries: 0, dropped: 0 }))
        .finally(() => {
          inFlight.delete(sessionId)
          activeReads.delete(sessionId)
          trimCache()
        })
      activeReads.set(sessionId, read)
      return read
    },
  }
}
