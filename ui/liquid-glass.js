// Shared native-DOM material. Inlined into both distributions by tools/build-ui.cjs.
// Inspired by the edge optics and layered interaction in the projects credited in ui/README.md.
function installLiquidGlass(panel, modal = null) {
  if (!panel || panel.dataset.glassReady) return;
  panel.dataset.glassReady = 'true';
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const reducedTransparency = window.matchMedia('(prefers-reduced-transparency: reduce)');
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.cssText = 'position:fixed;pointer-events:none;overflow:hidden';
  svg.id = `${panel.id}-optics`;
  const defs = document.createElementNS(ns, 'defs');
  svg.appendChild(defs);
  document.documentElement.appendChild(svg);
  const surfaces = [panel, modal?.querySelector('.cau-cw-dialog')].filter(Boolean);
  const entries = [];
  const removers = [];
  let suspended = document.hidden;
  let disposed = false;
  const listen = (target, name, handler, options) => {
    target.addEventListener(name, handler, options);
    removers.push(() => target.removeEventListener(name, handler, options));
  };
  // SVG backdrop displacement is supported by Chromium. Keep a plain blur in other engines.
  const refracts = /Chrome|Chromium|Edg\//.test(navigator.userAgent)
    && window.CSS?.supports('backdrop-filter', 'url("#glass")');

  function reset(entry) {
    cancelAnimationFrame(entry.frame);
    entry.frame = 0;
    entry.active = false;
    entry.surface.style.setProperty('--glass-light', '0');
    entry.surface.style.setProperty('--glass-x', '50%');
    entry.surface.style.setProperty('--glass-y', '0px');
    if (entry.button) entry.button.style.removeProperty('translate');
    entry.button = null;
  }

  function makeMap(entry) {
    if (disposed || suspended || !refracts || reducedTransparency.matches) return;
    // Layout dimensions stay stable while the entrance animation scales the surface.
    const rect = { width: entry.surface.offsetWidth, height: entry.surface.offsetHeight };
    if (!rect.width || !rect.height) return;
    const key = `${Math.round(rect.width)}x${Math.round(rect.height)}`;
    if (entry.size === key) return;
    entry.size = key;
    // Downsample the optical map only; page text always remains native DOM.
    const ratio = Math.min(1, 384 / Math.max(rect.width, rect.height));
    const width = Math.max(2, Math.round(rect.width * ratio));
    const height = Math.max(2, Math.round(rect.height * ratio));
    const radius = Math.min(parseFloat(getComputedStyle(entry.surface).borderRadius) || 24, rect.width / 2, rect.height / 2) * ratio;
    const bezel = 20 * ratio;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const pixels = ctx.createImageData(width, height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const px = x + .5 - width / 2;
        const py = y + .5 - height / 2;
        const qx = Math.abs(px) - (width / 2 - radius);
        const qy = Math.abs(py) - (height / 2 - radius);
        const ox = Math.max(qx, 0);
        const oy = Math.max(qy, 0);
        const length = Math.hypot(ox, oy);
        const distance = length + Math.min(Math.max(qx, qy), 0) - radius;
        const envelope = Math.pow(Math.max(0, 1 - Math.abs(distance) / bezel), 2);
        const nx = length ? ox / length : (qx > qy ? 1 : 0);
        const ny = length ? oy / length : (qx > qy ? 0 : 1);
        const index = (y * width + x) * 4;
        pixels.data[index] = Math.round(128 + Math.sign(px) * nx * envelope * 106);
        pixels.data[index + 1] = Math.round(128 + Math.sign(py) * ny * envelope * 106);
        pixels.data[index + 2] = 128;
        pixels.data[index + 3] = 255;
      }
    }
    ctx.putImageData(pixels, 0, 0);
    entry.image.setAttribute('href', canvas.toDataURL());
    entry.surface.style.setProperty('--glass-optics', `url("#${entry.filter.id}")`);
    entry.surface.dataset.glassOptics = 'refraction';
  }

  surfaces.forEach((surface, index) => {
    const filter = document.createElementNS(ns, 'filter');
    filter.id = `${panel.id}-refraction-${index}`;
    filter.setAttribute('x', '0%');
    filter.setAttribute('y', '0%');
    filter.setAttribute('width', '100%');
    filter.setAttribute('height', '100%');
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    const image = document.createElementNS(ns, 'feImage');
    image.setAttribute('x', '0');
    image.setAttribute('y', '0');
    image.setAttribute('width', '100%');
    image.setAttribute('height', '100%');
    image.setAttribute('preserveAspectRatio', 'none');
    image.setAttribute('result', 'edge-map');
    const displacement = document.createElementNS(ns, 'feDisplacementMap');
    displacement.setAttribute('in', 'SourceGraphic');
    displacement.setAttribute('in2', 'edge-map');
    displacement.setAttribute('scale', '16');
    displacement.setAttribute('xChannelSelector', 'R');
    displacement.setAttribute('yChannelSelector', 'G');
    filter.append(image, displacement);
    defs.appendChild(filter);
    const entry = { surface, filter, image, size: '', frame: 0, active: false, x: 0, y: 0, tx: 0, ty: 0, light: 0, button: null };
    entries.push(entry);
    surface.dataset.glassOptics = 'blur';

    function animate() {
      entry.frame = 0;
      if (disposed || suspended || reducedMotion.matches || !surface.isConnected) { reset(entry); return; }
      entry.x += (entry.tx - entry.x) * .17;
      entry.y += (entry.ty - entry.y) * .17;
      const targetLight = entry.active ? 1 : 0;
      entry.light += (targetLight - entry.light) * .14;
      surface.style.setProperty('--glass-x', `${entry.x.toFixed(1)}px`);
      surface.style.setProperty('--glass-y', `${entry.y.toFixed(1)}px`);
      surface.style.setProperty('--glass-light', entry.light.toFixed(3));
      if (Math.abs(entry.x - entry.tx) + Math.abs(entry.y - entry.ty) + Math.abs(entry.light - targetLight) > .025) {
        entry.frame = requestAnimationFrame(animate);
      } else {
        entry.light = targetLight;
        surface.style.setProperty('--glass-light', String(targetLight));
      }
    }
    const wake = () => { if (!entry.frame) entry.frame = requestAnimationFrame(animate); };
    listen(surface, 'pointermove', (event) => {
      if (suspended || reducedMotion.matches || !finePointer.matches || event.pointerType === 'touch') return;
      const rect = surface.getBoundingClientRect();
      entry.tx = event.clientX - rect.left;
      entry.ty = event.clientY - rect.top;
      if (!entry.active) { entry.x = entry.tx; entry.y = entry.ty; }
      entry.active = true;
      const button = event.target.closest('button:not(:disabled)');
      if (entry.button && entry.button !== button) entry.button.style.removeProperty('translate');
      entry.button = button;
      if (button) {
        const box = button.getBoundingClientRect();
        const x = Math.max(-1.8, Math.min(1.8, (event.clientX - box.left - box.width / 2) * .045));
        const y = Math.max(-1.4, Math.min(1.4, (event.clientY - box.top - box.height / 2) * .06));
        button.style.translate = `${x.toFixed(2)}px ${y.toFixed(2)}px`;
      }
      wake();
    }, { passive: true });
    listen(surface, 'pointerleave', () => {
      entry.active = false;
      if (entry.button) entry.button.style.removeProperty('translate');
      entry.button = null;
      if (!suspended && !reducedMotion.matches) wake();
    });
    listen(surface, 'pointerdown', (event) => {
      const button = event.target.closest('button:not(:disabled)');
      if (!button || reducedMotion.matches || suspended) return;
      const rect = button.getBoundingClientRect();
      const ripple = document.createElement('span');
      ripple.className = 'cau-cw-glass-ripple';
      ripple.setAttribute('aria-hidden', 'true');
      ripple.style.left = `${event.clientX - rect.left}px`;
      ripple.style.top = `${event.clientY - rect.top}px`;
      button.appendChild(ripple);
      ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
      setTimeout(() => ripple.remove(), 800);
    }, { passive: true });
  });

  let resizeFrame = 0;
  const updateMaps = () => entries.forEach((entry) => {
    try { makeMap(entry); } catch (_) {
      // CSP/canvas restrictions should never prevent using the monitor.
      entry.surface.style.removeProperty('--glass-optics');
      entry.surface.dataset.glassOptics = 'blur';
    }
  });
  const refresh = () => {
    if (resizeFrame || disposed || suspended) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      updateMaps();
    });
  };
  const resizeObserver = new ResizeObserver(refresh);
  surfaces.forEach((surface) => resizeObserver.observe(surface));
  const preferencesChanged = () => {
    entries.forEach((entry) => {
      reset(entry);
      if (reducedTransparency.matches) {
        entry.surface.style.removeProperty('--glass-optics');
        entry.surface.dataset.glassOptics = 'blur';
        entry.size = '';
      }
    });
    refresh();
  };
  listen(reducedMotion, 'change', preferencesChanged);
  listen(reducedTransparency, 'change', preferencesChanged);
  listen(finePointer, 'change', preferencesChanged);
  listen(document, 'visibilitychange', () => {
    suspended = document.hidden;
    if (suspended) entries.forEach(reset);
    else refresh();
  });
  // Preserve the material when a page returns from the browser back/forward cache.
  listen(window, 'pagehide', (event) => {
    entries.forEach(reset);
    cancelAnimationFrame(resizeFrame);
    resizeFrame = 0;
    if (event.persisted) { suspended = true; return; }
    disposed = true;
    resizeObserver.disconnect();
    svg.remove();
    removers.forEach((remove) => remove());
  });
  listen(window, 'pageshow', () => { suspended = document.hidden; refresh(); });
  updateMaps();
}
