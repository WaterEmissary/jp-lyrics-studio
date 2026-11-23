// 曲库（参考网易云音乐的布局）：
//   * 「曲库」视图：左侧歌单（全部歌曲 / 未归入歌单 / 我的歌单，可展开收起），右侧当前歌单的歌曲列表；
//   * 「歌词」「单词本」视图：播放条的歌单按钮在左侧展开「快速选歌」栏并一直停靠——歌直接放在各个歌单里，歌单可展开 / 收起；
//   * 播放条左下角显示当前歌曲（封面 + 歌名），点击在「歌词」与「曲库」之间切换；
//   * 另外负责：导入本地歌曲（音频 / NCM / LRC）、歌曲信息编辑（封面、所属歌单、音频）。
import { $, $$, h, escapeHTML, toast, bus, setStatus } from './util.js';
import { state } from './state.js';
import { api } from './api.js';
import { openSong, updateSongHeader } from './song.js';
import { loadSongAudio } from './player.js';
import { readTextFile } from './editor.js';
import { cacheIndex, downloads, downloadAudio, cancelDownload, deleteCached, putCached, fmtSize } from './cache.js';

const SOURCE_LABEL = { local: '本地', netease: '网易云', lrclib: 'LRCLIB', marumaru: 'Marumaru' };
const NARROW = '(max-width: 900px)';

let cacheIdx = new Map();   // 本设备已缓存的音频：id → {version, size}

export async function refreshLibrary() {
  try {
    const [songs] = await Promise.all([api.songs(), refreshCategories()]);
    state.songs = songs;
  } catch (e) {
    toast('曲库加载失败：' + e.message, { error: true });
    state.songs = [];
  }
  cacheIdx = await cacheIndex();
  renderLibrary();
}

async function refreshCacheIndex() {
  cacheIdx = await cacheIndex();
  renderLibrary();
}

/** 本设备缓存状态：none（无音频）| cached | outdated | missing | downloading */
function cacheState(s) {
  if (!s.hasAudio) return 'none';
  if (downloads.has(s.id)) return 'downloading';
  const c = cacheIdx.get(s.id);
  if (!c) return 'missing';
  return c.version === s.audioVersion ? 'cached' : 'outdated';
}

function cacheWidget(s) {
  const st = cacheState(s);
  if (st === 'none') return h('div', { class: 'lib-cache st-none', title: '服务器上没有音频', text: '—' });
  const wrap = h('div', { class: `lib-cache st-${st}` });
  if (st === 'cached') {
    const btn = h('button', { type: 'button', class: 'cache-btn ok', title: '已缓存到本设备（点击删除本设备缓存，服务器上的文件不受影响）', text: '✓ 已缓存' });
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`删除本设备上「${s.title}」的音频缓存？（服务器上的文件不受影响，之后可重新下载）`)) return;
      await deleteCached(s.id);
    });
    wrap.append(btn);
  } else if (st === 'downloading') {
    const d = downloads.get(s.id);
    const pct = d?.total ? Math.min(100, d.loaded / d.total * 100) : 0;
    const cancel = h('button', { type: 'button', class: 'cache-btn', title: '取消下载', text: '×' });
    cancel.addEventListener('click', (e) => { e.stopPropagation(); cancelDownload(s.id); });
    wrap.append(
      h('div', { class: 'mini-progress' }, h('div', { class: 'bar', style: `width:${pct.toFixed(1)}%` })),
      h('span', { class: 'cache-pct', text: `${pct.toFixed(0)}%` }), cancel);
  } else {
    const label = st === 'outdated' ? `↻ 更新 ${fmtSize(s.audioSize)}` : `⬇ ${fmtSize(s.audioSize)}`;
    const btn = h('button', { type: 'button', class: 'cache-btn', title: st === 'outdated' ? '服务器上的音频已更新，点击重新下载到本设备' : '音频还没缓存到本设备，点击下载（带进度）', text: label });
    btn.addEventListener('click', (e) => { e.stopPropagation(); downloadAudio(s).catch(() => {}); renderLibrary(); });
    wrap.append(btn);
  }
  return wrap;
}

// ---------------------------------------------------------------- 歌单（后端叫 categories）
let categories = [];          // [{id, name, count}]
// 当前在曲库视图里查看的歌单：all = 全部歌曲，none = 未归入歌单，其它 = 歌单 id
let currentCat = (() => { try { return localStorage.getItem('jls-cat') || 'all'; } catch { return 'all'; } })();

async function refreshCategories() {
  try { categories = await api.categories(); } catch { categories = []; }
  if (!['all', 'none'].includes(currentCat) && !categories.some(c => c.id === currentCat)) setCurrentCat('all', false);
}

function setCurrentCat(id, render = true) {
  const changed = currentCat !== id;
  currentCat = id;
  try { localStorage.setItem('jls-cat', id); } catch {}
  if (window.matchMedia(NARROW).matches) toggleSidebar(false);
  if (changed) $('#lib-filter').value = '';
  if (render) {
    renderLibrary();
    if (changed) $('#lib-list').scrollTop = 0;
  }
}

/** 某个歌单里的歌（按曲库顺序，不含筛选） */
function catSongs(id) {
  if (id === 'all') return state.songs;
  if (id === 'none') return state.songs.filter(s => !(s.categories || []).length);
  return state.songs.filter(s => (s.categories || []).includes(id));
}

function catName(id) {
  if (id === 'all') return '全部歌曲';
  if (id === 'none') return '未归入歌单';
  return categories.find(c => c.id === id)?.name || '歌单';
}

/** 歌单封面：歌单里第一首有封面的歌；都没有时用按名字生成的色块 */
function playlistCover(id, cls) {
  const withCover = catSongs(id).find(s => s.coverVersion);
  if (withCover) return coverEl(withCover, cls);
  return placeholderCover({ title: catName(id) }, cls);
}

const ICON_ALL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/></svg>';
const ICON_NONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 10h16"/></svg>';

let plCollapsed = (() => { try { return localStorage.getItem('jls-pl-collapsed') === '1'; } catch { return false; } })();

function renderSidebar() {
  const fixed = (id, icon) => {
    const b = h('button', { type: 'button', class: `pl-item fixed${currentCat === id ? ' active' : ''}`, dataset: { cat: id } },
      h('span', { class: 'pl-icon', html: icon }),
      h('span', { class: 'pl-name', text: catName(id) }),
      h('span', { class: 'pl-count', text: String(catSongs(id).length) }));
    b.addEventListener('click', () => setCurrentCat(id));
    return b;
  };
  const items = [fixed('all', ICON_ALL)];
  if (categories.length && (catSongs('none').length || currentCat === 'none')) items.push(fixed('none', ICON_NONE));
  $('#pl-fixed').replaceChildren(...items);

  $('#pl-count').textContent = String(categories.length);
  const toggle = $('#pl-toggle');
  toggle.setAttribute('aria-expanded', String(!plCollapsed));
  toggle.classList.toggle('collapsed', plCollapsed);
  const list = $('#pl-list');
  list.hidden = plCollapsed;
  if (!categories.length) {
    list.replaceChildren(h('div', { class: 'pl-empty muted small', text: '点 ＋ 新建歌单，然后把右侧的歌拖进来，或在歌曲的 ⋯ 菜单里加入。' }));
    return;
  }
  list.replaceChildren(...categories.map(c => {
    const b = h('button', { type: 'button', class: `pl-item${currentCat === c.id ? ' active' : ''}`, dataset: { cat: c.id },
      title: `${c.name}（右键或 ⋯ 可重命名 / 删除；把歌拖到这里加入歌单）` },
    playlistCover(c.id, 'pl-cover'),
    h('span', { class: 'pl-name', text: c.name }),
    h('span', { class: 'pl-count', text: String(c.count) }));
    const more = h('span', { class: 'pl-more', role: 'button', title: '重命名 / 删除', text: '⋯' });
    more.addEventListener('click', (e) => { e.stopPropagation(); openCatMenu(c.id, more); });
    b.append(more);
    b.addEventListener('click', () => setCurrentCat(c.id));
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); openCatMenu(c.id, b); });
    return b;
  }));
}

async function newCategory({ addSongIds = [], open = true } = {}) {
  const name = prompt('新歌单名称（例如：练习中 / 已学会 / 动漫 / Reol）');
  if (!name?.trim()) return null;
  try {
    const c = await api.createCategory(name.trim());
    if (addSongIds.length) await api.addToCategory(c.id, addSongIds);
    plCollapsed = false;
    try { localStorage.setItem('jls-pl-collapsed', '0'); } catch {}
    await refreshLibrary();
    if (open) setCurrentCat(c.id);
    toast(addSongIds.length ? `已加入新歌单「${c.name}」` : `已创建歌单「${c.name}」：可以把歌拖进来，或点「添加歌曲」`);
    return c;
  } catch (e) {
    toast('创建失败：' + e.message, { error: true });
    return null;
  }
}

function closeMenus() { $$('.lib-menu').forEach(m => m.remove()); }

function placeMenu(menu, anchor) {
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth, hgt = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left))}px`;
  menu.style.top = `${r.bottom + hgt + 8 > window.innerHeight ? Math.max(8, r.top - hgt - 4) : r.bottom + 4}px`;
}

function openCatMenu(id, anchor) {
  closeMenus();
  const c = categories.find(x => x.id === id);
  if (!c) return;
  const menu = h('div', { class: 'lib-menu popover menu' });
  const rename = h('button', { type: 'button', text: '重命名' });
  rename.addEventListener('click', async () => {
    closeMenus();
    const name = prompt('重命名歌单', c.name);
    if (!name?.trim() || name.trim() === c.name) return;
    try { categories = await api.renameCategory(id, name.trim()); renderLibrary(); } catch (e) { toast(e.message, { error: true }); }
  });
  const del = h('button', { type: 'button', class: 'danger', text: '删除歌单（歌曲不会被删除）' });
  del.addEventListener('click', async () => {
    closeMenus();
    if (!confirm(`删除歌单「${c.name}」？歌单里的歌曲仍保留在曲库中。`)) return;
    categories = await api.deleteCategory(id);
    if (currentCat === id) setCurrentCat('all', false);
    await refreshLibrary();
  });
  menu.append(h('div', { class: 'menu-title', text: c.name }), rename, del);
  placeMenu(menu, anchor);
}

/** 歌曲的 ⋯ 菜单：打开、加入 / 移出歌单、歌曲信息 */
function openSongMenu(song, anchor) {
  closeMenus();
  const menu = h('div', { class: 'lib-menu popover menu' });
  const open = h('button', { type: 'button', text: '打开歌词' });
  open.addEventListener('click', () => { closeMenus(); openFromList(song); });
  menu.append(open, h('div', { class: 'menu-sep' }), h('div', { class: 'menu-title', text: '加入歌单' }));
  if (!categories.length) menu.append(h('div', { class: 'muted small pad-x', text: '还没有歌单' }));
  for (const c of categories) {
    const on = (song.categories || []).includes(c.id);
    const row = h('label', { class: 'menu-check' }, h('input', { type: 'checkbox', checked: on }), c.name);
    row.querySelector('input').addEventListener('change', (e) => setMembership(song, c.id, e.target.checked));
    menu.append(row);
  }
  const add = h('button', { type: 'button', text: '＋ 新建歌单并加入' });
  add.addEventListener('click', () => { closeMenus(); newCategory({ addSongIds: [song.id], open: false }); });
  const info = h('button', { type: 'button', text: '歌曲信息 / 封面 / 音频…' });
  info.addEventListener('click', async () => {
    closeMenus();
    if (state.song?.id !== song.id) await openSong(song.id);
    openSongInfo();
  });
  menu.append(add, h('div', { class: 'menu-sep' }), info);
  placeMenu(menu, anchor);
}

async function setMembership(song, catId, on) {
  const ids = new Set(song.categories || []);
  if (on) ids.add(catId); else ids.delete(catId);
  try {
    const res = await api.setSongCategories(song.id, [...ids]);
    song.categories = res.categories;
    await refreshCategories();
    renderLibrary();
  } catch (err) { toast(err.message, { error: true }); }
}

/** 歌单视图的「添加歌曲」：从全部歌曲里勾选（窄屏不能拖动时也能整理歌单） */
function openAddSongsMenu(catId, anchor) {
  closeMenus();
  const menu = h('div', { class: 'lib-menu popover menu add-songs' });
  const filter = h('input', { class: 'input', type: 'search', placeholder: '搜索歌名 / 歌手' });
  const list = h('div', { class: 'add-songs-list' });
  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    const songs = state.songs.filter(s => !q || `${s.title} ${s.artist}`.toLowerCase().includes(q));
    list.replaceChildren(...songs.map(s => {
      const row = h('label', { class: 'menu-check' },
        h('input', { type: 'checkbox', checked: (s.categories || []).includes(catId) }),
        coverEl(s, 'menu-cover'),
        h('span', { class: 'menu-check-text' }, h('span', { text: s.title || '未命名' }), h('small', { class: 'muted', text: s.artist || '' })));
      row.querySelector('input').addEventListener('change', (e) => setMembership(s, catId, e.target.checked));
      return row;
    }));
    if (!songs.length) list.append(h('div', { class: 'muted small pad-x', text: '没有匹配的歌曲' }));
  };
  filter.addEventListener('input', draw);
  draw();
  menu.append(h('div', { class: 'menu-title', text: `添加到「${catName(catId)}」` }), filter, list);
  placeMenu(menu, anchor);
  filter.focus();
}

// ---------------------------------------------------------------- 封面
const coverUrl = (s) => `/api/songs/${encodeURIComponent(s.id)}/cover?v=${encodeURIComponent(s.coverVersion)}`;

function coverEl(s, cls = 'lib-cover') {
  if (s.coverVersion) {
    const img = h('img', { class: cls, src: coverUrl(s), alt: '', loading: 'lazy', draggable: 'false' });
    img.addEventListener('error', () => img.replaceWith(placeholderCover(s, cls)));
    return img;
  }
  return placeholderCover(s, cls);
}

/** 没有封面时：按歌名生成一个颜色块 + 首字 */
function placeholderCover(s, cls) {
  const text = (s.title || '?').trim();
  let hash = 0;
  for (const ch of text) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  const hue = hash % 360;
  return h('div', { class: `${cls} placeholder`, style: `--h:${hue}`, text: [...text][0] || '♪' });
}

export function songCover(s, cls) { return coverEl(s, cls); }

function fmtDur(sec) {
  if (!sec) return '';
  const m = Math.floor(sec / 60), ss = Math.round(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function summaryOf(id) { return state.songs.find(x => x.id === id); }

function songBadges(s, { withCats = false } = {}) {
  const badges = [];
  if (s.timeline === 'synthetic') badges.push('<span class="badge warn" title="纯文本歌词，时间为估算，可打轴">估算</span>');
  else if (s.timeline !== 'synced') badges.push('<span class="badge warn">无歌词</span>');
  if (!s.hasAudio) badges.push('<span class="badge warn" title="服务器上没有音频">无音频</span>');
  if (s.editedCount) badges.push(`<span class="badge edit" title="手动修改过的行">✎ ${s.editedCount}</span>`);
  if (withCats) {
    const names = (s.categories || []).map(id => categories.find(c => c.id === id)?.name).filter(Boolean);
    badges.push(...names.slice(0, 2).map(n => `<span class="badge cat">${escapeHTML(n)}</span>`));
  }
  return badges.join('');
}

// 正在播放的小动画（当前歌曲在列表里的序号位置）
const EQ = '<span class="eq" aria-label="当前歌曲"><i></i><i></i><i></i></span>';

/** 从列表 / 快速选歌打开一首歌并切到歌词视图 */
async function openFromList(s, { toLyrics = true } = {}) {
  closeMenus();
  if (state.song?.id !== s.id) await openSong(s.id);
  if (toLyrics) bus.emit('app:mode', 'lyrics');
  renderLibrary();
}

// ---------------------------------------------------------------- 歌曲列表（曲库视图右侧）
function visibleSongs() {
  const q = $('#lib-filter').value.trim().toLowerCase();
  return catSongs(currentCat).filter(s => !q || `${s.title} ${s.artist} ${s.album}`.toLowerCase().includes(q));
}

function renderListHeader(items) {
  const isCat = !['all', 'none'].includes(currentCat);
  $('#sl-kicker').textContent = currentCat === 'all' ? '曲库' : '歌单';
  $('#sl-name').textContent = catName(currentCat);
  $('#sl-cover').replaceChildren(currentCat === 'all'
    ? h('div', { class: 'sl-cover-img icon', html: ICON_ALL })
    : playlistCover(currentCat, 'sl-cover-img'));
  const all = catSongs(currentCat);
  const withAudio = all.filter(s => s.hasAudio);
  const missing = withAudio.filter(s => ['missing', 'outdated'].includes(cacheState(s)));
  const cached = withAudio.filter(s => cacheState(s) === 'cached');
  const dl = withAudio.filter(s => cacheState(s) === 'downloading');
  $('#lib-count').textContent = `${all.length} 首` + (items.length !== all.length ? `（显示 ${items.length}）` : '');
  $('#lib-cache-summary').textContent = withAudio.length
    ? `本设备已缓存 ${cached.length}/${withAudio.length}` + (dl.length ? ` · 下载中 ${dl.length}` : '') : '';
  const dla = $('#lib-download-all');
  dla.hidden = !missing.length;
  dla.textContent = `⬇ 全部下载（${missing.length} 首，${fmtSize(missing.reduce((a, s) => a + (s.audioSize || 0), 0))}）`;
  dla.title = '把这个歌单里还没缓存的音频都下载到本设备';
  const add = $('#sl-open');
  add.hidden = !isCat;
  add.textContent = '＋ 添加歌曲';
  $('#sl-more').hidden = !isCat;
}

function renderSongList() {
  const q = $('#lib-filter').value.trim();
  const list = $('#lib-list');
  const items = visibleSongs();
  list.classList.toggle('filtering', !!q);
  renderListHeader(items);
  if (!items.length) {
    const msg = !state.songs.length ? '曲库为空。点左上「＋ 导入歌曲」导入本地音频与歌词，或联网搜索歌词，都会保存在这里。'
      : q ? '没有匹配的歌曲'
        : currentCat === 'none' ? '所有歌都已经放进歌单了。'
          : '这个歌单还没有歌：点上方「＋ 添加歌曲」，或在「全部歌曲」里把歌拖到左侧这个歌单上。';
    list.replaceChildren(h('div', { class: 'lib-empty muted', text: msg }));
    return;
  }
  list.replaceChildren(...items.map((s, i) => {
    const current = state.song?.id === s.id;
    const row = h('div', {
      class: `lib-item sl-row${current ? ' current' : ''}`,
      role: 'button', tabindex: '0', dataset: { id: s.id },
    });
    const handle = h('span', { class: 'drag-handle', title: q ? '筛选时不能排序' : '拖动排序（所有设备同步）；拖到左侧歌单上可加入歌单', 'aria-label': '拖动排序', html: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>' });
    const no = h('span', { class: 'c-no', html: current ? EQ : String(i + 1).padStart(2, '0') });
    const title = h('div', { class: 'c-title' }, coverEl(s),
      h('div', { class: 'lib-body', html: `<div class="lib-title" title="${escapeHTML(s.title || '')}">${escapeHTML(s.title || '未命名')}</div>
        <div class="lib-meta">${songBadges(s, { withCats: currentCat === 'all' })}<span class="lib-artist">${escapeHTML(s.artist || SOURCE_LABEL[s.source] || '')}</span></div>` }));
    const album = h('span', { class: 'c-album', title: s.album || '', text: s.album || '' });
    const cache = h('div', { class: 'c-cache' }, cacheWidget(s));
    const dur = h('span', { class: 'c-dur lib-dur', text: fmtDur(s.duration) });
    const more = h('button', { type: 'button', class: 'lib-more', title: '歌单 / 歌曲信息', text: '⋯' });
    more.addEventListener('click', (e) => { e.stopPropagation(); openSongMenu(s, more); });
    row.append(handle, no, title, album, cache, dur, more);
    row.addEventListener('click', (e) => { if (!e.target.closest('.drag-handle, .lib-cache, .lib-more')) openFromList(s); });
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') openFromList(s); });
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); openSongMenu(s, more); });
    handle.addEventListener('pointerdown', (e) => startDrag(e, row));
    return row;
  }));
}

// ---------------------------------------------------------------- 快速选歌（歌词 / 单词本视图，停靠在左侧）
// 打开后一直保持（切歌不关闭），再点播放条上的歌单按钮或 × 才关闭；宽屏下记住开关状态。窄屏时是浮层，选歌后自动关闭。
let drawerOpen = (() => {
  try { return localStorage.getItem('jls-drawer') === '1' && !window.matchMedia(NARROW).matches; } catch { return false; }
})();
let drawerGroups = (() => {
  try { const v = localStorage.getItem('jls-drawer-open'); return v ? new Set(JSON.parse(v)) : null; } catch { return null; }
})();   // 展开的歌单 id；null = 还没操作过（按当前歌曲所在歌单自动展开）

function saveDrawerGroups() {
  try { localStorage.setItem('jls-drawer-open', JSON.stringify([...drawerGroups])); } catch {}
}

/** 快速选歌当前是否可见（曲库视图有自己的歌单栏，那里不显示） */
export function isDrawerOpen() { return drawerOpen && state.appMode !== 'list'; }

export function toggleDrawer(force) {
  const open = force ?? !isDrawerOpen();
  drawerOpen = open;
  document.body.classList.toggle('drawer-open', open);
  if (!window.matchMedia(NARROW).matches) {
    try { localStorage.setItem('jls-drawer', open ? '1' : '0'); } catch {}
  }
  bus.emit('minimap:render');   // 歌词区宽度变了
  if (!open) { closeMenus(); return; }
  if (state.appMode === 'list') bus.emit('app:mode', 'lyrics');
  if (!drawerGroups) {
    // 第一次打开：展开当前歌曲所在的歌单（没有歌单时展开「全部歌曲」）
    const cur = state.song ? summaryOf(state.song.id) : null;
    const first = cur?.categories?.find(id => categories.some(c => c.id === id));
    drawerGroups = new Set([first || (categories.length ? (cur && !cur.categories?.length ? 'none' : currentCat) : 'all')]);
  }
  renderDrawer();
  const cur = $('#dr-list .dr-song.current');
  if (cur) cur.scrollIntoView({ block: 'center' });
}

function drawerSongRow(s) {
  const current = state.song?.id === s.id;
  const row = h('button', { type: 'button', class: `dr-song${current ? ' current' : ''}`, dataset: { id: s.id } },
    coverEl(s, 'dr-cover'),
    h('span', { class: 'dr-text' },
      h('span', { class: 'dr-name', text: s.title || '未命名' }),
      h('span', { class: 'dr-artist', text: s.artist || SOURCE_LABEL[s.source] || '' })),
    h('span', { class: 'dr-dur', html: current ? EQ : fmtDur(s.duration) }));
  row.addEventListener('click', async () => {
    if (window.matchMedia(NARROW).matches) toggleDrawer(false);   // 宽屏保持打开，方便连续切歌
    if (state.song?.id !== s.id) await openSong(s.id);
    renderLibrary();
  });
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); openSongMenu(s, row); });
  return row;
}

function renderDrawer() {
  if (!isDrawerOpen()) return;
  const list = $('#dr-list');
  const keep = list.scrollTop;
  const q = $('#dr-filter').value.trim().toLowerCase();
  $('#dr-count').textContent = `${state.songs.length} 首`;
  if (q) {
    const hits = state.songs.filter(s => `${s.title} ${s.artist} ${s.album}`.toLowerCase().includes(q));
    list.replaceChildren(...(hits.length ? hits.map(drawerSongRow) : [h('div', { class: 'lib-empty muted', text: '没有匹配的歌曲' })]));
    return;
  }
  const groups = [{ id: 'all', name: '全部歌曲' }, ...categories.map(c => ({ id: c.id, name: c.name }))];
  if (categories.length && catSongs('none').length) groups.push({ id: 'none', name: '未归入歌单' });
  list.replaceChildren(...groups.map(g => {
    const songs = catSongs(g.id);
    const open = drawerGroups.has(g.id);
    const hasCurrent = !!state.song && songs.some(s => s.id === state.song.id);
    const head = h('button', { type: 'button', class: `dr-gh${hasCurrent ? ' has-current' : ''}`, 'aria-expanded': String(open) },
      h('span', { class: 'dr-chev', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>' }),
      g.id === 'all' ? h('span', { class: 'dr-gcover icon', html: ICON_ALL })
        : g.id === 'none' ? h('span', { class: 'dr-gcover icon', html: ICON_NONE }) : playlistCover(g.id, 'dr-gcover'),
      h('span', { class: 'dr-gname', text: g.name }),
      h('span', { class: 'dr-gcount', text: String(songs.length) }));
    head.addEventListener('click', () => {
      if (drawerGroups.has(g.id)) drawerGroups.delete(g.id); else drawerGroups.add(g.id);
      saveDrawerGroups();
      renderDrawer();
    });
    const box = h('div', { class: `dr-group${open ? ' open' : ''}`, dataset: { cat: g.id } }, head);
    if (open) {
      box.append(h('div', { class: 'dr-songs' },
        ...(songs.length ? songs.map(drawerSongRow) : [h('div', { class: 'dr-empty muted small', text: '这个歌单还没有歌' })])));
    }
    return box;
  }));
  list.scrollTop = keep;
}

// ---------------------------------------------------------------- 播放条左下角：当前歌曲
function renderNowPlaying() {
  const s = state.song;
  const box = $('#np');
  box.classList.toggle('empty', !s);
  if (!s) {
    $('#np-cover').replaceChildren(h('div', { class: 'np-cover-img icon', html: ICON_ALL }));
    $('#np-title').textContent = '未打开歌曲';
    $('#np-artist').textContent = '从曲库里选一首歌';
    return;
  }
  const sum = summaryOf(s.id) || { id: s.id, title: s.title, coverVersion: '' };
  $('#np-cover').replaceChildren(coverEl(sum, 'np-cover-img'));
  $('#np-title').textContent = s.title || '未命名歌曲';
  $('#np-artist').textContent = s.artist || '';
}

function renderLibrary() {
  if (drag) return; // 拖动中不重建列表
  renderSidebar();
  renderSongList();
  renderDrawer();
  renderNowPlaying();
  bus.emit('library:rendered');
}

/** 曲库视图：把当前歌曲滚动到可见位置 */
export function revealCurrentInList() {
  const row = $('#lib-list .sl-row.current');
  if (row) row.scrollIntoView({ block: 'center' });
}

// ---------------------------------------------------------------- 拖拽：排序 / 拖到歌单（鼠标 / 触屏通用，Pointer Events）
let drag = null;

function startDrag(e, item) {
  if ($('#lib-filter').value.trim()) { toast('请先清空搜索再拖动排序'); return; }
  e.preventDefault();
  closeMenus();
  const list = $('#lib-list');
  drag = { item, list, startOrder: [...list.querySelectorAll('.lib-item')].map(el => el.dataset.id), overCat: null };
  item.classList.add('dragging');
  document.body.classList.add('lib-dragging');
  e.target.setPointerCapture?.(e.pointerId);
  document.addEventListener('pointermove', onDragMove);
  document.addEventListener('pointerup', endDrag, { once: true });
  document.addEventListener('pointercancel', endDrag, { once: true });
}

function onDragMove(e) {
  if (!drag) return;
  const { item, list } = drag;
  // 悬停在左侧某个歌单上：准备加入歌单
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const target = under?.closest?.('.pl-item[data-cat]:not(.fixed)');
  $$('.pl-item.drop').forEach(c => c.classList.remove('drop'));
  drag.overCat = target ? target.dataset.cat : null;
  if (target) { target.classList.add('drop'); return; }
  const others = [...list.querySelectorAll('.lib-item:not(.dragging)')];
  let before = null;
  for (const el of others) {
    const r = el.getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) { before = el; break; }
  }
  if (before) { if (item.nextElementSibling !== before) list.insertBefore(item, before); }
  else if (list.lastElementChild !== item) list.appendChild(item);
  // 靠近边缘时自动滚动
  const lr = list.getBoundingClientRect();
  if (e.clientY < lr.top + 30) list.scrollTop -= 12;
  else if (e.clientY > lr.bottom - 30) list.scrollTop += 12;
}

async function endDrag() {
  document.removeEventListener('pointermove', onDragMove);
  if (!drag) return;
  const { item, list, startOrder, overCat } = drag;
  drag = null;
  item.classList.remove('dragging');
  document.body.classList.remove('lib-dragging');
  $$('.pl-item.drop').forEach(c => c.classList.remove('drop'));
  const songId = item.dataset.id;
  if (overCat) {
    // 拖到歌单上：加入歌单（列表顺序不变）
    try {
      categories = await api.addToCategory(overCat, [songId]);
      const s = summaryOf(songId);
      if (s && !(s.categories || []).includes(overCat)) s.categories = [...(s.categories || []), overCat];
      toast(`已加入「${catName(overCat)}」`, { ms: 1400 });
    } catch (err) { toast('加入歌单失败：' + err.message, { error: true }); }
    renderLibrary();
    return;
  }
  const visible = [...list.querySelectorAll('.lib-item')].map(el => el.dataset.id);
  if (visible.join() === startOrder.join()) { renderLibrary(); return; }
  // 在歌单视图里拖动：把它放到整个曲库里「可见的下一首」之前（只改变它在这个歌单里的相对位置）
  const all = state.songs.map(s => s.id).filter(id => id !== songId);
  const vi = visible.indexOf(songId);
  const nextVisible = visible[vi + 1];
  const prevVisible = visible[vi - 1];
  let pos = nextVisible ? all.indexOf(nextVisible) : (prevVisible ? all.indexOf(prevVisible) + 1 : all.length);
  if (pos < 0) pos = all.length;
  all.splice(pos, 0, songId);
  const byId = new Map(state.songs.map(s => [s.id, s]));
  state.songs = all.map(id => byId.get(id)).filter(Boolean);
  try {
    state.songs = await api.setOrder(all);
    toast('顺序已保存（其它设备刷新后同步）', { ms: 1400 });
  } catch (err) {
    toast('排序保存失败：' + err.message, { error: true });
  }
  renderLibrary();
}

/** 窄屏：歌单侧栏以浮层形式滑出 */
export function toggleSidebar(force) {
  const open = force ?? !document.body.classList.contains('sidebar-open');
  document.body.classList.toggle('sidebar-open', open);
}


// ---------------------------------------------------------------- NCM 解码（Web Worker，本机完成）
function decodeNcm(file) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('/static/workers/ncm-worker.js');
    worker.onmessage = (e) => {
      worker.terminate();
      const d = e.data;
      if (d.error) { reject(new Error(d.error)); return; }
      const blob = new Blob([d.buffer.slice(d.offset)], { type: d.mime });
      const ext = { 'audio/flac': 'flac', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav' }[d.mime] || 'mp3';
      // NCM 头部自带专辑封面：一并取出，导入后上传为歌曲封面
      const cover = d.cover ? new Blob([d.cover]) : null;
      resolve({ blob, ext, format: d.format, meta: d.meta, cover });
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'NCM 解析失败')); };
    worker.postMessage(file);
  });
}

/** 统一准备上传的音频：NCM 先还原；返回 {blob, filename, meta} */
export async function prepareAudio(file) {
  if (/\.ncm$/i.test(file.name)) {
    setStatus('正在本机还原 NCM…');
    const res = await decodeNcm(file);
    setStatus(`NCM 已还原为 ${res.format}`);
    const base = file.name.replace(/\.ncm$/i, '');
    return { blob: res.blob, filename: `${base}.${res.ext}`, meta: res.meta, cover: res.cover };
  }
  return { blob: file, filename: file.name, meta: null, cover: null };
}

// ---------------------------------------------------------------- 导入对话框
// 一次选择 / 拖入多个文件，自动识别「歌曲」与「歌词」：扩展名 → MIME → 文件头魔数 / 文本内容。
// 多首歌一起导入时按文件名配对（「歌手 - 歌名.mp3」配「歌手 - 歌名.lrc」）。
const AUDIO_EXT = new Set(['mp3', 'm4a', 'mp4', 'aac', 'flac', 'ogg', 'oga', 'opus', 'wav', 'webm', 'ncm', 'wma', 'ape']);
const LYRIC_EXT = new Set(['lrc', 'txt', 'krc', 'qrc']);
const imp = { files: [], songs: [] };   // files: [{file, kind, text?, prepared?, meta?}]

const baseName = (name) => String(name || '').replace(/\.[^.]+$/, '');
const normName = (name) => baseName(name).toLowerCase()
  .replace(/[\s　_\-－—–~〜()（）\[\]【】「」『』.,，。・･'"]+/g, '');

async function sniff(file) {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const str = String.fromCharCode(...head);
  if (str.startsWith('CTENFDAM')) return 'audio';
  if (str.startsWith('ID3') || str.startsWith('fLaC') || str.startsWith('OggS') || str.startsWith('RIFF')
      || str.slice(4, 8) === 'ftyp' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return 'audio';
  if (file.size < 2 * 1024 * 1024) {
    const text = await readTextFile(file.slice(0, 64 * 1024));
    if (/\[\d{1,3}:\d{1,2}([.:]\d{1,3})?\]/.test(text) || /[぀-ヿ一-鿿]/.test(text)) return 'lyrics';
  }
  return 'unknown';
}

async function classify(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (LYRIC_EXT.has(ext)) return 'lyrics';
  if ((file.type || '').startsWith('audio/')) return 'audio';
  if ((file.type || '').startsWith('text/')) return 'lyrics';
  return sniff(file);
}

function guessFromName(name) {
  const stem = baseName(name).trim();
  const m = stem.match(/^(.+?)\s+-\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { title: stem, artist: '' };
}

function lrcMeta(text) {
  const ti = text.match(/^\s*\[ti:(.*)\]\s*$/mi)?.[1]?.trim() || '';
  const ar = text.match(/^\s*\[ar:(.*)\]\s*$/mi)?.[1]?.trim() || '';
  return { title: ti, artist: ar };
}

/** 文件 → 待导入歌曲列表 [{audio, lyrics, title, artist}] */
function pairFiles() {
  const audios = imp.files.filter(f => f.kind === 'audio');
  const lyrics = imp.files.filter(f => f.kind === 'lyrics');
  const songs = [];
  const used = new Set();
  if (audios.length <= 1) {
    // 单首：唯一的音频 + 最像的那份歌词（同名优先，其次带时间标签的）
    const audio = audios[0] || null;
    let lyric = null;
    if (lyrics.length) {
      const key = audio ? normName(audio.file.name) : '';
      lyric = lyrics.find(l => key && normName(l.file.name) === key)
        || lyrics.find(l => /\[\d{1,3}:\d{2}/.test(l.text || ''))
        || lyrics[0];
      used.add(lyric);
    }
    if (audio || lyric) songs.push({ audio, lyric });
  } else {
    for (const a of audios) {
      const key = normName(a.file.name);
      let lyric = lyrics.find(l => !used.has(l) && normName(l.file.name) === key)
        || lyrics.find(l => !used.has(l) && (normName(l.file.name).includes(key) || key.includes(normName(l.file.name))));
      if (lyric) used.add(lyric);
      songs.push({ audio: a, lyric: lyric || null });
    }
  }
  // 没配上音频的歌词也各自成为一首（只有歌词）
  if (audios.length > 1) lyrics.filter(l => !used.has(l)).forEach(l => songs.push({ audio: null, lyric: l }));
  for (const sg of songs) {
    const fromNcm = sg.audio?.meta;
    const fromLrc = sg.lyric ? lrcMeta(sg.lyric.text || '') : {};
    const fromName = guessFromName((sg.audio || sg.lyric).file.name);
    sg.title = fromNcm?.title || fromLrc.title || fromName.title;
    sg.artist = fromNcm?.artist || fromLrc.artist || fromName.artist;
  }
  imp.songs = songs;
  imp.unused = lyrics.filter(l => !used.has(l) && audios.length <= 1);
}

function renderImport() {
  pairFiles();
  const list = $('#imp-filelist');
  const single = imp.songs.length <= 1;
  $('#imp-single').hidden = !single;
  list.replaceChildren(...imp.files.map((f, i) => {
    const extra = f.kind === 'audio' && f.prepared && f.prepared.filename !== f.file.name ? ` → ${f.prepared.filename.split('.').pop().toUpperCase()}` : '';
    const row = h('div', { class: `imp-file kind-${f.kind}` },
      h('select', { class: 'imp-kind', 'aria-label': '文件类型', title: '识别错了可以手动改' },
        h('option', { value: 'audio', text: '🎵 歌曲', selected: f.kind === 'audio' }),
        h('option', { value: 'lyrics', text: '📝 歌词', selected: f.kind === 'lyrics' }),
        h('option', { value: 'unknown', text: '忽略', selected: f.kind === 'unknown' })),
      h('span', { class: 'imp-fname', title: f.file.name, text: f.file.name + extra }),
      h('span', { class: 'muted small', text: `${(f.file.size / 1048576).toFixed(f.file.size > 1048576 ? 1 : 2)} MB` }),
      h('button', { type: 'button', class: 'icon-btn tiny', 'aria-label': '移除', text: '×' }));
    row.querySelector('select').addEventListener('change', async (e) => {
      f.kind = e.target.value;
      if (f.kind === 'lyrics' && f.text === undefined) f.text = await readTextFile(f.file);
      renderImport();
    });
    row.querySelector('button').addEventListener('click', () => { imp.files.splice(i, 1); renderImport(); });
    return row;
  }));
  const summary = $('#imp-summary');
  if (!imp.files.length) {
    summary.textContent = '';
  } else if (single) {
    const sg = imp.songs[0];
    summary.textContent = sg
      ? `将导入 1 首：${sg.audio ? '有音频' : '无音频'} · ${sg.lyric ? '有歌词' : '无歌词'}`
        + (imp.unused?.length ? `（另有 ${imp.unused.length} 份歌词未使用）` : '')
      : '';
    if (sg) {
      if (!$('#imp-title').dataset.touched) $('#imp-title').value = sg.title || '';
      if (!$('#imp-artist').dataset.touched) $('#imp-artist').value = sg.artist || '';
      if (!$('#imp-lrc').dataset.touched) $('#imp-lrc').value = sg.lyric?.text || '';
    }
  } else {
    summary.replaceChildren(
      h('div', { text: `将导入 ${imp.songs.length} 首（按文件名配对）：` }),
      ...imp.songs.map(sg => h('div', { class: 'imp-pair' },
        h('b', { text: sg.title || '未命名' }), sg.artist ? ` · ${sg.artist}` : '',
        h('span', { class: 'muted small', text: `  ${sg.audio ? '🎵' : '—'} ${sg.lyric ? '📝 ' + sg.lyric.file.name : '无歌词'}` }))));
  }
  $('#imp-submit').textContent = imp.songs.length > 1 ? `导入 ${imp.songs.length} 首` : '导入';
}

async function addFiles(fileList) {
  const files = [...fileList];
  for (const file of files) {
    const entry = { file, kind: await classify(file) };
    if (entry.kind === 'lyrics') entry.text = await readTextFile(file);
    imp.files.push(entry);
  }
  renderImport();
  // NCM 先在本机还原（并读出歌名 / 歌手）
  for (const entry of imp.files) {
    if (entry.kind === 'audio' && /\.ncm$/i.test(entry.file.name) && !entry.prepared) {
      try {
        entry.prepared = await prepareAudio(entry.file);
        entry.meta = entry.prepared.meta;
      } catch (e) {
        toast(`NCM 还原失败（${entry.file.name}）：${e.message}`, { error: true });
        entry.kind = 'unknown';
      }
      renderImport();
    }
  }
}

export function openImport(files = [], { pick = false } = {}) {
  imp.files = [];
  imp.songs = [];
  for (const id of ['#imp-title', '#imp-artist', '#imp-lrc']) { $(id).value = ''; delete $(id).dataset.touched; }
  $('#imp-progress').hidden = true;
  $('#imp-submit').disabled = false;
  renderImport();
  if (!$('#dlg-import').open) $('#dlg-import').showModal();
  if (files.length) addFiles(files);
  else if (pick) $('#imp-files').click();
}

function songFormData(sg, overrides = {}) {
  const fd = new FormData();
  fd.append('title', overrides.title ?? sg.title ?? '');
  fd.append('artist', overrides.artist ?? sg.artist ?? '');
  fd.append('lrc', overrides.lrc ?? sg.lyric?.text ?? '');
  return fd;
}

async function submitImport() {
  pairFiles();
  const single = imp.songs.length <= 1;
  let jobs;
  if (single) {
    const sg = imp.songs[0] || { audio: null, lyric: null };
    const lrc = $('#imp-lrc').value;
    if (!sg.audio && !lrc.trim()) { toast('请选择音频 / 歌词文件，或粘贴歌词', { error: true }); return; }
    jobs = [{ sg, fd: songFormData(sg, { title: $('#imp-title').value.trim(), artist: $('#imp-artist').value.trim(), lrc }) }];
  } else {
    jobs = imp.songs.map(sg => ({ sg, fd: songFormData(sg) }));
  }
  $('#imp-submit').disabled = true;
  $('#imp-progress').hidden = false;
  const created = [];
  try {
    for (let i = 0; i < jobs.length; i++) {
      const { sg, fd } = jobs[i];
      let prepared = null;
      if (sg.audio) {
        prepared = sg.audio.prepared || await prepareAudio(sg.audio.file);
        fd.append('audio', prepared.blob, prepared.filename);
      }
      setStatus(jobs.length > 1 ? `导入 ${i + 1}/${jobs.length}：${sg.title || ''}` : '正在上传…');
      const song = await api.createSong(fd, (p) => {
        $('#imp-progress-bar').style.width = `${Math.round(((i + p) / jobs.length) * 100)}%`;
      });
      created.push(song);
      if (sg.audio && song.audio) await putCached(song, fd.get('audio'));
      if (prepared?.cover && !song.cover) {
        try { await api.uploadCover(song.id, prepared.cover, 'ncm'); } catch (e) { console.warn('[cover]', e); }
      }
    }
    $('#dlg-import').close();
    await refreshLibrary();
    const first = created[0];
    await openSong(first.id);
    bus.emit('app:mode', 'lyrics');
    renderLibrary();
    toast(created.length > 1 ? `已导入 ${created.length} 首` : `已导入「${first.title}」`);
    setStatus('');
    if (created.length === 1 && !first.lines?.length && $('#imp-autosearch').checked) {
      bus.emit('search:open', { q: [first.title, first.artist].filter(Boolean).join(' '), bind: true });
    }
  } catch (e) {
    toast('导入失败：' + e.message, { error: true });
    if (created.length) refreshLibrary();
  } finally {
    $('#imp-submit').disabled = false;
  }
}

// ---------------------------------------------------------------- 歌曲信息
export function openSongInfo() {
  const s = state.song;
  if (!s) return;
  $('#si-title').value = s.title || '';
  $('#si-artist').value = s.artist || '';
  $('#si-album').value = s.album || '';
  $('#si-audio').textContent = s.audio ? `${s.audio.name}（${(s.audio.size / 1048576).toFixed(1)} MB）` : '未上传';
  $('#si-remove-audio').hidden = !s.audio;
  renderInfoCover();
  renderInfoCategories();
  if (!$('#dlg-info').open) $('#dlg-info').showModal();
}

function renderInfoCover() {
  const sum = summaryOf(state.song.id) || { id: state.song.id, title: state.song.title, coverVersion: '' };
  $('#si-cover').replaceChildren(coverEl(sum, 'si-cover-img'));
  const src = { embedded: '来自音频文件', ncm: '来自 NCM', user: '手动上传', online: '联网获取' }[state.song.cover?.source] || '';
  $('#si-cover-src').textContent = sum.coverVersion ? src : '没有封面';
  $('#si-cover-remove').hidden = !sum.coverVersion;
}

function renderInfoCategories() {
  const box = $('#si-cats');
  const sum = summaryOf(state.song.id);
  if (!categories.length) {
    box.replaceChildren(h('span', { class: 'muted small', text: '还没有歌单，可在曲库左侧「我的歌单」旁点 ＋ 新建。' }));
    return;
  }
  box.replaceChildren(...categories.map(c => {
    const lab = h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: (sum?.categories || []).includes(c.id) }), c.name);
    lab.querySelector('input').addEventListener('change', async () => {
      const ids = [...box.querySelectorAll('input')].map((el, i) => (el.checked ? categories[i].id : null)).filter(Boolean);
      const res = await api.setSongCategories(state.song.id, ids);
      if (sum) sum.categories = res.categories;
      await refreshCategories();
      renderLibrary();
    });
    return lab;
  }));
}

async function afterCoverChange(res) {
  if (res?.cover) state.song.cover = res.cover;
  await refreshLibrary();
  bus.emit('cover:changed');
  if ($('#dlg-info').open) renderInfoCover();
}

async function replaceAudio(file) {
  const s = state.song;
  if (!s || !file) return;
  try {
    const prepared = await prepareAudio(file);
    setStatus('正在上传音频…');
    const song = await api.uploadAudio(s.id, prepared.blob, prepared.filename, p => setStatus(`正在上传音频 ${Math.round(p * 100)}%`));
    await putCached(song, prepared.blob);
    if (prepared.cover && (!song.cover || song.cover.source !== 'user')) {
      try { await api.uploadCover(song.id, prepared.cover, 'ncm'); } catch {}
    }
    state.song.audio = song.audio;
    state.song.updatedAt = song.updatedAt;
    loadSongAudio(state.song);
    setStatus('音频已更新');
    toast('音频已保存到服务端，下次打开无需重新上传');
    refreshLibrary();
    if ($('#dlg-info').open) openSongInfo();
  } catch (e) {
    toast('上传失败：' + e.message, { error: true });
  }
}

export function initLibrary() {
  $('#lib-filter').addEventListener('input', renderLibrary);
  $('#sl-pl-btn').addEventListener('click', () => toggleSidebar());
  $('#sidebar-scrim').addEventListener('click', () => toggleSidebar(false));
  // 歌单区：展开 / 收起、新建；歌单视图：添加歌曲、⋯ 菜单
  $('#pl-toggle').addEventListener('click', () => {
    plCollapsed = !plCollapsed;
    try { localStorage.setItem('jls-pl-collapsed', plCollapsed ? '1' : '0'); } catch {}
    renderSidebar();
  });
  $('#pl-add').addEventListener('click', () => newCategory());
  $('#sl-open').addEventListener('click', (e) => { e.stopPropagation(); openAddSongsMenu(currentCat, e.currentTarget); });
  $('#sl-more').addEventListener('click', (e) => { e.stopPropagation(); openCatMenu(currentCat, e.currentTarget); });
  // 播放条左下角：当前歌曲 → 在「歌词」和「曲库」之间切换
  const npToggle = () => bus.emit('app:mode', state.appMode === 'lyrics' && state.song ? 'list' : (state.song ? 'lyrics' : 'list'));
  $('#np').addEventListener('click', npToggle);
  $('#np').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); npToggle(); } });
  // 左侧快速选歌栏
  $('#btn-drawer').addEventListener('click', (e) => { e.stopPropagation(); toggleDrawer(); });
  $('#dr-close').addEventListener('click', () => toggleDrawer(false));
  $('#drawer-scrim').addEventListener('click', () => toggleDrawer(false));
  $('#dr-filter').addEventListener('input', renderDrawer);
  $('#dr-collapse').addEventListener('click', () => { drawerGroups = new Set(); saveDrawerGroups(); renderDrawer(); });
  $('#dr-library').addEventListener('click', () => bus.emit('app:mode', 'list'));
  document.body.classList.toggle('drawer-open', drawerOpen);
  bus.on('app:changed', () => { if (isDrawerOpen()) { renderDrawer(); bus.emit('minimap:render'); } });
  $('#dr-list').addEventListener('scroll', closeMenus, { passive: true });

  $$('[data-cmd="import"]').forEach(b => b.addEventListener('click', () => openImport([], { pick: true })));

  $('#imp-files').addEventListener('change', e => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) addFiles(fs); });
  ['#imp-title', '#imp-artist', '#imp-lrc'].forEach(id => $(id).addEventListener('input', () => { $(id).dataset.touched = '1'; }));
  $('#imp-submit').addEventListener('click', submitImport);
  $('#imp-cancel').addEventListener('click', () => $('#dlg-import').close());
  const drop = $('#imp-drop');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('over');
    addFiles(e.dataTransfer.files);
  });

  // 拖文件到页面任意位置：打开导入框
  window.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', e => {
    if (e.target.closest?.('#imp-drop')) return;
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    if ($('#dlg-import').open) addFiles(e.dataTransfer.files);
    else openImport([...e.dataTransfer.files]);
  });

  $('#si-save').addEventListener('click', async () => {
    const patch = { title: $('#si-title').value.trim(), artist: $('#si-artist').value.trim(), album: $('#si-album').value.trim() };
    try {
      const song = await api.patchSong(state.song.id, patch);
      Object.assign(state.song, { title: song.title, artist: song.artist, album: song.album });
      updateSongHeader();
      refreshLibrary();
      $('#dlg-info').close();
    } catch (e) { toast('保存失败：' + e.message, { error: true }); }
  });
  $('#si-cover-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { await afterCoverChange(await api.uploadCover(state.song.id, f, 'user')); toast('封面已更新'); }
    catch (err) { toast('上传失败：' + err.message, { error: true }); }
  });
  $('#si-cover-fetch').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '查找中…';
    try {
      const res = await api.fetchCover(state.song.id);
      await afterCoverChange(res);
      toast(`已从${res.source}获取封面`);
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      btn.disabled = false;
      btn.textContent = '联网查找封面';
    }
  });
  $('#si-cover-remove').addEventListener('click', async () => {
    await api.deleteCover(state.song.id);
    state.song.cover = null;
    await afterCoverChange(null);
  });
  $('#si-audio-file').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; replaceAudio(f); });
  $('#si-remove-audio').addEventListener('click', async () => {
    if (!confirm('删除这首歌的音频文件？歌词与修改会保留。')) return;
    const song = await api.deleteAudio(state.song.id);
    state.song.audio = song.audio;
    loadSongAudio(state.song);
    refreshLibrary();
    openSongInfo();
  });
  $('#si-delete').addEventListener('click', async () => {
    const s = state.song;
    if (!confirm(`从曲库删除「${s.title}」？音频、歌词和全部修改记录都会被删除，无法恢复。`)) return;
    await api.deleteSong(s.id);
    $('#dlg-info').close();
    state.song = null;
    try { localStorage.removeItem('jls-last-song'); } catch {}
    bus.emit('song:closed');
    bus.emit('app:mode', 'list');
    refreshLibrary();
  });
  $('#si-cancel').addEventListener('click', () => $('#dlg-info').close());
  bus.on('song:opened', refreshLibrary);
  bus.on('song:closed', renderLibrary);
  document.addEventListener('click', (e) => { if (!e.target.closest('.lib-menu, .lib-more, .pl-more, #sl-open, #sl-more')) closeMenus(); });
  $('#lib-list').addEventListener('scroll', closeMenus, { passive: true });
  // 下载进度：节流刷新列表
  let pending = false;
  bus.on('cache:progress', () => {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; renderLibrary(); }, 250);
  });
  bus.on('cache:changed', refreshCacheIndex);
  bus.on('cache:error', ({ error }) => { if (error?.name !== 'AbortError') toast('下载失败：' + (error?.message || error), { error: true }); renderLibrary(); });
  $('#lib-download-all').addEventListener('click', async () => {
    // 只下载当前歌单里的歌（「全部歌曲」= 整个曲库）
    const todo = catSongs(currentCat).filter(s => ['missing', 'outdated'].includes(cacheState(s)));
    for (const s of todo) {
      try { await downloadAudio(s); } catch (e) { if (e?.name === 'AbortError') continue; }
    }
  });
  // 其它设备可能改了曲库（新增 / 排序）：回到本页面时刷新
  let lastRefresh = Date.now();
  const maybeRefresh = () => {
    if (document.visibilityState !== 'visible' || Date.now() - lastRefresh < 5000 || drag) return;
    lastRefresh = Date.now();
    refreshLibrary();
  };
  window.addEventListener('focus', maybeRefresh);
  document.addEventListener('visibilitychange', maybeRefresh);
  setInterval(maybeRefresh, 30000);
  bus.on('library:refresh', refreshLibrary);
  bus.on('audio:replace', replaceAudio);
}
