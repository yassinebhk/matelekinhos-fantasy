"""
Orquestador. Lo que corre el cron cada X horas:

  auth (refresh o login) -> pull API -> snapshot a SQLite -> derive -> escribe la web

Uso:
  python -m exporter.run              # ejecucion normal
  python -m exporter.run --once-verbose   # con logs detallados (para la 1a vez)
"""

import os
import sys
import json
import time
import logging
import subprocess
from pathlib import Path

import requests

from .auth import TokenCache, get_bearer, AuthError
from .api import FantasyAPI
from .store import Store
from . import metrics as M
from . import ffscrape

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config.json"
DB = ROOT / "fantasy.db"
TOKEN = ROOT / ".token.json"
WEB_DATA = ROOT / "web" / "data" / "metrics.js"
IMG_DIR = ROOT / "web" / "img" / "players"
BADGE_DIR = ROOT / "web" / "img" / "teams"

log = logging.getLogger("exporter")


def download_badges(teams):
    """Descarga los escudos de los equipos a web/img/teams/{id}.png (los que falten)."""
    BADGE_DIR.mkdir(parents=True, exist_ok=True)
    got = 0
    for t in M.as_list(teams):
        tid = M.pick(t, "id", "teamId")
        url = M.pick(t, "badgeColor", "badge", "image", "shield")
        if not tid or not url:
            continue
        dest = BADGE_DIR / f"{tid}.png"
        if dest.exists():
            continue
        try:
            r = requests.get(url, timeout=15)
            if r.ok and r.content:
                dest.write_bytes(r.content)
                got += 1
        except Exception:
            pass
    return got


def download_images(players, limit=None):
    """Descarga a web/img/players/{id}.png las fotos que falten (jugadores y
    entrenadores). Salta las que ya existen, así solo trabaja con las nuevas."""
    IMG_DIR.mkdir(parents=True, exist_ok=True)
    got = 0
    for p in M.as_list(players):
        pid = M.pick(p, "id", "playerMasterId", "playerId")
        url = M.pick(p, "image", "images.big", "photo")
        if not pid or not url or "no-player" in url:   # silueta genérica -> no la guardamos
            continue
        dest = IMG_DIR / f"{pid}.png"
        if dest.exists():
            continue
        try:
            r = requests.get(url, timeout=15)
            if r.ok and r.content:
                dest.write_bytes(r.content)
                got += 1
        except Exception:
            pass
        if limit and got >= limit:
            break
    return got


def load_config() -> dict:
    if not CONFIG.exists():
        sys.exit("Falta config.json. Copia config.example.json a config.json y rellenalo.")
    cfg = json.loads(CONFIG.read_text())
    email = str(cfg.get("email") or "")
    # el fichero se entrega con placeholders; avisamos claro si no se han tocado
    if email.startswith("TU_") or not email:
        has_token = TOKEN.exists()
        if not has_token:
            sys.exit(
                "config.json todavia tiene los datos de ejemplo.\n"
                "  -> Abre config.json y pon tu email y contrasena de LaLiga Fantasy.\n"
                "  -> Si entras con Google/Apple, deja email/password vacios y ejecuta"
                " 'python -m exporter.login' una vez."
            )
    return cfg


def pick_league(api: FantasyAPI, cfg: dict):
    """Usa la liga del config; si no hay, coge la primera de tu cuenta."""
    leagues = M.as_list(api.leagues())
    if not leagues:
        raise SystemExit("Tu cuenta no tiene ninguna liga.")
    want = str(cfg.get("league_id") or "").strip()
    if want:
        for lg in leagues:
            if str(M.pick(lg, "id", default="")) == want:
                return lg
    return leagues[0]


def pick_leagues(api: FantasyAPI, cfg: dict):
    """TODAS las ligas del usuario (multi-liga). Si config trae 'league_ids' (lista),
    solo esas; si trae el antiguo 'league_id' único, esa; si no, todas."""
    leagues = M.as_list(api.leagues())
    want = cfg.get("league_ids")
    if not want and cfg.get("league_id"):
        want = [cfg.get("league_id")]
    if want:
        want = {str(x).strip() for x in want}
        sel = [l for l in leagues if str(M.pick(l, "id", default="")) in want]
        if sel:
            return sel
    return leagues


def write_web(data: dict):
    WEB_DATA.parent.mkdir(parents=True, exist_ok=True)
    # se escribe como window.METRICS para que index.html funcione con doble clic,
    # sin necesidad de servidor (fetch de file:// suele estar bloqueado).
    WEB_DATA.write_text("window.METRICS = " + json.dumps(data, ensure_ascii=False, indent=2) + ";\n")


def main():
    verbose = "--once-verbose" in sys.argv
    logging.basicConfig(level=logging.DEBUG if verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    cfg = load_config()

    try:
        bearer = get_bearer(TokenCache(TOKEN),
                            email=cfg.get("email"), password=cfg.get("password"))
    except AuthError as e:
        sys.exit(f"[AUTH] {e}")

    api = FantasyAPI(bearer)
    store = Store(DB)

    try:
        week = M.pick(api.current_week(), "weekNumber", "week", "numberOfWeek", default=None)
    except Exception:
        week = None

    leagues = pick_leagues(api, cfg)
    if not leagues:
        raise SystemExit("Tu cuenta no tiene ninguna liga.")
    any_lid = M.pick(leagues[0], "id")
    log.info("Ligas (%d): %s | jornada=%s", len(leagues),
             ", ".join(f"{M.pick(l, 'name')}={M.pick(l, 'id')}" for l in leagues), week)

    import datetime as _dt
    now = _dt.datetime.now(_dt.timezone.utc)
    force = ("--full" in sys.argv) or ("--once-verbose" in sys.argv)   # ejecución manual = todos los niveles

    def age(kind):
        if force:
            return 1e12
        ts = store.latest_ts(kind)
        if not ts:
            return 1e12
        try:
            return (now - _dt.datetime.fromisoformat(ts)).total_seconds()
        except Exception:
            return 1e12

    def grab(kind, fn):
        try:
            payload = fn()
            store.save(kind, payload, week=week)
            log.info("  snapshot %-9s OK (%s elementos)", kind, len(M.as_list(payload)))
        except Exception as e:
            log.warning("  snapshot %-9s FALLO: %s", kind, e)

    # ============ DATOS GLOBALES DE LALIGA (una vez, valen para todas las ligas) ====
    store.lid = None

    # marcador de la jornada actual (casi en vivo)
    if week:
        try:
            games = M.as_list(api.calendar(week))
            if games:
                store.save("calendar_live", {str(week): games}, week=week)
        except Exception as e:
            log.warning("  calendar_live jornada %s FALLO: %s", week, e)

    # tendencias de mercado (futbolfantasy) ~25 min
    if age("fftrends") > 1500:
        try:
            trends = ffscrape.scrape()
            store.save("fftrends", trends, week=week)
            log.info("  snapshot fftrends  OK (%s jugadores)", len(trends))
        except Exception as e:
            log.warning("  fftrends FALLO: %s", e)

    # pesado global ~2h: jugadores, equipos, calendario 38 jornadas, fotos/escudos
    if age("players") > 7200:
        grab("players", lambda: api.all_players())
        grab("teams", lambda: api.teams_master())
        cal_all = {}
        for wk in range(1, 39):
            try:
                games = M.as_list(api.calendar(wk))
                if games:
                    cal_all[str(wk)] = games
            except Exception:
                pass
            time.sleep(0.1)
        if cal_all:
            store.save("calendar", cal_all, week=week)
            log.info("  snapshot calendar  OK (%s jornadas)", len(cal_all))
        try:
            n = download_images(store.latest("players"))
            b = download_badges(store.latest("teams"))
            if n or b:
                log.info("  imágenes     OK (%d fotos, %d escudos)", n, b)
        except Exception as e:
            log.warning("  imágenes FALLO: %s", e)

    # noticias ~25 min
    if age("news") > 1500:
        try:
            news = ffscrape.scrape_news()
            if news:
                store.save("news", news, week=week)
                log.info("  snapshot news      OK (%s titulares)", len(news))
        except Exception as e:
            log.warning("  news FALLO: %s", e)

    # clasificación real de LaLiga ~25 min
    if age("laliga_table") > 1500:
        try:
            tbl = ffscrape.scrape_classification()
            if tbl:
                store.save("laliga_table", tbl, week=week)
                log.info("  snapshot tabla     OK (%s equipos)", len(tbl))
        except Exception as e:
            log.warning("  tabla FALLO: %s", e)

    # onces probables ~2h
    if age("onces") > 7200:
        try:
            onces = ffscrape.scrape_lineups(store.latest("teams"))
            if onces:
                store.save("onces", onces, week=week)
                log.info("  snapshot onces     OK (%s equipos)", len(onces))
        except Exception as e:
            log.warning("  onces FALLO: %s", e)

    # calendario completo por equipo ~12h
    if age("teamcal") > 43200:
        try:
            tc = ffscrape.scrape_team_calendars(store.latest("teams"))
            if tc:
                store.save("teamcal", tc, week=week)
                log.info("  snapshot teamcal   OK (%s equipos)", len(tc))
        except Exception as e:
            log.warning("  teamcal FALLO: %s", e)

    # estadísticas de jugadores (API) ~6h, solo con liga en juego
    season_live = any(M.pick(p, "points", default=0) for p in M.as_list(store.latest("players")))
    if season_live and age("playerstats") > 21600:
        stats = {}
        for p in M.as_list(store.latest("players")):
            pid = M.pick(p, "id", "playerMasterId", "playerId")
            if not pid:
                continue
            try:
                pm = (api.player(pid, any_lid) or {}).get("playerMaster") or {}
                stats[str(pid)] = M.aggregate_player_stats(pm.get("playerStats"))
            except Exception:
                pass
            time.sleep(0.05)
        if stats:
            store.save("playerstats", stats, week=week)
            log.info("  snapshot playerstats OK (%s jugadores)", len(stats))

    # ============ DATOS POR LIGA (bucle sobre cada liga del usuario) ================
    for lg in leagues:
        lid = M.pick(lg, "id")
        store.lid = str(lid)
        tag = M.pick(lg, "name", default=lid)

        # tu caja en esta liga (1 llamada; la única que la API deja ver)
        prev_money = store.latest("money") or {}
        own_tid = next(iter(prev_money), None)
        if own_tid:
            own_mgr = (prev_money.get(own_tid) or {}).get("manager")
            try:
                store.save("money", {str(own_tid): {"manager": own_mgr, **(api.team_money(own_tid) or {})}}, week=week)
            except Exception as e:
                if "403" not in str(e):
                    log.warning("  [%s] caja FALLO: %s", tag, e)

        # ligero ~4-5 min: clasificación, mercado, actividad
        if age("ranking") > 240:
            grab("ranking", lambda: api.ranking(lid))
            grab("market", lambda: api.market(lid))
            if week:
                grab("weekly", lambda: api.ranking_week(lid, week))
            for idx in range(5):
                try:
                    payload = api.activity(lid, idx)
                    store.save("activity", payload, week=week)
                    if not M.as_list(payload):
                        break
                except Exception as e:
                    log.warning("  [%s] activity[%d] FALLO: %s", tag, idx, e)
                    break
                time.sleep(0.3)

        # pesado por liga ~2h: plantillas de todos los equipos + caja propia
        if age("roster") > 7200:
            money_map, roster_map = {}, {}
            for t in M.as_list(store.latest("ranking")):
                tid, mgr = M.team_id(t), M.manager_name(t)
                if not tid:
                    continue
                try:
                    money_map[str(tid)] = {"manager": mgr, **(api.team_money(tid) or {})}
                except Exception as e:
                    if "403" not in str(e):
                        log.warning("  [%s] money %s FALLO: %s", tag, tid, e)
                try:
                    roster_map[str(tid)] = {"manager": mgr, "detail": api.team(lid, tid)}
                except Exception as e:
                    log.warning("  [%s] roster %s FALLO: %s", tag, tid, e)
                time.sleep(0.2)
            if money_map:
                store.save("money", money_map, week=week)
            if roster_map:
                store.save("roster", roster_map, week=week)
                log.info("  [%s] roster OK (%s equipos)", tag, len(roster_map))

    store.lid = None

    # --- DERIVE (multi-liga) + escribir web ---------------------------------
    data = M.build_multi(store, leagues, week)
    write_web(data)

    # PUBLICAR en Cloudflare Pages (opcional): FF_DEPLOY=1 + credenciales en el entorno.
    if os.environ.get("FF_DEPLOY") == "1" and age("_deploy") > 1200:
        try:
            subprocess.run(["bash", str(ROOT / "deploy.sh")], check=False, timeout=240)
            store.save("_deploy", {"t": now.isoformat()}, week=week)
            log.info("  deploy     Cloudflare Pages OK")
        except Exception as e:
            log.warning("  deploy FALLO: %s", e)

    store.close()
    log.info("Listo. %d ligas -> %s", len(data.get("leagues", {})), WEB_DATA)


if __name__ == "__main__":
    main()
