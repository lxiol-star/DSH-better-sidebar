/**
 * Side Chat attachments: shared validation / prompt-planning rules and the
 * host half (upload route, staging table, attachment-store adapter).
 *
 * Contract pinned here:
 * - display names are validated as PLAIN LEAF names (traversal, separators and
 *   control characters refused) because the attachment store may use the name
 *   as the stored object's leaf name;
 * - image types are the store's four raster formats only, and the per-kind
 *   size caps are enforced before any bytes reach the store;
 * - text files are decoded and capped (per file + per turn) into model-facing
 *   context blocks; binary files stay durable handles;
 * - a declared text-only model still keeps the durable image block (transcript
 *   thumbnail) and receives a note instead of bytes;
 * - uploads are addressed by an opaque staging id owned by one thread: an
 *   unknown/foreign id is a retryable 409, never a citation of foreign bytes;
 * - the raw route is the only place bytes enter, and it validates first.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Buffer } from 'node:buffer'
import {
  attachmentKindOf,
  attachmentSummariesOf,
  formatAttachmentSize,
  imageInputSupportedOf,
  imageMediaTypeOf,
  isInlineContextBlock,
  isInlineTextFile,
  isTextOnlyImageNote,
  planSidechatPrompt,
  safeAttachmentName,
  textOnlyImageNote,
  SIDECHAT_ATTACH_ROUTE,
  SIDECHAT_INLINE_CHAR_CAP,
  SIDECHAT_MAX_ATTACHMENTS,
  SIDECHAT_MAX_FILE_BYTES,
  SIDECHAT_MAX_IMAGE_BYTES,
  SIDECHAT_TEXT_ONLY_IMAGE_NOTE_PREFIX,
} from '../src/sidechat-attachment-core.ts'
import {
  clearStagedSidechatAttachments,
  dropStagedSidechatAttachments,
  readSidechatImageAttachment,
  registerSidechatAttachmentRoute,
  resolveStagedSidechatAttachments,
  stageSidechatUpload,
} from '../src/sidechat-attachment-host.ts'
import { buildSidechatApi } from '../src/sidechat-routes.ts'
import { SIDE_BOUNDARY_PROMPT } from '../src/sidechat-core.ts'
import type { Context, SidebarHttpRequest, SidebarHttpResponse } from '../src/context-types.ts'

/** One durable image ref the fake store hands back. */
function imageRef(name: string, bytes: number, mediaType = 'image/png') {
  return {
    attachmentId: `sha256:${'a'.repeat(64)}` as never,
    mediaType: mediaType as 'image/png',
    bytes,
    width: 4,
    height: 4,
    name,
  }
}

/** Minimal structural host attachment store fake. */
function fakeStore(over: Record<string, unknown> = {}) {
  return {
    imageLimits: { maxImageBytes: 1024, maxImagesPerMessage: 4, maxMessageImageBytes: 4096, mediaTypes: ['image/png'] },
    saveImages: vi.fn(async (inputs: readonly { data: Uint8Array; mediaType: string; name?: string }[]) =>
      inputs.map(input => imageRef(input.name ?? 'image', input.data.length, input.mediaType))),
    saveFile: vi.fn(async ({ data, name }: { data: Uint8Array; name?: string }) => ({
      attachmentId: `sha256:${'b'.repeat(64)}` as never,
      name: name ?? 'file',
      bytes: data.length,
    })),
    readImage: vi.fn(async (ref: ReturnType<typeof imageRef>) => ({ ref, data: new Uint8Array([1, 2, 3]) })),
    ...over,
  }
}

/** A context serving only the host faces these helpers read. */
function hostCtx(store: unknown): Context {
  return {
    get: (key: string) => (key === 'attachments' ? store : undefined),
    effect: (callback: () => () => void) => { callback(); return () => {} },
    webServer: { register: () => () => {} },
  } as unknown as Context
}

const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
const textBytes = Buffer.from('hello 世界\n', 'utf8')

afterEach(() => {
  clearStagedSidechatAttachments()
})

describe('attachment display names (path safety)', () => {
  it('accepts a plain leaf name and neutralizes filesystem-illegal punctuation', () => {
    expect(safeAttachmentName('notes.md')).toBe('notes.md')
    expect(safeAttachmentName('  a b?.png  ')).toBe('a b_.png')
  })

  it('refuses traversal, separators, control characters and over-long names', () => {
    for (const bad of ['../etc/passwd', '..\\win.ini', 'dir/file.txt', '.', '..', '', '  ', 'a\nb', 'x'.repeat(200)]) {
      expect(safeAttachmentName(bad), bad).toBeNull()
    }
  })

  it('refuses non-string input', () => {
    expect(safeAttachmentName(undefined)).toBeNull()
    expect(safeAttachmentName(42)).toBeNull()
  })
})

describe('attachment type policy', () => {
  it('classifies the four raster image types as images (declared or by extension)', () => {
    expect(attachmentKindOf('shot.png', 'image/png')).toBe('image')
    expect(attachmentKindOf('shot.JPEG', undefined)).toBe('image')
    expect(attachmentKindOf('anim.gif', '')).toBe('image')
    expect(imageMediaTypeOf('shot.webp', undefined)).toBe('image/webp')
    expect(imageMediaTypeOf('shot.png', 'image/jpeg')).toBe('image/jpeg')
  })

  it('treats an unsupported declared image (SVG) as a text FILE, not an image', () => {
    expect(attachmentKindOf('logo.svg', 'image/svg+xml')).toBe('file')
    expect(imageMediaTypeOf('logo.svg', 'image/svg+xml')).toBeNull()
    expect(isInlineTextFile('logo.svg', 'image/svg+xml')).toBe(true)
  })

  it('recognizes inline-text candidates by media type, extension, and bare basename', () => {
    expect(isInlineTextFile('a.txt', '')).toBe(true)
    expect(isInlineTextFile('a.unknownext', 'text/plain')).toBe(true)
    expect(isInlineTextFile('a.unknownext', 'application/json')).toBe(true)
    expect(isInlineTextFile('Dockerfile', '')).toBe(true)
    expect(isInlineTextFile('photo.tiff', 'image/tiff')).toBe(false)
    expect(isInlineTextFile('archive.zip', 'application/zip')).toBe(false)
  })

  it('formats sizes compactly', () => {
    expect(formatAttachmentSize(980)).toBe('980 B')
    expect(formatAttachmentSize(12 * 1024)).toBe('12 KB')
    expect(formatAttachmentSize(3.2 * 1024 * 1024)).toBe('3.2 MB')
    expect(formatAttachmentSize(Number.NaN)).toBe('')
  })
})

describe('model image capability', () => {
  it('only an explicit declaration without image degrades', () => {
    expect(imageInputSupportedOf(['text'])).toBe(false)
    expect(imageInputSupportedOf(['text', 'image'])).toBe(true)
    expect(imageInputSupportedOf(undefined)).toBe(true)
    expect(imageInputSupportedOf([])).toBe(false)
  })
})

describe('prompt plan', () => {
  const fileRef = { attachmentId: 'sha256:file' as never, name: 'notes.md', bytes: 10 }

  it('carries the user text, durable file refs, and capped inline text', () => {
    const plan = planSidechatPrompt({
      text: 'summarize this',
      attachments: [{
        kind: 'file',
        name: 'notes.md',
        bytes: 10,
        ref: fileRef,
        inline: { text: '# Title\n\nbody', truncated: false },
      }],
      imageInputSupported: true,
    })
    expect(plan.content[0]).toEqual({ type: 'text', text: 'summarize this' })
    expect(plan.content[1]).toEqual({ type: 'file', attachment: fileRef })
    const inline = plan.content[2] as { type: 'text'; text: string }
    expect(inline.type).toBe('text')
    expect(isInlineContextBlock(inline.text)).toBe(true)
    expect(inline.text).toContain('# Title')
    expect(plan.degradedImages).toEqual([])
  })

  it('keeps the image block for a text-only model and appends the note', () => {
    const plan = planSidechatPrompt({
      text: '',
      attachments: [{ kind: 'image', name: 'shot.png', bytes: 4, ref: imageRef('shot.png', 4) }],
      imageInputSupported: false,
    })
    expect(plan.content[0]).toMatchObject({ type: 'image' })
    const note = plan.content[1] as { type: 'text'; text: string }
    expect(note.type).toBe('text')
    expect(isTextOnlyImageNote(note.text)).toBe(true)
    expect(note.text).toContain('shot.png')
    expect(plan.degradedImages).toEqual(['shot.png'])
  })

  it('caps the inline bodies of a turn at the shared total', () => {
    const huge = 'x'.repeat(SIDECHAT_INLINE_CHAR_CAP)
    const plan = planSidechatPrompt({
      text: '',
      attachments: [1, 2, 3].map(index => ({
        kind: 'file' as const,
        name: `part-${index}.txt`,
        bytes: huge.length,
        inline: { text: huge, truncated: false },
      })),
      imageInputSupported: true,
    })
    const inlineTotal = plan.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && isInlineContextBlock(block.text))
      .map(block => block.text.length)
      .reduce((sum, size) => sum + size, 0)
    expect(inlineTotal).toBeLessThanOrEqual(48_000 + SIDECHAT_INLINE_CHAR_CAP * 3)
    expect(plan.content.filter(block => block.type === 'text')).toHaveLength(2)
  })

  it('never emits an empty message', () => {
    const plan = planSidechatPrompt({ text: '   ', attachments: [], imageInputSupported: true })
    expect(plan.content).toEqual([])
  })

  it('builds the note from the degraded names', () => {
    expect(textOnlyImageNote(['a.png', 'b.png'])).toBe(`${SIDECHAT_TEXT_ONLY_IMAGE_NOTE_PREFIX}"a.png", "b.png".`)
  })
})

describe('attachmentSummariesOf', () => {
  it('parses durable file and image blocks and ignores unknown/malformed ones', () => {
    const rows = attachmentSummariesOf([
      { type: 'text', text: 'hi' },
      { type: 'file', attachment: { attachmentId: 'sha256:f', name: 'a.txt', bytes: 5 } },
      { type: 'image', attachment: imageRef('shot.png', 4) },
      { type: 'image', attachment: { attachmentId: 'sha256:bad' } },
      { type: 'tool-call', id: 'x' },
      null,
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ kind: 'file', name: 'a.txt', bytes: 5 })
    expect(rows[1]).toMatchObject({
      kind: 'image',
      name: 'shot.png',
      image: { mediaType: 'image/png', width: 4, height: 4 },
    })
  })

  it('tolerates a non-array content value', () => {
    expect(attachmentSummariesOf(undefined)).toEqual([])
    expect(attachmentSummariesOf('text')).toEqual([])
  })
})

describe('host staging and validation', () => {
  it('commits an image through the store and reports its normalized metadata', async () => {
    const store = fakeStore()
    const uploaded = await stageSidechatUpload(hostCtx(store), {
      childId: 'child-1',
      rawName: 'shot.png',
      rawMediaType: 'image/png',
      data: imageBytes,
    })
    expect(uploaded).toMatchObject({ kind: 'image', name: 'shot.png', width: 4, height: 4, bytes: 4 })
    expect(uploaded.uploadId).toMatch(/^att-/)
    expect(store.saveImages).toHaveBeenCalledOnce()
    // The staged entry resolves for its own thread…
    expect(resolveStagedSidechatAttachments('child-1', [uploaded.uploadId])).toHaveLength(1)
    // …and never for another one.
    expect(() => resolveStagedSidechatAttachments('child-2', [uploaded.uploadId]))
      .toThrow(expect.objectContaining({ code: 'forbidden' }))
  })

  it('saves a text file AND decodes its inline context', async () => {
    const store = fakeStore()
    const uploaded = await stageSidechatUpload(hostCtx(store), {
      childId: 'child-1',
      rawName: 'notes.md',
      rawMediaType: 'text/markdown',
      data: textBytes,
    })
    expect(uploaded.kind).toBe('file')
    expect(uploaded.inlineChars).toBe('hello 世界\n'.length)
    const [staged] = resolveStagedSidechatAttachments('child-1', [uploaded.uploadId])
    expect(staged?.inline?.text).toBe('hello 世界\n')
    expect(staged?.file?.name).toBe('notes.md')
  })

  it('degrades text files to inline-only when this host has no file store', async () => {
    const uploaded = await stageSidechatUpload(hostCtx({}), {
      childId: 'child-1',
      rawName: 'notes.txt',
      rawMediaType: 'text/plain',
      data: textBytes,
    })
    const [staged] = resolveStagedSidechatAttachments('child-1', [uploaded.uploadId])
    expect(staged?.file).toBeUndefined()
    expect(staged?.inline?.text).toContain('hello')
  })

  it('refuses a binary file when this host has no file store', async () => {
    await expect(stageSidechatUpload(hostCtx({}), {
      childId: 'child-1',
      rawName: 'blob.bin',
      rawMediaType: 'application/octet-stream',
      data: new Uint8Array([0, 1, 2, 3]),
    })).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('refuses a traversal name before any byte is stored', async () => {
    const store = fakeStore()
    await expect(stageSidechatUpload(hostCtx(store), {
      childId: 'child-1',
      rawName: '../../etc/passwd',
      rawMediaType: 'text/plain',
      data: textBytes,
    })).rejects.toMatchObject({ code: 'bad-request' })
    expect(store.saveFile).not.toHaveBeenCalled()
  })

  it('enforces the per-kind size caps and the declared image type', async () => {
    const store = fakeStore()
    await expect(stageSidechatUpload(hostCtx(store), {
      childId: 'child-1',
      rawName: 'huge.png',
      rawMediaType: 'image/png',
      data: new Uint8Array(SIDECHAT_MAX_IMAGE_BYTES + 1),
    })).rejects.toMatchObject({ code: 'too-large' })
    await expect(stageSidechatUpload(hostCtx(store), {
      childId: 'child-1',
      rawName: 'huge.txt',
      rawMediaType: 'text/plain',
      data: new Uint8Array(SIDECHAT_MAX_FILE_BYTES + 1),
    })).rejects.toMatchObject({ code: 'too-large' })
    // The deployment's own image cap wins when it is the smaller one.
    await expect(stageSidechatUpload(hostCtx({ ...store, imageLimits: { maxImageBytes: 2 } }), {
      childId: 'child-1',
      rawName: 'shot.png',
      rawMediaType: 'image/png',
      data: imageBytes,
    })).rejects.toMatchObject({ code: 'too-large' })
  })

  it('refuses to stage an image when the host has no image store', async () => {
    await expect(stageSidechatUpload(hostCtx({}), {
      childId: 'child-1',
      rawName: 'shot.png',
      rawMediaType: 'image/png',
      data: imageBytes,
    })).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('rejects a stale upload id with a retryable error and a malformed list up front', () => {
    expect(() => resolveStagedSidechatAttachments('child-1', ['att-gone']))
      .toThrow(expect.objectContaining({ code: 'sidechat-error', status: 409 }))
    expect(() => resolveStagedSidechatAttachments('child-1', 'not-an-array'))
      .toThrow(expect.objectContaining({ code: 'bad-request' }))
    expect(() => resolveStagedSidechatAttachments('child-1', Array.from({ length: SIDECHAT_MAX_ATTACHMENTS + 1 }, () => 'x')))
      .toThrow(expect.objectContaining({ code: 'bad-request' }))
    expect(resolveStagedSidechatAttachments('child-1', undefined)).toEqual([])
  })

  it('drops a thread\'s staged entries on dispose and evicts the oldest beyond the bound', async () => {
    const store = fakeStore()
    const target = 'child-1'
    const first = await stageSidechatUpload(hostCtx(store), {
      childId: target,
      rawName: 'a.txt',
      rawMediaType: 'text/plain',
      data: textBytes,
    })
    dropStagedSidechatAttachments(target)
    expect(() => resolveStagedSidechatAttachments(target, [first.uploadId]))
      .toThrow(expect.objectContaining({ code: 'sidechat-error' }))
    // The staging table is bounded: the 65th upload pushes the first one out.
    let oldest = ''
    for (let index = 0; index < 65; index += 1) {
      const uploaded = await stageSidechatUpload(hostCtx(store), {
        childId: target,
        rawName: `f-${index}.txt`,
        rawMediaType: 'text/plain',
        data: textBytes,
      })
      if (index === 0) oldest = uploaded.uploadId
    }
    expect(() => resolveStagedSidechatAttachments(target, [oldest]))
      .toThrow(expect.objectContaining({ code: 'sidechat-error' }))
  })
})

describe('host image read (transcript thumbnail)', () => {
  it('returns base64 bytes after validating the durable reference', async () => {
    const store = fakeStore()
    const value = await readSidechatImageAttachment(hostCtx(store), imageRef('shot.png', 3))
    expect(value.mediaType).toBe('image/png')
    expect(Buffer.from(value.data, 'base64')).toEqual(Buffer.from([1, 2, 3]))
  })

  it('refuses malformed references and deployments without the store', async () => {
    await expect(readSidechatImageAttachment(hostCtx(fakeStore()), { attachmentId: '' }))
      .rejects.toMatchObject({ code: 'bad-request' })
    await expect(readSidechatImageAttachment(hostCtx(fakeStore()), { ...imageRef('a.png', 3), mediaType: 'text/plain' }))
      .rejects.toMatchObject({ code: 'bad-request' })
    await expect(readSidechatImageAttachment(hostCtx({}), imageRef('a.png', 3)))
      .rejects.toMatchObject({ code: 'unavailable' })
  })
})

describe('upload route', () => {
  /** A response face capturing what the route wrote. */
  function response() {
    const state = { status: 0, body: '' }
    const res: SidebarHttpResponse = {
      statusCode: 0,
      writeHead(status) { state.status = status },
      write() { return true },
      end(body) { state.body = String(body ?? '') },
    }
    return { res, state }
  }

  /** The route handler captured out of the fake webServer registration. */
  interface RouteHarness {
    dispatch: (input: {
      method?: string
      query?: Record<string, string>
      body?: Uint8Array
      trusted?: boolean
    }) => Promise<{ status: number, body: string }>
  }

  /** Register the route on a fake context and expose one dispatch call. */
  function harness(store: unknown = fakeStore()): RouteHarness {
    let handler: ((req: SidebarHttpRequest, res: SidebarHttpResponse) => Promise<void>) | undefined
    const ctx = {
      get: (key: string) => (key === 'attachments' ? store : undefined),
      effect: (callback: () => () => void) => { callback(); return () => {} },
      webServer: {
        register: (route: { handler: (req: SidebarHttpRequest, res: SidebarHttpResponse) => Promise<void> }) => {
          handler = route.handler
          return () => {}
        },
      },
    } as unknown as Context
    registerSidechatAttachmentRoute(ctx, req => (req as unknown as { trusted?: boolean }).trusted !== false)
    return {
      async dispatch(input) {
        const query = new URLSearchParams(input.query ?? {}).toString()
        const req = {
          url: `http://x${SIDECHAT_ATTACH_ROUTE}?${query}`,
          method: input.method ?? 'POST',
          headers: {},
          trusted: input.trusted,
          async *[Symbol.asyncIterator]() {
            if (input.body !== undefined) yield input.body
          },
        } as unknown as SidebarHttpRequest
        const { res, state } = response()
        if (handler === undefined) throw new Error('route not registered')
        await handler(req, res)
        return state
      },
    }
  }

  it('answers the staged descriptor for a trusted POST', async () => {
    const route = harness()
    const state = await route.dispatch({
      query: { childId: 'child-1', name: 'notes.txt', mediaType: 'text/plain' },
      body: textBytes,
    })
    expect(state.status).toBe(200)
    const parsed = JSON.parse(state.body) as { ok: boolean, value: { uploadId: string, kind: string, name: string } }
    expect(parsed.ok).toBe(true)
    expect(parsed.value).toMatchObject({ kind: 'file', name: 'notes.txt' })
    expect(parsed.value.uploadId).toMatch(/^att-/)
  })

  it('refuses untrusted callers, non-POST methods and oversized bodies', async () => {
    const route = harness()
    expect((await route.dispatch({ query: { childId: 'c' }, body: textBytes, trusted: false })).status).toBe(403)
    expect((await route.dispatch({ method: 'GET', query: { childId: 'c' } })).status).toBe(405)
    const oversized = await route.dispatch({
      query: { childId: 'c', name: 'x.txt', mediaType: 'text/plain' },
      body: new Uint8Array(SIDECHAT_MAX_IMAGE_BYTES + 1),
    })
    expect(oversized.status).toBe(413)
  })

  it('reports a missing childId as a bad request', async () => {
    const route = harness()
    expect((await route.dispatch({ body: textBytes })).status).toBe(400)
  })
})

/** The boundary-delivered log one follow-up thread already carries. */
function deliveredEvents(): unknown[] {
  return [{
    type: 'user/message',
    seq: 0,
    time: 0,
    data: { content: [{ type: 'text', text: `${SIDE_BOUNDARY_PROMPT}\n\ninherited` }], source: { kind: 'user' } },
  }]
}

/** A live thread fake carrying the boundary-injection source kind. */
function threadAgent(events: unknown[]) {
  const agent = {
    id: 'child-1',
    status: 'idle' as const,
    options: { provider: 'deepseek', model: 'deepseek-chat' },
    ctx: { on: vi.fn(() => () => {}) },
    session: {
      id: 'child-1',
      header: { cwd: '/p', delegationDepth: 1, agentPreset: 'preset-a' },
      inheritedEventCount: 1,
      snapshotEvents: () => events,
      append: vi.fn((_type: string, _data: unknown) => ({ type: _type, seq: 0, time: 0, data: _data })),
    },
    inject: vi.fn(),
    followup: vi.fn(),
    cancel: vi.fn(),
    inbox: { nextTurn: [] as unknown[], nextStep: [] as unknown[], clear: vi.fn(), remove: vi.fn(() => true) },
  }
  return agent
}

/** A context serving the threads' services plus a fake attachment store / LLM. */
function promptCtx(input: {
  agent: ReturnType<typeof threadAgent>
  store?: unknown
  modalities?: readonly string[]
  rename?: (session: unknown, title: string) => void
}): Context {
  const table: Record<string, unknown> = {
    agents: { get: (id: string) => (id === input.agent.id ? input.agent : undefined) },
    attachments: input.store ?? fakeStore(),
    llm: input.modalities === undefined
      ? {}
      : { resolveModelInfo: vi.fn(async () => ({ inputModalities: input.modalities })) },
    ...(input.rename === undefined
      ? {}
      : { sessionTitle: { rename: vi.fn(input.rename) } }),
  }
  return { get: (key: string) => table[key] } as unknown as Context
}

describe('sidechat.prompt with attachments', () => {
  it('rides a text file as a durable ref plus capped inline context', async () => {
    const store = fakeStore()
    const agent = threadAgent(deliveredEvents())
    const ctx = promptCtx({ agent, store })
    const uploaded = await stageSidechatUpload(ctx, {
      childId: agent.id,
      rawName: 'notes.md',
      rawMediaType: 'text/markdown',
      data: textBytes,
    })
    const api = buildSidechatApi(ctx)
    await api['sidechat.prompt']({ childId: agent.id, text: 'read this', attachments: [uploaded.uploadId] })
    expect(agent.followup).toHaveBeenCalledOnce()
    const message = agent.followup.mock.calls[0]?.[0] as { content: { type: string, text?: string }[] }
    expect(message.content[0]).toEqual({ type: 'text', text: 'read this' })
    expect(message.content[1]?.type).toBe('file')
    expect(message.content.some(block => block.type === 'text' && isInlineContextBlock(block.text ?? ''))).toBe(true)
    expect(agent.inject).not.toHaveBeenCalled()
  })

  it('degrades images to a durable ref plus a note for a declared text-only model', async () => {
    const store = fakeStore()
    const agent = threadAgent(deliveredEvents())
    const ctx = promptCtx({ agent, store, modalities: ['text'] })
    const uploaded = await stageSidechatUpload(ctx, {
      childId: agent.id,
      rawName: 'shot.png',
      rawMediaType: 'image/png',
      data: imageBytes,
    })
    const api = buildSidechatApi(ctx)
    await api['sidechat.prompt']({ childId: agent.id, text: 'what is this?', attachments: [uploaded.uploadId] })
    const message = agent.followup.mock.calls[0]?.[0] as { content: { type: string, text?: string }[] }
    expect(message.content[1]?.type).toBe('image')
    const note = message.content.at(-1)
    expect(note?.type).toBe('text')
    expect(isTextOnlyImageNote(note?.text ?? '')).toBe(true)
  })

  it('keeps the image block without a note for an image-capable model', async () => {
    const store = fakeStore()
    const agent = threadAgent(deliveredEvents())
    const ctx = promptCtx({ agent, store, modalities: ['text', 'image'] })
    const uploaded = await stageSidechatUpload(ctx, {
      childId: agent.id,
      rawName: 'shot.png',
      rawMediaType: 'image/png',
      data: imageBytes,
    })
    const api = buildSidechatApi(ctx)
    await api['sidechat.prompt']({ childId: agent.id, text: 'look', attachments: [uploaded.uploadId] })
    const message = agent.followup.mock.calls[0]?.[0] as { content: { type: string, text?: string }[] }
    expect(message.content.some(block => block.type === 'image')).toBe(true)
    expect(message.content.some(block => block.type === 'text' && isTextOnlyImageNote(block.text ?? ''))).toBe(false)
  })

  it('accepts an attachment-only message and labels the thread from it', async () => {
    const store = fakeStore()
    const events: unknown[] = []
    const agent = threadAgent(events)
    const renames: string[] = []
    const ctx = promptCtx({ agent, store, rename: (_session, title) => { renames.push(title) } })
    const uploaded = await stageSidechatUpload(ctx, {
      childId: agent.id,
      rawName: 'diagram.png',
      rawMediaType: 'image/png',
      data: imageBytes,
    })
    const api = buildSidechatApi(ctx)
    await api['sidechat.prompt']({ childId: agent.id, text: '', attachments: [uploaded.uploadId] })
    // First contact: boundary injection then the content blocks.
    expect(agent.inject).toHaveBeenCalledOnce()
    const injected = agent.inject.mock.calls[0]?.[0] as { content: { type: string, text?: string }[] }
    expect(injected.content[0]?.text).toContain(SIDE_BOUNDARY_PROMPT)
    const message = agent.followup.mock.calls[0]?.[0] as { content: { type: string }[] }
    expect(message.content[0]?.type).toBe('image')
    expect(renames[0]).toBe('Side: diagram.png')
  })

  it('refuses an empty message, a stale upload id, and a malformed list', async () => {
    const store = fakeStore()
    const agent = threadAgent(deliveredEvents())
    const ctx = promptCtx({ agent, store })
    const api = buildSidechatApi(ctx)
    await expect(api['sidechat.prompt']({ childId: agent.id, text: '' }))
      .rejects.toMatchObject({ code: 'bad-request' })
    await expect(api['sidechat.prompt']({ childId: agent.id, text: 'x', attachments: ['att-gone'] }))
      .rejects.toMatchObject({ code: 'sidechat-error' })
    await expect(api['sidechat.prompt']({ childId: agent.id, text: 'x', attachments: 'nope' }))
      .rejects.toMatchObject({ code: 'bad-request' })
    expect(agent.followup).not.toHaveBeenCalled()
  })
})

describe('sidechat.attachment', () => {
  it('answers base64 bytes for a valid reference and refuses malformed ones', async () => {
    const store = fakeStore()
    const agent = threadAgent(deliveredEvents())
    const api = buildSidechatApi(promptCtx({ agent, store }))
    const value = await api['sidechat.attachment']({ childId: agent.id, attachment: imageRef('shot.png', 4) })
    expect(value.mediaType).toBe('image/png')
    expect(Buffer.from(value.data, 'base64')).toEqual(Buffer.from([1, 2, 3]))
    await expect(api['sidechat.attachment']({ childId: agent.id, attachment: {} }))
      .rejects.toMatchObject({ code: 'bad-request' })
  })
})
