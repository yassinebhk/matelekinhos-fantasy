// Cloudflare Pages Function: /api/*  — identidad por Google + ataduras email↔equipo.
// El usuario inicia sesión con Google en la web (gratis, sin tarjeta). El frontend
// nos manda el idToken de Google; aquí lo VERIFICAMOS (con Google) y usamos el email
// verificado para atar cada persona a su equipo (por liga) y que nadie use el de otro.
//
//   POST /api/whoami {idToken}                 -> {ok, email, teams:{leagueId:equipo}}
//   POST /api/claim  {idToken, leagueId, team} -> ata el equipo (o error si ya es de otro)

const CLIENT_ID = "779450162006-4h3v5a03r1amtqkhonouhi82akglo7op.apps.googleusercontent.com";
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const norm = (s) => String(s || "").trim().toLowerCase();

async function verifyGoogle(idToken) {
  if (!idToken) return null;
  try {
    const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken));
    if (!r.ok) return null;
    const t = await r.json();
    if (t.aud !== CLIENT_ID) return null;                       // token de OTRA app
    if (t.exp && Number(t.exp) * 1000 < Date.now()) return null; // caducado
    if (t.email_verified === false || t.email_verified === "false") return null;
    return norm(t.email);
  } catch (e) { return null; }
}

export async function onRequest(context) {
  const { request, params, env } = context;
  const seg = Array.isArray(params.path) ? params.path[0] : params.path;
  const KV = env.FF_BINDINGS;
  try {
    if (seg === "health") return json({ ok: true, kv: !!KV });
    if (request.method !== "POST") return json({ error: "method" }, 405);
    const b = await request.json().catch(() => ({}));
    const email = await verifyGoogle(b.idToken);
    if (!email) return json({ error: "No pude verificar tu cuenta de Google. Vuelve a entrar." }, 401);
    if (!KV) return json({ error: "almacén no disponible" }, 500);

    if (seg === "whoami") {
      const teams = JSON.parse((await KV.get("u:" + email)) || "{}");
      return json({ ok: true, email, teams });
    }

    if (seg === "claim") {
      const lid = String(b.leagueId || ""), team = String(b.team || "");
      if (!lid || !team) return json({ error: "Falta la liga o el equipo." }, 400);
      const key = "t:" + lid + ":" + norm(team);
      const owner = await KV.get(key);
      if (owner && owner !== email) return json({ error: "Ese equipo ya lo tiene otra persona de la liga. Elige el tuyo." }, 409);
      const teams = JSON.parse((await KV.get("u:" + email)) || "{}");
      const prev = teams[lid];
      if (prev && norm(prev) !== norm(team)) {                  // cambió de equipo en esta liga: libera el anterior
        const pk = "t:" + lid + ":" + norm(prev);
        if ((await KV.get(pk)) === email) await KV.delete(pk);
      }
      await KV.put(key, email);
      teams[lid] = team;
      await KV.put("u:" + email, JSON.stringify(teams));
      return json({ ok: true, email, teams });
    }

    return json({ error: "not found" }, 404);
  } catch (e) {
    return json({ error: String((e && e.message) || e).slice(0, 160) }, 500);
  }
}
