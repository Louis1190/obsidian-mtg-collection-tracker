// The real entry of the card recognition (entry.ts): what the plugin's start asks of it. The look for a webcam itself is availability.ts's, tested there.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type MTGCollectionPlugin from "../plugin";

const h = vi.hoisted(() => ({ stopWatching: vi.fn(), watch: vi.fn() }));
vi.mock("obsidian", () => ({ Platform: { isMobileApp: false } }));
vi.mock("./availability", () => ({ watchWebcam: h.watch }));
vi.mock("./shared", () => ({ stopSharedCardRecognition: vi.fn(async () => {}) }));
vi.mock("./ui/fingerprint-base", () => ({ stopFingerprintBase: vi.fn() }));
vi.mock("./ui/add-cards-scan", () => ({ AddCardsScan: class {} }));
vi.mock("./ui/setting-rows", () => ({ cardRecognitionSettingRows: () => [] }));

import { startCardRecognition } from "./entry";

beforeEach(() => {
	h.stopWatching.mockReset();
	h.watch.mockReset();
	h.watch.mockReturnValue(h.stopWatching);
});

describe("startCardRecognition", () => {
	it("starts looking for a webcam and hands the plugin what stops the look, so it ends with the plugin", () => {
		const register = vi.fn();
		startCardRecognition({ register } as unknown as MTGCollectionPlugin);
		expect(h.watch).toHaveBeenCalledTimes(1);
		expect(register).toHaveBeenCalledTimes(1);
		expect(register).toHaveBeenCalledWith(h.stopWatching);
	});
});
