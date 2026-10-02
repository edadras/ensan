"""The living world: presence threads -> connections -> clusters -> organisms.

Coordinates: x in [-W, W], y in [-1, 1] (16:9 world).
The server is the single source of truth; the TV and the website both
render the exact same compact state (seeded, deterministic geometry).
"""
import json
import math
import random
import threading
import time
from collections import deque
from datetime import date, datetime

W = 1.78
# The work evolves with the number of people, not with the calendar:
# a 6-day or a 10-day exhibition both reach the same stages.
STAGE_AT = [0, 20, 100, 250, 500, 1500, 4000]
PHASES = ["Birth", "Memory", "Connection", "Organism", "Collective", "Complexity", "Emergence"]
PHASES_FA = ["تولد", "حافظه", "اتصال", "ارگانیسم", "جمع", "پیچیدگی", "ظهور"]
MAX_RECENT = 320          # raw threads shown individually
FREEZE_SECONDS = 180      # slow-down duration before the final freeze
SNAPSHOT_EVERY = 120      # seconds between day snapshots
CONSOLIDATE_EVERY = 20    # seconds between merge/compress passes


def clamp(v, a, b):
    return a if v < a else b if v > b else v


def growth_curve(visitors):
    """Non-linear accumulation: almost nothing at 20, structures at 500,
    something unimaginable at 10,000."""
    c = clamp(math.log10(1 + visitors) / 4.0, 0.0, 1.0)
    return c ** 2.2


def resample(points, n):
    """Arc-length resample a polyline to n points."""
    if len(points) < 2:
        return [list(points[0])] * 2 if points else []
    d = [0.0]
    for a, b in zip(points, points[1:]):
        d.append(d[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    total = d[-1]
    if total < 1e-6:
        return [list(points[0]), list(points[-1])]
    out, j = [], 0
    for i in range(n):
        t = total * i / (n - 1)
        while j < len(d) - 2 and d[j + 1] < t:
            j += 1
        seg = d[j + 1] - d[j] or 1e-9
        f = (t - d[j]) / seg
        a, b = points[j], points[j + 1]
        out.append([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f])
    return out


def _r(v):
    return round(v, 3)


def node_cap(mass):
    return int(min(72, 10 + 9 * math.log2(1 + mass)))


class World:
    def __init__(self, store, cfg):
        self.store = store
        self.cfg = cfg
        self.lock = threading.RLock()
        self.version = int(time.time()) % 1000000 * 10
        self.visitors = store.count_threads()
        self.clusters = {c["id"]: c for c in store.load_clusters()}
        self.next_cluster = max(self.clusters, default=0) + 1
        self.recent = deque(store.recent_threads(MAX_RECENT), maxlen=MAX_RECENT)
        self.pulses = deque(maxlen=12)
        self.arrivals = deque(maxlen=64)
        self.live = []
        self.live_ts = 0.0
        self.dirty_clusters = set()
        self._cache_key = None
        self._cache = None
        self._last_consolidate = 0.0
        self._last_snapshot = 0.0
        self._last_backup = time.time()
        self._snap_version = None
        self._person_cache = {}
        self.damage_list = [list(r) for r in store.damages()]
        self._last_damage = 0.0
        self._damage_times = deque(maxlen=200)

        start = cfg.get("start_date") or store.meta_get("start_date")
        if not start:
            start = date.today().isoformat()
        store.meta_set("start_date", start)
        self.start_date = date.fromisoformat(start)
        self.end_time = None
        if cfg.get("end_time"):
            self.end_time = datetime.strptime(cfg["end_time"], "%Y-%m-%d %H:%M").timestamp()
        self.freeze_started = float(store.meta_get("freeze_started", "0") or 0)
        self.frozen = store.meta_get("frozen") == "1"

    # ------------------------------------------------------------------ time
    def days(self):
        return int(clamp(int(self.cfg.get("days", 7)), 1, 30))

    def day(self):
        """Calendar day of the exhibition (only used for the daily archive)."""
        if self.cfg.get("day_override"):
            return int(clamp(int(self.cfg["day_override"]), 1, self.days()))
        return int(clamp((date.today() - self.start_date).days + 1, 1, self.days()))

    def stage(self):
        """1..7, from the number of visitors."""
        return max(i + 1 for i, t in enumerate(STAGE_AT) if self.visitors >= t)

    def evolution(self):
        return clamp(growth_curve(self.visitors), 0.0, 1.0)

    def freeze_progress(self):
        if self.frozen:
            return 1.0
        if not self.freeze_started:
            return 0.0
        return clamp((time.time() - self.freeze_started) / FREEZE_SECONDS, 0.0, 1.0)

    def accepting(self):
        return not self.freeze_started and not self.frozen

    def params(self):
        d = self.stage()
        evo = self.evolution()
        return {
            "drift": 0.0 if d < 2 else clamp(0.35 + 0.11 * (d - 2), 0, 1),
            "connect": 0.0 if d < 3 else clamp(0.45 + 0.13 * (d - 3) + 0.2 * evo, 0, 1),
            "volume": 0.0 if d < 4 else clamp(0.45 + 0.18 * (d - 4), 0, 1),
            "wave": 0.0 if d < 5 else clamp(0.6 + 0.2 * (d - 5), 0, 1),
            "complexity": 0.0 if d < 6 else (0.65 if d == 6 else 1.0),
            "emergence": 1.0 if d >= 7 else 0.0,
            "freeze": self.freeze_progress(),
        }

    # -------------------------------------------------------------- presence
    def add_presence(self, points, duration=2.0, speed=0.2, gestures=None, ts=None, day=None, person=None):
        """A person left. Their path becomes one faint Presence Thread."""
        if not points or len(points) < 2:
            return None
        with self.lock:
            if not self.accepting():
                return None
            ts = ts or time.time()
            pts = [[clamp(p[0], -W, W), clamp(p[1], -1, 1)] for p in points]
            n = int(clamp(len(pts), 6, 22))
            pts = [[_r(x), _r(y)] for x, y in resample(pts, n)]
            t = {
                "ts": ts, "day": day or self.day(), "seed": random.randint(1, 2 ** 31 - 1),
                "duration": float(duration), "speed": float(speed), "pts": pts,
                "gestures": gestures or {}, "person": person,
            }
            t["id"] = self.store.insert_thread(t)
            self.recent.append(t)
            self.visitors += 1
            if person:
                self._person_cache.pop(person, None)
            self._absorb(t)

            # Collective response: simultaneous arrivals send a wave.
            now = time.time()
            self.arrivals.append(now)
            together = sum(1 for a in self.arrivals if now - a < 10)
            wave = self.params()["wave"]
            strength = (0.35 + 0.25 * min(together, 5)) * (0.3 + wave)
            mid = pts[len(pts) // 2]
            self.pulses.append([mid[0], mid[1], _r(strength), round(now, 2)])
            self.version += 1
            return t["id"]

    def _absorb(self, t):
        pts = t["pts"]
        sample = [pts[0], pts[len(pts) // 2], pts[-1]]
        evo = self.evolution()
        radius = 0.07 + 0.07 * evo
        best, best_d = None, 1e9
        for c in self.clusters.values():
            nodes = c["nodes"]
            for p in sample:
                for q in nodes:
                    dd = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2
                    if dd < best_d:
                        best_d, best = dd, c
        if best is not None and math.sqrt(best_d) < radius:
            c = best
            nodes = c["nodes"]
            prev = None
            for p in sample:
                k = min(range(len(nodes)), key=lambda i: (nodes[i][0] - p[0]) ** 2 + (nodes[i][1] - p[1]) ** 2)
                q = nodes[k]
                nodes.append([_r(p[0] + (q[0] - p[0]) * 0.3), _r(p[1] + (q[1] - p[1]) * 0.3)])
                new = len(nodes) - 1
                c["links"].append([k, new])
                if prev is not None:
                    c["links"].append([prev, new])
                prev = new
            c["mass"] += 1
            self._reduce(c, node_cap(c["mass"]))
        else:
            c = {
                "id": self.next_cluster, "seed": t["seed"], "mass": 1, "born": t["day"],
                "nodes": [list(p) for p in sample], "links": [[0, 1], [1, 2]],
            }
            self.next_cluster += 1
            self.clusters[c["id"]] = c
        self.dirty_clusters.add(c["id"])
        self.store.save_clusters([c])

    @staticmethod
    def _reduce(c, cap):
        """Compression: merge the two closest nodes until under cap."""
        nodes, links = c["nodes"], c["links"]
        while len(nodes) > cap:
            bi, bj, bd = 0, 1, 1e9
            for i in range(len(nodes)):
                xi, yi = nodes[i]
                for j in range(i + 1, len(nodes)):
                    dd = (xi - nodes[j][0]) ** 2 + (yi - nodes[j][1]) ** 2
                    if dd < bd:
                        bi, bj, bd = i, j, dd
            a, b = nodes[bi], nodes[bj]
            nodes[bi] = [_r((a[0] + b[0]) / 2), _r((a[1] + b[1]) / 2)]
            del nodes[bj]
            new_links = set()
            for x, y in links:
                x = bi if x == bj else (x - 1 if x > bj else x)
                y = bi if y == bj else (y - 1 if y > bj else y)
                if x != y:
                    new_links.add((min(x, y), max(x, y)))
            links[:] = [list(l) for l in new_links]
        # cap the number of links too (keep the structure readable)
        max_links = len(nodes) * 3
        if len(links) > max_links:
            random.Random(c["seed"]).shuffle(links)
            del links[max_links:]

    @staticmethod
    def centroid(c):
        n = c["nodes"]
        return (sum(p[0] for p in n) / len(n), sum(p[1] for p in n) / len(n))

    def consolidate(self):
        """create -> connect -> merge -> compress -> evolve."""
        with self.lock:
            evo = self.evolution()
            cap = max(18, int(90 - 72 * evo))
            merge_r = 0.04 + 0.1 * evo
            deleted, changed = [], set()
            while len(self.clusters) > 1:
                cl = list(self.clusters.values())
                cents = [self.centroid(c) for c in cl]
                bd, bi, bj = 1e9, 0, 1
                for i in range(len(cl)):
                    for j in range(i + 1, len(cl)):
                        d = math.hypot(cents[i][0] - cents[j][0], cents[i][1] - cents[j][1])
                        # heavier clusters attract from further away
                        d /= 1 + 0.04 * math.log1p(cl[i]["mass"] + cl[j]["mass"])
                        if d < bd:
                            bd, bi, bj = d, i, j
                if bd >= merge_r and len(cl) <= cap:
                    break
                a, b = cl[bi], cl[bj]
                if b["mass"] > a["mass"]:
                    a, b = b, a
                off = len(a["nodes"])
                # bridge between the closest pair of nodes
                bk = min(((i, j) for i in range(len(a["nodes"])) for j in range(len(b["nodes"]))),
                         key=lambda ij: (a["nodes"][ij[0]][0] - b["nodes"][ij[1]][0]) ** 2
                         + (a["nodes"][ij[0]][1] - b["nodes"][ij[1]][1]) ** 2)
                a["nodes"] += b["nodes"]
                a["links"] += [[x + off, y + off] for x, y in b["links"]]
                a["links"].append([bk[0], bk[1] + off])
                a["mass"] += b["mass"]
                self._reduce(a, node_cap(a["mass"]))
                del self.clusters[b["id"]]
                deleted.append(b["id"])
                changed.discard(b["id"])
                changed.add(a["id"])
            if deleted or changed:
                self.store.save_clusters([self.clusters[i] for i in changed if i in self.clusters], deleted)
                self.version += 1

    def organisms(self):
        evo = self.evolution()
        day = self.stage()
        cl = [c for c in self.clusters.values() if c["mass"] >= 2]
        if not cl:
            return []
        cents = [self.centroid(c) for c in cl]
        parent = list(range(len(cl)))

        def find(i):
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        r = 0.2 + 0.55 * evo
        for i in range(len(cl)):
            for j in range(i + 1, len(cl)):
                if day >= 7 or math.hypot(cents[i][0] - cents[j][0], cents[i][1] - cents[j][1]) < r:
                    parent[find(i)] = find(j)
        groups = {}
        for i in range(len(cl)):
            groups.setdefault(find(i), []).append(i)
        out = []
        for members in groups.values():
            m = sum(cl[i]["mass"] for i in members)
            x = sum(cents[i][0] * cl[i]["mass"] for i in members) / m
            y = sum(cents[i][1] * cl[i]["mass"] for i in members) / m
            rad = max(math.hypot(cents[i][0] - x, cents[i][1] - y) for i in members) + 0.1
            out.append({"x": _r(x), "y": _r(y), "r": _r(rad), "m": m, "c": [cl[i]["id"] for i in members]})
        out.sort(key=lambda o: -o["m"])
        return out

    # ---------------------------------------------------------------- damage
    def damage(self, x, y=0.0, strength=0.7, cause="strike"):
        """Shouting, striking or displeasure breaks a small part of the work.
        The broken pieces fall to the floor and stay there."""
        dcfg = self.cfg.get("damage", {})
        if not dcfg.get("enabled", True):
            return None
        with self.lock:
            if not self.accepting():
                return None
            now = time.time()
            if now - self._last_damage < dcfg.get("cooldown", 12):
                return None
            if sum(1 for t in self._damage_times if now - t < 3600) >= dcfg.get("max_per_hour", 30):
                return None
            self._last_damage = now
            self._damage_times.append(now)
            d = {"ts": now, "day": self.day(), "x": _r(clamp(x, -W, W)), "y": _r(clamp(y, -1, 1)),
                 "strength": _r(clamp(strength, 0.2, 1.0)), "seed": random.randint(1, 99999), "cause": cause}
            d["id"] = self.store.insert_damage(d)
            self.damage_list.append([d["id"], d["x"], d["y"], d["strength"], d["seed"], round(now, 2), cause])
            self.pulses.append([d["x"], -0.2, 0.9, round(now, 2)])
            self.version += 1
            print("[damage] %s at x=%.2f strength %.2f" % (cause, d["x"], d["strength"]))
            return d["id"]

    # ------------------------------------------------------------------ live
    def person_memory(self, pid):
        """Thread ids + paths left by one (anonymous) returning person."""
        if pid not in self._person_cache:
            rows = self.store.person_threads(pid, 16)
            self._person_cache[pid] = ([r[0] for r in rows], [[v for pt in r[1] for v in pt] for r in rows[:8]])
        return self._person_cache[pid]

    def set_live(self, bodies):
        for b in bodies:
            if b.get("pid"):
                ids, paths = self.person_memory(b["pid"])
                if ids:
                    b["lit"], b["mem"] = ids, paths
        with self.lock:
            self.live = [] if self.frozen else bodies
            self.live_ts = time.time()

    def live_bodies(self):
        return self.live if time.time() - self.live_ts < 2.0 else []

    # ----------------------------------------------------------------- state
    def state(self, include_live=False):
        with self.lock:
            now = time.time()
            key = (self.version, int(now // 10), self.freeze_started > 0, self.frozen)
            if self._cache_key != key:
                self._cache = self._build_state()
                self._cache_key = key
            st = dict(self._cache)
            st["now"] = round(now, 2)
            st["pulses"] = [p for p in self.pulses if now - p[3] < 20]
            if include_live:
                st["live"] = self.live_bodies()
            return st

    def _build_state(self):
        day = self.day()
        stage = self.stage()
        evo = self.evolution()
        orgs = self.organisms()
        links = sum(len(c["links"]) for c in self.clusters.values())
        connections = links + sum(max(0, len(o["c"]) - 1) * 6 for o in orgs)
        recent = list(self.recent)
        return {
            "v": self.version,
            "day": day,
            "days": self.days(),
            "stage": stage,
            "phase": PHASES[stage - 1],
            "phase_fa": PHASES_FA[stage - 1],
            "evolution": round(evo, 4),
            "params": self.params(),
            "frozen": self.frozen,
            "stats": {
                "visitors": self.visitors,
                "connections": connections,
                "memories": self.visitors,
                "clusters": len(self.clusters),
                "organisms": len(orgs),
            },
            "threads": [
                {"i": t["id"], "s": t["seed"] % 100000, "d": t["day"],
                 "p": [v for pt in t["pts"] for v in pt]}
                for t in recent
            ],
            "clusters": [
                {"i": c["id"], "s": c["seed"] % 100000, "m": c["mass"], "d": c["born"],
                 "n": [v for pt in c["nodes"] for v in pt], "l": [v for l in c["links"] for v in l]}
                for c in sorted(self.clusters.values(), key=lambda c: c["id"])
            ],
            "organisms": orgs,
            "damages": self.damage_list[-200:],
        }

    # ------------------------------------------------------------------ tick
    def tick(self):
        """Called about once a second by the background loop."""
        now = time.time()
        if self.end_time and now >= self.end_time and not self.freeze_started and not self.frozen:
            with self.lock:
                self.freeze_started = now
                self.store.meta_set("freeze_started", now)
                self.version += 1
        if self.freeze_started and not self.frozen and now - self.freeze_started >= FREEZE_SECONDS:
            self.consolidate()
            with self.lock:
                self.frozen = True
                self.live = []
                self.store.meta_set("frozen", "1")
                self.version += 1
                final = json.dumps(self.state())
                self.store.save_snapshot("final", final)
                self.store.save_snapshot(str(self.day()), final)
        if now - self._last_consolidate > CONSOLIDATE_EVERY:
            self._last_consolidate = now
            self.consolidate()
        if not self.frozen and now - self._last_snapshot > SNAPSHOT_EVERY:
            self._last_snapshot = now
            if self._snap_version != self.version:
                self._snap_version = self.version
                self.store.save_snapshot(str(self.day()), json.dumps(self.state()))
        if now - self._last_backup > 3600:
            self._last_backup = now
            try:
                self.store.backup()
            except Exception as e:  # never let a backup kill the installation
                print("[backup] failed:", e)

    def freeze_now(self):
        with self.lock:
            if not self.freeze_started:
                self.freeze_started = time.time()
                self.store.meta_set("freeze_started", self.freeze_started)
                self.version += 1

    def snapshot_list(self):
        keys = self.store.list_snapshots()
        days = sorted(int(k) for k in keys if k.isdigit())
        return {"days": days, "final": "final" in keys, "live_day": self.day(), "total": self.days(), "frozen": self.frozen}
