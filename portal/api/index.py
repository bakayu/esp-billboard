from __future__ import annotations

# pyright: reportMissingImports = false

import base64
import json
import os
import re
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, model_validator

try:
    import requests  # type: ignore
except Exception:  # pragma: no cover - optional dependency/runtime env
    requests = None

try:
    from google.cloud import vision  # type: ignore
    from google.oauth2 import service_account  # type: ignore
except Exception:  # pragma: no cover - optional dependency/runtime env
    vision = None
    service_account = None


CATEGORIES = (
    "nudity",
    "gore",
    "guns",
    "drugs",
    "alcohol",
    "violence",
)

DATA_URL_RE = re.compile(r"^data:image/[^;]+;base64,(?P<data>.+)$", re.IGNORECASE)

LIKELIHOOD_TO_SCORE = {
    0: 0.0,  # UNKNOWN
    1: 0.05,  # VERY_UNLIKELY
    2: 0.2,  # UNLIKELY
    3: 0.5,  # POSSIBLE
    4: 0.8,  # LIKELY
    5: 0.98,  # VERY_LIKELY
}

LABEL_HINTS = {
    "guns": [
        "gun",
        "firearm",
        "weapon",
        "rifle",
        "pistol",
        "revolver",
        "shotgun",
        "ammunition",
    ],
    "drugs": [
        "drug",
        "narcotic",
        "cannabis",
        "marijuana",
        "cocaine",
        "heroin",
        "methamphetamine",
        "syringe",
        "pill",
    ],
    "alcohol": [
        "alcohol",
        "beer",
        "wine",
        "liquor",
        "whiskey",
        "vodka",
        "cocktail",
        "bar",
    ],
    "gore": [
        "blood",
        "gore",
        "injury",
        "wound",
        "corpse",
        "dead body",
    ],
    "violence": [
        "violence",
        "fight",
        "assault",
        "attack",
        "weapon",
    ],
    "nudity": [
        "nudity",
        "nude",
        "sexual",
        "lingerie",
        "adult",
    ],
}

SIGHTENGINE_API_URL = "https://api.sightengine.com/1.0/check.json"
SIGHTENGINE_MODELS_DEFAULT = (
    "nudity-2.1,weapon,alcohol,recreational_drug,medical,offensive-2.0,"
    "gore-2.0,tobacco,violence,self-harm,gambling"
)


class ModerateRequest(BaseModel):
    width: int = 32
    height: int = 16
    imageDataUrl: Optional[str] = None
    pixels: Optional[List[List[int]]] = None
    thresholds: Dict[str, float] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_image_input(self) -> "ModerateRequest":
        if not self.imageDataUrl and not self.pixels:
            raise ValueError("Either imageDataUrl or pixels must be provided")
        return self


app = FastAPI(title="Portal Moderation API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def load_local_env_file() -> None:
    """Load api/.env for local development when process env is not preloaded."""
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if not os.path.exists(env_path):
        return

    try:
        with open(env_path, "r", encoding="utf-8") as handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("export "):
                    line = line[len("export ") :].strip()
                if "=" not in line:
                    continue

                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip()

                if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
                    value = value[1:-1]

                # Keep real environment variables highest priority.
                os.environ.setdefault(key, value)
    except Exception:
        # Do not hard-fail startup on malformed local env files.
        return


def env(name: str) -> str:
    return os.getenv(name, "").strip()


load_local_env_file()


def neutral_scores() -> Dict[str, float]:
    return {category: 0.0 for category in CATEGORIES}


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def decode_data_url(data_url: str) -> bytes:
    match = DATA_URL_RE.match(data_url.strip())
    if not match:
        raise ValueError("imageDataUrl must be a base64 data URL")

    b64 = match.group("data")
    try:
        return base64.b64decode(b64, validate=True)
    except Exception as exc:
        raise ValueError("imageDataUrl is not valid base64") from exc


def likelihood_score(value: int) -> float:
    return LIKELIHOOD_TO_SCORE.get(int(value), 0.0)


def safe_search_scores(annotation: Any) -> Dict[str, float]:
    adult = likelihood_score(annotation.adult)
    violence = likelihood_score(annotation.violence)
    racy = likelihood_score(annotation.racy)
    medical = likelihood_score(annotation.medical)

    return {
        "nudity": clamp01(max(adult, racy * 0.8)),
        "gore": clamp01(max(violence * 0.82, medical * 0.7)),
        "guns": 0.0,
        "drugs": 0.0,
        "alcohol": 0.0,
        "violence": clamp01(max(violence, racy * 0.35)),
    }


def label_scores(labels: List[Any]) -> Dict[str, float]:
    scores = neutral_scores()

    for label in labels:
        desc = (label.description or "").lower()
        confidence = clamp01(label.score)

        for category, hints in LABEL_HINTS.items():
            if any(hint in desc for hint in hints):
                scores[category] = max(scores[category], confidence)

    return scores


def merge_scores(*score_maps: Dict[str, float]) -> Dict[str, float]:
    merged = neutral_scores()
    for score_map in score_maps:
        for category in CATEGORIES:
            merged[category] = max(
                merged[category], clamp01(score_map.get(category, 0.0))
            )
    return merged


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _collect_numbered_paths(obj: Any, path: str = "") -> List[Tuple[str, float]]:
    items: List[Tuple[str, float]] = []
    if _is_number(obj):
        items.append((path.lower(), float(obj)))
        return items

    if isinstance(obj, dict):
        for key, value in obj.items():
            next_path = f"{path}.{key}" if path else str(key)
            items.extend(_collect_numbered_paths(value, next_path))
    elif isinstance(obj, list):
        for idx, value in enumerate(obj):
            next_path = f"{path}[{idx}]" if path else f"[{idx}]"
            items.extend(_collect_numbered_paths(value, next_path))
    return items


def _is_risk_path(path: str) -> bool:
    # Ignore confidence buckets that explicitly represent safe/background context.
    # Example in Sightengine output: nudity.none, nudity.context.*, *.categories.none
    tokens = re.findall(r"[a-zA-Z0-9_-]+", path.lower())
    blocked = {"none", "context"}
    return not any(token in blocked for token in tokens)


def _section_score(section: Any, hints: Optional[List[str]] = None) -> float:
    entries = [
        (path, value)
        for path, value in _collect_numbered_paths(section)
        if _is_risk_path(path)
    ]
    if not entries:
        return 0.0

    if not hints:
        return clamp01(max(value for _, value in entries))

    lowered_hints = [h.lower() for h in hints]
    filtered = [
        value for path, value in entries if any(hint in path for hint in lowered_hints)
    ]
    if not filtered:
        return 0.0
    return clamp01(max(filtered))


def moderate_with_sightengine(image_bytes: bytes) -> Tuple[Dict[str, float], str]:
    if requests is None:
        raise RuntimeError("requests package not available; install API dependencies")

    api_user = env("SIGHTENGINE_API_USER")
    api_secret = env("SIGHTENGINE_API_SECRET")
    models = env("SIGHTENGINE_MODELS") or SIGHTENGINE_MODELS_DEFAULT

    if not api_user or not api_secret:
        raise RuntimeError(
            "Sightengine credentials missing (SIGHTENGINE_API_USER/SECRET)"
        )

    try:
        response = requests.post(
            SIGHTENGINE_API_URL,
            data={
                "models": models,
                "api_user": api_user,
                "api_secret": api_secret,
            },
            files={"media": ("frame.png", image_bytes, "image/png")},
            timeout=20,
        )
    except requests.RequestException as exc:
        raise RuntimeError(f"Sightengine request failed: {exc}") from exc

    if response.status_code != 200:
        raise RuntimeError(f"Sightengine HTTP {response.status_code}: {response.text}")

    try:
        data = response.json()
    except ValueError as exc:
        raise RuntimeError("Sightengine returned invalid JSON") from exc

    if data.get("status") != "success":
        error = data.get("error")
        raise RuntimeError(f"Sightengine error: {error or data}")

    nudity = _section_score(data.get("nudity"))
    gore = _section_score(data.get("gore"))
    violence = _section_score(data.get("violence"))
    alcohol = _section_score(data.get("alcohol"), ["alcohol", "prob", "score"])
    drugs = _section_score(
        data.get("recreational_drug"),
        ["drug", "cannabis", "marijuana", "cocaine", "heroin", "meth", "prob"],
    )
    drugs = max(
        drugs, _section_score(data.get("medical"), ["pill", "paraphernalia", "prob"])
    )
    if drugs == 0.0:
        drugs = _section_score(data.get("drug"), ["drug", "prob", "score"])

    guns = _section_score(
        data.get("weapon"),
        ["firearm", "gun", "weapon", "rifle", "pistol", "shotgun"],
    )

    scores = {
        "nudity": nudity,
        "gore": gore,
        "guns": guns,
        "drugs": drugs,
        "alcohol": alcohol,
        "violence": violence,
    }

    return scores, "Moderated with Sightengine direct image upload"


def resolve_provider() -> str:
    provider = env("MODERATION_PROVIDER").lower()
    if provider in {"google", "google-vision", "vision"}:
        return "google"
    if provider in {"sightengine", "sight-engine"}:
        return "sightengine"
    # Auto: use Sightengine when credentials are present, else Google.
    if env("SIGHTENGINE_API_USER") and env("SIGHTENGINE_API_SECRET"):
        return "sightengine"
    return "google"


def load_vision_credentials() -> Any:
    if service_account is None:
        return None

    raw_json = env("GOOGLE_APPLICATION_CREDENTIALS_JSON")
    b64_json = env("GOOGLE_APPLICATION_CREDENTIALS_JSON_BASE64")

    if raw_json:
        try:
            info = json.loads(raw_json)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                "GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON"
            ) from exc
        return service_account.Credentials.from_service_account_info(info)

    if b64_json:
        try:
            decoded = base64.b64decode(b64_json, validate=True).decode("utf-8")
            info = json.loads(decoded)
        except Exception as exc:
            raise RuntimeError(
                "GOOGLE_APPLICATION_CREDENTIALS_JSON_BASE64 is invalid"
            ) from exc
        return service_account.Credentials.from_service_account_info(info)

    return None


def build_vision_client() -> Any:
    if vision is None:
        raise RuntimeError("google-cloud-vision package not available")

    credentials = load_vision_credentials()
    if credentials is not None:
        return vision.ImageAnnotatorClient(credentials=credentials)

    # Fallback to Application Default Credentials for local/dev shells.
    return vision.ImageAnnotatorClient()


def moderate_with_google_vision(image_bytes: bytes) -> Tuple[Dict[str, float], str]:
    if vision is None:
        raise RuntimeError("google-cloud-vision package not available")

    client = build_vision_client()
    image = vision.Image(content=image_bytes)

    safe_resp = client.safe_search_detection(image=image)
    if safe_resp.error.message:
        raise RuntimeError(f"safe_search_detection failed: {safe_resp.error.message}")

    label_resp = client.label_detection(image=image, max_results=30)
    if label_resp.error.message:
        raise RuntimeError(f"label_detection failed: {label_resp.error.message}")

    safe_scores = safe_search_scores(safe_resp.safe_search_annotation)
    label_based_scores = label_scores(list(label_resp.label_annotations))

    scores = merge_scores(safe_scores, label_based_scores)
    return scores, "Moderated with Google Cloud Vision safe-search + label analysis"


@app.get("/api/health")
def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.post("/api/moderate")
def moderate(payload: ModerateRequest) -> Dict[str, object]:
    if not payload.imageDataUrl:
        raise HTTPException(status_code=400, detail="imageDataUrl is required")

    try:
        image_bytes = decode_data_url(payload.imageDataUrl)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    vision_disabled = env("GOOGLE_VISION_DISABLED").lower() in {
        "1",
        "true",
        "yes",
    }

    if not vision_disabled:
        provider = resolve_provider()
        try:
            if provider == "sightengine":
                scores, reason = moderate_with_sightengine(image_bytes)
                source = "sightengine"
            else:
                scores, reason = moderate_with_google_vision(image_bytes)
                source = "google-cloud-vision"

            return {
                "scores": scores,
                "source": source,
                "reason": reason,
            }
        except Exception as exc:
            # Fail open with neutral scores. Frontend strict mode decides whether to block.
            return {
                "scores": neutral_scores(),
                "source": "fallback-neutral",
                "reason": f"Moderation provider unavailable, neutral scores used: {exc}",
            }

    return {
        "scores": neutral_scores(),
        "source": "disabled-neutral",
        "reason": "Vision moderation disabled by GOOGLE_VISION_DISABLED",
    }
