"""JP Lyrics Studio —— FastAPI 后端。

职责：
  1. 提供静态前端（/ 与 /static/*）
  2. 曲库：歌曲元数据、音频文件、歌词行（含分词/读音/标记）的持久化与编辑历史（SQLite，见 storage.py）
  3. 联网歌词搜索的服务端转发（见 online.py）

启动：python run.py   （默认 http://127.0.0.1:8765）
"""
from __future__ import annotations

import asyncio
import copy
import mimetypes
import re
import secrets
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import quote

from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from . import lrc as lrcmod
from . import online, storage, vocab

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"

# Windows 注册表可能把 .js 映射成 text/plain，导致浏览器拒绝加载 ES Module
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")

# 允许前端 PATCH 的行字段（其余字段一律忽略，防止脏数据）
LINE_FIELDS = {"time", "end", "text", "zh", "words", "wordsEdited", "romaji", "ruby", "wordTiming", "focus"}
SONG_FIELDS = {"title", "artist", "album", "offset", "timeline", "duration", "syncInfo"}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    storage.init()
    yield
    await online.close()
    storage.close()


app = FastAPI(title="JP Lyrics Studio", lifespan=lifespan)


class CachedStatic(StaticFiles):
    """词典文件体积大且永不变化：给长缓存；.gz 以原始字节下发（kuromoji 自己解压）。"""

    async def get_response(self, path: str, scope):  # type: ignore[override]
        resp = await super().get_response(path, scope)
        if path.startswith("dict/"):
            resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
            resp.headers["Content-Type"] = "application/octet-stream"
            if "content-encoding" in resp.headers:
                del resp.headers["content-encoding"]
        elif path.startswith("lib/"):
            resp.headers["Cache-Control"] = "public, max-age=86400"
        else:
            resp.headers["Cache-Control"] = "no-cache"
        return resp


app.mount("/static", CachedStatic(directory=STATIC), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


@app.exception_handler(KeyError)
async def _not_found(_req: Request, exc: KeyError):
    return JSONResponse({"error": f"未找到：{exc}"}, status_code=404)


@app.exception_handler(online.SourceError)
async def _source_err(_req: Request, exc: online.SourceError):
    return JSONResponse({"error": str(exc)}, status_code=502)


@app.get("/api/health")
def health():
    return {"ok": True, "dataDir": str(storage.DATA_DIR), "db": str(storage.DB_PATH), "proxy": online.PROXY_BASE}


# ------------------------------------------------------------------ settings
@app.get("/api/settings")
def get_settings():
    return storage.get_settings()


@app.put("/api/settings")
def put_settings(patch: dict = Body(...)):
    return storage.put_settings(patch)


# ---------------------------------------------------------------- dictionary
@app.get("/api/dictionary")
def get_dictionary():
    return storage.get_dictionary()


@app.put("/api/dictionary")
def put_dictionary(payload: dict = Body(...)):
    return storage.put_dictionary_entries(payload.get("entries") or {}, payload.get("remove") or [])


# --------------------------------------------------------------------- songs
@app.get("/api/songs")
def list_songs():
    return storage.list_songs()


def _guess_meta_from_filename(name: str) -> tuple[str, str]:
    stem = re.sub(r"\.[^.]+$", "", name or "").strip()
    m = re.match(r"^(.+?)\s+-\s+(.+)$", stem)
    if m:
        return m.group(2).strip(), m.group(1).strip()  # 「歌手 - 歌名」
    return stem, ""


@app.post("/api/songs")
async def create_song(
    title: str = Form(""),
    artist: str = Form(""),
    album: str = Form(""),
    lrc: str = Form(""),
    audio: UploadFile | None = File(None),
    lrcFile: UploadFile | None = File(None),
):
    """新建本地歌曲：可同时带音频与 LRC（文件或文本），两者都可缺省后续补充。"""
    text = lrc
    if lrcFile is not None and lrcFile.filename:
        raw = await lrcFile.read()
        text = _decode_text(raw)
    lines, meta, timeline = lrcmod.parse_lrc(text) if text.strip() else ([], {}, "none")
    if not title:
        title = meta.get("ti", "")
    if not artist:
        artist = meta.get("ar", "")
    if (not title) and audio is not None and audio.filename:
        title, guess_artist = _guess_meta_from_filename(audio.filename)
        artist = artist or guess_artist
    if (not title) and lrcFile is not None and lrcFile.filename:
        title, guess_artist = _guess_meta_from_filename(lrcFile.filename)
        artist = artist or guess_artist
    song = storage.create_song(title=title, artist=artist, album=album or meta.get("al", ""),
                               source="local", lines=lines, timeline=timeline)
    if audio is not None and audio.filename:
        try:
            song = await asyncio.to_thread(storage.store_audio, song, audio.file, audio.filename,
                                           audio.content_type or "")
        except ValueError as e:
            storage.delete_song(song["id"])
            raise HTTPException(400, str(e)) from e
    return song


def _decode_text(raw: bytes) -> str:
    for enc in ("utf-8-sig", "utf-16", "gb18030", "shift_jis"):
        try:
            txt = raw.decode(enc)
            if enc == "utf-16" and not raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
                continue
            return txt
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


@app.post("/api/songs/import")
def import_online(payload: dict = Body(...)):
    """从联网来源导入（网易云 / LRCLIB / Marumaru）。同来源同 ID 已存在时直接返回旧条目（保留用户修改）。"""
    source = payload.get("source") or "online"
    source_id = str(payload.get("sourceId") or "")
    existing = storage.find_by_source(source, source_id)
    if existing and not payload.get("force"):
        return {"song": storage.get_song(existing["id"]), "existed": True}
    lines = _normalize_lines(payload.get("lines") or [])
    song = storage.create_song(
        title=payload.get("title") or "", artist=payload.get("artist") or "", album=payload.get("album") or "",
        source=source, source_id=source_id, lines=lines, timeline=payload.get("timeline") or "synced",
        duration=payload.get("duration") or 0,
    )
    return {"song": song, "existed": False}


def _normalize_lines(items: list[dict]) -> list[dict]:
    lines = []
    for it in items:
        text = str(it.get("text") or "").strip()
        if not text:
            continue
        try:
            t = float(it.get("time") or 0)
        except (TypeError, ValueError):
            continue
        ln = lrcmod.make_line(t, text)
        for k in LINE_FIELDS - {"time", "text"}:
            if k in it and it[k] not in (None, ""):
                ln[k] = it[k]
        if it.get("id"):
            ln["id"] = str(it["id"])
        lines.append(ln)
    lrcmod.recompute_ends(lines)
    return lines


@app.put("/api/songs/order")
def set_order(payload: dict = Body(...)):
    """曲库拖拽排序：{ids: [歌曲ID, ...]}（服务端保存，所有设备一致）"""
    storage.set_song_order(list(payload.get("ids") or []))
    return storage.list_songs()


# --------------------------------------------------------------------- vocab
@app.get("/api/vocab")
def get_vocab(song: str = "all"):
    """单词本：song=歌曲ID 或 all（全部歌曲）"""
    if song != "all":
        storage.get_song(song)
    return {"entries": vocab.build_vocab(None if song == "all" else song)}


@app.put("/api/vocab/notes")
def put_vocab_notes(payload: dict = Body(...)):
    """保存释义 / 备注 / 收藏：{items: [{surface, meaning?, source?, note?, starred?, kana?}]}"""
    items = payload.get("items")
    if items is None:
        items = [payload]
    storage.put_vocab_notes([i for i in items if isinstance(i, dict)])
    return {"ok": True}


@app.get("/api/songs/{song_id}")
def get_song(song_id: str):
    song = storage.get_song(song_id)
    song["lastOpenedAt"] = storage.touch_opened(song_id)
    return song


@app.patch("/api/songs/{song_id}")
def patch_song(song_id: str, patch: dict = Body(...)):
    song = storage.get_song(song_id)
    for k, v in patch.items():
        if k in SONG_FIELDS:
            song[k] = v
    return storage.save_song(song)


@app.delete("/api/songs/{song_id}")
def delete_song(song_id: str):
    storage.get_song(song_id)
    storage.delete_song(song_id)
    return {"ok": True}


# --------------------------------------------------------------------- audio
@app.put("/api/songs/{song_id}/audio")
async def put_audio(song_id: str, audio: UploadFile = File(...)):
    song = storage.get_song(song_id)
    try:
        return await asyncio.to_thread(storage.store_audio, song, audio.file, audio.filename or "audio",
                                       audio.content_type or "")
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.delete("/api/songs/{song_id}/audio")
def delete_audio(song_id: str):
    return storage.remove_audio(storage.get_song(song_id))


@app.get("/api/songs/{song_id}/audio")
def get_audio(song_id: str):
    song = storage.get_song(song_id)
    p = storage.audio_path(song)
    if not p:
        raise HTTPException(404, "该歌曲还没有音频")
    # FileResponse 支持 Range 请求，音频可拖动进度
    return FileResponse(p, media_type=song["audio"]["mime"], headers={"Cache-Control": "no-cache"})


# --------------------------------------------------------------------- cover
@app.get("/api/songs/{song_id}/cover")
def get_cover(song_id: str):
    song = storage.get_song(song_id)
    p = storage.cover_path(song)
    if not p:
        raise HTTPException(404, "没有封面")
    # URL 带版本号（?v=coverVersion），可以长期缓存
    return FileResponse(p, media_type=song["cover"]["mime"], headers={"Cache-Control": "public, max-age=31536000"})


@app.put("/api/songs/{song_id}/cover")
async def put_cover(song_id: str, image: UploadFile = File(...), source: str = Form("user")):
    """上传封面（手动选择图片，或 NCM 在浏览器还原时取出的封面：source=ncm）"""
    song = storage.get_song(song_id)
    data = await image.read()
    try:
        storage.set_cover(song, data, image.content_type or "", source if source in ("user", "ncm") else "user")
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"cover": song["cover"], "coverVersion": storage.cover_version(song["cover"])}


@app.delete("/api/songs/{song_id}/cover")
def delete_cover(song_id: str):
    storage.remove_cover(storage.get_song(song_id))
    return {"ok": True}


@app.post("/api/songs/{song_id}/cover/fetch")
async def fetch_cover(song_id: str):
    """按歌名 / 歌手联网查找封面（网易云 → iTunes）"""
    song = storage.get_song(song_id)
    found = await online.fetch_cover(song.get("title") or "", song.get("artist") or "")
    if not found:
        raise HTTPException(404, "没有找到封面（可在歌曲信息里手动上传图片）")
    storage.set_cover(song, found[0], found[1], "online")
    return {"cover": song["cover"], "coverVersion": storage.cover_version(song["cover"]), "source": found[2]}


# ---------------------------------------------------------------- categories
@app.get("/api/categories")
def list_categories():
    return storage.list_categories()


@app.post("/api/categories")
def create_category(payload: dict = Body(...)):
    try:
        return storage.create_category(payload.get("name") or "")
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.put("/api/categories/order")
def order_categories(payload: dict = Body(...)):
    storage.set_category_order(list(payload.get("ids") or []))
    return storage.list_categories()


@app.patch("/api/categories/{cid}")
def rename_category(cid: str, payload: dict = Body(...)):
    try:
        storage.rename_category(cid, payload.get("name") or "")
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return storage.list_categories()


@app.delete("/api/categories/{cid}")
def delete_category(cid: str):
    storage.delete_category(cid)
    return storage.list_categories()


@app.post("/api/categories/{cid}/songs")
def add_to_category(cid: str, payload: dict = Body(...)):
    """把歌加入分类：{songIds: [...]}（拖到分类上 / 批量）"""
    for sid in payload.get("songIds") or []:
        storage.get_song(sid)
        storage.add_song_to_category(sid, cid)
    return storage.list_categories()


@app.delete("/api/categories/{cid}/songs/{song_id}")
def remove_from_category(cid: str, song_id: str):
    storage.remove_song_from_category(song_id, cid)
    return storage.list_categories()


@app.put("/api/songs/{song_id}/categories")
def set_song_categories(song_id: str, payload: dict = Body(...)):
    """设置歌曲所属的分类（覆盖）：{ids: [...]}"""
    storage.get_song(song_id)
    return {"categories": storage.set_song_categories(song_id, list(payload.get("ids") or []))}


# --------------------------------------------------------------------- lines
def _line_summary(before: dict | None, after: dict) -> str:
    parts = []
    if before is None:
        return "新增行"
    if before.get("text") != after.get("text"):
        parts.append("原文")
    if _words_sig(before) != _words_sig(after):
        bw = [w.get("t", "") for w in (before.get("words") or [])]
        aw = [w.get("t", "") for w in (after.get("words") or [])]
        if bw != aw:
            parts.append("分词")
        else:
            parts.append("读音/标记")
    if before.get("romaji") != after.get("romaji"):
        parts.append("罗马音")
    if before.get("zh") != after.get("zh"):
        parts.append("中文")
    if before.get("time") != after.get("time"):
        parts.append("时间")
    return "、".join(parts) or "无变化"


def _words_sig(line: dict) -> list:
    return [(w.get("t"), w.get("k"), w.get("r"), w.get("m")) for w in (line.get("words") or [])]


@app.put("/api/songs/{song_id}/lines")
def patch_lines(song_id: str, payload: dict = Body(...)):
    """按行 ID 局部更新歌词行。

    payload = {
      lines:  [{id, ...要修改的字段}],
      record: bool          # true = 用户编辑，写入历史；false = 自动分析回写，不记历史
      kind:   "edit" | "merge" | "split" | "mark" | ...（仅用于历史展示）
      note:   "可选的历史备注"
    }
    """
    song = storage.get_song(song_id)
    by_id = {ln["id"]: ln for ln in song.get("lines", [])}
    record = bool(payload.get("record"))
    kind = payload.get("kind") or "edit"
    note = payload.get("note") or ""
    hist = []
    changed = []
    time_changed = False
    for patch in payload.get("lines") or []:
        ln = by_id.get(patch.get("id"))
        if not ln:
            continue
        before = copy.deepcopy(ln)
        for k, v in patch.items():
            if k in LINE_FIELDS:
                ln[k] = v
                if k == "time":
                    time_changed = True
        if before != ln:
            changed.append(ln)
            if record:
                summary = _line_summary(before, ln)
                hist.append({"lineId": ln["id"], "kind": kind,
                             "summary": f"{summary}{'：' + note if note else ''}",
                             "before": before, "after": copy.deepcopy(ln)})
    if len(hist) > 1:
        # 同一次操作（如同步到副歌的多行）归为一组，撤销时一起恢复
        group = "g_" + secrets.token_hex(4)
        for e in hist:
            e["group"] = group
    if time_changed:
        lrcmod.recompute_ends(song["lines"])
    if changed:
        storage.save_song(song)
        storage.add_history(song_id, hist)
    return {"updated": [ln["id"] for ln in changed], "lines": changed if not time_changed else song["lines"],
            "resorted": time_changed}


@app.post("/api/songs/{song_id}/lyrics")
def replace_lyrics(song_id: str, payload: dict = Body(...)):
    """整体替换歌词（全文编辑 / 绑定联网歌词 / 补传 LRC）。

    payload = { lrc?: str, lines?: [...], timeline?: str, keepEdits: bool(默认 true), note?: str,
                source?/sourceId?（绑定联网歌词时记录来源） }
    keepEdits：新旧行按原文匹配，原文未变的行保留分词/读音/标记/中文与行 ID。
    """
    song = storage.get_song(song_id)
    if payload.get("lrc") is not None:
        new_lines, meta, timeline = lrcmod.parse_lrc(payload["lrc"])
    else:
        new_lines = _normalize_lines(payload.get("lines") or [])
        timeline = payload.get("timeline") or ("synced" if new_lines else "none")
    if payload.get("timeline"):
        timeline = payload["timeline"]
    if payload.get("keepEdits", True) and song.get("lines"):
        pool: dict[str, list[dict]] = {}
        for old in song["lines"]:
            pool.setdefault(_norm(old["text"]), []).append(old)
        used_ids = set()
        for ln in new_lines:
            cands = pool.get(_norm(ln["text"])) or []
            old = next((c for c in cands if c["id"] not in used_ids), None)
            if old is None and cands:
                old = cands[0]
            if not old:
                continue
            if old["id"] not in used_ids:
                ln["id"] = old["id"]
                used_ids.add(old["id"])
            for k in ("words", "wordsEdited", "romaji", "ruby", "focus"):
                if ln.get(k) in (None, False, "") and old.get(k) not in (None, False, ""):
                    ln[k] = copy.deepcopy(old[k])
            if not ln.get("zh") and old.get("zh"):
                ln["zh"] = old["zh"]
            if not ln.get("wordTiming") and old.get("wordTiming") and abs(old["time"] - ln["time"]) < 0.5:
                ln["wordTiming"] = old["wordTiming"]
    snap = storage.snapshot_lines(song) if song.get("lines") else None
    song["lines"] = new_lines
    song["timeline"] = timeline if new_lines else "none"
    song["syncInfo"] = None  # 歌词变了：允许重新自动获取逐字时间轴
    if payload.get("source"):
        song["lyricSource"] = {"source": payload.get("source"), "sourceId": str(payload.get("sourceId") or "")}
    storage.save_song(song)
    storage.add_history(song_id, [{
        "lineId": None, "kind": "lyrics", "summary": payload.get("note") or f"替换歌词（{len(new_lines)} 行）",
        "snapshot": snap,
    }])
    return song


def _norm(s: str) -> str:
    return re.sub(r"[\s　「」『』“”\"'’‘.,，。！？!?…・･♪\-－—–~〜]+", "", s or "").lower()


@app.get("/api/songs/{song_id}/history")
def get_history(song_id: str):
    storage.get_song(song_id)
    return storage.get_history(song_id)


@app.post("/api/songs/{song_id}/history/{hid}/revert")
def revert_history(song_id: str, hid: str):
    """把某条历史恢复到修改前：行级 → 还原该行；全文级 → 还原整首快照。"""
    song = storage.get_song(song_id)
    entry = storage.get_history_entry(song_id, hid)
    if not entry:
        raise HTTPException(404, "历史记录不存在")
    if entry.get("kind") == "lyrics" or entry.get("lineId") is None:
        snap = storage.load_snapshot(song_id, entry.get("snapshot") or "")
        if not snap:
            raise HTTPException(400, "这条记录没有可恢复的快照")
        new_snap = storage.snapshot_lines(song)
        song["lines"] = snap.get("lines", [])
        song["timeline"] = snap.get("timeline") or song.get("timeline")
        storage.save_song(song)
        storage.add_history(song_id, [{"lineId": None, "kind": "lyrics",
                                       "summary": f"撤销：{entry.get('summary', '')}", "snapshot": new_snap}])
        return song
    group = entry.get("group")
    entries = [entry]
    if group:
        entries = storage.get_history_group(song_id, group)
    by_id = {ln["id"]: i for i, ln in enumerate(song["lines"])}
    new_hist = []
    new_group = "g_" + secrets.token_hex(4) if len(entries) > 1 else None
    for e in entries:
        before = e.get("before")
        idx = by_id.get(e.get("lineId"))
        if idx is None or not before:
            continue
        cur = copy.deepcopy(song["lines"][idx])
        song["lines"][idx] = before
        new_hist.append({"lineId": before["id"], "kind": "revert", "summary": f"撤销：{e.get('summary', '')}",
                         "before": cur, "after": copy.deepcopy(before), "group": new_group})
    if not new_hist:
        raise HTTPException(400, "该行已不存在（可能已被全文编辑替换）")
    lrcmod.recompute_ends(song["lines"])
    storage.save_song(song)
    storage.add_history(song_id, new_hist)
    return song


@app.get("/api/songs/{song_id}/export.lrc")
def export_lrc(song_id: str, zh: int = 0):
    song = storage.get_song(song_id)
    text = lrcmod.build_lrc(song.get("lines", []), {"title": song.get("title"), "artist": song.get("artist")},
                            with_zh=bool(zh))
    fname = re.sub(r'[\\/:*?"<>|]+', "_", f"{song.get('artist', '')} - {song.get('title', '')}".strip(" -")) or "lyrics"
    return PlainTextResponse(text, headers={
        "Content-Disposition": f"attachment; filename*=UTF-8''{_quote(fname)}.lrc"})


def _quote(s: str) -> str:
    return quote(s)


@app.post("/api/lrc/parse")
def parse_lrc(payload: dict = Body(...)):
    lines, meta, timeline = lrcmod.parse_lrc(payload.get("lrc") or "")
    return {"lines": lines, "meta": meta, "timeline": timeline}


# -------------------------------------------------------------------- online
@app.get("/api/online/netease/search")
async def ne_search(q: str, limit: int = 8):
    return {"query": q, "results": await online.netease_search(q, limit)}


@app.get("/api/online/netease/lyric")
async def ne_lyric(id: str):  # noqa: A002
    return await online.netease_lyric(id)


@app.get("/api/online/lrclib/search")
async def lrclib_search(q: str):
    return {"query": q, "results": await online.lrclib_search(q)}


@app.get("/api/online/marumaru/search")
async def mm_search(title: str, artist: str = ""):
    return {"results": await online.marumaru_search(title, artist)}


@app.get("/api/online/marumaru/lyric")
async def mm_lyric(url: str):
    return await online.marumaru_lyric(url)


@app.get("/api/online/petit")
async def petit(title: str, artist: str = ""):
    return {"lines": await online.petit_word_timing(title, artist)}


@app.post("/api/online/translate")
async def translate(payload: dict = Body(...)):
    texts: list[str] = [str(t) for t in (payload.get("texts") or [])][:200]
    out: list[str] = []
    for t in texts:
        try:
            out.append(await online.translate_ja_zh(t) if t.strip() else "")
        except Exception:  # noqa: BLE001
            out.append("")
        await asyncio.sleep(0.15)
    return {"results": out}
