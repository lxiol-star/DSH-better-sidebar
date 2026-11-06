/**
 * Inter-session links: the read-only derivation of "which OTHER sessions has
 * this session exchanged messages with", in both directions.
 *
 * Framework-free (no React, no Node, no host imports) so the browser half, the
 * host route and the node test environment all fold the same transcript.
 *
 * ── where the evidence lives ─────────────────────────────────────────────
 * Every cross-session delivery in this DSH line leaves a record in the LOCAL
 * session log, so one session's own transcript is sufficient — no scan of other
 * sessions, no side index, no new persistence:
 *
 *  - OUTBOUND — the sender's log carries the delivering tool call. The two
 *    senders in the wild are the Agent-Teams relay tool `send_message`
 *    (`{target | agent_id, message}`, target being a teammate NAME or a session
 *    id) and the whales plugin's `whales_visit_send` (`{sessionId, message,
 *    mode?}`). A call only counts once its `tool/result` lands without
 *    `isError` / `data.error`, so a rejected send ("active teammate … not
 *    found") never fabricates an edge.
 *  - INBOUND — the recipient's log carries the relayed user message, whose
 *    `data.source` names the author: `{kind:'agent-message', form:'relay',
 *    senderSessionId}` (the stock `send_message` relay) or
 *    `{kind:'team-message', teamId, messageId, senderId, senderName}` (the
 *    Team channel). The source union is defined host-side in
 *    `@deepseek-ai/dsh-subagent` (`lib/types/continuation-messages.d.ts`).
 *
 * The same relationship is therefore recorded TWICE — once on each side — which
 * is what makes the panel naturally BIDIRECTIONAL: session X's own log yields
 * both `sent` and `received`, and session Y's own log yields the same pair
 * mirrored. No cross-session read is ever required.
 *
 * ── what this CANNOT see ─────────────────────────────────────────────────
 * The whales `whales_visit_send` path delivers a BARE user message: it calls
 * `agent.steer(userMessage(text))` with `source:{kind:'user'}` (see
 * dsh-agent-whales `lib/index.js` `userMessage` / the tool's `execute`), so the
 * recipient's log is indistinguishable from a human typing the words. Such an
 * exchange is visible from the sender only; the counterpart cannot reconstruct
 * it. {@link SessionLinkEdge.sent} can therefore exceed what the counterpart
 * reports as `received` — the panel states that per row instead of pretending
 * the two halves always agree.
 *
 * ── seeded logs ─────────────────────────────────────────────────────────
 * A fork/continuation stores the source session's events as an INHERITED PREFIX
 * (`header.isSeeded` + the handle's `inheritedEventCount`). Those events belong
 * to the ANCESTOR conversation: counting them would report the ancestor's
 * messages as this session's, and would make two sessions claim the same
 * exchange. Callers pass the inherited length and the fold starts after it.
 *
 * ── identity ─────────────────────────────────────────────────────────────
 * Stored session ids come in TWO shapes that are NOT interchangeable: a bare
 * UUID and a `session-<uuid>` prefixed id. The stored directory name equals the
 * header id, so the prefix is part of the identity rather than a decoration —
 * references are matched VERBATIM and never normalised by stripping it.
 */

/** Tools whose delivered call means "this session spoke to another session". */
export const DELIVER_TOOL_NAMES: ReadonlySet<string> = new Set([
  'send_message',
  'whales_visit_send',
])

/**
 * Argument keys that carry the recipient, most specific first. `target` is the
 * Agent-Teams relay's teammate name-or-id, `agent_id` the older relay's session
 * id, `sessionId` / `session_id` the whales plugin's, `to` a tolerated alias.
 */
const RECIPIENT_ARG_KEYS = ['target', 'agent_id', 'sessionId', 'session_id', 'to'] as const

/** Upper bound on edges one response carries (newest first). */
export const MAX_LINK_EDGES = 32

/** Canonical session ids: digits/letters and UUID dashes, with or without the
 *  `session-` prefix. Anything else (`lead`, `backend-core`) is a TEAMMATE NAME
 *  the transcript cannot turn into a session id on its own. */
const SESSION_ID_SHAPE = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Whether an argument/ref is shaped like a stored session id (see above). */
export function isSessionIdRef(ref: string): boolean {
  return SESSION_ID_SHAPE.test(ref)
}

/** Which side of the relationship a delivery ran. */
export type SessionLinkDirection = 'outbound' | 'inbound'

/**
 * One counterpart session and the traffic between it and the session whose log
 * this was derived from.
 *
 * The shape is intentionally flat and transport-agnostic: a consumer that draws
 * relationship lines in the workspace list needs only `ref` / `total` /
 * `lastTime` / `lastDirection`, while the side-chat panel renders `sent`,
 * `received`, `label` and `via`.
 */
export interface SessionLinkEdge {
  /**
   * The counterpart: a stored session id when {@link refKind} is `'session'`,
   * otherwise the teammate NAME carried by the send tool's arguments (the log
   * never recorded that name's session id, so it cannot be navigated to).
   */
  ref: string
  /** What {@link ref} is: a navigable session id, or a bare teammate name. */
  refKind: 'session' | 'name'
  /** Human label for the counterpart when one is known (`team-message` sender
   *  name, or the name a send used). Absent when only an id was recorded. */
  label?: string
  /** Deliveries this session initiated towards the counterpart. */
  sent: number
  /** Deliveries the counterpart initiated towards this session. */
  received: number
  /** `sent + received` — the total messages exchanged in either direction. */
  total: number
  /** Epoch milliseconds of the newest delivery in either direction. */
  lastTime: number
  /** Which side sent that newest delivery. */
  lastDirection: SessionLinkDirection
  /**
   * Which side spoke FIRST — i.e. who initiated the relationship. `'both'` when
   * the earliest message of each direction shares one timestamp (a relay's two
   * halves can land in the same millisecond), so no honest single answer exists.
   */
  startedBy: SessionLinkDirection | 'both'
  /** Transports that carried these deliveries, sorted: `'send_message'`,
   *  `'whales_visit_send'`, `'agent-message'`, `'team-message'`. */
  via: string[]
  /**
   * Deliveries this session sent that the counterpart's own log may not know
   * about — true when the ONLY outbound transport used was one that delivers a
   * provenance-free user message (`whales_visit_send`). The panel then says the
   * link is one-sided instead of implying both logs agree.
   */
  oneSided: boolean
}

/** One derived response: the edges plus the aggregates the panel footers use. */
export interface SessionLinksResult {
  /** The session whose log produced these edges. */
  sessionId: string
  /** Newest first. Bounded by {@link MAX_LINK_EDGES}. */
  edges: SessionLinkEdge[]
  /** Every delivery counted into {@link edges} (`sent + received`, pre-bound). */
  deliveries: number
  /** Counterparts dropped by {@link MAX_LINK_EDGES}. */
  dropped: number
}

/** How far into the log the fold should start (see the "seeded logs" header section). */
export interface SessionLinkOptions {
  /**
   * Length of the fork-inherited prefix — the source session's events that this
   * log replays verbatim. `0` / absent means the whole log is this session's own.
   */
  inheritedEventCount?: number
}

/** One minimal structural mirror of a stored session event (type/seq/time/data). */
export interface SessionLinkEvent {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
}

/** Mutable accumulator per counterpart, keyed by the exact reference string. */
interface MutableEdge {
  ref: string
  refKind: 'session' | 'name'
  label: string | undefined
  sent: number
  received: number
  firstOut: number
  firstIn: number
  lastTime: number
  lastDirection: SessionLinkDirection
  via: Set<string>
  outboundTools: Set<string>
}

/** Coerce one event's `data` payload to a plain object (logs are untrusted). */
function dataOf(event: SessionLinkEvent): Record<string, unknown> | undefined {
  const data: unknown = event.data
  return typeof data === 'object' && data !== null ? data as Record<string, unknown> : undefined
}

/** Parse the `arguments` field: a JSON STRING in every observed v4 log. An
 *  already-parsed object is tolerated; anything malformed yields undefined. */
function argumentsOf(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw)
      return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
    } catch {
      return undefined
    }
  }
  return typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : undefined
}

/** The recipient a send tool named, or undefined when the call named none. */
function recipientOf(args: Record<string, unknown>): string | undefined {
  for (const key of RECIPIENT_ARG_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** The `tool/result` payload of one result event. */
function resultMessageOf(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const message: unknown = data.message
  return typeof message === 'object' && message !== null ? message as Record<string, unknown> : undefined
}

/** One `tool/call` awaiting its result. */
interface PendingDelivery {
  ref: string
  tool: string
  time: number
}

/**
 * Fold one session's stored events into the counterpart edges.
 *
 * Two passes: the first harvests `team-message` sender names so an outbound
 * `send_message({target:'backend-core'})` can be resolved to that teammate's
 * session id using evidence from the SAME log; the second accumulates traffic.
 * An unresolved name stays an edge with {@link SessionLinkEdge.refKind} `'name'`
 * rather than being dropped — the reader still learns WHO the session talked to.
 *
 * @param sessionId - the session whose log these events are (the "self").
 * @param events - the stored log, in seq order (extra/unknown types are ignored).
 * @returns the edges (newest first, bounded) and their aggregates.
 */
export function deriveSessionLinks(
  sessionId: string,
  events: readonly SessionLinkEvent[],
  options: SessionLinkOptions = {},
): SessionLinksResult {
  // A seeded log opens with the ANCESTOR's events; only this session's own tail
  // is evidence about this session (see the header).
  const inherited = Math.max(0, Math.min(options.inheritedEventCount ?? 0, events.length))
  const own = inherited === 0 ? events : events.slice(inherited)
  /** senderName → senderId, harvested from this log's team messages. */
  const names = new Map<string, string>()

  for (const event of own) {
    if (event.type !== 'user/message') continue
    const source = dataOf(event)?.source
    if (typeof source !== 'object' || source === null) continue
    const { kind, senderId, senderName } = source as Record<string, unknown>
    if (kind !== 'team-message') continue
    if (typeof senderId !== 'string' || typeof senderName !== 'string') continue
    const trimmed = senderName.trim()
    if (trimmed === '' || !isSessionIdRef(senderId)) continue
    if (!names.has(trimmed)) names.set(trimmed, senderId)
  }

  const edges = new Map<string, MutableEdge>()
  /** callId → the delivery the call started (until its result decides). */
  const pending = new Map<string, PendingDelivery>()

  const bump = (
    ref: string,
    kind: 'session' | 'name',
    label: string | undefined,
    time: number,
    direction: SessionLinkDirection,
    via: string,
    tool: string,
  ): void => {
    const existing = edges.get(ref)
    const edge: MutableEdge = existing ?? {
      ref,
      refKind: kind,
      label,
      sent: 0,
      received: 0,
      firstOut: Number.POSITIVE_INFINITY,
      firstIn: Number.POSITIVE_INFINITY,
      lastTime: time,
      lastDirection: direction,
      via: new Set<string>(),
      outboundTools: new Set<string>(),
    }
    if (existing === undefined) edges.set(ref, edge)
    // A resolved id is stronger evidence than a bare name for the same ref.
    if (kind === 'session') edge.refKind = 'session'
    if (label !== undefined && edge.label === undefined) edge.label = label
    if (direction === 'outbound') {
      edge.sent += 1
      edge.outboundTools.add(tool)
      if (time < edge.firstOut) edge.firstOut = time
    } else {
      edge.received += 1
      if (time < edge.firstIn) edge.firstIn = time
    }
    edge.via.add(via)
    if (time >= edge.lastTime) {
      edge.lastTime = time
      edge.lastDirection = direction
    }
  }

  for (const event of own) {
    const data = dataOf(event)
    if (data === undefined) continue

    if (event.type === 'tool/call') {
      const tool = typeof data.name === 'string' ? data.name : ''
      if (!DELIVER_TOOL_NAMES.has(tool)) continue
      const callId = typeof data.callId === 'string' ? data.callId : ''
      if (callId === '') continue
      const args = argumentsOf(data.arguments)
      if (args === undefined) continue
      const raw = recipientOf(args)
      if (raw === undefined) continue
      const named = isSessionIdRef(raw) ? raw : names.get(raw)
      const ref = named ?? raw
      pending.set(callId, { ref, tool, time: event.time })
      continue
    }

    if (event.type === 'tool/result') {
      const message = resultMessageOf(data)
      if (message === undefined) continue
      const source = message.source
      const callId = typeof message.toolCallId === 'string'
        ? message.toolCallId
        : typeof source === 'object' && source !== null && typeof (source as Record<string, unknown>).callId === 'string'
          ? (source as Record<string, unknown>).callId as string
          : ''
      if (callId === '') continue
      const delivery = pending.get(callId)
      if (delivery === undefined) continue
      // A rejected / errored send never reached the counterpart.
      pending.delete(callId)
      if (message.isError === true || data.error !== undefined) continue
      const kind = isSessionIdRef(delivery.ref) ? 'session' : 'name'
      bump(delivery.ref, kind, kind === 'name' ? delivery.ref : undefined, delivery.time, 'outbound', delivery.tool, delivery.tool)
      continue
    }

    if (event.type !== 'user/message') continue
    const source = data.source
    if (typeof source !== 'object' || source === null) continue
    const fields = source as Record<string, unknown>
    const kind = fields.kind
    if (kind === 'agent-message') {
      const sender = fields.senderSessionId
      if (typeof sender !== 'string' || sender === '') continue
      bump(sender, 'session', undefined, event.time, 'inbound', 'agent-message', 'agent-message')
      continue
    }
    if (kind === 'team-message') {
      const sender = fields.senderId
      if (typeof sender !== 'string' || sender === '') continue
      const name = typeof fields.senderName === 'string' && fields.senderName.trim() !== ''
        ? fields.senderName.trim()
        : undefined
      bump(sender, isSessionIdRef(sender) ? 'session' : 'name', name, event.time, 'inbound', 'team-message', 'team-message')
    }
  }

  const ordered = [...edges.values()]
  const deliveries = ordered.reduce((sum, edge) => sum + edge.sent + edge.received, 0)
  ordered.sort((left, right) => right.lastTime - left.lastTime || left.ref.localeCompare(right.ref))

  const kept = ordered.slice(0, MAX_LINK_EDGES)
  return {
    sessionId,
    edges: kept.map((edge): SessionLinkEdge => {
      const startedBy: SessionLinkEdge['startedBy'] =
        edge.firstOut === edge.firstIn
          ? 'both'
          : edge.firstOut < edge.firstIn ? 'outbound' : 'inbound'
      const oneSided = edge.sent > 0
        && edge.outboundTools.size > 0
        && [...edge.outboundTools].every(tool => tool === 'whales_visit_send')
        && edge.received === 0
      return {
        ref: edge.ref,
        refKind: edge.refKind,
        ...(edge.label !== undefined ? { label: edge.label } : {}),
        sent: edge.sent,
        received: edge.received,
        total: edge.sent + edge.received,
        lastTime: edge.lastTime,
        lastDirection: edge.lastDirection,
        startedBy,
        via: [...edge.via].sort(),
        oneSided,
      }
    }),
    deliveries,
    dropped: Math.max(0, ordered.length - kept.length),
  }
}
