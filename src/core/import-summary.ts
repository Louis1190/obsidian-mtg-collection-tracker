// The summary of a file import, without "Done: " or a final period (file-import.ts adds them): "12 added, 3
// updated, 2 not found". `updated` is absent for a deck's decklist import (there are only additions); the last
// part only appears if there are discarded lines, named by `missingLabel` ("not found" for a card Scryfall
// doesn't know, "skipped" for a deck CSV).
export function formatImportSummary(
	added: number,
	updated: number | undefined,
	missing: number,
	missingLabel: string
): string {
	const updatedPart = updated === undefined ? "" : `, ${updated} updated`;
	const missingPart = missing > 0 ? `, ${missing} ${missingLabel}` : "";
	return `${added} added${updatedPart}${missingPart}`;
}
