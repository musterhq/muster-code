import { describe, expect, it } from "vitest";
import { buildMarker, parseMarkers } from "../src/lib/markers.js";

describe("markers", () => {
  it("round-trips attributes including quotes and ampersands", () => {
    const marker = buildMarker("checkout", { device: 'Dhairya\'s "Mac" & co', "device-id": "mbp-1", by: "Dhairya" });
    const [parsed] = parseMarkers(`Starting work.\n\n${marker}`);
    expect(parsed?.kind).toBe("checkout");
    expect(parsed?.attrs.device).toBe('Dhairya\'s "Mac" & co');
    expect(parsed?.attrs["device-id"]).toBe("mbp-1");
  });

  it("ignores unknown kinds and plain HTML comments", () => {
    expect(parseMarkers("<!-- muster:explode --> <!-- note -->")).toEqual([]);
  });

  it("finds several markers in one body", () => {
    const body = `${buildMarker("activity", { at: "2026-10-05T10:00:00Z" })} text ${buildMarker("release")}`;
    expect(parseMarkers(body).map((m) => m.kind)).toEqual(["activity", "release"]);
  });

  it("returns nothing for empty bodies", () => {
    expect(parseMarkers(null)).toEqual([]);
    expect(parseMarkers("")).toEqual([]);
  });
});
