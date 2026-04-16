"""Shared codec constants loaded from codec_constants.json.

Both the TypeScript feature_codec.ts and this Python module read from
the same JSON file to ensure STATE_DIM, ACTION_DIM, and MAX_ACTIONS
stay in sync.
"""
from __future__ import annotations

import json
from pathlib import Path

_CONSTANTS_PATH = Path(__file__).parent / "codec_constants.json"

with open(_CONSTANTS_PATH) as f:
    _data = json.load(f)

STATE_DIM: int = _data["STATE_DIM"]
ACTION_DIM: int = _data["ACTION_DIM"]
MAX_ACTIONS: int = _data["MAX_ACTIONS"]
RANKS: list[str] = _data["RANKS"]
SUITS: list[str] = _data["SUITS"]
PLAY_TYPES: list[str] = _data["PLAY_TYPES"]
