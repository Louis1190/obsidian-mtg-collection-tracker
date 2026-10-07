import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";

/* -------------------------------------------------------------------------- */
/*  requestUrl qui ne lève jamais                                             */
/* -------------------------------------------------------------------------- */
// `requestUrl({ throw: false })` ne couvre que les statuts HTTP (404, 429, 500…) : une erreur de TRANSPORT — hors ligne, DNS,
// pare-feu ou inspection TLS d'un réseau d'entreprise, portail captif — fait quand même rejeter la promesse. Les fetchers des
// sources de données (cardbase, Card Kingdom, Mana Pool) promettent « une valeur d'échec, jamais une exception » (undefined
// ou Map vide : l'interface a une branche pour ça, « — » ou « No price history available yet. ») ; sans ceci, la promesse
// rejetée n'arrivait jamais jusqu'à cette branche : le cadre restait sur ses points de chargement, et pour les tarifs Card
// Kingdom / Mana Pool la promesse REJETÉE restait en cache pour toute la session.
// Renvoie null à la place de la réponse quand la requête n'a pas pu aboutir : l'appelant traite null comme n'importe quel
// échec (le même chemin qu'un statut non 200).
export async function requestUrlOrNull(params: Omit<RequestUrlParam, "throw">): Promise<RequestUrlResponse | null> {
	try {
		return await requestUrl({ ...params, throw: false });
	} catch {
		return null;
	}
}
