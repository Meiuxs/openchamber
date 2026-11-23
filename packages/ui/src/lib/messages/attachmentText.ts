import { attachmentBasename } from '@/lib/attachmentIdentity';
import type { Part } from '@/lib/opencode/model';

import { decodeDataUrlText, isTextLikeFile } from './attachmentPreview';

const CITATION_PATTERN = /\[([^\]\n]+)\]/g;

const citationKey = (filename: string): string => attachmentBasename(filename).trim().toLowerCase();

const textAttachmentContents = (parts: readonly Part[]): Map<string, string> => {
    const contents = new Map<string, string>();
    for (const part of parts) {
        if (part.type !== 'file' || !part.filename || !part.url) continue;
        if (!isTextLikeFile({ mime: part.mime })) continue;
        const text = decodeDataUrlText(part.url);
        if (text === null || text.length === 0) continue;
        contents.set(citationKey(part.filename), text);
    }
    return contents;
};

export const expandAttachmentCitations = (text: string, parts: readonly Part[]): string => {
    if (!text.includes('[') || parts.length === 0) return text;
    const contents = textAttachmentContents(parts);
    if (contents.size === 0) return text;
    return text.replace(CITATION_PATTERN, (match, name: string) => contents.get(citationKey(name)) ?? match);
};
