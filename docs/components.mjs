import { Children, cloneElement, createElement as h, isValidElement } from 'react';

const blocks = (children) => Children.toArray(children).filter(isValidElement);
const withClass = (children, className) => blocks(children).map((child) => cloneElement(child, { className }));
const wordmark = () => h('a', { className: 'wordmark', href: './', 'aria-label': 'tanteki ホーム' }, 'tanteki', h('span', { 'aria-hidden': true }, '.'));

export function Layout({ metadata, children }) {
  const { title, description, imageAlt, footer } = metadata;
  const url = 'https://iwasa-kosui.github.io/tanteki/';
  return h('html', { lang: 'ja' },
    h('head', null,
      h('meta', { charSet: 'utf-8' }),
      h('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
      h('meta', { name: 'theme-color', content: '#ffffff' }),
      h('meta', { name: 'description', content: description }),
      ...Object.entries({ title, description, type: 'website', url, site_name: 'tanteki', locale: 'ja_JP', image: `${url}og-image.png`, 'image:type': 'image/png', 'image:width': '1731', 'image:height': '909', 'image:alt': imageAlt })
        .map(([key, content]) => h('meta', { key: `og:${key}`, property: `og:${key}`, content })),
      ...Object.entries({ card: 'summary_large_image', title, description, image: `${url}og-image.png`, 'image:alt': imageAlt })
        .map(([key, content]) => h('meta', { key: `twitter:${key}`, name: `twitter:${key}`, content })),
      h('link', { rel: 'canonical', href: url }),
      h('title', null, title),
      h('link', { rel: 'icon', href: './favicon.svg', type: 'image/svg+xml' }),
      h('link', { rel: 'stylesheet', href: './styles.css' }),
      h('script', { src: './site.js', defer: true }),
      h('link', { rel: 'stylesheet', href: './mermaid-preview.css' }),
      h('script', { type: 'module', src: './mermaid-preview.js' })),
    h('body', null,
      h('a', { className: 'skip-link', href: '#main' }, '本文へ移動'),
      h('header', { className: 'site-header wrap' }, wordmark(),
        h('nav', { 'aria-label': 'メインナビゲーション' },
          h('a', { href: '#examples' }, '使用例'),
          h('a', { href: '#start' }, '使い方'),
          h('a', { className: 'github-link', href: 'https://github.com/iwasa-kosui/tanteki' }, 'GitHub ', h('span', { 'aria-hidden': true }, '↗')))),
      h('main', { id: 'main' }, children),
      h('footer', { className: 'site-footer wrap' }, wordmark(), h('p', null, footer),
        h('div', null, h('a', { href: 'https://github.com/iwasa-kosui/tanteki' }, 'GitHub ↗'), h('a', { href: 'https://github.com/iwasa-kosui/tanteki/blob/main/LICENSE' }, 'MIT License')))));
}

function Hero({ eyebrow, children }) {
  return h('section', { className: 'hero wrap', 'aria-labelledby': 'hero-title' },
    h('div', { className: 'hero-copy' },
      h('p', { className: 'eyebrow' }, h('span', { className: 'accent-dot', 'aria-hidden': true }), ` ${eyebrow}`),
      blocks(children).map((child) => child.type === 'h1' ? cloneElement(child, { id: 'hero-title' })
        : child.type === 'p' ? cloneElement(child, { className: 'hero-description' }) : child)));
}

function Section({ id, eyebrow, intro, children }) {
  const [heading, ...body] = blocks(children);
  const title = h('div', null, h('p', { className: 'eyebrow' }, eyebrow), cloneElement(heading, { id: `${id}-title` }));
  const content = [id === 'approach' ? title : h('div', { className: 'section-heading' }, title, intro && h('p', null, intro)), ...body];
  return h('section', { id, className: `${id}${id === 'start' ? '' : ' wrap'} section`, 'aria-labelledby': `${id}-title` },
    ...(id === 'start' ? [h('div', { className: 'wrap' }, ...content, h('p', { id: 'copy-status', className: 'copy-status', role: 'status', 'aria-live': 'polite' }))] : content));
}

function DocumentTable({ caption, children }) {
  const [table] = blocks(children);
  return cloneElement(table, null, h('caption', null, caption), table.props.children);
}

function CopyBlock({ id, label, children }) {
  const [pre] = blocks(children);
  const code = Children.only(pre.props.children);
  const install = id === 'install-command';
  return h('div', { className: 'step-content' },
    h('div', { className: 'code-toolbar' },
      install ? h('label', { htmlFor: 'agent', 'data-enhance': true, hidden: true }, '利用するエージェント') : h('span', null, label),
      install && h('select', { id: 'agent', 'data-enhance': true, hidden: true },
        ...[['', '対話画面で選ぶ'], ['claude-code', 'Claude Code'], ['codex', 'Codex'], ['cursor', 'Cursor']].map(([value, name]) => h('option', { key: value, value }, name))),
      h('button', { className: 'copy-button', type: 'button', 'data-copy': id, 'aria-label': `${install ? 'インストールコマンド' : '依頼文'}をコピー`, hidden: true }, 'コピー')),
    h('pre', { className: install ? undefined : 'prompt' }, cloneElement(code, { id }, String(code.props.children).replace(/\n$/, ''))),
    withClass(blocks(children).slice(1), 'step-caption'));
}

export const components = {
  Hero,
  Section,
  DocumentTable,
  CopyBlock,
  Actions: ({ children }) => h('div', { className: 'hero-actions' }, children),
  Link: ({ href, primary, children }) => h('a', { className: primary ? 'button primary' : 'text-link', href }, children),
  Note: ({ children }) => withClass(children, 'source-note'),
  Principles: ({ children }) => h('div', { className: 'principles' }, children),
  Principle: ({ number, children }) => h('article', null, h('span', { className: 'principle-number', 'aria-hidden': true }, number), children),
  Steps: ({ children }) => h('div', { className: 'steps' }, children),
  Step: ({ number, children }) => h('div', { className: 'step-intro' }, h('span', { className: 'step-number' }, number), children),
  Footnote: ({ children }) => withClass(children, 'start-footnote'),
  Evidence: ({ children }) => h('section', { id: 'evidence', className: 'evidence wrap section', 'aria-labelledby': 'evidence-title' }, children),
  EvidenceIntro: ({ children }) => h('div', null, h('p', { className: 'eyebrow' }, '05 / EVIDENCE'),
    blocks(children).map((child) => child.type === 'h2' ? cloneElement(child, { id: 'evidence-title' }) : child)),
  EvidenceSources: ({ children }) => h('div', { className: 'evidence-sources' }, children),
  Evaluation: ({ children }) => h('div', { className: 'evaluation' }, children),
  ResultsTable: ({ caption, label, children }) => h('table', null, h('caption', null, caption),
    h('thead', null, h('tr', null, ...[label, 'なし', 'あり'].map((label) => h('th', { key: label, scope: 'col' }, label)))), h('tbody', null, children)),
  th: (props) => h('th', { ...props, scope: 'col' }),
  tr: ({ children }) => h('tr', null, blocks(children).map((child, index) => index === 0 && child.type === 'td'
    ? h('th', { ...child.props, key: child.key, scope: 'row' }) : child)),
};
