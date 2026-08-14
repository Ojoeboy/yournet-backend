// logo-editor.js
//
// Shared client-side helper for the account logo and portal logo upload
// buttons. Runs entirely in the browser before the file is ever sent to the
// server, so most images "just work" instead of bouncing off the 1.5MB
// server-side limit.
//
// Two paths, both producing a square image:
//   1. Auto (default) - "contain": the whole image is scaled down to fit
//      inside a square, with transparent padding on the short side. Nothing
//      is cropped out.
//   2. Manual - a simple draggable/resizable square box over the image lets
//      the admin pick which part to keep (no zoom - deliberately simple).
//
// Either path re-encodes the result (PNG if it fits under the size limit,
// otherwise falls back to JPEG at decreasing quality) so the upload should
// clear the server's size check on the first try.

(function () {
  const OUTPUT_DIM = 512; // logos are shown small (64px-ish); 512 is plenty of headroom
  const MAX_BYTES = 1.5 * 1024 * 1024;

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => resolve({ img, url });
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image file.')); };
      img.src = url;
    });
  }

  // Draws either the whole image (contain, transparent padding) or a
  // square crop region of it onto an OUTPUT_DIM x OUTPUT_DIM canvas.
  function renderToCanvas(img, cropRect) {
    const canvas = document.createElement('canvas');
    canvas.width = OUTPUT_DIM;
    canvas.height = OUTPUT_DIM;
    const ctx = canvas.getContext('2d');
    if (cropRect) {
      ctx.drawImage(
        img,
        cropRect.x, cropRect.y, cropRect.w, cropRect.h,
        0, 0, OUTPUT_DIM, OUTPUT_DIM
      );
    } else {
      const scale = Math.min(OUTPUT_DIM / img.width, OUTPUT_DIM / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      const x = (OUTPUT_DIM - w) / 2;
      const y = (OUTPUT_DIM - h) / 2;
      ctx.drawImage(img, 0, 0, img.width, img.height, x, y, w, h);
    }
    return canvas;
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  }

  // Tries PNG first (keeps transparent padding crisp). If that's over the
  // limit, flattens onto white and steps down JPEG quality until it fits.
  async function encodeUnderLimit(canvas) {
    const png = await canvasToBlob(canvas, 'image/png');
    if (png && png.size <= MAX_BYTES) return { blob: png, ext: 'png', mime: 'image/png' };

    const flat = document.createElement('canvas');
    flat.width = canvas.width;
    flat.height = canvas.height;
    const fctx = flat.getContext('2d');
    fctx.fillStyle = '#ffffff';
    fctx.fillRect(0, 0, flat.width, flat.height);
    fctx.drawImage(canvas, 0, 0);

    const qualities = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4];
    let last = null;
    for (let i = 0; i < qualities.length; i++) {
      const jpg = await canvasToBlob(flat, 'image/jpeg', qualities[i]);
      last = jpg;
      if (jpg && jpg.size <= MAX_BYTES) return { blob: jpg, ext: 'jpg', mime: 'image/jpeg' };
    }
    // Best effort - smallest quality we tried, even if still slightly over.
    return { blob: last || png, ext: 'jpg', mime: 'image/jpeg' };
  }

  async function processImage(file, cropRect) {
    const { img, url } = await loadImage(file);
    try {
      const canvas = renderToCanvas(img, cropRect);
      const { blob, ext, mime } = await encodeUnderLimit(canvas);
      const baseName = (file.name || 'logo').replace(/\.[^.]+$/, '');
      return new File([blob], baseName + '.' + ext, { type: mime });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // Opens the crop modal for `file`. Calls onConfirm(processedFile) once the
  // admin picks a path, or onCancel() if they back out.
  function open(file, { onConfirm, onCancel } = {}) {
    loadImage(file).then(({ img, url }) => {
      const DISPLAY_MAX = 320;
      const scale = Math.min(DISPLAY_MAX / img.width, DISPLAY_MAX / img.height, 1);
      const dispW = Math.max(40, Math.round(img.width * scale));
      const dispH = Math.max(40, Math.round(img.height * scale));

      const overlay = document.createElement('div');
      overlay.id = 'logoEditorOverlay';
      overlay.style.cssText =
        'position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:9999;' +
        'display:flex;align-items:center;justify-content:center;padding:16px';

      const modal = document.createElement('div');
      modal.style.cssText =
        'background:#0f1a1d;border:1px solid rgba(255,255,255,.15);border-radius:12px;' +
        'padding:20px;max-width:420px;width:100%;color:#dfe9eb;font-family:inherit';

      modal.innerHTML =
        '<h3 style="margin:0 0 6px;font-size:15px">Adjust your logo</h3>' +
        '<p style="margin:0 0 14px;font-size:12px;color:#8fa5aa">' +
        'Drag the box to pick which part to keep, or just use the whole image ' +
        '(nothing gets cropped out).</p>' +
        '<div id="logoEditorStage" style="position:relative;width:' + dispW + 'px;height:' + dispH +
        'px;margin:0 auto 16px;background:repeating-conic-gradient(#1c2b2f 0 25%, #142023 0 50%) 0/16px 16px;' +
        'border:1px solid rgba(255,255,255,.15);overflow:hidden">' +
        '<img id="logoEditorImg" src="' + url + '" style="position:absolute;top:0;left:0;width:' + dispW +
        'px;height:' + dispH + 'px;user-select:none;pointer-events:none">' +
        '<div id="logoEditorBox" style="position:absolute;border:2px solid #e8a33d;' +
        'box-shadow:0 0 0 9999px rgba(0,0,0,.45);cursor:move">' +
        '<div id="logoEditorHandle" style="position:absolute;right:-7px;bottom:-7px;width:14px;height:14px;' +
        'background:#e8a33d;border-radius:3px;cursor:nwse-resize"></div>' +
        '</div></div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">' +
        '<button type="button" id="logoEditorCancel" class="secondary" style="padding:8px 12px;font-size:12px">Cancel</button>' +
        '<button type="button" id="logoEditorAuto" class="secondary" style="padding:8px 12px;font-size:12px">Use whole image</button>' +
        '<button type="button" id="logoEditorConfirm" style="padding:8px 12px;font-size:12px">Use this crop</button>' +
        '</div>';

      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      const box = modal.querySelector('#logoEditorBox');
      const handle = modal.querySelector('#logoEditorHandle');

      let boxSize = Math.min(dispW, dispH);
      let boxX = (dispW - boxSize) / 2;
      let boxY = (dispH - boxSize) / 2;

      function renderBox() {
        box.style.width = boxSize + 'px';
        box.style.height = boxSize + 'px';
        box.style.left = boxX + 'px';
        box.style.top = boxY + 'px';
      }
      function clampBox() {
        boxSize = Math.max(24, Math.min(boxSize, Math.min(dispW, dispH)));
        boxX = Math.max(0, Math.min(boxX, dispW - boxSize));
        boxY = Math.max(0, Math.min(boxY, dispH - boxSize));
      }
      renderBox();

      let dragMode = null;
      let startX = 0, startY = 0, startBoxX = 0, startBoxY = 0, startSize = 0;

      function beginDrag(e, mode) {
        e.preventDefault();
        dragMode = mode;
        const p = e.touches ? e.touches[0] : e;
        startX = p.clientX; startY = p.clientY;
        startBoxX = boxX; startBoxY = boxY; startSize = boxSize;
        window.addEventListener('mousemove', onDrag);
        window.addEventListener('mouseup', endDrag);
        window.addEventListener('touchmove', onDrag, { passive: false });
        window.addEventListener('touchend', endDrag);
      }
      function onDrag(e) {
        if (!dragMode) return;
        e.preventDefault();
        const p = e.touches ? e.touches[0] : e;
        const dx = p.clientX - startX;
        const dy = p.clientY - startY;
        if (dragMode === 'move') {
          boxX = startBoxX + dx;
          boxY = startBoxY + dy;
        } else {
          boxSize = startSize + Math.max(dx, dy);
        }
        clampBox();
        renderBox();
      }
      function endDrag() {
        dragMode = null;
        window.removeEventListener('mousemove', onDrag);
        window.removeEventListener('mouseup', endDrag);
        window.removeEventListener('touchmove', onDrag);
        window.removeEventListener('touchend', endDrag);
      }
      box.addEventListener('mousedown', (e) => beginDrag(e, 'move'));
      box.addEventListener('touchstart', (e) => beginDrag(e, 'move'), { passive: false });
      handle.addEventListener('mousedown', (e) => { e.stopPropagation(); beginDrag(e, 'resize'); });
      handle.addEventListener('touchstart', (e) => { e.stopPropagation(); beginDrag(e, 'resize'); }, { passive: false });

      function cleanup() {
        document.body.removeChild(overlay);
        URL.revokeObjectURL(url);
      }

      modal.querySelector('#logoEditorCancel').onclick = () => {
        cleanup();
        if (onCancel) onCancel();
      };
      modal.querySelector('#logoEditorAuto').onclick = async () => {
        cleanup();
        const processed = await processImage(file, null);
        if (onConfirm) onConfirm(processed);
      };
      modal.querySelector('#logoEditorConfirm').onclick = async () => {
        const naturalScale = img.naturalWidth / dispW;
        const cropRect = {
          x: Math.round(boxX * naturalScale),
          y: Math.round(boxY * naturalScale),
          w: Math.round(boxSize * naturalScale),
          h: Math.round(boxSize * naturalScale),
        };
        cleanup();
        const processed = await processImage(file, cropRect);
        if (onConfirm) onConfirm(processed);
      };
    }).catch((err) => {
      if (onCancel) onCancel(err);
    });
  }

  window.LogoEditor = { open, processImage };
})();
