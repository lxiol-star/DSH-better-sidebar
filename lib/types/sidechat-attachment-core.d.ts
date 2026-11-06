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
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
/** One durable file reference as the LLM content vocabulary carries it. */
type FileRef = Extract<ContentBlock, {
    type: 'file';
}>['attachment'];
/** One durable image reference as the LLM content vocabulary carries it. */
type ImageRef = Extract<ContentBlock, {
    type: 'image';
}>['attachment'];
/** What an attachment IS to the turn: an inlinable/durable file or an image. */
export type SidechatAttachmentKind = 'file' | 'image';
/** Per-message attachment bound (one prompt can carry at most this many). */
export declare const SIDECHAT_MAX_ATTACHMENTS = 4;
/** Raw-byte bound of one FILE attachment (text files are capped again for the inline context). */
export declare const SIDECHAT_MAX_FILE_BYTES: number;
/**
 * Raw-byte bound of one IMAGE attachment. The host attachment store may impose
 * a lower deployment limit (`imageLimits.maxImageBytes`); the effective bound
 * is the smaller of the two.
 */
export declare const SIDECHAT_MAX_IMAGE_BYTES: number;
/** Body bound of the raw upload route (the largest per-kind cap, plus slack for form headers). */
export declare const SIDECHAT_MAX_UPLOAD_BYTES: number;
/** Characters of ONE text file carried as inline context. */
export declare const SIDECHAT_INLINE_CHAR_CAP = 24000;
/** Characters of ALL inlined text files in one turn. */
export declare const SIDECHAT_INLINE_TOTAL_CHAR_CAP = 48000;
/** Longest accepted attachment display name, in code units. */
export declare const SIDECHAT_MAX_NAME_CHARS = 120;
/** Raw-byte upload route of the side-chat composer (host-registered, raw body). */
export declare const SIDECHAT_ATTACH_ROUTE = "/sidebar/sidechat/attach";
/** Raster media types the host's image attachment path accepts (version one). */
export declare const SIDECHAT_IMAGE_MEDIA_TYPES: readonly ["image/png", "image/jpeg", "image/webp", "image/gif"];
/** One accepted raster image media type. */
export type SidechatImageMediaType = (typeof SIDECHAT_IMAGE_MEDIA_TYPES)[number];
/** Model-visible marker opening the "this model cannot take images" note block. */
export declare const SIDECHAT_TEXT_ONLY_IMAGE_NOTE_PREFIX = "Note: the selected model accepts text only; these image attachments were saved but not sent: ";
/** The one-line model-facing note appended to a turn whose model cannot take images. */
export declare function textOnlyImageNote(names: readonly string[]): string;
/** Whether a content text block is that generated note (never user prose). */
export declare function isTextOnlyImageNote(text: string): boolean;
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
export declare function safeAttachmentName(raw: unknown): string | null;
/** Whether a media type names one of the accepted raster formats. */
export declare function isSidechatImageMediaType(value: unknown): value is SidechatImageMediaType;
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
export declare function attachmentKindOf(name: string, mediaType: string | undefined): SidechatAttachmentKind;
/** The media type an image attachment is uploaded under (declared wins, extension fills in). */
export declare function imageMediaTypeOf(name: string, mediaType: string | undefined): SidechatImageMediaType | null;
/** Whether a file's type is one whose bytes are worth decoding into inline context. */
export declare function isInlineTextFile(name: string, mediaType: string | undefined): boolean;
/** One decoded, capped text file body carried inside the injected context. */
export interface SidechatInlineText {
    /** The decoded text (already capped by the host read). */
    text: string;
    /** Whether the host capped this file (the turn carries only its opening). */
    truncated: boolean;
}
/** One file attachment as the prompt plan sees it. */
export interface SidechatPlanFile {
    kind: 'file';
    name: string;
    bytes: number;
    /** The durable reference; absent only on hosts without a file attachment store. */
    ref?: FileRef;
    /** Decoded inline body; absent for binary / non-text files. */
    inline?: SidechatInlineText;
}
/** One image attachment as the prompt plan sees it. */
export interface SidechatPlanImage {
    kind: 'image';
    name: string;
    bytes: number;
    ref: ImageRef;
}
/** One attachment entry of a prompt plan. */
export type SidechatPlanAttachment = SidechatPlanFile | SidechatPlanImage;
/** The model-facing content one user turn builds. */
export interface SidechatPromptPlan {
    /** Blocks of the user message (text, durable refs, inline file text, note). */
    content: ContentBlock[];
    /** Image names the selected model cannot receive (the note names them). */
    degradedImages: string[];
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
export declare const SIDECHAT_INLINE_CONTEXT_PREFIX = "Side chat attachment context \u2014 ";
/** Whether a content text block is generated inline file context (never user prose). */
export declare function isInlineContextBlock(text: string): boolean;
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
export declare function imageInputSupportedOf(modalities: unknown): boolean;
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
export declare function planSidechatPrompt(input: {
    text: string;
    attachments: readonly SidechatPlanAttachment[];
    imageInputSupported: boolean;
}): SidechatPromptPlan;
/** One attachment surfaced for the transcript / inbox rows (display only). */
export interface SidechatAttachmentSummary {
    kind: SidechatAttachmentKind;
    /** Sanitized display name ('' when a legacy log carried none). */
    name: string;
    /** Exact encoded byte length. */
    bytes: number;
    /** Opaque durable id (never a path); '' only for a malformed legacy block. */
    attachmentId: string;
    /** Image display metadata, absent on files. */
    image?: {
        mediaType: string;
        width: number;
        height: number;
    };
}
/**
 * Extract the attachment rows of one message content (durable log event data or
 * an unclaimed inbox message). Defensive: the `user/message` content is
 * merge-extensible, so unknown blocks are ignored instead of throwing.
 *
 * @param content - the raw `data.content` of a user message.
 * @returns attachment summaries in content order (empty for plain text).
 */
export declare function attachmentSummariesOf(content: unknown): SidechatAttachmentSummary[];
/** Compact human byte size for a chip (`980 B` / `12.4 KB` / `3.1 MB`). */
export declare function formatAttachmentSize(bytes: number): string;
/**
 * One accepted upload as the wire reports it back to the composer. The client
 * keeps only this descriptor (and never the bytes); the prompt references the
 * opaque `uploadId`.
 */
export interface SidechatUploadedAttachment {
    uploadId: string;
    kind: SidechatAttachmentKind;
    name: string;
    bytes: number;
    /** Images: the normalized media type the store verified. */
    mediaType?: string;
    /** Images: normalized dimensions. */
    width?: number;
    height?: number;
    /** Text files: characters that will ride the turn as inline context (0 = not inlined). */
    inlineChars?: number;
    /** Text files: whether the inline context is only the opening of the file. */
    truncated?: boolean;
}
export {};
