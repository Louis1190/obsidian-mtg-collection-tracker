import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// card-detail-fx.ts imports Obsidian's Platform/setIcon at load.
vi.mock("obsidian", () => ({ Platform: { isMobile: false }, setIcon: () => {} }));

import { NAV_FADE_MS, crossfade, holdPreviousBanner, runFrameClock } from "./card-detail-fx";

// The bits of an element the crossfade and the banner hold touch (the file runs under Node): an inline opacity, a stylesheet opacity, classes,
// custom properties and the load/error listeners of a picture.
class FakeEl {
	inline = "";
	sheetOpacity = "1";
	isConnected = true;
	classes = new Set<string>();
	props = new Map<string, string>();
	listeners = new Map<string, () => void>();
	complete = false;
	naturalWidth = 0;
	decode?: () => Promise<void>;
	style = {
		opacity: "",
		removeProperty: (name: string) => {
			if (name === "opacity") this.inline = "";
			else this.props.delete(name);
		},
	};
	constructor() {
		// `el.style.opacity = x` and `el.setCssProps({ opacity })` both land in `inline`.
		Object.defineProperty(this.style, "opacity", { get: () => this.inline, set: (v: string) => (this.inline = v) });
	}
	get opacity(): number {
		return parseFloat(this.inline || this.sheetOpacity);
	}
	getAttribute(name: string) {
		return name === "style" && (this.inline || this.props.size) ? "x" : null;
	}
	removeAttribute() {}
	addClass(c: string) {
		this.classes.add(c);
	}
	removeClass(c: string) {
		this.classes.delete(c);
	}
	setCssProps(p: Record<string, string>) {
		for (const [k, v] of Object.entries(p)) {
			if (k === "opacity") this.inline = v;
			else this.props.set(k, v);
		}
	}
	addEventListener(type: string, fn: () => void) {
		this.listeners.set(type, fn);
	}
	fire(type: string) {
		this.listeners.get(type)?.();
	}
}
function el(sheetOpacity = "1"): FakeEl {
	const e = new FakeEl();
	e.sheetOpacity = sheetOpacity;
	return e;
}
const asEl = (e: FakeEl) => e as unknown as HTMLElement;
const asImg = (e: FakeEl) => e as unknown as HTMLImageElement;
const loaded = (e: FakeEl) => {
	e.complete = true;
	e.naturalWidth = 626;
};

// Node has no requestAnimationFrame: a queue the tests pump by hand, so a frame can come when the test says (after a freeze, after a hitch).
type Globals = { getComputedStyle?: unknown; requestAnimationFrame?: unknown };
let frameQueue: Array<(now: number) => void> = [];
const frame = (now: number) => {
	const queue = frameQueue;
	frameQueue = [];
	queue.forEach((callback) => callback(now));
};
// `count` frames, `step` ms apart, the first at `from`.
const frames = (count: number, from: number, step = 16) => {
	for (let i = 0; i < count; i++) frame(from + i * step);
};
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	frameQueue = [];
	const g = globalThis as Globals;
	g.getComputedStyle = (e: FakeEl) => ({ opacity: String(e.opacity) });
	g.requestAnimationFrame = (callback: (now: number) => void) => frameQueue.push(callback);
});
afterEach(() => {
	vi.useRealTimers();
	const g = globalThis as Globals;
	delete g.getComputedStyle;
	delete g.requestAnimationFrame;
});

describe("crossfade (the scripted fade between two cards' artwork)", () => {
	it("brings the incoming element from 0 to the opacity its stylesheet gives it, and takes the outgoing ones from theirs to 0", () => {
		const incoming = el("0.55");
		const outgoing = el("0.55");
		const done = vi.fn();
		crossfade(asEl(incoming), [asEl(outgoing)], 200, done);
		expect(incoming.opacity).toBe(0);
		expect(outgoing.opacity).toBeCloseTo(0.55);
		frames(7, 1000); // first frame + 6 steps of 16 ms = 96 ms in
		expect(incoming.opacity).toBeGreaterThan(0.1);
		expect(incoming.opacity).toBeLessThan(0.4);
		expect(incoming.opacity + outgoing.opacity).toBeCloseTo(0.55, 1); // the two always add up: no dip, no bump
		frames(10, 1112);
		expect(incoming.inline).toBe(""); // back to the stylesheet's value, nothing left inline
		expect(done).toHaveBeenCalledTimes(1);
	});

	it("is timed from its FIRST frame: a freeze before that frame does not eat the start of the fade", () => {
		const incoming = el();
		crossfade(asEl(incoming), [], 200);
		frame(5000); // the window took 100 ms... or 5 s to come up: the fade still starts at 0
		expect(incoming.opacity).toBe(0);
		frame(5016);
		expect(incoming.opacity).toBeGreaterThan(0);
		expect(incoming.opacity).toBeLessThan(0.05);
	});

	it("a frame that comes late advances the fade by a bounded step: a hitch pauses it instead of skipping it", () => {
		const incoming = el();
		crossfade(asEl(incoming), [], 200);
		frame(0);
		frame(16);
		frame(316); // 300 ms hitch (a chart painted)
		// 16 + 50 ms of fade, not 316: a third of the way, not finished
		expect(incoming.inline).not.toBe("");
		expect(incoming.opacity).toBeGreaterThan(0.15);
		expect(incoming.opacity).toBeLessThan(0.4);
	});

	it("reads the target from the stylesheet even when the caller already hid the element", () => {
		const incoming = el("0.55");
		incoming.inline = "0";
		crossfade(asEl(incoming), [], 200);
		frames(20, 0);
		expect(incoming.inline).toBe("");
		expect(incoming.opacity).toBe(0.55);
	});

	it("never leaves the picture hidden when no frame runs (a hidden window): a timeout ends it", () => {
		const incoming = el();
		const done = vi.fn();
		crossfade(asEl(incoming), [], 200, done);
		expect(incoming.opacity).toBe(0);
		vi.advanceTimersByTime(1199);
		expect(done).not.toHaveBeenCalled();
		vi.advanceTimersByTime(2);
		expect(incoming.inline).toBe("");
		expect(done).toHaveBeenCalledTimes(1);
	});

	it("ends at once, and once, when the element was replaced by a redraw", () => {
		const incoming = el();
		const done = vi.fn();
		crossfade(asEl(incoming), [], 200, done);
		incoming.isConnected = false;
		frame(0);
		frames(30, 16);
		vi.advanceTimersByTime(2000);
		expect(done).toHaveBeenCalledTimes(1);
	});
});

describe("holdPreviousBanner (the previous artwork stays under the new one, which melts in)", () => {
	const windowEl = () => ({}) as HTMLElement;
	const previousOf = (tilt: FakeEl) => tilt.props.get("--mtg-previous-banner");

	it("a card with nothing before it shows its picture at once", () => {
		const win = windowEl();
		const tilt = el();
		const img = el();
		loaded(img);
		holdPreviousBanner(win, asEl(tilt), asImg(img), "art-1");
		expect(tilt.classes.has("has-previous-banner")).toBe(false);
		expect(img.inline).toBe("");
	});

	it("the next card, already cached, starts hidden over the previous artwork and fades in", () => {
		const win = windowEl();
		const first = el();
		loaded(first);
		holdPreviousBanner(win, asEl(el()), asImg(first), "art-1");

		const tilt = el();
		const img = el();
		loaded(img);
		holdPreviousBanner(win, asEl(tilt), asImg(img), "art-2");
		expect(tilt.classes.has("has-previous-banner")).toBe(true);
		expect(previousOf(tilt)).toBe('url("art-1")');
		expect(img.opacity).toBe(0);
		frames(1 + Math.round(NAV_FADE_MS / 2 / 16), 100);
		expect(img.opacity).toBeGreaterThan(0);
		expect(img.opacity).toBeLessThan(1);
		expect(tilt.classes.has("has-previous-banner")).toBe(true); // still under it while it is not opaque
		frames(Math.round(NAV_FADE_MS / 16) + 2, 400);
		expect(img.inline).toBe("");
		expect(tilt.classes.has("has-previous-banner")).toBe(false);
		expect(previousOf(tilt)).toBeUndefined();
	});

	it("a picture still loading keeps the previous artwork and fades in once it has arrived", () => {
		const win = windowEl();
		const first = el();
		loaded(first);
		holdPreviousBanner(win, asEl(el()), asImg(first), "art-1");

		const tilt = el();
		const img = el();
		holdPreviousBanner(win, asEl(tilt), asImg(img), "art-2");
		vi.advanceTimersByTime(1000); // a slow link: nothing has happened yet
		expect(tilt.classes.has("has-previous-banner")).toBe(true);
		expect(img.inline).toBe("");
		loaded(img);
		img.fire("load");
		expect(img.opacity).toBe(0);
		frames(Math.round(NAV_FADE_MS / 16) + 3, 2000);
		expect(img.inline).toBe("");
		expect(tilt.classes.has("has-previous-banner")).toBe(false);
	});

	it("starts the fade once the picture is decoded, hidden meanwhile", async () => {
		const win = windowEl();
		const first = el();
		loaded(first);
		holdPreviousBanner(win, asEl(el()), asImg(first), "art-1");

		const tilt = el();
		const img = el();
		loaded(img);
		let decoded!: () => void;
		img.decode = () => new Promise<void>((resolve) => (decoded = resolve));
		holdPreviousBanner(win, asEl(tilt), asImg(img), "art-2");
		expect(img.opacity).toBe(0);
		frames(5, 0);
		expect(img.opacity).toBe(0); // not started: the pixels are not ready
		decoded();
		await Promise.resolve();
		await Promise.resolve();
		frames(1 + Math.round(NAV_FADE_MS / 2 / 16), 200);
		expect(img.opacity).toBeGreaterThan(0);
	});

	it("a redraw of the SAME card has nothing to melt from", () => {
		const win = windowEl();
		const first = el();
		loaded(first);
		holdPreviousBanner(win, asEl(el()), asImg(first), "art-1");
		const tilt = el();
		const again = el();
		loaded(again);
		holdPreviousBanner(win, asEl(tilt), asImg(again), "art-1");
		expect(tilt.classes.has("has-previous-banner")).toBe(false);
		expect(again.inline).toBe("");
	});

	it("a picture that fails drops the previous artwork instead of passing it for this card's", () => {
		const win = windowEl();
		const first = el();
		loaded(first);
		holdPreviousBanner(win, asEl(el()), asImg(first), "art-1");
		const tilt = el();
		const img = el();
		holdPreviousBanner(win, asEl(tilt), asImg(img), "art-2");
		img.fire("error");
		expect(tilt.classes.has("has-previous-banner")).toBe(false);
	});

	it("only a picture that really appeared counts as the one to melt from", () => {
		const win = windowEl();
		const first = el();
		loaded(first);
		holdPreviousBanner(win, asEl(el()), asImg(first), "art-1");
		holdPreviousBanner(win, asEl(el()), asImg(el()), "art-2"); // never loaded: the user moved on
		const tilt = el();
		const third = el();
		loaded(third);
		holdPreviousBanner(win, asEl(tilt), asImg(third), "art-3");
		expect(previousOf(tilt)).toBe('url("art-1")');
	});
});

describe("runFrameClock (the clock the text box height shares with the fades)", () => {
	it("shows the animation at 0 at once and finishes exactly once when the time is up", () => {
		const seen: number[] = [];
		const done = vi.fn();
		runFrameClock(200, (p) => seen.push(p), done);
		expect(seen).toEqual([0]);
		frames(20, 1000);
		expect(done).toHaveBeenCalledTimes(1);
		expect(seen.every((p, i) => i === 0 || p >= seen[i - 1])).toBe(true); // never goes backwards
		expect(Math.max(...seen)).toBeLessThan(1); // the end is the finish, not a last write
	});

	it("starts its clock at the first frame, not at the call, so a freeze before it does not eat the start", () => {
		const seen: number[] = [];
		runFrameClock(200, (p) => seen.push(p), () => {});
		vi.advanceTimersByTime(120); // the window rebuilt itself for ~100 ms before the first frame
		frame(5000); // the first frame, long after the call
		expect(seen[seen.length - 1]).toBe(0);
	});

	it("is paused, not skipped, by a late frame in the middle", () => {
		const seen: number[] = [];
		runFrameClock(200, (p) => seen.push(p), () => {});
		frames(5, 1000); // 16 ms steps: 64 ms in
		const before = seen[seen.length - 1];
		frame(1064 + 400); // a 400 ms hitch counts as one clamped step (50 ms), not 400
		const after = seen[seen.length - 1];
		expect(after).toBeGreaterThan(before);
		expect(after).toBeLessThan(0.9); // 64 + 50 = 114 ms of 200 ms, not the whole thing
	});

	it("finishes at once, without a last write, when what it animates is gone", () => {
		let alive = true;
		const seen: number[] = [];
		const done = vi.fn();
		runFrameClock(200, (p) => seen.push(p), done, () => alive);
		frames(2, 1000);
		alive = false;
		const writes = seen.length;
		frame(1100);
		expect(done).toHaveBeenCalledTimes(1);
		expect(seen.length).toBe(writes);
	});

	it("is finished by the timeout net when no frame ever comes (a hidden window)", () => {
		const done = vi.fn();
		runFrameClock(200, () => {}, done);
		vi.advanceTimersByTime(1199);
		expect(done).not.toHaveBeenCalled();
		vi.advanceTimersByTime(2);
		expect(done).toHaveBeenCalledTimes(1);
	});
});
