"""Web media from the promo's frame-exact UI captures (read-only input) and the live stills.
Usage: python tools/build_media.py <omp-studio-promo dir>
Output: public/media/{clip,seq,still,poster}. Rerun is idempotent; finished files are skipped.
"""
import os, subprocess, sys, tempfile
from PIL import Image

PROMO = sys.argv[1] if len(sys.argv) > 1 else r"D:\Project\omp-studio-promo"
SITE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MEDIA = os.path.join(SITE, "public", "media")
SHOTS = os.path.join(PROMO, "assets", "shots")
FFMPEG = os.path.join(PROMO, "node_modules", "@remotion", "compositor-win32-x64-msvc", "ffmpeg.exe")

# name: (shot, first frame, last frame). Frame ranges come from the capture markers.
CLIPS = {
    "stream": ("chat", 625, 1640), "modes": ("chat", 40, 460), "plan": ("plan", 121, 690),
    "hub": ("hub", 60, 586), "tokens": ("tokens", 10, 827), "models": ("models", 24, 475),
    "git": ("git", 20, 461), "caps": ("caps", 16, 401), "skills": ("skills", 10, 368),
    "perm": ("perm", 8, 371), "queue": ("queue", 57, 270), "btw": ("m-btw", 0, 178),
    "cmdk": ("m-cmdk", 0, 137), "restore": ("m-restore", 40, 187), "theme": ("m-theme", 0, 144),
    "history": ("m-history", 0, 169), "update": ("m-update", 0, 146),
}
SEQ = {"chat": ("chat", 625, 1640, 6)}  # 170 frames
STILLS = ["chat/f00592", "chat/f01556", "hub/f00540", "tokens/f00761", "models/f00166", "models/f00437",
          "git/f00425", "caps/f00140", "plan/f00243", "plan/f00641", "m-cmdk/f00126", "m-restore/f00172"]

def clip(name, shot, a, b):
    dst = os.path.join(MEDIA, "clip", f"{name}.mp4")
    poster = os.path.join(MEDIA, "poster", f"{name}.webp")
    d = os.path.join(SHOTS, shot)
    if not os.path.exists(dst):
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as t:
            for f in range(a, b + 1, 2):
                t.write(f"file '{os.path.join(d, f'f{f:05d}.jpg').replace(chr(92), '/')}'\nduration 0.033333\n")
        tmp = dst + ".tmp.mp4"
        subprocess.run([FFMPEG, "-y", "-v", "error", "-lowres", "1", "-f", "concat", "-safe", "0", "-i", t.name,
                        "-vf", "scale=1600:-2:flags=lanczos,format=yuv420p", "-r", "30", "-c:v", "libx264", "-preset", "slow",
                        "-crf", "25", "-g", "30", "-movflags", "+faststart", "-an", tmp], check=True)
        os.replace(tmp, dst); os.unlink(t.name)
    if not os.path.exists(poster):
        Image.open(os.path.join(d, f"f{a:05d}.jpg")).convert("RGB").resize((1200, 675), Image.LANCZOS).save(poster, quality=72, method=6)
    print(name, os.path.getsize(dst) // 1024, "KB", flush=True)

def main():
    for sub in ("clip", "poster", "still"):
        os.makedirs(os.path.join(MEDIA, sub), exist_ok=True)
    # Live stills: PNG (from capture-live.mjs) to WebP.
    still = os.path.join(MEDIA, "still")
    for f in os.listdir(still):
        if f.endswith(".png"):
            p = os.path.join(still, f)
            Image.open(p).convert("RGB").resize((2000, 1250), Image.LANCZOS).save(p[:-4] + ".webp", quality=82, method=6)
            os.unlink(p)
    for s in STILLS:
        dst = os.path.join(still, "shot-" + s.replace("/f", "-") + ".webp")
        if not os.path.exists(dst):
            Image.open(os.path.join(SHOTS, s + ".jpg")).convert("RGB").resize((2400, 1350), Image.LANCZOS).save(dst, quality=82, method=6)
    for name, (shot, a, b, step) in SEQ.items():
        out = os.path.join(MEDIA, "seq", name); os.makedirs(out, exist_ok=True)
        for i, f in enumerate(range(a, b + 1, step)):
            dst = os.path.join(out, f"{i:04d}.webp")
            if not os.path.exists(dst):
                im = Image.open(os.path.join(SHOTS, shot, f"f{f:05d}.jpg")); im.draft("RGB", (2880, 1620))
                im.convert("RGB").resize((1920, 1080), Image.LANCZOS).save(dst, quality=72, method=4)
        print("seq", name, i + 1, flush=True)
    for name, (shot, a, b) in CLIPS.items():
        clip(name, shot, a, b)
    print("MEDIA-DONE", flush=True)

main()
