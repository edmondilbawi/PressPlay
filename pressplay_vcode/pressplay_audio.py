import json
import os
import subprocess

import numpy as np


def get_episode_video_path(project: str, episode: str) -> str:
    """
    Return the full path to the episode video.
    Supports multiple common container extensions and falls back to
    the first video file in the episode folder.
    """
    base_dir = os.path.join("subtitles", project, episode)
    if not os.path.isdir(base_dir):
        raise FileNotFoundError(f"Episode directory not found: {base_dir}")

    preferred_exts = [".mp4", ".mov", ".mxf", ".mkv", ".avi", ".mpg", ".mpeg", ".ts", ".m4v"]

    # 1) Prefer file that matches episode name exactly with known extensions.
    for ext in preferred_exts:
        p = os.path.join(base_dir, f"{episode}{ext}")
        if os.path.isfile(p):
            return p

    # 2) Case-insensitive fallback in same folder for episode-stem matches.
    stem_lower = str(episode).strip().lower()
    candidates = []
    for name in os.listdir(base_dir):
        full = os.path.join(base_dir, name)
        if not os.path.isfile(full):
            continue
        lower = name.lower()
        ext = os.path.splitext(lower)[1]
        if ext in preferred_exts:
            candidates.append((name, full))

    for name, full in candidates:
        if os.path.splitext(name)[0].lower() == stem_lower:
            return full

    # 3) Final fallback: first video-like file in folder.
    if candidates:
        return candidates[0][1]

    raise FileNotFoundError(
        f"No episode video found in {base_dir}. Expected {episode}.mp4/.mov/.mxf/... or any video file."
    )


def ensure_waveform_json(project: str, episode: str) -> dict:
    """
    Ensure there is a JSON waveform file for this project/episode.
    If it doesn't exist, generate it using ffmpeg + numpy.
    Returns the loaded JSON dict.
    """
    base_dir = os.path.join("subtitles", project, episode)
    os.makedirs(base_dir, exist_ok=True)

    json_path = os.path.join(base_dir, f"{episode}_waveform.json")

    # If cached JSON exists, load it and reuse only if it matches current settings
    if os.path.isfile(json_path):
        with open(json_path, "r", encoding="utf-8") as f:
            cached = json.load(f)
        if (
            cached.get("sample_rate") == 8000
            and cached.get("chunk_duration_sec") == 0.02
        ):
            return cached

    # Otherwise, generate it
    video_path = get_episode_video_path(project, episode)

    sample_rate = 8000
    chunk_duration_sec = 0.02  # 20ms resolution (50 chunks/sec)

    # Use ffmpeg to output mono raw float32 PCM to stdout
    ffmpeg_cmd = [
        "ffmpeg",
        "-loglevel", "error",
        "-i",
        video_path,
        "-vn",               # no video
        "-ac",
        "1",                 # mono
        "-ar",
        str(sample_rate),
        "-f",
        "f32le",             # 32-bit float PCM
        "pipe:1",
    ]

    print(f"[waveform] Generating waveform for {project}/{episode} ...")
    proc = subprocess.Popen(
        ffmpeg_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        bufsize=1024 * 1024,
    )

    samples_per_chunk = int(sample_rate * chunk_duration_sec)
    chunk_size = samples_per_chunk * 4  # float32 = 4 bytes

    peaks_min = []
    peaks_max = []

    try:
        while True:
            chunk = proc.stdout.read(chunk_size)
            if not chunk:
                break

            samples = np.frombuffer(chunk, dtype=np.float32)
            if samples.size == 0:
                continue

            mn = float(np.min(samples))
            mx = float(np.max(samples))

            peaks_min.append(mn)
            peaks_max.append(mx)

        proc.stdout.close()
        proc.wait()
    finally:
        if proc.stderr:
            proc.stderr.close()

    if not peaks_min:
        raise RuntimeError("No audio data found while generating waveform")

    # Normalize to [-1..1] by the max absolute value across min/max
    max_abs = max(
        max(abs(x) for x in peaks_min),
        max(abs(x) for x in peaks_max),
        1e-9
    )

    norm_min = [round(x / max_abs, 3) for x in peaks_min]
    norm_max = [round(x / max_abs, 3) for x in peaks_max]

    data = {
        "project": project,
        "episode": episode,
        "sample_rate": sample_rate,
        "chunk_duration_sec": chunk_duration_sec,
        "peak_count": len(norm_max),
        "peaks_min": norm_min,
        "peaks_max": norm_max,
    }

    # Cache to disk
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(data, f)

    print(f"[waveform] JSON waveform created: {json_path} (peaks={len(norm_max)})")
    return data


def get_audio_duration(file_path: str) -> float:
    """
    Uses ffprobe if available. Returns 0.0 on failure.
    """
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                file_path
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False
        )

        raw = (result.stdout or "").strip()
        if raw:
            return round(float(raw), 3)
    except Exception as e:
        print("⚠️ Could not read audio duration via ffprobe:", repr(e))

    return 0.0
