// App Budget — notifications Web Push (RFC 8030 / 8291 / 8292), sans dépendance.
// Les clés VAPID sont créées au premier usage et gardées dans R2 (acces/vapid.json).
// Les abonnements des appareils de l'administrateur sont dans acces/push/<empreinte>.json.

const enc = new TextEncoder();
export const b64u = (buf) => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const unb64u = (s) => {
  const t = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "===".slice((t.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const concat = (...a) => {
  const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of a) { out.set(x, o); o += x.length; }
  return out;
};
export async function sha(text) {
  return b64u(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}

// Clés VAPID (ECDSA P-256) : publique au format brut (65 octets, base64url), privée en JWK
export async function vapidKeys(env) {
  const o = await env.FILES.get("acces/vapid.json");
  if (o) return await o.json();
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const v = { pub: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)), jwk: await crypto.subtle.exportKey("jwk", kp.privateKey) };
  await env.FILES.put("acces/vapid.json", JSON.stringify(v), { httpMetadata: { contentType: "application/json" } });
  return v;
}

async function vapidAuth(endpoint, v, subject) {
  const aud = new URL(endpoint).origin;
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", v.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + body));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${v.pub}`;
}

// Chiffrement du message pour l'appareil (aes128gcm, RFC 8291)
export async function encryptPayload(sub, text) {
  const uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, ecdh, concat(enc.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const k = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, k, concat(enc.encode(text), new Uint8Array([2]))));
  const head = new Uint8Array(21);
  head.set(salt, 0);
  new DataView(head.buffer).setUint32(16, 4096);
  head[20] = asPub.length;
  return concat(head, asPub, ct);
}

// Envoie un message à tous les appareils abonnés ; supprime les abonnements expirés
// prefix : appareils de l'administrateur (par défaut) ou d'une personne autorisée (acces/dpush/<id>/)
export async function notifyAll(env, msg, subject, prefix = "acces/push/") {
  if (!env.FILES) return 0;
  const list = await env.FILES.list({ prefix });
  if (!list.objects.length) return 0;
  const v = await vapidKeys(env);
  let n = 0;
  await Promise.all(list.objects.map(async (o) => {
    try {
      const sub = await (await env.FILES.get(o.key)).json();
      const body = await encryptPayload(sub, JSON.stringify(sub.url ? { ...msg, url: sub.url } : msg));
      const r = await fetch(sub.endpoint, {
        method: "POST",
        headers: { Authorization: await vapidAuth(sub.endpoint, v, subject), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "86400", Urgency: "high" },
        body,
      });
      if (r.status === 404 || r.status === 410) await env.FILES.delete(o.key);
      else if (r.ok) n++;
    } catch (_) {}
  }));
  return n;
}
