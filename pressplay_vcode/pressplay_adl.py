import json
import os
import shutil
from pathlib import Path
from uuid import uuid4
from datetime import datetime
from typing import Optional, List

from pressplay_utils import sanitize_track_name


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

    filtered_items = []
    missing_files = []

    for item in data:
        raw_spk = str(item.get("speaker", "")).strip()

        if selected_set and raw_spk not in selected_set:
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
        filtered_items.append((normalized, wav_path))

    if not filtered_items:
        raise ValueError("No usable ADL items found after filtering")

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
