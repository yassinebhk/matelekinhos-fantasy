"""
Flujo de login web (por usuario) contra el B2C de LaLiga.

Reutiliza la config del exportador. Como LaLiga solo admite el redirect de su app
(authredirect://), el flujo es: generamos la URL de login -> el usuario entra en la
página REAL de LaLiga -> el navegador falla al abrir authredirect://...?code=... ->
el usuario nos pega esa URL -> canjeamos el code por tokens (server-side, con el
verifier PKCE de su sesión).
"""

import os
import json
import base64
import hashlib
import urllib.parse

import requests

from exporter.auth import (TOKEN_URL, POLICY_SIGNIN, EMAIL_CLIENT_ID, REDIRECT_URI,
                           UA, TIMEOUT, _normalize, refresh as _refresh)

AUTHORIZE_URL = TOKEN_URL.replace("/token", "/authorize")


def new_pkce():
    verifier = base64.urlsafe_b64encode(os.urandom(64)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = base64.urlsafe_b64encode(os.urandom(16)).rstrip(b"=").decode()
    return verifier, challenge, state


def authorize_url(challenge: str, state: str) -> str:
    params = {
        "p": POLICY_SIGNIN,
        "client_id": EMAIL_CLIENT_ID,
        "response_type": "code",
        "redirect_uri": REDIRECT_URI,
        "scope": "openid offline_access",
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
        "nonce": state,
    }
    return f"{AUTHORIZE_URL}?{urllib.parse.urlencode(params)}"


def extract_code(raw: str) -> str:
    raw = (raw or "").strip().strip('"').strip("'")
    if "code=" in raw:
        query = urllib.parse.urlparse(raw).query or raw.split("?", 1)[-1]
        return urllib.parse.parse_qs(query).get("code", [""])[0] or ""
    return raw


def exchange_code(code: str, verifier: str) -> dict:
    r = requests.post(
        f"{TOKEN_URL}?p={POLICY_SIGNIN}",
        data={
            "grant_type": "authorization_code",
            "client_id": EMAIL_CLIENT_ID,
            "code": code,
            "redirect_uri": REDIRECT_URI,
            "code_verifier": verifier,
            "scope": "openid offline_access",
        },
        headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA},
        timeout=TIMEOUT,
    )
    if not r.ok:
        raise ValueError(f"exchange_failed:{r.status_code}:{r.text[:200]}")
    return _normalize(r.json(), EMAIL_CLIENT_ID)


def identity(id_token: str) -> dict:
    """Extrae (sin verificar firma, solo para identificar) sub/email/nombre del id_token."""
    try:
        payload = id_token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        d = json.loads(base64.urlsafe_b64decode(payload))
    except Exception:
        return {}
    email = d.get("email") or (d.get("emails") or [None])[0]
    name = d.get("name") or " ".join(x for x in (d.get("given_name"), d.get("family_name")) if x) or email
    return {"sub": d.get("sub") or d.get("oid") or email, "email": email, "name": name}


def bearer_from_refresh(refresh_token: str, client_id: str = EMAIL_CLIENT_ID) -> dict:
    """Renueva y devuelve el bundle de tokens (incluye posible nuevo refresh_token)."""
    return _refresh(refresh_token, client_id or EMAIL_CLIENT_ID)
