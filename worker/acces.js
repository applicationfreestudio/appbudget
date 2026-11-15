// App Budget — demandes d'accès pour la saisie de dépenses
// Une personne qui a le lien de consultation (/recap/<code>) peut demander l'accès (nom, prénom, adresse mail).
// Son navigateur garde un secret aléatoire « k » ; le serveur n'en garde que l'empreinte (kh).
// L'administrateur accepte, refuse ou révoque depuis l'application. Une fois acceptée, la personne envoie
// ses dépenses avec « Authorization: Bearer <id>.<k> » ; elles attendent dans acces/saisies/ que l'application les intègre.

import { sha, notifyAll, vapidKeys } from "./push.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
const rid = (n = 12) => {
  const a = "abcdefghijkmnpqrstuvwxyz23456789", b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => a[x % a.length]).join("");
};
const str = (v, max) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const IDRE = /^[a-z0-9]{12}$/;
const put = (env, key, o) => env.FILES.put(key, JSON.stringify(o), { httpMetadata: { contentType: "application/json" } });
async function getJson(env, key) { const o = await env.FILES.get(key); return o ? await o.json() : null; }
const pub = (d) => ({ id: d.id, nom: d.nom, prenom: d.prenom, email: d.email, at: d.at, status: d.status, decidedAt: d.decidedAt || null, last: d.last || null });
const subject = (url) => "mailto:notifications@" + url.hostname;

async function readBody(request, max = 8192) {
  const t = await request.text();
  if (t.length > max) throw new Error("trop volumineux");
  return JSON.parse(t || "{}");
}

// Personne autorisée à saisir (jeton « id.k »)
async function delegate(request, env) {
  const h = request.headers.get("Authorization") || "";
  const m = h.match(/^Bearer ([a-z0-9]{12})\.([A-Za-z0-9_-]{20,100})$/);
  if (!m) return null;
  const d = await getJson(env, `acces/demandes/${m[1]}.json`);
  if (!d || d.kh !== (await sha(m[2]))) return null;
  return d;
}

// Routes publiques, sous /recap/<code>/… (le code du lien a déjà été vérifié)
export async function recapAcces(request, env, url, rest, ctx) {
  // nouvelle demande
  if (rest === "acces" && request.method === "POST") {
    let b;
    try { b = await readBody(request, 2048); } catch (_) { return json({ error: "demande invalide" }, 400); }
    const nom = str(b.nom, 80), prenom = str(b.prenom, 80), email = str(b.email, 200).toLowerCase(), k = String(b.k || "");
    if (!nom || !prenom) return json({ error: "nom et prénom obligatoires" }, 400);
    if (!EMAIL.test(email)) return json({ error: "adresse mail invalide" }, 400);
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(k)) return json({ error: "demande invalide" }, 400);
    const list = await env.FILES.list({ prefix: "acces/demandes/" });
    if (list.objects.length >= 200) return json({ error: "trop de demandes enregistrées" }, 429);
    let attente = 0;
    for (const o of list.objects) { const d = await getJson(env, o.key); if (d && d.status === "attente") attente++; }
    if (attente >= 20) return json({ error: "trop de demandes en attente, réessaie plus tard" }, 429);
    const d = { id: rid(), nom, prenom, email, kh: await sha(k), at: new Date().toISOString(), status: "attente" };
    await put(env, `acces/demandes/${d.id}.json`, d);
    ctx.waitUntil(notifyAll(env, { title: "Demande d'accès", body: `${prenom} ${nom} (${email}) demande à saisir des dépenses.`, url: "/#parametres", tag: "acces-" + d.id }, subject(url)));
    return json({ id: d.id, status: d.status });
  }
  // état de sa propre demande : GET /recap/<code>/acces/<id> avec « Authorization: Bearer <id>.<k> »
  let m = rest.match(/^acces\/([a-z0-9]{12})$/);
  if (m && request.method === "GET") {
    const d = await delegate(request, env);
    if (!d || d.id !== m[1]) return json({ error: "demande introuvable" }, 404);
    return json({ id: d.id, nom: d.nom, prenom: d.prenom, email: d.email, status: d.status, at: d.at });
  }
  // saisie d'une dépense
  if (rest === "saisie" && request.method === "POST") {
    const d = await delegate(request, env);
    if (!d) return json({ error: "accès non reconnu" }, 401);
    if (d.status !== "active") return json({ error: d.status === "revoquee" ? "accès révoqué" : "accès pas encore accordé" }, 403);
    let b;
    try { b = await readBody(request, 8192); } catch (_) { return json({ error: "dépense invalide" }, 400); }
    const x = b.d || {};
    const montant = Math.round(Number(x.montant) * 100) / 100;
    if (!(montant > 0 && montant < 1e6)) return json({ error: "montant invalide" }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(x.date || ""))) return json({ error: "date invalide" }, 400);
    const dep = {
      date: String(x.date), montant, tiers: str(x.tiers, 200), objet: str(x.objet, 200), compte: str(x.compte, 20), nature: str(x.nature, 200),
      pay: str(x.pay, 40), cheque: str(x.cheque, 40), per: str(x.per, 40), nf: !!x.nf,
    };
    if (!dep.compte) return json({ error: "compte manquant" }, 400);
    const at = new Date().toISOString();
    const key = `acces/saisies/${Date.now()}-${d.id}-${rid(6)}.json`;
    await put(env, key, { by: { id: d.id, nom: d.nom, prenom: d.prenom, email: d.email }, at, d: dep });
    d.last = at;
    await put(env, `acces/demandes/${d.id}.json`, d);
    ctx.waitUntil(notifyAll(env, { title: "Nouvelle dépense", body: `${d.prenom} ${d.nom} : ${dep.tiers || dep.objet || "dépense"} · ${montant.toLocaleString("fr-FR", { style: "currency", currency: "EUR" })}`, url: "/#regie", tag: "saisie" }, subject(url)));
    return json({ ok: true, key: key.split("/").pop() });
  }
  // demande d'augmentation du prévisionnel d'une période (dépense bloquée)
  if (rest === "prev" && request.method === "POST") {
    const d = await delegate(request, env);
    if (!d) return json({ error: "accès non reconnu" }, 401);
    if (d.status !== "active") return json({ error: "accès pas accordé" }, 403);
    let b;
    try { b = await readBody(request, 2048); } catch (_) { return json({ error: "demande invalide" }, 400); }
    const montant = Math.round(Number(b.montant) * 100) / 100, reste = Math.round(Number(b.reste) * 100) / 100;
    const o = { by: { id: d.id, nom: d.nom, prenom: d.prenom, email: d.email }, at: new Date().toISOString(), per: str(b.per, 40), nom: str(b.nom, 120), montant: montant > 0 ? montant : 0, reste: isFinite(reste) ? reste : 0, tiers: str(b.tiers, 120) };
    if (!o.per) return json({ error: "période manquante" }, 400);
    const list = await env.FILES.list({ prefix: "acces/prev/" });
    if (list.objects.length >= 100) return json({ error: "trop de demandes en attente" }, 429);
    await put(env, `acces/prev/${Date.now()}-${d.id}-${rid(6)}.json`, o);
    const eur = (x) => x.toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
    ctx.waitUntil(notifyAll(env, { title: "Prévisionnel à augmenter", body: `${d.prenom} ${d.nom} : ${o.nom}, dépense de ${eur(o.montant)} bloquée (reste ${eur(o.reste)}).`, url: "/#parametres", tag: "prev" }, subject(url)));
    return json({ ok: true });
  }
  return null;
}

// Routes de l'administrateur, sous /api/… (jeton APP_TOKEN déjà vérifié)
export async function apiAcces(request, env, url, path, ctx) {
  if (path === "acces" && request.method === "GET") {
    const list = await env.FILES.list({ prefix: "acces/demandes/" });
    const out = [];
    for (const o of list.objects) { const d = await getJson(env, o.key); if (d) out.push(pub(d)); }
    out.sort((a, b) => b.at.localeCompare(a.at));
    return json({ demandes: out });
  }
  let m = path.match(/^acces\/([a-z0-9]{12})$/);
  if (m && request.method === "POST") {
    const key = `acces/demandes/${m[1]}.json`, d = await getJson(env, key);
    if (!d) return json({ error: "demande introuvable" }, 404);
    let b;
    try { b = await readBody(request, 1024); } catch (_) { return json({ error: "requête invalide" }, 400); }
    const a = b.action;
    if (a === "supprimer") { await env.FILES.delete(key); return json({ ok: true }); }
    const st = { accepter: "active", refuser: "refusee", revoquer: "revoquee" }[a];
    if (!st) return json({ error: "action inconnue" }, 400);
    d.status = st;
    d.decidedAt = new Date().toISOString();
    await put(env, key, d);
    return json({ ok: true, demande: pub(d) });
  }
  // notifications : clé publique, abonnement d'un appareil, test
  if (path === "push/key" && request.method === "GET") return json({ key: (await vapidKeys(env)).pub });
  if (path === "push/sub" && (request.method === "POST" || request.method === "DELETE")) {
    let b;
    try { b = await readBody(request, 4096); } catch (_) { return json({ error: "requête invalide" }, 400); }
    const s = b.sub || {};
    if (!/^https:\/\//.test(String(s.endpoint || ""))) return json({ error: "abonnement invalide" }, 400);
    const key = `acces/push/${await sha(s.endpoint)}.json`;
    if (request.method === "DELETE") { await env.FILES.delete(key); return json({ ok: true }); }
    if (!s.keys || !s.keys.p256dh || !s.keys.auth) return json({ error: "abonnement invalide" }, 400);
    await put(env, key, { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, at: new Date().toISOString(), ua: str(request.headers.get("User-Agent"), 200) });
    return json({ ok: true });
  }
  if (path === "push/test" && request.method === "POST") {
    const n = await notifyAll(env, { title: "App Budget", body: "Les notifications fonctionnent sur cet appareil.", url: "/#parametres", tag: "test" }, subject(url));
    return json({ ok: true, envoyes: n });
  }
  return null;
}
