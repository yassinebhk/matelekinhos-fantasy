"""
Autenticacion OAuth2 contra el tenant Azure B2C de LaLiga.

Parametros (client_ids, politicas, endpoints) extraidos del cliente de
referencia LaLigaApp v3.5.0 (jul 2026). Si LaLiga los cambia, se editan aqui.

Dos caminos:
  - ROPC (email + contrasena)  -> login 100% automatico, sin navegador.  << recomendado
  - Refresh token              -> renovacion desatendida a partir de ahi.

El token que la API usa como Bearer es el id_token (con fallback a access_token).
"""

import json
import time
import base64
from pathlib import Path

import requests

TOKEN_URL = "https://login.laliga.es/laligadspprob2c.onmicrosoft.com/oauth2/v2.0/token"

# client_ids reales del tenant B2C de LaLiga
EMAIL_CLIENT_ID = "af88bcff-1157-40a0-b579-030728aacf0b"   # flujo email/contrasena (ROPC)
WEB_CLIENT_ID   = "6457fa17-1224-416a-b21a-ee6ce76e9bc0"   # flujo web

POLICY_ROPC   = "B2C_1A_ResourceOwnerv2"                   # login email/contrasena
POLICY_SIGNIN = "B2C_1A_5ULAIP_PARAMETRIZED_SIGNIN"        # emite y refresca tokens

REDIRECT_URI = "authredirect://com.lfp.laligafantasy"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

TIMEOUT = 25


class AuthError(Exception):
    pass


def _decode_exp(id_token: str) -> int | None:
    """Lee el 'exp' del JWT sin verificar firma (solo para saber cuando caduca)."""
    try:
        payload = id_token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        data = json.loads(base64.urlsafe_b64decode(payload))
        return int(data.get("exp"))
    except Exception:
        return None


def _normalize(tok: dict, issuing_client: str) -> dict:
    """Deja el token en una forma estable y calcula 'expires_on' (epoch)."""
    id_token = tok.get("id_token")
    # La API de LaLiga usa el id_token como Bearer (el B2C suele emitir solo id_token
    # para el scope openid); caemos al access_token solo si no hay id_token.
    bearer = id_token or tok.get("access_token")
    now = int(time.time())
    expires_on = (
        tok.get("expires_on")
        or _decode_exp(id_token or "")
        or now + int(tok.get("id_token_expires_in") or tok.get("expires_in") or 86400)
    )
    return {
        "bearer": bearer,
        "id_token": id_token,
        "access_token": tok.get("access_token"),
        "refresh_token": tok.get("refresh_token"),
        "expires_on": int(expires_on),
        "client_id": issuing_client,
    }


def login_password(email: str, password: str) -> dict:
    """Login ROPC: intercambia email+contrasena por tokens. Sin navegador."""
    url = f"{TOKEN_URL}?p={POLICY_ROPC}"
    body = {
        "grant_type": "password",
        "client_id": EMAIL_CLIENT_ID,
        "scope": f"openid {EMAIL_CLIENT_ID} offline_access",
        "redirect_uri": REDIRECT_URI,
        "username": email,
        "password": password,
        "response_type": "id_token",
    }
    r = requests.post(url, data=body,
                      headers={"Content-Type": "application/x-www-form-urlencoded",
                               "User-Agent": UA},
                      timeout=TIMEOUT)
    if not r.ok:
        raise AuthError(_err(r))
    return _normalize(r.json(), EMAIL_CLIENT_ID)


def refresh(refresh_token: str, client_id: str = EMAIL_CLIENT_ID) -> dict:
    """Renueva tokens con el refresh_token. Este es el paso que corre el cron."""
    url = f"{TOKEN_URL}?p={POLICY_SIGNIN}"
    body = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": client_id or WEB_CLIENT_ID,
        "scope": "openid offline_access",
    }
    r = requests.post(url, data=body,
                      headers={"Content-Type": "application/x-www-form-urlencoded",
                               "User-Agent": UA},
                      timeout=TIMEOUT)
    if not r.ok:
        raise AuthError("invalid_grant" if r.status_code in (400, 401) else _err(r))
    tok = _normalize(r.json(), client_id)
    if not tok["bearer"]:
        raise AuthError("refresh sin id_token/access_token")
    return tok


def _err(r: requests.Response) -> str:
    try:
        j = r.json()
        return j.get("error_description") or j.get("error") or r.text[:300]
    except Exception:
        return f"{r.status_code} {r.text[:300]}"


# ---------------------------------------------------------------------------
# Cache de token en disco: guarda el ultimo bundle y lo refresca solo cuando
# quedan <5 min. Asi el cron no re-loguea en cada ejecucion.
# ---------------------------------------------------------------------------
class TokenCache:
    def __init__(self, path: Path):
        self.path = Path(path)

    def load(self) -> dict | None:
        if self.path.exists():
            return json.loads(self.path.read_text())
        return None

    def save(self, tok: dict):
        self.path.write_text(json.dumps(tok, indent=2))
        try:
            self.path.chmod(0o600)  # el fichero contiene el refresh token
        except Exception:
            pass

    def valid_bearer(self, tok: dict | None) -> bool:
        return bool(tok and tok.get("bearer") and tok.get("expires_on", 0) - time.time() > 300)


def get_bearer(cache: TokenCache, *, email: str | None, password: str | None) -> str:
    """
    Devuelve un bearer valido, en este orden:
      1) el cacheado si aun sirve,
      2) refrescandolo con el refresh_token,
      3) haciendo login ROPC con email/contrasena (si estan disponibles).
    """
    tok = cache.load()
    if cache.valid_bearer(tok):
        return tok["bearer"]

    if tok and tok.get("refresh_token"):
        try:
            new = refresh(tok["refresh_token"], tok.get("client_id") or EMAIL_CLIENT_ID)
            cache.save(new)
            return new["bearer"]
        except AuthError as e:
            if "invalid_grant" not in str(e):
                raise
            # refresh caducado -> caemos a login con credenciales

    if email and password:
        new = login_password(email, password)
        cache.save(new)
        return new["bearer"]

    raise AuthError(
        "No hay token valido y no puedo renovar.\n"
        "  -> Si usas login por email: rellena email/password en config.json.\n"
        "  -> Si usas Google/Apple: ejecuta 'python -m exporter.login' una vez "
        "para capturar el refresh token."
    )
