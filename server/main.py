from fastapi import FastAPI, UploadFile, File, HTTPException, Depends, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
import os
import uuid
import string
import random
import asyncio
from datetime import datetime, timedelta
import aiofiles
import hashlib
from typing import Dict
import logging
from collections import defaultdict
from dotenv import load_dotenv

# --- Load environment variables ---
load_dotenv()
SECRET_KEY = os.getenv("SECRET_KEY")
if not SECRET_KEY:
    raise RuntimeError("SECRET_KEY is not set")
RATE_LIMIT = int(os.getenv("RATE_LIMIT", "5"))

# --- Logging ---
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# --- App config ---
app = FastAPI(title="File Transfer API", version="1.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = "uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)

file_storage: Dict[str, dict] = {}
user_rate_limit: Dict[str, list] = defaultdict(list)  # API key → [timestamps]
ip_rate_limit: Dict[str, list] = defaultdict(list)    # IP address → [timestamps]

MAX_FILE_SIZE = 50 * 1024 * 1024  # 50MB
EXPIRY_TIME = 60  # in seconds
CODE_LENGTH = 8

# --- Models ---
class FileDownloadRequest(BaseModel):
    code: str

class FileUploadResponse(BaseModel):
    code: str
    expires_at: str
    file_size: int

# --- Utilities ---
def generate_code() -> str:
    chars = string.ascii_uppercase + string.digits
    chars = chars.replace('0', '').replace('O', '').replace('I', '').replace('1', '')
    return ''.join(random.choice(chars) for _ in range(CODE_LENGTH))

def get_file_hash(file_path: str) -> str:
    hasher = hashlib.sha256()
    with open(file_path, 'rb') as f:
        for chunk in iter(lambda: f.read(4096), b""):
            hasher.update(chunk)
    return hasher.hexdigest()

def sanitize_filename(filename: str) -> str:
    safe_chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-() "
    return ''.join(c if c in safe_chars else '_' for c in (filename or "download")).strip() or "download"

async def cleanup_expired_files():
    while True:
        now = datetime.now()
        expired = [code for code, info in file_storage.items() if now > info['expires_at']]
        for code in expired:
            info = file_storage.pop(code, None)
            if info and os.path.exists(info['file_path']):
                os.remove(info['file_path'])
                logger.info(f"Expired file removed: {code}")
        await asyncio.sleep(30)

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(cleanup_expired_files())

# --- Auth + Rate limiting ---
def check_user_rate_limit(request: Request):

    ip = request.client.host
    now = datetime.now()

    # --- IP rate limit ---
    ip_rate_limit[ip] = [t for t in ip_rate_limit[ip] if (now - t).seconds < 60]
    if len(ip_rate_limit[ip]) >= RATE_LIMIT:
        raise HTTPException(status_code=429, detail="Too many requests from this IP")
    ip_rate_limit[ip].append(now)

# --- Routes ---
@app.post("/upload", response_model=FileUploadResponse)
async def upload_file(request: Request, file: UploadFile = File(...)):
    check_user_rate_limit(request)
    try:
        content = await file.read()
        file_size = len(content)
        if file_size == 0:
            raise HTTPException(status_code=400, detail="Empty file not allowed")
        if file_size > MAX_FILE_SIZE:
            raise HTTPException(status_code=413, detail=f"Max size is {MAX_FILE_SIZE // 1024 // 1024}MB")

        code = generate_code()
        while code in file_storage:
            code = generate_code()

        original_filename = file.filename or "file"
        ext = os.path.splitext(original_filename)[1]
        unique_name = f"{uuid.uuid4()}{ext}"
        file_path = os.path.join(UPLOAD_DIR, unique_name)

        async with aiofiles.open(file_path, 'wb') as f:
            await f.write(content)

        expires_at = datetime.now() + timedelta(seconds=EXPIRY_TIME)
        file_hash = get_file_hash(file_path)

        file_storage[code] = {
            'file_path': file_path,
            'original_name': original_filename,
            'file_size': file_size,
            'content_type': file.content_type,
            'expires_at': expires_at,
            'hash': file_hash,
            'upload_time': datetime.now()
        }

        logger.info(f"Uploaded {original_filename} → {code}")
        return FileUploadResponse(code=code, expires_at=expires_at.isoformat(), file_size=file_size)

    except Exception as e:
        logger.error(f"Upload error: {e}")
        raise HTTPException(status_code=500, detail="Upload failed")

@app.post("/download")
async def download_file(request: FileDownloadRequest, background_tasks: BackgroundTasks):
    check_user_rate_limit(request)

    return await _handle_download(request.code.strip().upper(), background_tasks)

@app.get("/download/{code}")
async def direct_download(request: Request, code: str, background_tasks: BackgroundTasks):
    check_user_rate_limit(request)
    return await _handle_download(code.strip().upper(), background_tasks)

async def _handle_download(code: str, background_tasks: BackgroundTasks):
    if code not in file_storage:
        raise HTTPException(status_code=404, detail="Invalid or expired code")

    info = file_storage[code]
    if datetime.now() > info['expires_at']:
        if os.path.exists(info['file_path']):
            os.remove(info['file_path'])
        file_storage.pop(code, None)
        raise HTTPException(status_code=410, detail="Code expired")

    if not os.path.exists(info['file_path']):
        file_storage.pop(code, None)
        raise HTTPException(status_code=404, detail="File not found")

    current_hash = get_file_hash(info['file_path'])
    if current_hash != info['hash']:
        os.remove(info['file_path'])
        file_storage.pop(code, None)
        raise HTTPException(status_code=500, detail="File integrity check failed")

    background_tasks.add_task(schedule_cleanup, code)

    return FileResponse(
        path=info['file_path'],
        filename=sanitize_filename(info['original_name']),
        media_type=info['content_type'] or 'application/octet-stream'
    )

def schedule_cleanup(code: str):
    try:
        info = file_storage.pop(code, None)
        if info and os.path.exists(info['file_path']):
            os.remove(info['file_path'])
            logger.info(f"File {code} deleted after download")
    except Exception as e:
        logger.error(f"Cleanup error: {e}")

@app.get("/info/{code}")
async def get_file_info(request: Request, code: str):
    check_user_rate_limit(request)
    code = code.strip().upper()
    if code not in file_storage:
        raise HTTPException(status_code=404, detail="Invalid or expired code")

    info = file_storage[code]
    if datetime.now() > info['expires_at']:
        if os.path.exists(info['file_path']):
            os.remove(info['file_path'])
        file_storage.pop(code, None)
        raise HTTPException(status_code=410, detail="Code expired")

    return {
        "original_name": info['original_name'],
        "file_size": info['file_size'],
        "content_type": info['content_type'],
        "expires_at": info['expires_at'].isoformat(),
        "time_remaining": (info['expires_at'] - datetime.now()).total_seconds(),
        "upload_time": info['upload_time'].isoformat(),
        "hash": info['hash']
    }

@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "active_files": len(file_storage),
        "timestamp": datetime.now().isoformat()
    }
