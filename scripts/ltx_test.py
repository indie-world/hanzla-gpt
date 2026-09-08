"""
Submits one LTX-Video text-to-video job to ComfyUI and reports how long it took.
Deliberately conservative settings, because the target GPU has 3.3 GB usable VRAM.
"""

import json
import sys
import time
import urllib.request
import urllib.error

HOST = "http://127.0.0.1:8188"

PROMPT = (
    "A calm ocean wave rolling onto a sandy beach at sunset, golden light, "
    "gentle motion, cinematic"
)
NEGATIVE = "worst quality, blurry, jittery, distorted, static"

WIDTH = int(sys.argv[1]) if len(sys.argv) > 1 else 384
HEIGHT = int(sys.argv[2]) if len(sys.argv) > 2 else 256
LENGTH = int(sys.argv[3]) if len(sys.argv) > 3 else 41   # must be 8n+1
STEPS = int(sys.argv[4]) if len(sys.argv) > 4 else 20

WORKFLOW = {
    "ckpt":  {"class_type": "CheckpointLoaderSimple",
              "inputs": {"ckpt_name": "ltx-video-2b-v0.9.5.safetensors"}},
    "clip":  {"class_type": "CLIPLoader",
              "inputs": {"clip_name": "t5xxl_fp8_e4m3fn.safetensors", "type": "ltxv"}},
    "pos":   {"class_type": "CLIPTextEncode",
              "inputs": {"text": PROMPT, "clip": ["clip", 0]}},
    "neg":   {"class_type": "CLIPTextEncode",
              "inputs": {"text": NEGATIVE, "clip": ["clip", 0]}},
    "cond":  {"class_type": "LTXVConditioning",
              "inputs": {"positive": ["pos", 0], "negative": ["neg", 0], "frame_rate": 24.0}},
    "lat":   {"class_type": "EmptyLTXVLatentVideo",
              "inputs": {"width": WIDTH, "height": HEIGHT, "length": LENGTH, "batch_size": 1}},
    "samp":  {"class_type": "KSampler",
              "inputs": {"model": ["ckpt", 0], "positive": ["cond", 0], "negative": ["cond", 1],
                         "latent_image": ["lat", 0], "seed": 42, "steps": STEPS, "cfg": 3.0,
                         "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0}},
    "dec":   {"class_type": "VAEDecodeTiled",
              "inputs": {"samples": ["samp", 0], "vae": ["ckpt", 2],
                         "tile_size": 256, "overlap": 32,
                         "temporal_size": 16, "temporal_overlap": 4}},
    "save":  {"class_type": "SaveWEBM",
              "inputs": {"images": ["dec", 0], "filename_prefix": "hanzla_ltx",
                         "codec": "vp9", "fps": 24.0, "crf": 32.0}},
}


def post(path, payload):
    req = urllib.request.Request(
        HOST + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def get(path):
    with urllib.request.urlopen(HOST + path, timeout=60) as r:
        return json.loads(r.read())


def main():
    print(f"settings: {WIDTH}x{HEIGHT}, {LENGTH} frames "
          f"({LENGTH / 24:.1f}s @24fps), {STEPS} steps")
    t0 = time.time()

    try:
        res = post("/prompt", {"prompt": WORKFLOW, "client_id": "hanzla-test"})
    except urllib.error.HTTPError as e:
        print("SUBMIT FAILED:", e.read().decode()[:2000])
        return 1

    pid = res["prompt_id"]
    print("queued:", pid)

    last = ""
    while True:
        time.sleep(3)
        hist = get(f"/history/{pid}")
        if pid in hist:
            entry = hist[pid]
            status = entry.get("status", {})
            if status.get("status_str") == "error" or not status.get("completed", True):
                msgs = status.get("messages", [])
                for m in msgs:
                    if m[0] in ("execution_error", "execution_interrupted"):
                        print("ERROR:", json.dumps(m[1])[:2500])
                        return 1
            outs = entry.get("outputs", {})
            elapsed = time.time() - t0
            print(f"DONE in {elapsed:.0f}s ({elapsed / 60:.1f} min)")
            for node, o in outs.items():
                for key in ("images", "gifs", "videos"):
                    for f in o.get(key, []):
                        print("  output:", f.get("filename"), "in", f.get("subfolder", ""), f.get("type"))
            return 0

        q = get("/queue")
        running = q.get("queue_running", [])
        state = "running" if running else "pending"
        el = time.time() - t0
        line = f"  {state}  {el:.0f}s"
        if line != last:
            print(line, flush=True)
            last = line
        if el > 3600:
            print("giving up after 60 minutes")
            return 1


if __name__ == "__main__":
    sys.exit(main())
