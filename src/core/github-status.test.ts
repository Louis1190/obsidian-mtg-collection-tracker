import { describe, it, expect } from "vitest";
import { githubHomeStatus, GithubStatusInput } from "./github-status";

const clock = (ms: number) => `t${ms}`;
const base: GithubStatusInput = { enabled: true, configured: true, state: "idle", fatal: false, message: "", lastOkAt: 1000 };
const status = (over: Partial<GithubStatusInput>) => githubHomeStatus({ ...base, ...over }, clock);

describe("the GitHub line on Home", () => {
	it("shows nothing when the sync is off on this device", () => {
		expect(status({ enabled: false })).toBeNull();
		expect(status({ enabled: false, state: "error", fatal: true, message: "x" })).toBeNull();
	});

	it("says what is missing when it is on but not configured", () => {
		const s = status({ configured: false, state: "off", lastOkAt: 0 })!;
		expect(s.tone).toBe("warn");
		expect(s.text).toMatch(/repository and a token/);
	});

	it("says it is synced, and when it last checked", () => {
		expect(status({})).toEqual({ tone: "ok", text: "Synced with GitHub — checked at t1000" });
		expect(status({ state: "syncing" })!.tone).toBe("ok"); // a manual sync in progress is not a problem
	});

	it("says it is still starting before the first exchange", () => {
		expect(status({ state: "off", lastOkAt: 0 })).toEqual({ tone: "ok", text: "Syncing with GitHub…" });
		expect(status({ state: "syncing", lastOkAt: 0 })!.text).toBe("Syncing with GitHub…");
	});

	it("when GitHub does not answer: warns, reassures about the changes, gives the last success", () => {
		const s = status({ state: "error", message: "Could not reach GitHub [checking the version: …]", lastOkAt: 5000 })!;
		expect(s.tone).toBe("warn");
		expect(s.text).toContain("last synced at t5000");
		expect(s.text).toMatch(/kept on this device/);
		expect(s.text).not.toMatch(/checking the version/); // the technical cause stays in the settings
		expect(status({ state: "error", lastOkAt: 0 })!.text).not.toMatch(/last synced/); // never succeeded: nothing to quote
	});

	it("a lasting fault (token, repository) is an error that names the reason", () => {
		const s = status({ state: "error", fatal: true, message: "GitHub rejected the token (wrong, expired or revoked)." })!;
		expect(s.tone).toBe("error");
		expect(s.text).toBe("GitHub sync has stopped: GitHub rejected the token (wrong, expired or revoked). Open the settings to fix it.");
		expect(status({ state: "error", fatal: true, message: "" })!.text).toBe("GitHub sync has stopped. Open the settings to fix it.");
	});

	it("uses a real clock by default", () => {
		const s = githubHomeStatus({ ...base, lastOkAt: new Date(2026, 9, 5, 0, 46, 30).getTime() })!;
		expect(s.text).toMatch(/checked at .*46/);
	});
});
