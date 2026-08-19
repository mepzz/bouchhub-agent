"""
Positional face swap for the BouchHub photo pipeline.

The whole point of this file is the ORDERING. ReActor maps reference faces to
detected faces by size, which puts the wrong face on the wrong person the moment
someone stands closer to the camera. Here the base image's faces are sorted
left-to-right by bounding-box centre and matched to slots the same way, so the
person on the left of the frame always gets the left reference.

Must be run with ComfyUI's own interpreter — that is the one with insightface
and cv2:
    %USERPROFILE%\\AI\\ComfyUI\\.venv\\Scripts\\python.exe

Prints one line of JSON on stdout. Everything human-readable goes to stderr so
the caller can parse the result without stripping log noise.
"""

import argparse, json, os, sys

def out(**kw):
    print(json.dumps(kw))
    sys.exit(0 if kw.get("ok") else 1)

def log(msg):
    print(msg, file=sys.stderr)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True, help="generated image to swap faces into")
    ap.add_argument("--out", required=True)
    # Slots are given in frame order. Pass only the ones in use: one reference
    # is a solo portrait, three is the full cast.
    ap.add_argument("--ref", action="append", default=[],
                    help="reference image path, repeatable, in LEFT-to-RIGHT order")
    ap.add_argument("--swapper", required=True, help="inswapper_128.onnx")
    ap.add_argument("--det-size", type=int, default=640)
    args = ap.parse_args()

    for p in [args.base, args.swapper] + args.ref:
        if not os.path.exists(p):
            out(ok=False, error=f"missing file: {p}")
    if not args.ref:
        out(ok=False, error="no reference faces given")

    try:
        import cv2, numpy as np
        import insightface
        from insightface.app import FaceAnalysis
    except Exception as e:
        out(ok=False, error=f"insightface/cv2 not importable — is this ComfyUI's venv python? ({e})")

    # CUDA if the venv has onnxruntime-gpu, else CPU. CPU works and costs about a
    # minute per image; it is reported so a slow run is explainable rather than
    # mysterious.
    try:
        import onnxruntime
        available = onnxruntime.get_available_providers()
    except Exception:
        available = []
    providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if "CUDAExecutionProvider" in available else ["CPUExecutionProvider"]
    log(f"providers: {providers}")

    try:
        app = FaceAnalysis(name="buffalo_l", providers=providers)
        app.prepare(ctx_id=0, det_size=(args.det_size, args.det_size))
        swapper = insightface.model_zoo.get_model(args.swapper, providers=providers)
    except Exception as e:
        out(ok=False, error=f"could not load the face models: {e}")

    def read_upright(path):
        # EXIF rotation is the difference between a usable reference and a face
        # the detector never finds, and phone photos carry it constantly.
        try:
            from PIL import Image, ImageOps
            im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
            return cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)
        except Exception:
            return cv2.imread(path)

    base = read_upright(args.base)
    if base is None:
        out(ok=False, error=f"could not read {args.base}")

    faces = app.get(base)
    if not faces:
        out(ok=False, error="no face detected in the generated image — regenerate, or raise the person count in the prompt")

    # LEFT TO RIGHT. This one line is the fix.
    faces = sorted(faces, key=lambda f: (f.bbox[0] + f.bbox[2]) / 2.0)

    # Load each reference and take its largest face — a reference photo often has
    # bystanders, and the subject is essentially always the biggest face in it.
    refs = []
    for i, path in enumerate(args.ref):
        img = read_upright(path)
        if img is None:
            out(ok=False, error=f"could not read reference {path}")
        found = app.get(img)
        if not found:
            out(ok=False, error=f"no face found in reference {os.path.basename(path)} — use a clearer, front-facing photo")
        refs.append(max(found, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1])))

    n = min(len(refs), len(faces))
    result = base
    for i in range(n):
        result = swapper.get(result, faces[i], refs[i], paste_back=True)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    if not cv2.imwrite(args.out, result):
        out(ok=False, error=f"could not write {args.out}")

    out(ok=True, path=args.out, swapped=n, facesDetected=len(faces), refsGiven=len(refs),
        provider=providers[0],
        note=None if n == len(refs) else
             f"only {len(faces)} face(s) were generated for {len(refs)} reference(s) — the extra references were not used")

if __name__ == "__main__":
    main()
