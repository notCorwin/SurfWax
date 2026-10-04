import type { MessageView } from "./runtime-view";

export type Turn = { id: string; messages: MessageView[]; assistants: MessageView[] };

/** Rebuild only the changed suffix; finished turns retain their object identity. */
export function createTurnProjection() {
  let previousMessages: readonly MessageView[] = [];
  let previousTurns: Turn[] = [];
  const ends: number[] = [];
  let keys: string[] = [];
  let getItemKey = (index: number) => keys[index]!;
  const project = (messages: readonly MessageView[]): Turn[] => {
    if (messages === previousMessages) return previousTurns;
    let common = 0;
    while (common < Math.min(messages.length, previousMessages.length)
      && messages[common] === previousMessages[common]) common++;
    let kept = 0;
    while (kept < ends.length && ends[kept]! <= common
      && (ends[kept] === messages.length || messages[ends[kept]!]?.role === "user")) kept++;
    const turns = previousTurns.slice(0, kept);
    let index = kept ? ends[kept - 1]! : 0;
    ends.length = kept;
    while (index < messages.length) {
      const start = index++;
      while (index < messages.length && messages[index]!.role !== "user") index++;
      const group = messages.slice(start, index);
      turns.push({ id: group[0]!.id, messages: group, assistants: group.filter((message) => message.role === "assistant") });
      ends.push(index);
    }
    previousMessages = messages;
    previousTurns = turns;
    if (turns.length !== keys.length || turns.some((turn, index) => turn.id !== keys[index])) {
      const nextKeys = turns.map((turn) => turn.id);
      keys = nextKeys;
      getItemKey = (index) => nextKeys[index]!;
    }
    return turns;
  };
  // TanStack invalidates all measurements when the key callback changes.
  // Tokens change bodies, while branch/turn changes update this callback.
  return Object.assign(project, { getItemKey: () => getItemKey });
}
