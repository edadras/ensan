"""Accumulation of Presence - entry point.

    python run.py                      exhibition PC (camera + world + server)
    python run.py --simulate 20        no camera, 20 fake visitors / minute
    python run.py --mirror             website server (receives /api/ingest)
    python run.py --data data_preview --seed 3000 --day 7 --simulate 30
                                       preview day 7 with 3000 fake visitors
"""
import argparse
import os
import subprocess
import sys
import threading
import time
import webbrowser

from presence.config import ROOT, load_config


def open_kiosk(url):
    time.sleep(2.5)
    if sys.platform.startswith("win"):
        for exe in (r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
                    r"C:\Program Files\Google\Chrome\Application\chrome.exe"):
            if os.path.exists(exe):
                subprocess.Popen([exe, "--kiosk", url, "--edge-kiosk-type=fullscreen",
                                  "--no-first-run", "--disable-features=Translate"])
                return
    webbrowser.open(url)


def main():
    ap = argparse.ArgumentParser(description="Accumulation of Presence")
    ap.add_argument("--mirror", action="store_true", help="website mode (no camera, receives data)")
    ap.add_argument("--simulate", type=float, default=0, help="fake visitors per minute (no camera)")
    ap.add_argument("--seed", type=int, default=0, help="add N fake visitors instantly (for previews)")
    ap.add_argument("--day", type=int, default=0, help="force day 1..7")
    ap.add_argument("--data", default=None, help="data folder (default from config.json)")
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--no-camera", action="store_true")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--config", default=None, help="path to config.json")
    a = ap.parse_args()

    cfg = load_config(a.config) if a.config else load_config()
    if a.data:
        cfg["data_dir"] = a.data if os.path.isabs(a.data) else os.path.join(ROOT, a.data)
    if a.day:
        cfg["day_override"] = a.day
    if a.port:
        cfg["port"] = a.port
    if a.mirror:
        cfg["mode"] = "mirror"

    import uvicorn
    from presence.server import create_app, start_ticker
    from presence.store import Store

    store = Store(cfg["data_dir"])
    world = None
    if cfg["mode"] != "mirror":
        from presence.world import World
        world = World(store, cfg)
        if a.seed:
            from presence.simulate import seed
            print("[seed] adding %d fake visitors ..." % a.seed)
            seed(world, a.seed, days=(a.day or None))
        start_ticker(world)
        if a.simulate:
            from presence.simulate import Simulator
            Simulator(world, a.simulate).start()
        elif cfg["camera"]["enabled"] and not a.no_camera:
            from presence.camera import CameraTracker
            tracker = CameraTracker(world, cfg["camera"], cfg.get("identity"), cfg.get("damage"))
            tracker.start()
            if cfg["damage"].get("enabled") and cfg["damage"].get("shout"):
                from presence.audio import ShoutDetector
                ShoutDetector(tracker.shout, cfg["damage"].get("shout_db", 20)).start()
        if cfg["remote"]["enabled"]:
            from presence.sync import RemotePusher
            RemotePusher(world, cfg["remote"], cfg["api_key"]).start()
        print("[world] day %d  visitors %d  clusters %d  data: %s"
              % (world.day(), world.visitors, len(world.clusters), store.path))

    app = create_app(cfg, store, world)
    url = "http://127.0.0.1:%d/presence/" % cfg["port"]
    print("[server] open", url)
    if world is not None and cfg.get("open_browser") and not a.no_browser:
        threading.Thread(target=open_kiosk, args=(url + "?tv=1",), daemon=True).start()
    uvicorn.run(app, host=cfg["host"], port=cfg["port"], log_level="warning")


if __name__ == "__main__":
    main()
