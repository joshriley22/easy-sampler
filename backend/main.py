from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
import os
import uuid
import shutil

UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

# MP3 magic bytes: ID3 tag or MPEG frame sync
_MP3_MAGIC = (b"ID3", b"\xff\xfb", b"\xff\xf3", b"\xff\xf2", b"\xff\xfa")

app = FastAPI(title="Easy Sampler API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:4173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.post("/api/upload")
async def upload_audio(file: UploadFile = File(...)):
    if not file.filename or not file.filename.lower().endswith(".mp3"):
        raise HTTPException(status_code=400, detail="Only MP3 files are accepted.")

    header = await file.read(3)
    if not any(header.startswith(magic) for magic in _MP3_MAGIC):
        raise HTTPException(status_code=400, detail="File does not appear to be a valid MP3.")

    # Rewind and save
    await file.seek(0)

    file_id = str(uuid.uuid4())
    dest = os.path.join(UPLOAD_DIR, f"{file_id}.mp3")

    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)

    return JSONResponse({"file_id": file_id, "filename": file.filename})


# Serve the built React frontend when not in dev mode
_static_dir = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")
if os.path.isdir(_static_dir):
    app.mount("/", StaticFiles(directory=_static_dir, html=True), name="static")
