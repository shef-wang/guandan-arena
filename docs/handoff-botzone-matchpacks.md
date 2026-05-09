# Handoff: Botzone Guandan match data

Use this log to resume fetching **all finished matches** for Botzone **掼蛋 (Guandan)** from the official bulk export, without rediscovering URLs and pitfalls.

## Goal

- Pull **historical gameplay / match JSON** for game id `65490c16ec1ab1389702dced`.
- Prefer **monthly ZIP matchpacks** (one download per month, each line in unpacked JSON = one finished match).
- User-requested “heavy months” to try first: **2025-1, 2025-6, 2025-12, 2026-1**.

## Official bulk download (preferred)

- **UI:** [Download Matches](https://www.botzone.org.cn/downloadmatches) (Chinese site; English mirror exists at `en.botzone.org.cn`).
- **CDN base:** `https://extra.botzone.org.cn/matchpacks/`
- **URL pattern** (matches the site’s own JS — month is **1–12, not zero-padded**):

  ```text
  https://extra.botzone.org.cn/matchpacks/<gameId>-<year>-<month>.zip
  ```

  Example:

  ```text
  https://extra.botzone.org.cn/matchpacks/65490c16ec1ab1389702dced-2025-12.zip
  ```

- **Format:** Site states each pack is **ZIP**; inside, lines are **JSON objects** (one match per line). (Exact inner filename not re-verified here — inspect ZIP after first good download.)
- **Coverage window:** From platform “birth” (2014-05) through **last complete calendar month** (current month may be incomplete / absent).

### Guandan-specific notes

- Game id `65490c16ec1ab1389702dced` encodes creation ≈ **2023-11** (Mongo ObjectId timestamp). Earlier months may **404** — expected.

## Repo tool

- **Script:** `tools/fetch_botzone_matchpacks.py`
- **Output (default):** `data/botzone/matchpacks/` (directory; see `.gitignore`).
- **Important flag:** `--insecure`  
  `extra.botzone.org.cn` often presents a TLS certificate with **hostname mismatch**; stock Python verification fails without this.

Example (the four priority months):

```bash
python3 tools/fetch_botzone_matchpacks.py --insecure \
  --months 2025-1 2025-6 2025-12 2026-1
```

Options: `--game`, `--out`, `--retries`, `--delay`.

The script checks that the response body starts with `PK` (real ZIP) so HTML error pages are not saved as `.zip`.

## What happened last time (blocked on server)

- With `--insecure`, requests reached the host but nginx returned **`502 Bad Gateway`** for every tried month (same as `curl -skI` to the matchpack URL).
- **No ZIPs were saved.** This is an **upstream / Botzone infrastructure** issue, not a wrong URL in our script.
- **Action when resuming:** Re-run the same command; success looks like `OK <filename> <N> bytes` and files under `data/botzone/matchpacks/`.

## Volume sanity check (optional context)

A crawl of `globalmatchlist?game=65490c16ec1ab1389702dced` (paginate with `&startid=<last id on page>`) was used to **estimate** match counts by month (timestamps from Mongo ObjectId prefix, **UTC**). Rough orders of magnitude for **≥ 2025-01** (not a substitute for matchpack line counts):

| Month   | ~Matches |
|---------|----------|
| 2025-01 | ~478     |
| 2025-06 | ~810     |
| 2025-12 | ~2337    |
| 2026-01 | ~1000    |

Activity is **spiky** (contest-driven); many months are sparse. **Total ≥ 2025-01** on the order of **~5k** matches (from that crawl, not from ZIP line counts).

## Fallback if matchpacks stay broken

- **Enumerate IDs:** `https://www.botzone.org.cn/globalmatchlist?game=65490c16ec1ab1389702dced`  
  Pagination: `&startid=<24-char hex id>` (last id on current page). ~20 matches per page.
- **Per-match pages:** `https://www.botzone.org.cn/match/<id>` — replay JSON is loaded dynamically; bulk ZIP is still the right long-term approach.
- A one-off ID list from a previous crawl may exist on a dev machine as `/tmp/botzone_guandan_ids_since_2025.txt` — **not in repo**; regenerate if needed.

## Git / ignore

- `.gitignore` includes `data/botzone/` so large downloads do not clutter `git status`.

## Quick checklist when you resume

1. `python3 tools/fetch_botzone_matchpacks.py --insecure --months 2025-1 2025-6 2025-12 2026-1`
2. If 502 persists: retry later; optionally probe `curl -skI` on one URL.
3. On success: unzip, confirm JSONL-style content, extend `--months` for full `2025-01` … `last closed month` sweep.
4. If TLS errors without `--insecure`: expected; keep `--insecure` or fix local trust store only if Botzone fixes the cert.

---

*Written for continuity; update this file when matchpack layout or Botzone URLs change.*
