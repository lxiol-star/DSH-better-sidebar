/**
 * Stale host-half diagnosis for Side Chat attachments.
 *
 * A page reload picks up the NEW client bundle from disk while the running
 * process still serves the OLD host half — the attach route then answers 404/405
 * with a non-JSON body and the tray used to show a bare "upload failed". The
 * contract pinned here:
 *  - `api.sidechatAttach` turns a 404/405 into the `host-stale` code (and keeps
 *    the ordinary envelope errors untouched);
 *  - the queued chip labels that row with the localized "restart DSH" copy and
 *    puts the raw reason in its tooltip, so the cause is visible without devtools.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { ComposerAttachmentTray } from '../src/client/SidechatAttachments.tsx'
import { SidebarApiError, api } from '../src/client/api.ts'
import { t } from '../src/client/locales.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'

setupReactAct()

// The tray's copy is locale-driven; pin the browser fallback to en.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  document.body.innerHTML = ''
})

/** One attachment file the composer would post. */
function file(): File {
  return new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' })
}

describe('side-chat attach: stale host half', () => {
  it.each([404, 405])('maps HTTP %i on the attach route to host-stale', async (status) => {
    globalThis.fetch = vi.fn(async () => new Response('', { status })) as unknown as typeof fetch
    const attempt = api.sidechatAttach('child-1', file())
    const error = await attempt.catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(SidebarApiError)
    expect((error as SidebarApiError).code).toBe('host-stale')
  })

  it('keeps the host envelope error for a served route', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ ok: false, error: { code: 'too-large', message: 'image is too big' } }),
      { status: 413, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch
    const error = await api.sidechatAttach('child-1', file()).catch((thrown: unknown) => thrown)
    expect((error as SidebarApiError).code).toBe('too-large')
  })

  it('labels the failed chip with the restart hint and keeps the reason in the tooltip', () => {
    const view = renderRoot(createElement(ComposerAttachmentTray, {
      items: [{
        id: 'row-1',
        kind: 'image' as const,
        name: 'image.png',
        bytes: 3,
        status: 'error' as const,
        errorCode: 'host-stale' as const,
        errorMessage: 'HTTP 405',
      }],
      onRemove: () => {},
    }))
    try {
      const chip = view.container.querySelector<HTMLElement>('[class*="sidechatAttachmentChip"]')
      expect(chip).not.toBeNull()
      expect(chip!.textContent).toContain(t('sideChatAttachHostStale'))
      expect(chip!.textContent).not.toContain(t('sideChatAttachFailedShort'))
      // The tooltip carries the transport reason (the panel shows it as-is).
      expect(chip!.title).toContain('HTTP 405')
      expect(chip!.title).toContain('image.png')
    } finally {
      view.unmount()
    }
  })

  it('keeps the generic label for a non-stale failure', () => {
    const view = renderRoot(createElement(ComposerAttachmentTray, {
      items: [{
        id: 'row-2',
        kind: 'file' as const,
        name: 'notes.txt',
        bytes: 3,
        status: 'error' as const,
        errorCode: 'too-large' as const,
      }],
      onRemove: () => {},
    }))
    try {
      const chip = view.container.querySelector<HTMLElement>('[class*="sidechatAttachmentChip"]')
      expect(chip!.textContent).toContain(t('sideChatAttachFailedShort'))
      expect(chip!.title).toBe('notes.txt')
    } finally {
      view.unmount()
    }
  })
})
