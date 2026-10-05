import { describe, expect, it } from "vitest";
import { openInMusterHref, relativeTime, formatUsd } from "../src/ui/format.js";

describe("ui format helpers", () => {
  it("builds the muster:// deep link with the Paperclip host and identifier", () => {
    const href = openInMusterHref("muster://task/co-1/iss-1", "https://paperclip.example.com", "MUS-7");
    expect(href).toBe("muster://task/co-1/iss-1?host=https%3A%2F%2Fpaperclip.example.com&identifier=MUS-7");
    expect(openInMusterHref("muster://task/co-1/iss-1", "http://localhost:3100", null)).toBe("muster://task/co-1/iss-1?host=http%3A%2F%2Flocalhost%3A3100");
  });

  it("formats relative time and money", () => {
    const now = new Date("2026-10-05T12:00:00Z");
    expect(relativeTime("2026-10-05T11:59:40Z", now)).toBe("just now");
    expect(relativeTime("2026-10-05T11:15:00Z", now)).toBe("45 min ago");
    expect(relativeTime("2026-10-04T06:00:00Z", now)).toBe("30 h ago");
    expect(relativeTime("2026-10-01T12:00:00Z", now)).toBe("4 d ago");
    expect(relativeTime(null, now)).toBe("never");
    expect(formatUsd(0.42)).toBe("$0.420");
    expect(formatUsd(12)).toBe("$12.00");
    expect(formatUsd(null)).toBe("-");
  });
});
