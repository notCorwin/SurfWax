import { expect, it } from "vitest";
import type { MessageView } from "./runtime-view";
import { createTurnProjection } from "./turn-projection";

const message = (id: string, role = "assistant") => ({ id, role }) as MessageView;
it("keeps completed history stable while appending and updating the current turn", () => {
  const project = createTurnProjection();
  const history = Array.from({ length: 500 }, (_, index) => [message(`u${index}`, "user"), message(`a${index}`)]).flat();
  const before = project(history);
  const user = message("new", "user"), first = message("response");
  const streamed = project([...history, user, first]);
  const keys = project.getItemKey();
  expect(streamed.slice(0, 500)).toEqual(before);
  expect(streamed[499]).toBe(before[499]);
  const updated = message("response");
  const next = project([...history, user, updated, message("tool-response")]);
  expect(project.getItemKey()).toBe(keys);
  expect(keys(500)).toBe("new");
  expect(next[499]).toBe(before[499]);
  expect(next[500]?.assistants).toEqual([updated, message("tool-response")]);
  expect(streamed[500]?.assistants).toEqual([first]);
});
it("handles branch replacement, partial truncation and empty history", () => {
  const project = createTurnProjection();
  const user = message("u", "user"), first = message("a"), secondUser = message("u2", "user");
  project([user, first, secondUser, message("a2")]);
  expect(project([user]).map((turn) => turn.messages)).toEqual([[user]]);
  expect(project([user, message("branch")])[0]?.assistants).toEqual([message("branch")]);
  const keys = project.getItemKey();
  expect(project([message("alternative", "user"), first])[0]?.id).toBe("alternative");
  expect(project.getItemKey()).not.toBe(keys);
  expect(project.getItemKey()(0)).toBe("alternative");
  expect(project([])).toEqual([]);
});
