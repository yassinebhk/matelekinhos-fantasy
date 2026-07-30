"""
Scraper de tendencias de mercado de futbolfantasy.com.

Su página de mercado incrusta cada jugador en un <tr class="elemento_jugador">
con atributos data-* muy limpios: valor actual y valores a 1/2/3/7/14/30 días,
tendencia y aceleración. De ahí sacamos subidas/bajadas diarias, momentum y un
histórico real de valor (para las gráficas) sin depender del cambio diario propio.

Es la misma fuente que usa el cliente de referencia (LaLigaApp).
"""

import re
import requests

MARKET_URL = "https://www.futbolfantasy.com/analytics/laliga-fantasy/mercado"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
TIMEOUT = 25

_ROW = re.compile(r'<tr class="elemento_jugador[^"]*"([^>]*)>')
_ATTR = re.compile(r'data-([a-z0-9-]+)="([^"]*)"')


def _int(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


# mapa shortName (API LaLiga) -> slug de futbolfantasy. La lista REAL de equipos
# se toma de la API cada temporada; esto solo traduce el código corto al slug.
FF_SLUG = {
    "ALA": "alaves", "ATH": "athletic", "ATM": "atletico", "BAR": "barcelona", "BET": "betis",
    "CEL": "celta", "ELC": "elche", "ESP": "espanyol", "GET": "getafe", "GIR": "girona",
    "LEV": "levante", "MGA": "malaga", "MLL": "mallorca", "OSA": "osasuna", "OVI": "oviedo",
    "RAC": "racing", "RAY": "rayo-vallecano", "RCD": "deportivo", "RMA": "real-madrid",
    "RSO": "real-sociedad", "SEV": "sevilla", "VAL": "valencia", "VLL": "valladolid",
    "VIL": "villarreal", "LPA": "las-palmas", "LEG": "leganes", "CAD": "cadiz",
    "GRA": "granada", "ALM": "almeria",
}
LINEUP_URL = "https://www.futbolfantasy.com/laliga/equipos/{slug}"


def _pos_from_y(y):
    try:
        y = float(y)
    except (TypeError, ValueError):
        return ""
    return "POR" if y >= 80 else "DEF" if y >= 55 else "MED" if y >= 30 else "DEL"


def _pos_abbr(sp):
    s = (sp or "").lower()
    if "porter" in s:
        return "POR"
    if "defen" in s:
        return "DEF"
    if "medio" in s or "centro" in s:
        return "MED"
    if "delant" in s:
        return "DEL"
    return ""


def parse_lineup(html):
    """Once probable de un equipo: titulares + suplentes, con probabilidad, posición,
    coordenadas en el campo y foto (de futbolfantasy)."""
    marks = [(m.start(), m.group(1)) for m in re.finditer(r'data-onceFF="(titular|suplente)"', html)]
    players, seen = [], set()
    for k, (i, role) in enumerate(marks):
        nxt = marks[k + 1][0] if k + 1 < len(marks) else i + 2600
        back, fwd = html[max(0, i - 1300):i], html[i:nxt]
        slug = re.search(r'/jugadores/([a-z0-9-]+)', fwd)
        if not slug or slug.group(1) in seen:
            continue
        seen.add(slug.group(1))
        pos = re.search(r'data-posicion="([^"]*)"', back)
        prob = re.search(r'data-probabilidad="(\d+)', fwd)
        x = re.search(r'data-onceFF-x="([\d.]+)', fwd)
        y = re.search(r'data-onceFF-y="([\d.]+)', fwd)
        img = re.search(r'(?:https?:)?//(?:media|static)\.futbolfantasy\.com/[^"\'\s]*jugadores/ficha/\d+\.png', html[i:nxt + 250])
        imgu = img.group(0) if img else None
        if imgu and imgu.startswith("//"):
            imgu = "https:" + imgu
        players.append({
            "slug": slug.group(1), "name": slug.group(1).replace("-", " ").title(),
            "starter": role == "titular",
            "pos": _pos_abbr(pos.group(1)) if pos else _pos_from_y(y.group(1) if y else None),
            "prob": int(prob.group(1)) if prob else None,
            "x": float(x.group(1)) if x else None,
            "y": float(y.group(1)) if y else None,
            "img": imgu,
        })
    return players


def scrape_lineups(teams):
    """Once probable de los equipos REALES de la temporada (los que da la API).
    `teams` = snapshot teams-master. Devuelve {shortName: {name, players[]}}."""
    import time
    rows = teams if isinstance(teams, list) else (teams or {}).get("elements") or []
    out = {}
    for t in rows:
        sn = t.get("shortName")
        slug = FF_SLUG.get(sn)
        if not slug:
            continue
        try:
            r = requests.get(LINEUP_URL.format(slug=slug), headers={"User-Agent": UA}, timeout=TIMEOUT)
            if not r.ok:
                continue
            players = parse_lineup(r.text)
            if players:
                out[sn] = {"name": t.get("name") or sn, "players": players}
        except Exception:
            pass
        time.sleep(0.4)
    return out


NEWS_URL = "https://www.futbolfantasy.com/laliga/noticias"
_NEWS = re.compile(r'/laliga/noticias/(\d+)-([a-z0-9-]+)"[^>]*>\s*([A-ZÁÉÍÓÚÑ¡¿0-9][^<]{6,150}?)\s*</a>')


def scrape_news(limit=30):
    """Titulares/rumores de LaLiga desde futbolfantasy. Devuelve [{id, title, url}]."""
    r = requests.get(NEWS_URL, headers={"User-Agent": UA}, timeout=TIMEOUT)
    r.raise_for_status()
    out, seen = [], set()
    for m in _NEWS.finditer(r.text):
        nid = m.group(1)
        if nid in seen:
            continue
        seen.add(nid)
        out.append({"id": nid, "title": m.group(3).strip(),
                    "url": "https://www.futbolfantasy.com/laliga/noticias/%s-%s" % (nid, m.group(2))})
        if len(out) >= limit:
            break
    return out


CLAS_URL = "https://www.futbolfantasy.com/laliga/clasificacion"
TEAMCAL_URL = "https://www.futbolfantasy.com/laliga/equipos/{slug}/partidos"


def scrape_classification():
    """Clasificación real de LaLiga: posición, equipo y estadísticas (PJ..Pts)."""
    r = requests.get(CLAS_URL, headers={"User-Agent": UA}, timeout=TIMEOUT)
    r.raise_for_status()
    h = r.text
    out = []
    for m in re.finditer(r'posicion-style">(\d+)</span>(.*?)(?=posicion-style">\d+</span>|</table>|$)', h, re.S):
        seg = m.group(2)
        link = re.search(r'/laliga/equipos/([a-z0-9-]+)"', seg)
        name = re.search(r'<span>\s*([^<]+?)\s*</span>', seg)
        nums = [int(x) for x in re.findall(r'>\s*(-?\d{1,3})\s*<', seg)]
        out.append({"pos": int(m.group(1)), "slug": link.group(1) if link else None,
                    "team": name.group(1).strip() if name else "?", "nums": nums})
        if len(out) >= 20:
            break
    return out


def scrape_team_calendars(teams):
    """Calendario COMPLETO de cada equipo (todas las competiciones) desde futbolfantasy."""
    import time
    rows = teams if isinstance(teams, list) else (teams or {}).get("elements") or []
    out = {}
    for t in rows:
        sn = t.get("shortName")
        slug = FF_SLUG.get(sn)
        if not slug:
            continue
        try:
            r = requests.get(TEAMCAL_URL.format(slug=slug), headers={"User-Agent": UA}, timeout=TIMEOUT)
            if not r.ok:
                continue
            matches = []
            for chunk in r.text.split('class="partido"')[1:]:
                seg = chunk[:1600]
                tip = re.search(r'data-tooltip="([^"]+)"', seg)
                if not tip:
                    continue
                comp = re.search(r'logos_competiciones/[^"]+"\s*alt="([^"]+)"', seg)
                txt = re.sub(r'\s+', " ", re.sub(r'<[^>]+>', " ", seg))
                when = re.search(r'[LMXJVSD][a-zé]{1,2}\s+\d{1,2}/\d{2}(?:\s+\d{1,2}:\d{2}h)?', txt)
                # marcador (solo si ya se ha jugado): "2 - 1", nunca parte de una fecha
                score = re.search(r'(?<![\d/])(\d{1,2})\s*-\s*(\d{1,2})(?![\d/])', txt)
                matches.append({"comp": comp.group(1) if comp else "", "match": tip.group(1).strip(),
                                "when": when.group(0).strip() if when else "",
                                "score": f"{score.group(1)}-{score.group(2)}" if score else None})
                if len(matches) >= 45:
                    break
            if matches:
                out[sn] = {"name": t.get("name") or sn, "matches": matches}
        except Exception:
            pass
        time.sleep(0.4)
    return out


def scrape():
    """Devuelve una lista de dicts por jugador con valor, histórico, momentum y foto."""
    r = requests.get(MARKET_URL, headers={"User-Agent": UA}, timeout=TIMEOUT)
    r.raise_for_status()
    # mapa id -> URL de foto (ficha) para toda la página
    faces = {}
    for m in re.finditer(r'(?:https?:)?//[a-z.]*futbolfantasy\.com/[^"\']*jugadores/ficha/(\d+)\.png', r.text):
        u = m.group(0)
        faces.setdefault(m.group(1), "https:" + u if u.startswith("//") else u)
    out = []
    for attr_str in _ROW.findall(r.text):
        d = dict(_ATTR.findall(attr_str))
        name = d.get("nombre")
        if not name:
            continue
        # histórico cronológico (viejo -> hoy) para sparkline real
        hist = [_int(d.get(k)) for k in ("valor30", "valor14", "valor7", "valor3", "valor2", "valor1", "valor")]
        out.append({
            "ffId": d.get("id"),
            "name": name,
            "teamFf": d.get("equipo"),
            "pos": d.get("posicion"),
            "value": _int(d.get("valor")),
            "hist": hist,
            "tendencia": _int(d.get("tendencia")),
            "aceleracion": _int(d.get("aceleracion")),
            "dif1": _int(d.get("diferencia1")),
            "dif7": _int(d.get("diferencia7")),
            "dif30": _int(d.get("diferencia30")),
            "img": faces.get(d.get("id")),
        })
    return out
