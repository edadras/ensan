"""Microphone: a sudden shout (a loud "aah!") near the work breaks a piece of it."""
import math
import threading
import time

try:
    import numpy as np
    import sounddevice as sd
except Exception:  # optional
    sd = None


class ShoutDetector(threading.Thread):
    def __init__(self, on_shout, threshold_db=20):
        super().__init__(daemon=True)
        self.on_shout = on_shout
        self.threshold = threshold_db
        self.ambient = None
        self.loud_since = None
        self.last_event = 0.0

    def run(self):
        if sd is None:
            print("[audio] sounddevice not installed - shout detection disabled")
            return
        while True:
            try:
                with sd.InputStream(channels=1, samplerate=16000, blocksize=800, callback=self.block):
                    print("[audio] listening")
                    while True:
                        time.sleep(1)
            except Exception as e:
                print("[audio] microphone unavailable (%s), retrying in 30s" % e)
                time.sleep(30)

    def block(self, indata, frames, t, status):
        rms = float(np.sqrt(np.mean(indata[:, 0] ** 2))) + 1e-7
        db = 20 * math.log10(rms)
        if self.ambient is None:
            self.ambient = db
        now = time.time()
        loud = db > self.ambient + self.threshold and db > -35
        if loud:
            # a shout lasts: at least ~0.25 s above the threshold
            self.loud_since = self.loud_since or now
            if now - self.loud_since > 0.25 and now - self.last_event > 3:
                self.last_event = now
                strength = min(1.0, 0.45 + (db - self.ambient - self.threshold) / 25)
                try:
                    self.on_shout(strength)
                except Exception as e:
                    print("[audio] error:", e)
        else:
            self.loud_since = None
            # the room's background noise, slowly
            self.ambient = self.ambient * 0.995 + db * 0.005
