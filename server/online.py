"""联网歌词来源（全部由后端转发，前端不再直连第三方，避免 CORS / 混合内容问题）。

来源：
  * 网易云：优先走原项目部署的 Cloudflare Worker（JLS_PROXY_BASE，返回已归一化的 JSON，
    含逐字时间轴）；Worker 不可用时回落到网易云公开接口直连解析（lrc / tlyric / romalrc / yrc）。
  * LRCLIB：https://lrclib.net/api/search （分两波检索，与原前端策略一致）
  * Marumaru：仅经 Worker（站点 HTML 解析逻辑在 Worker 内）
  * PetitLyrics：逐字时间轴补充
  * MyMemory：日→中机器翻译

统一网易云歌词结构：
  {id, title, artist, album, duration,
   lines: [{time(秒), duration(秒|None), text, zh, romaji, wordTiming:[{starttime,endtime,text}](毫秒)|None}]}
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import time
import xml.etree.ElementTree as ET
from urllib.parse import quote

import httpx

PROXY_BASE = os.environ.get("JLS_PROXY_BASE", "https://jp-lyrics-proxy.nepqaq.workers.dev").rstrip("/")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

_client: httpx.AsyncClient | None = None


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=8.0),
                                    headers={"User-Agent": UA}, follow_redirects=True)
    return _client


async def close() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


class SourceError(Exception):
    pass


def _stamp() -> str:
    return f"{int(time.time() * 1000):x}"


async def _proxy_json(path: str, timeout: float = 15.0) -> dict:
    if not PROXY_BASE:
        raise SourceError("未配置歌词代理（JLS_PROXY_BASE）")
    r = await client().get(PROXY_BASE + path, timeout=timeout, headers={"Cache-Control": "no-cache"})
    try:
        data = r.json()
    except ValueError:
        data = None
    if r.status_code >= 400:
        msg = (data or {}).get("error", {}).get("message") if isinstance(data, dict) else None
        raise SourceError(msg or f"代理 HTTP {r.status_code}")
    return data or {}


# ================================================================ 网易云
async def netease_search(q: str, limit: int = 8) -> list[dict]:
    errors = []
    try:
        data = await _proxy_json(f"/api/search/{quote(q, safe='')}?limit={limit}&_t={_stamp()}", 10)
        if str(data.get("query", "")).strip().lower() == q.strip().lower() or "query" not in data:
            res = data.get("results") or []
            if isinstance(res, list):
                return res[:limit]
        errors.append("代理返回结果与关键词不一致")
    except Exception as e:  # noqa: BLE001
        errors.append(f"代理：{e}")
    try:
        return await _netease_search_direct(q, limit)
    except Exception as e:  # noqa: BLE001
        errors.append(f"直连：{e}")
    raise SourceError("；".join(errors))


async def _netease_search_direct(q: str, limit: int) -> list[dict]:
    r = await client().post(
        "https://music.163.com/api/search/get/web",
        data={"s": q, "type": 1, "limit": limit, "offset": 0},
        headers={"Referer": "https://music.163.com/"},
    )
    r.raise_for_status()
    songs = (r.json().get("result") or {}).get("songs") or []
    return [{
        "id": s.get("id"),
        "title": s.get("name", ""),
        "artist": " / ".join(a.get("name", "") for a in s.get("artists") or []),
        "album": (s.get("album") or {}).get("name", ""),
        "duration": s.get("duration", 0),
    } for s in songs]


async def netease_lyric(song_id: str) -> dict:
    errors = []
    try:
        data = await _proxy_json(f"/api/lyric?id={quote(str(song_id))}", 15)
        if isinstance(data.get("lines"), list) and data["lines"]:
            return data
        errors.append("代理未返回歌词")
    except Exception as e:  # noqa: BLE001
        errors.append(f"代理：{e}")
    try:
        return await _netease_lyric_direct(song_id)
    except Exception as e:  # noqa: BLE001
        errors.append(f"直连：{e}")
    raise SourceError("；".join(errors))


_LRC_TAG = re.compile(r"\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]")


def _parse_simple_lrc(text: str) -> list[tuple[float, str]]:
    out = []
    for raw in (text or "").splitlines():
        if raw.startswith("{"):
            continue  # 网易云的 JSON 元数据行（作词/作曲）
        stamps = []
        for m in _LRC_TAG.finditer(raw):
            frac = m.group(3)
            stamps.append(int(m.group(1)) * 60 + int(m.group(2)) + (int(frac.ljust(3, "0")[:3]) / 1000 if frac else 0))
        content = _LRC_TAG.sub("", raw).strip()
        for t in stamps:
            out.append((round(t, 3), content))
    out.sort(key=lambda x: x[0])
    return out


_YRC_LINE = re.compile(r"^\[(\d+),(\d+)\](.*)$")
_YRC_META = re.compile(r"\((\d+),(\d+),(\d+)\)")


def _parse_yrc(text: str) -> list[dict]:
    """网易云 yrc 逐字歌词：[行开始ms,行时长ms](字开始ms,字时长ms,0)文字…（与原 Worker 解析一致）"""
    lines = []
    for raw in (text or "").splitlines():
        m = _YRC_LINE.match(raw.strip())
        if not m:
            continue
        start, dur, body = int(m.group(1)), int(m.group(2)), m.group(3)
        metas = list(_YRC_META.finditer(body))
        words = []
        for i, meta in enumerate(metas):
            chunk = body[meta.end(): metas[i + 1].start() if i + 1 < len(metas) else len(body)]
            if chunk:
                st = int(meta.group(1))
                words.append({"starttime": st, "endtime": st + int(meta.group(2)), "text": chunk})
        text_ = "".join(w["text"] for w in words).strip() if metas else body.strip()
        if text_:
            lines.append({"start": start, "dur": dur, "text": text_, "words": words})
    return lines


def _nearest(pairs: list[tuple[float, str]], t: float, tol: float = 0.6) -> str:
    best, gap = "", tol
    for tt, txt in pairs:
        d = abs(tt - t)
        if d <= gap and txt:
            best, gap = txt, d
    return best


async def _netease_lyric_direct(song_id: str) -> dict:
    headers = {"Referer": "https://music.163.com/"}
    r = await client().get(
        f"https://music.163.com/api/song/lyric?os=pc&id={quote(str(song_id))}&lv=-1&tv=-1&rv=-1&yv=-1",
        headers=headers)
    r.raise_for_status()
    j = r.json()
    lrc = _parse_simple_lrc((j.get("lrc") or {}).get("lyric", ""))
    tl = _parse_simple_lrc((j.get("ytlrc") or {}).get("lyric", "") or (j.get("tlyric") or {}).get("lyric", ""))
    ro = _parse_simple_lrc((j.get("yromalrc") or {}).get("lyric", "") or (j.get("romalrc") or {}).get("lyric", ""))
    yrc = _parse_yrc((j.get("yrc") or {}).get("lyric", ""))
    lines = []
    if yrc:
        for y in yrc:
            if not y["text"]:
                continue
            t = y["start"] / 1000
            lines.append({"time": t, "duration": y["dur"] / 1000, "text": y["text"],
                          "zh": _nearest(tl, t), "romaji": _nearest(ro, t), "wordTiming": y["words"] or None})
    else:
        for i, (t, txt) in enumerate(lrc):
            if not txt:
                continue
            nxt = next((tt for tt, _ in lrc[i + 1:] if tt > t), None)
            lines.append({"time": t, "duration": (nxt - t) if nxt else None, "text": txt,
                          "zh": _nearest(tl, t, 0.05), "romaji": _nearest(ro, t, 0.05), "wordTiming": None})
    meta = {"title": "", "artist": "", "album": "", "duration": 0}
    try:
        d = await client().get(f"https://music.163.com/api/song/detail/?ids=[{quote(str(song_id))}]", headers=headers)
        s = (d.json().get("songs") or [{}])[0]
        meta = {"title": s.get("name", ""), "artist": " / ".join(a.get("name", "") for a in s.get("artists") or []),
                "album": (s.get("album") or {}).get("name", ""), "duration": s.get("duration", 0)}
    except Exception:  # noqa: BLE001
        pass
    if not lines:
        raise SourceError("该歌曲没有歌词")
    return {"id": song_id, **meta, "lines": lines}


# ================================================================ LRCLIB
async def _lrclib(params: dict) -> list[dict]:
    clean = {k: v for k, v in params.items() if v}
    for attempt in range(2):
        try:
            r = await client().get("https://lrclib.net/api/search", params=clean, timeout=9,
                                   headers={"Lrclib-Client": "jp-lyrics-studio"})
            if r.status_code in (429, 503):
                await asyncio.sleep(0.5)
                continue
            if r.status_code >= 400:
                return []
            data = r.json()
            return data if isinstance(data, list) else []
        except Exception:  # noqa: BLE001
            if attempt == 0:
                await asyncio.sleep(0.5)
    return []


async def lrclib_search(q: str) -> list[dict]:
    waves = [[{"q": q}, {"track_name": q}]]
    tokens = q.split()
    if len(tokens) >= 2:
        second = [{"track_name": " ".join(tokens[:-1]), "artist_name": tokens[-1]}]
        if " ".join(tokens[1:]) != " ".join(tokens[:-1]):
            second.append({"track_name": " ".join(tokens[1:]), "artist_name": tokens[0]})
        waves.append(second)
    seen, out = set(), []
    for wave in waves:
        results = await asyncio.gather(*[_lrclib(p) for p in wave])
        for lst in results:
            for item in lst:
                if item.get("id") in seen:
                    continue
                seen.add(item.get("id"))
                out.append(item)
        if len(out) >= 5:
            break
    # 有同步歌词的排前面
    out.sort(key=lambda x: 0 if x.get("syncedLyrics") else 1)
    return out[:20]


# ================================================================ Marumaru（经 Worker）
async def marumaru_search(title: str, artist: str = "") -> list[dict]:
    queries = [q for q in dict.fromkeys([title.strip(), artist.strip()]) if q]
    for q in queries:
        data = await _proxy_json(f"/api/marumaru/search/{quote(q, safe='')}?_t={_stamp()}", 25)
        items = data.get("results") or []
        if not items:
            continue
        if artist:
            al = artist.lower()
            items.sort(key=lambda it: 0 if al in f"{it.get('title', '')} {it.get('artist', '')}".lower() else 1)
        return items[:10]
    return []


async def marumaru_lyric(url: str) -> dict:
    data = await _proxy_json(f"/api/marumaru/lyric?url={quote(url, safe='')}", 25)
    if not isinstance(data.get("lines"), list) or not data["lines"]:
        raise SourceError("Marumaru 页面未能解析出歌词")
    return data


# ================================================================ PetitLyrics 逐字时间轴
async def petit_word_timing(title: str, artist: str = "") -> list[dict]:
    clean_artist = re.split(r"[,/&]| feat\.? ", artist or "", flags=re.I)[0].strip()
    for key_artist in dict.fromkeys([clean_artist, ""]):
        form = {"clientAppId": "p1110417", "lyricsType": "3", "terminalType": "10", "key_title": title}
        if key_artist:
            form["key_artist"] = key_artist
        try:
            r = await client().post("https://p0.petitlyrics.com/api/GetPetitLyricsData.php", data=form, timeout=12)
            if r.status_code >= 400:
                continue
            root = ET.fromstring(r.content)
            ltype = root.findtext(".//lyricsType")
            ldata = root.findtext(".//lyricsData")
            if ltype != "3" or not ldata:
                continue
            inner = ET.fromstring(base64.b64decode(ldata).decode("utf-8"))
            lines = []
            for line in inner.iter("line"):
                words = []
                for w in line.iter("word"):
                    txt = w.findtext("wordstring") or ""
                    if txt:
                        words.append({"starttime": int(w.findtext("starttime") or 0),
                                      "endtime": int(w.findtext("endtime") or 0), "text": txt})
                text = line.findtext("linestring") or ""
                if text or words:
                    lines.append({"text": text, "words": words})
            if lines:
                return lines
        except Exception:  # noqa: BLE001
            continue
    return []


# ================================================================ 翻译
async def translate_ja_zh(text: str) -> str:
    r = await client().get("https://api.mymemory.translated.net/get",
                           params={"q": text, "langpair": "ja|zh-CN"}, timeout=12)
    r.raise_for_status()
    return ((r.json() or {}).get("responseData") or {}).get("translatedText", "") or ""


def dumps(obj) -> str:  # 调试用
    return json.dumps(obj, ensure_ascii=False)
