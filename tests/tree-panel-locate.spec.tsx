/**
 * TreePanel's "locate current file" affordance (the docked files window).
 *
 * The search row gains an IconButton ONLY when the host passes
 * `onRevealActive` — the docked editor tab has a current file to bring into
 * view, while the standalone explorer / folder window (which renders the same
 * panel) has none and must stay button-free. The button's accessible name is
 * `t('editorLocateCurrent')`, it sits inside `.editorTreeSearch` between the
 * search input and the refresh affordance, and clicking it first DROPS a live
 * query — the reveal only scrolls the TREE body, and that body is parked
 * behind the results panel while a query is active — then hands the reveal to
 * the host's callback exactly once.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { TreePanel } from '../src/client/TreePanel.tsx'
import { t } from '../src/client/locales.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so the panel's copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const { fsTrees, fsSearch } = vi.hoisted(() => ({
  fsTrees: vi.fn(async (_scope: unknown, paths: readonly string[]) => ({
    levels: paths.map(path => ({ path, entries: [{ name: 'a.ts', path: '/tmp/a.ts', isDir: false }], truncated: false })),
  })),
  fsSearch: vi.fn(async (): Promise<{ matches: string[]; dirs: string[]; truncated: boolean }> =>
    ({ matches: ['a.ts'], dirs: [], truncated: false })),
}))

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTrees,
    fsSearch,
    // The tree reads the shared git-status store; a non-repo answer keeps
    // every row plain (this spec is about the locate affordance).
    gitStatus: async () => ({ isRepo: false, entries: [] }),
  },
  downloadUrl: () => '/sidebar/file',
}))

interface PanelHarness {
  container: HTMLDivElement
  unmount: () => void
}

function mountPanel(overrides: Partial<ComponentProps<typeof TreePanel>> = {}): PanelHarness {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(createElement(TreePanel, {
      sessionId: 'locate-s1',
      cwd: '/tmp',
      expanded: [],
      revealed: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onReferenceFile: () => {},
      ...overrides,
    }))
  })
  return {
    container,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

/** The search input of the panel's search row. */
function searchInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[class*="editorSearchInput"]')
  if (input === null) throw new Error('search input not rendered')
  return input
}

/** One button by its accessible name (the panel-local IconButton labels). */
function buttonByLabel(container: HTMLElement, label: string): HTMLButtonElement | null {
  return [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.getAttribute('aria-label') === label) ?? null
}

/** Type a query the React way and let the 300ms debounce elapse. */
async function search(container: HTMLElement, query: string): Promise<void> {
  const input = searchInput(container)
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, query)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { await new Promise<void>(resolve => { window.setTimeout(resolve, 350) }) })
}

let harness: PanelHarness | undefined

afterEach(() => {
  harness?.unmount()
  harness = undefined
  document.body.innerHTML = ''
  fsTrees.mockClear()
  fsSearch.mockClear()
})

describe('TreePanel locate-current-file button', () => {
  it('renders no locate button when the host provides no onRevealActive (standalone explorer)', async () => {
    harness = mountPanel()
    // The search row itself IS rendered — the absence below is about the
    // optional prop, not a missing panel.
    await act(async () => {})
    expect(searchInput(harness.container)).not.toBeNull()
    expect(buttonByLabel(harness.container, t('refresh'))).not.toBeNull()
    expect(buttonByLabel(harness.container, t('editorLocateCurrent'))).toBeNull()
  })

  it('renders the locate button in the search row and fires the callback exactly once', async () => {
    const onRevealActive = vi.fn()
    harness = mountPanel({ onRevealActive })
    await act(async () => {})

    const input = searchInput(harness.container)
    const locate = buttonByLabel(harness.container, t('editorLocateCurrent'))
    expect(locate).not.toBeNull()
    // The pinned en dictionary spells the affordance out; `t()` is the same
    // source the component renders from.
    expect(t('editorLocateCurrent')).toBe('Locate current file')
    expect(locate!.getAttribute('aria-label')).toBe('Locate current file')
    // IconButton: the accessible name doubles as the hover title; the glyph
    // is inlined (no primitives icon for it).
    expect(locate!.title).toBe('Locate current file')
    expect(locate!.querySelector('svg')).not.toBeNull()
    // Same search row, between the input and the refresh affordance.
    const row = input.parentElement
    expect(row).not.toBeNull()
    expect(locate!.parentElement).toBe(row)
    const children = [...row!.children]
    expect(children.indexOf(locate!)).toBeGreaterThan(children.indexOf(input))
    expect(children.indexOf(buttonByLabel(harness.container, t('refresh'))!)).toBeGreaterThan(children.indexOf(locate!))

    await act(async () => { locate!.click() })
    expect(onRevealActive).toHaveBeenCalledTimes(1)
    // Nothing was typed, so the input stays empty — the callback alone fires.
    expect(searchInput(harness.container).value).toBe('')
  })

  it('clears a live search query as part of the locate click', async () => {
    const onRevealActive = vi.fn()
    harness = mountPanel({ onRevealActive })
    await act(async () => {})
    await search(harness.container, 'a.ts')
    expect(fsSearch).toHaveBeenCalledTimes(1)
    expect(searchInput(harness.container).value).toBe('a.ts')

    const locate = buttonByLabel(harness.container, t('editorLocateCurrent'))
    expect(locate).not.toBeNull()
    await act(async () => { locate!.click() })

    // One callback, and the query is gone by the time the click settles: the
    // tree (whose body is the only thing that scrolls) is no longer parked
    // behind the results panel. React batches the setQuery with the click, so
    // the cleared input is observed after the act flush — the same click that
    // fired the callback.
    expect(onRevealActive).toHaveBeenCalledTimes(1)
    expect(searchInput(harness.container).value).toBe('')
    // The query change may not re-run the search effect's fetch at all; what
    // matters is that no additional search was requested by the clear.
    expect(fsSearch).toHaveBeenCalledTimes(1)
  })
})
