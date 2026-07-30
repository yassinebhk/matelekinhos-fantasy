"""
Cliente de la API de LaLiga Fantasy.

Base y rutas extraidas del cliente de referencia (temporada 26/27):
  base:  https://fantasy-api.llt-services.com/api
  cmp:   /v1/competition/{COMPETITION_ID}   (COMPETITION_ID = 1 = Primera)

Todas las rutas llevan ?x-lang=es y auth por Bearer (id_token).
Si algun path devuelve 404, LaLiga lo habra movido: se ajusta aqui, en un solo sitio.
"""

import requests

BASE = "https://fantasy-api.llt-services.com/api"
COMPETITION_ID = "1"
CMP = f"/v1/competition/{COMPETITION_ID}"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
TIMEOUT = 25


class FantasyAPI:
    def __init__(self, bearer: str):
        self.s = requests.Session()
        self.s.headers.update({
            "Authorization": f"Bearer {bearer}",
            "Accept": "application/json",
            "User-Agent": UA,
            "x-lang": "es",   # el cliente real lo manda como header ademas de en la query
            "x-app": "2",     # identificador de app que inyecta el cliente oficial
        })

    def _get(self, path: str):
        sep = "&" if "?" in path else "?"
        url = f"{BASE}{path}{sep}x-lang=es"
        r = self.s.get(url, timeout=TIMEOUT)
        r.raise_for_status()
        return r.json()

    # --- usuario / ligas ---------------------------------------------------
    def current_user(self):
        return self._get("/v4/user/me")

    def leagues(self):
        return self._get(f"{CMP}/leagues")

    # --- clasificacion -----------------------------------------------------
    def ranking(self, league_id):
        return self._get(f"{CMP}/leagues/{league_id}/standing")

    def ranking_week(self, league_id, week):
        return self._get(f"{CMP}/leagues/{league_id}/standing/{week}")

    # --- actividad (compras, ventas, CLAUSULAZOS, pujas) -> novedades ------
    def activity(self, league_id, index=0):
        return self._get(f"{CMP}/leagues/{league_id}/activity/{index}")

    # --- equipos / mercado / jugadores ------------------------------------
    def team(self, league_id, team_id):
        return self._get(f"{CMP}/leagues/{league_id}/teams/{team_id}")

    def team_money(self, team_id):
        return self._get(f"{CMP}/teams/{team_id}/money")

    def market(self, league_id):
        return self._get(f"{CMP}/league/{league_id}/market")

    def all_players(self):
        return self._get(f"{CMP}/players")

    def teams_master(self):
        # catálogo de equipos reales (id -> nombre/escudo)
        return self._get("/v3/teams-master")

    def player(self, player_id, league_id):
        # incluye el historico marketValue (fecha -> valor) del jugador
        return self._get(f"{CMP}/player/{player_id}/league/{league_id}")

    def current_week(self):
        return self._get(f"{CMP}/week/current")

    def calendar(self, week):
        # partidos de una jornada: fecha/hora, equipos (localId/visitorId) y marcador
        return self._get(f"{CMP}/calendar?weekNumber={week}")
