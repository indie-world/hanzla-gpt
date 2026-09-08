"""
Validates the WAN workflow wiring against the running ComfyUI.
Mirrors exactly what src/main.js submits, so a pass here means the app's
workflow JSON is correct.

  python wan_test.py            -> WAN 2.1 text-to-video
  python wan_test.py wan22      -> WAN 2.2 text-to-video
  python wan_test.py wan22 img  -> WAN 2.2 image-to-video (needs a photo)
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error
import random

HOST = "http://127.0.0.1:8188"

ENGINE = sys.argv[1] if len(sys.argv) > 1 else "wan"
IMAGE = sys.argv[2] if len(sys.argv) > 2 else None

PROMPT = ("A woman with shoulder-length dark hair sits at a wooden table in a sunlit cafe, "
          "she smiles gently and turns her head towards the window, soft natural light, "
          "shallow depth of field, cinematic, photorealistic")
NEGATIVE = os.environ.get("NEG",
    "cartoon, anime, illustration, drawing, painting, cel shaded, 3d render, cgi, "
    "worst quality, blurry, distorted face, extra limbs, static, watermark")

WIDTH  = int(os.environ.get("W", 320))
HEIGHT = int(os.environ.get("H", 192))
LENGTH = int(os.environ.get("L", 25))
STEPS  = int(os.environ.get("S", 12))
CFG    = float(os.environ.get("CFG", 0))   # 0 = per-engine default
SHIFT  = float(os.environ.get("SHIFT", 8.0))
LORA   = os.environ.get("LORA", "")            # distillation LoRA filename, if any
LSTR   = float(os.environ.get("LSTR", 1.0))    # LoRA strength
TILED  = int(os.environ.get("TILED", 1))   # 0 = plain VAEDecode, as the official template uses
SEED = random.randint(1, 2**31)   # vary, or ComfyUI returns a cached result


def align(length, n):
    return round((length - 1) / n) * n + 1


def wan21():
    return {
        "unet": {"class_type": "UNETLoader", "inputs": {
            "unet_name": "wan2.1_t2v_1.3B_fp16.safetensors", "weight_dtype": "default"}},
        "clip": {"class_type": "CLIPLoader", "inputs": {
            "clip_name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors", "type": "wan"}},
        "vae": {"class_type": "VAELoader", "inputs": {"vae_name": "wan_2.1_vae.safetensors"}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": PROMPT, "clip": ["clip", 0]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": NEGATIVE, "clip": ["clip", 0]}},
        "shift": {"class_type": "ModelSamplingSD3",
                  "inputs": {"model": (["lora", 0] if LORA else ["unet", 0]), "shift": SHIFT}},
        "lat": {"class_type": "EmptyHunyuanLatentVideo", "inputs": {
            "width": WIDTH, "height": HEIGHT, "length": align(LENGTH, 4), "batch_size": 1}},
        "samp": {"class_type": "KSampler", "inputs": {
            "model": ["shift", 0], "positive": ["pos", 0], "negative": ["neg", 0],
            "latent_image": ["lat", 0], "seed": SEED, "steps": STEPS, "cfg": (CFG or 6.0),
            "sampler_name": "uni_pc", "scheduler": "simple", "denoise": 1.0}},
        "dec": ({"class_type": "VAEDecode", "inputs": {"samples": ["samp", 0], "vae": ["vae", 0]}}
                if TILED == 0 else
                {"class_type": "VAEDecodeTiled", "inputs": {
                    "samples": ["samp", 0], "vae": ["vae", 0],
                    "tile_size": 512, "overlap": 64, "temporal_size": 32, "temporal_overlap": 8}}),
        "save": {"class_type": "SaveWEBM", "inputs": {
            "images": ["dec", 0], "filename_prefix": "test_wan21",
            "codec": "vp9", "fps": 16.0, "crf": 32.0}},
    }


def wan22(image_name=None):
    wf = {
        "unet": {"class_type": "UNETLoader", "inputs": {
            "unet_name": "wan2.2_ti2v_5B_fp16.safetensors", "weight_dtype": "default"}},
        "clip": {"class_type": "CLIPLoader", "inputs": {
            "clip_name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors", "type": "wan"}},
        "vae": {"class_type": "VAELoader", "inputs": {"vae_name": "wan2.2_vae.safetensors"}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": PROMPT, "clip": ["clip", 0]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": NEGATIVE, "clip": ["clip", 0]}},
        "shift": {"class_type": "ModelSamplingSD3", "inputs": {"model": ["unet", 0], "shift": SHIFT}},
        "samp": {"class_type": "KSampler", "inputs": {
            "model": ["shift", 0], "positive": ["pos", 0], "negative": ["neg", 0],
            "latent_image": ["lat", 0], "seed": SEED, "steps": STEPS, "cfg": (CFG or 5.0),
            "sampler_name": "uni_pc", "scheduler": "simple", "denoise": 1.0}},
        "dec": ({"class_type": "VAEDecode", "inputs": {"samples": ["samp", 0], "vae": ["vae", 0]}}
                if TILED == 0 else
                {"class_type": "VAEDecodeTiled", "inputs": {
                    "samples": ["samp", 0], "vae": ["vae", 0],
                    "tile_size": 512, "overlap": 64, "temporal_size": 32, "temporal_overlap": 8}}),
        "save": {"class_type": "SaveWEBM", "inputs": {
            "images": ["dec", 0], "filename_prefix": "test_wan22",
            "codec": "vp9", "fps": 24.0, "crf": 32.0}},
    }
    lat = {"vae": ["vae", 0], "width": WIDTH, "height": HEIGHT,
           "length": align(LENGTH, 4), "batch_size": 1}
    if image_name:
        wf["img"] = {"class_type": "LoadImage", "inputs": {"image": image_name}}
        wf["fit"] = {"class_type": "ImageScale", "inputs": {
            "image": ["img", 0], "width": WIDTH, "height": HEIGHT,
            "upscale_method": "lanczos", "crop": "center"}}
        lat["start_image"] = ["fit", 0]
    wf["lat"] = {"class_type": "Wan22ImageToVideoLatent", "inputs": lat}
    return wf


def add_lora(wf):
    if LORA:
        wf["lora"] = {"class_type": "LoraLoaderModelOnly", "inputs": {
            "model": ["unet", 0], "lora_name": LORA, "strength_model": LSTR}}
    return wf


def get(path):
    with urllib.request.urlopen(HOST + path, timeout=60) as r:
        return json.loads(r.read())


def main():
    wf = add_lora(wan21()) if ENGINE == "wan" else wan22(IMAGE)
    print(f"engine={ENGINE} image={IMAGE or 'none'} {WIDTH}x{HEIGHT} "
          f"{align(LENGTH,4)} frames {STEPS} steps cfg={CFG or 'default'} shift={SHIFT}")

    req = urllib.request.Request(
        HOST + "/prompt",
        data=json.dumps({"prompt": wf, "client_id": "wan-test"}).encode(),
        headers={"Content-Type": "application/json"})
    try:
        pid = json.loads(urllib.request.urlopen(req, timeout=60).read())["prompt_id"]
    except urllib.error.HTTPError as e:
        print("SUBMIT REJECTED:", e.read().decode()[:2500])
        return 1

    print("queued:", pid)
    t0 = time.time()
    while True:
        time.sleep(3)
        try:
            hist = get(f"/history/{pid}")
        except Exception as ex:
            print(f"  poll error ({ex}) — continuing")
            continue
        if pid in hist:
            entry = hist[pid]
            st = entry.get("status", {})
            if st.get("status_str") == "error":
                for m in st.get("messages", []):
                    if m[0] == "execution_error":
                        print("EXECUTION ERROR:", json.dumps(m[1])[:2000])
                        return 1
            for out in entry.get("outputs", {}).values():
                for k in ("images", "gifs", "videos"):
                    for f in out.get(k, []):
                        print(f"DONE in {time.time()-t0:.0f}s -> {f.get('filename')}")
                        return 0
            print("finished but no output file")
            return 1
        el = time.time() - t0
        if int(el) % 30 < 3:
            print(f"  {el:.0f}s…", flush=True)
        if el > 2400:
            print("timeout")
            return 1


if __name__ == "__main__":
    sys.exit(main())
