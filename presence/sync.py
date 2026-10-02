"""Pushes the world state from the exhibition PC to the website.
No video is sent - only the compact world state (+ day snapshots)."""
import hashlib
import json
import threading
import time
import urllib.request


class RemotePusher(threading.Thread):
    def __init__(self, world, cfg, api_key):
        super().__init__(daemon=True)
        self.world = world
        self.url = cfg["api"].rstrip("/") + "/ingest"
        self.interval = max(1.0, float(cfg.get("interval", 4)))
        self.key = api_key
        self.sent_snap = {}
        self.ok = False
        self.last_error = ""

    def payload(self):
        state = self.world.state(include_live=True)
        snaps = {}
        for k in self.world.store.list_snapshots():
            s = self.world.store.get_snapshot(k)
            h = hashlib.md5(s.encode()).hexdigest()
            if self.sent_snap.get(k) != h:
                snaps[k] = (s, h)
        return state, snaps

    def run(self):
        while True:
            try:
                state, snaps = self.payload()
                body = '{"state":%s,"snapshots":{%s}}' % (
                    json.dumps(state),
                    ",".join('"%s":%s' % (k, s) for k, (s, _) in snaps.items()),
                )
                req = urllib.request.Request(
                    self.url, data=body.encode("utf-8"), method="POST",
                    headers={"Content-Type": "application/json", "X-Api-Key": self.key,
                             "User-Agent": "presence-installation/1.0"},
                )
                with urllib.request.urlopen(req, timeout=20) as r:
                    r.read()
                for k, (_, h) in snaps.items():
                    self.sent_snap[k] = h
                if not self.ok:
                    print("[remote] connected:", self.url)
                self.ok, self.last_error = True, ""
            except Exception as e:  # offline? keep the installation running, retry later
                if self.ok or self.last_error != str(e):
                    print("[remote] push failed (will retry):", e)
                self.ok, self.last_error = False, str(e)
            time.sleep(self.interval)
