/**
 * Inter-session link derivation (src/session-links.ts) and its bounded cache
 * (src/session-links-routes.ts 'links.edges').
 *
 * The contract these cases pin:
 *
 * 1. BOTH halves of one relationship are readable from ONE session's own log —
 *    the sender's delivering `tool/call` and the recipient's relayed
 *    `user/message` `data.source`. That is what makes the panel bidirectional
 *    without scanning other sessions.
 * 2. Only DELIVERED sends count: a rejected relay ("active teammate … not
 *    found") must never fabricate an edge.
 * 3. A `send_message({target:'name'})` resolves to a session id only when the
 *    same log carries a team message from that name; otherwise the edge stays
 *    honestly unresolved (`refKind:'name'`, no navigation).
 * 4. `whales_visit_send` is one-sided by construction (it injects a bare user
 *    message with no sender marker), so its edge is flagged `oneSided`.
 * 5. Stored ids come in two shapes that are NOT interchangeable — `abc-…` and
 *    `session-abc-…` are distinct identities and are never merged.
 * 6. The response is bounded and the host cache never grows past
 *    `LINK_CACHE_LIMIT`, is keyed by the backend revision (an unchanged log is
 *    not re-read), and degrades to an empty edge set when the log is
 *    unreadable rather than surfacing an error.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DELIVER_TOOL_NAMES,
  MAX_LINK_EDGES,
  deriveSessionLinks,
  isSessionIdRef,
  type SessionLinkEvent,
} from '../src/session-links.ts'
import { LINK_CACHE_LIMIT, buildLinksApi, linkCacheSize, resetLinkCache } from '../src/session-links-routes.ts'
import type { Context } from '../src/context-types.ts'

const SELF = '11111111-1111-4111-8111-111111111111'
const PEER = '22222222-2222-4222-8222-222222222222'
const OTHER = '33333333-3333-4333-8333-333333333333'

/** One `tool/call` event, `arguments` serialised exactly as the host stores it. */
function toolCall(seq: number, time: number, name: string, args: unknown, callId = `call_${seq}`): SessionLinkEvent {
  return { type: 'tool/call', seq, time, data: { callId, name, arguments: JSON.stringify(args) } }
}

/** One `tool/result` event for `callId` (errors carry `isError`). */
function toolResult(seq: number, time: number, callId: string, isError = false): SessionLinkEvent {
  return {
    type: 'tool/result',
    seq,
    time,
    data: { message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text: 'ok' }], isError } },
  }
}

/** One relayed user message, as the host writes it. */
function userMessage(seq: number, time: number, source: Record<string, unknown>): SessionLinkEvent {
  return { type: 'user/message', seq, time, data: { role: 'user', content: [{ type: 'text', text: 'hi' }], source } }
}

/** A delivered `send_message({target, message})` relay pair. */
function relay(seq: number, time: number, target: string): SessionLinkEvent[] {
  const callId = `call_${seq}`
  return [toolCall(seq, time, 'send_message', { target, message: 'hello' }, callId), toolResult(seq + 1, time + 1, callId)]
}

describe('session links: evidence sources', () => {
  it('names exactly the two delivering tools', () => {
    expect([...DELIVER_TOOL_NAMES].sort()).toEqual(['send_message', 'whales_visit_send'])
  })

  it('recognises stored session ids in both shapes and rejects teammate names', () => {
    expect(isSessionIdRef(PEER)).toBe(true)
    expect(isSessionIdRef(`session-${PEER}`)).toBe(true)
    expect(isSessionIdRef('lead')).toBe(false)
    expect(isSessionIdRef('backend-core')).toBe(false)
    expect(isSessionIdRef('')).toBe(false)
  })

  it('derives an outbound edge from a delivered send_message call', () => {
    const result = deriveSessionLinks(SELF, relay(0, 1_000, PEER))
    expect(result.edges).toHaveLength(1)
    const [edge] = result.edges
    expect(edge).toMatchObject({
      ref: PEER,
      refKind: 'session',
      sent: 1,
      received: 0,
      total: 1,
      lastTime: 1_000,
      lastDirection: 'outbound',
      startedBy: 'outbound',
      via: ['send_message'],
      oneSided: false,
    })
    expect(result.deliveries).toBe(1)
    expect(result.dropped).toBe(0)
  })

  it('reads the older relay argument key too (`agent_id`)', () => {
    const events = [toolCall(0, 5_000, 'send_message', { agent_id: PEER, message: 'x' }, 'c1'), toolResult(1, 5_001, 'c1')]
    expect(deriveSessionLinks(SELF, events).edges[0]).toMatchObject({ ref: PEER, sent: 1 })
  })

  it('drops a send whose result failed', () => {
    const events = [toolCall(0, 1_000, 'send_message', { target: PEER, message: 'x' }, 'c1'), toolResult(1, 1_001, 'c1', true)]
    expect(deriveSessionLinks(SELF, events)).toMatchObject({ edges: [], deliveries: 0 })
  })

  it('drops a send with no result yet (still in flight)', () => {
    expect(deriveSessionLinks(SELF, [toolCall(0, 1_000, 'send_message', { target: PEER, message: 'x' })]).edges)
      .toEqual([])
  })

  it('derives an inbound edge from a relayed agent-message, with no sender-side pairing', () => {
    const result = deriveSessionLinks(SELF, [
      userMessage(0, 2_000, { kind: 'agent-message', form: 'relay', senderSessionId: PEER }),
    ])
    expect(result.edges[0]).toMatchObject({
      ref: PEER,
      refKind: 'session',
      sent: 0,
      received: 1,
      lastDirection: 'inbound',
      startedBy: 'inbound',
      via: ['agent-message'],
    })
  })

  it('derives an inbound edge and the sender label from a team-message', () => {
    const result = deriveSessionLinks(SELF, [
      userMessage(0, 2_000, { kind: 'team-message', teamId: 't', messageId: 'm', senderId: OTHER, senderName: 'backend-core' }),
    ])
    expect(result.edges[0]).toMatchObject({ ref: OTHER, refKind: 'session', label: 'backend-core', received: 1, via: ['team-message'] })
  })

  it('ignores every other user-message source (human, context, subagent notices)', () => {
    const result = deriveSessionLinks(SELF, [
      userMessage(0, 1_000, { kind: 'user' }),
      userMessage(1, 1_001, { kind: 'subagent-settled', form: 'notice', senderSessionId: PEER }),
      userMessage(2, 1_002, { kind: 'time-context' }),
      userMessage(3, 1_003, { kind: 'runtime-context' }),
    ])
    expect(result.edges).toEqual([])
  })

  it('treats a whales visit as a one-sided outbound edge', () => {
    const events = [
      toolCall(0, 3_000, 'whales_visit_send', { sessionId: `session-${PEER}`, message: 'go', mode: 'steer' }, 'w1'),
      toolResult(1, 3_001, 'w1'),
    ]
    expect(deriveSessionLinks(SELF, events).edges[0]).toMatchObject({
      ref: `session-${PEER}`,
      refKind: 'session',
      sent: 1,
      received: 0,
      via: ['whales_visit_send'],
      oneSided: true,
    })
  })

  it('does not flag a relay as one-sided once the counterpart answers', () => {
    const result = deriveSessionLinks(SELF, [
      ...relay(0, 1_000, PEER),
      userMessage(2, 2_000, { kind: 'agent-message', form: 'relay', senderSessionId: PEER }),
    ])
    expect(result.edges[0]).toMatchObject({ sent: 1, received: 1, oneSided: false, startedBy: 'outbound' })
  })
})

describe('session links: identity and dedupe', () => {
  it('merges the two directions of one relationship into one edge', () => {
    const result = deriveSessionLinks(SELF, [
      ...relay(0, 1_000, PEER),
      ...relay(2, 2_000, PEER),
      userMessage(4, 3_000, { kind: 'agent-message', form: 'relay', senderSessionId: PEER }),
    ])
    expect(result.edges).toHaveLength(1)
    expect(result.edges[0]).toMatchObject({ sent: 2, received: 1, total: 3, lastTime: 3_000, lastDirection: 'inbound' })
    expect(result.deliveries).toBe(3)
  })

  it('reports startedBy from the earlier direction, and `both` on an exact tie', () => {
    const inboundFirst = deriveSessionLinks(SELF, [
      userMessage(0, 500, { kind: 'agent-message', form: 'relay', senderSessionId: PEER }),
      ...relay(1, 9_000, PEER),
    ])
    expect(inboundFirst.edges[0]?.startedBy).toBe('inbound')

    const tie = deriveSessionLinks(SELF, [
      userMessage(0, 700, { kind: 'agent-message', form: 'relay', senderSessionId: PEER }),
      ...relay(1, 700, PEER),
    ])
    expect(tie.edges[0]?.startedBy).toBe('both')
  })

  it('never merges a bare id with its session- prefixed twin', () => {
    const result = deriveSessionLinks(SELF, [
      ...relay(0, 1_000, `session-${PEER}`),
      userMessage(2, 2_000, { kind: 'agent-message', form: 'relay', senderSessionId: PEER }),
    ])
    expect(result.edges.map(edge => edge.ref).sort()).toEqual([PEER, `session-${PEER}`].sort())
  })

  it('resolves a teammate NAME via a team message in the same log', () => {
    const result = deriveSessionLinks(SELF, [
      userMessage(0, 500, { kind: 'team-message', teamId: 't', messageId: 'm', senderId: PEER, senderName: 'backend-core' }),
      ...relay(1, 1_000, 'backend-core'),
    ])
    expect(result.edges).toHaveLength(1)
    expect(result.edges[0]).toMatchObject({ ref: PEER, refKind: 'session', label: 'backend-core', sent: 1, received: 1 })
  })

  it('keeps an unresolvable teammate name as a name-kind edge', () => {
    const result = deriveSessionLinks(SELF, relay(0, 1_000, 'frontend'))
    expect(result.edges[0]).toMatchObject({ ref: 'frontend', refKind: 'name', sent: 1 })
    expect(result.edges[0]?.label).toBe('frontend')
  })
})

describe('session links: seeded (fork-inherited) logs', () => {
  // A continuation stores the source session's events as a PREFIX. Those belong
  // to the ancestor: counting them would make two sessions both claim the same
  // exchange, and would show a brand-new continuation as freshly social.
  const inherited = [
    ...relay(0, 1_000, PEER),
    userMessage(2, 1_100, { kind: 'agent-message', form: 'relay', senderSessionId: OTHER }),
  ]
  const ownTail = [...relay(3, 9_000, 'someone-else')]

  it('ignores the inherited prefix and folds only this session own tail', () => {
    const result = deriveSessionLinks(SELF, [...inherited, ...ownTail], { inheritedEventCount: inherited.length })
    expect(result.edges.map(edge => edge.ref)).toEqual(['someone-else'])
    expect(result.deliveries).toBe(1)
  })

  it('folds the whole log when no inherited prefix is declared', () => {
    const result = deriveSessionLinks(SELF, [...inherited, ...ownTail])
    expect(result.edges.map(edge => edge.ref).sort()).toEqual([PEER, OTHER, 'someone-else'].sort())
    expect(result.deliveries).toBe(3)
  })

  it('never runs past the end when the declared prefix exceeds the log', () => {
    expect(deriveSessionLinks(SELF, [...inherited], { inheritedEventCount: 99 }))
      .toEqual({ sessionId: SELF, edges: [], deliveries: 0, dropped: 0 })
  })

  it('treats a zero prefix as "everything is mine"', () => {
    const result = deriveSessionLinks(SELF, inherited, { inheritedEventCount: 0 })
    expect(result.deliveries).toBe(2)
  })
})

describe('session links: robustness and bounds', () => {
  it('returns an empty result for an empty or unreadable log', () => {
    expect(deriveSessionLinks(SELF, [])).toEqual({ sessionId: SELF, edges: [], deliveries: 0, dropped: 0 })
  })

  it('ignores malformed arguments and unknown event types', () => {
    const events: SessionLinkEvent[] = [
      { type: 'tool/call', seq: 0, time: 1, data: { callId: 'c1', name: 'send_message', arguments: '{not json' } },
      { type: 'tool/call', seq: 1, time: 2, data: { name: 'send_message', arguments: '{"target":"x"}' } },
      { type: 'tool/result', seq: 2, time: 3, data: { message: { toolCallId: 'c1' } } },
      { type: 'session/title', seq: 3, time: 4, data: { title: 'x' } },
      { type: 'tool/call', seq: 4, time: 5, data: { callId: 'c9', name: 'bash', arguments: '{"command":"ls"}' } },
      { type: 'tool/result', seq: 5, time: 6, data: { message: { toolCallId: 'c9' } } },
    ]
    expect(deriveSessionLinks(SELF, events).edges).toEqual([])
  })

  it('sorts newest first and truncates at MAX_LINK_EDGES', () => {
    const events: SessionLinkEvent[] = []
    const total = MAX_LINK_EDGES + 5
    for (let index = 0; index < total; index += 1) {
      const id = `4444444${String(index).padStart(1, '0')}-4444-4444-8444-444444444444`
      // Ascending time: the LAST entries are the newest and must survive the cut.
      events.push(...relay(index * 2, 1_000 + index, id))
    }
    const result = deriveSessionLinks(SELF, events)
    expect(result.edges).toHaveLength(MAX_LINK_EDGES)
    expect(result.dropped).toBe(total - MAX_LINK_EDGES)
    expect(result.deliveries).toBe(total)
    const times = result.edges.map(edge => edge.lastTime)
    expect(times).toStrictEqual([...times].sort((left, right) => right - left))
    expect(result.edges[0]?.lastTime).toBe(1_000 + total - 1)
  })
})

/** Minimal `sessionPersistence` fake: a mutable log per session id. */
function fakePersistence(logs: Map<string, readonly SessionLinkEvent[]>) {
  const reads: string[] = []
  let revisionSeq = 0
  const revisions = new Map<string, string>()
  return {
    reads,
    bump(sessionId: string): void {
      revisions.set(sessionId, `rev-${String(++revisionSeq)}`)
    },
    face: {
      async open(sessionId: string) {
        reads.push(sessionId)
        const events = logs.get(sessionId)
        if (events === undefined) throw new Error('missing session')
        return {
          header: {},
          inheritedEventCount: 0,
          async read() { return { events } },
          async close() { /* nothing to release */ },
        }
      },
      async stat(sessionId: string) {
        return { revision: revisions.get(sessionId) ?? 'rev-0' }
      },
    },
  }
}

/** The route only ever calls `ctx.get('sessionPersistence')`. */
function fakeContext(persistence: unknown): Context {
  return { get: (name: string) => (name === 'sessionPersistence' ? persistence : undefined) } as unknown as Context
}

describe('links.edges route (bounded cache)', () => {
  beforeEach(() => { resetLinkCache() })

  it('serves a second read of an unchanged log from the cache', async () => {
    const logs = new Map([[SELF, relay(0, 1_000, PEER)]])
    const persistence = fakePersistence(logs)
    persistence.bump(SELF)
    const api = buildLinksApi(fakeContext(persistence.face))

    const first = await api['links.edges']({ sessionId: SELF })
    const second = await api['links.edges']({ sessionId: SELF })

    expect(first.edges).toHaveLength(1)
    expect(second).toEqual(first)
    expect(persistence.reads).toEqual([SELF])
  })

  it('re-reads when the backend revision changes', async () => {
    const events = relay(0, 1_000, PEER)
    const logs = new Map<string, readonly SessionLinkEvent[]>([[SELF, events]])
    const persistence = fakePersistence(logs)
    persistence.bump(SELF)
    const api = buildLinksApi(fakeContext(persistence.face))

    await api['links.edges']({ sessionId: SELF })
    logs.set(SELF, [...events, ...relay(2, 2_000, OTHER)])
    persistence.bump(SELF)
    const refreshed = await api['links.edges']({ sessionId: SELF })

    expect(refreshed.edges).toHaveLength(2)
    expect(persistence.reads).toEqual([SELF, SELF])
  })

  it('stays bounded across more sessions than the cache holds', async () => {
    const logs = new Map<string, readonly SessionLinkEvent[]>()
    const persistence = fakePersistence(logs)
    const total = LINK_CACHE_LIMIT + 6
    for (let index = 0; index < total; index += 1) {
      const id = `5555555${String(index).padStart(1, '0')}-5555-4555-8555-555555555555`
      logs.set(id, relay(0, 1_000 + index, PEER))
      persistence.bump(id)
    }
    const api = buildLinksApi(fakeContext(persistence.face))
    for (const id of logs.keys()) await api['links.edges']({ sessionId: id })

    expect(linkCacheSize()).toBeLessThanOrEqual(LINK_CACHE_LIMIT)
    // The newest entries survive the trim (LRU keeps the young end).
    expect(linkCacheSize()).toBe(LINK_CACHE_LIMIT)
  })

  it('degrades to an empty edge set when the log cannot be read', async () => {
    const persistence = fakePersistence(new Map())
    const api = buildLinksApi(fakeContext(persistence.face))
    await expect(api['links.edges']({ sessionId: SELF })).resolves
      .toEqual({ sessionId: SELF, edges: [], deliveries: 0, dropped: 0 })
  })

  it('degrades to an empty edge set when the host has no persistence service', async () => {
    const api = buildLinksApi(fakeContext(undefined))
    await expect(api['links.edges']({ sessionId: SELF })).resolves
      .toEqual({ sessionId: SELF, edges: [], deliveries: 0, dropped: 0 })
  })

  it('rejects a payload without a session id', async () => {
    const api = buildLinksApi(fakeContext(undefined))
    await expect(api['links.edges']({})).rejects.toThrow()
  })
})
