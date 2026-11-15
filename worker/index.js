// App Budget — Worker Cloudflare
// - sert l'application (dossier public/, via le binding ASSETS)
// - expose /api/* pour stocker les fichiers dans R2 (binding FILES)
// Authentification : en-tête "Authorization: Bearer <APP_TOKEN>" (ou ?token= pour ouvrir un fichier).

import { recapAcces, apiAcces } from "./acces.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

// Comparaison à temps constant pour le jeton
function sameToken(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function authorized(request, env, url) {
  const h = request.headers.get("Authorization") || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : url.searchParams.get("token") || "";
  return !!env.APP_TOKEN && sameToken(tok, env.APP_TOKEN);
}

// Clés autorisées : lettres, chiffres, espaces et . _ - / (pas de "..")
function cleanKey(raw) {
  const key = decodeURIComponent(raw).replace(/^\/+/, "");
  if (!key || key.length > 512 || key.includes("..") || !/^[\p{L}\p{N} ._\-\/()]+$/u.test(key)) return null;
  return key;
}

const MAX_SIZE = 25 * 1024 * 1024; // 25 Mo par fichier

async function api(request, env, url, ctx) {
  const path = url.pathname.replace(/^\/api\/?/, "");

  if (path === "health") {
    // diagnostic : noms des variables présentes (jamais leurs valeurs)
    const names = Object.keys(env).filter((k) => !["ASSETS", "FILES"].includes(k));
    return json({ app: "appbudget", ok: true, storage: !!env.FILES, token: !!env.APP_TOKEN, variables: names });
  }
  if (!env.FILES) return json({ error: "stockage R2 non relié (binding FILES)" }, 503);
  if (!env.APP_TOKEN) return json({ error: "secret APP_TOKEN non défini" }, 503);
  if (!authorized(request, env, url)) return json({ error: "non autorisé" }, 401);

  // demandes d'accès et notifications
  const ac = await apiAcces(request, env, url, path, ctx);
  if (ac) return ac;

  // Liste : GET /api/files?prefix=...
  if (path === "files" && request.method === "GET") {
    const prefix = url.searchParams.get("prefix") || undefined;
    const files = [];
    let cursor;
    do {
      const page = await env.FILES.list({ prefix, cursor, limit: 1000 });
      for (const o of page.objects) files.push({ key: o.key, size: o.size, uploaded: o.uploaded.toISOString() });
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return json({ files });
  }

  if (!path.startsWith("files/")) return json({ error: "introuvable" }, 404);
  const key = cleanKey(path.slice(6));
  if (!key) return json({ error: "nom de fichier invalide" }, 400);

  switch (request.method) {
    case "GET": {
      const obj = await env.FILES.get(key);
      if (!obj) return json({ error: "fichier absent" }, 404);
      const headers = new Headers({ "Cache-Control": "no-store" });
      obj.writeHttpMetadata(headers);
      headers.set("ETag", obj.httpEtag);
      return new Response(obj.body, { headers });
    }
    case "PUT": {
      const len = Number(request.headers.get("Content-Length") || 0);
      if (len > MAX_SIZE) return json({ error: "fichier trop volumineux (25 Mo max)" }, 413);
      const obj = await env.FILES.put(key, request.body, {
        httpMetadata: { contentType: request.headers.get("Content-Type") || "application/octet-stream" },
      });
      return json({ ok: true, key, size: obj.size });
    }
    case "DELETE":
      await env.FILES.delete(key);
      return json({ ok: true, key });
    default:
      return json({ error: "méthode non autorisée" }, 405);
  }
}

// Page de consultation en lecture seule : /recap/<code>
// Le code est choisi depuis l'application (fichier R2 partage/code.json) ; un mauvais code donne une page introuvable.
async function recap(request, env, url, ctx) {
  const nf = () => new Response("Page introuvable.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "X-Robots-Tag": "noindex" } });
  const m = url.pathname.match(/^\/recap\/([A-Za-z0-9_-]{16,64})(?:\/(.*))?$/);
  if (!m || !env.FILES) return nf();
  const rest = (m[2] || "").replace(/\/+$/, "");
  if (!rest && request.method !== "GET") return nf();
  const ref = await env.FILES.get("partage/code.json");
  if (!ref) return nf();
  let code = "";
  try { code = (await ref.json()).code || ""; } catch (_) {}
  if (!code || !sameToken(m[1], code)) return nf();
  // demandes d'accès et saisie de dépenses par les personnes autorisées
  if (rest) return (await recapAcces(request, env, url, rest, ctx)) || nf();
  if (url.searchParams.has("data")) {
    const obj = await env.FILES.get("etat/courant.json");
    if (!obj) return json({ error: "aucune donnée enregistrée" }, 404);
    return new Response(obj.body, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
  }
  const page = await env.ASSETS.fetch(new Request(new URL("/", url)));
  const html = (await page.text()).replace("<head>", '<head><base href="/"><meta name="robots" content="noindex,nofollow">');
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      try {
        return await api(request, env, url, ctx);
      } catch (e) {
        return json({ error: "erreur interne", detail: String(e && e.message || e) }, 500);
      }
    }
    if (url.pathname.startsWith("/recap/")) {
      try { return await recap(request, env, url, ctx); } catch (e) { return json({ error: "erreur interne" }, 500); }
    }
    return env.ASSETS.fetch(request);
  },
};
