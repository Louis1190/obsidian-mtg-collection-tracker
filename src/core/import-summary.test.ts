import { describe, expect, it } from "vitest";
import { formatImportSummary } from "./import-summary";

describe("formatImportSummary", () => {
	it("says how many were added and updated, and nothing about missing lines when there are none", () => {
		expect(formatImportSummary(12, 3, 0, "not found")).toBe("12 added, 3 updated");
	});

	it("appends the missing count with the label of the import", () => {
		expect(formatImportSummary(12, 3, 2, "not found")).toBe("12 added, 3 updated, 2 not found");
		expect(formatImportSummary(0, 0, 5, "skipped")).toBe("0 added, 0 updated, 5 skipped");
	});

	it("leaves out the updated part when the import only adds (decklist into a deck)", () => {
		expect(formatImportSummary(60, undefined, 0, "not found")).toBe("60 added");
		expect(formatImportSummary(58, undefined, 2, "not found")).toBe("58 added, 2 not found");
	});
});
