const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { webcrypto } = require('node:crypto');
const ContactList = require('../contact-list.js');

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
class Element {
  constructor(order = 0, parent = null) {
    this.order = order;
    this.parent = parent;
    this.rect = { left: order * 100, top: 0, width: 100, height: 100 };
    this.attrs = {};
    this.background = 'none';
    // Default agar scoring kartu quote bisa membaca struktur tanpa error.
    this.tagName = 'DIV';
    this.textContent = '';
  }
  getAttribute(key) { return this.attrs[key] || null; }
  getBoundingClientRect() { return this.rect; }
  // excludedMatch membuat closest() peka terhadap isi selector, sehingga test
  // benar-benar memverifikasi penanda yang dipakai content.js.
  closest(selector = '') {
    if (!this.excluded) return null;
    if (this.excludedMatch) return selector.includes(this.excludedMatch) ? this.excluded : null;
    return this.excluded;
  }
  contains(other) {
    // Telusuri rantai parent secara transitif, seperti Node.contains() asli.
    for (let node = other; node; node = node.parent) {
      if (node === this) return true;
    }
    return false;
  }
  compareDocumentPosition(other) { return other.order > this.order ? 4 : 2; }
  querySelectorAll(selector) {
    if (this.nodes?.[selector]) return this.nodes[selector];
    // Selector komposit (".selectable-text, span[dir], img"): cocokkan SETIAP
    // bagian yang dipisah koma terhadap kunci yang terdaftar, lalu gabungkan —
    // meniru perilaku DOM asli. Tanpa ini, penanda kartu quote tidak pernah
    // menemukan bukti di dalam mock.
    const parts = String(selector).split(',').map((part) => part.trim()).filter(Boolean);
    if (parts.length > 1) {
      const merged = [];
      for (const part of parts) {
        for (const el of this.querySelectorAll(part)) {
          if (!merged.includes(el)) merged.push(el);
        }
      }
      if (merged.length) return merged;
    }
    // Selector gabungan (mis. daftar penanda dokumen) dicocokkan per bagian
    // supaya test cukup mendaftarkan satu penanda saja.
    for (const key of Object.keys(this.nodes || {})) {
      if (key.length > 2 && selector.includes(key)) return this.nodes[key];
    }
    // Selector tag sederhana (img / canvas / video): cocokkan berdasarkan
    // instance yang terdaftar pada key mana pun.
    const tagSel = String(selector).trim().toLowerCase();
    if (tagSel === 'img' || tagSel === 'canvas' || tagSel === 'img, canvas' || tagSel === 'video') {
      const hits = [];
      for (const list of Object.values(this.nodes || {})) {
        for (const el of list) {
          const isImg = el instanceof Image || el instanceof Canvas;
          const tag = String(el?.tagName || '').toUpperCase();
          if (tagSel === 'video' ? tag === 'VIDEO' : isImg) {
            if (!hits.includes(el)) hits.push(el);
          }
        }
      }
      if (hits.length) return hits;
    }
    // Selector atribut ([aria-label], [title], [data-icon]): pindai elemen
    // yang terdaftar pada key lain dan cocokkan atributnya — meniru DOM asli
    // di mana query atribut menjangkau semua descendant.
    if (/\[[a-z-]+[\]*=]/i.test(selector)) {
      const wanted = ['aria-label', 'title', 'data-icon', 'download', 'data-testid', 'href', 'alt'];
      const hits = [];
      for (const list of Object.values(this.nodes || {})) {
        for (const el of list) {
          if (!el?.attrs) continue;
          if (wanted.some((attr) => selector.includes(`[${attr}`) && el.attrs[attr] != null)) {
            if (!hits.includes(el)) hits.push(el);
          }
        }
      }
      if (hits.length) return hits;
    }
    return [];
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
class Image extends Element {
  constructor(order = 0, parent = null) {
    super(order, parent);
    this.tagName = 'IMG';
  }
}
class Canvas extends Element {
  constructor(order = 0, parent = null) {
    super(order, parent);
    this.tagName = 'CANVAS';
  }
}
function setup(extraNames = []) {
  const context = vm.createContext({
    Blob, crypto: webcrypto, anonymousMediaIds: new WeakMap(), ContactList,
    normalizeImageMime: () => 'image/png', imageExtensionForMime: () => 'png',
    sanitizePathSegment: (value) => value,
    // Tidak ada permintaan STOP dalam skenario unit test.
    isStopRequested: () => false,
    HTMLElement: Element, HTMLImageElement: Image, HTMLCanvasElement: Canvas,
    cleanText: (value) => String(value || '').trim(), isVisible: () => true,
    getComputedStyle: (element) => ({ backgroundImage: element.background }),
    // Baca aria-label/title/alt dari node uji agar deteksi stiker, voice note,
    // dan GIF benar-benar terverifikasi (bukan selalu string kosong).
    collectSemanticLabels: (root) => [
      root?.attrs?.['aria-label'], root?.attrs?.title, root?.attrs?.alt
    ].filter(Boolean).join(' '),
    findMessageBubble: (node) => node,
    parsePrePlainText: () => ({ sender: 'A' }), detectDirection: () => 'incoming',
    extractNativeMessageId: () => 'message-1', simpleHash: () => 'hash',
    // Stub: penanda metadata sidebar tidak relevan untuk skenario unit test.
    isLikelySidebarMetadata: () => false,
    normalizeComparable: (value) => String(value || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ')
  });
  const names = ['parseMessageNode', 'buildInitialMediaMetadata', 'buildImageCandidate',
    'extractBackgroundImageUrl', 'findMessageImages', 'imageArea', 'detectMessageType',
    'extractMessageText', 'isQuotedOrLinkPreview', 'extractMessageUrls', 'hasLinkPreview',
    'detectMedia', 'registerImageCandidate', 'imageCandidateSignature',
    'hasDocumentAttachment', 'hasVideoSurface', 'isLikelyTimestampOrNameOnly',
    'isQuoteStamp', 'quoteEvidenceSelector', 'quoteContainerEvidenceScore', 'isRealQuoteContainer',
    'extractReplyPreview', 'extractReplySender', 'extractQuotedMessageId', 'isQuotedOrLinkPreview',
    'downloadImageCapture', 'captureImageSmart', 'buildExportZipBundle', 'canAttemptImageState',
    'buildChatJsonFilename', 'buildChatJsonPayload', 'buildExportSummaryJson', 'sanitizeChatForJson',
    'findRenderedMessageRoots', 'collectRenderedMessages', 'imageCandidateScore',
    'resolveReplySequences', 'findReplyTargetByPreview', 'isGenericMediaReplyPreview',
    'replySenderMatches', 'normalizeReplyComparable', 'replyPreviewMatchesMessage',
    'replyPreviewMatchesMediaType'];
  for (const name of [...names, ...extraNames]) {
    let start = source.indexOf(`  function ${name}(`);
    if (start < 0) start = source.indexOf(`  async function ${name}(`);
    assert.notEqual(start, -1, name);
    const closing = /^  }\r?$/m.exec(source.slice(start));
    assert.ok(closing, `${name} closing brace`);
    const end = start + closing.index + closing[0].length;
    vm.runInContext(source.slice(start, end), context);
  }
  return context;
}
function bubble(images = [], text = null) {
  const root = new Element();
  root.nodes = { 'img, canvas': images, '.selectable-text': text ? [{ innerText: text, closest: () => null }] : [] };
  return root;
}

// Bubble yang berisi BEBERAPA blok .selectable-text (pesan panjang / quote).
// blocks: array of { text, quoted } — quoted=true membungkus blok dalam
// kontainer quoted sehingga isQuotedOrLinkPreview() mengenalinya.
function multiBlockBubble(blocks, images = []) {
  const root = new Element();
  root.nodes = { 'img, canvas': images };
  const selectable = [];
  const quoteContainer = new Element(0, root);
  quoteContainer.attrs.class = 'quoted-mention';
  const quotedElements = [];
  const spans = [];
  for (const block of blocks) {
    const el = new Element(0, root);
    el.innerText = block.text;
    if (block.quoted) {
      // closest() mengembalikan kontainer quoted untuk elemen ini.
      el.excluded = quoteContainer;
      el.excludedMatch = 'quoted-mention';
      el.parent = quoteContainer;
      quotedElements.push(el);
      // Kartu quote WhatsApp menampilkan NAMA pengirim yang dikutip sebagai
      // elemen kecil di atas preview, di dalam kontainer quote yang sama.
      const nameEl = new Element(0, quoteContainer);
      nameEl.innerText = block.sender || 'Pusdalyan A';
      spans.push(nameEl);
    } else {
      el.closest = () => null;
    }
    selectable.push(el);
  }
  // Bukti isi kartu quote (dipakai isRealQuoteContainer untuk validasi) dan
  // kandidat nama pengirim di dalamnya (dipakai extractReplySender).
  quoteContainer.nodes = { '.selectable-text': quotedElements, 'span, div': spans };
  root.nodes['.selectable-text'] = selectable;
  // Daftarkan kontainer quoted agar extractReplySender dapat menemukannya.
  root.nodes['[class*="quoted"], blockquote, [data-testid*="quoted"]'] =
    blocks.some((b) => b.quoted) ? [quoteContainer] : [];
  root.nodes['span, div'] = selectable.concat(spans);
  return root;
}

// Mensimulasikan DOM WhatsApp sungguhan yang "kotor": bubble pesan biasa
// kebetulan memiliki elemen DENGAN class mengandung kata "quoted" (komponen
// UI/CSS-in-JS lain, BUKAN kartu balasan) dan aria-label status pengiriman
// ("Dikirim") pada ikon centang. Tanpa guard struktural, kedua artefak ini
// membuat pesan panjang dihapus dari teks dan/atau dianggap reply palsu.
function addStrayQuotedElement(root, selectable) {
  const stray = new Element(0, root);
  stray.attrs.class = 'x1quoted0f9k btn';
  root.nodes['[class*="quoted"], blockquote, [data-testid*="quoted"]'] = [stray];
  for (const el of selectable) {
    // closest() mengembalikan elemen liar ini untuk SEMUA blok pesan.
    el.excluded = stray;
    el.excludedMatch = 'quoted';
  }
  return stray;
}

test('single photo without caption remains an image', () => {
  const message = setup().parseMessageNode(bubble([new Image()]), 0);
  assert.equal(message.type, 'img');
  assert.equal(message.text, null);
  assert.equal(message._image_candidates.length, 1);
});

test('album registers every tile in DOM order, independent of resolution', () => {
  const api = setup();
  const images = [new Image(0), new Image(1), new Canvas(2)];
  images[1].naturalWidth = 2000;
  images[1].naturalHeight = 2000;
  const message = api.parseMessageNode(bubble(images, 'Album'), 0);
  assert.equal(message._image_candidates.length, 3);
  assert.equal(message._image_candidates[0].element, images[0]);
  const states = new Map();
  api.registerImageCandidate({}, message, { exportImages: true }, states);
  assert.equal(states.size, 3);
  assert.equal(states.get('message-1::image-3').candidate.element, images[2]);
});

test('background fallback of same tile is not exported twice', () => {
  const api = setup();
  const background = new Element();
  background.background = 'url("blob:photo")';
  const image = new Image(0, background);
  const root = bubble([image]);
  root.nodes['div, span'] = [background];
  assert.equal(api.findMessageImages(root).length, 1);
});

test('captioned video yields text and no media or image candidates', () => {
  const root = bubble([new Image()], 'Caption video');
  root.nodes.video = [new Element()];
  const message = setup().parseMessageNode(root, 0);
  assert.equal(message.type, 'text');
  assert.equal(message.text, 'Caption video');
  assert.equal(message.media, null);
  assert.equal(message._image_candidates.length, 0);
});

test('video duration is not used as a caption', () => {
  const root = bubble([new Image()]);
  root.nodes.video = [new Element()];
  root.nodes['span[dir], div[dir]'] = [{ innerText: '00:42' }];
  // Video tanpa caption berada di luar lingkup ekspor.
  assert.equal(setup().parseMessageNode(root, 0), null);
});

test('link preview yields only URL, never title or thumbnail', () => {
  const link = new Element();
  link.attrs.href = 'https://example.com/article';
  const thumbnail = new Image(0, link);
  thumbnail.excluded = link;
  link.nodes = { 'img, canvas': [thumbnail] };
  const root = bubble([thumbnail], 'Judul preview');
  link.parent = root;
  root.nodes['a[href]'] = [link];
  const message = setup().parseMessageNode(root, 0);
  // Caption asli tetap diekspor sebagai teks; thumbnail tidak ikut.
  assert.equal(message.type, 'text');
  assert.equal(message.text, 'Judul preview');
  assert.equal(message.media, null);
  assert.equal(message._image_candidates.length, 0);
});

test('photo with URL caption is still a photo', () => {
  const root = bubble([new Image()], 'https://example.com');
  const link = new Element();
  link.attrs.href = 'https://example.com';
  root.nodes['a[href]'] = [link];
  assert.equal(setup().parseMessageNode(root, 0).type, 'img');
});

test('identical bytes across chats share one stored file; distinct bytes remain distinct', async () => {
  const api = setup();
  const options = { exportRoot: 'export' };
  const save = (chatName, bytes) => api.downloadImageCapture({
    chatName, messageId: chatName, options,
    capture: { blob: new Blob([bytes], { type: 'image/png' }), width: 100, height: 100 }
  });
  const [first, duplicate, other] = await Promise.all([
    save('A', 'photo-one'), save('B', 'photo-one'), save('A', 'photo-two')
  ]);
  assert.equal(first.relative_path, duplicate.relative_path);
  assert.equal(first.unique_key.length, 64);
  assert.notEqual(first.relative_path, other.relative_path);
  assert.equal(options.mediaDatabase.files.size, 2);
  const fresh = await api.downloadImageCapture({ chatName: 'A', options: {}, capture: {
    blob: new Blob(['photo-one']), width: 100, height: 100
  } });
  assert.equal(fresh.bytes, first.bytes);
});

test('unit registry coalesces concurrent and repeated capture calls', async () => {
  const api = setup();
  let calls = 0;
  api.captureImageUnit = async () => { calls += 1; return { saved: true }; };
  const args = { chatName: 'A', messageId: 'album::image-1', options: {} };
  const [first, second] = await Promise.all([api.captureImageSmart(args), api.captureImageSmart(args)]);
  assert.equal(first, second);
  await api.captureImageSmart(args);
  assert.equal(calls, 1);
  await api.captureImageSmart({ ...args, messageId: 'album::image-2' });
  assert.equal(calls, 2);
});

test('failed capture can retry; successfully exported low-quality state cannot', async () => {
  const api = setup();
  const args = { chatName: 'A', messageId: 'image-1', options: {} };
  api.captureImageUnit = async () => { throw new Error('unavailable'); };
  await assert.rejects(api.captureImageSmart(args), /unavailable/);
  assert.equal(args.options.mediaDatabase.units.size, 0);
  api.captureImageUnit = async () => ({ saved: true });
  assert.equal((await api.captureImageSmart(args)).saved, true);
  assert.equal(api.canAttemptImageState({ candidate: {}, status: 'exported', quality: 'low', attempts: 1 },
    { maxImageAttempts: 3 }), false);
});

test('ZIP contains one entry for shared image path', async () => {
  const api = setup();
  api.createZipBlob = (files) => files;
  const image = { relative_path: 'img/A/hash.png', blob: new Blob(['photo']) };
  const { blob: files, jsonFiles } = await api.buildExportZipBundle({ exportRoot: 'export', payload: {},
    exportedChats: [{ image_files: [image, image] }, { image_files: [image] }] });
  // Dua file JSON per chat + export-summary.json + CSV + satu gambar bersama.
  assert.equal(files.length, 5);
  assert.equal(jsonFiles.length, 2);
  assert.equal(files.filter((file) => file.path.endsWith('.png')).length, 1);
});

test('every scraped chat becomes its own JSON file inside messages/', async () => {
  const api = setup();
  api.createZipBlob = (files) => files;
  const payload = { schema_version: '1.9.2', export_summary: { per_chat: [] }, errors: [],
    output: { directory: 'export' } };
  const exportedChats = [
    { chat_id: 'c1', chat_name: 'Grup A', message_count: 2, messages: [{ id: 'a1' }, { id: 'a2' }],
      image_files: [{ relative_path: 'img/A/hash.png', blob: new Blob(['photo']) }] },
    { chat_id: 'c2', chat_name: 'Budi', message_count: 1, messages: [{ id: 'b1' }], image_files: [] },
    // Nama identik di Community berbeda tidak boleh saling menimpa.
    { chat_id: 'c3', chat_name: 'Grup A', community_name: 'Kampus', message_count: 1,
      messages: [{ id: 'c1' }], image_files: [] }
  ];
  const { blob: files, jsonFiles } = await api.buildExportZipBundle({
    exportRoot: 'export', payload, exportedChats });

  assert.equal(jsonFiles.length, 3);
  const messageFiles = files.filter((file) => file.path.startsWith('export/messages/'));
  assert.equal(messageFiles.length, 3);
  assert.equal(new Set(messageFiles.map((file) => file.path)).size, 3);
  assert.ok(messageFiles.every((file) => file.path.endsWith('.json')));
  // Ringkasan gabungan berada di akar arsip, bukan di dalam messages/.
  assert.ok(files.some((file) => file.path === 'export/export-summary.json'));
  assert.equal(files.length, 6);
  const csv = files.find((file) => file.path === 'export/exported-contacts.csv');
  assert.ok(csv);
  assert.deepEqual(ContactList.contactsFromRows(ContactList.parseCsv(csv.data)).map((entry) => entry.name),
    ['Grup A', 'Budi', 'Grup A']);

  const first = JSON.parse(messageFiles[0].data);
  assert.equal(first.chat.chat_name, 'Grup A');
  assert.equal(first.chat.messages.length, 2);
  assert.equal(first.schema_version, '1.9.2');
  assert.equal(first.output.json_file, jsonFiles[0].relative_path);
  // Payload per chat tidak membawa daftar chat lain maupun ringkasan global.
  assert.equal(first.chats, undefined);
  assert.equal(first.export_summary, undefined);
  // Blob gambar dibuang agar JSON tidak memuat objek kosong.
  assert.equal(first.chat.image_files[0].blob, undefined);
  assert.equal(first.chat.image_files[0].relative_path, 'img/A/hash.png');

  const summary = JSON.parse(files.find((file) => file.path === 'export/export-summary.json').data);
  assert.equal(summary.chat_files.length, 3);
  assert.deepEqual(summary.chat_files.map((file) => file.chat_id), ['c1', 'c2', 'c3']);
  assert.equal(summary.chat_files[0].message_count, 2);
});

function messageList(roots) {
  return { querySelectorAll: (selector) => selector.includes('.message-in') ? roots : [] };
}

test('collector discovers photo without any pre-plain-text or caption node', () => {
  const api = setup();
  const root = bubble([new Image()]);
  const messages = api.collectRenderedMessages(messageList([root]), 0);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'img');
  assert.equal(messages[0].text, null);
  assert.equal(messages[0]._image_candidates.length, 1);
});

test('collector discovers captionless album once despite nested message nodes', () => {
  const api = setup();
  const root = bubble([new Image(0), new Image(1), new Image(2)]);
  const nested = new Element(0, root);
  const messages = api.collectRenderedMessages(messageList([root, root, nested]), 0);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, null);
  assert.equal(messages[0]._image_candidates.length, 3);
});

test('overlapping sibling layers of one photo produce only one image candidate', () => {
  const api = setup();
  const preview = new Canvas(0);
  const photo = new Image(0);
  photo.naturalWidth = 1600;
  photo.naturalHeight = 1600;
  const separateTile = new Image(1);
  const images = api.findMessageImages(bubble([preview, photo, separateTile]));
  assert.equal(images.length, 2);
  assert.ok(images.includes(photo));
  assert.ok(images.includes(separateTile));
});

test('captionless photo does not use bubble timestamp as caption', () => {
  const root = bubble([new Image()]);
  root.nodes['span[dir], div[dir]'] = [{ innerText: '12:45' }];
  const message = setup().parseMessageNode(root, 0);
  assert.equal(message.type, 'img');
  assert.equal(message.text, null);
  const states = new Map();
  setup().registerImageCandidate({}, message, { exportImages: true }, states);
  assert.equal(states.size, 1);
  assert.equal(states.get('message-1::image-1').status, 'detected');
});

test('real bubble resolver keeps distinct captionless message roots', () => {
  const api = setup(['findMessageBubble']);
  const incoming = bubble([new Image()]);
  const outgoing = bubble([new Image()]);
  for (const root of [incoming, outgoing]) {
    root.closest = (selector) => selector === '.message-in, .message-out' ? root : null;
  }
  const metadata = new Element(0, incoming);
  metadata.closest = incoming.closest;
  const messages = api.collectRenderedMessages(messageList([incoming, metadata, outgoing]), 0);
  assert.equal(messages.length, 2);
  assert.ok(messages.every((message) => message.type === 'img' && message.text === null));
});

test('real bubble resolver discovers image via native ID without text metadata', () => {
  const api = setup(['findMessageBubble']);
  const root = bubble([new Image()]);
  root.closest = (selector) => selector.includes('[data-id]') ? root : null;
  const messages = api.collectRenderedMessages(messageList([root]), 0);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]._image_candidates.length, 1);
});

test('two anonymous captionless photos keep separate IDs and both reach ZIP files', async () => {
  const api = setup(['processPendingImageCaptures']);
  api.extractNativeMessageId = () => null;
  const roots = [bubble([new Image()]), bubble([new Image()])];
  const main = messageList(roots);
  const first = api.collectRenderedMessages(main, 0);
  const repeated = api.collectRenderedMessages(main, 2);
  assert.notEqual(first[0].id, first[1].id);
  assert.equal(first[0].id, repeated[0].id);
  assert.equal(first[1].id, repeated[1].id);
  const states = new Map();
  const options = { exportImages: true, maxImageAttempts: 3, exportRoot: 'export' };
  const collect = () => {
    for (const message of api.collectRenderedMessages(main, 0)) {
      api.registerImageCandidate({}, message, options, states);
    }
  };
  collect();
  api.waitForMessageScroller = async () => null;
  api.normalizeError = (error) => error.message;
  // Browser image decoding is mocked; queue, file hashing and ZIP entry selection are real.
  let captures = 0;
  api.captureImageUnit = async (args) => {
    captures += 1;
    return api.downloadImageCapture({ ...args, capture: {
      blob: new Blob([`photo-${captures}`], { type: 'image/png' }), width: 100, height: 100
    } });
  };
  await api.processPendingImageCaptures({ entry: { name: 'Chat' }, main,
    scroller: null, options, imageStates: states, collect });
  assert.equal(captures, 2);
  const files = [...states.values()];
  assert.ok(files.every((state) => state.status === 'exported' && state.blob));
  assert.ok(files.every((state) => state.relative_path.startsWith('img/')));
  assert.notEqual(files[0].relative_path, files[1].relative_path);
  api.createZipBlob = (entries) => entries;
  const { blob: entries } = await api.buildExportZipBundle({ exportRoot: 'export', payload: {},
    exportedChats: [{ image_files: files }] });
  // Satu JSON chat + ringkasan + CSV + dua gambar berbeda.
  assert.equal(entries.length, 5);
});

test('media-only rows without standard classes or caption metadata are discovered', () => {
  const api = setup(['findMessageBubble']);
  api.extractNativeMessageId = () => null;
  const rows = [bubble([new Image()]), bubble([new Image()])];
  for (const row of rows) {
    row.closest = (selector) => selector === '[role="row"]' ? row : null;
  }
  const main = { querySelectorAll: (selector) => selector === '[role="row"]' ? rows : [] };
  const messages = api.collectRenderedMessages(main, 0);
  assert.equal(messages.length, 2);
  assert.ok(messages.every((message) => message.type === 'img' && message.text === null));
  assert.notEqual(messages[0].id, messages[1].id);
});

test('row fallback does not merge existing independent message roots', () => {
  const api = setup();
  api.extractNativeMessageId = () => null;
  const row = bubble([new Image(), new Image(1)]);
  const roots = [bubble([new Image()]), bubble([new Image(1)])];
  roots.forEach((root) => { root.parent = row; });
  const main = { querySelectorAll: (selector) => selector === '[role="row"]' ? [row] : roots };
  const messages = api.collectRenderedMessages(main, 0);
  assert.equal(messages.length, 2);
  assert.notEqual(messages[0].id, messages[1].id);
});

// --- Pengecualian thumbnail: dokumen, balasan, tautan, video ---

test('PDF page preview is a document, never an exported image', () => {
  const api = setup();
  const preview = new Image();
  const root = bubble([preview]);
  root.innerText = 'Laporan-Tahunan.pdf 12 halaman 2,4 MB';
  // Dokumen tanpa caption dilewati sepenuhnya.
  assert.equal(api.parseMessageNode(root, 0), null);
  // Dengan caption, hanya teksnya yang diekspor.
  const captioned = bubble([new Image()], 'Silakan dibaca');
  captioned.innerText = 'Laporan-Tahunan.pdf 12 halaman 2,4 MB';
  const message = api.parseMessageNode(captioned, 0);
  assert.equal(message.type, 'text');
  assert.equal(message.text, 'Silakan dibaca');
  assert.equal(message._image_candidates.length, 0);
});

test('document card detected by download attribute alone', () => {
  const api = setup();
  const root = bubble([new Image()]);
  root.nodes['[download]'] = [new Element()];
  assert.equal(api.hasDocumentAttachment(root), true);
  assert.equal(api.parseMessageNode(root, 0), null);
});

test('page-count and file-size wording alone marks a document card', () => {
  const api = setup();
  const pages = bubble([new Image()]);
  pages.innerText = '3 pages';
  assert.equal(api.hasDocumentAttachment(pages), true);
  const size = bubble([new Image()]);
  size.innerText = '850 KB';
  assert.equal(api.hasDocumentAttachment(size), true);
  assert.equal(api.hasDocumentAttachment(bubble([new Image()])), false);
});

test('quoted reply thumbnail is skipped without any data-testid', () => {
  const api = setup();
  const quoted = new Element();
  quoted.attrs.class = 'quoted-mention';
  const thumbnail = new Image(0, quoted);
  thumbnail.excluded = quoted;
  // Hanya cocok bila content.js benar-benar menyertakan penanda quoted-mention.
  thumbnail.excludedMatch = 'quoted-mention';
  // Kartu quote nyata berisi thumbnail gambar sebagai bukti strukturalnya.
  quoted.nodes = { 'img, canvas': [thumbnail] };
  const root = bubble([thumbnail]);
  quoted.parent = root;
  assert.equal(api.isQuotedOrLinkPreview(thumbnail, root), true);
  assert.equal(api.findMessageImages(root).length, 0);
});

test('real photo beside a link preview is still exported', () => {
  const api = setup();
  const link = new Element();
  link.attrs.href = 'https://example.com/article';
  const thumbnail = new Image(0, link);
  thumbnail.excluded = link;
  link.nodes = { 'img, canvas': [thumbnail] };
  const photo = new Image(1);
  const root = bubble([thumbnail, photo], 'https://example.com/article');
  link.parent = root;
  root.nodes['a[href]'] = [link];
  const message = api.parseMessageNode(root, 0);
  assert.equal(message.type, 'img');
  assert.equal(message._image_candidates.length, 1);
  assert.equal(message._image_candidates[0].element, photo);
});

test('video poster is skipped even when only a play icon is present', () => {
  const api = setup();
  const root = bubble([new Image()]);
  root.nodes['[data-icon*="play"]'] = [new Element()];
  assert.equal(api.hasVideoSurface(root), true);
  // Tanpa caption, video tidak menghasilkan record apa pun.
  assert.equal(api.parseMessageNode(root, 0), null);
});

test('images labelled as thumbnail or document are never candidates', () => {
  const api = setup();
  for (const label of ['Thumbnail', 'Pratinjau dokumen', 'PDF preview']) {
    const tagged = new Image();
    tagged.attrs.alt = label;
    assert.equal(api.findMessageImages(bubble([tagged])).length, 0, label);
  }
  const photo = new Image();
  photo.attrs.alt = 'Foto dari Budi';
  assert.equal(api.findMessageImages(bubble([photo])).length, 1);
});

// --- Lingkup ekspor: hanya teks dan gambar ---

test('sticker timestamp is never captured as text (regression)', () => {
  const api = setup();
  const root = bubble([new Image()]);
  root.attrs['aria-label'] = 'Sticker';
  // Jam pesan hidup di span[dir]; dulu fallback ini memungut "22:47".
  root.nodes['span[dir], div[dir]'] = [{ innerText: '22:47' }];
  assert.equal(api.parseMessageNode(root, 0), null);
});

test('clock-like text is not captured for any skipped media', () => {
  const api = setup();
  const surfaces = [
    ['Sticker', {}],
    ['Voice message', {}],
    ['GIF', {}],
    ['Document', {}]
  ];
  for (const [label, extra] of surfaces) {
    const root = bubble([new Image()]);
    root.attrs['aria-label'] = label;
    root.nodes['span[dir], div[dir]'] = [{ innerText: '10:01' }];
    Object.assign(root.nodes, extra);
    assert.equal(api.parseMessageNode(root, 0), null, label);
  }
});

test('skipped media keeps its real caption as plain text', () => {
  const api = setup();
  const root = bubble([new Image()], 'Lihat stiker ini');
  root.attrs['aria-label'] = 'Sticker';
  root.nodes['span[dir], div[dir]'] = [{ innerText: '22:47' }];
  const message = api.parseMessageNode(root, 0);
  assert.equal(message.type, 'text');
  assert.equal(message.text, 'Lihat stiker ini');
  assert.equal(message.media, null);
  assert.equal(message._image_candidates.length, 0);
});

test('only "img" and "text" types are ever produced', () => {
  const api = setup();
  const photo = api.parseMessageNode(bubble([new Image()]), 0);
  assert.equal(photo.type, 'img');
  const captioned = api.parseMessageNode(bubble([new Image()], 'Halo'), 0);
  assert.equal(captioned.type, 'img');
  assert.equal(captioned.text, 'Halo');
  const plain = api.parseMessageNode(bubble([], 'Pesan biasa'), 0);
  assert.equal(plain.type, 'text');
});

// --- Regresi: pesan panjang multi-blok tidak boleh dipecah / reply palsu ---

// Pesan lapangan yang sangat panjang + penuh kombinasi teks unik WhatsApp:
// baris penanda format (*bold*, _italic_, ~strike~, ```mono```), baris quote
// ("> "), bullet, unicode font aneh, emoji + ZWJ, dan stempel ====.
// Dibaca dari fixture realistis (satu blok tunggal, persis render WhatsApp).
const STRESS_TEXT = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'stress-message.txt'), 'utf8'
).replace(/\r\n/g, '\n').replace(/\n$/, '');

function stressBubble() {
  const api = setup();
  const root = multiBlockBubble([{ text: STRESS_TEXT }]);
  // Simulasi DOM kotor: class "quoted" nyasar + ikon centang "Dikirim".
  addStrayQuotedElement(root, root.nodes['.selectable-text']);
  const tick = new Element(0, root);
  tick.attrs['aria-label'] = ' Dikirim ';
  root.nodes['[aria-label], [title]'] = [tick];
  return { api, root };
}

test('ultra long formatted message is one whole text and never a self-reply', () => {
  const { api, root } = stressBubble();
  const message = api.parseMessageNode(root, 0);
  assert.ok(message, 'pesan tidak boleh hilang dari daftar (sequence tidak boleh lompat)');
  assert.equal(message.type, 'text');
  // SELURUH pesan masuk ke "text" utuh, karakter demi karakter.
  assert.equal(message.text, STRESS_TEXT);
  // Pesan ini berdiri sendiri: BUKAN reply terhadap apa pun.
  assert.equal(message.reply_to, null);
});

test('long formatted message also survives being split into several blocks', () => {
  const { api } = stressBubble();
  // WhatsApp terkadang merender pesan yang sama sebagai beberapa blok.
  const blocks = [
    { text: 'Informasi Pusdalyan\n2 Oktober 2026 03:11\n*PENUMPANG MELEBIHI RELASI*\n========================' },
    { text: 'Terima Informasi: 02/10/2026 02:54\nKonduktor KA 274 Kahuripan\nNama : Fajar\nNIPP : 75790' },
    { text: '_Isi Informasi:_\n\u2022 Kedapatan 1 penumpang melebihi relasi dengan sengaja seharusnya turun BJR' },
    { text: '*Pusdalyan Proaktif, Responsif, dan Solutif*\n*Semakin Melayani*' }
  ];
  const root = multiBlockBubble(blocks);
  addStrayQuotedElement(root, root.nodes['.selectable-text']);
  const tick = new Element(0, root);
  tick.attrs['aria-label'] = 'Dikirim';
  root.nodes['[aria-label], [title]'] = [tick];
  const message = api.parseMessageNode(root, 0);
  assert.ok(message);
  assert.equal(message.text, blocks.map((b) => b.text).join('\n'));
  assert.equal(message.reply_to, null);
});

test('long multi-block message is kept whole and never becomes its own reply', () => {
  const api = setup();
  const report = multiBlockBubble([
    { text: 'NO. KA : 69\nNAMA KA : BANJAR\nRELASI : ML-BD\nKDR : BANYU BIRU\nNIPP : 75283\nLINTAS : BJR-BD' },
    { text: 'Melaporkan :' },
    { text: 'Mohon dibantu porter untuk bawa barang saat akan tiba di sta Akhir ( Bd ) utk PNP WNA china di Eksa 4/7D' }
  ]);
  const message = api.parseMessageNode(report, 0);
  assert.equal(message.type, 'text');
  // Seluruh blok pesan tergabung menjadi SATU teks utuh.
  assert.equal(message.text,
    'NO. KA : 69\nNAMA KA : BANJAR\nRELASI : ML-BD\nKDR : BANYU BIRU\nNIPP : 75283\nLINTAS : BJR-BD\n' +
    'Melaporkan :\n' +
    'Mohon dibantu porter untuk bawa barang saat akan tiba di sta Akhir ( Bd ) utk PNP WNA china di Eksa 4/7D');
  // TIDAK ada reply palsu yang berasal dari potongan pesan itu sendiri.
  assert.equal(message.reply_to, null);
});

test('a real quoted reply keeps quoted text out of the body and links the preview', () => {
  const api = setup();
  const root = multiBlockBubble([
    { text: 'Jalur monitor, mohon bantuan kursi roda dri kedatangan KA 129 / Papandayan Pre 1-9D', quoted: true },
    { text: 'Copy pak di infokan ke dinas siang' }
  ]);
  const message = api.parseMessageNode(root, 0);
  assert.equal(message.type, 'text');
  // Body hanya berisi jawaban pengirim, bukan isi pesan yang dikutip.
  assert.equal(message.text, 'Copy pak di infokan ke dinas siang');
  // Quote yang terkonfirmasi tetap terhubung sebagai reply_to.
  assert.ok(message.reply_to);
  assert.equal(message.reply_to.preview,
    'Jalur monitor, mohon bantuan kursi roda dri kedatangan KA 129 / Papandayan Pre 1-9D');
  // Nama pengirim yang dikutip ikut tersimpan sebagai sender.
  assert.equal(message.reply_to.sender, 'Pusdalyan A');
});

test('duplicate adjacent blocks in one message are merged without repetition', () => {
  const api = setup();
  const root = multiBlockBubble([
    { text: 'Bagian pertama pesan' },
    { text: 'Bagian pertama pesan' },
    { text: 'bagian kedua' }
  ]);
  const message = api.parseMessageNode(root, 0);
  assert.equal(message.text, 'Bagian pertama pesan\nbagian kedua');
  assert.equal(message.reply_to, null);
});

test('clock-only nested fallback is not captured as message text', () => {
  const api = setup();
  const root = bubble([], null);
  root.nodes['span[dir], div[dir]'] = [{ innerText: '14.23' }];
  // Bukan media dan tidak ada teks nyata -> tidak menghasilkan record.
  assert.equal(api.parseMessageNode(root, 0), null);
});

test('collector drops skipped bubbles from the message list', () => {
  const api = setup();
  const photo = bubble([new Image()]);
  const video = bubble([new Image(1)]);
  video.nodes.video = [new Element()];
  const messages = api.collectRenderedMessages(messageList([photo, video]), 0);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'img');
});

// --- Resolusi sequence reply: seq 9 me-reply seq 4 harus tercatat sebagai 4 ---

test('reply sequence resolves to the real original message sequence', () => {
  const api = setup(['resolveReplySequences']);
  const originalText = 'Jalur monitor, mohon bantuan kursi roda dri kedatangan KA 129 / Papandayan Pre 1-9D';
  // Pesan dengan sequence 9 ini me-reply pesan sequence 4.
  const replyRoot = multiBlockBubble([
    { text: originalText, quoted: true },
    { text: 'Copy pak di infokan ke dinas siang' }
  ]);
  const replyMessage = api.parseMessageNode(replyRoot, 8);
  assert.ok(replyMessage.reply_to);
  // Rakit daftar pesan sebagaimana hasil ekspor: target ada di sequence 4.
  const messages = [
    { id: 'm1', sender: 'A', direction: 'incoming', type: 'text', text: 'Pesan lain 1' },
    { id: 'm2', sender: 'B', direction: 'incoming', type: 'text', text: 'Pesan lain 2' },
    { id: 'm3', sender: 'A', direction: 'incoming', type: 'text', text: 'Pesan lain 3' },
    { id: 'm4', sender: 'Pusdalyan A', direction: 'incoming', type: 'text', text: originalText },
    { id: 'm5', sender: 'A', direction: 'incoming', type: 'text', text: 'Pesan lain 5' },
    { id: 'm6', sender: 'B', direction: 'incoming', type: 'text', text: 'Pesan lain 6' },
    { id: 'm7', sender: 'A', direction: 'incoming', type: 'text', text: 'Pesan lain 7' },
    { id: 'm8', sender: 'B', direction: 'incoming', type: 'text', text: 'Pesan lain 8' }
  ].map((message, index) => ({ ...message, sequence: index + 1, reply_to: null }));
  messages.push({ ...replyMessage, sequence: 9 });
  const resolved = api.resolveReplySequences(messages);
  const entry = resolved.find((message) => message.sequence === 9);
  assert.ok(entry.reply_to, 'reply_to harus dipertahankan, bukan dihapus');
  // Inilah inti permintaan: reply_to.sequence berisi sequence ASLI pesan target.
  assert.equal(entry.reply_to.sequence, 4);
  assert.equal(entry.reply_to.message_id, 'm4');
});

test('a fake reply is dropped when its preview matches no earlier message', () => {
  const api = setup(['resolveReplySequences']);
  // Bubble yang menghasilkan reply_to palsu: preview "Informasi Pusdalyan..."
  // tidak pernah muncul sebagai pesan mana pun di riwayat chat.
  const fakeRoot = multiBlockBubble([
    { text: 'Informasi Pusdalyan 2 Oktober 2026 03:11 PENUMPANG MELEBIHI RELASI', quoted: true },
    { text: 'Semakin Melayani' }
  ]);
  const fakeMessage = api.parseMessageNode(fakeRoot, 2);
  assert.ok(fakeMessage.reply_to, 'parse menghasilkan kandidat reply');
  const messages = [
    { id: 'm1', sender: 'A', direction: 'incoming', type: 'text', text: 'Halo selamat pagi' },
    { id: 'm2', sender: 'B', direction: 'outgoing', type: 'text', text: 'Pagi, siap' }
  ].map((message, index) => ({ ...message, sequence: index + 1, reply_to: null }));
  messages.push({ ...fakeMessage, sequence: 3 });
  const resolved = api.resolveReplySequences(messages);
  // Tidak ada pesan yang cocok -> reply palsu dibuang, bukan disimpan dengan
  // sequence null.
  assert.equal(resolved[2].reply_to, null);
});

test('a reply to a long message still resolves despite the 500-char preview cut', () => {
  const api = setup(['resolveReplySequences']);
  // Pesan asli jauh lebih panjang dari 500 karakter; kartu quote hanya memuat
  // potongan awalnya (dipotong preview). Resolver harus tetap menemukannya.
  const longOriginal = 'Laporan awal kejadian. ' +
    Array.from({ length: 40 }, (_, i) => `baris detail ${i + 1} kejadian`).join('\n');
  const previewSnippet = longOriginal.slice(0, 120); // < 500, prefix dari pesan asli
  const replyRoot = multiBlockBubble([
    { text: previewSnippet, quoted: true },
    { text: 'Siap, diteruskan ke tim lapangan' }
  ]);
  const replyMessage = api.parseMessageNode(replyRoot, 5);
  const messages = [
    { id: 'm1', sender: 'A', direction: 'incoming', type: 'text', text: 'Pesan pembuka' },
    { id: 'm2', sender: 'Pusdalyan A', direction: 'incoming', type: 'text', text: longOriginal }
  ].map((message, index) => ({ ...message, sequence: index + 1, reply_to: null }));
  messages.push({ ...replyMessage, sequence: 3 });
  const resolved = api.resolveReplySequences(messages);
  const entry = resolved[2];
  assert.ok(entry.reply_to);
  // Meski preview dipotong, sequence asli (2) tetap tercatat.
  assert.equal(entry.reply_to.sequence, 2);
  assert.equal(entry.reply_to.message_id, 'm2');
});


// --- Fitur STOP: hentikan lalu simpan yang sudah terkumpul ---

test('stop request halts the image queue but keeps exported files', async () => {
  const api = setup(['processPendingImageCaptures']);
  api.extractNativeMessageId = () => null;
  const roots = [bubble([new Image()]), bubble([new Image()])];
  const main = messageList(roots);
  const states = new Map();
  const options = { exportImages: true, maxImageAttempts: 3, exportRoot: 'export' };
  const collect = () => {
    for (const message of api.collectRenderedMessages(main, 0)) {
      api.registerImageCandidate({}, message, options, states);
    }
  };
  collect();
  api.waitForMessageScroller = async () => null;
  api.normalizeError = (error) => error.message;

  let captures = 0;
  // STOP ditekan setelah gambar pertama selesai disimpan.
  let stopped = false;
  api.isStopRequested = () => stopped;
  api.captureImageUnit = async (args) => {
    captures += 1;
    stopped = true;
    return api.downloadImageCapture({ ...args, capture: {
      blob: new Blob([`photo-${captures}`], { type: 'image/png' }), width: 100, height: 100
    } });
  };

  await api.processPendingImageCaptures({ entry: { name: 'Chat' }, main,
    scroller: null, options, imageStates: states, collect });

  // Antrean berhenti lebih awal, tetapi gambar yang sudah selesai tetap utuh.
  assert.equal(captures, 1);
  const exported = [...states.values()].filter((state) => state.status === 'exported');
  assert.equal(exported.length, 1);
  assert.ok(exported[0].blob);
  assert.ok(exported[0].relative_path.startsWith('img/'));
});

test('image queue runs to completion when stop is never requested', async () => {
  const api = setup(['processPendingImageCaptures']);
  api.extractNativeMessageId = () => null;
  const main = messageList([bubble([new Image()]), bubble([new Image()])]);
  const states = new Map();
  const options = { exportImages: true, maxImageAttempts: 3, exportRoot: 'export' };
  const collect = () => {
    for (const message of api.collectRenderedMessages(main, 0)) {
      api.registerImageCandidate({}, message, options, states);
    }
  };
  collect();
  api.waitForMessageScroller = async () => null;
  api.normalizeError = (error) => error.message;
  api.isStopRequested = () => false;

  let captures = 0;
  api.captureImageUnit = async (args) => {
    captures += 1;
    return api.downloadImageCapture({ ...args, capture: {
      blob: new Blob([`photo-${captures}`], { type: 'image/png' }), width: 100, height: 100
    } });
  };

  await api.processPendingImageCaptures({ entry: { name: 'Chat' }, main,
    scroller: null, options, imageStates: states, collect });

  assert.equal(captures, 2);
  assert.equal([...states.values()].filter((s) => s.status === 'exported').length, 2);
});

test('already exported images still reach the ZIP after an early stop', async () => {
  const api = setup();
  api.createZipBlob = (entries) => entries;
  const saved = await api.downloadImageCapture({
    chatName: 'A', messageId: 'image-1', options: { exportRoot: 'export' },
    capture: { blob: new Blob(['photo']), width: 100, height: 100 }
  });
  const { blob: entries } = await api.buildExportZipBundle({ exportRoot: 'export', payload: {},
    exportedChats: [{ image_files: [{ ...saved, blob: new Blob(['photo']) }] }] });
  // JSON chat + ringkasan + CSV + gambar yang sempat tersimpan.
  assert.equal(entries.length, 4);
});

