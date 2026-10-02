"""Faces: who came back, and who is unhappy.

Nothing visual is stored. A face becomes 128 anonymous numbers (SFace) kept
only in the local database, so a returning visitor can find their own traces
in the work. Expression (FER+) is used only in the moment, never stored.
"""
import numpy as np

from . import models

try:
    import cv2
except ImportError:
    cv2 = None

EMOTIONS = ["neutral", "happiness", "surprise", "sadness", "anger", "disgust", "fear", "contempt"]


class FaceEngine:
    def __init__(self, want_identity=True, want_emotion=True):
        self.detector = self.recognizer = self.fer = None
        if cv2 is None:
            return
        p = models.ensure("face_detection_yunet_2023mar.onnx")
        if not p:
            print("[faces] face detector unavailable - identity/expression disabled")
            return
        self.detector = cv2.FaceDetectorYN.create(p, "", (320, 240), 0.75, 0.3, 50)
        if want_identity:
            p = models.ensure("face_recognition_sface_2021dec.onnx")
            if p:
                self.recognizer = cv2.FaceRecognizerSF.create(p, "")
        if want_emotion:
            p = models.ensure("emotion-ferplus-8.onnx")
            if p:
                self.fer = cv2.dnn.readNetFromONNX(p)
        print("[faces] ready  identity=%s  expression=%s" % (self.recognizer is not None, self.fer is not None))

    @property
    def ok(self):
        return self.detector is not None

    def detect(self, frame):
        h, w = frame.shape[:2]
        self.detector.setInputSize((w, h))
        _, faces = self.detector.detect(frame)
        return [] if faces is None else list(faces)

    def signature(self, frame, face):
        if self.recognizer is None:
            return None
        crop = self.recognizer.alignCrop(frame, face)
        f = self.recognizer.feature(crop).flatten().astype(np.float32)
        return f / (np.linalg.norm(f) + 1e-9)

    def unhappiness(self, frame, face):
        """0..1: anger, disgust, contempt (and some sadness)."""
        if self.fer is None:
            return 0.0
        x, y, w, h = [int(v) for v in face[:4]]
        x, y = max(0, x), max(0, y)
        crop = frame[y:y + h, x:x + w]
        if crop.size == 0:
            return 0.0
        g = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        g = cv2.resize(g, (64, 64)).astype(np.float32)
        self.fer.setInput(g.reshape(1, 1, 64, 64))
        s = self.fer.forward().flatten()
        p = np.exp(s - s.max())
        p /= p.sum()
        return float(p[4] + p[5] + p[7] + 0.5 * p[3])


class Identities:
    """Anonymous gallery of returning visitors."""

    def __init__(self, store, threshold=0.42):
        self.store = store
        self.threshold = threshold
        self.gallery = {}
        for pid, emb, _ in store.persons_all():
            self.gallery[pid] = np.frombuffer(emb, dtype=np.float32).copy()

    def match(self, sig):
        best, score = None, -1.0
        for pid, g in self.gallery.items():
            s = float(np.dot(sig, g))
            if s > score:
                best, score = pid, s
        return (best, score) if score >= self.threshold else (None, score)

    def remember(self, sig, pid=None):
        if pid is None:
            pid = self.store.person_create(sig.astype(np.float32).tobytes())
            self.gallery[pid] = sig
        else:
            g = self.gallery[pid] * 0.8 + sig * 0.2
            g /= np.linalg.norm(g) + 1e-9
            self.gallery[pid] = g.astype(np.float32)
            self.store.person_update(pid, self.gallery[pid].tobytes())
        return pid
