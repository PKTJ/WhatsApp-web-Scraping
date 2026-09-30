(() => {
  "use strict";

  const chatRegistry = new Map();
  const anonymousMediaIds = new WeakMap();
  let scanGeneration = 0;
  let exportInProgress = false;
  let scanInProgress = false;
  // Permintaan STOP dari panel. Loop scroll, antrean gambar, dan queue chat
  // memeriksa flag ini di titik aman lalu keluar lebih awal supaya data yang
  // sudah terkumpul tetap diekspor, bukan dibuang.
  let stopRequested = false;

  function requestStop() {
    if (!exportInProgress && !scanInProgress) return false;
    stopRequested = true;
    return true;
  }

  function isStopRequested() {
    return stopRequested;
  }

  async function waitUntil(predicate, timeoutMs = 2_500, intervalMs = 120) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      let value = null;

      try {
        value = predicate();
      } catch (_error) {
        value = null;
      }

      if (value) return value;

      await sleep(intervalMs);
    }

    return null;
  }

  function dispatchEscapeEvent() {
    const options = {
      key: "Escape",
      code: "Escape",
      keyCode: 27,
      which: 27,
      bubbles: true,
      cancelable: true,
      composed: true
    };

    for (const target of [window, document, document.body]) {
      try {
        target.dispatchEvent(new KeyboardEvent("keydown", options));
      } catch (_error) {
        // Abaikan.
      }
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "STOP_EXPORT") {
      const accepted = requestStop();
      sendResponse({
        ok: accepted,
        error: accepted ? null : "Tidak ada proses yang sedang berjalan."
      });
      return undefined;
    }

    if (message?.type === "GET_RUNTIME_STATE") {
      sendResponse({
        ok: true,
        export_in_progress: exportInProgress,
        scan_in_progress: scanInProgress,
        stop_requested: stopRequested
      });
      return undefined;
    }

    if (message?.type === "SCAN_ALL_CHATS") {
      if (scanInProgress) {
        sendResponse({ ok: false, error: "Pemindaian chat lain masih berlangsung." });
        return undefined;
      }

      if (exportInProgress) {
        sendResponse({ ok: false, error: "Tunggu proses ekspor selesai sebelum memindai chat." });
        return undefined;
      }

      scanInProgress = true;
      stopRequested = false;
      scanAllChats(message?.options || {})
        .then(sendResponse)
        .catch((error) =>
          sendResponse({ ok: false, error: normalizeError(error) })
        )
        .finally(() => {
          scanInProgress = false;
          stopRequested = false;
        });

      return true;
    }

    if (message?.type === "EXPORT_SELECTED_CHATS") {
      if (exportInProgress) {
        sendResponse({ ok: false, error: "Ekspor lain masih berlangsung." });
        return undefined;
      }

      if (scanInProgress) {
        sendResponse({ ok: false, error: "Tunggu pemindaian seluruh chat selesai sebelum mengekspor." });
        return undefined;
      }

      exportInProgress = true;
      stopRequested = false;

      exportSelectedChats(message.chatIds, message.options)
        .then(sendResponse)
        .catch((error) =>
          sendResponse({ ok: false, error: normalizeError(error) })
        )
        .finally(() => {
          exportInProgress = false;
          stopRequested = false;
        });

      return true;
    }

    return undefined;
  });

  async function scanAllChats(scanOptions = {}) {
    // v0.9.0: normalisasi titik awal. Sebelumnya hasil scan bergantung pada apakah
    // pengguna menekan Pindai dari Chats atau Communities. Sekarang selalu kembali
    // ke Chats terlebih dahulu, baru menjalankan pipeline All -> Groups -> Communities.
    const chatsReady = await ensureChatsNavigationForScan();
    if (!chatsReady || !document.querySelector("#pane-side")) {
      throw new Error(
        "Daftar Chats WhatsApp tidak berhasil dibuka. Pastikan WhatsApp Web sudah selesai dimuat."
      );
    }

    chatRegistry.clear();
    scanGeneration += 1;

    const state = {
      discovered: new Map(),
      scanOrder: 0,
      announcementsSkipped: 0,
      skippedAnnouncementKeys: new Set(),
      totalSteps: 0,
      reachedLimit: false,
      scanPasses: []
    };

    // Pass 1: paksa filter All bila tersedia supaya private chat tetap masuk.
    const switchedToAll = await switchChatFilter("all");
    if (switchedToAll) await sleep(500);
    await scanCurrentSidebarPass(state, "all");

     // Pass 2: filter Groups menampilkan subgroup Community sebagai row sidebar.
    // Penamaan NAMA GROUP (NAMA COMMUNITY) diekstrak dari geometri row ini.
    // Community traversal (panel Communities) DIHAPUS total — scan murni sidebar.
    const switchedToGroups = await switchChatFilter("groups");

    if (switchedToGroups) {
      await sleep(500);

      await scanCurrentSidebarPass(state, "groups", {
        progressPass: "groups",
        pageStepRatio: 0.78,
        renderWaitMs: 380,
        samplesPerViewport: 2
      });
    }

    // Kembalikan navigasi ke Chats/All agar sidebar pengguna konsisten dan proses
    // openChat berikutnya memiliki daftar chat umum sebagai titik awal.
    await restoreChatsNavigation();
    if (switchedToGroups) {
      await switchChatFilter("all");
    }
    await sleep(300);

    const scannedEntries = Array.from(state.discovered.values()).sort(compareScannedEntries);

    const {
      entries: withoutCommunityContainers,
      removedCount: communityContainersRemoved
    } = removeCommunityContainerEntries(scannedEntries);

    const {
      entries,
      mergedCount: postRepairMergedEntries
    } = mergeEquivalentScannedEntries(withoutCommunityContainers);

    for (const entry of entries) {
      chatRegistry.set(entry.id, entry);
    }

    const communityGroupCount = entries.filter(
      (entry) => entry.source_kind === "community_group"
    ).length;

    emitScanProgress({
      discoveredChats: entries.length,
      communityGroups: communityGroupCount,
      announcementsSkipped: state.announcementsSkipped,
      scanStep: state.totalSteps,
      scanPass: "completed",
      completed: true
    });

    return {
      ok: true,
      stopped_by_user: isStopRequested(),
      chats: entries.map(publicChatEntry),
      scan_stats: {
        discovered_chat_count: entries.length,
        community_group_count: communityGroupCount,
        announcements_skipped: state.announcementsSkipped,
        scan_steps_used: state.totalSteps,
        scan_passes: state.scanPasses,
        groups_filter_scanned: state.scanPasses.includes("groups"),
        groups_verification_pass: switchedToGroups,
        community_containers_removed: communityContainersRemoved,
        post_repair_merged_entries: postRepairMergedEntries,
        reached_scan_step_limit: state.reachedLimit
      }
    };
  }

  async function scanCurrentSidebarPass(state, scanPass, scanOptions = {}) {
    const pane = document.querySelector("#pane-side");
    if (!pane) {
      if (scanPass === "all") {
        throw new Error("Sidebar WhatsApp tidak ditemukan saat memindai filter All.");
      }
      return;
    }

    const scroller = findSidebarScroller(pane);
    if (!scroller) {
      if (scanPass === "all") {
        throw new Error("Area scroll daftar chat WhatsApp tidak ditemukan.");
      }
      return;
    }

    if (!state.scanPasses.includes(scanPass)) {
      state.scanPasses.push(scanPass);
    }

    const progressPass = scanOptions.progressPass || scanPass;
    const pageStepRatio = Math.min(0.9, Math.max(0.3, Number(scanOptions.pageStepRatio || 0.68)));
    const renderWaitMs = Math.min(1_500, Math.max(300, Number(scanOptions.renderWaitMs || 460)));
    const samplesPerViewport = Math.min(4, Math.max(1, Number(scanOptions.samplesPerViewport || 1)));

    const originalTop = scroller.scrollTop;
    let step = 0;
    let stableBottomRounds = 0;
    const maxScanSteps = 1800;

    try {
      scroller.scrollTop = 0;
      await waitForSidebarRender(scroller, 550);

      while (step < maxScanSteps) {
        // Titik henti saat memindai sidebar: chat yang sudah ditemukan tetap
        // dipertahankan sehingga daftar hasil scan tidak hilang.
        if (isStopRequested()) break;

        const currentTop = Math.max(0, scroller.scrollTop);

        // Community rows pada WhatsApp Web memakai virtualized DOM. Pada satu
        // render frame hanya sebagian child-row dapat tersedia. Sampling ulang
        // viewport yang sama sebelum bergerak membuat scan jauh lebih deterministik.
        for (let sample = 0; sample < samplesPerViewport; sample += 1) {
          if (sample > 0) await sleep(180 + sample * 70);
          const scanCandidates = findChatScanCandidates(pane, scanPass);
          const viewportDescriptors = buildViewportScanDescriptors(scanCandidates, scanPass);

          for (const item of viewportDescriptors) {
            const row = item.row;
            const descriptor = item.descriptor;
            if (!descriptor.name || descriptor.is_community_container) continue;

            if (descriptor.is_announcement) {
              if (!state.skippedAnnouncementKeys.has(descriptor.identity_key)) {
                state.skippedAnnouncementKeys.add(descriptor.identity_key);
                state.announcementsSkipped += 1;
              }
              continue;
            }

            const existing = findMatchingScannedEntry(
              state.discovered,
              descriptor,
              currentTop,
              scroller.clientHeight
            );

            if (!existing) {
              const id = `scan-${scanGeneration}-chat-${state.scanOrder}`;
              const entry = {
                id,
                name: descriptor.name,
                preview: descriptor.preview,
                community_name: descriptor.community_name,
                source_kind: descriptor.source_kind,
                identity_key: descriptor.identity_key,
                alias_signature: descriptor.alias_signature || "",
                title_aliases: descriptor.title_aliases || [],
                discovered_via: scanPass,
                discovered_via_all: scanPass === "all",
                discovered_via_groups_filter: scanPass === "groups",
                scan_positions: { [scanPass]: currentTop },
                scan_top: currentTop,
                scan_order: state.scanOrder,
                first_scan_pass: scanPass,
                scan_pass_rank: scanPass === "all" ? 0 : scanPass === "groups" ? 1 : 2
              };
              state.discovered.set(id, entry);
              state.scanOrder += 1;
            } else {
              if (!existing.preview && descriptor.preview) {
                existing.preview = descriptor.preview;
              }
              existing.title_aliases = Array.from(new Set([
                ...(existing.title_aliases || []),
                ...(descriptor.title_aliases || [])
              ].filter(Boolean)));
              existing.alias_signature = buildAliasSignature(existing.title_aliases);
              if (!existing.community_name && descriptor.community_name) {
                existing.community_name = descriptor.community_name;
                existing.source_kind = "community_group";
              }
              // Jika sebuah group pertama kali ditemukan lewat All lalu kembali
              // muncul pada filter Groups, simpan fakta ini untuk pencarian ulang.
              if (scanPass === "groups") {
                existing.discovered_via_groups_filter = true;
              } else if (scanPass === "all") {
                existing.discovered_via_all = true;
              }
              existing.scan_positions = {
                ...(existing.scan_positions || {}),
                [scanPass]: Math.min(
                  Number.isFinite(existing.scan_positions?.[scanPass])
                    ? existing.scan_positions[scanPass]
                    : currentTop,
                  currentTop
                )
              };
              existing.scan_top = Math.min(existing.scan_top, currentTop);
            }
          }
        }

        const communityGroups = Array.from(state.discovered.values()).filter(
          (entry) => entry.source_kind === "community_group"
        ).length;

        emitScanProgress({
          discoveredChats: state.discovered.size,
          communityGroups,
          announcementsSkipped: state.announcementsSkipped,
          scanStep: state.totalSteps + step,
          scanPass: progressPass
        });

        const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const atBottom = scroller.scrollTop >= maxTop - 4;

        if (atBottom) {
          const beforeHeight = scroller.scrollHeight;
          const grew = await waitForSidebarGrowth(scroller, beforeHeight, 1_800);

          if (grew) {
            stableBottomRounds = 0;
            step += 1;
            continue;
          }

          stableBottomRounds += 1;
          if (stableBottomRounds >= 3) break;

          await sleep(450);
          step += 1;
          continue;
        }

        stableBottomRounds = 0;
        // Overlap lebih besar daripada versi lama agar row Community yang berada
        // di batas viewport tidak terlewat saat virtual list mengganti node.
        const pageStep = Math.max(160, Math.floor(scroller.clientHeight * pageStepRatio));
        const nextTop = Math.min(maxTop, scroller.scrollTop + pageStep);
        scroller.scrollTop = nextTop;
        await waitForSidebarRender(scroller, renderWaitMs);
        step += 1;
      }
    } finally {
      state.totalSteps += step;
      if (step >= maxScanSteps) state.reachedLimit = true;
      if (scroller.isConnected) {
        scroller.scrollTop = Math.min(
          originalTop,
          Math.max(0, scroller.scrollHeight - scroller.clientHeight)
        );
        await waitForSidebarRender(scroller, 220);
      }
    }
  }


  // ---------------------------------------------------------------------------
  // v0.8.9 — Dedicated Community traversal
  // ---------------------------------------------------------------------------
  // Audit + public implementations show that a Community is not reliably a flat
  // chat-list concept. Group metadata models expose an explicit parent relation
  // (linkedParent) and a dedicated announcement flag. DOM-only scanning therefore
  // needs an explicit Communities-panel pass instead of assuming the Groups filter
  // always renders every subgroup as a normal #pane-side row.


  function findPrimaryNavigationControl(kind) {
    const wanted = kind === "communities"
      ? /(?:^|\b)(communities|community|komunitas)(?:$|\b)/i
      : /(?:^|\b)(chats?|chat)(?:$|\b)/i;
    const iconWanted = kind === "communities"
      ? /community|communities/i
      : /chat/i;

    const candidates = Array.from(
      document.querySelectorAll('button, [role="button"], [role="tab"], [tabindex]')
    ).filter((element) => element instanceof HTMLElement && isVisible(element));

    let best = null;
    let bestScore = -Infinity;
    for (const element of candidates) {
      const rect = element.getBoundingClientRect();
      if (rect.left > 145 || rect.width > 150 || rect.height > 120 || rect.height < 24) continue;

      const semantic = cleanText([
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("data-testid"),
        element.getAttribute("data-icon"),
        ...Array.from(element.querySelectorAll('[aria-label], [title], [data-icon], [data-testid]'))
          .slice(0, 12)
          .flatMap((child) => [
            child.getAttribute("aria-label"),
            child.getAttribute("title"),
            child.getAttribute("data-icon"),
            child.getAttribute("data-testid")
          ])
      ].filter(Boolean).join(" | "));
      const direct = directVisibleText(element);
      const matches = wanted.test(semantic) || wanted.test(direct) || iconWanted.test(semantic);
      if (!matches) continue;

      const leftRailBonus = rect.left < 85 ? 120 : 0;
      const iconBonus = iconWanted.test(semantic) ? 60 : 0;
      const labelBonus = wanted.test(semantic) ? 45 : 0;
      const score = leftRailBonus + iconBonus + labelBonus - rect.width / 10;
      if (score > bestScore) {
        best = element;
        bestScore = score;
      }
    }
    return best;
  }

  async function ensureChatsNavigationForScan() {
    // Deteksi "surface chat sudah siap". Jangan bergantung hanya pada filter
    // "all" — pada beberapa build/keadaan loading filter itu belum dirender
    // walau sidebar chat sudah ada. Cukup andalkan #pane-side + setidaknya ada
    // satu row chat atau scroller yang bisa di-scroll.
    const hasChatSurface = () => {
      const pane = document.querySelector("#pane-side");
      if (!(pane instanceof HTMLElement) || !isVisible(pane)) return false;
      const rows = pane.querySelectorAll('[role="listitem"], span[title]');
      if (rows.length > 0) return true;
      const scroller = findSidebarScroller(pane);
      return Boolean(scroller && scroller.scrollHeight > 0);
    };

    // Tunggu WhatsApp Web menyelesaikan render awal (maks ~15 detik) sebelum
    // menyimpulkan gagal. Ini menangani klik Pindai yang terlalu cepat.
    const initialDeadline = Date.now() + 15_000;
    while (Date.now() < initialDeadline) {
      if (hasChatSurface()) return true;
      await sleep(200);
    }

    if (hasChatSurface()) return true;

    const chatNav = findPrimaryNavigationControl("chats");
    if (chatNav) {
      activateChatTarget(chatNav);
      const deadline = Date.now() + 4_500;
      while (Date.now() < deadline) {
        await sleep(140);
        if (hasChatSurface()) return true;
      }
    }

    // Fallback untuk rollout yang memberi label Chats hanya pada descendant icon.
    for (const anchor of findTextAnchors(/^(chats?|chat)$/i)) {
      const target = anchor.closest('button, [role="button"], [role="tab"], [tabindex]') || anchor;
      if (!(target instanceof HTMLElement) || !isVisible(target)) continue;
      activateChatTarget(target);
      const deadline = Date.now() + 2_800;
      while (Date.now() < deadline) {
        await sleep(140);
        if (hasChatSurface()) return true;
      }
    }

    return hasChatSurface();
  }

  async function restoreChatsNavigation() {
    const chatNav = findPrimaryNavigationControl("chats");
    if (!chatNav) return false;
    activateChatTarget(chatNav);
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      await sleep(120);
      if (document.querySelector("#pane-side")) return true;
    }
    return Boolean(document.querySelector("#pane-side"));
  }

  function directVisibleText(element) {
    if (!(element instanceof HTMLElement)) return "";
    return cleanText(
      Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || "")
        .join(" ")
    );
  }

  function findPanelFromAnchor(anchor, { minHeight = 220, maxWidth = 720 } = {}) {
    let current = anchor instanceof HTMLElement ? anchor : null;
    let best = null;
    for (let depth = 0; current && current !== document.body && depth < 14; depth += 1) {
      const rect = current.getBoundingClientRect();
      if (
        rect.height >= minHeight &&
        rect.width >= 220 &&
        rect.width <= maxWidth &&
        rect.left < Math.max(760, window.innerWidth * 0.62)
      ) {
        best = current;
      }
      current = current.parentElement;
    }
    return best;
  }

  function findTextAnchors(pattern) {
    const anchors = [];
    for (const element of document.querySelectorAll('span, div, p, button, [role="button"], [aria-label], [title]')) {
      if (!(element instanceof HTMLElement) || !isVisible(element)) continue;
      const values = [
        directVisibleText(element),
        cleanText(element.getAttribute("aria-label")),
        cleanText(element.getAttribute("title")),
        cleanText(element.getAttribute("data-testid")),
        cleanText(element.getAttribute("data-icon"))
      ].filter(Boolean);
      if (values.some((value) => {
        pattern.lastIndex = 0;
        return pattern.test(value);
      })) anchors.push(element);
    }
    return anchors;
  }

  function panelLooksLikeCommunityDetail(panel) {
    if (!(panel instanceof HTMLElement) || !isVisible(panel)) return false;
    const semantic = cleanText([
      panel.getAttribute("aria-label"),
      panel.getAttribute("title"),
      ...Array.from(panel.querySelectorAll('[aria-label], [title], [data-icon], [data-testid]'))
        .slice(0, 80)
        .flatMap((element) => [
          element.getAttribute("aria-label"),
          element.getAttribute("title"),
          element.getAttribute("data-icon"),
          element.getAttribute("data-testid")
        ])
    ].filter(Boolean).join(" | "));
    const visible = cleanText(panel.innerText || "");
    // Marker detail Community diperluas agar panel detail tidak disangka index.
    return /(?:add group|tambahkan grup|view community|lihat komunitas|subgroup switcher|groups? you(?:'|’)?re in|groups? you are in|groups? you can join|other groups?|grup yang anda ikuti|grup yang kamu ikuti|grup yang bisa anda ikuti|grup yang dapat anda ikuti|arrow-left|back|kembali)/i.test(
      `${semantic} | ${visible}`
    );
  }

  function panelHasCommunitiesHeading(panel) {
    if (!(panel instanceof HTMLElement)) return false;
    const text = cleanText(panel.innerText || "");
    return /^(communities|komunitas)$/im.test(text);
  }

  function findCommunityListPanel() {
    const anchors = findTextAnchors(/^(communities|komunitas)$/i);
    const candidates = anchors
      .map((anchor) => findPanelFromAnchor(anchor, { minHeight: 280, maxWidth: 700 }))
      .filter(Boolean)
      .filter((panel) => !panel.querySelector("#main"))
      .filter((panel) => !panelLooksLikeCommunityDetail(panel))
      .filter((panel) => {
        const rows = findCommunityIndexRows(panel).length;
        return rows > 0 || panelHasCommunitiesHeading(panel);
      });
    candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const aRows = findCommunityIndexRows(a).length;
      const bRows = findCommunityIndexRows(b).length;
      return bRows - aRows || ar.width * ar.height - br.width * br.height;
    });
    return candidates[0] || null;
  }

  async function waitForCommunityListPanel(timeoutMs = 3_500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const panel = findCommunityListPanel();
      if (panel) return panel;
      await sleep(140);
    }
    return findCommunityListPanel();
  }

  function findVisibleCommunityDetailPanels() {
    const anchors = findTextAnchors(
      /^(add group|tambahkan grup|announcements?|pengumuman|view community|lihat komunitas|groups? you(?:'|’)?re in|groups? you are in|groups? you can join|other groups?|grup yang anda ikuti|grup yang kamu ikuti|grup yang bisa anda ikuti|grup yang dapat anda ikuti)$/i
    );

    const panels = [];

    for (const anchor of anchors) {
      const panel = findPanelFromAnchor(anchor, { minHeight: 260, maxWidth: 760 });

      if (!panel || !isVisible(panel)) continue;

      const rect = panel.getBoundingClientRect();

      if (rect.height < 260 || rect.width < 220) continue;

      panels.push(panel);
    }

    return uniqueElements(panels).filter((panel) => {
      return !panels.some((other) => other !== panel && panel.contains(other));
    });
  }

  function findLikelyOpenCommunityDetailPanel() {
    const panels = findVisibleCommunityDetailPanels();

    return panels.find((panel) => panelLooksLikeCommunityDetail(panel)) || null;
  }
  
  function findCommunityDetailPanel(expectedName = null) {
    const expected = normalizeComparable(expectedName || "");
    const panels = findVisibleCommunityDetailPanels();
    if (!expected) return panels[0] || null;

    // Strict match. v0.9.0 returned panels[0] when the expected Community did not
    // match, which made an old/stale detail panel look like a successful navigation.
    const exact = panels.find((panel) => {
      const title = normalizeComparable(extractCommunityPanelTitle(panel) || "");
      if (title === expected) return true;
      const rect = panel.getBoundingClientRect();
      const headerTokens = getVisualTextTokensInRect({
        top: rect.top,
        bottom: Math.min(rect.bottom, rect.top + 150),
        left: rect.left,
        right: rect.right,
        width: rect.width,
        height: Math.min(150, rect.height)
      }, panel).map((token) => normalizeComparable(token.text || ""));
      return headerTokens.includes(expected);
    });
    return exact || null;
  }

  async function waitForCommunityDetailPanel(expectedName, timeoutMs = 3_500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const panel = findCommunityDetailPanel(expectedName);
      if (panel) return panel;
      await sleep(140);
    }
    return findCommunityDetailPanel(expectedName);
  }

  function findPanelScroller(panel) {
    if (!(panel instanceof HTMLElement)) return null;
    const candidates = [panel, ...panel.querySelectorAll('div')]
      .filter((element) => element instanceof HTMLElement && isVisible(element));
    let best = null;
    let bestScore = -Infinity;
    for (const candidate of candidates) {
      const range = candidate.scrollHeight - candidate.clientHeight;
      if (candidate.clientHeight < 160 || range < 25) continue;
      const rect = candidate.getBoundingClientRect();
      const overflow = getComputedStyle(candidate).overflowY;
      const score = range + (/auto|scroll|overlay/.test(overflow) ? 1_000_000 : 0) + rect.height;
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  }

  function getVisualTextTokensInRect(rect, boundary) {
    const boundaryRect = boundary.getBoundingClientRect();
    const tokens = [];
    const seen = new Map();
    const selector = 'span, div, p, button, [aria-label], [title]';

    for (const element of boundary.querySelectorAll(selector)) {
      if (!(element instanceof HTMLElement) || !isVisible(element)) continue;
      const er = element.getBoundingClientRect();
      const centerY = (er.top + er.bottom) / 2;
      if (centerY < rect.top - 2 || centerY > rect.bottom + 2) continue;
      if (er.right <= rect.left || er.left >= rect.right) continue;
      if (er.bottom <= boundaryRect.top || er.top >= boundaryRect.bottom) continue;

      const values = [
        directVisibleText(element),
        cleanText(element.getAttribute("aria-label")),
        cleanText(element.getAttribute("title"))
      ].filter(Boolean);

      for (const text of values) {
        if (!text || text.length > 160) continue;
        const key = normalizeComparable(text);
        if (!key || isLikelySidebarMetadata(text) || isScannerControlTitle(text)) continue;
        const style = getComputedStyle(element);
        const fontSize = Number.parseFloat(style.fontSize) || 0;
        const weightRaw = Number.parseInt(style.fontWeight, 10);
        const weight = Number.isFinite(weightRaw) ? weightRaw : /bold/i.test(style.fontWeight) ? 700 : 400;
        const upper = centerY <= rect.top + rect.height * 0.72;
        const score = fontSize * 3 + Math.min(weight, 800) / 18 + (upper ? 28 : 0) + (weight >= 500 ? 25 : 0);
        const previous = seen.get(key);
        if (!previous || score > previous.score) {
          seen.set(key, { text: cleanText(text), score, top: er.top, left: er.left, upper });
        }
      }
    }

    tokens.push(...seen.values());
    tokens.sort((a, b) => a.top - b.top || a.left - b.left || b.score - a.score);
    return tokens;
  }

  function findVisualRowsInPanel(panel) {
    const panelRect = panel.getBoundingClientRect();
    const candidates = [];

    const explicit = Array.from(panel.querySelectorAll('[role="listitem"], [role="row"], [role="button"], [tabindex]'));
    for (const element of explicit) {
      if (!(element instanceof HTMLElement) || !isVisible(element)) continue;
      const rect = element.getBoundingClientRect();
      if (
        rect.height >= 36 && rect.height <= 128 &&
        rect.width >= Math.max(130, panelRect.width * 0.42) &&
        rect.top >= panelRect.top + 36 && rect.bottom <= panelRect.bottom + 2
      ) {
        candidates.push(element);
      }
    }

    // Geometry fallback: start from strong visible text and walk up to a row-sized
    // ancestor. This covers child labels rendered outside the span[title] wrapper.
    for (const element of panel.querySelectorAll('span, div, p')) {
      if (!(element instanceof HTMLElement) || !isVisible(element)) continue;
      const text = directVisibleText(element);
      if (!text || text.length > 120 || isLikelySidebarMetadata(text)) continue;
      let current = element;
      for (let depth = 0; current && current !== panel && depth < 9; depth += 1) {
        const rect = current.getBoundingClientRect();
        if (
          rect.height >= 36 && rect.height <= 128 &&
          rect.width >= Math.max(130, panelRect.width * 0.42)
        ) {
          candidates.push(current);
          break;
        }
        current = current.parentElement;
      }
    }

    const unique = uniqueElements(candidates);
    return unique
      .filter((row) => !unique.some((other) => {
        if (other === row || !row.contains(other)) return false;
        const rr = row.getBoundingClientRect();
        const or = other.getBoundingClientRect();
        const similarBand = Math.abs(rr.top - or.top) < 4 && Math.abs(rr.bottom - or.bottom) < 4;
        return similarBand;
      }))
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  }

  function extractCommunityPanelTitle(panel) {
    if (!(panel instanceof HTMLElement)) return null;
    const rect = panel.getBoundingClientRect();
    const tokens = getVisualTextTokensInRect({
      top: rect.top,
      bottom: Math.min(rect.bottom, rect.top + 150),
      left: rect.left,
      right: rect.right,
      width: rect.width,
      height: Math.min(150, rect.height)
    }, panel)
      .filter((token) => !isScannerControlTitle(token.text))
      .filter((token) => !isAnnouncementName(token.text))
      .filter((token) => !/^(communities|komunitas)$/i.test(token.text));
    tokens.sort((a, b) => b.score - a.score || a.top - b.top);
    return tokens[0]?.text || null;
  }

  function isAnnouncementVisualRow(row, tokens = []) {
    if (tokens.some((token) => isAnnouncementName(token.text))) return true;
    const semantic = cleanText([
      row.getAttribute?.("aria-label"),
      row.getAttribute?.("title"),
      row.innerText,
      ...Array.from(row.querySelectorAll?.('[aria-label], [title], [data-icon], [data-testid]') || [])
        .slice(0, 30)
        .flatMap((element) => [
          element.getAttribute?.("aria-label"),
          element.getAttribute?.("title"),
          element.getAttribute?.("data-icon"),
          element.getAttribute?.("data-testid")
        ])
    ].filter(Boolean).join(" | "));
    return /announcement|pengumuman|megaphone/i.test(semantic);
  }

  function chooseCommunityChildFromTokens(tokens, communityName) {
    const communityKey = normalizeComparable(communityName || "");
    const candidates = tokens
      .filter((token) => token.text)
      .filter((token) => normalizeComparable(token.text) !== communityKey)
      .filter((token) => !isScannerControlTitle(token.text))
      .filter((token) => !isCommunitySectionHeading(token.text))
      .filter((token) => !isLikelyCommunityPreviewLine(token.text))
      .filter((token) => !/^(communities|komunitas|new community|komunitas baru)$/i.test(token.text));

    const announcement = candidates.find((token) => isAnnouncementName(token.text));
    if (announcement) return announcement.text;

    const strong = [...candidates].sort((a, b) => {
      const upperDiff = Number(b.upper) - Number(a.upper);
      return upperDiff || b.score - a.score || a.top - b.top;
    });
    return strong[0]?.text || null;
  }

  function classifyCommunitySectionHeading(text) {
    const value = normalizeComparable(text || "")
      .replace(/\s*\(\d+\)\s*$/, "")
      .replace(/\s+[·•-]?\s*\d+\s*$/, "")
      .trim();
    if (!value) return null;

    // WhatsApp membedakan subgroup yang sudah diikuti dan subgroup yang hanya
    // tersedia untuk di-join. Public UI saat ini memakai label seperti
    // "Groups you're in" dan "Groups you can join" / "Other groups".
    if (/^(groups? you(?:'|’)?re in|groups? you are in|groups? you(?:'|’)?re a part of|groups? you are a part of|grup yang anda ikuti|grup yang kamu ikuti|grup anda|grup yang diikuti)$/.test(value)) {
      return "active";
    }
    if (/^(groups? you can join|other groups?|other groups? in the community|groups? available to join|grup yang dapat anda ikuti|grup yang bisa anda ikuti|grup lain|grup lainnya|grup lain di komunitas)$/.test(value)) {
      return "inactive";
    }
    return null;
  }

  function isCommunitySectionHeading(text) {
    return Boolean(classifyCommunitySectionHeading(text));
  }


  function findCommunityIndexRows(panel) {
    return findVisualRowsInPanel(panel).filter((row) => {
      const rect = row.getBoundingClientRect();
      const tokens = getVisualTextTokensInRect(rect, panel);
      const name = chooseCommunityIndexNameFromTokens(tokens);
      return Boolean(name);
    });
  }

  function chooseCommunityIndexNameFromTokens(tokens) {
    const candidates = tokens
      .filter((token) => token.text)
      .filter((token) => !isScannerControlTitle(token.text))
      .filter((token) => !isLikelyCommunityPreviewLine(token.text))
      .filter((token) => !/^(communities|komunitas|new community|komunitas baru|create community|buat komunitas|back|kembali|navigation menu|menu navigasi|close|tutup)$/i.test(token.text));
    candidates.sort((a, b) => Number(b.upper) - Number(a.upper) || b.score - a.score || a.top - b.top);
    return candidates[0]?.text || null;
  }

  function extractCommunityIndexName(row, panel) {
    const tokens = getVisualTextTokensInRect(row.getBoundingClientRect(), panel);
    return chooseCommunityIndexNameFromTokens(tokens);
  }

  // ===========================================================================
  // Helper back / recovery Community yang lebih aman
  // ===========================================================================

  
  async function switchChatFilter(kind) {
    const control = findChatFilterControl(kind);
    if (!control) return false;

    if (isChatFilterSelected(control)) return true;

    control.click();

    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      await sleep(120);
      const refreshed = findChatFilterControl(kind);
      if (refreshed && isChatFilterSelected(refreshed)) return true;
    }

    // Sebagian build WhatsApp tidak mengekspos state selected. Jika kontrol ada
    // dan sudah diklik, tetap anggap perpindahan berhasil setelah render timeout.
    return true;
  }

  function findChatFilterControl(kind) {
    const labels = kind === "groups"
      ? new Set(["groups", "group", "grup", "grups", "group chats", "chat grup"])
      : new Set(["all", "semua"]);
    const pane = document.querySelector("#pane-side");
    const paneRect = pane?.getBoundingClientRect();

    const candidates = Array.from(
      document.querySelectorAll('button, [role="button"], [role="tab"], [tabindex]')
    ).filter(isVisible);

    return candidates.find((element) => {
      const rect = element.getBoundingClientRect();
      if (paneRect) {
        const horizontallyAligned =
          rect.right >= paneRect.left && rect.left <= paneRect.right;
        const nearFilterBand =
          rect.top >= paneRect.top - 140 && rect.bottom <= paneRect.top + 90;
        if (!horizontallyAligned || !nearFilterBand) return false;
      }

      const texts = [
        cleanText(element.innerText),
        cleanText(element.getAttribute("aria-label")),
        cleanText(element.getAttribute("title"))
      ]
        .map(normalizeComparable)
        .filter(Boolean);

      return texts.some((text) => labels.has(text));
    }) || null;
  }

  function isChatFilterSelected(control) {
    if (!control) return false;
    const ariaPressed = control.getAttribute("aria-pressed");
    const ariaSelected = control.getAttribute("aria-selected");
    const dataState = normalizeComparable(control.getAttribute("data-state"));
    const className = normalizeComparable(String(control.className || ""));

    return (
      ariaPressed === "true" ||
      ariaSelected === "true" ||
      dataState === "active" ||
      dataState === "selected" ||
      /(?:^|\s)(active|selected)(?:\s|$)/.test(className)
    );
  }

  function emitScanProgress({
    discoveredChats,
    communityGroups = 0,
    announcementsSkipped = 0,
    scanStep,
    scanPass = null,
    completed = false
  }) {
    try {
      const promise = chrome.runtime.sendMessage({
        type: "SCAN_PROGRESS",
        discovered_chat_count: discoveredChats,
        community_group_count: communityGroups,
        announcements_skipped: announcementsSkipped,
        scan_step: scanStep,
        scan_pass: scanPass,
        completed
      });
      promise?.catch?.(() => {});
    } catch (_error) {
      // Popup mungkin tertutup; pemindaian tetap boleh dilanjutkan.
    }
  }

  function findSidebarScroller(pane) {
    if (!(pane instanceof HTMLElement)) {
      return null;
    }

    const candidates = [pane, ...pane.querySelectorAll("div")].filter(
      (element) => element instanceof HTMLElement && isVisible(element)
    );

    let best = null;
    let bestScore = -1;

    for (const candidate of candidates) {
      const scrollRange = candidate.scrollHeight - candidate.clientHeight;
      if (candidate.clientHeight < 180 || scrollRange < 30) {
        continue;
      }

      const rect = candidate.getBoundingClientRect();
      const paneRect = pane.getBoundingClientRect();
      const overlapsPane =
        rect.bottom > paneRect.top &&
        rect.top < paneRect.bottom &&
        rect.right > paneRect.left &&
        rect.left < paneRect.right;

      if (!overlapsPane) continue;

      const overflowY = getComputedStyle(candidate).overflowY;
      const overflowBonus = /auto|scroll|overlay/.test(overflowY) ? 1_000_000 : 0;
      const widthBonus = Math.min(500, rect.width);
      const score = overflowBonus + scrollRange + widthBonus;

      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    return best || pane;
  }

  async function waitForSidebarRender(scroller, maxWaitMs = 450) {
    const start = Date.now();
    let lastTop = scroller.scrollTop;
    let stableRounds = 0;

    while (Date.now() - start < maxWaitMs) {
      await sleep(90);
      const currentTop = scroller.scrollTop;

      if (Math.abs(currentTop - lastTop) < 1) {
        stableRounds += 1;
        if (stableRounds >= 2) break;
      } else {
        stableRounds = 0;
      }

      lastTop = currentTop;
    }

    // Satu jeda kecil tambahan memberi React waktu mengganti baris virtual.
    await sleep(80);
  }

  async function waitForSidebarGrowth(scroller, previousHeight, timeoutMs) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await sleep(180);
      if (scroller.scrollHeight > previousHeight + 10) {
        return true;
      }
    }

    return false;
  }

  function findChatScanCandidates(pane, scanPass = "all") {
    // Audit v0.8.8: kembalikan prinsip scanner v0.8.0 yang terbukti mampu
    // menemukan SETIAP physical child-row Community. span[title] hanya dipakai
    // sebagai petunjuk untuk menemukan row, bukan sebagai identitas/nama chat.
    // Pada build pengguna, span[title] pada child-row justru berisi nama Community
    // yang sama, sedangkan nama subgroup tampil sebagai teks biasa.
    return findChatRows(pane, scanPass).map((row) => ({
      row,
      anchor_title: null
    }));
  }

  function isScannerControlTitle(text) {
    const value = normalizeComparable(text || "");
    return /^(add group|tambahkan grup|view community|lihat komunitas|subgroup switcher|ic-arrow-drop-down|profile details|groups?|grups?|all|semua|back|kembali|navigation menu|menu navigasi|close|tutup|communities|komunitas|new community|komunitas baru|create community|buat komunitas)$/.test(value);
  }

  function findChatRows(pane) {
    const roleRows = Array.from(pane.querySelectorAll('[role="listitem"]'))
      .filter((row) => isLikelyChatRow(row) && isInsidePaneViewport(row, pane));

    // Jangan memakai roleRows sebagai satu-satunya sumber. Pada tampilan
    // Community WhatsApp, beberapa child-group dapat memakai wrapper interaktif
    // tanpa role=listitem. Versi lama berhenti setelah menemukan roleRows dan
    // akibatnya row child-group tersebut tidak pernah ikut dipindai.
    const inferredRows = [];
    for (const titleSpan of pane.querySelectorAll("span[title]")) {
      if (!isVisible(titleSpan)) continue;
      const row = findRowAncestor(titleSpan, pane);
      if (
        row &&
        isLikelyChatRow(row) &&
        isInsidePaneViewport(row, pane)
      ) {
        inferredRows.push(row);
      }
    }

    return uniqueElements([...roleRows, ...inferredRows])
      .filter((row) => !isNestedDuplicateRow(row, [...roleRows, ...inferredRows]))
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.top - br.top || ar.left - br.left;
      });
  }

  function isNestedDuplicateRow(row, allRows) {
    // Bila dua kandidat mewakili area yang hampir sama, pertahankan wrapper
    // interaktif yang paling dekat dengan judul. Ini penting untuk nested group
    // di Community supaya parent-card tidak menelan beberapa child-group.
    const rr = row.getBoundingClientRect();
    return allRows.some((other) => {
      if (other === row || !row.contains(other)) return false;
      const or = other.getBoundingClientRect();
      const sameFootprint =
        Math.abs(or.top - rr.top) < 3 &&
        Math.abs(or.bottom - rr.bottom) < 3 &&
        Math.abs(or.left - rr.left) < 3 &&
        Math.abs(or.right - rr.right) < 3;
      return sameFootprint;
    });
  }

  function isInsidePaneViewport(element, pane) {
    const rectangle = element.getBoundingClientRect();
    const paneRectangle = pane.getBoundingClientRect();

    return (
      rectangle.bottom > paneRectangle.top + 1 &&
      rectangle.top < paneRectangle.bottom - 1 &&
      rectangle.right > paneRectangle.left + 1 &&
      rectangle.left < paneRectangle.right - 1
    );
  }

  function findRowAncestor(element, boundary) {
    let current = element;

    for (let depth = 0; current && current !== boundary && depth < 12; depth += 1) {
      const rectangle = current.getBoundingClientRect();
      const hasReasonableSize =
        rectangle.width >= 180 && rectangle.height >= 38 && rectangle.height <= 150;
      const isInteractive =
        current.matches('[role="listitem"], [role="button"], [tabindex], [data-tab]') ||
        getComputedStyle(current).cursor === "pointer";

      // Versi lama menyimpan ancestor terakhir/terluar. Pada Community hal itu
      // dapat membuat beberapa child-group menunjuk ke parent container yang sama.
      // Ambil ancestor interaktif TERDEKAT agar tiap subgroup tetap menjadi row.
      if (hasReasonableSize && isInteractive) {
        return current;
      }

      current = current.parentElement;
    }

    return null;
  }

  function isLikelyChatRow(row) {
    if (!(row instanceof HTMLElement) || !isVisible(row)) {
      return false;
    }

    const rectangle = row.getBoundingClientRect();
    const hasTitle = Boolean(extractChatName(row));

    return (
      hasTitle &&
      rectangle.width >= 180 &&
      rectangle.height >= 38 &&
      rectangle.height <= 150
    );
  }

  function buildViewportScanDescriptors(scanCandidates, scanPass = "all") {
    if (scanPass !== "groups") {
      return scanCandidates.map((candidate) => ({
        row: candidate.row,
        descriptor: extractChatDescriptor(
          candidate.row,
          scanPass,
          candidate.anchor_title || null
        )
      }));
    }

    // v0.8.8 hybrid scanner:
    // 1) physical row discovery = perilaku v0.8.0 yang terbukti lengkap;
    // 2) identity/name = visible row text, bukan span[title] Community yang berulang.
    const rawItems = scanCandidates.map((candidate) => {
      const row = candidate.row;
      const base = extractChatDescriptor(row, "all", null);
      const localName = inferCommunityChildNameFromRow(row, base.name);
      return {
        row,
        base,
        localName,
        localNameStrong: isStrongCommunityChildLabel(row, base.name, localName),
        hasCommunityContext: hasCommunityContextAroundRow(row)
      };
    });

    const repeatedBaseNames = new Map();
    for (const item of rawItems) {
      const key = normalizeComparable(item.base.name || "");
      if (!key) continue;
      repeatedBaseNames.set(key, (repeatedBaseNames.get(key) || 0) + 1);
    }

    return rawItems.map((item) => {
      const baseName = cleanText(item.base.name);
      const baseKey = normalizeComparable(baseName);
      const localName = cleanText(item.localName);
      const localKey = normalizeComparable(localName);
      const repeatedPhysicalRows = (repeatedBaseNames.get(baseKey) || 0) >= 2;
      const hasDistinctLocalName = Boolean(localKey && localKey !== baseKey);

      // FIX utama untuk kasus "semua subgroup bernama Community":
      // Pada pass Groups, sebuah row yang punya label LOKAL (nama subgroup dari
      // teks biasa) yang berbeda dari base name (nama Community dari span[title])
      // adalah subgroup. Jangan lagi bergantung pada hasCommunityContextAroundRow
      // (rapuh, bergantung pada kontrol Community di ancestor). Kunci keputusan:
      // - jika nama terulang di banyak physical row (repeatedPhysicalRows), pasti
      //   ini adalah Community + subgroup; pakai nama lokal.
      // - jika ada konteks Community, juga pakai nama lokal.
      // - jika tidak ada nama lokal yang berbeda tetapi ada konteks Community,
      //   row ini adalah header/container Community -> dibuang.
      if (baseName && hasDistinctLocalName && item.localNameStrong) {
        if (item.hasCommunityContext || repeatedPhysicalRows) {
          return {
            row: item.row,
            descriptor: buildCommunityChildDescriptor(
              item.row,
              item.base,
              localName,
              baseName
            )
          };
        }
      }

      // Header/container Community: ada kontrol Community tapi tidak ada nama
      // child lokal yang berbeda. Buang agar tidak ditawarkan sebagai chat.
      if (item.hasCommunityContext && baseName && !hasDistinctLocalName) {
        return {
          row: item.row,
          descriptor: {
            ...item.base,
            is_community_container: true
          }
        };
      }

      return { row: item.row, descriptor: item.base };
    });
  }

  function buildCommunityChildDescriptor(row, baseDescriptor, childName, communityName) {
    const child = cleanText(childName);
    const community = cleanText(communityName);
    const titleAliases = Array.from(new Set([
      child,
      community,
      ...(baseDescriptor.title_aliases || []),
      ...extractMeaningfulRowLines(row).slice(0, 6)
    ].filter(Boolean)));
    const preview = extractChatPreviewForNames(row, [child, community]);
    const nativeKey = extractChatNativeKey(row);
    const identitySeed = [
      normalizeComparable(community),
      normalizeComparable(child),
      simpleHash(normalizeComparable(preview || ""))
    ].join("|");

    // Native key pada beberapa build berasal dari wrapper Community dan dapat
    // sama untuk semua child. Karena itu child name selalu menjadi bagian key.
    const identityKey = nativeKey
      ? `native:${nativeKey}|community-child:${normalizeComparable(child)}`
      : `dom:community-child:${identitySeed}`;

    return {
      name: child,
      preview,
      community_name: community || null,
      source_kind: "community_group",
      is_announcement: isAnnouncementName(child),
      is_community_container: false,
      identity_key: identityKey,
      alias_signature: buildAliasSignature(titleAliases),
      title_aliases: titleAliases,
      local_name_source: "visible_row_text"
    };
  }

  function inferCommunityChildNameFromRow(row, communityName) {
    const communityKey = normalizeComparable(communityName || "");
    if (!communityKey) return null;

    // Urutan visual row adalah sinyal paling stabil pada build pengguna:
    // Community label -> subgroup label -> preview. Ini juga menangkap nama
    // subgroup yang bukan span[title].
    const lineCandidate = chooseCommunityLocalNameFromLines(
      extractMeaningfulRowLines(row),
      communityName
    );
    if (lineCandidate) return lineCandidate;

    // Fallback style/geometry bila innerText tidak memisahkan baris dengan baik.
    const styledCandidates = getVisibleRowTextCandidates(row)
      .filter((candidate) => normalizeComparable(candidate.text) !== communityKey)
      .filter((candidate) => !isScannerControlTitle(candidate.text))
      .filter((candidate) => !isLikelySidebarMetadata(candidate.text));
    const strong = styledCandidates
      .filter((candidate) => candidate.isStrongLabel)
      .sort((a, b) => b.score - a.score)[0];
    return strong?.text || null;
  }

  function chooseCommunityLocalNameFromLines(lines, communityName) {
    const communityKey = normalizeComparable(communityName || "");
    for (const line of lines || []) {
      const key = normalizeComparable(line);
      if (!key || key === communityKey) continue;
      if (isScannerControlTitle(line) || isLikelySidebarMetadata(line)) continue;
      if (isLikelyCommunityPreviewLine(line)) continue;
      return cleanText(line);
    }
    return null;
  }

  function isLikelyCommunityPreviewLine(text) {
    const value = normalizeComparable(text || "");
    if (!value) return true;
    if (/^(sticker|photo|foto|image|gambar|video|gif|audio|voice message|pesan suara|document|dokumen)$/.test(value)) {
      return true;
    }
    if (/^(you|anda|saya|~?[^:]{1,40}):\s+.+/.test(value)) return true;
    if (/^(https?:\/\/|www\.)/.test(value)) return true;
    if (/\b(removed|added|joined|left|menghapus|menambahkan|bergabung|keluar)\b.*\b(group|grup|community|komunitas)\b/.test(value)) {
      return true;
    }
    return false;
  }

  function isStrongCommunityChildLabel(row, communityName, localName) {
    const localKey = normalizeComparable(localName || "");
    const communityKey = normalizeComparable(communityName || "");
    if (!localKey || localKey === communityKey) return false;
    if (isAnnouncementName(localName)) return true;
    return getVisibleRowTextCandidates(row).some(
      (candidate) => candidate.isStrongLabel && normalizeComparable(candidate.text) === localKey
    );
  }

  function extractMeaningfulRowLines(row) {
    return Array.from(new Set(
      cleanText(row?.innerText || "")
        .split("\n")
        .map(cleanText)
        .filter(Boolean)
        .filter((line) => !isLikelySidebarMetadata(line))
        .filter((line) => !/^(profile details|subgroup switcher|ic-arrow-drop-down)$/i.test(line))
    ));
  }

  function getVisibleRowTextCandidates(row) {
    if (!(row instanceof HTMLElement)) return [];
    const rowRect = row.getBoundingClientRect();
    const candidates = [];
    const seen = new Map();

    for (const element of row.querySelectorAll("span, div, p")) {
      if (!(element instanceof HTMLElement) || !isVisible(element)) continue;
      const rect = element.getBoundingClientRect();
      if (
        rect.bottom <= rowRect.top ||
        rect.top >= rowRect.bottom ||
        rect.right <= rowRect.left ||
        rect.left >= rowRect.right
      ) {
        continue;
      }

      const directText = cleanText(
        Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent || "")
          .join(" ")
      );
      if (!directText || directText.length > 140) continue;
      if (isLikelySidebarMetadata(directText) || isScannerControlTitle(directText)) continue;

      const style = getComputedStyle(element);
      const fontSize = Number.parseFloat(style.fontSize) || 0;
      const parsedWeight = Number.parseInt(style.fontWeight, 10);
      const fontWeight = Number.isFinite(parsedWeight)
        ? parsedWeight
        : /bold/i.test(style.fontWeight) ? 700 : 400;
      const relativeTop = Math.max(0, rect.top - rowRect.top);
      const inUpperArea = relativeTop <= rowRect.height * 0.7;
      const isStrongLabel = inUpperArea && (fontWeight >= 500 || fontSize >= 14);
      const score =
        fontSize * 3 +
        Math.min(fontWeight, 800) / 18 +
        (inUpperArea ? 25 : 0) +
        (fontWeight >= 500 ? 25 : 0);

      const key = normalizeComparable(directText);
      const previous = seen.get(key);
      if (!previous || score > previous.score) {
        seen.set(key, { text: directText, score, isStrongLabel });
      }
    }

    candidates.push(...seen.values());
    return candidates;
  }

  function hasCommunityContextAroundRow(row) {
    let current = row;
    for (let depth = 0; current && current !== document.body && depth < 6; depth += 1) {
      if (current.id === "pane-side") break;
      const rect = current.getBoundingClientRect?.();
      // Jangan menganggap seluruh sidebar sebagai container Community hanya karena
      // ada satu tombol Add group di tempat lain pada viewport.
      if (rect && rect.height > 900) break;

      const semantic = cleanText([
        current.getAttribute?.("aria-label"),
        current.getAttribute?.("title"),
        current.innerText?.slice(0, 900),
        ...Array.from(current.querySelectorAll?.('[aria-label], [title]') || [])
          .slice(0, 30)
          .flatMap((element) => [
            element.getAttribute?.("aria-label"),
            element.getAttribute?.("title")
          ])
      ].filter(Boolean).join(" | "));

      if (/(?:add group|tambahkan grup|view community|lihat komunitas|subgroup switcher)/i.test(semantic)) {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  }

  function extractChatPreviewForNames(row, excludedNames = []) {
    const excluded = new Set(excludedNames.map(normalizeComparable).filter(Boolean));
    const lines = extractMeaningfulRowLines(row)
      .filter((line) => !excluded.has(normalizeComparable(line)))
      .filter((line) => !isScannerControlTitle(line));
    return lines.at(-1)?.slice(0, 160) || "";
  }

  // ---------------------------------------------------------------------------
  // Ekstraksi nama berbasis GEOMETRI row sidebar (refactor penamaan akurat).
  //
  // Struktur row chat/subgroup di WhatsApp Web (lihat screenshot + outerHTML):
  //   [NAMA COMMUNITY]  <- label kecil/abu, paling atas (hanya pada subgroup)
  //   [NAMA GROUP/CHAT] <- label bold/berat>=500 & font>=13, tepat di bawahnya
  //   [preview]         <- sisa baris
  // Dengan membaca POSISI vertikal + bobot font (bukan skor ad-hoc), nama group
  // dan community dibedakan secara deterministik -> tidak ada lagi "semua
  // subgroup bernama sama".
  // ---------------------------------------------------------------------------

  function collectRowNameLabels(row) {
    if (!(row instanceof HTMLElement)) return [];
    const rowRect = row.getBoundingClientRect();
    const seen = new Map();

    for (const element of row.querySelectorAll("span, div")) {
      if (!(element instanceof HTMLElement) || !isVisible(element)) continue;
      const rect = element.getBoundingClientRect();
      if (
        rect.bottom <= rowRect.top ||
        rect.top >= rowRect.bottom ||
        rect.right <= rowRect.left ||
        rect.left >= rowRect.right
      ) {
        continue;
      }

      const text = cleanText(directVisibleText(element) || element.getAttribute?.("title"));
      if (!text || text.length > 120) continue;
      if (isLikelySidebarMetadata(text) || isScannerControlTitle(text)) continue;
      // Abaikan teks yang tampak seperti preview pesan (mis. "You: ...",
      // "Nama: pesan", label media). Nama chat tidak mengandung pola itu.
      if (isLikelyCommunityPreviewLine(text)) continue;

      const style = getComputedStyle(element);
      const fontSize = Number.parseFloat(style.fontSize) || 0;
      const parsedWeight = Number.parseInt(style.fontWeight, 10);
      const weight = Number.isFinite(parsedWeight)
        ? parsedWeight
        : /bold/i.test(style.fontWeight) ? 700 : 400;

      const key = normalizeComparable(text);
      const prev = seen.get(key);
      // Dedup berdasarkan teks; simpan representasi paling "menonjol".
      const emphasis = fontSize * 2 + weight / 50;
      if (!prev || emphasis > prev.emphasis) {
        seen.set(key, {
          text,
          top: rect.top - rowRect.top,
          fontSize,
          weight,
          emphasis
        });
      }
    }

    return Array.from(seen.values()).sort((a, b) => a.top - b.top);
  }

  function isBoldNameLabel(label) {
    return label.weight >= 500 || label.fontSize >= 13;
  }

  // Kembalikan { name, communityName, preview, isCommunity } berbasis geometri.
  function extractGeometricChatNaming(row) {
    const labels = collectRowNameLabels(row);
    if (labels.length === 0) return null;

    // Berdasarkan data diagnostik nyata ([WA-NAME-DEBUG]): SEMUA label nama pada
    // row Community memakai font-weight 400. Bobot font TIDAK membedakan nama
    // Community vs nama Group. Pembeda yang konsisten adalah UKURAN FONT:
    //   "BBB World"        fs=14 (label Community, paling atas)
    //   "BBB Kuliah only"  fs=16 (label Group, tepat di bawahnya)
    //   preview/sender     fs=14 (di bawah)
    // Maka: nama chat/group = label dengan FONT TERBESAR; Community = label
    // ber-font lebih kecil yang berada TEPAT DI ATAS nama.
    const maxFontSize = Math.max(...labels.map((label) => label.fontSize));
    const primary = labels.find((label) => label.fontSize >= maxFontSize - 0.5);

    const communityCandidate = labels
      .filter((label) =>
        label !== primary &&
        label.top < primary.top - 1 &&
        label.fontSize < primary.fontSize - 0.5
      )
      .sort((a, b) => b.top - a.top)[0];

    const result = communityCandidate
      ? {
          name: primary.text,
          communityName: communityCandidate.text,
          isCommunity: true
        }
      : {
          name: primary.text,
          communityName: null,
          isCommunity: false
        };

    return result;
  }

  function extractGeometricPreview(row, name, communityName) {
    const exclude = new Set(
      [name, communityName].map(normalizeComparable).filter(Boolean)
    );
    const lines = cleanText(row?.innerText || "")
      .split("\n")
      .map(cleanText)
      .filter(Boolean)
      .filter((line) => !exclude.has(normalizeComparable(line)))
      .filter((line) => !isLikelySidebarMetadata(line));
    return lines.at(-1)?.slice(0, 160) || "";
  }

  function extractChatDescriptor(row, scanPass = "all", anchorTitle = null) {
    const titleCandidates = getChatTitleCandidates(row);
    const ariaName = extractAriaChatName(row);
    const anchorName = anchorTitle
      ? cleanText(anchorTitle.getAttribute?.("title") || anchorTitle.textContent)
      : "";
    const titleAliases = Array.from(
      new Set([
        anchorName,
        ...titleCandidates.map((candidate) => cleanText(candidate.text)),
        ariaName
      ].filter(Boolean))
    );

    // UTAMA: penamaan berbasis geometri row. Ini menentukan nama chat/subgroup
    // beserta community secara deterministik dari posisi + bobot font.
    const geometric = extractGeometricChatNaming(row);
    let name;
    let communityName;
    let preview;

    if (geometric && geometric.name) {
      name = geometric.name;
      communityName = geometric.communityName;
      preview = extractGeometricPreview(row, name, communityName);
    } else {
      // Fallback bila geometri gagal (struktur tak terduga): logika lama.
      name = choosePrimaryChatTitle(row, titleCandidates) || ariaName;
      preview = name ? extractChatPreview(row, name) : "";
      communityName = name && scanPass === "groups"
        ? extractCommunityContextForAnchoredRow(row, name, titleCandidates, preview)
        : null;

      if (communityName && name) {
        const nameKey = normalizeComparable(name);
        const communityKey = normalizeComparable(communityName);
        if (nameKey === communityKey) {
          const groupCandidate = extractCommunityGroupNameCandidate(
            row,
            titleCandidates,
            communityName
          );
          if (groupCandidate) {
            name = groupCandidate;
            preview = extractChatPreview(row, name);
          }
        }
      }
    }

    const isAnnouncement = isAnnouncementName(name) || isAnnouncementRow(row, name);
    const isCommunityContainer = isCommunityContainerHeaderRow(
      row,
      name,
      titleCandidates,
      anchorName
    );
    const nativeKey = extractChatNativeKey(row);
    const sourceKind = communityName ? "community_group" : "chat";
    const identitySeed = nativeKey || [
      normalizeComparable(name),
      normalizeComparable(communityName || ""),
      simpleHash(normalizeComparable(preview || ""))
    ].join("|");

    return {
      name,
      preview,
      community_name: communityName,
      source_kind: sourceKind,
      is_announcement: isAnnouncement,
      is_community_container: isCommunityContainer,
      identity_key: nativeKey ? `native:${nativeKey}` : `dom:${identitySeed}`,
      alias_signature: buildAliasSignature(titleAliases),
      // Internal only. Community rows can expose both community and subgroup
      // labels. Do not permanently trust which one is the chat name until the
      // clicked conversation header confirms it.
      title_aliases: titleAliases
    };
  }

  // Cari kandidat nama GROUP pada row Community ketika nama yang terpilih justru
  // adalah nama Community (kasus "semua subgroup bernama sama"). Nama group bisa
  // berupa span[title] maupun teks biasa. Urutan visual label nama pada row
  // Community umumnya [Community, Group, ...preview], sehingga kandidat nama
  // group adalah label pertama yang berbeda dari nama Community.
  function extractCommunityGroupNameCandidate(row, titleCandidates, communityName) {
    const communityKey = normalizeComparable(communityName || "");
    const isEligible = (text) => {
      const key = normalizeComparable(text || "");
      return (
        key &&
        key !== communityKey &&
        !isAnnouncementName(text) &&
        !isScannerControlTitle(text) &&
        !isLikelySidebarMetadata(text) &&
        !isLikelyCommunityPreviewLine(text) &&
        !isCommunitySectionHeading(text)
      );
    };

    // 1) Utamakan span[title] yang berbeda dari Community (paling andal).
    const fromTitle = (titleCandidates || [])
      .map((candidate) => cleanText(candidate.text))
      .find(isEligible);
    if (fromTitle) return fromTitle;

    // 2) Fallback: baris teks biasa di row (subgroup sering bukan span[title]).
    const fromLines = extractMeaningfulRowLines(row).find(isEligible);
    if (fromLines) return fromLines;

    // 3) Fallback terakhir: kandidat teks visible dengan gaya label kuat.
    const fromStyled = getVisibleRowTextCandidates(row)
      .filter((candidate) => candidate.isStrongLabel && isEligible(candidate.text))
      .sort((a, b) => b.score - a.score)[0];
    return fromStyled?.text || null;
  }

  function getChatTitleCandidates(row) {
    return Array.from(row.querySelectorAll("span[title]"))
      .filter(isVisible)
      .map((element) => ({
        element,
        text: cleanText(element.getAttribute("title")),
        score: scoreChatTitleCandidate(element, row)
      }))
      .filter((item) => item.text && !isLikelySidebarMetadata(item.text));
  }

  function scoreChatTitleCandidate(element, row) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const fontSize = Number.parseFloat(style.fontSize) || 0;
    const fontWeightRaw = Number.parseInt(style.fontWeight, 10);
    const fontWeight = Number.isFinite(fontWeightRaw)
      ? fontWeightRaw
      : /bold/i.test(style.fontWeight) ? 700 : 400;
    const relativeTop = Math.max(0, rect.top - rowRect.top);
    const firstHalfBonus = relativeTop <= rowRect.height * 0.58 ? 12 : 0;
    const titleAttr = cleanText(element.getAttribute("title"));
    const rowLines = cleanText(row.innerText).split("\n").map(cleanText).filter(Boolean);
    const lineIndex = rowLines.findIndex((line) => line === titleAttr);
    const lineBonus = lineIndex === 0 ? 10 : lineIndex === 1 ? 5 : 0;

    return fontSize * 3 + Math.min(fontWeight, 800) / 35 + firstHalfBonus + lineBonus;
  }

  function choosePrimaryChatTitle(row, candidates) {
    if (!candidates.length) return null;

    const distinct = [];
    const seen = new Set();
    for (const candidate of candidates) {
      const key = normalizeComparable(candidate.text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      distinct.push(candidate);
    }

    distinct.sort((a, b) => b.score - a.score);
    return distinct[0]?.text || null;
  }

  function extractAriaChatName(row) {
    const ariaLabel = cleanText(row.getAttribute("aria-label"));
    if (!ariaLabel) return null;
    return cleanText(ariaLabel.split(",")[0]);
  }

  function extractChatName(row) {
    const candidates = getChatTitleCandidates(row);
    return choosePrimaryChatTitle(row, candidates) || extractAriaChatName(row);
  }

  function extractChatPreview(row, chatName) {
    const lines = cleanText(row.innerText)
      .split("\n")
      .map(cleanText)
      .filter(Boolean)
      .filter((line) => normalizeComparable(line) !== normalizeComparable(chatName))
      .filter((line) => !isLikelySidebarMetadata(line));

    return lines.at(-1)?.slice(0, 160) || "";
  }

  function extractCommunityContextForAnchoredRow(row, chatName, titleCandidates, preview) {
    const chatKey = normalizeComparable(chatName);
    const rowSemantic = cleanText([
      row.getAttribute?.("aria-label"),
      row.getAttribute?.("title"),
      row.innerText?.slice(0, 500)
    ].filter(Boolean).join(" | "));
    const rowLooksLikeCommunityContainer = /(?:subgroup switcher|view community|lihat komunitas|add group|tambahkan grup|community|komunitas)/i.test(rowSemantic);

    // Jika anchor masih harus memakai wrapper Community, judul pertama di wrapper
    // biasanya adalah nama Community. Kita boleh memakainya sebagai context, tetapi
    // TIDAK pernah sebagai chat_name karena chat_name sudah dikunci oleh anchor.
    if (rowLooksLikeCommunityContainer) {
      const firstContext = titleCandidates
        .map((candidate) => cleanText(candidate.text))
        .find((text) =>
          text &&
          normalizeComparable(text) !== chatKey &&
          !isAnnouncementName(text) &&
          !isScannerControlTitle(text)
        );
      if (firstContext) return firstContext;
    }

    // Pada leaf-row yang kecil, gunakan context lokal hanya bila kandidat judul
    // sedikit. Ini mencegah sibling subgroup dari wrapper besar dianggap nama
    // Community.
    if (titleCandidates.length <= 2) {
      const local = extractCommunityContext(row, chatName, titleCandidates, preview);
      if (local && normalizeComparable(local) !== chatKey) {
        return local;
      }
    }

    // Jika leaf-row hanya berisi nama subgroup + preview, cari ancestor Community
    // yang mempunyai kontrol khas seperti Add group/View community/Subgroup
    // switcher. Dari container itu ambil title yang berada di atas child-row.
    const rowRect = row.getBoundingClientRect();
    let ancestor = row.parentElement;
    for (let depth = 0; ancestor && ancestor !== document.body && depth < 8; depth += 1) {
      const semantic = cleanText([
        ancestor.getAttribute?.("aria-label"),
        ancestor.getAttribute?.("title"),
        ancestor.innerText?.slice(0, 500)
      ].filter(Boolean).join(" | "));
      const hasCommunityControls = /(?:subgroup switcher|view community|lihat komunitas|add group|tambahkan grup|community|komunitas)/i.test(semantic);

      if (hasCommunityControls) {
        const options = Array.from(ancestor.querySelectorAll("span[title]"))
          .filter(isVisible)
          .map((span) => ({
            text: cleanText(span.getAttribute("title")),
            rect: span.getBoundingClientRect()
          }))
          .filter((item) => item.text)
          .filter((item) => normalizeComparable(item.text) !== normalizeComparable(chatName))
          .filter((item) => !isAnnouncementName(item.text))
          .filter((item) => !isScannerControlTitle(item.text))
          .filter((item) => item.rect.bottom <= rowRect.top + 10)
          .sort((a, b) => b.rect.bottom - a.rect.bottom);

        // Header Community biasanya title terdekat di atas deretan child-row.
        if (options.length) return options[0].text;
      }

      ancestor = ancestor.parentElement;
    }

    return null;
  }

  function extractCommunityContext(row, chatName, titleCandidates, preview) {
    const chatKey = normalizeComparable(chatName);
    const previewKey = normalizeComparable(preview || "");
    const alternatives = titleCandidates
      .filter((candidate) => normalizeComparable(candidate.text) !== chatKey)
      .filter((candidate) => normalizeComparable(candidate.text) !== previewKey)
      .filter((candidate) => !isAnnouncementName(candidate.text))
      .filter((candidate) => candidate.text.length <= 120)
      .sort((a, b) => b.score - a.score);

    // Community child rows sering memiliki label konteks kedua di row yang sama.
    if (alternatives.length > 0) {
      return alternatives[0].text;
    }

    // Fallback konservatif: cari label Community/Komunitas pada dua ancestor
    // terdekat, tetapi jangan mengambil teks dari sibling chat biasa.
    let ancestor = row.parentElement;
    for (let depth = 0; ancestor && depth < 3; depth += 1, ancestor = ancestor.parentElement) {
      const label = cleanText(
        ancestor.getAttribute?.("aria-label") || ancestor.getAttribute?.("title")
      );
      if (/\b(community|komunitas)\b/i.test(label)) {
        const title = Array.from(ancestor.querySelectorAll("span[title]"))
          .filter(isVisible)
          .map((element) => cleanText(element.getAttribute("title")))
          .find((text) => text && normalizeComparable(text) !== chatKey && !isAnnouncementName(text));
        if (title) return title;
      }
    }

    return null;
  }

  function isLikelySidebarMetadata(text) {
    const value = cleanText(text);
    return (
      !value ||
      /^\d{1,2}[:.]\d{2}$/.test(value) ||
      /^(yesterday|kemarin|today|hari ini)$/i.test(value) ||
      /^\d+$/.test(value) ||
      // Teks badge/status unread — BUKAN nama chat. Pada row dengan pesan belum
      // dibaca, elemen ini bisa menjadi label ber-font terbesar sehingga tanpa
      // filter ini ia keliru terpilih sebagai nama (mis. "2 unread messages").
      /^\d+\s+unread\s+messages?$/i.test(value) ||
      /^unread\s+messages?$/i.test(value) ||
      /\bunread\s+messages?\b/i.test(value) ||
      /^\d+\s+(pesan\s+)?belum\s+dibaca$/i.test(value) ||
      /\bbelum\s+dibaca\b/i.test(value) ||
      // Teks tanggal seperti "4/6/2026" atau "06/09/2026".
      /^\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}$/.test(value)
    );
  }

  function isCommunityContainerHeaderRow(row, name, titleCandidates = [], anchorName = "") {
    const semantic = cleanText([
      row.getAttribute?.("aria-label"),
      row.getAttribute?.("title"),
      row.innerText?.slice(0, 600),
      ...Array.from(row.querySelectorAll('[aria-label], [title]')).slice(0, 30).flatMap((element) => [
        element.getAttribute?.("aria-label"),
        element.getAttribute?.("title")
      ])
    ].filter(Boolean).join(" | "));

    const hasContainerControls = /(?:subgroup switcher|view community|lihat komunitas|add group|tambahkan grup)/i.test(semantic);
    if (!hasContainerControls) return false;

    const firstTitle = titleCandidates
      .map((candidate) => cleanText(candidate.text))
      .find(Boolean) || "";
    const nameKey = normalizeComparable(name || "");
    const anchorKey = normalizeComparable(anchorName || "");
    const firstKey = normalizeComparable(firstTitle || "");

    // Anchor child yang berbeda dari title pertama tetap merupakan subgroup.
    if (anchorKey && firstKey && anchorKey !== firstKey) return false;

    // Tanpa anchor, atau anchor tepat pada header pertama, row ini adalah
    // container/header Community dan bukan percakapan yang dapat diekspor.
    return Boolean(nameKey && (!anchorKey || nameKey === firstKey));
  }

  function isAnnouncementName(name) {
    const value = normalizeComparable(name || "");
    return /^(announcements?|pengumuman)$/.test(value);
  }

  function isAnnouncementRow(row, name) {
    if (isAnnouncementName(name)) return true;

    const semantic = [
      row.getAttribute("aria-label"),
      row.getAttribute("title"),
      ...Array.from(row.querySelectorAll('[aria-label], [title]')).slice(0, 25).flatMap((element) => [
        element.getAttribute("aria-label"),
        element.getAttribute("title")
      ])
    ]
      .map(cleanText)
      .filter(Boolean)
      .join(" | ");

    // Jangan skip hanya karena preview mengandung kata announcement. Harus ada
    // label UI yang secara eksplisit menandai row tersebut sebagai announcement.
    return /(?:^|\b)(announcements?|pengumuman)(?:$|\b)/i.test(semantic) &&
      /(?:community|komunitas|group|grup|announcement|pengumuman)/i.test(semantic);
  }

  function extractChatNativeKey(row) {
    const candidates = [row, ...row.querySelectorAll("[data-id], [data-jid], [data-chat-id], a[href]")];
    for (const element of candidates) {
      for (const attribute of ["data-chat-id", "data-jid", "data-id", "href"]) {
        const value = cleanText(element.getAttribute?.(attribute));
        if (!value) continue;
        if (attribute === "data-id" && value.length < 8) continue;
        return `${attribute}:${value.slice(0, 300)}`;
      }
    }
    return null;
  }

  function buildAliasSignature(aliases = []) {
    return Array.from(new Set(aliases
      .map((value) => normalizeComparable(value))
      .filter(Boolean)
      .filter((value) => !/^(profile details|subgroup switcher|ic-arrow-drop-down|groups?|grups?|all|semua)$/.test(value))
    )).sort().join("~");
  }


  function removeCommunityContainerEntries(entries) {
    const communityNames = new Set(
      entries
        .filter((entry) => entry.source_kind === "community_group")
        .map((entry) => normalizeComparable(entry.community_name || ""))
        .filter(Boolean)
    );

    if (communityNames.size === 0) {
      return { entries, removedCount: 0 };
    }

    let removedCount = 0;
    const filtered = entries.filter((entry) => {
      const nameKey = normalizeComparable(entry.name || "");
      const isChild = entry.source_kind === "community_group";
      const looksLikeContainer = !isChild && communityNames.has(nameKey);
      if (looksLikeContainer) removedCount += 1;
      return !looksLikeContainer;
    });
    return { entries: filtered, removedCount };
  }

  function mergeEquivalentScannedEntries(entries) {
    const merged = [];
    let mergedCount = 0;

    for (const entry of entries) {
      const nameKey = normalizeComparable(entry.name || "");
      const communityKey = normalizeComparable(entry.community_name || "");
      const previewKey = normalizeComparable(entry.preview || "");
      const aliasSet = new Set((entry.title_aliases || []).map(normalizeComparable).filter(Boolean));

      const existing = merged.find((candidate) => {
        if (normalizeComparable(candidate.name || "") !== nameKey) return false;

        const candidateCommunity = normalizeComparable(candidate.community_name || "");
        if (candidateCommunity && communityKey && candidateCommunity !== communityKey) {
          return false;
        }

        if (candidate.identity_key && entry.identity_key && candidate.identity_key === entry.identity_key) {
          return true;
        }

        const candidatePreview = normalizeComparable(candidate.preview || "");
        const exactPreview = Boolean(previewKey && candidatePreview && previewKey === candidatePreview);
        if (exactPreview) return true;

        // Bila salah satu entry tidak membawa community context (umumnya hasil
        // pass All), jangan merge hanya berdasarkan nama. Ini mencegah group
        // bernama sama dari Community berbeda tertukar.
        if (!candidateCommunity || !communityKey) return false;

        const candidateAliases = new Set(
          (candidate.title_aliases || []).map(normalizeComparable).filter(Boolean)
        );
        let overlap = 0;
        for (const alias of aliasSet) {
          if (candidateAliases.has(alias)) overlap += 1;
        }
        return overlap >= 2;
      });

      if (!existing) {
        merged.push(entry);
        continue;
      }

      mergedCount += 1;
      if (!existing.preview && entry.preview) existing.preview = entry.preview;
      if (!existing.community_name && entry.community_name) {
        existing.community_name = entry.community_name;
        existing.source_kind = "community_group";
      }
      existing.title_aliases = Array.from(new Set([
        ...(existing.title_aliases || []),
        ...(entry.title_aliases || [])
      ].filter(Boolean)));
      existing.alias_signature = buildAliasSignature(existing.title_aliases);
      existing.discovered_via_all ||= Boolean(entry.discovered_via_all);
      existing.discovered_via_groups_filter ||= Boolean(entry.discovered_via_groups_filter);
      existing.scan_positions = { ...(existing.scan_positions || {}) };
      for (const [pass, top] of Object.entries(entry.scan_positions || {})) {
        const current = existing.scan_positions[pass];
        existing.scan_positions[pass] = Number.isFinite(current)
          ? Math.min(current, top)
          : top;
      }
      existing.scan_top = Math.min(existing.scan_top, entry.scan_top);
    }

    return { entries: merged, mergedCount };
  }

  function findMatchingScannedEntry(discovered, descriptor, currentTop, viewportHeight) {
    const descriptorNameKey = normalizeComparable(descriptor.name);
    const descriptorCommunityKey = normalizeComparable(descriptor.community_name || "");
    const descriptorAliasSignature = descriptor.alias_signature || buildAliasSignature(descriptor.title_aliases || []);
    for (const entry of discovered.values()) {
      if (entry.identity_key !== descriptor.identity_key) continue;
      if (normalizeComparable(entry.name) !== descriptorNameKey) continue;
      const existingCommunityKey = normalizeComparable(entry.community_name || "");
      if (
        existingCommunityKey &&
        descriptorCommunityKey &&
        existingCommunityKey !== descriptorCommunityKey
      ) {
        continue;
      }

      // Satu wrapper Community kadang membagikan native key yang sama ke beberapa
      // child-row. Jangan menggabungkan row hanya karena native key sama jika
      // alias judulnya berbeda; ini adalah sumber bug "1 group per Community".
      const existingAliasSignature = entry.alias_signature || buildAliasSignature(entry.title_aliases || []);
      if (
        descriptor.source_kind === "community_group" &&
        existingAliasSignature &&
        descriptorAliasSignature &&
        existingAliasSignature !== descriptorAliasSignature
      ) {
        continue;
      }
      return entry;
    }

    const nameKey = descriptorNameKey;
    const communityKey = normalizeComparable(descriptor.community_name || "");
    const previewKey = normalizeComparable(descriptor.preview || "");

    for (const entry of discovered.values()) {
      if (normalizeComparable(entry.name) !== nameKey) continue;

      const existingCommunity = normalizeComparable(entry.community_name || "");
      if (existingCommunity && communityKey && existingCommunity !== communityKey) {
        continue;
      }

      const existingPreview = normalizeComparable(entry.preview || "");
      const exactPreview = Boolean(existingPreview && previewKey && existingPreview === previewKey);
      const previewMatches = exactPreview || !existingPreview || !previewKey;
      const nearby = Math.abs(entry.scan_top - currentTop) <= Math.max(300, viewportHeight * 1.4);

      const existingAliasSignature = entry.alias_signature || buildAliasSignature(entry.title_aliases || []);
      const communityCandidate =
        descriptor.source_kind === "community_group" || entry.source_kind === "community_group";

      if (communityCandidate) {
        // Untuk Community, nama provisional bisa sama untuk beberapa subgroup.
        // Alias signature harus cocok sebelum dua physical row dianggap sama.
        if (
          existingAliasSignature &&
          descriptorAliasSignature &&
          existingAliasSignature !== descriptorAliasSignature
        ) {
          continue;
        }
        if (exactPreview || (previewMatches && nearby && existingAliasSignature === descriptorAliasSignature)) {
          return entry;
        }
        continue;
      }

      // Chat biasa tetap memakai aturan lama agar entry All + Groups yang sama
      // tidak diduplikasi.
      if (exactPreview || (previewMatches && nearby)) return entry;
    }

    return null;
  }

  function publicChatEntry(entry) {
    return {
      id: entry.id,
      contact_id: extractNumericContactId(entry.identity_key),
      name: entry.name,
      preview: entry.preview || "",
      community_name: entry.community_name || null,
      source_kind: entry.source_kind || "chat",
      membership_status: entry.membership_status || null
    };
  }

  function extractNumericContactId(identityKey) {
    const match = /(?:data-jid|data-chat-id|data-id):\+?(\d{6,20})(?:@(?:c\.us|s\.whatsapp\.net))?/i.exec(String(identityKey || ""));
    return match ? match[1] : null;
  }

  function compareScannedEntries(a, b) {
    const aRank = Number.isFinite(a?.scan_pass_rank) ? a.scan_pass_rank : 2;
    const bRank = Number.isFinite(b?.scan_pass_rank) ? b.scan_pass_rank : 2;
    if (aRank !== bRank) return aRank - bRank;

    const aPosition = a?.scan_positions?.[a.first_scan_pass];
    const bPosition = b?.scan_positions?.[b.first_scan_pass];
    if (Number.isFinite(aPosition) && Number.isFinite(bPosition) && aPosition !== bPosition) {
      return aPosition - bPosition;
    }

    return (a?.scan_order || 0) - (b?.scan_order || 0);
  }

  async function exportSelectedChats(chatIds, rawOptions) {
    const options = normalizeOptions(rawOptions);
    const selectedEntries = chatIds
      .map((id) => chatRegistry.get(id))
      .filter(Boolean);

    if (selectedEntries.length === 0) {
      throw new Error(
        "Daftar chat tidak lagi tersedia. Pindai ulang chat sebelum mengekspor."
      );
    }

    const exportStartedAt = new Date();
    const exportRoot = `whatsapp-export-${formatFilenameDate(exportStartedAt)}`;
    options.exportRoot = exportRoot;
    // Database internal dibatasi satu arsip, agar ekspor berikutnya tetap lengkap.
    options.mediaDatabase = { units: new Map(), files: new Map() };

    const exportedChats = [];
    const errors = [];
    const chatResults = [];
    let stoppedEarly = false;

    for (let index = 0; index < selectedEntries.length; index += 1) {
      // Titik henti antar-chat: chat yang sudah selesai tetap masuk arsip.
      if (isStopRequested()) {
        stoppedEarly = true;
        break;
      }

      const entry = selectedEntries[index];
      const currentChatIndex = index + 1;
      const totalChats = selectedEntries.length;

      emitExportProgress({
        currentChatIndex,
        totalChats,
        result: {
          chat_id: entry.id,
          chat_name: entry.name,
          community_name: entry.community_name || null,
          source_kind: entry.source_kind || "chat",
          stage: "opening",
          status: "partial",
          requested_messages: options.maxMessages,
          captured_messages: 0,
          scroll_steps_used: 0,
          image_export_enabled: options.exportImages,
          images_detected: 0,
          images_exported: 0,
          images_high_quality: 0,
          images_readable: 0,
          images_low_quality: 0,
          images_failed: 0,
          images_pending: 0
        }
      });

      try {
        // Jangan mengandalkan referensi DOM hasil pemindaian. WhatsApp dapat
        // merender ulang seluruh sidebar setiap kali chat aktif berubah.
        await openChat(entry);

        const result = await scrapeConversation(entry, options, (progress) => {
          emitExportProgress({
            currentChatIndex,
            totalChats,
            result: {
              chat_id: entry.id,
              chat_name: entry.name,
              community_name: entry.community_name || null,
              source_kind: entry.source_kind || "chat",
              stage: "collecting",
              status: "partial",
              requested_messages: options.maxMessages,
              image_export_enabled: options.exportImages,
              ...progress
            }
          });
        });
        exportedChats.push(result);

        const summary = buildChatResult(result, options);
        chatResults.push(summary);
        emitExportProgress({
          currentChatIndex,
          totalChats,
          result: {
            ...summary,
            stage: "completed"
          }
        });

        // Beri React/WhatsApp waktu menyelesaikan render sebelum pindah ke chat
        // berikutnya. Ini penting ketika beberapa chat diekspor berurutan.
        await sleep(800);
      } catch (error) {
        const normalized = normalizeError(error);
        const notMember = error?.code === "COMMUNITY_NOT_MEMBER";
        const failure = {
          chat_id: entry.id,
          chat_name: entry.name,
          community_name: entry.community_name || null,
          source_kind: entry.source_kind || "chat",
          reason: notMember ? "community_not_member" : "export_error",
          error: normalized
        };
        errors.push(failure);

        const summary = {
          chat_id: entry.id,
          chat_name: entry.name,
          community_name: entry.community_name || null,
          source_kind: entry.source_kind || "chat",
          status: notMember ? "skipped" : "error",
          requested_messages: options.maxMessages,
          captured_messages: 0,
          missing_messages: options.maxMessages,
          target_reached: false,
          stop_reason: notMember ? "community_not_member" : "export_error",
          scroll_steps_used: 0,
          successful_load_batches: 0,
          total_wait_ms: 0,
          image_export_enabled: options.exportImages,
          images_detected: 0,
          images_exported: 0,
          images_high_quality: 0,
          images_readable: 0,
          images_low_quality: 0,
          images_failed: 0,
          images_metadata_only: 0,
          image_bytes_exported: 0,
          error: normalized
        };
        chatResults.push(summary);
        emitExportProgress({
          currentChatIndex,
          totalChats,
          result: {
            ...summary,
            stage: "completed"
          }
        });

        // Tetap lanjut ke chat berikutnya setelah satu chat gagal/tidak diikuti.
        // Kembalikan navigasi ke Chats agar kegagalan Community tidak meninggalkan
        // panel Join/Community yang dapat mengacaukan entry berikutnya.
        await recoverAfterFailedChatExport();
        await sleep(420);
      }
    }

    const exportedAt = new Date();
    const aggregateMedia = aggregateMediaSummary(exportedChats);
    const payload = {
      schema_version: "1.9.2",
      exported_at: exportedAt.toISOString(),
      source: {
        application: "WhatsApp Web",
        method: "Rendered DOM extraction",
        extension_name: chrome.runtime.getManifest().name,
        extension_version: chrome.runtime.getManifest().version
      },
      output: {
        directory: exportRoot,
        default_location: `Downloads/${exportRoot}`,
        // v0.9.3: setiap kontak/grup memiliki satu file JSON sendiri di dalam
        // folder messages. Ringkasan gabungan seluruh chat, daftar file, dan
        // error disimpan terpisah di akar arsip supaya folder messages benar-benar
        // hanya berisi file per chat.
        messages_directory: "messages",
        json_file_mode: "one_file_per_chat",
        json_file_naming: "messages/<nama chat>-<hash nama>.json",
        summary_file: "export-summary.json",
        contacts_file: "exported-contacts.csv",
        media_directory: options.exportImages ? "img" : null
      },
      export_settings: {
        text_only: !options.exportImages,
        include_media_metadata: true,
        download_images: options.exportImages,
        image_export_mode: options.exportImages ? options.imageExportMode : "disabled",
        image_quality_note: options.exportImages
          ? options.imageExportMode === "readable"
            ? "Mode readable mencoba media viewer untuk setiap kandidat gambar yang masih dapat dibuka, me-refresh kandidat setelah rerender, lalu memilih resource terbaik; fallback preview tetap dapat dipakai dan ditandai quality=low."
            : "Mode preview menyimpan resource gambar yang sedang dirender di bubble tanpa membuka media viewer."
          : null,
        max_messages_per_chat: options.maxMessages,
        load_older_messages: true,
        scroll_mode: "dynamic_target_based",
        internal_scroll_safety_cap: options.dynamicScrollHardCap,
        max_load_wait_ms_per_step: options.maxLoadWaitMs,
        max_image_wait_ms: options.imageLoadWaitMs,
        max_image_bytes: options.maxImageBytes,
        max_no_progress_rounds: options.maxNoProgressRounds,
        message_ordering: "visual_dom_order_with_timestamp_fallback",
        community_group_detection: "chats_then_community_snapshot_with_active_membership_sections",
        announcements_policy: "skip",
        community_membership_policy: "export_only_groups_user_is_in; skip join/request sections",
        reply_sequence_resolution: "message_id_then_nearest_previous_preview_match"
      },
      export_summary: {
        stopped_by_user: stoppedEarly,
        requested_chat_count: selectedEntries.length,
        attempted_chat_count: chatResults.length,
        exported_chat_count: exportedChats.length,
        complete_chat_count: chatResults.filter((item) => item.status === "complete").length,
        partial_chat_count: chatResults.filter((item) => item.status === "partial").length,
        failed_chat_count: chatResults.filter((item) => item.status === "error").length,
        skipped_chat_count: chatResults.filter((item) => item.status === "skipped").length,
        requested_messages_per_chat: options.maxMessages,
        captured_messages_total: exportedChats.reduce(
          (total, chat) => total + chat.message_count,
          0
        ),
        media: aggregateMedia,
        per_chat: chatResults
      },
      warnings: [
        stoppedEarly
          ? "Ekspor dihentikan manual oleh pengguna. Arsip ini hanya memuat chat dan pesan yang sempat terkumpul sampai tombol Hentikan ditekan."
          : null,
        "Hanya pesan yang berhasil dirender oleh WhatsApp Web yang dapat diekspor.",
        "Angka maksimum pesan merupakan target. Scroll berlangsung dinamis sampai target tercapai, awal chat/no-progress terdeteksi, atau guard keselamatan internal tercapai.",
        options.exportImages
          ? "v0.9.2 mode readable mencoba media viewer untuk setiap kandidat gambar yang dapat dibuka dan me-refresh kandidat setelah rerender. Hasil tetap bergantung pada media yang tersedia bagi WhatsApp Web dan tidak menjamin file original tanpa kompresi."
          : "Ekspor gambar dimatikan; media hanya dicatat sebagai metadata.",
        "Video, audio, voice note, dokumen, GIF, dan media selain gambar belum diunduh pada v0.9.2; hanya metadata yang terdeteksi yang disimpan.",
        "Baris Announcements/Pengumuman pada Community dilewati dari hasil scan dan tidak ditawarkan untuk ekspor.",
        "Subgroup Community pada bagian Groups you can join/Other groups atau yang menampilkan Join/Request to join dilewati. Jika subgroup lolos scan tetapi saat ekspor ternyata bukan anggota, chat tersebut dicatat skipped dan queue tetap dilanjutkan.",
        "reply_to.sequence hanya terisi jika pesan target juga termasuk dalam rentang pesan yang berhasil diekspor dan dapat dicocokkan dengan cukup yakin; jika tidak, nilainya null.",
        "Selector DOM WhatsApp Web dapat berubah dan mungkin memerlukan pembaruan ekstensi.",
        "Urutan pesan diprioritaskan berdasarkan posisi visual dari atas ke bawah pada DOM WhatsApp Web; timestamp digunakan sebagai fallback.",
        "Chat yang gagal ditemukan atau gagal dibuka tetap tercatat di export_summary.per_chat dengan status error dan tetap dihitung pada attempted_chat_count.",
        "Setiap kontak/grup disimpan sebagai satu file JSON terpisah di folder messages/. Ringkasan seluruh chat, daftar error, indeks file, dan exported-contacts.csv berada di akar arsip."
      ].filter(Boolean),
      errors,
      // chats sengaja TIDAK disertakan di sini. Payload ini dipakai sebagai
      // envelope bersama untuk setiap file JSON per chat, dan menyalin seluruh
      // chat ke dalamnya akan menggandakan isi arsip berkali-kali.
      chat_count: exportedChats.length
    };

    const { blob: zipBlob, jsonFiles } = await buildExportZipBundle({
      exportRoot,
      payload,
      exportedChats
    });
    const zipUrl = URL.createObjectURL(zipBlob);
    const downloadResponse = await chrome.runtime.sendMessage({
      type: "DOWNLOAD_FILE_URL",
      filename: `${exportRoot}.zip`,
      url: zipUrl,
      saveAs: false
    });

    if (!downloadResponse?.ok) {
      URL.revokeObjectURL(zipUrl);
      throw new Error(downloadResponse?.error || "File ZIP gagal diunduh.");
    }

    // JANGAN revoke segera setelah request. chrome.downloads.download() resolve
    // saat unduhan dimulai, tetapi service worker mungkin masih membaca object
    // URL ini. Revoke terlalu dini membuat ZIP gagal terunduh dan hasil ekspor
    // seolah-olah hanya berupa file terpisah. Tunda pembersihan.
    setTimeout(() => URL.revokeObjectURL(zipUrl), 60_000);

    return {
      ok: true,
      stoppedByUser: stoppedEarly,
      attemptedChats: chatResults.length,
      exportedChats: exportedChats.length,
      exportedMessages: exportedChats.reduce(
        (total, chat) => total + chat.message_count,
        0
      ),
      detectedImages: aggregateMedia.images_detected,
      exportedImages: aggregateMedia.images_exported,
      highQualityImages: aggregateMedia.images_high_quality,
      readableImages: aggregateMedia.images_readable,
      lowQualityImages: aggregateMedia.images_low_quality,
      failedImages: aggregateMedia.images_failed,
      outputDirectory: exportRoot,
      // Jumlah file JSON per chat yang benar-benar masuk ke folder messages.
      jsonFiles: jsonFiles.length,
      contactsFile: `${exportRoot}/exported-contacts.csv`,
      jsonFilePaths: jsonFiles.map((file) => file.relative_path),
      errors,
      chatResults
    };
  }

  async function recoverAfterFailedChatExport() {
    try {
      await restoreChatsNavigation();
      await switchChatFilter("all");
      await sleep(320);
    } catch (_) {
      // Recovery bersifat best-effort. Error satu chat tidak boleh membatalkan queue.
    }
  }

  function buildChatResult(chat, options) {
    const captured = chat.message_count;
    const targetReached = captured >= options.maxMessages;
    const mediaSummary = chat.media_summary || emptyMediaSummary();

    return {
      chat_id: chat.chat_id || null,
      contact_id: chat.contact_id || null,
      chat_name: chat.chat_name,
      source_kind: chat.source_kind || "chat",
      community_name: chat.community_name || null,
      membership_status: chat.membership_status || null,
      status: targetReached ? "complete" : "partial",
      requested_messages: options.maxMessages,
      captured_messages: captured,
      missing_messages: Math.max(0, options.maxMessages - captured),
      target_reached: targetReached,
      stop_reason: chat.extraction.stop_reason,
      scroll_steps_used: chat.extraction.scroll_steps_used,
      successful_load_batches: chat.extraction.successful_load_batches,
      no_progress_rounds: chat.extraction.no_progress_rounds,
      total_wait_ms: chat.extraction.total_wait_ms,
      message_scroller_found: chat.extraction.message_scroller_found,
      image_export_enabled: options.exportImages,
      images_detected: mediaSummary.images_detected,
      images_exported: mediaSummary.images_exported,
      images_high_quality: mediaSummary.images_high_quality,
      images_readable: mediaSummary.images_readable,
      images_low_quality: mediaSummary.images_low_quality,
      images_failed: mediaSummary.images_failed,
      images_metadata_only: mediaSummary.images_metadata_only,
      image_bytes_exported: mediaSummary.image_bytes_exported
    };
  }

  function emitExportProgress({ currentChatIndex, totalChats, result }) {
    try {
      const promise = chrome.runtime.sendMessage({
        type: "EXPORT_PROGRESS",
        current_chat_index: currentChatIndex,
        total_chats: totalChats,
        result
      });

      if (promise?.catch) {
        promise.catch(() => {
          // Popup dapat ditutup saat ekspor masih berjalan. Hal itu tidak boleh
          // menghentikan proses pengambilan maupun unduhan JSON.
        });
      }
    } catch (_error) {
      // Abaikan kegagalan pengiriman progress.
    }
  }

  function normalizeOptions(rawOptions = {}) {
    const maxMessages = clampInteger(rawOptions.maxMessages, 1, 5000, 200);

    return {
      maxMessages,
      // v0.8.8: pemuatan pesan lama selalu aktif. Target pesan menjadi kontrol
      // no-progress menjadi penghenti utama. Hard cap ini hanya guard internal
      // agar perubahan DOM yang aneh tidak membuat loop tanpa batas.
      dynamicScrollHardCap: Math.min(10_000, Math.max(120, maxMessages * 2 + 40)),
      maxLoadWaitMs: clampInteger(rawOptions.maxLoadWaitMs, 1_000, 30_000, 8_000),
      maxNoProgressRounds: 6,
      exportImages: rawOptions.exportImages === true,
      imageExportMode: ["readable", "preview"].includes(rawOptions.imageExportMode)
        ? rawOptions.imageExportMode
        : "readable",
      imageLoadWaitMs: clampInteger(rawOptions.imageLoadWaitMs, 1_000, 30_000, 8_000),
      maxImageBytes: 20 * 1024 * 1024,
      maxImageAttempts: 3,
      exportRoot: null
    };
  }

  async function openChat(entry) {
    // v0.8.8 retains the v0.8.4 audit fix:
    // - Community scanning is allowed to keep multiple title aliases.
    // - Opening a chat is no longer blocked by a possibly reversed
    //   community/subgroup label from the scanner.
    // - The actual chat name is confirmed from the conversation header AFTER
    //   the row has been clicked, then the entry is canonicalized.
    const preferredFilter = entry.discovered_via_all
      ? "all"
      : entry.discovered_via_groups_filter || entry.discovered_via === "groups"
        ? "groups"
        : "all";

    await switchChatFilter(preferredFilter);
    await sleep(320);

    let pane = document.querySelector("#pane-side");
    if (!pane) {
      throw new Error("Sidebar WhatsApp tidak ditemukan saat membuka chat.");
    }

    let row = await locateChatRow(pane, entry, 18_000, preferredFilter);

    if (!row && preferredFilter !== "groups" && entry.discovered_via_groups_filter) {
      await switchChatFilter("groups");
      await sleep(350);
      pane = document.querySelector("#pane-side");
      if (pane) row = await locateChatRow(pane, entry, 12_000, "groups");
    } else if (!row && preferredFilter !== "all" && entry.discovered_via_all) {
      await switchChatFilter("all");
      await sleep(350);
      pane = document.querySelector("#pane-side");
      if (pane) row = await locateChatRow(pane, entry, 12_000, "all");
    }

    if (!row && entry.community_name) {
      // v0.8.9: subgroup yang hanya hidup di panel Communities tidak harus muncul
      // sebagai row flat di #pane-side. Buka melalui hierarchy Community -> child.
      const openedFromCommunity = await openCommunityGroupFromNavigation(entry);
      if (openedFromCommunity) return;
    }

    if (!row) {
      const context = entry.community_name
        ? ` di Community “${entry.community_name}”`
        : "";
      throw new Error(
        `Baris chat “${entry.name}”${context} tidak ditemukan setelah daftar chat dan panel Communities ditelusuri. Chat tetap dihitung sebagai percobaan gagal pada ringkasan ekspor.`
      );
    }

    row.scrollIntoView({ block: "center", inline: "nearest" });
    await sleep(420);
    row = findChatRowForEntry(pane, entry) || row;

    // Bila chat sudah aktif, terima salah satu alias yang tersimpan. Ini penting
    // pada Community karena scanner lama dapat menukar chat_name/community_name.
    const alreadyOpen = matchEntryAgainstHeader(document.querySelector("#main"), entry);
    if (alreadyOpen) {
      await waitForConversationEntry(entry, 12_000);
      return;
    }

    const clickTargets = getChatClickTargets(
      row,
      getEntryNameAliases(entry),
      entry.source_kind === "community_group"
    );
    let lastError = null;

    for (const target of clickTargets) {
      activateChatTarget(target);

      try {
        await waitForConversationEntry(entry, 12_000);
        return;
      } catch (error) {
        lastError = error;
      }

      const refreshedRow = findChatRowForEntry(pane, entry);
      if (refreshedRow && refreshedRow !== row) {
        row = refreshedRow;
      }
    }

    const keyboardTarget = findChatRowForEntry(pane, entry) || row;
    keyboardTarget.focus?.({ preventScroll: true });
    keyboardTarget.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        composed: true
      })
    );
    keyboardTarget.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        composed: true
      })
    );

    try {
      await waitForConversationEntry(entry, 12_000);
      return;
    } catch (error) {
      lastError = error;
    }

    const candidates = getHeaderNameCandidates(document.querySelector("#main"));
    const aliases = getEntryNameAliases(entry);
    const detail = candidates.length
      ? ` Kandidat teks header: “${candidates.slice(0, 6).join(" | ")}”. Alias scan: “${aliases.join(" | ")}”.`
      : " Panel percakapan belum terbuka.";

    throw new Error(
      `${lastError?.message || `Chat “${entry.name}” tidak berhasil dibuka.`}${detail}`
    );
  }


  async function openCommunityGroupFromNavigation(entry) {
    const expectedCommunity = normalizeComparable(entry?.community_name || "");
    const expectedChild = normalizeComparable(entry?.name || "");
    if (!expectedCommunity || !expectedChild) return false;

    // Reuse an already-open matching Community panel if present.
    let detailPanel = findVisibleCommunityDetailPanels().find((panel) =>
      normalizeComparable(extractCommunityPanelTitle(panel) || "") === expectedCommunity
    ) || null;

    if (!detailPanel) {
      const nav = findPrimaryNavigationControl("communities");
      if (!nav) return false;
      activateChatTarget(nav);
      await sleep(620);

      let listPanel = await waitForCommunityListPanel(3_800);
      if (!listPanel) return false;
      const communityRow = await locateCommunityIndexRow(listPanel, entry.community_name, 12_000);
      if (!communityRow) return false;

      communityRow.scrollIntoView({ block: "center", inline: "nearest" });
      await sleep(180);
      activateChatTarget(communityRow);
      await sleep(480);
      detailPanel = await waitForCommunityDetailPanel(entry.community_name, 4_000);
      if (!detailPanel) return false;
    }

    const childRow = findCommunityChildRow(detailPanel, entry.name);
    if (!childRow) return false;
    childRow.scrollIntoView({ block: "center", inline: "nearest" });
    await sleep(220);
    activateChatTarget(childRow);

    try {
      await waitForCommunityConversationAccess(entry, 12_000);
      entry.membership_status = "active_verified";
      return true;
    } catch (error) {
      if (error?.code === "COMMUNITY_NOT_MEMBER") throw error;
      return false;
    }
  }

  async function locateCommunityIndexRow(panel, communityName, timeoutMs = 10_000) {
    const expected = normalizeComparable(communityName || "");
    if (!expected) return null;
    let scroller = findPanelScroller(panel) || panel;
    const deadline = Date.now() + timeoutMs;
    scroller.scrollTop = 0;
    await waitForSidebarRender(scroller, 420);

    while (Date.now() < deadline) {
      panel = findCommunityListPanel() || panel;
      for (const row of findCommunityIndexRows(panel)) {
        const name = normalizeComparable(extractCommunityIndexName(row, panel) || "");
        if (name === expected) return row;
      }
      scroller = findPanelScroller(panel) || scroller;
      const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      if (scroller.scrollTop >= maxTop - 4) break;
      scroller.scrollTop = Math.min(maxTop, scroller.scrollTop + Math.max(180, Math.floor(scroller.clientHeight * 0.72)));
      await waitForSidebarRender(scroller, 430);
    }
    return null;
  }

  function findCommunityChildRow(panel, childName) {
    const expected = normalizeComparable(childName || "");
    if (!expected) return null;
    const scored = [];
    for (const row of findVisualRowsInPanel(panel)) {
      const tokens = getVisualTextTokensInRect(row.getBoundingClientRect(), panel);
      if (isAnnouncementVisualRow(row, tokens)) continue;
      const candidate = normalizeComparable(chooseCommunityChildFromTokens(tokens, extractCommunityPanelTitle(panel)) || "");
      const tokenKeys = tokens.map((token) => normalizeComparable(token.text));
      if (candidate !== expected && !tokenKeys.includes(expected)) continue;
      let score = candidate === expected ? 120 : 70;
      const direct = normalizeComparable(directVisibleText(row));
      if (direct === expected) score += 35;
      scored.push({ row, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.row || null;
  }

  async function locateChatRow(pane, entry, timeoutMs = 18_000, filterKind = null) {
    let row = findChatRowForEntry(pane, entry);
    if (row) return row;

    const scroller = findSidebarScroller(pane);
    if (!scroller) return null;

    const deadline = Date.now() + timeoutMs;
    const maxTop = () => Math.max(0, scroller.scrollHeight - scroller.clientHeight);

    // Posisi disimpan per filter karena urutan row pada All dan Groups berbeda.
    const rememberedTop = Number.isFinite(entry.scan_positions?.[filterKind])
      ? entry.scan_positions[filterKind]
      : entry.scan_top;

    if (Number.isFinite(rememberedTop)) {
      scroller.scrollTop = Math.min(Math.max(0, rememberedTop), maxTop());
      await waitForSidebarRender(scroller, 650);
      row = findChatRowForEntry(pane, entry);
      if (row) return row;

      // Virtual list dapat bergeser sedikit ketika unread count berubah.
      const nearbyOffsets = [-0.7, 0.7, -1.4, 1.4];
      for (const multiplier of nearbyOffsets) {
        if (Date.now() >= deadline) break;
        const offset = Math.floor(scroller.clientHeight * multiplier);
        scroller.scrollTop = Math.min(
          maxTop(),
          Math.max(0, rememberedTop + offset)
        );
        await waitForSidebarRender(scroller, 450);
        row = findChatRowForEntry(pane, entry);
        if (row) return row;
      }
    }

    // Fallback terakhir: telusuri seluruh sidebar dari atas ke bawah. Dengan
    // cara ini chat tetap bisa dibuka walaupun posisi daftar berubah setelah scan.
    scroller.scrollTop = 0;
    await waitForSidebarRender(scroller, 450);

    while (Date.now() < deadline) {
      row = findChatRowForEntry(pane, entry);
      if (row) return row;

      const bottom = maxTop();
      if (scroller.scrollTop >= bottom - 4) {
        const previousHeight = scroller.scrollHeight;
        const grew = await waitForSidebarGrowth(scroller, previousHeight, 900);
        if (!grew) break;
      }

      const step = Math.max(260, Math.floor(scroller.clientHeight * 0.82));
      const nextTop = Math.min(maxTop(), scroller.scrollTop + step);
      if (nextTop <= scroller.scrollTop + 1) break;

      scroller.scrollTop = nextTop;
      await waitForSidebarRender(scroller, 380);
    }

    return findChatRowForEntry(pane, entry);
  }

  function findCommunityPhysicalRowForEntry(pane, entry) {
    const expectedChild = normalizeComparable(entry?.name || "");
    const expectedCommunity = normalizeComparable(entry?.community_name || "");
    if (!expectedChild) return null;

    const scored = [];
    for (const row of findChatRows(pane)) {
      const base = extractChatDescriptor(row, "all", null);
      const baseName = cleanText(base.name);
      const localName = inferCommunityChildNameFromRow(row, baseName);
      const localKey = normalizeComparable(localName || "");
      const lines = extractMeaningfulRowLines(row).map(normalizeComparable);
      const childMatches = localKey === expectedChild || lines.includes(expectedChild);
      if (!childMatches) continue;
      if (isAnnouncementName(localName)) continue;

      const baseKey = normalizeComparable(baseName);
      let score = 100;
      if (expectedCommunity && baseKey === expectedCommunity) score += 80;
      if (expectedCommunity && lines.includes(expectedCommunity)) score += 45;
      const expectedPreview = normalizeComparable(entry?.preview || "");
      if (expectedPreview && lines.includes(expectedPreview)) score += 25;

      const nameNode = findNameNodeInRow(row, [entry.name]);
      const clickRow = nameNode
        ? (findClickableRowAncestor(nameNode, pane) || row)
        : row;
      scored.push({ row: clickRow, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.row || null;
  }

  function findChatRowForEntry(pane, entry) {
    // v0.8.8: subgroup Community pada build pengguna tidak selalu memiliki
    // span[title] dengan nama subgroup. Temukan physical row dari visible text
    // terlebih dahulu sebelum fallback ke selector title lama.
    if (entry?.source_kind === "community_group" || entry?.community_name) {
      const communityRow = findCommunityPhysicalRowForEntry(pane, entry);
      if (communityRow) return communityRow;
    }

    const expectedNames = new Set(
      getEntryNameAliases(entry).map(normalizeComparable).filter(Boolean)
    );
    const titleMatches = Array.from(pane.querySelectorAll("span[title]"))
      .filter(isVisible)
      .filter((span) => expectedNames.has(normalizeComparable(span.getAttribute("title"))));

    const candidates = [];
    for (const span of titleMatches) {
      const scanRow = findRowAncestor(span, pane);
      const clickRow = findClickableRowAncestor(span, pane) || scanRow;
      if (!clickRow || !isInsidePaneViewport(clickRow, pane)) continue;

      const descriptorPass = entry.community_name || entry.discovered_via === "groups" ? "groups" : "all";
      const descriptor = extractChatDescriptor(
        scanRow || clickRow,
        descriptorPass,
        descriptorPass === "groups" ? span : null
      );
      if (descriptor.is_announcement || descriptor.is_community_container) continue;
      candidates.push({ row: clickRow, descriptor });
    }

    if (candidates.length === 0) {
      for (const scanRow of findChatRows(pane)) {
        const descriptor = extractChatDescriptor(
          scanRow,
          entry.community_name || entry.discovered_via === "groups" ? "groups" : "all"
        );
        const descriptorAliases = new Set(
          [descriptor.name, descriptor.community_name, ...(descriptor.title_aliases || [])]
            .map(normalizeComparable)
            .filter(Boolean)
        );
        const overlaps = [...expectedNames].some((name) => descriptorAliases.has(name));
        if (descriptor.name && !descriptor.is_announcement && !descriptor.is_community_container && overlaps) {
          const nameNode = findNameNodeInRow(scanRow, getEntryNameAliases(entry));
          const clickRow = nameNode
            ? (findClickableRowAncestor(nameNode, pane) || scanRow)
            : scanRow;
          candidates.push({ row: clickRow, descriptor });
        }
      }
    }

    if (candidates.length === 0) return null;

    const expectedCommunity = normalizeComparable(entry.community_name || "");
    const expectedPreview = normalizeComparable(entry.preview || "");
    const expectedIdentity = entry.identity_key || "";

    candidates.sort((a, b) =>
      scoreChatRowForEntry(b.descriptor, expectedCommunity, expectedPreview, expectedIdentity) -
      scoreChatRowForEntry(a.descriptor, expectedCommunity, expectedPreview, expectedIdentity)
    );

    return candidates[0].row;
  }

  function findNameNodeInRow(row, expectedNames) {
    const expected = new Set(
      (Array.isArray(expectedNames) ? expectedNames : [expectedNames])
        .map(normalizeComparable)
        .filter(Boolean)
    );

    const titleMatch = Array.from(row.querySelectorAll("span[title]"))
      .find((span) => expected.has(normalizeComparable(span.getAttribute("title"))));
    if (titleMatch) return titleMatch;

    // Community subgroup name can be ordinary rendered text without title=.
    for (const element of row.querySelectorAll("span, div, p")) {
      if (!(element instanceof HTMLElement) || !isVisible(element)) continue;
      const directText = cleanText(
        Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent || "")
          .join(" ")
      );
      if (directText && expected.has(normalizeComparable(directText))) {
        return element;
      }
    }
    return null;
  }

  function findClickableRowAncestor(element, boundary) {
    let current = element;
    let best = null;

    // Berbeda dari findRowAncestor() yang mengembalikan ancestor TERDEKAT untuk
    // scanner Community, fungsi ini mempertahankan ancestor interaktif TERLUAR
    // yang masih berukuran seperti satu row chat. Ini meniru perilaku v0.7 yang
    // terbukti dapat membuka private chat dan group sebelum perubahan scanner.
    for (let depth = 0; current && current !== boundary && depth < 12; depth += 1) {
      const rectangle = current.getBoundingClientRect();
      const hasReasonableSize =
        rectangle.width >= 180 && rectangle.height >= 42 && rectangle.height <= 155;
      const isInteractive =
        current.matches('[role="listitem"], [role="button"], [tabindex], [data-tab]') ||
        getComputedStyle(current).cursor === "pointer";

      if (hasReasonableSize && isInteractive) {
        best = current;
      }

      current = current.parentElement;
    }

    return best;
  }

  function scoreChatRowForEntry(descriptor, expectedCommunity, expectedPreview, expectedIdentity) {
    let score = 0;
    if (expectedIdentity && descriptor.identity_key === expectedIdentity) score += 200;

    const actualCommunity = normalizeComparable(descriptor.community_name || "");
    if (expectedCommunity && actualCommunity === expectedCommunity) score += 80;
    else if (!expectedCommunity && !actualCommunity) score += 20;

    const actualPreview = normalizeComparable(descriptor.preview || "");
    if (expectedPreview && actualPreview === expectedPreview) score += 60;
    else if (
      expectedPreview &&
      actualPreview &&
      (expectedPreview.startsWith(actualPreview) || actualPreview.startsWith(expectedPreview))
    ) {
      score += 25;
    }

    if (descriptor.source_kind === "community_group" && expectedCommunity) score += 10;
    return score;
  }

  function getChatClickTargets(row, expectedNames, preferRow = false) {
    const expected = new Set(
      (Array.isArray(expectedNames) ? expectedNames : [expectedNames])
        .map(normalizeComparable)
        .filter(Boolean)
    );
    const titledSpans = Array.from(row.querySelectorAll("span[title]"));
    const nameSpans = titledSpans.filter(
      (span) => expected.has(normalizeComparable(span.getAttribute("title")))
    );
    const targets = [];

    // For a Community subgroup, the scanner's nearest row is the most reliable
    // clickable identity. Clicking a title span first can accidentally select a
    // parent/community label when both labels are inside the same visual card.
    if (preferRow) {
      targets.push(row);
      if (row.firstElementChild instanceof HTMLElement) {
        targets.push(row.firstElementChild);
      }
    }

    for (const nameSpan of nameSpans) {
      targets.push(nameSpan);
      const interactiveAncestor = nameSpan.closest(
        '[role="button"], [tabindex="0"], [tabindex="-1"]'
      );
      if (interactiveAncestor && row.contains(interactiveAncestor)) {
        targets.push(interactiveAncestor);
      }
    }

    const innerInteractive = row.querySelector(
      '[role="button"], [tabindex="0"], [tabindex="-1"]'
    );
    if (innerInteractive) targets.push(innerInteractive);

    if (!preferRow && row.firstElementChild instanceof HTMLElement) {
      targets.push(row.firstElementChild);
    }

    targets.push(row);
    return uniqueElements(targets).filter((target) => target instanceof HTMLElement);
  }

  function activateChatTarget(target) {
    target.scrollIntoView({ block: "center", inline: "nearest" });
    target.focus?.({ preventScroll: true });

    const rectangle = target.getBoundingClientRect();
    const clientX = rectangle.left + Math.max(1, rectangle.width / 2);
    const clientY = rectangle.top + Math.max(1, rectangle.height / 2);
    const common = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX,
      clientY,
      button: 0,
      buttons: 1,
      view: window
    };

    if (typeof PointerEvent === "function") {
      target.dispatchEvent(
        new PointerEvent("pointerdown", {
          ...common,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true
        })
      );
    }

    target.dispatchEvent(new MouseEvent("mousedown", common));

    if (typeof PointerEvent === "function") {
      target.dispatchEvent(
        new PointerEvent("pointerup", {
          ...common,
          buttons: 0,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true
        })
      );
    }

    target.dispatchEvent(
      new MouseEvent("mouseup", {
        ...common,
        buttons: 0
      })
    );
    target.click();
  }

  function getEntryNameAliases(entry) {
    return Array.from(new Set([
      cleanText(entry?.name),
      cleanText(entry?.community_name),
      ...((entry?.title_aliases || []).map(cleanText))
    ].filter(Boolean)));
  }

  function getHeaderAliasesForEntry(entry) {
    const all = getEntryNameAliases(entry);
    if (entry?.source_kind !== "community_group" || !entry?.community_name) return all;

    // Untuk subgroup Community, nama Community bukan nama conversation. Versi lama
    // memasukkan community_name ke alias header sehingga panel/preview Community
    // dapat salah dianggap sebagai subgroup yang berhasil dibuka.
    const communityKey = normalizeComparable(entry.community_name);
    const childKey = normalizeComparable(entry.name);
    const strict = all.filter((name) => {
      const key = normalizeComparable(name);
      return key && (key === childKey || key !== communityKey);
    });
    return strict.length ? strict : [entry.name].filter(Boolean);
  }

  function matchEntryAgainstHeader(main, entry) {
    if (!main) return null;
    const aliases = new Map(
      getHeaderAliasesForEntry(entry).map((name) => [normalizeComparable(name), name])
    );
    if (aliases.size === 0) return null;

    for (const candidate of getHeaderNameCandidates(main)) {
      const key = normalizeComparable(candidate);
      if (aliases.has(key)) {
        return aliases.get(key);
      }
    }
    return null;
  }

  function findVisibleJoinOrRequestControl(expectedGroupName = "") {
    const expected = normalizeComparable(expectedGroupName);
    const controls = Array.from(document.querySelectorAll('button, [role="button"], a[role="button"], [tabindex]'))
      .filter((element) => element instanceof HTMLElement && isVisible(element));

    for (const control of controls) {
      const action = normalizeComparable(cleanText([
        control.innerText,
        control.getAttribute("aria-label"),
        control.getAttribute("title"),
        control.getAttribute("data-testid")
      ].filter(Boolean).join(" | ")));

      if (!/(?:^|\b)(join group|request to join|request to join group|minta bergabung|permintaan bergabung|gabung grup|bergabung ke grup)(?:$|\b)/.test(action)) continue;

      if (!expected) return control;
      let container = control.closest('[role="dialog"], [data-animate-modal-popup="true"]');
      if (!(container instanceof HTMLElement)) {
        container = control.parentElement?.parentElement?.parentElement || control.parentElement;
      }
      const contextText = normalizeComparable(cleanText(container?.innerText || ""));
      if (!contextText || contextText.includes(expected)) return control;
    }
    return null;
  }

  async function waitForCommunityConversationAccess(entry, timeoutMs = 12_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (findVisibleJoinOrRequestControl(entry?.name || "")) {
        const error = new Error(
          `Subgroup “${entry?.name || "Community group"}” terlihat di Community, tetapi akun ini belum menjadi anggota (UI menawarkan Join/Request to join). Chat dilewati.`
        );
        error.code = "COMMUNITY_NOT_MEMBER";
        throw error;
      }

      const main = document.querySelector("#main");
      const matchedName = matchEntryAgainstHeader(main, entry);
      if (main && matchedName) {
        canonicalizeEntryFromHeader(entry, matchedName);
        await waitForConversationBody(main, 3_500);
        return matchedName;
      }
      await sleep(160);
    }

    throw new Error(
      `Subgroup “${entry?.name || "Community group"}” tidak berhasil dibuka sebagai conversation aktif.`
    );
  }

  function canonicalizeEntryFromHeader(entry, matchedName) {
    const matched = cleanText(matchedName);
    if (!matched) return;

    const oldName = cleanText(entry.name);
    const oldCommunity = cleanText(entry.community_name);
    const matchedKey = normalizeComparable(matched);

    // Regression found in v0.8.x: on some Community rows the visual community
    // title received a higher scanner score than the child-group title. The
    // stored fields therefore became reversed. The clicked conversation header
    // is authoritative for chat_name, so swap when it matches community_name.
    if (
      oldCommunity &&
      matchedKey === normalizeComparable(oldCommunity) &&
      matchedKey !== normalizeComparable(oldName)
    ) {
      entry.name = oldCommunity;
      entry.community_name = oldName || null;
      entry.source_kind = "community_group";
    } else if (matchedKey !== normalizeComparable(oldName)) {
      entry.name = matched;
    }

    entry.title_aliases = Array.from(new Set([
      ...(entry.title_aliases || []),
      oldName,
      oldCommunity,
      matched
    ].filter(Boolean)));
  }

  async function waitForConversationEntry(entry, timeoutMs = 12_000) {
    const deadline = Date.now() + timeoutMs;
    let stableMatches = 0;
    let lastMatchKey = "";

    while (Date.now() < deadline) {
      const main = document.querySelector("#main");
      const matchedName = matchEntryAgainstHeader(main, entry);
      const matchKey = normalizeComparable(matchedName || "");

      if (main && matchedName) {
        if (matchKey === lastMatchKey) stableMatches += 1;
        else {
          lastMatchKey = matchKey;
          stableMatches = 1;
        }

        if (stableMatches >= 2) {
          canonicalizeEntryFromHeader(entry, matchedName);
          await waitForConversationBody(main, 3_500);
          return matchedName;
        }
      } else {
        stableMatches = 0;
        lastMatchKey = "";
      }

      await sleep(180);
    }

    const aliases = getEntryNameAliases(entry);
    throw new Error(
      `Chat tidak berhasil dikonfirmasi pada header. Alias yang diharapkan: “${aliases.join(" | ")}”.`
    );
  }

  async function waitForConversationBody(main, timeoutMs = 6_000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (!main.isConnected) break;

      const hasMessage = findRenderedMessageRoots(main).length > 0;
      const scroller = findMessageScroller(main);

      // Header sering siap lebih dulu daripada virtual message scroller.
      if (hasMessage && scroller) {
        await sleep(350);
        return;
      }

      if (hasMessage) {
        await sleep(550);
        if (findMessageScroller(main)) return;
      }

      await sleep(180);
    }

    // Jangan gagalkan openChat. scrapeConversation memiliki resolver yang
    // menunggu ulang dan lebih agresif.
    await sleep(300);
  }

  function getHeaderNameCandidates(main) {
    if (!main) {
      return [];
    }

    const header = main.querySelector("header");
    if (!header) {
      return [];
    }

    const candidates = [];
    const add = (value) => {
      const cleaned = cleanText(value);
      if (cleaned && cleaned.length <= 300) {
        candidates.push(cleaned);
      }
    };

    // Nama chat bisa berada pada textContent, title, atau aria-label,
    // tergantung tipe chat dan versi antarmuka WhatsApp Web.
    const elements = header.querySelectorAll(
      'span[title], [title], span[dir="auto"], [aria-label], [role="button"] span'
    );

    for (const element of elements) {
      if (!isVisible(element)) {
        continue;
      }

      add(element.getAttribute?.("title"));
      add(element.getAttribute?.("aria-label"));
      add(element.textContent);
    }

    for (const line of cleanText(header.innerText)
      .split("\n")
      .map(cleanText)
      .filter(Boolean)) {
      add(line);
    }

    return Array.from(new Set(candidates));
  }

  function extractCurrentChatName(main, expectedName = null) {
    const candidates = getHeaderNameCandidates(main);

    if (expectedName) {
      const expected = normalizeComparable(expectedName);
      const exact = candidates.find(
        (candidate) => normalizeComparable(candidate) === expected
      );
      if (exact) {
        return exact;
      }
    }

    // Untuk diagnostik, prioritaskan baris pertama header. Jangan lagi memilih
    // span[title] pertama karena pada grup elemen itu sering berisi daftar anggota.
    const header = main?.querySelector("header");
    const firstLine = cleanText(header?.innerText)
      .split("\n")
      .map(cleanText)
      .find(Boolean);

    return firstLine || candidates[0] || null;
  }

  async function scrapeConversation(entry, options, onProgress = () => {}) {
    const main = document.querySelector("#main");

    if (!main) {
      throw new Error("Panel percakapan tidak ditemukan.");
    }

    // Tunggu container pesan sesudah chat dibuka. WhatsApp dapat mengganti
    // header lebih dulu dan baru memasang virtual scroller beberapa saat kemudian.
    let scroller = await waitForMessageScroller(main, 6_000);
    const initialScrollerDiagnostics = describeMessageScroller(scroller, main);
    const collector = new Map();
    const orderPositions = new Map();
    const imageStates = new Map();
    let captureOrder = 0;
    let scrollStepsUsed = 0;
    let successfulLoadBatches = 0;
    let noProgressRounds = 0;
    let totalWaitMs = 0;
    let stopReason = "initial_messages_only";

    const collect = () => {
      const sizeBefore = collector.size;
      const messages = collectRenderedMessages(main, captureOrder);
      captureOrder += messages.length;
      mergeRenderedMessageOrder(messages, orderPositions);

      for (const message of messages) {
        registerImageCandidate(entry, message, options, imageStates);

        const orderPosition = orderPositions.get(message.id);
        const {
          _image_candidates: _imageCandidates,
          _image_candidate: _imageCandidate,
          ...messageForStorage
        } = message;
        const orderedMessage = {
          ...messageForStorage,
          dom_order_position: Number.isFinite(orderPosition)
            ? orderPosition
            : null
        };
        const existing = collector.get(message.id);

        if (
          !existing ||
          messageQuality(orderedMessage) > messageQuality(existing)
        ) {
          collector.set(message.id, orderedMessage);
        } else if (
          !Number.isFinite(existing.dom_order_position) &&
          Number.isFinite(orderPosition)
        ) {
          existing.dom_order_position = orderPosition;
        }
      }

      return collector.size - sizeBefore;
    };

    const reportProgress = () => {
      const imageStats = summarizeImageStates(imageStates);
      onProgress({
        captured_messages: Math.min(collector.size, options.maxMessages),
        scroll_steps_used: scrollStepsUsed,
        successful_load_batches: successfulLoadBatches,
        no_progress_rounds: noProgressRounds,
        total_wait_ms: totalWaitMs,
        images_detected: imageStats.images_detected,
        images_exported: imageStats.images_exported,
        images_high_quality: imageStats.images_high_quality,
        images_readable: imageStats.images_readable,
        images_low_quality: imageStats.images_low_quality,
        images_failed: imageStats.images_failed,
        images_pending: imageStats.images_pending
      });
    };

    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      await sleep(650);
    }

    collect();
    if (options.exportImages) {
      scroller = await processPendingImageCaptures({
        entry, main, scroller, options, imageStates, collect
      });
    }
    reportProgress();

    if (!scroller) {
      stopReason = "message_scroller_not_found";
    } else {
      for (let step = 0; step < options.dynamicScrollHardCap; step += 1) {
        // Titik henti di tengah chat: pesan yang sudah terkumpul dipertahankan.
        if (isStopRequested()) {
          stopReason = "stopped_by_user";
          break;
        }

        if (collector.size >= options.maxMessages) {
          stopReason = "target_reached";
          break;
        }

        if (!scroller.isConnected) {
          scroller = await waitForMessageScroller(main, 1_500);
        }

        if (!scroller) {
          scroller = await waitForMessageScroller(main, 2_500);
        }

        if (!scroller) {
          stopReason = "message_scroller_not_found";
          break;
        }

        scrollStepsUsed += 1;
        const countBefore = collector.size;
        const clickedOlder = clickOlderMessagesButton(main);
        if (!clickedOlder) triggerOlderMessagesLoad(scroller, main);

        const waitResult = await waitForOlderMessageProgress({
          main,
          scroller,
          collect,
          getCollectedCount: () => collector.size,
          countBefore,
          maxWaitMs: options.maxLoadWaitMs
        });

        totalWaitMs += waitResult.waitedMs;
        if (waitResult.scroller?.isConnected) scroller = waitResult.scroller;

        if (waitResult.progress) {
          successfulLoadBatches += 1;
          noProgressRounds = 0;

          // Beri virtual list waktu menyelesaikan satu render tambahan. Kadang
          // satu batch muncul bertahap setelah perubahan pertama terdeteksi.
          await sleep(350);
          collect();
        } else {
          noProgressRounds += 1;
        }

        // Media diproses saat bubble masih berada di DOM. Mode readable
        // menjalankan queue secara serial agar viewer WhatsApp tidak saling
        // bertabrakan ketika beberapa gambar terlihat pada batch yang sama.
        if (options.exportImages) {
          scroller = await processPendingImageCaptures({
            entry, main, scroller, options, imageStates, collect
          });
        }

        reportProgress();

        if (collector.size >= options.maxMessages) {
          stopReason = "target_reached";
          break;
        }

        if (noProgressRounds >= options.maxNoProgressRounds) {
          stopReason = "no_progress_timeout";
          break;
        }

        if (step === options.dynamicScrollHardCap - 1) {
          stopReason = "dynamic_safety_limit";
        }
      }
    }

    if (collector.size >= options.maxMessages) {
      stopReason = "target_reached";
    } else if (
      scroller &&
      stopReason === "initial_messages_only"
    ) {
      stopReason = "dynamic_safety_limit";
    }

    // Satu pass terakhir untuk kandidat yang masih terlihat sebelum sequence
    // final dibuat. Capture viewer dilakukan serial agar overlay selalu ditutup
    // sebelum scraper pindah ke chat berikutnya.
    if (options.exportImages) {
      scroller = await processPendingImageCaptures({
        entry, main, scroller, options, imageStates, collect
      });
    }
    await settleImageCaptures(imageStates);

    let messages = Array.from(collector.values());
    messages.sort(compareMessages);

    if (messages.length > options.maxMessages) {
      messages = messages.slice(-options.maxMessages);
    }

    messages = messages.map((message, index) => {
      const {
        dom_order_position: _internalDomOrder,
        _capture_order: _internalCaptureOrder,
        ...publicMessage
      } = message;
      return {
        ...publicMessage,
        sequence: index + 1,
        media: finalizeMessageMedia(publicMessage, imageStates, options)
      };
    });

    // Setelah sequence final diketahui, hubungkan quoted reply ke pesan target.
    // Jika target reply berada di luar rentang pesan yang diekspor, sequence
    // sengaja bernilai null agar tidak menunjuk ke pesan yang salah.
    messages = resolveReplySequences(messages);

    const mediaSummary = summarizeFinalMessagesMedia(messages);
    const imageFiles = Array.from(imageStates.entries())
      .filter(([, state]) => state?.status === "exported" && state?.blob)
      .map(([messageId, state]) => ({
        message_id: state.message_id || messageId,
        filename: state.filename,
        relative_path: state.relative_path,
        download_path: state.download_path,
        default_location: state.default_location,
        blob: state.blob,
        mime_type: state.mime_type,
        bytes: state.bytes,
        quality: state.quality,
        source: state.source
      }));

    // Kembalikan percakapan ke bagian terbaru sebelum berpindah ke chat lain.
    // Ini mencegah posisi scroll lama mengganggu render panel berikutnya.
    if (scroller?.isConnected) {
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      await sleep(450);
    }

    return {
      chat_id: entry.id,
      contact_id: extractNumericContactId(entry.identity_key),
      chat_name: entry.name,
      chat_type: inferChatType(main),
      source_kind: entry.source_kind || "chat",
      community_name: entry.community_name || null,
      membership_status: entry.membership_status || null,
      message_count: messages.length,
      media_summary: mediaSummary,
      image_files: imageFiles,
      extraction: {
        completed_at: new Date().toISOString(),
        requested_message_count: options.maxMessages,
        captured_message_count: messages.length,
        missing_message_count: Math.max(
          0,
          options.maxMessages - messages.length
        ),
        target_reached: messages.length >= options.maxMessages,
        stop_reason: stopReason,
        older_messages_requested: true,
        message_scroller_found: Boolean(scroller),
        message_scroller: initialScrollerDiagnostics,
        scroll_steps_used: scrollStepsUsed,
        successful_load_batches: successfulLoadBatches,
        no_progress_rounds: noProgressRounds,
        scroll_mode: "dynamic_target_based",
        internal_scroll_safety_cap: options.dynamicScrollHardCap,
        max_load_wait_ms_per_step: options.maxLoadWaitMs,
        total_wait_ms: totalWaitMs
      },
      messages
    };
  }

  function triggerOlderMessagesLoad(scroller, main = null) {
    if (!scroller) return;

    const currentTop = Math.max(0, Number(scroller.scrollTop || 0));
    const viewportHeight = Math.max(300, Number(scroller.clientHeight || 0));
    const distance = Math.max(620, Math.floor(viewportHeight * 0.95));
    const nextTop = currentTop <= 100 ? 0 : Math.max(0, currentTop - distance);

    try {
      if (typeof scroller.scrollTo === "function") {
        scroller.scrollTo({ top: nextTop, behavior: "instant" });
      }
    } catch (_error) {
      // Browser tertentu tidak mengenal behavior=instant.
    }

    scroller.scrollTop = nextTop;
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));

    try {
      scroller.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: -distance,
          bubbles: true,
          cancelable: true,
          composed: true
        })
      );
    } catch (_error) {
      // Synthetic wheel hanya pemicu tambahan.
    }

    // Fallback virtualizer: bila assignment tidak mengubah scrollTop, minta
    // bubble tertua yang sedang dirender masuk ke bagian atas viewport.
    if (
      main &&
      currentTop > 120 &&
      Math.abs(Number(scroller.scrollTop || 0) - currentTop) < 2
    ) {
      try {
        findRenderedMessageRoots(main)[0]?.scrollIntoView({
          block: "start",
          inline: "nearest"
        });
      } catch (_error) {
        // Tidak fatal.
      }
    }
  }

  function clickOlderMessagesButton(main) {
    // Hanya tombol aksi pemuatan, bukan teks pesan yang kebetulan serupa.
    for (const button of main?.querySelectorAll?.('button, [role="button"]') || []) {
      if (!isVisible(button)) continue;
      const labels = [button.getAttribute?.("aria-label"), button.getAttribute?.("title"), button.textContent]
        .map((value) => String(value || "").trim().replace(/\s+/g, " "));
      if (labels.some((value) => /^(?:muat|tampilkan|lihat|load|show|view) (?:lebih banyak )?(?:pesan|messages?) (?:lama|sebelumnya|older|previous|earlier)(?: lagi)?$/i.test(value))) {
        button.click();
        return true;
      }
    }
    return false;
  }

  async function waitForOlderMessageProgress({
    main,
    scroller,
    collect,
    getCollectedCount,
    countBefore,
    maxWaitMs
  }) {
    const startedAt = Date.now();
    let activeScroller = scroller;
    let previousHeight = activeScroller.scrollHeight;
    let previousTop = activeScroller.scrollTop;
    let lastDomMovementAt = startedAt;
    let lastNudgeAt = startedAt;
    let loadingSince = null;
    let extraWaitMs = 0;

    while (Date.now() - startedAt < maxWaitMs + extraWaitMs) {
      if (isStopRequested()) break;
      await sleep(280);

      if (!activeScroller.isConnected) {
        activeScroller = await waitForMessageScroller(main, 1_200);
        if (!activeScroller) {
          return {
            progress: false,
            waitedMs: Date.now() - startedAt,
            scrollerLost: true,
            scroller: null
          };
        }
      }

      collect();

      if (getCollectedCount() > countBefore) {
        return {
          progress: true,
          waitedMs: Date.now() - startedAt,
          scrollerLost: false,
          scroller: activeScroller
        };
      }

      const currentHeight = activeScroller.scrollHeight;
      const currentTop = activeScroller.scrollTop;
      const moved =
        Math.abs(currentHeight - previousHeight) > 2 ||
        Math.abs(currentTop - previousTop) > 2;

      if (moved) {
        lastDomMovementAt = Date.now();
        previousHeight = currentHeight;
        previousTop = currentTop;
      }

      // Jika WhatsApp masih menampilkan indikator pemuatan atau struktur scroll
      // masih berubah, tunggu sampai batas maksimum alih-alih menganggap gagal.
      const loading = isOlderMessagesLoading(main);
      if (loading) {
        if (loadingSince === null) loadingSince = Date.now();
        // Beri waktu tambahan bila indikator pemuatan nyata terlihat, terbatas.
        if (Date.now() - loadingSince >= 600) extraWaitMs = Math.min(20_000, maxWaitMs);
      } else loadingSince = null;
      const stableForMs = Date.now() - lastDomMovementAt;

      // Saat tidak berada di dekat atas dan tidak ada perubahan sama sekali,
      // lakukan dorongan tambahan supaya virtual list terus bergerak ke atas.
      if (!loading && stableForMs >= 900 && Date.now() - lastNudgeAt >= 1_200) {
        if (!clickOlderMessagesButton(main) && activeScroller.scrollTop > 0) {
          triggerOlderMessagesLoad(activeScroller, main);
        }
        lastNudgeAt = Date.now();
      }
    }

    collect();

    return {
      progress: getCollectedCount() > countBefore,
      waitedMs: Date.now() - startedAt,
      scrollerLost: false,
      scroller: activeScroller
    };
  }

  function isOlderMessagesLoading(main) {
    const candidates = main.querySelectorAll(
      '[role="progressbar"], [aria-busy="true"], [aria-label], [title]'
    );

    for (const element of candidates) {
      if (!isVisible(element)) {
        continue;
      }

      const semanticText = [
        element.getAttribute?.("aria-label"),
        element.getAttribute?.("title"),
        element.textContent
      ]
        .map(cleanText)
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase();

      if (
        element.getAttribute?.("role") === "progressbar" ||
        /loading|memuat|mengambil pesan|fetching messages/.test(semanticText)
      ) {
        return true;
      }
    }

    return false;
  }

  async function waitForMessageScroller(main, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (!main?.isConnected) return null;
      const scroller = findMessageScroller(main);
      if (scroller) return scroller;
      await sleep(180);
    }

    return findMessageScroller(main);
  }

  function findMessageScroller(main) {
    if (!main) return null;

    const candidates = new Set();
    const messageNodes = findRenderedMessageRoots(main);

    // Prioritas: naik dari bubble pesan yang benar-benar dirender. Ini tidak
    // bergantung pada nama class maupun overflow-y tertentu.
    for (const node of messageNodes.slice(0, 16)) {
      let current = node.parentElement;
      for (let depth = 0; current && current !== main && depth < 16; depth += 1) {
        if (hasScrollableGeometry(current)) candidates.add(current);
        current = current.parentElement;
      }
    }

    // Kandidat virtual viewport yang umum.
    for (const element of main.querySelectorAll(
      '[data-scroll-container], [data-virtualized], [role="application"], [tabindex]'
    )) {
      if (hasScrollableGeometry(element)) candidates.add(element);
    }

    // Fallback penuh. overflow:hidden tetap boleh karena beberapa virtualizer
    // mengubah scrollTop melalui JS pada container seperti ini.
    if (candidates.size === 0) {
      for (const element of main.querySelectorAll("div, section")) {
        if (hasScrollableGeometry(element)) candidates.add(element);
      }
    }

    const ranked = Array.from(candidates)
      .map((element) => ({ element, score: scrollerScore(element, main) }))
      .filter((item) => Number.isFinite(item.score) && item.score > 0)
      .sort((a, b) => b.score - a.score);

    return ranked[0]?.element || null;
  }

  function hasScrollableGeometry(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected) return false;

    const rectangle = element.getBoundingClientRect();
    if (rectangle.width < 280 || rectangle.height < 180) return false;

    const clientHeight = Number(element.clientHeight || 0);
    const scrollHeight = Number(element.scrollHeight || 0);
    return clientHeight > 0 && scrollHeight - clientHeight > 24;
  }

  function scrollerScore(element, main) {
    const rectangle = element.getBoundingClientRect();
    const scrollRange = Math.max(0, element.scrollHeight - element.clientHeight);
    const messageCount = findRenderedMessageRoots(element).length;
    let overflowY = "";
    try {
      overflowY = String(getComputedStyle(element).overflowY || "").toLowerCase();
    } catch (_error) {
      overflowY = "";
    }

    const overflowBonus = /auto|scroll|overlay/.test(overflowY) ? 2_000_000 : 0;
    const messageBonus = messageCount * 5_000_000;
    const rangeBonus = Math.min(scrollRange, 100_000) * 120;
    const areaBonus = Math.min(rectangle.width * rectangle.height, 2_000_000);
    const composerPenalty = element.querySelector("footer") ? 4_000_000 : 0;
    const equalsMainPenalty = element === main ? 8_000_000 : 0;

    return messageBonus + overflowBonus + rangeBonus + areaBonus - composerPenalty - equalsMainPenalty;
  }

  function describeMessageScroller(scroller, main) {
    if (!scroller) {
      return {
        found: false,
        strategy: "message_ancestor_and_geometry",
        visible_message_nodes: main?.querySelectorAll?.("[data-pre-plain-text]")?.length || 0
      };
    }

    let overflowY = null;
    try {
      overflowY = getComputedStyle(scroller).overflowY || null;
    } catch (_error) {
      overflowY = null;
    }

    return {
      found: true,
      strategy: "message_ancestor_and_geometry",
      tag: scroller.tagName?.toLowerCase?.() || null,
      overflow_y: overflowY,
      client_height: Number(scroller.clientHeight || 0),
      scroll_height: Number(scroller.scrollHeight || 0),
      initial_scroll_top: Number(scroller.scrollTop || 0),
      rendered_messages_inside: scroller.querySelectorAll?.("[data-pre-plain-text]")?.length || 0
    };
  }

  function mergeRenderedMessageOrder(messages, orderPositions) {
    const orderedIds = [];
    const seenIds = new Set();

    for (const message of messages) {
      if (!message?.id || seenIds.has(message.id)) {
        continue;
      }
      seenIds.add(message.id);
      orderedIds.push(message.id);
    }

    if (orderedIds.length === 0) {
      return;
    }

    const anchorOffsets = [];

    orderedIds.forEach((id, index) => {
      const knownPosition = orderPositions.get(id);
      if (Number.isFinite(knownPosition)) {
        anchorOffsets.push(knownPosition - index);
      }
    });

    let batchOffset;

    if (anchorOffsets.length > 0) {
      batchOffset = medianNumber(anchorOffsets);
    } else if (orderPositions.size === 0) {
      batchOffset = 0;
    } else {
      // Ekstraksi bergerak dari pesan terbaru ke pesan yang lebih lama.
      // Jika satu batch tidak memiliki overlap, letakkan seluruh batch sebelum
      // posisi tertua yang sudah diketahui agar urutan atas-ke-bawah tetap benar.
      const minimumKnownPosition = Math.min(...orderPositions.values());
      batchOffset = minimumKnownPosition - orderedIds.length - 1;
    }

    orderedIds.forEach((id, index) => {
      if (!orderPositions.has(id)) {
        orderPositions.set(id, batchOffset + index);
      }
    });
  }

  function medianNumber(values) {
    const sorted = values
      .filter(Number.isFinite)
      .slice()
      .sort((a, b) => a - b);

    if (sorted.length === 0) {
      return 0;
    }

    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) {
      return sorted[middle];
    }

    return (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function findRenderedMessageRoots(main) {
    const nodes = Array.from(main.querySelectorAll(
      '[data-pre-plain-text], .message-in, .message-out, [data-id^="true_"], [data-id^="false_"], [id^="true_"], [id^="false_"]'
    ));
    // Beberapa layout media-only hanya menyediakan row, tanpa metadata caption.
    // Batasi fallback ke row berisi media agar header/sidebar tidak menjadi pesan.
    for (const row of main.querySelectorAll('[role="row"]')) {
      if (nodes.some((node) => row.contains(node) || node.contains(row))) continue;
      if (findMessageImages(row).length > 0) nodes.push(row);
    }
    const roots = [...new Set(nodes.map(findMessageBubble))];
    // Satu bubble album dapat berisi beberapa node metadata/ID tile.
    return roots.filter((root) => !roots.some((other) => other !== root && other.contains(root)));
  }

  function collectRenderedMessages(main, captureOrderStart) {
    const metadataNodes = findRenderedMessageRoots(main);
    const results = [];

    metadataNodes.forEach((metadataNode, index) => {
      try {
        // parseMessageNode() mengembalikan null untuk bubble di luar lingkup
        // (video, stiker, dokumen tanpa caption) sehingga tidak masuk hasil.
        const message = parseMessageNode(metadataNode, captureOrderStart + index);
        if (message) results.push(message);
      } catch (_error) {
        // Satu pesan yang formatnya tidak dikenali tidak boleh menggagalkan ekspor.
      }
    });

    return results;
  }

  function parseMessageNode(metadataNode, captureOrder) {
    const bubble = findMessageBubble(metadataNode);
    const metadataRaw = cleanText(
      metadataNode.getAttribute("data-pre-plain-text") ||
      bubble.querySelector("[data-pre-plain-text]")?.getAttribute("data-pre-plain-text")
    );
    const parsedMetadata = parsePrePlainText(metadataRaw);
    const direction = detectDirection(bubble);
    const media = detectMedia(bubble);
    // BUG FIX: sebelumnya mode captionOnly hanya aktif untuk video/gambar,
    // sehingga stiker/voice note jatuh ke fallback span[dir] dan menangkap jam
    // pesan ("22:47") sebagai teks. Sekarang SEMUA bubble bermedia memakai
    // captionOnly, jadi hanya caption asli yang diambil.
    const text = extractMessageText(metadataNode, bubble, Boolean(media));
    const type = detectMessageType(text, media, bubble);

    // Media di luar gambar tidak diekspor. Tanpa caption, tidak ada yang
    // tersisa untuk disimpan sehingga bubble dilewati sepenuhnya.
    if (type === null) {
      return null;
    }

    const nativeId = extractNativeMessageId(metadataNode, bubble);
    const idSource = [
      nativeId,
      metadataRaw,
      type,
      text
    ]
      .filter(Boolean)
      .join("|");

    let id = nativeId || `msg-${simpleHash(idSource)}`;
    if (!nativeId && media?.detectedAs === "image") {
      // Caption bukan identitas foto. Dua foto tanpa metadata sebelumnya sama-sama
      // mendapat hash("img"), lalu saling menimpa di collector/antrean capture.
      // WeakMap mempertahankan ID selama bubble hidup tanpa menahan DOM lama.
      if (!anonymousMediaIds.has(bubble)) {
        anonymousMediaIds.set(bubble, `msg-media-${crypto.randomUUID()}`);
      }
      id = anonymousMediaIds.get(bubble);
    }

    return {
      id,
      sender: parsedMetadata.sender,
      timestamp_raw: parsedMetadata.timestampRaw,
      timestamp_iso: parsedMetadata.timestampIso,
      direction,
      type,
      text: text || null,
      media: buildInitialMediaMetadata(media),
      reply_to: extractReplyPreview(bubble, text, nativeId),
      _capture_order: captureOrder,
      // Semua tile album; representasi ganda disaring di findMessageImages().
      _image_candidates: media?.detectedAs === "image"
        ? media.imageElements.map(buildImageCandidate).filter(Boolean)
        : []
    };
  }

  // Metadata media hanya relevan untuk gambar; tipe lain tidak pernah sampai
  // ke sini karena sudah dilewati di parseMessageNode().
  function buildInitialMediaMetadata(media) {
    if (media?.detectedAs !== "image") {
      return null;
    }

    const result = { export_status: "metadata_only" };
    const candidate = buildImageCandidate(media.imageElement);
    const width = Number(candidate?.width || 0);
    const height = Number(candidate?.height || 0);

    if (width > 0) result.width = width;
    if (height > 0) result.height = height;
    result.source = "rendered_dom";
    if (candidate?.element_kind) result.render_kind = candidate.element_kind;

    return result;
  }

  function buildImageCandidate(imageElement) {
    if (!(imageElement instanceof HTMLElement)) {
      return null;
    }

    const rectangle = imageElement.getBoundingClientRect();
    let source = "";
    let elementKind = "element";

    if (imageElement instanceof HTMLImageElement) {
      source = imageElement.currentSrc || imageElement.getAttribute("src") || "";
      elementKind = "img";
    } else if (imageElement instanceof HTMLCanvasElement) {
      elementKind = "canvas";
    } else {
      source = extractBackgroundImageUrl(imageElement);
      elementKind = source ? "background" : "element";
    }

    const naturalWidth = imageElement instanceof HTMLImageElement
      ? imageElement.naturalWidth
      : imageElement instanceof HTMLCanvasElement
        ? imageElement.width
        : 0;
    const naturalHeight = imageElement instanceof HTMLImageElement
      ? imageElement.naturalHeight
      : imageElement instanceof HTMLCanvasElement
        ? imageElement.height
        : 0;

    return {
      source,
      width: naturalWidth || Math.round(rectangle.width) || null,
      height: naturalHeight || Math.round(rectangle.height) || null,
      rendered_width: Math.round(rectangle.width) || null,
      rendered_height: Math.round(rectangle.height) || null,
      element_kind: elementKind,
      element: imageElement
    };
  }

  function extractBackgroundImageUrl(element) {
    if (!(element instanceof HTMLElement)) return "";
    try {
      const value = getComputedStyle(element).backgroundImage || "";
      const match = value.match(/^url\(["']?(.*?)["']?\)$/);
      return match?.[1] || "";
    } catch (_error) {
      return "";
    }
  }

  function imageCandidateScore(candidate) {
    if (!candidate) return 0;
    const width = Number(candidate.width || candidate.rendered_width || 0);
    const height = Number(candidate.height || candidate.rendered_height || 0);
    return Math.max(0, width * height);
  }

  function imageCandidateSignature(candidate) {
    if (!candidate) return "";
    return [
      candidate.source || "",
      candidate.width || 0,
      candidate.height || 0,
      candidate.rendered_width || 0,
      candidate.rendered_height || 0,
      candidate.element_kind || ""
    ].join("|");
  }

  function registerImageCandidate(entry, message, options, imageStates) {
    if (message.type !== "image" && message.type !== "img") {
      return;
    }

    const candidates = Array.isArray(message._image_candidates)
      ? message._image_candidates
      : message._image_candidate
        ? [message._image_candidate]
        : [];

    candidates.forEach((candidate, imageIndex) => {
      const stateKey = `${message.id}::image-${imageIndex + 1}`;
      let state = imageStates.get(stateKey);

      if (!state) {
        state = {
          message_id: message.id,
          image_index: imageIndex,
          status: options.exportImages ? "detected" : "metadata_only",
          attempts: 0,
          promise: null,
          candidate: candidate || null,
          candidate_signature: imageCandidateSignature(candidate),
          last_attempt_signature: null,
          width: candidate?.width || message.media?.width || null,
          height: candidate?.height || message.media?.height || null,
          filename: null,
          relative_path: null,
          download_path: null,
          saved_path: null,
          default_location: null,
          mime_type: null,
          bytes: 0,
          source: null,
          quality: null,
          blob: null,
          viewer_attempted: false,
          fallback_used: false,
          warning: null,
          error: null
        };
        imageStates.set(stateKey, state);
      } else if (candidate) {
        const currentScore = imageCandidateScore(state.candidate);
        const nextScore = imageCandidateScore(candidate);
        if (!state.candidate || nextScore >= currentScore || !state.candidate.element?.isConnected) {
          state.candidate = candidate;
          state.candidate_signature = imageCandidateSignature(candidate);
        }
        if ((!state.width || candidate.width > state.width) && candidate.width) state.width = candidate.width;
        if ((!state.height || candidate.height > state.height) && candidate.height) state.height = candidate.height;
      }

      if (!options.exportImages) state.status = "metadata_only";
    });
  }

  function canAttemptImageState(state, options) {
    if (!state?.candidate) return false;
    if (state.status === "pending") return false;
    if (state.attempts >= options.maxImageAttempts) return false;
    if (state.status === "exported") return false;

    const candidate = state.candidate;
    const hasSource = Boolean(candidate.source);
    const hasElement = Boolean(candidate.element);
    return hasSource || hasElement;
  }

  async function processPendingImageCaptures({
    entry, main, scroller, options, imageStates, collect = null
  }) {
    // v0.8.8: jangan membuat snapshot queue berisi HTMLElement lama. Membuka
    // media viewer dapat membuat React/virtualizer mengganti bubble lain, sehingga
    // kandidat yang tadinya connected menjadi stale. Queue sekarang dievaluasi
    // ulang sebelum SETIAP gambar dan collect() dipanggil lagi setelah viewer.
    let activeScroller = scroller;
    const attemptedThisPass = new Set();
    let guard = 0;
    const guardLimit = Math.max(12, imageStates.size * 5 + 10);

    while (guard < guardLimit) {
      guard += 1;

      // Titik henti antar-gambar. Membuka media viewer memakan waktu, jadi STOP
      // harus terasa langsung tanpa menunggu seluruh antrean selesai.
      if (isStopRequested()) break;

      if (typeof collect === "function") {
        try { collect(); } catch (_error) {}
      }

      let selected = null;
      for (const [messageId, state] of imageStates.entries()) {
        if (!canAttemptImageState(state, options)) continue;
        const signature = state.candidate_signature || imageCandidateSignature(state.candidate);
        const passKey = `${messageId}::${signature}`;
        if (attemptedThisPass.has(passKey)) continue;
        selected = { messageId, state, passKey };
        break;
      }

      if (!selected) break;

      const { messageId, state, passKey } = selected;
      attemptedThisPass.add(passKey);
      state.status = "pending";
      state.attempts += 1;
      state.last_attempt_signature = state.candidate_signature;
      state.error = null;

      try {
        const result = await captureImageSmart({
          chatName: entry.name,
          messageId,
          candidate: state.candidate,
          main,
          scroller: activeScroller,
          options
        });

        state.status = "exported";
        state.filename = result.filename;
        state.relative_path = result.relative_path;
        state.download_path = result.download_path || null;
        state.saved_path = result.saved_path || null;
        state.default_location = result.default_location || null;
        state.mime_type = result.mime_type;
        state.bytes = result.bytes;
        state.width = result.width || state.width;
        state.height = result.height || state.height;
        state.source = result.source;
        state.quality = result.quality;
        state.blob = result.blob || state.blob || null;
        state.viewer_attempted = result.viewer_attempted === true;
        state.fallback_used = result.fallback_used === true;
        state.warning = result.warning || null;
        state.error = null;
      } catch (error) {
        state.status = "failed";
        state.error = normalizeError(error);
      }

      activeScroller = await waitForMessageScroller(main, 1_500) || activeScroller;

      // Sangat penting: viewer sering memicu rerender bubble. Refresh collector
      // sekarang agar state gambar berikutnya menunjuk ke elemen DOM terbaru.
      if (typeof collect === "function") {
        try { collect(); } catch (_error) {}
      }
    }

    return activeScroller;
  }

  async function captureImageSmart({ chatName, messageId, candidate, main, scroller, options }) {
    const database = options.mediaDatabase ||= { units: new Map(), files: new Map() };
    const unitId = JSON.stringify([chatName, messageId]);
    if (database.units.has(unitId)) return database.units.get(unitId);
    // Catat promise sebelum I/O: pemanggilan bersamaan berbagi pekerjaan yang sama.
    const pending = captureImageUnit({ chatName, messageId, candidate, main, scroller, options });
    database.units.set(unitId, pending);
    try {
      return await pending;
    } catch (error) {
      database.units.delete(unitId); // Kegagalan tidak dianggap sudah diproses.
      throw error;
    }
  }

  async function captureImageUnit({ chatName, messageId, candidate, main, scroller, options }) {
    let previewResult = null;
    let viewerResult = null;
    let previewError = null;
    let viewerError = null;
    let viewerAttempted = false;

    try {
      previewResult = await resolveImageElementCapture(
        candidate,
        options.imageLoadWaitMs,
        "rendered_dom"
      );
    } catch (error) {
      previewError = error;
    }

    // SEDERHANA: saat export gambar aktif, SELALU coba buka media viewer terlebih
    // dahulu (buka->simpan) untuk mendapat file kualitas terbaik, lalu fallback ke
    // resource DOM bila viewer gagal. Mode preview/readable tidak lagi mengontrol
    // perilaku — keduanya menambah kompleksitas tanpa manfaat nyata.
    const shouldTryViewer = candidate?.element?.isConnected;

    if (shouldTryViewer) {
      viewerAttempted = true;
      try {
        viewerResult = await captureFromWhatsAppViewer({
          candidate,
          main,
          scroller,
          maxWaitMs: options.imageLoadWaitMs
        });
      } catch (error) {
        viewerError = error;
      }
    }

    const best = chooseBestImageCapture(previewResult, viewerResult);
    if (!best?.blob?.size) {
      const details = [viewerError, previewError]
        .filter(Boolean)
        .map(normalizeError)
        .join(" | ");
      throw new Error(`Gambar terdeteksi tetapi tidak ada resource yang dapat disimpan${details ? `: ${details}` : "."}`);
    }

    if (best.blob.size > options.maxImageBytes) {
      throw new Error(
        `Gambar ${Math.ceil(best.blob.size / 1024 / 1024)} MB melebihi batas v0.9.2 (${Math.ceil(options.maxImageBytes / 1024 / 1024)} MB per gambar).`
      );
    }

    const quality = classifyImageQuality(best.width, best.height, best.blob.size);
    const fallbackUsed = viewerAttempted && best.source !== "viewer";
    let warning = null;
    if (quality === "low") {
      warning = viewerAttempted
        ? "Versi viewer tidak tersedia/lebih baik; file fallback masih beresolusi rendah dan mungkin sulit dibaca."
        : "Resource yang tersedia beresolusi rendah dan mungkin sulit dibaca.";
    } else if (fallbackUsed) {
      warning = "Media viewer gagal/tidak memberi versi lebih baik; preview DOM dipakai karena masih memenuhi ambang readable.";
    }

    const saved = await downloadImageCapture({
      chatName,
      messageId,
      capture: best,
      options
    });

    return {
      ...saved,
      blob: best.blob,
      source: best.source,
      quality,
      viewer_attempted: viewerAttempted,
      fallback_used: fallbackUsed,
      warning
    };
  }

  function chooseBestImageCapture(preview, viewer) {
    if (!preview) return viewer;
    if (!viewer) return preview;

    const previewRank = imageQualityRank(
      classifyImageQuality(preview.width, preview.height, preview.blob?.size || 0)
    );
    const viewerRank = imageQualityRank(
      classifyImageQuality(viewer.width, viewer.height, viewer.blob?.size || 0)
    );

    if (viewerRank !== previewRank) {
      return viewerRank > previewRank ? viewer : preview;
    }

    const viewerPixels = Number(viewer.width || 0) * Number(viewer.height || 0);
    const previewPixels = Number(preview.width || 0) * Number(preview.height || 0);
    if (viewerPixels !== previewPixels) {
      return viewerPixels > previewPixels ? viewer : preview;
    }

    return (viewer.blob?.size || 0) >= (preview.blob?.size || 0) ? viewer : preview;
  }

  function imageQualityRank(quality) {
    return quality === "high" ? 3 : quality === "readable" ? 2 : 1;
  }

  function classifyImageQuality(width, height, bytes = 0) {
    const w = Number(width || 0);
    const h = Number(height || 0);
    const longEdge = Math.max(w, h);
    const shortEdge = Math.min(w, h);
    const pixels = Math.max(0, w * h);
    const size = Number(bytes || 0);

    if (
      (longEdge >= 1600 && shortEdge >= 700 && pixels >= 1_500_000) ||
      (pixels >= 2_000_000 && size >= 80_000)
    ) {
      return "high";
    }

    if (
      (longEdge >= 900 && shortEdge >= 420 && pixels >= 450_000 && size >= 25_000) ||
      (longEdge >= 1200 && pixels >= 350_000 && size >= 20_000)
    ) {
      return "readable";
    }

    return "low";
  }

  async function downloadImageCapture({ chatName, messageId, capture, options }) {
    const blob = capture.blob;
    const database = options.mediaDatabase ||= { units: new Map(), files: new Map() };
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    const uniqueKey = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (database.files.has(uniqueKey)) return database.files.get(uniqueKey);
    const mimeType = normalizeImageMime(blob.type, capture.source_url || "");
    const extension = imageExtensionForMime(mimeType);
    const chatFolder = `${sanitizePathSegment(chatName).slice(0, 70)}-${simpleHash(chatName).slice(0, 6)}`;
    const filename = `image-${uniqueKey}.${extension}`;
    const relativePath = `img/${chatFolder}/${filename}`;
    const downloadPath = `${options.exportRoot}/${relativePath}`;

    const result = {
      unique_key: uniqueKey,
      filename,
      relative_path: relativePath,
      download_path: downloadPath,
      default_location: `Downloads/${downloadPath}`,
      saved_path: relativePath,
      mime_type: mimeType,
      bytes: blob.size,
      width: capture.width || null,
      height: capture.height || null,
      blob
    };
    database.files.set(uniqueKey, result);
    return result;
  }

  async function buildExportZipBundle({ exportRoot, payload, exportedChats = [] }) {
    // v0.9.3: satu kontak/grup = satu file JSON. Folder messages berisi tepat
    // sebanyak chat yang berhasil di-scrape, bukan satu file gabungan.
    const files = [];
    const jsonFiles = [];
    const usedFilenames = new Set();

    for (const chat of exportedChats) {
      if (!chat) continue;

      const filename = buildChatJsonFilename(chat, usedFilenames);
      const relativePath = `messages/${filename}`;
      const chatPayload = buildChatJsonPayload({ payload, chat, relativePath });

      files.push({
        path: `${exportRoot}/${relativePath}`,
        data: JSON.stringify(chatPayload, null, 2)
      });
      jsonFiles.push({
        chat_id: chat.chat_id || null,
        chat_name: chat.chat_name || null,
        community_name: chat.community_name || null,
        source_kind: chat.source_kind || "chat",
        filename,
        relative_path: relativePath,
        message_count: Number(chat.message_count || 0)
      });
    }

    // Ringkasan gabungan tetap tersedia, tetapi disimpan di akar arsip agar
    // folder messages hanya memuat file per chat.
    files.push({
      path: `${exportRoot}/export-summary.json`,
      data: JSON.stringify(buildExportSummaryJson({ payload, jsonFiles }), null, 2)
    });

    // Daftar ini sengaja hanya memuat chat yang berhasil dibaca dan dimasukkan
    // ke arsip. File tersebut dapat diunggah ke ekspor berikutnya untuk mengunci
    // ulang pilihan berdasarkan nama persis atau ID angka.
    files.push({
      path: `${exportRoot}/exported-contacts.csv`,
      data: ContactList.buildExportedContactsCsv(exportedChats)
    });

    const includedPaths = new Set();

    for (const chat of exportedChats) {
      const imageFiles = Array.isArray(chat?.image_files) ? chat.image_files : [];
      for (const image of imageFiles) {
        const blob = image?.blob;
        if (!(blob instanceof Blob)) continue;

        const relative = String(image.relative_path || "").replace(/^\.+\//, "");
        const zipPath = `${exportRoot}/${relative}`;
        if (includedPaths.has(zipPath)) continue;
        includedPaths.add(zipPath);
        files.push({ path: zipPath, data: blob });
      }
    }

    return { blob: await createZipBlob(files), jsonFiles };
  }

  function buildChatJsonFilename(chat, usedFilenames = new Set()) {
    // Nama file memakai konvensi yang sama dengan folder img/: nama chat yang
    // sudah disanitasi plus hash pendek, sehingga dua chat dengan nama mirip
    // (atau nama yang sama di Community berbeda) tidak saling menimpa.
    const rawName = chat?.chat_name || chat?.chat_id || "chat";
    const identity = [
      chat?.chat_id || "",
      chat?.chat_name || "",
      chat?.community_name || ""
    ].join("|");
    const base = `${sanitizePathSegment(rawName).slice(0, 70)}-${simpleHash(identity).slice(0, 6)}`;

    let filename = `${base}.json`;
    let suffix = 2;
    while (usedFilenames.has(filename)) {
      filename = `${base}-${suffix}.json`;
      suffix += 1;
    }
    usedFilenames.add(filename);

    return filename;
  }

  function buildChatJsonPayload({ payload, chat, relativePath }) {
    const { output, export_summary: _summary, errors: _errors, ...shared } = payload || {};

    return {
      ...shared,
      output: {
        ...(output || {}),
        json_file: relativePath
      },
      chat: sanitizeChatForJson(chat)
    };
  }

  function buildExportSummaryJson({ payload, jsonFiles = [] }) {
    return {
      ...(payload || {}),
      chat_files: jsonFiles
    };
  }

  function sanitizeChatForJson(chat) {
    if (!chat || typeof chat !== "object") return chat;

    // Blob gambar hanya dipakai untuk menyusun ZIP. JSON.stringify akan
    // mengubahnya menjadi objek kosong, jadi buang dan simpan metadatanya saja.
    const imageFiles = Array.isArray(chat.image_files)
      ? chat.image_files.map(({ blob: _blob, ...metadata }) => metadata)
      : chat.image_files;

    return { ...chat, image_files: imageFiles };
  }

  async function createZipBlob(entries = []) {
    const encoder = new TextEncoder();
    const archiveParts = [];
    const centralDirectory = [];
    let offset = 0;

    for (const entry of entries) {
      const name = String(entry.path || "").replace(/\\/g, "/");
      let data;
      if (entry.data instanceof Blob) {
        data = new Uint8Array(await entry.data.arrayBuffer());
      } else if (typeof entry.data === "string") {
        data = encoder.encode(entry.data);
      } else {
        data = new Uint8Array(entry.data || []);
      }

      const nameBytes = encoder.encode(name);
      const crc = crc32Bytes(data);
      const modTime = 0;
      const modDate = 0;

      const localHeader = new Uint8Array(30 + nameBytes.length);
      const localView = new DataView(localHeader.buffer);
      localView.setUint32(0, 0x04034b50, true);
      localView.setUint16(4, 20, true);
      localView.setUint16(6, 0, true);
      localView.setUint16(8, 0, true);
      localView.setUint16(10, modTime, true);
      localView.setUint16(12, modDate, true);
      localView.setUint32(14, crc >>> 0, true);
      localView.setUint32(18, data.length, true);
      localView.setUint32(22, data.length, true);
      localView.setUint16(26, nameBytes.length, true);
      localView.setUint16(28, 0, true);
      localHeader.set(nameBytes, 30);

      archiveParts.push(localHeader, data);

      const centralHeader = new Uint8Array(46 + nameBytes.length);
      const centralView = new DataView(centralHeader.buffer);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0, true);
      centralView.setUint16(10, 0, true);
      centralView.setUint16(12, modTime, true);
      centralView.setUint16(14, modDate, true);
      centralView.setUint32(16, crc >>> 0, true);
      centralView.setUint32(20, data.length, true);
      centralView.setUint32(24, data.length, true);
      centralView.setUint16(28, nameBytes.length, true);
      centralView.setUint16(30, 0, true);
      centralView.setUint16(32, 0, true);
      centralView.setUint16(34, 0, true);
      centralView.setUint16(36, 0, true);
      centralView.setUint32(38, 0, true);
      centralView.setUint32(42, offset, true);
      centralHeader.set(nameBytes, 46);
      centralDirectory.push(centralHeader);

      offset += localHeader.length + data.length;
    }

    const centralDirectoryBytes = concatUint8Arrays(centralDirectory);
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, 0x06054b50, true);
    eocdView.setUint16(4, 0, true);
    eocdView.setUint16(6, 0, true);
    eocdView.setUint16(8, entries.length, true);
    eocdView.setUint16(10, entries.length, true);
    eocdView.setUint32(12, centralDirectoryBytes.length, true);
    eocdView.setUint32(16, offset, true);
    eocdView.setUint16(20, 0, true);

    const zipBytes = concatUint8Arrays([
      ...archiveParts,
      centralDirectoryBytes,
      eocd
    ]);

    return new Blob([zipBytes], { type: "application/zip" });
  }

  function concatUint8Arrays(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + (chunk?.length || 0), 0);
    const output = new Uint8Array(total);
    let cursor = 0;

    for (const chunk of chunks) {
      output.set(chunk, cursor);
      cursor += chunk.length;
    }

    return output;
  }

  const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32Bytes(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
      crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  async function resolveImageElementCapture(candidate, maxWaitMs, sourceLabel = "rendered_dom") {
    if (!candidate) {
      throw new Error("Kandidat gambar tidak tersedia.");
    }

    const element = candidate.element;
    let fetchError = null;
    let blob = null;

    // Jangan mempercayai src snapshot dari saat collect(). Gambar WhatsApp yang
    // baru sering mengganti placeholder/blob setelah beberapa ratus milidetik.
    // Tunggu elemen terkini siap lalu baca currentSrc TERBARU.
    if (element instanceof HTMLImageElement && element.isConnected) {
      try {
        await waitForImageReady(element, Math.min(maxWaitMs, 4_000));
        await waitForImageSourceSettle(element, Math.min(maxWaitMs, 2_000));
      } catch (_error) {
        // Fetch/canvas fallback tetap dicoba.
      }
    }

    let source = "";
    if (element instanceof HTMLImageElement) {
      source = element.currentSrc || element.getAttribute("src") || candidate.source || "";
    } else if (element instanceof HTMLElement && !(element instanceof HTMLCanvasElement)) {
      source = extractBackgroundImageUrl(element) || candidate.source || "";
    } else {
      source = candidate.source || "";
    }

    if (source) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), maxWaitMs);
        try {
          const response = await fetch(source, {
            credentials: "include",
            signal: controller.signal
          });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          const fetched = await response.blob();
          if (fetched.size > 0) blob = fetched;
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        fetchError = error;
      }
    }

    if (!blob && element instanceof HTMLImageElement) {
      try {
        await waitForImageReady(element, maxWaitMs);
        blob = await imageElementToBlob(element);
      } catch (canvasError) {
        const details = [fetchError, canvasError]
          .filter(Boolean)
          .map(normalizeError)
          .join(" | ");
        throw new Error(`Resource gambar tidak dapat disalin: ${details}`);
      }
    }

    if (!blob && element instanceof HTMLCanvasElement) {
      try {
        blob = await canvasElementToBlob(element);
      } catch (canvasError) {
        const details = [fetchError, canvasError]
          .filter(Boolean)
          .map(normalizeError)
          .join(" | ");
        throw new Error(`Canvas gambar tidak dapat disalin: ${details}`);
      }
    }

    if (!blob?.size) {
      throw new Error(
        `Source gambar tidak tersedia${fetchError ? `: ${normalizeError(fetchError)}` : "."}`
      );
    }

    const dimensions = await getBlobImageDimensions(blob);
    return {
      blob,
      width: dimensions.width || candidate.width || null,
      height: dimensions.height || candidate.height || null,
      source: sourceLabel,
      source_url: source
    };
  }

  async function waitForImageSourceSettle(image, maxWaitMs = 2_000) {
    const startedAt = Date.now();
    let lastSignature = "";
    let stableSince = 0;

    while (Date.now() - startedAt < maxWaitMs) {
      const signature = [
        image.currentSrc || image.getAttribute("src") || "",
        image.naturalWidth || 0,
        image.naturalHeight || 0,
        image.complete ? 1 : 0
      ].join("|");

      if (signature !== lastSignature) {
        lastSignature = signature;
        stableSince = Date.now();
      } else if (image.complete && image.naturalWidth > 0 && Date.now() - stableSince >= 450) {
        return;
      }

      await sleep(120);
    }
  }

  async function canvasElementToBlob(canvas) {
    return await new Promise((resolve, reject) => {
      try {
        canvas.toBlob(
          (blob) => blob ? resolve(blob) : reject(new Error("Canvas gagal membuat blob gambar.")),
          "image/png"
        );
      } catch (error) {
        reject(error);
      }
    });
  }

  async function getBlobImageDimensions(blob) {
    try {
      if (typeof createImageBitmap === "function") {
        const bitmap = await createImageBitmap(blob);
        const result = { width: bitmap.width, height: bitmap.height };
        bitmap.close?.();
        return result;
      }
    } catch (_error) {
      // fallback di bawah
    }
    return { width: null, height: null };
  }

  async function captureFromWhatsAppViewer({ candidate, main, scroller, maxWaitMs }) {
    const image = candidate?.element;
    if (!(image instanceof HTMLElement) || !image.isConnected) {
      throw new Error("Bubble gambar sudah tidak berada di DOM untuk membuka viewer.");
    }

    const savedTop = Number(scroller?.scrollTop || 0);
    const viewerBefore = findLikelyViewerImage(main, image);
    if (viewerBefore) {
      await closeWhatsAppViewer(main, viewerBefore);
    }

    const clickTarget = findImageViewerClickTarget(image);
    dispatchClickSequence(clickTarget || image);

    let viewerImage = null;
    try {
      viewerImage = await waitForStableViewerImage(main, image, maxWaitMs);
      const viewerCandidate = buildImageCandidate(viewerImage);
      if (!viewerCandidate) {
        throw new Error("Elemen gambar pada media viewer tidak dapat dibaca.");
      }
      const result = await resolveImageElementCapture(
        viewerCandidate,
        maxWaitMs,
        "viewer"
      );
      return result;
    } finally {
      const activeViewerImage = viewerImage || findLikelyViewerImage(main, image);
      if (activeViewerImage) {
        await closeWhatsAppViewer(main, activeViewerImage).catch(() => {});
      }
      const refreshedScroller = await waitForMessageScroller(main, 1_200);
      if (refreshedScroller) {
        refreshedScroller.scrollTop = Math.min(savedTop, refreshedScroller.scrollHeight);
        refreshedScroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        await sleep(180);
      }
    }
  }

  function findImageViewerClickTarget(image) {
    let current = image;
    for (let depth = 0; current && depth < 6; depth += 1) {
      const role = cleanText(current.getAttribute?.("role")).toLowerCase();
      if (
        current.tagName === "BUTTON" ||
        current.tagName === "A" ||
        role === "button" ||
        current.tabIndex >= 0
      ) {
        return current;
      }
      current = current.parentElement;
    }
    return image;
  }

  function dispatchClickSequence(element) {
    if (!element) return;
    try {
      element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    } catch (_error) {
      // optional
    }
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      try {
        const EventCtor = type.startsWith("pointer") && typeof PointerEvent === "function"
          ? PointerEvent
          : MouseEvent;
        element.dispatchEvent(new EventCtor(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 0
        }));
      } catch (_error) {
        // Continue with native click below.
      }
    }
    try { element.click(); } catch (_error) {}
  }

  async function waitForStableViewerImage(main, originalImage, maxWaitMs) {
    const startedAt = Date.now();
    let best = null;
    let bestSignature = "";
    let stableSince = 0;

    while (Date.now() - startedAt < maxWaitMs) {
      await sleep(250);
      const candidate = findLikelyViewerImage(main, originalImage);
      if (!candidate) continue;

      const rect = candidate.getBoundingClientRect();
      const signature = [
        candidate.currentSrc || candidate.src || "",
        candidate.naturalWidth || 0,
        candidate.naturalHeight || 0,
        Math.round(rect.width),
        Math.round(rect.height)
      ].join("|");

      if (candidate !== best || signature !== bestSignature) {
        best = candidate;
        bestSignature = signature;
        stableSince = Date.now();
        continue;
      }

      const provisionalQuality = classifyImageQuality(
        candidate.naturalWidth || rect.width,
        candidate.naturalHeight || rect.height,
        1_000_000
      );
      const stableFor = Date.now() - stableSince;

      // Untuk kandidat yang sudah berukuran layak, 1.2s stabil cukup. Kandidat
      // kecil diberi waktu lebih lama agar WhatsApp sempat mengganti thumbnail
      // dengan resource viewer yang lebih besar.
      if (
        candidate.complete &&
        candidate.naturalWidth > 0 &&
        candidate.naturalHeight > 0 &&
        ((provisionalQuality !== "low" && stableFor >= 1_200) || stableFor >= 2_500)
      ) {
        return candidate;
      }
    }

    if (best?.complete && best.naturalWidth > 0) {
      return best;
    }
    throw new Error("Timeout menunggu gambar media viewer stabil.");
  }

  function findLikelyViewerImage(main, originalImage) {
    const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
    const candidates = Array.from(document.querySelectorAll("img"))
      .filter((image) => image !== originalImage && isVisible(image))
      .map((image) => {
        const rect = image.getBoundingClientRect();
        const labels = [
          image.getAttribute("alt"),
          image.getAttribute("aria-label"),
          image.getAttribute("title")
        ].map(cleanText).join(" ").toLowerCase();
        if (/avatar|profile photo|foto profil/.test(labels)) return null;
        if (rect.width < 180 || rect.height < 100) return null;

        const outsideMain = !main?.contains(image);
        const viewerAncestor = findViewerAncestor(image);
        const displayedArea = rect.width * rect.height;
        const naturalArea = (image.naturalWidth || rect.width) * (image.naturalHeight || rect.height);
        let score = displayedArea + Math.min(naturalArea, 12_000_000) * 0.25;
        if (outsideMain) score += viewportArea * 1.2;
        if (viewerAncestor) score += viewportArea * 2;
        if (rect.width >= window.innerWidth * 0.45) score += viewportArea * 0.8;
        return { image, score, viewerAncestor, outsideMain };
      })
      .filter(Boolean)
      .filter((item) => item.viewerAncestor || item.outsideMain)
      .sort((a, b) => b.score - a.score);

    return candidates[0]?.image || null;
  }

  function findViewerAncestor(element) {
    let current = element?.parentElement;
    for (let depth = 0; current && depth < 10; depth += 1) {
      const role = cleanText(current.getAttribute?.("role")).toLowerCase();
      const ariaModal = cleanText(current.getAttribute?.("aria-modal")).toLowerCase();
      const rect = current.getBoundingClientRect?.();
      const style = getComputedStyle(current);
      const coversViewport = rect &&
        rect.width >= window.innerWidth * 0.65 &&
        rect.height >= window.innerHeight * 0.65;
      if (
        role === "dialog" ||
        ariaModal === "true" ||
        style.position === "fixed" && coversViewport
      ) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  async function closeWhatsAppViewer(main, viewerImage = null) {
    if (!viewerImage) return;
    const viewerAncestor = findViewerAncestor(viewerImage);
    const scope = viewerAncestor || document;
    const controls = Array.from(scope.querySelectorAll(
      'button, [role="button"], [aria-label], [title]'
    ))
      .filter(isVisible)
      .map((element) => ({
        element,
        label: [
          element.getAttribute?.("aria-label"),
          element.getAttribute?.("title"),
          element.textContent
        ].map(cleanText).filter(Boolean).join(" ").toLowerCase()
      }))
      .filter((item) => /^(close|tutup|back|kembali)$|\b(close|tutup)\b/.test(item.label));

    if (controls[0]) {
      dispatchClickSequence(controls[0].element);
    }

    // Fallback untuk build WhatsApp yang tidak memberi label pada tombol close.
    for (const target of [document, document.body, window]) {
      try {
        target.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          keyCode: 27,
          which: 27,
          bubbles: true,
          cancelable: true
        }));
      } catch (_error) {}
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < 2_000) {
      await sleep(120);
      const stillOpen = viewerImage && viewerImage.isConnected && isVisible(viewerImage) &&
        (findViewerAncestor(viewerImage) || !main?.contains(viewerImage));
      if (!stillOpen) return;
    }
  }

  async function waitForImageReady(image, maxWaitMs) {
    if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
      return;
    }

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        image.removeEventListener("load", onLoad);
        image.removeEventListener("error", onError);
        callback(value);
      };
      const onLoad = () => finish(resolve);
      const onError = () => finish(reject, new Error("Elemen gambar gagal dimuat."));
      const timer = setTimeout(
        () => finish(reject, new Error("Timeout menunggu elemen gambar siap.")),
        maxWaitMs
      );

      image.addEventListener("load", onLoad, { once: true });
      image.addEventListener("error", onError, { once: true });
    });
  }

  async function imageElementToBlob(image) {
    const width = image.naturalWidth || Math.round(image.getBoundingClientRect().width);
    const height = image.naturalHeight || Math.round(image.getBoundingClientRect().height);

    if (width <= 0 || height <= 0) {
      throw new Error("Dimensi gambar tidak tersedia.");
    }

    if (width * height > 40_000_000) {
      throw new Error("Dimensi gambar terlalu besar untuk fallback canvas.");
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas 2D tidak tersedia.");
    }

    context.drawImage(image, 0, 0, width, height);

    return await new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error("Canvas gagal membuat blob gambar.")),
        "image/png"
      );
    });
  }

  function normalizeImageMime(mimeType, source) {
    const normalized = cleanText(mimeType).toLowerCase();
    if (normalized.startsWith("image/")) {
      return normalized.split(";")[0];
    }

    const sourceText = String(source || "").toLowerCase();
    if (sourceText.includes("image/png") || sourceText.endsWith(".png")) return "image/png";
    if (sourceText.includes("image/webp") || sourceText.endsWith(".webp")) return "image/webp";
    if (sourceText.includes("image/gif") || sourceText.endsWith(".gif")) return "image/gif";
    return "image/jpeg";
  }

  function imageExtensionForMime(mimeType) {
    const map = {
      "image/png": "png",
      "image/webp": "webp",
      "image/gif": "gif",
      "image/bmp": "bmp",
      "image/avif": "avif",
      "image/heic": "heic",
      "image/heif": "heif",
      "image/jpeg": "jpg"
    };
    return map[mimeType] || "jpg";
  }

  async function settleImageCaptures(imageStates) {
    const pending = [];
    for (const state of imageStates.values()) {
      if (state.promise) pending.push(state.promise);
    }
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }
  }

  function summarizeImageStates(imageStates) {
    const summary = {
      images_detected: imageStates.size,
      images_exported: 0,
      images_high_quality: 0,
      images_readable: 0,
      images_low_quality: 0,
      images_failed: 0,
      images_pending: 0
    };

    for (const state of imageStates.values()) {
      if (state.status === "exported") {
        summary.images_exported += 1;
        if (state.quality === "high") summary.images_high_quality += 1;
        else if (state.quality === "readable") summary.images_readable += 1;
        else summary.images_low_quality += 1;
      } else if (state.status === "failed") summary.images_failed += 1;
      else if (state.status === "pending") summary.images_pending += 1;
    }

    return summary;
  }

  function finalizeMessageMedia(message, imageState, options) {
    if (!message.media) {
      return null;
    }

    if (message.type !== "image" && message.type !== "img") {
      return message.media;
    }

    const states = imageState instanceof Map
      ? Array.from(imageState.values()).filter((state) => state?.message_id === message.id)
      : imageState
        ? [imageState]
        : [];
    const exportedStates = states.filter((state) => state.status === "exported");
    const primaryState = exportedStates[0] || states[0] || null;
    const result = {
      export_status: options.exportImages
        ? exportedStates.length > 0
          ? "exported"
          : "failed"
        : "metadata_only",
      type: "img"
    };

    if (primaryState?.source) result.source = primaryState.source;
    else if (message.media.source) result.source = message.media.source;

    const localPath = primaryState?.relative_path || primaryState?.saved_path || message.media?.relative_path || null;
    if (localPath) {
      result.local_path = localPath;
      result.relative_path = localPath;
      result.path = localPath;
      result.url = localPath;
    }

    const width = primaryState?.width || message.media.width;
    const height = primaryState?.height || message.media.height;
    if (Number.isFinite(width) && width > 0) result.width = width;
    if (Number.isFinite(height) && height > 0) result.height = height;

    if (exportedStates.length > 0) {
      result.quality = primaryState.quality || "low";
      result.filename = primaryState.filename;
      result.relative_path = primaryState.relative_path;
      result.download_path = primaryState.download_path || null;
      result.default_location = primaryState.default_location || null;
      result.saved_path = primaryState.saved_path || null;
      result.mime_type = primaryState.mime_type;
      result.bytes = primaryState.bytes;
      result.viewer_attempted = primaryState.viewer_attempted === true;
      result.fallback_used = primaryState.fallback_used === true;
      result.images = states.map((state) => ({
        type: "img",
        export_status: state.status === "exported" ? "exported" : "failed",
        filename: state.filename,
        local_path: state.relative_path || state.saved_path || null,
        relative_path: state.relative_path || state.saved_path || null,
        mime_type: state.mime_type,
        width: state.width || null,
        height: state.height || null,
        quality: state.quality || "low",
        bytes: state.bytes || 0,
        error: state.error || null
      }));
      if (primaryState.warning) result.warning = primaryState.warning;
    } else if (options.exportImages) {
      result.quality = "unknown";
      result.viewer_attempted = primaryState?.viewer_attempted === true;
      result.error = primaryState?.error ||
        "Gambar terdeteksi, tetapi resource gambar tidak dapat diekspor ketika bubble tersedia.";
      result.images = states.map((state) => ({
        type: "img",
        export_status: "failed",
        local_path: null,
        width: state.width || null,
        height: state.height || null,
        error: state.error || result.error
      }));
    }

    return result;
  }

  function emptyMediaSummary() {
    return {
      images_detected: 0,
      images_exported: 0,
      images_high_quality: 0,
      images_readable: 0,
      images_low_quality: 0,
      images_failed: 0,
      images_metadata_only: 0,
      image_bytes_exported: 0,
      other_media_metadata_only: 0
    };
  }

  function summarizeFinalMessagesMedia(messages) {
    const summary = emptyMediaSummary();

    for (const message of messages) {
      if (message.type === "image" || message.type === "img") {
        const images = Array.isArray(message.media?.images) && message.media.images.length > 0
          ? message.media.images
          : [message.media];
        summary.images_detected += images.length;
        for (const image of images) {
          if (image?.export_status === "exported" || image?.local_path) {
            summary.images_exported += 1;
            summary.image_bytes_exported += Number(image.bytes || 0);
            if (image.quality === "high") summary.images_high_quality += 1;
            else if (image.quality === "readable") summary.images_readable += 1;
            else summary.images_low_quality += 1;
          } else if (image?.export_status === "failed") {
            summary.images_failed += 1;
          } else {
            summary.images_metadata_only += 1;
          }
        }
      } else if (message.media) {
        summary.other_media_metadata_only += 1;
      }
    }

    return summary;
  }

  function aggregateMediaSummary(chats) {
    const total = emptyMediaSummary();
    for (const chat of chats) {
      const summary = chat.media_summary || emptyMediaSummary();
      for (const key of Object.keys(total)) {
        total[key] += Number(summary[key] || 0);
      }
    }
    return total;
  }

  function sanitizePathSegment(value) {
    return String(value || "chat")
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+$/, "_") || "chat";
  }

  function findMessageBubble(metadataNode) {
    const nativeRoot = metadataNode.closest('[data-id^="true_"], [data-id^="false_"], [id^="true_"], [id^="false_"]');
    if (nativeRoot) return nativeRoot;
    const messageRoot = metadataNode.closest(".message-in, .message-out");
    if (messageRoot) return messageRoot;
    const dataIdAncestor = metadataNode.closest("[data-id], [id^='true_'], [id^='false_']");
    if (dataIdAncestor) {
      return dataIdAncestor;
    }
    const row = metadataNode.closest('[role="row"]');
    if (row) return row;

    let current = metadataNode;

    for (let depth = 0; current && depth < 9; depth += 1) {
      const className = String(current.className || "");
      if (/message-(in|out)/i.test(className)) {
        return current;
      }
      current = current.parentElement;
    }

    return metadataNode.parentElement || metadataNode;
  }

  function parsePrePlainText(value) {
    const cleaned = cleanText(value).replace(/[\u200e\u200f]/g, "");
    const match = cleaned.match(/^\[([^\]]+)]\s*(.*?):\s*$/);

    if (!match) {
      return {
        sender: null,
        timestampRaw: cleaned || null,
        timestampIso: null
      };
    }

    const timestampRaw = cleanText(match[1]);
    const sender = cleanText(match[2]) || null;

    return {
      sender,
      timestampRaw,
      timestampIso: parseLocalizedTimestamp(timestampRaw)
    };
  }

  function parseLocalizedTimestamp(value) {
    const cleaned = value.replace(/[\u200e\u200f]/g, "").trim();
    const match = cleaned.match(
      /^(\d{1,2})[:.](\d{2})(?::(\d{2}))?\s*,\s*(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/
    );

    if (!match) {
      return null;
    }

    const [, hour, minute, second = "0", firstDatePart, secondDatePart, yearRaw] =
      match;
    const year = yearRaw.length === 2 ? Number(`20${yearRaw}`) : Number(yearRaw);

    // WhatsApp mengikuti locale browser. Untuk locale Indonesia, urutan tanggalnya DD/MM/YYYY.
    const day = Number(firstDatePart);
    const month = Number(secondDatePart);
    const date = new Date(
      year,
      month - 1,
      day,
      Number(hour),
      Number(minute),
      Number(second)
    );

    if (
      Number.isNaN(date.getTime()) ||
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day
    ) {
      return null;
    }

    return toLocalIsoString(date);
  }

  function extractMessageText(metadataNode, bubble, captionOnly = false) {
    const selectable = Array.from(
      bubble.querySelectorAll(".selectable-text")
    )
      .filter(isVisible)
      .filter((element) => !isQuotedOrLinkPreview(element, bubble))
      .map((element) => cleanText(element.innerText))
      .filter(Boolean);

    if (selectable.length > 0) {
      return selectable.at(-1);
    }

    // Jangan menjadikan durasi video atau jam pesan sebagai caption media.
    if (captionOnly) return null;

    const nestedSelectable = Array.from(
      metadataNode.querySelectorAll("span[dir], div[dir]")
    )
      .filter(isVisible)
      .map((element) => cleanText(element.innerText))
      .filter(Boolean);

    if (nestedSelectable.length > 0) {
      return nestedSelectable.at(-1);
    }

    return null;
  }

  function detectDirection(bubble) {
    let current = bubble;

    for (let depth = 0; current && depth < 8; depth += 1) {
      const className = String(current.className || "");
      if (/message-out/i.test(className)) {
        return "outgoing";
      }
      if (/message-in/i.test(className)) {
        return "incoming";
      }
      current = current.parentElement;
    }

    return "unknown";
  }

  // Ruang lingkup ekspor hanya teks dan gambar. Fungsi ini menjawab satu
  // pertanyaan: bubble ini gambar asli, permukaan yang harus dilewati, atau
  // bukan media sama sekali.
  //   - "image"   -> foto yang dikirim pengguna (dengan atau tanpa caption)
  //   - "skip"    -> video/GIF/stiker/dokumen/voice note/link preview dll.
  //   - null      -> bukan media; caption/teks diproses seperti pesan biasa
  function detectMedia(bubble) {
    const labels = collectSemanticLabels(bubble).toLowerCase();
    const imageElements = findMessageImages(bubble);
    const imageElement = imageElements[0] || null;

    // URUTAN PENTING: seluruh permukaan non-gambar diperiksa lebih dulu karena
    // video, GIF, stiker, dan kartu dokumen juga memiliki <img> poster.
    const isSkippable =
      hasVideoSurface(bubble) ||
      hasDocumentAttachment(bubble) ||
      bubble.querySelector("audio") ||
      /sticker|stiker/.test(labels) ||
      /voice message|voice note|pesan suara/.test(labels) ||
      /\bgif\b/.test(labels) ||
      /document|dokumen|attachment|lampiran/.test(labels);

    if (isSkippable) {
      return { detectedAs: "skip", imageElements: [] };
    }

    // findMessageImages() sudah membuang thumbnail di dalam kartu preview,
    // sehingga sisa kandidat di sini adalah foto asli.
    if (hasLinkPreview(bubble) && !imageElement) {
      return { detectedAs: "skip", imageElements: [] };
    }

    if (!imageElement) {
      return null;
    }

    return { detectedAs: "image", imageElement, imageElements };
  }

  function findMessageImages(bubble) {
    const candidates = [];

    for (const element of bubble.querySelectorAll("img, canvas")) {
      if (isQuotedOrLinkPreview(element, bubble)) continue;
      const rectangle = element.getBoundingClientRect();
      if (rectangle.width < 64 || rectangle.height < 64) continue;

      const labels = [
        element.getAttribute?.("alt"),
        element.getAttribute?.("aria-label"),
        element.getAttribute?.("title")
      ].map(cleanText).join(" ").toLowerCase();
      // Avatar, ikon UI, dan thumbnail kartu dokumen/tautan tidak pernah
      // merupakan foto yang dikirim pengguna.
      if (/avatar|profile photo|foto profil/.test(labels)) continue;
      if (/thumbnail|thumb|preview|pratinjau|pratayang/.test(labels)) continue;
      if (/document|dokumen|pdf|attachment|lampiran/.test(labels)) continue;
      candidates.push(element);
    }

    // Beberapa build WhatsApp merender gambar sebagai CSS background, bukan
    // <img>. Sebelumnya fallback ini hanya berjalan bila TIDAK ada <img>, sehingga
    // bubble yang memiliki <img> kecil (mis. ikon/emotikon) membuat gambar
    // background-asli tidak pernah terdeteksi -> gambar ter-skip. Sekarang
    // background-image SELALU ikut dikumpulkan sebagai kandidat tambahan.
    for (const element of bubble.querySelectorAll("div, span")) {
      if (isQuotedOrLinkPreview(element, bubble)) continue;
      const rectangle = element.getBoundingClientRect();
      if (rectangle.width < 96 || rectangle.height < 96) continue;
      if (!extractBackgroundImageUrl(element)) continue;
      candidates.push(element);
    }

    // Urutan DOM stabil, tidak berubah saat resolusi salah satu tile meningkat.
    // Hapus hanya representasi yang menempati tile yang sama, bukan foto lain
    // yang kebetulan memakai URL/placeholder sama.
    const unique = [];
    for (const element of candidates) {
      const rect = element.getBoundingClientRect();
      const duplicate = unique.findIndex((other) => {
        const otherRect = other.getBoundingClientRect();
        // Placeholder/canvas dan img bisa berupa sibling yang saling menimpa.
        return Math.abs(rect.left - otherRect.left) < 3 &&
          Math.abs(rect.top - otherRect.top) < 3 &&
          Math.abs(rect.width - otherRect.width) < 3 &&
          Math.abs(rect.height - otherRect.height) < 3;
      });
      if (duplicate < 0) unique.push(element);
      else if (imageArea(element) > imageArea(unique[duplicate])) unique[duplicate] = element;
    }
    return unique.sort((a, b) => {
      const position = a.compareDocumentPosition(b);
      return position & 4 ? -1 : position & 2 ? 1 : 0;
    });
  }

  function isQuotedOrLinkPreview(element, bubble) {
    // WhatsApp Web modern sudah banyak membuang data-testid. Selain atribut
    // lama, periksa juga pembungkus <a href>, blockquote, penanda kelas/aria
    // quoted, dan kartu preview agar thumbnail balasan maupun thumbnail tautan
    // tidak pernah masuk antrean ekspor gambar.
    const container = element.closest(
      '[data-testid*="quoted"], [data-testid*="link-preview"], [data-testid*="url-preview"], ' +
      '[class*="quoted-mention"], [class*="quoted"], blockquote, ' +
      '[class*="link-preview"], [class*="url-preview"], ' +
      '[aria-label*="Quoted" i], [aria-label*="Dikutip" i], [aria-label*="Balasan" i], ' +
      'a[href^="http://"], a[href^="https://"]'
    );
    return Boolean(container && bubble.contains(container));
  }

  function extractMessageUrls(bubble) {
    return [...new Set(Array.from(bubble.querySelectorAll('a[href]'))
      .filter((element) => !element.closest('[data-testid*="quoted"]'))
      .map((element) => element.getAttribute("href"))
      .filter((url) => /^https?:\/\//i.test(url || "")))];
  }

  function hasLinkPreview(bubble) {
    if (!extractMessageUrls(bubble).length) return false;
    // Selain data-testid lama, kenali kartu preview lewat penanda kelas dan
    // pembungkus <a> yang memuat gambar/background.
    return Boolean(bubble.querySelector(
      '[data-testid*="link-preview"], [data-testid*="url-preview"], ' +
      '[class*="link-preview"], [class*="url-preview"]'
    )) ||
      Array.from(bubble.querySelectorAll('a[href]')).some((link) =>
        /^https?:\/\//i.test(link.getAttribute("href") || "") &&
        (link.querySelector("img, canvas") || extractBackgroundImageUrl(link))
      );
  }

  // Kartu dokumen (PDF/Office/arsip) sering merender preview halaman pertama
  // sebagai <img>/canvas berukuran besar. Tanpa guard ini preview tersebut
  // lolos sebagai foto biasa dan ikut terekspor. Deteksi memakai tiga sinyal
  // independen: atribut unduhan, ikon dokumen, dan pola teks kartu dokumen.
  function hasDocumentAttachment(bubble) {
    if (!bubble?.querySelector) return false;

    if (
      bubble.querySelector(
        '[download], [data-icon*="document"], [data-icon*="pdf"], ' +
        '[data-icon*="doc"], [data-icon*="sheet"], [data-icon*="slide"], ' +
        '[aria-label*="Download" i], [aria-label*="Unduh" i]'
      )
    ) {
      return true;
    }

    const labels = collectSemanticLabels(bubble).toLowerCase();
    const body = cleanText(bubble.innerText).toLowerCase();
    const haystack = `${labels} ${body}`;

    // Ekstensi berkas non-gambar yang WhatsApp tampilkan sebagai kartu dokumen.
    if (/\.(pdf|docx?|xlsx?|pptx?|txt|csv|zip|rar|7z|apk|odt|ods|odp)\b/.test(haystack)) {
      return true;
    }

    // Kartu dokumen menampilkan jumlah halaman dan/atau ukuran berkas.
    const hasPageCount = /\b\d+\s*(pages?|halaman)\b/.test(haystack);
    const hasFileSize = /\b\d+(?:[.,]\d+)?\s*[kmg]b\b/.test(haystack);
    return hasPageCount || hasFileSize;
  }

  // Video/GIF juga memiliki <img> poster. Selain elemen <video>, kenali tombol
  // putar, label durasi, dan penanda GIF supaya poster tidak dianggap foto.
  function hasVideoSurface(bubble) {
    if (!bubble?.querySelector) return false;

    if (bubble.querySelector("video")) return true;

    return Boolean(
      bubble.querySelector(
        '[data-icon*="play"], [data-icon*="video"], [data-icon*="gif"], ' +
        '[aria-label*="Play" i], [aria-label*="Putar" i], [aria-label*="video" i]'
      )
    );
  }

  function imageArea(image) {
    const rectangle = image.getBoundingClientRect();
    const width = image instanceof HTMLImageElement
      ? image.naturalWidth || rectangle.width || 0
      : image instanceof HTMLCanvasElement
        ? image.width || rectangle.width || 0
        : rectangle.width || 0;
    const height = image instanceof HTMLImageElement
      ? image.naturalHeight || rectangle.height || 0
      : image instanceof HTMLCanvasElement
        ? image.height || rectangle.height || 0
        : rectangle.height || 0;
    return width * height;
  }

  // Hanya dua tipe yang diekspor: "img" dan "text". null berarti bubble tidak
  // menghasilkan apa pun dan harus dilewati oleh pemanggil.
  function detectMessageType(text, media) {
    if (media?.detectedAs === "image") {
      return "img";
    }

    // Media non-gambar hanya menyumbang caption teks aslinya, bila ada.
    return text ? "text" : null;
  }

  function collectSemanticLabels(root) {
    const values = [];
    const elements = [root, ...root.querySelectorAll("[aria-label], [title], [alt]")];

    for (const element of elements) {
      for (const attribute of ["aria-label", "title", "alt"]) {
        const value = cleanText(element.getAttribute?.(attribute));
        if (value) {
          values.push(value);
        }
      }
    }

    return values.join(" ");
  }

  function extractReplyPreview(bubble, messageText, currentMessageId = null) {
    const messageKey = normalizeComparable(messageText || "");
    const selectable = Array.from(bubble.querySelectorAll(".selectable-text"))
      .filter(isVisible)
      .map((element) => cleanText(element.innerText))
      .filter(Boolean);

    const candidates = [];
    const seen = new Set();
    for (const text of selectable) {
      const key = normalizeComparable(text);
      if (!key || key === messageKey || seen.has(key)) continue;
      seen.add(key);
      candidates.push(text);
    }

    if (candidates.length === 0) {
      return null;
    }

    // Quoted preview biasanya muncul sebelum body pesan aktual. Hindari memilih
    // string sangat pendek yang lebih mungkin nama sender/label UI apabila ada
    // kandidat lain yang lebih informatif.
    const preview =
      candidates.find((candidate) => candidate.length >= 2) || candidates[0];
    if (!preview) return null;

    const sender = extractReplySender(bubble, preview, messageText);
    const quotedMessageId = extractQuotedMessageId(bubble, currentMessageId);

    return {
      sender: sender || null,
      preview: preview.slice(0, 500),
      message_id: quotedMessageId || null,
      sequence: null
    };
  }

  function extractReplySender(bubble, preview, messageText) {
    const labels = Array.from(bubble.querySelectorAll('[aria-label], [title]'))
      .filter(isVisible)
      .flatMap((element) => [
        cleanText(element.getAttribute("aria-label")),
        cleanText(element.getAttribute("title"))
      ])
      .filter(Boolean);

    for (const label of labels) {
      const match = label.match(/(?:replying to|reply to|membalas|balas ke)\s+(.+)/i);
      if (match?.[1]) {
        const value = cleanText(match[1]).replace(/[,:].*$/, "");
        if (value) return value.slice(0, 160);
      }
    }

    const excluded = new Set([
      normalizeComparable(preview || ""),
      normalizeComparable(messageText || "")
    ]);
    const titleCandidate = labels.find((label) => {
      const key = normalizeComparable(label);
      return key && !excluded.has(key) && label.length <= 160 && !isLikelySidebarMetadata(label);
    });

    return titleCandidate || null;
  }

  function extractQuotedMessageId(bubble, currentMessageId) {
    const currentKey = cleanText(currentMessageId || "");
    const ids = Array.from(bubble.querySelectorAll("[data-id]"))
      .map((element) => cleanText(element.getAttribute("data-id")))
      .filter((value) => value && value !== currentKey);

    // Jangan membuat ID sintetis untuk quote. Hanya simpan ID DOM bila memang
    // WhatsApp mengeksposkannya; resolver sequence tetap punya fallback preview.
    return ids.find((value) => value.length >= 8) || null;
  }

  function resolveReplySequences(messages) {
    const byId = new Map(messages.map((message) => [message.id, message]));

    return messages.map((message, index) => {
      if (!message.reply_to) return message;

      const reply = { ...message.reply_to };
      let target = reply.message_id ? byId.get(reply.message_id) : null;

      if (!target || target.sequence >= message.sequence) {
        target = findReplyTargetByPreview(messages, index, reply);
      }

      return {
        ...message,
        reply_to: {
          ...reply,
          message_id: reply.message_id || target?.id || null,
          sequence: target?.sequence ?? null
        }
      };
    });
  }

  function findReplyTargetByPreview(messages, currentIndex, reply) {
    const previewKey = normalizeReplyComparable(reply.preview || "");
    const senderKey = normalizeComparable(reply.sender || "");

    if (isGenericMediaReplyPreview(previewKey)) {
      const prior = messages.slice(0, currentIndex);
      const senderScoped = senderKey
        ? prior.filter((candidate) => replySenderMatches(candidate, senderKey))
        : prior;
      const scopedMatches = senderScoped.filter((candidate) =>
        replyPreviewMatchesMediaType(previewKey, candidate.type)
      );
      if (scopedMatches.length === 1) return scopedMatches[0];

      // Generic preview seperti "Photo" terlalu ambigu jika ada beberapa image.
      // Lebih aman null daripada menunjuk sequence yang salah.
      if (!senderKey) return null;

      const allMatches = prior.filter((candidate) =>
        replyPreviewMatchesMediaType(previewKey, candidate.type)
      );
      return allMatches.length === 1 ? allMatches[0] : null;
    }

    for (let index = currentIndex - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (senderKey && !replySenderMatches(candidate, senderKey)) continue;
      if (replyPreviewMatchesMessage(previewKey, candidate)) return candidate;
    }

    // Sender parsing WhatsApp tidak selalu tersedia. Jika pencarian dengan sender
    // gagal, ulangi berdasarkan preview saja, tetap dari pesan terdekat ke belakang.
    if (senderKey) {
      for (let index = currentIndex - 1; index >= 0; index -= 1) {
        const candidate = messages[index];
        if (replyPreviewMatchesMessage(previewKey, candidate)) return candidate;
      }
    }

    return null;
  }

  function isGenericMediaReplyPreview(previewKey) {
    return [
      "photo", "foto", "image", "gambar", "video", "sticker", "stiker",
      "document", "dokumen", "file", "berkas", "voice message", "voice note",
      "pesan suara", "audio", "gif"
    ].includes(previewKey);
  }

  function replySenderMatches(candidate, senderKey) {
    const candidateSender = normalizeComparable(candidate.sender || "");
    if (!candidateSender) return false;
    if (candidateSender === senderKey) return true;

    // WhatsApp dapat menulis "You"/"Anda" pada quoted sender untuk pesan sendiri.
    if (/^(you|anda|saya|me)$/.test(senderKey)) {
      return candidate.direction === "outgoing";
    }
    return false;
  }

  function normalizeReplyComparable(value) {
    return normalizeComparable(value)
      .replace(/\s+/g, " ")
      .replace(/[.…]+$/g, "")
      .trim();
  }

  function replyPreviewMatchesMessage(previewKey, candidate) {
    if (!previewKey) return false;

    const textKey = normalizeReplyComparable(candidate.text || "");
    if (textKey) {
      if (textKey === previewKey) return true;
      if (textKey.startsWith(previewKey) || previewKey.startsWith(textKey)) return true;
      if (previewKey.length >= 18 && textKey.includes(previewKey)) return true;
    }

    return replyPreviewMatchesMediaType(previewKey, candidate.type);
  }

  function replyPreviewMatchesMediaType(previewKey, type) {
    const aliases = {
      image: ["photo", "foto", "image", "gambar"],
      video: ["video"],
      sticker: ["sticker", "stiker"],
      document: ["document", "dokumen", "file", "berkas"],
      voice_note: ["voice message", "voice note", "pesan suara", "audio"],
      audio: ["audio", "voice message", "pesan suara"],
      gif: ["gif"]
    };

    return (aliases[type] || []).some((alias) => previewKey === alias);
  }

  function extractNativeMessageId(metadataNode, bubble) {
    let candidate = metadataNode.closest("[data-id]") || bubble.closest?.("[data-id]");
    let id = candidate ? candidate.getAttribute("data-id") : null;

    if (!id) {
      candidate = metadataNode.closest("[id^='false_'], [id^='true_']") || bubble.closest?.("[id^='false_'], [id^='true_']");
      id = candidate ? candidate.getAttribute("id") : null;
    }

    if (!id) {
      candidate = bubble.querySelector('[data-id^="true_"], [data-id^="false_"], [id^="true_"], [id^="false_"]');
      id = candidate?.getAttribute("data-id") || candidate?.getAttribute("id");
    }
    return cleanText(id) || null;
  }

  function inferChatType(main) {
    const header = main.querySelector("header");
    const headerText = cleanText(header?.innerText);
    const lines = headerText
      .split("\n")
      .map(cleanText)
      .filter(Boolean);

    if (lines.length >= 2 && lines[1].includes(",")) {
      return "group";
    }

    return "unknown";
  }

  function messageQuality(message) {
    let score = 0;
    if (message.text) score += 4;
    if (message.timestamp_iso) score += 2;
    if (message.sender) score += 1;
    if (message.direction !== "unknown") score += 1;
    if (message.type !== "unknown") score += 1;
    return score;
  }

  function compareMessages(a, b) {
    const aDomOrder = a.dom_order_position;
    const bDomOrder = b.dom_order_position;

    if (Number.isFinite(aDomOrder) && Number.isFinite(bDomOrder)) {
      const visualDifference = aDomOrder - bDomOrder;
      if (visualDifference !== 0) {
        return visualDifference;
      }
    } else if (Number.isFinite(aDomOrder)) {
      return -1;
    } else if (Number.isFinite(bDomOrder)) {
      return 1;
    }

    if (a.timestamp_iso && b.timestamp_iso) {
      const timeDifference =
        new Date(a.timestamp_iso).getTime() - new Date(b.timestamp_iso).getTime();
      if (timeDifference !== 0) {
        return timeDifference;
      }
    } else if (a.timestamp_iso) {
      return -1;
    } else if (b.timestamp_iso) {
      return 1;
    }

    // Fallback terakhir harus tetap naik, bukan turun. Versi lama memakai
    // pengurutan menurun sehingga pesan dalam menit yang sama menjadi terbalik.
    return (a._capture_order || 0) - (b._capture_order || 0);
  }

  function isVisible(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    const rectangle = element.getBoundingClientRect();
    const style = getComputedStyle(element);

    return (
      rectangle.width > 0 &&
      rectangle.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden"
    );
  }

  function uniqueElements(elements) {
    return Array.from(new Set(elements));
  }

  function cleanText(value) {
    return String(value || "")
      .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
      .replace(/\r/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function normalizeComparable(value) {
    return cleanText(value).toLocaleLowerCase().replace(/\s+/g, " ");
  }

  function clampInteger(value, minimum, maximum, fallback) {
    const number = Number.parseInt(value, 10);
    if (!Number.isInteger(number)) {
      return fallback;
    }
    return Math.min(maximum, Math.max(minimum, number));
  }

  function simpleHash(value) {
    let hash = 0x811c9dc5;

    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }

    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function toLocalIsoString(date) {
    const timezoneOffset = -date.getTimezoneOffset();
    const sign = timezoneOffset >= 0 ? "+" : "-";
    const absoluteOffset = Math.abs(timezoneOffset);
    const offsetHours = String(Math.floor(absoluteOffset / 60)).padStart(2, "0");
    const offsetMinutes = String(absoluteOffset % 60).padStart(2, "0");

    return [
      date.getFullYear(),
      "-",
      String(date.getMonth() + 1).padStart(2, "0"),
      "-",
      String(date.getDate()).padStart(2, "0"),
      "T",
      String(date.getHours()).padStart(2, "0"),
      ":",
      String(date.getMinutes()).padStart(2, "0"),
      ":",
      String(date.getSeconds()).padStart(2, "0"),
      sign,
      offsetHours,
      ":",
      offsetMinutes
    ].join("");
  }

  function formatFilenameDate(date) {
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
      "-",
      String(date.getHours()).padStart(2, "0"),
      String(date.getMinutes()).padStart(2, "0"),
      String(date.getSeconds()).padStart(2, "0")
    ].join("");
  }

  function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function normalizeError(error) {
    return error instanceof Error ? error.message : String(error);
  }
})();
