"""
Login para cuentas que entran con Google/Apple (o email), en DOS pasos, para
no depender de mantener un proceso vivo entre que abres el navegador y copias
el resultado.

  Paso 1:  python -m exporter.login
           -> genera la URL de login y guarda el verifier PKCE en disco.
              Ábrela, inicia sesión, y al final el navegador intentará ir a
              authredirect://com.lfp.laligafantasy?...&code=...  (dará un error
              "no hay app registrada": es normal). Copia ESA URL entera.

  Paso 2:  python -m exporter.login --code "authredirect://...?...&code=..."
           -> canjea el code por tokens y los guarda en .token.json.
              (Acepta la URL entera o solo el valor de code=.)

A partir de ahí el cron se renueva solo. Si usas email/contraseña normal, NO
necesitas esto: rellena email/password en config.json.
"""

import base64
import hashlib
import os
import sys
import json
import webbrowser
import urllib.parse
from pathlib import Path

import requests

from .auth import (TOKEN_URL, POLICY_SIGNIN, EMAIL_CLIENT_ID, REDIRECT_URI,
                   UA, TIMEOUT, _normalize, TokenCache)

AUTHORIZE_URL = TOKEN_URL.replace("/token", "/authorize")
ROOT = Path(__file__).resolve().parent.parent
TOKEN = ROOT / ".token.json"
PKCE = ROOT / ".login_pkce.json"   # efímero: se borra tras canjear el code


def _pkce():
    verifier = base64.urlsafe_b64encode(os.urandom(64)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def _extract_code(raw: str) -> str:
    raw = raw.strip().strip('"').strip("'")
    if "code=" in raw:
        query = urllib.parse.urlparse(raw).query or raw.split("?", 1)[-1]
        return urllib.parse.parse_qs(query).get("code", [""])[0] or raw
    return raw


def start():
    verifier, challenge = _pkce()
    state = base64.urlsafe_b64encode(os.urandom(16)).rstrip(b"=").decode()
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
    url = f"{AUTHORIZE_URL}?{urllib.parse.urlencode(params)}"
    PKCE.write_text(json.dumps({"verifier": verifier, "state": state}))
    try:
        PKCE.chmod(0o600)
    except Exception:
        pass

    print("\n=== PASO 1/2 ===")
    print("Abre esta URL, inicia sesión (Google/Apple/email) y, al final, el")
    print("navegador intentará ir a 'authredirect://...': dará un error de que")
    print("no hay app registrada. ESO ES CORRECTO. Copia la URL COMPLETA de ese error.\n")
    print(url + "\n")
    print("Luego canjéala (o pásasela a Claude):")
    print('  python -m exporter.login --code "authredirect://...&code=..."\n')
    if os.environ.get("LOGIN_NO_OPEN") != "1":
        try:
            webbrowser.open(url)
        except Exception:
            pass


def finish(raw: str):
    if not PKCE.exists():
        sys.exit("No encuentro el verifier PKCE. Ejecuta primero 'python -m exporter.login' (paso 1).")
    verifier = json.loads(PKCE.read_text()).get("verifier")
    code = _extract_code(raw)
    if not code:
        sys.exit("No pude leer ningún 'code' de lo que pegaste.")

    resp = requests.post(
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
    if not resp.ok:
        sys.exit(f"Error al canjear el code: {resp.status_code} {resp.text[:400]}\n"
                 "(Suele ser que el code caducó (~2 min) o ya se usó: repite el paso 1.)")

    tok = _normalize(resp.json(), EMAIL_CLIENT_ID)
    if not tok.get("refresh_token"):
        print("AVISO: no llegó refresh_token; la sesión podría durar solo 24h.")
    TokenCache(TOKEN).save(tok)
    PKCE.unlink(missing_ok=True)
    print(f"\nOK. Token guardado en {TOKEN}. Ya puedes ejecutar el exporter.")


def main():
    args = sys.argv[1:]
    if args and args[0] == "--code":
        finish(args[1] if len(args) > 1 else input("Pega el code o la URL authredirect://...: "))
    elif args and args[0].startswith("authredirect"):
        finish(args[0])
    else:
        start()


if __name__ == "__main__":
    main()
