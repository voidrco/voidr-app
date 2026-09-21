function previewPoint(image, event) {
  if (!image.naturalWidth || image.hidden) return null;
  const rect = image.getBoundingClientRect();
  const scale = Math.min(1, rect.width / image.naturalWidth, rect.height / image.naturalHeight);
  const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
  const x = (event.clientX - rect.left - (rect.width - width) / 2) / width;
  const y = (event.clientY - rect.top - (rect.height - height) / 2) / height;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}

export function mountIntervention(root, api, onError) {
  const image = root.getElementById('screenshot');
  const panel = root.getElementById('intervention');
  const field = root.getElementById('intervention-value');
  const state = { active: false };
  const controller = new AbortController();
  const listen = (node, event, callback, options = {}) => node.addEventListener(event, callback, { ...options, signal: controller.signal });
  const send = input => { if (state.active) void api.input(input).catch(onError); };
  listen(image, 'click', event => {
    if (!state.active) return;
    const point = previewPoint(image, event);
    if (point) { image.focus(); send({ type: 'click', ...point }); }
  });
  listen(image, 'keydown', event => {
    if (!state.active) return;
    event.stopPropagation();
    const key = event.key === ' ' ? 'Space' : event.key === 'Tab' && event.shiftKey ? 'Shift+Tab' : event.key;
    if (!['Tab', 'Shift+Tab', 'Enter', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(key)) return;
    event.preventDefault(); send({ type: 'key', key });
  });
  listen(image, 'wheel', event => {
    if (!state.active) return;
    event.preventDefault(); send({ type: 'wheel', deltaY: Math.max(-2000, Math.min(2000, event.deltaY)) });
  }, { passive: false });
  listen(panel, 'submit', event => {
    event.preventDefault(); event.stopPropagation();
    if (!state.active || !field.value) return;
    send({ type: 'fill', value: field.value }); field.value = ''; image.focus();
  });
  listen(panel, 'keydown', event => event.stopPropagation());
  listen(root.getElementById('intervention-enter'), 'click', () => send({ type: 'key', key: 'Enter' }));
  listen(root.getElementById('intervention-resume'), 'click', () => { if (state.active) void api.resume().catch(onError); });
  return {
    update(active) {
      state.active = active;
      panel.hidden = !active;
      image.tabIndex = active ? 0 : -1;
      image.parentElement.dataset.intervening = String(active);
      if (!active) field.value = '';
    },
    dispose() { controller.abort(); field.value = ''; },
  };
}
