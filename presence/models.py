"""Downloads the small ONNX models used for faces (once, into ./models).

    python -m presence.models
"""
import os
import sys
import urllib.request

from .config import ROOT

MODEL_DIR = os.path.join(ROOT, "models")

MODELS = {
    # face detector (230 KB)
    "face_detection_yunet_2023mar.onnx": [
        "https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx",
        "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    ],
    # anonymous face signature: 128 numbers, no image (37 MB)
    "face_recognition_sface_2021dec.onnx": [
        "https://huggingface.co/opencv/face_recognition_sface/resolve/main/face_recognition_sface_2021dec.onnx",
        "https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
    ],
    # facial expression (FER+, 34 MB)
    "emotion-ferplus-8.onnx": [
        "https://huggingface.co/onnxmodelzoo/emotion-ferplus-8/resolve/main/emotion-ferplus-8.onnx",
        "https://github.com/onnx/models/raw/main/validated/vision/body_analysis/emotion_ferplus/model/emotion-ferplus-8.onnx",
    ],
}


def path(name):
    return os.path.join(MODEL_DIR, name)


def ensure(name):
    """Return the local path of a model, downloading it if needed (None if impossible)."""
    p = path(name)
    if os.path.exists(p) and os.path.getsize(p) > 10000:
        return p
    os.makedirs(MODEL_DIR, exist_ok=True)
    for url in MODELS[name]:
        try:
            print("[models] downloading", name, "...")
            tmp = p + ".part"
            urllib.request.urlretrieve(url, tmp)
            if os.path.getsize(tmp) > 10000:
                os.replace(tmp, p)
                return p
        except Exception as e:
            print("[models] failed from", url.split("/")[2], ":", e)
    return None


def ensure_all():
    ok = True
    for name in MODELS:
        ok = ensure(name) is not None and ok
    return ok


if __name__ == "__main__":
    sys.exit(0 if ensure_all() else 1)
