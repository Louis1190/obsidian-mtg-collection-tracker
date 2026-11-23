import { computeCollectionValue, localDayKey, readValuePoints, recordValuePoint } from "../core/value-history";
import type MTGCollectionPlugin from "../plugin";

/* -------------------------------------------------------------------------- */
/* When the value of the collection is written down (MTGCollectionPlugin, this-parameter functions wired in plugin.ts).
   The data and the rules are core/value-history.ts; the curve is drawn by ui/value-history-chart.ts. */
/* -------------------------------------------------------------------------- */

// Writes today's point from the prices now stored on the cards. Called by refreshAllPrices once it has applied the
// fresh prices (so the point is as fresh as the data can be). Does NOT save: the caller does, once. Returns whether the
// history changed.
export function recordCollectionValue(this: MTGCollectionPlugin, now: number = Date.now()): boolean {
	// What is stored may come from a file written elsewhere: it is read through the validator first, so a malformed
	// entry can neither break the write nor be copied on.
	const history = readValuePoints(this.settings.valueHistory);
	if (!recordValuePoint(history, localDayKey(now), computeCollectionValue(this.settings.collection), now)) return false;
	this.settings.valueHistory = history;
	return true;
}

// The first start after the update: there is no history yet, but the cards already carry prices from the last refresh,
// so that refresh's day gets its point right away and the curve has two ends from the second day on, instead of waiting a
// full refresh interval for its first point. Does nothing once any point exists (so it never runs twice, and never on a
// device that received a history from another one), nor for a collection with no refresh date or no card. Saves.
export function seedValueHistory(this: MTGCollectionPlugin, now: number = Date.now()): boolean {
	if (readValuePoints(this.settings.valueHistory).length > 0) return false;
	const refreshedAt = this.settings.lastPriceRefresh;
	if (!(refreshedAt > 0)) return false;
	const history = readValuePoints(undefined);
	if (!recordValuePoint(history, localDayKey(refreshedAt), computeCollectionValue(this.settings.collection), now)) return false;
	this.settings.valueHistory = history;
	void this.saveSettings();
	return true;
}
