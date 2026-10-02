"""SQLite persistence. Everything lives in data/presence.db, so the work
survives crashes, power loss and Windows restarts."""
import json
import os
import sqlite3
import threading
import time


class Store:
    def __init__(self, data_dir):
        os.makedirs(data_dir, exist_ok=True)
        self.data_dir = data_dir
        self.path = os.path.join(data_dir, "presence.db")
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
            CREATE TABLE IF NOT EXISTS threads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts REAL, day INTEGER, seed INTEGER,
                duration REAL, speed REAL, points TEXT, gestures TEXT);
            CREATE TABLE IF NOT EXISTS clusters (id INTEGER PRIMARY KEY, data TEXT);
            CREATE TABLE IF NOT EXISTS snapshots (k TEXT PRIMARY KEY, ts REAL, state TEXT);
            CREATE TABLE IF NOT EXISTS persons (
                id INTEGER PRIMARY KEY AUTOINCREMENT, emb BLOB, first REAL, last REAL, visits INTEGER);
            CREATE TABLE IF NOT EXISTS damages (
                id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, day INTEGER,
                x REAL, y REAL, strength REAL, seed INTEGER, cause TEXT);
            """
        )
        cols = [r[1] for r in self.db.execute("PRAGMA table_info(threads)").fetchall()]
        if "person_id" not in cols:
            self.db.execute("ALTER TABLE threads ADD COLUMN person_id INTEGER")
            self.db.execute("CREATE INDEX IF NOT EXISTS threads_person ON threads(person_id)")

    # --- meta -------------------------------------------------------------
    def meta_get(self, k, default=None):
        with self.lock:
            r = self.db.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
        return r[0] if r else default

    def meta_set(self, k, v):
        with self.lock:
            self.db.execute("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", (k, str(v)))

    # --- threads ----------------------------------------------------------
    def insert_thread(self, t):
        with self.lock:
            cur = self.db.execute(
                "INSERT INTO threads (ts, day, seed, duration, speed, points, gestures, person_id)"
                " VALUES (?,?,?,?,?,?,?,?)",
                (t["ts"], t["day"], t["seed"], t["duration"], t["speed"],
                 json.dumps(t["pts"]), json.dumps(t.get("gestures") or {}), t.get("person")),
            )
            return cur.lastrowid

    def count_threads(self):
        with self.lock:
            return self.db.execute("SELECT COUNT(*) FROM threads").fetchone()[0]

    def recent_threads(self, n):
        with self.lock:
            rows = self.db.execute(
                "SELECT id, ts, day, seed, duration, speed, points FROM threads ORDER BY id DESC LIMIT ?", (n,)
            ).fetchall()
        return [
            {"id": r[0], "ts": r[1], "day": r[2], "seed": r[3], "duration": r[4], "speed": r[5],
             "pts": json.loads(r[6])}
            for r in reversed(rows)
        ]

    def iter_threads(self):
        with self.lock:
            rows = self.db.execute(
                "SELECT id, ts, day, seed, duration, speed, points, gestures FROM threads ORDER BY id"
            ).fetchall()
        for r in rows:
            yield {"id": r[0], "ts": r[1], "day": r[2], "seed": r[3], "duration": r[4], "speed": r[5],
                   "pts": json.loads(r[6]), "gestures": json.loads(r[7] or "{}")}

    def person_threads(self, pid, n=16):
        with self.lock:
            rows = self.db.execute(
                "SELECT id, points FROM threads WHERE person_id=? ORDER BY id DESC LIMIT ?", (pid, n)).fetchall()
        return [(r[0], json.loads(r[1])) for r in rows]

    # --- persons: an anonymous face signature (128 numbers), never an image ---
    def persons_all(self):
        with self.lock:
            return self.db.execute("SELECT id, emb, visits FROM persons").fetchall()

    def person_create(self, emb_bytes):
        now = time.time()
        with self.lock:
            cur = self.db.execute("INSERT INTO persons (emb, first, last, visits) VALUES (?,?,?,1)",
                                  (emb_bytes, now, now))
            return cur.lastrowid

    def person_update(self, pid, emb_bytes):
        with self.lock:
            self.db.execute("UPDATE persons SET emb=?, last=?, visits=visits+1 WHERE id=?",
                            (emb_bytes, time.time(), pid))

    def persons_forget_all(self):
        with self.lock:
            self.db.execute("DELETE FROM persons")
            self.db.execute("UPDATE threads SET person_id=NULL")

    # --- damages ------------------------------------------------------------
    def insert_damage(self, d):
        with self.lock:
            cur = self.db.execute(
                "INSERT INTO damages (ts, day, x, y, strength, seed, cause) VALUES (?,?,?,?,?,?,?)",
                (d["ts"], d["day"], d["x"], d["y"], d["strength"], d["seed"], d["cause"]))
            return cur.lastrowid

    def damages(self):
        with self.lock:
            return self.db.execute(
                "SELECT id, x, y, strength, seed, ts, cause FROM damages ORDER BY id").fetchall()

    # --- clusters ---------------------------------------------------------
    def load_clusters(self):
        with self.lock:
            rows = self.db.execute("SELECT data FROM clusters").fetchall()
        return [json.loads(r[0]) for r in rows]

    def save_clusters(self, clusters, deleted=()):
        with self.lock:
            self.db.execute("BEGIN")
            try:
                for c in clusters:
                    self.db.execute("INSERT OR REPLACE INTO clusters (id, data) VALUES (?, ?)",
                                    (c["id"], json.dumps(c)))
                for cid in deleted:
                    self.db.execute("DELETE FROM clusters WHERE id=?", (cid,))
                self.db.execute("COMMIT")
            except Exception:
                self.db.execute("ROLLBACK")
                raise

    # --- snapshots (one per day + "final" + "live" on mirrors) -------------
    def save_snapshot(self, key, state_json):
        with self.lock:
            self.db.execute("INSERT OR REPLACE INTO snapshots (k, ts, state) VALUES (?,?,?)",
                            (str(key), time.time(), state_json))

    def get_snapshot(self, key):
        with self.lock:
            r = self.db.execute("SELECT state FROM snapshots WHERE k=?", (str(key),)).fetchone()
        return r[0] if r else None

    def list_snapshots(self):
        with self.lock:
            return [r[0] for r in self.db.execute("SELECT k FROM snapshots ORDER BY k").fetchall()]

    # --- backup -----------------------------------------------------------
    def backup(self, keep=48):
        folder = os.path.join(self.data_dir, "backups")
        os.makedirs(folder, exist_ok=True)
        dest = os.path.join(folder, time.strftime("presence-%Y%m%d-%H%M.db"))
        with self.lock:
            target = sqlite3.connect(dest)
            self.db.backup(target)
            target.close()
        files = sorted(f for f in os.listdir(folder) if f.endswith(".db"))
        for f in files[:-keep]:
            try:
                os.remove(os.path.join(folder, f))
            except OSError:
                pass
        return dest
