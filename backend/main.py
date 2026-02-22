from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
import os
import uuid
import shutil
import boto3
from botocore.exceptions import ClientError
import psycopg2
from psycopg2.extras import RealDictCursor

UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

# MP3 magic bytes: ID3 tag or MPEG frame sync
_MP3_MAGIC = (b"ID3", b"\xff\xfb", b"\xff\xf3", b"\xff\xf2", b"\xff\xfa")

S3_BUCKET = "amzn-s3-music-sample-bucket"

_DB_HOST = os.environ.get("SUPABASE_DB_HOST", "aws-0-us-east-1.pooler.supabase.com")
_DB_PORT = int(os.environ.get("SUPABASE_DB_PORT", "6543"))
_DB_USER = "postgres.bilewmuidvrufadoorly"
_DB_NAME = "postgres"


def _get_db():
    db_password = os.environ.get("DB_PASSWORD", "")
    return psycopg2.connect(
        host=_DB_HOST,
        port=_DB_PORT,
        dbname=_DB_NAME,
        user=_DB_USER,
        password=db_password,
    )


def _get_s3():
    return boto3.client(
        "s3",
        aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
    )


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


@app.post("/api/songs")
async def create_song(file: UploadFile = File(...), title: str = Form(...)):
    """Upload an MP3 to S3 and record its metadata in Supabase."""
    if not file.filename or not file.filename.lower().endswith(".mp3"):
        raise HTTPException(status_code=400, detail="Only MP3 files are accepted.")

    header = await file.read(3)
    if not any(header.startswith(magic) for magic in _MP3_MAGIC):
        raise HTTPException(status_code=400, detail="File does not appear to be a valid MP3.")

    await file.seek(0)
    data = await file.read()

    song_key = f"songs/{uuid.uuid4()}.mp3"

    s3 = _get_s3()
    try:
        s3.put_object(
            Bucket=S3_BUCKET,
            Key=song_key,
            Body=data,
            ContentType="audio/mpeg",
        )
    except ClientError as exc:
        raise HTTPException(status_code=502, detail=f"S3 upload failed: {exc}") from exc

    try:
        conn = _get_db()
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    "INSERT INTO songs (title, likes, song_key) VALUES (%s, %s, %s) RETURNING *",
                    (title, 0, song_key),
                )
                fetched = cur.fetchone()
                if fetched is None:
                    raise RuntimeError("INSERT returned no row")
                row = dict(fetched)
            conn.commit()
        finally:
            conn.close()
    except Exception as exc:
        # Roll back S3 upload on DB failure
        try:
            s3.delete_object(Bucket=S3_BUCKET, Key=song_key)
        except ClientError:
            pass
        raise HTTPException(status_code=502, detail=f"Database insert failed: {exc}") from exc

    return JSONResponse(row, status_code=201)


@app.get("/api/songs")
async def list_songs():
    """Return all songs stored in Supabase."""
    try:
        conn = _get_db()
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("SELECT * FROM songs ORDER BY id DESC")
                rows = [dict(r) for r in cur.fetchall()]
        finally:
            conn.close()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Database query failed: {exc}") from exc

    return JSONResponse(rows)


@app.post("/api/songs/{song_id}/like")
async def like_song(song_id: int):
    """Increment the like count for a song."""
    row = None
    try:
        conn = _get_db()
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    "UPDATE songs SET likes = likes + 1 WHERE id = %s RETURNING *",
                    (song_id,),
                )
                row = cur.fetchone()
            conn.commit()
        finally:
            conn.close()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Database update failed: {exc}") from exc

    if row is None:
        raise HTTPException(status_code=404, detail="Song not found.")
    return JSONResponse(dict(row))
@app.get("/api/songs/{song_id}/download-url")
async def get_download_url(song_id: int):
    """Return a presigned S3 URL for downloading/streaming the song."""
    try:
        conn = _get_db()
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("SELECT song_key FROM songs WHERE id = %s", (song_id,))
                row = cur.fetchone()
        finally:
            conn.close()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Database query failed: {exc}") from exc

    if row is None:
        raise HTTPException(status_code=404, detail="Song not found.")

    s3 = _get_s3()
    try:
        url = s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": S3_BUCKET, "Key": row["song_key"]},
            ExpiresIn=3600,
        )
    except ClientError as exc:
        raise HTTPException(status_code=502, detail=f"Could not generate download URL: {exc}") from exc

    return JSONResponse({"url": url})


# Serve the built React frontend when not in dev mode
_static_dir = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")
if os.path.isdir(_static_dir):
    app.mount("/", StaticFiles(directory=_static_dir, html=True), name="static")
