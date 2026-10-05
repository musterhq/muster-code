import { describe, expect, it } from "vitest";
import { parseWorkLog, summarizeLatest, totalsOf } from "../src/lib/worklog.js";

const SAMPLE = `# Local work log

## 2026-10-05T09:14:00Z · Add retry to the uploader
- Device: Dhairya's MacBook
- Files: +120 -34 (6 files)
- Tests: 14 passed, 1 failed
- Tokens: 12,400 in / 3,100 out
- Model: claude-sonnet-5-5
- Cost: $0.42 (personal)
- Summary: Retries with backoff; added tests for the 429 path.

## 2026-10-05T11:02:00Z · Wire retry config
- Files: +18 −5 (2 files)
- Tests: 16 passed
- Tokens: 4,000 total
- Model: gpt-5
- Cost: $1.10
- Cost source: org
`;

describe("parseWorkLog", () => {
  const entries = parseWorkLog(SAMPLE);

  it("parses markdown entries into structured rows", () => {
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      at: "2026-10-05T09:14:00Z",
      title: "Add retry to the uploader",
      device: "Dhairya's MacBook",
      filesAdded: 120,
      filesRemoved: 34,
      filesChanged: 6,
      testsPassed: 14,
      testsFailed: 1,
      tokensIn: 12400,
      tokensOut: 3100,
      tokensTotal: 15500,
      model: "claude-sonnet-5-5",
      costUsd: 0.42,
      costSource: "personal",
    });
  });

  it("handles unicode minus, total-only tokens and a separate cost source", () => {
    expect(entries[1]).toMatchObject({ filesAdded: 18, filesRemoved: 5, filesChanged: 2, tokensTotal: 4000, costUsd: 1.1, costSource: "org" });
  });

  it("accepts fenced json entries", () => {
    const json = '```json\n[{"at":"2026-10-06T08:00:00Z","title":"Json entry","filesAdded":3,"filesRemoved":1,"tokensIn":10,"tokensOut":5,"model":"m","costUsd":0.01,"costSource":"personal"}]\n```';
    const parsed = parseWorkLog(json);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ title: "Json entry", tokensTotal: 15, costSource: "personal" });
  });

  it("keeps unknown bullets in extra and survives garbage", () => {
    const parsed = parseWorkLog("## Odd\n- Branch: feat/x\n- no colon here\n```json\n{not json\n```");
    expect(parsed[0]?.extra.Branch).toBe("feat/x");
    expect(parseWorkLog(null)).toEqual([]);
  });

  it("sums totals by cost source and summarizes the latest entry", () => {
    const totals = totalsOf(entries);
    expect(totals).toMatchObject({ entries: 2, filesAdded: 138, filesRemoved: 39, tokensTotal: 19500, costPersonalUsd: 0.42, costOrgUsd: 1.1 });
    expect(summarizeLatest(entries)).toContain("Wire retry config");
    expect(summarizeLatest(parseWorkLog(SAMPLE.split("## 2026-10-05T11")[0]!))).toBe("Retries with backoff; added tests for the 429 path.");
    expect(summarizeLatest([])).toBeNull();
  });
});
