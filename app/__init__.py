from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from prometheus_fastapi_instrumentator import Instrumentator

from .logging import setup_logging
from .routes import router
from .admin import router as admin_router

PLAYGROUND_DIR = Path(__file__).resolve().parent.parent / "playground" / "dist"


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    yield


app = FastAPI(title="SmartFlo-LiveKit Connector", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(router)
app.include_router(admin_router)

Instrumentator().instrument(app).expose(app)

# Serve playground build (must be after API routes so they take priority)
if PLAYGROUND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=PLAYGROUND_DIR, html=True), name="playground")
