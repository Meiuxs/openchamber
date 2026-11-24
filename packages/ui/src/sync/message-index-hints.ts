export type MessageIndexHints = {
  find(messages: readonly { id: string }[], messageID: string): number;
  forget(messageID: string): void;
  clear(): void;
};

/**
 * Remembers the last message lookup so a burst of streaming events aimed at
 * the same message resolves in O(1) instead of scanning the whole session.
 * The cached index is always validated against the current array, so an
 * insertion or removal can never return the wrong message.
 */
export const createMessageIndexHints = (): MessageIndexHints => {
  let hint: { messageID: string; index: number } | null = null;

  return {
    find(messages, messageID) {
      if (hint && hint.messageID === messageID && messages[hint.index]?.id === messageID) {
        return hint.index;
      }
      const index = messages.findIndex((message) => message.id === messageID);
      if (index >= 0) hint = { messageID, index };
      return index;
    },
    forget(messageID) {
      if (hint?.messageID === messageID) hint = null;
    },
    clear() {
      hint = null;
    },
  };
};
