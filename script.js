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
  let selectedIds = new Set();
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
    // content is laid out once at base size (fw x fh, BASE_FONT) and magnified
    // with a transform, so wrapping never drifts while scaling.
    c.style.width = el.fw + 'px';
    c.style.height = el.fh + 'px';
    const s = el.scale || 1;
    if (editingId === el.id) { c.style.transform = 'scale(' + s + ')'; return; }
    // clamp + apply vertical scroll for overflowing notes (base px translate)
    const max = Math.max(0, c.scrollHeight - el.fh);
    if (!el.scrollY || el.scrollY < 0) el.scrollY = 0;
    if (el.scrollY > max) el.scrollY = max;
    c.style.transform = 'scale(' + s + ') translateY(' + (-el.scrollY) + 'px)';
  }
  function noteMaxScroll(el) {
    const n = nodes.get(el.id); if (!n) return 0;
    const c = n.querySelector('.note-content'); if (!c) return 0;
    return Math.max(0, c.scrollHeight - el.fh);
  }

  // ---------- plaintext / markdown ----------
  // Notes hold plain text only. Rich paste is converted to Markdown; literal
  // bullet glyphs become "- "; emojis (ordinary characters) pass through.
  function normalizePlain(s) {
    if (!s) return '';
    return String(s)
      .replace(/\r\n?/g, '\n')
      .replace(/\u00a0/g, ' ')                       // nbsp -> space
      .replace(/^[ \t]*[•◦▪‣·●○∙]\s+/gm, '- ')       // bullet glyphs -> dash
      .replace(/[ \t]+\n/g, '\n')                    // trailing whitespace
      .replace(/\n{3,}/g, '\n\n')                    // collapse big gaps
      .replace(/[ \t]+$/, '')
      .trim();
  }

  function htmlToMarkdown(html) {
    let doc;
    try { doc = new DOMParser().parseFromString(html, 'text/html'); }
    catch (e) { return normalizePlain(html); }
    doc.querySelectorAll('style,script,head,meta,title').forEach((n) => n.remove());
    return normalizePlain(mdSerialize(doc.body));
  }
  function mdInline(node) { return mdSerialize(node).replace(/\s+/g, ' ').trim(); }
  function mdList(listEl, ordered, depth) {
    const pad = '  '.repeat(depth || 0);
    const lines = [];
    let i = 1;
    Array.from(listEl.children).forEach((li) => {
      if (!li.tagName || li.tagName.toLowerCase() !== 'li') return;
      const marker = ordered ? (i++ + '. ') : '- ';
      let inline = '', nested = '';
      li.childNodes.forEach((cn) => {
        if (cn.nodeType === 1 && /^(ul|ol)$/i.test(cn.tagName)) {
          nested += '\n' + mdList(cn, cn.tagName.toLowerCase() === 'ol', (depth || 0) + 1);
        } else {
          inline += cn.nodeType === 3 ? cn.nodeValue : mdSerialize(cn);
        }
      });
      lines.push(pad + marker + inline.replace(/\s+/g, ' ').trim() + nested);
    });
    return lines.join('\n');
  }
  function mdSerialize(node) {
    let out = '';
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) { out += child.nodeValue.replace(/\s+/g, ' '); return; }
      if (child.nodeType !== 1) return;
      const tag = child.tagName.toLowerCase();
      switch (tag) {
        case 'br': out += '\n'; break;
        case 'hr': out += '\n---\n'; break;
        case 'strong': case 'b': { const t = mdInline(child); out += t ? '**' + t + '**' : ''; break; }
        case 'em': case 'i': { const t = mdInline(child); out += t ? '*' + t + '*' : ''; break; }
        case 'code': { const t = mdInline(child); out += t ? '`' + t + '`' : ''; break; }
        case 'a': { const t = mdInline(child); const href = child.getAttribute('href'); out += (href && t) ? '[' + t + '](' + href + ')' : t; break; }
        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
          out += '\n' + '#'.repeat(+tag[1]) + ' ' + mdInline(child) + '\n'; break;
        case 'ul': out += '\n' + mdList(child, false, 0) + '\n'; break;
        case 'ol': out += '\n' + mdList(child, true, 0) + '\n'; break;
        case 'li': out += mdSerialize(child); break;
        case 'blockquote': out += '\n> ' + mdInline(child) + '\n'; break;
        case 'p': case 'div': case 'section': case 'tr':
          out += '\n' + mdSerialize(child) + '\n'; break;
        case 'td': case 'th': out += mdSerialize(child) + ' '; break;
        default: out += mdSerialize(child);
      }
    });
    return out;
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
    if (selectedIds.has(id)) { selectedIds.delete(id); document.body.classList.toggle('multi-select', selectedIds.size > 1); }
    refreshContentFlag();
    scheduleSave();
  }

  // ---------- selection ----------
  function setSelection(ids) {
    const next = new Set(ids);
    if (editingId && !next.has(editingId)) stopEditing();
    selectedIds = next;
    for (const [eid, n] of nodes) n.classList.toggle('is-selected', selectedIds.has(eid));
    document.body.classList.toggle('multi-select', selectedIds.size > 1);
    updateSelbox();
    if (!selectedIds.size) hideMenus();
  }
  function select(id) { setSelection(id ? [id] : []); }
  function toggleSelection(id) {
    const s = new Set(selectedIds);
    if (s.has(id)) s.delete(id); else s.add(id);
    setSelection([...s]);
  }
  // single-element ops (resize/rotate handles) require exactly one selection
  const getSelected = () => (selectedIds.size === 1 ? state.elements.find((e) => selectedIds.has(e.id)) : null);
  const getSelectedEls = () => state.elements.filter((e) => selectedIds.has(e.id));

  // world-space axis-aligned bounds of an element (rotation-aware)
  function elAABB(el) {
    const a = el.rot * Math.PI / 180;
    const u = { x: Math.cos(a), y: Math.sin(a) };
    const v = { x: -Math.sin(a), y: Math.cos(a) };
    const c = { x: el.x + el.w / 2, y: el.y + el.h / 2 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      const px = c.x + sx * (el.w / 2) * u.x + sy * (el.h / 2) * v.x;
      const py = c.y + sx * (el.w / 2) * u.y + sy * (el.h / 2) * v.y;
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
    }
    return { minX, minY, maxX, maxY };
  }

  function duplicateElement(el) {
    const c = JSON.parse(JSON.stringify(el));
    delete c.id;
    c.x += 26; c.y += 26;
    const ne = addElement(c);
    return ne;
  }
  function duplicateSelection() {
    const src = getSelectedEls();
    if (!src.length) return;
    const made = src.map((el) => duplicateElement(el));
    setSelection(made.map((e) => e.id));
  }
  function removeSelection() {
    const ids = [...selectedIds];
    selectedIds = new Set();
    for (const id of ids) removeElement(id);
    setSelection([]);
  }

  // selection overlay in screen space
  function updateSelbox() {
    const els = getSelectedEls();
    if (!els.length) { selbox.classList.remove('active'); return; }
    const { zoom } = state.view;
    if (els.length === 1) {
      // single: frame + handles, rotated to the element
      const el = els[0];
      const cx = state.view.panX + (el.x + el.w / 2) * zoom;
      const cy = state.view.panY + (el.y + el.h / 2) * zoom;
      selbox.style.left = cx + 'px';
      selbox.style.top = cy + 'px';
      selbox.style.width = (el.w * zoom) + 'px';
      selbox.style.height = (el.h * zoom) + 'px';
      selbox.style.transform = `translate(-50%, -50%) rotate(${el.rot}deg)`;
      selbox.classList.add('single');
      selbox.classList.remove('multi');
    } else {
      // multiple: axis-aligned bounding frame, no handles
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const el of els) {
        const b = elAABB(el);
        if (b.minX < minX) minX = b.minX; if (b.minY < minY) minY = b.minY;
        if (b.maxX > maxX) maxX = b.maxX; if (b.maxY > maxY) maxY = b.maxY;
      }
      const sx = state.view.panX + minX * zoom;
      const sy = state.view.panY + minY * zoom;
      selbox.style.left = (sx + (maxX - minX) * zoom / 2) + 'px';
      selbox.style.top = (sy + (maxY - minY) * zoom / 2) + 'px';
      selbox.style.width = ((maxX - minX) * zoom) + 'px';
      selbox.style.height = ((maxY - minY) * zoom) + 'px';
      selbox.style.transform = 'translate(-50%, -50%) rotate(0deg)';
      selbox.classList.add('multi');
      selbox.classList.remove('single');
    }
    selbox.classList.add('active');
  }

  // ---------- pointer interaction ----------
  let drag = null;

  function onElementPointerDown(e, el) {
    if (e.button === 1) { e.preventDefault(); e.stopPropagation(); startPan(e, true); return; }
    if (editingId === el.id) return;           // let text editing receive the event
    if (e.button !== 0) return;                // right handled by marquee / context menu
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) { toggleSelection(el.id); return; }  // multi-select toggle
    if (!selectedIds.has(el.id)) { select(el.id); bringToFront(el); }  // fresh single select
    const start = screenToWorld(e.clientX, e.clientY);
    const moving = getSelectedEls().map((se) => ({ el: se, sx: se.x, sy: se.y }));
    drag = { kind: 'move', moving, startWX: start.x, startWY: start.y, moved: false };
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
      const dx = p.x - drag.startWX, dy = p.y - drag.startWY;
      for (const m of drag.moving) { m.el.x = m.sx + dx; m.el.y = m.sy + dy; placeNode(m.el); }
      drag.moved = true;
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
    el.scrollY = 0;
    const n = nodes.get(el.id);
    n.classList.add('editing');
    const c = n.querySelector('.note-content');
    applyNoteStyle(el);            // drop scroll translate while editing
    c.contentEditable = 'true';
    c.focus();
    // place caret at end
    const r = document.createRange();
    r.selectNodeContents(c); r.collapse(false);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    c.addEventListener('paste', onNotePaste);
    c.addEventListener('blur', onNoteBlur, { once: true });
  }
  // paste inside a note: convert rich/special text to plain markdown, insert as text
  function onNotePaste(e) {
    e.preventDefault();
    const cd = e.clipboardData;
    if (!cd) return;
    const html = cd.getData('text/html');
    const plain = cd.getData('text/plain');
    const out = html ? htmlToMarkdown(html) : normalizePlain(plain);
    insertPlainText(out);
  }
  function insertPlainText(text) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    r.deleteContents();
    r.insertNode(document.createTextNode(text));
    r.collapse(false);
    sel.removeAllRanges(); sel.addRange(r);
  }
  function onNoteBlur(e) {
    const n = e.target.closest('.el');
    if (!n) return;
    const el = state.elements.find((x) => x.id === n.dataset.id);
    // innerText preserves line breaks (textContent collapses <div>/<br> boundaries)
    if (el) { el.text = normalizePlain(e.target.innerText); e.target.textContent = el.text; scheduleSave(); }
    n.classList.remove('editing');
    e.target.contentEditable = 'false';
    e.target.removeEventListener('paste', onNotePaste);
    if (editingId === (el && el.id)) editingId = null;
    if (el) applyNoteStyle(el);
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

  function addImageFromSrc(src, wx, wy, fallbackLink) {
    const img = new Image();
    img.onload = () => {
      const max = 360;
      let w = img.naturalWidth, h = img.naturalHeight;
      const sc = Math.min(1, max / Math.max(w, h));
      w = Math.max(40, w * sc); h = Math.max(30, h * sc);
      const el = addElement({ type: 'image', x: wx - w / 2, y: wy - h / 2, w, h, src, _aspect: img.naturalWidth / img.naturalHeight });
      select(el.id);
    };
    img.onerror = () => {
      // remote image blocked (hotlink/CORS) — keep the link as a note so nothing is lost
      const link = fallbackLink || src;
      addNote(wx, wy, link);
      toast('Could not load image \u2014 kept the link');
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
    // hovering a note: scroll its content instead of the canvas (when it overflows)
    if (!(e.ctrlKey || e.metaKey || e.shiftKey)) {
      const noteNode = e.target.closest && e.target.closest('.el.note');
      if (noteNode) {
        const el = state.elements.find((x) => x.id === noteNode.dataset.id);
        if (el) {
          if (editingId === el.id) return;        // let the editor scroll natively
          const max = noteMaxScroll(el);
          if (max > 0) {
            e.preventDefault();
            el.scrollY = clamp((el.scrollY || 0) + e.deltaY / (el.scale || 1), 0, max);
            applyNoteStyle(el);
            scheduleSave();
            return;
          }
        }
      }
    }
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
  // shift + left-drag = marquee selection (capture phase, before element/pan handlers)
  let marquee = null;
  const marqueeEl = $('#marquee');
  window.addEventListener('pointerdown', (e) => {
    if (e.button === 0 && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      hideMenus();
      marquee = { sx: e.clientX, sy: e.clientY, add: (e.ctrlKey || e.metaKey), base: new Set(selectedIds) };
      marqueeEl.classList.add('active');
      positionMarquee(e.clientX, e.clientY);
      window.addEventListener('pointermove', onMarqueeMove);
      window.addEventListener('pointerup', onMarqueeUp, { once: true });
    }
  }, true);
  function positionMarquee(x, y) {
    const x1 = Math.min(marquee.sx, x), y1 = Math.min(marquee.sy, y);
    marqueeEl.style.left = x1 + 'px';
    marqueeEl.style.top = y1 + 'px';
    marqueeEl.style.width = Math.abs(x - marquee.sx) + 'px';
    marqueeEl.style.height = Math.abs(y - marquee.sy) + 'px';
  }
  function onMarqueeMove(e) {
    if (!marquee) return;
    positionMarquee(e.clientX, e.clientY);
    // live preview of what's inside
    const ids = marqueeHits(e.clientX, e.clientY);
    const set = marquee.add ? new Set([...marquee.base, ...ids]) : new Set(ids);
    for (const [eid, n] of nodes) n.classList.toggle('is-selected', set.has(eid));
  }
  function marqueeHits(x, y) {
    const a = screenToWorld(Math.min(marquee.sx, x), Math.min(marquee.sy, y));
    const b = screenToWorld(Math.max(marquee.sx, x), Math.max(marquee.sy, y));
    const r = { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
    const hits = [];
    for (const el of state.elements) {
      const e2 = elAABB(el);
      if (e2.minX <= r.maxX && e2.maxX >= r.minX && e2.minY <= r.maxY && e2.maxY >= r.minY) hits.push(el.id);
    }
    return hits;
  }
  function onMarqueeUp(e) {
    window.removeEventListener('pointermove', onMarqueeMove);
    marqueeEl.classList.remove('active');
    const ids = marqueeHits(e.clientX, e.clientY);
    const final = marquee.add ? new Set([...marquee.base, ...ids]) : ids;
    marquee = null;
    setSelection([...final]);
  }

  viewport.addEventListener('pointerdown', (e) => {
    if (e.button === 1) { e.preventDefault(); startPan(e, true); return; }
    if (e.button === 2) return;         // right button -> context menu / marquee
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
  ['dragenter', 'dragover'].forEach((ev) => window.addEventListener(ev, (e) => {
    const types = e.dataTransfer ? Array.from(e.dataTransfer.types) : [];
    if (types.includes('Files') || types.includes('text/uri-list') || types.includes('text/html') || types.includes('text/plain')) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
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
    // image dragged from another tab/app (Google Images, etc.)
    const dtHtml = e.dataTransfer.getData('text/html');
    const uri = (e.dataTransfer.getData('text/uri-list') || '').split('\n').find((l) => l && !l.startsWith('#')) || '';
    let imgUrl = '';
    if (dtHtml) { const m = /<img[^>]+src\s*=\s*["']([^"']+)["']/i.exec(dtHtml); if (m) imgUrl = m[1]; }
    if (!imgUrl) {
      const u = uri.trim();
      if (/^data:image\//i.test(u) || /^https?:\/\/[^\s]+\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?[^\s]*)?$/i.test(u)) imgUrl = u;
    }
    if (imgUrl) { addImageFromSrc(imgUrl, w.x, w.y, uri.trim() || imgUrl); return; }
    const txt = e.dataTransfer.getData('text/plain');
    if (dtHtml) addNote(w.x, w.y, htmlToMarkdown(dtHtml));
    else if (txt) addNote(w.x, w.y, normalizePlain(txt));
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
    const cbHtml = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    if (cbHtml) { e.preventDefault(); addNote(center.x, center.y, htmlToMarkdown(cbHtml)); }
    else if (text) { e.preventDefault(); addNote(center.x, center.y, normalizePlain(text)); }
  });

  // ---------- keyboard ----------
  window.addEventListener('keydown', (e) => {
    if (editingId) { if (e.key === 'Escape') stopEditing(); return; }
    const els = getSelectedEls();
    const one = getSelected();
    if ((e.key === 'Delete' || e.key === 'Backspace') && els.length) { e.preventDefault(); removeSelection(); }
    else if (e.key === 'Escape') select(null);
    else if (els.length && e.key === ']') els.forEach(bringToFront);
    else if (els.length && e.key === '[') els.forEach(sendToBack);
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D') && els.length) { e.preventDefault(); duplicateSelection(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); setSelection(state.elements.map((x) => x.id)); }
    else if (one && e.key === 'Enter' && one.type === 'note') { e.preventDefault(); startEditing(one); }
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
  // in-app Save dialog: resolves to the chosen base name, or null if cancelled
  function promptFilename(def) {
    return new Promise((resolve) => {
      const wrap = $('#savewrap');
      const input = $('#savename');
      const base = (def || 'Chalkboard').replace(/\.pdf$/i, '');
      input.value = base;
      wrap.classList.add('active');
      input.focus(); input.select();
      let done = false;
      function finish(val) {
        if (done) return; done = true;
        wrap.classList.remove('active');
        $('#saveok').removeEventListener('click', onOk);
        $('#savecancel').removeEventListener('click', onCancel);
        wrap.removeEventListener('pointerdown', onBackdrop);
        input.removeEventListener('keydown', onKey);
        resolve(val);
      }
      const onOk = () => finish(input.value.trim() || base);
      const onCancel = () => finish(null);
      const onBackdrop = (e) => { if (e.target === wrap) finish(null); };
      const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); onOk(); } else if (e.key === 'Escape') { e.preventDefault(); onCancel(); } };
      $('#saveok').addEventListener('click', onOk);
      $('#savecancel').addEventListener('click', onCancel);
      wrap.addEventListener('pointerdown', onBackdrop);
      input.addEventListener('keydown', onKey);
    });
  }

  $('#tl-pdf').addEventListener('click', async () => {
    if (!state.elements.length) { toast('Nothing to export yet'); return; }
    select(null);
    toast('Building PDF\u2026');
    try { const r = await window.Export.toPDF({ viewport, world, state, applyView, promptFilename }); if (r !== 'cancelled') toast('PDF saved'); }
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
      if (!selectedIds.has(node.dataset.id)) select(node.dataset.id);  // keep group if right-clicking a member
      const one = getSelected();
      ctxmenu.querySelector('[data-act="download"]').style.display =
        (one && (one.type === 'image' || one.type === 'pdf' || one.type === 'text' || one.type === 'chip')) ? '' : 'none';
      const dup = ctxmenu.querySelector('[data-act="dup"] span');
      if (dup) dup.textContent = selectedIds.size > 1 ? 'Duplicate ' + selectedIds.size + ' items' : 'Duplicate';
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
    const els = getSelectedEls();
    if (!els.length) { hideMenus(); return; }
    switch (btn.dataset.act) {
      case 'delete': removeSelection(); break;
      case 'back': els.forEach(sendToBack); break;
      case 'front': els.forEach(bringToFront); break;
      case 'dup': duplicateSelection(); break;
      case 'download': if (els.length === 1) downloadElement(els[0]); break;
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
          } else if (it.types.includes('text/html')) {
            const blob = await it.getType('text/html');
            const html = await blob.text();
            if (html) addNote(wx, wy, htmlToMarkdown(html));
            handled = true;
          } else if (it.types.includes('text/plain')) {
            const blob = await it.getType('text/plain');
            const text = await blob.text();
            if (text) addNote(wx, wy, normalizePlain(text));
            handled = true;
          }
        }
        if (handled) return;
      }
      const text = await navigator.clipboard.readText();
      if (text) addNote(wx, wy, normalizePlain(text));
      else toast('Clipboard is empty');
    } catch (err) {
      toast('Allow clipboard access, or press \u2318/Ctrl + V');
    }
  }

  window.addEventListener('pointerdown', (e) => { if (!(e.target instanceof Element) || !e.target.closest('.ctx')) hideMenus(); }, true);
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
