/**
 * EditorHost's "locate current file" wiring (the docked tree panel).
 *
 * TreePanel's contract is covered by tree-panel-locate.spec.tsx; this spec
 * proves the host side end to end: the docked editor tab's locate button
 * writes the reveal into the tab's OWN session state (`revealPaths`: ancestors
 * expanded, `revealed` = the resolved absolute path), the already-existing
 * FileTree scroll effect then centers+clamps the highlighted row by scrolling
 * the tree body ONLY (never `row.scrollIntoView`, which would also scroll the
 * clipping panel host), and a SECOND click scrolls again — `revealPaths`
 * returns a fresh `revealed` array even when the set is unchanged, and the
 * effect keys on that identity.
 *
 * The real workbench re-renders EditorHost with the session state's
 * expanded/revealed on every store change (Sidebar subscribes); the harness
 * mirrors that explicitly after the click, exactly like editor-host.spec.tsx.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { Context } from '../src/context-types.ts'
import { EditorHost } from '../src/client/EditorHost.tsx'
import { t } from '../src/client/locales.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import { allLeaves, createSidebarStore, type SidebarTab } from '../src/client/state.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so the panel's copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

/** The tree root and the one directory the reveal must expand. */
const CWD = '/tmp'
const DIR = '/tmp/src'
/** The tab's file — inside the cwd, so the reveal resolves to itself. */
const FILE = '/tmp/src/a.ts'

// jsdom defines no scrollIntoView; counting calls needs a real function. The
// test asserts it is NEVER used (it would scroll every scrollable ancestor).
const scrollIntoView = vi.fn()
beforeAll(() => {
  ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = scrollIntoView
})

const { fsTrees } = vi.hoisted(() => ({
  fsTrees: vi.fn(async (_scope: unknown, paths: readonly string[]) => ({
    levels: paths.map(path => (path === CWD
      ? { path, entries: [{ name: 'src', path: '/tmp/src', isDir: true }], truncated: false }
      : path === '/tmp/src'
        ? { path, entries: [{ name: 'a.ts', path: '/tmp/src/a.ts', isDir: false }], truncated: false }
        : { path, entries: [], truncated: false })),
  })),
}))

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTrees,
    // The shared git-status store polls this; a non-repo answer keeps rows plain.
    gitStatus: async () => ({ isRepo: false, entries: [] }),
    // The editor tab's file-op stream is live for a real (non-empty) path; an
    // empty answer keeps the poll harmless.
    changesOps: async () => ({ events: [], lastSeq: 0 }),
    fsSearch: async () => ({ matches: [], dirs: [], truncated: false }),
  },
  // The load path is viewer-less for `.ts` here, which renders the binary
  // download pane; that pane builds its href from downloadUrl at render time.
  downloadUrl: () => '/sidebar/file',
}))

let sessionSeq = 0
let sessionId: string

beforeEach(() => {
  // Layout persistence is process-global (a store persists after 200ms), so
  // another case must never hydrate this one's session id, and the previous
  // case's treeOpen flag must not decide whether this one mounts its tree.
  sessionId = `editor-locate-session-${++sessionSeq}`
  localStorage.clear()
  fsTrees.mockClear()
})

/** A store + the fake client ctx for one session, seeded fresh per test. */
function setup(): {
  store: ReturnType<typeof createSidebarStore>
  ctx: Context
  service: ReturnType<typeof createBetterSidebarService>
} {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  // openTab dedupes by path, so the tab type needs its descriptor.
  service.registerTab({ id: 'editor', title: 'Editor', dedupeKey: (tab) => tab.path, component: () => null })
  store.setSession(sessionId)
  const sessionsSnapshot = { byId: { [sessionId]: { cwd: CWD } }, current: sessionId }
  const ctx = {
    get: (name: string) => name === 'betterSidebar' ? service : undefined,
    // openSidebarFile reads the session cwd from the session feed.
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => sessionsSnapshot } },
  } as unknown as Context
  return { store, ctx, service }
}

/**
 * Mount EditorHost for one tab. The render reads the tab's session state on
 * every pass, so `rerender()` after a store write mirrors the Sidebar
 * subscription that feeds `expanded`/`revealed` in the real app.
 */
async function mountHost(
  ctx: Context,
  store: ReturnType<typeof createSidebarStore>,
  cwd: string,
  pick: (tab: SidebarTab) => boolean,
): Promise<{
  container: HTMLDivElement
  rerender: () => Promise<void>
  unmount: () => void
}> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const render = (): void => {
    const tab = allLeaves(store.getSnapshot().state!.bottomSplits)
      .flatMap(leaf => leaf.tabs)
      .find(pick)
    if (tab === undefined) throw new Error('tab not seeded')
    const state = store.getSessionState(sessionId)
    if (state === undefined) throw new Error('session state not seeded')
    root.render(createElement(EditorHost, {
      ctx,
      store,
      scope: { sessionId, cwd },
      tab,
      expanded: state.expanded,
      revealed: state.revealed,
      onToggleDir: () => {},
      onReferenceFile: () => {},
    }))
  }
  // The async act flushes the tree's first level load, so the mounted tree
  // settles inside act instead of warning on a stray background update.
  await act(async () => { render() })
  return {
    container,
    rerender: async () => { await act(async () => { render() }) },
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

/** One button by its accessible name (the panel-local IconButton labels). */
function buttonByLabel(container: HTMLElement, label: string): HTMLButtonElement | null {
  return [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.getAttribute('aria-label') === label) ?? null
}

/**
 * The FileTree body: the `.explorerBody` that carries row-name spans (the
 * panel's parked search-results body has rows too, but no name spans).
 */
function treeBody(container: HTMLElement): HTMLElement {
  const body = [...container.querySelectorAll<HTMLElement>('div[class*="explorerBody"]')]
    .find(el => el.querySelector('[class*="explorerName"]') !== null)
  if (body === undefined) throw new Error('tree body not mounted')
  return body
}

/** Wait for one named tree row (the levels load asynchronously). */
async function waitForRow(container: HTMLElement, name: string): Promise<void> {
  // A macrotask boundary first, as in editor-host.spec.tsx: under load React
  // can defer the level flush past the microtasks the mount helper drains.
  await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
  await vi.waitFor(() => {
    const found = [...container.querySelectorAll<HTMLElement>('[class*="explorerName"]')]
      .some(el => el.textContent === name)
    expect(found).toBe(true)
  }, { timeout: 20_000 })
}

// jsdom has no layout: the body/row geometry below is pinned so the scroll
// target is a known number. Body: top 100, 300 tall, 1000 content tall,
// scrolled 40; the revealed row lands at 400, 20 tall:
//   target = 40 + (400 + 10) − (100 + 150) = 200, inside the clamp (0…700).
const BODY_TOP = 100
const BODY_CLIENT = 300
const BODY_SCROLL_HEIGHT = 1000
const BODY_SCROLL_TOP = 40
const ROW_TOP = 400
const ROW_HEIGHT = 20
const EXPECTED_SCROLL_TOP = 200

const nativeGetBoundingClientRect = Element.prototype.getBoundingClientRect
let rowRectPatched = false

/** Pin the highlighted row's geometry for the scroll effect's math. */
function stubRevealedRowRect(): void {
  rowRectPatched = true
  Element.prototype.getBoundingClientRect = (function (this: Element): DOMRect {
    if (this.hasAttribute('data-dsh-revealed')) {
      return { top: ROW_TOP, height: ROW_HEIGHT } as DOMRect
    }
    return nativeGetBoundingClientRect.call(this)
  }) as Element['getBoundingClientRect']
}

/** Pin the tree body's geometry and capture its scroll calls. */
function stubTreeBody(body: HTMLElement): ReturnType<typeof vi.fn> {
  const scrollTo = vi.fn()
  Object.defineProperty(body, 'scrollTo', { value: scrollTo })
  Object.defineProperty(body, 'getBoundingClientRect', { value: () => ({ top: BODY_TOP, height: BODY_CLIENT }) })
  Object.defineProperty(body, 'clientHeight', { value: BODY_CLIENT })
  Object.defineProperty(body, 'scrollHeight', { value: BODY_SCROLL_HEIGHT })
  Object.defineProperty(body, 'scrollTop', { value: BODY_SCROLL_TOP, writable: true })
  return scrollTo
}

afterEach(() => {
  if (rowRectPatched) {
    Element.prototype.getBoundingClientRect = nativeGetBoundingClientRect
    rowRectPatched = false
  }
  scrollIntoView.mockClear()
  document.body.innerHTML = ''
})

describe('EditorHost locate current file', () => {
  it('reveals, expands and scrolls the docked tree; a second click scrolls again', async () => {
    const { store, ctx, service } = setup()
    service.openTab({ type: 'editor', title: 'a.ts', path: FILE, id: `editor:${FILE}`, meta: { treeOpen: true } })

    const host = await mountHost(ctx, store, CWD, tab => tab.type === 'editor' && tab.path === FILE)
    try {
      await waitForRow(host.container, 'src')
      // Nothing is highlighted before the locate click.
      expect(host.container.querySelector('[data-dsh-revealed]')).toBeNull()
      const locate = buttonByLabel(host.container, t('editorLocateCurrent'))
      expect(locate).not.toBeNull()

      const body = treeBody(host.container)
      const scrollTo = stubTreeBody(body)
      stubRevealedRowRect()

      await act(async () => { locate!.click() })
      await host.rerender()

      // 1) The write landed in the tab's OWN session state: the ancestor is
      //    expanded and the highlight is the resolved absolute path.
      const state = store.getSessionState(sessionId)!
      expect(state.revealed).toEqual([FILE])
      expect(state.expanded).toContain(DIR)

      // 2) The highlighted row exists in the DOM…
      await vi.waitFor(() => {
        expect(host.container.querySelector('[data-dsh-revealed]')).not.toBeNull()
      }, { timeout: 20_000 })
      expect(host.container.querySelector('[data-dsh-revealed]')!.textContent).toContain('a.ts')

      // 3) …and the tree body (only) scrolled it into view, centered+clamped.
      await vi.waitFor(() => { expect(scrollTo).toHaveBeenCalled() }, { timeout: 20_000 })
      expect(scrollTo.mock.calls[0]![0]).toEqual({ top: EXPECTED_SCROLL_TOP, behavior: 'smooth' })
      expect(scrollIntoView).not.toHaveBeenCalled()

      // 4) A second click must scroll AGAIN: `revealPaths` returns a fresh
      //    array, and the effect keys on that identity.
      const callsBefore = scrollTo.mock.calls.length
      const again = buttonByLabel(host.container, t('editorLocateCurrent'))!
      await act(async () => { again.click() })
      await host.rerender()
      await vi.waitFor(() => {
        expect(scrollTo.mock.calls.length).toBeGreaterThan(callsBefore)
      }, { timeout: 20_000 })
      expect(scrollTo.mock.calls.at(-1)![0]).toEqual({ top: EXPECTED_SCROLL_TOP, behavior: 'smooth' })
      expect(store.getSessionState(sessionId)!.revealed).toEqual([FILE])
      expect(scrollIntoView).not.toHaveBeenCalled()
    } finally {
      host.unmount()
    }
  })

  it('a standalone explorer (the path-less tree-only window) gets no locate button', async () => {
    const { store, ctx, service } = setup()
    // Default prefs are split mode: a path-less files window IS the explorer.
    service.openTab({ type: 'editor', title: 'Files', meta: { treeOpen: true } })

    const host = await mountHost(ctx, store, CWD, tab => tab.type === 'editor' && tab.path === undefined)
    try {
      await waitForRow(host.container, 'src')
      // The full tree panel (search row included) rendered — the absence of
      // the locate affordance is the host's in-place/standalone difference,
      // not a missing tree.
      expect(host.container.querySelector('input[class*="editorSearchInput"]')).not.toBeNull()
      expect(buttonByLabel(host.container, t('refresh'))).not.toBeNull()
      expect(buttonByLabel(host.container, t('editorLocateCurrent'))).toBeNull()
    } finally {
      host.unmount()
    }
  })

  it('normalizes a typed "./" spelling before matching the row', async () => {
    const { store, ctx, service } = setup()
    // The path bar stores what the user typed, so the tab can carry `./`.
    // Rows keep the host's normalized spelling — without normalization the
    // reveal would highlight nothing AND persist unmatched `expanded` entries.
    const typed = `${CWD}/./src/a.ts`
    service.openTab({ type: 'editor', title: 'a.ts', path: typed, id: `editor:${typed}`, meta: { treeOpen: true } })

    const host = await mountHost(ctx, store, CWD, tab => tab.type === 'editor' && tab.path === typed)
    try {
      await waitForRow(host.container, 'src')
      const locate = buttonByLabel(host.container, t('editorLocateCurrent'))
      expect(locate).not.toBeNull()
      // jsdom has no scrollTo on a div: the reveal's scroll must not throw (the
      // exact geometry is asserted by the case above).
      stubTreeBody(treeBody(host.container))
      await act(async () => { locate!.click() })
      await host.rerender()
      expect(store.getSessionState(sessionId)!.revealed).toEqual([FILE])
      expect(store.getSessionState(sessionId)!.expanded).toContain(DIR)
    } finally {
      host.unmount()
    }
  })

  it('hides the button when the previewed file cannot be a tree row (outside the root)', async () => {
    const { store, ctx, service } = setup()
    // `../outside/b.ts` resolves out of the explorer root: the tree can never
    // show it, so the affordance is absent rather than a click that can only
    // no-op (and would persist junk `expanded` entries).
    const outside = '/outside/b.ts'
    service.openTab({ type: 'editor', title: 'b.ts', path: outside, id: `editor:${outside}`, meta: { treeOpen: true } })

    const host = await mountHost(ctx, store, CWD, tab => tab.type === 'editor' && tab.path === outside)
    try {
      await waitForRow(host.container, 'src')
      expect(host.container.querySelector('input[class*="editorSearchInput"]')).not.toBeNull()
      expect(buttonByLabel(host.container, t('editorLocateCurrent'))).toBeNull()
    } finally {
      host.unmount()
    }
  })
})
