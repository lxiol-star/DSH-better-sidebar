/**
 * Shared (host + browser) attachment vocabulary for Side Chat: limits, display
 * name sanitizing, type classification, the model-facing prompt plan, and the
 * wire descriptors both halves exchange.
 *
 * Framework-free and Node-free on purpose: the host route validates with the
 * SAME constants the browser composer pre-checks with (so a file the picker
 * accepts is never refused for a different reason server-side), the transcript
 * mapper parses durable content blocks with the same parser the inbox
 * projection uses, and the node test environment can exercise the plan without
 * a host. Node-specific work (decoding a text buffer, talking to
 * `ctx.attachments`) stays in sidechat-attachment-host.ts.
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** One durable file reference as the LLM content vocabulary carries it. */
type FileRef = Extract<ContentBlock, { type: 'file' }>['attachment']
/** One durable image reference as the LLM content vocabulary carries it. */
type ImageRef = Extract<ContentBlock, { type: 'image' }>['attachment']

/** What an attachment IS to the turn: an inlinable/durable file or an image. */
export type SidechatAttachmentKind = 'file' | 'image'

/** Per-message attachment bound (one prompt can carry at most this many). */
export const SIDECHAT_MAX_ATTACHMENTS = 4

/** Raw-byte bound of one FILE attachment (text files are capped again for the inline context). */
export const SIDECHAT_MAX_FILE_BYTES = 2 * 1024 * 1024

/**
 * Raw-byte bound of one IMAGE attachment. The host attachment store may impose
 * a lower deployment limit (`imageLimits.maxImageBytes`); the effective bound
 * is the smaller of the two.
 */
export const SIDECHAT_MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** Body bound of the raw upload route (the largest per-kind cap, plus slack for form headers). */
export const SIDECHAT_MAX_UPLOAD_BYTES = SIDECHAT_MAX_IMAGE_BYTES

/** Characters of ONE text file carried as inline context. */
export const SIDECHAT_INLINE_CHAR_CAP = 24_000

/** Characters of ALL inlined text files in one turn. */
export const SIDECHAT_INLINE_TOTAL_CHAR_CAP = 48_000

/** Longest accepted attachment display name, in code units. */
export const SIDECHAT_MAX_NAME_CHARS = 120

/** Raw-byte upload route of the side-chat composer (host-registered, raw body). */
export const SIDECHAT_ATTACH_ROUTE = '/sidebar/sidechat/attach'

/** Raster media types the host's image attachment path accepts (version one). */
export const SIDECHAT_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

/** One accepted raster image media type. */
export type SidechatImageMediaType = (typeof SIDECHAT_IMAGE_MEDIA_TYPES)[number]

/** Image extensions mapped onto the media types above (the picker omits MIME). */
const IMAGE_EXTENSIONS: Readonly<Record<string, SidechatImageMediaType>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

/**
 * Extensions a text file is likely to carry. Only these (plus `text/*` media
 * types and the basenames below) are decoded and inlined; anything else is
 * still attached durably (the model receives the store's file handle, and the
 * tools can open it) but is never decoded as prose.
 */
const INLINE_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  'txt', 'text', 'md', 'markdown', 'mdx', 'rst', 'adoc', 'org', 'log', 'csv', 'tsv',
  'json', 'jsonc', 'json5', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'xml', 'html', 'htm', 'xhtml', 'svg', 'css', 'scss', 'sass', 'less', 'styl',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue', 'svelte', 'astro',
  'py', 'pyi', 'rb', 'php', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'clj', 'cljs',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'm', 'mm', 'swift', 'cs', 'fs', 'vb',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'sql', 'graphql', 'gql', 'proto',
  'lua', 'pl', 'pm', 'r', 'dart', 'ex', 'exs', 'erl', 'hrl', 'tex', 'bib', 'diff', 'patch',
  'gitignore', 'gitattributes', 'dockerignore', 'editorconfig', 'npmrc', 'nvmrc', 'lock',
])

/** Basenames that are text files without a useful extension. */
const INLINE_TEXT_BASENAMES: ReadonlySet<string> = new Set([
  'makefile', 'dockerfile', 'containerfile', 'jenkinsfile', 'procfile', 'gemfile',
  'rakefile', 'license', 'licence', 'readme', 'changelog', 'authors', 'notice',
])

/** Model-visible marker opening the "this model cannot take images" note block. */
export const SIDECHAT_TEXT_ONLY_IMAGE_NOTE_PREFIX =
  'Note: the selected model accepts text only; these image attachments were saved but not sent: '

/** The one-line model-facing note appended to a turn whose model cannot take images. */
export function textOnlyImageNote(names: readonly string[]): string {
  return `${SIDECHAT_TEXT_ONLY_IMAGE_NOTE_PREFIX}${names.map(name => `"${name}"`).join(', ')}.`
}

/** Whether a content text block is that generated note (never user prose). */
export function isTextOnlyImageNote(text: string): boolean {
  return text.startsWith(SIDECHAT_TEXT_ONLY_IMAGE_NOTE_PREFIX)
}

/** Lowercase extension of a display name ('' when it has none). */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

/** Lowercase basename without its directory part (input is already a leaf). */
function baseNameOf(name: string): string {
  return name.toLowerCase()
}

/**
 * Validate/normalize one attachment display name coming off the wire.
 *
 * The browser always supplies a File.name (a leaf already), but the route is
 * reachable by anything that can pass the trust fence, so a name is treated as
 * untrusted text: directory separators, control characters, and the two
 * traversal names are REFUSED rather than repaired (a repaired name would hide
 * a hostile caller instead of rejecting it), and only characters that are
 * illegal on some filesystem are replaced for the stored object's leaf name.
 *
 * @param raw - caller-supplied name.
 * @returns the safe display name, or null when the name is not a plain leaf.
 */
export function safeAttachmentName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed === '.' || trimmed === '..') return null
  if (trimmed.includes('/') || trimmed.includes('\\')) return null
  for (const char of trimmed) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return null
  }
  if (trimmed.length > SIDECHAT_MAX_NAME_CHARS) return null
  // The attachment store also uses the name as the stored object's leaf name;
  // Windows-illegal punctuation would make that object unusable there.
  return trimmed.replace(/[<>:"|?*]/g, '_')
}

/** Whether a media type names one of the accepted raster formats. */
export function isSidechatImageMediaType(value: unknown): value is SidechatImageMediaType {
  return typeof value === 'string' && (SIDECHAT_IMAGE_MEDIA_TYPES as readonly string[]).includes(value)
}

/**
 * Classify one attachment by declared media type first, extension second.
 * Unknown types are FILES (durable handle, no inlining) rather than errors —
 * the browser may not know a MIME for a source file, and refusing a `.ts`
 * because no MIME was declared would be user-hostile. An unsupported DECLARED
 * image type (SVG, TIFF) also falls through to the extension: SVG is a text
 * document here, not a raster image.
 *
 * @param name - safe display name.
 * @param mediaType - declared MIME ('' / undefined when unknown).
 * @returns `image` only when the store can normalize it, else `file`.
 */
export function attachmentKindOf(name: string, mediaType: string | undefined): SidechatAttachmentKind {
  if (isSidechatImageMediaType(mediaType)) return 'image'
  return IMAGE_EXTENSIONS[extensionOf(name)] === undefined ? 'file' : 'image'
}

/** The media type an image attachment is uploaded under (declared wins, extension fills in). */
export function imageMediaTypeOf(name: string, mediaType: string | undefined): SidechatImageMediaType | null {
  if (isSidechatImageMediaType(mediaType)) return mediaType
  return IMAGE_EXTENSIONS[extensionOf(name)] ?? null
}

/** Whether a file's type is one whose bytes are worth decoding into inline context. */
export function isInlineTextFile(name: string, mediaType: string | undefined): boolean {
  const type = typeof mediaType === 'string' ? mediaType.toLowerCase() : ''
  if (type.startsWith('text/')) return true
  if (type === 'application/json' || type.endsWith('+json') || type.endsWith('+xml')) return true
  if (type === 'application/xml' || type === 'application/javascript' || type === 'application/x-sh') return true
  const ext = extensionOf(name)
  if (ext !== '') return INLINE_TEXT_EXTENSIONS.has(ext)
  return INLINE_TEXT_BASENAMES.has(baseNameOf(name))
}

/** One decoded, capped text file body carried inside the injected context. */
export interface SidechatInlineText {
  /** The decoded text (already capped by the host read). */
  text: string
  /** Whether the host capped this file (the turn carries only its opening). */
  truncated: boolean
}

/** One file attachment as the prompt plan sees it. */
export interface SidechatPlanFile {
  kind: 'file'
  name: string
  bytes: number
  /** The durable reference; absent only on hosts without a file attachment store. */
  ref?: FileRef
  /** Decoded inline body; absent for binary / non-text files. */
  inline?: SidechatInlineText
}

/** One image attachment as the prompt plan sees it. */
export interface SidechatPlanImage {
  kind: 'image'
  name: string
  bytes: number
  ref: ImageRef
}

/** One attachment entry of a prompt plan. */
export type SidechatPlanAttachment = SidechatPlanFile | SidechatPlanImage

/** The model-facing content one user turn builds. */
export interface SidechatPromptPlan {
  /** Blocks of the user message (text, durable refs, inline file text, note). */
  content: ContentBlock[]
  /** Image names the selected model cannot receive (the note names them). */
  degradedImages: string[]
}

/**
 * Model-facing prefix opening one inlined text-file block.
 *
 * The body rides the USER message (not a queued injection): a follow-up can be
 * typed while the thread is mid-turn, and an injected next-step context message
 * would then be claimed by the RUNNING turn instead of the follow-up it belongs
 * to. Keeping it in-message preserves message order in every state. The prefix
 * is how the transcript mapper tells the generated block apart from the user's
 * own words (it renders a collapsed "attachment content" row instead of
 * dumping 24k characters into the bubble).
 */
export const SIDECHAT_INLINE_CONTEXT_PREFIX = 'Side chat attachment context — '

/** Whether a content text block is generated inline file context (never user prose). */
export function isInlineContextBlock(text: string): boolean {
  return text.startsWith(SIDECHAT_INLINE_CONTEXT_PREFIX)
}

/** Format one inlined file as model-facing context (prefixed by the marker above). */
function inlineFileContext(name: string, bytes: number, inline: SidechatInlineText): string {
  const header = inline.truncated
    ? `File "${name}" (${bytes} bytes) — opening ${inline.text.length} characters only:`
    : `File "${name}" (${bytes} bytes):`
  return `${SIDECHAT_INLINE_CONTEXT_PREFIX}${header}\n\n${inline.text}`
}

/**
 * Whether a model's declared input modalities accept images.
 *
 * Mirrors the host's own native-prompt rule exactly: only an EXPLICIT
 * text-only declaration degrades here; an adapter that declares nothing keeps
 * the image block and remains the one deciding at request time (the host's
 * request projector already replaces images with stable placeholder text for
 * models that declare `inputModalities: ['text']`).
 *
 * @param modalities - the resolved model's `inputModalities`, when the host
 *  advertises them.
 * @returns false only for a declaration that excludes `image`.
 */
export function imageInputSupportedOf(modalities: unknown): boolean {
  if (!Array.isArray(modalities)) return true
  return modalities.some(entry => entry === 'image')
}

/**
 * Build the user message content of one turn.
 *
 * Order is the model's reading order: the user's words, each durable
 * attachment reference (whose file handle / image the model receives in
 * place), the capped bodies of the text files, then — only for a model
 * declared text-only — the note naming the images that were not sent.
 *
 * Files: a durable `file` block (the model receives the store's deterministic
 * handle, the transcript a chip) PLUS the capped body — an attached source file
 * is useful even when the agent never opens it. Images: a durable `image` block;
 * the block still rides the log when the model is declared text-only (the
 * transcript thumbnail survives) and the host's own request projector turns it
 * into its standard placeholder text for that model, while the note below tells
 * the user what happened.
 *
 * @param input - the composer text, the attachments, and the model's image
 *  capability.
 * @returns content blocks and the names degraded to note-only.
 */
export function planSidechatPrompt(input: {
  text: string
  attachments: readonly SidechatPlanAttachment[]
  imageInputSupported: boolean
}): SidechatPromptPlan {
  const content: ContentBlock[] = []
  const inlineBlocks: ContentBlock[] = []
  const degradedImages: string[] = []
  const text = input.text.trim()
  if (text !== '') content.push({ type: 'text', text })
  let remainingInline = SIDECHAT_INLINE_TOTAL_CHAR_CAP
  for (const attachment of input.attachments) {
    if (attachment.kind === 'image') {
      content.push({ type: 'image', attachment: attachment.ref })
      if (!input.imageInputSupported) degradedImages.push(attachment.name)
      continue
    }
    if (attachment.ref !== undefined) content.push({ type: 'file', attachment: attachment.ref })
    const inline = attachment.inline
    if (inline === undefined || inline.text === '' || remainingInline <= 0) continue
    const capped = inline.text.length > remainingInline ? inline.text.slice(0, remainingInline) : inline.text
    remainingInline -= capped.length
    inlineBlocks.push({
      type: 'text',
      text: inlineFileContext(attachment.name, attachment.bytes, {
        text: capped,
        truncated: inline.truncated || capped.length < inline.text.length,
      }),
    })
  }
  content.push(...inlineBlocks)
  if (degradedImages.length > 0) {
    content.push({ type: 'text', text: textOnlyImageNote(degradedImages) })
  }
  return { content, degradedImages }
}

/** One attachment surfaced for the transcript / inbox rows (display only). */
export interface SidechatAttachmentSummary {
  kind: SidechatAttachmentKind
  /** Sanitized display name ('' when a legacy log carried none). */
  name: string
  /** Exact encoded byte length. */
  bytes: number
  /** Opaque durable id (never a path); '' only for a malformed legacy block. */
  attachmentId: string
  /** Image display metadata, absent on files. */
  image?: { mediaType: string; width: number; height: number }
}

/** Narrow one durable image reference out of an untrusted content block. */
function imageSummaryOf(value: unknown): SidechatAttachmentSummary | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const ref = value as Record<string, unknown>
  const attachmentId = ref.attachmentId
  const bytes = ref.bytes
  const width = ref.width
  const height = ref.height
  const mediaType = ref.mediaType
  if (typeof attachmentId !== 'string' || attachmentId === '') return null
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null
  if (typeof width !== 'number' || !Number.isFinite(width)) return null
  if (typeof height !== 'number' || !Number.isFinite(height)) return null
  return {
    kind: 'image',
    name: typeof ref.name === 'string' ? ref.name : '',
    bytes,
    attachmentId,
    image: {
      mediaType: typeof mediaType === 'string' ? mediaType : 'image/png',
      width,
      height,
    },
  }
}

/** Narrow one durable file reference out of an untrusted content block. */
function fileSummaryOf(value: unknown): SidechatAttachmentSummary | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const ref = value as Record<string, unknown>
  const attachmentId = ref.attachmentId
  const bytes = ref.bytes
  if (typeof attachmentId !== 'string' || attachmentId === '') return null
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null
  return {
    kind: 'file',
    name: typeof ref.name === 'string' ? ref.name : '',
    bytes,
    attachmentId,
  }
}

/**
 * Extract the attachment rows of one message content (durable log event data or
 * an unclaimed inbox message). Defensive: the `user/message` content is
 * merge-extensible, so unknown blocks are ignored instead of throwing.
 *
 * @param content - the raw `data.content` of a user message.
 * @returns attachment summaries in content order (empty for plain text).
 */
export function attachmentSummariesOf(content: unknown): SidechatAttachmentSummary[] {
  if (!Array.isArray(content)) return []
  const rows: SidechatAttachmentSummary[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as { type?: unknown; attachment?: unknown }
    if (candidate.type === 'image') {
      const row = imageSummaryOf(candidate.attachment)
      if (row !== null) rows.push(row)
      continue
    }
    if (candidate.type === 'file') {
      const row = fileSummaryOf(candidate.attachment)
      if (row !== null) rows.push(row)
    }
  }
  return rows
}

/** Compact human byte size for a chip (`980 B` / `12.4 KB` / `3.1 MB`). */
export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024
    return `${kb >= 100 ? Math.round(kb) : Math.round(kb * 10) / 10} KB`
  }
  const mb = bytes / (1024 * 1024)
  return `${Math.round(mb * 10) / 10} MB`
}

/**
 * One accepted upload as the wire reports it back to the composer. The client
 * keeps only this descriptor (and never the bytes); the prompt references the
 * opaque `uploadId`.
 */
export interface SidechatUploadedAttachment {
  uploadId: string
  kind: SidechatAttachmentKind
  name: string
  bytes: number
  /** Images: the normalized media type the store verified. */
  mediaType?: string
  /** Images: normalized dimensions. */
  width?: number
  height?: number
  /** Text files: characters that will ride the turn as inline context (0 = not inlined). */
  inlineChars?: number
  /** Text files: whether the inline context is only the opening of the file. */
  truncated?: boolean
}
