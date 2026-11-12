"""LRC 解析 / 生成工具。

统一的「行」结构（与前端、song.json 保持一致）：
    {
      "id": "l_xxxx",          # 稳定行 ID（编辑历史依赖它）
      "time": 12.34,           # 秒
      "end": 15.0 | None,      # 下一个时间标签（逐句练习的片段终点）
      "text": "風に触った",     # 日语原文
      "zh": "",                # 中文翻译
      "words": None | [...],   # 分词结果（前端自动分析后回写），见 README
      "wordsEdited": False,    # 用户是否手动改过分词/读音
      "romaji": None | str,    # 整行罗马音手动覆盖；None = 由 words 自动拼接
      "ruby": None | str,      # 外部来源（Marumaru）的注音 HTML，用于提升读音准确度
      "wordTiming": None | [...]  # 逐字时间轴 [{starttime, endtime, text}]（毫秒）
    }
"""
from __future__ import annotations

import re
import secrets

TAG_RE = re.compile(r"\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]")
META_RE = re.compile(r"^\[(ti|ar|al|by|offset|length|re|ve|au):(.*)\]\s*$", re.I)


def new_line_id() -> str:
    return "l_" + secrets.token_hex(4)


def make_line(time: float, text: str, **extra) -> dict:
    line = {
        "id": new_line_id(),
        "time": round(float(time), 3),
        "end": None,
        "text": text,
        "zh": "",
        "words": None,
        "wordsEdited": False,
        "romaji": None,
        "ruby": None,
        "wordTiming": None,
    }
    line.update({k: v for k, v in extra.items() if v is not None})
    return line


def parse_lrc(text: str) -> tuple[list[dict], dict, str]:
    """解析 LRC 文本。

    返回 (lines, meta, timeline)：
      timeline = 'synced'  有时间标签
               = 'synthetic' 纯文本，按 4 秒间隔生成的估算时间轴
    同一时间戳出现两行（常见于「日文行 + 中文行」双语 LRC）时，第二行作为上一行的中文翻译。
    """
    meta: dict = {}
    raw_lines = (text or "").replace("﻿", "").splitlines()
    out: list[dict] = []
    boundaries: list[float] = []
    offset_ms = 0
    has_tags = False

    for raw in raw_lines:
        m = META_RE.match(raw.strip())
        if m:
            key, val = m.group(1).lower(), m.group(2).strip()
            if key == "offset":
                try:
                    offset_ms = int(val)
                except ValueError:
                    pass
            else:
                meta[key] = val
            continue
        stamps = []
        for tm in TAG_RE.finditer(raw):
            mi, se = int(tm.group(1)), int(tm.group(2))
            frac = tm.group(3)
            ms = int(frac.ljust(3, "0")[:3]) if frac else 0
            if se < 60:
                stamps.append(mi * 60 + se + ms / 1000)
        if stamps:
            has_tags = True
        content = TAG_RE.sub("", raw).strip()
        boundaries.extend(stamps)
        if not stamps or not content:
            continue
        for t in stamps:
            out.append({"time": max(0.0, t - offset_ms / 1000), "text": content})

    if not has_tags:
        # 纯文本歌词：每行 4 秒的估算时间轴
        plain = [ln.strip() for ln in raw_lines if ln.strip() and not META_RE.match(ln.strip())]
        lines = [make_line(i * 4, t) for i, t in enumerate(plain)]
        for i, ln in enumerate(lines):
            ln["end"] = lines[i + 1]["time"] if i + 1 < len(lines) else ln["time"] + 4
        return lines, meta, "synthetic"

    out.sort(key=lambda x: x["time"])
    # 双语 LRC：同一时间戳的第二行视为翻译
    merged: list[dict] = []
    for item in out:
        if merged and abs(merged[-1]["time"] - item["time"]) < 1e-6 and not merged[-1].get("zh"):
            if _looks_japanese(merged[-1]["text"]) and not _looks_japanese(item["text"]):
                merged[-1]["zh"] = item["text"]
                continue
        merged.append(item)

    uniq = sorted(set(round(b - offset_ms / 1000, 3) for b in boundaries))
    lines = []
    for item in merged:
        ln = make_line(item["time"], item["text"], zh=item.get("zh") or "")
        ln["end"] = next((b for b in uniq if b > ln["time"] + 1e-6), None)
        lines.append(ln)
    return lines, meta, "synced"


def _looks_japanese(s: str) -> bool:
    return bool(re.search(r"[぀-ヿ]", s or ""))


def fmt_time(t: float) -> str:
    t = max(0.0, float(t or 0))
    m = int(t // 60)
    s = t - m * 60
    return f"{m:02d}:{s:05.2f}"


def build_lrc(lines: list[dict], meta: dict | None = None, with_zh: bool = False) -> str:
    head = []
    if meta:
        if meta.get("title"):
            head.append(f"[ti:{meta['title']}]")
        if meta.get("artist"):
            head.append(f"[ar:{meta['artist']}]")
    body = []
    for ln in lines:
        if not ln.get("text"):
            continue
        body.append(f"[{fmt_time(ln.get('time', 0))}]{ln['text']}")
        if with_zh and ln.get("zh"):
            body.append(f"[{fmt_time(ln.get('time', 0))}]{ln['zh']}")
    return "\n".join(head + body)


def recompute_ends(lines: list[dict]) -> None:
    """按时间排序后，以下一行时间作为本行 end（保留比下一行更早的显式 end）。"""
    lines.sort(key=lambda x: x.get("time", 0))
    for i, ln in enumerate(lines):
        nxt = lines[i + 1]["time"] if i + 1 < len(lines) else None
        cur_end = ln.get("end")
        if nxt is None:
            if cur_end is None or cur_end <= ln["time"]:
                ln["end"] = None
        elif cur_end is None or cur_end <= ln["time"] or cur_end > nxt:
            ln["end"] = nxt
