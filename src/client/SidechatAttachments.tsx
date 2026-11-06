/**
 * Attachment surfaces of Side Chat (browser half).
 *
 * Two audiences share one vocabulary:
 * - the COMPOSER tray shows what is queued, uploading, or refused — image
 *   rows carry the local object-URL preview, file rows the host's own
 *   file-type glyph;
 * - an already SENT message renders its durable chips: a thumbnail fetched
 *   from the host attachment store for images, an icon + name + size for
 *   files. Thumbnails are cached process-wide and bounded; an in-use URL is
 *   never evicted, so a committed transcript cannot lose a picture mid-render.
 *
 * Every visual value rides a theme token and every glyph is a host primitive
 * (see the skin contract), so this module adds no colors of its own.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconCloseFillRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { builtinFileIcon } from './file-icons.tsx'
import { t } from './locales.ts'
import { api } from './api.ts'
import {
  formatAttachmentSize,
  type SidechatAttachmentSummary,
} from '../sidechat-attachment-core.ts'
import type { QueuedSidechatAttachment } from './use-sidechat-attachments.ts'
import css from './SideChatView.module.css'

/** Browser cap on cached transcript thumbnails (in-use URLs are never evicted). */
const THUMB_CACHE_MAX = 32

/** One cached thumbnail object URL plus how many mounted chips hold it. */
interface CachedThumb {
  url: string
  /** Number of mounted rows currently rendering this URL. */
  holds: number
}

/** Fetch dedupe + bounded cache keyed by durable attachment id. */
const thumbCache = new Map<string, CachedThumb>()
const thumbInflight = new Map<string, Promise<string | null>>()

/** Evict the oldest UNHELD entry; returns true when something was revoked. */
function evictOneThumb(): boolean {
  for (const [key, entry] of thumbCache) {
    if (entry.holds > 0) continue
    thumbCache.delete(key)
    URL.revokeObjectURL(entry.url)
    return true
  }
  return false
}

/** Decode the host's base64 image payload into an object URL. */
function objectUrlOf(data: string, mediaType: string): string | null {
  try {
    const binary = atob(data)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return URL.createObjectURL(new Blob([bytes], { type: mediaType }))
  } catch {
    // A malformed payload degrades to the placeholder glyph.
    return null
  }
}

/** Obtain (or fetch once) one attachment's thumbnail object URL. */
async function loadThumbnail(childId: string, summary: SidechatAttachmentSummary): Promise<string | null> {
  const cached = thumbCache.get(summary.attachmentId)
  if (cached !== undefined) return cached.url
  const pending = thumbInflight.get(summary.attachmentId)
  if (pending !== undefined) return pending
  const request = (async (): Promise<string | null> => {
    try {
      const value = await api.sidechatAttachment(childId, summary)
      const url = objectUrlOf(value.data, value.mediaType)
      if (url === null) return null
      thumbCache.delete(summary.attachmentId)
      thumbCache.set(summary.attachmentId, { url, holds: 0 })
      while (thumbCache.size > THUMB_CACHE_MAX) {
        if (!evictOneThumb()) break
      }
      return url
    } catch {
      return null
    } finally {
      thumbInflight.delete(summary.attachmentId)
    }
  })()
  thumbInflight.set(summary.attachmentId, request)
  return request
}

/**
 * One transcript thumbnail URL for one durable image chip.
 *
 * The cache entry is pinned while the chip is mounted (so a long transcript
 * cannot evict a picture that is on screen) and released on unmount.
 *
 * @param childId - the thread the message belongs to (the bytes are fetched
 *  through that thread's route).
 * @param summary - the durability reference parsed from the logged message.
 * @returns the object URL, or null while loading / after a failed read.
 */
function useAttachmentThumbnail(childId: string, summary: SidechatAttachmentSummary): string | null {
  const [url, setUrl] = useState<string | null>(() => thumbCache.get(summary.attachmentId)?.url ?? null)
  const heldRef = useRef<string | null>(null)
  useEffect(() => {
    let alive = true
    const cached = thumbCache.get(summary.attachmentId)
    if (cached !== undefined) {
      cached.holds += 1
      heldRef.current = summary.attachmentId
      setUrl(cached.url)
    } else {
      void loadThumbnail(childId, summary).then((loaded) => {
        if (!alive || loaded === null) return
        const entry = thumbCache.get(summary.attachmentId)
        if (entry !== undefined) {
          entry.holds += 1
          heldRef.current = summary.attachmentId
        }
        setUrl(loaded)
      })
    }
    return () => {
      alive = false
      const held = heldRef.current
      heldRef.current = null
      if (held === null) return
      const entry = thumbCache.get(held)
      if (entry !== undefined && entry.holds > 0) entry.holds -= 1
    }
  }, [childId, summary])
  return url
}

/** One image chip's thumbnail (own component so the hook is unconditional). */
function ImageAttachmentThumbnail(props: {
  childId: string | undefined
  summary: SidechatAttachmentSummary
  className: string
}): ReactNode {
  const { childId, summary, className } = props
  const url = useAttachmentThumbnail(childId ?? '', summary)
  if (url === null) {
    return (
      <span className={clsx(className, css.sidechatSentAttachmentPending)} aria-hidden="true">
        {builtinFileIcon(summary.name || 'image', 14)}
      </span>
    )
  }
  return <img className={className} src={url} alt={summary.name} />
}

/**
 * The composer tray: one chip per queued upload.
 *
 * @param props.items - queue rows in acceptance order.
 * @param props.onRemove - drop one row (revokes its preview).
 */
export function ComposerAttachmentTray(props: {
  items: readonly QueuedSidechatAttachment[]
  onRemove: (id: string) => void
}): ReactNode {
  if (props.items.length === 0) return null
  return (
    <div className={css.sidechatAttachmentTray}>
      {props.items.map((item) => (
        <div
          key={item.id}
          className={clsx(
            css.sidechatAttachmentChip,
            item.status === 'error' && css.sidechatAttachmentChipError,
          )}
          title={item.errorMessage === undefined
            ? item.name
            : `${item.name} — ${item.errorMessage}`}
        >
          {item.previewUrl === undefined
            ? (
              <span className={css.sidechatAttachmentIcon} aria-hidden="true">
                {builtinFileIcon(item.name, 14)}
              </span>
            )
            : <img className={css.sidechatAttachmentThumb} src={item.previewUrl} alt="" />}
          <span className={css.sidechatAttachmentMeta}>
            <span className={css.sidechatAttachmentName}>{item.name}</span>
            <span className={css.sidechatAttachmentSize}>
              {item.status === 'uploading'
                ? t('sideChatAttachUploading')
                : item.status === 'error'
                  ? item.errorCode === 'host-stale'
                    ? t('sideChatAttachHostStale')
                    : t('sideChatAttachFailedShort')
                  : formatAttachmentSize(item.bytes)}
            </span>
          </span>
          <button
            type="button"
            className={css.sidechatAttachmentRemove}
            onClick={() => props.onRemove(item.id)}
            title={t('sideChatAttachRemove')}
            aria-label={t('sideChatAttachRemove')}
          >
            <IconCloseFillRegular size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}

/**
 * The durable chips of one sent message (or of a queued inbox message).
 *
 * @param props.attachments - summaries parsed from the message content.
 * @param props.childId - thread id for image thumbnail reads (undefined on
 *  the local echo, whose previews are local object URLs instead).
 */
export function SentAttachmentChips(props: {
  attachments: readonly SidechatAttachmentSummary[]
  childId: string | undefined
}): ReactNode {
  if (props.attachments.length === 0) return null
  return (
    <div className={css.sidechatSentAttachments}>
      {props.attachments.map((attachment, index) => (
        attachment.kind === 'image'
          ? (
            <figure className={css.sidechatSentAttachment} key={`${attachment.attachmentId}:${index}`}>
              <ImageAttachmentThumbnail
                childId={props.childId}
                summary={attachment}
                className={css.sidechatSentAttachmentThumb ?? ''}
              />
              <figcaption className={css.sidechatSentAttachmentCaption} title={attachment.name}>
                <span className={css.sidechatSentAttachmentName}>{attachment.name || t('sideChatAttachImage')}</span>
              </figcaption>
            </figure>
          )
          : (
            <div className={css.sidechatSentAttachment} key={`${attachment.attachmentId}:${index}`} title={attachment.name}>
              <span className={css.sidechatSentAttachmentIcon} aria-hidden="true">
                {builtinFileIcon(attachment.name, 14)}
              </span>
              <span className={css.sidechatSentAttachmentName}>{attachment.name || t('sideChatAttachFile')}</span>
              <span className={css.sidechatSentAttachmentSize}>{formatAttachmentSize(attachment.bytes)}</span>
            </div>
          )
      ))}
    </div>
  )
}
