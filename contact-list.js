// Format pertukaran lokal untuk daftar chat yang sudah diekspor.
(function (root) {
  function csvCell(value) {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function buildExportedContactsCsv(chats) {
    const rows = [["chat_name", "chat_id", "contact_id", "community_name", "source_kind", "message_count"]];
    for (const chat of chats) {
      rows.push([chat.chat_name, chat.chat_id, chat.contact_id, chat.community_name, chat.source_kind, chat.message_count]);
    }
    // BOM membuat UTF-8 (termasuk nama beraksen) terbaca di Excel.
    return "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }

  function parseCsv(text) {
    const input = String(text).replace(/^\uFEFF/, "");
    const first = input.split(/\r?\n/, 1)[0];
    const delimiter = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ";" : ",";
    const rows = [];
    let row = [], cell = "", quoted = false;
    for (let i = 0; i < input.length; i += 1) {
      const char = input[i];
      if (quoted) {
        if (char === '"' && input[i + 1] === '"') { cell += '"'; i += 1; }
        else if (char === '"') quoted = false;
        else cell += char;
      } else if (char === '"' && !cell) quoted = true;
      else if (char === delimiter) { row.push(cell); cell = ""; }
      else if (char === "\n" || char === "\r") {
        if (char === "\r" && input[i + 1] === "\n") i += 1;
        row.push(cell);
        if (row.some((value) => value.trim())) rows.push(row);
        row = []; cell = "";
      } else cell += char;
    }
    if (quoted) throw new Error("CSV memiliki tanda kutip yang belum ditutup.");
    row.push(cell);
    if (row.some((value) => value.trim())) rows.push(row);
    return rows;
  }

  function numericId(value) {
    const text = String(value ?? "").trim();
    // ID internal / hash grup bukan nomor kontak. Jangan samakan angka di tengah ID.
    const match = /^(?:(?:data-jid|data-chat-id|data-id):)?\+?(\d{6,20})(?:@(?:c\.us|s\.whatsapp\.net))?$/i.exec(text);
    if (match) return match[1];
    if (/^\+?[\d\s().-]{6,30}$/.test(text)) {
      const digits = text.replace(/\D/g, "");
      if (digits.length >= 6 && digits.length <= 20) return digits;
    }
    const embedded = /^native:(?:data-jid|data-chat-id|data-id):\+?(\d{6,20})(?:@(?:c\.us|s\.whatsapp\.net))?(?:\|.*)?$/i.exec(text);
    if (embedded) return embedded[1];
    return null;
  }

  function contactsFromRows(rows) {
    if (!rows.length) throw new Error("File tidak berisi daftar kontak.");
    const headers = rows[0].map((value) => String(value).trim().toLowerCase().replace(/[\s-]+/g, "_"));
    const nameIndex = headers.findIndex((key) => ["chat_name", "nama_kontak", "nama", "contact_name", "name", "kontak"].includes(key));
    const idIndex = headers.findIndex((key) => ["contact_id", "chat_id", "id", "id_angka", "nomor", "nomor_telepon", "phone", "phone_number"].includes(key));
    const communityIndex = headers.indexOf("community_name");
    const hasHeader = nameIndex >= 0 || idIndex >= 0;
    const chatIdIndex = headers.indexOf("chat_id");
    const contactIdIndex = headers.indexOf("contact_id");
    const entries = (hasHeader ? rows.slice(1) : rows).map((row) => ({
      name: String(row[hasHeader ? nameIndex : 0] ?? "").trim(),
      id: String(hasHeader
        ? ((contactIdIndex >= 0 && numericId(row[contactIdIndex]) && String(row[contactIdIndex]).trim()) ||
          (idIndex >= 0 && String(row[idIndex] ?? "").trim()) || (chatIdIndex >= 0 ? row[chatIdIndex] : ""))
        : (row[row.length > 1 ? 1 : 0] ?? "")).trim(),
      community: communityIndex >= 0 ? String(row[communityIndex] ?? "").trim() : ""
    })).filter((entry) => entry.name || numericId(entry.id));
    if (!entries.length) throw new Error("Tidak ada nama kontak atau ID angka yang dapat dibaca.");
    return entries;
  }

  function normalizeContactName(value) {
    return String(value ?? "").normalize("NFKD")
      .replace(/[\u0300-\u036f\uFE00-\uFE0F]/g, "")
      .replace(/\p{Cf}/gu, "")
      .toLocaleLowerCase("id-ID")
      .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
      .trim().replace(/\s+/g, " ");
  }

  function editSimilarity(left, right) {
    if (left === right) return 1;
    const a = Array.from(left), b = Array.from(right);
    const longest = Math.max(a.length, b.length);
    // Nama ekstrem panjang tetap dapat cocok secara persis/kata kunci,
    // tetapi tidak boleh membuat perhitungan edit distance membekukan panel.
    if (!a.length || !b.length || longest > 256 || Math.min(a.length, b.length) / longest < 0.85) return 0;
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i += 1) {
      const current = [i];
      for (let j = 1; j <= b.length; j += 1) {
        current[j] = Math.min(current[j - 1] + 1, previous[j] + 1,
          previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      previous = current;
    }
    return 1 - previous[b.length] / longest;
  }

  function nameProfile(value) {
    const normalized = normalizeContactName(value);
    const tokens = normalized ? normalized.split(" ") : [];
    const generic = new Set(["grup", "group", "tim", "team", "pak", "bu", "bapak", "ibu", "pt", "cv"]);
    return {
      normalized, tokens,
      sorted: [...tokens].sort().join(" "),
      numbers: (normalized.match(/\p{N}+/gu) || []).sort().join(" "),
      initials: tokens.filter((token) => /^\p{L}$/u.test(token)).sort().join(" "),
      informative: tokens.some((token) => Array.from(token.replace(/[^\p{L}]/gu, "")).length >= 4 && !generic.has(token))
    };
  }

  function containsTokens(whole, part) {
    const remaining = [...whole];
    return part.every((token) => {
      const index = remaining.indexOf(token);
      if (index < 0) return false;
      remaining.splice(index, 1);
      return true;
    });
  }

  function similarName(query, candidate) {
    if (!query.informative || !candidate.informative) return null;
    // Nomor/tahun dan label satu huruf tidak dikoreksi sebagai salah ketik.
    // Kata kunci tanpa nomor boleh menemukan grup bernomor (mis. Alumni → Alumni 2024).
    if (query.numbers && candidate.numbers && query.numbers !== candidate.numbers) return null;
    if (query.initials && candidate.initials && query.initials !== candidate.initials) return null;
    if (containsTokens(candidate.tokens, query.tokens) || containsTokens(query.tokens, candidate.tokens)) {
      const ratio = Math.min(query.normalized.length, candidate.normalized.length) /
        Math.max(query.normalized.length, candidate.normalized.length);
      return { kind: "keyword", score: 0.9 + 0.08 * ratio };
    }
    if (query.numbers !== candidate.numbers || query.initials !== candidate.initials) return null;
    const score = Math.max(editSimilarity(query.normalized, candidate.normalized),
      editSimilarity(query.sorted, candidate.sorted));
    return score >= 0.85 ? { kind: "fuzzy", score } : null;
  }

  function matchContacts(chats, entries, { mode = "smart" } = {}) {
    const smart = mode !== "exact";
    const prepared = chats.map((chat) => ({
      chat, profile: nameProfile(chat.name), community: normalizeContactName(chat.community_name),
      numbers: [chat.id, chat.contact_id, chat.name].map(numericId).filter(Boolean)
    }));
    const selected = new Set();
    const matches = entries.map((entry, entryIndex) => {
      const name = String(entry.name ?? "").trim();
      const number = numericId(entry.id) || numericId(name);
      const profile = nameProfile(name);
      const community = normalizeContactName(entry.community);
      function candidate(item, kind, score = 1) {
        return { chatId: item.chat.id, name: item.chat.name, community: item.chat.community_name || "", kind, score };
      }
      function result(kind, candidates) {
        if (kind !== "ambiguous" && kind !== "unmatched") {
          for (const item of candidates) selected.add(item.chatId);
        }
        return { entryIndex, kind, candidates };
      }

      // ID angka lebih kuat daripada nama, bahkan setelah kontak berganti nama.
      const byId = number ? prepared.filter((item) => item.numbers.includes(number)) : [];
      if (byId.length) return result("id", byId.map((item) => candidate(item, "id")));
      const eligible = prepared.filter((item) => {
        if (number && item.numbers.length && !item.numbers.includes(number)) return false;
        if (!entry.community) return true;
        return smart ? Boolean(community) && community === item.community : entry.community === item.chat.community_name;
      });
      const exact = name ? eligible.filter((item) => name === item.chat.name) : [];
      if (exact.length) return result("exact", exact.map((item) => candidate(item, "exact")));
      if (!smart || !profile.normalized || numericId(name)) return result("unmatched", []);
      const normalized = eligible.filter((item) => profile.normalized === item.profile.normalized);
      if (normalized.length) return result("normalized", normalized.map((item) => candidate(item, "normalized")));

      const similar = eligible.flatMap((item) => {
        // Nomor telepon tidak pernah dicocokkan dengan edit distance.
        if (numericId(item.chat.name)) return [];
        const match = similarName(profile, item.profile);
        return match ? [candidate(item, match.kind, match.score)] : [];
      }).sort((a, b) => b.score - a.score);
      if (!similar.length) return result("unmatched", []);
      const best = similar[0];
      // Kata kunci yang menunjuk beberapa chat dan skor yang terlalu berdekatan
      // ditampilkan untuk diperiksa, bukan memilih orang/grup secara sembarang.
      const ambiguous = similar.length > 1 &&
        (similar.filter((match) => match.kind === "keyword").length > 1 || best.score - similar[1].score < 0.05);
      return ambiguous ? result("ambiguous", similar) : result(best.kind, [best]);
    });
    return {
      chatIds: [...new Set(chats.filter((chat) => selected.has(chat.id)).map((chat) => chat.id))],
      matches,
      matchedCount: matches.filter((match) => !["ambiguous", "unmatched"].includes(match.kind)).length,
      ambiguousCount: matches.filter((match) => match.kind === "ambiguous").length,
      unmatchedCount: matches.filter((match) => match.kind === "unmatched").length
    };
  }

  function matchingChatIds(chats, entries, options) {
    return matchContacts(chats, entries, options).chatIds;
  }

  function xmlDocument(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("XML Excel tidak valid.");
    return doc;
  }

  async function parseXlsx(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    // Central directory dipakai agar ZIP buatan Excel/LibreOffice (dengan data descriptor) terbaca.
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) {
      if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw new Error("File XLSX bukan arsip Excel yang valid.");
    const count = view.getUint16(end + 10, true);
    let offset = view.getUint32(end + 16, true);
    const files = new Map();
    const decoder = new TextDecoder();
    for (let i = 0; i < count; i += 1) {
      if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw new Error("Direktori XLSX rusak.");
      const method = view.getUint16(offset + 10, true);
      const size = view.getUint32(offset + 20, true);
      const unpacked = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extra = view.getUint16(offset + 30, true);
      const comment = view.getUint16(offset + 32, true);
      const local = view.getUint32(offset + 42, true);
      const name = decoder.decode(bytes.slice(offset + 46, offset + 46 + nameLength));
      files.set(name, { method, size, unpacked, local });
      offset += 46 + nameLength + extra + comment;
    }
    async function readFile(name) {
      const file = files.get(name);
      if (!file) return null;
      if (file.unpacked > 20_000_000) throw new Error("Sheet Excel terlalu besar.");
      const at = file.local;
      if (at + 30 > bytes.length || view.getUint32(at, true) !== 0x04034b50) throw new Error("Data XLSX rusak.");
      const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
      if (start + file.size > bytes.length) throw new Error("Data XLSX terpotong.");
      let data = bytes.slice(start, start + file.size);
      if (file.method === 8) {
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        data = new Uint8Array(await new Response(stream).arrayBuffer());
      } else if (file.method !== 0) throw new Error("Kompresi XLSX tidak didukung.");
      if (data.length > 20_000_000) throw new Error("Sheet Excel terlalu besar.");
      return decoder.decode(data);
    }
    const workbookText = await readFile("xl/workbook.xml");
    if (!workbookText) throw new Error("Workbook XLSX tidak ditemukan.");
    const workbook = xmlDocument(workbookText);
    const sheet = workbook.getElementsByTagName("sheet")[0];
    if (!sheet) throw new Error("Workbook tidak memiliki sheet.");
    const relationshipId = sheet.getAttribute("r:id");
    const relsText = await readFile("xl/_rels/workbook.xml.rels");
    const relationships = relsText ? xmlDocument(relsText).getElementsByTagName("Relationship") : [];
    const relation = Array.from(relationships).find((item) => item.getAttribute("Id") === relationshipId);
    const target = relation?.getAttribute("Target");
    if (!target) throw new Error("Sheet Excel pertama tidak ditemukan.");
    const sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    if (sheetPath.includes("..")) throw new Error("Path sheet Excel tidak valid.");
    const sheetText = await readFile(sheetPath);
    if (!sheetText) throw new Error("Sheet Excel pertama tidak tersedia.");
    const sharedText = await readFile("xl/sharedStrings.xml");
    const shared = sharedText ? Array.from(xmlDocument(sharedText).getElementsByTagName("si"),
      (si) => Array.from(si.getElementsByTagName("t"), (t) => t.textContent).join("")) : [];
    return Array.from(xmlDocument(sheetText).getElementsByTagName("row"), (row) => {
      const values = [];
      for (const cell of row.getElementsByTagName("c")) {
        const reference = cell.getAttribute("r") || "";
        const letters = /^[A-Z]+/i.exec(reference)?.[0]?.toUpperCase() || "A";
        let column = 0;
        for (const letter of letters) column = column * 26 + letter.charCodeAt(0) - 64;
        if (column > 100) continue;
        const value = cell.getElementsByTagName("v")[0]?.textContent || "";
        values[column - 1] = cell.getAttribute("t") === "s" ? (shared[Number(value)] || "") :
          cell.getAttribute("t") === "inlineStr" ? Array.from(cell.getElementsByTagName("t"), (t) => t.textContent).join("") : value;
      }
      return values;
    }).filter((row) => row.some((value) => String(value ?? "").trim()));
  }

  async function readContactsFile(file) {
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".csv")) return contactsFromRows(parseCsv(await file.text()));
    if (lower.endsWith(".xlsx")) return contactsFromRows(await parseXlsx(await file.arrayBuffer()));
    throw new Error("Gunakan CSV atau Excel .xlsx (file .xls lama perlu dikonversi dahulu).");
  }

  root.ContactList = { buildExportedContactsCsv, parseCsv, numericId, contactsFromRows,
    normalizeContactName, matchContacts, matchingChatIds, parseXlsx, readContactsFile };
  if (typeof module !== "undefined") module.exports = root.ContactList;
})(typeof globalThis !== "undefined" ? globalThis : this);
