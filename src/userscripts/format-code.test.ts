import { describe, expect, it } from "vitest";
import { formatUserScriptCode } from "./format-code";

describe("user script code formatting", () => {
  it("formats static CSS as readable JavaScript while escaping template characters", async () => {
    const code = `const CSS_TOP = ${JSON.stringify('a::before{content:"${name} ` \\\\ path";color:red}')};`;
    const formatted = await formatUserScriptCode(code);
    expect(formatted).toContain("const CSS_TOP = `\n");
    expect(formatted).toContain("color: red;");
    expect(formatted).toContain("\\${name}");
    expect(formatted).toContain("\\`");
    expect(new Function(`${formatted}; return CSS_TOP;`)()).toContain("${name} ` \\\\ path");
  });

  it("leaves interpolated CSS templates intact", async () => {
    const formatted = await formatUserScriptCode("const CSS_DYNAMIC = `a{color:${color}}`;");
    expect(formatted).toContain("`a{color:${color}}`");
  });
});
