/**
 * Side Chat —「会话间沟通 / 关联会话」section.
 *
 * Lists every OTHER session this conversation has exchanged messages with, in
 * both directions, newest first. The data is derived host-side from the
 * session's own stored log (see src/session-links.ts) and arrives through the
 * single `links.edges` route, so this component only renders and navigates.
 *
 * Behaviour:
 * - VISIBILITY GATED: the fetch runs when the tab is on screen and is aborted
 *   when it is not; there is no timer and no polling. Returning to the tab
 *   re-reads once (a session that ran in the background may have talked to
 *   somebody meanwhile), and the header carries an explicit refresh for the
 *   reader who wants it now.
 * - EMPTY IS HONEST: an unreadable / edge-free log renders
 *   `sideChatLinksEmpty` — "本会话暂无跨会话沟通" — never an error banner, because
 *   "no evidence" is exactly what an empty log means here.
 * - BIDIRECTIONAL BY CONSTRUCTION: the same pair is visible from both sessions
 *   because each side's own log records its half (outbound `tool/call` in the
 *   sender, the relayed `user/message` source in the recipient). The whales
 *   `whales_visit_send` transport is the one exception — it delivers a bare
 *   user message with no sender marker, so its receiver cannot reconstruct the
 *   link; such a row is flagged by the host-folded `oneSided` bit.
 *
 * A counterpart is a stored session id when one was recorded, and a bare
 * TEAMMATE NAME otherwise (`send_message({target:'backend-core'})` records only
 * the name when the log holds no team message from it). Name rows still show
 * who and how often, but cannot be clicked: opening "a name" is not a thing the
 * runtime can do, so the row says so instead of silently doing nothing.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSyncExternalStore } from 'react'
import {
  IconChevronRightOutlineRegular,
  IconRefreshOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context, SidebarSessionList } from '../context-types.ts'
import type { SessionLinkEdge, SessionLinksResult } from '../session-links.ts'
import { api, type SessionScope } from './api.ts'
import { relativeTime, t } from './locales.ts'
import css from './SideChatLinks.module.css'

/** Chevron / refresh glyph size. The host icons default to 16px, so a small
 *  inline control must ask for 14 explicitly (AGENTS §5). */
const SMALL_ICON = 14

/** The counterpart's display title: the live session list first (it carries the
 *  host's own generated title), then the recorded teammate name, then the raw
 *  reference shortened to something a reader can still match against a list. */
function titleOf(edge: SessionLinkEdge, byId: SidebarSessionList['byId']): string {
  const listed = byId[edge.ref]?.displayTitle
  if (listed !== undefined && listed.trim() !== '') return listed.trim()
  if (edge.label !== undefined && edge.label !== '') return edge.label
  if (edge.refKind === 'name') return edge.ref
  return edge.ref.length > 12 ? `${edge.ref.slice(0, 8)}…` : edge.ref
}

/** The count phrase for one row: both halves when the exchange ran both ways,
 *  the single known direction otherwise. */
function countsOf(edge: SessionLinkEdge): string {
  if (edge.sent > 0 && edge.received > 0) {
    return t('sideChatLinksSummary', { sent: edge.sent, received: edge.received })
  }
  if (edge.sent > 0) return t('sideChatLinksSentOnly', { count: edge.sent })
  return t('sideChatLinksReceivedOnly', { count: edge.received })
}

/** Direction glyph + the row's accessible name. */
function directionOf(edge: SessionLinkEdge): { glyph: string; label: string } {
  if (edge.sent > 0 && edge.received > 0) return { glyph: '⇄', label: t('sideChatLinksBothAria') }
  if (edge.sent > 0) return { glyph: '→', label: t('sideChatLinksOutAria') }
  return { glyph: '←', label: t('sideChatLinksInAria') }
}

/** Props: the plugin context (session list + navigation), the scoped session,
 *  and whether the tab is on screen (the fetch is gated on it). */
export function SideChatLinks(props: {
  ctx: Context
  scope: SessionScope
  visible: boolean
}): React.ReactNode {
  const { ctx, scope, visible } = props
  // The two scope PRIMITIVES are what the fetch depends on. Depending on the
  // `scope` object itself would re-run the effect on every parent render (the
  // caller builds it inline), turning one panel into a request loop.
  const { sessionId, cwd } = scope
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState<SessionLinksResult | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  /** Bumped by the refresh button to re-run the effect on demand. */
  const [revision, setRevision] = useState(0)

  // The live session list is what turns a stored id into a readable title.
  const list = useSyncExternalStore(
    useCallback((callback: () => void) => ctx.sessions.list.subscribe(callback), [ctx]),
    useCallback(() => ctx.sessions.list.getSnapshot(), [ctx]),
  )

  useEffect(() => {
    // Off screen: keep whatever we already have, issue nothing. This is the
    // whole visibility gate — no timer exists to stop.
    if (!visible) return
    const controller = new AbortController()
    setFailed(false)
    void api.linksEdges({ sessionId, cwd }, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return
        setResult(next)
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setFailed(true)
      })
    return () => { controller.abort() }
  }, [sessionId, cwd, visible, revision])

  /** Jump to the counterpart: a catalog child needs its exact direct-parent
   *  address (the generic open is fenced away from subagent identities), a
   *  top-level session opens directly. Name-only rows are not navigable. */
  const openCounterpart = useCallback((edge: SessionLinkEdge): void => {
    if (edge.refKind !== 'session') return
    const sessions = ctx.sessions
    const address = sessions.subagentAddress?.(edge.ref)
    if (address !== undefined) sessions.openSubagent?.(address)
    else sessions.open?.(edge.ref)
  }, [ctx])

  // Memoized: the row list depends on it, and a fresh `[]` per render would
  // rebuild every row on every parent update.
  const edges = useMemo(() => result?.edges ?? [], [result])
  const dropped = result?.dropped ?? 0
  const countLabel = edges.length > 0 ? String(edges.length) : undefined

  const rows = useMemo(() => edges.map((edge) => {
    const title = titleOf(edge, list.byId)
    const direction = directionOf(edge)
    const navigable = edge.refKind === 'session'
    return (
      <button
        key={edge.ref}
        type="button"
        className={css.row}
        data-dsh-sidechat-link={edge.refKind}
        disabled={!navigable}
        title={navigable ? t('sideChatLinksOpenAria', { title }) : t('sideChatLinksUnresolved')}
        onClick={() => { openCounterpart(edge) }}
      >
        <span className={css.glyph} data-direction={edge.lastDirection} aria-label={direction.label}>
          {direction.glyph}
        </span>
        <span className={css.rowText}>
          <span className={css.title}>{title}</span>
          <span className={css.meta}>
            <span>{countsOf(edge)}</span>
            <span className={css.dot} aria-hidden="true">·</span>
            <span>{relativeTime(new Date(edge.lastTime).toISOString())}</span>
            {edge.oneSided && (
              <>
                <span className={css.dot} aria-hidden="true">·</span>
                <span className={css.flag}>{t('sideChatLinksOneSided')}</span>
              </>
            )}
          </span>
        </span>
      </button>
    )
  }), [edges, list.byId, openCounterpart])

  return (
    <section className={css.links} data-dsh-sidechat-links={result === undefined ? 'pending' : 'ready'}>
      <div className={css.header}>
        <button
          type="button"
          className={css.toggle}
          aria-expanded={open}
          onClick={() => { setOpen(value => !value) }}
        >
          <IconChevronRightOutlineRegular size={SMALL_ICON} className={open ? css.chevronOpen : css.chevron} />
          <span className={css.headerLabel}>{t('sideChatLinks')}</span>
          {countLabel !== undefined && <span className={css.count}>{countLabel}</span>}
        </button>
        {/* The empty state has to be visible WITHOUT expanding, otherwise the
            reader cannot tell "nothing to show" from "not loaded yet". */}
        {!open && result !== undefined && edges.length === 0 && (
          <span className={css.emptyInline}>{t('sideChatLinksEmpty')}</span>
        )}
        <button
          type="button"
          className={css.refresh}
          aria-label={t('sideChatLinksRefresh')}
          title={t('sideChatLinksRefresh')}
          onClick={() => { setRevision(value => value + 1) }}
        >
          <IconRefreshOutlineRegular size={SMALL_ICON} />
        </button>
      </div>
      {open && (
        <div className={css.body}>
          {failed && <p className={css.error}>{t('sideChatLinksFailed')}</p>}
          {!failed && result !== undefined && edges.length === 0 && (
            <p className={css.empty}>{t('sideChatLinksEmpty')}</p>
          )}
          {rows.length > 0 && <div className={css.list}>{rows}</div>}
          {dropped > 0 && <p className={css.dropped}>{t('sideChatLinksDropped', { count: dropped })}</p>}
        </div>
      )}
    </section>
  )
}
