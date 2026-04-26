from fastapi import (
    APIRouter,
    Request,
    Header,
    Form,
    WebSocket,
    WebSocketDisconnect,
    UploadFile,
    File,
    Body,
    HTTPException,
)
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse, FileResponse, StreamingResponse
from fastapi.templating import Jinja2Templates

import json
import os
import pandas as pd
import urllib.parse
import traceback
import math
import shutil
import tempfile
from pathlib import Path
from uuid import uuid4
from datetime import datetime
import asyncio
import threading

import httpx  # used for AI server calls
import re
import subprocess
import numpy as np
import wave
from typing import List, Set, Dict, Any, Optional, Iterator

from pressplay_audio import ensure_waveform_json as ensure_waveform_json_audio

EMOTION_PRESETS = {
    "neutral":    [0.02, 0.02, 0.02, 0.02, 0.00, 0.00, 0.00, 0.95],
    "happy":      [0.98, 0.05, 0.04, 0.00, 0.00, 0.00, 0.12, 0.08],
    "sad":        [0.00, 0.00, 0.98, 0.10, 0.00, 0.40, 0.00, 0.05],
    "angry":      [0.00, 0.98, 0.10, 0.06, 0.10, 0.00, 0.02, 0.00],
    "cry":        [0.00, 0.00, 1.08, 0.24, 0.00, 0.62, 0.00, 0.00],
    "fear":       [0.00, 0.11, 0.28, 1.02, 0.00, 0.12, 0.06, 0.00],
    "surprised":  [0.22, 0.07, 0.00, 0.20, 0.00, 0.00, 1.00, 0.00],
    "calm":       [0.04, 0.00, 0.04, 0.00, 0.00, 0.00, 0.00, 1.15],
    "whisper":    [0.00, 0.00, 0.22, 0.08, 0.00, 0.16, 0.00, 1.36],
    "excited":    [0.82, 0.10, 0.00, 0.10, 0.05, 0.00, 0.70, 0.05],
    "serious":    [0.04, 0.40, 0.06, 0.08, 0.20, 0.00, 0.00, 0.58],
    "tender":     [0.40, 0.00, 0.48, 0.00, 0.00, 0.32, 0.00, 1.12],
}

EMOTION_TEXT_PROMPTS = {
    "neutral": "neutral, clear, natural studio narration",
    "happy": "very happy, bright, smiling, playful, upbeat delivery",
    "sad": "deeply sad, soft, low-energy, emotionally heavy, fragile tone",
    "angry": "angry, tense, forceful, sharp delivery, controlled aggression",
    "cry": "crying, trembling voice, emotional pain, teary and breaking tone",
    "fear": "fearful, anxious, shaky voice, tense breath, urgent hesitation",
    "surprised": "strong surprise, sudden burst, widened tone, reactive emphasis",
    "calm": "calm, steady, relaxed, controlled pace",
    "whisper": "whispering, very soft voice, close-mic, breathy, intimate, confidential tone",
    "excited": "highly excited, energetic, lively emphasis, animated and vivid",
    "serious": "serious, firm, focused, authoritative",
    "tender": "tender, warm, gentle, affectionate, emotionally warm tone",
}

NATURAL_EMOTION_MODE = True
NATURAL_MAX_EMO_ALPHA = 1.6
NATURAL_MAX_MIX_BY_PRESET = {
    "neutral": 0.28,
    "happy": 0.34,
    "sad": 0.36,
    "angry": 0.28,
    "cry": 0.30,
    "fear": 0.30,
    "surprised": 0.33,
    "calm": 0.34,
    "whisper": 0.44,
    "excited": 0.32,
    "serious": 0.34,
    "tender": 0.44,
}

EMOJI_ANNOTATION_RULES = {
    # Whisper / breathy
    "ðŸ‘‚": {"preset": "whisper", "weight": 1.0, "replacement": " ... "},
    "ðŸ¤«": {"preset": "whisper", "weight": 1.1, "replacement": " ... "},
    "ðŸ˜®â€ðŸ’¨": {"preset": "whisper", "weight": 1.1, "replacement": " ... "},
    # Cry / sadness
    "ðŸ˜­": {"preset": "cry", "weight": 3.0, "replacement": " ... "},
    "ðŸ˜¢": {"preset": "sad", "weight": 3.4, "replacement": " ... "},
    "ðŸ¥º": {"preset": "tender", "weight": 1.2, "replacement": " ... "},
    # Sickness / weak tone
    "ðŸ¤§": {"preset": "sad", "weight": 1.2, "replacement": " ... "},
    "ðŸ¤’": {"preset": "sad", "weight": 1.0, "replacement": " ... "},
    # Energy clusters
    "ðŸ˜‚": {"preset": "happy", "weight": 1.5, "replacement": " ! "},
    "ðŸ¤£": {"preset": "happy", "weight": 1.6, "replacement": " ! "},
    "ðŸ˜„": {"preset": "happy", "weight": 1.2, "replacement": " ! "},
    "ðŸ˜¡": {"preset": "angry", "weight": 1.7, "replacement": " ! "},
    "ðŸ¤¬": {"preset": "angry", "weight": 2.0, "replacement": " ! "},
    "ðŸ˜¨": {"preset": "fear", "weight": 1.3, "replacement": " ... "},
    "ðŸ˜±": {"preset": "fear", "weight": 1.8, "replacement": " ! "},
    "ðŸ˜®": {"preset": "surprised", "weight": 1.2, "replacement": " ! "},
    "ðŸ˜²": {"preset": "surprised", "weight": 1.3, "replacement": " ! "},
}

EMOJI_ANNOTATION_PATTERN = re.compile(
    "|".join(re.escape(k) for k in sorted(EMOJI_ANNOTATION_RULES.keys(), key=len, reverse=True))
)

TEXT_ANNOTATION_RULES = {
    "cry": {"preset": "cry", "weight": 1.5, "replacement": " "},
    "crying": {"preset": "cry", "weight": 1.6, "replacement": " "},
    "sob": {"preset": "cry", "weight": 1.7, "replacement": " "},
    "sobbing": {"preset": "cry", "weight": 1.8, "replacement": " "},
    "sad": {"preset": "sad", "weight": 1.5, "replacement": " "},
    "whisper": {"preset": "whisper", "weight": 1.5, "replacement": " "},
    "soft": {"preset": "whisper", "weight": 1.5, "replacement": " "},
    "tender": {"preset": "tender", "weight": 1.5, "replacement": " "},
    "calm": {"preset": "calm", "weight": 1.5, "replacement": " "},
    "serious": {"preset": "serious", "weight": 1.5, "replacement": " "},
    "angry": {"preset": "angry", "weight": 1.5, "replacement": " "},
    "rage": {"preset": "angry", "weight": 2.0, "replacement": " "},
    "fear": {"preset": "fear", "weight": 1.5, "replacement": " "},
    "scared": {"preset": "fear", "weight": 2.0, "replacement": " "},
    "surprised": {"preset": "surprised", "weight": 1.5, "replacement": " "},
    "shock": {"preset": "surprised", "weight": 1.8, "replacement": " "},
    "happy": {"preset": "happy", "weight": 1.5, "replacement": " "},
    "excited": {"preset": "excited", "weight": 2.0, "replacement": " "},
    "frantic": {"preset": "fear", "weight": 3.0, "replacement": " "},
    "panic": {"preset": "fear", "weight": 2.8, "replacement": " "},
}

TEXT_ANNOTATION_PATTERN = re.compile(r"\{([a-zA-Z][a-zA-Z0-9_\-\s]{1,30})\}")

EMOJI_PRESET_PRIORITY = {
    "cry": 12,
    "angry": 11,
    "fear": 10,
    "whisper": 9,
    "sad": 8,
    "surprised": 7,
    "excited": 6,
    "happy": 5,
    "tender": 4,
    "serious": 3,
    "calm": 2,
    "neutral": 1,
}

VC_SERVER_URL_ENV = os.getenv("CHATTERBOX_VC_URL", "").strip()
VC_SERVER_URLS_ENV = os.getenv("CHATTERBOX_VC_URLS", "").strip()
VC_SERVER_TIMEOUT_SEC = float(os.getenv("CHATTERBOX_VC_TIMEOUT_SEC", "300"))
TTS_SERVER_URLS_ENV = os.getenv("INDEXTTS2_URLS", "").strip()
TTS_SERVER_TIMEOUT_SEC = float(os.getenv("INDEXTTS2_TIMEOUT_SEC", "300"))

def get_vc_server_urls() -> List[str]:
    """
    Resolve VC endpoints in priority order.
    Supports comma-separated env var CHATTERBOX_VC_URLS and legacy CHATTERBOX_VC_URL.
    """
    urls: List[str] = []
    default_urls = [
        "http://127.0.0.1:8003/convert",
        "http://91.144.16.91:8003/convert",
    ]

    def _normalize(url: str) -> str:
        u = str(url or "").strip()
        if not u:
            return ""
        if not u.lower().endswith("/convert"):
            u = u.rstrip("/") + "/convert"
        return u

    if VC_SERVER_URLS_ENV:
        for raw in VC_SERVER_URLS_ENV.split(","):
            u = _normalize(raw)
            if u:
                urls.append(u)
    elif VC_SERVER_URL_ENV:
        u = _normalize(VC_SERVER_URL_ENV)
        if u:
            urls.append(u)

    # Always append built-in fallbacks.
    urls.extend(default_urls)

    dedup: List[str] = []
    seen = set()
    for u in urls:
        if u in seen:
            continue
        seen.add(u)
        dedup.append(u)
    return dedup


def get_tts_server_urls() -> List[str]:
    """
    Resolve TTS endpoints in priority order.
    Supports comma-separated env var INDEXTTS2_URLS.
    """
    urls: List[str] = []
    default_urls = [
        "http://127.0.0.1:8001/synthesize",
        "http://91.144.16.91:8001/synthesize",
    ]

    if TTS_SERVER_URLS_ENV:
        for raw in TTS_SERVER_URLS_ENV.split(","):
            u = str(raw or "").strip()
            if not u:
                continue
            if not u.lower().endswith("/synthesize"):
                u = u.rstrip("/") + "/synthesize"
            urls.append(u)
        # Always include built-in fallbacks after env-provided URLs.
        urls.extend(default_urls)
    else:
        urls = list(default_urls)

    dedup: List[str] = []
    seen = set()
    for u in urls:
        if u in seen:
            continue
        seen.add(u)
        dedup.append(u)
    return dedup


def blend_emotion_vectors(base_vec: List[float], preset_vec: List[float], mix: float) -> List[float]:
    """
    Blend two emotion vectors:
    mix=0.0 -> base only, mix=1.0 -> preset only.
    """
    m = max(0.0, min(1.0, float(mix)))
    base = list(base_vec or [])
    preset = list(preset_vec or [])
    n = max(len(base), len(preset))
    if n == 0:
        return []
    if len(base) < n:
        base.extend([0.0] * (n - len(base)))
    if len(preset) < n:
        preset.extend([0.0] * (n - len(preset)))
    return [round((b * (1.0 - m)) + (p * m), 6) for b, p in zip(base, preset)]


ADAPT_MODEL = os.getenv("OLLAMA_MODEL", "llama3.1:8b")
ADAPT_OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434/api/chat")
ADAPT_OLLAMA_TIMEOUT_SEC = float(os.getenv("OLLAMA_TIMEOUT_SEC", "300"))
ADAPT_CPS_TARGET = 19.5
ADAPT_CPS_MIN = 18.0
ADAPT_CPS_MAX = 21.0
ADAPT_SHORT_GAP_THRESHOLD = 0.28
ADAPT_MIN_REAL_GAP = 0.15


def sanitize_text_for_index_tts2(text: str) -> str:
    """
    Normalize text into a stable, TTS-friendly sentence for IndexTTS2.
    """
    t = str(text or "").strip()
    if not t:
        return ""

    replacements = {
        "\u2018": "'",
        "\u2019": "'",
        "\u201C": '"',
        "\u201D": '"',
        "\u2013": "-",
        "\u2014": "-",
        "\u2026": "...",
        "\u00A0": " ",
    }
    for src, dst in replacements.items():
        t = t.replace(src, dst)

    # Remove HTML/SSML-like tags and invisible/control characters.
    t = re.sub(r"<[^>]+>", " ", t)
    t = re.sub(r"[\u200B-\u200D\uFEFF]", "", t)
    t = re.sub(r"[\x00-\x08\x0B\x0C\x0E-\x1F]", " ", t)

    t = t.replace("\r", " ").replace("\n", " ").replace("\t", " ")
    t = re.sub(r"\s+", " ", t).strip()
    t = re.sub(r"\s+([,.;:!?])", r"\1", t)

    # Avoid excessive repeated punctuation.
    t = re.sub(r"([!?.,;:])\1{2,}", r"\1\1", t)

    # If it ends with alnum, add sentence stop for cleaner prosody.
    if t and re.search(r"[A-Za-z0-9]$", t):
        t += "."

    return t.strip()


def apply_emoji_annotations_for_tts(text: str) -> Dict[str, Any]:
    """
    Irodori-style annotations:
    - parse text tags like {crying}, {whisper}
    - remove emoji glyphs from spoken text
    - keep short pause/exclamation hints
    - infer a dominant emotion preset from tag/emoji usage
    """
    raw = str(text or "")
    if not raw.strip():
        return {
            "text": "",
            "has_emoji": False,
            "has_tags": False,
            "has_annotations": False,
            "auto_preset": None,
            "suggested_mix": 0.65,
            "scores": {},
            "tags": [],
        }

    scores: Dict[str, float] = {}
    tags: List[str] = []
    last_tag_preset: Optional[str] = None
    emoji_hits = 0

    def _replace_tag(m: re.Match) -> str:
        nonlocal last_tag_preset
        raw_tag = str(m.group(1) or "").strip().lower()
        tag_key = re.sub(r"\s+", "_", raw_tag).replace("-", "_")
        rule = TEXT_ANNOTATION_RULES.get(tag_key) or TEXT_ANNOTATION_RULES.get(raw_tag)
        if not rule:
            return " "
        preset = str(rule.get("preset") or "neutral").strip().lower()
        weight = float(rule.get("weight", 1.0) or 1.0)
        scores[preset] = scores.get(preset, 0.0) + weight
        tags.append(raw_tag)
        last_tag_preset = preset
        return str(rule.get("replacement") or " ")

    def _replace(m: re.Match) -> str:
        nonlocal emoji_hits
        emo = m.group(0)
        rule = EMOJI_ANNOTATION_RULES.get(emo) or {}
        preset = str(rule.get("preset") or "neutral").strip().lower()
        weight = float(rule.get("weight", 1.0) or 1.0)
        scores[preset] = scores.get(preset, 0.0) + weight
        emoji_hits += 1
        return str(rule.get("replacement") or " ")

    out = TEXT_ANNOTATION_PATTERN.sub(_replace_tag, raw)
    out = EMOJI_ANNOTATION_PATTERN.sub(_replace, out)
    has_emoji = emoji_hits > 0
    has_tags = bool(tags)
    has_annotations = bool(scores)

    # If nothing was annotated, keep user text untouched (pause-sensitive).
    if not has_annotations:
        return {
            "text": raw.strip(),
            "has_emoji": False,
            "has_tags": False,
            "has_annotations": False,
            "auto_preset": None,
            "suggested_mix": 0.65,
            "scores": {},
            "tags": [],
        }

    # Keep punctuation/pause structure; only clean whitespace artifacts from removed tags/emojis.
    out = out.replace("\r", " ").replace("\n", " ").replace("\t", " ")
    out = re.sub(r" {2,}", " ", out).strip()

    auto_preset: Optional[str] = None
    if has_tags and last_tag_preset:
        auto_preset = last_tag_preset
    elif has_emoji:
        auto_preset = sorted(scores.items(), key=lambda kv: (-kv[1], -EMOJI_PRESET_PRIORITY.get(kv[0], 0), kv[0]))[0][0]

    # Mildly raise mix when emojis are dense, capped to keep prompt emotion stable.
    score_total = sum(scores.values())
    suggested_mix = max(0.65, min(0.9, 0.58 + (0.06 * score_total)))

    return {
        "text": out,
        "has_emoji": has_emoji,
        "has_tags": has_tags,
        "has_annotations": has_annotations,
        "auto_preset": auto_preset,
        "suggested_mix": round(suggested_mix, 2),
        "scores": scores,
        "tags": tags,
    }


def strip_annotations_for_cps(text: str) -> str:
    """
    Remove control annotations like {crying}/{whisper} from CPS calculations.
    Keeps spoken words only.
    """
    t = str(text or "")
    t = TEXT_ANNOTATION_PATTERN.sub(" ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def apply_indextts2_speech_effects(
    text: str,
    effect_style: str = "none",
    effect_strength: float = 0.0,
    effect_position: str = "auto",
    index_hint: int = 0,
) -> str:
    """
    Optional light text styling for expressive TTS delivery (e.g., "mm", "wow").
    Keeps source meaning intact; only adds small spoken reaction tokens.
    """
    base = sanitize_text_for_index_tts2(text)
    if not base:
        return ""

    style = str(effect_style or "none").strip().lower()
    strength = max(0.0, min(1.0, float(effect_strength or 0.0)))
    position = str(effect_position or "auto").strip().lower()
    if style in ("none", "", "off") or strength <= 0.0:
        return base

    tokens_by_style = {
        "mm": ["Mm,", "Mmm,"],
        "wow": ["Wow,", "Whoa,"],
        "reaction": ["Mm,", "Wow,", "Oh,", "Hmm,"],
        "thoughtful": ["Hmm,", "Mm,", "Well,"],
        "surprised": ["Wow,", "Whoa,", "Oh!"],
        "laughing": ["Haha,", "Heh,", "Ahaha,"],
        "crying": ["Sniff,", "Oh...", "Ah..."],
        "sigh": ["Sigh,", "Ah,", "Well..."],
        "excited": ["Yes!", "Wow,", "Oh wow,"],
        "whisper": ["(softly),", "(whispering),", "hush,"],
    }
    tokens = tokens_by_style.get(style, tokens_by_style["reaction"])
    token = tokens[abs(int(index_hint)) % len(tokens)]

    # Gentle gating so effects stay natural.
    if len(base) < 10:
        return base
    if base[:6].lower().startswith(("mm", "wow", "hmm", "oh", "whoa")):
        return base

    add_infix = strength >= 0.75 and "," in base and len(base) > 28
    out = base

    if position not in {"start", "middle", "end", "auto"}:
        position = "auto"
    if position == "auto":
        if strength >= 0.8 and len(base) > 30:
            position = "middle"
        elif strength >= 0.45:
            position = "start"
        else:
            position = "end"

    if position == "start":
        out = f"{token} {out}".strip()
    elif position == "middle":
        if "," in out:
            out = re.sub(r",\s*", f", {token.lower()} ", out, count=1)
        else:
            words = out.split()
            mid = max(1, len(words) // 2)
            words.insert(mid, token.lower())
            out = " ".join(words)
    elif position == "end":
        end_punct = ""
        m = re.search(r"([.!?]+)$", out)
        if m:
            end_punct = m.group(1)
            out = out[:-len(end_punct)].rstrip()
        out = f"{out} {token.lower()}".strip()
        if end_punct:
            out = f"{out}{end_punct}"

    if add_infix and position != "middle":
        out = re.sub(r",\s*", ", mm, ", out, count=1)

    return sanitize_text_for_index_tts2(out)


def ollama_chat_content(prompt: str, model: str = ADAPT_MODEL, temperature: float = 0.45) -> str:
    """
    Call Ollama /api/chat and return message.content.
    """
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "options": {
            "temperature": temperature,
            "top_p": 0.9,
            "num_predict": 320,
            "repeat_penalty": 1.1,
        },
    }
    timeout_cfg = httpx.Timeout(
        connect=10.0,
        read=ADAPT_OLLAMA_TIMEOUT_SEC,
        write=30.0,
        pool=30.0,
    )
    max_attempts = 2
    last_error = None

    for attempt in range(1, max_attempts + 1):
        try:
            with httpx.Client(timeout=timeout_cfg) as client:
                resp = client.post(ADAPT_OLLAMA_URL, json=payload)
                resp.raise_for_status()
                data = resp.json()
            return str((data.get("message") or {}).get("content") or "").strip()
        except (httpx.ReadTimeout, httpx.ConnectTimeout) as e:
            last_error = e
            if attempt >= max_attempts:
                break
            continue
        except Exception as e:
            last_error = e
            break

    try:
        err_msg = str(last_error)
    except Exception:
        err_msg = "unknown error"
    raise RuntimeError(
        "Ollama adaptation failed. Ensure Ollama is running and model "
        f"'{model}' is available. Timeout is {ADAPT_OLLAMA_TIMEOUT_SEC:.0f}s. Details: {err_msg}"
    )


PALETTE = [
    "#3F51B5",  # indigo
    "#4CAF50",  # green
    "#FF9800",  # orange
    "#9C27B0",  # purple
    "#009688",  # teal
    "#795548",  # brown
    "#607D8B",  # slate
    "#2196F3",  # blue
    "#8BC34A",  # light green
    "#00BCD4",  # cyan
    "#673AB7",  # deep purple
    "#FFC107",  # amber
    "#CDDC39",  # lime
    "#03A9F4",  # sky blue
    "#FF5722",  # deep orange (not red)
    "#6D4C41",  # warm brown
    "#26A69A",  # soft teal
    "#5C6BC0",  # softer indigo
]




def load_recordings_meta_from_path(meta_path: str) -> list:
    if not os.path.exists(meta_path):
        return []
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def save_recordings_meta_to_path(meta_path: str, recordings_meta: list) -> None:
    tmp_path = meta_path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(recordings_meta, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, meta_path)


def remove_generated_wav_for_recording(base_path: str, rec: dict, reason: str = "") -> None:
    """
    Delete generated TTS wav for a recording row if present.
    Only deletes files inside <base_path>/recordings for safety.
    """
    try:
        if not isinstance(rec, dict):
            return

        file_name = str(rec.get("file") or "").strip()
        if not file_name:
            return

        source = str(rec.get("source") or "").strip().lower()
        # Target generated TTS files (explicit source or common suffix naming).
        if source != "tts" and not file_name.lower().endswith("_tts.wav"):
            return

        recordings_dir = Path(base_path).resolve() / "recordings"
        target = (recordings_dir / file_name).resolve()

        # Safety: never delete outside recordings folder.
        try:
            if not target.is_relative_to(recordings_dir):
                print(f"âš ï¸ Skip unsafe delete path: {target}")
                return
        except Exception:
            # Fallback for environments without is_relative_to
            if str(recordings_dir) not in str(target):
                print(f"âš ï¸ Skip unsafe delete path: {target}")
                return

        if target.exists():
            target.unlink()
            print(f"ðŸ—‘ Deleted generated WAV ({reason}): {target.name}")
    except Exception as e:
        print(f"âš ï¸ Failed to delete generated WAV ({reason}): {e}")


def shift_recordings_meta_for_insert(base_path: str, insert_index: int):
    meta_path = os.path.join(base_path, "recordings", "recordings_meta.json")

    if not os.path.exists(meta_path):
        return []

    try:
        data = load_recordings_meta_from_path(meta_path)
        if not isinstance(data, list):
            return []

        updated = []

        for rec in data:
            if not isinstance(rec, dict):
                continue

            try:
                idx = int(rec.get("index"))
            except Exception:
                continue

            if idx >= insert_index:
                rec = dict(rec)
                rec["index"] = idx + 1

            updated.append(rec)

        # inserted segment must have NO recording row
        cleaned = []
        for r in updated:
            try:
                idx = int(r.get("index", -999999))
                # remove ONLY the newly inserted empty slot
                if idx == insert_index and r.get("source") != "tts" and r.get("source") != "mic":
                    continue
            except Exception:
                pass
            cleaned.append(r)

        cleaned.sort(key=lambda r: int(r.get("index", 0)))
        save_recordings_meta_to_path(meta_path, cleaned)

        print(f"ðŸŽ§ recordings_meta shifted for insert at index {insert_index}; inserted segment left empty")
        return cleaned

    except Exception as e:
        print(f"âš ï¸ recordings_meta insert update failed: {e}")
        return []


def shift_recordings_meta_for_split(base_path: str, split_index: int):
    meta_path = os.path.join(base_path, "recordings", "recordings_meta.json")

    if not os.path.exists(meta_path):
        return []

    try:
        data = load_recordings_meta_from_path(meta_path)
        if not isinstance(data, list):
            return []

        updated = []

        for rec in data:
            if not isinstance(rec, dict):
                continue

            try:
                idx = int(rec.get("index"))
            except Exception:
                continue

            # remove recording for the split segment and delete generated wav
            if idx == split_index:
                print(f"ðŸ—‘ Removing recording at split index {split_index}")
                remove_generated_wav_for_recording(base_path, rec, reason=f"split idx {split_index}")
                continue

            if idx > split_index:
                rec = dict(rec)
                rec["index"] = idx + 1

            updated.append(rec)

        updated.sort(key=lambda r: int(r.get("index", 0)))
        save_recordings_meta_to_path(meta_path, updated)

        print(f"ðŸŽ§ recordings_meta updated for split at index {split_index}")
        return updated

    except Exception as e:
        print(f"âš ï¸ recordings_meta split update failed: {e}")
        return []


def shift_recordings_meta_for_delete(base_path: str, delete_index: int):
    meta_path = os.path.join(base_path, "recordings", "recordings_meta.json")

    if not os.path.exists(meta_path):
        return []

    try:
        data = load_recordings_meta_from_path(meta_path)
        if not isinstance(data, list):
            return []

        updated = []

        for rec in data:
            if not isinstance(rec, dict):
                continue

            try:
                idx = int(rec.get("index"))
            except Exception:
                continue

            # delete recording for deleted segment and delete generated wav
            if idx == delete_index:
                print(f"ðŸ—‘ Removing recording at deleted index {delete_index}")
                remove_generated_wav_for_recording(base_path, rec, reason=f"delete idx {delete_index}")
                continue

            # shift later recordings back
            if idx > delete_index:
                rec = dict(rec)
                rec["index"] = idx - 1

            updated.append(rec)

        updated.sort(key=lambda r: int(r.get("index", 0)))
        save_recordings_meta_to_path(meta_path, updated)

        print(f"ðŸŽ§ recordings_meta updated for delete at index {delete_index}")
        return updated

    except Exception as e:
        print(f"âš ï¸ recordings_meta delete update failed: {e}")
        return []




def seconds_to_adl(seconds: float, fps: int = 25) -> str:
    total_frames = max(0, round(seconds * fps))
    h = total_frames // (3600 * fps)
    m = (total_frames % (3600 * fps)) // (60 * fps)
    s = (total_frames % (60 * fps)) // fps
    f = total_frames % fps
    return f"{h:02}.{m:02}.{s:02}.{f:02}/0000"


def resolve_wav(audio_dir: Path, item: dict):
    original_name = str(item.get("file", "")).strip()
    if original_name:
        wav_name = Path(original_name).with_suffix(".wav").name
        candidate = (audio_dir / wav_name).resolve()
        if candidate.exists():
            return candidate

    idx = item.get("index")
    speaker = str(item.get("speaker", "")).strip()
    start = float(item.get("start", 0))
    start_ms = int(round(start * 1000))

    fallback_names = [
        f"{idx}_{speaker}_{start_ms}_tts.wav",
        f"{idx}_{speaker}_{start_ms:06d}_tts.wav",
        f"{idx}_{speaker}_{start_ms}.wav",
        f"{idx}_{speaker}_{start_ms:06d}.wav",
    ]

    for name in fallback_names:
        candidate = (audio_dir / name).resolve()
        if candidate.exists():
            return candidate

    if idx is not None:
        wildcard_matches = sorted(audio_dir.glob(f"{idx}_*.wav"))
        if wildcard_matches:
            return wildcard_matches[0]

    return None


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


def get_episode_speakers(project: str, episode: str) -> List[str]:
    speakers = set()

    for item in load_recordings_meta(project, episode):
        speaker = str(item.get("speaker", "")).strip()
        if not is_bad_speaker_name(speaker):
            speakers.add(speaker)

    if not speakers:
        for seg in load_episode_segments_for_tts(project, episode):
            speaker = str(seg.get("speaker", "")).strip()
            if not is_bad_speaker_name(speaker):
                speakers.add(speaker)

    return sorted(speakers, key=lambda s: s.lower())


def load_done_segment_indexes(project: str, episode: str) -> Set[int]:
    path = Path("subtitles") / project / episode / "recordings" / "done.json"

    if not path.exists():
        return set()

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return set()

    if not isinstance(data, list):
        return set()

    out: Set[int] = set()
    for item in data:
        try:
            out.add(int(item))
        except Exception:
            continue
    return out


def save_done_segment_indexes(project: str, episode: str, done_indexes: Set[int]):
    path = Path("subtitles") / project / episode / "recordings" / "done.json"
    path.parent.mkdir(parents=True, exist_ok=True)

    tmp = str(path) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(sorted(done_indexes), f, ensure_ascii=False, indent=2)

    os.replace(tmp, path)

def shift_done_indexes_for_insert(project: str, episode: str, insert_index: int):
    done_indexes = load_done_segment_indexes(project, episode)
    updated = set()

    for idx in done_indexes:
        if idx >= insert_index:
            updated.add(idx + 1)
        else:
            updated.add(idx)

    save_done_segment_indexes(project, episode, updated)
    return updated


def shift_done_indexes_for_split(project: str, episode: str, split_index: int):
    done_indexes = load_done_segment_indexes(project, episode)
    updated = set()

    for idx in done_indexes:
        if idx > split_index:
            updated.add(idx + 1)
        else:
            updated.add(idx)

    # If the original segment was done, keep the first half checked at split_index.
    # The new second half (split_index + 1) remains unchecked.

    save_done_segment_indexes(project, episode, updated)
    return updated


def shift_done_indexes_for_delete(project: str, episode: str, delete_index: int):
    done_indexes = load_done_segment_indexes(project, episode)
    updated = set()

    for idx in done_indexes:
        if idx == delete_index:
            continue
        if idx > delete_index:
            updated.add(idx - 1)
        else:
            updated.add(idx)

    save_done_segment_indexes(project, episode, updated)
    return updated




def sanitize_track_name(s: str) -> str:
    s = str(s).strip()
    if not s:
        return "Unknown"
    s = re.sub(r'[^\w\s\-]', '', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s[:32] or "Unknown"


def build_adl(
    project,
    episode,
    fps=25,
    samplerate=48000,
    selected_speakers: Optional[List[str]] = None,
    copy_wavs: bool = False,
    copy_folder: Optional[str] = None,
    done_only: bool = False,
    track_mode: str = "multi_track_by_speaker",
    adl_source_root: Optional[str] = None,  # kept only so route won't fail
):
    base = Path("subtitles") / project / episode
    audio_dir = base / "recordings"
    json_path = audio_dir / "recordings_meta.json"

    track_mode = str(track_mode or "multi_track_by_speaker").strip().lower()
    valid_track_modes = {"single_track", "multi_track_by_speaker"}
    if track_mode not in valid_track_modes:
        raise ValueError(f"Invalid track_mode: {track_mode}")

    suffix = "done" if done_only else "all"
    suffix += "_single" if track_mode == "single_track" else "_multi"

    export_dir = Path(copy_folder).expanduser() if copy_folder else (base / "adl_export")
    export_dir.mkdir(parents=True, exist_ok=True)
    out_path = export_dir / f"{episode}_{suffix}.adl"

    if not json_path.exists():
        raise FileNotFoundError(f"recordings_meta.json not found: {json_path}")

    data = json.loads(json_path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError("recordings_meta.json must contain a list")

    now = datetime.now().isoformat(timespec="seconds")
    uid = uuid4()

    selected_set = {str(s).strip() for s in (selected_speakers or []) if str(s).strip()}
    done_indexes = load_done_segment_indexes(project, episode) if done_only else set()

    filtered_items = []
    missing_files = []

    for item in data:
        raw_spk = str(item.get("speaker", "")).strip()

        item_index = item.get("index")
        try:
            item_index_int = int(item_index)
        except Exception:
            item_index_int = None

        if selected_set and raw_spk not in selected_set:
            continue

        if done_only and item_index_int not in done_indexes:
            continue

        wav_path = resolve_wav(audio_dir, item)
        if not wav_path:
            missing_files.append(str(item.get("file", "")))
            continue

        try:
            start = float(item.get("start", 0))
            end = float(item.get("end", 0))
        except Exception:
            continue

        duration = end - start
        if duration <= 0:
            continue

        normalized = dict(item)
        normalized["speaker"] = raw_spk
        normalized["index"] = item_index_int if item_index_int is not None else item.get("index")
        filtered_items.append((normalized, wav_path))

    if not filtered_items:
        raise ValueError("No usable ADL items found after filtering")

    # Match working exporter behavior: only real non-empty speakers
    speakers = sorted({
        str(item.get("speaker", "")).strip()
        for item, _wav in filtered_items
        if str(item.get("speaker", "")).strip()
    })

    if not speakers:
        speakers = ["Unknown"]

    if track_mode == "single_track":
        speaker_tracks = {spk: 1 for spk in speakers}
        track_defs = [(1, "All Segments")]
    else:
        speaker_tracks = {spk: i + 1 for i, spk in enumerate(speakers)}
        track_defs = [(i + 1, spk) for i, spk in enumerate(speakers)]

    lines = [
        "<ADL>",
        "\t<VERSION>",
        '\t\t(ADL_ID)\t"06,64,43,52,01,01,01,04,01,02,03,04,"',
        f"\t\t(ADL_UID)\t{uid}",
        "\t\t(VER_ADL_VERSION)\t01.01.00.00.03",
        '\t\t(VER_CREATOR)\t"JSON ADL Generator"',
        "\t\t(VER_CRTR)\t1.0.0",
        "\t</VERSION>",
        "\t<PROJECT>",
        f'\t\t(PROJ_TITLE)\t"{project}_{episode}"',
        '\t\t(PROJ_ORIGINATOR)\t"JSON-TTS"',
        f"\t\t(PROJ_CREATE_DATE)\t{now}",
        "\t</PROJECT>",
        "\t<SYSTEM>",
        "\t\t(SYS_SRC_OFFSET)\t00.00.00.00/0000",
        "\t\t(SYS_BIT_DEPTH)\t24",
        "\t</SYSTEM>",
        "\t<SEQUENCE>",
        f"\t\t(SEQ_SAMPLE_RATE)\tS{samplerate}",
        f"\t\t(SEQ_FRAME_RATE)\t{fps}",
        "\t</SEQUENCE>",
        "\t<TRACKLIST>",
    ]

    for tid, track_name in track_defs:
        clean_name = sanitize_track_name(track_name)
        lines.append(f'\t\t(Track)\t{tid}\t"{clean_name}"')

    lines.append("\t</TRACKLIST>")
    lines.append("\t<SOURCE_INDEX>")

    source_items = []
    src_index = 0
    copied_files = []

    target_dir = export_dir if copy_wavs else None
    if target_dir is not None:
        target_dir.mkdir(parents=True, exist_ok=True)

    for item, wav_path in filtered_items:
        start = float(item.get("start", 0))
        end = float(item.get("end", 0))
        duration = end - start
        if duration <= 0:
            continue

        src_index += 1
        dur_adl = seconds_to_adl(duration, fps)

        adl_wav = wav_path
        if target_dir is not None:
            dst = target_dir / wav_path.name
            if wav_path.resolve() != dst.resolve():
                shutil.copy2(wav_path, dst)
            adl_wav = dst
            copied_files.append(str(dst))

        desc = f"{item.get('speaker', 'Unknown')} #{item.get('index', src_index)}"
        url = adl_wav.as_uri()

        lines.append(
            f'\t\t(Index)\t{src_index}\t(F)\t"url:{url}"\t{uuid4()}\t00.00.00.00/0000\t{dur_adl}\t{desc[:40]}\tN'
        )

        source_items.append((src_index, item))

    lines.append("\t</SOURCE_INDEX>")
    lines.append("\t<EVENT_LIST>")

    for src_index, item in source_items:
        start_adl = seconds_to_adl(float(item.get("start", 0)), fps)
        end_adl = seconds_to_adl(float(item.get("end", 0)), fps)

        spk = str(item.get("speaker", "")).strip() or "Unknown"
        track_num = speaker_tracks.get(spk, 1)
        name = f"{sanitize_track_name(spk)}_{src_index:03d}"

        lines += [
            f"\t\t(Entry)\t{src_index}\t(Cut)\tI\t{src_index}\t1\t{track_num}\t00.00.00.00/0000\t{start_adl}\t{end_adl}\tR",
            f'\t\t\t(Rem)\tNAME\t"{name}"'
        ]

    lines.append("\t</EVENT_LIST>")
    lines.append("</ADL>")

    # IMPORTANT: write Windows-style CRLF line endings
    out_path.write_text("\r\n".join(lines) + "\r\n", encoding="utf-8")

    return {
        "path": str(out_path),
        "filename": out_path.name,
        "exported_items": len(source_items),
        "speakers": speakers,
        "copy_folder": str(target_dir) if target_dir is not None else None,
        "copied_files": copied_files,
        "missing_files": missing_files,
        "done_only": done_only,
        "track_mode": track_mode,
        "track_count": len(track_defs),
    }

def _djb2_hash(s: str) -> int:
    h = 5381
    for ch in s:
        h = ((h << 5) + h) + ord(ch)  # h*33 + ord(ch)
    return h & 0xFFFFFFFF  # stable 32-bit

def stable_speaker_color(name: str) -> str:
    name = (name or "Unset").strip()
    idx = _djb2_hash(name) % len(PALETTE)
    return PALETTE[idx]


def build_unique_speaker_colors(names: List[str]) -> Dict[str, str]:
    """
    Assign deterministic colors without collisions when possible.
    If preferred hash color is taken, pick next free palette color.
    """
    ordered = sorted({str(n or "").strip() or "Unset" for n in names})
    used: Set[str] = set()
    out: Dict[str, str] = {}
    for name in ordered:
        preferred = stable_speaker_color(name)
        if preferred not in used:
            out[name] = preferred
            used.add(preferred)
            continue
        chosen = None
        for color in PALETTE:
            if color not in used:
                chosen = color
                break
        if chosen is None:
            # Palette exhausted: keep deterministic fallback.
            chosen = preferred
        out[name] = chosen
        used.add(chosen)
    return out

# -------------------------------
# Initialize FastAPI Router
# -------------------------------
pressplay_router = APIRouter()
MOVIE_FRONTEND_DIST = Path(__file__).resolve().parent / "movie-production-backend-master" / "app" / "frontend" / "dist"
MOVIE_FRONTEND_INDEX = MOVIE_FRONTEND_DIST / "index.html"

templates = Jinja2Templates(directory="templates")


def movie_frontend_or_template(request: Request, template_name: str, context: Optional[Dict[str, Any]] = None):
    if MOVIE_FRONTEND_INDEX.exists():
        return FileResponse(MOVIE_FRONTEND_INDEX)
    data = {"request": request}
    if context:
        data.update(context)
    return templates.TemplateResponse(request, template_name, data)


# -------------------------------
# User + Assignment Files
# -------------------------------
USERS_FILE = "users.json"
ASSIGNMENTS_FILE = "assignments.json"

if not os.path.exists(USERS_FILE):
    with open(USERS_FILE, "w") as f:
        json.dump({}, f)

if not os.path.exists(ASSIGNMENTS_FILE):
    with open(ASSIGNMENTS_FILE, "w") as f:
        json.dump({}, f)


def load_users():
    with open(USERS_FILE, "r") as f:
        return json.load(f)


def save_users(users):
    with open(USERS_FILE, "w") as f:
        json.dump(users, f, indent=2)


def load_assignments():
    with open(ASSIGNMENTS_FILE, "r") as f:
        return json.load(f)


def save_assignments(assignments):
    with open(ASSIGNMENTS_FILE, "w") as f:
        json.dump(assignments, f, indent=2)

# -------------------------------
# Waveform Utilities
# -------------------------------

def get_episode_video_path(project: str, episode: str) -> str:
    """
    Return the full path to the episode video.
    Expected: subtitles/{project}/{episode}/{episode}.mp4
    """
    video_path = os.path.join("subtitles", project, episode, f"{episode}.mp4")
    if not os.path.isfile(video_path):
        raise FileNotFoundError(f"Video file not found: {video_path}")
    return video_path


def _iter_file_bytes(path: str, start: int, end: int, chunk_size: int = 1024 * 1024) -> Iterator[bytes]:
    with open(path, "rb") as f:
        f.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            data = f.read(min(chunk_size, remaining))
            if not data:
                break
            remaining -= len(data)
            yield data


@pressplay_router.get("/video_stream/{project}/{episode}")
async def video_stream(project: str, episode: str, range: Optional[str] = Header(default=None)):
    """
    Range-enabled MP4 endpoint to guarantee browser seek support.
    """
    video_path = get_episode_video_path(project, episode)
    file_size = os.path.getsize(video_path)
    media_type = "video/mp4"
    base_headers = {
        "Accept-Ranges": "bytes",
        "Content-Type": media_type,
        "Cache-Control": "no-store",
    }

    if not range:
        headers = {**base_headers, "Content-Length": str(file_size)}
        return StreamingResponse(_iter_file_bytes(video_path, 0, file_size - 1), headers=headers, media_type=media_type)

    m = re.match(r"bytes=(\d*)-(\d*)", range.strip())
    if not m:
        raise HTTPException(status_code=416, detail="Invalid Range header")

    start_str, end_str = m.groups()
    if start_str == "" and end_str == "":
        raise HTTPException(status_code=416, detail="Invalid Range header")

    if start_str == "":
        # suffix length: bytes=-500000
        suffix_len = int(end_str)
        if suffix_len <= 0:
            raise HTTPException(status_code=416, detail="Invalid Range header")
        start = max(0, file_size - suffix_len)
        end = file_size - 1
    else:
        start = int(start_str)
        end = int(end_str) if end_str else (file_size - 1)

    if start < 0 or end >= file_size or start > end:
        raise HTTPException(status_code=416, detail="Requested Range Not Satisfiable")

    content_length = end - start + 1
    headers = {
        **base_headers,
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Content-Length": str(content_length),
    }
    return StreamingResponse(
        _iter_file_bytes(video_path, start, end),
        status_code=206,
        headers=headers,
        media_type=media_type,
    )

def ensure_waveform_json(project: str, episode: str) -> dict:
    """
    Proxy to the shared waveform generator to avoid stale settings.
    """
    return ensure_waveform_json_audio(project, episode)


# -------------------------------
# Timecode Utilities
# -------------------------------
def timecode_to_seconds(tc):
    """
    Parse flexible time formats safely.
    Accepted examples:
    - HH:MM:SS:FF
    - HH:MM:SS(.mmm)
    - numeric seconds
    Returns 0.0 for invalid/empty values instead of raising.
    """
    if tc is None:
        return 0.0

    raw = str(tc).strip()
    if not raw or raw.lower() in {"nan", "none", "null"}:
        return 0.0

    # HH:MM:SS:FF
    m_tc = re.fullmatch(r"(\d+):(\d+):(\d+):(\d+)", raw)
    if m_tc:
        h, m, s, f = [int(x) for x in m_tc.groups()]
        return (h * 3600.0) + (m * 60.0) + float(s) + (float(f) / 25.0)

    # HH:MM:SS(.mmm)
    m_sec = re.fullmatch(r"(\d+):(\d+):(\d+(?:\.\d+)?)", raw)
    if m_sec:
        h = int(m_sec.group(1))
        m = int(m_sec.group(2))
        s = float(m_sec.group(3))
        return (h * 3600.0) + (m * 60.0) + s

    # Plain seconds
    try:
        val = float(raw)
        return val if val >= 0 else 0.0
    except Exception:
        return 0.0


def timecode_filter(seconds):
    fps = 25
    total_frames = int(round(seconds * fps))
    h = total_frames // (3600 * fps)
    m = (total_frames // (60 * fps)) % 60
    s = (total_frames // fps) % 60
    f = total_frames % fps
    return f"{h:02}:{m:02}:{s:02}:{f:02}"


def detect_pause_marks_for_segment(project: str, episode: str, start_sec: float, end_sec: float) -> List[str]:
    """
    Detect pause marks from episode audio for one segment.
    Returns list of standalone marks, e.g. [".", ","].
    """
    if end_sec <= start_sec:
        return []

    video_path = os.path.join("subtitles", project, episode, f"{episode}.mp4")
    if not os.path.isfile(video_path):
        return []

    ffmpeg_cmd = [
        "ffmpeg",
        "-loglevel", "error",
        "-ss", str(float(start_sec)),
        "-to", str(float(end_sec)),
        "-i", video_path,
        "-vn",
        "-ac", "1",
        "-ar", "16000",
        "-f", "f32le",
        "pipe:1",
    ]

    try:
        proc = subprocess.run(
            ffmpeg_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if proc.returncode != 0 or not proc.stdout:
            return []

        samples = np.frombuffer(proc.stdout, dtype=np.float32)
        if samples.size < 320:
            return []

        sr = 16000
        frame = int(0.02 * sr)
        hop = int(0.01 * sr)

        energy = []
        for i in range(0, len(samples) - frame, hop):
            seg = samples[i : i + frame]
            energy.append(float(np.sqrt(np.mean(seg * seg) + 1e-12)))
        if not energy:
            return []

        energy = np.array(energy, dtype=np.float32)
        smooth = np.convolve(energy, np.ones(7) / 7, mode="same")
        thr = float(np.mean(smooth) * 0.4)
        silence = smooth < thr

        pauses = []
        start_i = None
        for i, is_silence in enumerate(silence):
            if is_silence and start_i is None:
                start_i = i
            elif not is_silence and start_i is not None:
                dur = (i - start_i) * hop / sr
                if dur >= ADAPT_MIN_REAL_GAP:
                    pauses.append(float(dur))
                start_i = None
        if start_i is not None:
            dur = (len(silence) - start_i) * hop / sr
            if dur >= ADAPT_MIN_REAL_GAP:
                pauses.append(float(dur))

        return ["," if p < ADAPT_SHORT_GAP_THRESHOLD else "." for p in pauses]
    except Exception as e:
        print(f"âš ï¸ pause detection failed for {project}/{episode}: {e}")
        return []


def adapt_text_with_marks(
    text: str,
    marks: List[str],
    duration_sec: float,
    cps_target: float = ADAPT_CPS_TARGET,
    previous_context: Optional[List[str]] = None,
    arabic_text: str = "",
) -> str:
    """
    Adapt one segment text for dubbing with CPS-focused control.
    Pause-symbol logic is intentionally disabled.
    """
    source = (text or "").strip()
    if not source:
        return source

    duration_sec = max(0.1, float(duration_sec))
    min_chars = max(8, int(duration_sec * ADAPT_CPS_MIN))
    max_chars = max(min_chars, int(duration_sec * ADAPT_CPS_MAX))
    arabic_anchor = (arabic_text or "").strip()

    def _norm(s: str) -> str:
        return "".join(ch.lower() for ch in (s or "") if ch.isalnum() or ch.isspace()).strip()

    def _cps(s: str) -> float:
        return len(strip_annotations_for_cps(s)) / max(0.1, duration_sec)

    def _has_arabic(s: str) -> bool:
        return bool(re.search(r"[\u0600-\u06FF]", s or ""))

    def _is_bad(s: str) -> bool:
        t = (s or "").lower()
        if not t.strip():
            return True
        if _has_arabic(t):
            return True
        bad = ["i cannot", "i can't", "i am unable", "cannot fulfill", "can't fulfill"]
        return any(x in t for x in bad)

    def _extract_text(raw_text: str) -> str:
        t = (raw_text or "").strip()
        try:
            obj = json.loads(t)
            if isinstance(obj, dict):
                if isinstance(obj.get("text"), str):
                    return obj["text"].strip()
                if isinstance(obj.get("blocks"), list):
                    return " ".join(str(x).strip() for x in obj["blocks"] if str(x).strip()).strip()
        except Exception:
            pass
        i, j = t.find("{"), t.rfind("}")
        if i != -1 and j > i:
            try:
                obj = json.loads(t[i:j+1])
                if isinstance(obj, dict) and isinstance(obj.get("text"), str):
                    return obj["text"].strip()
            except Exception:
                pass
        return t

    def _rewrite(current: str, mode: str, temp: float) -> str:
        prompt = f"""
You are a professional dubbing adapter.
Rewrite in natural English while preserving exact meaning.
Do NOT change facts, names, entities, intent, or who did what.
Do NOT output Arabic.
Target CPS between {ADAPT_CPS_MIN:.0f} and {ADAPT_CPS_MAX:.0f}.
Target length between {min_chars} and {max_chars} characters.
Sentence type must stay the same (question stays question).
Mode: {mode}
Return JSON only: {{"text":"adapted sentence"}}
Arabic meaning anchor: "{arabic_anchor if arabic_anchor else ''}"
Source: "{source}"
Current: "{current}"
Duration seconds: {duration_sec:.3f}
"""
        raw = ollama_chat_content(prompt=prompt, model=ADAPT_MODEL, temperature=temp)
        out = _extract_text(raw).strip().strip('"').strip("'")
        return sanitize_text_for_index_tts2(re.sub(r"\s+", " ", out))

    source_cps = _cps(source)
    # Fast path: if source is already within target CPS, avoid expensive LLM calls.
    if ADAPT_CPS_MIN <= source_cps <= ADAPT_CPS_MAX:
        return sanitize_text_for_index_tts2(source)

    best = source
    best_dist = min(abs(_cps(source) - ADAPT_CPS_MIN), abs(_cps(source) - ADAPT_CPS_MAX))
    best_diff = ""
    best_diff_dist = 10**9

    for mode, temps in [
        ("rewrite with different wording", [0.40]),
        ("expand naturally if short, compress if long", [0.50]),
    ]:
        for temp in temps:
            cand = _rewrite(best, mode, temp)
            if _is_bad(cand):
                continue
            if source.endswith("?") and not cand.endswith("?"):
                cand = cand.rstrip(".!,;: ") + "?"
            if _norm(cand) == _norm(source) and mode == "rewrite with different wording":
                continue
            cps_val = _cps(cand)
            dist = 0.0 if ADAPT_CPS_MIN <= cps_val <= ADAPT_CPS_MAX else min(abs(cps_val - ADAPT_CPS_MIN), abs(cps_val - ADAPT_CPS_MAX))
            if _norm(cand) != _norm(source) and dist < best_diff_dist:
                best_diff = cand
                best_diff_dist = dist
            if dist < best_dist:
                best = cand
                best_dist = dist
            if ADAPT_CPS_MIN <= cps_val <= ADAPT_CPS_MAX:
                return cand

    # Hard fallback: force a different wording when source is far from target CPS.
    if _norm(best) == _norm(source) and (source_cps > ADAPT_CPS_MAX or source_cps < ADAPT_CPS_MIN):
        for temp in [0.45]:
            mode = (
                f"hard-compress to <= {max_chars} chars with same meaning; must use different wording"
                if source_cps > ADAPT_CPS_MAX
                else f"expand naturally to >= {min_chars} chars with same meaning; must use different wording"
            )
            cand = _rewrite(source, mode, temp)
            if _is_bad(cand):
                continue
            if source.endswith("?") and not cand.endswith("?"):
                cand = cand.rstrip(".!,;: ") + "?"
            if _norm(cand) == _norm(source):
                continue
            cps_val = _cps(cand)
            dist = 0.0 if ADAPT_CPS_MIN <= cps_val <= ADAPT_CPS_MAX else min(abs(cps_val - ADAPT_CPS_MIN), abs(cps_val - ADAPT_CPS_MAX))
            if dist < best_diff_dist:
                best_diff = cand
                best_diff_dist = dist
            if ADAPT_CPS_MIN <= cps_val <= ADAPT_CPS_MAX:
                return cand

    if best_diff:
        return sanitize_text_for_index_tts2(best_diff)
    return sanitize_text_for_index_tts2(best)


def _normalize_for_compare(text: str) -> str:
    return "".join(ch.lower() for ch in (text or "") if ch.isalnum() or ch.isspace()).strip()


def _cps_for_duration(text: str, duration_sec: float) -> float:
    return len(strip_annotations_for_cps(text)) / max(0.1, float(duration_sec or 0.0))


templates.env.filters["timecode"] = timecode_filter


# =====================================================
# ðŸ”¥ NEW WEBSOCKET CONNECTION MANAGER (ROOM-BASED)
# =====================================================
class ConnectionManager:
    def __init__(self):
        # room_name â†’ list of websocket connections
        self.rooms: dict[str, List[WebSocket]] = {}

    async def connect(self, websocket: WebSocket, room: str):
        await websocket.accept()
        if room not in self.rooms:
            self.rooms[room] = []
        self.rooms[room].append(websocket)

    def disconnect(self, websocket: WebSocket, room: str):
        if room in self.rooms and websocket in self.rooms[room]:
            self.rooms[room].remove(websocket)

    async def broadcast(self, room: str, message: str):
        if room not in self.rooms:
            return
        sockets = list(self.rooms[room])
        if not sockets:
            return

        async def _send_one(ws: WebSocket) -> tuple[WebSocket, bool]:
            try:
                # Bound send time so a slow/disconnected client cannot stall segment ops.
                await asyncio.wait_for(ws.send_text(message), timeout=0.35)
                return ws, True
            except Exception:
                return ws, False

        results = await asyncio.gather(*(_send_one(ws) for ws in sockets), return_exceptions=False)

        # Remove stale sockets so future broadcasts stay fast.
        for ws, ok in results:
            if not ok:
                try:
                    self.disconnect(ws, room)
                except Exception:
                    pass


# âœ… IMPORTANT: global manager instance
manager = ConnectionManager()


# =====================================================
# AI TRANSLATION ENDPOINT (Memory-Based)
# =====================================================
@pressplay_router.post("/ai/translate")
async def ai_translate(payload: dict = Body(...)):
    return {"status": "error", "arabic": "", "message": "Translation service disabled"}


# Routes
@pressplay_router.get("/login", response_class=HTMLResponse)
async def login_form(request: Request):
    return movie_frontend_or_template(request, "login.html")

@pressplay_router.post("/login")
async def login(request: Request, username: str = Form(...), password: str = Form(...)):
    users = load_users()
    user = users.get(username)
    if user and user["password"] == password:
        request.session["user"] = {"username": username, "role": user["role"]}
        return RedirectResponse("/projects", status_code=302)
    return movie_frontend_or_template(request, "login.html", {"error": "Invalid credentials"})

@pressplay_router.get("/logout")
async def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/login", status_code=302)

@pressplay_router.get("/admin", response_class=HTMLResponse)
async def admin_panel(request: Request):
    user = request.session.get("user")
    if not user or user["role"] != "admin":
        return RedirectResponse("/login")
    
    root_dir = "subtitles"
    projects = []
    if os.path.exists(root_dir):
        for name in os.listdir(root_dir):
            if os.path.isdir(os.path.join(root_dir, name)):
                projects.append(name)

    users_dict = load_users()
    users = [{"username": uname, "role": data["role"]} for uname, data in users_dict.items()]

    return movie_frontend_or_template(request, "admin.html", {
        "projects": projects,
        "users": users
    })

@pressplay_router.get("/admin/project_episodes")
async def get_project_episodes(project: str):
    project_path = os.path.join("subtitles", project)
    episodes = []

    if os.path.isdir(project_path):
        for folder in os.listdir(project_path):
            ep_path = os.path.join(project_path, folder)
            if os.path.isdir(ep_path):
                base_path = os.path.join(ep_path, folder)
                episodes.append({
                    "name": folder,
                    "has_video": os.path.isfile(base_path + ".mp4"),
                    "has_csv_en": os.path.isfile(base_path + "_en.csv"),
                    "has_csv_ar": os.path.isfile(base_path + "_ar.csv")
                })

    return {"episodes": episodes}

@pressplay_router.get("/admin/assigned_users")
async def get_assigned_users(project: str, episode: str):
    assignments = load_assignments()
    key = f"{project}/{episode}"
    users = assignments.get(key, [])
    return {"users": users}

from starlette.responses import RedirectResponse

@pressplay_router.post("/admin/assign_user")
async def assign_user(
    request: Request,
    title: str = Form(...),
    episode: str = Form(...),
    username: str = Form(...)
):
    user = request.session.get("user")
    if not user or user.get("role") != "admin":
        return RedirectResponse("/login", status_code=302)

    assignments = load_assignments()
    key = f"{title}/{episode}"
    assignments.setdefault(key, [])
    if username not in assignments[key]:
        assignments[key].append(username)
        save_assignments(assignments)

    request.session["flash"] = {"type": "success", "message": f"âœ… Assigned {username} to {title} / {episode}"}
    return RedirectResponse(url="/admin", status_code=303)

@pressplay_router.post("/admin/remove_assignment")
async def remove_assignment(project: str = Form(...), episode: str = Form(...), username: str = Form(...)):
    assignments = load_assignments()
    key = f"{project}/{episode}"
    if key in assignments and username in assignments[key]:
        assignments[key].remove(username)
        save_assignments(assignments)
    return {"status": "removed"}

@pressplay_router.post("/admin/create_user")
async def create_user(
    request: Request,
    username: str = Form(...),
    password: str = Form(...),
    role: str = Form(...)
):
    session_user = request.session.get("user")
    if not session_user or session_user.get("role") != "admin":
        return RedirectResponse("/login", status_code=302)

    users = load_users()
    if username in users:
        request.session["flash"] = {"type": "error", "message": f"âŒ User {username} already exists."}
        return RedirectResponse(url="/admin", status_code=303)

    users[username] = {"password": password, "role": role}
    save_users(users)

    request.session["flash"] = {"type": "success", "message": f"âœ… User {username} created ({role})."}
    return RedirectResponse(url="/admin", status_code=303)


@pressplay_router.post("/admin/unassign_user")
async def unassign_user(
    project: str = Form(...),
    episode: str = Form(...),
    username: str = Form(...)
):
    assignments = load_assignments()
    
    key = f"{project}/{episode}"   # â† FIXED (slash instead of colon)

    if key in assignments and username in assignments[key]:
        assignments[key].remove(username)

        # Remove empty keys
        if not assignments[key]:
            del assignments[key]

        save_assignments(assignments)
        return {"status": "ok", "removed": username}

    return {"status": "error", "message": "User not assigned"}


@pressplay_router.post("/admin/create_project")
async def create_project(
    request: Request,
    project_select: str = Form(""),
    project_input: str = Form(""),
    episode_count: str = Form("0")
):
    user = request.session.get("user")
    if not user or user.get("role") != "admin":
        return RedirectResponse("/login", status_code=302)

    project_name = project_input.strip() or project_select.strip()
    if not project_name:
        request.session["flash"] = {"type": "error", "message": "âŒ No project name provided."}
        return RedirectResponse(url="/admin", status_code=303)

    path = os.path.join("subtitles", project_name)
    os.makedirs(path, exist_ok=True)

    try:
        count = int(episode_count)
    except ValueError:
        count = 0

    created = 0
    for i in range(1, count + 1):
        episode_folder = os.path.join(path, f"{project_name}_Episode_{i}")
        if not os.path.exists(episode_folder):
            os.makedirs(episode_folder)
            created += 1

    request.session["flash"] = {"type": "success", "message": f"âœ… Project '{project_name}': {created} episode(s) created."}
    return RedirectResponse(url="/admin", status_code=303)

from typing import Optional

@pressplay_router.post("/admin/upload")
async def upload_files(
    request: Request,
    project: str = Form(...),
    episode: str = Form(...),
    video: Optional[UploadFile] = File(None),
    csv_en: Optional[UploadFile] = File(None),
    csv_ar: Optional[UploadFile] = File(None),
):
    user = request.session.get("user")
    if not user or user.get("role") != "admin":
        return RedirectResponse("/login", status_code=302)

    episode_path = os.path.join("subtitles", project, episode)
    os.makedirs(episode_path, exist_ok=True)

    uploaded_any = False

    if video and getattr(video, "filename", ""):
        video_path = os.path.join(episode_path, f"{episode}.mp4")
        with open(video_path, "wb") as f:
            shutil.copyfileobj(video.file, f)
        uploaded_any = True

    if csv_en and getattr(csv_en, "filename", ""):
        en_path = os.path.join(episode_path, f"{episode}_en.csv")
        with open(en_path, "wb") as f:
            shutil.copyfileobj(csv_en.file, f)
        uploaded_any = True

    if csv_ar and getattr(csv_ar, "filename", ""):
        ar_path = os.path.join(episode_path, f"{episode}_ar.csv")
        with open(ar_path, "wb") as f:
            shutil.copyfileobj(csv_ar.file, f)
        uploaded_any = True

    if not uploaded_any:
        request.session["flash"] = {
            "type": "error",
            "message": "âŒ Please choose at least one file to upload."
        }
        return RedirectResponse(url="/admin", status_code=303)

    request.session["flash"] = {
        "type": "success",
        "message": f"âœ… Files uploaded for {project} / {episode}"
    }
    return RedirectResponse(url="/admin", status_code=303)


@pressplay_router.get("/admin/episode_speakers")
async def admin_episode_speakers(request: Request, project: str, episode: str):
    user = request.session.get("user")
    if not user or user.get("role") != "admin":
        return JSONResponse(status_code=403, content={"status": "error", "message": "Admin only"})

    try:
        return {"status": "ok", "speakers": get_episode_speakers(project, episode)}
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e), "speakers": []},
        )


@pressplay_router.get("/admin/download_adl")
async def download_adl(request: Request, project: str, episode: str, filename: Optional[str] = None):
    user = request.session.get("user")
    if not user or user.get("role") != "admin":
        return JSONResponse(status_code=403, content={"status": "error", "message": "Admin only"})

    recordings_dir = Path("subtitles") / project / episode / "recordings"
    safe_name = Path(filename).name if filename else f"{episode}.adl"
    adl_path = recordings_dir / safe_name
    if not adl_path.exists():
        fallback = recordings_dir / f"{episode}.adl"
        if fallback.exists():
            adl_path = fallback
        else:
            return JSONResponse(status_code=404, content={"status": "error", "message": "ADL file not found"})

    return FileResponse(str(adl_path), filename=adl_path.name, media_type="application/octet-stream")


@pressplay_router.post("/admin/export_adl_episode")
async def export_adl_episode(request: Request):
    user = request.session.get("user")
    if not user or user.get("role") != "admin":
        return JSONResponse(status_code=403, content={"status": "error", "message": "Admin only"})

    try:
        payload = await request.json()
    except Exception:
        payload = {}

    project = (payload.get("project") or "").strip()
    episode = (payload.get("episode") or "").strip()
    speakers = payload.get("speakers") or []
    copy_wavs = bool(payload.get("copy_wavs", False))
    copy_folder = (payload.get("copy_folder") or "").strip() or None
    done_only = bool(payload.get("done_only", False))
    track_mode = (payload.get("track_mode") or "multi_track_by_speaker").strip() or "multi_track_by_speaker"
    adl_source_root = (payload.get("adl_source_root") or "").strip() or None

    if not project or not episode:
        return JSONResponse(
            status_code=400,
            content={"status": "error", "message": "Missing project or episode"},
        )

    try:
        result = build_adl(
            project,
            episode,
            selected_speakers=speakers,
            copy_wavs=copy_wavs,
            copy_folder=copy_folder,
            done_only=done_only,
            track_mode=track_mode,
            adl_source_root=adl_source_root,
        )

        return {
            "status": "ok",
            "file": result["path"],
            "filename": result["filename"],
            "download_url": (
                f"/admin/download_adl?project={urllib.parse.quote(project)}"
                f"&episode={urllib.parse.quote(episode)}"
                f"&filename={urllib.parse.quote(result['filename'])}"
            ),
            "exported_items": result["exported_items"],
            "speakers": result["speakers"],
            "copy_folder": result["copy_folder"],
            "copied_files": len(result["copied_files"]),
            "missing_files": result["missing_files"],
            "done_only": result["done_only"],
            "track_mode": result["track_mode"],
            "track_count": result["track_count"],
        }

    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )

@pressplay_router.get("/waveform_json/{project}/{episode}")
async def get_waveform_json(project: str, episode: str):
    """
    Return the JSON waveform data for the given project/episode.
    Generates and caches it on first request, then reuses.
    """
    try:
        data = ensure_waveform_json(project, episode)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Video file not found for episode")
    except Exception as e:
        print("Waveform JSON generation error:", e)
        raise HTTPException(status_code=500, detail="Failed to generate waveform")

    return JSONResponse(content=data)


@pressplay_router.get("/editor/{project}/{episode}", response_class=HTMLResponse)
async def subtitle_editor(request: Request, project: str, episode: str):
    user = request.session.get("user")
    if not user:
        return RedirectResponse("/login")

    decoded_project = urllib.parse.unquote(project)
    decoded_episode = urllib.parse.unquote(episode)

    base_path = os.path.join("subtitles", decoded_project, decoded_episode)
    en_path = os.path.join(base_path, f"{decoded_episode}_en.csv")
    ar_path = os.path.join(base_path, f"{decoded_episode}_ar.csv")

    def normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
        df = df.copy()
        df.columns = [str(c).strip().replace("\ufeff", "") for c in df.columns]
        needed = ["Timecode In", "Timecode Out", "Character", "Dialogue"]
        for col in needed:
            if col not in df.columns:
                df[col] = ""
        return df[needed]

    def ensure_csv(path: str):
        if not os.path.exists(path):
            pd.DataFrame(
                columns=["Timecode In", "Timecode Out", "Character", "Dialogue"]
            ).to_csv(path, index=False, encoding="utf-8-sig")

    def safe_read_csv(path: str) -> pd.DataFrame:
        """
        Read subtitle CSV defensively so one malformed row does not break editor load.
        """
        try:
            return pd.read_csv(path, encoding="utf-8-sig")
        except pd.errors.ParserError:
            return pd.read_csv(
                path,
                encoding="utf-8-sig",
                engine="python",
                on_bad_lines="skip",
            )
        except UnicodeDecodeError:
            return pd.read_csv(
                path,
                encoding="utf-8",
                engine="python",
                on_bad_lines="skip",
            )

    # Auto-create paired CSV if one is missing
    if os.path.exists(en_path) and not os.path.exists(ar_path):
        df = safe_read_csv(en_path)
        df = normalize_columns(df)
        df_out = df[["Timecode In", "Timecode Out", "Character"]].copy()
        df_out["Dialogue"] = ""
        df_out.to_csv(ar_path, index=False, encoding="utf-8-sig")
    elif os.path.exists(ar_path) and not os.path.exists(en_path):
        df = safe_read_csv(ar_path)
        df = normalize_columns(df)
        df_out = df[["Timecode In", "Timecode Out", "Character"]].copy()
        df_out["Dialogue"] = ""
        df_out.to_csv(en_path, index=False, encoding="utf-8-sig")

    ensure_csv(en_path)
    ensure_csv(ar_path)

    # Load recordings metadata
    meta_path = os.path.join(base_path, "recordings", "recordings_meta.json")
    recordings_meta = []
    if os.path.exists(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                recordings_meta = json.load(f)
            if not isinstance(recordings_meta, list):
                recordings_meta = []
        except Exception:
            recordings_meta = []

    # Load CSVs only
    df_en = normalize_columns(safe_read_csv(en_path))
    df_ar = normalize_columns(safe_read_csv(ar_path))

    # Process English CSV
    df_en["start"] = df_en["Timecode In"].astype(str).apply(timecode_to_seconds)
    df_en["end"] = df_en["Timecode Out"].astype(str).apply(timecode_to_seconds)
    df_en["speaker"] = df_en["Character"].fillna("Unset").replace("", "Unset").astype(str)
    df_en["text"] = df_en["Dialogue"].fillna("").astype(str).str.replace("\n", " ", regex=False)

    # Process Arabic CSV
    df_ar["start"] = df_ar["Timecode In"].astype(str).apply(timecode_to_seconds)
    df_ar["end"] = df_ar["Timecode Out"].astype(str).apply(timecode_to_seconds)
    df_ar["speaker"] = df_ar["Character"].fillna("Unset").replace("", "Unset").astype(str)
    df_ar["text"] = df_ar["Dialogue"].fillna("").astype(str).str.replace("\n", " ", regex=False)

    # Keep both dataframes aligned by row count
    row_count = max(len(df_en), len(df_ar))

    while len(df_en) < row_count:
        df_en.loc[len(df_en)] = {
            "Timecode In": "",
            "Timecode Out": "",
            "Character": "Unset",
            "Dialogue": "",
            "start": 0.0,
            "end": 0.0,
            "speaker": "Unset",
            "text": "",
        }

    while len(df_ar) < row_count:
        df_ar.loc[len(df_ar)] = {
            "Timecode In": "",
            "Timecode Out": "",
            "Character": "Unset",
            "Dialogue": "",
            "start": 0.0,
            "end": 0.0,
            "speaker": "Unset",
            "text": "",
        }

    # Synchronize speakers across EN and AR
    for i in range(row_count):
        spk_en = str(df_en.at[i, "speaker"]).strip()
        spk_ar = str(df_ar.at[i, "speaker"]).strip()

        if spk_en and spk_en.lower() != "unset":
            chosen = spk_en
        elif spk_ar and spk_ar.lower() != "unset":
            chosen = spk_ar
        else:
            chosen = "Unset"

        df_en.at[i, "speaker"] = chosen
        df_ar.at[i, "speaker"] = chosen

    # Pair lines
    paired_lines = []
    for i in range(row_count):
        en_row = df_en.iloc[i]
        ar_row = df_ar.iloc[i]

        start = en_row["start"] if str(en_row["Timecode In"]).strip() else ar_row["start"]
        end = en_row["end"] if str(en_row["Timecode Out"]).strip() else ar_row["end"]

        paired_lines.append({
            "start": float(start),
            "end": float(end),
            "en": {
                "speaker": str(en_row["speaker"]).strip() or "Unset",
                "text": str(en_row["text"]),
            },
            "ar": {
                "speaker": str(ar_row["speaker"]).strip() or "Unset",
                "text": str(ar_row["text"]),
            },
        })

    all_speakers = set()

    for pair in paired_lines:
        for side in ["en", "ar"]:
            name = (pair[side].get("speaker") or "Unset").strip()
            all_speakers.add(name)
    speaker_colors = build_unique_speaker_colors(list(all_speakers))

    return templates.TemplateResponse(request, "index.html", {
        "request": request,
        "project": decoded_project,
        "episode": decoded_episode,
        "paired_lines": paired_lines,
        "speaker_colors": speaker_colors,
        "recordings_meta": recordings_meta,
        "all_speakers": sorted(all_speakers),
    })

@pressplay_router.post("/save_subtitle")
async def save_subtitle(
    index: int = Form(...),
    lang: str = Form(...),
    text: str = Form(""),
    speaker: str = Form(""),
    start: str = Form(None),
    end: str = Form(None),
    editor_user_id: str = Form(""),
    editor_session_id: str = Form(""),
    project: str = Form(...),
    episode: str = Form(...)
):
    conflicting_user = get_conflicting_editor(project, episode, editor_user_id, editor_session_id)
    if conflicting_user:
        return JSONResponse(
            status_code=423,
            content={
                "status": "locked",
                "message": f"Episode is being edited by {conflicting_user}. Please wait.",
                "locked_by": conflicting_user,
            },
        )
    episode_lock = get_episode_write_lock(project, episode)
    await episode_lock.acquire()
    try:
        if lang not in ["en", "ar"]:
            return {"status": "error", "message": "Invalid language"}

        if index < 0:
            return {"status": "error", "message": "Invalid index"}

        base_path = os.path.join("subtitles", project, episode)
        os.makedirs(base_path, exist_ok=True)

        en_path = os.path.join(base_path, f"{episode}_en.csv")
        ar_path = os.path.join(base_path, f"{episode}_ar.csv")

        def ensure_csv(path: str):
            if not os.path.exists(path):
                pd.DataFrame(
                    columns=["Timecode In", "Timecode Out", "Character", "Dialogue"]
                ).to_csv(path, index=False, encoding="utf-8-sig")

        def normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
            df = df.copy()
            df.columns = [str(c).strip().replace("\ufeff", "") for c in df.columns]
            needed = ["Timecode In", "Timecode Out", "Character", "Dialogue"]
            for col in needed:
                if col not in df.columns:
                    df[col] = ""
            return df[needed]

        def seconds_to_tc(seconds: float) -> str:
            fps = 25
            total_frames = int(round(float(seconds) * fps))
            h = total_frames // (3600 * fps)
            m = (total_frames % (3600 * fps)) // (60 * fps)
            s = (total_frames % (60 * fps)) // fps
            f = total_frames % fps
            return f"{h:02}:{m:02}:{s:02}:{f:02}"

        def parse_time(v):
            try:
                x = float(v)
                if x >= 0:
                    return x
            except Exception:
                return None
            return None

        ensure_csv(en_path)
        ensure_csv(ar_path)

        df_en = normalize_columns(pd.read_csv(en_path, encoding="utf-8-sig"))
        df_ar = normalize_columns(pd.read_csv(ar_path, encoding="utf-8-sig"))

        max_len = max(len(df_en), len(df_ar), index + 1)

        while len(df_en) < max_len:
            df_en.loc[len(df_en)] = {
                "Timecode In": "",
                "Timecode Out": "",
                "Character": "Unset",
                "Dialogue": "",
            }

        while len(df_ar) < max_len:
            df_ar.loc[len(df_ar)] = {
                "Timecode In": "",
                "Timecode Out": "",
                "Character": "Unset",
                "Dialogue": "",
            }

        clean_speaker = (speaker or "").strip()

        st = parse_time(start)
        en = parse_time(end)

        # update text only in selected language CSV
        if lang == "en":
            df_en.at[index, "Dialogue"] = text or ""
        else:
            df_ar.at[index, "Dialogue"] = text or ""

        # only update speaker if a real value was provided
        if clean_speaker:
            df_en.at[index, "Character"] = clean_speaker
            df_ar.at[index, "Character"] = clean_speaker

        # timing stays mirrored in both CSVs
        if st is not None:
            tc_in = seconds_to_tc(st)
            df_en.at[index, "Timecode In"] = tc_in
            df_ar.at[index, "Timecode In"] = tc_in

        if en is not None:
            tc_out = seconds_to_tc(en)
            df_en.at[index, "Timecode Out"] = tc_out
            df_ar.at[index, "Timecode Out"] = tc_out

        # atomic save
        en_tmp = en_path + ".tmp"
        ar_tmp = ar_path + ".tmp"

        df_en.to_csv(en_tmp, index=False, encoding="utf-8-sig")
        df_ar.to_csv(ar_tmp, index=False, encoding="utf-8-sig")

        os.replace(en_tmp, en_path)
        os.replace(ar_tmp, ar_path)

        return {
            "status": "ok",
            "message": "Subtitle saved to CSV",
            "index": index,
            "lang": lang,
        }

    except Exception as e:
        print(f"âŒ save_subtitle failed: {e}")
        print(traceback.format_exc())
        return {"status": "error", "message": str(e)}
    finally:
        if episode_lock.locked():
            episode_lock.release()


@pressplay_router.post("/adapt_segment")
async def adapt_segment(
    project: str = Form(...),
    episode: str = Form(...),
    index: int = Form(...),
    cps_target: float = Form(ADAPT_CPS_TARGET),
):
    try:
        if index < 0:
            return {"status": "error", "message": "Invalid index"}

        base_path = os.path.join("subtitles", project, episode)
        en_path = os.path.join(base_path, f"{episode}_en.csv")
        ar_path = os.path.join(base_path, f"{episode}_ar.csv")
        if not os.path.exists(en_path) or not os.path.exists(ar_path):
            return {"status": "error", "message": "Episode subtitles not found"}

        def normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
            df = df.copy()
            df.columns = [str(c).strip().replace("\ufeff", "") for c in df.columns]
            needed = ["Timecode In", "Timecode Out", "Character", "Dialogue"]
            for col in needed:
                if col not in df.columns:
                    df[col] = ""
            return df[needed]

        df_en = normalize_columns(pd.read_csv(en_path, encoding="utf-8-sig"))
        df_ar = normalize_columns(pd.read_csv(ar_path, encoding="utf-8-sig"))
        max_len = max(len(df_en), len(df_ar))
        if index >= max_len:
            return {"status": "error", "message": "Segment index out of range"}

        while len(df_en) < max_len:
            df_en.loc[len(df_en)] = {"Timecode In": "", "Timecode Out": "", "Character": "Unset", "Dialogue": ""}
        while len(df_ar) < max_len:
            df_ar.loc[len(df_ar)] = {"Timecode In": "", "Timecode Out": "", "Character": "Unset", "Dialogue": ""}

        row_en = df_en.iloc[index]
        row_ar = df_ar.iloc[index]
        start_tc = str(row_en["Timecode In"]).strip() or str(row_ar["Timecode In"]).strip()
        end_tc = str(row_en["Timecode Out"]).strip() or str(row_ar["Timecode Out"]).strip()
        if not start_tc or not end_tc:
            return {"status": "error", "message": "Missing segment timecodes"}

        start_sec = timecode_to_seconds(start_tc)
        end_sec = timecode_to_seconds(end_tc)
        duration_sec = max(0.0, float(end_sec - start_sec))
        if duration_sec <= 0:
            return {"status": "error", "message": "Invalid segment duration"}

        # Re-adapt source should come from AR line so repeated Adapt does not
        # drift by adapting already-adapted EN text.
        source_text = str(row_ar["Dialogue"] or "").strip()
        if not source_text:
            source_text = str(row_en["Dialogue"] or "").strip()
        if not source_text:
            return {"status": "error", "message": "No source text to adapt"}

        speaker = str(row_en["Character"] or row_ar["Character"] or "Unset").strip()
        marks = detect_pause_marks_for_segment(project, episode, start_sec, end_sec)

        adapted_text = adapt_text_with_marks(
            source_text,
            marks,
            duration_sec,
            cps_target=cps_target,
            previous_context=[],
            arabic_text=source_text,
        )
        adapted_text = sanitize_text_for_index_tts2(adapted_text)
        if not adapted_text:
            return {"status": "error", "message": "Adapted text is empty after TTS sanitization"}

        source_cps = _cps_for_duration(source_text, duration_sec)
        adapted_cps = _cps_for_duration(adapted_text, duration_sec)
        same_text = _normalize_for_compare(source_text) == _normalize_for_compare(adapted_text)
        out_of_range = adapted_cps > ADAPT_CPS_MAX or adapted_cps < ADAPT_CPS_MIN
        if same_text and out_of_range:
            return {
                "status": "error",
                "message": (
                    "Adaptation produced no meaningful rewrite and CPS is still out of target range. "
                    f"source_cps={source_cps:.1f}, adapted_cps={adapted_cps:.1f}, "
                    f"target={ADAPT_CPS_MIN:.1f}-{ADAPT_CPS_MAX:.1f}."
                ),
            }

        save_result = await save_subtitle(
            index=index,
            lang="en",
            text=adapted_text,
            speaker=speaker,
            start=str(start_sec),
            end=str(end_sec),
            project=project,
            episode=episode,
        )
        if save_result.get("status") != "ok":
            return {"status": "error", "message": save_result.get("message", "Failed to save adapted text")}

        return {
            "status": "ok",
            "index": index,
            "adapted_text": adapted_text,
            "pause_marks": marks,
            "pause_pattern": " ".join(marks),
            "duration_sec": round(duration_sec, 3),
            "cps_target": cps_target,
        }
    except Exception as e:
        print(f"âŒ adapt_segment failed: {e}")
        print(traceback.format_exc())
        return {"status": "error", "message": str(e)}



@pressplay_router.websocket("/ws/edits/{project}/{episode}")
async def websocket_endpoint(websocket: WebSocket, project: str, episode: str):
    room = f"{project}/{episode}"
    await manager.connect(websocket, room)
    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                user = str((msg or {}).get("user", "")).strip()
                session_id = str((msg or {}).get("session_id", "")).strip()
                msg_type = str((msg or {}).get("type", "")).strip().lower()
                editor_key = build_editor_key(user, session_id)
                if editor_key:
                    _register_socket_user(room, websocket, editor_key)
                    _touch_room_user(room, editor_key)
                    if msg_type == "lock":
                        _acquire_room_field_lock(room, editor_key)
                    elif msg_type == "unlock":
                        _release_room_field_lock(room, editor_key)
            except Exception:
                # Keep websocket relay robust even on malformed payloads.
                pass
            await manager.broadcast(room, data)
    except WebSocketDisconnect:
        manager.disconnect(websocket, room)
        _unregister_socket_user(room, websocket)

@pressplay_router.post("/save_done_state")
async def save_done_state(
    project: str = Form(...),
    episode: str = Form(...),
    index: int = Form(...),
    is_done: str = Form(...),
    editor_user_id: str = Form(""),
    editor_session_id: str = Form("")
):
    try:
        conflicting_user = get_conflicting_editor(project, episode, editor_user_id, editor_session_id)
        if conflicting_user:
            return JSONResponse(
                status_code=423,
                content={
                    "status": "locked",
                    "message": f"Episode is being edited by {conflicting_user}. Please wait.",
                    "locked_by": conflicting_user,
                },
            )
        done_indexes = load_done_segment_indexes(project, episode)
        is_done_bool = str(is_done).lower() == "true"

        if is_done_bool:
            done_indexes.add(index)
        else:
            done_indexes.discard(index)

        save_done_segment_indexes(project, episode, done_indexes)

        room = f"{project}/{episode}"
        try:
            await manager.broadcast(room, json.dumps({
                "type": "segment_done",
                "index": index,
                "is_done": is_done_bool
            }))
        except Exception as ws_error:
            print(f"WebSocket broadcast failed: {ws_error}")

        return {"status": "ok", "index": index, "is_done": is_done_bool}

    except Exception as e:
        print(f"âŒ Error saving done state: {e}")
        return {"status": "error", "message": str(e)}


@pressplay_router.get("/get_done_states")
async def get_done_states(project: str, episode: str):
    try:
        done_indexes = load_done_segment_indexes(project, episode)
        done_states = [{"index": i, "is_done": True} for i in sorted(done_indexes)]
        return {"status": "ok", "done_states": done_states}
    except Exception as e:
        print(f"âŒ Error loading done states: {e}")
        return {"status": "error", "message": str(e), "done_states": []}



@pressplay_router.get("/admin/project_episode_count")
async def project_episode_count(project: str):
    project_path = os.path.join("subtitles", project)
    count = 0
    if os.path.isdir(project_path):
        count = len([
            name for name in os.listdir(project_path)
            if os.path.isdir(os.path.join(project_path, name))
        ])
    return {"project": project, "count": count}

@pressplay_router.get("/admin/debug_project_episodes")
async def debug_project_episodes(project: str):
    project_path = os.path.join("subtitles", project)
    episodes = []

    if os.path.isdir(project_path):
        for folder in os.listdir(project_path):
            ep_path = os.path.join(project_path, folder)
            if os.path.isdir(ep_path):
                video_file = os.path.join(ep_path, f"{folder}.mp4")
                has_video = os.path.isfile(video_file)
                episodes.append({
                    "name": folder,
                    "has_video": has_video
                })

    return JSONResponse(content={"episodes": episodes})

@pressplay_router.get("/admin/users", response_class=HTMLResponse)
async def list_users(request: Request):
    user = request.session.get("user")
    if not user or user["role"] != "admin":
        return RedirectResponse("/login")
    users = load_users()
    return movie_frontend_or_template(request, "users.html", {
        "users": users
    })

@pressplay_router.post("/admin/edit_user")
async def edit_user(username: str = Form(...)):
    # Placeholder for future editing logic
    return RedirectResponse("/admin/users", status_code=302)

@pressplay_router.post("/admin/delete_user")
async def delete_user(username: str = Form(...)):
    users = load_users()
    if username in users:
        del users[username]
        save_users(users)
    return RedirectResponse("/admin/users", status_code=302)

@pressplay_router.get("/projects", response_class=HTMLResponse)
async def view_projects(request: Request):
    user = request.session.get("user")
    if not user:
        return RedirectResponse("/login")

    base_dir = "subtitles"
    assignments = load_assignments()
    projects = {}

    for key, assigned_users in assignments.items():
        project, episode = key.split("/", 1)
        if user["role"] == "admin" or user["username"] in assigned_users:
            if project not in projects:
                projects[project] = []
            projects[project].append({
                "name": episode,
                "users": assigned_users
            })

    return movie_frontend_or_template(request, "projects.html", {
        "username": user["username"],
        "role": user["role"],
        "projects": [
            {"title": project, "episodes": eps}
            for project, eps in projects.items()
        ]
    })



@pressplay_router.post("/delete_segment")
async def delete_segment(
    request: Request,
    project: str = Form(...),
    episode: str = Form(...),
    segment_index: int = Form(...),
    editor_user_id: str = Form(""),
    editor_session_id: str = Form("")
):
    conflicting_user = get_conflicting_editor(project, episode, editor_user_id, editor_session_id)
    if conflicting_user:
        return JSONResponse(
            status_code=423,
            content={
                "status": "locked",
                "message": f"Episode is being edited by {conflicting_user}. Please wait.",
                "locked_by": conflicting_user,
            },
        )
    episode_lock = get_episode_write_lock(project, episode)
    await episode_lock.acquire()
    try:
        if should_ignore_duplicate_delete(project, episode, segment_index, editor_user_id, editor_session_id):
            return {
                "status": "success",
                "message": "Duplicate delete ignored",
                "deleted_index": segment_index,
                "ignored_duplicate": True,
            }
        print("=== DELETE SEGMENT REQUEST RECEIVED ===")
        print(f"Project: {project}, Episode: {episode}, Segment Index: {segment_index}")

        base_path = os.path.join("subtitles", project, episode)
        en_path = os.path.join(base_path, f"{episode}_en.csv")
        ar_path = os.path.join(base_path, f"{episode}_ar.csv")

        def normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
            df = df.copy()
            df.columns = [str(c).strip().replace("\ufeff", "") for c in df.columns]
            needed = ["Timecode In", "Timecode Out", "Character", "Dialogue"]
            for col in needed:
                if col not in df.columns:
                    df[col] = ""
            return df[needed]

        def ensure_csv(path: str):
            if not os.path.exists(path):
                pd.DataFrame(
                    columns=["Timecode In", "Timecode Out", "Character", "Dialogue"]
                ).to_csv(path, index=False, encoding="utf-8-sig")

        def load_csv(path: str) -> pd.DataFrame:
            ensure_csv(path)
            try:
                df = pd.read_csv(path, encoding="utf-8-sig")
            except pd.errors.EmptyDataError:
                df = pd.DataFrame(columns=["Timecode In", "Timecode Out", "Character", "Dialogue"])
            return normalize_columns(df)

        df_en = load_csv(en_path)
        df_ar = load_csv(ar_path)

        row_count = max(len(df_en), len(df_ar))

        if segment_index < 0 or segment_index >= row_count:
            return {"status": "error", "message": "Invalid segment index"}

        while len(df_en) < row_count:
            df_en.loc[len(df_en)] = ["", "", "Unset", ""]

        while len(df_ar) < row_count:
            df_ar.loc[len(df_ar)] = ["", "", "Unset", ""]

        df_en_new = df_en.drop(index=segment_index).reset_index(drop=True)
        df_ar_new = df_ar.drop(index=segment_index).reset_index(drop=True)

        en_tmp = en_path + ".tmp"
        ar_tmp = ar_path + ".tmp"

        df_en_new.to_csv(en_tmp, index=False, encoding="utf-8-sig")
        df_ar_new.to_csv(ar_tmp, index=False, encoding="utf-8-sig")

        os.replace(en_tmp, en_path)
        os.replace(ar_tmp, ar_path)

        updated_recordings = shift_recordings_meta_for_delete(base_path, segment_index)

        updated_done = shift_done_indexes_for_delete(project, episode, segment_index)

        room = f"{project}/{episode}"
        try:
            await manager.broadcast(room, json.dumps({
                "type": "segments_changed",
                "action": "delete",
                "index": segment_index,
                "timestamp": datetime.utcnow().isoformat()
            }))
        except Exception as ws_error:
            print(f"WebSocket broadcast (delete) failed: {ws_error}")

        print("âœ… Delete done")
        return {
            "status": "success",
            "message": "Segment deleted successfully",
            "deleted_index": segment_index,
            "total_segments": len(df_en_new),
            "recordings_meta_updated": True,
            "recordings_count": len(updated_recordings),
            "done_count": len(updated_done),
        }

    except Exception as e:
        print(f"âŒ Delete failed: {e}")
        print(traceback.format_exc())
        return {"status": "error", "message": str(e)}




    finally:
        if episode_lock.locked():
            episode_lock.release()

@pressplay_router.post("/insert_segment")
async def insert_segment(
    request: Request,
    project: str = Form(...),
    episode: str = Form(...),
    start: float = Form(...),
    end: float = Form(...),
    speaker: str = Form("Unset"),
    english_text: str = Form(""),
    arabic_text: str = Form(""),
    editor_user_id: str = Form(""),
    editor_session_id: str = Form("")
):
    conflicting_user = get_conflicting_editor(project, episode, editor_user_id, editor_session_id)
    if conflicting_user:
        return JSONResponse(
            status_code=423,
            content={
                "status": "locked",
                "message": f"Episode is being edited by {conflicting_user}. Please wait.",
                "locked_by": conflicting_user,
            },
        )
    episode_lock = get_episode_write_lock(project, episode)
    await episode_lock.acquire()
    try:
        print("=== INSERT SEGMENT REQUEST RECEIVED ===")
        print(f"Project: {project}, Episode: {episode}")
        print(f"Start: {start}, End: {end}, Speaker: {speaker}")

        if end <= start:
            return {"status": "error", "message": "End time must be greater than start time"}

        base_path = os.path.join("subtitles", project, episode)
        os.makedirs(base_path, exist_ok=True)

        en_path = os.path.join(base_path, f"{episode}_en.csv")
        ar_path = os.path.join(base_path, f"{episode}_ar.csv")

        def tc(seconds: float) -> str:
            fps = 25
            total_frames = int(round(float(seconds) * fps))
            h = total_frames // (3600 * fps)
            m = (total_frames % (3600 * fps)) // (60 * fps)
            s = (total_frames % (60 * fps)) // fps
            f = total_frames % fps
            return f"{h:02}:{m:02}:{s:02}:{f:02}"

        def normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
            df = df.copy()
            df.columns = [str(c).strip().replace("\ufeff", "") for c in df.columns]
            needed = ["Timecode In", "Timecode Out", "Character", "Dialogue"]
            for col in needed:
                if col not in df.columns:
                    df[col] = ""
            return df[needed]

        def ensure_csv(path: str):
            if not os.path.exists(path):
                pd.DataFrame(
                    columns=["Timecode In", "Timecode Out", "Character", "Dialogue"]
                ).to_csv(path, index=False, encoding="utf-8-sig")

        def load_csv(path: str) -> pd.DataFrame:
            ensure_csv(path)
            try:
                df = pd.read_csv(path, encoding="utf-8-sig")
            except pd.errors.EmptyDataError:
                df = pd.DataFrame(columns=["Timecode In", "Timecode Out", "Character", "Dialogue"])
            return normalize_columns(df)

        # -------------------------
        # Load CSVs only
        # -------------------------
        df_en = load_csv(en_path)
        df_ar = load_csv(ar_path)

        # keep both CSVs aligned by row count
        row_count = max(len(df_en), len(df_ar))

        while len(df_en) < row_count:
            df_en.loc[len(df_en)] = {
                "Timecode In": "",
                "Timecode Out": "",
                "Character": "Unset",
                "Dialogue": "",
            }

        while len(df_ar) < row_count:
            df_ar.loc[len(df_ar)] = {
                "Timecode In": "",
                "Timecode Out": "",
                "Character": "Unset",
                "Dialogue": "",
            }

        clean_speaker = (speaker or "Unset").strip() or "Unset"

        new_en_row = {
            "Timecode In": tc(float(start)),
            "Timecode Out": tc(float(end)),
            "Character": clean_speaker,
            "Dialogue": english_text or "",
        }

        new_ar_row = {
            "Timecode In": tc(float(start)),
            "Timecode Out": tc(float(end)),
            "Character": clean_speaker,
            "Dialogue": arabic_text or "",
        }

        # -------------------------
        # Find insertion point by existing row start time
        # Prefer EN, fallback to AR
        # -------------------------
        insert_index = row_count

        for i in range(row_count):
            existing_start = None

            for df in (df_en, df_ar):
                try:
                    raw_tc = str(df.iloc[i]["Timecode In"]).strip()
                    if raw_tc:
                        existing_start = timecode_to_seconds(raw_tc)
                        break
                except Exception:
                    pass

            if existing_start is None:
                continue

            if float(existing_start) > float(start):
                insert_index = i
                break

        print(f"Inserting at CSV row index {insert_index}")

        # -------------------------
        # Insert into both CSVs
        # -------------------------
        top_en = df_en.iloc[:insert_index]
        bottom_en = df_en.iloc[insert_index:]

        top_ar = df_ar.iloc[:insert_index]
        bottom_ar = df_ar.iloc[insert_index:]

        df_en_new = pd.concat(
            [top_en, pd.DataFrame([new_en_row]), bottom_en],
            ignore_index=True
        )

        df_ar_new = pd.concat(
            [top_ar, pd.DataFrame([new_ar_row]), bottom_ar],
            ignore_index=True
        )

        # atomic writes
        en_tmp = en_path + ".tmp"
        ar_tmp = ar_path + ".tmp"

        df_en_new.to_csv(en_tmp, index=False, encoding="utf-8-sig")
        df_ar_new.to_csv(ar_tmp, index=False, encoding="utf-8-sig")

        os.replace(en_tmp, en_path)
        os.replace(ar_tmp, ar_path)

        updated_recordings = shift_recordings_meta_for_insert(base_path, insert_index)
        updated_done = shift_done_indexes_for_insert(project, episode, insert_index)

        room = f"{project}/{episode}"
        try:
            await manager.broadcast(room, json.dumps({
                "type": "segments_changed",
                "action": "insert",
                "index": insert_index,
                "timestamp": datetime.utcnow().isoformat()
            }))
        except Exception as ws_error:
            print(f"WebSocket broadcast (insert) failed: {ws_error}")

        print(f"âœ… Segment inserted successfully. Total segments: {len(df_en_new)}")
        return {
            "status": "success",
            "message": "Segment inserted successfully",
            "insert_index": insert_index,
            "total_segments": len(df_en_new),
            "recordings_meta_updated": True,
            "recordings_count": len(updated_recordings),
            "done_count": len(updated_done),
        }

    except Exception as e:
        error_msg = f"Unexpected error: {str(e)}"
        print(f"âŒ {error_msg}")
        print(traceback.format_exc())
        return {"status": "error", "message": error_msg}






    finally:
        if episode_lock.locked():
            episode_lock.release()

@pressplay_router.post("/split_segment")
async def split_segment(
    request: Request,
    project: str = Form(...),
    episode: str = Form(...),
    segment_index: int = Form(...),
    split_time: float = Form(...),
    editor_user_id: str = Form(""),
    editor_session_id: str = Form("")
):
    conflicting_user = get_conflicting_editor(project, episode, editor_user_id, editor_session_id)
    if conflicting_user:
        return JSONResponse(
            status_code=423,
            content={
                "status": "locked",
                "message": f"Episode is being edited by {conflicting_user}. Please wait.",
                "locked_by": conflicting_user,
            },
        )
    episode_lock = get_episode_write_lock(project, episode)
    await episode_lock.acquire()
    try:
        print("=== SPLIT SEGMENT REQUEST RECEIVED ===")
        print(f"Project: {project}, Episode: {episode}")
        print(f"Segment Index: {segment_index}, Split Time: {split_time}")

        base_path = os.path.join("subtitles", project, episode)
        en_path = os.path.join(base_path, f"{episode}_en.csv")
        ar_path = os.path.join(base_path, f"{episode}_ar.csv")

        def normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
            df = df.copy()
            df.columns = [str(c).strip().replace("\ufeff", "") for c in df.columns]
            needed = ["Timecode In", "Timecode Out", "Character", "Dialogue"]
            for col in needed:
                if col not in df.columns:
                    df[col] = ""
            return df[needed]

        def ensure_csv(path: str):
            if not os.path.exists(path):
                pd.DataFrame(
                    columns=["Timecode In", "Timecode Out", "Character", "Dialogue"]
                ).to_csv(path, index=False, encoding="utf-8-sig")

        def load_csv(path: str) -> pd.DataFrame:
            ensure_csv(path)
            try:
                df = pd.read_csv(path, encoding="utf-8-sig")
            except pd.errors.EmptyDataError:
                df = pd.DataFrame(columns=["Timecode In", "Timecode Out", "Character", "Dialogue"])
            return normalize_columns(df)

        def tc(seconds: float) -> str:
            fps = 25
            total_frames = int(round(float(seconds) * fps))
            h = total_frames // (3600 * fps)
            m = (total_frames % (3600 * fps)) // (60 * fps)
            s = (total_frames % (60 * fps)) // fps
            f = total_frames % fps
            return f"{h:02}:{m:02}:{s:02}:{f:02}"

        def tc_to_sec(tc_str: str):
            return timecode_to_seconds(str(tc_str).strip())

        # -------------------------
        # Load CSVs
        # -------------------------
        df_en = load_csv(en_path)
        df_ar = load_csv(ar_path)

        row_count = max(len(df_en), len(df_ar))

        if segment_index < 0 or segment_index >= row_count:
            return {"status": "error", "message": "Invalid segment index"}

        # ensure both aligned
        while len(df_en) < row_count:
            df_en.loc[len(df_en)] = ["", "", "Unset", ""]

        while len(df_ar) < row_count:
            df_ar.loc[len(df_ar)] = ["", "", "Unset", ""]

        # -------------------------
        # Get original segment
        # -------------------------
        def safe_tc(value):
            if value is None:
                return None
            if pd.isna(value):
                return None
            s = str(value).strip()
            return s if s else None

        start_tc = safe_tc(df_en.iloc[segment_index]["Timecode In"]) or safe_tc(df_ar.iloc[segment_index]["Timecode In"])
        end_tc = safe_tc(df_en.iloc[segment_index]["Timecode Out"]) or safe_tc(df_ar.iloc[segment_index]["Timecode Out"])

        if not start_tc or not end_tc:
            return {"status": "error", "message": "Missing timecode data for segment"}

        start = tc_to_sec(start_tc)
        end = tc_to_sec(end_tc)

        print(f"Splitting {segment_index}: {start} â†’ {end} at {split_time}")

        if split_time <= start or split_time >= end:
            return {"status": "error", "message": "Split time must be inside segment"}

        # -------------------------
        # Create rows
        # -------------------------
        def split_row(df):
            row = df.iloc[segment_index]

            first = {
                "Timecode In": tc(start),
                "Timecode Out": tc(split_time),
                "Character": row["Character"],
                "Dialogue": row["Dialogue"],
            }

            second = {
                "Timecode In": tc(split_time),
                "Timecode Out": tc(end),
                "Character": row["Character"],
                "Dialogue": row["Dialogue"],
            }

            return first, second

        en_first, en_second = split_row(df_en)
        ar_first, ar_second = split_row(df_ar)

        # -------------------------
        # Apply split
        # -------------------------
        def apply_split(df, first, second):
            top = df.iloc[:segment_index]
            bottom = df.iloc[segment_index + 1:]

            return pd.concat(
                [top, pd.DataFrame([first, second]), bottom],
                ignore_index=True
            )

        df_en_new = apply_split(df_en, en_first, en_second)
        df_ar_new = apply_split(df_ar, ar_first, ar_second)

        # -------------------------
        # Save
        # -------------------------
        en_tmp = en_path + ".tmp"
        ar_tmp = ar_path + ".tmp"

        df_en_new.to_csv(en_tmp, index=False, encoding="utf-8-sig")
        df_ar_new.to_csv(ar_tmp, index=False, encoding="utf-8-sig")

        os.replace(en_tmp, en_path)
        os.replace(ar_tmp, ar_path)

        # -------------------------
        # Fix recordings
        # -------------------------
        updated_recordings = shift_recordings_meta_for_split(base_path, segment_index)
        updated_done = shift_done_indexes_for_split(project, episode, segment_index)

        room = f"{project}/{episode}"
        try:
            await manager.broadcast(room, json.dumps({
                "type": "segments_changed",
                "action": "split",
                "index": segment_index,
                "timestamp": datetime.utcnow().isoformat()
            }))
        except Exception as ws_error:
            print(f"WebSocket broadcast (split) failed: {ws_error}")

        print("âœ… Split done")
        return {
            "status": "success",
            "message": "Segment split successfully",
            "recordings_meta_updated": True,
            "recordings_count": len(updated_recordings),
            "done_count": len(updated_done),
        }

    except Exception as e:
        print(f"âŒ Split failed: {e}")
        print(traceback.format_exc())
        return {"status": "error", "message": str(e)}
        
    


    finally:
        if episode_lock.locked():
            episode_lock.release()

def safe_filename_part(value: str) -> str:
    value = (value or "voice").strip()
    value = re.sub(r"[^\w\-]+", "_", value, flags=re.UNICODE)
    return value[:80] or "voice"


def upsert_recording_meta(meta_path: str, new_recording: dict):
    recordings_meta = []

    if os.path.exists(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                recordings_meta = json.load(f)
        except Exception:
            recordings_meta = []

    def _idx(v):
        try:
            return int(v)
        except Exception:
            return None

    new_index = _idx(new_recording.get("index"))
    prev_same_index = None
    same_index_tts_files = []
    for r in recordings_meta:
        if _idx(r.get("index")) == new_index:
            if prev_same_index is None:
                prev_same_index = r
            if str(r.get("source", "")).lower() == "tts":
                rf = str(r.get("file") or "").strip()
                if rf:
                    same_index_tts_files.append(rf)

    # Keep last 3 generated TTS waves per segment index.
    if str(new_recording.get("source", "")).lower() == "tts":
        history = []
        current_file = str(new_recording.get("file") or "").strip()
        if current_file:
            history.append(current_file)
        if isinstance(prev_same_index, dict):
            prev_file = str(prev_same_index.get("file") or "").strip()
            if prev_file:
                history.append(prev_file)
            prev_hist = prev_same_index.get("recent_waves")
            if isinstance(prev_hist, list):
                for f in prev_hist:
                    fs = str(f or "").strip()
                    if fs:
                        history.append(fs)
        # Safety: reconstruct from existing files on disk for this segment index.
        rec_dir = os.path.dirname(meta_path)
        if os.path.isdir(rec_dir) and new_index is not None:
            tts_candidates = []
            pat = re.compile(rf"^{re.escape(str(new_index))}_.+_tts(?:_|\.wav)", re.IGNORECASE)
            try:
                for fn in os.listdir(rec_dir):
                    if not pat.search(fn):
                        continue
                    fp = os.path.join(rec_dir, fn)
                    if not os.path.isfile(fp):
                        continue
                    try:
                        mt = os.path.getmtime(fp)
                    except Exception:
                        mt = 0.0
                    tts_candidates.append((mt, fn))
            except Exception:
                tts_candidates = []
            # newest first
            tts_candidates.sort(key=lambda x: x[0], reverse=True)
            for _, fn in tts_candidates[:6]:
                history.append(fn)
        dedup = []
        for f in history:
            if f and f not in dedup:
                dedup.append(f)
        new_recording["recent_waves"] = dedup[:3]

    recordings_meta = [r for r in recordings_meta if _idx(r.get("index")) != new_index]
    recordings_meta.append(new_recording)

    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(recordings_meta, f, ensure_ascii=False, indent=2)

    # Cleanup: for TTS entries, keep only the last 3 files for this segment index.
    if str(new_recording.get("source", "")).lower() == "tts":
        keep = set(new_recording.get("recent_waves") or [])
        rec_dir = os.path.dirname(meta_path)
        for old_file in same_index_tts_files:
            if old_file in keep:
                continue
            old_path = os.path.join(rec_dir, old_file)
            if os.path.isfile(old_path):
                try:
                    os.remove(old_path)
                except Exception:
                    pass


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
        print("âš ï¸ Could not read audio duration via ffprobe:", repr(e))

    return 0.0


def get_wav_rms(file_path: str) -> float:
    """
    Returns RMS amplitude for WAV PCM. Returns 0.0 on failure.
    """
    try:
        with wave.open(file_path, "rb") as wf:
            frames = wf.readframes(wf.getnframes())
            sw = int(wf.getsampwidth())
            ch = int(wf.getnchannels())
            if not frames:
                return 0.0
            if sw == 2:
                arr = np.frombuffer(frames, dtype=np.int16).astype(np.float32)
                if ch > 1:
                    arr = arr.reshape(-1, ch).mean(axis=1)
                return float(np.sqrt(np.mean(np.square(arr))))
            if sw == 1:
                arr = np.frombuffer(frames, dtype=np.uint8).astype(np.float32) - 128.0
                if ch > 1:
                    arr = arr.reshape(-1, ch).mean(axis=1)
                return float(np.sqrt(np.mean(np.square(arr))))
    except Exception:
        return 0.0
    return 0.0


OUTPUT_WAV_SAMPLE_RATE = 48000
OUTPUT_WAV_CHANNELS = 1
OUTPUT_WAV_CODEC = "pcm_s24le"
OUTPUT_WAV_BIT_DEPTH = 24
TTS_FADE_OUT_MIN_SEC = 0.03
TTS_FADE_OUT_MAX_SEC = 0.12
TTS_FADE_OUT_RATIO = 0.18


def get_wav_format_info(file_path: str) -> Dict[str, Any]:
    """
    Read WAV format info. Uses ffprobe first (more reliable for 24-bit PCM),
    then falls back to Python wave.
    """
    info: Dict[str, Any] = {
        "sample_rate": 0,
        "bit_depth": 0,
        "channels": 0,
        "codec_name": "",
        "sample_fmt": "",
    }
    try:
        probe_cmd = [
            "ffprobe",
            "-v", "error",
            "-select_streams", "a:0",
            "-show_entries", "stream=sample_rate,channels,bits_per_sample,bits_per_raw_sample,codec_name,sample_fmt",
            "-of", "json",
            file_path,
        ]
        result = subprocess.run(
            probe_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
        if result.returncode == 0 and (result.stdout or "").strip():
            payload = json.loads(result.stdout or "{}")
            streams = payload.get("streams") or []
            if streams:
                s0 = streams[0] or {}
                info["sample_rate"] = int(float(s0.get("sample_rate") or 0))
                info["channels"] = int(s0.get("channels") or 0)
                info["codec_name"] = str(s0.get("codec_name") or "")
                info["sample_fmt"] = str(s0.get("sample_fmt") or "")
                bits_raw = int(s0.get("bits_per_raw_sample") or 0)
                bits_sample = int(s0.get("bits_per_sample") or 0)
                bit_depth = bits_raw or bits_sample
                if bit_depth <= 0:
                    sf = info["sample_fmt"].lower()
                    if sf == "s16":
                        bit_depth = 16
                    elif sf == "s24":
                        bit_depth = 24
                    elif sf == "s32":
                        bit_depth = 32
                if bit_depth <= 0 and info["codec_name"].lower() == "pcm_s24le":
                    bit_depth = 24
                info["bit_depth"] = int(bit_depth or 0)
                return info
    except Exception:
        pass

    try:
        with wave.open(file_path, "rb") as wf:
            info["sample_rate"] = int(wf.getframerate())
            info["channels"] = int(wf.getnchannels())
            info["bit_depth"] = int(wf.getsampwidth()) * 8
    except Exception:
        pass
    return info


def normalize_generated_wav_spec(
    file_path: str,
    sample_rate: int = OUTPUT_WAV_SAMPLE_RATE,
    channels: int = OUTPUT_WAV_CHANNELS,
    codec: str = OUTPUT_WAV_CODEC,
) -> Dict[str, int]:
    """
    Force WAV output spec for generated files (TTS/VC), then verify.
    """
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_out:
        tmp_path = tmp_out.name
    try:
        cmd = [
            "ffmpeg",
            "-y",
            "-i", file_path,
            "-ac", str(int(channels)),
            "-ar", str(int(sample_rate)),
            "-c:a", str(codec),
            tmp_path,
        ]
        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
        if result.returncode != 0 or not os.path.exists(tmp_path) or os.path.getsize(tmp_path) == 0:
            raise Exception(f"ffmpeg wav normalization failed: {result.stderr}")

        shutil.move(tmp_path, file_path)
        info = get_wav_format_info(file_path)
        sr = int(info.get("sample_rate", 0) or 0)
        ch = int(info.get("channels", 0) or 0)
        bd = int(info.get("bit_depth", 0) or 0)
        codec_name = str(info.get("codec_name", "") or "").lower()

        # Only fail on confirmed mismatch. Unknown probe values should not block TTS.
        if sr > 0 and sr != int(sample_rate):
            raise Exception(f"normalized wav spec mismatch (sample_rate): got {info}")
        if ch > 0 and ch != int(channels):
            raise Exception(f"normalized wav spec mismatch (channels): got {info}")
        if bd > 0 and bd != OUTPUT_WAV_BIT_DEPTH and codec_name != "pcm_s24le":
            raise Exception(f"normalized wav spec mismatch (bit_depth): got {info}")

        if sr == 0 or ch == 0 or (bd == 0 and codec_name != "pcm_s24le"):
            print(f"⚠️ WAV spec probe ambiguous, continuing with expected spec: {info}")

        return {
            "sample_rate": sr if sr > 0 else int(sample_rate),
            "bit_depth": bd if bd > 0 else int(OUTPUT_WAV_BIT_DEPTH),
            "channels": ch if ch > 0 else int(channels),
        }
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass


def build_atempo_filter_chain(tempo: float) -> str:
    """
    Build ffmpeg atempo chain for any positive tempo ratio.
    Each atempo instance supports 0.5..2.0.
    """
    t = max(0.01, float(tempo))
    parts: List[str] = []
    while t < 0.5:
        parts.append("atempo=0.5")
        t /= 0.5
    while t > 2.0:
        parts.append("atempo=2.0")
        t /= 2.0
    parts.append(f"atempo={t:.6f}")
    return ",".join(parts)


def classify_fit(delta: float) -> str:
    abs_delta = abs(delta)

    if abs_delta <= 0.15:
        return "good"
    elif abs_delta <= 0.40:
        return "warning"
    return "bad"


def fit_label(delta: float) -> str:
    abs_delta = abs(delta)

    if abs_delta <= 0.15:
        return "Fits well"
    elif delta > 0:
        return f"Too long by {abs_delta:.2f}s"
    else:
        return f"Too short by {abs_delta:.2f}s"

@pressplay_router.post("/upload_audio")
async def upload_audio(
    project: str = Form(...),
    episode: str = Form(...),
    index: int = Form(...),
    speaker: str = Form(...),
    start: float = Form(...),
    end: float = Form(...),
    pre_roll_sec: float = Form(0.0),
    post_roll_sec: float = Form(0.0),
    file: UploadFile = File(...)
):
    path = os.path.join("subtitles", project, episode, "recordings")
    os.makedirs(path, exist_ok=True)

    safe_speaker = safe_filename_part(speaker)
    filename = f"{index}_{safe_speaker}_{int(start * 1000)}.wav"
    file_path = os.path.join(path, filename)

    with open(file_path, "wb") as f:
        f.write(await file.read())

    meta_path = os.path.join(path, "recordings_meta.json")
    new_recording = {
        "index": index,
        "speaker": speaker,
        "start": start,
        "end": end,
        "duration": float(end - start),
        "pre_roll_sec": max(0.0, float(pre_roll_sec or 0.0)),
        "post_roll_sec": max(0.0, float(post_roll_sec or 0.0)),
        "file": filename,
        "source": "mic",
    }
    upsert_recording_meta(meta_path, new_recording)

    return JSONResponse({
        "status": "ok",
        "file": filename,
        "index": index,
        "speaker": speaker,
        "start": start,
        "end": end,
        "pre_roll_sec": max(0.0, float(pre_roll_sec or 0.0)),
        "post_roll_sec": max(0.0, float(post_roll_sec or 0.0)),
        "source": "mic",
    })

def load_episode_segments_for_tts(project: str, episode: str) -> List[Dict[str, Any]]:
    base_path = os.path.join("subtitles", project, episode)
    en_path = os.path.join(base_path, f"{episode}_en.csv")
    ar_path = os.path.join(base_path, f"{episode}_ar.csv")

    if not os.path.exists(en_path) and not os.path.exists(ar_path):
        raise FileNotFoundError(f"No subtitle CSV files found for {project}/{episode}")

    def normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
        df = df.copy()
        df.columns = [str(c).strip().replace("\ufeff", "") for c in df.columns]
        needed = ["Timecode In", "Timecode Out", "Character", "Dialogue"]
        for col in needed:
            if col not in df.columns:
                df[col] = ""
        return df[needed]

    # Auto-create paired CSV
    if os.path.exists(en_path) and not os.path.exists(ar_path):
        df = pd.read_csv(en_path, encoding="utf-8-sig")
        df = normalize_columns(df)
        df_out = df[["Timecode In", "Timecode Out", "Character"]].copy()
        df_out["Dialogue"] = ""
        df_out.to_csv(ar_path, index=False, encoding="utf-8-sig")
    elif os.path.exists(ar_path) and not os.path.exists(en_path):
        df = pd.read_csv(ar_path, encoding="utf-8-sig")
        df = normalize_columns(df)
        df_out = df[["Timecode In", "Timecode Out", "Character"]].copy()
        df_out["Dialogue"] = ""
        df_out.to_csv(en_path, index=False, encoding="utf-8-sig")

    df_en = normalize_columns(pd.read_csv(en_path, encoding="utf-8-sig")) if os.path.exists(en_path) else None
    df_ar = normalize_columns(pd.read_csv(ar_path, encoding="utf-8-sig")) if os.path.exists(ar_path) else None

    if df_en is not None:
        df_en["start"] = df_en["Timecode In"].astype(str).apply(timecode_to_seconds)
        df_en["end"] = df_en["Timecode Out"].astype(str).apply(timecode_to_seconds)
        df_en["speaker"] = df_en["Character"].fillna("Unset").replace("", "Unset").astype(str)
        df_en["text"] = df_en["Dialogue"].fillna("").astype(str).str.replace("\n", " ", regex=False)

    if df_ar is not None:
        df_ar["start"] = df_ar["Timecode In"].astype(str).apply(timecode_to_seconds)
        df_ar["end"] = df_ar["Timecode Out"].astype(str).apply(timecode_to_seconds)
        df_ar["speaker"] = df_ar["Character"].fillna("Unset").replace("", "Unset").astype(str)
        df_ar["text"] = df_ar["Dialogue"].fillna("").astype(str).str.replace("\n", " ", regex=False)

    if df_en is not None and df_ar is not None:
        for i in range(max(len(df_en), len(df_ar))):
            spk_en = str(df_en.at[i, "speaker"]) if i < len(df_en) else ""
            spk_ar = str(df_ar.at[i, "speaker"]) if i < len(df_ar) else ""

            spk_en = spk_en.strip()
            spk_ar = spk_ar.strip()

            if spk_en and spk_en.lower() != "unset":
                chosen = spk_en
            elif spk_ar and spk_ar.lower() != "unset":
                chosen = spk_ar
            else:
                chosen = "Unset"

            if i < len(df_en):
                df_en.at[i, "speaker"] = chosen
            if i < len(df_ar):
                df_ar.at[i, "speaker"] = chosen

    segments: List[Dict[str, Any]] = []
    length = max(len(df_en) if df_en is not None else 0, len(df_ar) if df_ar is not None else 0)
    done_indexes = load_done_segment_indexes(project, episode)

    for i in range(length):
        en_row = df_en.iloc[i] if df_en is not None and i < len(df_en) else None
        ar_row = df_ar.iloc[i] if df_ar is not None and i < len(df_ar) else None

        start = float(en_row["start"] if en_row is not None else ar_row["start"])
        end = float(en_row["end"] if en_row is not None else ar_row["end"])

        speaker = (
            str(en_row["speaker"]).strip() if en_row is not None and str(en_row["speaker"]).strip()
            else str(ar_row["speaker"]).strip() if ar_row is not None and str(ar_row["speaker"]).strip()
            else "Unset"
        )

        text_ar = str(ar_row["text"]).strip() if ar_row is not None else ""
        text_en = str(en_row["text"]).strip() if en_row is not None else ""
        # For TTS generation we prefer EN, then fallback to AR if EN is empty.
        text = text_en or text_ar

        segments.append({
            "index": i,
            "speaker": speaker,
            "start": start,
            "end": end,
            "text": text,
            "text_ar": text_ar,
            "text_en": text_en,
            "is_done": i in done_indexes,
        })

    return segments


def load_recordings_meta(project: str, episode: str) -> List[Dict[str, Any]]:
    meta_path = os.path.join("subtitles", project, episode, "recordings", "recordings_meta.json")
    return load_recordings_meta_from_path(meta_path)


async def generate_tts_segment_internal(
    project: str,
    episode: str,
    index: int,
    speaker: str,
    start: float,
    end: float,
    text: str,
    voice: str = "en-US-RogerNeural",
    rate: str = "+0%",
    use_emotion_control: str = "false",
    emotion_preset: str = "neutral",
    emo_alpha: float = 1.0,
    emotion_mix: float = 0.65,
    use_emo_text_prompt: bool = True,
    effect_style: str = "none",
    effect_strength: float = 0.0,
    effect_position: str = "auto",
):
    """
    Internal shared implementation for one segment.
    Returns the same JSON payload shape as /tts_segment.
    Raises HTTPException/Exception on failure.
    """
    use_emotion = str(use_emotion_control).lower() == "true"

    # Speech effects are text-driven now (typed directly by the user), so disable auto insertion.
    effective_effect_style = "none"
    effective_effect_strength = 0.0
    effective_effect_position = "auto"

    raw_text = str(text or "").strip()
    emoji_meta = apply_emoji_annotations_for_tts(raw_text)
    emoji_text = str(emoji_meta.get("text") or "").strip()
    has_any_annotations = bool(emoji_meta.get("has_annotations"))
    has_emoji_annotations = bool(emoji_meta.get("has_emoji"))
    has_tag_annotations = bool(emoji_meta.get("has_tags"))

    # Tag-only mode: auto emotion applies only for explicit {emotion} tags.
    effective_use_emotion = bool(use_emotion or has_tag_annotations)
    effective_emotion_preset = str(emotion_preset or "neutral").strip().lower() or "neutral"
    effective_emotion_mix = max(0.0, min(1.0, float(emotion_mix)))
    auto_annotation_preset = str(emoji_meta.get("auto_preset") or "").strip().lower()
    if has_tag_annotations and auto_annotation_preset:
        if (not use_emotion) or effective_emotion_preset in {"neutral", ""}:
            effective_emotion_preset = auto_annotation_preset
        effective_emotion_mix = max(effective_emotion_mix, float(emoji_meta.get("suggested_mix", 0.65)))
    # In explicit tag mode ({sad}, {happy}, ...), keep emotion clearly audible.
    if has_tag_annotations:
        effective_emotion_mix = max(effective_emotion_mix, 0.72)
    # Tag-only annotation (e.g. {crying}) should keep pacing stable but with stronger emotion.
    if has_tag_annotations and not has_emoji_annotations and (not use_emotion):
        effective_emotion_mix = min(effective_emotion_mix, 0.50)
    if effective_emotion_preset not in EMOTION_PRESETS:
        effective_emotion_preset = "neutral"

    source_text_for_tts = emoji_text or raw_text

    if effective_use_emotion:
        # For tag-based emotion, keep default text normalization so pacing matches non-emotion mode.
        if has_tag_annotations and not has_emoji_annotations:
            text_tts = sanitize_text_for_index_tts2(source_text_for_tts)
        else:
            # For emoji/manual expressive text, preserve user pause punctuation.
            text_tts = source_text_for_tts.strip()
    else:
        text_tts = apply_indextts2_speech_effects(
            text=sanitize_text_for_index_tts2(source_text_for_tts),
            effect_style=effective_effect_style,
            effect_strength=effective_effect_strength,
            effect_position=effective_effect_position,
            index_hint=index,
        )

    if not text_tts:
        raise HTTPException(status_code=400, detail="No text provided for TTS.")

    if end <= start:
        raise HTTPException(status_code=400, detail="Invalid segment timing.")

    path = os.path.join("subtitles", project, episode, "recordings")
    os.makedirs(path, exist_ok=True)

    safe_speaker = safe_filename_part(speaker)
    def tc_compact(seconds: float):
        fps = 25
        total_frames = int(round(seconds * fps))
        h = total_frames // (3600 * fps)
        m = (total_frames % (3600 * fps)) // (60 * fps)
        s = (total_frames % (60 * fps)) // fps
        f = total_frames % fps
        return f"{h:02}{m:02}{s:02}{f:02}"

    gen_id = datetime.utcnow().strftime("%Y%m%d%H%M%S%f")[:-3]
    filename = f"{index}_{safe_speaker}_{tc_compact(start)}_tts_{gen_id}.wav"
    file_path = os.path.join(path, filename)

    tts_server_urls = get_tts_server_urls()

    try:
        rate_num = float(str(rate).replace("%", "").replace("+", "").strip())
    except Exception:
        rate_num = 0.0

    speed = max(0.7, min(1.3, 1.0 + (rate_num / 100.0) * 0.35))

    video_path = os.path.join("subtitles", project, episode, f"{episode}.mp4")
    if not os.path.exists(video_path):
        raise HTTPException(status_code=404, detail=f"Video file not found: {video_path}")

    temp_prompt_wav = None
    temp_prompt_wav_trim = None

    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            temp_prompt_wav = tmp.name

        # exact segment only (no pre-roll/post-roll)
        emo_start = max(0.0, float(start))
        emo_duration = max(0.1, float(end) - float(start))
        target_length_ms = max(100, int(round((float(end) - float(start)) * 1000)))

        ffmpeg_cmd = [
            "ffmpeg",
            "-y",
            "-ss", str(emo_start),
            "-i", video_path,
            "-t", str(emo_duration),
            "-vn",
            "-ac", "1",
            "-ar", "24000",
            "-c:a", "pcm_s16le",
            temp_prompt_wav,
        ]

        ffmpeg_result = subprocess.run(
            ffmpeg_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )

        if ffmpeg_result.returncode != 0:
            raise Exception(f"ffmpeg failed: {ffmpeg_result.stderr}")

        if not os.path.exists(temp_prompt_wav) or os.path.getsize(temp_prompt_wav) == 0:
            raise Exception("Failed to extract emotion prompt audio from video")

        # Trim leading/trailing silence from emotion reference to avoid
        # "silent emotion" when subtitle timing contains large gaps.
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_trim:
            temp_prompt_wav_trim = tmp_trim.name
        trim_cmd = [
            "ffmpeg",
            "-y",
            "-i", temp_prompt_wav,
            "-af", "silenceremove=start_periods=1:start_silence=0.08:start_threshold=-42dB:stop_periods=1:stop_silence=0.12:stop_threshold=-42dB",
            "-ac", "1",
            "-ar", "24000",
            "-c:a", "pcm_s16le",
            temp_prompt_wav_trim,
        ]
        trim_result = subprocess.run(
            trim_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
        if trim_result.returncode == 0 and os.path.exists(temp_prompt_wav_trim) and os.path.getsize(temp_prompt_wav_trim) > 0:
            trimmed_duration = get_audio_duration(temp_prompt_wav_trim)
            if trimmed_duration >= 0.2:
                prompt_wav_for_emotion = temp_prompt_wav_trim
            else:
                prompt_wav_for_emotion = temp_prompt_wav
        else:
            prompt_wav_for_emotion = temp_prompt_wav

        prompt_wav_for_prosody = temp_prompt_wav
        emo_rms = get_wav_rms(prompt_wav_for_emotion)
        emo_duration = get_audio_duration(prompt_wav_for_emotion)
        emotion_ref_too_quiet = (emo_duration < 0.25) or (emo_rms < 120.0)

        emotion_applied = False
        emotion_use_audio_prompt = False
        emotion_payload: Dict[str, str] = {}
        # Keep prompt audio influence stable so pauses/prosody remain anchored.
        effective_emo_alpha = max(0.15, min(1.6, float(emo_alpha)))
        if NATURAL_EMOTION_MODE:
            effective_emo_alpha = min(effective_emo_alpha, NATURAL_MAX_EMO_ALPHA)
        if effective_use_emotion:
            emotion_applied = True
            emotion_use_audio_prompt = not emotion_ref_too_quiet
            # Tag-based control should not inject extra pauses from reference-audio prosody.
            if has_tag_annotations:
                emotion_use_audio_prompt = False
            preset_key = str(effective_emotion_preset).strip().lower()
            base_vec = EMOTION_PRESETS["neutral"]
            preset_vec = EMOTION_PRESETS.get(preset_key, base_vec)
            mix = max(0.0, min(1.0, float(effective_emotion_mix)))
            if preset_key in {"whisper", "tender"}:
                mix = max(0.42, min(0.78, mix * 1.1))
            if NATURAL_EMOTION_MODE and (not has_tag_annotations):
                mix_cap = float(NATURAL_MAX_MIX_BY_PRESET.get(preset_key, 0.34))
                mix = min(mix, mix_cap)
            emo_vector = blend_emotion_vectors(base_vec, preset_vec, mix)
            emotion_payload["emo_vector"] = json.dumps(emo_vector)
            emo_text = None
            if has_tag_annotations:
                # Explicit tag mode should still leverage text emotion cues.
                emo_text = EMOTION_TEXT_PROMPTS.get(preset_key)
            else:
                if NATURAL_EMOTION_MODE:
                    emo_text = EMOTION_TEXT_PROMPTS.get(preset_key) if preset_key in {"whisper", "tender"} else None
                else:
                    emo_text = EMOTION_TEXT_PROMPTS.get(preset_key) if preset_key in {"whisper", "tender", "sad", "cry"} else None
            if emo_text and bool(use_emo_text_prompt):
                emotion_payload["use_emo_text"] = "true"
                emotion_payload["emo_text"] = emo_text
            print(
                f"emo_vector mixed preset={preset_key} mix={mix:.2f} "
                f"alpha={effective_emo_alpha:.2f} emo_text={'yes' if (emo_text and bool(use_emo_text_prompt)) else 'no'} "
                f"annotation_mode={'on' if has_any_annotations else 'off'} "
                f"emo_audio_prompt={'on' if emotion_use_audio_prompt else 'off'}"
            )
        else:
            print(f"default prompt-based emotion alpha={effective_emo_alpha}")

        target_sec = max(0.1, target_length_ms / 1000.0)
        trial_speed = float(speed)
        best_audio: Optional[bytes] = None
        best_duration = 0.0
        best_speed = trial_speed
        best_err = 9999.0

        async with httpx.AsyncClient(timeout=TTS_SERVER_TIMEOUT_SEC) as client:
            for _ in range(3):
                r: Optional[httpx.Response] = None
                last_err = ""
                for tts_url in tts_server_urls:
                    try:
                        with open(prompt_wav_for_prosody, "rb") as f_prompt:
                            files = {
                                "prompt_wav": ("prompt.wav", f_prompt, "audio/wav"),
                            }
                            data = {
                                "text": text_tts,
                                "speaker": speaker,
                                "speed": str(round(trial_speed, 5)),
                                "emo_alpha": str(effective_emo_alpha),
                                "target_length_ms": str(target_length_ms),
                            }
                            if emotion_applied:
                                data.update(emotion_payload)
                            if emotion_use_audio_prompt:
                                with open(prompt_wav_for_emotion, "rb") as f_emo:
                                    files["emo_audio_prompt"] = ("emo_prompt.wav", f_emo, "audio/wav")
                                    r = await client.post(tts_url, files=files, data=data)
                            else:
                                r = await client.post(tts_url, files=files, data=data)
                        if r.status_code == 200:
                            break
                        body = (r.text or "").strip().replace("\n", " ")
                        last_err = f"{tts_url} -> HTTP {r.status_code}: {body[:220]}"
                    except Exception as e:
                        last_err = f"{tts_url} -> {e}"
                        continue

                if r is None or r.status_code != 200:
                    raise Exception(f"TTS server unavailable across endpoints: {last_err or 'no reachable endpoint'}")

                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_out:
                    temp_out = tmp_out.name
                try:
                    with open(temp_out, "wb") as out_tmp:
                        out_tmp.write(r.content)
                    trial_duration = get_audio_duration(temp_out)
                    # For tag-based control, ignore leading silence when adapting speed.
                    if has_tag_annotations and trial_duration > 0.0:
                        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_probe:
                            temp_probe = tmp_probe.name
                        try:
                            probe_cmd = [
                                "ffmpeg",
                                "-y",
                                "-i", temp_out,
                                "-af", "silenceremove=start_periods=1:start_silence=0.03:start_threshold=-45dB",
                                "-ac", "1",
                                "-ar", "24000",
                                "-c:a", "pcm_s16le",
                                temp_probe,
                            ]
                            probe_result = subprocess.run(
                                probe_cmd,
                                stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE,
                                text=True,
                                check=False,
                            )
                            if probe_result.returncode == 0 and os.path.exists(temp_probe) and os.path.getsize(temp_probe) > 0:
                                trimmed_duration = get_audio_duration(temp_probe)
                                if trimmed_duration > 0.0:
                                    trial_duration = trimmed_duration
                        finally:
                            if os.path.exists(temp_probe):
                                try:
                                    os.remove(temp_probe)
                                except Exception:
                                    pass
                finally:
                    try:
                        os.remove(temp_out)
                    except Exception:
                        pass

                err = abs(float(trial_duration) - float(target_sec))
                if err < best_err:
                    best_err = err
                    best_audio = r.content
                    best_duration = float(trial_duration)
                    best_speed = float(trial_speed)

                if err <= 0.12 or trial_duration <= 0.05:
                    break

                ratio = float(trial_duration) / float(target_sec)
                desired_speed = max(0.65, min(1.55, float(trial_speed) * ratio))
                trial_speed = float(trial_speed) + (desired_speed - float(trial_speed)) * 0.75

        if best_audio is None:
            raise Exception("TTS synthesis returned no audio")

        with open(file_path, "wb") as out:
            out.write(best_audio)

        used_speed = float(best_speed)
        tts_duration = float(best_duration) if best_duration > 0 else get_audio_duration(file_path)
        segment_duration = round(float(end - start), 3)

        # Final hard duration lock:
        # 1) remove leading silence, 2) retime, 3) pad/trim to exact segment duration.
        if tts_duration > 0 and segment_duration > 0:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_nosil:
                temp_nosil = tmp_nosil.name
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_fit:
                temp_fit = tmp_fit.name
            try:
                nosil_cmd = [
                    "ffmpeg",
                    "-y",
                    "-i", file_path,
                    "-af", "silenceremove=start_periods=1:start_silence=0.03:start_threshold=-45dB",
                    "-ac", "1",
                    "-ar", "24000",
                    "-c:a", "pcm_s16le",
                    temp_nosil,
                ]
                nosil_result = subprocess.run(
                    nosil_cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    check=False,
                )
                source_for_fit = temp_nosil if (nosil_result.returncode == 0 and os.path.exists(temp_nosil) and os.path.getsize(temp_nosil) > 0) else file_path
                source_duration = get_audio_duration(source_for_fit)
                if source_duration <= 0:
                    source_duration = tts_duration

                tempo_ratio = float(source_duration) / float(segment_duration)
                atempo_filter = build_atempo_filter_chain(tempo_ratio)
                fade_dur = max(
                    TTS_FADE_OUT_MIN_SEC,
                    min(TTS_FADE_OUT_MAX_SEC, float(segment_duration) * TTS_FADE_OUT_RATIO),
                )
                fade_dur = min(fade_dur, max(0.0, float(segment_duration) - 0.01))
                fade_start = max(0.0, float(segment_duration) - fade_dur)
                final_filter = (
                    f"{atempo_filter},"
                    f"apad=pad_dur={segment_duration:.3f},"
                    f"atrim=0:{segment_duration:.3f},"
                    f"afade=t=out:st={fade_start:.3f}:d={fade_dur:.3f}"
                )
                fit_cmd = [
                    "ffmpeg",
                    "-y",
                    "-i", source_for_fit,
                    "-af", final_filter,
                    "-ac", "1",
                    "-ar", "24000",
                    "-c:a", "pcm_s16le",
                    temp_fit,
                ]
                fit_result = subprocess.run(
                    fit_cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    check=False,
                )
                if fit_result.returncode == 0 and os.path.exists(temp_fit) and os.path.getsize(temp_fit) > 0:
                    shutil.move(temp_fit, file_path)
                    tts_duration = get_audio_duration(file_path)
            finally:
                if os.path.exists(temp_nosil):
                    try:
                        os.remove(temp_nosil)
                    except Exception:
                        pass
                if os.path.exists(temp_fit):
                    try:
                        os.remove(temp_fit)
                    except Exception:
                        pass

        wav_info = normalize_generated_wav_spec(file_path)
        tts_duration = get_audio_duration(file_path)
        delta = round(tts_duration - segment_duration, 3)
        fit_status = classify_fit(delta)
        fit_text = fit_label(delta)

        meta_path = os.path.join(path, "recordings_meta.json")
        new_recording = {
            "index": index,
            "speaker": speaker,
            "start": start,
            "end": end,
            "duration": tts_duration if tts_duration > 0 else segment_duration,
            "file": filename,
            "source": "tts",
            "voice": "IndexTTS2/auto",
            "rate": rate,
            "speed": used_speed,
            "target_length_ms": target_length_ms,
            "emo_start": round(emo_start, 3),
            "emo_duration": round(emo_duration, 3),
            "tts_duration": tts_duration,
            "segment_duration": segment_duration,
            "delta": delta,
            "fit_status": fit_status,
            "fit_text": fit_text,
            "use_emotion_control": str(emotion_applied).lower(),
            "emotion_preset": effective_emotion_preset,
            "emo_alpha": float(emo_alpha),
            "emo_alpha_effective": float(effective_emo_alpha),
            "emotion_mix": float(effective_emotion_mix),
            "use_emo_text_prompt": bool(use_emo_text_prompt),
            "effect_style": effective_effect_style,
            "effect_strength": float(effective_effect_strength),
            "effect_position": effective_effect_position,
            "text_tts": text_tts,
            "emoji_annotations": bool(has_emoji_annotations),
            "tag_annotations": bool(has_tag_annotations),
            "emoji_auto_preset": auto_annotation_preset or "",
            "emoji_scores": emoji_meta.get("scores", {}),
            "annotation_tags": emoji_meta.get("tags", []),
            "emotion_ref_too_quiet": bool(emotion_ref_too_quiet),
            "emotion_ref_rms": round(float(emo_rms), 2),
            "emotion_applied": bool(emotion_applied),
            "wav_sample_rate": int(wav_info.get("sample_rate", 0)),
            "wav_bit_depth": int(wav_info.get("bit_depth", 0)),
            "wav_channels": int(wav_info.get("channels", 0)),
        }
        upsert_recording_meta(meta_path, new_recording)

        return {
            "status": "ok",
            "file": filename,
            "index": index,
            "speaker": speaker,
            "start": start,
            "end": end,
            "source": "tts",
            "voice": "IndexTTS2/auto",
            "rate": rate,
            "speed": used_speed,
            "target_length_ms": target_length_ms,
            "emo_start": round(emo_start, 3),
            "emo_duration": round(emo_duration, 3),
            "tts_duration": tts_duration,
            "segment_duration": segment_duration,
            "delta": delta,
            "fit_status": fit_status,
            "fit_text": fit_text,
            "use_emotion_control": str(emotion_applied).lower(),
            "emotion_preset": effective_emotion_preset,
            "emo_alpha": float(emo_alpha),
            "emo_alpha_effective": float(effective_emo_alpha),
            "emotion_mix": float(effective_emotion_mix),
            "use_emo_text_prompt": bool(use_emo_text_prompt),
            "effect_style": effective_effect_style,
            "effect_strength": float(effective_effect_strength),
            "effect_position": effective_effect_position,
            "text_tts": text_tts,
            "emoji_annotations": bool(has_emoji_annotations),
            "tag_annotations": bool(has_tag_annotations),
            "emoji_auto_preset": auto_annotation_preset or "",
            "emoji_scores": emoji_meta.get("scores", {}),
            "annotation_tags": emoji_meta.get("tags", []),
            "emotion_ref_too_quiet": bool(emotion_ref_too_quiet),
            "emotion_ref_rms": round(float(emo_rms), 2),
            "emotion_applied": bool(emotion_applied),
            "wav_sample_rate": int(wav_info.get("sample_rate", 0)),
            "wav_bit_depth": int(wav_info.get("bit_depth", 0)),
            "wav_channels": int(wav_info.get("channels", 0)),
            "recent_waves": new_recording.get("recent_waves", []),
        }

    finally:
        if temp_prompt_wav and os.path.exists(temp_prompt_wav):
            try:
                os.remove(temp_prompt_wav)
            except Exception:
                pass
        if temp_prompt_wav_trim and os.path.exists(temp_prompt_wav_trim):
            try:
                os.remove(temp_prompt_wav_trim)
            except Exception:
                pass


@pressplay_router.post("/tts_segment")
async def tts_segment(
    project: str = Form(...),
    episode: str = Form(...),
    index: int = Form(...),
    speaker: str = Form(...),
    start: float = Form(...),
    end: float = Form(...),
    text: str = Form(...),
    voice: str = Form("en-US-RogerNeural"),
    rate: str = Form("+0%"),
    use_emotion_control: str = Form("false"),
    emotion_preset: str = Form("neutral"),
    emo_alpha: float = Form(1.0),
    emotion_mix: float = Form(0.65),
    use_emo_text_prompt: bool = Form(True),
    effect_style: str = Form("none"),
    effect_strength: float = Form(0.0),
    effect_position: str = Form("auto"),
):
    try:
        result = await generate_tts_segment_internal(
            project=project,
            episode=episode,
            index=index,
            speaker=speaker,
            start=start,
            end=end,
            text=text,
            voice=voice,
            rate=rate,
            use_emotion_control=use_emotion_control,
            emotion_preset=emotion_preset,
            emo_alpha=emo_alpha,
            emotion_mix=emotion_mix,
            use_emo_text_prompt=use_emo_text_prompt,
            effect_style=effect_style,
            effect_strength=effect_strength,
            effect_position=effect_position,
        )
        return JSONResponse(result)

    except HTTPException as e:
        return JSONResponse(
            status_code=e.status_code,
            content={"status": "error", "message": e.detail},
        )
    except Exception as e:
        print("âŒ IndexTTS2 generation failed:", repr(e))
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": f"IndexTTS2 generation failed: {str(e)}"},
        )


@pressplay_router.post("/set_active_wave")
async def set_active_wave(
    project: str = Form(...),
    episode: str = Form(...),
    index: int = Form(...),
    file: str = Form(...),
):
    try:
        safe_file = str(file or "").strip()
        if not safe_file:
            return JSONResponse(status_code=400, content={"status": "error", "message": "Missing file"})

        meta_path = os.path.join("subtitles", project, episode, "recordings", "recordings_meta.json")
        data = load_recordings_meta_from_path(meta_path)
        if not isinstance(data, list):
            data = []

        hit = None
        for rec in data:
            if int(rec.get("index", -1)) == int(index):
                hit = rec
                break

        if not isinstance(hit, dict):
            return JSONResponse(status_code=404, content={"status": "error", "message": "Segment recording not found"})

        recent = []
        if safe_file:
            recent.append(safe_file)
        current_file = str(hit.get("file") or "").strip()
        if current_file:
            recent.append(current_file)
        prev = hit.get("recent_waves")
        if isinstance(prev, list):
            recent.extend([str(x or "").strip() for x in prev if str(x or "").strip()])

        dedup = []
        for f in recent:
            if f and f not in dedup:
                dedup.append(f)

        hit["file"] = safe_file
        hit["recent_waves"] = dedup[:3]
        save_recordings_meta_to_path(meta_path, data)
        return {"status": "ok", "index": index, "file": safe_file, "recent_waves": hit["recent_waves"]}
    except Exception as e:
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


@pressplay_router.post("/vc_segment")
async def vc_segment(
    project: str = Form(...),
    episode: str = Form(...),
    index: int = Form(...),
    speaker: str = Form(...),
    start: float = Form(...),
    end: float = Form(...),
    source_file: str = Form(""),
    source_mode: str = Form("recorded"),
    target_speaker: str = Form(""),
):
    try:
        if end <= start:
            return JSONResponse(status_code=400, content={"status": "error", "message": "Invalid segment timing"})

        recordings_dir = os.path.join("subtitles", project, episode, "recordings")
        os.makedirs(recordings_dir, exist_ok=True)
        source_mode_norm = str(source_mode or "recorded").strip().lower()

        temp_source_path = None
        selected_source = str(source_file or "").strip()
        source_path = ""
        source_pre_roll_sec = 0.0
        source_post_roll_sec = 0.0

        if source_mode_norm == "original":
            video_path = os.path.join("subtitles", project, episode, f"{episode}.mp4")
            if not os.path.exists(video_path):
                return JSONResponse(status_code=404, content={"status": "error", "message": f"Video file not found: {video_path}"})

            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                temp_source_path = tmp.name

            ffmpeg_cmd = [
                "ffmpeg",
                "-y",
                "-ss", str(max(0.0, float(start))),
                "-i", video_path,
                "-t", str(max(0.1, float(end) - float(start))),
                "-vn",
                "-ac", "1",
                "-ar", "24000",
                "-c:a", "pcm_s16le",
                temp_source_path,
            ]
            ffmpeg_result = subprocess.run(
                ffmpeg_cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )
            if ffmpeg_result.returncode != 0:
                return JSONResponse(status_code=500, content={"status": "error", "message": f"ffmpeg extract failed: {ffmpeg_result.stderr}"})
            if not os.path.exists(temp_source_path) or os.path.getsize(temp_source_path) == 0:
                return JSONResponse(status_code=500, content={"status": "error", "message": "Failed to extract source audio from original video"})
            source_path = temp_source_path
            selected_source = "original_video_segment"
        else:
            meta = load_recordings_meta(project, episode)
            source_meta = None
            if not selected_source:
                rec = next((r for r in meta if int(r.get("index", -1)) == int(index) and str(r.get("file", "")).strip()), None)
                if rec:
                    source_meta = rec
                    selected_source = str(rec.get("file", "")).strip()

            if not selected_source:
                return JSONResponse(
                    status_code=400,
                    content={"status": "error", "message": "No source recording found for this segment. Record first, then run VC."},
                )

            source_path = os.path.abspath(os.path.join(recordings_dir, selected_source))
            recordings_abs = os.path.abspath(recordings_dir)
            if not source_path.startswith(recordings_abs + os.sep):
                return JSONResponse(status_code=400, content={"status": "error", "message": "Invalid source file"})
            if not os.path.exists(source_path):
                return JSONResponse(status_code=404, content={"status": "error", "message": f"Source recording not found: {selected_source}"})

            if source_meta is None:
                source_meta = next(
                    (
                        r for r in meta
                        if str(r.get("file", "")).strip() == selected_source
                    ),
                    None
                )
            if isinstance(source_meta, dict):
                try:
                    source_pre_roll_sec = max(0.0, float(source_meta.get("pre_roll_sec") or source_meta.get("preRollSec") or 0.0))
                except Exception:
                    source_pre_roll_sec = 0.0
                try:
                    source_post_roll_sec = max(0.0, float(source_meta.get("post_roll_sec") or source_meta.get("postRollSec") or 0.0))
                except Exception:
                    source_post_roll_sec = 0.0

            # Ignore pre/post-roll for VC input when using recorded source:
            # feed only the core segment speech to the VC model.
            if source_pre_roll_sec > 0.0 or source_post_roll_sec > 0.0:
                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                    temp_source_path = tmp.name

                seg_duration = max(0.1, float(end) - float(start))
                ffmpeg_trim_cmd = [
                    "ffmpeg",
                    "-y",
                    "-ss", str(source_pre_roll_sec),
                    "-i", source_path,
                    "-t", str(seg_duration),
                    "-vn",
                    "-ac", "1",
                    "-ar", "24000",
                    "-c:a", "pcm_s16le",
                    temp_source_path,
                ]
                ffmpeg_trim_result = subprocess.run(
                    ffmpeg_trim_cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    check=False,
                )
                if ffmpeg_trim_result.returncode != 0:
                    return JSONResponse(
                        status_code=500,
                        content={"status": "error", "message": f"ffmpeg trim failed: {ffmpeg_trim_result.stderr}"},
                    )
                if not os.path.exists(temp_source_path) or os.path.getsize(temp_source_path) == 0:
                    return JSONResponse(
                        status_code=500,
                        content={"status": "error", "message": "Failed to trim pre-roll from source audio"},
                    )
                source_path = temp_source_path
                source_pre_roll_sec = 0.0
                source_post_roll_sec = 0.0

        target = str(target_speaker or "").strip() or str(speaker or "").strip()
        if not target:
            return JSONResponse(status_code=400, content={"status": "error", "message": "Target speaker is required"})

        safe_speaker = safe_filename_part(speaker)
        fps = 25
        total_frames = int(round(float(start) * fps))
        h = total_frames // (3600 * fps)
        m = (total_frames % (3600 * fps)) // (60 * fps)
        s = (total_frames % (60 * fps)) // fps
        f = total_frames % fps
        filename = f"{index}_{safe_speaker}_{h:02}{m:02}{s:02}{f:02}_tts.wav"
        out_path = os.path.join(recordings_dir, filename)

        vc_server_urls = get_vc_server_urls()
        vc_last_error = ""
        vc_used_url = ""
        r = None
        async with httpx.AsyncClient(timeout=VC_SERVER_TIMEOUT_SEC) as client:
            for vc_url in vc_server_urls:
                vc_used_url = vc_url
                try:
                    with open(source_path, "rb") as src:
                        files = {"source_wav": (os.path.basename(source_path), src, "audio/wav")}
                        data = {"target_speaker": target}
                        resp = await client.post(vc_url, files=files, data=data)
                    if resp.status_code == 200:
                        r = resp
                        break
                    vc_last_error = f"{vc_url} -> {resp.status_code}: {(resp.text or '')[:300]}"
                except Exception as e:
                    vc_last_error = f"{vc_url} -> {e}"
                    continue

        if not r or r.status_code != 200:
            return JSONResponse(
                status_code=502,
                content={
                    "status": "error",
                    "message": f"VC server unavailable across endpoints: {vc_last_error or 'All connection attempts failed'}",
                },
            )

        with open(out_path, "wb") as out:
            out.write(r.content)

        wav_info = normalize_generated_wav_spec(out_path)
        vc_duration = get_audio_duration(out_path)
        segment_duration = round(float(end - start), 3)
        delta = round(vc_duration - segment_duration, 3)
        fit_status = classify_fit(delta)
        fit_text = fit_label(delta)

        meta_path = os.path.join(recordings_dir, "recordings_meta.json")
        new_recording = {
            "index": index,
            "speaker": speaker,
            "start": start,
            "end": end,
            "duration": vc_duration if vc_duration > 0 else segment_duration,
            "file": filename,
            "source": "vc",
            "voice": f"ChatterboxVC/{target}",
            "rate": "+0%",
            "tts_duration": vc_duration,
            "segment_duration": segment_duration,
            "delta": delta,
            "fit_status": fit_status,
            "fit_text": fit_text,
            "vc_target_speaker": target,
            "vc_source_file": selected_source,
            "vc_source_mode": source_mode_norm,
            "pre_roll_sec": source_pre_roll_sec,
            "post_roll_sec": source_post_roll_sec,
            "wav_sample_rate": int(wav_info.get("sample_rate", 0)),
            "wav_bit_depth": int(wav_info.get("bit_depth", 0)),
            "wav_channels": int(wav_info.get("channels", 0)),
        }
        upsert_recording_meta(meta_path, new_recording)

        return JSONResponse(
            {
                "status": "ok",
                "file": filename,
                "index": index,
                "speaker": speaker,
                "start": start,
                "end": end,
                "source": "vc",
                "voice": f"ChatterboxVC/{target}",
                "rate": "+0%",
                "tts_duration": vc_duration,
                "segment_duration": segment_duration,
                "delta": delta,
                "fit_status": fit_status,
                "fit_text": fit_text,
                "vc_target_speaker": target,
                "vc_source_file": selected_source,
                "vc_source_mode": source_mode_norm,
                "pre_roll_sec": source_pre_roll_sec,
                "post_roll_sec": source_post_roll_sec,
                "vc_server_url": vc_used_url,
                "wav_sample_rate": int(wav_info.get("sample_rate", 0)),
                "wav_bit_depth": int(wav_info.get("bit_depth", 0)),
                "wav_channels": int(wav_info.get("channels", 0)),
            }
        )
    except Exception as e:
        print("âŒ VC generation failed:", repr(e))
        return JSONResponse(status_code=500, content={"status": "error", "message": f"VC generation failed: {str(e)}"})
    finally:
        if temp_source_path and os.path.exists(temp_source_path):
            try:
                os.remove(temp_source_path)
            except Exception:
                pass


@pressplay_router.post("/admin/generate_tts_episode")
async def admin_generate_tts_episode(request: Request, payload: dict = Body(...)):
    user = request.session.get("user")
    if not user or user.get("role") != "admin":
        return JSONResponse(status_code=403, content={"status": "error", "message": "Admin only"})

    project = (payload.get("project") or "").strip()
    episode = (payload.get("episode") or "").strip()
    force = bool(payload.get("force", False))
    effect_style = str(payload.get("effect_style", "none") or "none").strip()
    effect_position = str(payload.get("effect_position", "auto") or "auto").strip()
    use_emo_text_prompt = bool(payload.get("use_emo_text_prompt", True))
    try:
        emotion_mix = float(payload.get("emotion_mix", 0.65) or 0.65)
    except Exception:
        emotion_mix = 0.65
    try:
        effect_strength = float(payload.get("effect_strength", 0.0) or 0.0)
    except Exception:
        effect_strength = 0.0

    if not project or not episode:
        return JSONResponse(
            status_code=400,
            content={"status": "error", "message": "Missing project or episode"}
        )

    try:
        segments = load_episode_segments_for_tts(project, episode)
        recordings_meta = load_recordings_meta(project, episode)

        existing_tts_indices = {
            int(r.get("index"))
            for r in recordings_meta
            if r.get("source") == "tts" and r.get("index") is not None
        }

        generated = 0
        skipped = 0
        failed = 0
        failures = []

        for seg in segments:
            index = int(seg["index"])
            speaker = seg["speaker"]
            start = float(seg["start"])
            end = float(seg["end"])
            text = (seg.get("text") or "").strip()
            is_done = bool(seg.get("is_done", False))

            # skip done segments
            if is_done:
                skipped += 1
                continue

            # skip empty EN text
            if not text:
                skipped += 1
                continue

            # skip already-generated TTS unless force=true
            if not force and index in existing_tts_indices:
                skipped += 1
                continue

            try:
                await generate_tts_segment_internal(
                    project=project,
                    episode=episode,
                    index=index,
                    speaker=speaker,
                    start=start,
                    end=end,
                    text=text,
                    voice="en-US-RogerNeural",
                    rate="+0%",
                    emotion_mix=emotion_mix,
                    use_emo_text_prompt=use_emo_text_prompt,
                    effect_style=effect_style,
                    effect_strength=effect_strength,
                    effect_position=effect_position,
                )
                generated += 1
            except Exception as e:
                failed += 1
                failures.append({
                    "index": index,
                    "speaker": speaker,
                    "message": str(e),
                })
                print(f"âŒ Episode TTS failed for {project}/{episode} segment {index}: {e}")

        return JSONResponse({
            "status": "ok",
            "project": project,
            "episode": episode,
            "generated": generated,
            "skipped": skipped,
            "failed": failed,
            "failures": failures,
        })

    except Exception as e:
        print("âŒ admin_generate_tts_episode failed:", repr(e))
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )        








@pressplay_router.get("/", response_class=HTMLResponse)
async def start_page(request: Request):
    user = request.session.get("user")
    if user:
        return RedirectResponse("/projects", status_code=302)
    return movie_frontend_or_template(request, "start.html")



@pressplay_router.get("/export")
async def export_en(project: str, episode: str):
    base = os.path.join("subtitles", project, episode)
    en_path = os.path.join(base, f"{episode}_en.csv")
    final_path = os.path.join(base, f"{episode}_Final_en.csv")

    if not os.path.exists(en_path):
        return JSONResponse(status_code=404, content={"error": "English CSV not found"})

    df = pd.read_csv(en_path, encoding="utf-8-sig")
    df.to_csv(final_path, index=False, encoding="utf-8-sig")
    return FileResponse(final_path, filename=f"{episode}_Final_en.csv")

@pressplay_router.get("/export_ar")
async def export_ar(project: str, episode: str):
    base = os.path.join("subtitles", project, episode)
    ar_path = os.path.join(base, f"{episode}_ar.csv")
    final_path = os.path.join(base, f"{episode}_Final_ar.csv")

    if not os.path.exists(ar_path):
        return JSONResponse(status_code=404, content={"error": "Arabic CSV not found"})

    df = pd.read_csv(ar_path, encoding="utf-8-sig")
    df.to_csv(final_path, index=False, encoding="utf-8-sig")
    return FileResponse(final_path, filename=f"{episode}_Final_ar.csv")


@pressplay_router.get("/export_merged")
async def export_merged(project: str, episode: str):
    base = os.path.join("subtitles", project, episode)
    en_path = os.path.join(base, f"{episode}_en.csv")
    ar_path = os.path.join(base, f"{episode}_ar.csv")
    final_path = os.path.join(base, f"{episode}_Final_merged.csv")

    if not (os.path.exists(en_path) and os.path.exists(ar_path)):
        return JSONResponse(status_code=404, content={"error": "Missing CSV files"})

    df_en = pd.read_csv(en_path, encoding="utf-8-sig")
    df_ar = pd.read_csv(ar_path, encoding="utf-8-sig")

    merged = pd.DataFrame({
        "Start": df_en["Timecode In"],
        "End": df_en["Timecode Out"],
        "Speaker_EN": df_en["Character"],
        "Text_EN": df_en["Dialogue"],
        "Speaker_AR": df_ar["Character"],
        "Text_AR": df_ar["Dialogue"]
    })

    merged.to_csv(final_path, index=False, encoding="utf-8-sig")
    return FileResponse(final_path, filename=f"{episode}_Final_merged.csv")
_EPISODE_WRITE_LOCKS: Dict[str, asyncio.Lock] = {}
_EPISODE_WRITE_LOCKS_GUARD = threading.Lock()
_ROOM_FIELD_LOCKS: Dict[str, Dict[str, int]] = {}
_ROOM_USER_LAST_SEEN: Dict[str, Dict[str, float]] = {}
_ROOM_USER_CONN_COUNT: Dict[str, Dict[str, int]] = {}
_WS_USER_BY_SOCKET: Dict[int, Dict[str, str]] = {}
_ROOM_EDIT_GUARD = threading.Lock()
ROOM_EDIT_TTL_SEC = 120.0
_DELETE_DEDUP_GUARD = threading.Lock()
_RECENT_DELETE_TS: Dict[str, float] = {}
DELETE_DEDUP_WINDOW_SEC = 2.0


def get_episode_write_lock(project: str, episode: str) -> asyncio.Lock:
    """
    Serialize CSV/meta write operations per episode to avoid lost updates
    during concurrent save/split/insert/delete requests.
    """
    key = f"{project}::{episode}"
    with _EPISODE_WRITE_LOCKS_GUARD:
        lock = _EPISODE_WRITE_LOCKS.get(key)
        if lock is None:
            lock = asyncio.Lock()
            _EPISODE_WRITE_LOCKS[key] = lock
        return lock


def build_editor_key(editor_user_id: str, editor_session_id: str) -> str:
    u = str(editor_user_id or "").strip()
    s = str(editor_session_id or "").strip()
    if u and s:
        return f"{u}#{s}"
    return u or s


def editor_display_name(editor_key: str) -> str:
    k = str(editor_key or "").strip()
    if "#" in k:
        return k.split("#", 1)[0] or k
    return k


def _touch_room_user(room: str, user: str):
    now = datetime.utcnow().timestamp()
    with _ROOM_EDIT_GUARD:
        last = _ROOM_USER_LAST_SEEN.setdefault(room, {})
        last[user] = now


def _acquire_room_field_lock(room: str, user: str):
    with _ROOM_EDIT_GUARD:
        locks = _ROOM_FIELD_LOCKS.setdefault(room, {})
        locks[user] = int(locks.get(user, 0)) + 1
    _touch_room_user(room, user)


def _release_room_field_lock(room: str, user: str):
    with _ROOM_EDIT_GUARD:
        locks = _ROOM_FIELD_LOCKS.get(room, {})
        if user in locks:
            locks[user] = max(0, int(locks[user]) - 1)
            if locks[user] <= 0:
                locks.pop(user, None)
        if not locks and room in _ROOM_FIELD_LOCKS:
            _ROOM_FIELD_LOCKS.pop(room, None)


def _clear_room_user_nolock(room: str, user: str):
    locks = _ROOM_FIELD_LOCKS.get(room, {})
    locks.pop(user, None)
    if not locks and room in _ROOM_FIELD_LOCKS:
        _ROOM_FIELD_LOCKS.pop(room, None)

    seen = _ROOM_USER_LAST_SEEN.get(room, {})
    seen.pop(user, None)
    if not seen and room in _ROOM_USER_LAST_SEEN:
        _ROOM_USER_LAST_SEEN.pop(room, None)

    conns = _ROOM_USER_CONN_COUNT.get(room, {})
    conns.pop(user, None)
    if not conns and room in _ROOM_USER_CONN_COUNT:
        _ROOM_USER_CONN_COUNT.pop(room, None)


def _clear_room_user(room: str, user: str):
    with _ROOM_EDIT_GUARD:
        _clear_room_user_nolock(room, user)


def _register_socket_user(room: str, websocket: WebSocket, user: str):
    ws_key = id(websocket)
    with _ROOM_EDIT_GUARD:
        prev = _WS_USER_BY_SOCKET.get(ws_key)
        if prev and prev.get("room") == room and prev.get("user") == user:
            return
        if prev:
            prev_room = prev.get("room", "")
            prev_user = prev.get("user", "")
            conns_prev = _ROOM_USER_CONN_COUNT.get(prev_room, {})
            if prev_user in conns_prev:
                conns_prev[prev_user] = max(0, int(conns_prev[prev_user]) - 1)
                if conns_prev[prev_user] <= 0:
                    conns_prev.pop(prev_user, None)
                    _clear_room_user_nolock(prev_room, prev_user)
            if not conns_prev and prev_room in _ROOM_USER_CONN_COUNT:
                _ROOM_USER_CONN_COUNT.pop(prev_room, None)

        _WS_USER_BY_SOCKET[ws_key] = {"room": room, "user": user}
        conns = _ROOM_USER_CONN_COUNT.setdefault(room, {})
        conns[user] = int(conns.get(user, 0)) + 1
    _touch_room_user(room, user)


def _unregister_socket_user(room: str, websocket: WebSocket):
    ws_key = id(websocket)
    with _ROOM_EDIT_GUARD:
        meta = _WS_USER_BY_SOCKET.pop(ws_key, None)
        if not meta:
            return
        user = str(meta.get("user", "")).strip()
        if not user:
            return
        conns = _ROOM_USER_CONN_COUNT.get(room, {})
        if user in conns:
            conns[user] = max(0, int(conns[user]) - 1)
            if conns[user] <= 0:
                conns.pop(user, None)
                _clear_room_user_nolock(room, user)
        if not conns and room in _ROOM_USER_CONN_COUNT:
            _ROOM_USER_CONN_COUNT.pop(room, None)


def get_conflicting_editor(project: str, episode: str, editor_user_id: str, editor_session_id: str = "") -> Optional[str]:
    room = f"{project}/{episode}"
    current = build_editor_key(editor_user_id, editor_session_id)
    now = datetime.utcnow().timestamp()
    with _ROOM_EDIT_GUARD:
        locks = _ROOM_FIELD_LOCKS.get(room, {}) or {}
        seen = _ROOM_USER_LAST_SEEN.get(room, {}) or {}
        candidates: List[str] = []
        for user, count in locks.items():
            if int(count or 0) <= 0:
                continue
            last_ts = float(seen.get(user, 0.0) or 0.0)
            if now - last_ts > ROOM_EDIT_TTL_SEC:
                continue
            candidates.append(str(user))
        if not candidates:
            return None
        if current and current in candidates:
            return None
        return editor_display_name(sorted(candidates)[0])


def should_ignore_duplicate_delete(
    project: str,
    episode: str,
    segment_index: int,
    editor_user_id: str = "",
    editor_session_id: str = "",
) -> bool:
    """
    Guard against accidental duplicate delete submits (double keypress/click).
    Returns True when a same delete request is repeated within a short window.
    """
    room = f"{project}/{episode}"
    editor_key = build_editor_key(editor_user_id, editor_session_id) or "anonymous"
    key = f"{room}|{editor_key}|{int(segment_index)}"
    now = datetime.utcnow().timestamp()
    with _DELETE_DEDUP_GUARD:
        stale_before = now - (DELETE_DEDUP_WINDOW_SEC * 8.0)
        stale_keys = [k for k, ts in _RECENT_DELETE_TS.items() if float(ts or 0.0) < stale_before]
        for k in stale_keys:
            _RECENT_DELETE_TS.pop(k, None)
        last_ts = float(_RECENT_DELETE_TS.get(key, 0.0) or 0.0)
        _RECENT_DELETE_TS[key] = now
        return (now - last_ts) < DELETE_DEDUP_WINDOW_SEC
