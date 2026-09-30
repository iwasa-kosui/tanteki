let renderer;
let nextId = 0;

function loadMermaid() {
  renderer ??= import('./vendor/mermaid/mermaid.esm.min.mjs').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      fontFamily: '"Noto Sans JP", "Hiragino Kaku Gothic ProN", Meiryo, sans-serif',
    });
    return mermaid;
  });
  return renderer;
}

async function renderDiagram(source) {
  try {
    const mermaid = await loadMermaid();
    await document.fonts.ready;
    const { svg } = await mermaid.render(`mermaid-preview-${++nextId}`, source.textContent);
    const figure = document.createElement('figure');
    figure.className = 'mermaid-preview';
    const diagram = document.createElement('div');
    diagram.className = 'mermaid-diagram';
    diagram.tabIndex = 0;
    diagram.setAttribute('role', 'region');
    diagram.setAttribute('aria-label', 'Mermaidの図');
    // Only Mermaid's strict-mode SVG enters the page; the source stays text.
    diagram.innerHTML = svg;
    const drawing = diagram.querySelector('svg');
    const width = drawing.viewBox.baseVal.width;
    if (width > 0) drawing.style.width = `${width}px`;
    const zoom = document.createElement('button');
    zoom.type = 'button';
    zoom.className = 'mermaid-zoom';
    zoom.textContent = '図を拡大';
    zoom.setAttribute('aria-pressed', 'false');
    zoom.addEventListener('click', () => {
      const expanded = diagram.classList.toggle('is-expanded');
      zoom.setAttribute('aria-pressed', String(expanded));
      zoom.textContent = expanded ? '図を縮小' : '図を拡大';
    });
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = '図のソース';
    details.append(summary);
    figure.append(diagram, zoom, details);
    source.replaceWith(figure);
    details.append(source);
  } catch {
    // A failed import or invalid diagram must leave the original text readable.
    source.dataset.mermaidState = 'failed';
  }
}

// Hidden tabs and closed details are rendered only after they become visible.
const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    observer.unobserve(entry.target);
    void renderDiagram(entry.target);
  }
});
for (const source of document.querySelectorAll('pre[data-mermaid]')) observer.observe(source);
