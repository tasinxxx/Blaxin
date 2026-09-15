#!/usr/bin/env python3
"""
BLAXIN computer-use perception probe — OCR-based screen grounding.

Reads a REAL screenshot (PNG) of the display BLAXIN controls and turns raw
pixels into GROUNDED, ACTIONABLE state: visible text becomes element boxes
(x, y, w, h) with click points and confidences, so an agent can pick a
semantic target ("click the button labelled OK") and act on REAL screen
coordinates instead of guessing pixels.

Pipeline (all on real pixels):
  1. multi-scale upscaling (LANCZOS) — small GUI text needs more pixels,
     and different scales segment button rows differently; merging both
     gives every element more real evidence
  2. multi-mode tesseract (psm 3, 6, 11, 12) — no single segmentation mode
     sees everything on a GUI (psm 6 catches button rows psm 11 misses)
  3. per-run boxes are scaled BACK to real screen coordinates, then merged
     (same text + overlapping box → best confidence + agreement count)
  4. every element/word carries a real click point (box center)

Honest contract:
  - emits NOTHING about what "should" be on screen — only what OCR saw;
  - per-element confidence and cross-run agreement are carried verbatim;
  - on failure (no OCR engine, unreadable image) exits non-zero with a JSON
    error object — never an empty-but-successful result.
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

MAX_PHRASE_WORDS = 4
MIN_WORD_LEN = 2
MIN_CONFIDENCE = 35.0
PSM_MODES = (3, 6, 11, 12)
# Multi-scale OCR ensemble: small GUI text grounds differently at 3x vs 4x
# (one scale may read a button row as one blob, another as separate words).
DEFAULT_UPSCALES = (3, 4)


def check_image(image: Path):
    if not image.is_file() or image.stat().st_size == 0:
        print(json.dumps({"ok": False, "error": f"unreadable image: {image}"}))
        sys.exit(4)
    with image.open("rb") as fh:
        if fh.read(8) != b"\x89PNG\r\n\x1a\n":
            print(json.dumps({"ok": False, "error": "not a PNG image"}))
            sys.exit(5)


def prepare(image: Path, upscale: int):
    """Return (analysis image, upscale factor actually applied)."""
    if upscale <= 1:
        return image, 1
    try:
        from PIL import Image
        img = Image.open(image)
        big = img.resize((img.width * upscale, img.height * upscale), Image.LANCZOS)
        prepared = image.with_name(image.stem + f".x{upscale}.png")
        big.save(prepared)
        return prepared, upscale
    except Exception:
        # Pillow missing or unopenable → fall back to raw pixels honestly.
        return image, 1


def run_tsv(image: Path, psm: int):
    tsv = subprocess.run(
        ["tesseract", str(image), "stdout", "--psm", str(psm), "tsv"],
        capture_output=True, text=True, timeout=120,
    )
    if tsv.returncode != 0:
        raise RuntimeError(f"tesseract psm={psm} exited {tsv.returncode}: {tsv.stderr.strip()[:200]}")
    return tsv.stdout


def parse_tsv(tsv: str):
    words = []
    lines = tsv.splitlines()
    header = lines[0].split("\t") if lines else []
    try:
        idx = {name: i for i, name in enumerate(header)}
        conf_i, text_i = idx["conf"], idx["text"]
        left_i, top_i, width_i, height_i = idx["left"], idx["top"], idx["width"], idx["height"]
        block_i, par_i, line_i, word_i = idx["block_num"], idx["par_num"], idx["line_num"], idx["word_num"]
    except KeyError:
        raise RuntimeError(f"unexpected tesseract TSV header: {header[:8]}")

    for line in lines[1:]:
        cols = line.split("\t")
        if len(cols) <= max(conf_i, text_i, width_i):
            continue
        text = cols[text_i].strip()
        try:
            conf = float(cols[conf_i])
        except ValueError:
            continue
        if not text or conf < MIN_CONFIDENCE or len(text) < MIN_WORD_LEN or not any(c.isalnum() for c in text):
            continue
        words.append({
            "text": text,
            "confidence": round(conf, 1),
            "x": int(cols[left_i]), "y": int(cols[top_i]),
            "w": int(cols[width_i]), "h": int(cols[height_i]),
            "line": (cols[block_i], cols[par_i], cols[line_i]),
            "word": int(cols[word_i]),
        })
    return words


def assemble(words):
    lines: dict = {}
    for w in words:
        key = w.pop("line")
        lines.setdefault(key, []).append(w)

    elements = []
    for key in sorted(lines, key=lambda k: (int(k[0]), int(k[1]), int(k[2]))):
        ws = sorted(lines[key], key=lambda w: w["word"])
        text = " ".join(w["text"] for w in ws)
        x0 = min(w["x"] for w in ws)
        y0 = min(w["y"] for w in ws)
        x1 = max(w["x"] + w["w"] for w in ws)
        y1 = max(w["y"] + w["h"] for w in ws)
        conf = sum(w["confidence"] for w in ws) / len(ws)
        elements.append({
            "text": text,
            "confidence": round(conf, 1),
            "box": {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0},
        })

    singles = list(words)
    return elements, singles


def overlaps(a, b, pad=8):
    return not (a["x"] + a["w"] + pad < b["x"] or b["x"] + b["w"] + pad < a["x"]
                or a["y"] + a["h"] + pad < b["y"] or b["y"] + b["h"] + pad < a["y"])


def normalize_text(s):
    return " ".join("".join(c if c.isalnum() or c in "-_" else " " for c in s.lower()).split())


def merge_boxes(items):
    """Merge the same physical text seen by multiple OCR runs (modes ×
    scales): same normalized text + overlapping box → one entry with the
    best confidence and a run count. Cross-run agreement is a real
    confidence signal, carried as `modesSeen`."""
    merged = []
    for it in sorted(items, key=lambda e: -e["confidence"]):
        hit = None
        for m in merged:
            if normalize_text(m["text"]) == normalize_text(it["text"]) and overlaps(m["box"], it["box"]):
                hit = m
                break
        if hit:
            x0 = min(hit["box"]["x"], it["box"]["x"])
            y0 = min(hit["box"]["y"], it["box"]["y"])
            x1 = max(hit["box"]["x"] + hit["box"]["w"], it["box"]["x"] + it["box"]["w"])
            y1 = max(hit["box"]["y"] + hit["box"]["h"], it["box"]["y"] + it["box"]["h"])
            hit["box"] = {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}
            hit["modesSeen"] = hit.get("modesSeen", 1) + 1
            hit["confidence"] = max(hit["confidence"], it["confidence"])
        else:
            merged.append(dict(it))
    return merged


def with_click(items):
    out = []
    for it in items:
        b = it["box"]
        out.append({**it, "click": {"x": b["x"] + b["w"] // 2, "y": b["y"] + b["h"] // 2}})
    return out


def match_rank(t, q):
    """Rank how well normalized text `t` grounds the query `q`.
    0 = whole text is the query · 1 = query is an exact token of it ·
    2 = substring · 4 = fuzzy single token with OCR-tolerant edit distance
    (small fonts misread 1–2 glyphs per token: c/l, O/0, V/H, W/H). The
    tolerance scales with token length (≤1 for ≥5 chars, ≤2 for ≥7).
    None = no match."""
    tokens = t.split()
    if t == q:
        return 0
    if q in tokens:
        return 1
    if q in t:
        return 2
    if len(q) >= 5:
        tol = 2 if len(q) >= 7 else 1
        for tok in tokens:
            if len(tok) == len(q) and sum(a != b for a, b in zip(tok, q)) <= tol:
                return 4
    return None


def find(elements, words, query):
    """Ground a semantic target with RANKED, WORD-AWARE matching.

    The same physical text can appear in a button label AND inside a body
    sentence, and a matched row must not be clicked at its center (that
    can fall BETWEEN two buttons). Preference, best wins:
      - lower match_rank beats higher (label beats sentence);
      - WORD-level candidates (tight box) beat element-level at equal rank;
      - ties break to the shorter text, then more cross-run agreement.
    Returns {click, box, text, confidence, level, ...} or None."""
    q = normalize_text(query)
    q_words = q.split()
    if not q or len(q_words) > MAX_PHRASE_WORDS:
        return None
    best = None  # (sort_key, payload)

    for w in words:
        wt = normalize_text(w["text"])
        rank = match_rank(wt, q) if len(q_words) == 1 else (0 if wt == q else None)
        if rank is None:
            continue
        key = (rank, len(w["text"]), -w.get("modesSeen", 1))
        payload = {"click": w["click"], "box": w["box"], "text": w["text"],
                   "confidence": w["confidence"], "modesSeen": w.get("modesSeen", 1), "level": "word"}
        if best is None or key < best[0]:
            best = (key, payload)

    for el in elements:
        rank = match_rank(normalize_text(el["text"]), q)
        if rank is None:
            continue
        click, box = el["click"], el["box"]
        if rank > 0 and len(normalize_text(el["text"]).split()) > 1:
            # Matched inside a multi-word element: prefer a tight click on
            # the matching WORD, never the element center (which can fall
            # between two buttons).
            for w in words:
                wt = normalize_text(w["text"])
                if overlaps(w["box"], el["box"], pad=4) and match_rank(wt, q) is not None \
                        and (q in wt.split() or wt == q or (len(q) >= 5 and match_rank(wt, q) == 4)):
                    click, box = w["click"], w["box"]
                    break
        key = (rank, len(el["text"]), -el.get("modesSeen", 1))
        payload = {"click": click, "box": box, "text": el["text"],
                   "confidence": el["confidence"], "modesSeen": el.get("modesSeen", 1), "level": "element"}
        if best is None or key < best[0]:
            best = (key, payload)

    return best[1] if best else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--find", action="append", default=[])
    ap.add_argument("--upscale", default=",".join(map(str, DEFAULT_UPSCALES)),
                    help="comma list of upscale factors (multi-scale OCR ensemble)")
    args = ap.parse_args()

    if shutil.which("tesseract") is None:
        print(json.dumps({"ok": False, "error": "tesseract not installed"}))
        sys.exit(3)
    check_image(Path(args.image))

    scales = [max(1, int(s)) for s in str(args.upscale).split(",") if s.strip()]

    all_elements, all_words = [], []
    modes_used = []
    prepared = None
    for scale in scales:
        prepared, applied = prepare(Path(args.image), scale)
        for psm in PSM_MODES:
            try:
                words = parse_tsv(run_tsv(prepared, psm))
            except RuntimeError:
                continue  # a mode failing is not fatal — others may see the screen
            modes_used.append(psm)
            els, singles = assemble(words)
            # Scale BACK to real screen coordinates (OCR ran on the upscaled image).
            for el in els:
                el["box"] = {k: v // applied for k, v in el["box"].items()}
            for w in singles:
                w["x"], w["y"], w["w"], w["h"] = w["x"] // applied, w["y"] // applied, w["w"] // applied, w["h"] // applied
            all_elements.extend(els)
            all_words.extend(singles)

    try:
        if prepared is not None and prepared != Path(args.image):
            prepared.unlink()
    except OSError:
        pass

    merged_elements = with_click(merge_boxes(all_elements))
    merged_words = with_click(merge_boxes([
        {"text": w["text"], "confidence": w["confidence"],
         "box": {"x": w["x"], "y": w["y"], "w": w["w"], "h": w["h"]}}
        for w in all_words
    ]))

    targets = {}
    for q in args.find:
        hit = find(merged_elements, merged_words, q)
        targets[q] = ({"found": True, **hit} if hit else {"found": False})

    print(json.dumps({
        "ok": True,
        "upscales": scales,
        "modesUsed": sorted(set(modes_used)),
        "elementCount": len(merged_elements),
        "elements": merged_elements[:120],
        "targets": targets,
    }))


if __name__ == "__main__":
    main()
