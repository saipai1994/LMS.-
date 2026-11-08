from __future__ import annotations
import json
import sqlite3
import threading
import time
from typing import Optional


class Cache:
    """Tiny sqlite KV so a revealed contact is never paid for twice."""
    def __init__(self, path: str):
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.lock = threading.Lock()
        self.db.execute("CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL, ts REAL NOT NULL)")
        self.db.commit()

    def get(self, key: str, max_age_days: float = 90) -> Optional[dict]:
        with self.lock:
            row = self.db.execute("SELECT v, ts FROM kv WHERE k=?", (key,)).fetchone()
        if not row or time.time() - row[1] > max_age_days * 86400:
            return None
        return json.loads(row[0])

    def put(self, key: str, value: dict) -> None:
        with self.lock:
            self.db.execute("INSERT OR REPLACE INTO kv VALUES(?,?,?)", (key, json.dumps(value), time.time()))
            self.db.commit()
