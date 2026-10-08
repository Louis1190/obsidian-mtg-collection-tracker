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
	chunk,
	applySvgColor,
	dedupeSetsByIcon,
	getSetGroupLabel,
	SET_GROUP_ORDER,
	ScryfallSetSummary,
	searchScryfall,
	fetchLatestPaperPrintings,
	searchAllPrintings,
	fetchScryfallCollection,
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
