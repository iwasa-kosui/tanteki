import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function copyMermaidAssets(source, output) {
  const mermaid = dirname(fileURLToPath(import.meta.resolve('mermaid')));
  const vendor = join(output, 'vendor/mermaid');
  await mkdir(vendor, { recursive: true });
  for (const file of ['mermaid-preview.js', 'mermaid-preview.css']) {
    await cp(join(source, file), join(output, file));
  }
  await cp(join(mermaid, 'mermaid.esm.min.mjs'), join(vendor, 'mermaid.esm.min.mjs'));
  await cp(join(mermaid, 'chunks/mermaid.esm.min'), join(vendor, 'chunks/mermaid.esm.min'), {
    recursive: true,
    filter: (path) => !path.endsWith('.map'),
  });
  await cp(join(mermaid, '../LICENSE'), join(vendor, 'LICENSE'));
}

export function addMermaidPreview(html, base) {
  return html.replace('<title>', `<link rel="stylesheet" href="${base}mermaid-preview.css"><script type="module" src="${base}mermaid-preview.js"></script><title>`);
}
