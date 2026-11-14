import { describe, it, expect, vi, beforeEach } from "vitest";

// scryfall.ts imports `requestUrl` from "obsidian" at module level. The
// npm package "obsidian" only provides types, no runtime implementation —
// loading this module under Node/Vitest would crash without this mock.
vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

import { requestUrl } from "obsidian";
import {
	getImageUrl,
	getArtCropUrl,
	getRarityColor,
	sanitizeSvg,
	parseCsv,
	toCsvField,
	requestScryfall,
	isScryfallStrictEndpoint,
	resetScryfallStrictGateForTests,
	chunk,
	applySvgColor,
	dedupeSetsByIcon,
	getSetGroupLabel,
	SET_GROUP_ORDER,
	ScryfallSetSummary,
	searchScryfall,
	resolveEnglishPrints,
	clearEnglishPrintCacheForTests,
	fetchLatestPaperPrintings,
	searchAllPrintings,
	fetchScryfallCollection,
	fetchCardsByName,
	fetchPrintingsOfIllustrations,
	fetchPrintingsOfNames,
	fetchPrintingBySetAndNumber,
	fetchSetCardNames,
	resetSetNamesCacheForTests,
	SET_NAMES_MAX_PAGES,
	buildCardTextInfo,
	getDoubleFacedImages,
	getSplitCardInfo,
	ScryfallError,
	ScryfallCard,
} from "./scryfall";

const mockRequestUrl = vi.mocked(requestUrl);

beforeEach(() => {
	mockRequestUrl.mockReset();
});

function makeScryfallCard(overrides: Partial<ScryfallCard> = {}): ScryfallCard {
	return {
		id: "id1",
		name: "Card",
		set: "set",
		set_name: "Set",
		collector_number: "1",
		rarity: "common",
		type_line: "Creature",
		...overrides,
	};
}

// applySvgColor only uses .style and .querySelectorAll(...).forEach(...) — a
// real DOM environment (jsdom) isn't needed for this single function, a
// minimal object satisfying that same interface is enough and avoids adding a
// DOM dependency at this stage.
function makeFakeSvgContainer(children: { style: Record<string, string> }[] = []) {
	return {
		style: {} as Record<string, string>,
		querySelectorAll: () => children,
	} as unknown as HTMLElement;
}

describe("getImageUrl", () => {
	it("prefers image_uris.normal", () => {
		const card = makeScryfallCard({ image_uris: { normal: "normal.png", small: "small.png" } });
		expect(getImageUrl(card)).toBe("normal.png");
	});

	it("falls back to the first face's normal image for double-faced cards", () => {
		const card = makeScryfallCard({
			card_faces: [{ image_uris: { normal: "face-normal.png" } }],
		});
		expect(getImageUrl(card)).toBe("face-normal.png");
	});

	it("falls back to image_uris.small when normal is unavailable", () => {
		const card = makeScryfallCard({ image_uris: { small: "small.png" } });
		expect(getImageUrl(card)).toBe("small.png");
	});

	it("returns an empty string when no image is available", () => {
		expect(getImageUrl(makeScryfallCard())).toBe("");
	});
});

describe("getArtCropUrl", () => {
	it("prefers image_uris.art_crop", () => {
		const card = makeScryfallCard({ image_uris: { art_crop: "art.png", normal: "normal.png" } });
		expect(getArtCropUrl(card)).toBe("art.png");
	});

	it("falls back to the first face's art crop", () => {
		const card = makeScryfallCard({
			card_faces: [{ image_uris: { art_crop: "face-art.png" } }],
		});
		expect(getArtCropUrl(card)).toBe("face-art.png");
	});

	it("falls back to getImageUrl when no art crop is available at all", () => {
		const card = makeScryfallCard({ image_uris: { normal: "normal.png" } });
		expect(getArtCropUrl(card)).toBe("normal.png");
	});
});

describe("getRarityColor", () => {
	it("maps each known rarity to its color", () => {
		expect(getRarityColor("mythic")).toBe("#d9662b");
		expect(getRarityColor("rare")).toBe("#d4af37");
		expect(getRarityColor("uncommon")).toBe("#9fb4c7");
		expect(getRarityColor("common")).toBe("#ffffff");
	});

	it("is case-insensitive", () => {
		expect(getRarityColor("MYTHIC")).toBe("#d9662b");
	});

	it("defaults to white for an unknown rarity", () => {
		expect(getRarityColor("bogus")).toBe("#ffffff");
	});
});

describe("sanitizeSvg", () => {
	it("strips script tags", () => {
		const svg = `<svg><script>alert(1)</script><circle /></svg>`;
		expect(sanitizeSvg(svg)).toBe("<svg><circle /></svg>");
	});

	it("strips inline event handler attributes with either quote style", () => {
		const svg = `<svg onload="evil()"><circle onclick='evil()' /></svg>`;
		expect(sanitizeSvg(svg)).toBe(`<svg><circle /></svg>`);
	});

	it("leaves a clean svg untouched", () => {
		const svg = `<svg><path fill="#fff" /></svg>`;
		expect(sanitizeSvg(svg)).toBe(svg);
	});

	it("strips javascript: and data: href/xlink:href attributes", () => {
		const svg = `<svg><a href="javascript:alert(1)">x</a><use xlink:href="data:image/svg+xml;base64,x" /><path fill="#fff" /></svg>`;
		expect(sanitizeSvg(svg)).toBe(`<svg><a>x</a><use /><path fill="#fff" /></svg>`);
	});

	it("leaves a normal http(s) href untouched", () => {
		const svg = `<svg><a href="https://example.com">x</a></svg>`;
		expect(sanitizeSvg(svg)).toBe(svg);
	});

	it("strips foreignObject blocks entirely, including any nested markup", () => {
		const svg = `<svg><foreignObject><body onload="evil()">hi</body></foreignObject><circle /></svg>`;
		expect(sanitizeSvg(svg)).toBe("<svg><circle /></svg>");
	});

	it("strips SMIL animation tags (animate/animateTransform/animateMotion/set)", () => {
		const svg =
			`<svg><animate attributeName="x" to="1" /><animateTransform attributeName="transform" values="javascript:alert(1)" />` +
			`<animateMotion path="M0 0" /><set attributeName="x" to="1" /><circle /></svg>`;
		expect(sanitizeSvg(svg)).toBe("<svg><circle /></svg>");
	});

	// Bypasses CodeQL reports (js/bad-tag-filter, js/incomplete-multi-character-sanitization): the browser's
	// HTML parser accepts end tags the regexes did not know, and a single pass lets a removal assemble a new
	// forbidden fragment out of the text on both sides of it.
	it("strips a script whose end tag has a space or attributes (browsers accept both)", () => {
		expect(sanitizeSvg(`<svg><script>alert(1)</script ><circle /></svg>`)).toBe("<svg><circle /></svg>");
		expect(sanitizeSvg(`<svg><script>alert(1)</script foo="bar"><circle /></svg>`)).toBe("<svg><circle /></svg>");
		expect(sanitizeSvg(`<svg><script>alert(1)</script/><circle /></svg>`)).toBe("<svg><circle /></svg>");
	});

	it("strips a foreignObject whose end tag has a space or attributes", () => {
		expect(sanitizeSvg(`<svg><foreignObject><p>hi</p></foreignObject ><circle /></svg>`)).toBe("<svg><circle /></svg>");
		expect(sanitizeSvg(`<svg><foreignObject><p>hi</p></foreignObject x="y"><circle /></svg>`)).toBe(
			"<svg><circle /></svg>",
		);
	});

	it("does not leave a script behind when removing one assembles another", () => {
		expect(sanitizeSvg(`<svg><scr<script></script>ipt>alert(1)</script><circle /></svg>`)).toBe(
			"<svg><circle /></svg>",
		);
	});

	it("does not leave an event handler behind when removing one assembles another", () => {
		expect(sanitizeSvg(`<svg o onclick="x"nload="y"><circle /></svg>`)).toBe("<svg><circle /></svg>");
		expect(sanitizeSvg(`<svg o onclick='x'nload='y'><circle /></svg>`)).toBe("<svg><circle /></svg>");
	});

	it("does not leave a javascript: href behind when removing one assembles another", () => {
		expect(sanitizeSvg(`<svg><a hr href="javascript:x"ef="javascript:alert(1)">x</a></svg>`)).toBe(
			"<svg><a>x</a></svg>",
		);
		expect(sanitizeSvg(`<svg><a hr href='data:x'ef='javascript:alert(1)'>x</a></svg>`)).toBe("<svg><a>x</a></svg>");
	});

	it("does not leave an animation tag behind when removing one assembles another", () => {
		expect(sanitizeSvg(`<svg><anim<set x="1"/>ate attributeName="x" to="1"/><circle /></svg>`)).toBe(
			"<svg><circle /></svg>",
		);
	});
});

describe("toCsvField", () => {
	it("wraps a plain value in quotes", () => {
		expect(toCsvField("Lightning Bolt")).toBe('"Lightning Bolt"');
	});

	it("doubles embedded quotes (RFC 4180)", () => {
		expect(toCsvField('Say "hi"')).toBe('"Say ""hi"""');
	});

	it("defangs a leading =, +, -, @ (CSV formula injection) with a leading apostrophe", () => {
		expect(toCsvField("=cmd|'/c calc'!A1")).toBe(`"'=cmd|'/c calc'!A1"`);
		expect(toCsvField("+1")).toBe(`"'+1"`);
		expect(toCsvField("-1")).toBe(`"'-1"`);
		expect(toCsvField("@SUM(1,1)")).toBe(`"'@SUM(1,1)"`);
	});

	it("does not defang a value that merely contains one of those characters mid-string", () => {
		expect(toCsvField("Fire // Ice - Split")).toBe('"Fire // Ice - Split"');
	});
});

describe("parseCsv", () => {
	it("parses simple comma-separated rows", () => {
		expect(parseCsv("a,b,c\n1,2,3\n")).toEqual([
			["a", "b", "c"],
			["1", "2", "3"],
		]);
	});

	it("handles quoted fields containing commas", () => {
		expect(parseCsv('name,note\n"Bolt, Lightning",good\n')).toEqual([
			["name", "note"],
			["Bolt, Lightning", "good"],
		]);
	});

	it("handles quoted fields containing embedded newlines", () => {
		expect(parseCsv('name,rules\nCard,"Line one\nLine two"\n')).toEqual([
			["name", "rules"],
			["Card", "Line one\nLine two"],
		]);
	});

	it("unescapes doubled quotes inside a quoted field", () => {
		expect(parseCsv('name\n"Say ""hi"""\n')).toEqual([["name"], ['Say "hi"']]);
	});

	it("filters out blank lines", () => {
		expect(parseCsv("a,b\n\n1,2\n")).toEqual([
			["a", "b"],
			["1", "2"],
		]);
	});

	it("handles a final row with no trailing newline", () => {
		expect(parseCsv("a,b\n1,2")).toEqual([
			["a", "b"],
			["1", "2"],
		]);
	});
});

describe("chunk", () => {
	it("splits an array into fixed-size chunks", () => {
		expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
	});

	it("returns a single chunk when size exceeds the array length", () => {
		expect(chunk([1, 2], 75)).toEqual([[1, 2]]);
	});

	it("returns an empty array for empty input", () => {
		expect(chunk([], 75)).toEqual([]);
	});
});

describe("dedupeSetsByIcon", () => {
	function makeSet(overrides: Partial<ScryfallSetSummary> = {}): ScryfallSetSummary {
		return {
			code: "xyz",
			name: "Set",
			set_type: "expansion",
			icon_svg_uri: "icon-a.svg",
			digital: false,
			...overrides,
		};
	}

	it("keeps every set untouched when each has its own icon", () => {
		const sets = [
			makeSet({ code: "a", icon_svg_uri: "icon-a.svg" }),
			makeSet({ code: "b", icon_svg_uri: "icon-b.svg" }),
		];
		expect(dedupeSetsByIcon(sets)).toHaveLength(2);
	});

	it("collapses several sets sharing the same icon into one", () => {
		const sets = [
			makeSet({ code: "msh", name: "Marvel Super Heroes", set_type: "expansion" }),
			makeSet({ code: "tmsh", name: "Marvel Super Heroes Tokens", set_type: "token" }),
			makeSet({ code: "amsh", name: "Marvel Super Heroes Art Series", set_type: "memorabilia" }),
		];
		const result = dedupeSetsByIcon(sets);
		expect(result).toHaveLength(1);
		expect(result[0].code).toBe("msh");
	});

	it("prefers the main entry even when it's encountered after its accessory sets", () => {
		const sets = [
			makeSet({ code: "tmsh", name: "Marvel Super Heroes Tokens", set_type: "token" }),
			makeSet({ code: "msh", name: "Marvel Super Heroes", set_type: "expansion" }),
		];
		expect(dedupeSetsByIcon(sets)[0].code).toBe("msh");
	});

	it("keeps the first entry when every candidate sharing an icon is an accessory type", () => {
		const sets = [
			makeSet({ code: "tmsh", name: "Marvel Super Heroes Tokens", set_type: "token" }),
			makeSet({ code: "amsh", name: "Marvel Super Heroes Art Series", set_type: "memorabilia" }),
		];
		expect(dedupeSetsByIcon(sets)[0].code).toBe("tmsh");
	});

	it("never merges sets with no known icon into each other", () => {
		const sets = [
			makeSet({ code: "a", icon_svg_uri: undefined }),
			makeSet({ code: "b", icon_svg_uri: undefined }),
		];
		expect(dedupeSetsByIcon(sets)).toHaveLength(2);
	});
});

describe("getSetGroupLabel", () => {
	it("maps every real set_type observed live on /sets to a non-'Other' group", () => {
		// The 22 set_type values actually seen live on the API at the time of
		// writing this test — if Scryfall removes one, this test keeps passing (no
		// negative assertion); if it adds a new one, getSetGroupLabel sends it to
		// "Other" rather than crash, but this test would not detect it — a
		// separate test covers that fallback.
		const knownTypes = [
			"core",
			"expansion",
			"commander",
			"planechase",
			"archenemy",
			"vanguard",
			"arsenal",
			"masters",
			"draft_innovation",
			"duel_deck",
			"from_the_vault",
			"premium_deck",
			"spellbook",
			"starter",
			"box",
			"masterpiece",
			"promo",
			"token",
			"memorabilia",
			"minigame",
			"eternal",
			"funny",
		];
		knownTypes.forEach((t) => expect(getSetGroupLabel(t)).not.toBe("Other"));
	});

	it("falls back to 'Other' for an unrecognized set_type", () => {
		expect(getSetGroupLabel("some_future_type_scryfall_hasnt_invented_yet")).toBe("Other");
	});

	it("puts core and expansion sets in their own distinct groups", () => {
		expect(getSetGroupLabel("core")).toBe("Core sets");
		expect(getSetGroupLabel("expansion")).toBe("Expansion sets");
		expect(getSetGroupLabel("core")).not.toBe(getSetGroupLabel("expansion"));
	});

	it("groups every Commander/multiplayer-oriented set_type together", () => {
		const label = getSetGroupLabel("commander");
		expect(getSetGroupLabel("planechase")).toBe(label);
		expect(getSetGroupLabel("archenemy")).toBe(label);
		expect(getSetGroupLabel("vanguard")).toBe(label);
		expect(getSetGroupLabel("arsenal")).toBe(label);
	});

	it("isolates funny (Un-set) sets into their own group", () => {
		expect(getSetGroupLabel("funny")).toBe("Un-Sets");
		expect(getSetGroupLabel("funny")).not.toBe(getSetGroupLabel("expansion"));
	});
});

describe("SET_GROUP_ORDER", () => {
	it("ends with 'Other', matching getSetGroupLabel's own fallback", () => {
		expect(SET_GROUP_ORDER[SET_GROUP_ORDER.length - 1]).toBe("Other");
	});

	it("lists every group getSetGroupLabel can actually return, with no duplicates", () => {
		expect(new Set(SET_GROUP_ORDER).size).toBe(SET_GROUP_ORDER.length);
		expect(SET_GROUP_ORDER).toContain(getSetGroupLabel("core"));
		expect(SET_GROUP_ORDER).toContain(getSetGroupLabel("funny"));
	});
});

describe("requestScryfall", () => {
	it("returns the response as-is when not rate-limited", async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: { ok: true } } as any);
		const res = await requestScryfall({ url: "https://api.scryfall.com/x" });
		expect(res.status).toBe(200);
	});

	// Each case below now includes the initial global gate
	// (SCRYFALL_MIN_GAP_MS = 110ms, see requestScryfall) IN ADDITION to the
	// 429's own wait — the request itself only goes out after those 110ms, so
	// the total delay before resolution is "110ms + 429 wait", not just the
	// 429 wait alone.

	it("waits the Retry-After duration (seconds) before resolving on a 429", async () => {
		vi.useFakeTimers();
		try {
			mockRequestUrl.mockResolvedValueOnce({
				status: 429,
				headers: { "retry-after": "1" },
				json: {},
			} as any);
			let resolved = false;
			requestScryfall({ url: "https://api.scryfall.com/x" }).then(() => {
				resolved = true;
			});
			await vi.advanceTimersByTimeAsync(1109);
			expect(resolved).toBe(false);
			await vi.advanceTimersByTimeAsync(50);
			expect(resolved).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("falls back to a fixed 2s wait when Retry-After is absent", async () => {
		vi.useFakeTimers();
		try {
			mockRequestUrl.mockResolvedValueOnce({ status: 429, headers: {}, json: {} } as any);
			let resolved = false;
			requestScryfall({ url: "https://api.scryfall.com/x" }).then(() => {
				resolved = true;
			});
			await vi.advanceTimersByTimeAsync(2109);
			expect(resolved).toBe(false);
			await vi.advanceTimersByTimeAsync(50);
			expect(resolved).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("caps an excessive Retry-After at 5s rather than blocking indefinitely", async () => {
		vi.useFakeTimers();
		try {
			mockRequestUrl.mockResolvedValueOnce({
				status: 429,
				headers: { "retry-after": "3600" },
				json: {},
			} as any);
			let resolved = false;
			requestScryfall({ url: "https://api.scryfall.com/x" }).then(() => {
				resolved = true;
			});
			await vi.advanceTimersByTimeAsync(5109);
			expect(resolved).toBe(false);
			await vi.advanceTimersByTimeAsync(50);
			expect(resolved).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("spaces out concurrent requests from independent callers by the global minimum gap", async () => {
		vi.useFakeTimers();
		try {
			const callTimes: number[] = [];
			mockRequestUrl.mockImplementation((() => {
				callTimes.push(Date.now());
				return Promise.resolve({ status: 200, json: {} });
			}) as any);
			const p1 = requestScryfall({ url: "https://api.scryfall.com/a" });
			const p2 = requestScryfall({ url: "https://api.scryfall.com/b" });
			const p3 = requestScryfall({ url: "https://api.scryfall.com/c" });
			await vi.advanceTimersByTimeAsync(400);
			await Promise.all([p1, p2, p3]);
			expect(callTimes.length).toBe(3);
			expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(110);
			expect(callTimes[2] - callTimes[1]).toBeGreaterThanOrEqual(110);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("the 2-requests-per-second endpoints of Scryfall", () => {
	it("recognises exactly the four hard-limited endpoints", () => {
		for (const url of [
			"https://api.scryfall.com/cards/collection",
			"https://api.scryfall.com/cards/search?q=x&unique=prints",
			"https://api.scryfall.com/cards/named?exact=Sol+Ring",
			"https://api.scryfall.com/cards/random",
		]) {
			expect(isScryfallStrictEndpoint(url)).toBe(true);
		}
		for (const url of [
			"https://api.scryfall.com/cards/lea/161", // by set and number: "all other methods"
			"https://api.scryfall.com/sets/lea",
			"https://api.scryfall.com/symbology",
			"https://api.scryfall.com/cards/autocomplete?q=sol",
		]) {
			expect(isScryfallStrictEndpoint(url)).toBe(false);
		}
	});

	it("keeps /cards/collection requests 550 ms apart, and lets a request that finds the line idle go out at once", async () => {
		vi.useFakeTimers();
		try {
			resetScryfallStrictGateForTests();
			const callTimes: number[] = [];
			mockRequestUrl.mockImplementation((() => {
				callTimes.push(Date.now());
				return Promise.resolve({ status: 200, json: {} });
			}) as any);
			const url = "https://api.scryfall.com/cards/collection";
			const batch = [requestScryfall({ url }), requestScryfall({ url }), requestScryfall({ url })];
			await vi.advanceTimersByTimeAsync(3000);
			await Promise.all(batch);
			expect(callTimes.length).toBe(3);
			expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(550);
			expect(callTimes[2] - callTimes[1]).toBeGreaterThanOrEqual(550);
			// a lone request much later: only the 110 ms gate, not 550
			await vi.advanceTimersByTimeAsync(10_000);
			const before = Date.now();
			const lone = requestScryfall({ url });
			await vi.advanceTimersByTimeAsync(200);
			await lone;
			expect(callTimes[3] - before).toBeLessThan(200);
		} finally {
			vi.useRealTimers();
			resetScryfallStrictGateForTests();
		}
	});

	it("does not slow the other methods down (sets, symbology, a card by set and number)", async () => {
		vi.useFakeTimers();
		try {
			resetScryfallStrictGateForTests();
			const callTimes: number[] = [];
			mockRequestUrl.mockImplementation((() => {
				callTimes.push(Date.now());
				return Promise.resolve({ status: 200, json: {} });
			}) as any);
			const calls = ["https://api.scryfall.com/sets/lea", "https://api.scryfall.com/symbology", "https://api.scryfall.com/cards/lea/161"].map((url) => requestScryfall({ url }));
			await vi.advanceTimersByTimeAsync(600);
			await Promise.all(calls);
			expect(callTimes[2] - callTimes[0]).toBeLessThan(400);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("applySvgColor", () => {
	it("sets the container's own color and every matched descendant's fill", () => {
		const path1 = { style: {} as Record<string, string> };
		const path2 = { style: {} as Record<string, string> };
		const container = makeFakeSvgContainer([path1, path2]);
		applySvgColor(container, "#ff0000");
		expect(container.style.color).toBe("#ff0000");
		expect(path1.style.fill).toBe("#ff0000");
		expect(path2.style.fill).toBe("#ff0000");
	});

	it("does nothing to descendants when there are none, without throwing", () => {
		const container = makeFakeSvgContainer([]);
		expect(() => applySvgColor(container, "#00ff00")).not.toThrow();
		expect(container.style.color).toBe("#00ff00");
	});
});

describe("searchScryfall", () => {
	it("uses the exact set+collector-number lookup when both are given, and returns a single card on 200", async () => {
		const card = makeScryfallCard({ id: "exact1" });
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: card } as any);

		const results = await searchScryfall("", "mid", "235");

		expect(results).toEqual({ cards: [card], hasMore: false, totalCards: 1 });
		expect(mockRequestUrl).toHaveBeenCalledTimes(1);
		expect((mockRequestUrl.mock.calls[0][0] as any).url).toContain("/cards/mid/235");
	});

	it("falls back to the general search on a 404 from the exact lookup", async () => {
		const generalCard = makeScryfallCard({ id: "general1" });
		mockRequestUrl
			.mockResolvedValueOnce({ status: 404, json: {} } as any)
			.mockResolvedValueOnce({ status: 200, json: { data: [generalCard] } } as any);

		const results = await searchScryfall("Bolt", "mid", "235");

		expect(results).toEqual({ cards: [generalCard], hasMore: false, totalCards: 1 });
		expect(mockRequestUrl).toHaveBeenCalledTimes(2);
	});

	it("throws a ScryfallError when the exact lookup fails with a non-404 status", async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 500, json: { details: "Server error" } } as any);

		await expect(searchScryfall("", "mid", "235")).rejects.toMatchObject({
			status: 500,
			message: "Server error",
		});
	});

	it("returns an empty result without calling requestUrl when there is nothing to search for", async () => {
		const results = await searchScryfall("", "", "");
		expect(results).toEqual({ cards: [], hasMore: false, totalCards: 0 });
		expect(mockRequestUrl).not.toHaveBeenCalled();
	});

	it("orders by set when a set filter is present in the query, else by release date", async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: { data: [] } } as any);
		await searchScryfall("", "mid", "");
		expect((mockRequestUrl.mock.calls[0][0] as any).url).toContain("order=set&dir=asc");

		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: { data: [] } } as any);
		await searchScryfall("Bolt", "", "");
		expect((mockRequestUrl.mock.calls[1][0] as any).url).toContain("order=released");
	});

	it("returns an empty result on a 404 from the general search", async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 404, json: {} } as any);
		expect(await searchScryfall("Bolt", "", "")).toEqual({ cards: [], hasMore: false, totalCards: 0 });
	});

	it("throws a ScryfallError on a non-200/404 status from the general search", async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 503, json: {} } as any);
		await expect(searchScryfall("Bolt", "", "")).rejects.toThrow(ScryfallError);
	});

	it("falls back to an empty result when the response has no data field", async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: {} } as any);
		expect(await searchScryfall("Bolt", "", "")).toEqual({ cards: [], hasMore: false, totalCards: 0 });
	});

	it("surfaces has_more/total_cards from the response, and falls back to cards.length when total_cards is missing", async () => {
		const card = makeScryfallCard({ id: "p1" });
		mockRequestUrl.mockResolvedValueOnce({
			status: 200,
			json: { data: [card], has_more: true, total_cards: 340 },
		} as any);
		expect(await searchScryfall("Bolt", "", "")).toEqual({ cards: [card], hasMore: true, totalCards: 340 });

		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: { data: [card] } } as any);
		expect(await searchScryfall("Bolt", "", "")).toEqual({ cards: [card], hasMore: false, totalCards: 1 });
	});

	it("only appends &page= to the URL when page > 1", async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: { data: [] } } as any);
		await searchScryfall("Bolt", "", "", "", undefined, 1);
		expect((mockRequestUrl.mock.calls[0][0] as any).url).not.toContain("page=");

		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: { data: [] } } as any);
		await searchScryfall("Bolt", "", "", "", undefined, 2);
		expect((mockRequestUrl.mock.calls[1][0] as any).url).toContain("&page=2");
	});
});

describe("fetchLatestPaperPrintings", () => {
	it("returns paper printings on success", async () => {
		const card = makeScryfallCard({ id: "p1" });
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: { data: [card] } } as any);
		expect(await fetchLatestPaperPrintings()).toEqual({ cards: [card], hasMore: false, totalCards: 1 });
	});

	it("returns an empty result on any non-200 status", async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 500, json: {} } as any);
		expect(await fetchLatestPaperPrintings()).toEqual({ cards: [], hasMore: false, totalCards: 0 });
	});

	it("surfaces has_more/total_cards, and appends &page= only when page > 1", async () => {
		const card = makeScryfallCard({ id: "p1" });
		mockRequestUrl.mockResolvedValueOnce({
			status: 200,
			json: { data: [card], has_more: true, total_cards: 500 },
		} as any);
		expect(await fetchLatestPaperPrintings(undefined, 3)).toEqual({
			cards: [card],
			hasMore: true,
			totalCards: 500,
		});
		expect((mockRequestUrl.mock.calls[0][0] as any).url).toContain("&page=3");
	});
});

describe("searchAllPrintings", () => {
	it("returns all printings for an exact card name on success", async () => {
		const card = makeScryfallCard({ id: "print1" });
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: { data: [card] } } as any);
		expect(await searchAllPrintings("Lightning Bolt")).toEqual([card]);
	});

	it("returns an empty array on any non-200 status", async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 404, json: {} } as any);
		expect(await searchAllPrintings("Nonexistent Card")).toEqual([]);
	});
});

describe("fetchScryfallCollection", () => {
	it("batches ids into groups of 75, merges results by id, and reports progress per batch", async () => {
		const ids = Array.from({ length: 80 }, (_, i) => `id${i}`);
		mockRequestUrl
			.mockResolvedValueOnce({
				status: 200,
				json: { data: ids.slice(0, 75).map((id) => makeScryfallCard({ id })) },
			} as any)
			.mockResolvedValueOnce({
				status: 200,
				json: { data: ids.slice(75).map((id) => makeScryfallCard({ id })) },
			} as any);
		const onProgress = vi.fn();

		const map = await fetchScryfallCollection(ids, onProgress);

		expect(map.size).toBe(80);
		expect(map.get("id0")?.id).toBe("id0");
		expect(map.get("id79")?.id).toBe("id79");
		expect(onProgress).toHaveBeenCalledWith("Fetching card data… batch 1/2");
		expect(onProgress).toHaveBeenCalledWith("Fetching card data… batch 2/2");

		const firstRequest = mockRequestUrl.mock.calls[0][0] as any;
		expect(firstRequest.url).toBe("https://api.scryfall.com/cards/collection");
		expect(firstRequest.method).toBe("POST");
		const body = JSON.parse(firstRequest.body);
		expect(body.identifiers).toHaveLength(75);
		expect(body.identifiers[0]).toEqual({ id: "id0" });
	});

	it("silently skips a failed batch instead of throwing", async () => {
		const ids = Array.from({ length: 80 }, (_, i) => `id${i}`);
		mockRequestUrl
			.mockResolvedValueOnce({ status: 500, json: {} } as any)
			.mockResolvedValueOnce({
				status: 200,
				json: { data: ids.slice(75).map((id) => makeScryfallCard({ id })) },
			} as any);

		const map = await fetchScryfallCollection(ids);

		expect(map.size).toBe(5);
		expect(map.has("id0")).toBe(false);
	});

	it("calls onChunkResolved after each batch with only that batch's cards, before the whole call resolves", async () => {
		// Root cause of a bug reported twice on the
		// MTGCollectionPlugin.bulkFetchLegalities side (plugin.ts): without a way
		// to resolve each id as soon as ITS batch comes back, a caller that
		// derives one Promise per id from the single Promise returned by this
		// function sees ALL its ids resolved only after the very last batch, even
		// those whose data arrived in the first.
		const ids = Array.from({ length: 80 }, (_, i) => `id${i}`);
		mockRequestUrl
			.mockResolvedValueOnce({
				status: 200,
				json: { data: ids.slice(0, 75).map((id) => makeScryfallCard({ id })) },
			} as any)
			.mockResolvedValueOnce({
				status: 200,
				json: { data: ids.slice(75).map((id) => makeScryfallCard({ id })) },
			} as any);
		const chunkSnapshots: number[] = [];
		const onChunkResolved = vi.fn((chunkResults: Map<string, unknown>) => {
			chunkSnapshots.push(chunkResults.size);
		});

		const map = await fetchScryfallCollection(ids, undefined, onChunkResolved);

		expect(onChunkResolved).toHaveBeenCalledTimes(2);
		expect(chunkSnapshots).toEqual([75, 5]);
		// The first call must contain ONLY the ids of the first batch, not yet
		// those of the second (which has not been requested yet at that moment) —
		// checks that it is a per-batch snapshot, not a reference to the final
		// cumulative map.
		const firstCallResults = onChunkResolved.mock.calls[0][0] as Map<string, unknown>;
		expect(firstCallResults.has("id0")).toBe(true);
		expect(firstCallResults.has("id75")).toBe(false);
		// An independent snapshot, not a reference to the final cumulative map
		// (which would indeed contain id75 once both batches are processed) —
		// without this distinction, the previous test would pass even if the code
		// passed `map` instead of `chunkMap`.
		expect(firstCallResults).not.toBe(map);
		expect(map.size).toBe(80);
	});

	it("passes an empty chunk map to onChunkResolved for a failed batch, without throwing", async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 500, json: {} } as any);
		const onChunkResolved = vi.fn();

		await fetchScryfallCollection(["id0"], undefined, onChunkResolved);

		expect(onChunkResolved).toHaveBeenCalledTimes(1);
		expect((onChunkResolved.mock.calls[0][0] as Map<string, unknown>).size).toBe(0);
	});

	it("returns an empty map and makes no requests for an empty id list", async () => {
		const map = await fetchScryfallCollection([]);
		expect(map.size).toBe(0);
		expect(mockRequestUrl).not.toHaveBeenCalled();
	});
});

describe("buildCardTextInfo", () => {
	it("reads oracle text and stats straight off a single-faced card", () => {
		const card = makeScryfallCard({
			oracle_text: "Flying, vigilance",
			power: "3",
			toughness: "4",
		});
		expect(buildCardTextInfo(card)).toEqual({
			oracleText: "Flying, vigilance",
			power: "3",
			toughness: "4",
			loyalty: undefined,
		});
	});

	it("treats an empty oracle_text (a real vanilla creature) as a real, non-null result", () => {
		const card = makeScryfallCard({ oracle_text: "", power: "2", toughness: "2" });
		expect(buildCardTextInfo(card)).toEqual({
			oracleText: "",
			power: "2",
			toughness: "2",
			loyalty: undefined,
		});
	});

	it("reads loyalty straight off a single-faced planeswalker", () => {
		const card = makeScryfallCard({ oracle_text: "+1: ...", loyalty: "5" });
		expect(buildCardTextInfo(card).loyalty).toBe("5");
	});

	it("falls back to card_faces when the top-level card has no oracle_text at all (double-faced card)", () => {
		const card = makeScryfallCard({
			oracle_text: undefined,
			card_faces: [
				{ name: "Front Face", oracle_text: "Front ability text", power: "2", toughness: "2" },
				{ name: "Back Face", oracle_text: "Back ability text" },
			],
		});
		const info = buildCardTextInfo(card);
		expect(info.oracleText).toBe("Front Face\nFront ability text\n\n// \n\nBack Face\nBack ability text");
		expect(info.power).toBe("2");
		expect(info.toughness).toBe("2");
	});

	it("skips faces with no oracle_text of their own when combining a double-faced card's text", () => {
		const card = makeScryfallCard({
			oracle_text: undefined,
			card_faces: [{ name: "Front", oracle_text: "Front text" }, { name: "Back" }],
		});
		expect(buildCardTextInfo(card).oracleText).toBe("Front\nFront text");
	});

	it("does not populate faces for a single-faced card", () => {
		const card = makeScryfallCard({ oracle_text: "Flying" });
		expect(buildCardTextInfo(card).faces).toBeUndefined();
	});

	it("populates faces with each face's own name/manaCost/typeLine/oracleText/stats, unmerged (split card)", () => {
		const card = makeScryfallCard({
			oracle_text: undefined,
			mana_cost: "{1}{R} // {1}{U}",
			type_line: "Instant // Instant",
			card_faces: [
				{ name: "Fire", mana_cost: "{1}{R}", type_line: "Instant", oracle_text: "Fire deals 2 damage." },
				{ name: "Ice", mana_cost: "{1}{U}", type_line: "Instant", oracle_text: "Tap target permanent." },
			],
		});
		expect(buildCardTextInfo(card).faces).toEqual([
			{
				name: "Fire",
				manaCost: "{1}{R}",
				typeLine: "Instant",
				oracleText: "Fire deals 2 damage.",
				power: undefined,
				toughness: undefined,
				loyalty: undefined,
			},
			{
				name: "Ice",
				manaCost: "{1}{U}",
				typeLine: "Instant",
				oracleText: "Tap target permanent.",
				power: undefined,
				toughness: undefined,
				loyalty: undefined,
			},
		]);
	});

	it("populates faces with each face's own power/toughness (double-faced creature)", () => {
		const card = makeScryfallCard({
			oracle_text: undefined,
			card_faces: [
				{ name: "Front", oracle_text: "Front text", power: "2", toughness: "2" },
				{ name: "Back", oracle_text: "Back text", power: "5", toughness: "5" },
			],
		});
		const faces = buildCardTextInfo(card).faces;
		expect(faces?.[0]).toMatchObject({ name: "Front", power: "2", toughness: "2" });
		expect(faces?.[1]).toMatchObject({ name: "Back", power: "5", toughness: "5" });
	});
});

describe("getDoubleFacedImages", () => {
	it("returns front/back for a real transform/modal_dfc card (no root image_uris, both faces have one)", () => {
		const card = makeScryfallCard({
			image_uris: undefined,
			card_faces: [
				{ name: "Front", image_uris: { normal: "front.png" } },
				{ name: "Back", image_uris: { normal: "back.png" } },
			],
		});
		expect(getDoubleFacedImages(card)).toEqual({ front: "front.png", back: "back.png" });
	});

	it("also returns the artwork alone of the back face when Scryfall has one", () => {
		const card = makeScryfallCard({
			image_uris: undefined,
			card_faces: [
				{ name: "Front", image_uris: { normal: "front.png", art_crop: "front-art.png" } },
				{ name: "Back", image_uris: { normal: "back.png", art_crop: "back-art.png" } },
			],
		});
		expect(getDoubleFacedImages(card)?.backArt).toBe("back-art.png");
	});

	it("also returns the illustrator of the back face, which can differ from the front's", () => {
		const card = makeScryfallCard({
			image_uris: undefined,
			card_faces: [
				{ name: "Front", artist: "Front Artist", image_uris: { normal: "front.png" } },
				{ name: "Back", artist: "Back Artist", image_uris: { normal: "back.png" } },
			],
		});
		expect(getDoubleFacedImages(card)?.backArtist).toBe("Back Artist");
	});

	it("returns null for a single-faced card with no card_faces at all", () => {
		const card = makeScryfallCard({ image_uris: { normal: "front.png" } });
		expect(getDoubleFacedImages(card)).toBeNull();
	});

	it("returns null for split/adventure/flip-style cards — root has its own image even though card_faces exists", () => {
		const card = makeScryfallCard({
			image_uris: { normal: "whole-card.png" },
			card_faces: [{ name: "Fire" }, { name: "Ice" }],
		});
		expect(getDoubleFacedImages(card)).toBeNull();
	});

	it("returns null for a meld card — root has its own image and no card_faces", () => {
		const card = makeScryfallCard({ image_uris: { normal: "whole-card.png" }, card_faces: undefined });
		expect(getDoubleFacedImages(card)).toBeNull();
	});

	it("returns null if a face is missing its own image_uris despite no root image (defensive — shouldn't happen live)", () => {
		const card = makeScryfallCard({
			image_uris: undefined,
			card_faces: [{ name: "Front", image_uris: { normal: "front.png" } }, { name: "Back" }],
		});
		expect(getDoubleFacedImages(card)).toBeNull();
	});
});

describe("getSplitCardInfo", () => {
	it("returns isAftermath: false for a classic split card (e.g. Fire // Ice)", () => {
		const card = makeScryfallCard({ layout: "split", keywords: [] });
		expect(getSplitCardInfo(card)).toEqual({ isAftermath: false });
	});

	it("returns isAftermath: true for an Aftermath-style split card (e.g. Never // Return)", () => {
		const card = makeScryfallCard({ layout: "split", keywords: ["Aftermath"] });
		expect(getSplitCardInfo(card)).toEqual({ isAftermath: true });
	});

	it("returns isAftermath: false when keywords is entirely absent (defensive)", () => {
		const card = makeScryfallCard({ layout: "split", keywords: undefined });
		expect(getSplitCardInfo(card)).toEqual({ isAftermath: false });
	});

	it("returns null for a non-split layout even if keywords happens to include Aftermath", () => {
		const card = makeScryfallCard({ layout: "normal", keywords: ["Aftermath"] });
		expect(getSplitCardInfo(card)).toBeNull();
	});

	it("returns null for a real double-faced card (transform/modal_dfc) — flip button territory, not rotation", () => {
		const card = makeScryfallCard({
			layout: "transform",
			image_uris: undefined,
			card_faces: [{ name: "Front", image_uris: { normal: "front.png" } }, { name: "Back" }],
		});
		expect(getSplitCardInfo(card)).toBeNull();
	});

	it("returns null when layout is entirely absent (older cached data, defensive)", () => {
		const card = makeScryfallCard({ layout: undefined });
		expect(getSplitCardInfo(card)).toBeNull();
	});
});

describe("searching by a name printed in another language", () => {
	// Shapes taken from live responses of 2026-11-07: the French print of Rocky
	// Rebuke (TLA 193) has the English `name`, the French `printed_name` and prices
	// that are ALL null, the English print has the prices.
	const frenchHit = makeScryfallCard({
		id: "fr-id",
		name: "Rocky Rebuke",
		set: "tla",
		collector_number: "193",
		lang: "fr",
		printed_name: "Blâme de pierre",
		prices: { usd: undefined, eur: undefined },
	});
	const englishPrint = makeScryfallCard({
		id: "en-id",
		name: "Rocky Rebuke",
		set: "tla",
		collector_number: "193",
		lang: "en",
		prices: { usd: "0.20", usd_foil: "0.23", eur: "0.08" },
	});

	type Handler = {
		search?: (query: string) => { status: number; json: unknown };
		collection?: (identifiers: { set: string; collector_number: string }[]) => { status: number; json: unknown };
	};
	function serve(handler: Handler) {
		mockRequestUrl.mockImplementation((async (params: { url: string; body?: string }) => {
			if (params.url.includes("/cards/search")) {
				const query = new URL(params.url).searchParams.get("q") ?? "";
				return handler.search?.(query) ?? { status: 404, json: {} };
			}
			if (params.url.endsWith("/cards/collection")) {
				const identifiers = JSON.parse(params.body ?? "{}").identifiers;
				return handler.collection?.(identifiers) ?? { status: 200, json: { data: [], not_found: [] } };
			}
			return { status: 404, json: {} };
		}) as any);
	}
	const searchQueries = () =>
		mockRequestUrl.mock.calls
			.filter((c) => (c[0] as any).url.includes("/cards/search"))
			.map((c) => new URL((c[0] as any).url).searchParams.get("q"));
	const collectionCalls = () => mockRequestUrl.mock.calls.filter((c) => (c[0] as any).url.endsWith("/cards/collection"));

	// The strict endpoints are spaced 550 ms apart: run on a fake clock.
	async function run<T>(start: () => Promise<T>): Promise<T> {
		vi.useFakeTimers();
		try {
			resetScryfallStrictGateForTests();
			const pending = start();
			await vi.advanceTimersByTimeAsync(20_000);
			return await pending;
		} finally {
			vi.useRealTimers();
			resetScryfallStrictGateForTests();
		}
	}

	beforeEach(() => {
		clearEnglishPrintCacheForTests();
	});

	it("looks in every language when English finds nothing, and returns the English print carrying the language", async () => {
		serve({
			search: (q) => (q.endsWith("lang:any") ? { status: 200, json: { data: [frenchHit], total_cards: 1 } } : { status: 404, json: {} }),
			collection: () => ({ status: 200, json: { data: [englishPrint], not_found: [] } }),
		});

		// typed without the accent: nothing says it is not English, so English is tried first
		const result = await run(() => searchScryfall("", "", "", "Blame de pierre", undefined, 1, "english-then-any"));

		expect(searchQueries()).toEqual(["Blame de pierre", "Blame de pierre lang:any"]);
		expect(result.searchedAnyLanguage).toBe(true);
		expect(result.cards).toHaveLength(1);
		const card = result.cards[0];
		expect(card.id).toBe("en-id");
		expect(card.prices?.usd).toBe("0.20");
		expect(card.lang).toBe("fr");
		expect(card.printed_name).toBe("Blâme de pierre");
		// the English print is asked for by set + collector number, nothing else
		expect(JSON.parse((collectionCalls()[0][0] as any).body)).toEqual({
			identifiers: [{ set: "tla", collector_number: "193" }],
		});
	});

	it("asks for every language at once when the name has an accent or a non-Latin letter, even if English would have found something", async () => {
		serve({
			search: () => ({ status: 200, json: { data: [frenchHit, englishPrint], total_cards: 2 } }),
			collection: () => ({ status: 200, json: { data: [englishPrint], not_found: [] } }),
		});

		const result = await run(() => searchScryfall("", "", "", "Blâme de pierre", undefined, 1, "english-then-any"));

		expect(searchQueries()).toEqual(["Blâme de pierre lang:any"]);
		expect(result.searchedAnyLanguage).toBe(true);
		// the English print itself (lang "en") and the French copy of it are two different results
		// ... the English one first
		expect(result.cards.map((c) => `${c.id}:${c.lang}`)).toEqual(["en-id:en", "en-id:fr"]);
	});

	it("puts the English prints first in a search made in every language, keeping the order inside each group", async () => {
		const spanish = { ...frenchHit, id: "es-id", lang: "es", printed_name: "Reprimenda rocosa", collector_number: "194" };
		const englishOther = { ...englishPrint, id: "en-id-2", collector_number: "194" };
		serve({
			search: () => ({ status: 200, json: { data: [frenchHit, spanish, englishPrint, englishOther], total_cards: 4 } }),
			collection: (identifiers) => ({
				status: 200,
				json: { data: identifiers.map((i) => (i.collector_number === "194" ? englishOther : englishPrint)) },
			}),
		});
		const result = await run(() => searchScryfall("", "", "", "Blâme", undefined, 1, "any"));
		expect(result.cards.map((c) => `${c.id}:${c.lang}`)).toEqual(["en-id:en", "en-id-2:en", "en-id:fr", "en-id-2:es"]);
	});

	it("does not do that for an accented name in the default English mode, on a later page, or next to a lang: clause", async () => {
		serve({ search: () => ({ status: 404, json: {} }) });
		await run(() => searchScryfall("", "", "", "Blâme"));
		await run(() => searchScryfall("", "", "", "Blâme", undefined, 2, "english-then-any"));
		await run(() => searchScryfall("", "", "", "Blâme lang:fr", undefined, 1, "english-then-any"));
		expect(searchQueries()).toEqual(["Blâme", "Blâme", "Blâme lang:fr"]);
	});

	it("does not look further in the default English mode", async () => {
		serve({ search: () => ({ status: 404, json: {} }) });
		const result = await run(() => searchScryfall("", "", "", "Blâme de pierre"));
		expect(searchQueries()).toEqual(["Blâme de pierre"]);
		expect(result).toEqual({ cards: [], hasMore: false, totalCards: 0 });
	});

	it("does not look further when English already found cards, and says nothing about languages", async () => {
		serve({ search: () => ({ status: 200, json: { data: [englishPrint], total_cards: 1 } }) });
		const result = await run(() => searchScryfall("", "", "", "Rocky", undefined, 1, "english-then-any"));
		expect(searchQueries()).toEqual(["Rocky"]);
		expect(collectionCalls()).toHaveLength(0);
		expect(result).toEqual({ cards: [englishPrint], hasMore: false, totalCards: 1 });
	});

	it("does not widen a query that already names a language, nor one with no name in it", async () => {
		serve({ search: () => ({ status: 404, json: {} }) });
		await run(() => searchScryfall("", "", "", "Blâme lang:ja", undefined, 1, "english-then-any"));
		await run(() => searchScryfall("", "", "", "c:r t:elf", undefined, 1, "english-then-any"));
		expect(searchQueries()).toEqual(["Blâme lang:ja", "c:r t:elf"]);
	});

	it("does not retry in every language on a later page, and goes straight there in 'any' mode", async () => {
		serve({
			search: (q) => (q.endsWith("lang:any") ? { status: 200, json: { data: [frenchHit] } } : { status: 404, json: {} }),
			collection: () => ({ status: 200, json: { data: [englishPrint] } }),
		});
		await run(() => searchScryfall("", "", "", "Blâme", undefined, 2, "english-then-any"));
		expect(searchQueries()).toEqual(["Blâme"]);

		mockRequestUrl.mockClear();
		const next = await run(() => searchScryfall("", "", "", "Blâme", undefined, 2, "any"));
		expect(searchQueries()).toEqual(["Blâme lang:any"]);
		expect(next.searchedAnyLanguage).toBe(true);
		expect(next.cards[0].id).toBe("en-id");
	});

	it("folds the results of an explicit lang:fr search too (they used to be stored with the French print's id and no price)", async () => {
		serve({
			search: () => ({ status: 200, json: { data: [frenchHit], total_cards: 1 } }),
			collection: () => ({ status: 200, json: { data: [englishPrint] } }),
		});
		const result = await run(() => searchScryfall("", "", "", "Rocky lang:fr"));
		expect(searchQueries()).toEqual(["Rocky lang:fr"]);
		expect(result.searchedAnyLanguage).toBeUndefined();
		expect(result.cards[0]).toMatchObject({ id: "en-id", lang: "fr", prices: { usd: "0.20" } });
	});

	it("remembers a printing it has looked up, so a second search does not ask again", async () => {
		serve({
			search: () => ({ status: 200, json: { data: [frenchHit] } }),
			collection: () => ({ status: 200, json: { data: [englishPrint] } }),
		});
		await run(() => searchScryfall("", "", "", "Rocky lang:fr"));
		await run(() => searchScryfall("", "", "", "Blâme lang:fr"));
		expect(collectionCalls()).toHaveLength(1);
	});

	it("keeps the foreign hit when the lookup fails, without throwing, and asks again next time", async () => {
		serve({
			search: () => ({ status: 200, json: { data: [frenchHit] } }),
			collection: () => ({ status: 500, json: {} }),
		});
		const result = await run(() => searchScryfall("", "", "", "Rocky lang:fr"));
		expect(result.cards[0]).toBe(frenchHit);

		serve({
			search: () => ({ status: 200, json: { data: [frenchHit] } }),
			collection: () => ({ status: 200, json: { data: [englishPrint] } }),
		});
		const again = await run(() => searchScryfall("", "", "", "Rocky lang:fr"));
		expect(again.cards[0].id).toBe("en-id");
	});

	it("keeps the foreign hit when the request itself fails (offline)", async () => {
		serve({ search: () => ({ status: 200, json: { data: [frenchHit] } }) });
		mockRequestUrl.mockImplementation((async (params: { url: string }) => {
			if (params.url.includes("/cards/search")) return { status: 200, json: { data: [frenchHit] } };
			throw new Error("net::ERR_INTERNET_DISCONNECTED");
		}) as any);
		const result = await run(() => searchScryfall("", "", "", "Rocky lang:fr"));
		expect(result.cards[0]).toBe(frenchHit);
	});

	it("remembers a confirmed 'no such English printing' and keeps the hit", async () => {
		serve({
			search: () => ({ status: 200, json: { data: [frenchHit] } }),
			collection: () => ({ status: 200, json: { data: [], not_found: [{ set: "tla", collector_number: "193" }] } }),
		});
		const first = await run(() => searchScryfall("", "", "", "Rocky lang:fr"));
		const second = await run(() => searchScryfall("", "", "", "Rocky lang:fr"));
		expect(first.cards[0]).toBe(frenchHit);
		expect(second.cards[0]).toBe(frenchHit);
		expect(collectionCalls()).toHaveLength(1);
	});

	it("keeps a printing that exists in one foreign language only (the counterpart is not English)", async () => {
		const japaneseOnly = makeScryfallCard({
			id: "ja-id", set: "sta", collector_number: "111", lang: "ja", printed_name: "豊穣な収穫", prices: { usd: "2.74" },
		});
		serve({
			search: () => ({ status: 200, json: { data: [japaneseOnly] } }),
			collection: () => ({ status: 200, json: { data: [japaneseOnly] } }),
		});
		const result = await run(() => searchScryfall("", "", "", "豊穣 lang:ja"));
		expect(result.cards).toEqual([japaneseOnly]);
		expect(result.cards[0].prices?.usd).toBe("2.74");
	});

	it("asks for at most 75 printings per request", async () => {
		const hits = Array.from({ length: 80 }, (_, i) =>
			makeScryfallCard({ id: `fr-${i}`, set: "tla", collector_number: String(i + 1), lang: "fr", printed_name: `n${i}` })
		);
		serve({
			collection: (identifiers) => ({
				status: 200,
				json: {
					data: identifiers.map((id) =>
						makeScryfallCard({ id: `en-${id.collector_number}`, set: id.set, collector_number: id.collector_number, lang: "en" })
					),
				},
			}),
		});
		const resolved = await run(() => resolveEnglishPrints(hits));
		expect(collectionCalls().map((c) => JSON.parse((c[0] as any).body).identifiers.length)).toEqual([75, 5]);
		expect(resolved).toHaveLength(80);
		expect(resolved.every((c) => c.id.startsWith("en-") && c.lang === "fr")).toBe(true);
	});

	it("keeps one card per (card, language): the same French print twice collapses, French and German stay apart", async () => {
		const german = { ...frenchHit, id: "de-id", lang: "de", printed_name: "Felsiger Tadel" };
		serve({ collection: () => ({ status: 200, json: { data: [englishPrint] } }) });
		const resolved = await run(() => resolveEnglishPrints([frenchHit, { ...frenchHit }, german, englishPrint]));
		expect(resolved.map((c) => `${c.id}:${c.lang}`)).toEqual(["en-id:fr", "en-id:de", "en-id:en"]);
	});

	it("sends nothing when no hit is a foreign print", async () => {
		const resolved = await run(() => resolveEnglishPrints([englishPrint, makeScryfallCard({ id: "x" })]));
		expect(mockRequestUrl).not.toHaveBeenCalled();
		expect(resolved).toHaveLength(2);
	});
});

describe("fetchCardsByName", () => {
	it("asks for the names in ONE collection request and answers a map keyed by the lower-cased name asked for", async () => {
		mockRequestUrl.mockResolvedValueOnce({
			status: 200,
			json: { data: [makeScryfallCard({ id: "a", name: "Soul Burn" }), makeScryfallCard({ id: "b", name: "Scald" })], not_found: [{ name: "Nothing Here" }] },
		} as any);
		const map = await fetchCardsByName(["Soul Burn", "Scald", "Nothing Here", "Soul Burn", " "]);
		expect(mockRequestUrl).toHaveBeenCalledTimes(1);
		const req = mockRequestUrl.mock.calls[0][0] as any;
		expect(req.url).toBe("https://api.scryfall.com/cards/collection");
		expect(req.method).toBe("POST");
		expect(JSON.parse(req.body).identifiers).toEqual([{ name: "Soul Burn" }, { name: "Scald" }, { name: "Nothing Here" }]);
		expect(map.get("soul burn")?.id).toBe("a");
		expect(map.get("scald")?.id).toBe("b");
		expect(map.has("nothing here")).toBe(false);
	});

	it("finds a card asked for by one face of its double name", async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: { data: [makeScryfallCard({ id: "fi", name: "Fire // Ice" })] } } as any);
		const map = await fetchCardsByName(["Fire"]);
		expect(map.get("fire")?.id).toBe("fi");
	});

	it("sends nothing for no name, and answers an empty map for a refused or failed request instead of throwing", async () => {
		expect((await fetchCardsByName([])).size).toBe(0);
		expect((await fetchCardsByName(["", "  "])).size).toBe(0);
		expect(mockRequestUrl).not.toHaveBeenCalled();
		mockRequestUrl.mockResolvedValueOnce({ status: 500, json: {} } as any);
		expect((await fetchCardsByName(["Scald"])).size).toBe(0);
		mockRequestUrl.mockRejectedValueOnce(new Error("offline"));
		expect((await fetchCardsByName(["Scald"])).size).toBe(0);
	});
});

describe("fetchPrintingsOfNames", () => {
	it("asks for every printing of the names in ONE search, newest first, and answers the cards in Scryfall's order", async () => {
		mockRequestUrl.mockResolvedValueOnce({
			status: 200,
			json: { data: [makeScryfallCard({ id: "msc", set: "msc", collector_number: "807" }), makeScryfallCard({ id: "spm", set: "spm", collector_number: "82" })] },
		} as any);
		const cards = await fetchPrintingsOfNames(["Masked Meower"]);
		expect(cards.map((c) => c.id)).toEqual(["msc", "spm"]);
		expect(mockRequestUrl).toHaveBeenCalledTimes(1);
		const url = new URL((mockRequestUrl.mock.calls[0][0] as any).url);
		expect(url.pathname).toBe("/cards/search");
		expect(url.searchParams.get("q")).toBe('!"Masked Meower"');
		expect(url.searchParams.get("unique")).toBe("prints");
		expect(url.searchParams.get("order")).toBe("released");
		expect(url.searchParams.get("dir")).toBe("desc");
	});

	it("joins several names with `or`, once each, drops quotes and blanks, and asks for at most five", async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: { data: [] } } as any);
		await fetchPrintingsOfNames(["Fire // Ice", 'Say "Hi"', "Fire // Ice", " ", "A", "B", "C", "D"]);
		const q = new URL((mockRequestUrl.mock.calls[0][0] as any).url).searchParams.get("q");
		expect(q).toBe('(!"Fire // Ice" or !"Say Hi" or !"A" or !"B" or !"C")');
	});

	it("sends nothing for no name, and answers an empty list for a refused, failed or empty answer", async () => {
		expect(await fetchPrintingsOfNames([])).toEqual([]);
		expect(await fetchPrintingsOfNames(["", " "])).toEqual([]);
		expect(mockRequestUrl).not.toHaveBeenCalled();
		mockRequestUrl.mockResolvedValueOnce({ status: 404, json: { object: "error" } } as any);
		expect(await fetchPrintingsOfNames(["Nothing"])).toEqual([]);
		mockRequestUrl.mockRejectedValueOnce(new Error("offline"));
		expect(await fetchPrintingsOfNames(["Nothing"])).toEqual([]);
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: {} } as any);
		expect(await fetchPrintingsOfNames(["Nothing"])).toEqual([]);
	});
});

describe("fetchPrintingsOfIllustrations", () => {
	const A = "190b8aec-3286-4446-91a6-757dc2d7708d";
	const B = "e36db1dd-2e5b-473b-953b-d768c5c73588";
	const C = "fb2b1ca2-7440-48c2-81c8-84da0a45a626";
	const D = "2fcca987-364c-4738-a75b-099d8a26d614";

	it("asks for every paper printing of ONE illustration in one search, newest first, and answers Scryfall's order", async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: { data: [makeScryfallCard({ id: "30a", set: "30a" }), makeScryfallCard({ id: "lea", set: "lea" })] } } as any);
		const cards = await fetchPrintingsOfIllustrations([A]);
		expect(cards.map((c) => c.id)).toEqual(["30a", "lea"]);
		expect(mockRequestUrl).toHaveBeenCalledTimes(1);
		const url = new URL((mockRequestUrl.mock.calls[0][0] as any).url);
		expect(url.pathname).toBe("/cards/search");
		expect(url.searchParams.get("q")).toBe(`illustration_id:${A} game:paper`);
		expect(url.searchParams.get("unique")).toBe("prints");
		expect(url.searchParams.get("order")).toBe("released");
		expect(url.searchParams.get("dir")).toBe("desc");
	});

	it("joins several illustrations with `or`, once each, and asks for at most three", async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: { data: [] } } as any);
		await fetchPrintingsOfIllustrations([A, B, A, C, D]);
		expect(new URL((mockRequestUrl.mock.calls[0][0] as any).url).searchParams.get("q")).toBe(`(illustration_id:${A} or illustration_id:${B} or illustration_id:${C}) game:paper`);
	});

	it("sends nothing for an id that is not an id (it goes into a search query), and answers an empty list for a refused or failed request", async () => {
		expect(await fetchPrintingsOfIllustrations([])).toEqual([]);
		expect(await fetchPrintingsOfIllustrations(["", "x or name:a", `${A} or o:x`, A.toUpperCase()])).toEqual([]);
		expect(mockRequestUrl).not.toHaveBeenCalled();
		mockRequestUrl.mockResolvedValueOnce({ status: 404, json: { object: "error" } } as any);
		expect(await fetchPrintingsOfIllustrations([A])).toEqual([]);
		mockRequestUrl.mockRejectedValueOnce(new Error("offline"));
		expect(await fetchPrintingsOfIllustrations([A])).toEqual([]);
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: {} } as any);
		expect(await fetchPrintingsOfIllustrations([A])).toEqual([]);
	});
});

describe("fetchPrintingBySetAndNumber", () => {
	it("asks for the printing by its set code (lower case) and collector number, and answers the card", async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: makeScryfallCard({ id: "spm82", set: "spm", collector_number: "82" }) } as any);
		const card = await fetchPrintingBySetAndNumber("SPM", "82");
		expect(card?.id).toBe("spm82");
		expect((mockRequestUrl.mock.calls[0][0] as any).url).toBe("https://api.scryfall.com/cards/spm/82");
	});
	it("answers null for an unknown printing, a failed request, and a set or number that cannot be one, without asking", async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 404, json: { object: "error" } } as any);
		expect(await fetchPrintingBySetAndNumber("spm", "9999")).toBeNull();
		mockRequestUrl.mockRejectedValueOnce(new Error("offline"));
		expect(await fetchPrintingBySetAndNumber("spm", "82")).toBeNull();
		mockRequestUrl.mockClear();
		expect(await fetchPrintingBySetAndNumber("s", "82")).toBeNull();
		expect(await fetchPrintingBySetAndNumber("spm/../x", "82")).toBeNull();
		expect(await fetchPrintingBySetAndNumber("spm", "../1")).toBeNull();
		expect(await fetchPrintingBySetAndNumber("spm", "")).toBeNull();
		expect(mockRequestUrl).not.toHaveBeenCalled();
	});
});

describe("fetchSetCardNames", () => {
	// The strict endpoints are spaced 550 ms apart: run on a fake clock.
	async function run<T>(start: () => Promise<T>): Promise<T> {
		vi.useFakeTimers();
		try {
			resetScryfallStrictGateForTests();
			const pending = start();
			await vi.advanceTimersByTimeAsync(20_000);
			return await pending;
		} finally {
			vi.useRealTimers();
			resetScryfallStrictGateForTests();
		}
	}
	const page = (names: string[], hasMore = false) => ({ status: 200, json: { data: names.map((name) => ({ name })), has_more: hasMore } }) as any;
	const urls = () => mockRequestUrl.mock.calls.map((c) => new URL((c[0] as any).url));

	beforeEach(() => {
		resetSetNamesCacheForTests();
	});

	it("asks for the cards of the set, one of each, in set order, and answers their names", async () => {
		mockRequestUrl.mockResolvedValueOnce(page(["Shock", "Swamp", "Shock"]));
		expect(await run(() => fetchSetCardNames("SPM"))).toEqual(["Shock", "Swamp"]);
		expect(mockRequestUrl).toHaveBeenCalledTimes(1);
		const url = urls()[0];
		expect(url.pathname).toBe("/cards/search");
		expect(url.searchParams.get("q")).toBe("e:spm");
		expect(url.searchParams.get("unique")).toBe("cards");
		expect(url.searchParams.get("order")).toBe("set");
		expect(url.searchParams.get("page")).toBe("1");
	});

	it("reads the next page while Scryfall says there is more, asking by page number (never a URL the answer hands out)", async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: { data: [{ name: "A" }], has_more: true, next_page: "https://evil.example/x" } } as any);
		mockRequestUrl.mockResolvedValueOnce(page(["B", "A"]));
		expect(await run(() => fetchSetCardNames("hob"))).toEqual(["A", "B"]);
		expect(urls().map((u) => [u.host, u.searchParams.get("page")])).toEqual([
			["api.scryfall.com", "1"],
			["api.scryfall.com", "2"],
		]);
	});

	it("keeps the answer for the session, and two scans asking at once share one request", async () => {
		mockRequestUrl.mockResolvedValue(page(["Shock"]));
		const [a, b] = await run(() => Promise.all([fetchSetCardNames("spm"), fetchSetCardNames("spm")]));
		expect(a).toEqual(["Shock"]);
		expect(b).toEqual(["Shock"]);
		expect(await fetchSetCardNames("spm")).toEqual(["Shock"]);
		expect(mockRequestUrl).toHaveBeenCalledTimes(1);
	});

	it("says null for a code that is not a set, and remembers it (a 404 is a settled answer)", async () => {
		mockRequestUrl.mockResolvedValue({ status: 404, json: { object: "error" } } as any);
		expect(await run(() => fetchSetCardNames("mhob"))).toBeNull();
		expect(await fetchSetCardNames("mhob")).toBeNull();
		expect(mockRequestUrl).toHaveBeenCalledTimes(1);
	});

	it("says null for a failed request, a refusal or a body that is not JSON, and asks again next time (a failure is not an answer)", async () => {
		mockRequestUrl.mockRejectedValueOnce(new Error("offline"));
		expect(await run(() => fetchSetCardNames("spm"))).toBeNull();
		mockRequestUrl.mockResolvedValueOnce({ status: 500, json: {} } as any);
		expect(await run(() => fetchSetCardNames("spm"))).toBeNull();
		mockRequestUrl.mockResolvedValueOnce({
			status: 200,
			get json(): never {
				throw new SyntaxError("Unexpected token <");
			},
		} as any);
		expect(await run(() => fetchSetCardNames("spm"))).toBeNull();
		expect(mockRequestUrl).toHaveBeenCalledTimes(3);
		mockRequestUrl.mockResolvedValueOnce(page(["Shock"]));
		expect(await run(() => fetchSetCardNames("spm"))).toEqual(["Shock"]);
	});

	it("does not list a set of more pages than SET_NAMES_MAX_PAGES, and remembers that", async () => {
		mockRequestUrl.mockResolvedValue(page(["Card"], true));
		expect(await run(() => fetchSetCardNames("sld"))).toBeNull();
		expect(mockRequestUrl).toHaveBeenCalledTimes(SET_NAMES_MAX_PAGES);
		expect(await fetchSetCardNames("sld")).toBeNull();
		expect(mockRequestUrl).toHaveBeenCalledTimes(SET_NAMES_MAX_PAGES);
	});

	it("sends nothing for a code that cannot be a set", async () => {
		for (const code of ["", "sp", "spm/../x", "toolongcode", "s p", "spm\n"]) expect(await fetchSetCardNames(code)).toBeNull();
		expect(mockRequestUrl).not.toHaveBeenCalled();
	});

	it("says null for a set with no card", async () => {
		mockRequestUrl.mockResolvedValue(page([]));
		expect(await run(() => fetchSetCardNames("zzz"))).toBeNull();
	});
});
