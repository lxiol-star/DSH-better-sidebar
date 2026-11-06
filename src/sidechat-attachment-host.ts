/**
 * Host half of Side Chat attachments: the raw upload route, the bounded
 * staging table between upload and prompt, and the adapter onto the host's
 * durable attachment store (`ctx.attachments`).
 *
 * Why an upload route at all: the `/sidebar/api` JSON envelope is capped at
 * 1 MiB (wire.ts), and base64-in-JSON would inflate every image by a third on
 * top of that. The composer therefore POSTs the File itself — one request, one
 * attachment, raw bytes — exactly like the long-standing `/sidebar/upload`
 * route. The route validates (name shape, type policy, size caps) BEFORE the
 * bytes reach the store, and the store re-validates the bytes themselves
 * (media type against the decoded image, content-addressed digest).
 *
 * Why a staging table: the prompt references uploaded bytes by an opaque
 * `uploadId`, never by a client-supplied attachment reference, so a browser
 * cannot cite an attachment it did not upload. Entries are bounded (LRU) and
 * dropped when the thread is disposed; a stale id surfaces as a clear
 * "re-attach" error instead of a dangling reference.
 *
 * No DSH source is touched and no host package is value-imported: the store,
 * like every other host service this plugin consumes, is read structurally
 * through `ctx.get('attachments')` and every method is optional so an older or
 * headless deployment degrades instead of crashing.
 */
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Context, SidebarHttpRequest, SidebarHttpResponse } from './context-types.ts'
import { decodeTextBytes } from './text-encoding.ts'
import {
  attachmentKindOf,
  formatAttachmentSize,
  imageMediaTypeOf,
  isInlineTextFile,
  safeAttachmentName,
  SIDECHAT_ATTACH_ROUTE,
  SIDECHAT_INLINE_CHAR_CAP,
  SIDECHAT_MAX_ATTACHMENTS,
  SIDECHAT_MAX_FILE_BYTES,
  SIDECHAT_MAX_IMAGE_BYTES,
  SIDECHAT_MAX_UPLOAD_BYTES,
  SIDECHAT_IMAGE_MEDIA_TYPES,
  type SidechatAttachmentKind,
  type SidechatImageMediaType,
  type SidechatInlineText,
  type SidechatUploadedAttachment,
} from './sidechat-attachment-core.ts'
import { readBytesBody, SidebarError, writeError, writeJson, writeOk } from './wire.ts'

/** One durable file reference (the LLM content vocabulary's own shape). */
type FileRef = Extract<ContentBlock, { type: 'file' }>['attachment']
/** One durable image reference (the LLM content vocabulary's own shape). */
type ImageRef = Extract<ContentBlock, { type: 'image' }>['attachment']

/**
 * The host attachment service's structural face (a plugin peer only for
 * `dsh-llm`; `dsh-attachment` is deliberately not a dependency). Every member
 * is optional: a deployment without verbatim file storage still takes images,
 * a deployment without the service degrades to inline text only.
 */
interface SidechatAttachmentStoreFace {
  readonly imageLimits?: {
    readonly maxImageBytes?: number
    readonly maxImagesPerMessage?: number
    readonly maxMessageImageBytes?: number
    readonly mediaTypes?: readonly string[]
  }
  saveImages?(inputs: readonly {
    data: Uint8Array
    mediaType: SidechatImageMediaType
    name?: string
  }[]): Promise<readonly ImageRef[]>
  saveFile?(input: { data: Uint8Array; name?: string }): Promise<FileRef>
  readImage?(ref: ImageRef): Promise<{ ref: ImageRef; data: Uint8Array }>
}

/**
 * Read the host attachment service, or undefined when this deployment has
 * none. `ctx.get` is fenced in some compositions; a throwing miss is treated
 * as "absent" like every other optional host face in this plugin.
 */
function attachmentStoreOf(ctx: Context): SidechatAttachmentStoreFace | undefined {
  try {
    return ctx.get('attachments') as SidechatAttachmentStoreFace | undefined
  } catch {
    return undefined
  }
}

/**
 * One staged upload: the durable reference(s) plus everything the prompt plan
 * needs. `file` / `image` stay undefined on the degraded paths (an inline-only
 * text file on a host without a file store).
 */
export interface StagedSidechatAttachment {
  readonly uploadId: string
  readonly childId: string
  readonly kind: SidechatAttachmentKind
  readonly name: string
  readonly bytes: number
  readonly image?: ImageRef
  readonly file?: FileRef
  readonly inline?: SidechatInlineText
  readonly inlineChars?: number
  readonly mediaType?: string
  readonly width?: number
  readonly height?: number
}

/**
 * How many uploads stay addressable across all threads. The composer stages at
 * most SIDECHAT_MAX_ATTACHMENTS per message and the tab is one thread at a
 * time; 64 covers a busy multi-thread session and keeps the table small (the
 * durable objects live in the store, this table only holds references).
 */
const STAGED_MAX = 64

/** Insertion-ordered staging table: re-inserting refreshes recency, overflow evicts the oldest. */
const stagedAttachments = new Map<string, StagedSidechatAttachment>()

/** Drop every staged entry belonging to one thread (dispose / archive). */
export function dropStagedSidechatAttachments(childId: string): void {
  for (const [id, entry] of stagedAttachments) {
    if (entry.childId === childId) stagedAttachments.delete(id)
  }
}

/** Test hook: forget every staged entry (module state must not leak between specs). */
export function clearStagedSidechatAttachments(): void {
  stagedAttachments.clear()
}

/** Remember one staged upload under a fresh opaque id; returns the id. */
function rememberStaged(entry: Omit<StagedSidechatAttachment, 'uploadId'>): string {
  const uploadId = `att-${randomUUID()}`
  stagedAttachments.set(uploadId, { ...entry, uploadId })
  while (stagedAttachments.size > STAGED_MAX) {
    const oldest = stagedAttachments.keys().next().value
    if (oldest === undefined) break
    stagedAttachments.delete(oldest)
  }
  return uploadId
}

/** Narrow an untrusted image reference from the transcript-fetch payload. */
function parseImageRef(raw: unknown): ImageRef {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SidebarError('bad-request', 'attachment must be an image reference')
  }
  const record = raw as Record<string, unknown>
  const attachmentId = record.attachmentId
  const mediaType = record.mediaType
  const bytes = record.bytes
  const width = record.width
  const height = record.height
  if (typeof attachmentId !== 'string' || attachmentId === '') {
    throw new SidebarError('bad-request', 'attachment id is required')
  }
  if (!(SIDECHAT_IMAGE_MEDIA_TYPES as readonly string[]).includes(String(mediaType))) {
    throw new SidebarError('bad-request', 'unsupported image media type')
  }
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new SidebarError('bad-request', 'attachment byte length is invalid')
  }
  if (bytes > SIDECHAT_MAX_IMAGE_BYTES) {
    throw new SidebarError('too-large', 'image exceeds the side-chat attachment limit', 413)
  }
  if (typeof width !== 'number' || !Number.isSafeInteger(width) || width <= 0
    || typeof height !== 'number' || !Number.isSafeInteger(height) || height <= 0) {
    throw new SidebarError('bad-request', 'attachment dimensions are invalid')
  }
  const name = typeof record.name === 'string' ? safeAttachmentName(record.name) : null
  return {
    attachmentId: attachmentId as ImageRef['attachmentId'],
    mediaType: mediaType as SidechatImageMediaType,
    bytes,
    width,
    height,
    ...(name === null ? {} : { name }),
  }
}

/**
 * Validate one upload and commit it to the host store.
 *
 * Validation order matters: the name is rejected before the bytes are looked
 * at (a traversal name must never reach a store that uses it as a leaf name),
 * then the per-kind size cap, then the type policy, then the store (which
 * verifies the decoded bytes against the declared media type).
 *
 * @param ctx - host plugin context.
 * @param input - the route's query values plus the bounded raw body.
 * @returns the wire descriptor the composer keeps (id + display metadata).
 * @throws {SidebarError} bad-request / too-large / unavailable.
 */
export async function stageSidechatUpload(ctx: Context, input: {
  childId: string
  rawName: unknown
  rawMediaType: unknown
  data: Uint8Array
}): Promise<SidechatUploadedAttachment> {
  const name = safeAttachmentName(input.rawName)
  if (name === null) {
    throw new SidebarError('bad-request', 'attachment name must be a plain display name')
  }
  const declaredMediaType = typeof input.rawMediaType === 'string' && input.rawMediaType !== ''
    ? input.rawMediaType
    : undefined
  const kind = attachmentKindOf(name, declaredMediaType)
  const store = attachmentStoreOf(ctx)
  if (kind === 'image') {
    const mediaType = imageMediaTypeOf(name, declaredMediaType)
    if (mediaType === null) {
      throw new SidebarError('bad-request', 'unsupported image type; attach png, jpeg, webp, or gif')
    }
    const storeCap = store?.imageLimits?.maxImageBytes
    const cap = typeof storeCap === 'number' && storeCap > 0
      ? Math.min(SIDECHAT_MAX_IMAGE_BYTES, storeCap)
      : SIDECHAT_MAX_IMAGE_BYTES
    if (input.data.length > cap) {
      throw new SidebarError('too-large', `image exceeds the ${formatAttachmentSize(cap)} attachment limit`, 413)
    }
    if (store?.saveImages === undefined) {
      throw new SidebarError('unavailable', 'this deployment has no image attachment store', 503)
    }
    let ref: ImageRef
    try {
      const refs = await store.saveImages([{ data: input.data, mediaType, name }])
      const first = refs[0]
      if (first === undefined || typeof first.attachmentId !== 'string') {
        throw new SidebarError('unavailable', 'image attachment store returned no reference', 503)
      }
      ref = first
    } catch (error) {
      if (error instanceof SidebarError) throw error
      throw new SidebarError('bad-request', error instanceof Error ? error.message : String(error))
    }
    const uploadId = rememberStaged({
      childId: input.childId,
      kind: 'image',
      name,
      bytes: ref.bytes,
      image: ref,
      mediaType: ref.mediaType,
      width: ref.width,
      height: ref.height,
    })
    return {
      uploadId,
      kind: 'image',
      name,
      bytes: ref.bytes,
      mediaType: ref.mediaType,
      width: ref.width,
      height: ref.height,
    }
  }
  if (input.data.length > SIDECHAT_MAX_FILE_BYTES) {
    throw new SidebarError(
      'too-large',
      `file exceeds the ${formatAttachmentSize(SIDECHAT_MAX_FILE_BYTES)} attachment limit`,
      413,
    )
  }
  const inline = inlineTextOf(name, declaredMediaType, input.data)
  let ref: FileRef | undefined
  if (store?.saveFile !== undefined) {
    try {
      ref = await store.saveFile({ data: input.data, name })
    } catch (error) {
      throw new SidebarError('bad-request', error instanceof Error ? error.message : String(error))
    }
  } else if (inline === undefined) {
    throw new SidebarError('unavailable', 'this deployment cannot store file attachments', 503)
  }
  const uploadId = rememberStaged({
    childId: input.childId,
    kind: 'file',
    name,
    bytes: input.data.length,
    ...(ref === undefined ? {} : { file: ref }),
    ...(inline === undefined ? {} : { inline, inlineChars: inline.text.length }),
  })
  return {
    uploadId,
    kind: 'file',
    name,
    bytes: input.data.length,
    ...(inline === undefined ? {} : { inlineChars: inline.text.length, truncated: inline.truncated }),
  }
}

/**
 * Decode one uploaded file's bytes into capped inline text, or undefined when
 * the file is not a text-like type (or is not decodable text at all).
 *
 * Reuses the editor's own encoding detector (`decodeTextBytes`): a UTF-16LE or
 * GB18030 source file attached from Windows must not reach the model as
 * mojibake, and that helper is the one place this repo decides what "text"
 * means. The inline slice is bounded twice — per file and later in the prompt
 * plan for the turn total.
 */
function inlineTextOf(name: string, mediaType: string | undefined, data: Uint8Array): SidechatInlineText | undefined {
  if (!isInlineTextFile(name, mediaType)) return undefined
  const decoded = decodeTextBytes(Buffer.from(data))
  if (decoded === null) return undefined
  const content = decoded.content
  if (content === '') return undefined
  if (content.length <= SIDECHAT_INLINE_CHAR_CAP) return { text: content, truncated: false }
  return { text: content.slice(0, SIDECHAT_INLINE_CHAR_CAP), truncated: true }
}

/**
 * Resolve the prompt's attachment ids against the staging table.
 *
 * Never trusts a client-supplied reference: an id that is unknown (evicted,
 * host restarted) or belongs to another thread surfaces as a retryable error,
 * so the composer tells the user to re-attach instead of silently dropping the
 * file from a sent turn.
 *
 * @param childId - the thread the prompt is being sent to.
 * @param rawIds - the prompt payload's `attachments` value.
 * @returns staged entries in caller order (duplicates collapsed).
 * @throws {SidebarError} bad-request on a malformed list, 409 on a stale id.
 */
export function resolveStagedSidechatAttachments(
  childId: string,
  rawIds: unknown,
): StagedSidechatAttachment[] {
  if (rawIds === undefined || rawIds === null) return []
  if (!Array.isArray(rawIds)) throw new SidebarError('bad-request', 'attachments must be an array')
  if (rawIds.length > SIDECHAT_MAX_ATTACHMENTS) {
    throw new SidebarError('bad-request', `at most ${SIDECHAT_MAX_ATTACHMENTS} attachments per message`)
  }
  const resolved: StagedSidechatAttachment[] = []
  const seen = new Set<string>()
  for (const rawId of rawIds) {
    if (typeof rawId !== 'string' || rawId === '') {
      throw new SidebarError('bad-request', 'attachment ids must be non-empty strings')
    }
    if (seen.has(rawId)) continue
    seen.add(rawId)
    const staged = stagedAttachments.get(rawId)
    if (staged === undefined) {
      throw new SidebarError(
        'sidechat-error',
        'an attachment expired before the message was sent; attach the file again',
        409,
      )
    }
    if (staged.childId !== childId) {
      throw new SidebarError('forbidden', 'attachment belongs to another thread', 403)
    }
    resolved.push(staged)
  }
  return resolved
}

/**
 * Read one durable image's bytes for the transcript thumbnail.
 *
 * The reference originates in the thread's own log (the transcript row), and
 * the host store verifies the digest before returning bytes, so this is a
 * read of an object the browser was already shown — never a path lookup.
 *
 * @param ctx - host plugin context.
 * @param rawRef - the untrusted reference from the transcript row.
 * @returns base64 bytes plus the verified media type.
 * @throws {SidebarError} bad-request on a malformed reference, unavailable
 *  when the deployment has no image store.
 */
export async function readSidechatImageAttachment(
  ctx: Context,
  rawRef: unknown,
): Promise<{ data: string; mediaType: string }> {
  const ref = parseImageRef(rawRef)
  const store = attachmentStoreOf(ctx)
  if (store?.readImage === undefined) {
    throw new SidebarError('unavailable', 'this deployment has no image attachment store', 503)
  }
  let stored: { ref: ImageRef; data: Uint8Array }
  try {
    stored = await store.readImage(ref)
  } catch (error) {
    throw new SidebarError('bad-request', error instanceof Error ? error.message : String(error))
  }
  if (stored.data.length > SIDECHAT_MAX_IMAGE_BYTES) {
    throw new SidebarError('too-large', 'image exceeds the side-chat attachment limit', 413)
  }
  return { data: Buffer.from(stored.data).toString('base64'), mediaType: ref.mediaType }
}

/**
 * Register the raw Side Chat attachment upload route:
 * `POST /sidebar/sidechat/attach?childId=&name=&mediaType=`, body = file bytes.
 *
 * @param ctx - host plugin context.
 * @param fence - the plugin's browser-trust fence (`ctx.connection.requestRejection`).
 */
export function registerSidechatAttachmentRoute(
  ctx: Context,
  fence: (req: SidebarHttpRequest) => boolean,
): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SIDECHAT_ATTACH_ROUTE,
    handler: async (req: SidebarHttpRequest, res: SidebarHttpResponse) => {
      if (!fence(req)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const childId = url.searchParams.get('childId')
        if (childId === null || childId === '') {
          throw new SidebarError('bad-request', 'childId is required')
        }
        const data = await readBytesBody(req, SIDECHAT_MAX_UPLOAD_BYTES)
        const uploaded = await stageSidechatUpload(ctx, {
          childId,
          rawName: url.searchParams.get('name'),
          rawMediaType: url.searchParams.get('mediaType'),
          data,
        })
        writeOk(res, uploaded)
      } catch (error) {
        writeError(res, error)
      }
    },
  }), 'dsh-better-sidebar: /sidebar/sidechat/attach route')
}
