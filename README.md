# WhatsApp JSON + Image Exporter v0.2.0

v0.9.2 memfokuskan perbaikan pada alur Community dan keamanan queue ekspor. Scanner selalu memulai dari Chats, memindai All + Groups, lalu berpindah ke Communities. Daftar nama Community dikumpulkan terlebih dahulu sebagai snapshot; setelah itu Community dibuka satu per satu berdasarkan snapshot tersebut. Cara ini menghindari row virtual yang berubah saat panel detail dibuka/ditutup.

## Perubahan utama

- Traversal Community tidak lagi membuka Community sambil men-scroll index. Index dipindai dulu, lalu nama Community diproses satu per satu.
- Subgroup Community dipisahkan berdasarkan status membership UI. Bagian `Groups you're in` / padanan Indonesia dianggap aktif. Bagian `Groups you can join`, `Other groups`, serta row yang menawarkan `Join group` atau `Request to join` dilewati.
- Announcements/Pengumuman tetap dilewati.
- Subgroup yang lolos scan tetapi ketika dibuka ternyata menampilkan Join/Request akan dicatat `skipped` dan queue ekspor tetap lanjut ke chat berikutnya.
- Setelah kegagalan satu chat, ekstensi melakukan recovery ke Chats/All sebelum melanjutkan queue.
- Header subgroup Community sekarang dikonfirmasi memakai nama subgroup, bukan nama Community.
- Search, multi-chat, dynamic scroll, `reply_to.sequence`, ekspor gambar readable, dan path media di JSON tetap dipertahankan.

## Struktur arsip hasil ekspor

Setiap kontak/grup yang berhasil di-scrape disimpan sebagai **satu file JSON tersendiri**. Folder `messages/` berisi tepat sebanyak chat yang berhasil diekspor, bukan satu file gabungan.

```
whatsapp-export-YYYYMMDD-HHMMSS.zip
└── whatsapp-export-YYYYMMDD-HHMMSS/
    ├── export-summary.json              ← ringkasan semua chat + daftar error + indeks file
    ├── messages/
    │   ├── Budi Santoso-433e5c.json     ← satu kontak = satu file
    │   ├── Grup Kuliah-075957.json      ← satu grup = satu file
    │   └── Grup Kuliah-e78f63.json      ← nama sama, Community beda = file beda
    └── img/
        └── <nama chat>-<hash>/
            └── image-<sha256>.png
```

Aturan penamaan file JSON:

- Format `<nama chat yang disanitasi>-<hash 6 karakter>.json`, konvensi yang sama dengan folder `img/`.
- Karakter yang ilegal pada nama file Windows (`< > : " / \ | ? *`) diganti `-`; nama chat asli tetap utuh di dalam JSON pada field `chat.chat_name`.
- Hash dihitung dari `chat_id` + nama chat + nama Community, sehingga dua chat bernama sama (misalnya subgroup dengan nama identik di dua Community) tidak saling menimpa. Jika nama file masih bertabrakan, akhiran `-2`, `-3`, dan seterusnya ditambahkan.

Isi setiap file JSON per chat:

- Metadata bersama (`schema_version`, `exported_at`, `source`, `export_settings`, `warnings`) sehingga file tetap dapat dibaca sendiri tanpa file lain.
- `output.json_file` menunjuk ke path file itu sendiri.
- `chat` berisi satu objek chat lengkap beserta `messages`. Blob gambar tidak ikut diserialisasi, hanya metadata dan `relative_path` ke file di `img/`.
- Ringkasan gabungan (`export_summary`), daftar `errors`, dan indeks `chat_files` **tidak** diulang di setiap file — semuanya ada di `export-summary.json` pada akar arsip.

## Alur scan

1. Paksa buka **Chats**.
2. Scan **All**.
3. Scan **Groups** + verification pass.
4. Buka **Communities**.
5. Scan index Communities sampai bawah dan simpan snapshot nama Community.
6. Untuk setiap nama Community:
   - buka index Communities,
   - cari Community berdasarkan nama,
   - buka detail,
   - scan dari atas ke bawah,
   - simpan hanya subgroup aktif/yang sudah diikuti,
   - skip Announcements dan subgroup yang masih bisa di-Join/Request,
   - kembali ke index.
7. Rekonsiliasi hasil Community authoritative dengan hasil All/Groups.
8. Kembali ke Chats/All.

## Instalasi

1. Ekstrak ZIP.
2. Buka `chrome://extensions` atau `edge://extensions`.
3. Aktifkan Developer mode.
4. Klik **Load unpacked**.
5. Pilih folder `whatsapp-json-exporter-v0.9.2`.
6. Reload WhatsApp Web dengan `Ctrl+Shift+R`.
7. Klik ikon ekstensi di toolbar — panel terbuka di **sisi kanan browser**.
8. Klik **Pindai** dan jangan berinteraksi dengan sidebar selama scan.

## Side panel & persistensi progres

Ekstensi berjalan sebagai **side panel** (bukan popup). Perbedaan utamanya:

- Panel **tidak tertutup** saat Anda mengeklik halaman, berpindah tab, atau membuka jendela lain.
- Daftar chat, pilihan, hasil ekspor, status, dan pengaturan disimpan di `chrome.storage.local` lewat service worker.
- Saat panel dibuka kembali — termasuk **setelah Chrome ditutup dan dibuka lagi** — seluruh tampilan terakhir dipulihkan otomatis.
- Progres scan/ekspor tetap tercatat walaupun panel sempat ditutup di tengah proses.
- Karena panel bisa aktif saat tab non-WhatsApp sedang dibuka, ekstensi otomatis mencari tab WhatsApp Web di jendela mana pun sebelum mengirim perintah.

Menekan **Pindai** atau **Ekspor** menghapus hasil lama, jadi arsip sebelumnya tidak tercampur. Membutuhkan Chrome/Edge **versi 114+** (`sidePanel` API).

## Menghentikan proses (STOP)

Selama scan atau ekspor berjalan, tombol **Ekspor** berganti menjadi **Hentikan & simpan sekarang** (merah).

1. Klik tombol tersebut — muncul **dialog konfirmasi**.
2. Pilih **Batal, lanjutkan** untuk meneruskan proses, atau **Ya, hentikan & simpan** untuk berhenti.
3. Dialog juga bisa dibatalkan dengan tombol `Esc` atau mengeklik area gelap di luarnya.

Setelah dikonfirmasi, proses berhenti di **titik aman terdekat** lalu langsung membangun ZIP dari data yang sudah terkumpul. Tidak ada data yang dibuang.

Titik henti diperiksa di empat tempat:

| Lokasi | Efek |
| --- | --- |
| Antar-chat pada antrean ekspor | Chat yang sudah selesai tetap masuk arsip |
| Loop scroll di dalam satu chat | Pesan yang sudah terkumpul dipertahankan, `stop_reason: "stopped_by_user"` |
| Antar-gambar pada antrean capture | Gambar yang sudah tersimpan tetap utuh |
| Loop scroll sidebar saat memindai | Daftar chat yang sudah ditemukan tetap bisa diekspor |

Arsip hasil penghentian ditandai `export_summary.stopped_by_user: true` beserta catatan pada `warnings`. Status panel menampilkan **"Dihentikan: …"** alih-alih "Selesai: …".

Karena STOP membuang sisa antrean yang belum diproses, konfirmasi bersifat **wajib** — satu klik tidak akan langsung menghentikan proses.

## Aturan ekstraksi media

**Ruang lingkup ekspor hanya dua: teks dan gambar.**

| Jenis | Diekspor? | Keterangan |
| --- | --- | --- |
| Teks pesan (masuk & keluar) | ✅ Ya | Selalu diambil |
| Gambar (dengan/tanpa caption) | ✅ Ya | File disimpan + caption jadi `text` |
| Video / GIF | ❌ Tidak | Caption-nya saja yang jadi `text`; tanpa caption bubble dilewati |
| Stiker, voice note, audio | ❌ Tidak | Sama seperti video |
| Dokumen / PDF | ❌ Tidak | Preview halaman pertama tidak pernah jadi gambar |
| Thumbnail (link, PDF, video) | ❌ Tidak | Selalu dibuang |

JSON hasil ekspor hanya pernah memuat `"type": "img"` atau `"type": "text"`. Bubble yang tidak menghasilkan keduanya dilewati sepenuhnya sehingga tidak ada entri kosong.

### Perbaikan jam terbaca sebagai teks

Sebelumnya mode `captionOnly` hanya aktif untuk video dan gambar, sehingga stiker/voice note jatuh ke fallback `span[dir]` dan memungut jam pesan (mis. `"22:47"`) sebagai `text`. Sekarang **semua** bubble bermedia memakai `captionOnly`, jadi hanya caption asli yang dibaca. Durasi video dan jam pesan tidak pernah menjadi caption.

- Foto tanpa caption dan tanpa ID native memakai ID sementara per bubble, bukan hash caption kosong, supaya dua foto berbeda tidak saling menimpa dalam antrean. Baris pesan (`role="row"`) berisi media juga diperiksa jika class pesan/metadata tidak tersedia. Untuk pesan tanpa ID native, DOM yang dibuat ulang dapat menghasilkan ID sementara baru; deduplikasi byte file tetap berlaku, tetapi deduplikasi record pesan pada kondisi ini tidak dijamin.

- Pengumpulan pesan, kesiapan chat, dan pencarian scroll tidak hanya bergantung pada `data-pre-plain-text`: pembungkus pesan masuk/keluar dan ID pesan juga diperiksa. Bubble album diproses sekali walaupun memiliki beberapa node metadata. Lapisan gambar/canvas/background yang bertumpuk dengan ukuran dan posisi sama disatukan sebelum ekspor.

- Database internal `Map` berlaku untuk satu sesi ekspor. ID unit (chat, ID pesan, indeks gambar) mengunci pekerjaan yang sedang berlangsung dan hasil sukses. Kegagalan boleh dicoba ulang. Ekspor baru memiliki database baru supaya arsip tidak kehilangan file.
- Sebelum file ditambahkan, SHA-256 dari byte gambar diperiksa. File identik, termasuk lintas chat, berbagi satu path; ZIP hanya memasukkan path tersebut sekali. Hash membandingkan byte, bukan kemiripan visual gambar dengan kompresi berbeda.

- Gambar tunggal, tanpa caption, dan setiap tile album/grid yang tersedia di DOM diproses terpisah. Aktifkan ekspor gambar untuk menyimpan file. Representasi gambar dan background pada tile yang sama tidak disimpan dua kali.
- Video menghasilkan teks caption saja, tanpa file video, poster, atau metadata media. Durasi/jam pesan tidak digunakan sebagai caption. Poster video dikenali lewat elemen `<video>` maupun tombol putar/penanda GIF, sehingga video yang posternya belum dimuat penuh tetap tidak diekspor sebagai foto.
- Link dengan preview menghasilkan URL saja, tanpa judul/deskripsi preview atau thumbnail. Gambar dengan URL pada caption tetap diperlakukan sebagai gambar. Foto asli yang dikirim bersama tautan berpreview tetap diekspor karena penyaringan dilakukan per kandidat, bukan mematikan seluruh bubble.

### Thumbnail yang dikecualikan

Hanya foto yang benar-benar dikirim pengguna yang diekspor. Empat jenis thumbnail berikut tidak pernah masuk antrean:

| Jenis | Cara dikenali |
| --- | --- |
| Thumbnail video/GIF | Elemen `<video>`, ikon `play`/`video`/`gif`, atau label Play/Putar |
| Thumbnail dokumen/PDF | Atribut `download`, ikon dokumen/pdf/sheet/slide, ekstensi berkas (`.pdf`, `.docx`, `.xlsx`, `.zip`, dll.), atau pola teks kartu dokumen seperti `12 halaman` / `2,4 MB` |
| Thumbnail balasan (quoted) | Pembungkus `quoted`/`quoted-mention`, `blockquote`, atau label `Dikutip`/`Balasan` — tidak lagi bergantung pada `data-testid` yang sudah banyak dihapus WhatsApp |
| Thumbnail link preview | Kartu `link-preview`/`url-preview` berbasis `data-testid` maupun penanda kelas, serta gambar di dalam pembungkus `<a href>` |

Sebagai lapis tambahan, gambar yang labelnya mengandung `thumbnail`, `preview`, `pratinjau`, `document`, `dokumen`, `pdf`, atau penanda avatar/foto profil selalu dibuang. Deteksi dokumen dan video dievaluasi **sebelum** deteksi gambar agar preview halaman pertama PDF tidak pernah diklasifikasikan sebagai foto.

- Album yang menyembunyikan gambar di balik indikator `+N` masih bergantung pada tile yang dimuat WhatsApp Web; gambar yang belum tersedia di DOM tidak dapat dijamin ikut tersimpan.
- Pengujian aturan media: jalankan `node --test` dengan berkas `C:\Users\fairu\Downloads\WhatsApp-web-Scraping\tests\media-extraction.test.js` (Node.js, tanpa dependensi tambahan).

## Catatan

WhatsApp Web memakai DOM virtual dan bukan API publik. Label membership dapat berbeda antar bahasa/rollout. v0.9.2 mengenali label English/Indonesia umum dan juga mengecek aksi Join/Request sebagai guard tambahan. Jika UI WhatsApp mengubah istilah lagi, scanner mungkin perlu pembaruan.
