"""SQLite 存储（Python 标准库 sqlite3，无需额外依赖）。

数据目录（DATA_DIR，默认项目根目录下的 data/，已在 .gitignore 中忽略）：
    data/
      studio.db                # SQLite 数据库：设置、词典、歌曲、歌词行、编辑历史、整首快照
      audio/<song_id>.<ext>    # 上传的音频（体积大，且需要 HTTP Range 拖动进度，所以仍存文件）

表结构（见 SCHEMA）：
    settings   (key, value JSON)
    dictionary (surface, kana, romaji, fixed, updated_at)
    songs      (id, title, artist, ..., audio JSON, sync_info JSON, lyric_source JSON)
    lines      (song_id, id, pos, time, end_time, text, zh, words JSON, words_edited, romaji, ruby, word_timing JSON)
    history    (id, song_id, ts, line_id, kind, summary, before JSON, after JSON, grp, snapshot)
    snapshots  (id, song_id, created_at, timeline, lines JSON)

对外接口保持「整首歌一个 dict」的形式（与前端 / song.json 时代完全一致），
app.py 不直接接触 SQL。旧版 JSON 文件存储（data/songs/*/song.json）在首次启动时自动迁移。
"""
from __future__ import annotations

import json
import os
import secrets
import shutil
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

from . import lrc as lrcmod

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("JLS_DATA_DIR", ROOT / "data")).resolve()
DB_PATH = DATA_DIR / "studio.db"
AUDIO_DIR = DATA_DIR / "audio"
COVER_DIR = DATA_DIR / "covers"
SCHEMA_VERSION = 3  # v2：songs.sort_order、vocab_notes；v3：songs.cover / cover_checked（封面）、categories（分类）

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None

AUDIO_EXT = {
    "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a",
    "audio/aac": "aac", "audio/flac": "flac", "audio/x-flac": "flac", "audio/ogg": "ogg",
    "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/webm": "webm",
    "audio/opus": "opus",
}
EXT_MIME = {
    "mp3": "audio/mpeg", "m4a": "audio/mp4", "mp4": "audio/mp4", "aac": "audio/aac",
    "flac": "audio/flac", "ogg": "audio/ogg", "oga": "audio/ogg", "opus": "audio/ogg",
    "wav": "audio/wav", "webm": "audio/webm",
}

DEFAULT_SETTINGS: dict[str, Any] = {
    "theme": "auto",            # auto | light | dark
    "layout": "stack",          # stack（原文/罗马音/中文分行） | inline（逐词对照）
    "wordStyle": "box",         # none | box（边框） | tint（交替底色） | underline
    "wordStyleLongOnly": False,  # 仅对长句启用单词样式
    "longLineChars": 14,
    "showFurigana": True,
    "showRomaji": True,
    "showZh": True,
    "kanaScript": "hiragana",   # 注音显示：hiragana | katakana
    "playbackRate": 1.0,
    "preservePitch": True,
    "applySameLines": True,     # 编辑一行时同步到本曲相同歌词行
    "linePlayMode": "single",   # 行内 ▶ 按钮：single 只播这一句后停止 | continue 从这一句开始继续往下播
    "fontScale": 1.0,
    # 同步 / 单句播放
    "estimateSungEnd": True,    # 无逐字时间轴时按假名音拍估算句尾（避免把间奏/下一句算进本句）
    "segLead": 0.15,            # 单句播放提前开始（秒）
    "segTrim": 0.2,             # 单句播放在下一句开始前提前结束（秒）
    "autoWordTiming": True,     # 打开没有逐字时间轴的歌曲时，自动从网易云 / PetitLyrics 获取
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                -- JSON
);
CREATE TABLE IF NOT EXISTS dictionary (
  surface    TEXT PRIMARY KEY,
  kana       TEXT NOT NULL DEFAULT '',
  romaji     TEXT NOT NULL DEFAULT '',
  fixed      INTEGER NOT NULL DEFAULT 1,
  updated_at REAL
);
CREATE TABLE IF NOT EXISTS songs (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL DEFAULT '',
  artist         TEXT NOT NULL DEFAULT '',
  album          TEXT NOT NULL DEFAULT '',
  source         TEXT NOT NULL DEFAULT 'local',
  source_id      TEXT NOT NULL DEFAULT '',
  duration       REAL NOT NULL DEFAULT 0,
  timeline       TEXT NOT NULL DEFAULT 'none',   -- synced | synthetic | none
  offset_sec     REAL NOT NULL DEFAULT 0,
  audio          TEXT,                           -- JSON {file, mime, size, name}
  sync_info      TEXT,                           -- JSON
  lyric_source   TEXT,                           -- JSON
  created_at     REAL,
  updated_at     REAL,
  last_opened_at REAL,
  sort_order     REAL,                           -- 曲库手动排序（小的在前），v2 新增
  cover          TEXT,                           -- JSON {file, mime, size, source: embedded|ncm|user|online, updatedAt}，v3
  cover_checked  INTEGER NOT NULL DEFAULT 0      -- 是否已尝试从音频提取内嵌封面，v3
);
CREATE INDEX IF NOT EXISTS idx_songs_source ON songs(source, source_id);
CREATE TABLE IF NOT EXISTS lines (
  song_id      TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  id           TEXT NOT NULL,
  pos          INTEGER NOT NULL,
  time         REAL NOT NULL,
  end_time     REAL,
  text         TEXT NOT NULL,
  zh           TEXT NOT NULL DEFAULT '',
  words        TEXT,                             -- JSON [{t,k,r,p?,m?}]，NULL = 未分析
  words_edited INTEGER NOT NULL DEFAULT 0,
  romaji       TEXT,                             -- 整行罗马音手动覆盖
  ruby         TEXT,                             -- 外部注音 HTML
  word_timing  TEXT,                             -- JSON [{starttime,endtime,text}]
  focus        INTEGER NOT NULL DEFAULT 0,       -- 「关注」的难句（高亮显示，练会后可取消），v3
  PRIMARY KEY (song_id, id)
);
CREATE INDEX IF NOT EXISTS idx_lines_pos ON lines(song_id, pos);
CREATE TABLE IF NOT EXISTS history (
  id       TEXT PRIMARY KEY,
  song_id  TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  ts       REAL NOT NULL,
  line_id  TEXT,
  kind     TEXT NOT NULL,
  summary  TEXT NOT NULL DEFAULT '',
  before   TEXT,                                 -- JSON 行快照
  after    TEXT,                                 -- JSON 行快照
  grp      TEXT,                                 -- 同一次操作的分组
  snapshot TEXT                                  -- snapshots.id（全文级操作）
);
CREATE INDEX IF NOT EXISTS idx_history_song ON history(song_id, ts);
CREATE INDEX IF NOT EXISTS idx_history_grp ON history(grp);
CREATE TABLE IF NOT EXISTS categories (        -- 曲库分类（类似歌单；一首歌可以属于多个分类），v3
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  sort_order REAL NOT NULL DEFAULT 0,
  created_at REAL
);
CREATE TABLE IF NOT EXISTS song_categories (
  song_id     TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  added_at    REAL,
  PRIMARY KEY (song_id, category_id)
);
CREATE INDEX IF NOT EXISTS idx_song_categories_cat ON song_categories(category_id);
CREATE TABLE IF NOT EXISTS vocab_notes (       -- 单词本：释义 / 备注 / 收藏（按词面，跨歌曲共享）
  surface    TEXT PRIMARY KEY,
  kana       TEXT NOT NULL DEFAULT '',
  meaning    TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT '',             -- auto（机器翻译） | user（手动填写，不会被自动翻译覆盖）
  note       TEXT NOT NULL DEFAULT '',
  starred    INTEGER NOT NULL DEFAULT 0,
  updated_at REAL
);
CREATE TABLE IF NOT EXISTS snapshots (
  id         TEXT PRIMARY KEY,
  song_id    TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  created_at REAL NOT NULL,
  timeline   TEXT,
  lines      TEXT NOT NULL                       -- JSON 整首歌词行
);
"""


def _now() -> float:
    return round(time.time(), 3)


def _dumps(v: Any) -> str | None:
    return None if v is None else json.dumps(v, ensure_ascii=False, separators=(",", ":"))


def _loads(s: str | None, default: Any = None) -> Any:
    if s is None or s == "":
        return default
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        return default


def db() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.executescript(SCHEMA)  # 首次连接即建表（幂等）
        _upgrade_schema(conn)
        _conn = conn
    return _conn


def _upgrade_schema(conn: sqlite3.Connection) -> None:
    """已有数据库的结构升级（按 meta.schema_version 逐步执行）。"""
    row = conn.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()
    ver = int(row[0]) if row else 0
    cols = {r[1] for r in conn.execute("PRAGMA table_info(songs)")}
    if "sort_order" not in cols:
        conn.execute("ALTER TABLE songs ADD COLUMN sort_order REAL")
    if "cover" not in cols:
        conn.execute("ALTER TABLE songs ADD COLUMN cover TEXT")
    line_cols = {r[1] for r in conn.execute("PRAGMA table_info(lines)")}
    if "focus" not in line_cols:
        conn.execute("ALTER TABLE lines ADD COLUMN focus INTEGER NOT NULL DEFAULT 0")
    if "cover_checked" not in cols:
        conn.execute("ALTER TABLE songs ADD COLUMN cover_checked INTEGER NOT NULL DEFAULT 0")
    if ver < 2:
        # 初始排序 = 原来的「最近打开在前」
        ids = [r[0] for r in conn.execute(
            "SELECT id FROM songs ORDER BY COALESCE(last_opened_at, updated_at, 0) DESC")]
        for i, sid in enumerate(ids):
            conn.execute("UPDATE songs SET sort_order = ? WHERE id = ? AND sort_order IS NULL", (float(i), sid))
    conn.execute("INSERT INTO meta(key, value) VALUES ('schema_version', ?) "
                 "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (str(SCHEMA_VERSION),))


class _Tx:
    """with _tx() as c: ...  —— 进程内加锁 + SQLite 事务"""

    def __enter__(self) -> sqlite3.Connection:
        _lock.acquire()
        c = db()
        c.execute("BEGIN IMMEDIATE")
        return c

    def __exit__(self, exc_type, exc, tb):
        try:
            db().execute("ROLLBACK" if exc_type else "COMMIT")
        finally:
            _lock.release()
        return False


_tx = _Tx


def _q(sql: str, params: tuple = ()) -> list[sqlite3.Row]:
    """只读查询（与写事务共用同一连接，所以同样加锁）"""
    with _lock:
        return db().execute(sql, params).fetchall()


def _q1(sql: str, params: tuple = ()) -> sqlite3.Row | None:
    with _lock:
        return db().execute(sql, params).fetchone()


def init() -> None:
    with _lock:
        db()
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    _migrate_legacy_json()
    backfill_covers()


def close() -> None:
    global _conn
    with _lock:
        if _conn is not None:
            _conn.close()
            _conn = None


# ---------------------------------------------------------------- settings
def get_settings() -> dict:
    rows = _q("SELECT key, value FROM settings")
    saved = {r["key"]: _loads(r["value"]) for r in rows}
    return {**DEFAULT_SETTINGS, **{k: v for k, v in saved.items() if k in DEFAULT_SETTINGS}}


def put_settings(patch: dict) -> dict:
    with _tx() as c:
        for k, v in patch.items():
            if k in DEFAULT_SETTINGS:
                c.execute("INSERT INTO settings(key, value) VALUES (?, ?) "
                          "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (k, _dumps(v)))
    return get_settings()


# -------------------------------------------------------------- dictionary
def get_dictionary() -> dict:
    rows = _q("SELECT * FROM dictionary ORDER BY updated_at DESC")
    return {r["surface"]: {"k": r["kana"], "r": r["romaji"], "fixed": bool(r["fixed"]), "updatedAt": r["updated_at"]}
            for r in rows}


def put_dictionary_entries(entries: dict, remove: list[str] | None = None) -> dict:
    with _tx() as c:
        for surface, val in (entries or {}).items():
            surface = str(surface).strip()
            if not surface or not isinstance(val, dict):
                continue
            c.execute(
                "INSERT INTO dictionary(surface, kana, romaji, fixed, updated_at) VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(surface) DO UPDATE SET kana = excluded.kana, romaji = excluded.romaji, "
                "fixed = excluded.fixed, updated_at = excluded.updated_at",
                (surface, str(val.get("k") or ""), str(val.get("r") or ""), 1 if val.get("fixed", True) else 0, _now()))
        for surface in remove or []:
            c.execute("DELETE FROM dictionary WHERE surface = ?", (surface,))
    return get_dictionary()


# ------------------------------------------------------------------- songs
_SONG_COLS = {
    # dict 键 -> (列名, 是否 JSON)
    "title": ("title", False), "artist": ("artist", False), "album": ("album", False),
    "source": ("source", False), "sourceId": ("source_id", False), "duration": ("duration", False),
    "timeline": ("timeline", False), "offset": ("offset_sec", False), "audio": ("audio", True),
    "syncInfo": ("sync_info", True), "lyricSource": ("lyric_source", True),
    "createdAt": ("created_at", False), "updatedAt": ("updated_at", False),
    "lastOpenedAt": ("last_opened_at", False),
    "sortOrder": ("sort_order", False),
    "cover": ("cover", True),
}


def _row_to_song(r: sqlite3.Row) -> dict:
    song = {"id": r["id"]}
    for key, (col, is_json) in _SONG_COLS.items():
        song[key] = _loads(r[col]) if is_json else r[col]
    song["sourceId"] = song["sourceId"] or ""
    song["offset"] = song["offset"] or 0.0
    return song


def _row_to_line(r: sqlite3.Row) -> dict:
    return {
        "id": r["id"],
        "time": r["time"],
        "end": r["end_time"],
        "text": r["text"],
        "zh": r["zh"] or "",
        "words": _loads(r["words"]),
        "wordsEdited": bool(r["words_edited"]),
        "romaji": r["romaji"],
        "ruby": r["ruby"],
        "wordTiming": _loads(r["word_timing"]),
        "focus": bool(r["focus"]),
    }


def _line_params(song_id: str, pos: int, ln: dict) -> tuple:
    return (
        song_id, ln["id"], pos, float(ln.get("time") or 0), ln.get("end"), ln.get("text") or "",
        ln.get("zh") or "", _dumps(ln.get("words")), 1 if ln.get("wordsEdited") else 0,
        ln.get("romaji") or None, ln.get("ruby") or None, _dumps(ln.get("wordTiming")), 1 if ln.get("focus") else 0,
    )


_LINE_INSERT = ("INSERT INTO lines(song_id, id, pos, time, end_time, text, zh, words, words_edited, romaji, ruby, word_timing, focus) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")


def list_songs() -> list[dict]:
    rows = _q("""
        SELECT s.*,
               (SELECT COUNT(*) FROM lines l WHERE l.song_id = s.id) AS line_count,
               (SELECT COUNT(*) FROM lines l WHERE l.song_id = s.id
                  AND (l.words_edited = 1 OR l.romaji IS NOT NULL)) AS edited_count
        FROM songs s
        ORDER BY COALESCE(s.sort_order, 0) ASC, s.created_at DESC
    """)
    cats: dict[str, list[str]] = {}
    for r in _q("SELECT song_id, category_id FROM song_categories ORDER BY added_at"):
        cats.setdefault(r["song_id"], []).append(r["category_id"])
    out = []
    for r in rows:
        s = _row_to_song(r)
        out.append({
            "id": s["id"], "title": s["title"], "artist": s["artist"], "album": s["album"],
            "source": s["source"], "sourceId": s["sourceId"], "hasAudio": bool(s["audio"]),
            "timeline": s["timeline"], "lineCount": r["line_count"], "editedCount": r["edited_count"],
            "createdAt": s["createdAt"], "updatedAt": s["updatedAt"], "lastOpenedAt": s["lastOpenedAt"],
            "sortOrder": s["sortOrder"],
            # 音频版本：浏览器本地缓存据此判断是否过期
            "audioVersion": audio_version(s["audio"]), "audioSize": (s["audio"] or {}).get("size", 0),
            "duration": s["duration"] or 0,
            # 封面版本（URL 带上它，图片可长期缓存）；空 = 没有封面
            "coverVersion": cover_version(s["cover"]),
            "categories": cats.get(s["id"], []),
        })
    return out


def get_song(song_id: str) -> dict:
    with _lock:
        r = _q1("SELECT * FROM songs WHERE id = ?", (song_id,))
        if r is None:
            raise KeyError(song_id)
        song = _row_to_song(r)
        song["lines"] = [_row_to_line(x) for x in _q("SELECT * FROM lines WHERE song_id = ? ORDER BY pos", (song_id,))]
    return song


def _write_song(c: sqlite3.Connection, song: dict) -> None:
    cols = ["id"] + [col for col, _ in _SONG_COLS.values()]
    vals = [song["id"]]
    for key, (_col, is_json) in _SONG_COLS.items():
        v = song.get(key)
        if key == "offset":
            v = float(v or 0)
        elif key in ("title", "artist", "album", "source", "sourceId"):
            v = "" if v is None else str(v)
        elif key == "timeline":
            v = v or "none"
        elif key == "duration":
            v = float(v or 0)
        vals.append(_dumps(v) if is_json else v)
    placeholders = ", ".join("?" for _ in cols)
    updates = ", ".join(f"{col} = excluded.{col}" for col in cols[1:])
    c.execute(f"INSERT INTO songs({', '.join(cols)}) VALUES ({placeholders}) "
              f"ON CONFLICT(id) DO UPDATE SET {updates}", vals)
    c.execute("DELETE FROM lines WHERE song_id = ?", (song["id"],))
    seen = set()
    for pos, ln in enumerate(song.get("lines") or []):
        if not ln.get("id") or ln["id"] in seen:
            ln["id"] = lrcmod.new_line_id()
        seen.add(ln["id"])
        c.execute(_LINE_INSERT, _line_params(song["id"], pos, ln))


def save_song(song: dict, touch: bool = True) -> dict:
    """整首写回（歌曲元数据 + 全部歌词行，事务内完成）。"""
    if touch:
        song["updatedAt"] = _now()
    with _tx() as c:
        _write_song(c, song)
    return song


def touch_opened(song_id: str) -> float:
    ts = _now()
    with _tx() as c:
        c.execute("UPDATE songs SET last_opened_at = ? WHERE id = ?", (ts, song_id))
    return ts


def _top_sort_order() -> float:
    r = _q1("SELECT MIN(sort_order) AS m FROM songs")
    return (r["m"] if r and r["m"] is not None else 0.0) - 1.0


def set_song_order(ids: list[str]) -> None:
    """按给定顺序重排曲库（拖拽排序）；未列出的歌保持原相对顺序排在后面。"""
    with _tx() as c:
        listed = [i for i in ids if isinstance(i, str)]
        rest = [r["id"] for r in c.execute(
            "SELECT id FROM songs ORDER BY COALESCE(sort_order, 0), created_at DESC") if r["id"] not in set(listed)]
        for pos, sid in enumerate(listed + rest):
            c.execute("UPDATE songs SET sort_order = ? WHERE id = ?", (float(pos), sid))


def audio_version(audio: dict | None) -> str:
    if not audio:
        return ""
    return f"{audio.get('size', 0)}-{int(audio.get('uploadedAt') or 0)}"


def find_by_source(source: str, source_id: str) -> dict | None:
    if not source_id:
        return None
    r = _q1("SELECT id FROM songs WHERE source = ? AND source_id = ?", (source, str(source_id)))
    return {"id": r["id"]} if r else None


def create_song(*, title: str = "", artist: str = "", album: str = "", source: str = "local",
                source_id: str = "", lines: list[dict] | None = None, timeline: str = "none",
                duration: float = 0) -> dict:
    song_id = time.strftime("%y%m%d") + "-" + secrets.token_hex(3)
    now = _now()
    song = {
        "id": song_id, "title": title or "未命名歌曲", "artist": artist, "album": album,
        "source": source, "sourceId": str(source_id or ""), "duration": duration, "audio": None,
        "timeline": timeline if lines else "none", "offset": 0.0, "syncInfo": None, "lyricSource": None,
        "lines": lines or [], "createdAt": now, "updatedAt": now, "lastOpenedAt": now,
        "sortOrder": _top_sort_order(),   # 新歌放在曲库最上面
    }
    return save_song(song, touch=False)


def delete_song(song_id: str) -> None:
    with _tx() as c:
        r = c.execute("SELECT audio, cover FROM songs WHERE id = ?", (song_id,)).fetchone()
        c.execute("DELETE FROM songs WHERE id = ?", (song_id,))  # lines / history / snapshots / 分类关系 级联删除
    audio = _loads(r["audio"]) if r else None
    if audio:
        (AUDIO_DIR / audio["file"]).unlink(missing_ok=True)
    cover = _loads(r["cover"]) if r else None
    if cover:
        (COVER_DIR / cover["file"]).unlink(missing_ok=True)


# --------------------------------------------------------------------- audio
def audio_path(song: dict) -> Path | None:
    a = song.get("audio")
    if not a:
        return None
    p = AUDIO_DIR / a["file"]
    return p if p.exists() else None


def store_audio(song: dict, src_file, filename: str, content_type: str) -> dict:
    """把上传流写入 data/audio/<song_id>.<ext>，替换旧音频。src_file 为可 read() 的文件对象。"""
    ext = (filename.rsplit(".", 1)[-1].lower() if "." in filename else "")
    if ext not in EXT_MIME:
        ext = AUDIO_EXT.get((content_type or "").split(";")[0].strip().lower(), "")
    if not ext:
        raise ValueError("无法识别的音频格式，请上传 mp3 / m4a / flac / ogg / wav（NCM 会在浏览器里先还原）")
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    target = AUDIO_DIR / f"{song['id']}.{ext}"
    tmp = AUDIO_DIR / f".upload-{secrets.token_hex(4)}"
    size = 0
    with open(tmp, "wb") as out:
        while True:
            chunk = src_file.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            out.write(chunk)
    old = song.get("audio")
    os.replace(tmp, target)
    if old and old.get("file") and old["file"] != target.name:
        (AUDIO_DIR / old["file"]).unlink(missing_ok=True)
    song["audio"] = {"file": target.name, "mime": EXT_MIME[ext], "size": size, "name": filename,
                     "uploadedAt": _now()}
    save_song(song)
    # 新音频自带封面时自动提取（用户手动设置的封面不覆盖）
    if (song.get("cover") or {}).get("source") != "user":
        _try_extract_cover(song)
    return song


def remove_audio(song: dict) -> dict:
    p = audio_path(song)
    if p:
        p.unlink(missing_ok=True)
    song["audio"] = None
    return save_song(song)


# --------------------------------------------------------------------- cover
IMAGE_EXT = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/bmp": "bmp"}


def cover_version(cover: dict | None) -> str:
    return f"{int((cover or {}).get('updatedAt') or 0)}-{(cover or {}).get('size', 0)}" if cover else ""


def cover_path(song: dict) -> Path | None:
    c = song.get("cover")
    if not c:
        return None
    p = COVER_DIR / c["file"]
    return p if p.exists() else None


def set_cover(song: dict, data: bytes, mime: str, source: str) -> dict:
    """保存封面图片到 data/covers/<song_id>.<ext>，更新 song.cover。"""
    from .cover import sniff_image
    mime = sniff_image(data) or mime
    ext = IMAGE_EXT.get(mime)
    if not ext:
        raise ValueError("不支持的图片格式（支持 jpg / png / webp / gif）")
    if len(data) > 15 * 1024 * 1024:
        raise ValueError("封面图片太大（上限 15MB）")
    COVER_DIR.mkdir(parents=True, exist_ok=True)
    old = song.get("cover")
    target = COVER_DIR / f"{song['id']}.{ext}"
    tmp = COVER_DIR / f".upload-{secrets.token_hex(4)}"
    tmp.write_bytes(data)
    os.replace(tmp, target)
    if old and old.get("file") and old["file"] != target.name:
        (COVER_DIR / old["file"]).unlink(missing_ok=True)
    song["cover"] = {"file": target.name, "mime": mime, "size": len(data), "source": source, "updatedAt": _now()}
    with _tx() as c:
        c.execute("UPDATE songs SET cover = ?, cover_checked = 1 WHERE id = ?", (_dumps(song["cover"]), song["id"]))
    return song


def remove_cover(song: dict) -> dict:
    p = cover_path(song)
    if p:
        p.unlink(missing_ok=True)
    song["cover"] = None
    with _tx() as c:
        c.execute("UPDATE songs SET cover = NULL WHERE id = ?", (song["id"],))
    return song


def _try_extract_cover(song: dict) -> bool:
    from .cover import extract_cover
    p = audio_path(song)
    found = extract_cover(p) if p else None
    if found:
        set_cover(song, found[0], found[1], "embedded")
    else:
        with _tx() as c:
            c.execute("UPDATE songs SET cover_checked = 1 WHERE id = ?", (song["id"],))
    return bool(found)


def backfill_covers() -> int:
    """启动时给「有音频、还没封面、还没检查过」的歌提取一次内嵌封面。"""
    n = 0
    for r in _q("SELECT id FROM songs WHERE audio IS NOT NULL AND cover IS NULL AND cover_checked = 0"):
        try:
            if _try_extract_cover(get_song(r["id"])):
                n += 1
        except Exception:  # noqa: BLE001
            continue
    return n


# ---------------------------------------------------------------- categories
def list_categories() -> list[dict]:
    rows = _q("""SELECT c.*, (SELECT COUNT(*) FROM song_categories sc WHERE sc.category_id = c.id) AS cnt
                 FROM categories c ORDER BY c.sort_order, c.created_at""")
    return [{"id": r["id"], "name": r["name"], "count": r["cnt"], "sortOrder": r["sort_order"]} for r in rows]


def create_category(name: str) -> dict:
    name = (name or "").strip()[:40]
    if not name:
        raise ValueError("分类名不能为空")
    cid = "c_" + secrets.token_hex(4)
    with _tx() as c:
        mx = c.execute("SELECT MAX(sort_order) FROM categories").fetchone()[0]
        c.execute("INSERT INTO categories(id, name, sort_order, created_at) VALUES (?, ?, ?, ?)",
                  (cid, name, (mx if mx is not None else -1) + 1, _now()))
    return {"id": cid, "name": name, "count": 0}


def rename_category(cid: str, name: str) -> None:
    name = (name or "").strip()[:40]
    if not name:
        raise ValueError("分类名不能为空")
    with _tx() as c:
        if c.execute("UPDATE categories SET name = ? WHERE id = ?", (name, cid)).rowcount == 0:
            raise KeyError(cid)


def delete_category(cid: str) -> None:
    """删除分类只删除分类本身和归类关系，歌曲不受影响。"""
    with _tx() as c:
        c.execute("DELETE FROM categories WHERE id = ?", (cid,))


def set_category_order(ids: list[str]) -> None:
    with _tx() as c:
        for pos, cid in enumerate(ids):
            c.execute("UPDATE categories SET sort_order = ? WHERE id = ?", (float(pos), cid))


def set_song_categories(song_id: str, cids: list[str]) -> list[str]:
    with _tx() as c:
        valid = {r[0] for r in c.execute("SELECT id FROM categories")}
        want = [x for x in dict.fromkeys(cids) if x in valid]
        c.execute("DELETE FROM song_categories WHERE song_id = ?", (song_id,))
        for cid in want:
            c.execute("INSERT INTO song_categories(song_id, category_id, added_at) VALUES (?, ?, ?)",
                      (song_id, cid, _now()))
    return want


def add_song_to_category(song_id: str, cid: str) -> None:
    with _tx() as c:
        if not c.execute("SELECT 1 FROM categories WHERE id = ?", (cid,)).fetchone():
            raise KeyError(cid)
        c.execute("INSERT OR IGNORE INTO song_categories(song_id, category_id, added_at) VALUES (?, ?, ?)",
                  (song_id, cid, _now()))


def remove_song_from_category(song_id: str, cid: str) -> None:
    with _tx() as c:
        c.execute("DELETE FROM song_categories WHERE song_id = ? AND category_id = ?", (song_id, cid))


# ---------------------------------------------------------------- history
def _row_to_history(r: sqlite3.Row) -> dict:
    rec = {
        "id": r["id"], "ts": r["ts"], "lineId": r["line_id"], "kind": r["kind"], "summary": r["summary"],
        "before": _loads(r["before"]), "after": _loads(r["after"]),
    }
    if r["grp"]:
        rec["group"] = r["grp"]
    if r["snapshot"]:
        rec["snapshot"] = r["snapshot"]
    return rec


def add_history(song_id: str, entries: list[dict]) -> list[dict]:
    """entries: [{lineId, kind, summary, before, after, group?, snapshot?}]，before/after 为整行快照。"""
    out = []
    if not entries:
        return out
    with _tx() as c:
        for e in entries:
            rec = {"id": "h_" + secrets.token_hex(4), "ts": _now(), "lineId": e.get("lineId"),
                   "kind": e.get("kind", "edit"), "summary": e.get("summary", ""),
                   "before": e.get("before"), "after": e.get("after")}
            c.execute("INSERT INTO history(id, song_id, ts, line_id, kind, summary, before, after, grp, snapshot) "
                      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                      (rec["id"], song_id, rec["ts"], rec["lineId"], rec["kind"], rec["summary"],
                       _dumps(rec["before"]), _dumps(rec["after"]), e.get("group"), e.get("snapshot")))
            if e.get("group"):
                rec["group"] = e["group"]
            if e.get("snapshot"):
                rec["snapshot"] = e["snapshot"]
            out.append(rec)
    return out


def get_history(song_id: str, limit: int = 300) -> list[dict]:
    rows = _q("SELECT * FROM history WHERE song_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?", (song_id, limit))
    return [_row_to_history(r) for r in rows]


def get_history_entry(song_id: str, hid: str) -> dict | None:
    r = _q1("SELECT * FROM history WHERE song_id = ? AND id = ?", (song_id, hid))
    return _row_to_history(r) if r else None


def get_history_group(song_id: str, group: str) -> list[dict]:
    rows = _q("SELECT * FROM history WHERE song_id = ? AND grp = ? ORDER BY ts", (song_id, group))
    return [_row_to_history(r) for r in rows]


# ------------------------------------------------------------ vocab notes
def get_vocab_notes() -> dict:
    return {r["surface"]: {"kana": r["kana"], "meaning": r["meaning"], "source": r["source"], "note": r["note"],
                           "starred": bool(r["starred"]), "updatedAt": r["updated_at"]}
            for r in _q("SELECT * FROM vocab_notes")}


def put_vocab_notes(items: list[dict]) -> dict:
    """items: [{surface, kana?, meaning?, source?, note?, starred?}]；只更新给出的字段。
    自动翻译（source=auto）不会覆盖用户手动填写（source=user）的释义。"""
    with _tx() as c:
        for it in items:
            surface = str(it.get("surface") or "").strip()
            if not surface:
                continue
            cur = c.execute("SELECT * FROM vocab_notes WHERE surface = ?", (surface,)).fetchone()
            row = dict(cur) if cur else {"surface": surface, "kana": "", "meaning": "", "source": "", "note": "", "starred": 0}
            if "meaning" in it:
                if it.get("source") == "auto" and row["source"] == "user" and row["meaning"]:
                    pass
                else:
                    row["meaning"] = str(it.get("meaning") or "")
                    row["source"] = it.get("source") or "user"
            for k in ("kana", "note"):
                if k in it:
                    row[k] = str(it.get(k) or "")
            if "starred" in it:
                row["starred"] = 1 if it.get("starred") else 0
            c.execute("INSERT INTO vocab_notes(surface, kana, meaning, source, note, starred, updated_at) "
                      "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(surface) DO UPDATE SET kana = excluded.kana, "
                      "meaning = excluded.meaning, source = excluded.source, note = excluded.note, "
                      "starred = excluded.starred, updated_at = excluded.updated_at",
                      (surface, row["kana"], row["meaning"], row["source"], row["note"], row["starred"], _now()))
    return get_vocab_notes()


def iter_song_lines(song_id: str | None = None):
    """单词本用：逐行返回 (song_id, title, line_id, text, zh, words, words_edited)，按曲库顺序。"""
    sql = ("SELECT s.id AS sid, s.title, l.id AS lid, l.text, l.zh, l.words, l.words_edited FROM lines l "
           "JOIN songs s ON s.id = l.song_id "
           + ("WHERE s.id = ? " if song_id else "") + "ORDER BY COALESCE(s.sort_order, 0), s.created_at DESC, l.pos")
    for r in _q(sql, (song_id,) if song_id else ()):
        yield r["sid"], r["title"], r["lid"], r["text"], r["zh"] or "", _loads(r["words"]), bool(r["words_edited"])


# --------------------------------------------------------------- snapshots
def snapshot_lines(song: dict) -> str:
    """全文编辑前给整首歌词做快照，返回快照 ID（写进历史，撤销时整体恢复）。"""
    sid = "s_" + time.strftime("%Y%m%d%H%M%S") + secrets.token_hex(2)
    with _tx() as c:
        c.execute("INSERT INTO snapshots(id, song_id, created_at, timeline, lines) VALUES (?, ?, ?, ?, ?)",
                  (sid, song["id"], _now(), song.get("timeline"), _dumps(song.get("lines", []))))
    return sid


def load_snapshot(song_id: str, snap_id: str) -> dict | None:
    r = _q1("SELECT * FROM snapshots WHERE song_id = ? AND id = ?", (song_id, snap_id))
    if not r:
        return None
    return {"lines": _loads(r["lines"], []), "timeline": r["timeline"]}


# ------------------------------------------------------- 旧版 JSON 存储迁移
def _migrate_legacy_json() -> None:
    """把旧版 data/songs/<id>/song.json（+ history.jsonl / snapshots / audio.*）、settings.json、
    dictionary.json 导入 SQLite。完成后旧文件移到 data/_legacy_json_backup/，不会删除。"""
    legacy_songs = DATA_DIR / "songs"
    legacy_files = [DATA_DIR / n for n in ("settings.json", "dictionary.json", "index.json")]
    if not legacy_songs.exists() and not any(p.exists() for p in legacy_files):
        return
    backup = DATA_DIR / "_legacy_json_backup"
    backup.mkdir(exist_ok=True)

    def read_json(p: Path, default):
        try:
            with open(p, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:  # noqa: BLE001
            return default

    settings = read_json(DATA_DIR / "settings.json", {})
    if isinstance(settings, dict) and settings:
        existing = {r["key"] for r in _q("SELECT key FROM settings")}
        put_settings({k: v for k, v in settings.items() if k not in existing})
    dictionary = read_json(DATA_DIR / "dictionary.json", {})
    if isinstance(dictionary, dict) and dictionary:
        put_dictionary_entries(dictionary)

    if legacy_songs.exists():
        for d in sorted(legacy_songs.iterdir()):
            song = read_json(d / "song.json", None)
            if not isinstance(song, dict) or not song.get("id"):
                continue
            if _q1("SELECT 1 FROM songs WHERE id = ?", (song["id"],)):
                continue
            # 音频移到 data/audio/<id>.<ext>
            if song.get("audio") and (d / song["audio"]["file"]).exists():
                ext = song["audio"]["file"].rsplit(".", 1)[-1]
                AUDIO_DIR.mkdir(parents=True, exist_ok=True)
                target = AUDIO_DIR / f"{song['id']}.{ext}"
                shutil.move(str(d / song["audio"]["file"]), target)
                song["audio"]["file"] = target.name
            else:
                song["audio"] = None
            snap_map = {}
            snaps_dir = d / "snapshots"
            save_song(song, touch=False)
            if snaps_dir.exists():
                for sp in sorted(snaps_dir.glob("*.json")):
                    data = read_json(sp, None)
                    if isinstance(data, dict):
                        tmp = {"id": song["id"], "lines": data.get("lines", []), "timeline": data.get("timeline")}
                        snap_map[sp.name] = snapshot_lines(tmp)
            hist_path = d / "history.jsonl"
            if hist_path.exists():
                with _tx() as c:
                    with open(hist_path, "r", encoding="utf-8") as f:
                        for raw in f:
                            try:
                                e = json.loads(raw)
                            except json.JSONDecodeError:
                                continue
                            c.execute(
                                "INSERT OR IGNORE INTO history(id, song_id, ts, line_id, kind, summary, before, after, grp, snapshot) "
                                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                                (e.get("id") or "h_" + secrets.token_hex(4), song["id"], e.get("ts") or _now(),
                                 e.get("lineId"), e.get("kind", "edit"), e.get("summary", ""),
                                 _dumps(e.get("before")), _dumps(e.get("after")), e.get("group"),
                                 snap_map.get(e.get("snapshot") or "")))
        shutil.move(str(legacy_songs), str(backup / f"songs-{time.strftime('%Y%m%d%H%M%S')}"))
    for p in legacy_files:
        if p.exists():
            shutil.move(str(p), str(backup / p.name))


__all__ = [
    "init", "close", "get_settings", "put_settings", "get_dictionary", "put_dictionary_entries",
    "list_songs", "get_song", "save_song", "touch_opened", "create_song", "delete_song", "find_by_source",
    "audio_path", "store_audio", "remove_audio", "add_history", "get_history", "get_history_entry",
    "get_history_group", "snapshot_lines", "load_snapshot", "DATA_DIR", "DB_PATH",
    "set_song_order", "audio_version", "cover_version", "cover_path", "set_cover", "remove_cover",
    "backfill_covers", "list_categories", "create_category", "rename_category", "delete_category",
    "set_category_order", "set_song_categories", "add_song_to_category", "remove_song_from_category", "get_vocab_notes", "put_vocab_notes", "iter_song_lines",
]
