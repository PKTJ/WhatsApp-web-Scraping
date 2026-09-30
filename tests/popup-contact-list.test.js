const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ContactList = require('../contact-list.js');

const source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');

// DOM kecil untuk menjalankan seluruh script panel beserta event-nya tanpa
// dependensi browser tambahan. Tata letak visual tetap perlu diuji di Chrome.
class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = new Map();
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.text = '';
    const classes = new Set();
    this.classList = {
      contains: (name) => classes.has(name),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name)
    };
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map((child) => child.textContent).join(''); }
  append(...children) {
    for (const child of children) { child.parentElement = this; this.children.push(child); }
  }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this.text = ''; this.children = []; this.append(...children); }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }
  async trigger(type) {
    for (const callback of this.listeners.get(type) || []) await callback({ target: this });
  }
  querySelectorAll(selector) {
    const matches = (child) => selector === 'input[type="checkbox"]'
      ? child.tag === 'input' && child.type === 'checkbox' : child.tag === selector;
    return this.children.flatMap((child) => [
      ...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() {}
}

async function setup(state = {}, scanResponse = { ok: true, chats: [] }) {
  const elements = {};
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const [, tag, attrs, id] = match;
    assert.equal(elements[id], undefined, `unique HTML ID: ${id}`);
    const element = elements[id] = new Element(tag);
    element.value = /\bvalue="([^"]*)"/.exec(attrs)?.[1] || '';
    element.type = /\btype="([^"]*)"/.exec(attrs)?.[1] || '';
    element.checked = /\bchecked\b/.test(attrs);
    element.hidden = /\bhidden\b/.test(attrs);
  }
  elements.contactMatchMode.value = 'smart';
  const fileRow = new Element('div');
  fileRow.append(new Element('label'), elements.contactFile);
  let timer = null;
  const saved = [];
  const context = vm.createContext({
    ContactList,
    document: {
      getElementById: (id) => elements[id] || null,
      createElement: (tag) => new Element(tag),
      addEventListener() {}
    },
    setTimeout: (callback) => { timer = callback; return 1; },
    clearTimeout: () => { timer = null; },
    chrome: {
      runtime: {
        sendMessage: async (message) => {
          if (message.type === 'LOAD_SESSION_STATE') return { state };
          if (message.type === 'SAVE_SESSION_STATE') saved.push(message.state);
          return { ok: true };
        },
        onMessage: { addListener() {} }
      },
      tabs: {
        query: async () => [{ id: 1, url: 'https://web.whatsapp.com/' }],
        sendMessage: async (_tabId, message) => message.type === 'SCAN_ALL_CHATS' ? scanResponse : { ok: true }
      }
    }
  });
  vm.runInContext(source, context);
  await new Promise(setImmediate);
  const selected = () => Array.from(context.getSelectedIds());
  const upload = async (text, name = 'contacts.csv') => {
    elements.contactFile.files = [{ name, size: Buffer.byteLength(text), text: async () => text }];
    await elements.contactFile.trigger('change');
  };
  return { context, elements, selected, upload, saved, flushSave: () => timer?.() };
}

test('panel upload applies smart matches, preserves manual choices and reports rows instead of chat count', async () => {
  const ui = await setup({ chats: [
    { id: 'one', name: 'Budi Santoso' }, { id: 'two', name: 'Kontak Manual' }
  ], selected_chat_ids: ['two'] });
  await ui.upload('chat_name\nBudi Santso\nBudi Santso\nTidak Ditemukan');
  assert.deepEqual(ui.selected(), ['two', 'one']);
  assert.match(ui.elements.contactFileStatus.textContent, /2 dari 3 baris kontak.*1 chat/);
  assert.match(ui.elements.contactFileStatus.textContent, /1 tidak ditemukan/);
  assert.equal(ui.elements.contactMatchDetails.hidden, false);
  assert.match(ui.elements.contactMatchResults.textContent, /Nama mirip \(92%\)/);
  assert.equal(ui.elements.contactFile.value, '');
  ui.flushSave();
  assert.equal(ui.saved.at(-1).imported_file_name, 'contacts.csv');
  assert.equal(ui.saved.at(-1).settings.contact_match_mode, 'smart');
});

test('ambiguous candidates can be selected manually and stay synchronized with chat checkboxes', async () => {
  const ui = await setup({ chats: [
    { id: 'one', name: 'Marketing Jakarta' }, { id: 'two', name: 'Marketing Bandung' }
  ] });
  await ui.upload('Marketing');
  assert.deepEqual(ui.selected(), []);
  assert.match(ui.elements.contactFileStatus.textContent, /1 perlu diperiksa/);
  const candidates = ui.elements.contactMatchResults.querySelectorAll('input[type="checkbox"]');
  assert.equal(candidates.length, 2);
  candidates[0].checked = true;
  await candidates[0].trigger('change');
  assert.deepEqual(ui.selected(), [candidates[0].value]);
  const chatCheckbox = ui.elements.chatList.querySelectorAll('input[type="checkbox"]')
    .find((checkbox) => checkbox.value === candidates[0].value);
  assert.equal(chatCheckbox.checked, true);
  chatCheckbox.checked = false;
  await chatCheckbox.trigger('change');
  assert.equal(candidates[0].checked, false);
  await ui.elements.invertCheckButton.trigger('click');
  assert.deepEqual(ui.selected(), ['one', 'two']);
  assert.ok(candidates.every((checkbox) => checkbox.checked));
});

test('file imported before scan is matched on scan and exact mode is applied on the next scan', async () => {
  const ui = await setup({}, { ok: true, chats: [{ id: 'one', name: 'Budi Santoso' }] });
  await ui.upload('Budi Santso');
  assert.match(ui.elements.contactFileStatus.textContent, /Klik Pindai/);
  assert.equal(ui.elements.contactMatchDetails.hidden, true);
  await ui.elements.scanButton.trigger('click');
  assert.deepEqual(ui.selected(), ['one']);
  ui.elements.contactMatchMode.value = 'exact';
  await ui.elements.contactMatchMode.trigger('change');
  assert.deepEqual(ui.selected(), ['one'], 'mode change must not silently reset manual selections');
  await ui.elements.scanButton.trigger('click');
  assert.deepEqual(ui.selected(), []);
  assert.match(ui.elements.contactFileStatus.textContent, /1 tidak ditemukan/);
  assert.equal(ui.elements.contactMatchMode.disabled, false);
});

test('restoring the panel keeps saved manual choices and the mode used by the last match report', async () => {
  const ui = await setup({
    chats: [{ id: 'one', name: 'Budi Santoso' }],
    imported_contacts: [{ name: 'Budi Santso' }], imported_file_name: 'previous.csv',
    imported_match_mode: 'smart', selected_chat_ids: [], settings: { contact_match_mode: 'exact' }
  });
  assert.deepEqual(ui.selected(), [], 'restoration must not auto-check a manually deselected match');
  assert.equal(ui.elements.contactMatchMode.value, 'exact');
  assert.match(ui.elements.contactFileStatus.textContent, /1 dari 1 baris kontak.*previous.csv/);
  assert.equal(ui.elements.contactMatchResults.querySelector('input[type="checkbox"]').checked, false);
  await ui.upload('Budi Santso');
  assert.deepEqual(ui.selected(), []);
  assert.match(ui.elements.contactFileStatus.textContent, /1 tidak ditemukan/);
});

test('matching controls are locked while busy and invalid uploads do not erase saved contacts', async () => {
  const ui = await setup({ chats: [{ id: 'one', name: 'Budi Santoso' }] });
  await ui.upload('Budi Santso');
  ui.context.setBusy(true);
  assert.equal(ui.elements.contactMatchMode.disabled, true);
  assert.equal(ui.elements.contactFile.disabled, true);
  assert.equal(ui.elements.contactMatchResults.querySelector('input[type="checkbox"]').disabled, true);
  await ui.upload('Other');
  assert.match(ui.elements.contactFileStatus.textContent, /Tunggu proses/);
  ui.context.setBusy(false);
  await ui.upload('"unclosed');
  assert.match(ui.elements.contactFileStatus.textContent, /tanda kutip/);
  assert.deepEqual(ui.selected(), ['one']);
  assert.equal(ui.context.collectSessionState().imported_contacts[0].name, 'Budi Santso');
});

test('failed rescan clears stale candidate controls and waits for another scan', async () => {
  const ui = await setup({ chats: [{ id: 'one', name: 'Budi Santoso' }] }, { ok: false, error: 'Scan gagal' });
  await ui.upload('Budi Santso');
  await ui.elements.scanButton.trigger('click');
  assert.deepEqual(ui.selected(), []);
  assert.equal(ui.elements.contactMatchDetails.hidden, true);
  assert.equal(ui.elements.contactMatchResults.children.length, 0);
  assert.match(ui.elements.contactFileStatus.textContent, /Klik Pindai/);
  assert.equal(ui.elements.status.textContent, 'Scan gagal');
});

test('matching details render names as text, including bracketed names and HTML-like content', async () => {
  const name = '[AB] <img src=x onerror=alert(1)>';
  const ui = await setup({ chats: [{ id: 'one', name }] });
  await ui.upload(name);
  assert.deepEqual(ui.selected(), ['one']);
  assert.ok(ui.elements.contactMatchResults.textContent.includes(name));
  assert.equal(ui.elements.contactMatchResults.querySelectorAll('img').length, 0);
});