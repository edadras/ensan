"""Fake visitors - for previewing the work without a camera, and for
seeding a test database to see what day 4 or day 7 will look like."""
import math
import random
import threading
import time

from .world import W, clamp

LANES = [-0.55, -0.15, 0.2, 0.5]


def fake_path(rng):
    kind = rng.random()
    pts = []
    if kind < 0.6:  # walks across
        lane = rng.choice(LANES) + rng.gauss(0, 0.12)
        x0, x1 = (-W, W) if rng.random() < 0.5 else (W, -W)
        steps = rng.randint(14, 30)
        wob = rng.uniform(0.02, 0.15)
        ph = rng.uniform(0, 6.28)
        for i in range(steps):
            f = i / (steps - 1)
            pts.append([x0 + (x1 - x0) * f, lane + math.sin(f * 5 + ph) * wob + rng.gauss(0, 0.01)])
    elif kind < 0.85:  # stops and looks
        cx, cy = rng.uniform(-1.0, 1.0), rng.uniform(-0.6, 0.6)
        for i in range(rng.randint(10, 22)):
            a = i * 0.7
            pts.append([cx + math.cos(a) * 0.05 * i / 6, cy + math.sin(a * 1.3) * 0.04 * i / 8])
    else:  # wanders
        x, y = rng.uniform(-W, W), rng.uniform(-0.8, 0.8)
        a = rng.uniform(0, 6.28)
        for _ in range(rng.randint(10, 25)):
            a += rng.gauss(0, 0.6)
            x, y = x + math.cos(a) * 0.08, y + math.sin(a) * 0.06
            pts.append([clamp(x, -W, W), clamp(y, -0.95, 0.95)])
    return pts


def seed(world, n, days=None):
    """Instantly add n fake visitors (spread over `days` if given)."""
    rng = random.Random()
    for i in range(n):
        day = None
        if days:
            day = 1 + int(days * i / max(1, n))
        world.add_presence(fake_path(rng), duration=rng.uniform(2, 40), speed=rng.uniform(0.05, 1.2),
                           ts=time.time() - (n - i), day=day)
        if i % 40 == 39:
            world.consolidate()
    world.consolidate()


class Simulator(threading.Thread):
    """Moving fake bodies in front of the 'camera'; leaving bodies become threads."""

    def __init__(self, world, per_minute=12):
        super().__init__(daemon=True)
        self.world = world
        self.rate = per_minute / 60.0
        self.bodies = []
        self.next_id = 1
        self.rng = random.Random()

    def spawn(self):
        r = self.rng
        path = fake_path(r)
        # some fake visitors come back again and again (anonymous person ids 1..6)
        pid = r.randint(1, 6) if r.random() < 0.35 else None
        self.bodies.append({"id": self.next_id, "path": path, "t": 0.0, "pid": pid,
                            "dur": r.uniform(4, 14), "g": {"hu": 0, "ao": 0, "st": 0, "fa": 0},
                            "gt": 0.0})
        self.next_id += 1

    def run(self):
        last = time.time()
        while True:
            time.sleep(1 / 15)
            now = time.time()
            dt = now - last
            last = now
            if self.rng.random() < self.rate * dt and len(self.bodies) < 6:
                self.spawn()
                if self.rng.random() < 0.15:  # groups arrive together
                    self.spawn()
            live = []
            for b in list(self.bodies):
                b["t"] += dt
                f = b["t"] / b["dur"]
                if f >= 1:
                    self.bodies.remove(b)
                    self.world.add_presence(b["path"], duration=b["dur"], speed=0.3, gestures=b["g"], person=b["pid"])
                    continue
                b["gt"] -= dt
                if b["gt"] <= 0:
                    b["gt"] = self.rng.uniform(1.5, 4)
                    b["g"] = {k: 1 if self.rng.random() < 0.18 else 0 for k in ("hu", "ao", "st", "fa")}
                p = b["path"]
                k = f * (len(p) - 1)
                i = int(k)
                j = min(i + 1, len(p) - 1)
                u = k - i
                x = p[i][0] + (p[j][0] - p[i][0]) * u
                y = p[i][1] + (p[j][1] - p[i][1]) * u
                body = {"i": b["id"], "x": round(x, 3), "y": round(y, 3), "vx": 0, "vy": 0, **b["g"]}
                if b["pid"]:
                    body["pid"] = b["pid"]
                live.append(body)
            # now and then someone shouts, strikes or frowns: a piece breaks
            if live and self.rng.random() < dt / 50:
                b = self.rng.choice(live)
                self.world.damage(b["x"], b["y"], self.rng.uniform(0.4, 1.0),
                                  self.rng.choice(["shout", "strike", "displeasure"]))
            self.world.set_live(live)
