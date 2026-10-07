import { describe, it, expect } from "vitest";
import { detectDeckCardFunction, deckFunctionSortKey, DECK_FUNCTION_CATEGORIES } from "./deck-function";

describe("detectDeckCardFunction", () => {
	it("returns undefined when nothing matches and there are no evasion keywords", () => {
		expect(
			detectDeckCardFunction({ typeLine: "Creature — Human", oracleText: "A perfectly vanilla bear." })
		).toBeUndefined();
	});

	it("classifies a land as Land regardless of what its own text says", () => {
		// Un fetchland matcherait aussi le motif Ramp (search your library
		// for ... land card) — Land doit toujours l'emporter pour ce type.
		expect(
			detectDeckCardFunction({
				typeLine: "Land",
				oracleText: "{T}, Sacrifice this: Search your library for a basic land card, put it onto the battlefield.",
			})
		).toBe("Land");
	});

	it("detects a counterspell", () => {
		expect(
			detectDeckCardFunction({ typeLine: "Instant", oracleText: "Counter target spell." })
		).toBe("Counterspell");
	});

	it("detects removal via destroy/exile target or -X/-X", () => {
		expect(
			detectDeckCardFunction({ typeLine: "Instant", oracleText: "Destroy target creature." })
		).toBe("Removal");
		expect(
			detectDeckCardFunction({ typeLine: "Sorcery", oracleText: "Exile target artifact." })
		).toBe("Removal");
		expect(
			detectDeckCardFunction({ typeLine: "Instant", oracleText: "Target creature gets -3/-3 until end of turn." })
		).toBe("Removal");
	});

	it("detects tokens", () => {
		expect(
			detectDeckCardFunction({ typeLine: "Sorcery", oracleText: "Create two 1/1 white Soldier creature tokens." })
		).toBe("Tokens");
	});

	it("detects +1/+1 counters and proliferate", () => {
		expect(
			detectDeckCardFunction({ typeLine: "Creature — Elf", oracleText: "Put a +1/+1 counter on target creature." })
		).toBe("Counters");
		expect(detectDeckCardFunction({ typeLine: "Instant", oracleText: "Proliferate." })).toBe("Counters");
	});

	it("detects reanimation", () => {
		expect(
			detectDeckCardFunction({
				typeLine: "Sorcery",
				oracleText: "Return target creature card from your graveyard to the battlefield.",
			})
		).toBe("Reanimation");
	});

	it("detects sacrifice synergy", () => {
		expect(
			detectDeckCardFunction({ typeLine: "Instant", oracleText: "As an additional cost, sacrifice a creature." })
		).toBe("Sacrifice");
	});

	it("detects ramp via land-tutoring or a plain mana ability, ahead of the broader Tutor rule", () => {
		expect(
			detectDeckCardFunction({
				typeLine: "Sorcery",
				oracleText: "Search your library for a basic land card, put it onto the battlefield tapped.",
			})
		).toBe("Ramp");
		expect(detectDeckCardFunction({ typeLine: "Artifact", oracleText: "{T}: Add {C}." })).toBe("Ramp");
	});

	it("detects a non-land tutor", () => {
		expect(
			detectDeckCardFunction({ typeLine: "Sorcery", oracleText: "Search your library for a creature card." })
		).toBe("Tutor");
	});

	it("detects card draw", () => {
		expect(detectDeckCardFunction({ typeLine: "Sorcery", oracleText: "Draw two cards." })).toBe("Draw");
	});

	it("detects discard", () => {
		expect(
			detectDeckCardFunction({ typeLine: "Sorcery", oracleText: "Target player discards two cards." })
		).toBe("Discard");
	});

	it("detects mill", () => {
		expect(
			detectDeckCardFunction({ typeLine: "Sorcery", oracleText: "Target player mills five cards." })
		).toBe("Mill");
	});

	it("detects lifegain", () => {
		expect(detectDeckCardFunction({ typeLine: "Instant", oracleText: "You gain 4 life." })).toBe("Lifegain");
	});

	it("falls back to Evasion when only a keyword matches and no rule does", () => {
		expect(
			detectDeckCardFunction({
				typeLine: "Creature — Bird",
				oracleText: "Flying",
				keywords: ["Flying"],
			})
		).toBe("Evasion");
	});

	it("prefers an earlier-priority functional match over a later evasion keyword", () => {
		expect(
			detectDeckCardFunction({
				typeLine: "Creature — Dragon",
				oracleText: "Flying. Draw a card.",
				keywords: ["Flying"],
			})
		).toBe("Draw");
	});
});

describe("deckFunctionSortKey", () => {
	it("orders known categories in DECK_FUNCTION_CATEGORIES order, unknowns last", () => {
		const land = deckFunctionSortKey("Land");
		const ramp = deckFunctionSortKey("Ramp");
		const other = deckFunctionSortKey("Not A Real Category");
		expect(land.localeCompare(ramp)).toBeLessThan(0);
		expect(ramp.localeCompare(other)).toBeLessThan(0);
	});

	it("matches DECK_FUNCTION_CATEGORIES' own declared order", () => {
		const sorted = [...DECK_FUNCTION_CATEGORIES].sort((a, b) =>
			deckFunctionSortKey(a).localeCompare(deckFunctionSortKey(b))
		);
		expect(sorted).toEqual(DECK_FUNCTION_CATEGORIES as unknown as string[]);
	});
});
