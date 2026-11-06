import { type SidechatAttachmentKind } from '../sidechat-attachment-core.ts';
/** Why one file was refused or failed to upload (the view localizes the code). */
export type SidechatAttachmentErrorCode = 'too-many' | 'too-large' | 'invalid-name' | 'unsupported-image' | 'host' | 'network';
/** One attachment row of the composer tray. */
export interface QueuedSidechatAttachment {
    /** Client-local row identity (stable React key). */
    id: string;
    kind: SidechatAttachmentKind;
    name: string;
    bytes: number;
    /** Declared MIME ('' when the browser knew none). */
    mediaType?: string;
    /** Object URL of the local preview (images only). */
    previewUrl?: string;
    status: 'uploading' | 'ready' | 'error';
    /** Opaque host staging id, present once the upload landed. */
    uploadId?: string;
    /** Failure code of a row that never became sendable. */
    errorCode?: SidechatAttachmentErrorCode;
}
/** One localized-refusal-style failure of the queue. */
export interface SidechatAttachmentFailure {
    code: SidechatAttachmentErrorCode;
    /** Raw host/network message for codes that carry one. */
    message?: string;
}
/** The queue surface the composer renders and sends from. */
export interface SidechatAttachmentQueue {
    items: readonly QueuedSidechatAttachment[];
    /** Opaque ids of the ready rows, in tray order (the prompt payload). */
    readyIds: readonly string[];
    /** True while at least one upload is in flight (send waits for these). */
    uploading: boolean;
    /** Last refusal/failure, cleared as soon as the user adds or removes one. */
    failure: SidechatAttachmentFailure | null;
    /** Queue every accepted file; refusals land in `failure`. */
    add: (files: readonly File[]) => void;
    /** Drop one row (and revoke its preview). */
    remove: (id: string) => void;
    /** Drop every row (called after a successful send). */
    clear: () => void;
    /** Clear the last failure banner. */
    dismissFailure: () => void;
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
export declare function useSidechatAttachmentQueue(childId: string | undefined): SidechatAttachmentQueue;
