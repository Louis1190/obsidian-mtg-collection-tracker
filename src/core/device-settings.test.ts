import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS } from "./data-model";
import { DEVICE_LOCAL_KEYS, omitDeviceLocal, pickDeviceLocal } from "./device-settings";

describe("DEVICE_LOCAL_KEYS", () => {
	// A typo here wouldn't raise any error: the targeted key would simply stay synced
	// across devices. Hence this cross-check with the data model.
	it("only names settings that exist, with a plain (string/boolean) default", () => {
		for (const k of DEVICE_LOCAL_KEYS) {
			expect(Object.keys(DEFAULT_SETTINGS), `${k} is not a setting`).toContain(k);
			const type = typeof (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[k];
			expect(["string", "boolean"], `${k} is a ${type}`).toContain(type);
		}
	});

	it("keeps configuration (the settings tab) and data shared", () => {
		for (const k of [
			"collection",
			"decks",
			"lists",
			"wantlist",
			"wantlists",
			"savedSearchFilters",
			"accentColor",
			"priceCurrency",
			"customIconSvg",
			"cardbaseApiKey",
			"autoBackupIntervalHours",
			"priceRefreshIntervalHours",
		]) {
			expect(DEVICE_LOCAL_KEYS.has(k), k).toBe(false);
		}
	});
});

describe("omitDeviceLocal / pickDeviceLocal", () => {
	const s = { collection: [1], collectionViewMode: "card", navCollapsed: true, priceCurrency: "eur" };

	it("splits a settings object into what is synced and what stays on the device", () => {
		expect(omitDeviceLocal(s)).toEqual({ collection: [1], priceCurrency: "eur" });
		expect(pickDeviceLocal(s)).toEqual({ collectionViewMode: "card", navCollapsed: true });
	});

	it("does not mutate its input and shares the entity arrays", () => {
		const out = omitDeviceLocal(s);
		expect(out.collection).toBe(s.collection);
		expect(s.collectionViewMode).toBe("card");
	});

	it("skips a device-local key that is not set", () => {
		expect(pickDeviceLocal({ priceCurrency: "usd" })).toEqual({});
	});
});
