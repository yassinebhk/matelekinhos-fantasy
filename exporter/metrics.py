"""
Capa DERIVE: transforma snapshots crudos en el JSON que consume la web.

Los nombres de campo estan verificados contra el cliente de referencia
(Externoak/LaLigaApp, temporada 26/27) y su equivalente 25/26. Aun asi cada
lectura usa pick() con varios candidatos por si LaLiga renombra algo: si en tu
primera ejecucion ves un campo vacio, abre fantasy.db, mira el nombre real en
el JSON crudo de la tabla 'snapshots' y anadelo a la lista de candidatos.

Todo se calcula LEYENDO EL HISTORICO de snapshots, asi que cuantas mas fotos
acumule el cron, mas ricas son las tendencias, movers y rachas.
"""

from __future__ import annotations
import re
import unicodedata
import datetime as dt

POS = {1: "POR", 2: "DEF", 3: "MED", 4: "DEL", 5: "ENT"}   # 5 = entrenador


def norm_name(s):
    s = unicodedata.normalize("NFKD", str(s or "").lower()).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9 ]", "", s).strip()


def make_index(items, name_of, key_of):
    """Índice de emparejado: por nombre normalizado exacto y por apellido (deduplicado)."""
    by_norm, by_sur = {}, {}
    for it in items:
        for nm in name_of(it):
            n = norm_name(nm)
            if not n:
                continue
            by_norm.setdefault(n, it)
            by_sur.setdefault(n.split()[-1], {})[str(key_of(it))] = it
    return {"byNorm": by_norm, "bySur": {s: list(v.values()) for s, v in by_sur.items()}}


def index_match(idx, name):
    """Coincidencia PRECISA: nombre exacto, o por apellido SOLO si es único (no adivina)."""
    q = norm_name(name)
    if not q:
        return None
    if q in idx["byNorm"]:
        return idx["byNorm"][q]
    cands = idx["bySur"].get(q.split()[-1], [])
    return cands[0] if len(cands) == 1 else None


def build_ff_index(store):
    """Índice de futbolfantasy (valor, histórico, tendencia, aceleración)."""
    return make_index([p for p in as_list(store.latest("fftrends")) if p.get("name")],
                      name_of=lambda r: [r.get("name")],
                      key_of=lambda r: r.get("ffId") or r.get("name"))


def ff_match(ff_index, nickname):
    return index_match(ff_index, nickname)


def photo_of(laliga_image, ff_rec):
    """Devuelve (oficial, url). Si LaLiga aún no tiene foto real (silueta 'no-player'),
    cae a la foto de futbolfantasy. oficial=True indica que hay PNG local descargado."""
    if laliga_image and "no-player" not in laliga_image:
        return True, laliga_image
    return False, (ff_rec.get("img") if ff_rec else None)


def pick(d, *keys, default=None):
    """Devuelve el primer campo existente (soporta rutas 'a.b.c')."""
    if not isinstance(d, dict):
        return default
    for k in keys:
        cur, ok = d, True
        for part in k.split("."):
            if isinstance(cur, dict) and part in cur:
                cur = cur[part]
            else:
                ok = False
                break
        if ok and cur not in (None, ""):
            return cur
    return default


def as_list(x):
    """Lista tal cual, o la lista que venga envuelta en un sobre habitual."""
    if isinstance(x, list):
        return x
    if isinstance(x, dict):
        for k in ("elements", "items", "data", "results", "content",
                  "leagues", "standings", "teams", "players", "lineup", "squad"):
            if isinstance(x.get(k), list):
                return x[k]
    return []


def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


def position_label(p):
    v = pick(p, "positionId", "position", "positionName", default=None)
    try:
        return POS.get(int(v), "")
    except (TypeError, ValueError):
        return str(v) if v else ""


def player_team(p):
    return pick(p, "team.shortName", "team.name", "teamName", "team.slug", default="")


# --- clasificacion + historico ---------------------------------------------
def manager_name(team: dict) -> str:
    return pick(team, "team.manager.managerName", "manager.managerName", "manager.name",
                "managerName", "name", "user.name", default="?")


def manager_id(team: dict):
    return pick(team, "team.manager.id", "manager.id", "managerId", "userId", default=None)


def team_id(team: dict):
    return pick(team, "team.id", "teamId", "id", default=None)


def team_points(team: dict) -> int:
    return _int(pick(team, "points", "totalPoints", "team.teamPoints", "team.points", default=0))


def team_value(team: dict) -> int:
    return _int(pick(team, "team.teamValue", "teamValue", "value", default=0))


def build_standings(store) -> list[dict]:
    """Clasificacion actual enriquecida: rachas, posicion previa, puntos de la
    jornada, valor de plantilla, caja, eficiencia (pts por M€) y brecha al lider."""
    series = store.series("ranking")
    if not series:
        return []

    pts_hist: dict[str, list[int]] = {}
    rank_hist: dict[str, list[int]] = {}
    val_hist: dict[str, list[int]] = {}
    for _c, _w, payload in series:
        rows = as_list(payload)
        for i, team in enumerate(rows, start=1):
            nm = manager_name(team)
            pts_hist.setdefault(nm, []).append(team_points(team))
            rank_hist.setdefault(nm, []).append(_int(pick(team, "position", "rank", default=i)) or i)
            val_hist.setdefault(nm, []).append(team_value(team))

    # puntos de la jornada actual (snapshot 'weekly'); si no hay, delta del historico
    weekly = {manager_name(t): team_points(t) for t in as_list(store.latest("weekly"))}
    # caja por manager (snapshot 'money')
    money_by_mgr = {}
    for _tid, info in (store.latest("money") or {}).items():
        if isinstance(info, dict):
            money_by_mgr[info.get("manager", "?")] = _int(pick(info, "teamMoney", "money"))

    _c, _w, last = series[-1]
    out = []
    for i, team in enumerate(as_list(last), start=1):
        nm = manager_name(team)
        pts, val = team_points(team), team_value(team)
        h, rh = pts_hist.get(nm, []), rank_hist.get(nm, [])
        wk = weekly.get(nm)
        if wk is None:
            wk = (h[-1] - h[-2]) if len(h) >= 2 else 0
        out.append({
            "rank": _int(pick(team, "position", "rank", default=i)) or i,
            "prevRank": rh[-2] if len(rh) >= 2 else None,
            "manager": nm,
            "teamId": str(team_id(team) or "") or None,
            "points": pts,
            "weekPoints": max(0, _int(wk)),
            "teamValue": val,
            "money": money_by_mgr.get(nm),
            "ptsPerValue": round(pts / (val / 1e6), 1) if val else None,
            "history": h[-16:],
            "rankHistory": rh[-16:],
            "valueHistory": val_hist.get(nm, [])[-16:],
        })
    out.sort(key=lambda r: r["rank"])
    if out:
        leader = out[0]["points"]
        for r in out:
            r["gapToLeader"] = leader - r["points"]
    return out


# --- rachas ------------------------------------------------------------------
def build_streaks(standings: list[dict]) -> list[dict]:
    streaks = []
    for r in standings:
        h = r["history"]
        gains = [b - a for a, b in zip(h, h[1:])] if len(h) > 1 else []
        recent = gains[-3:]
        if not recent:
            trend, label = "flat", "sin datos aun"
        elif all(x == 0 for x in recent):
            trend, label = "flat", "sin cambios"
        elif all(x > 0 for x in recent):
            trend, label = "up", f"{len(recent)} subidas seguidas"
        elif all(x <= 0 for x in recent):
            trend, label = "down", "en baja"
        else:
            trend, label = "mixed", "irregular"
        streaks.append({"manager": r["manager"], "gains": gains[-8:], "trend": trend, "label": label})
    return streaks


def build_jornada(standings, week):
    top = sorted(standings, key=lambda r: r.get("weekPoints", 0), reverse=True)
    return {
        "number": week,
        "top": [{"manager": r["manager"], "weekPoints": r.get("weekPoints", 0)} for r in top[:6]],
    }


# --- indices auxiliares ------------------------------------------------------
def build_player_index(store) -> dict:
    """id(str) -> {'name','value'} desde el ultimo snapshot de 'players'."""
    idx = {}
    for p in as_list(store.latest("players")):
        pid = pick(p, "id", "playerMasterId", "playerId")
        if pid is not None:
            idx[str(pid)] = {"name": pick(p, "nickname", "name", default="?"),
                             "value": _int(pick(p, "marketValue", "value"))}
    return idx


def build_manager_index(store) -> dict:
    """id(str) -> managerName desde el ultimo snapshot de 'ranking'."""
    idx = {}
    for t in as_list(store.latest("ranking")):
        mid = manager_id(t)
        if mid is not None:
            idx[str(mid)] = manager_name(t)
    return idx


# --- actividad -> clausulazos, novedades, records, gasto ---------------------
# La actividad NO trae texto de operacion: trae 'activityTypeId' (entero).
ACTIVITY_LABELS = {1: "compró", 4: "blindó", 6: "puntos jornada", 7: "alineación indebida",
                   9: "se unió", 31: "fichó", 32: "clausuló", 33: "vendió"}
TRANSFER_TYPES = {1, 4, 31, 32, 33}
BUY_TYPES = {1, 31, 32}     # cuenta como gasto del comprador
CLAUSE_TYPE = 32


def _type_id(it):
    v = pick(it, "activityTypeId", "activityType", "operationTypeId", "type", default=None)
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _amount(it):
    return _int(pick(it, "amount", "money", "price", "value"))


def _resolve_who(it, manager_idx, name_key, id_key):
    n = pick(it, name_key)
    if n:
        return n
    i = pick(it, id_key)
    return manager_idx.get(str(i), "?") if i is not None else "?"


def _roster_players(info):
    """Lista de jugadores crudos de un snapshot de plantilla, tolerante al envoltorio."""
    detail = info.get("detail") or info
    players = as_list(pick(detail, "players", "lineup", "squad", default=None) or detail)
    if not players:
        players = as_list(pick(detail, "team.players", default=None))
    return players


def build_activity_all(store, player_idx, manager_idx, top=12):
    seen = {}
    for _c, _w, payload in store.series("activity"):
        for it in as_list(payload):
            key = pick(it, "id", "operationId", default=None) or repr(it)[:80]
            seen[key] = it
    items = list(seen.values())

    def pname(it):
        n = pick(it, "playerMaster.nickname", "playerMaster.name", "player.nickname",
                 "player.name", "playerName", "name")
        if n:
            return n
        pid = pick(it, "playerMasterId", "playerId", "playerMaster.id", "player.id")
        return player_idx.get(str(pid), {}).get("name", "?") if pid is not None else "?"

    def pvalue(it):
        v = _int(pick(it, "playerMaster.marketValue", "player.marketValue", "marketValue"))
        if not v:
            pid = pick(it, "playerMasterId", "playerId", "playerMaster.id", "player.id")
            v = player_idx.get(str(pid), {}).get("value", 0) if pid is not None else 0
        return v

    def who(it, name_key, id_key):
        n = pick(it, name_key)
        if n:
            return n
        i = pick(it, id_key)
        return manager_idx.get(str(i), "?") if i is not None else "?"

    novedades, clauses = [], []
    spent, ops = {}, {}
    for it in items:
        tid = _type_id(it)
        amount = _amount(it)
        frm = who(it, "user2Name", "user2Id")   # vendedor / propietario previo
        to = who(it, "user1Name", "user1Id")     # comprador / nuevo propietario
        pid = pick(it, "playerMasterId", "playerId", "playerMaster.id", "player.id")
        entry = {"date": pick(it, "createdAt", "date", "timestamp", default=""),
                 "player": pname(it), "playerId": str(pid) if pid is not None else None,
                 "amount": amount, "op": ACTIVITY_LABELS.get(tid, "movimiento"), "typeId": tid,
                 "from": frm, "to": to}
        if tid in TRANSFER_TYPES or tid is None:
            novedades.append(entry)
        if tid in TRANSFER_TYPES and to != "?":
            ops[to] = ops.get(to, 0) + 1
        if tid in BUY_TYPES and to != "?":
            spent[to] = spent.get(to, 0) + amount
        if tid == CLAUSE_TYPE:
            value = pvalue(it)
            c = dict(entry, marketValue=value,
                     premiumPct=round((amount - value) / value * 100, 1) if value else None)
            clauses.append(c)

    novedades.sort(key=lambda e: e["date"], reverse=True)
    clauses.sort(key=lambda e: e["amount"], reverse=True)

    spending = sorted(({"manager": m, "spent": s, "ops": ops.get(m, 0)} for m, s in spent.items()),
                      key=lambda x: x["spent"], reverse=True)

    signings = [e for e in novedades if e["typeId"] in (1, 31)]
    records = {
        "biggestClause": clauses[0] if clauses else None,
        "biggestSigning": max(signings, key=lambda e: e["amount"]) if signings else None,
        "biggestPremium": max((c for c in clauses if c.get("premiumPct") is not None),
                              key=lambda c: c["premiumPct"], default=None),
        "topSpender": spending[0] if spending else None,
        "mostActive": max(({"manager": m, "ops": n} for m, n in ops.items()),
                          key=lambda x: x["ops"], default=None),
    }
    return {"clauses": clauses[:top], "novedades": novedades[:40],
            "spending": spending, "records": records}


# --- movers de mercado (subidas/bajadas de valor) ----------------------------
# La API no da variacion diaria: se calcula comparando nuestros propios snapshots.
def build_movers(store, player_idx, top=12):
    snaps = store.series("players")
    if not snaps:
        return _movers_from_market(store, top)

    def val_map(payload):
        m = {}
        for p in as_list(payload):
            pid = pick(p, "id", "playerMasterId", "playerId")
            if pid is not None:
                m[str(pid)] = _int(pick(p, "marketValue", "value"))
        return m

    last = val_map(snaps[-1][2])
    prev = val_map(snaps[-2][2]) if len(snaps) > 1 else {}
    rows = []
    for pid, value in last.items():
        delta = value - prev.get(pid, value)
        rows.append({"id": str(pid), "player": player_idx.get(pid, {}).get("name", "?"), "value": value,
                     "delta": delta, "deltaPct": round(delta / value * 100, 1) if value else 0})
    ups = sorted((r for r in rows if r["delta"] > 0), key=lambda r: r["delta"], reverse=True)[:top]
    downs = sorted((r for r in rows if r["delta"] < 0), key=lambda r: r["delta"])[:top]
    if not ups and not downs:   # primer dia: sin historico, muestra los mas valiosos
        top_val = sorted(rows, key=lambda r: r["value"], reverse=True)[:top]
        return {"up": top_val, "down": []}
    return {"up": ups, "down": downs}


def _movers_from_market(store, top):
    rows = []
    for it in as_list(store.latest("market")):
        p = pick(it, "playerMaster", "player", default=it)
        rows.append({"id": str(pick(p, "id", "playerMasterId", "playerId", default="")) or None,
                     "player": pick(p, "nickname", "name", default="?"),
                     "value": _int(pick(p, "marketValue", "value", "salePrice")), "delta": 0, "deltaPct": 0})
    rows.sort(key=lambda m: m["value"], reverse=True)
    return {"up": rows[:top], "down": []}


# --- mejores jugadores de la liga (players master) ---------------------------
def build_top_players(store, ff_index, top=10):
    def norm(p):
        official, img = photo_of(pick(p, "image", "images.big", "photo"), ff_match(ff_index, pick(p, "nickname", "name")))
        return {"id": str(pick(p, "id", "playerMasterId", "playerId", default="")) or None,
                "player": pick(p, "nickname", "name", default="?"),
                "value": _int(pick(p, "marketValue", "value")),
                "points": _int(pick(p, "points", "totalPoints")),
                "avg": round(float(pick(p, "averagePoints", "avgPoints", default=0) or 0), 1),
                "position": position_label(p), "team": player_team(p),
                "img": img, "official": official}
    P = [norm(p) for p in as_list(store.latest("players"))]
    return {
        "byValue": sorted(P, key=lambda x: x["value"], reverse=True)[:top],
        "byPoints": sorted(P, key=lambda x: x["points"], reverse=True)[:top],
        "byAvg": sorted((x for x in P if x["avg"] > 0), key=lambda x: x["avg"], reverse=True)[:top],
    }


# --- mercado actual de la liga ----------------------------------------------
def build_market(store, ff_index, top=200):
    out = []
    for it in as_list(store.latest("market")):
        p = pick(it, "playerMaster", "player", default=it)
        official, img = photo_of(pick(p, "image", "images.big", "photo"), ff_match(ff_index, pick(p, "nickname", "name")))
        # discr: marketPlayerLeague = agente libre (de la liga) · marketPlayerTeam = lo vende un manager
        is_mgr = pick(it, "discr", default="") == "marketPlayerTeam"
        seller = pick(it, "sellerTeam.manager.managerName", "playerTeam.manager.managerName", default=None) if is_mgr else None
        out.append({"id": str(pick(p, "id", "playerMasterId", "playerId", default="")) or None,
                    "player": pick(p, "nickname", "name", default="?"),
                    "value": _int(pick(p, "marketValue", "value")),
                    "price": _int(pick(it, "salePrice", "price")),
                    "position": position_label(p), "team": player_team(p),
                    "bids": _int(pick(it, "numberOfBids", "numberOfOffers", "bids")),
                    "source": "manager" if is_mgr else "league",
                    "seller": seller,
                    "clause": _int(pick(it, "playerTeam.buyoutClause")) or None,
                    "shielded": bool(pick(it, "playerTeam.isShielded", default=False)),
                    "expires": pick(it, "expirationDate", default=None),
                    "img": img, "official": official})
    out.sort(key=lambda m: m["value"], reverse=True)
    return out[:top]


# --- CAJA de cada manager reconstruida de la actividad pública ----------------
def build_cajas(store, manager_idx, managers):
    """Reconstruye la caja de CADA manager sin necesitar su login, a partir de la
    actividad pública de la liga:  caja = inicial + ventas − compras − blindajes.
    El 'inicial' se auto-calibra con la caja REAL que la API sí deja ver (la del
    dueño del snapshot 'money'), así vale para cualquier liga. Validado: coincide
    exacto con la caja real de la API."""
    net, seen = {}, set()
    for _c, _w, payload in store.series("activity"):
        for e in as_list(payload):
            eid = pick(e, "id", default=None)
            if eid is not None:
                if eid in seen:
                    continue
                seen.add(eid)
            tid = _type_id(e)
            amt = _int(pick(e, "amount", default=0))
            if not amt or tid is None:
                continue
            u1, u2 = pick(e, "user1Id"), pick(e, "user2Id")
            n1 = manager_idx.get(str(u1)) if u1 is not None else None
            n2 = manager_idx.get(str(u2)) if u2 is not None else None
            if tid == 33:                       # vendió al mercado -> ingresa
                if n1: net[n1] = net.get(n1, 0) + amt
            elif tid in (1, 32):                # compró / clausuló a otro manager
                if n1: net[n1] = net.get(n1, 0) - amt      # comprador/clausulador paga
                if n2: net[n2] = net.get(n2, 0) + amt      # vendedor/propietario recibe
            elif tid in (31, 4):                # fichó agente libre / blindó -> gasto
                if n1: net[n1] = net.get(n1, 0) - amt

    # caja real conocida (solo la del dueño de la cuenta) -> para calibrar y fijar
    real = {}
    for _tid, info in (store.latest("money") or {}).items():
        if isinstance(info, dict) and info.get("manager"):
            m = _int(pick(info, "teamMoney", "money", default=None))
            if pick(info, "teamMoney", "money") is not None:
                real[info["manager"]] = m
    initial = 100_000_000
    for mgr, rc in real.items():
        initial = rc - net.get(mgr, 0)         # auto-calibrado con la caja real
        break

    names = [m.get("name") for m in managers if m.get("name")]
    cajas = {nm: initial + net.get(nm, 0) for nm in names}
    cajas.update(real)                         # la real (exacta) manda donde la haya
    return cajas


# --- presupuesto por manager -------------------------------------------------
def build_budgets(store):
    out = []
    for _tid, info in (store.latest("money") or {}).items():
        if isinstance(info, dict):
            out.append({"manager": info.get("manager", "?"),
                        "money": _int(pick(info, "teamMoney", "money")),
                        "invested": _int(pick(info, "teamInvestment", "invested"))})
    out.sort(key=lambda b: b["money"], reverse=True)
    return out


# --- plantillas por manager --------------------------------------------------
def build_rosters(store):
    out = []
    for _tid, info in (store.latest("roster") or {}).items():
        if not isinstance(info, dict):
            continue
        detail = info.get("detail") or info
        players = as_list(pick(detail, "players", "lineup", "squad", default=None) or detail)
        if not players:
            players = as_list(pick(detail, "team.players", default=None))
        squad = []
        for pl in players:
            pm = pick(pl, "playerMaster", "player", default=pl)
            squad.append({"name": pick(pm, "nickname", "name", default="?"),
                          "value": _int(pick(pm, "marketValue", "value")),
                          "clause": _int(pick(pl, "buyoutClause.amount", "buyoutClause",
                                              "playerTeam.buyoutClause")),
                          "points": _int(pick(pm, "points", "totalPoints")),
                          "position": position_label(pm)})
        squad.sort(key=lambda x: x["value"], reverse=True)
        out.append({"manager": info.get("manager", "?"), "count": len(squad),
                    "value": sum(x["value"] for x in squad), "players": squad})
    out.sort(key=lambda r: r["value"], reverse=True)
    return out


# --- mapa de equipos reales (de teams-master) --------------------------------
def build_team_map(store):
    from .ffscrape import FF_SLUG                 # código corto (BAR, RMA…) -> slug de futbolfantasy
    m = {}
    for t in as_list(store.latest("teams")):
        tid = pick(t, "id", "teamId")
        if tid is None:
            continue
        code = pick(t, "shortName", "name", "nickname", default="?")
        m[str(tid)] = {"name": code,
                       "badge": pick(t, "badgeColor", "badge", "image", "shield", "crest", "slug"),
                       "ffSlug": FF_SLUG.get(code)}
    return m


# --- motor de análisis de mercado (inspirado en analiticafantasy, datos propios)
# Todo se calcula con NUESTRO histórico de valores: subidas/bajadas diarias,
# momentum (acelera/frena), predicción, mapa de precios y patrones por equipo.
def _parse_ts(s):
    try:
        return dt.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return None


def build_market_analytics(store, team_map, ff_index):
    # info actual por jugador (de nuestro players master)
    info = {}
    for p in as_list(store.latest("players")):
        pid = pick(p, "id", "playerMasterId", "playerId")
        if pid is None:
            continue
        info[str(pid)] = {"name": pick(p, "nickname", "name", default="?"), "pos": position_label(p),
                          "teamId": str(pick(p, "teamId", default="")) or None,
                          "value": _int(pick(p, "marketValue", "value")),
                          "img": pick(p, "image", "images.big", "photo")}

    # filas con datos REALES de futbolfantasy (subida/bajada, momentum, histórico de 30 días)
    rows = []
    for pid, m in info.items():
        ff = ff_match(ff_index, m["name"])
        if not ff:
            continue
        hist = [v for v in ff.get("hist", []) if v]
        if not hist:
            continue
        v0 = hist[-1]
        v1 = hist[-2] if len(hist) >= 2 else v0
        v2 = hist[-3] if len(hist) >= 3 else v1
        official, img = photo_of(m["img"], ff)
        rows.append({"id": pid, "player": m["name"], "pos": m["pos"], "teamId": m["teamId"],
                     "img": img, "official": official, "value": v0, "day": v0 - v1, "prev": v1 - v2,
                     "accel": ff.get("aceleracion", 0), "hist": hist})

    trim = lambda L: [{k: r[k] for k in ("id", "player", "pos", "img", "official", "value", "day", "prev", "accel", "hist")} for r in L[:15]]
    up = trim(sorted((r for r in rows if r["day"] > 0), key=lambda r: r["day"], reverse=True))
    down = trim(sorted((r for r in rows if r["day"] < 0), key=lambda r: r["day"]))
    accelUp = trim(sorted((r for r in rows if r["day"] > 0 and r["day"] > r["prev"]), key=lambda r: r["day"] - r["prev"], reverse=True))
    brakeUp = trim(sorted((r for r in rows if r["day"] > 0 and r["day"] <= r["prev"]), key=lambda r: r["prev"] - r["day"], reverse=True))
    accelDown = trim(sorted((r for r in rows if r["day"] < 0 and r["day"] < r["prev"]), key=lambda r: r["prev"] - r["day"], reverse=True))
    brakeDown = trim(sorted((r for r in rows if r["day"] < 0 and r["day"] >= r["prev"]), key=lambda r: r["day"] - r["prev"], reverse=True))
    predicted = trim(sorted((r for r in rows if r["day"] > 0 and r["accel"] > 0), key=lambda r: r["accel"], reverse=True))

    # mapa de precios (bandas en M€), sobre todos nuestros jugadores
    bands = [(0, 1), (1, 3), (3, 6), (6, 12), (12, 25), (25, 1e9)]
    labels = ["<1M", "1–3M", "3–6M", "6–12M", "12–25M", "25M+"]
    counts = [0] * len(bands)
    for m in info.values():
        v = m.get("value", 0) / 1e6
        for i, (a, b) in enumerate(bands):
            if a <= v < b:
                counts[i] += 1
                break
    price_map = [{"label": labels[i], "count": counts[i]} for i in range(len(bands))]

    # patrones por equipo (variación real agregada por equipo)
    agg = {}
    for r in rows:
        if r["teamId"]:
            agg.setdefault(r["teamId"], 0)
            agg[r["teamId"]] += r["day"]
    valagg = {}
    for m in info.values():
        if m["teamId"]:
            valagg[m["teamId"]] = valagg.get(m["teamId"], 0) + m["value"]
    tname = lambda tid: team_map.get(tid, {}).get("name") or ("Equipo " + tid)
    teams = [{"teamId": tid, "team": tname(tid), "delta": d} for tid, d in agg.items()]

    return {
        "dailyUp": up, "dailyDown": down, "accelUp": accelUp, "brakeUp": brakeUp,
        "accelDown": accelDown, "brakeDown": brakeDown, "predicted": predicted,
        "priceMap": price_map,
        "teamBest": sorted((t for t in teams if t["delta"] > 0), key=lambda t: t["delta"], reverse=True)[:8],
        "teamWorst": sorted((t for t in teams if t["delta"] < 0), key=lambda t: t["delta"])[:8],
        "teamByValue": sorted(([{"teamId": tid, "team": tname(tid), "value": v} for tid, v in valagg.items()]),
                              key=lambda t: t["value"], reverse=True)[:10],
        "hasHistory": bool(rows),
        "matched": len(rows),
    }


# --- datos por-entidad (drill-down de jugadores y presidentes) ---------------
def build_entities(store, standings, manager_idx, ff_index):
    """Devuelve (players, managers, transfers) con histórico, propiedad y traspasos,
    para poder pinchar en un jugador (su trayectoria entre presidentes + valor en el
    tiempo) o en un presidente (su plantilla e histórico de fichajes)."""

    # --- info y serie de valor de cada jugador (de los snapshots 'players') ---
    val_hist, pinfo = {}, {}
    for cap, _wk, payload in store.series("players"):
        for p in as_list(payload):
            pid = pick(p, "id", "playerMasterId", "playerId")
            if pid is None:
                continue
            val_hist.setdefault(str(pid), []).append({"t": cap, "v": _int(pick(p, "marketValue", "value"))})
    for p in as_list(store.latest("players")):
        pid = pick(p, "id", "playerMasterId", "playerId")
        if pid is not None:
            _st = pick(p, "playerStatus", default="")
            pinfo[str(pid)] = {"name": pick(p, "nickname", "name", default="?"),
                               "pos": position_label(p), "team": player_team(p),
                               "teamId": str(pick(p, "teamId", "team.id", default="")) or None,
                               "value": _int(pick(p, "marketValue", "value")),
                               "points": _int(pick(p, "points", "totalPoints")),
                               "avg": round(float(pick(p, "averagePoints", default=0) or 0), 1),
                               "status": _st if _st in ("injured", "doubtful", "suspended") else "",
                               "img": pick(p, "image", "images.big", "photo")}

    # --- propiedad actual + cláusula (del último snapshot de plantillas) ---
    rosters_raw = store.latest("roster") or {}
    owner, clause = {}, {}
    for _tid, info in rosters_raw.items():
        if not isinstance(info, dict):
            continue
        nm = info.get("manager", "?")
        for pl in _roster_players(info):
            pm = pick(pl, "playerMaster", "player", default=pl)
            pid = pick(pm, "id", "playerMasterId", "playerId")
            if pid is None:
                continue
            pid = str(pid)
            owner[pid] = nm
            clause[pid] = _int(pick(pl, "buyoutClause.amount", "buyoutClause", "playerTeam.buyoutClause"))
            pinfo.setdefault(pid, {"name": pick(pm, "nickname", "name", default="?"),
                                   "pos": position_label(pm), "team": player_team(pm),
                                   "teamId": str(pick(pm, "teamId", "team.id", default="")) or None,
                                   "value": _int(pick(pm, "marketValue", "value")),
                                   "points": _int(pick(pm, "points", "totalPoints")), "avg": 0.0,
                                   "img": pick(pm, "image", "images.big", "photo")})

    # --- log de traspasos (de toda la actividad, deduplicado) ---
    seen = {}
    for _c, _w, payload in store.series("activity"):
        for it in as_list(payload):
            key = pick(it, "id", "operationId", default=None) or repr(it)[:80]
            seen[key] = it
    transfers = []
    for it in seen.values():
        tid = _type_id(it)
        if tid not in TRANSFER_TYPES:
            continue
        pid = pick(it, "playerMasterId", "playerId", "playerMaster.id", "player.id")
        pid = str(pid) if pid is not None else None
        pname = (pinfo.get(pid, {}).get("name") if pid else None) or pick(
            it, "playerMaster.nickname", "playerMaster.name", "player.nickname",
            "player.name", "playerName", "name", default="?")
        transfers.append({"date": pick(it, "createdAt", "date", "timestamp", default=""),
                          "type": tid, "op": ACTIVITY_LABELS.get(tid, "movimiento"),
                          "player": pname, "playerId": pid, "amount": _amount(it),
                          "from": _resolve_who(it, manager_idx, "user2Name", "user2Id"),
                          "to": _resolve_who(it, manager_idx, "user1Name", "user1Id")})
    transfers.sort(key=lambda e: e["date"], reverse=True)

    # --- todos los jugadores (para poder pinchar en cualquiera) ---
    relevant = set(pinfo) | set(owner) | {t["playerId"] for t in transfers if t["playerId"]}
    for it in as_list(store.latest("market")):
        p = pick(it, "playerMaster", "player", default=it)
        pid = pick(p, "id", "playerMasterId", "playerId")
        if pid is not None:
            relevant.add(str(pid))
    players = []
    for pid in relevant:
        info = pinfo.get(pid, {"name": "?", "pos": "", "team": "", "value": 0, "points": 0, "avg": 0.0})
        vhist = val_hist.get(pid, [])[-40:]
        day, ff_url = None, None
        ff = ff_match(ff_index, info.get("name"))
        if ff:
            h = [v for v in ff.get("hist", []) if v]
            if len(h) >= 2:                       # histórico REAL de futbolfantasy (30 días)
                vhist = [{"t": None, "v": v} for v in h]
                day = h[-1] - h[-2]
            if ff.get("name"):                    # ficha en futbolfantasy (fuente pública)
                ff_url = "https://www.futbolfantasy.com/jugadores/" + re.sub(r"\s+", "-", norm_name(ff["name"]))
        if day is None:                            # sin match en futbolfantasy: usa NUESTRO histórico
            iv = [x["v"] for x in val_hist.get(pid, []) if x["v"]]
            if len(iv) >= 2:                       # último cambio real (el valor sube/baja 1 vez al día)
                cur = iv[-1]
                prev = next((v for v in reversed(iv[:-1]) if v != cur), None)
                if prev is not None:
                    day = cur - prev
        official, img = photo_of(info.get("img"), ff)   # silueta 'no-player' -> foto de futbolfantasy
        players.append({"id": pid, **info, "img": img, "official": official,
                        "owner": owner.get(pid), "clause": clause.get(pid, 0),
                        "day": day, "ffUrl": ff_url, "valueHistory": vhist,
                        "transfers": [t for t in transfers if t["playerId"] == pid]})
    players.sort(key=lambda p: p["value"], reverse=True)

    # --- presidentes (managers) con plantilla, histórico y gasto ---
    hist = {r["manager"]: r for r in standings}
    managers = []
    for _tid, info in rosters_raw.items():
        if not isinstance(info, dict):
            continue
        nm = info.get("manager", "?")
        squad = []
        for pl in _roster_players(info):
            pm = pick(pl, "playerMaster", "player", default=pl)
            pid = pick(pm, "id", "playerMasterId", "playerId")
            squad.append({"id": str(pid) if pid is not None else None,
                          "name": pick(pm, "nickname", "name", default="?"),
                          "pos": position_label(pm),
                          "value": _int(pick(pm, "marketValue", "value")),
                          "clause": _int(pick(pl, "buyoutClause.amount", "buyoutClause", "playerTeam.buyoutClause")),
                          "points": _int(pick(pm, "points", "totalPoints")),
                          "img": pinfo.get(str(pid), {}).get("img") if pid is not None else None})
        squad.sort(key=lambda x: x["value"], reverse=True)
        mt = [t for t in transfers if t["from"] == nm or t["to"] == nm]
        r = hist.get(nm, {})
        managers.append({"name": nm, "rank": r.get("rank"), "points": r.get("points", 0),
                         "value": sum(x["value"] for x in squad) or r.get("teamValue", 0),
                         "money": r.get("money"), "count": len(squad), "squad": squad,
                         "transfers": mt, "ops": len(mt),
                         "spent": sum(t["amount"] for t in mt if t["to"] == nm and t["type"] in BUY_TYPES),
                         "pointsHistory": r.get("history", []), "rankHistory": r.get("rankHistory", [])})
    if not managers:   # sin plantillas: al menos los de la clasificación
        for r in standings:
            mt = [t for t in transfers if t["from"] == r["manager"] or t["to"] == r["manager"]]
            managers.append({"name": r["manager"], "rank": r["rank"], "points": r["points"],
                             "value": r["teamValue"], "money": r.get("money"), "count": 0, "squad": [],
                             "transfers": mt, "ops": len(mt),
                             "spent": sum(t["amount"] for t in mt if t["to"] == r["manager"] and t["type"] in BUY_TYPES),
                             "pointsHistory": r["history"], "rankHistory": r["rankHistory"]})
    managers.sort(key=lambda m: (m["rank"] or 999))
    return players, managers, transfers


# --- calendario de partidos (todas las jornadas) -----------------------------
def build_calendar(store, team_map, current_week):
    raw = dict(store.latest("calendar") or {})
    if isinstance(store.latest("calendar"), list):  # compat con el formato antiguo (1 jornada)
        raw = {str(current_week or 1): store.latest("calendar")}
    # overlay de la jornada actual con marcadores casi en vivo (refresco de 5 min)
    live = store.latest("calendar_live") or {}
    for wk, games in (live.items() if isinstance(live, dict) else []):
        raw[str(wk)] = games

    def fmt(g):
        lid = str(pick(g, "localId", "local.id", default="") or "")
        vid = str(pick(g, "visitorId", "visitor.id", default="") or "")
        return {"date": pick(g, "matchDate", "date", "time", default=""),
                "local": team_map.get(lid, {}).get("name", "?"), "localId": lid or None,
                "visitor": team_map.get(vid, {}).get("name", "?"), "visitorId": vid or None,
                "localScore": pick(g, "localScore", default=None),
                "visitorScore": pick(g, "visitorScore", default=None),
                "state": pick(g, "matchState", default=None)}

    by_week = {}
    for wk, games in raw.items():
        ms = [fmt(g) for g in as_list(games)]
        ms.sort(key=lambda m: m["date"] or "")
        by_week[str(wk)] = ms
    weeks = sorted(by_week.keys(), key=lambda w: int(w) if str(w).isdigit() else 0)
    return {"current": current_week, "weeks": weeks, "byWeek": by_week}


# --- onces probables (futbolfantasy) -----------------------------------------
def build_onces(store, players):
    data = store.latest("onces") or {}
    if not data:
        return []
    master = [p for p in as_list(store.latest("players")) if pick(p, "id")]
    # jugadores del master agrupados por equipo (para emparejar DENTRO del equipo)
    by_team = {}
    for p in master:
        by_team.setdefault(str(pick(p, "teamId", default="")), []).append(p)
    sn2id = {t.get("shortName"): str(pick(t, "id", default="")) for t in as_list(store.latest("teams"))}

    def mk(items):
        return make_index(items, name_of=lambda p: [pick(p, "nickname"), pick(p, "name")],
                          key_of=lambda p: pick(p, "id"))

    def resolve(s, tidx):
        mp = index_match(tidx, s.get("name")) if tidx else None
        official, img = photo_of(pick(mp, "image", "images.big") if mp else None, {"img": s.get("img")})
        # estado real de la API (lesión/duda/sanción): marca al jugador aunque
        # futbolfantasy aún no lo haya quitado de su 11 probable.
        st = pick(mp, "playerStatus", default="") if mp else ""
        return {
            "name": pick(mp, "nickname", "name", default=s.get("name")) if mp else s.get("name"),
            "id": str(pick(mp, "id")) if mp else None,
            "img": img, "official": official,
            "pos": s.get("pos", ""), "prob": s.get("prob"), "x": s.get("x"), "y": s.get("y"),
            "status": st if st in ("injured", "doubtful", "suspended") else "",
        }

    out = []
    for sn, d in data.items():
        tidx = mk(by_team.get(sn2id.get(sn, ""), []))
        xi, subs = [], []
        for s in d.get("players", []):
            row = resolve(s, tidx)
            (xi if s.get("starter") else subs).append(row)
        subs.sort(key=lambda r: (r["prob"] or 0), reverse=True)
        c = {"DEF": 0, "MED": 0, "DEL": 0}
        gk = 0
        for p in xi:
            if p["pos"] in c:
                c[p["pos"]] += 1
            elif p["pos"] == "POR":
                gk += 1
        # solo mostramos la formación si es coherente (1 portero + 10 de campo);
        # si el dato de posición viene ruidoso (p.ej. 7-4-1) la omitimos.
        valid = gk == 1 and (c["DEF"] + c["MED"] + c["DEL"]) == 10 and c["DEF"] and c["DEL"]
        formation = "-".join(str(c[k]) for k in ("DEF", "MED", "DEL") if c[k]) if valid else None
        out.append({"team": d.get("name", sn), "slug": sn, "teamId": sn2id.get(sn) or None,
                    "formation": formation, "xi": xi, "subs": subs})
    out.sort(key=lambda t: t["team"])
    return out


# --- clausulómetro: a quién puedes clausular con tu caja ---------------------
def _locked(raw, now):
    if not raw:
        return False
    try:
        if isinstance(raw, (int, float)) or str(raw).isdigit():
            v = int(raw)
            if v > 1e12:
                v //= 1000
            return dt.datetime.fromtimestamp(v, dt.timezone.utc) > now
        return dt.datetime.fromisoformat(str(raw).replace("Z", "+00:00")) > now
    except Exception:
        return False


def build_clausulometro(store, ff_index):
    caja, own = 0, None
    for _tid, info in (store.latest("money") or {}).items():
        if isinstance(info, dict):
            caja = _int(pick(info, "teamMoney", "money"))
            own = info.get("manager")
    now = dt.datetime.now(dt.timezone.utc)
    players = []
    for _tid, info in (store.latest("roster") or {}).items():
        if not isinstance(info, dict) or info.get("manager") == own:
            continue                                   # no puedes clausular tu propio equipo
        mgr = info.get("manager", "?")
        for pl in _roster_players(info):
            pm = pick(pl, "playerMaster", "player", default=pl)
            clause = _int(pick(pl, "buyoutClause.amount", "buyoutClause", "playerTeam.buyoutClause"))
            if not clause:
                continue
            pid = pick(pm, "id", "playerMasterId", "playerId")
            official, img = photo_of(pick(pm, "image", "images.big"), ff_match(ff_index, pick(pm, "nickname", "name")))
            value = _int(pick(pm, "marketValue", "value"))
            players.append({"id": str(pid) if pid is not None else None,
                            "name": pick(pm, "nickname", "name", default="?"), "pos": position_label(pm),
                            "teamId": str(pick(pm, "teamId", default="")) or None, "img": img, "official": official,
                            "owner": mgr, "value": value, "clause": clause,
                            "premium": round((clause - value) / value * 100) if value else None,
                            "shielded": bool(pick(pl, "isShielded", "shielded")),
                            "locked": _locked(pick(pl, "buyoutClauseLockedEndTime", "buyoutClauseLocked"), now)})
    players.sort(key=lambda p: p["value"], reverse=True)
    return {"caja": caja, "manager": own, "players": players}


# --- bajas: lesionados, dudas y sancionados ----------------------------------
def build_injuries(store):
    LBL = {"injured": "lesión", "doubtful": "duda", "suspended": "sanción"}
    ORDER = {"suspended": 0, "injured": 1, "doubtful": 2}
    owner = {}
    for _tid, info in (store.latest("roster") or {}).items():
        if isinstance(info, dict):
            for pl in _roster_players(info):
                pm = pick(pl, "playerMaster", "player", default=pl)
                pid = pick(pm, "id", "playerMasterId", "playerId")
                if pid is not None:
                    owner[str(pid)] = info.get("manager")
    out = []
    for p in as_list(store.latest("players")):
        st = pick(p, "playerStatus")
        if st in LBL:
            pid = str(pick(p, "id"))
            out.append({"id": pid, "name": pick(p, "nickname", "name", default="?"),
                        "status": st, "statusLabel": LBL[st], "pos": position_label(p),
                        "teamId": str(pick(p, "teamId", default="")) or None,
                        "value": _int(pick(p, "marketValue", "value")), "owner": owner.get(pid)})
    out.sort(key=lambda x: (ORDER.get(x["status"], 9), -x["value"]))
    return out


# --- dificultad de calendario (fixture ticker) -------------------------------
def build_fixture_difficulty(store, team_map, current_week, weeks=6):
    # fuerza de cada equipo = suma del valor de sus jugadores -> tier 1 (flojo) .. 5 (fuerte)
    val = {}
    for p in as_list(store.latest("players")):
        tid = str(pick(p, "teamId", default="") or "")
        if tid:
            val[tid] = val.get(tid, 0) + _int(pick(p, "marketValue", "value"))
    ranked = [tid for tid, _ in sorted(val.items(), key=lambda x: -x[1])]
    tier = {tid: max(1, min(5, 5 - (i // 4))) for i, tid in enumerate(ranked)}

    cal = store.latest("calendar") or {}
    if isinstance(cal, list):
        cal = {str(current_week or 1): cal}
    cur = int(current_week or 1)
    wk_list = [str(w) for w in range(cur, cur + weeks)]

    out = []
    for tid, t in team_map.items():
        fixtures = []
        for w in wk_list:
            f = None
            for g in as_list(cal.get(w, [])):
                lid = str(pick(g, "localId", default="") or "")
                vid = str(pick(g, "visitorId", default="") or "")
                if lid == tid:
                    f = (vid, True)
                elif vid == tid:
                    f = (lid, False)
            if f:
                fixtures.append({"week": int(w), "oppId": f[0] or None,
                                 "opp": team_map.get(f[0], {}).get("name", "?"),
                                 "home": f[1], "diff": tier.get(f[0], 3)})
            else:
                fixtures.append({"week": int(w), "oppId": None, "opp": "—", "home": None, "diff": 0})
        out.append({"teamId": tid, "team": t.get("name", "?"), "fixtures": fixtures})
    out.sort(key=lambda x: sum(f["diff"] for f in x["fixtures"]))   # calendario más fácil primero
    return {"weeks": [int(w) for w in wk_list], "teams": out}


# --- clasificación real de LaLiga + escudo ------------------------------------
def build_laliga_table(store):
    tbl = store.latest("laliga_table") or []
    if not tbl:
        return []
    ms = as_list(store.latest("teams"))

    def find_tid(ffslug):
        for tt in ms:
            s = str(pick(tt, "slug", default="") or "")
            if ffslug and (ffslug in s or s.endswith(ffslug)):
                return str(pick(tt, "id", default=""))
        return None

    # Cabecera real de futbolfantasy (bloque "Total"): Pt · PJ · G · E · P · GF · GC · DG
    out = []
    for r in tbl:
        nums = r.get("nums") or []
        g = lambda i: nums[i] if len(nums) > i else None
        out.append({"pos": r["pos"], "team": r["team"], "teamId": find_tid(r.get("slug") or ""),
                    "pts": g(0), "pj": g(1), "pg": g(2), "pe": g(3), "pp": g(4),
                    "gf": g(5), "gc": g(6), "dg": g(7)})
    return out


# --- estadísticas de jugadores (API Fantasy, playerStats por jornada) --------
# Claves Opta de LaLiga Fantasy -> stat interno (con sinónimos por si cambian).
STAT_SYNS = {
    "goals":      ["goals", "goal"],
    "assists":    ["goal_assist", "assists", "goalAssist", "second_assist"],
    "shots":      ["total_scoring_att", "shots", "totalScoringAtt"],
    "clears":     ["effective_clearance", "clearances", "effectiveClearance"],
    "recoveries": ["ball_recovery", "recoveries", "ballRecovery"],
    "saves":      ["saves", "save"],
    "conceded":   ["goals_conceded", "goalsConceded"],
    "yellow":     ["yellow_card", "yellowCard"],
    "red":        ["red_card", "second_yellow_card", "redCard"],
    "penSaved":   ["penalty_save", "penaltySave"],
    "minutes":    ["mins_played", "minsPlayed", "minutes"],
}


def _stat_count(stats: dict, synonyms):
    """Lee el recuento de una stat aceptando [count, pts], count plano o {value:..}."""
    for k in synonyms:
        if k in stats:
            v = stats[k]
            if isinstance(v, list) and v:
                v = v[0]
            elif isinstance(v, dict):
                v = v.get("value", v.get("count", 0))
            try:
                return float(v) or 0
            except (TypeError, ValueError):
                return 0
    return 0


def aggregate_player_stats(raw_list):
    """raw = playerMaster.playerStats (una entrada por jornada) -> totales de temporada."""
    tot = {kk: 0 for kk in STAT_SYNS}
    tot["matches"] = 0
    tot["cleanSheets"] = 0
    for e in (raw_list or []):
        if not isinstance(e, dict):
            continue
        st = e.get("stats")
        if isinstance(st, list):   # a veces stats llega como lista de {name,value}
            st = {d.get("name"): d.get("value") for d in st if isinstance(d, dict)}
        if not isinstance(st, dict):
            st = e                 # o plano en la propia entrada
        mins = _stat_count(st, STAT_SYNS["minutes"])
        if mins > 0:
            tot["matches"] += 1
        for kk, syn in STAT_SYNS.items():
            tot[kk] += _stat_count(st, syn)
        if mins >= 60 and _stat_count(st, STAT_SYNS["conceded"]) == 0:
            tot["cleanSheets"] += 1
    return {k: int(v) for k, v in tot.items()}


def build_player_stats(store, ff_index):
    """Tabla de estadísticas de todos los jugadores: resumen (puntos/media/valor) SIEMPRE
    disponible + desglose por jornada (goles, asistencias, remates, despejes,
    recuperaciones, paradas, porterías a cero, tarjetas) cuando la liga está en juego."""
    players = as_list(store.latest("players"))
    snap = store.latest("playerstats") or {}
    out = []
    for p in players:
        pid = str(pick(p, "id", "playerMasterId", "playerId", default="") or "")
        if not pid:
            continue
        agg = snap.get(pid) or {}
        official, img = photo_of(pick(p, "image", "images.big", "photo"),
                                 ff_match(ff_index, pick(p, "nickname", "name")))
        out.append({
            "id": pid,
            "name": pick(p, "nickname", "name", default="?"),
            "teamId": str(pick(p, "teamId", default="") or ""),
            "pos": position_label(p) or "—",
            "img": img, "official": official,
            "value": int(pick(p, "marketValue", default=0) or 0),
            "points": int(pick(p, "points", default=0) or 0),
            "avg": round(float(pick(p, "averagePoints", default=0) or 0), 1),
            "lastPts": int(pick(p, "lastSeasonPoints", default=0) or 0),
            "matches": agg.get("matches", 0),
            "minutes": agg.get("minutes", 0),
            "goals": agg.get("goals", 0),
            "assists": agg.get("assists", 0),
            "shots": agg.get("shots", 0),
            "clears": agg.get("clears", 0),
            "recoveries": agg.get("recoveries", 0),
            "saves": agg.get("saves", 0),
            "cleanSheets": agg.get("cleanSheets", 0),
            "yellow": agg.get("yellow", 0),
            "red": agg.get("red", 0),
        })
    # marca si hay desglose real (para que el front active las columnas por stat)
    live = any(r["goals"] or r["assists"] or r["minutes"] for r in out)
    return {"live": live, "rows": out}


def build_value_history(store, rosters_raw):
    """Serie de VALOR de plantilla por mánager reconstruida de los snapshots 'players'
    (globales y ricos): suma el valor de su plantilla ACTUAL en cada captura. Da una
    evolución con buena granularidad desde ya, sin esperar a acumular 'ranking'."""
    series = store.series("players")
    if len(series) < 2:
        return {}
    caps = [c for c, _w, _p in series]
    per_pid = {}                                   # pid -> [valor por captura] (con relleno)
    for idx, (_c, _w, payload) in enumerate(series):
        for p in as_list(payload):
            pid = pick(p, "id", "playerMasterId", "playerId")
            if pid is not None:
                per_pid.setdefault(str(pid), [None] * len(caps))[idx] = _int(pick(p, "marketValue", "value"))
    for arr in per_pid.values():                   # relleno hacia delante y hacia atrás
        last = None
        for i in range(len(arr)):
            if arr[i] is None:
                arr[i] = last
            else:
                last = arr[i]
        first = next((x for x in arr if x is not None), 0)
        for i in range(len(arr)):
            if arr[i] is None:
                arr[i] = first
    out = {}
    for _tid, info in (rosters_raw or {}).items():
        if not isinstance(info, dict):
            continue
        nm = info.get("manager", "?")
        ids = []
        for pl in _roster_players(info):
            pm = pick(pl, "playerMaster", "player", default=pl)
            pid = pick(pm, "id", "playerMasterId", "playerId")
            if pid is not None:
                ids.append(str(pid))
        out[nm] = [{"t": caps[i], "v": sum(per_pid[pid][i] for pid in ids if pid in per_pid)}
                   for i in range(len(caps))]
    return out


# --- ensamblado final --------------------------------------------------------
def build_all(store, league: dict, current_week) -> dict:
    standings = build_standings(store)
    player_idx = build_player_index(store)
    manager_idx = build_manager_index(store)
    ff_index = build_ff_index(store)
    act = build_activity_all(store, player_idx, manager_idx)
    players, managers, transfers = build_entities(store, standings, manager_idx, ff_index)
    team_map = build_team_map(store)
    you = None                                    # tu equipo = del que la API deja ver la caja
    for _tid, info in (store.latest("money") or {}).items():
        if isinstance(info, dict) and info.get("manager"):
            you = info.get("manager")
    # caja AUTOMÁTICA de cada manager (reconstruida de la actividad pública)
    cajas = build_cajas(store, manager_idx, managers)
    for s in standings:
        if s.get("manager") in cajas:
            s["money"] = cajas[s["manager"]]
    for m in managers:
        if m.get("name") in cajas:
            m["money"] = cajas[m["name"]]
    # serie de valor de plantilla (para las gráficas de evolución de patrimonio)
    vseries = build_value_history(store, store.latest("roster") or {})
    for s in standings:
        s["valueSeries"] = vseries.get(s["manager"], [])
    for m in managers:
        m["valueSeries"] = vseries.get(m["name"], [])
    rank_caps = [c for c, _w, _p in store.series("ranking")][-16:]
    return {
        "histCaps": rank_caps,
        "you": you,
        "cajas": cajas,
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(),
        "sample": False,
        "league": {
            "id": pick(league, "id", default=None),
            "name": pick(league, "name", default="Mi liga"),
            "currentWeek": current_week,
            "managers": len(standings),
        },
        "standings": standings,
        "streaks": build_streaks(standings),
        "jornada": build_jornada(standings, current_week),
        "superClausulazos": act["clauses"],
        "records": act["records"],
        "spending": act["spending"],
        "movers": build_movers(store, player_idx),
        "topPlayers": build_top_players(store, ff_index),
        "market": build_market(store, ff_index),
        "budgets": sorted([{"manager": nm, "money": c} for nm, c in cajas.items()],
                          key=lambda b: b["money"], reverse=True),
        "novedades": act["novedades"],
        "players": players,
        "managers": managers,
        "transfers": transfers,
        "teams": team_map,
        "marketAnalytics": build_market_analytics(store, team_map, ff_index),
        "calendar": build_calendar(store, team_map, current_week),
        "onces": build_onces(store, players),
        "clausulometro": build_clausulometro(store, ff_index),
        "injuries": build_injuries(store),
        "fixtures": build_fixture_difficulty(store, team_map, current_week),
        "news": as_list(store.latest("news"))[:30],
        "laligaTable": build_laliga_table(store),
        "teamCalendars": store.latest("teamcal") or {},
        "playerStats": build_player_stats(store, ff_index),
    }


def build_multi(store, leagues, current_week) -> dict:
    """Deriva TODAS las ligas del usuario en un único objeto para la web multi-liga.
    Lo específico de cada liga (clasificación, plantillas, mercado, clausulómetro) se
    calcula por separado leyendo los snapshots namespaceados (store.lid); lo global de
    LaLiga (valores, onces, calendario, stats) sale igual en cada bloque."""
    blocks = {}
    lst = []
    for lg in leagues:
        lid = str(pick(lg, "id", default="") or "")
        if not lid:
            continue
        store.lid = lid
        blocks[lid] = build_all(store, lg, current_week)
        lst.append({"id": lid, "name": pick(lg, "name", default="Liga")})
    store.lid = None
    return {
        "multi": True,
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(),
        "list": lst,
        "leagues": blocks,
    }
