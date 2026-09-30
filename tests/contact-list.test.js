const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildExportedContactsCsv, parseCsv, contactsFromRows, matchingChatIds, matchContacts,
  normalizeContactName, numericId, readContactsFile } = require('../contact-list.js');

test('CSV roundtrip handles commas, quotes, newlines and UTF-8 names', () => {
  const csv = buildExportedContactsCsv([
    { chat_name: 'Budi, "Toko"\nBaru', chat_id: 'native:data-jid:628123456789@c.us', message_count: 5 },
    { chat_name: 'René', chat_id: 'dom:random', community_name: 'Kampus', message_count: 0 }
  ]);
  const entries = contactsFromRows(parseCsv(csv));
  assert.equal(entries[0].name, 'Budi, "Toko"\nBaru');
  assert.equal(entries[0].id, 'native:data-jid:628123456789@c.us');
  assert.equal(entries[1].community, 'Kampus');
});

test('exact names, community scope and numeric IDs match without fuzzy false positives', () => {
  const chats = [
    { id: 'one', name: 'Ani' }, { id: 'two', name: 'Anita' },
    { id: 'three', name: 'Grup A', community_name: 'Kampus' },
    { id: 'four', name: 'Grup A', community_name: 'Kantor' },
    { id: 'native:data-jid:628123456789@c.us', name: 'Nama Baru' }
  ];
  assert.deepEqual(matchingChatIds(chats, [
    { name: 'Ani', id: '' }, { name: 'Grup A', community: 'Kampus' },
    { name: '', id: '+62 812-3456-789' }
  ]), ['one', 'three', 'native:data-jid:628123456789@c.us']);
  assert.equal(numericId('dom:chat-628123456789-random'), null);
});

test('CSV without header can contain just names or numeric IDs', async () => {
  const entries = await readContactsFile({ name: 'old.csv', text: async () => 'Ani\n628123456789\n' });
  assert.equal(entries.length, 2);
  assert.equal(entries[1].name, '628123456789');
});

test('smart matching normalizes case, accents, punctuation, whitespace and invisible characters', () => {
  assert.equal(normalizeContactName('  RÉNÉ\u200e — Toko   Baru 🌟 '), 'rene toko baru');
  const report = matchContacts([{ id: 'one', name: 'RÉNÉ - TOKO BARU 🌟' }], [{ name: 'rene toko baru' }]);
  assert.deepEqual(report.chatIds, ['one']);
  assert.equal(report.matches[0].kind, 'normalized');
  assert.deepEqual(matchContacts([{ id: 'one', name: 'BU\u200bDI' }], [{ name: 'Budi' }]).chatIds, ['one']);
});

test('complete keywords match added words and reordered group names', () => {
  for (const [name, query] of [
    ['Alumni SMA Bandung 2024', 'Alumni Bandung'],
    ['Budi Santoso', 'Pak Budi Santoso'],
    ['Santoso Budi', 'Budi Santoso'],
    ['Tim Marketing Jakarta', 'Marketing']
  ]) {
    const report = matchContacts([{ id: 'one', name }], [{ name: query }]);
    assert.deepEqual(report.chatIds, ['one'], query);
    assert.equal(report.matches[0].kind, 'keyword');
  }
});

test('Levenshtein similarity tolerates light typos but does not invent unrelated matches', () => {
  const report = matchContacts([
    { id: 'one', name: 'Budi Santoso' }, { id: 'two', name: 'Dewi Lestari' }
  ], [{ name: 'Budi Santso' }, { name: 'Kontak Tidak Ada' }]);
  assert.deepEqual(report.chatIds, ['one']);
  assert.equal(report.matches[0].kind, 'fuzzy');
  assert.ok(report.matches[0].candidates[0].score >= 0.85);
  assert.equal(report.unmatchedCount, 1);
});

test('short names, generic words, empty normalized names and substrings cannot select unrelated chats', () => {
  for (const [name, query] of [
    ['Anita', 'Ani'], ['Dina', 'Dini'], ['Pak Rudi', 'Pak'],
    ['Grup Bandung', 'Grup'], ['Marketing', 'Market'], ['⭐', '🌟'], ['   ', '']
  ]) {
    assert.deepEqual(matchingChatIds([{ id: 'one', name }], [{ name: query }]), [], query);
  }
});

test('exact names and numeric IDs take priority over similar names', () => {
  const chats = [
    { id: 'one', name: 'Budi Santoso' },
    { id: 'two', name: 'Pak Budi Santoso' },
    { id: 'native:data-jid:628123456789@c.us', name: 'Nama Baru' }
  ];
  assert.deepEqual(matchingChatIds(chats, [{ name: 'Budi Santoso' }]), ['one']);
  const report = matchContacts(chats, [{ name: 'Budi Santoso', id: '+62 812-3456-789' }]);
  assert.deepEqual(report.chatIds, ['native:data-jid:628123456789@c.us']);
  assert.equal(report.matches[0].kind, 'id');
});

test('phone numbers are never fuzzy matched and conflicting known numbers block name matches', () => {
  assert.deepEqual(matchingChatIds([{ id: 'one', name: '+628123456788' }], [{ name: '628123456789' }]), []);
  assert.deepEqual(matchingChatIds([{ id: 'one', name: 'Budi', contact_id: '628123456788' }],
    [{ name: 'Budi', id: '628123456789' }]), []);
  assert.deepEqual(matchingChatIds([{ id: 'dom:random', name: 'Budi Santoso' }],
    [{ name: 'Budi Santso', id: '628123456789' }]), ['dom:random']);
});

test('group years, numbers and single-letter labels are not treated as typos', () => {
  for (const [name, query] of [
    ['Alumni Bandung 2025', 'Alumni Bandung 2024'],
    ['Marketing 12', 'Marketing 13'],
    ['Kelompok Belajar A', 'Kelompok Belajar B']
  ]) {
    assert.deepEqual(matchingChatIds([{ id: 'one', name }], [{ name: query }]), [], query);
  }
});

test('community scope is normalized but never fuzzy matched or ignored for name matches', () => {
  const report = matchContacts([
    { id: 'one', name: 'Marketing Jakarta', community_name: 'KÁMPUS - UTAMA' },
    { id: 'two', name: 'Marketing Jakarta', community_name: 'Kampus Lain' },
    { id: 'three', name: 'Marketing Jakarta' }
  ], [{ name: 'Marketing', community: 'kampus utama' }]);
  assert.deepEqual(report.chatIds, ['one']);
  assert.deepEqual(matchingChatIds([{ id: 'one', name: 'Marketing', community_name: 'Kampus' }],
    [{ name: 'Marketing', community: 'Kampuz' }]), []);
});

test('multiple keyword candidates and near-tied typo scores require manual review', () => {
  for (const [names, query] of [
    [['Marketing Jakarta', 'Marketing Bandung'], 'Marketing'],
    [['Budi Santosa', 'Budi Santosi'], 'Budi Santoso']
  ]) {
    const report = matchContacts(names.map((name, i) => ({ id: String(i), name })), [{ name: query }]);
    assert.deepEqual(report.chatIds, []);
    assert.equal(report.ambiguousCount, 1);
    assert.equal(report.matchedCount, 0);
    assert.equal(report.unmatchedCount, 0);
    assert.equal(report.matches[0].candidates.length, 2);
  }
});

test('report counts imported rows separately from unique matching chats', () => {
  const report = matchContacts([
    { id: 'one', name: 'Budi Santoso' }, { id: 'two', name: 'Grup A' }, { id: 'three', name: 'Grup A' }
  ], [{ name: 'Budi Santoso' }, { name: 'Budi Santso' }, { name: 'Grup A' }, { name: 'Tidak Ada' }]);
  assert.deepEqual(report.chatIds, ['one', 'two', 'three']);
  assert.equal(report.matchedCount, 3);
  assert.equal(report.unmatchedCount, 1);
  const duplicate = matchContacts([{ id: 'one', name: 'Budi' }], [{ name: 'Budi' }, { name: 'Budi' }]);
  assert.equal(duplicate.matchedCount, 2);
  assert.equal(duplicate.chatIds.length, 1);
  const multiple = matchContacts([{ id: 'one', name: 'Budi' }, { id: 'two', name: 'Budi' }], [{ name: 'Budi' }]);
  assert.equal(multiple.matchedCount, 1);
  assert.equal(multiple.chatIds.length, 2);
});

test('exact mode skips normalization, keywords and typo matching', () => {
  const chats = [{ id: 'one', name: 'Budi Santoso' }];
  for (const name of ['budi santoso', 'Budi', 'Budi Santso']) {
    assert.deepEqual(matchingChatIds(chats, [{ name }], { mode: 'exact' }), []);
  }
  assert.deepEqual(matchingChatIds(chats, [{ name: 'Budi Santoso' }], { mode: 'exact' }), ['one']);
});

test('matching supports non-Latin names and safely skips edit distance for extreme lengths', () => {
  assert.deepEqual(matchingChatIds([{ id: 'one', name: '東京 家族' }], [{ name: '東京　家族' }]), ['one']);
  const name = 'a'.repeat(300);
  assert.deepEqual(matchingChatIds([{ id: 'one', name }], [{ name }]), ['one']);
  assert.deepEqual(matchingChatIds([{ id: 'one', name }], [{ name: 'b' + name.slice(1) }]), []);
});

test('numeric contact_id is not hidden by an earlier internal chat_id column in an exported file', () => {
  const entries = contactsFromRows(parseCsv(buildExportedContactsCsv([
    { chat_name: 'Nama Lama', chat_id: 'dom:random', contact_id: '628123456789' },
    { chat_name: 'Lain', chat_id: 'native:data-jid:628123456788@c.us', contact_id: '' }
  ])));
  assert.equal(entries[0].id, '628123456789');
  assert.equal(entries[1].id, 'native:data-jid:628123456788@c.us');
  assert.deepEqual(matchingChatIds([{ id: 'new', name: 'Nama Baru', contact_id: '628123456789' }], entries), ['new']);
});

test('typo threshold includes 85 percent but excludes lower scores', () => {
  const chats = [{ id: 'one', name: 'abcdefghijklmnopqrst' }];
  const accepted = matchContacts(chats, [{ name: 'xyzdefghijklmnopqrst' }]);
  assert.equal(accepted.matches[0].kind, 'fuzzy');
  assert.equal(accepted.matches[0].candidates[0].score, 0.85);
  assert.deepEqual(matchingChatIds(chats, [{ name: 'xyzzefghijklmnopqrst' }]), []);
});

test('multiple keyword candidates remain ambiguous even with a higher-scoring typo candidate', () => {
  const name = 'Marketing ' + 'a'.repeat(100);
  const report = matchContacts([
    { id: 'one', name: name.slice(0, -1) + 'b' },
    { id: 'two', name: 'Marketing' },
    { id: 'three', name: 'a'.repeat(100) }
  ], [{ name }]);
  assert.deepEqual(report.chatIds, []);
  assert.equal(report.ambiguousCount, 1);
});
