from __future__ import annotations

import json
from pathlib import Path

_CONSTANTS_PATH = Path(__file__).parent / "codec_constants.json"

with open(_CONSTANTS_PATH, "r", encoding="utf8") as handle:
    _data = json.load(handle)

STATE_DIM: int = _data["STATE_DIM"]
ACTION_DIM: int = _data["ACTION_DIM"]
MAX_ACTIONS: int = _data["MAX_ACTIONS"]
RANKS: list[str] = _data["RANKS"]
SUITS: list[str] = _data["SUITS"]
PLAY_TYPES: list[str] = _data["PLAY_TYPES"]
