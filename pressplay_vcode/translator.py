from fastapi import APIRouter, Body
from pydantic import BaseModel
from fuzzywuzzy import fuzz
import re, unicodedata, sqlite3

translator_router = APIRouter()


DB_PATH = "translations.db"

# -------------------------------------------------
# Ensure DB
# -------------------------------------------------
def ensure_memory_table():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("""
    CREATE TABLE IF NOT EXISTS memory (
        turkish TEXT UNIQUE,
        arabic TEXT
    )
    """)
    conn.commit()
    conn.close()

ensure_memory_table()

# -------------------------------------------------
# TURKISH NORMALIZATION
# -------------------------------------------------
def normalize_turkish(text: str) -> str:
    if not text:
        return ""

    text = unicodedata.normalize("NFKC", text)
    text = text.lower()

    replace_map = {
        "â": "a", "î": "i", "Û": "u",
        "Â": "a", "Î": "i", "Û": "u",
        "ş̧": "ş", "ğ̆": "ğ"
    }
    for k, v in replace_map.items():
        text = text.replace(k, v)

    text = re.sub(r"[!?.,:;“”\"'’()`\[\]{}…]+", " ", text)
    text = re.sub(r"[^a-z0-9çğıöşü\s]", " ", text)
    text = re.sub(r"\s+", " ", text)

    return text.strip()

# -------------------------------------------------
# LOOKUP WITH EXACT + FUZZY MATCH
# -------------------------------------------------
def lookup_memory(turkish: str, threshold: int = 80):
    original = turkish
    turkish = normalize_turkish(turkish)

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    # Exact match
    c.execute("SELECT arabic FROM memory WHERE turkish = ?", (turkish,))
    row = c.fetchone()
    if row and row[0]:
        conn.close()
        return row[0]

    # Fuzzy search
    c.execute("SELECT turkish, arabic FROM memory")
    rows = c.fetchall()

    best_ar = ""
    best_score = 0

    for stored_tr, stored_ar in rows:
        if not stored_tr or not stored_ar:
            continue
        score = fuzz.ratio(turkish, stored_tr)
        if score > best_score:
            best_score = score
            best_ar = stored_ar

    conn.close()

    if best_score >= threshold:
        print(f"[FUZZY MATCH] '{original}' → '{best_ar}' (score {best_score})")
        return best_ar

    return ""

# -------------------------------------------------
# SAVE MEMORY
# -------------------------------------------------
def save_memory(turkish: str, arabic: str):
    turkish = normalize_turkish(turkish)
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute(
        "INSERT OR REPLACE INTO memory (turkish, arabic) VALUES (?, ?)",
        (turkish, arabic)
    )
    conn.commit()
    conn.close()

# -------------------------------------------------
# GPT TRANSLATION
# -------------------------------------------------
def gpt_translate(text: str) -> str:
    prompt = (
        "Translate the following Turkish sentence into Levantine Arabic "
        "(Shami dialect), keeping meaning natural and conversational:\n\n"
        f"{text}"
    )

    response = client.chat.completions.create(
        model="gpt-5.1",
        messages=[
            {"role": "system", "content": "You are a translation engine specializing in Turkish → Levantine Arabic."},
            {"role": "user", "content": prompt}
        ]
    )

    return response.choices[0].message.content.strip()

# -------------------------------------------------
# Request Models
# -------------------------------------------------
class TranslateRequest(BaseModel):
    turkish: str

class TranslateResponse(BaseModel):
    arabic: str

class MemoryRequest(BaseModel):
    turkish: str
    arabic: str

# -------------------------------------------------
# ROUTES
# -------------------------------------------------
@translator_router.post("/translate", response_model=TranslateResponse)
def api_translate(req: TranslateRequest):
    text = req.turkish.strip()

    # 1) Memory lookup
    memory_result = lookup_memory(text)
    if memory_result:
        return TranslateResponse(arabic=memory_result)

    # 2) GPT fallback
    gpt_result = gpt_translate(text)

    # 3) Store GPT translation in memory
    save_memory(text, gpt_result)

    return TranslateResponse(arabic=gpt_result)

@translator_router.post("/save_memory")
def api_save_memory(req: MemoryRequest):
    save_memory(req.turkish.strip(), req.arabic.strip())
    return {"status": "saved"}

@translator_router.get("/translator_status")
def translator_status():
    return {"status": "Memory + GPT Translator Active"}
