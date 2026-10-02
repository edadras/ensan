"""HTTP + WebSocket server. Same app runs on the exhibition PC
("installation") and on the website ("mirror")."""
import asyncio
import hmac
import json
import os
import threading
import time

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .config import ROOT

WEB_DIR = os.path.join(ROOT, "web")


def _json(obj_or_str, cache="no-store"):
    body = obj_or_str if isinstance(obj_or_str, str) else json.dumps(obj_or_str, ensure_ascii=False)
    return Response(body, media_type="application/json", headers={"Cache-Control": cache})


class Mirror:
    """Website side: just keeps the last state the exhibition sent."""

    def __init__(self, store):
        self.store = store
        self.state_json = store.get_snapshot("live") or "{}"
        self.version = json.loads(self.state_json).get("v", 0)
        self.received = 0.0

    def ingest(self, data):
        if "state" in data and isinstance(data["state"], dict):
            self.state_json = json.dumps(data["state"], ensure_ascii=False)
            self.version = data["state"].get("v", 0)
            self.received = time.time()
            self.store.save_snapshot("live", self.state_json)
        for k, s in (data.get("snapshots") or {}).items():
            if k in {"1", "2", "3", "4", "5", "6", "7", "final"}:
                self.store.save_snapshot(k, json.dumps(s, ensure_ascii=False))

    def snapshot_list(self):
        keys = self.store.list_snapshots()
        st = json.loads(self.state_json or "{}")
        return {"days": sorted(int(k) for k in keys if k.isdigit()), "final": "final" in keys,
                "live_day": st.get("day", 1), "frozen": st.get("frozen", False)}


def create_app(cfg, store, world=None):
    mirror = Mirror(store) if world is None else None
    app = FastAPI(title="Accumulation of Presence", docs_url="/api/docs", redoc_url=None)
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"], allow_headers=["*"])
    sockets = set()

    def check_key(request: Request):
        key = request.headers.get("x-api-key") or request.headers.get("authorization", "").replace("Bearer ", "")
        if request.client and request.client.host in ("127.0.0.1", "::1") and world is not None:
            return
        if not key or not hmac.compare_digest(key, cfg["api_key"]):
            raise HTTPException(401, "invalid api key")

    @app.get("/")
    def root():
        return RedirectResponse("/presence/")

    @app.get("/presence")
    def presence_noslash():
        return RedirectResponse("/presence/")

    # ---------------------------------------------------------------- read
    @app.get("/api/state")
    def state(since: int = -1, live: int = 0):
        if world is not None:
            if since == world.version and not live:
                return _json({"v": since, "same": True, "now": time.time()})
            return _json(world.state(include_live=bool(live)))
        if since == mirror.version:
            return _json({"v": since, "same": True, "now": time.time()})
        return _json(mirror.state_json)

    @app.get("/api/live")
    def live():
        if world is not None:
            return _json({"b": world.live_bodies()})
        return _json({"b": json.loads(mirror.state_json).get("live", [])})

    @app.get("/api/stats")
    def stats():
        st = world.state() if world is not None else json.loads(mirror.state_json)
        return _json({"day": st.get("day"), "phase": st.get("phase"), "evolution": st.get("evolution"),
                      **(st.get("stats") or {})})

    @app.get("/api/snapshots")
    def snapshots():
        return _json(world.snapshot_list() if world is not None else mirror.snapshot_list())

    @app.get("/api/snapshot/{key}")
    def snapshot(key: str):
        s = store.get_snapshot(key)
        if not s or key == "live":
            raise HTTPException(404, "no snapshot")
        return _json(s, cache="public, max-age=60")

    # --------------------------------------------------------------- write
    @app.post("/api/presence")
    async def add_presence(request: Request):
        """External sensors can add a presence: {"points": [[x,y],...], "duration": s, "speed": v}"""
        check_key(request)
        if world is None:
            raise HTTPException(400, "mirror mode: use /api/ingest")
        d = await request.json()
        tid = world.add_presence(d["points"], d.get("duration", 2), d.get("speed", 0.2), d.get("gestures"))
        return {"ok": tid is not None, "id": tid}

    @app.post("/api/damage")
    async def damage(request: Request):
        """Break a small part of the work: {"x": -1.7..1.7, "strength": 0.2..1, "cause": "strike"}"""
        check_key(request)
        if world is None:
            raise HTTPException(400, "mirror mode")
        d = await request.json()
        did = world.damage(d.get("x", 0.0), d.get("y", 0.0), d.get("strength", 0.7), d.get("cause", "manual"))
        return {"ok": did is not None, "id": did}

    @app.post("/api/admin/forget-faces")
    async def forget_faces(request: Request):
        """Delete every face signature (the traces in the work remain, anonymously)."""
        check_key(request)
        if world is None:
            raise HTTPException(400, "mirror mode")
        world.store.persons_forget_all()
        world._person_cache.clear()
        return {"ok": True}

    @app.post("/api/live")
    async def set_live(request: Request):
        check_key(request)
        if world is None:
            raise HTTPException(400, "mirror mode")
        world.set_live((await request.json()).get("b", []))
        return {"ok": True}

    @app.post("/api/ingest")
    async def ingest(request: Request):
        """The exhibition PC uploads its world state here (mirror mode)."""
        check_key(request)
        if mirror is None:
            raise HTTPException(400, "this server is the installation, not a mirror")
        mirror.ingest(await request.json())
        return {"ok": True, "v": mirror.version}

    @app.post("/api/admin/freeze")
    async def freeze(request: Request):
        check_key(request)
        if world is None:
            raise HTTPException(400, "mirror mode")
        world.freeze_now()
        return {"ok": True}

    @app.get("/api/export")
    def export(request: Request):
        """All raw presence threads (JSON lines) - an archive of the work."""
        check_key(request)
        if world is None:
            raise HTTPException(400, "mirror mode")

        def gen():
            for t in store.iter_threads():
                yield json.dumps(t) + "\n"

        return StreamingResponse(gen(), media_type="application/x-ndjson",
                                 headers={"Content-Disposition": "attachment; filename=presence-threads.jsonl"})

    # ----------------------------------------------------------- websocket
    @app.websocket("/ws")
    async def ws(socket: WebSocket):
        await socket.accept()
        sockets.add(socket)
        try:
            while True:
                await socket.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            sockets.discard(socket)

    async def broadcaster():
        last_rx = None
        while True:
            await asyncio.sleep(1 / 15)
            if not sockets:
                continue
            if world is not None:
                msg = {"t": "live", "b": world.live_bodies(), "v": world.version}
            else:
                if mirror.received == last_rx:
                    continue
                last_rx = mirror.received
                msg = {"t": "live", "b": json.loads(mirror.state_json).get("live", []), "v": mirror.version}
            text = json.dumps(msg)
            for s in list(sockets):
                try:
                    await s.send_text(text)
                except Exception:
                    sockets.discard(s)

    @app.on_event("startup")
    async def _start():
        asyncio.create_task(broadcaster())

    app.mount("/presence", StaticFiles(directory=WEB_DIR, html=True), name="web")
    return app


def start_ticker(world):
    def loop():
        while True:
            try:
                world.tick()
            except Exception as e:
                print("[tick] error:", e)
            time.sleep(1)

    threading.Thread(target=loop, daemon=True).start()
