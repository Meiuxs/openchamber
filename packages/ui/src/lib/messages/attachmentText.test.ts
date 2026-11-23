import { describe, expect, test } from 'bun:test';

import type { FilePart, Part, TextPart } from '@/lib/opencode/model';

import { expandAttachmentCitations } from './attachmentText';

const textPart = ({ text }: Pick<TextPart, 'text'>): Part => ({
    id: 'p1',
    sessionID: 's',
    messageID: 'm',
    type: 'text',
    text,
});

const filePart = ({ filename, mime, url }: Pick<FilePart, 'filename' | 'mime' | 'url'>): Part => ({
    id: 'f1',
    sessionID: 's',
    messageID: 'm',
    type: 'file',
    filename,
    mime,
    url,
});

const dataUrl = (mime: string, text: string): string => `data:${mime};base64,${Buffer.from(text).toString('base64')}`;

describe('expandAttachmentCitations', () => {
    test('replaces a pasted-context citation with the text it names', () => {
        const parts = [
            textPart({ text: '看看这个 [pasted-context-1.txt] 是的撒的撒的' }),
            filePart({ filename: 'pasted-context-1.txt', mime: 'text/plain', url: dataUrl('text/plain', '粘贴的大段文本') }),
        ];
        expect(expandAttachmentCitations('看看这个 [pasted-context-1.txt] 是的撒的撒的', parts))
            .toBe('看看这个 粘贴的大段文本 是的撒的撒的');
    });

    test('matches the citation ignoring case and surrounding spaces like the chips do', () => {
        const parts = [
            filePart({ filename: 'Pasted-Context-1.TXT', mime: 'text/plain', url: dataUrl('text/plain', 'body') }),
        ];
        expect(expandAttachmentCitations('[  pasted-context-1.txt  ]', parts)).toBe('body');
    });

    test('expands picked JSON attachments too', () => {
        const parts = [filePart({ filename: 'data.json', mime: 'application/json', url: dataUrl('application/json', '{"k":1}') })];
        expect(expandAttachmentCitations('use [data.json]', parts)).toBe('use {"k":1}');
    });

    test('leaves citations alone when no text attachment has those bytes', () => {
        const parts = [
            filePart({ filename: 'build.zip', mime: 'application/zip', url: 'data:application/zip;base64,UEsDBA==' }),
            filePart({ filename: 'photo.png', mime: 'image/png', url: 'data:image/png;base64,iVBORw0KGgo=' }),
            filePart({ filename: 'notes.md', mime: 'text/plain', url: 'file:///repo/docs/notes.md' }),
        ];
        expect(expandAttachmentCitations('[build.zip] [photo.png] [notes.md] [unknown.txt]', parts))
            .toBe('[build.zip] [photo.png] [notes.md] [unknown.txt]');
    });

    test('replaces every occurrence and keeps the rest of the message untouched', () => {
        const parts = [filePart({ filename: 'pasted-context-1.txt', mime: 'text/plain', url: dataUrl('text/plain', 'X') })];
        expect(expandAttachmentCitations('a [pasted-context-1.txt] b [pasted-context-1.txt] c', parts)).toBe('a X b X c');
    });

    test('returns the text unchanged without parts or citations', () => {
        expect(expandAttachmentCitations('plain text', [])).toBe('plain text');
        const parts = [filePart({ filename: 'pasted-context-1.txt', mime: 'text/plain', url: dataUrl('text/plain', 'X') })];
        expect(expandAttachmentCitations('plain text', parts)).toBe('plain text');
    });
});
