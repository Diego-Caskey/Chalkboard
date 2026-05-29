/* Chalkboard — infinite brainstorming canvas.
   Globals expected: window.Store (store.js), window.Export (export.js). */
(function () {
  'use strict';

  // ---------- state ----------
  const state = {
    elements: [],          // [{id,type,x,y,w,h,rot,z, ...payload}]
    view: { panX: 0, panY: 0, zoom: 1 },
    nextZ: 1,
  };
  const nodes = new Map();   // id -> DOM node
  let selectedId = null;
  let editingId = null;
  let loaded = false;

  const $ = (s) => document.querySelector(s);
  const viewport = $('#viewport');
  const world = $('#world');
  const selbox = $('#selbox');

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // ---------- note typography ----------
  // Notes carry a layout box in "font units" (fw/fh at scale 1, BASE_FONT px)
  // plus a uniform `scale`. Rendered size = fw*scale x fh*scale, with font and
  // padding scaled to match — so resizing magnifies the note (crisp, identical
  // wrapping) rather than reflowing it. Shift+resize edits fw/fh instead.
  const BASE_FONT = 16, BASE_PADX = 14, BASE_PADY = 12, NOTE_LH = 1.4;
  const NOTE_MAX_W = 400, NOTE_MAX_H = 550;   // ~8:11 page proportion, scale 1
  const NOTE_MIN_W = 70, NOTE_MIN_H = 44;
  const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif';

  let measureEl = null;
  function measureNote(text) {
    if (!measureEl) {
      measureEl = document.createElement('div');
      measureEl.style.cssText = 'position:absolute;visibility:hidden;left:-99999px;top:0;' +
        'box-sizing:border-box;white-space:pre-wrap;word-break:break-word;' +
        'font:400 ' + BASE_FONT + 'px/' + NOTE_LH + ' ' + FONT_STACK + ';' +
        'padding:' + BASE_PADY + 'px ' + BASE_PADX + 'px;max-width:' + NOTE_MAX_W + 'px;';
      document.body.appendChild(measureEl);
    }
    measureEl.textContent = (text && text.length) ? text : 'Type\u2026';
    const w = clamp(Math.ceil(measureEl.offsetWidth) + 1, NOTE_MIN_W, NOTE_MAX_W);
    const h = clamp(Math.ceil(measureEl.offsetHeight) + 1, NOTE_MIN_H, NOTE_MAX_H);
    return { w, h };
  }

  function normalizeNote(el) {
    if (el.type !== 'note') return;
    if (el.scale == null) el.scale = 1;
    if (el.fw == null) el.fw = el.w / el.scale;
    if (el.fh == null) el.fh = el.h / el.scale;
  }
  function applyNoteStyle(el) {
    const n = nodes.get(el.id); if (!n) return;
    const c = n.querySelector('.note-content'); if (!c) return;
    const s = el.scale || 1;
    c.style.fontSize = (BASE_FONT * s) + 'px';
    c.style.padding = (BASE_PADY * s) + 'px ' + (BASE_PADX * s) + 'px';
  }

  // ---------- coordinate transforms ----------
  function screenToWorld(sx, sy) {
    return { x: (sx - state.view.panX) / state.view.zoom, y: (sy - state.view.panY) / state.view.zoom };
  }
  function applyView() {
    const { panX, panY, zoom } = state.view;
    world.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    viewport.style.backgroundSize = `${24 * zoom}px ${24 * zoom}px`;
    viewport.style.backgroundPosition = `${panX}px ${panY}px`;
    const pct = $('#zoom .pct');
    if (pct) pct.textContent = Math.round(zoom * 100) + '%';
    updateSelbox();
  }

  // ---------- persistence ----------
  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, 350);
  }
  async function doSave() {
    if (!loaded) return;
    try { await Store.set('board', { elements: state.elements, view: state.view, nextZ: state.nextZ }); }
    catch (e) { console.warn('save failed', e); }
  }
  async function load() {
    let data = null;
    try { data = await Store.get('board'); } catch (e) { console.warn(e); }
    if (data && Array.isArray(data.elements)) {
      state.elements = data.elements;
      state.view = data.view || state.view;
      state.nextZ = data.nextZ || (state.elements.length + 1);
    }
    loaded = true;
    applyView();
    for (const el of state.elements) mountNode(el);
    refreshContentFlag();
  }

  // ---------- element creation ----------
  function addElement(el) {
    el.id = el.id || uid();
    el.rot = el.rot || 0;
    el.z = state.nextZ++;
    state.elements.push(el);
    mountNode(el);
    refreshContentFlag();
    scheduleSave();
    return el;
  }

  function mountNode(el) {
    const n = document.createElement('div');
    n.className = 'el ' + el.type;
    n.dataset.id = el.id;
    n.style.width = el.w + 'px';
    n.style.height = el.h + 'px';

    if (el.type === 'note') {
      normalizeNote(el);
      const c = document.createElement('div');
      c.className = 'note-content';
      c.textContent = el.text || '';
      n.appendChild(c);
    } else if (el.type === 'image') {
      const img = document.createElement('img');
      img.className = 'media';
      img.src = el.src;
      img.draggable = false;
      n.appendChild(img);
    } else if (el.type === 'pdf') {
      n.classList.add('preview');
      n.innerHTML = `<div class="pv-head">${escapeHtml(el.fileName || 'document.pdf')}</div><div class="pv-body"><embed type="application/pdf" src="${el.src}#toolbar=0&navpanes=0"></div>`;
    } else if (el.type === 'text') {
      n.classList.add('preview');
      const body = document.createElement('div');
      body.className = 'pv-body';
      const pre = document.createElement('pre');
      pre.className = 'pv-text';
      pre.textContent = el.content || '';
      body.appendChild(pre);
      const head = document.createElement('div');
      head.className = 'pv-head';
      head.textContent = el.fileName || 'text';
      n.appendChild(head);
      n.appendChild(body);
    } else if (el.type === 'chip') {
      n.innerHTML = `<div class="ext">${escapeHtml(extOf(el.fileName, el.fileType))}</div>
        <div class="meta"><div class="name">${escapeHtml(el.fileName || 'file')}</div>
        <div class="size">${formatSize(el.fileSize)}</div></div>`;
    }

    nodes.set(el.id, n);
    world.appendChild(n);
    placeNode(el);
    if (el.type === 'note') applyNoteStyle(el);
    n.addEventListener('pointerdown', (e) => onElementPointerDown(e, el));
    if (el.type === 'note') {
      n.addEventListener('dblclick', (e) => { e.stopPropagation(); startEditing(el); });
    }
    return n;
  }

  function placeNode(el) {
    const n = nodes.get(el.id);
    if (!n) return;
    n.style.left = el.x + 'px';
    n.style.top = el.y + 'px';
    n.style.width = el.w + 'px';
    n.style.height = el.h + 'px';
    n.style.transform = `rotate(${el.rot}deg)`;
    n.style.zIndex = el.z;
  }

  function removeElement(id) {
    const i = state.elements.findIndex((e) => e.id === id);
    if (i < 0) return;
    state.elements.splice(i, 1);
    const n = nodes.get(id);
    if (n) n.remove();
    nodes.delete(id);
    if (selectedId === id) select(null);
    refreshContentFlag();
    scheduleSave();
  }

  // ---------- selection ----------
  function select(id) {
    if (editingId && editingId !== id) stopEditing();
    selectedId = id;
    for (const [eid, n] of nodes) n.classList.toggle('is-selected', eid === id);
    updateSelbox();
    if (!id) hideMenus();
  }
  const getSelected = () => state.elements.find((e) => e.id === selectedId);

  function duplicateElement(el) {
    const c = JSON.parse(JSON.stringify(el));
    delete c.id;
    c.x += 26; c.y += 26;
    const ne = addElement(c);
    select(ne.id);
    return ne;
  }

  // selection overlay in screen space
  function updateSelbox() {
    const el = getSelected();
    if (!el) { selbox.classList.remove('active'); return; }
    const { zoom } = state.view;
    const cx = state.view.panX + (el.x + el.w / 2) * zoom;
    const cy = state.view.panY + (el.y + el.h / 2) * zoom;
    const w = el.w * zoom, h = el.h * zoom;
    selbox.style.left = cx + 'px';
    selbox.style.top = cy + 'px';
    selbox.style.width = w + 'px';
    selbox.style.height = h + 'px';
    selbox.style.transform = `translate(-50%, -50%) rotate(${el.rot}deg)`;
    selbox.classList.add('active');
  }

  // ---------- pointer interaction ----------
  let drag = null;

  function onElementPointerDown(e, el) {
    if (e.button === 1) { e.preventDefault(); e.stopPropagation(); startPan(e, true); return; }
    if (editingId === el.id) return;           // let text editing receive the event
    if (e.button !== 0) return;
    e.stopPropagation();
    select(el.id);
    bringToFront(el);
    const start = screenToWorld(e.clientX, e.clientY);
    drag = { kind: 'move', el, startX: el.x, startY: el.y, startWX: start.x, startWY: start.y, moved: false };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, { once: true });
  }

  function startResize(e, corner) {
    e.stopPropagation();
    const el = getSelected();
    if (!el) return;
    const a = el.rot * Math.PI / 180;
    const u = { x: Math.cos(a), y: Math.sin(a) };
    const v = { x: -Math.sin(a), y: Math.cos(a) };
    const c = { x: el.x + el.w / 2, y: el.y + el.h / 2 };
    const sx = corner.includes('r') ? 1 : -1;   // x sign of dragged corner
    const sy = corner.includes('b') ? 1 : -1;   // y sign
    // anchor = opposite corner (fixed point) in world coords
    const A = {
      x: c.x + (-sx) * (el.w / 2) * u.x + (-sy) * (el.h / 2) * v.x,
      y: c.y + (-sx) * (el.w / 2) * u.y + (-sy) * (el.h / 2) * v.y,
    };
    drag = { kind: 'resize', el, u, v, A, sx, sy, aspect: (el.type === 'image' && el.w && el.h) ? el.w / el.h : 0 };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, { once: true });
  }

  function startRotate(e) {
    e.stopPropagation();
    const el = getSelected();
    if (!el) return;
    drag = { kind: 'rotate', el };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, { once: true });
  }

  function startPan(e, keepSelection) {
    if (e.button !== 0 && e.button !== 1) return;
    if (!keepSelection) select(null);
    drag = { kind: 'pan', startPanX: state.view.panX, startPanY: state.view.panY, sx: e.clientX, sy: e.clientY };
    viewport.classList.add('panning');
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, { once: true });
  }

  function onPointerMove(e) {
    if (!drag) return;
    if (drag.kind === 'pan') {
      state.view.panX = drag.startPanX + (e.clientX - drag.sx);
      state.view.panY = drag.startPanY + (e.clientY - drag.sy);
      applyView();
      return;
    }
    if (drag.kind === 'move') {
      const p = screenToWorld(e.clientX, e.clientY);
      drag.el.x = drag.startX + (p.x - drag.startWX);
      drag.el.y = drag.startY + (p.y - drag.startWY);
      drag.moved = true;
      placeNode(drag.el);
      updateSelbox();
      return;
    }
    if (drag.kind === 'resize') {
      const { el, u, v, A, sx, sy } = drag;
      const P = screenToWorld(e.clientX, e.clientY);
      const d = { x: P.x - A.x, y: P.y - A.y };
      let newW = clamp((d.x * u.x + d.y * u.y) * sx, 40, 100000);
      let newH = clamp((d.x * v.x + d.y * v.y) * sy, 30, 100000);
      const isNote = el.type === 'note';
      const scaleNote = isNote && e.shiftKey;       // shift = magnify (font scales)
      // lock aspect for image resize and for shift-scale note resize
      const lockAspect = isNote ? (scaleNote ? el.fw / el.fh : 0) : drag.aspect;
      if (lockAspect) { newH = newW / lockAspect; }
      const nc = {
        x: A.x + u.x * (sx * newW / 2) + v.x * (sy * newH / 2),
        y: A.y + u.y * (sx * newW / 2) + v.y * (sy * newH / 2),
      };
      el.w = newW; el.h = newH;
      el.x = nc.x - newW / 2; el.y = nc.y - newH / 2;
      if (isNote) {
        if (scaleNote) { el.scale = newW / el.fw; }   // magnify: font + box together
        else { el.fw = newW / el.scale; el.fh = newH / el.scale; }  // default: reshape box
        applyNoteStyle(el);
      }
      placeNode(el);
      updateSelbox();
      return;
    }
    if (drag.kind === 'rotate') {
      const el = drag.el;
      const cScreenX = state.view.panX + (el.x + el.w / 2) * state.view.zoom;
      const cScreenY = state.view.panY + (el.y + el.h / 2) * state.view.zoom;
      let deg = Math.atan2(e.clientY - cScreenY, e.clientX - cScreenX) * 180 / Math.PI + 90;
      // light snapping to 0/45/90... within 3deg
      for (const s of [0, 45, 90, 135, 180, 225, 270, 315, 360, -45, -90, -135, -180]) {
        if (Math.abs(((deg % 360) + 360) % 360 - ((s % 360) + 360) % 360) < 3) { deg = s; break; }
      }
      el.rot = deg;
      placeNode(el);
      updateSelbox();
      return;
    }
  }

  function onPointerUp() {
    if (drag) {
      viewport.classList.remove('panning');
      if (drag.kind !== 'move' || drag.moved) scheduleSave();
    }
    drag = null;
    window.removeEventListener('pointermove', onPointerMove);
  }

  // ---------- z-order ----------
  function bringToFront(el) {
    el.z = state.nextZ++;
    placeNode(el);
    scheduleSave();
  }
  function sendToBack(el) {
    const min = Math.min(...state.elements.map((e) => e.z));
    el.z = min - 1;
    placeNode(el);
    scheduleSave();
  }

  // ---------- editing notes ----------
  function startEditing(el) {
    select(el.id);
    editingId = el.id;
    const n = nodes.get(el.id);
    n.classList.add('editing');
    const c = n.querySelector('.note-content');
    c.contentEditable = 'true';
    c.focus();
    // place caret at end
    const r = document.createRange();
    r.selectNodeContents(c); r.collapse(false);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    c.addEventListener('blur', onNoteBlur, { once: true });
  }
  function onNoteBlur(e) {
    const n = e.target.closest('.el');
    if (!n) return;
    const el = state.elements.find((x) => x.id === n.dataset.id);
    if (el) { el.text = e.target.textContent; scheduleSave(); }
    n.classList.remove('editing');
    e.target.contentEditable = 'false';
    if (editingId === (el && el.id)) editingId = null;
  }
  function stopEditing() {
    if (!editingId) return;
    const n = nodes.get(editingId);
    if (n) { const c = n.querySelector('.note-content'); if (c) c.blur(); }
    editingId = null;
  }

  // ---------- adding content ----------
  function viewCenterWorld() {
    return screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
  }
  function addNote(wx, wy, text) {
    let fw, fh;
    if (text && text.length) {
      const m = measureNote(text);
      fw = m.w; fh = m.h;
    } else {
      fw = 200; fh = 120;
    }
    const el = addElement({ type: 'note', x: wx - fw / 2, y: wy - fh / 2, w: fw, h: fh, fw, fh, scale: 1, text: text || '' });
    select(el.id);
    if (!text) startEditing(el);
    return el;
  }

  function addImageFromSrc(src, wx, wy) {
    const img = new Image();
    img.onload = () => {
      const max = 360;
      let w = img.naturalWidth, h = img.naturalHeight;
      const sc = Math.min(1, max / Math.max(w, h));
      w = Math.max(40, w * sc); h = Math.max(30, h * sc);
      const el = addElement({ type: 'image', x: wx - w / 2, y: wy - h / 2, w, h, src, _aspect: img.naturalWidth / img.naturalHeight });
      select(el.id);
    };
    img.src = src;
  }

  function addFile(file, wx, wy, spread) {
    const ox = spread ? (Math.random() - 0.5) * 60 : 0;
    const oy = spread ? (Math.random() - 0.5) * 60 : 0;
    const x = wx + ox, y = wy + oy;
    const type = file.type || '';
    if (type.startsWith('image/')) {
      const r = new FileReader();
      r.onload = () => addImageFromSrc(r.result, x, y);
      r.readAsDataURL(file);
    } else if (type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      const r = new FileReader();
      r.onload = () => {
        const w = 300, h = 390;
        select(addElement({ type: 'pdf', x: x - w / 2, y: y - h / 2, w, h, src: r.result, fileName: file.name, fileType: type, fileSize: file.size }).id);
      };
      r.readAsDataURL(file);
    } else if (isTextual(file)) {
      const r = new FileReader();
      r.onload = () => {
        const w = 300, h = 220;
        const content = String(r.result).slice(0, 40000);
        select(addElement({ type: 'text', x: x - w / 2, y: y - h / 2, w, h, content, fileName: file.name, fileType: type, fileSize: file.size }).id);
      };
      r.readAsText(file);
    } else {
      const r = new FileReader();
      r.onload = () => {
        const w = 220, h = 64;
        select(addElement({ type: 'chip', x: x - w / 2, y: y - h / 2, w, h, src: r.result, fileName: file.name, fileType: type, fileSize: file.size }).id);
      };
      r.readAsDataURL(file);  // store so chip download works after reload
    }
  }

  function isTextual(file) {
    const t = file.type || '';
    if (t.startsWith('text/')) return true;
    if (/(json|xml|javascript|csv|markdown|x-sh|x-yaml|yaml)/.test(t)) return true;
    return /\.(txt|md|markdown|json|csv|tsv|js|jsx|ts|tsx|css|html|xml|yml|yaml|py|rb|go|rs|java|c|cpp|h|sh|sql|log|ini|toml|env)$/i.test(file.name || '');
  }

  function downloadElement(el) {
    let href = el.src;
    let name = el.fileName || 'file';
    if (!href && el.type === 'text') {
      href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(el.content || '');
      name = el.fileName || 'text.txt';
    }
    if (!href) return;
    const a = document.createElement('a');
    a.href = href; a.download = name; a.click();
  }

  // ---------- helpers ----------
  function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function extOf(name, mime) {
    const m = /\.([a-z0-9]+)$/i.exec(name || '');
    if (m) return m[1].slice(0, 4);
    if (mime && mime.includes('/')) return mime.split('/')[1].slice(0, 4);
    return 'file';
  }
  function formatSize(b) {
    if (!b && b !== 0) return '';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }
  function refreshContentFlag() {
    document.body.classList.toggle('has-content', state.elements.length > 0);
  }
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  // ---------- wheel: pan + zoom ----------
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      // shift-wheel: many devices report vertical wheel as deltaX while shift is held
      const delta = e.shiftKey ? (e.deltaY || e.deltaX) : e.deltaY;
      const factor = Math.exp(-delta * 0.0015);
      const nz = clamp(state.view.zoom * factor, 0.1, 4);
      const w = screenToWorld(e.clientX, e.clientY);
      state.view.zoom = nz;
      state.view.panX = e.clientX - w.x * nz;
      state.view.panY = e.clientY - w.y * nz;
    } else {
      state.view.panX -= e.deltaX;
      state.view.panY -= e.deltaY;
    }
    applyView();
    scheduleSave();
  }, { passive: false });

  function zoomBy(mult) {
    const nz = clamp(state.view.zoom * mult, 0.1, 4);
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    const w = screenToWorld(cx, cy);
    state.view.zoom = nz;
    state.view.panX = cx - w.x * nz;
    state.view.panY = cy - w.y * nz;
    applyView(); scheduleSave();
  }
  function fitAll() {
    if (!state.elements.length) { state.view = { panX: 0, panY: 0, zoom: 1 }; applyView(); scheduleSave(); return; }
    const b = window.Export.contentBounds(state.elements, 80);
    const sw = window.innerWidth, sh = window.innerHeight;
    const z = clamp(Math.min(sw / b.w, sh / b.h), 0.1, 1.5);
    state.view.zoom = z;
    state.view.panX = (sw - b.w * z) / 2 - b.minX * z;
    state.view.panY = (sh - b.h * z) / 2 - b.minY * z;
    applyView(); scheduleSave();
  }

  // ---------- canvas background interactions ----------
  viewport.addEventListener('pointerdown', (e) => {
    if (e.button === 1) { e.preventDefault(); startPan(e, true); return; }
    if (e.target === viewport || e.target === world) startPan(e, false);
  });
  // suppress middle-click autoscroll
  viewport.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
  window.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
  viewport.addEventListener('dblclick', (e) => {
    if (e.target === viewport || e.target === world) {
      const w = screenToWorld(e.clientX, e.clientY);
      addNote(w.x, w.y);
    }
  });

  // ---------- drag & drop ----------
  let dropCounter = 0;
  ['dragenter', 'dragover'].forEach((ev) => window.addEventListener(ev, (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
      e.preventDefault();
      viewport.classList.add('dropping');
    }
  }));
  window.addEventListener('dragleave', (e) => { if (e.clientX === 0 && e.clientY === 0) viewport.classList.remove('dropping'); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    viewport.classList.remove('dropping');
    const w = screenToWorld(e.clientX, e.clientY);
    const files = e.dataTransfer.files;
    if (files && files.length) {
      const multi = files.length > 1;
      Array.from(files).forEach((f) => addFile(f, w.x, w.y, multi));
      return;
    }
    const txt = e.dataTransfer.getData('text/plain');
    if (txt) addNote(w.x, w.y, txt);
  });

  // ---------- paste ----------
  window.addEventListener('paste', (e) => {
    if (editingId) return; // let the note handle its own paste
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const center = viewCenterWorld();
    const files = [];
    for (const it of items) if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f); }
    if (files.length) {
      e.preventDefault();
      const multi = files.length > 1;
      files.forEach((f) => addFile(f, center.x, center.y, multi));
      return;
    }
    const text = e.clipboardData.getData('text/plain');
    if (text) { e.preventDefault(); addNote(center.x, center.y, text); }
  });

  // ---------- keyboard ----------
  window.addEventListener('keydown', (e) => {
    if (editingId) { if (e.key === 'Escape') stopEditing(); return; }
    const el = getSelected();
    if ((e.key === 'Delete' || e.key === 'Backspace') && el) { e.preventDefault(); removeElement(el.id); }
    else if (e.key === 'Escape') select(null);
    else if (el && (e.key === ']')) bringToFront(el);
    else if (el && (e.key === '[')) sendToBack(el);
    else if (el && e.key === 'Enter' && el.type === 'note') { e.preventDefault(); startEditing(el); }
  });

  // ---------- chrome wiring ----------
  let pendingAddPos = null;
  $('#tl-upload').addEventListener('click', () => { pendingAddPos = null; $('#file-input').click(); });
  $('#file-input').addEventListener('change', (e) => {
    const at = pendingAddPos || viewCenterWorld();
    pendingAddPos = null;
    const fs = Array.from(e.target.files || []);
    fs.forEach((f) => addFile(f, at.x, at.y, fs.length > 1));
    e.target.value = '';
  });
  $('#tl-clear').addEventListener('click', async () => {
    if (!state.elements.length) return;
    if (!confirm('Clear the entire board? This cannot be undone.')) return;
    state.elements = []; state.nextZ = 1;
    for (const [, n] of nodes) n.remove();
    nodes.clear(); select(null); refreshContentFlag();
    await Store.del('board');
    toast('Board cleared');
  });
  $('#tl-pdf').addEventListener('click', async () => {
    if (!state.elements.length) { toast('Nothing to export yet'); return; }
    select(null);
    toast('Building PDF\u2026');
    try { await window.Export.toPDF({ viewport, world, state, applyView }); toast('PDF saved'); }
    catch (err) { console.error(err); toast('Export failed'); }
  });

  $('#z-in').addEventListener('click', () => zoomBy(1.2));
  $('#z-out').addEventListener('click', () => zoomBy(1 / 1.2));
  $('#zoom .pct').addEventListener('click', fitAll);

  // ---------- right-click context menus ----------
  const ctxmenu = $('#ctxmenu');
  const ctxmenuEmpty = $('#ctxmenu-empty');
  let emptyMenuPos = { x: 0, y: 0 };

  function placeMenu(menu, x, y) {
    menu.classList.add('active');
    const r = menu.getBoundingClientRect();
    const px = Math.min(x, window.innerWidth - r.width - 8);
    const py = Math.min(y, window.innerHeight - r.height - 8);
    menu.style.left = Math.max(8, px) + 'px';
    menu.style.top = Math.max(8, py) + 'px';
  }
  function hideMenus() { ctxmenu.classList.remove('active'); ctxmenuEmpty.classList.remove('active'); }

  viewport.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    hideMenus();
    const node = e.target.closest('.el');
    if (node) {
      select(node.dataset.id);
      const el = getSelected();
      ctxmenu.querySelector('[data-act="download"]').style.display =
        (el && (el.type === 'image' || el.type === 'pdf' || el.type === 'text' || el.type === 'chip')) ? '' : 'none';
      placeMenu(ctxmenu, e.clientX, e.clientY);
    } else {
      select(null);
      emptyMenuPos = screenToWorld(e.clientX, e.clientY);
      placeMenu(ctxmenuEmpty, e.clientX, e.clientY);
    }
  });

  ctxmenu.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const el = getSelected();
    if (!el) { hideMenus(); return; }
    switch (btn.dataset.act) {
      case 'delete': removeElement(el.id); break;
      case 'back': sendToBack(el); break;
      case 'front': bringToFront(el); break;
      case 'dup': duplicateElement(el); break;
      case 'download': downloadElement(el); break;
    }
    hideMenus();
  });

  ctxmenuEmpty.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const at = emptyMenuPos;
    if (btn.dataset.act === 'add') { pendingAddPos = at; $('#file-input').click(); }
    else if (btn.dataset.act === 'paste') { pasteFromClipboard(at.x, at.y); }
    hideMenus();
  });

  async function pasteFromClipboard(wx, wy) {
    try {
      if (navigator.clipboard && navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        let handled = false;
        for (const it of items) {
          const imgType = it.types.find((t) => t.startsWith('image/'));
          if (imgType) {
            const blob = await it.getType(imgType);
            const r = new FileReader();
            r.onload = () => addImageFromSrc(r.result, wx, wy);
            r.readAsDataURL(blob);
            handled = true;
          } else if (it.types.includes('text/plain')) {
            const blob = await it.getType('text/plain');
            const text = await blob.text();
            if (text) addNote(wx, wy, text);
            handled = true;
          }
        }
        if (handled) return;
      }
      const text = await navigator.clipboard.readText();
      if (text) addNote(wx, wy, text);
      else toast('Clipboard is empty');
    } catch (err) {
      toast('Allow clipboard access, or press \u2318/Ctrl + V');
    }
  }

  window.addEventListener('pointerdown', (e) => { if (!e.target.closest('.ctx')) hideMenus(); }, true);
  window.addEventListener('wheel', hideMenus, { passive: true });

  // ---------- theme toggle ----------
  function applyTheme(dark) {
    document.documentElement.classList.toggle('dark', dark);
    try { localStorage.setItem('cb-theme', dark ? 'dark' : 'light'); } catch (e) {}
  }
  $('#brand').addEventListener('click', () => {
    applyTheme(!document.documentElement.classList.contains('dark'));
  });

  // resize/rotate handles
  selbox.querySelectorAll('.handle.r').forEach((h) => h.addEventListener('pointerdown', (e) => startResize(e, h.dataset.corner)));
  selbox.querySelector('.handle.rot').addEventListener('pointerdown', startRotate);

  window.addEventListener('resize', updateSelbox);

  // ---------- go ----------
  load();
})();
