from contextlib import asynccontextmanager

from fastapi import FastAPI
from prometheus_fastapi_instrumentator import Instrumentator

from .logging import setup_logging
from .routes import router


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    yield


app = FastAPI(title="SmartFlo-LiveKit Connector", lifespan=lifespan)
app.include_router(router)

Instrumentator().instrument(app).expose(app)
