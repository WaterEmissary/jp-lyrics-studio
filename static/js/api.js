// 后端 API 封装。所有接口都在 server/app.py 中定义。
async function request(method, url, body, { timeout = 30000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const opts = { method, signal: ctrl.signal, headers: {} };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  try {
    const r = await fetch(url, opts);
    let data = null;
    const text = await r.text();
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!r.ok) {
      const msg = (data && (data.error || data.detail)) || `HTTP ${r.status}`;
      throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('请求超时');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const enc = encodeURIComponent;

/** 带上传进度的 multipart 请求（大音频文件时显示进度） */
function upload(method, url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data?.detail || data?.error || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('网络错误'));
    xhr.send(formData);
  });
}

export const api = {
  settings: () => request('GET', '/api/settings'),
  saveSettings: (patch) => request('PUT', '/api/settings', patch),

  dictionary: () => request('GET', '/api/dictionary'),
  saveDictionary: (entries, remove = []) => request('PUT', '/api/dictionary', { entries, remove }),

  songs: () => request('GET', '/api/songs'),
  setOrder: (ids) => request('PUT', '/api/songs/order', { ids }),
  categories: () => request('GET', '/api/categories'),
  createCategory: (name) => request('POST', '/api/categories', { name }),
  renameCategory: (id, name) => request('PATCH', `/api/categories/${enc(id)}`, { name }),
  deleteCategory: (id) => request('DELETE', `/api/categories/${enc(id)}`),
  addToCategory: (id, songIds) => request('POST', `/api/categories/${enc(id)}/songs`, { songIds }),
  setSongCategories: (songId, ids) => request('PUT', `/api/songs/${enc(songId)}/categories`, { ids }),
  uploadCover: (songId, blob, source = 'user') => {
    const fd = new FormData();
    fd.append('image', blob, 'cover');
    fd.append('source', source);
    return upload('PUT', `/api/songs/${enc(songId)}/cover`, fd);
  },
  deleteCover: (songId) => request('DELETE', `/api/songs/${enc(songId)}/cover`),
  fetchCover: (songId) => request('POST', `/api/songs/${enc(songId)}/cover/fetch`, {}, { timeout: 40000 }),
  vocab: (song = 'all') => request('GET', `/api/vocab?song=${enc(song)}`, undefined, { timeout: 60000 }),
  saveVocabNotes: (items) => request('PUT', '/api/vocab/notes', { items }),
  song: (id) => request('GET', `/api/songs/${enc(id)}`),
  createSong: (formData, onProgress) => upload('POST', '/api/songs', formData, onProgress),
  importSong: (payload) => request('POST', '/api/songs/import', payload),
  patchSong: (id, patch) => request('PATCH', `/api/songs/${enc(id)}`, patch),
  deleteSong: (id) => request('DELETE', `/api/songs/${enc(id)}`),
  uploadAudio: (id, file, filename, onProgress) => {
    const fd = new FormData();
    fd.append('audio', file, filename || file.name || 'audio');
    return upload('PUT', `/api/songs/${enc(id)}/audio`, fd, onProgress);
  },
  deleteAudio: (id) => request('DELETE', `/api/songs/${enc(id)}/audio`),
  audioUrl: (id, bust = '') => `/api/songs/${enc(id)}/audio${bust ? `?v=${enc(bust)}` : ''}`,

  /** lines: [{id, ...fields}]；record=true 写入编辑历史 */
  patchLines: (id, lines, { record = false, kind = 'edit', note = '' } = {}) =>
    request('PUT', `/api/songs/${enc(id)}/lines`, { lines, record, kind, note }),
  replaceLyrics: (id, payload) => request('POST', `/api/songs/${enc(id)}/lyrics`, payload),
  history: (id) => request('GET', `/api/songs/${enc(id)}/history`),
  revert: (id, hid) => request('POST', `/api/songs/${enc(id)}/history/${enc(hid)}/revert`),
  exportLrcUrl: (id, zh = false) => `/api/songs/${enc(id)}/export.lrc${zh ? '?zh=1' : ''}`,
  parseLrc: (lrc) => request('POST', '/api/lrc/parse', { lrc }),

  online: {
    neteaseSearch: (q) => request('GET', `/api/online/netease/search?q=${enc(q)}`, undefined, { timeout: 25000 }),
    neteaseLyric: (id) => request('GET', `/api/online/netease/lyric?id=${enc(id)}`, undefined, { timeout: 30000 }),
    lrclibSearch: (q) => request('GET', `/api/online/lrclib/search?q=${enc(q)}`, undefined, { timeout: 40000 }),
    marumaruSearch: (title, artist = '') =>
      request('GET', `/api/online/marumaru/search?title=${enc(title)}&artist=${enc(artist)}`, undefined, { timeout: 60000 }),
    marumaruLyric: (url) => request('GET', `/api/online/marumaru/lyric?url=${enc(url)}`, undefined, { timeout: 60000 }),
    petit: (title, artist = '') =>
      request('GET', `/api/online/petit?title=${enc(title)}&artist=${enc(artist)}`, undefined, { timeout: 30000 }),
    translate: (texts) => request('POST', '/api/online/translate', { texts }, { timeout: 180000 }),
  },
};
