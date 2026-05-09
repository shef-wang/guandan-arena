#!/usr/bin/env python3
"""Download Botzone monthly matchpack ZIPs from extra.botzone.org.cn.

Official pattern (see https://www.botzone.org.cn/downloadmatches):
  https://extra.botzone.org.cn/matchpacks/<gameId>-<year>-<month>.zip
Month is 1–12 without zero-padding, matching the site's JS.

Example (掼蛋 / Guandan):
  python3 tools/fetch_botzone_matchpacks.py --insecure \\
    --months 2025-1 2025-6 2025-12 2026-1

Use --insecure: extra.botzone.org.cn often presents a TLS cert whose CN does not match the hostname.
"""

from __future__ import annotations

import argparse
import gzip
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


DEFAULT_GAME = "65490c16ec1ab1389702dced"  # Botzone Guandan
DEFAULT_OUT = Path(__file__).resolve().parent.parent / "data" / "botzone" / "matchpacks"
USER_AGENT = "guandan-arena-fetch_botzone_matchpacks/1.0 (research; +https://github.com/)"
REFERER = "https://www.botzone.org.cn/downloadmatches"


def build_url(game_id: str, year: int, month: int) -> str:
    return f"https://extra.botzone.org.cn/matchpacks/{game_id}-{year}-{month}.zip"


def fetch(url: str, timeout: float = 120.0, *, insecure: bool = False) -> tuple[int, bytes, str]:
    ctx: ssl.SSLContext | None = None
    if insecure:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE

    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "*/*",
            "Referer": REFERER,
            "Accept-Encoding": "gzip",
        },
    )
    opener_ctx = {"context": ctx} if ctx else {}
    with urllib.request.urlopen(req, timeout=timeout, **opener_ctx) as resp:  # noqa: S310
        data = resp.read()
        enc = resp.headers.get("Content-Encoding", "")
        if enc.lower() == "gzip":
            data = gzip.decompress(data)
        return resp.status, data, resp.headers.get("Content-Type", "")


def main() -> None:
    p = argparse.ArgumentParser(description="Download Botzone matchpack ZIPs by month.")
    p.add_argument(
        "--game",
        default=DEFAULT_GAME,
        help=f"Botzone game id (default: Guandan {DEFAULT_GAME})",
    )
    p.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUT,
        help=f"Output directory (default: {DEFAULT_OUT})",
    )
    p.add_argument(
        "--months",
        nargs="+",
        required=True,
        metavar="Y-M",
        help="Months as Y-M e.g. 2025-1 2025-12",
    )
    p.add_argument("--retries", type=int, default=5, help="Retries per file on failure")
    p.add_argument("--delay", type=float, default=1.0, help="Seconds between attempts")
    p.add_argument(
        "--insecure",
        action="store_true",
        help="Skip TLS hostname/cert verification (often required for extra.botzone.org.cn).",
    )
    args = p.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    failed = 0

    for spec in args.months:
        parts = spec.split("-", 1)
        if len(parts) != 2:
            print(f"skip bad month {spec!r} (want Y-M)", file=sys.stderr)
            continue
        year_s, month_s = parts
        try:
            year, month = int(year_s), int(month_s)
        except ValueError:
            print(f"skip bad month {spec!r}", file=sys.stderr)
            continue
        if not (1 <= month <= 12):
            print(f"skip bad month {spec!r}", file=sys.stderr)
            continue

        url = build_url(args.game, year, month)
        dest = args.out / f"{args.game}-{year}-{month}.zip"

        last_err: Exception | None = None
        for attempt in range(1, args.retries + 1):
            try:
                code, body, ctype = fetch(url, insecure=args.insecure)
                if code != 200:
                    raise RuntimeError(f"HTTP {code} content-type={ctype!r}")
                if not body.startswith(b"PK"):
                    preview = body[:200].decode("utf-8", errors="replace")
                    raise RuntimeError(f"not a ZIP (wrong URL, 404, or 502 page). Start of body: {preview!r}")
                dest.write_bytes(body)
                print(f"OK {dest.name}  {len(body)} bytes")
                last_err = None
                break
            except (urllib.error.HTTPError, urllib.error.URLError, OSError, RuntimeError) as e:
                last_err = e
                print(f"  attempt {attempt}/{args.retries} failed: {e}", file=sys.stderr)
                if attempt < args.retries:
                    time.sleep(args.delay * attempt)

        if last_err is not None:
            print(f"FAILED {dest.name}  {last_err}", file=sys.stderr)
            failed += 1
        time.sleep(args.delay)

    if failed:
        print(f"\n{failed} download(s) failed.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
