"""单词本：从歌词行的分词结果（line.words）自动整理单词。

* 直接使用歌词里显示的「词」（包含用户合并 / 拆分 / 改读音后的结果），所以单词本始终跟随编辑；
* 去掉词尾助词：「君の」→「君」、「裏切りは」→「裏切り」、「暇なんて」→「暇」（读音与罗马音同步去掉）；
* 跳过标点、纯英文、只剩一个假名的词；
* 按词面合并：同一个词在多首歌 / 多行出现时计数并保留例句；读音优先取用户手动编辑过的行。
释义 / 备注 / 收藏保存在 vocab_notes 表（按词面，跨歌曲共享）。
"""
from __future__ import annotations

import re

from . import storage

# 词尾助词（长的在前）及其罗马音
PARTICLES: list[tuple[str, str]] = [
    ("ばかり", "bakari"), ("くらい", "kurai"), ("ぐらい", "gurai"), ("なんて", "nante"), ("なんか", "nanka"),
    ("から", "kara"), ("まで", "made"), ("より", "yori"), ("って", "tte"), ("だけ", "dake"), ("しか", "shika"),
    ("ほど", "hodo"), ("など", "nado"), ("さえ", "sae"), ("こそ", "koso"), ("でも", "demo"), ("には", "ni wa"),
    ("では", "de wa"), ("とは", "to wa"), ("へと", "e to"),
    ("は", "wa"), ("が", "ga"), ("を", "o"), ("に", "ni"), ("へ", "e"), ("で", "de"), ("と", "to"), ("も", "mo"),
    ("の", "no"), ("や", "ya"), ("か", "ka"), ("ね", "ne"), ("よ", "yo"), ("さ", "sa"), ("ぞ", "zo"), ("ぜ", "ze"),
]
# 这些「助词」作为读音时的写法（は/へ/を 读 wa/e/o，但读音假名仍写 は/へ/を）
RE_KANJI = re.compile(r"[㐀-鿿豈-﫿々〆ヶ]")
RE_KANA = re.compile(r"^[ぁ-ゖァ-ヺー]+$")
RE_LATIN = re.compile(r"^[\x20-\x7e]+$")


def _hira(s: str) -> str:
    return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in s or "")


def _strip_romaji(r: str, pr: str) -> str:
    r = (r or "").strip()
    if r.endswith(" " + pr):
        return r[: -len(pr) - 1].strip()
    if r.endswith(pr) and len(r) > len(pr):
        return r[: -len(pr)].strip()
    return r


def strip_particles(t: str, k: str, r: str) -> tuple[str, str, str]:
    """去掉词尾助词（最多两层），词面与读音都必须以该助词结尾才去掉。"""
    for _ in range(2):
        for p, pr in PARTICLES:
            if not t.endswith(p) or len(t) <= len(p):
                continue
            core = t[: -len(p)]
            kh = _hira(k)
            if k and not kh.endswith(p):
                continue
            # 剩下的部分要像一个词：有汉字 / 片假名，或至少两个假名
            if not (RE_KANJI.search(core) or re.search(r"[ァ-ヺ]", core) or len(core) >= 2):
                continue
            t = core
            k = k[: -len(p)] if k else k
            r = _strip_romaji(r, pr)
            break
        else:
            break
    return t, k, r


def build_vocab(song_id: str | None = None, max_examples: int = 3) -> list[dict]:
    notes = storage.get_vocab_notes()
    entries: dict[str, dict] = {}
    for sid, title, lid, text, zh, words, edited in storage.iter_song_lines(song_id):
        if not isinstance(words, list):
            continue
        for w in words:
            if not isinstance(w, dict) or w.get("p"):
                continue
            t0 = str(w.get("t") or "").strip()
            if not t0 or RE_LATIN.match(t0):
                continue
            t, k, r = strip_particles(t0, str(w.get("k") or ""), str(w.get("r") or ""))
            if not t or (RE_KANA.match(t) and len(t) < 2):
                continue
            e = entries.get(t)
            if e is None:
                e = entries[t] = {"t": t, "k": k, "r": r, "forms": [], "count": 0, "songs": [], "examples": [],
                                  "readings": {}}
            e["count"] += 1
            if k:
                e["readings"][k] = e["readings"].get(k, 0) + 1
                if edited and not e.get("_edited"):
                    # 用户手动编辑过的行优先：单词本读音跟随编辑
                    e["k"], e["r"], e["_edited"] = k, r, True
            if t0 != t and t0 not in e["forms"] and len(e["forms"]) < 6:
                e["forms"].append(t0)
            if not any(s["id"] == sid for s in e["songs"]):
                e["songs"].append({"id": sid, "title": title})
            if len(e["examples"]) < max_examples and not any(x["text"] == text for x in e["examples"]):
                e["examples"].append({"songId": sid, "lineId": lid, "text": text, "zh": zh, "form": t0})
    out = []
    for t, e in entries.items():
        readings = e.pop("readings")
        e["edited"] = bool(e.pop("_edited", False))
        if readings and not e["k"]:
            e["k"] = max(readings, key=readings.get)
        e["altReadings"] = [k for k in readings if k != e["k"]]
        n = notes.get(t) or {}
        e.update({"meaning": n.get("meaning", ""), "meaningSource": n.get("source", ""),
                  "note": n.get("note", ""), "starred": bool(n.get("starred"))})
        out.append(e)
    return out
