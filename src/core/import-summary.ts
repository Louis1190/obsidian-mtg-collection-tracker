// Le résumé d'un import de fichier, sans « Done: » ni point final (file-import.ts les ajoute) :
// « 12 added, 3 updated, 2 not found ». `updated` est absent pour l'import de decklist d'un deck (il n'y a
// que des ajouts) ; la dernière partie n'apparaît que s'il y a des lignes écartées, nommées par `missingLabel`
// (« not found » pour une carte que Scryfall ne connaît pas, « skipped » pour un CSV de deck).
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
