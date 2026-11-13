// 本设备音频缓存（IndexedDB）
//
// 歌曲音频保存在服务端；每台设备可以「按需下载」到浏览器本地缓存，之后离线也能秒开、不再消耗流量。
// 用 IndexedDB 而不是 Cache Storage：后者只在 HTTPS / localhost 下可用，而局域网用 http://IP:8765 访问时也要能缓存。
// 记录：{id: 歌曲ID, version: "大小-上传时间", size, mime, blob, savedAt}
import { bus } from './util.js';
import { api } from './api.js';

const DB_NAME = 'jls-cache';
const STORE = 'audio';
let dbp = null;

function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('浏览器不支持 IndexedDB')); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('事务中止'));
  }));
}

const reqP = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/** 歌曲对象 / 曲库摘要 → 音频版本号（与服务端 storage.audio_version 一致） */
export function versionOf(songOrSummary) {
  if (!songOrSummary) return '';
  if (songOrSummary.audioVersion !== undefined) return songOrSummary.audioVersion;
  const a = songOrSummary.audio;
  return a ? `${a.size || 0}-${Math.trunc(a.uploadedAt || 0)}` : '';
}

export async function getCached(id) {
  try { return await tx('readonly', s => reqP(s.get(id))) || null; } catch { return null; }
}

/** id → {version, size, savedAt}（不读出音频内容） */
export async function cacheIndex() {
  const map = new Map();
  try {
    await tx('readonly', s => new Promise((resolve, reject) => {
      const req = s.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { resolve(); return; }
        const v = cur.value;
        map.set(v.id, { version: v.version, size: v.size, savedAt: v.savedAt });
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    }));
  } catch {}
  return map;
}

/** 上传音频的设备直接把文件写进本设备缓存（不用再下载一遍） */
export async function putCached(song, blob) {
  if (!song?.audio || !blob) return;
  try {
    await tx('readwrite', s => reqP(s.put({ id: song.id, version: versionOf(song), size: blob.size,
      mime: song.audio.mime || blob.type, blob, savedAt: Date.now() })));
    bus.emit('cache:changed', { id: song.id });
  } catch (e) {
    console.warn('[cache] 写入失败', e);
  }
}

export async function deleteCached(id) {
  await tx('readwrite', s => reqP(s.delete(id)));
  bus.emit('cache:changed', { id });
}

export async function clearAll() {
  await tx('readwrite', s => reqP(s.clear()));
  bus.emit('cache:changed', {});
}

export async function storageEstimate() {
  try { return await navigator.storage?.estimate?.(); } catch { return null; }
}

// 正在进行的下载：id → {loaded, total, ctrl, promise}
export const downloads = new Map();

/**
 * 下载歌曲音频到本设备（带进度）。进度通过 bus 事件 cache:progress {id, loaded, total} 广播。
 * 同一首歌重复调用返回同一个 Promise。
 */
export function downloadAudio(summary) {
  const id = summary.id;
  if (downloads.has(id)) return downloads.get(id).promise;
  const ctrl = new AbortController();
  const entry = { loaded: 0, total: summary.audioSize || summary.audio?.size || 0, ctrl };
  entry.promise = (async () => {
    try { navigator.storage?.persist?.(); } catch {}
    const version = versionOf(summary);
    const r = await fetch(api.audioUrl(id, version), { signal: ctrl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    entry.total = Number(r.headers.get('Content-Length')) || entry.total;
    const mime = r.headers.get('Content-Type') || 'audio/mpeg';
    const chunks = [];
    if (r.body?.getReader) {
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        entry.loaded += value.length;
        bus.emit('cache:progress', { id, loaded: entry.loaded, total: entry.total });
      }
    } else {
      chunks.push(new Uint8Array(await r.arrayBuffer()));
      entry.loaded = entry.total;
    }
    const blob = new Blob(chunks, { type: mime });
    await tx('readwrite', s => reqP(s.put({ id, version, size: blob.size, mime, blob, savedAt: Date.now() })));
    return blob;
  })();
  downloads.set(id, entry);
  bus.emit('cache:progress', { id, loaded: 0, total: entry.total });
  entry.promise.then(
    () => { downloads.delete(id); bus.emit('cache:done', { id }); bus.emit('cache:changed', { id }); },
    (e) => { downloads.delete(id); bus.emit('cache:error', { id, error: e }); },
  );
  return entry.promise;
}

export function cancelDownload(id) {
  downloads.get(id)?.ctrl.abort();
}

// 本设备的音频策略（每台设备不同，存在 localStorage）：ask 每次询问 | stream 直接在线播放 | auto 自动下载缓存
export function audioMode() {
  try { return localStorage.getItem('jls-audio-mode') || 'ask'; } catch { return 'ask'; }
}
export function setAudioMode(m) {
  try { localStorage.setItem('jls-audio-mode', m); } catch {}
}

export function fmtSize(bytes) {
  if (!bytes) return '0 MB';
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
