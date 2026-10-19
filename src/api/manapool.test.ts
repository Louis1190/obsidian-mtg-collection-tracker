import { describe, expect, it, vi } from "vitest";

// manapool.ts imports Obsidian's Platform and requestUrl at load; nothing here makes a request.
vi.mock("obsidian", () => ({ Platform: { isMobileApp: false }, requestUrl: async () => ({ status: 500 }) }));

import { manaPoolCardUrl, toManaPoolSeriesFinish } from "./manapool";

describe("manaPoolCardUrl", () => {
	it("is /card/<set>/<number>, lower case, the address Mana Pool redirects to the full page", () => {
		expect(manaPoolCardUrl("LEA", "232")).toBe("https://manapool.com/card/lea/232");
		expect(manaPoolCardUrl("UNH", "116")).toBe("https://manapool.com/card/unh/116");
	});

	it("keeps a number with letters, and encodes what is not safe in a path so that nothing can leave the address", () => {
		expect(manaPoolCardUrl("hml", "12A")).toBe("https://manapool.com/card/hml/12a");
		expect(manaPoolCardUrl("sld", "123★")).toBe("https://manapool.com/card/sld/123%E2%98%85");
		expect(manaPoolCardUrl("x/../y", "1?z#w")).toBe("https://manapool.com/card/x%2F..%2Fy/1%3Fz%23w");
	});

	it("is always https on manapool.com (what openExternalUrl accepts)", () => {
		expect(manaPoolCardUrl("a", "1").startsWith("https://manapool.com/card/")).toBe(true);
	});
});

describe("toManaPoolSeriesFinish", () => {
	it("follows pickManaPoolPrice: etched is etched, foil and surge foil are foil, the rest is normal", () => {
		expect(toManaPoolSeriesFinish("etched")).toBe("etched");
		expect(toManaPoolSeriesFinish("foiled")).toBe("foil");
		expect(toManaPoolSeriesFinish("surged")).toBe("foil");
		expect(toManaPoolSeriesFinish("regular")).toBe("normal");
		expect(toManaPoolSeriesFinish("proxy")).toBe("normal");
	});
});
