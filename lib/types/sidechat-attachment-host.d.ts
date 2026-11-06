import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Context, SidebarHttpRequest } from './context-types.ts';
import { type SidechatAttachmentKind, type SidechatInlineText, type SidechatUploadedAttachment } from './sidechat-attachment-core.ts';
/** One durable file reference (the LLM content vocabulary's own shape). */
type FileRef = Extract<ContentBlock, {
    type: 'file';
}>['attachment'];
/** One durable image reference (the LLM content vocabulary's own shape). */
type ImageRef = Extract<ContentBlock, {
    type: 'image';
}>['attachment'];
/**
 * One staged upload: the durable reference(s) plus everything the prompt plan
 * needs. `file` / `image` stay undefined on the degraded paths (an inline-only
 * text file on a host without a file store).
 */
export interface StagedSidechatAttachment {
    readonly uploadId: string;
    readonly childId: string;
    readonly kind: SidechatAttachmentKind;
    readonly name: string;
    readonly bytes: number;
    readonly image?: ImageRef;
    readonly file?: FileRef;
    readonly inline?: SidechatInlineText;
    readonly inlineChars?: number;
    readonly mediaType?: string;
    readonly width?: number;
    readonly height?: number;
}
/** Drop every staged entry belonging to one thread (dispose / archive). */
export declare function dropStagedSidechatAttachments(childId: string): void;
/** Test hook: forget every staged entry (module state must not leak between specs). */
export declare function clearStagedSidechatAttachments(): void;
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
export declare function stageSidechatUpload(ctx: Context, input: {
    childId: string;
    rawName: unknown;
    rawMediaType: unknown;
    data: Uint8Array;
}): Promise<SidechatUploadedAttachment>;
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
export declare function resolveStagedSidechatAttachments(childId: string, rawIds: unknown): StagedSidechatAttachment[];
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
export declare function readSidechatImageAttachment(ctx: Context, rawRef: unknown): Promise<{
    data: string;
    mediaType: string;
}>;
/**
 * Register the raw Side Chat attachment upload route:
 * `POST /sidebar/sidechat/attach?childId=&name=&mediaType=`, body = file bytes.
 *
 * @param ctx - host plugin context.
 * @param fence - the plugin's browser-trust fence (`ctx.connection.requestRejection`).
 */
export declare function registerSidechatAttachmentRoute(ctx: Context, fence: (req: SidebarHttpRequest) => boolean): void;
export {};
