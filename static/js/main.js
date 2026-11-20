// 入口：加载设置 → 初始化各模块 → 绑定全局交互
import { $, $$, toast, bus, debounce, isTypingTarget, setStatus } from './util.js';
import { state, lineById } from './state.js';
import { api } from './api.js';
import { applyDisplayClasses, renderSong, rerenderAllLines, renderLineContent } from './render.js';
import { initMinimap, renderMinimap } from './minimap.js';
import { setUserDict, ensureTokenizer } from './analyzer.js';
import {
  initPlayer, setRate, stepRate, togglePlay, stepLine, toggleLoopCurrent, seekLyric, playLine, play, pause,
  player, noteUserScroll, startTapSync, tap, untap, tapSync, clearSegment, centerLine, RATES, calibrateOffset,
} from './player.js';
import { initEditor, setEditing, openLineEditor, openFulltext, openHistory, openDictionary } from './editor.js';
import { initSong, openSong, updateSongHeader, translateMissing, analyzeSong, fetchWordTiming, clearWordTiming } from './song.js';
import { initLibrary, refreshLibrary, openImport, openSongInfo, toggleSidebar, toggleDrawer, isDrawerOpen, revealCurrentInList } from './library.js';
import { initSearch, openSearch, openMarumaru } from './search.js';
import { initExport, openExport } from './export.js';
import { lineStart } from './timing.js';
import { initVocab, openVocab } from './vocab.js';
import { audioMode, setAudioMode, clearAll as clearAudioCache, storageEstimate, fmtSize } from './cache.js';

// ---------------------------------------------------------------- 设置
const saveSettings = debounce(async (patch) => {
  try { await api.saveSettings(patch); } catch (e) { console.warn('设置保存失败', e); }
}, 400);
let pendingPatch = {};
function patchSettings(patch, { rerender = false } = {}) {
  Object.assign(state.settings, patch);
  pendingPatch = { ...pendingPatch, ...patch };
  const p = pendingPatch;
  saveSettings(p);
  setTimeout(() => { if (pendingPatch === p) pendingPatch = {}; }, 500);
  applyDisplayClasses();
  syncSettingsUI();
  if (rerender) rerenderAllLines();
  syncFab();
  bus.emit('minimap:render');
}
bus.on('settings:patch', (p) => patchSettings(p));

function syncSettingsUI() {
  const s = state.settings;
  $$('#settings [data-set]').forEach(el => {
    const key = el.dataset.set;
    if (el.type === 'checkbox') el.checked = !!s[key];
    else if (el.type === 'radio') el.checked = String(s[key]) === el.value;
    else el.value = String(s[key] ?? '');
  });
}

function initSettingsUI() {
  const RERENDER = new Set(['layout', 'kanaScript', 'longLineChars']);
  $$('#settings [data-set]').forEach(el => {
    el.addEventListener('change', () => {
      const key = el.dataset.set;
      let val;
      if (el.type === 'checkbox') val = el.checked;
      else if (el.type === 'radio') { if (!el.checked) return; val = el.value; }
      else if (el.type === 'range' || el.type === 'number') val = Number(el.value);
      else val = el.value;
      patchSettings({ [key]: val }, { rerender: RERENDER.has(key) });
      if (key === 'preservePitch') $('#audio').preservesPitch = val;
    });
  });
  $('#btn-settings').addEventListener('click', (e) => { e.stopPropagation(); togglePopover('#settings', '#btn-settings'); });
  $('#btn-more').addEventListener('click', (e) => { e.stopPropagation(); togglePopover('#more-menu', '#btn-more'); });
  document.addEventListener('click', (e) => {
    $$('.popover:not([hidden])').forEach(p => {
      if (!p.contains(e.target)) p.hidden = true;
    });
  });
  $('#btn-theme').addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(state.settings.theme || 'auto') + 1) % 3];
    patchSettings({ theme: next });
    toast({ auto: '主题：跟随系统', light: '主题：浅色', dark: '主题：深色' }[next], { ms: 1000 });
  });
}

function togglePopover(sel, anchorSel) {
  const pop = $(sel);
  const willOpen = pop.hidden;
  $$('.popover').forEach(p => { p.hidden = true; });
  if (!willOpen) return;
  pop.hidden = false;
  const a = $(anchorSel).getBoundingClientRect();
  const w = pop.offsetWidth;
  pop.style.top = `${a.bottom + 6}px`;
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, a.right - w))}px`;
}

// ---------------------------------------------------------------- 歌词区交互
function initLyricsInteractions() {
  const view = $('#lyrics');
  view.addEventListener('click', (e) => {
    const cmd = e.target.closest('[data-cmd]');
    if (cmd) { runCommand(cmd.dataset.cmd); return; }
    const lineEl = e.target.closest('.line');
    if (!lineEl) return;
    const line = lineById(lineEl.dataset.id);
    if (!line) return;
    const tool = e.target.closest('.tool');
    if (tool) {
      e.stopPropagation();
      const act = tool.dataset.act;
      if (act === 'play') {
        if (state.settings.linePlayMode === 'continue') {
          // 连续模式：从这一句开始正常往下播放
          clearSegment();
          seekLyric(Math.max(0, lineStart(line) - 0.05));
          play();
        } else if (player.segment && !player.segment.loop && player.segment.lineId === line.id) {
          clearSegment();
          pause();
        } else {
          playLine(line);   // 单句模式：只播这一句，播完自动停
        }
      } else if (act === 'focus') toggleFocus(line);
      else if (act === 'edit') openLineEditor(line);
      return;
    }
    if (state.editing) {
      const w = e.target.closest('.jp .w, .ro .rw');
      if (w) bus.emit('word:click', { ev: e, el: lineEl.querySelector(`.jp [data-wi="${w.dataset.wi}"]`) || w });
      return;
    }
    if (window.getSelection()?.toString()) return;
    clearSegment();
    seekLyric(Math.max(0, lineStart(line) - 0.05));
    centerLine(lineEl);
  });
  view.addEventListener('dblclick', (e) => {
    const lineEl = e.target.closest('.line');
    if (!lineEl || e.target.closest('.tool')) return;
    const line = lineById(lineEl.dataset.id);
    if (line) {
      window.getSelection()?.removeAllRanges();
      const w = e.target.closest('[data-wi]');
      openLineEditor(line, { focusWord: w ? Number(w.dataset.wi) : -1 });
    }
  });
  // 悬停：原文词 ↔ 罗马音词 互相高亮
  view.addEventListener('mouseover', (e) => {
    const w = e.target.closest('[data-wi]');
    $$('.hover-pair').forEach(el => el.classList.remove('hover-pair'));
    if (!w) return;
    const lineEl = w.closest('.line');
    lineEl?.querySelectorAll(`[data-wi="${w.dataset.wi}"]`).forEach(el => el.classList.add('hover-pair'));
  });
  view.addEventListener('wheel', noteUserScroll, { passive: true });
  view.addEventListener('touchmove', noteUserScroll, { passive: true });
}

// ---------------------------------------------------------------- 命令
function runCommand(cmd) {
  $$('.popover').forEach(p => { p.hidden = true; });
  switch (cmd) {
    case 'import': return openImport([], { pick: true });
    case 'search': return openSearch({});
    case 'search-bind': return openSearch({ bind: true });
    case 'fulltext': return openFulltext();
    case 'history': return openHistory();
    case 'dictionary': return openDictionary();
    case 'export': return openExport();
    case 'info': return state.song ? openSongInfo() : toast('请先打开一首歌');
    case 'marumaru': return state.song ? openMarumaru() : toast('请先打开一首歌');
    case 'translate': return translateMissing();
    case 'tapsync': return startTapSync();
    case 'wordtiming':
      if (!state.song?.lines?.length) return toast('请先打开有歌词的歌曲');
      if (state.song.timeline !== 'synced') return toast('当前是估算时间轴：先「打轴」或导入带时间的 LRC，再获取逐字时间轴');
      return fetchWordTiming(state.song, { quiet: false });
    case 'clear-wordtiming': return clearWordTiming();
    case 'reanalyze':
      if (!state.song) return;
      if (!confirm('重新自动分析本曲所有「未手动编辑」的行？手动修改过的行保持不变。')) return;
      return analyzeSong({ onlyUnedited: true });
    case 'upload-audio': return $('#si-audio-file').click();
    default: return null;
  }
}

// ---------------------------------------------------------------- 键盘
function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    const k = e.key;
    if (k === 'Escape' && isDrawerOpen()) { toggleDrawer(false); return; }
    if (state.appMode === 'vocab') return;
    if (k === 'l' || k === 'L') { if (state.appMode === 'lyrics') toggleDrawer(); else setAppMode('lyrics'); return; }
    if (state.appMode !== 'lyrics') {
      // 曲库视图：只保留播放相关的快捷键
      if (k === ' ' || e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (k === '[') stepRate(-1);
      else if (k === ']') stepRate(1);
      return;
    }
    if (tapSync.active) {
      if (k === 't' || k === 'T' || k === 'Enter') { e.preventDefault(); tap(); return; }
      if (k === 'Backspace') { e.preventDefault(); untap(); return; }
    }
    if (k === ' ' || e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (k === 'ArrowLeft') { e.preventDefault(); stepLine(-1); }
    else if (k === 'ArrowRight') { e.preventDefault(); stepLine(1); }
    else if (k === '[') stepRate(-1);
    else if (k === ']') stepRate(1);
    else if (k === 'r' || k === 'R') toggleLoopCurrent();
    else if (k === 'a' || k === 'A') calibrateOffset();
    else if (k === 'm' || k === 'M') toggleLineMode();
    else if (k === 'f' || k === 'F') toggleFocus(state.song?.lines?.[state.activeIdx]);
    else if (k === 'e' || k === 'E') setEditing(!state.editing);
    else if (k === 'Escape' && state.editing) setEditing(false);
  });
}

// ---------------------------------------------------------------- 应用视图（曲库 / 歌词 / 单词本）
const APP_MODES = ['list', 'lyrics', 'vocab'];

function setAppMode(mode) {
  if (!APP_MODES.includes(mode)) mode = 'lyrics';
  $$('.popover').forEach(p => { p.hidden = true; });
  if (mode !== 'lyrics' && state.editing) setEditing(false);
  const prev = state.appMode;
  state.appMode = mode;
  document.body.dataset.app = mode;
  $$('button[data-app]').forEach(b => b.classList.toggle('active', b.dataset.app === mode));
  try { localStorage.setItem('jls-app', mode); } catch {}
  toggleSidebar(false);
  if (mode === 'list') {
    toggleDrawer(false);
    setTimeout(revealCurrentInList, 0);
  } else if (mode === 'vocab') {
    openVocab();
  } else {
    // 歌词区隐藏后滚动位置会丢失：回来时把当前句重新居中
    setTimeout(() => {
      renderMinimap();
      if (prev !== 'lyrics') centerLine(state.song?.lines?.[state.activeIdx]?._el, 'auto');
    }, 30);
  }
}

// ---------------------------------------------------------------- 关注的难句
async function toggleFocus(line) {
  if (!line || !state.song) return;
  line.focus = !line.focus;
  renderLineContent(line);
  bus.emit('minimap:render');
  try {
    await api.patchLines(state.song.id, [{ id: line.id, focus: line.focus }], { record: false });
    const n = state.song.lines.filter(l => l.focus).length;
    toast(line.focus ? `已关注这一句（本曲共 ${n} 句）` : `已取消关注（还剩 ${n} 句）`, { ms: 1300 });
  } catch (e) {
    line.focus = !line.focus;
    renderLineContent(line);
    bus.emit('minimap:render');
    toast('保存失败：' + e.message, { error: true });
  }
}

// ---------------------------------------------------------------- 歌词区悬浮按钮 & 单句/连续
const FONT_STEPS = [1, 1.15, 1.3, 0.9];

function syncFab() {
  const s = state.settings;
  const kana = $('#lyric-fab [data-fab="kana"]');
  kana.textContent = s.kanaScript === 'katakana' ? 'ア' : 'あ';
  kana.classList.toggle('on', !!s.showFurigana);
  kana.classList.toggle('off', !s.showFurigana);
  kana.title = `假名注音：${!s.showFurigana ? '已隐藏' : s.kanaScript === 'katakana' ? '片假名' : '平假名'}（点击切换：平假名 → 片假名 → 隐藏）`;
  for (const [k, key] of [['romaji', 'showRomaji'], ['zh', 'showZh']]) {
    const b = $(`#lyric-fab [data-fab="${k}"]`);
    b.classList.toggle('on', !!s[key]);
    b.classList.toggle('off', !s[key]);
  }
  const single = s.linePlayMode !== 'continue';
  const lm = $('#btn-linemode');
  lm.textContent = single ? '单句' : '连续';
  lm.classList.toggle('continue', !single);
  lm.setAttribute('aria-pressed', String(single));
  $$('.line .tool[data-act="play"]').forEach(b => {
    b.title = single ? '只播放这一句（播完自动停；再点停止）' : '从这一句开始播放';
  });
}

function initFab() {
  $('#lyric-fab').addEventListener('click', (e) => {
    const b = e.target.closest('[data-fab]');
    if (!b) return;
    const s = state.settings;
    switch (b.dataset.fab) {
      case 'kana':
        // 平假名 → 片假名 → 隐藏 → 平假名
        if (!s.showFurigana) patchSettings({ showFurigana: true, kanaScript: 'hiragana' }, { rerender: true });
        else if (s.kanaScript !== 'katakana') patchSettings({ kanaScript: 'katakana' }, { rerender: true });
        else patchSettings({ showFurigana: false });
        break;
      case 'romaji': patchSettings({ showRomaji: !s.showRomaji }); break;
      case 'zh': patchSettings({ showZh: !s.showZh }); break;
      case 'font': {
        const i = FONT_STEPS.findIndex(v => Math.abs(v - (s.fontScale || 1)) < 0.01);
        patchSettings({ fontScale: FONT_STEPS[(i + 1) % FONT_STEPS.length] });
        break;
      }
      default: break;
    }
  });
  $('#btn-linemode').addEventListener('click', toggleLineMode);
}

function toggleLineMode() {
  const next = state.settings.linePlayMode === 'continue' ? 'single' : 'continue';
  patchSettings({ linePlayMode: next });
  if (next === 'continue') clearSegment();
  toast(next === 'single' ? '单句模式：点行内 ▶ 只播这一句' : '连续模式：点行内 ▶ 从这一句开始一直播放', { ms: 1600 });
}

// ---------------------------------------------------------------- 本设备设置（音频缓存策略，存在 localStorage）
function initDeviceSettings() {
  const sel = $('#set-audio-mode');
  sel.value = audioMode();
  sel.addEventListener('change', () => setAudioMode(sel.value));
  bus.on('audio-mode:changed', (m) => { sel.value = m; });
  const usage = async () => {
    const est = await storageEstimate();
    $('#set-cache-usage').textContent = est ? `已用 ${fmtSize(est.usage)} / 可用约 ${fmtSize(est.quota)}` : '';
  };
  $('#btn-settings').addEventListener('click', usage);
  $('#set-cache-clear').addEventListener('click', async () => {
    if (!confirm('清除本设备上所有已缓存的音频？（服务器上的文件不受影响，可随时重新下载）')) return;
    await clearAudioCache();
    usage();
    toast('已清除本设备音频缓存');
  });
}

// ---------------------------------------------------------------- 启动
async function boot() {
  try {
    state.settings = await api.settings();
  } catch (e) {
    state.settings = {};
    toast('无法连接后端：' + e.message, { error: true, ms: 6000 });
  }
  applyDisplayClasses();
  initSettingsUI();
  syncSettingsUI();
  initPlayer();
  initEditor();
  initSong();
  initLibrary();
  initSearch();
  initExport();
  initVocab();
  bus.on('app:mode', setAppMode);
  bus.on('song:open', (id) => openSong(id));
  initDeviceSettings();
  initFab();
  syncFab();
  initMinimap();
  bus.on('song:opened', syncFab);
  initLyricsInteractions();
  initKeyboard();

  const rateSel = $('#rate-select');
  rateSel.replaceChildren(...RATES.map(r => new Option(`${r}×`, String(r))));
  setRate(state.settings.playbackRate || 1, { save: false });

  $$('[data-cmd]').forEach(el => {
    if (el.closest('#lyrics')) return;
    if (el.dataset.cmd === 'import') return; // 已在 library.js 绑定
    el.addEventListener('click', (e) => { e.stopPropagation(); runCommand(el.dataset.cmd); });
  });
  $('#btn-edit-mode').addEventListener('click', () => setEditing(!state.editing));
  $$('button[data-app]').forEach(b => b.addEventListener('click', () => setAppMode(b.dataset.app)));

  bus.on('song:closed', () => { renderSong(); updateSongHeader(); });

  try { setUserDict(await api.dictionary()); } catch {}
  await refreshLibrary();
  renderSong();
  updateSongHeader();
  let last = null;
  try { last = localStorage.getItem('jls-last-song'); } catch {}
  if (!(last && state.songs.some(s => s.id === last))) last = state.songs[0]?.id || null;
  if (last) await openSong(last);
  // 恢复上次的视图（没有歌曲时显示曲库）
  let mode = null;
  try { mode = localStorage.getItem('jls-app'); } catch {}
  if (!APP_MODES.includes(mode)) mode = state.song ? 'lyrics' : 'list';
  if (!state.song && mode === 'lyrics') mode = 'list';
  setAppMode(mode);
  // 空闲时预热词典，首次分析更快
  setTimeout(() => ensureTokenizer().then(() => { if (!state.song) setStatus('词典已就绪'); }).catch(() => {}), 800);
}

boot();
