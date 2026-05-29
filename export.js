/* PDF export — renders the whole board (its content bounding box) to a single
   PDF page via html2canvas + jsPDF. Resets the view to scale 1 around the
   content, captures, then restores. */
(function () {
  'use strict';

  // axis-aligned bounds of all elements accounting for rotation, with padding
  function contentBounds(elements, pad) {
    pad = pad || 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of elements) {
      const a = el.rot * Math.PI / 180;
      const u = { x: Math.cos(a), y: Math.sin(a) };
      const v = { x: -Math.sin(a), y: Math.cos(a) };
      const c = { x: el.x + el.w / 2, y: el.y + el.h / 2 };
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
        const px = c.x + sx * (el.w / 2) * u.x + sy * (el.h / 2) * v.x;
        const py = c.y + sx * (el.w / 2) * u.y + sy * (el.h / 2) * v.y;
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
      }
    }
    if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 100; maxY = 100; }
    return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad, w: (maxX - minX) + 2 * pad, h: (maxY - minY) + 2 * pad };
  }

  async function toPDF(ctx) {
    const { viewport, world, state, applyView } = ctx;
    const pad = 48;
    const b = contentBounds(state.elements, pad);
    const W = Math.ceil(b.w), H = Math.ceil(b.h);

    // keep canvas under browser limits while staying crisp
    const maxDim = 7000;
    let scale = 2;
    if (W * scale > maxDim || H * scale > maxDim) scale = Math.max(1, Math.min(maxDim / W, maxDim / H));

    const saved = { transform: world.style.transform, overflow: viewport.style.overflow };
    world.style.transform = `translate(${-b.minX}px, ${-b.minY}px) scale(1)`;
    viewport.style.overflow = 'visible';
    viewport.classList.add('exporting');
    document.querySelectorAll('.chrome, #mark, #selbox, #toast').forEach((n) => n.classList.add('exporting-hide'));

    let canvas;
    try {
      canvas = await html2canvas(viewport, {
        width: W, height: H, x: 0, y: 0,
        backgroundColor: '#faf9f6', scale,
        useCORS: true, logging: false,
        windowWidth: Math.max(W, window.innerWidth),
        windowHeight: Math.max(H, window.innerHeight),
      });
    } finally {
      world.style.transform = saved.transform;
      viewport.style.overflow = saved.overflow;
      viewport.classList.remove('exporting');
      document.querySelectorAll('.exporting-hide').forEach((n) => n.classList.remove('exporting-hide'));
      applyView();
    }

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: W >= H ? 'landscape' : 'portrait', unit: 'px', format: [W, H], compress: true });
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, W, H);
    pdf.save('chalkboard.pdf');
  }

  window.Export = { toPDF, contentBounds };
})();
