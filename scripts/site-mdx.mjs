import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluate } from '@mdx-js/mdx';
import { createElement as h } from 'react';
import * as runtime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import remarkGfm from 'remark-gfm';
import { components, Layout } from '../docs/components.mjs';

// Only repository-owned MDX is evaluated. Benchmark documents stay in the
// existing Markdown renderer and are never executed as MDX.
export async function renderSite(source, format, fragments) {
  const load = async (name) => {
    const path = join(source, name);
    return evaluate({ path, value: await readFile(path, 'utf8') }, {
      ...runtime, baseUrl: pathToFileURL(path), remarkPlugins: [remarkGfm],
    });
  };
  const { default: Content, metadata } = await load('index.mdx');
  for (const key of ['title', 'description', 'imageAlt', 'footer']) {
    if (typeof metadata?.[key] !== 'string' || !metadata[key].trim()) throw new Error(`Missing site metadata: ${key}`);
  }
  const slots = format === 'isolated' ? ['Examples', 'RunContext', 'RunSources'] : ['Examples', 'EvaluationRows', 'BenchmarkRows'];
  const mdxComponents = {
    ...components,
    IsolatedOnly: ({ children }) => format === 'isolated' ? children : null,
    LegacyOnly: ({ children }) => format === 'legacy' ? children : null,
    ...Object.fromEntries(['Examples', 'RunContext', 'RunSources', 'EvaluationRows', 'BenchmarkRows'].map((name) => [name, () => h('site-slot', { name })])),
  };
  if (format === 'legacy') {
    const { default: LegacyEvidence } = await load('legacy-evidence.mdx');
    mdxComponents.LegacyEvidence = () => h(LegacyEvidence, { components: mdxComponents });
  } else {
    mdxComponents.LegacyEvidence = () => null;
  }
  let html = '<!doctype html>\n' + renderToStaticMarkup(h(Layout, { metadata }, h(Content, { components: mdxComponents })));
  let prose = html;
  for (const name of slots) {
    const marker = `<site-slot name="${name}"></site-slot>`;
    if (html.split(marker).length !== 2) throw new Error(`Expected one <${name} /> in site MDX`);
    if (typeof fragments[name] !== 'string') throw new Error(`Missing site fragment: ${name}`);
    html = html.replace(marker, () => fragments[name]);
    // Quotes and prompts keep their original text; lint only editorial copy.
    prose = prose.replace(marker, () => name === 'Examples' ? '' : fragments[name]);
  }
  return { html, prose: extractProse(prose) };
}

export function extractProse(html) {
  return html
    .replace(/<head>[\s\S]*?<\/head>/g, '')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/g, (_, content) => `\n\n\`\`\`text\n${content.replace(/<[^>]*>/g, '')}\n\`\`\`\n\n`)
    .replace(/<!--[^]*?-->/g, '')
    .replace(/<\/a>\s*<a\b/g, '</a>\n\n<a')
    .replace(/<\/?(?:header|nav|footer)[^>]*>/g, '\n\n')
    .replace(/<(?:br|\/p|\/h[1-6]|\/div|\/section|\/article|\/li|\/dt|\/dd|\/caption|\/th|\/td|\/label|\/option|\/button|\/summary)[^>]*>/g, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&#x([a-f\d]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .split('\n').map((line) => line.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
