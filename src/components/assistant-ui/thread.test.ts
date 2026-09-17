import { describe, expect, it } from "vitest";
import { workLabel } from "./work-time";

describe("workLabel", () => {
  it.each([
    [365 * 86400 + 211 * 86400, "工作了1 年 211 天"],
    [7 * 86400 + 23 * 3600, "工作了7 天 23 小时"],
    [3 * 3600 + 29 * 60, "工作了3 小时 29 分钟"],
    [29 * 60 + 38, "工作了29 分 38 秒"],
    [60, "工作了1 分 0 秒"],
    [3600, "工作了1 小时 0 分钟"],
    [86400, "工作了1 天 0 小时"],
    [18, "工作了18 秒"],
    [0, "工作了0 秒"],
  ])("formats %i seconds as %s", (seconds, expected) => {
    expect(workLabel(seconds)).toBe(expected);
  });
});
