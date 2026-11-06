/**
 * Composer attachment queue for one Side Chat thread (browser half).
 *
 * The File objects stay client-side only: each one is uploaded immediately
 * through the raw attach route (`sidechat.attach`) and from then on the queue
 * holds the wire descriptor (opaque upload id + display metadata, never
 * bytes). The prompt references ids, so removing a not-yet-sent attachment is
 * just forgetting its id — the host keeps enforcing the same caps on the
 * actual bytes, which is why the pre-check here is advisory only (it gives a
 * fast, localized refusal instead of a round-trip).
 *
 * Lifecycle is bounded and timer-free: at most {@link SIDECHAT_MAX_ATTACHMENTS}
 * items, object URLs created for image previews are revoked on removal, on
 * thread change, and on unmount.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api.ts'
import { SidebarApiError } from './api.ts'
import {
  attachmentKindOf,
  imageMediaTypeOf,
  safeAttachmentName,
  SIDECHAT_MAX_ATTACHMENTS,
  SIDECHAT_MAX_FILE_BYTES,
  SIDECHAT_MAX_IMAGE_BYTES,
  type SidechatAttachmentKind,
} from '../sidechat-attachment-core.ts'

/** Why one file was refused or failed to upload (the view localizes the code). */
export type SidechatAttachmentErrorCode =
  | 'too-many'
  | 'too-large'
  | 'invalid-name'
  | 'unsupported-image'
  | 'host'
  | 'network'

/** One attachment row of the composer tray. */
export interface QueuedSidechatAttachment {
  /** Client-local row identity (stable React key). */
  id: string
  kind: SidechatAttachmentKind
  name: string
  bytes: number
  /** Declared MIME ('' when the browser knew none). */
  mediaType?: string
  /** Object URL of the local preview (images only). */
  previewUrl?: string
  status: 'uploading' | 'ready' | 'error'
  /** Opaque host staging id, present once the upload landed. */
  uploadId?: string
  /** Failure code of a row that never became sendable. */
  errorCode?: SidechatAttachmentErrorCode
}

/** One localized-refusal-style failure of the queue. */
export interface SidechatAttachmentFailure {
  code: SidechatAttachmentErrorCode
  /** Raw host/network message for codes that carry one. */
  message?: string
}

/** The queue surface the composer renders and sends from. */
export interface SidechatAttachmentQueue {
  items: readonly QueuedSidechatAttachment[]
  /** Opaque ids of the ready rows, in tray order (the prompt payload). */
  readyIds: readonly string[]
  /** True while at least one upload is in flight (send waits for these). */
  uploading: boolean
  /** Last refusal/failure, cleared as soon as the user adds or removes one. */
  failure: SidechatAttachmentFailure | null
  /** Queue every accepted file; refusals land in `failure`. */
  add: (files: readonly File[]) => void
  /** Drop one row (and revoke its preview). */
  remove: (id: string) => void
  /** Drop every row (called after a successful send). */
  clear: () => void
  /** Clear the last failure banner. */
  dismissFailure: () => void
}

/** Map a wire failure onto the localized code the tray understands. */
function failureOf(error: unknown): SidechatAttachmentFailure {
  if (error instanceof SidebarApiError) {
    if (error.code === 'too-large') return { code: 'too-large' }
    if (error.code === 'network') return { code: 'network', message: error.message }
    return { code: 'host', message: error.message }
  }
  return { code: 'host', message: error instanceof Error ? error.message : String(error) }
}

/**
 * One thread's attachment queue.
 *
 * A row is uploaded the moment it is accepted, sequentially: the first upload
 * of a multi-file drop starts immediately, each following one starts when the
 * previous settled, so a slow image cannot starve a small text file behind a
 * parallel burst of requests.
 *
 * @param childId - the open Side Chat thread (undefined before one exists:
 *  files cannot be accepted yet, the picker is not shown).
 * @returns the queue state and its mutations.
 */
export function useSidechatAttachmentQueue(childId: string | undefined): SidechatAttachmentQueue {
  const [items, setItems] = useState<QueuedSidechatAttachment[]>([])
  const [failure, setFailure] = useState<SidechatAttachmentFailure | null>(null)
  const itemsRef = useRef<QueuedSidechatAttachment[]>([])
  itemsRef.current = items
  const seqRef = useRef(0)
  /** Uploads of one drop run in order; this chains them without timers. */
  const uploadChainRef = useRef<Promise<void>>(Promise.resolve())
  const previewUrlsRef = useRef(new Set<string>())
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    // The Set instance is stable for the component's life; capture it so the
    // cleanup does not read a (possibly re-assigned) ref during teardown.
    const previewUrls = previewUrlsRef.current
    return () => {
      mountedRef.current = false
      for (const url of previewUrls) URL.revokeObjectURL(url)
      previewUrls.clear()
    }
  }, [])

  // Attachments belong to the thread they were staged on: switching threads
  // (the tab menu rebinds the view) must never carry them across.
  const boundThreadRef = useRef(childId)
  useEffect(() => {
    if (boundThreadRef.current === childId) return
    boundThreadRef.current = childId
    for (const url of previewUrlsRef.current) URL.revokeObjectURL(url)
    previewUrlsRef.current.clear()
    setItems([])
  }, [childId])

  const revoke = useCallback((item: QueuedSidechatAttachment): void => {
    if (item.previewUrl === undefined) return
    URL.revokeObjectURL(item.previewUrl)
    previewUrlsRef.current.delete(item.previewUrl)
  }, [])

  const updateItem = useCallback((id: string, patch: Partial<QueuedSidechatAttachment>): void => {
    if (!mountedRef.current) return
    setItems(current => current.map(item => (item.id === id ? { ...item, ...patch } : item)))
  }, [])

  const enqueueUpload = useCallback((id: string, file: File, threadId: string): void => {
    uploadChainRef.current = uploadChainRef.current.then(async () => {
      try {
        const uploaded = await api.sidechatAttach(threadId, file)
        updateItem(id, {
          status: 'ready',
          uploadId: uploaded.uploadId,
          name: uploaded.name,
          bytes: uploaded.bytes,
          ...(uploaded.mediaType === undefined ? {} : { mediaType: uploaded.mediaType }),
        })
      } catch (error) {
        const failed = failureOf(error)
        updateItem(id, { status: 'error', errorCode: failed.code })
        if (mountedRef.current) setFailure(failed)
      }
    })
  }, [updateItem])

  const add = useCallback((files: readonly File[]): void => {
    if (files.length === 0) return
    const threadId = boundThreadRef.current
    if (threadId === undefined) {
      setFailure({ code: 'host', message: 'open a side chat thread first' })
      return
    }
    setFailure(null)
    const accepted: { row: QueuedSidechatAttachment; file: File }[] = []
    let refusal: SidechatAttachmentFailure | null = null
    let count = itemsRef.current.length
    for (const file of files) {
      if (count >= SIDECHAT_MAX_ATTACHMENTS) {
        refusal ??= { code: 'too-many' }
        break
      }
      const name = safeAttachmentName(file.name)
      if (name === null) {
        refusal ??= { code: 'invalid-name' }
        continue
      }
      const mediaType = file.type === '' ? undefined : file.type
      const kind = attachmentKindOf(name, mediaType)
      if (kind === 'image') {
        if (imageMediaTypeOf(name, mediaType) === null) {
          refusal ??= { code: 'unsupported-image' }
          continue
        }
        if (file.size > SIDECHAT_MAX_IMAGE_BYTES) {
          refusal ??= { code: 'too-large' }
          continue
        }
      } else if (file.size > SIDECHAT_MAX_FILE_BYTES) {
        refusal ??= { code: 'too-large' }
        continue
      }
      seqRef.current += 1
      const id = `attach-${seqRef.current}`
      const previewUrl = kind === 'image' ? URL.createObjectURL(file) : undefined
      if (previewUrl !== undefined) previewUrlsRef.current.add(previewUrl)
      accepted.push({
        file,
        row: {
          id,
          kind,
          name,
          bytes: file.size,
          ...(mediaType === undefined ? {} : { mediaType }),
          ...(previewUrl === undefined ? {} : { previewUrl }),
          status: 'uploading',
        },
      })
      count += 1
    }
    if (accepted.length > 0) setItems(current => [...current, ...accepted.map(entry => entry.row)])
    if (refusal !== null) setFailure(refusal)
    for (const entry of accepted) enqueueUpload(entry.row.id, entry.file, threadId)
  }, [enqueueUpload])

  const remove = useCallback((id: string): void => {
    const item = itemsRef.current.find(entry => entry.id === id)
    if (item !== undefined) revoke(item)
    setItems(current => current.filter(entry => entry.id !== id))
    setFailure(null)
  }, [revoke])

  const clear = useCallback((): void => {
    for (const item of itemsRef.current) revoke(item)
    setItems([])
    setFailure(null)
  }, [revoke])

  const dismissFailure = useCallback((): void => {
    setFailure(null)
  }, [])

  const readyIds: string[] = []
  for (const item of items) {
    if (item.status === 'ready' && item.uploadId !== undefined) readyIds.push(item.uploadId)
  }

  return {
    items,
    readyIds,
    uploading: items.some(item => item.status === 'uploading'),
    failure,
    add,
    remove,
    clear,
    dismissFailure,
  }
}
