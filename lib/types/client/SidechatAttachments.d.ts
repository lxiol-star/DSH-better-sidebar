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
import { type ReactNode } from 'react';
import { type SidechatAttachmentSummary } from '../sidechat-attachment-core.ts';
import type { QueuedSidechatAttachment } from './use-sidechat-attachments.ts';
/**
 * The composer tray: one chip per queued upload.
 *
 * @param props.items - queue rows in acceptance order.
 * @param props.onRemove - drop one row (revokes its preview).
 */
export declare function ComposerAttachmentTray(props: {
    items: readonly QueuedSidechatAttachment[];
    onRemove: (id: string) => void;
}): ReactNode;
/**
 * The durable chips of one sent message (or of a queued inbox message).
 *
 * @param props.attachments - summaries parsed from the message content.
 * @param props.childId - thread id for image thumbnail reads (undefined on
 *  the local echo, whose previews are local object URLs instead).
 */
export declare function SentAttachmentChips(props: {
    attachments: readonly SidechatAttachmentSummary[];
    childId: string | undefined;
}): ReactNode;
