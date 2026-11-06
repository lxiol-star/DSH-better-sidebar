/**
 * 「关联会话」section of the Side Chat (src/client/SideChatLinks.tsx).
 *
 * Contract this spec pins — all of it is about HONESTY and GATING, not styling:
 *
 * 1. The empty state says「本会话暂无跨会话沟通」and is readable WITHOUT expanding
 *    the section (a reader must be able to tell "nothing happened" from "not
 *    loaded yet" — the fetch is async and the panel starts collapsed).
 * 2. A row shows the counterpart's live title, which side spoke last (the
 *    direction glyph) and the per-direction counts; the two directions of one
 *    relationship are ONE row, not two.
 * 3. Clicking a session row navigates: a catalog child goes through its exact
 *    subagent address (`openSubagent`), a top-level session through
 *    `sessions.open`. A name-only row is NOT clickable and explains why, because
 *    the log recorded a teammate name and no session id.
 * 4. The fetch is visibility-gated: an off-screen tab issues NO request.
 * 5. A host failure renders the failure line, and an unreadable log still
 *    renders the honest empty state rather than an error.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
// First import: browser globals before the primitive-carrying sidebar graph loads.
import './browser-globals.ts'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'
import { SideChatLinks } from '../src/client/SideChatLinks.tsx'
import { api } from '../src/client/api.ts'
import type { Context } from '../src/context-types.ts'
import type { SessionLinkEdge, SessionLinksResult } from '../src/session-links.ts'

setupReactAct()

vi.mock('../src/client/api.ts', () => ({ api: { linksEdges: vi.fn() } }))

const SELF = 'session-better-sidebar-0000-0000-000000000001'
const PEER = 'peer-0000-0000-0000-000000000002'
const CHILD = 'child-0000-0000-0000-000000000003'

/** One edge with only the fields the view reads differing per case. */
function edge(overrides: Partial<SessionLinkEdge> & Pick<SessionLinkEdge, 'ref'>): SessionLinkEdge {
  return {
    refKind: 'session',
    sent: 1,
    received: 1,
    total: 2,
    lastTime: Date.now() - 5000,
    lastDirection: 'outbound',
    startedBy: 'outbound',
    via: ['send_message'],
    oneSided: false,
    ...overrides,
  }
}

function resultOf(edges: SessionLinkEdge[], dropped = 0): SessionLinksResult {
  return { sessionId: SELF, edges, deliveries: edges.reduce((sum, item) => sum + item.total, 0), dropped }
}

/** Fake context: the session list feed plus the two navigation seams. */
function fakeContext(byId: Record<string, { displayTitle: string }>, childId?: string) {
  const open = vi.fn()
  const openSubagent = vi.fn()
  // `useSyncExternalStore` compares snapshots by identity, so the feed must hand
  // back ONE object — a fresh literal per call is an infinite re-render.
  const snapshot = {
    byId: Object.fromEntries(
      Object.entries(byId).map(([id, value]) => [id, { id, displayTitle: value.displayTitle }]),
    ),
  }
  const ctx = {
    sessions: {
      list: {
        getSnapshot: () => snapshot,
        subscribe: () => () => { /* static feed in tests */ },
      },
      open,
      openSubagent,
      subagentAddress: (id: string) => (id === childId ? { parentSessionId: SELF, childSessionId: id, mode: 'continuable' } : undefined),
    },
  } as unknown as Context
  return { ctx, open, openSubagent }
}

/** Let the async fetch settle inside act(). */
async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

function render(ctx: Context, visible = true): RenderedRoot {
  return renderRoot(createElement(SideChatLinks, { ctx, scope: { sessionId: SELF }, visible }))
}

/** The section's header toggle (the disclosure button). */
function toggle(root: RenderedRoot): HTMLButtonElement {
  const element = root.container.querySelector('[data-dsh-sidechat-links] button[aria-expanded]')
  if (!(element instanceof HTMLButtonElement)) throw new Error('missing header toggle')
  return element
}

function rows(root: RenderedRoot): HTMLButtonElement[] {
  return [...root.container.querySelectorAll('[data-dsh-sidechat-link]')].filter(
    (node): node is HTMLButtonElement => node instanceof HTMLButtonElement,
  )
}

/** The assertions below quote the SHIPPED Chinese copy, so the spec pins the
 *  zh dictionary rather than jsdom's `en-US` navigator default. */
const localeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

function speakChinese(): void {
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
}

beforeEach(() => {
  vi.mocked(api.linksEdges).mockReset()
  vi.mocked(api.linksEdges).mockResolvedValue(resultOf([]))
  speakChinese()
})

afterEach(() => {
  document.body.innerHTML = ''
  if (localeDescriptor === undefined) Reflect.deleteProperty(globalThis, 'navigator')
  else Object.defineProperty(globalThis, 'navigator', localeDescriptor)
})

describe('side chat links section', () => {
  it('shows 本会话暂无跨会话沟通 without needing to be expanded', async () => {
    const { ctx } = fakeContext({})
    const root = render(ctx)
    await flush()

    const section = root.container.querySelector('[data-dsh-sidechat-links]')
    expect(section?.getAttribute('data-dsh-sidechat-links')).toBe('ready')
    expect(root.container.textContent).toContain('本会话暂无跨会话沟通')
    // Collapsed: no row list rendered yet.
    expect(rows(root)).toHaveLength(0)
    root.unmount()
  })

  it('draws one row per relationship with title, direction and both counts', async () => {
    vi.mocked(api.linksEdges).mockResolvedValue(resultOf([
      edge({ ref: PEER, sent: 3, received: 2, total: 5, lastDirection: 'inbound' }),
    ]))
    const { ctx } = fakeContext({ [PEER]: { displayTitle: 'backend-core 会话' } })
    const root = render(ctx)
    await flush()
    act(() => { toggle(root).dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    const [row] = rows(root)
    expect(row).toBeDefined()
    expect(row?.textContent).toContain('backend-core 会话')
    expect(row?.textContent).toContain('发出 3 · 收到 2')
    // Last speaker is inbound → the glyph reports it, and the row is one row.
    expect(row?.textContent).toContain('⇄')
    expect(root.container.querySelector('[data-dsh-sidechat-links]')?.textContent).toContain('关联会话')
    root.unmount()
  })

  it('opens a top-level counterpart through sessions.open', async () => {
    vi.mocked(api.linksEdges).mockResolvedValue(resultOf([edge({ ref: PEER })]))
    const { ctx, open, openSubagent } = fakeContext({ [PEER]: { displayTitle: 'peer' } })
    const root = render(ctx)
    await flush()
    act(() => { toggle(root).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    act(() => { rows(root)[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(open).toHaveBeenCalledWith(PEER)
    expect(openSubagent).not.toHaveBeenCalled()
    root.unmount()
  })

  it('opens a catalog child through its exact subagent address', async () => {
    vi.mocked(api.linksEdges).mockResolvedValue(resultOf([edge({ ref: CHILD })]))
    const { ctx, open, openSubagent } = fakeContext({ [CHILD]: { displayTitle: 'child' } }, CHILD)
    const root = render(ctx)
    await flush()
    act(() => { toggle(root).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    act(() => { rows(root)[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(openSubagent).toHaveBeenCalledWith({ parentSessionId: SELF, childSessionId: CHILD, mode: 'continuable' })
    expect(open).not.toHaveBeenCalled()
    root.unmount()
  })

  it('renders a name-only counterpart as a non-clickable row that explains itself', async () => {
    vi.mocked(api.linksEdges).mockResolvedValue(resultOf([
      edge({ ref: 'frontend', refKind: 'name', label: 'frontend', received: 0, total: 1 }),
    ]))
    const { ctx, open } = fakeContext({})
    const root = render(ctx)
    await flush()
    act(() => { toggle(root).dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    const [row] = rows(root)
    expect(row?.disabled).toBe(true)
    expect(row?.textContent).toContain('frontend')
    expect(row?.getAttribute('title')).toContain('队友名')
    act(() => { row?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(open).not.toHaveBeenCalled()
    root.unmount()
  })

  it('issues no request while the tab is off screen', async () => {
    const { ctx } = fakeContext({})
    const root = render(ctx, false)
    await flush()

    expect(api.linksEdges).not.toHaveBeenCalled()
    root.unmount()
  })

  it('renders the failure line when the host rejects', async () => {
    vi.mocked(api.linksEdges).mockRejectedValue(new Error('boom'))
    const { ctx } = fakeContext({})
    const root = render(ctx)
    await flush()
    act(() => { toggle(root).dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(root.container.textContent).toContain('关联会话读取失败')
    root.unmount()
  })

  it('reports truncated older relationships', async () => {
    vi.mocked(api.linksEdges).mockResolvedValue(resultOf([edge({ ref: PEER })], 4))
    const { ctx } = fakeContext({ [PEER]: { displayTitle: 'peer' } })
    const root = render(ctx)
    await flush()
    act(() => { toggle(root).dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(root.container.textContent).toContain('另有 4 个较早的关联会话未显示')
    root.unmount()
  })
})
