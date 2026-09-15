type ActiveRun = {
  conversationId: string;
  controller: AbortController;
  done: Promise<void>;
  finish: () => void;
};

let activeRun: ActiveRun | undefined;
const backgroundControllers = new Map<AbortController, {
  conversationId?: string;
  done: Promise<void>;
  finish: () => void;
}>();

export async function claimConversationRun(conversationId: string, signal?: AbortSignal): Promise<{
  signal: AbortSignal;
  finish: () => void;
}> {
  if (activeRun) {
    activeRun.controller.abort("another-conversation-started");
    await activeRun.done;
  }

  const controller = new AbortController();
  let resolve!: () => void;
  const done = new Promise<void>((doneResolve) => { resolve = doneResolve; });
  let finished = false;
  const run: ActiveRun = {
    conversationId,
    controller,
    done,
    finish: () => {
      if (finished) return;
      finished = true;
      if (activeRun === run) activeRun = undefined;
      resolve();
    },
  };
  activeRun = run;

  return {
    signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    finish: run.finish,
  };
}

export function registerBackgroundRequest(controller: AbortController, conversationId?: string): () => void {
  let resolve!: () => void;
  const entry = { conversationId, done: new Promise<void>((doneResolve) => { resolve = doneResolve; }), finish: resolve };
  backgroundControllers.set(controller, entry);
  return () => {
    backgroundControllers.delete(controller);
    entry.finish();
  };
}

export async function abortConversationWork(conversationId: string, reason = "conversation-deleted"): Promise<void> {
  const run = activeRun?.conversationId === conversationId ? activeRun : undefined;
  const requests = [...backgroundControllers].filter(([, entry]) => entry.conversationId === conversationId);
  run?.controller.abort(reason);
  for (const [controller] of requests) controller.abort(reason);
  await Promise.all([...(run ? [run.done] : []), ...requests.map(([, entry]) => entry.done)]);
}

export function abortAllConversationWork(): void {
  activeRun?.controller.abort("sidepanel-closed");
  for (const controller of backgroundControllers.keys()) controller.abort("sidepanel-closed");
  backgroundControllers.clear();
}

export function activeConversationId(): string | undefined {
  return activeRun?.conversationId;
}
