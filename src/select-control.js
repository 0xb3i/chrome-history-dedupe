// Shared Ant-style surface for the page's native select value models.
export function createSelectControl(select, { label }) {
  const document = select.ownerDocument;
  const wrapper = document.createElement('div');
  wrapper.className = 'select-combobox';
  wrapper.dataset.selectId = select.id;
  const button = document.createElement('button');
  button.className = 'select-combobox-button';
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  const value = document.createElement('span');
  value.className = 'select-combobox-value';
  const arrow = document.createElement('span');
  arrow.className = 'select-combobox-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  const menu = document.createElement('div');
  menu.className = 'select-combobox-menu';
  menu.id = `${select.id}-listbox`;
  menu.hidden = true;
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', label);
  button.setAttribute('aria-controls', menu.id);

  const options = [...select.options].map((nativeOption) => {
    const option = document.createElement('button');
    option.className = 'select-combobox-option';
    option.type = 'button';
    option.tabIndex = -1;
    option.textContent = nativeOption.textContent;
    option.dataset.value = nativeOption.value;
    option.setAttribute('role', 'option');
    option.addEventListener('click', () => {
      select.value = nativeOption.value;
      select.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
      close();
      button.focus();
    });
    option.addEventListener('keydown', (event) => {
      const index = options.indexOf(option);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        options[Math.max(0, Math.min(options.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        options[event.key === 'Home' ? 0 : options.length - 1]?.focus();
      }
    });
    menu.append(option);
    return option;
  });

  function sync() {
    value.textContent = [...select.options].find((option) => option.value === select.value)?.textContent ?? '';
    button.title = value.textContent;
    button.setAttribute('aria-label', `${label}：${value.textContent}`);
    for (const option of options) option.setAttribute('aria-selected', String(option.dataset.value === select.value));
  }

  function close() {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }

  function open() {
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
  }

  button.addEventListener('click', () => menu.hidden ? open() : close());
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    open();
    (options.find((option) => option.dataset.value === select.value) ?? options[0])?.focus();
  });
  wrapper.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) {
      event.preventDefault();
      event.stopPropagation();
      close();
      button.focus();
    }
  });
  // There are only two controls, both owned by the page for its full lifetime.
  for (const type of ['click', 'focusin']) document.addEventListener(type, (event) => {
    if (!wrapper.contains(event.target)) close();
  });
  select.addEventListener('change', sync);
  select.classList.add('native-select-hidden');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  button.append(value, arrow);
  wrapper.append(button, menu);
  select.insertAdjacentElement('afterend', wrapper);
  sync();
  return { sync };
}
