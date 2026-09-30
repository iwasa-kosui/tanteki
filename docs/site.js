const tabs = [...document.querySelectorAll('[data-example-tab]')];
const panels = [...document.querySelectorAll('.example-panel')];
const tabList = document.querySelector('.example-tabs');

// All examples are visible without JavaScript; enhance them into keyboard tabs.
if (tabList) {
  tabList.hidden = false;
  tabList.setAttribute('role', 'tablist');
  function selectTab(selected, focus = false) {
    for (const [index, tab] of tabs.entries()) {
      const active = tab === selected;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      panels[index].hidden = !active;
    }
    if (focus) selected.focus();
  }
  for (const [index, tab] of tabs.entries()) {
    tab.setAttribute('role', 'tab');
    panels[index].setAttribute('role', 'tabpanel');
    panels[index].setAttribute('aria-labelledby', tab.id);
    panels[index].tabIndex = 0;
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', (event) => {
      let target;
      if (event.key === 'ArrowRight') target = tabs[(index + 1) % tabs.length];
      if (event.key === 'ArrowLeft') target = tabs[(index + tabs.length - 1) % tabs.length];
      if (event.key === 'Home') target = tabs[0];
      if (event.key === 'End') target = tabs.at(-1);
      if (target) { event.preventDefault(); selectTab(target, true); }
    });
  }
  selectTab(tabs[0]);
}

const agent = document.querySelector('#agent');
for (const element of document.querySelectorAll('[data-enhance]')) element.hidden = false;
agent?.addEventListener('change', () => {
  document.querySelector('#install-command').textContent =
    `gh skill install iwasa-kosui/tanteki tanteki --scope user${agent.value ? ` --agent ${agent.value}` : ''}`;
  document.querySelector('[data-copy="install-command"]').textContent = 'コピー';
});

for (const button of document.querySelectorAll('[data-copy]')) {
  button.hidden = false;
  button.addEventListener('click', async () => {
    const source = document.getElementById(button.dataset.copy);
    const status = document.querySelector('#copy-status');
    button.disabled = true;
    try {
      await navigator.clipboard.writeText(source.textContent);
      button.textContent = 'コピー済み';
      status.textContent = `${button.dataset.copy === 'prompt' ? '依頼文' : 'コマンド'}をコピーしました。`;
    } catch {
      const range = document.createRange();
      range.selectNodeContents(source);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      status.textContent = 'コピーできなかったため、文章を選択しました。端末のコピー操作を使ってください。';
    } finally {
      button.disabled = false;
    }
  });
}
