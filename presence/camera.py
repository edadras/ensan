"""Camera -> people -> live bodies + presence threads.

Pure OpenCV (background subtraction + blob tracking): no skeleton, no
face, no image is ever stored. Only motion paths leave the camera.
"""
import math
import sys
import threading
import time

from .world import W, clamp

try:
    import cv2
    import numpy as np
except ImportError:  # camera is optional
    cv2 = None
    np = None


class Track:
    _next = 1

    def __init__(self, blob, now):
        self.id = Track._next
        Track._next += 1
        self.first = now
        self.last = now
        self.path = []
        self.base_aspect = None
        self.base_h = None
        self.speed = 0.0
        self.still_since = now
        self.prev = None
        self.update(blob, now)

    def update(self, blob, now):
        x, y, bw, bh = blob["bbox"]
        pos = blob["world"]
        if self.prev is not None:
            dt = max(1e-3, now - self.last)
            v = math.hypot(pos[0] - self.prev[0], pos[1] - self.prev[1]) / dt
            self.speed = self.speed * 0.8 + v * 0.2
            self.vx = (pos[0] - self.prev[0]) / dt
            self.vy = (pos[1] - self.prev[1]) / dt
        else:
            self.vx = self.vy = 0.0
        if self.speed > 0.06:
            self.still_since = now
        aspect = bw / max(1, bh)
        if now - self.first < 1.0 or self.base_aspect is None:
            self.base_aspect = aspect if self.base_aspect is None else self.base_aspect * 0.8 + aspect * 0.2
            self.base_h = bh if self.base_h is None else self.base_h * 0.8 + bh * 0.2
        self.aspect, self.h = aspect, bh
        self.prev = pos
        self.last = now
        self.blob = blob
        if not self.path or math.hypot(pos[0] - self.path[-1][0], pos[1] - self.path[-1][1]) > 0.015:
            self.path.append([round(pos[0], 3), round(pos[1], 3)])

    def gestures(self, now):
        return {
            "hu": 1 if self.base_h and self.h > self.base_h * 1.15 else 0,          # hands up
            "ao": 1 if self.base_aspect and self.aspect > self.base_aspect * 1.4 else 0,  # arms open
            "st": 1 if now - self.still_since > 1.5 else 0,                           # still
            "fa": 1 if self.speed > 0.9 else 0,                                       # fast
        }

    def body(self, now):
        g = self.gestures(now)
        x, y = self.prev
        return {"i": self.id, "x": round(x, 3), "y": round(y, 3),
                "vx": round(self.vx, 3), "vy": round(self.vy, 3), **g}


def to_world(cx, cy, bh, fw, fh):
    """Frame -> world. Mirrored x; y mixes height-in-frame and distance
    (bigger silhouette = closer = lower) so paths fill the whole canvas."""
    x = (0.5 - cx / fw) * 2 * W * 0.92
    depth = bh / fh
    y = (0.55 - depth) * 1.5 + (0.5 - cy / fh) * 0.7
    return [clamp(x, -W, W), clamp(y, -0.95, 0.95)]


class CameraTracker(threading.Thread):
    def __init__(self, world, cfg):
        super().__init__(daemon=True)
        self.world = world
        self.cfg = cfg
        self.tracks = {}
        self.running = True

    def open(self):
        idx = self.cfg.get("index", 0)
        if sys.platform.startswith("win"):
            cap = cv2.VideoCapture(idx, cv2.CAP_DSHOW)
        else:
            cap = cv2.VideoCapture(idx)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.cfg.get("width", 640))
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.cfg.get("height", 480))
        return cap if cap.isOpened() else None

    def run(self):
        if cv2 is None:
            print("[camera] OpenCV not installed - camera disabled")
            return
        while self.running:
            cap = self.open()
            if cap is None:
                print("[camera] cannot open camera %s, retrying in 10s" % self.cfg.get("index", 0))
                time.sleep(10)
                continue
            print("[camera] started")
            try:
                self.loop(cap)
            except Exception as e:
                print("[camera] error:", e)
            finally:
                cap.release()
            time.sleep(2)

    def loop(self, cap):
        bg = cv2.createBackgroundSubtractorMOG2(history=800, varThreshold=36, detectShadows=True)
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        fails = 0
        last_live = 0
        warm = time.time()
        while self.running:
            ok, frame = cap.read()
            if not ok:
                fails += 1
                if fails > 30:
                    return
                time.sleep(0.05)
                continue
            fails = 0
            now = time.time()
            small = cv2.resize(frame, (320, int(320 * frame.shape[0] / frame.shape[1])))
            fh, fw = small.shape[:2]
            mask = bg.apply(small, learningRate=0.003 if now - warm > 5 else -1)
            _, mask = cv2.threshold(mask, 200, 255, cv2.THRESH_BINARY)
            mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
            mask = cv2.dilate(mask, kernel, iterations=3)
            contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            min_area = self.cfg.get("min_area", 0.012) * fw * fh
            blobs = []
            for c in contours:
                if cv2.contourArea(c) < min_area:
                    continue
                x, y, bw, bh = cv2.boundingRect(c)
                cx, cy = x + bw / 2, y + bh / 2
                blobs.append({"bbox": (x, y, bw, bh), "world": to_world(cx, cy, bh, fw, fh)})
            if now - warm < 5:
                continue  # let the background model learn the empty room
            self.match(blobs, now)
            if now - last_live > 1 / 15:
                last_live = now
                self.world.set_live([t.body(now) for t in self.tracks.values() if now - t.last < 0.4])
            if self.cfg.get("debug_window"):
                for t in self.tracks.values():
                    x, y, bw, bh = t.blob["bbox"]
                    cv2.rectangle(small, (x, y), (x + bw, y + bh), (0, 255, 200), 1)
                    cv2.putText(small, str(t.id), (x, y - 2), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 200), 1)
                cv2.imshow("presence camera", np.hstack([small, cv2.cvtColor(mask, cv2.COLOR_GRAY2BGR)]))
                cv2.waitKey(1)

    def match(self, blobs, now):
        used = set()
        pairs = []
        for tid, t in self.tracks.items():
            for bi, b in enumerate(blobs):
                d = math.hypot(t.prev[0] - b["world"][0], t.prev[1] - b["world"][1])
                if d < 0.6:
                    pairs.append((d, tid, bi))
        pairs.sort()
        matched_t = set()
        for d, tid, bi in pairs:
            if tid in matched_t or bi in used:
                continue
            self.tracks[tid].update(blobs[bi], now)
            matched_t.add(tid)
            used.add(bi)
        for bi, b in enumerate(blobs):
            if bi not in used:
                t = Track(b, now)
                self.tracks[t.id] = t
        timeout = self.cfg.get("lost_timeout", 1.2)
        for tid in [tid for tid, t in self.tracks.items() if now - t.last > timeout]:
            t = self.tracks.pop(tid)
            duration = t.last - t.first
            if duration >= self.cfg.get("min_duration", 1.0):
                if len(t.path) < 2:  # someone who stood perfectly still
                    p = t.path[0]
                    t.path.append([p[0] + 0.03, p[1] + 0.01])
                g = t.gestures(now)
                self.world.add_presence(t.path, duration=duration, speed=t.speed, gestures=g)
