"""后端冒烟测试：python -m pytest tests -q   （需要 pip install pytest）"""
import os
import tempfile

os.environ["JLS_DATA_DIR"] = tempfile.mkdtemp(prefix="jls-test-")

from fastapi.testclient import TestClient  # noqa: E402

from server import lrc  # noqa: E402
from server.app import app  # noqa: E402

LRC = """[ti:テスト]
[ar:歌手]
[00:01.00]風に触った中で
[00:01.00]在风中触碰
[00:05.50]君の声が聞こえた
[00:10.00]風に触った中で
"""


def test_parse_lrc_bilingual_and_ends():
    lines, meta, timeline = lrc.parse_lrc(LRC)
    assert timeline == "synced"
    assert meta["ti"] == "テスト"
    assert [l["text"] for l in lines] == ["風に触った中で", "君の声が聞こえた", "風に触った中で"]
    assert lines[0]["zh"] == "在风中触碰"
    assert lines[0]["end"] == 5.5 and lines[-1]["end"] is None


def test_parse_plain_text_is_synthetic():
    lines, _, timeline = lrc.parse_lrc("一行目\n二行目")
    assert timeline == "synthetic"
    assert [l["time"] for l in lines] == [0, 4]


def test_song_edit_history_and_revert():
    c = TestClient(app)
    song = c.post("/api/songs", data={"lrc": LRC}).json()
    assert song["title"] == "テスト" and len(song["lines"]) == 3
    l0, _, l2 = song["lines"]
    words = [{"t": "風に触った", "k": "かぜにさわった", "r": "kaze ni sawatta"}, {"t": "中で", "k": "なかで", "r": "naka de"}]
    # 同一次操作改两行（副歌同步）→ 同组历史
    r = c.put(f"/api/songs/{song['id']}/lines", json={
        "lines": [{"id": l0["id"], "words": words, "wordsEdited": True}, {"id": l2["id"], "words": words, "wordsEdited": True}],
        "record": True, "kind": "merge"}).json()
    assert len(r["updated"]) == 2
    hist = c.get(f"/api/songs/{song['id']}/history").json()
    assert len(hist) == 2 and hist[0]["group"] == hist[1]["group"]
    reverted = c.post(f"/api/songs/{song['id']}/history/{hist[0]['id']}/revert").json()
    assert all(not ln.get("wordsEdited") for ln in reverted["lines"])


def test_replace_lyrics_keeps_edits():
    c = TestClient(app)
    song = c.post("/api/songs", data={"lrc": LRC}).json()
    lid = song["lines"][1]["id"]
    c.put(f"/api/songs/{song['id']}/lines", json={"lines": [{"id": lid, "words": [{"t": "君の声が聞こえた", "k": "", "r": ""}], "wordsEdited": True}], "record": True})
    new = c.post(f"/api/songs/{song['id']}/lyrics", json={"lrc": "[00:02.00]君の声が聞こえた\n[00:04.00]新しい", "keepEdits": True}).json()
    assert new["lines"][0]["id"] == lid and new["lines"][0]["wordsEdited"] is True
    assert new["lines"][1]["words"] is None


def test_audio_upload_and_range():
    c = TestClient(app)
    song = c.post("/api/songs", data={"title": "a"}, files={"audio": ("x.mp3", b"ID3" + b"\0" * 5000, "audio/mpeg")}).json()
    assert song["audio"]["mime"] == "audio/mpeg"
    r = c.get(f"/api/songs/{song['id']}/audio", headers={"Range": "bytes=0-9"})
    assert r.status_code == 206 and len(r.content) == 10


def test_delete_song_cascades():
    c = TestClient(app)
    song = c.post("/api/songs", data={"lrc": LRC}, files={"audio": ("x.mp3", b"ID3" + b"\0" * 100, "audio/mpeg")}).json()
    lid = song["lines"][0]["id"]
    c.put(f"/api/songs/{song['id']}/lines", json={"lines": [{"id": lid, "zh": "x"}], "record": True})
    from server import storage
    path = storage.audio_path(storage.get_song(song["id"]))
    assert path and path.exists()
    assert c.delete(f"/api/songs/{song['id']}").status_code == 200
    assert not path.exists()
    assert storage.get_history(song["id"]) == []
    assert c.get(f"/api/songs/{song['id']}").status_code == 404


def test_migrate_legacy_json(tmp_path, monkeypatch):
    """旧版 data/songs/<id>/song.json 存储在首次启动时迁移到 SQLite"""
    import json
    from server import storage
    legacy = tmp_path / "songs" / "261112-abcdef"
    legacy.mkdir(parents=True)
    (legacy / "audio.mp3").write_bytes(b"ID3data")
    (legacy / "song.json").write_text(json.dumps({
        "id": "261112-abcdef", "title": "旧歌", "artist": "", "source": "local", "timeline": "synced",
        "audio": {"file": "audio.mp3", "mime": "audio/mpeg", "size": 7, "name": "a.mp3"},
        "lines": [{"id": "l_1", "time": 1.0, "end": None, "text": "テスト", "zh": "", "words": None}],
    }, ensure_ascii=False), encoding="utf-8")
    (legacy / "history.jsonl").write_text(json.dumps({"id": "h_x", "ts": 1, "lineId": "l_1", "kind": "edit",
                                                      "summary": "s", "before": None, "after": None}) + "\n", encoding="utf-8")
    (tmp_path / "settings.json").write_text('{"layout": "inline"}', encoding="utf-8")
    storage.close()
    monkeypatch.setattr(storage, "DATA_DIR", tmp_path)
    monkeypatch.setattr(storage, "DB_PATH", tmp_path / "studio.db")
    monkeypatch.setattr(storage, "AUDIO_DIR", tmp_path / "audio")
    try:
        storage.init()
        song = storage.get_song("261112-abcdef")
        assert song["title"] == "旧歌" and song["lines"][0]["text"] == "テスト"
        assert storage.audio_path(song).read_bytes() == b"ID3data"
        assert storage.get_history("261112-abcdef")[0]["id"] == "h_x"
        assert storage.get_settings()["layout"] == "inline"
        assert not (tmp_path / "songs").exists() and (tmp_path / "_legacy_json_backup").exists()
    finally:
        storage.close()
