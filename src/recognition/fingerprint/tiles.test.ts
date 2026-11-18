import { describe, expect, it } from "vitest";
import type { ScryfallCard } from "../../api/scryfall";
import type { Match } from "./database";
import { buildFingerprintCards, CORNER_CHECK_SCORE, isNoMatch, MAX_FINGERPRINT_TILES, NEAR_TIE, NO_MATCH_SCORE, WEAK_SCORE, worthLookingUp } from "./tiles";

const match = (id: string, score: number): Match => ({ row: 0, id, score });
const card = (id: string, illustration: string | undefined): ScryfallCard => ({ id, name: "N", set: "s", collector_number: id, illustration_id: illustration }) as unknown as ScryfallCard;
const ids = (t: { cards: ScryfallCard[] } | null) => t?.cards.map((c) => c.id);

describe("isNoMatch / worthLookingUp", () => {
	it("is no match for nothing and for a best score above the bound", () => {
		expect(isNoMatch([])).toBe(true);
		expect(isNoMatch([match("a", NO_MATCH_SCORE + 0.1)])).toBe(true);
		expect(isNoMatch([match("a", NO_MATCH_SCORE - 0.1)])).toBe(false);
	});
	it("looks up the best always and the others only when within a near tie of it", () => {
		const m = [match("a", -14), match("b", -14 + NEAR_TIE), match("c", -14 + NEAR_TIE + 0.01)];
		expect(worthLookingUp(m).map((x) => x.id)).toEqual(["a", "b"]);
		expect(worthLookingUp([])).toEqual([]);
	});
});

describe("buildFingerprintCards", () => {
	it("shows the printings of the best illustration first, in the order of their look, then Scryfall's order", () => {
		const m = [match("A", -15)];
		const printings = [card("p1", "A"), card("p2", "A"), card("p3", "A"), card("p4", "A")];
		const t = buildFingerprintCards(m, printings, new Map([["p3", 0], ["p2", 1]]));
		expect(ids(t)).toEqual(["p3", "p2", "p1", "p4"]);
		expect(t?.note).toBe("4 editions of the card in your photo. Pick the one that matches your card.");
		expect(t?.weak).toBe(false);
	});

	it("puts the near tie's printings after the best's, and says so", () => {
		const m = [match("A", -15), match("B", -14.5), match("C", -9)];
		const printings = [card("b1", "B"), card("a1", "A"), card("c1", "C"), card("a2", "A")];
		const t = buildFingerprintCards(m, printings);
		expect(ids(t)).toEqual(["a1", "a2", "b1", "c1"]); // C is no near tie: after everything shown (its group is the 'other' one)
		expect(t?.note).toBe("4 editions of the cards that look like your photo. Pick the one that matches your card.");
	});

	it("is faint, and says it, when the best score is above the weak bound", () => {
		const weak = buildFingerprintCards([match("A", WEAK_SCORE + 0.5)], [card("a1", "A"), card("a2", "A")]);
		expect(weak?.weak).toBe(true);
		expect(weak?.note).toBe("2 editions of the possible cards from your photo, but they only partly match. Check them against your card.");
		const one = buildFingerprintCards([match("A", WEAK_SCORE + 0.5)], [card("a1", "A")]);
		expect(one?.note).toBe("1 possible card from your photo, but it only partly matches. Check it against your card.");
	});

	it("shows one printing as one possible card", () => {
		expect(buildFingerprintCards([match("A", -15)], [card("a1", "A")])?.note).toBe("1 possible card from your photo");
	});

	it("shows at most the limit, and nothing for nothing", () => {
		const many = Array.from({ length: MAX_FINGERPRINT_TILES + 10 }, (_, i) => card(`p${i}`, "A"));
		expect(buildFingerprintCards([match("A", -15)], many)?.cards.length).toBe(MAX_FINGERPRINT_TILES);
		expect(buildFingerprintCards([], [card("a", "A")])).toBeNull();
		expect(buildFingerprintCards([match("A", -15)], [])).toBeNull();
	});

	it("puts a printing of no known illustration last", () => {
		const t = buildFingerprintCards([match("A", -15)], [card("x", undefined), card("a1", "A")]);
		expect(ids(t)).toEqual(["a1", "x"]);
	});
});

describe("the corner's printing", () => {
	const cornerCard = (id: string, illustration: string | undefined, over: Partial<ScryfallCard> = {}): ScryfallCard => ({ ...card(id, illustration), set: "hob", collector_number: "1", ...over }) as ScryfallCard;

	it("is checked below a bound that sits between what the right cards score and what the base's wrong answers do", () => {
		// the right cards of the 49 real photos were -29 to -11.5, the wrong answers for a card the base does not hold -12.4 to -6: above the weak bound, below the no-match one
		expect(CORNER_CHECK_SCORE).toBeLessThan(WEAK_SCORE);
		expect(CORNER_CHECK_SCORE).toBeLessThan(NO_MATCH_SCORE);
		expect(CORNER_CHECK_SCORE).toBeLessThanOrEqual(-12.4);
	});

	it("goes first when it carries one of the illustrations found, and the picture is said to agree", () => {
		const t = buildFingerprintCards([match("A", -12)], [card("p1", "A"), card("p2", "A"), card("p3", "A")], new Map(), cornerCard("p3", "A"));
		expect(ids(t)).toEqual(["p3", "p1", "p2"]);
		expect(t?.note).toBe("Matched by the number printed on your card (HOB 1), and the picture agrees. Other editions follow.");
		expect(t?.weak).toBe(false);
	});

	it("goes first, and the person is asked to check, when it carries none of them (a card the base does not hold, or a number misread)", () => {
		const t = buildFingerprintCards([match("A", -9)], [card("p1", "A"), card("p2", "A")], new Map(), cornerCard("token", "T"));
		expect(ids(t)).toEqual(["token", "p1", "p2"]);
		expect(t?.note).toBe("Matched by the number printed on your card (HOB 1), but the picture does not confirm it. Check it against your card. Other editions follow.");
		expect(t?.weak).toBe(true);
	});

	it("counts an illustration of a near tie, and a face of a double-faced card, as found", () => {
		const near = buildFingerprintCards([match("A", -12), match("B", -11.5)], [card("a1", "A"), card("b1", "B")], new Map(), cornerCard("b1", "B"));
		expect(near?.weak).toBe(false);
		const faces = cornerCard("dfc", undefined, { card_faces: [{ illustration_id: "Z" }, { illustration_id: "A" }] });
		expect(buildFingerprintCards([match("A", -12)], [card("a1", "A")], new Map(), faces)?.weak).toBe(false);
		const far = buildFingerprintCards([match("A", -12), match("B", -9)], [card("a1", "A")], new Map(), cornerCard("b1", "B"));
		expect(far?.weak).toBe(true); // B is no near tie of A: it is not among the illustrations the picture found
	});

	it("is shown once, and alone with the others cut at the limit", () => {
		const many = Array.from({ length: MAX_FINGERPRINT_TILES + 5 }, (_, i) => card(`p${i}`, "A"));
		const t = buildFingerprintCards([match("A", -12)], many, new Map(), cornerCard("p7", "A"));
		expect(t?.cards.length).toBe(MAX_FINGERPRINT_TILES);
		expect(t?.cards.filter((c) => c.id === "p7")).toHaveLength(1);
		expect(t?.cards[0].id).toBe("p7");
		expect(buildFingerprintCards([match("A", -12)], [card("p1", "A")], new Map(), cornerCard("p1", "A"))?.note).toBe("Matched by the number printed on your card (HOB 1), and the picture agrees.");
	});

	it("changes nothing when there is none", () => {
		const m = [match("A", -12)];
		const printings = [card("p1", "A"), card("p2", "A")];
		expect(buildFingerprintCards(m, printings, new Map(), null)).toEqual(buildFingerprintCards(m, printings));
	});
});
