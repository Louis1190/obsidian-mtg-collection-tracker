// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { renderValueHistoryChart } from "./value-history-chart";
import type { ValuePoint } from "../core/value-history";

// Obsidian's DOM helpers are not in jsdom: the ones the chart uses.
beforeEach(() => {
	const proto = Element.prototype as unknown as Record<string, unknown>;
	proto.createDiv = function (this: Element, o?: { cls?: string; text?: string }) {
		const d = this.ownerDocument.createElement("div");
		if (o?.cls) d.className = o.cls;
		if (o?.text) d.textContent = o.text;
		this.appendChild(d);
		return d;
	};
	proto.createSpan = function (this: Element, o?: { cls?: string; text?: string }) {
		const d = this.ownerDocument.createElement("span");
		if (o?.cls) d.className = o.cls;
		if (o?.text) d.textContent = o.text;
		this.appendChild(d);
		return d;
	};
	proto.empty = function (this: Element) {
		this.replaceChildren();
	};
	proto.addClass = function (this: Element, c: string) {
		this.classList.add(c);
	};
	proto.removeClass = function (this: Element, c: string) {
		this.classList.remove(c);
	};
	document.body.innerHTML = "";
});

const pt = (day: string, usd: number, cards = 10): ValuePoint => ({ day, usd, eur: usd / 2, cards, dateModified: 1 });

function draw(series: ValuePoint[], currency: "usd" | "eur" = "usd") {
	const host = document.createElement("div");
	document.body.appendChild(host);
	renderValueHistoryChart(host, series, currency);
	return host;
}

// jsdom has no layout: give the drawing a 300px-wide box at x=0, so a clientX is a position in the viewBox.
function sized(host: HTMLElement) {
	const svg = host.querySelector("svg")!;
	svg.getBoundingClientRect = () => ({ left: 0, right: 300, width: 300, top: 0, bottom: 70, height: 70, x: 0, y: 0, toJSON: () => ({}) });
	return host.querySelector(".mtg-value-chart-plot") as HTMLElement;
}

const move = (el: Element, clientX: number, type = "pointermove") => el.dispatchEvent(new MouseEvent(type, { clientX, bubbles: true }));
const tip = (host: HTMLElement) => host.querySelector(".mtg-value-chart-tooltip") as HTMLElement;
const SERIES = [pt("2026-11-20", 1000, 10), pt("2026-11-21", 1100, 11), pt("2026-11-22", 1300, 12)];

describe("renderValueHistoryChart — the drawing", () => {
	it("draws nothing under two points", () => {
		expect(draw([]).children).toHaveLength(0);
		expect(draw([pt("2026-11-22", 5)]).children).toHaveLength(0);
	});

	it("draws one curve through every point, with its area and an end dot", () => {
		const host = draw(SERIES);
		const paths = host.querySelectorAll("svg path");
		expect(paths).toHaveLength(2);
		const line = paths[1].getAttribute("d")!;
		expect(line.match(/[ML]/g)).toHaveLength(3);
		expect(line.startsWith("M0.0,")).toBe(true);
		// The end dot, and the hidden dot that follows the pointer.
		const circles = host.querySelectorAll("svg circle");
		expect(circles).toHaveLength(2);
		expect(circles[1].classList.contains("mtg-hidden")).toBe(true);
		expect(paths[0].getAttribute("d")!.endsWith("Z")).toBe(true);
	});

	it("spaces the points by DAY, not by index, so a hole shows as a hole", () => {
		const host = draw([pt("2026-11-01", 10), pt("2026-11-02", 11), pt("2026-11-11", 12)]);
		const xs = Array.from(host.querySelectorAll("svg path")[1].getAttribute("d")!.matchAll(/[ML]([\d.]+),/g)).map((m) => Number(m[1]));
		expect(xs).toEqual([0, 30, 300]);
	});

	it("draws a higher value higher", () => {
		const host = draw(SERIES);
		const ys = Array.from(host.querySelectorAll("svg path")[1].getAttribute("d")!.matchAll(/,([\d.]+)/g)).map((m) => Number(m[1]));
		expect(ys[0]).toBeGreaterThan(ys[1]);
		expect(ys[1]).toBeGreaterThan(ys[2]);
		expect(ys[2]).toBeGreaterThanOrEqual(0);
		expect(ys[0]).toBeLessThanOrEqual(80);
	});

	it("labels the axes: compact amounts up the side, the first and last day underneath", () => {
		const host = draw(SERIES);
		const labels = Array.from(host.querySelectorAll(".mtg-value-chart-y-labels span")).map((e) => e.textContent);
		expect(labels).toHaveLength(2);
		expect(labels[0]).toMatch(/^\$1\.\dk$/);
		expect(labels[1]).toMatch(/^\$(9\d\d|1k)$|^\$\d{3}$/);
		expect(Array.from(host.querySelectorAll(".mtg-value-chart-dates span")).map((e) => e.textContent)).toEqual(["Nov 20", "Nov 22"]);
	});

	it("writes the year on the axis when the curve spans years", () => {
		const host = draw([pt("2025-12-20", 5), pt("2026-01-05", 6)]);
		expect(Array.from(host.querySelectorAll(".mtg-value-chart-dates span")).map((e) => e.textContent)).toEqual(["Dec 20, 2025", "Jan 5, 2026"]);
	});

	it("has a text alternative", () => {
		const label = draw(SERIES).querySelector("svg")!.getAttribute("aria-label")!;
		expect(label).toContain("$1000.00");
		expect(label).toContain("$1300.00");
		expect(label).toContain("Nov 22");
	});

	it("draws the currency it is asked for", () => {
		const host = draw(SERIES, "eur");
		expect(Array.from(host.querySelectorAll(".mtg-value-chart-y-labels span"))[0].textContent!.startsWith("€")).toBe(true);
		expect(host.querySelector("svg")!.getAttribute("aria-label")).toContain("€500.00");
	});

	it("replaces what was there instead of stacking a second chart", () => {
		const host = document.createElement("div");
		renderValueHistoryChart(host, SERIES, "usd");
		renderValueHistoryChart(host, SERIES, "usd");
		expect(host.querySelectorAll("svg")).toHaveLength(1);
		renderValueHistoryChart(host, [], "usd");
		expect(host.children).toHaveLength(0);
	});
});

describe("renderValueHistoryChart — reading a point", () => {
	it("shows the point nearest to the pointer: day, copies held, value", () => {
		const host = draw(SERIES);
		const plot = sized(host);
		move(plot, 5);
		expect(tip(host).classList.contains("is-visible")).toBe(true);
		expect(tip(host).textContent).toBe("Nov 20 · 10 cards$1000.00");
		move(plot, 160);
		expect(tip(host).textContent).toBe("Nov 21 · 11 cards$1100.00");
		move(plot, 295);
		expect(tip(host).textContent).toBe("Nov 22 · 12 cards$1300.00");
	});

	it("says '1 card' for one", () => {
		const host = draw([pt("2026-11-21", 5, 1), pt("2026-11-22", 6, 2)]);
		move(sized(host), 0);
		expect(tip(host).textContent).toContain("· 1 card$");
	});

	it("puts the cursor line and the dot on that point", () => {
		const host = draw(SERIES);
		move(sized(host), 160);
		const line = host.querySelectorAll("svg line")[2];
		expect(line.getAttribute("x1")).toBe("150");
		expect(line.classList.contains("mtg-hidden")).toBe(false);
		const dot = host.querySelectorAll("svg circle")[1];
		expect(dot.getAttribute("cx")).toBe("150");
		expect(dot.classList.contains("mtg-hidden")).toBe(false);
	});

	it("anchors the tooltip on the left of the point, and flips it on the right edge so it never overflows", () => {
		const host = draw(SERIES);
		const plot = sized(host);
		move(plot, 5);
		expect(tip(host).style.left).toBe("0%");
		expect(tip(host).style.right).toBe("");
		move(plot, 295);
		expect(tip(host).style.left).toBe("");
		expect(tip(host).style.right).toBe("0%");
	});

	it("reads a position outside the drawing as its nearest end", () => {
		const host = draw(SERIES);
		const plot = sized(host);
		move(plot, -500);
		expect(tip(host).textContent).toContain("Nov 20");
		move(plot, 9999);
		expect(tip(host).textContent).toContain("Nov 22");
	});

	it("hides when the pointer leaves", () => {
		const host = draw(SERIES);
		const plot = sized(host);
		move(plot, 100);
		move(plot, 100, "pointerleave");
		expect(tip(host).classList.contains("is-visible")).toBe(false);
		expect(host.querySelectorAll("svg line")[2].classList.contains("mtg-hidden")).toBe(true);
		expect(host.querySelectorAll("svg circle")[1].classList.contains("mtg-hidden")).toBe(true);
	});

	it("a finger reads on touch-down and lets go when it lifts; a mouse stays until it leaves", () => {
		const host = draw(SERIES);
		const plot = sized(host);
		move(plot, 100, "pointerdown");
		expect(tip(host).classList.contains("is-visible")).toBe(true);
		plot.dispatchEvent(Object.assign(new MouseEvent("pointerup", { bubbles: true }), { pointerType: "touch" }));
		expect(tip(host).classList.contains("is-visible")).toBe(false);
		move(plot, 100);
		plot.dispatchEvent(Object.assign(new MouseEvent("pointerup", { bubbles: true }), { pointerType: "mouse" }));
		expect(tip(host).classList.contains("is-visible")).toBe(true);
	});

	it("does nothing while the chart has no width yet (not laid out)", () => {
		const host = draw(SERIES);
		move(host.querySelector(".mtg-value-chart-plot")!, 100);
		expect(tip(host).classList.contains("is-visible")).toBe(false);
	});
});
