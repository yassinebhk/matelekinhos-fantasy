"""
Almacén de usuarios de la liga: guarda el refresh_token de cada miembro CIFRADO
(Fernet) en SQLite, y firma las cookies de sesión con la misma clave.

La clave sale de la variable de entorno FANTASY_SECRET (recomendado en producción).
Si no existe, se genera una y se guarda en server/.secret (modo desarrollo).
NUNCA subas users.db ni .secret a ningún sitio público.
"""

import os
import json
import time
import base64
import sqlite3
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

ROOT = Path(__file__).resolve().parent.parent
SECRET_FILE = Path(__file__).resolve().parent / ".secret"
DB = ROOT / "users.db"


def _load_key() -> bytes:
    env = os.environ.get("FANTASY_SECRET")
    if env:
        return env.encode() if len(env) >= 44 else base64.urlsafe_b64encode(env.encode().ljust(32)[:32])
    if SECRET_FILE.exists():
        return SECRET_FILE.read_bytes().strip()
    key = Fernet.generate_key()
    SECRET_FILE.write_bytes(key)
    try:
        SECRET_FILE.chmod(0o600)
    except Exception:
        pass
    return key


_FERNET = Fernet(_load_key())


class UserStore:
    def __init__(self, path: Path = DB):
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.db.execute("""CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY, email TEXT, name TEXT,
            refresh_enc BLOB, client_id TEXT, created REAL, updated REAL)""")
        self.db.commit()

    def save_user(self, user_id, email, name, refresh_token, client_id):
        enc = _FERNET.encrypt(refresh_token.encode()) if refresh_token else b""
        now = time.time()
        self.db.execute(
            """INSERT INTO users (user_id, email, name, refresh_enc, client_id, created, updated)
               VALUES (?,?,?,?,?,?,?)
               ON CONFLICT(user_id) DO UPDATE SET
                 email=excluded.email, name=excluded.name,
                 refresh_enc=CASE WHEN length(excluded.refresh_enc)>0 THEN excluded.refresh_enc ELSE users.refresh_enc END,
                 client_id=excluded.client_id, updated=excluded.updated""",
            (user_id, email, name, enc, client_id, now, now))
        self.db.commit()

    def get_refresh(self, user_id):
        row = self.db.execute("SELECT refresh_enc, client_id FROM users WHERE user_id=?", (user_id,)).fetchone()
        if not row or not row[0]:
            return None, None
        try:
            return _FERNET.decrypt(row[0]).decode(), row[1]
        except InvalidToken:
            return None, None

    def get_user(self, user_id):
        row = self.db.execute("SELECT user_id, email, name, client_id, updated FROM users WHERE user_id=?",
                              (user_id,)).fetchone()
        if not row:
            return None
        return {"user_id": row[0], "email": row[1], "name": row[2], "client_id": row[3], "updated": row[4]}

    def all_users(self):
        rows = self.db.execute("SELECT user_id, email, name, client_id FROM users").fetchall()
        return [{"user_id": r[0], "email": r[1], "name": r[2], "client_id": r[3]} for r in rows]


# --- cookies de sesión firmadas/cifradas (mismo Fernet) ---------------------
def make_session(user_id: str) -> str:
    return _FERNET.encrypt(json.dumps({"u": user_id, "t": int(time.time())}).encode()).decode()


def read_session(token: str, max_age_days: int = 60):
    if not token:
        return None
    try:
        data = json.loads(_FERNET.decrypt(token.encode(), ttl=max_age_days * 86400))
        return data.get("u")
    except (InvalidToken, Exception):
        return None
