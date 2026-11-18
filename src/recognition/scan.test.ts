import { describe, expect, it } from "vitest";
import { cardCorners, scene } from "./__tests__/scenes";
import { catalogueIndex, parseCatalogue, shortNameIndex } from "./catalogue";
import { buildNameIndex } from "./name-match";
import { downscaleRgba, findCornerCard, languageOfCard, PRINTED_WINDOWS, PRINTED_WINDOWS_OUTER, scanPhoto, SET_SCOPE_START_READS, type OcrReader, type Photo, type SetScope } from "./scan";
import { encodeBmp, extractStrip, stripVariant, toChannel, toGray } from "./strips";
import { CONFIRM_CONFIG, readingPlan, type ReadLine } from "./reading";

const ROWS = parseCatalogue(["Soul Burn\tBrûlure des âmes", "Goblin Spy\tEspion gobelin", "Rough Rhino Cavalry\tCavalerie des Rhinos féroces"].join("\n"));
const index = catalogueIndex(ROWS, ["fr"]);
const title = (text: string): ReadLine[] => [{ text, y0: 100, y1: 170 }];

// a 720 x 960 photo (the finder works on a 360 px wide copy of it): a dark-bordered card on a lighter table
const W = 720;
const H = 960;
const withCard = (): Photo => ({ rgba: scene({ w: W, h: H, bg: 190, border: 25, frame: 150, corners: cardCorners(360, 480, 420, 588, 0), borderWidth: 24 }), w: W, h: H });
/** The card with a band of pure red across its top (where the title strips are cut): the luminance of it is low (76) while its red channel is full and its blue one empty, so a strip cut from a channel is NOT the strip cut from the luminance. The finder still sees the same card. */
const withColouredTitle = (): Photo => {
	const photo = withCard();
	for (let y = 195; y < 262; y++) for (let x = 165; x < 555; x++) (photo.rgba as Uint8ClampedArray).set([255, 0, 0, 255], (y * W + x) * 4);
	return photo;
};
const empty = (): Photo => ({ rgba: new Uint8ClampedArray(W * H * 4).fill(180), w: W, h: H });

/**
 * An engine that answers `lines(call)` for the n-th TITLE reading (1-based: strips and tall reads, psm 7 and 11) and records what it was given. The corner of the card
 * (psm 6, read FIRST) answers nothing here: `calls` has every reading, `titles` only the title's.
 */
function fakeEngine(lines: (call: number) => ReadLine[]) {
	const calls: { bmp: Uint8Array; psm: number }[] = [];
	const titles: { bmp: Uint8Array; psm: number }[] = [];
	const reader: OcrReader = {
		recognize: async (bmp, psm) => {
			calls.push({ bmp, psm });
			if (psm === 6) return [];
			titles.push({ bmp, psm });
			return lines(titles.length);
		},
	};
	return { reader, calls, titles };
}

describe("downscaleRgba", () => {
	it("averages the pixels each new pixel covers", () => {
		// a 4 x 4 picture whose 2 x 2 blocks are 0, 100, 200, 40 (red channel): the 2 x 2 result is those values
		const rgba = new Uint8ClampedArray(4 * 4 * 4);
		const block = [0, 100, 200, 40];
		for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) rgba[(y * 4 + x) * 4] = block[(y >> 1) * 2 + (x >> 1)];
		const d = downscaleRgba({ rgba, w: 4, h: 4 }, 2);
		expect([d.w, d.h]).toEqual([2, 2]);
		expect([d.rgba[0], d.rgba[4], d.rgba[8], d.rgba[12]]).toEqual(block);
		const mixed = new Uint8ClampedArray([0, 0, 0, 255, 100, 0, 0, 255]);
		expect(downscaleRgba({ rgba: mixed, w: 2, h: 1 }, 1).rgba[0]).toBe(50);
	});
	it("hands back a picture that is already small enough", () => {
		const p = { rgba: new Uint8ClampedArray(16), w: 2, h: 2 };
		expect(downscaleRgba(p, 360)).toBe(p);
	});
	it("keeps the aspect ratio", () => {
		const d = downscaleRgba({ rgba: new Uint8ClampedArray(720 * 960 * 4), w: 720, h: 960 }, 360);
		expect([d.w, d.h]).toEqual([360, 480]);
	});
});

describe("scanPhoto", () => {
	it("says there is no card on a flat picture, without reading anything", async () => {
		const e = fakeEngine(() => title("Soul Burn"));
		const r = await scanPhoto(empty(), e.reader, index);
		expect(r.stoppedBy).toBe("no-card");
		expect(r.quad).toBeNull();
		expect(e.calls).toHaveLength(0);
	});

	it("hands the card the finder found to onQuad once, in the photo's pixels, before anything is read; and nothing when there is no card", async () => {
		const e = fakeEngine(() => title("Soul Burn"));
		const seen: { quad: unknown; readsBefore: number }[] = [];
		const r = await scanPhoto(withCard(), e.reader, index, { onQuad: (quad) => seen.push({ quad, readsBefore: e.calls.length }) });
		expect(seen).toHaveLength(1);
		expect(seen[0].readsBefore).toBe(0); // the outline is drawn before the corner or the title is read
		expect(seen[0].quad).toEqual(r.quad);
		const corners = seen[0].quad as [number, number][];
		// the photo is 720 x 960 and the card was drawn 420 wide around (360, 480): the corners are in those pixels, not in the finder's 360 px copy
		expect(Math.min(...corners.map((c) => c[0]))).toBeGreaterThan(100);
		expect(Math.max(...corners.map((c) => c[0]))).toBeGreaterThan(500);
		const none: unknown[] = [];
		await scanPhoto(empty(), e.reader, index, { onQuad: (q) => none.push(q) });
		expect(none).toEqual([]);
	});

	it("reads strips until a card is sure, and finds the card the engine read", async () => {
		const e = fakeEngine((call) => (call >= 2 ? title("Brulure des ames") : []));
		const progress: number[] = [];
		const r = await scanPhoto(withCard(), e.reader, index, { onProgress: (p) => progress.push(p.reads) });
		expect(r.stoppedBy).toBe("sure");
		expect(r.decision?.owner).toBe(0);
		expect(r.reads).toBe(3); // the title on readings 2 and 3: two readings agree
		expect(progress).toEqual([1, 2, 3]);
		expect(r.proposals[0].owner).toBe(0);
		expect(r.quad).not.toBeNull();
		// the quad is in the pixels of the photo given, not of the small copy: the card is 420 px wide
		const q = r.quad!;
		expect(Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1])).toBeGreaterThan(380);
	});

	it("hands the engine uncompressed BMP strips, the tall one first as sparse text, then the title strip as a line", async () => {
		const e = fakeEngine(() => []);
		await scanPhoto(withCard(), e.reader, index, { maxReads: 12 });
		expect(e.calls[0].psm).toBe(6); // the corner is read first
		const first = e.titles[0];
		expect(String.fromCharCode(first.bmp[0], first.bmp[1])).toBe("BM");
		expect(new DataView(first.bmp.buffer, first.bmp.byteOffset).getInt32(18, true)).toBe(1100);
		expect(e.titles.slice(0, 10).every((c) => c.psm === 11)).toBe(true);
		expect(e.titles[10].psm).toBe(7);
		// the five variants of one strip differ
		expect(new Set(e.titles.slice(0, 5).map((c) => Array.from(c.bmp.slice(1100, 1140)).join(","))).size).toBeGreaterThan(1);
	});

	it("runs the whole plan when nothing is read, and proposes nothing", async () => {
		const e = fakeEngine(() => []);
		const r = await scanPhoto(withCard(), e.reader, index);
		expect(r.stoppedBy).toBe("plan");
		expect(r.reads).toBe(readingPlan().length);
		expect(r.reads).toBe(160);
		expect(r.decision).toBeNull();
		expect(r.proposals).toEqual([]);
		// 2.2 s alone, 5.7 s while the whole suite runs on a loaded machine: the default 5 s limit left no margin (a CI runner can be slower still)
	}, 60_000);

	describe("the short names", () => {
		// 0 Soul Burn, 1 Swamp, 2 Fog, 3 Serra, 4 Serra Angel
		const ROWS_S = parseCatalogue(["Soul Burn\tBrûlure des âmes", "Swamp\tMarais", "Fog\t", "Serra\t", "Serra Angel\t"].join("\n"));
		const wholeIndex = catalogueIndex(ROWS_S, ["fr"]);
		const shortIndex = shortNameIndex(ROWS_S, ["fr"]);

		it("finds a name the whole-catalogue reader refuses, once three readings say it, and says how", async () => {
			const e = fakeEngine(() => title("Swamp"));
			const r = await scanPhoto(withCard(), e.reader, wholeIndex, { shortIndex });
			expect(r.stoppedBy).toBe("sure");
			expect(r.shortcut).toBe("short-name");
			expect(r.decision).toMatchObject({ owner: 1, sure: true });
			expect(r.reads).toBe(3);
			expect(r.proposals[0].owner).toBe(1);
			// the same readings without the index: nothing is ever decided (the name is 5 letters)
			const e2 = fakeEngine(() => title("Swamp"));
			const none = await scanPhoto(withCard(), e2.reader, wholeIndex, { maxReads: 20 });
			expect(none.decision).toBeNull();
			expect(none.proposals).toEqual([]);
		});

		it("reads a name of three letters followed by its mana cost", async () => {
			const e = fakeEngine(() => title("Fog G"));
			const r = await scanPhoto(withCard(), e.reader, wholeIndex, { shortIndex });
			expect(r.shortcut).toBe("short-name");
			expect(r.decision?.owner).toBe(2);
		});

		it("does not decide on two readings, and proposes nothing it has not decided (a lone exact short word in noise is often wrong)", async () => {
			const e = fakeEngine((call) => (call <= 2 ? title("Swamp") : []));
			const r = await scanPhoto(withCard(), e.reader, wholeIndex, { shortIndex, maxReads: 20 });
			expect(r.stoppedBy).toBe("budget");
			expect(r.decision).toBeNull();
			expect(r.proposals).toEqual([]);
		});

		it("leaves the corner's, the set's and the catalogue's decisions first: a long name decided at the same time wins", async () => {
			// Soul Burn is read twice (decided at the 2nd reading), Swamp on every reading: the long card is decided first
			const e = fakeEngine(() => [...title("Soul Burn"), ...title("Swamp")]);
			const r = await scanPhoto(withCard(), e.reader, wholeIndex, { shortIndex });
			expect(r.shortcut).toBeNull();
			expect(r.decision?.owner).toBe(0);
			expect(r.reads).toBe(2);
		});

		it("does not take the short name that starts a longer title the whole-catalogue reader has evidence for: 'Serra' inside 'Serra Angel'", async () => {
			// the long title read once (evidence, no decision yet), "Serra" alone on three readings
			const e = fakeEngine((call) => (call === 1 ? [...title("Serra"), ...title("Serra Angel")] : title("Serra")));
			const r = await scanPhoto(withCard(), e.reader, wholeIndex, { shortIndex, maxReads: 8 });
			expect(r.shortcut).toBeNull();
			expect(r.stoppedBy).toBe("budget");
			expect(r.decision?.owner).not.toBe(3);
			// and with no reading of the long title, the same three readings do decide the short card
			const e2 = fakeEngine(() => title("Serra"));
			const alone = await scanPhoto(withCard(), e2.reader, wholeIndex, { shortIndex, maxReads: 8 });
			expect(alone.shortcut).toBe("short-name");
			expect(alone.decision?.owner).toBe(3);
		});

		it("is explained away only by a longer name that CONTAINS it: another card's evidence does not hold it back", async () => {
			// "Soul Burn" read once (evidence 1, undecided) and "Swamp" on three readings: Swamp is not a part of Soul Burn
			const e = fakeEngine((call) => (call === 1 ? [...title("Swamp"), ...title("Soul Burn")] : title("Swamp")));
			const r = await scanPhoto(withCard(), e.reader, wholeIndex, { shortIndex, maxReads: 8 });
			expect(r.shortcut).toBe("short-name");
			expect(r.decision?.owner).toBe(1);
		});

		it("is not held back by the same card's own longer name: 'Fog' is the French name of Fog Bank", async () => {
			const rows = parseCatalogue(["Soul Burn\t", "Fog Bank\tFog"].join("\n"));
			const e = fakeEngine((call) => (call === 1 ? [...title("Fog"), ...title("Fog Bank")] : title("Fog")));
			const r = await scanPhoto(withCard(), e.reader, catalogueIndex(rows, ["fr"]), { shortIndex: shortNameIndex(rows, ["fr"]), maxReads: 8 });
			expect(r.shortcut).toBe("short-name");
			expect(r.decision?.owner).toBe(1);
		});

		it("is held back only by a longer name with some evidence, not by a passing guess at it", async () => {
			const rows = parseCatalogue(["Soul Burn\t", "Serra\t", "Serra Disciple\t"].join("\n"));
			// "Serra Disciple" read once as "sera disciplxx" (three edits: score 0.79, evidence 0.24, under the 0.3 it takes to explain a short name away), "Serra" on three readings
			const e = fakeEngine((call) => (call === 1 ? [...title("Serra"), ...title("Sera Disciplxx")] : title("Serra")));
			const r = await scanPhoto(withCard(), e.reader, catalogueIndex(rows, ["fr"]), { shortIndex: shortNameIndex(rows, ["fr"]), maxReads: 8 });
			expect(r.shortcut).toBe("short-name");
			expect(r.decision?.owner).toBe(1);
		});

		it("waits for the corner's confirmation window when the corner named a card, then may decide", async () => {
			const soulBurn = { owner: 0, names: ["Soul Burn"] };
			const corner: ReadLine[] = [
				{ text: "R 0082", y0: 0, y1: 40 },
				{ text: "SPM * FR", y0: 50, y1: 90 },
			];
			const e = fakeEngine(() => title("Swamp")); // the corner is readable; the title is never the card it named
			const reader: OcrReader = { recognize: (bmp, psm) => (psm === 6 ? Promise.resolve(corner) : e.reader.recognize(bmp, psm)) };
			const r = await scanPhoto(withCard(), reader, wholeIndex, { shortIndex, shortcut: async () => soulBurn, maxReads: 30 });
			expect(r.shortcut).toBe("short-name");
			expect(r.decision?.owner).toBe(1);
			expect(r.reads).toBe(CONFIRM_CONFIG.steps + 1);
		});

		it("is not used without the index", async () => {
			const e = fakeEngine(() => title("Swamp"));
			const r = await scanPhoto(withCard(), e.reader, wholeIndex, { maxReads: 12 });
			expect(r.shortcut).toBeNull();
			expect(r.decision).toBeNull();
		});
	});

	describe("the time cap", () => {
		/** A clock that moves `step` ms each time it is read, so a test says how long a reading "takes". */
		const clock = (step: number) => {
			let t = 0;
			return () => (t += step);
		};

		it("stops reading once the time given has passed, answers what the readings so far propose, and says why", async () => {
			const e = fakeEngine((call) => (call <= 3 ? title("Pin") : [])); // a few weak readings of a wrong word, then nothing
			const r = await scanPhoto(withCard(), e.reader, index, { maxMs: 6500, now: clock(1000) });
			expect(r.stoppedBy).toBe("time");
			// the clock is read once at the start, then before every reading and after it (progress): the limit is reached part way through, long before the 160 readings
			expect(r.reads).toBeGreaterThan(0);
			expect(r.reads).toBeLessThan(10);
			expect(e.titles).toHaveLength(r.reads);
		});

		it("keeps the cards the readings had evidence for when the time runs out: the best guess, with a decision only if the evidence is the plan's end rule", async () => {
			// "Soul Burn" read twice, perfectly (evidence 2), then nothing: the time runs out with a card to propose
			const e = fakeEngine((call) => (call <= 2 ? title("Soul Burn") : []));
			const sureFirst = await scanPhoto(withCard(), e.reader, index, { maxMs: 1e9, now: clock(1) });
			expect(sureFirst.stoppedBy).toBe("sure"); // a card read twice is decided before any cap matters
			const e2 = fakeEngine((call) => (call === 1 ? title("Soul Burn") : []));
			const r = await scanPhoto(withCard(), e2.reader, index, { maxMs: 6000, now: clock(1000) });
			expect(r.stoppedBy).toBe("time");
			expect(r.proposals.map((p) => p.owner)).toEqual([0]);
			expect(r.decision).toMatchObject({ owner: 0, sure: false }); // one perfect reading is evidence 1: what the plan's end would also accept
		});

		it("answers nothing, and no card, when nothing was read by the time it runs out", async () => {
			const e = fakeEngine(() => []);
			const r = await scanPhoto(withCard(), e.reader, index, { maxMs: 6000, now: clock(1000) });
			expect(r.stoppedBy).toBe("time");
			expect(r.decision).toBeNull();
			expect(r.proposals).toEqual([]);
		});

		it("counts from the start of the scan, the corner included: a corner that takes the whole time leaves no title reading", async () => {
			let t = 0;
			const reader: OcrReader = {
				recognize: async (_bmp, psm) => {
					if (psm === 6) t += 10000; // each of the corner's readings takes ten seconds
					return psm === 6 ? [] : title("Soul Burn");
				},
			};
			const r = await scanPhoto(withCard(), reader, index, { maxMs: 15000, now: () => t });
			expect(r.stoppedBy).toBe("time");
			expect(r.reads).toBe(0);
		});

		it("does not stop a scan that has no limit, nor one that finishes inside it", async () => {
			const e = fakeEngine(() => []);
			const free = await scanPhoto(withCard(), e.reader, index, { now: clock(1e6) }); // a clock that races, and no maxMs
			expect(free.stoppedBy).toBe("plan");
			expect(free.reads).toBe(160);
			const e2 = fakeEngine((call) => (call >= 2 ? title("Brulure des ames") : []));
			const quick = await scanPhoto(withCard(), e2.reader, index, { maxMs: 60000, now: clock(10) });
			expect(quick.stoppedBy).toBe("sure");
		});

		it("lets the reading in progress finish: the limit is looked at before a reading, never inside one", async () => {
			const t0 = { t: 0 };
			const reader: OcrReader = {
				recognize: async (_bmp, psm) => {
					if (psm !== 6) t0.t += 5000; // a title reading takes five seconds
					return [];
				},
			};
			const r = await scanPhoto(withCard(), reader, index, { maxMs: 12000, now: () => t0.t });
			expect(r.stoppedBy).toBe("time");
			expect(r.reads).toBe(3); // 0 s, 5 s, 10 s start a reading; at 15 s the limit is over
			t0.t = 0;
			const exact = await scanPhoto(withCard(), reader, index, { maxMs: 10000, now: () => t0.t });
			expect(exact.reads).toBe(2); // the limit is reached AT 10 s: no third reading
		});

		it("reports the time spent and the limit with every reading, for the bar", async () => {
			const e = fakeEngine(() => []);
			const seen: { elapsedMs: number; limitMs?: number }[] = [];
			await scanPhoto(withCard(), e.reader, index, { maxMs: 4500, now: clock(1000), onProgress: (p) => seen.push({ elapsedMs: p.elapsedMs, limitMs: p.limitMs }) });
			expect(seen.length).toBeGreaterThan(0);
			expect(seen.every((p) => p.limitMs === 4500)).toBe(true);
			expect(seen.map((p) => p.elapsedMs)).toEqual([...seen.map((p) => p.elapsedMs)].sort((a, b) => a - b));
		});
	});

	it("stops at the reading budget it is given", async () => {
		const e = fakeEngine(() => []);
		const r = await scanPhoto(withCard(), e.reader, index, { maxReads: 5 });
		expect(r.stoppedBy).toBe("budget");
		expect(r.reads).toBe(5);
		expect(e.calls.filter((c) => c.psm !== 6)).toHaveLength(5); // the corner of the card is read besides (psm 6), whatever the budget of the title
	});

	it("stops when the person cancels", async () => {
		const ctl = new AbortController();
		const e = fakeEngine((call) => {
			if (call === 2) ctl.abort();
			return [];
		});
		const r = await scanPhoto(withCard(), e.reader, index, { signal: ctl.signal });
		expect(r.stoppedBy).toBe("cancelled");
		expect(r.reads).toBe(2);
	});

	it("proposes the best card with its evidence when the plan runs out without a lead", async () => {
		// two cards read twice each: the stop rule needs a lead, so the plan runs out and the best is proposed as not sure
		const e = fakeEngine((call) => (call <= 4 ? [...title("Brulure des ames"), ...title("Goblin Spy")] : []));
		const r = await scanPhoto(withCard(), e.reader, index);
		expect(r.stoppedBy).toBe("plan");
		expect(r.decision?.sure).toBe(false);
		expect(r.proposals.map((p) => p.owner).sort()).toEqual([0, 1]);
	});
});

describe("scanPhoto: the edition printed in the corner", () => {
	const ENGLISH = "Soul Burn";
	/** The title for strips and tall reads (psm 7 / 11), `corner(call)` for the printed corner (psm 6, 1-based among those calls). */
	function twoEngines(corner: (call: number) => ReadLine[] | "throw") {
		let cornerCalls = 0;
		const sizes: number[] = [];
		const e = fakeEngine(() => title(ENGLISH));
		const reader: OcrReader = {
			recognize: async (bmp, psm) => {
				if (psm !== 6) return e.reader.recognize(bmp, psm);
				cornerCalls++;
				sizes.push(Math.abs(new DataView(bmp.buffer, bmp.byteOffset).getInt32(22, true)));
				const answer = corner(cornerCalls);
				if (answer === "throw") throw new Error("engine fell over");
				return answer;
			},
		};
		return { reader, cornerCalls: () => cornerCalls, sizes };
	}
	const lines = (...texts: string[]): ReadLine[] => texts.map((text, i) => ({ text, y0: i * 50, y1: i * 50 + 40 }));

	it("reads the corner once the title is sure, with two variants of the first window, and parses number, set and language", async () => {
		const t = twoEngines(() => lines("C 0082", "SPM * FR NARENDRA"));
		const r = await scanPhoto(withCard(), t.reader, index);
		expect(r.stoppedBy).toBe("sure");
		expect(r.printed).toEqual({ number: "82", set: "spm", lang: "fr", rarity: "C" });
		expect(t.cornerCalls()).toBe(2); // both variants agree on the number: the second window is not needed
		expect(t.sizes).toEqual([435, 435]); // a 1100 px wide window of 0.30 x 0.085 of the card
	});

	it("tries the second window when the first gives no number the two variants agree on", async () => {
		const t = twoEngines((call) => (call <= 2 ? lines("garbage", "noise") : lines("C 0047", "SPM + FR")));
		const r = await scanPhoto(withCard(), t.reader, index);
		expect(t.cornerCalls()).toBe(4);
		expect(r.printed?.number).toBe("47");
		expect(PRINTED_WINDOWS).toHaveLength(2);
	});

	it("combines the reads: one variant that slips a digit does not decide against the other three", async () => {
		const t = twoEngines((call) => (call === 1 ? lines("C 0086", "SPM * FR") : lines("C 0088", "SPM * FR")));
		const r = await scanPhoto(withCard(), t.reader, index);
		expect(t.cornerCalls()).toBe(4); // the first two disagreed
		expect(r.printed?.number).toBe("88");
	});

	it("cuts the first corner window inside the quad's bottom when the quad is the card's own edge, and below it when it is the frame inside the border", async () => {
		// a dark border on a lighter table: the finder answers the card's own edge (polarity "out"); a white border on a dark table: the frame inside it ("in")
		const firstCornerStrip = async (photo: Photo): Promise<{ bmp: Uint8Array; quad: NonNullable<Awaited<ReturnType<typeof scanPhoto>>["quad"]>; polarity: string | undefined }> => {
			const bmps: Uint8Array[] = [];
			const reader: OcrReader = {
				recognize: async (bmp, psm) => {
					if (psm === 6) bmps.push(bmp);
					return psm === 6 ? [] : title(ENGLISH);
				},
			};
			const r = await scanPhoto(photo, reader, index);
			return { bmp: bmps[0], quad: r.quad!, polarity: r.finder?.polarity };
		};
		const bmpOf = (photo: Photo, quad: NonNullable<Awaited<ReturnType<typeof scanPhoto>>["quad"]>, win: { x0: number; x1: number; y0: number; y1: number }): Uint8Array =>
			encodeBmp(stripVariant(extractStrip(toGray(photo.rgba, photo.w, photo.h), quad, { ...win, outW: 1100, roll: 0 }), "asis"));
		// a boolean, not toEqual: a failing diff of two 400 KB pictures never finishes
		const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
		const own = await firstCornerStrip(withCard());
		expect(own.polarity).toBe("out");
		expect(sameBytes(own.bmp, bmpOf(withCard(), own.quad, PRINTED_WINDOWS_OUTER[0]))).toBe(true);
		const whiteBorder: Photo = { rgba: scene({ w: W, h: H, bg: 35, border: 235, frame: 120, corners: cardCorners(360, 480, 420, 588, 0), borderWidth: 24 }), w: W, h: H };
		const frame = await firstCornerStrip(whiteBorder);
		expect(frame.polarity).toBe("in");
		expect(sameBytes(frame.bmp, bmpOf(whiteBorder, frame.quad, PRINTED_WINDOWS[0]))).toBe(true);
	});

	it("answers no printed info when nothing in the corner can be read, and keeps the proposals", async () => {
		const t = twoEngines(() => []);
		const r = await scanPhoto(withCard(), t.reader, index);
		expect(r.printed).toBeNull();
		expect(r.proposals[0].owner).toBe(0);
	});

	it("keeps the title result when reading the corner fails", async () => {
		const t = twoEngines(() => "throw");
		const r = await scanPhoto(withCard(), t.reader, index);
		expect(r.printed).toBeNull();
		expect(r.stoppedBy).toBe("sure");
		expect(r.decision?.owner).toBe(0);
	});

	it("reads the corner even when no title was read (a token, a name the reader cannot take), and proposes nothing from the title", async () => {
		const corner = twoEngines(() => lines("0003", "TSPM * FR"));
		const noTitle = fakeEngine(() => []);
		const reader: OcrReader = { recognize: (bmp, psm) => (psm === 6 ? corner.reader.recognize(bmp, psm) : noTitle.reader.recognize(bmp, psm)) };
		const r = await scanPhoto(withCard(), reader, index);
		expect(r.proposals).toEqual([]);
		expect(corner.cornerCalls()).toBe(2);
		expect(r.printed).toEqual({ number: "3", set: "tspm", lang: "fr", rarity: null });
	});

	it("reads the corner BEFORE the title, so a cancelled title reading still has it", async () => {
		const ctl = new AbortController();
		const t = twoEngines(() => lines("C 0082", "SPM * FR"));
		const wrapped: OcrReader = {
			recognize: async (bmp, psm) => {
				const out = await t.reader.recognize(bmp, psm);
				if (psm !== 6) ctl.abort();
				return out;
			},
		};
		const c = await scanPhoto(withCard(), wrapped, index, { signal: ctl.signal });
		expect(c.stoppedBy).toBe("cancelled");
		expect(t.cornerCalls()).toBe(2);
		expect(c.printed).toEqual({ number: "82", set: "spm", lang: "fr", rarity: "C" });
	});

	it("reads the wide window when the first gave a set code under three letters, and keeps the whole code", async () => {
		const t = twoEngines((call) => (call <= 2 ? lines("C 0082", "PM * FR") : lines("0082", "SPM * FR")));
		const r = await scanPhoto(withCard(), t.reader, index);
		expect(t.cornerCalls()).toBe(4);
		expect(t.sizes).toEqual([435, 435, 363, 363]); // the wide window is 0.36 of the card wide, not 0.30
		expect(r.printed).toEqual({ number: "82", set: "spm", lang: "fr", rarity: "C" });
	});

	it("does not read the wide window when the set code came out whole", async () => {
		const t = twoEngines(() => lines("C 0082", "SPM * FR"));
		await scanPhoto(withCard(), t.reader, index);
		expect(t.sizes).toEqual([435, 435]);
	});

	it("stops reading the corner as soon as the person cancels, keeping what the reads so far gave, and reads no title", async () => {
		const ctl = new AbortController();
		const titleReads: number[] = [];
		const t = twoEngines((call) => {
			if (call === 1) ctl.abort();
			return lines("C 0082", "SPM * FR");
		});
		const counting: OcrReader = { recognize: (bmp, psm) => (psm !== 6 ? (titleReads.push(1), t.reader.recognize(bmp, psm)) : t.reader.recognize(bmp, psm)) };
		const r = await scanPhoto(withCard(), counting, index, { signal: ctl.signal });
		expect(r.stoppedBy).toBe("cancelled");
		expect(t.cornerCalls()).toBe(1);
		expect(titleReads).toEqual([]);
		expect(r.printed).toEqual({ number: "82", set: "spm", lang: "fr", rarity: "C" });
	});

	it("does not read the corner of a photo with no card", async () => {
		const t = twoEngines(() => lines("C 0082", "SPM * FR"));
		const r = await scanPhoto(empty(), t.reader, index);
		expect(r.printed).toBeNull();
		expect(t.cornerCalls()).toBe(0);
	});
});

describe("scanPhoto: the corner names the card first (shortcut)", () => {
	const cornerLines = (): ReadLine[] => [
		{ text: "C 0082", y0: 0, y1: 40 },
		{ text: "SPM * FR", y0: 50, y1: 90 },
	];
	/** An engine whose corner (psm 6) reads like a modern card and whose title reads answer `titleAt(call)`. */
	function engine(titleAt: (call: number) => ReadLine[]) {
		const e = fakeEngine(titleAt);
		const reader: OcrReader = { recognize: (bmp, psm) => (psm === 6 ? (e.calls.push({ bmp, psm }), Promise.resolve(cornerLines())) : e.reader.recognize(bmp, psm)) };
		return { reader, titleReads: () => e.titles.length };
	}
	const soulBurn = { owner: 0, names: ["Soul Burn", "Brûlure des âmes"] };

	it("confirms the card named by the corner with ONE good title reading, where the whole plan needs two that agree", async () => {
		const e = engine(() => title("Brulure des ames"));
		const asked: string[] = [];
		const r = await scanPhoto(withCard(), e.reader, index, {
			shortcut: async (printed) => (asked.push(`${printed.set} ${printed.number}`), soulBurn),
		});
		expect(asked).toEqual(["spm 82"]);
		expect(r.shortcut).toBe("confirmed");
		expect(r.stoppedBy).toBe("sure");
		expect(e.titleReads()).toBe(1);
		expect(r.reads).toBe(1);
		expect(r.decision).toMatchObject({ owner: 0, key: "brulure des ames", sure: true });
		expect(r.proposals).toEqual([{ owner: 0, key: "brulure des ames", evidence: 1, reads: 1 }]);
		expect(r.printed?.number).toBe("82");
	});

	it("confirms by an English title just as well, and keeps the key of the name that matched (the language)", async () => {
		const e = engine(() => title("Soul Burn"));
		const r = await scanPhoto(withCard(), e.reader, index, { shortcut: async () => soulBurn });
		expect(r.decision?.key).toBe("soul burn");
	});

	it("stops with the corner alone, reading no title, when the card has no catalogue row (a token, a card newer than the snapshot)", async () => {
		const e = engine(() => title("Brulure des ames"));
		const r = await scanPhoto(withCard(), e.reader, index, { shortcut: async () => ({ owner: null, names: [] }) });
		expect(r.shortcut).toBe("corner-only");
		expect(r.stoppedBy).toBe("sure");
		expect(e.titleReads()).toBe(0);
		expect(r.decision).toBeNull();
		expect(r.proposals).toEqual([]);
		expect(r.printed?.number).toBe("82");
	});

	it("falls back to the whole plan when the title is not the card the corner named, and still finds the card the title says", async () => {
		const e = engine(() => title("Brulure des ames"));
		const r = await scanPhoto(withCard(), e.reader, index, { shortcut: async () => ({ owner: 1, names: ["Goblin Spy", "Espion gobelin"] }) });
		expect(r.shortcut).toBeNull();
		expect(r.decision?.owner).toBe(0);
		expect(r.reads).toBe(CONFIRM_CONFIG.steps + 1); // the readings that could have confirmed the corner's card go on first, then the ordinary rule applies
	});

	it("does not stop on another card the first readings agree on while the corner's card can still be confirmed (a long name read in pieces)", async () => {
		// "Goblin Spy" is read three times (the plan would stop there), then the corner's card comes out whole on the fourth
		const e = engine((call) => (call <= 3 ? title("Goblin Spy") : title("Brulure des ames")));
		const r = await scanPhoto(withCard(), e.reader, index, { shortcut: async () => soulBurn });
		expect(r.shortcut).toBe("confirmed");
		expect(r.decision).toMatchObject({ owner: 0, sure: true });
		expect(r.reads).toBe(4);
	});

	it("cuts the title strips from the quad turned half a turn when the corner could only be read from it (the card lies upside down)", async () => {
		const photo = withCard();
		const titleBmps: Uint8Array[] = [];
		let corner = 0;
		const reader: OcrReader = {
			recognize: async (bmp, psm) => {
				if (psm === 6) {
					corner++;
					return corner <= 4 ? [] : cornerLines(); // nothing in the four reads of the quad as given, then the turned one reads
				}
				titleBmps.push(bmp);
				return title("Brulure des ames");
			},
		};
		const r = await scanPhoto(photo, reader, index, { shortcut: async () => soulBurn });
		const q = r.quad!;
		const turned = [q[2], q[3], q[0], q[1]] as typeof q;
		const gray = toGray(photo.rgba, photo.w, photo.h);
		const first = readingPlan()[0];
		const expected = (quad: typeof q): Uint8Array => encodeBmp(stripVariant(extractStrip(gray, quad, first.strip), first.variant));
		const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
		expect(r.shortcut).toBe("confirmed");
		expect(same(titleBmps[0], expected(turned))).toBe(true);
		expect(same(titleBmps[0], expected(q))).toBe(false);
	});

	it("falls back to the whole plan when the lookup answers nothing or fails", async () => {
		for (const shortcut of [async () => null, async () => Promise.reject(new Error("offline"))]) {
			const e = engine(() => title("Brulure des ames"));
			const r = await scanPhoto(withCard(), e.reader, index, { shortcut });
			expect(r.shortcut).toBeNull();
			expect(r.reads).toBe(2);
		}
	});

	it("does not ask when nothing was read in the corner", async () => {
		const e = fakeEngine(() => title("Brulure des ames")); // its corner reads answer nothing
		let asked = 0;
		const r = await scanPhoto(withCard(), e.reader, index, { shortcut: async () => (asked++, soulBurn) });
		expect(asked).toBe(0);
		expect(r.shortcut).toBeNull();
	});

	it("confirms the card with the first title strip when the tall strip read nothing usable (the 6th reading: a red-framed title read as \"(Pin\")", async () => {
		const e = engine((call) => (call <= 5 ? title("Pin") : title("Brulure des ames")));
		const r = await scanPhoto(withCard(), e.reader, index, { shortcut: async () => soulBurn });
		expect(r.shortcut).toBe("confirmed");
		expect(r.decision).toMatchObject({ owner: 0, sure: true });
		expect(r.reads).toBe(6);
	});

	it("checks only the first readings of the plan against the card: a title that comes later is found the ordinary way", async () => {
		const e = engine((call) => (call <= CONFIRM_CONFIG.steps + 1 ? [] : title("Brulure des ames")));
		const r = await scanPhoto(withCard(), e.reader, index, { shortcut: async () => soulBurn });
		expect(r.shortcut).toBeNull();
		expect(r.decision?.owner).toBe(0);
		expect(r.reads).toBe(CONFIRM_CONFIG.steps + 3); // the two readings after the confirming window agree
	});

	it("reads the title the right way up first when the corner named the card (the upside-down readings last), and in the plan's own order when no card was named", async () => {
		const photo = withColouredTitle(); // the colours make a strip cut from a channel differ from the luminance one, so the order of the channels is checked too
		const expectedBmp = (quad: [number, number][], step: ReturnType<typeof readingPlan>[number]): Uint8Array =>
			encodeBmp(stripVariant(extractStrip(toChannel(photo.rgba, photo.w, photo.h, step.channel), quad as never, step.strip), step.variant));
		const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, k) => v === b[k]);
		const plan = readingPlan();
		const ordered = [...plan.filter((s) => s.roll === 0), ...plan.filter((s) => s.roll !== 0)];
		expect(plan.slice(0, 40).some((s, k) => s !== ordered[k])).toBe(true); // the two orders differ within the first 40 readings, so the check below can fail
		expect(ordered.slice(0, 40).some((s) => s.channel !== "L")).toBe(true); // and those 40 include colour readings
		for (const named of [true, false]) {
			const bmps: Uint8Array[] = [];
			const reader: OcrReader = { recognize: async (bmp, psm) => (psm === 6 ? cornerLines() : (bmps.push(bmp), [])) };
			const r = await scanPhoto(photo, reader, index, { shortcut: async () => (named ? soulBurn : null), maxReads: 40 });
			const order = named ? ordered : plan;
			const quad = r.quad as [number, number][];
			expect(bmps.length).toBe(40);
			expect(bmps.every((b, k) => same(b, expectedBmp(quad, order[k])))).toBe(true);
		}
	}, 60000);

	it("cuts the colour readings of the plan from the red, blue and green channel of the photo, not from the luminance", async () => {
		const photo = withColouredTitle();
		const e = fakeEngine(() => []);
		const r = await scanPhoto(photo, e.reader, index, { maxReads: 35 });
		const plan = readingPlan();
		const quad = r.quad as [number, number][];
		const bmpOf = (k: number): Uint8Array => e.titles[k].bmp;
		const cut = (step: (typeof plan)[number], channel: "L" | "R" | "G" | "B"): Uint8Array => encodeBmp(stripVariant(extractStrip(toChannel(photo.rgba, photo.w, photo.h, channel), quad as never, step.strip), step.variant));
		const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, k) => v === b[k]);
		// the 16th..30th readings: blue, red, green, five variants each, of the first title strip the right way up; the 11th..15th are its luminance
		for (const [k, channel] of [[10, "L"], [15, "B"], [20, "R"], [25, "G"], [30, "L"]] as const) {
			expect(plan[k].channel).toBe(channel);
			expect(same(bmpOf(k), cut(plan[k], channel))).toBe(true);
		}
		// and the same strip through two different channels is not the same picture (the band is red: bright in R, black in B)
		expect(same(bmpOf(15), bmpOf(20))).toBe(false);
		expect(same(bmpOf(10), bmpOf(15))).toBe(false);
	}, 60000);

	/** An engine whose corner reading answers `cornerAt(call)` (1-based among the corner readings) and whose title readings answer the card's title. */
	function engineWithCorner(cornerAt: (call: number) => ReadLine[]) {
		const e = fakeEngine(() => title("Brulure des ames"));
		let cornerCalls = 0;
		const reader: OcrReader = { recognize: (bmp, psm) => (psm === 6 ? (cornerCalls++, Promise.resolve(cornerAt(cornerCalls))) : e.reader.recognize(bmp, psm)) };
		return { reader, cornerCalls: () => cornerCalls };
	}
	const lines2 = (a: string, b: string): ReadLine[] => [
		{ text: a, y0: 0, y1: 40 },
		{ text: b, y0: 50, y1: 90 },
	];

	it("asks once more with the wide window's reading when a set code of three letters was not a card (PMR for SPM)", async () => {
		// the wide window reads the set code well but its number line is lost in noise: the number of the first reading is kept
		const e = engineWithCorner((call) => (call <= 2 ? lines2("C 0197", "PMR tw lonas") : lines2("zzz", "SPM * FR")));
		const asked: string[] = [];
		const r = await scanPhoto(withCard(), e.reader, index, {
			shortcut: async (printed) => (asked.push(`${printed.set} ${printed.number}`), printed.set === "spm" ? soulBurn : null),
		});
		expect(asked).toEqual(["pmr 197", "spm 197"]);
		expect(e.cornerCalls()).toBe(4);
		expect(r.shortcut).toBe("confirmed");
		expect(r.printed).toMatchObject({ number: "197", set: "spm" });
	});

	it("asks again with the wide window's reading when a stray letter turned the set code into one Scryfall does not know (MHOB for HOB)", async () => {
		// the narrow window reads HOB once and MHOB once (a tie: the longer code is kept), the wide window reads HOB twice: HOB wins the vote and is asked
		const e = engineWithCorner((call) => lines2("R 0083", call === 2 ? "MHOB * EN" : "HOB * EN"));
		const asked: string[] = [];
		const r = await scanPhoto(withCard(), e.reader, index, {
			shortcut: async (printed) => (asked.push(`${printed.set} ${printed.number}`), printed.set === "hob" ? soulBurn : null),
		});
		expect(asked).toEqual(["mhob 83", "hob 83"]);
		expect(r.shortcut).toBe("confirmed");
		expect(r.printed).toMatchObject({ number: "83", set: "hob" });
	});

	it("does not re-read the corner when the person cancelled while Scryfall was being asked", async () => {
		const ctl = new AbortController();
		const e = engineWithCorner(() => lines2("C 0197", "PMR tw lonas"));
		const asked: string[] = [];
		const r = await scanPhoto(withCard(), e.reader, index, {
			signal: ctl.signal,
			shortcut: async (printed) => {
				asked.push(`${printed.set}`);
				ctl.abort();
				return null;
			},
		});
		expect(asked).toEqual(["pmr"]);
		expect(e.cornerCalls()).toBe(2);
		expect(r.stoppedBy).toBe("cancelled");
	});

	it("does not ask again when the first answer was a card", async () => {
		const e = engineWithCorner(() => lines2("C 0082", "SPM * FR"));
		const asked: string[] = [];
		await scanPhoto(withCard(), e.reader, index, { shortcut: async (printed) => (asked.push(`${printed.set}`), soulBurn) });
		expect(asked).toEqual(["spm"]);
		expect(e.cornerCalls()).toBe(2);
	});

	it("does not re-read when the set code had fewer than three letters (the wide window was read already), nor when no number was read", async () => {
		const short = engineWithCorner(() => lines2("C 0082", "PM * FR"));
		const askedShort: string[] = [];
		await scanPhoto(withCard(), short.reader, index, { shortcut: async (printed) => (askedShort.push(`${printed.set}`), null) });
		expect(askedShort).toEqual(["pm"]);
		expect(short.cornerCalls()).toBe(4); // first window, then the wide one for the short code: no third

		const noNumber = engineWithCorner(() => lines2("garbage", "SPM * FR"));
		const askedNoNumber: string[] = [];
		await scanPhoto(withCard(), noNumber.reader, index, { shortcut: async (printed) => (askedNoNumber.push(`${printed.number}`), null) });
		expect(askedNoNumber).toEqual(["null"]);
		expect(noNumber.cornerCalls()).toBe(6); // the first window, the same window of the card turned half a turn (nothing there either), then the second (no number read twice): the set code is whole, so no wide window and no re-read
	});

	it("reads the corner of a card lying upside down: when no window of the quad read a number, the first window of the quad turned half a turn, which is kept for the next one", async () => {
		const bmps: Uint8Array[] = [];
		const e = fakeEngine(() => title("Soul Burn"));
		// the four reads of the quad as the finder gave it see nothing; the turned first window reads a number once (call 5) and nothing the second time: the second window follows
		let corner = 0;
		const reader: OcrReader = {
			recognize: async (bmp, psm) => {
				if (psm !== 6) return e.reader.recognize(bmp, psm);
				bmps.push(bmp);
				corner++;
				return corner <= 4 || corner === 6 ? [] : lines2("C 0082", "SPM * FR");
			},
		};
		const photo = withCard();
		const r = await scanPhoto(photo, reader, index);
		expect(r.printed?.number).toBe("82");
		const q = r.quad!;
		const turned = [q[2], q[3], q[0], q[1]] as typeof q;
		const gray = toGray(photo.rgba, photo.w, photo.h);
		const bmpOf = (quad: typeof q, win: { x0: number; x1: number; y0: number; y1: number }): Uint8Array => encodeBmp(stripVariant(extractStrip(gray, quad, { ...win, outW: 1100, roll: 0 }), "asis"));
		const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
		expect(corner).toBe(8); // first window 2, second window 2 (a number read nowhere), the turned first window 2, the turned second window 2 (the number was read once)
		expect(same(bmps[0], bmpOf(q, PRINTED_WINDOWS_OUTER[0]))).toBe(true);
		expect(same(bmps[2], bmpOf(q, PRINTED_WINDOWS_OUTER[1]))).toBe(true);
		expect(same(bmps[4], bmpOf(turned, PRINTED_WINDOWS_OUTER[0]))).toBe(true);
		expect(same(bmps[6], bmpOf(turned, PRINTED_WINDOWS_OUTER[1]))).toBe(true); // after the turn, the other window is cut from the turned quad too
	});

	it("does not turn the card when the first window already read a number", async () => {
		const e = engineWithCorner(() => lines2("C 0082", "SPM * FR"));
		await scanPhoto(withCard(), e.reader, index);
		expect(e.cornerCalls()).toBe(2);
	});

	it("retries once only, and only when the wide reading changed the set code", async () => {
		const stays = engineWithCorner(() => lines2("C 0197", "PMR * FR"));
		const askedStays: string[] = [];
		await scanPhoto(withCard(), stays.reader, index, { shortcut: async (printed) => (askedStays.push(`${printed.set}`), null) });
		expect(askedStays).toEqual(["pmr"]); // the wide reading says the same: nothing new to ask
		expect(stays.cornerCalls()).toBe(4);

		const changes = engineWithCorner((call) => lines2("C 0197", call <= 2 ? "PMR * FR" : "SPX * FR"));
		const askedChanges: string[] = [];
		await scanPhoto(withCard(), changes.reader, index, { shortcut: async (printed) => (askedChanges.push(`${printed.set}`), null) });
		expect(askedChanges).toEqual(["pmr", "spx"]); // twice, not three times
	});

	it("does not ask when the person cancelled while the corner was being read", async () => {
		const ctl = new AbortController();
		const e = fakeEngine(() => title("Brulure des ames"));
		const reader: OcrReader = {
			recognize: (bmp, psm) => {
				if (psm !== 6) return e.reader.recognize(bmp, psm);
				ctl.abort(); // the first reading of the corner finishes with the person gone
				return Promise.resolve(cornerLines());
			},
		};
		let asked = 0;
		const r = await scanPhoto(withCard(), reader, index, { signal: ctl.signal, shortcut: async () => (asked++, soulBurn) });
		expect(r.printed?.number).toBe("82"); // what the one reading gave is kept
		expect(asked).toBe(0);
		expect(r.stoppedBy).toBe("cancelled");
	});

	it("does not ask when the person already cancelled", async () => {
		const ctl = new AbortController();
		ctl.abort();
		const e = engine(() => title("Brulure des ames"));
		let asked = 0;
		const r = await scanPhoto(withCard(), e.reader, index, { signal: ctl.signal, shortcut: async () => (asked++, soulBurn) });
		expect(asked).toBe(0);
		expect(r.stoppedBy).toBe("cancelled");
	});
});

describe("scanPhoto: the title read among the cards of the corner's set", () => {
	const cornerLines = (): ReadLine[] => [
		{ text: "C 0086", y0: 0, y1: 40 },
		{ text: "SPM * FR", y0: 50, y1: 90 },
	];
	/** An engine whose corner (psm 6) reads like a modern card and whose title reads answer `titleAt(call)` (1-based); `onTitle` sees every title reading after it is answered. */
	function engine(titleAt: (call: number) => ReadLine[], onTitle?: (call: number) => void) {
		const e = fakeEngine(titleAt);
		const reader: OcrReader = {
			recognize: async (bmp, psm) => {
				if (psm === 6) return cornerLines();
				const lines = await e.reader.recognize(bmp, psm);
				onTitle?.(e.titles.length);
				return lines;
			},
		};
		return { reader, titleReads: () => e.titles.length };
	}
	/** The cards of the set: "Choc" (a French name of 4 letters) and "Opt" (3) are owned by rows past the catalogue's (3 and 4); Goblin Spy is the catalogue's own row 1. */
	const SET: SetScope = { index: buildNameIndex(["Shock", "Choc", "Opt", "Goblin Spy"], [3, 3, 4, 1]) };
	const goblinCorner = { owner: 1, names: ["Goblin Spy", "Espion gobelin"] }; // what the number 86 says: another card
	const lines = (...texts: string[]): ReadLine[] => texts.map((text, i) => ({ text, y0: i * 100, y1: i * 100 + 70 }));

	it("finds a title too short for the whole catalogue among the cards of the printed set, when the corner's number points at another card", async () => {
		const e = engine(() => title("Choc"));
		const asked: string[] = [];
		const r = await scanPhoto(withCard(), e.reader, index, {
			shortcut: async () => goblinCorner,
			setScope: async (printed) => (asked.push(printed.set ?? ""), SET),
		});
		expect(r.shortcut).toBe("set-title");
		expect(r.stoppedBy).toBe("sure");
		expect(r.decision).toMatchObject({ owner: 3, key: "choc", sure: true });
		expect(r.proposals[0].owner).toBe(3);
		expect(asked).toEqual(["spm"]);
		// the card list is asked for after SET_SCOPE_START_READS readings that did not confirm the corner's card, and the readings made meanwhile are read through it
		expect(r.reads).toBe(SET_SCOPE_START_READS + 1);
		expect(r.printed?.number).toBe("86");
	});

	it("asks for the list at once when the corner named no card, and decides on the second reading (two must agree)", async () => {
		const e = engine(() => title("Choc"));
		let asked = 0;
		const r = await scanPhoto(withCard(), e.reader, index, { setScope: async () => (asked++, SET) });
		expect(asked).toBe(1);
		expect(r.shortcut).toBe("set-title");
		expect(r.decision).toMatchObject({ owner: 3, sure: true });
		expect(r.reads).toBe(2);
	});

	it("reads a title of three letters too, and refuses the same word in the whole catalogue's index", async () => {
		const r = await scanPhoto(withCard(), engine(() => title("Opt")).reader, index, { setScope: async () => SET });
		expect(r.decision).toMatchObject({ owner: 4, key: "opt" });
		const whole = await scanPhoto(withCard(), engine(() => title("Goblin Spy")).reader, index, { setScope: async () => ({ index: buildNameIndex(["Opt"], [9]) }) });
		expect(whole.shortcut).toBeNull(); // not the set-scoped reader: the whole catalogue found Goblin Spy
		expect(whole.decision?.owner).toBe(1);
	});

	it("joins the readings already made when the list arrives late, and decides on the first one it sees", async () => {
		let release: (scope: SetScope) => void = () => undefined;
		const late = new Promise<SetScope>((resolve) => (release = resolve));
		const e = engine(
			() => title("Choc"),
			(call) => {
				if (call === 6) release(SET); // the list comes in while the 6th reading is being made: the five before it were read without the list
			},
		);
		const r = await scanPhoto(withCard(), e.reader, index, { setScope: () => late });
		expect(r.shortcut).toBe("set-title");
		expect(r.decision?.owner).toBe(3);
		expect(r.reads).toBe(6); // one reading alone cannot decide (two must agree): the earlier ones were read through the list too
	});

	it("never waits for the list: a list that does not arrive leaves the scan exactly as it was", async () => {
		const e = engine(() => title("Brulure des ames"));
		const r = await scanPhoto(withCard(), e.reader, index, { setScope: () => new Promise<SetScope | null>(() => undefined) });
		expect(r.shortcut).toBeNull();
		expect(r.decision).toMatchObject({ owner: 0, sure: true });
		expect(r.reads).toBe(2);
	});

	it("leaves the scan as it was when the list is refused, empty, rejected or throws", async () => {
		for (const setScope of [async () => null, async () => Promise.reject(new Error("offline")), () => Promise.reject(new Error("x")), () => { throw new Error("sync"); }]) {
			const e = engine(() => title("Choc"));
			const r = await scanPhoto(withCard(), e.reader, index, { setScope: setScope as () => Promise<SetScope | null>, maxReads: 12 });
			expect(r.shortcut).toBeNull();
			expect(r.stoppedBy).toBe("budget");
			expect(r.decision).toBeNull();
			expect(r.proposals).toEqual([]);
			expect(e.titleReads()).toBe(12);
		}
	});

	it("asks for a set's list ONCE however many readings follow", async () => {
		const asked: string[] = [];
		const e = engine(() => []);
		await scanPhoto(withCard(), e.reader, index, { shortcut: async () => goblinCorner, setScope: async (p) => (asked.push(p.set ?? ""), null), maxReads: 12 });
		expect(asked).toEqual(["spm"]);
	});

	it("does not ask for the list when the corner's card is confirmed, even by the 4th reading (the common path pays nothing)", async () => {
		for (const firstGood of [1, SET_SCOPE_START_READS]) {
			let asked = 0;
			const e = engine((call) => (call >= firstGood ? title("Brulure des ames") : []));
			const r = await scanPhoto(withCard(), e.reader, index, {
				shortcut: async () => ({ owner: 0, names: ["Soul Burn", "Brûlure des âmes"] }),
				setScope: async () => (asked++, SET),
			});
			expect(r.shortcut).toBe("confirmed");
			expect(r.reads).toBe(firstGood);
			expect(asked).toBe(0);
		}
	});

	it("does not ask when the corner named a card the catalogue lacks (the corner decides alone), nor when no set code was read", async () => {
		let asked = 0;
		const e = engine(() => title("Choc"));
		const r = await scanPhoto(withCard(), e.reader, index, { shortcut: async () => ({ owner: null, names: [] }), setScope: async () => (asked++, SET) });
		expect(r.shortcut).toBe("corner-only");
		const noCorner = fakeEngine(() => title("Choc"));
		await scanPhoto(withCard(), noCorner.reader, index, { maxReads: 3, setScope: async () => (asked++, SET) });
		expect(asked).toBe(0);
	});

	it("does not decide on noise, nor on a line that is only close to a short name (choe is not choc)", async () => {
		for (const text of ["Choe", "Che", "Ch0", "Cho", "ee", "Choc is a thing that has more words"]) {
			const e = engine(() => title(text));
			const r = await scanPhoto(withCard(), e.reader, index, { setScope: async () => SET, maxReads: 12 });
			expect(r.shortcut, text).toBeNull();
			expect(r.decision, text).toBeNull();
		}
	}, 60_000);

	it("does not decide on a card that is not in the printed set's list (the wrong set, or a card of another set)", async () => {
		const e = engine(() => title("Brulure des ames"));
		const r = await scanPhoto(withCard(), e.reader, index, { setScope: async () => ({ index: buildNameIndex(["Thwip", "Kapow"], [5, 6]) }), maxReads: 12 });
		expect(r.shortcut).toBeNull();
		expect(r.decision?.owner).toBe(0); // the whole catalogue still finds it
	});

	it("shows the set's card first among the proposals, then the whole catalogue's, each card once", async () => {
		const e = engine((call) => (call === 1 ? lines("Choc", "Goblin Spy") : lines("Choc")));
		const r = await scanPhoto(withCard(), e.reader, index, { setScope: async () => SET });
		expect(r.shortcut).toBe("set-title");
		expect(r.proposals.map((p) => p.owner)).toEqual([3, 1]);
	});

	it("prefers the printed set's card to another card the whole catalogue is also sure of (the corner narrowed the choice)", async () => {
		const e = engine(() => lines("Choc", "Goblin Spy"));
		const r = await scanPhoto(withCard(), e.reader, index, { setScope: async () => ({ index: buildNameIndex(["Shock", "Choc"], [3, 3]) }) });
		expect(r.shortcut).toBe("set-title");
		expect(r.decision?.owner).toBe(3);
		expect(r.proposals.map((p) => p.owner)).toEqual([3, 1]);
	});

	it("keeps the set's best card among the proposals when the plan runs out without a sure one", async () => {
		// "Choc" is read once only: 1 reading is not enough for the stop rule, and not for a decision at the end of the plan either (evidence 1 < the margin rule needs 2 reads)
		const e = engine((call) => (call === 1 ? title("Choc") : []));
		const r = await scanPhoto(withCard(), e.reader, index, { setScope: async () => SET });
		expect(r.stoppedBy).toBe("plan");
		expect(r.proposals.map((p) => p.owner)).toEqual([3]);
		expect(r.decision).toMatchObject({ owner: 3, sure: false });
	});

	it("stops on the person's cancel as before", async () => {
		const ctl = new AbortController();
		const e = engine(() => [], (call) => call === 2 && ctl.abort());
		const r = await scanPhoto(withCard(), e.reader, index, { setScope: async () => SET, signal: ctl.signal });
		expect(r.stoppedBy).toBe("cancelled");
	});
});

describe("languageOfCard", () => {
	it("is empty for English (the plugin's code) and the language code otherwise", () => {
		expect(languageOfCard(ROWS[0], "soul burn")).toBe("");
		expect(languageOfCard(ROWS[0], "brulure des ames")).toBe("fr");
	});
});

describe("findCornerCard: the corner of a card the fingerprint already found", () => {
	const quad = cardCorners(360, 480, 420, 588, 0) as [number, number][] as Parameters<typeof findCornerCard>[1];
	const lines = (a: string, b: string): ReadLine[] => [
		{ text: a, y0: 0, y1: 40 },
		{ text: b, y0: 50, y1: 90 },
	];
	/** An engine that records every reading (the corner's only: a title is never read here) and answers `at(call)` (1-based). */
	function engine(at: (call: number) => ReadLine[] | "throw") {
		const bmps: Uint8Array[] = [];
		const psms: number[] = [];
		const reader: OcrReader = {
			recognize: async (bmp, psm) => {
				bmps.push(bmp);
				psms.push(psm);
				const answer = at(bmps.length);
				if (answer === "throw") throw new Error("engine fell over");
				return answer;
			},
		};
		return { reader, bmps, psms };
	}
	const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

	it("reads the corner only, asks for the card at the set code and number it read, and answers it with what was read", async () => {
		const e = engine(() => lines("C 0082", "SPM * FR"));
		const asked: string[] = [];
		const r = await findCornerCard(withCard(), quad, false, e.reader, async (printed) => (asked.push(`${printed.set} ${printed.number}`), "the card"));
		expect(r.card).toBe("the card");
		expect(r.printed).toMatchObject({ number: "82", set: "spm", lang: "fr" });
		expect(asked).toEqual(["spm 82"]);
		expect(new Set(e.psms)).toEqual(new Set([6])); // no title strip is ever read
		expect(e.bmps).toHaveLength(2); // both variants of the first window agree: nothing more is read
	});

	it("cuts its windows from the quad as the card's own edge or as the frame inside the border, as the caller says", async () => {
		const photo = withCard();
		const first = async (outer: boolean): Promise<Uint8Array> => {
			const e = engine(() => []);
			await findCornerCard(photo, quad, outer, e.reader, async () => null);
			return e.bmps[0];
		};
		const bmpOf = (win: { x0: number; x1: number; y0: number; y1: number }): Uint8Array => encodeBmp(stripVariant(extractStrip(toGray(photo.rgba, photo.w, photo.h), quad, { ...win, outW: 1100, roll: 0 }), "asis"));
		expect(sameBytes(await first(true), bmpOf(PRINTED_WINDOWS_OUTER[0]))).toBe(true);
		expect(sameBytes(await first(false), bmpOf(PRINTED_WINDOWS[0]))).toBe(true);
		expect(sameBytes(bmpOf(PRINTED_WINDOWS_OUTER[0]), bmpOf(PRINTED_WINDOWS[0]))).toBe(false); // the two really are different strips
	});

	it("asks once more with the wide window's reading when a set code of three letters was not a card (PMR for SPM), and only then", async () => {
		const e = engine((call) => (call <= 2 ? lines("C 0197", "PMR tw lonas") : lines("zzz", "SPM * FR")));
		const asked: string[] = [];
		const r = await findCornerCard(withCard(), quad, false, e.reader, async (printed) => (asked.push(`${printed.set} ${printed.number}`), printed.set === "spm" ? "spm card" : null));
		expect(asked).toEqual(["pmr 197", "spm 197"]);
		expect(r.card).toBe("spm card");
		expect(r.printed).toMatchObject({ number: "197", set: "spm" });
		const stays = engine(() => lines("C 0197", "PMR * FR"));
		const askedStays: string[] = [];
		await findCornerCard(withCard(), quad, false, stays.reader, async (printed) => (askedStays.push(String(printed.set)), null));
		expect(askedStays).toEqual(["pmr"]); // the wide reading says the same: nothing new to ask
	});

	it("answers no card, asking for nothing, when no number could be read", async () => {
		const e = engine(() => lines("garbage", "noise"));
		let asked = 0;
		const r = await findCornerCard(withCard(), quad, false, e.reader, async () => (asked++, "x"));
		expect(r.card).toBeNull();
		expect(asked).toBe(0);
	});

	it("never throws: a lookup that fails is no card, an engine that fails is no corner", async () => {
		const ok = engine(() => lines("C 0082", "SPM * FR"));
		const failedLookup = await findCornerCard(withCard(), quad, false, ok.reader, async () => Promise.reject(new Error("offline")));
		expect(failedLookup.card).toBeNull();
		expect(failedLookup.printed).toMatchObject({ number: "82", set: "spm" }); // what was read is still answered
		const broken = engine(() => "throw");
		expect(await findCornerCard(withCard(), quad, false, broken.reader, async () => "x")).toEqual({ printed: null, card: null });
	});

	it("asks for nothing once the person cancelled", async () => {
		const ctl = new AbortController();
		const e = engine(() => (ctl.abort(), lines("C 0082", "SPM * FR"))); // the first reading finishes with the person gone
		let asked = 0;
		const r = await findCornerCard(withCard(), quad, false, e.reader, async () => (asked++, "x"), ctl.signal);
		expect(asked).toBe(0);
		expect(r.card).toBeNull();
	});
});
