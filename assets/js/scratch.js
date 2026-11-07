/**
 * scratch.js — 收益刮刮乐
 *
 * 开启后把顶部三块收益数字用画布遮住，鼠标按住拖动即可「刮开」，
 * 刮掉一半以上自动完全揭开。数值刷新后会重新盖上。
 */
(function () {
  'use strict';

  const STORE_KEY = 'taptap_scratch_mode';
  const TARGETS = ['summary-total', 'summary-today', 'summary-month'];

  function enabled() {
    try { return localStorage.getItem(STORE_KEY) === '1'; } catch (_) { return false; }
  }
  function setEnabled(on) {
    try { localStorage.setItem(STORE_KEY, on ? '1' : '0'); } catch (_) {}
    if (on) coverAll(); else uncoverAll();
  }

  const overlays = new Map(); // el -> canvas

  function makeOverlay(el) {
    const canvas = document.createElement('canvas');
    canvas.className = 'scratch-canvas';
    const rect = el.getBoundingClientRect();
    const w = Math.max(40, Math.round(rect.width));
    const h = Math.max(24, Math.round(rect.height));
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // 底色：像素风渐变 + 噪点
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#8b7cf6');
    g.addColorStop(1, '#25b6e9');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    for (let i = 0; i < Math.max(18, Math.floor((w * h) / 260)); i++) {
      ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.font = '600 11px -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('刮开查看', w / 2, h / 2);

    // 刮开逻辑
    let drawing = false;
    let last = null;
    let strokes = 0;
    const radius = 13;

    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      const p = e.touches ? e.touches[0] : e;
      return { x: p.clientX - r.left, y: p.clientY - r.top };
    };
    const erase = (p) => {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();
      if (last) {
        // 连点成线，避免快速拖动出现断点
        const dx = p.x - last.x, dy = p.y - last.y;
        const dist = Math.hypot(dx, dy);
        const steps = Math.ceil(dist / (radius / 2));
        for (let i = 1; i < steps; i++) {
          ctx.beginPath();
          ctx.arc(last.x + (dx * i) / steps, last.y + (dy * i) / steps, radius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      last = p;
      strokes++;
    };
    const progress = () => {
      try {
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let clear = 0, total = 0;
        for (let i = 3; i < data.length; i += 4 * 8) { total++; if (data[i] < 24) clear++; }
        return total ? clear / total : 0;
      } catch (_) { return 0; }
    };
    const finish = () => {
      canvas.classList.add('is-done');
      setTimeout(() => { try { canvas.remove(); } catch (_) {} }, 260);
      overlays.delete(el);
    };

    canvas.addEventListener('pointerdown', (e) => {
      drawing = true; last = null; canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
      erase(pos(e)); e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      erase(pos(e));
      if (strokes % 12 === 0 && progress() > 0.55) { drawing = false; finish(); }
      e.preventDefault();
    });
    const stop = () => {
      if (!drawing) return;
      drawing = false; last = null;
      if (progress() > 0.55) finish();
    };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointerleave', stop);
    canvas.addEventListener('pointercancel', stop);

    el.style.position = el.style.position || 'relative';
    el.appendChild(canvas);
    overlays.set(el, canvas);
    return canvas;
  }

  function coverAll() {
    if (!enabled()) return;
    for (const id of TARGETS) {
      const el = document.getElementById(id);
      if (!el || overlays.has(el)) continue;
      const text = (el.textContent || '').trim();
      if (!text || text === '暂无' || text === '¥0.00' && false) { /* 仍然遮住 */ }
      makeOverlay(el);
    }
  }

  function uncoverAll() {
    for (const [el, canvas] of overlays.entries()) {
      try { canvas.remove(); } catch (_) {}
    }
    overlays.clear();
  }

  // 数值刷新后重新盖上（仅当开关开启且当前没有正在刮的遮罩时）
  function remark() {
    if (!enabled()) return;
    setTimeout(coverAll, 50);
  }

  window.ScratchMode = { enabled, setEnabled, coverAll, uncoverAll, remark };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { setTimeout(coverAll, 600); });
  } else {
    setTimeout(coverAll, 600);
  }
})();
