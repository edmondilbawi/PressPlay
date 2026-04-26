# app.py  – Unified PressPlay + Translator Server

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from starlette.middleware.sessions import SessionMiddleware
from fastapi.staticfiles import StaticFiles

# Routers
from pressplay import pressplay_router
from translator import translator_router

# ----------------------------
# Create Unified FastAPI App
# ----------------------------
app = FastAPI(title="PressPlay Unified Server")

BASE_DIR = Path(__file__).resolve().parent
MOVIE_FRONTEND_DIST = BASE_DIR / "movie-production-backend-master" / "app" / "frontend" / "dist"
MOVIE_FRONTEND_INDEX = MOVIE_FRONTEND_DIST / "index.html"

# ----------------------------
# Middleware
# ----------------------------
# Session support (login system)
app.add_middleware(SessionMiddleware, secret_key="super-secret-session-key")

# CORS for browser + JS requests
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # You can restrict later if needed
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ----------------------------
# Static File Mounts
# ----------------------------
# These were originally mounted in main.py – now handled here
app.mount("/static", StaticFiles(directory="static"), name="static")
app.mount("/subtitles", StaticFiles(directory="subtitles"), name="subtitles")
if (MOVIE_FRONTEND_DIST / "assets").exists():
    app.mount("/assets", StaticFiles(directory=str(MOVIE_FRONTEND_DIST / "assets")), name="movie_assets")

# ----------------------------
# Attach Routers
# ----------------------------
app.include_router(pressplay_router)
app.include_router(translator_router)

# ----------------------------
# Health Check
# ----------------------------
@app.get("/health")
def health():
    return {
        "status": "ok",
        "components": ["PressPlay", "Translator", "MemoryDB"]
    }


@app.get("/assets/{asset_path:path}")
async def movie_production_asset(asset_path: str):
    asset_file = (MOVIE_FRONTEND_DIST / "assets" / asset_path).resolve()
    assets_dir = (MOVIE_FRONTEND_DIST / "assets").resolve()
    if not str(asset_file).startswith(str(assets_dir)) or not asset_file.is_file():
        raise HTTPException(status_code=404, detail="Asset not found")
    return FileResponse(asset_file)


@app.get("/{spa_path:path}", response_class=HTMLResponse)
async def movie_production_frontend(spa_path: str):
    """
    Serve the React frontend for client-side routes that are not handled by
    the PressPlay/Translator APIs.
    """
    if MOVIE_FRONTEND_INDEX.exists():
        return FileResponse(MOVIE_FRONTEND_INDEX)
    return HTMLResponse(
        "movie-production-backend-master frontend is not built yet. "
        "Run `npm run build` in movie-production-backend-master/app/frontend.",
        status_code=503,
    )

# ----------------------------
# Development Entry Point
# (Only used when running: python app.py)
# ----------------------------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app:app",
        host="0.0.0.0",
        port=8000,
        reload=True
    )
