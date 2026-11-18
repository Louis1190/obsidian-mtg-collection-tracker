import { describe, expect, it } from "vitest";
import { FINGERPRINT_BASE_URL } from "./config";

describe("the address the base of fingerprints is downloaded from", () => {
	it("is the data site's own folder, https, with no trailing slash (the loader adds `/index.json` and `/<shard>` itself)", () => {
		expect(FINGERPRINT_BASE_URL).toBe("https://louis1190.github.io/mtg-card-fingerprints/fp");
		expect(FINGERPRINT_BASE_URL.startsWith("https://")).toBe(true);
		expect(FINGERPRINT_BASE_URL.endsWith("/")).toBe(false);
		expect(new URL(FINGERPRINT_BASE_URL).search).toBe("");
		expect(new URL(FINGERPRINT_BASE_URL).hash).toBe("");
	});
});
