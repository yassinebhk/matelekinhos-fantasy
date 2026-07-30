"""
Capa de INGEST: guarda snapshots crudos con timestamp. Inmutable.
Todo lo demas (rachas, deltas, comparativas) se recalcula leyendo de aqui,
asi que nunca pierdes historico aunque cambies las metricas mas adelante.
"""

import json
import sqlite3
import datetime as dt
from pathlib import Path


# Datos específicos de cada liga (se guardan con sufijo @<liga>); el resto es global.
PER_LEAGUE = {"ranking", "weekly", "activity", "roster", "money", "market"}


class Store:
    def __init__(self, path: Path):
        self.lid = None      # contexto de liga actual; namespacea los kinds PER_LEAGUE
        self.con = sqlite3.connect(str(path))
        self.con.execute("""
            CREATE TABLE IF NOT EXISTS snapshots (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                captured TEXT NOT NULL,     -- ISO8601 UTC
                week     INTEGER,           -- jornada activa en ese momento
                kind     TEXT NOT NULL,     -- ranking|activity|market|...
                payload  TEXT NOT NULL      -- JSON crudo tal cual lo devolvio la API
            )
        """)
        self.con.execute("CREATE INDEX IF NOT EXISTS ix_kind ON snapshots(kind, id)")
        self.con.commit()

    def _k(self, kind: str) -> str:
        """Namespacea por liga los kinds PER_LEAGUE cuando hay contexto de liga."""
        return f"{kind}@{self.lid}" if (self.lid and kind in PER_LEAGUE) else kind

    def save(self, kind: str, payload, week=None):
        self.con.execute(
            "INSERT INTO snapshots (captured, week, kind, payload) VALUES (?,?,?,?)",
            (dt.datetime.now(dt.timezone.utc).isoformat(), week, self._k(kind),
             json.dumps(payload, ensure_ascii=False)),
        )
        self.con.commit()

    def latest(self, kind: str):
        row = self.con.execute(
            "SELECT payload FROM snapshots WHERE kind=? ORDER BY id DESC LIMIT 1", (self._k(kind),)
        ).fetchone()
        return json.loads(row[0]) if row else None

    def latest_ts(self, kind: str):
        """ISO8601 del snapshot mas reciente de un tipo (o None). Para tiers del cron."""
        row = self.con.execute(
            "SELECT captured FROM snapshots WHERE kind=? ORDER BY id DESC LIMIT 1", (self._k(kind),)
        ).fetchone()
        return row[0] if row else None

    def series(self, kind: str):
        """Todos los snapshots de un tipo, en orden cronologico."""
        rows = self.con.execute(
            "SELECT captured, week, payload FROM snapshots WHERE kind=? ORDER BY id", (self._k(kind),)
        ).fetchall()
        return [(c, w, json.loads(p)) for c, w, p in rows]

    def close(self):
        self.con.close()
