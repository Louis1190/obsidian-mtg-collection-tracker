// The settings row of the card recognition, moved out of setting-tab.ts (docs/history/public-stubs-plan.md, phase 2): same name, same search words, same behaviour on the toggle.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type MTGCollectionPlugin from "../../plugin";

const h = vi.hoisted(() => ({ stopShared: vi.fn(), stopBase: vi.fn(), available: vi.fn(() => true) }));
vi.mock("../shared", () => ({ stopSharedCardRecognition: h.stopShared }));
vi.mock("./fingerprint-base", () => ({ stopFingerprintBase: h.stopBase }));
vi.mock("../availability", () => ({ cardRecognitionAvailable: h.available }));

import { cardRecognitionSettingRows } from "./setting-rows";

function fakePlugin(enabled: boolean) {
	return { settings: { cardRecognitionEnabled: enabled }, saveSettings: vi.fn(async () => {}) };
}

/** Draws the row on a fake Setting and answers the toggle the row created. */
function draw(plugin: ReturnType<typeof fakePlugin>) {
	const row = cardRecognitionSettingRows(plugin as unknown as MTGCollectionPlugin)[0];
	const toggle = {
		value: undefined as boolean | undefined,
		change: undefined as ((v: boolean) => Promise<void>) | undefined,
		setValue(v: boolean) {
			this.value = v;
			return this;
		},
		onChange(fn: (v: boolean) => Promise<void>) {
			this.change = fn;
			return this;
		},
	};
	const setting = { addToggle: (cb: (t: typeof toggle) => unknown) => (cb(toggle), setting) };
	row.render?.(setting as never);
	return { row, toggle };
}

beforeEach(() => {
	h.stopShared.mockReset();
	h.stopBase.mockReset();
	h.available.mockReset();
	h.available.mockReturnValue(true);
});

describe("the \"Card recognition (beta)\" row", () => {
	it("is the only row, named and findable as before", () => {
		const rows = cardRecognitionSettingRows(fakePlugin(false) as unknown as MTGCollectionPlugin);
		expect(rows).toHaveLength(1);
		expect(rows[0].name).toBe("Card recognition (beta)");
		expect(rows[0].aliases).toEqual(["photo", "camera", "scan", "ocr", "recognise", "recognize", "picture"]);
		expect(rows[0].desc).toMatch(/^Add a card from a photo: a camera button appears in "Add cards"\./);
	});

	it("is drawn and found by the settings search on a phone or tablet, and neither on a computer (phones and tablets only for now)", () => {
		const row = cardRecognitionSettingRows(fakePlugin(true) as unknown as MTGCollectionPlugin)[0];
		const searchable = row.searchable as () => boolean;
		expect(row.visible?.()).toBe(true);
		expect(searchable()).toBe(true);
		h.available.mockReturnValue(false);
		// read again at each draw and each search, not once when the rows are listed
		expect(row.visible?.()).toBe(false);
		expect(searchable()).toBe(false);
	});

	it("says that the photo is let go once read", () => {
		expect(cardRecognitionSettingRows(fakePlugin(false) as unknown as MTGCollectionPlugin)[0].desc).toMatch(/is let go as soon as it has been read/);
	});

	it("shows the device's current value", () => {
		expect(draw(fakePlugin(true)).toggle.value).toBe(true);
		expect(draw(fakePlugin(false)).toggle.value).toBe(false);
	});

	it("turning it on saves the setting and stops nothing", async () => {
		const plugin = fakePlugin(false);
		const { toggle } = draw(plugin);
		await toggle.change?.(true);
		expect(plugin.settings.cardRecognitionEnabled).toBe(true);
		expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
		expect(h.stopShared).not.toHaveBeenCalled();
		expect(h.stopBase).not.toHaveBeenCalled();
	});

	it("turning it off saves the setting, then lets go of the reader and the base", async () => {
		const plugin = fakePlugin(true);
		const { toggle } = draw(plugin);
		await toggle.change?.(false);
		expect(plugin.settings.cardRecognitionEnabled).toBe(false);
		expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
		expect(h.stopShared).toHaveBeenCalledTimes(1);
		expect(h.stopBase).toHaveBeenCalledWith(plugin);
	});
});
