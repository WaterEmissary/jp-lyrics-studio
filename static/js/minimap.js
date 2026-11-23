// 歌词缩略图（类似 CodeGlance）：占满歌词区右侧的一条竖向缩略图，
//   * 每一句画成一根横条（长度 ≈ 这句的长度），位置与歌词区实际排版一一对应；
//   * 颜色：关注的难句（橙）、手动编辑过（蓝点）、当前句（实色）、已唱过（深灰）；
//   * 半透明框 = 当前可见范围，可以拖动；点击任意位置跳过去；悬停显示这一句的原文。
import { $, bus } from './util.js';
import { state } from './state.js';
import { noteUserScroll } from './player.js';

let dragging = null;     // {grab: 视口框内按下的位置}
let scale = 1;

const view = () => $('#lyrics');

function trackHeight() {
  return $('#minimap').clientHeight;
}

export function renderMinimap() {
  const mm = $('#minimap');
  const track = $('#mm-track');
  const lines = state.song?.lines || [];
  const v = view();
  const visible = lines.length > 0 && state.appMode === 'lyrics' && !!lines[0]?._el;
  mm.hidden = !visible;
  if (!visible) return;
  const H = trackHeight();
  const total = v.scrollHeight || 1;
  scale = Math.min(H / total, 0.25);
  track.style.height = `${total * scale}px`;
  const frag = document.createDocumentFragment();
  lines.forEach((ln, i) => {
    const el = ln._el;
    if (!el) return;
    const bar = document.createElement('div');
    bar.className = 'mm-bar';
    bar.dataset.idx = String(i);
    const len = [...(ln.text || '')].length;
    bar.style.top = `${el.offsetTop * scale}px`;
    bar.style.height = `${Math.max(2, Math.min(6, el.offsetHeight * scale * 0.55))}px`;
    bar.style.width = `calc((100% - 18px) * ${(0.2 + 0.8 * Math.min(1, len / 26)).toFixed(3)})`;   // 左 10px + 右留 8px
    if (ln.focus) bar.classList.add('focus');
    if (ln.wordsEdited || ln.romaji) bar.classList.add('edited');
    frag.append(bar);
  });
  track.replaceChildren(frag);
  updateActive();
  updateViewport();
}

export function updateActive() {
  const idx = state.activeIdx;
  document.querySelectorAll('#mm-track .mm-bar').forEach(b => {
    const i = Number(b.dataset.idx);
    b.classList.toggle('active', i === idx);
    b.classList.toggle('past', idx >= 0 && i < idx);
  });
}

function updateViewport() {
  const v = view();
  const box = $('#mm-view');
  box.style.top = `${v.scrollTop * scale}px`;
  box.style.height = `${Math.max(12, v.clientHeight * scale)}px`;
}

// 每个函数各自节流（共用一个句柄会让滚动更新把待执行的重绘取消掉）
const pending = new Map();
const schedule = (fn) => {
  if (pending.has(fn)) return;
  pending.set(fn, requestAnimationFrame(() => { pending.delete(fn); fn(); }));
};

function scrollToTrackY(y, { center = true } = {}) {
  const v = view();
  const target = y / scale - (center ? v.clientHeight / 2 : 0);
  v.style.scrollBehavior = 'auto';
  v.scrollTop = Math.max(0, Math.min(v.scrollHeight - v.clientHeight, target));
  v.style.scrollBehavior = '';
}

function trackY(e) {
  return e.clientY - $('#mm-track').getBoundingClientRect().top;
}

function showTip(e) {
  const tip = $('#mm-tip');
  if (dragging) { tip.hidden = true; return; }
  const y = trackY(e);
  // 找到离指针最近的一句
  let best = null, gap = Infinity;
  document.querySelectorAll('#mm-track .mm-bar').forEach(b => {
    const d = Math.abs(parseFloat(b.style.top) - y);
    if (d < gap) { gap = d; best = b; }
  });
  if (!best || gap > 14) { tip.hidden = true; return; }
  const ln = state.song?.lines?.[Number(best.dataset.idx)];
  if (!ln) { tip.hidden = true; return; }
  tip.textContent = `${Number(best.dataset.idx) + 1}. ${ln.text}${ln.focus ? '  ★关注' : ''}`;
  tip.hidden = false;
  const mmRect = $('#minimap').getBoundingClientRect();
  tip.style.top = `${Math.max(0, e.clientY - mmRect.top - 12)}px`;
}

export function initMinimap() {
  const mm = $('#minimap');
  const v = view();
  v.addEventListener('scroll', () => schedule(updateViewport), { passive: true });
  window.addEventListener('resize', () => schedule(renderMinimap));
  bus.on('song:opened', () => setTimeout(renderMinimap, 50));
  bus.on('line:active', () => updateActive());
  bus.on('minimap:render', () => schedule(renderMinimap));
  bus.on('song:changed', () => schedule(renderMinimap));
  // 歌词内容变化（分析完成、编辑、显示设置切换）都会改变行高：观察歌词区尺寸变化后重绘
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(() => schedule(renderMinimap));
    const observeAll = () => {
      ro.disconnect();
      ro.observe(v);
      v.querySelectorAll('.line').forEach(el => ro.observe(el));
    };
    observeAll();
    // 整首重新渲染（切歌 / 时间重排）时重新观察每一行
    new MutationObserver(() => { observeAll(); schedule(renderMinimap); }).observe(v, { childList: true });
  }

  mm.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    noteUserScroll();
    const box = $('#mm-view');
    const y = trackY(e);
    const top = parseFloat(box.style.top) || 0;
    const hgt = box.offsetHeight;
    if (y >= top && y <= top + hgt) {
      dragging = { grab: y - top };           // 抓住视口框拖动
    } else {
      dragging = { grab: hgt / 2 };           // 点击空白处：跳过去并继续拖动
      scrollToTrackY(y - hgt / 2, { center: false });
    }
    mm.classList.add('dragging');
    mm.setPointerCapture(e.pointerId);
  });
  mm.addEventListener('pointermove', (e) => {
    if (!dragging) { showTip(e); return; }
    noteUserScroll();
    scrollToTrackY(trackY(e) - dragging.grab, { center: false });
  });
  const end = () => { dragging = null; mm.classList.remove('dragging'); };
  mm.addEventListener('pointerup', end);
  mm.addEventListener('pointercancel', end);
  mm.addEventListener('pointerleave', () => { $('#mm-tip').hidden = true; });
}
