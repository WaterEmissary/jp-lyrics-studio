"""从音频文件中提取内嵌封面（纯 Python，无第三方依赖）。

支持：
  * MP3  —— ID3v2.2 / 2.3 / 2.4 的 PIC / APIC 帧
  * FLAC —— METADATA_BLOCK_PICTURE（类型 6）
  * M4A / MP4 —— moov/udta/meta/ilst/covr 原子
  * OGG / Opus —— Vorbis Comment 里的 METADATA_BLOCK_PICTURE（base64）
NCM 的封面在浏览器端还原时一并取出，经 PUT /api/songs/{id}/cover 上传（见 static/workers/ncm-worker.js）。

extract_cover(path) -> (bytes, mime) | None
"""
from __future__ import annotations

import base64
import struct
from pathlib import Path

MAX_READ = 64 * 1024 * 1024


def sniff_image(data: bytes) -> str | None:
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:2] == b"BM":
        return "image/bmp"
    return None


def _syncsafe(b: bytes) -> int:
    return (b[0] << 21) | (b[1] << 14) | (b[2] << 7) | b[3]


def _deunsync(b: bytes) -> bytes:
    return b.replace(b"\xff\x00", b"\xff")


def _skip_text(data: bytes, pos: int, enc: int) -> int:
    """跳过以对应编码结尾符结束的字符串，返回结尾符之后的位置。"""
    if enc in (1, 2):  # UTF-16：双字节 0 结尾，且需要按 2 字节对齐
        while pos + 1 < len(data):
            if data[pos] == 0 and data[pos + 1] == 0:
                return pos + 2
            pos += 2
        return len(data)
    end = data.find(b"\x00", pos)
    return len(data) if end < 0 else end + 1


def _id3(data: bytes) -> tuple[bytes, str] | None:
    if data[:3] != b"ID3" or len(data) < 10:
        return None
    major, flags = data[3], data[5]
    size = _syncsafe(data[6:10])
    tag = data[10: 10 + size]
    if flags & 0x80 and major < 4:
        tag = _deunsync(tag)
    pos = 0
    if flags & 0x40:  # 扩展头
        if major == 4:
            pos = _syncsafe(tag[0:4])
        else:
            pos = struct.unpack(">I", tag[0:4])[0] + 4
    pictures = []
    while pos + (6 if major == 2 else 10) <= len(tag):
        if major == 2:
            fid = tag[pos: pos + 3]
            fsize = int.from_bytes(tag[pos + 3: pos + 6], "big")
            body = tag[pos + 6: pos + 6 + fsize]
            pos += 6 + fsize
        else:
            fid = tag[pos: pos + 4]
            fsize = _syncsafe(tag[pos + 4: pos + 8]) if major == 4 else struct.unpack(">I", tag[pos + 4: pos + 8])[0]
            fflags = tag[pos + 9]
            body = tag[pos + 10: pos + 10 + fsize]
            pos += 10 + fsize
            if major == 4 and fflags & 0x02:
                body = _deunsync(body)
            if major == 4 and fflags & 0x01:  # 数据长度指示符
                body = body[4:]
        if not fid.strip(b"\x00"):
            break
        if fid in (b"APIC", b"PIC") and body:
            enc = body[0]
            if fid == b"PIC":
                p = 1 + 3  # 3 字节图片格式
            else:
                p = body.find(b"\x00", 1) + 1  # MIME 字符串
            ptype = body[p] if p < len(body) else 0
            p = _skip_text(body, p + 1, enc)
            img = body[p:]
            mime = sniff_image(img)
            if mime:
                pictures.append((ptype, img, mime))
    if not pictures:
        return None
    # 优先「封面（正面）」= 类型 3
    pictures.sort(key=lambda x: 0 if x[0] == 3 else 1)
    return pictures[0][1], pictures[0][2]


def _flac_picture_block(b: bytes) -> tuple[bytes, str] | None:
    try:
        p = 4
        mlen = struct.unpack(">I", b[p: p + 4])[0]
        p += 4 + mlen
        dlen = struct.unpack(">I", b[p: p + 4])[0]
        p += 4 + dlen + 16
        size = struct.unpack(">I", b[p: p + 4])[0]
        img = b[p + 4: p + 4 + size]
        mime = sniff_image(img)
        return (img, mime) if mime else None
    except (struct.error, IndexError):
        return None


def _flac(data: bytes) -> tuple[bytes, str] | None:
    if data[:4] != b"fLaC":
        return None
    pos = 4
    while pos + 4 <= len(data):
        header = data[pos]
        btype = header & 0x7F
        size = int.from_bytes(data[pos + 1: pos + 4], "big")
        if btype == 6:
            return _flac_picture_block(data[pos + 4: pos + 4 + size])
        pos += 4 + size
        if header & 0x80:
            break
    return None


def _mp4(data: bytes) -> tuple[bytes, str] | None:
    def atoms(buf: bytes, start: int, end: int):
        p = start
        while p + 8 <= end:
            size = struct.unpack(">I", buf[p: p + 4])[0]
            typ = buf[p + 4: p + 8]
            hdr = 8
            if size == 1:
                size = struct.unpack(">Q", buf[p + 8: p + 16])[0]
                hdr = 16
            elif size == 0:
                size = end - p
            if size < hdr:
                return
            yield typ, p + hdr, p + size
            p += size

    def find(path: list[bytes], start: int, end: int):
        for typ, s, e in atoms(data, start, end):
            if typ == path[0]:
                if len(path) == 1:
                    return s, e
                if typ == b"meta":
                    s += 4  # meta 有 4 字节 version/flags
                r = find(path[1:], s, e)
                if r:
                    return r
        return None

    if data[4:8] != b"ftyp":
        return None
    r = find([b"moov", b"udta", b"meta", b"ilst", b"covr"], 0, len(data))
    if not r:
        return None
    for typ, s, e in atoms(data, r[0], r[1]):
        if typ == b"data":
            img = data[s + 8: e]
            mime = sniff_image(img)
            if mime:
                return img, mime
    return None


def _ogg(data: bytes) -> tuple[bytes, str] | None:
    if data[:4] != b"OggS":
        return None
    key = b"METADATA_BLOCK_PICTURE="
    i = data.find(key)
    if i < 0:
        i = data.lower().find(key.lower())
    if i < 0:
        return None
    # Vorbis comment 前 4 字节是长度（小端）
    try:
        length = struct.unpack("<I", data[i - 4: i])[0]
        raw = data[i + len(key): i - 4 + 4 + length]
        # 跨页的情况：去掉中间的 Ogg 页头比较复杂，这里只处理单页内的常见情况
        return _flac_picture_block(base64.b64decode(raw + b"=" * (-len(raw) % 4), validate=False))
    except Exception:  # noqa: BLE001
        return None


def extract_cover(path: Path) -> tuple[bytes, str] | None:
    try:
        size = path.stat().st_size
        with open(path, "rb") as f:
            head = f.read(16)
            f.seek(0)
            if head[4:8] == b"ftyp":
                data = f.read(min(size, MAX_READ))  # M4A 的 moov 可能在文件末尾
            elif head[:3] == b"ID3":
                f.seek(6)
                tag_size = _syncsafe(f.read(4)) + 10
                f.seek(0)
                data = f.read(min(tag_size + 16, MAX_READ))
            else:
                data = f.read(min(size, 16 * 1024 * 1024))
    except OSError:
        return None
    for fn in (_id3, _flac, _mp4, _ogg):
        try:
            r = fn(data)
        except Exception:  # noqa: BLE001  —— 损坏的标签不应影响上传
            r = None
        if r:
            return r
    return None
