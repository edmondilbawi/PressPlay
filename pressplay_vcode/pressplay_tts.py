import json
import os
import subprocess
import tempfile

import httpx
from fastapi import HTTPException

from pressplay_constants import EMOTION_PRESETS
from pressplay_audio import get_audio_duration
from pressplay_services import upsert_recording_meta
from pressplay_utils import safe_filename_part


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
):
    """
    Internal shared implementation for one segment.
    Returns the same JSON payload shape as /tts_segment.
    Raises HTTPException/Exception on failure.
    """
    text = (text or "").strip()

    if not text:
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

    filename = f"{index}_{safe_speaker}_{tc_compact(start)}_tts.wav"
    file_path = os.path.join(path, filename)

    TTS_SERVER_URL = "http://91.144.16.91:8001/synthesize"

    try:
        rate_num = float(str(rate).replace("%", "").replace("+", "").strip())
    except Exception:
        rate_num = 0.0

    speed = max(0.7, min(1.3, 1.0 + (rate_num / 100.0) * 0.35))

    video_path = os.path.join("subtitles", project, episode, f"{episode}.mp4")
    if not os.path.exists(video_path):
        raise HTTPException(status_code=404, detail=f"Video file not found: {video_path}")

    temp_prompt_wav = None

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

        async with httpx.AsyncClient(timeout=300.0) as client:
            with open(temp_prompt_wav, "rb") as f_prompt, open(temp_prompt_wav, "rb") as f_emo:
                files = {
                    # required by /synthesize
                    "prompt_wav": ("prompt.wav", f_prompt, "audio/wav"),
                    # this is the real emotion reference input
                    "emo_audio_prompt": ("emo_prompt.wav", f_emo, "audio/wav"),
                }

                effective_emo_alpha = float(emo_alpha)

                data = {
                    "text": text,
                    "speaker": speaker,
                    "speed": str(speed),
                    "emo_alpha": str(effective_emo_alpha),
                    "target_length_ms": str(target_length_ms),
                }

                if str(use_emotion_control).lower() == "true":
                    emo_vector = EMOTION_PRESETS.get(
                        str(emotion_preset).strip().lower(),
                        EMOTION_PRESETS["neutral"],
                    )
                    data["emo_vector"] = json.dumps(emo_vector)
                    print(f"🎭 emo_vector preset={emotion_preset} alpha={emo_alpha} vector={emo_vector}")
                else:
                    print(f"🎧 default prompt-based emotion alpha={effective_emo_alpha}")

                r = await client.post(
                    TTS_SERVER_URL,
                    files=files,
                    data=data,
                )

            if r.status_code != 200:
                raise Exception(f"TTS server error {r.status_code}: {r.text}")

            with open(file_path, "wb") as out:
                out.write(r.content)

        tts_duration = get_audio_duration(file_path)
        segment_duration = round(float(end - start), 3)
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
            "speed": speed,
            "target_length_ms": target_length_ms,
            "emo_start": round(emo_start, 3),
            "emo_duration": round(emo_duration, 3),
            "tts_duration": tts_duration,
            "segment_duration": segment_duration,
            "delta": delta,
            "fit_status": fit_status,
            "fit_text": fit_text,
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
            "speed": speed,
            "target_length_ms": target_length_ms,
            "emo_start": round(emo_start, 3),
            "emo_duration": round(emo_duration, 3),
            "tts_duration": tts_duration,
            "segment_duration": segment_duration,
            "delta": delta,
            "fit_status": fit_status,
            "fit_text": fit_text,
        }

    finally:
        if temp_prompt_wav and os.path.exists(temp_prompt_wav):
            try:
                os.remove(temp_prompt_wav)
            except Exception:
                pass
