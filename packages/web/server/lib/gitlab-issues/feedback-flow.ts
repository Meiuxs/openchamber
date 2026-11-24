import { isRecord, isString } from '../shared/guards.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import { isBareBotMention, isBotNoteBody, parseFeedbackCommand } from './gitlab.js';
import type { GitlabIssueLedger, FeedbackHistoryEntry, NoteWatermarks, RunEntry } from './ledger.js';
import { BLOCKED_REASONS, FEEDBACK_MAX_ROUNDS, FEEDBACK_MIN_ACCESS_LEVEL, PHASES } from './machine.js';
import { formatBareMentionComment, formatFeedbackAckComment } from './prompts.js';
import type { FeedbackLine } from './prompts.js';
import type { DispatchContext } from './dispatcher.js';

interface FeedbackScanItem {
  channel: string;
  noteId: number;
  userId: number;
  author: string;
  text: string;
}

interface FeedbackScan {
  items: FeedbackScanItem[];
  mentions: { channel: string; iid: number }[];
  watermarks: NoteWatermarks;
  changed: boolean;
}

type ErrorLike = { name?: unknown; message?: unknown };

export interface FeedbackFlowDependencies {
  ledger: GitlabIssueLedger;
  keyOf: (run: RunEntry) => string;
  appendFeedbackHistory: (run: RunEntry, entry: FeedbackHistoryEntry) => FeedbackHistoryEntry[];
  transition: (run: RunEntry, to: string, patch?: Partial<RunEntry>) => Promise<RunEntry>;
  blockWithComment: (
    run: RunEntry,
    context: DispatchContext,
    reason: string,
    detail: string,
    patch?: Partial<RunEntry>,
  ) => Promise<RunEntry>;
  errorName: (error: ErrorLike) => string | undefined;
  warn: (message: string, error?: ErrorLike) => void;
  isoNow: () => string;
}

const isJsonRecord = (value: unknown): value is JsonObject => isRecord(value);
const isErrorLike = (value: unknown): value is ErrorLike => isRecord(value);
const isInteger = (value: unknown): value is number => Number.isInteger(value);
const asIid = (value: JsonValue | undefined): number => (isInteger(value) ? value : 0);
const asText = (value: JsonValue | null | undefined) => (isString(value) ? value : '');

export function createFeedbackFlow(dependencies: FeedbackFlowDependencies) {
  const {
    ledger, keyOf, appendFeedbackHistory, transition, blockWithComment, errorName, warn, isoNow,
  } = dependencies;

  const scanFeedback = async (run: RunEntry, context: DispatchContext): Promise<FeedbackScan> => {
    const [issueNotes, mrNotes] = await Promise.all([
      context.api.listNotes(run.projectId, run.iid ?? 0),
      context.api.listMergeRequestNotes(run.projectId, run.mrIid ?? 0),
    ]);
    const newestId = (notes: JsonObject[]) => notes.reduce((max, note) => (
      isInteger(note?.id) ? Math.max(max, note.id) : max), 0);
    const marks = run.noteWatermarks ?? null;
    if (!marks) {
      return {
        // SAFETY: empty arrays are valid empty results of these element types.
        items: [] as FeedbackScanItem[],
        // SAFETY: empty arrays are valid empty results of these element types.
        mentions: [] as { channel: string; iid: number }[],
        watermarks: { issue: newestId(issueNotes), mergeRequest: newestId(mrNotes) },
        changed: false,
      };
    }
    const channels = [
      { name: 'issue', iid: run.iid ?? 0, notes: issueNotes },
      { name: 'mergeRequest', iid: run.mrIid ?? 0, notes: mrNotes },
    ];
    const accessLevels = new Map((await context.api.listMembers(run.projectId))
      .map((member): [number, number] => [Number(member?.id), Number(member?.access_level)]));
    const items: FeedbackScanItem[] = [];
    const mentions: { channel: string; iid: number }[] = [];
    const nextWatermarks: NoteWatermarks = { ...marks };
    for (const channel of channels) {
      // SAFETY: channels only contains the two literal names that index NoteWatermarks.
      const since = Number(marks[channel.name as keyof NoteWatermarks] ?? 0);
      const fresh = channel.notes.filter((note) => isInteger(note?.id) && note.id > since);
      if (!fresh.length) continue;
      for (const note of fresh) {
        if (note.system || isBotNoteBody(asText(note.body))) continue;
        const author = isJsonRecord(note.author) ? note.author : null;
        if ((accessLevels.get(Number(author?.id)) ?? 0) < FEEDBACK_MIN_ACCESS_LEVEL) continue;
        const command = parseFeedbackCommand(asText(note.body), context.botUsername);
        if (command) {
          items.push({
            channel: channel.name,
            noteId: asIid(note.id),
            userId: Number(author?.id ?? 0),
            author: isString(author?.username) ? author.username : asText(author?.username),
            text: command.text ?? '',
          });
        } else if (isBareBotMention(asText(note.body), context.botUsername)) {
          mentions.push({ channel: channel.name, iid: channel.iid });
        }
      }
      // SAFETY: channels only contains the two literal names that index NoteWatermarks.
      nextWatermarks[channel.name as keyof NoteWatermarks] = newestId(fresh);
    }
    return {
      items,
      mentions,
      watermarks: nextWatermarks,
      changed: nextWatermarks.issue !== marks.issue || nextWatermarks.mergeRequest !== marks.mergeRequest,
    };
  };

  const postFeedbackReply = (
    context: DispatchContext,
    run: RunEntry,
    channel: string,
    iid: number,
    body: string,
  ) => (channel === 'issue'
    ? context.api.postNote(run.projectId, iid, body)
    : context.api.postMergeRequestNote(run.projectId, iid, body)
  ).catch((error) => warn(`[gitlab-issues] feedback reply failed for #${run.iid}:`, isErrorLike(error) ? error : undefined));

  const handleFeedbackScan = async (run: RunEntry, context: DispatchContext): Promise<RunEntry | false> => {
    let scan: FeedbackScan;
    try {
      scan = await scanFeedback(run, context);
    } catch (error) {
      if (errorName(isErrorLike(error) ? error : {}) !== 'GitlabListOverflowError') throw error;
      return blockWithComment(run, context, BLOCKED_REASONS.NOTES_LIMIT,
        '评论数量超出自动化单次读取上限，反馈无法继续解析，请人工处理后续修改。');
    }
    for (const mention of scan.mentions) {
      await postFeedbackReply(
        context, run, mention.channel, mention.iid,
        formatBareMentionComment(context.botUsername),
      );
    }
    if (scan.items.length) {
      const nextRounds = (run.feedbackRounds ?? 0) + 1;
      if (nextRounds > FEEDBACK_MAX_ROUNDS) {
        return blockWithComment(
          run,
          context,
          BLOCKED_REASONS.FEEDBACK_LIMIT,
          `反馈修复已达上限（${FEEDBACK_MAX_ROUNDS} 轮）。`,
          { noteWatermarks: scan.watermarks },
        );
      }
      const byChannel: { channel: string; iid: number; items: FeedbackScanItem[] }[] = [];
      for (const item of scan.items) {
        const last = byChannel[byChannel.length - 1];
        if (last && last.channel === item.channel) last.items.push(item);
        else byChannel.push({ channel: item.channel, iid: item.channel === 'issue' ? run.iid ?? 0 : run.mrIid ?? 0, items: [item] });
      }
      for (const group of byChannel) {
        await postFeedbackReply(
          context, run, group.channel, group.iid,
          formatFeedbackAckComment({ items: group.items, round: nextRounds, maxRounds: FEEDBACK_MAX_ROUNDS }),
        );
      }
      const last = scan.items[scan.items.length - 1];
      const feedbackItems: FeedbackLine[] = scan.items.map(({ author, text }) => ({ author, text }));
      const historyItems = scan.items.map(({ author, text }) => ({ author, text }));
      const next = await transition(run, PHASES.ADDRESSING, {
        feedbackRounds: nextRounds,
        lastFeedbackActor: last?.userId ?? null,
        feedbackItems,
        feedbackHistory: appendFeedbackHistory(run, {
          round: nextRounds,
          items: historyItems,
          at: isoNow(),
        }),
        noteWatermarks: scan.watermarks,
        sessionId: null,
        attempts: 0,
        reviewRounds: 0,
        reviewImpact: null,
      });
      await context.api.addLabels(run.projectId, run.iid ?? 0, ['ai-working'])
        .catch((error) => warn(`[gitlab-issues] ai-working label failed for #${run.iid}:`, isErrorLike(error) ? error : undefined));
      return next;
    }
    if (scan.changed || !run.noteWatermarks) {
      await ledger.update(keyOf(run), { noteWatermarks: scan.watermarks });
    }
    return false;
  };

  return { handleFeedbackScan };
}
