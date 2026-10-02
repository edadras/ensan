"""Configuration: config.json next to run.py, created with defaults on first run."""
import copy
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(ROOT, "config.json")

DEFAULTS = {
    "host": "0.0.0.0",
    "port": 8000,
    # "installation" = exhibition PC (camera + world simulation)
    # "mirror"       = website server that only receives data via /api/ingest
    "mode": "installation",
    "data_dir": "data",
    # First day of the exhibition (YYYY-MM-DD). Empty = the day of first run.
    "start_date": "",
    # Moment the work freezes forever, e.g. "2026-10-09 21:00". Empty = never.
    "end_time": "",
    # Length of the exhibition in days (only for the daily archive / timeline).
    # The artwork itself evolves with the number of visitors, not with days.
    "days": 7,
    # Force a calendar day for testing. 0 = automatic from start_date.
    "day_override": 0,
    # Secret shared between the exhibition PC and the website.
    "api_key": "CHANGE-ME-to-a-long-random-secret",
    "open_browser": True,
    "camera": {
        "enabled": True,
        "index": 0,
        "width": 640,
        "height": 480,
        "min_area": 0.012,      # min blob area as fraction of frame
        "min_duration": 1.0,    # seconds a person must be seen to leave a trace
        "lost_timeout": 1.2,    # seconds before a lost track is closed
        "debug_window": False,  # show an OpenCV window with detections
    },
    "identity": {
        "enabled": True,        # recognise returning visitors (anonymous face signature, local only)
        "threshold": 0.42,      # higher = stricter matching
    },
    "damage": {
        "enabled": True,
        "shout": True,          # microphone: a sudden loud sound
        "shout_db": 20,         # dB above the room's background noise
        "strike": True,         # a fast strike / lunge toward the screen
        "displeasure": True,    # an unhappy / angry face for a few seconds
        "cooldown": 12,         # seconds between two damages
        "max_per_hour": 30,
    },
    "remote": {
        "enabled": False,
        # Python mirror:  "https://your-site.com/api"
        # PHP host:       "https://your-site.com/presence/api.php"
        "api": "https://your-site.com/api",
        "interval": 4,
    },
}


def _merge(base, over):
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def load_config(path=CONFIG_PATH):
    user = {}
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            user = json.load(f)
    else:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(DEFAULTS, f, indent=2, ensure_ascii=False)
    cfg = _merge(DEFAULTS, user)
    if not os.path.isabs(cfg["data_dir"]):
        cfg["data_dir"] = os.path.join(ROOT, cfg["data_dir"])
    return cfg
