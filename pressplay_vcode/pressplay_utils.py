import re
from typing import Set

from pressplay_constants import PALETTE


def timecode_to_seconds(tc):
    h, m, s, f = map(int, tc.split(":"))
    return h * 3600 + m * 60 + s + f / 25


def timecode_filter(seconds):
    fps = 25
    total_frames = int(round(seconds * fps))
    h = total_frames // (3600 * fps)
    m = (total_frames // (60 * fps)) % 60
    s = (total_frames // fps) % 60
    f = total_frames % fps
    return f"{h:02}:{m:02}:{s:02}:{f:02}"


def is_bad_speaker_name(value: str) -> bool:
    s = str(value or "").strip()
    if not s:
        return True

    sl = s.lower()
    if sl in {"unknown", "unset", "audio", "speaker", "track", "voice"}:
        return True

    if re.fullmatch(r"(audio|speaker|track|voice)[\s_-]*\d+", sl):
        return True

    return False


def sanitize_track_name(s: str) -> str:
    s = str(s).strip()
    if not s:
        return "Unknown"
    s = re.sub(r"[^\w\s\-]", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:32] or "Unknown"


def safe_filename_part(value: str) -> str:
    value = (value or "voice").strip()
    value = re.sub(r"[^\w\-]+", "_", value, flags=re.UNICODE)
    return value[:80] or "voice"


def _djb2_hash(s: str) -> int:
    h = 5381
    for ch in s:
        h = ((h << 5) + h) + ord(ch)  # h*33 + ord(ch)
    return h & 0xFFFFFFFF  # stable 32-bit


def stable_speaker_color(name: str) -> str:
    name = (name or "Unset").strip()
    idx = _djb2_hash(name) % len(PALETTE)
    return PALETTE[idx]
