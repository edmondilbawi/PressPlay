import json
import os
from pathlib import Path
from typing import List, Dict, Any, Set

import pandas as pd

from pressplay_utils import is_bad_speaker_name, timecode_to_seconds


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

        print(f"🎧 recordings_meta shifted for insert at index {insert_index}; inserted segment left empty")
        return cleaned

    except Exception as e:
        print(f"⚠️ recordings_meta insert update failed: {e}")
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

            # remove recording for the split segment
            if idx == split_index:
                print(f"🗑 Removing recording at split index {split_index}")
                continue

            if idx > split_index:
                rec = dict(rec)
                rec["index"] = idx + 1

            updated.append(rec)

        updated.sort(key=lambda r: int(r.get("index", 0)))
        save_recordings_meta_to_path(meta_path, updated)

        print(f"🎧 recordings_meta updated for split at index {split_index}")
        return updated

    except Exception as e:
        print(f"⚠️ recordings_meta split update failed: {e}")
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

            # delete recording for deleted segment
            if idx == delete_index:
                print(f"🗑 Removing recording at deleted index {delete_index}")
                continue

            # shift later recordings back
            if idx > delete_index:
                rec = dict(rec)
                rec["index"] = idx - 1

            updated.append(rec)

        updated.sort(key=lambda r: int(r.get("index", 0)))
        save_recordings_meta_to_path(meta_path, updated)

        print(f"🎧 recordings_meta updated for delete at index {delete_index}")
        return updated

    except Exception as e:
        print(f"⚠️ recordings_meta delete update failed: {e}")
        return []


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

        text = str(en_row["text"]).strip() if en_row is not None else ""

        segments.append({
            "index": i,
            "speaker": speaker,
            "start": start,
            "end": end,
            "text": text,
            "is_done": i in done_indexes,
        })

    return segments


def load_recordings_meta(project: str, episode: str) -> List[Dict[str, Any]]:
    meta_path = os.path.join("subtitles", project, episode, "recordings", "recordings_meta.json")
    return load_recordings_meta_from_path(meta_path)


def upsert_recording_meta(meta_path: str, new_recording: dict):
    recordings_meta = []

    if os.path.exists(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                recordings_meta = json.load(f)
        except Exception:
            recordings_meta = []

    recordings_meta = [r for r in recordings_meta if r.get("index") != new_recording["index"]]
    recordings_meta.append(new_recording)

    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(recordings_meta, f, ensure_ascii=False, indent=2)
