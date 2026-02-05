(function () {
  "use strict";
  console.log("SP JS VERSION 2026-02-02-OAI");

  if (window.__BATCH_COMPARE_V1_LOADED__) return;
  window.__BATCH_COMPARE_V1_LOADED__ = true;

  function initBatchCompare() {
    console.log("Batch Compare init running");
    // Find container via stable selector
    const container = document.getElementById("batch-compare-v1") || document.querySelector("[data-batch-compare]");
    if (!container) {
      console.warn("[BatchCompare] Container not found");
      return;
    }

    console.debug("[Batch Compare] boot ok", { version: "js", debug: qsDebug() });

    const API_BASE = "https://rf-api-7vvq.onrender.com";
    const FETCH_TIMEOUT = 12000;
    const CLOSE_GAP = 10;
    
    // Preset-specific minimum hit_score gates for preset winner candidates
    const PRESET_HIT_GATES = {
      hit_single: 0.25,      // 25% for second pick (strict)
      statement_opener: 0.15, // 15%
      ballad: 0.15,           // 15%
      experimental: 0.10,     // 10%
      album_track: 0.00       // No gate for album track
    };

    const elLoading = container.querySelector("#bc-loading");
    const elError = container.querySelector("#bc-error");
    const elUploader = container.querySelector("#bc-uploader");
    const elCompare = container.querySelector("#bc-compare");

    const elFiles = container.querySelector("#bc-files");
    const elFileList = container.querySelector("#bc-file-list");
    const elMsg = container.querySelector("#bc-msg");
    const elStart = container.querySelector("#bc-start");
    const elReset = container.querySelector("#bc-reset");
    const elProgress = container.querySelector("#bc-progress");

    const elNew = container.querySelector("#bc-new");
    const elStrategy = container.querySelector("#bc-strategy");
    const elPresetNote = container.querySelector("#bc-preset-note");
    const elScoreDetails = container.querySelector("#bc-score-details");
    const elScoreTable = container.querySelector("#bc-score-table");
    const elLead = container.querySelector("#bc-lead");
    const elSummary = container.querySelector("#bc-summary");
    const elList = container.querySelector("#bc-list");

    // Store current items and preset for re-ranking
    let currentItems = [];
    let currentPreset = "hit_single";
    let lastGoodPreset = "hit_single";
    let lastGoodItems = [];
    let lastGoodScores = [];
    let openAiListenTriggered = false;

    const PRESET_STORAGE_KEY = "sp_batch_compare_preset";
    const PRESET_ROLE_LABEL = {
      hit_single: "Second pick",
      statement_opener: "Statement opener",
      ballad: "Ballad single",
      experimental: "Experimental pick",
      album_track: "Album track"
    };

    function resolvePreset() {
      const fromUrl = qsPreset();
      if (fromUrl) return { preset: fromUrl, source: "url" };
      return { preset: "hit_single", source: "default" };
    }

    function qsDebug() {
      try {
        const u = new URL(window.location.href);
        return u.searchParams.get("debug") === "1";
      } catch (_) {
        return false;
      }
    }

    // Strict flag parser (tuning override via ?force_sidecar=0/1)
    function parseFlag(v) {
      if (v === "1" || v === "true") return true;
      if (v === "0" || v === "false") return false;
      return null; // not present / invalid
    }

    // Single source of truth: URL ?force_sidecar=0/1 override → else localStorage["sp_use_sidecar"] → else true
    function resolveUseSidecar(checkbox) {
      try {
        const params = new URLSearchParams(window.location.search);
        const forced = parseFlag(params.get("force_sidecar"));
        if (forced !== null) return forced;
        const stored = localStorage.getItem("sp_use_sidecar");
        if (stored === "0") return false;
        if (stored === "1") return true;
        return true; // null or other → default true
      } catch (_) {
        return true;
      }
    }

    // OpenAI judge: URL ?force_oai=0/1 → localStorage["sp_use_oai"] → default OFF
    function resolveUseOai() {
      let result = false;
      try {
        const params = new URLSearchParams(window.location.search);
        if (params.has("force_oai")) {
          result = params.get("force_oai") === "1";
        } else {
          const stored = localStorage.getItem("sp_use_oai");
          if (stored === "1") result = true;
          else if (stored === "0") result = false;
        }
      } catch (_) {}
      console.log("resolveUseOai =", result);
      return result;
    }

    let presetNoteText = "";
    let filterNoteText = "";

    function renderPresetNote() {
      if (!elPresetNote) return;
      const parts = [];
      if (presetNoteText) parts.push(presetNoteText);
      if (filterNoteText) parts.push(filterNoteText);
      if (!parts.length) {
        elPresetNote.style.display = "none";
        elPresetNote.textContent = "";
        return;
      }
      elPresetNote.style.display = "block";
      elPresetNote.textContent = parts.join(" · ");
    }

    function setPresetNote(text) {
      presetNoteText = text ? String(text) : "";
      renderPresetNote();
    }

    function setFilterNote(text) {
      filterNoteText = text ? String(text) : "";
      renderPresetNote();
    }

    function qsPreset() {
      try {
        const u = new URL(window.location.href);
        let p = u.searchParams.get("preset");
        p = (p || "").split("?")[0].trim();
        return p && String(p).length ? String(p) : null;
      } catch (_) {
        return null;
      }
    }

    function storePreset(preset) {
      try {
        localStorage.setItem(PRESET_STORAGE_KEY, String(preset));
      } catch (_) {}
    }

    function setPresetInUrl(preset) {
      try {
        const u = new URL(window.location.href);
        u.searchParams.set("preset", String(preset));
        window.history.replaceState({}, "", u.toString());
      } catch (_) {}
    }

    const s = (v) => (v == null ? "" : String(v));

    const COPY_OPENERS = [
      "Quick take:",
      "First impression:",
      "Snapshot:",
      "Short read:",
      "Top-line note:",
      "Initial take:",
      "Small advisor note:",
      "Fast read:",
      "In this pass:",
      "Overall feel:"
    ];

    const COPY_REASONS = [
      "This fits the {presetLabel} lens cleanly.",
      "Feels cohesive for a {roleLabel} slot.",
      "The {presetLabel} lens favors this shape.",
      "Steady fit under the current lens.",
      "Solid balance for the {presetLabel} view.",
      "Feels reliable in the {roleLabel} lane.",
      "A stable read for this preset.",
      "Comfortable fit for this role."
    ];

    const COPY_CLOSERS = [
      "Try it as a top pick.",
      "Keep it in the second-pick mix.",
      "Test it as a supporting pick.",
      "Worth a quick A/B listen.",
      "Hold it as a contrast option.",
      "Pair it with the top pick for balance.",
      "Queue it for a second listen.",
      "Try it against the top pick.",
      "Consider it for the album slot.",
      "Use it as a pacing change.",
      "Worth a focused listen.",
      "Try it in a smaller test set."
    ];

    const REASON_TEMPLATES = [
      "Reason: Clear early identity and strong genre fit make this the most immediate first-release option.",
      "Reason: Complements the top pick by adding contrast while maintaining a clear musical direction.",
      "Reason: Better suited for context and depth, rewarding listeners beyond the first release."
    ];

    function hash32(str) {
      let h = 0x811c9dc5;
      for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = (h * 16777619) >>> 0;
      }
      return h >>> 0;
    }

    function pick(arr, seedStr) {
      if (!arr || !arr.length) return "";
      const idx = hash32(seedStr) % arr.length;
      return arr[idx];
    }

    function fillTemplate(template, ctx) {
      return String(template || "")
        .replace("{moment}", ctx.momentRange || "")
        .replace("{presetLabel}", ctx.presetLabel || "")
        .replace("{roleLabel}", ctx.roleLabel || "");
    }

    function isTemplateUsable(template, ctx) {
      if (!template) return false;
      if (template.includes("{moment}") && !ctx.momentRange) return false;
      if (template.includes("{presetLabel}") && !ctx.presetLabel) return false;
      if (template.includes("{roleLabel}") && !ctx.roleLabel) return false;
      return true;
    }

    function buildMicroCopy(song, preset, roleLabel, ctx) {
      const seed = [
        s(song?.id),
        s(song?.title),
        s(song?.artist),
        s(preset),
        s(roleLabel)
      ].join("|");

      const momentRange = s(ctx?.momentRange || "");
      const presetLabel = s(ctx?.presetLabel || s(preset));
      const isBalladLens = !!ctx?.isBalladLens;
      const filteredCountText = s(ctx?.filteredCountText || "");

      const templateCtx = {
        momentRange,
        presetLabel,
        roleLabel: s(roleLabel || "")
      };
      const opener = pick(COPY_OPENERS, seed + "|open");

      const reasonPool = COPY_REASONS.filter((t) => isTemplateUsable(t, templateCtx));
      const reason = reasonPool.length
        ? fillTemplate(pick(reasonPool, seed + "|reason"), templateCtx)
        : "Steady fit under the current lens.";

      const sentences = [];
      if (opener) {
        sentences.push(opener + " " + reason);
      } else {
        sentences.push(reason);
      }

      if (isBalladLens && filteredCountText && sentences.length < 2) {
        sentences.push("Ballad lens filtered this batch.");
      } else if (sentences.length < 2) {
        sentences.push(pick(COPY_CLOSERS, seed + "|close"));
      }

      let out = sentences.join(" ");
      if (out.length > 220 && sentences.length > 1) {
        out = sentences[0];
      }
      if (out.length > 220) {
        out = out.slice(0, 217).trim() + "…";
      }
      return out.trim();
    }

    function formatConfidence(conf) {
      if (conf === null || conf === undefined) return "";
      if (typeof conf === "string") {
        const t = conf.trim();
        return t ? t : "";
      }
      const n = Number(conf);
      if (!isFinite(n)) return "";
      if (n <= 1) return Math.round(n * 100) + "%";
      if (n <= 100) return Math.round(n) + "%";
      return "";
    }

    function getHookTiming(item) {
      const fj = item && item.features_json && typeof item.features_json === "object" ? item.features_json : null;
      const ht = fj?.hook_timing || fj?.hookTiming || item?.hook_timing || null;
      if (!ht || typeof ht !== "object") return null;
      const bucket = ht?.bucket || ht?.label || ht?.range || ht?.timing || null;
      if (!bucket) return null;
      const conf = ht?.confidence ?? ht?.score ?? ht?.probability ?? null;
      return { bucket: s(bucket), confidence: formatConfidence(conf) };
    }

    function getDecisionSummary(item) {
      const fj = item && item.features_json && typeof item.features_json === "object" ? item.features_json : null;
      const dr = fj?.decision_response || fj?.decisionResponse || null;
      const summary = dr?.summary || dr?.reason || dr?.decision || dr?.label || null;
      if (summary) return s(summary);
      const reasons = Array.isArray(dr?.reasons) ? dr.reasons.filter(Boolean) : [];
      if (reasons.length > 0) return s(reasons[0]);
      return "";
    }

    function fillReasonTemplate(template, ctx) {
      return String(template || "")
        .replace("{roleClause}", ctx.roleClause || "")
        .replace("{presetLabel}", ctx.presetLabel || "")
        .replace("{momentRange}", ctx.momentRange || "")
        .replace("{segmentLabel}", ctx.segmentLabel || "")
        .replace("{hookBucket}", ctx.hookBucket || "")
        .replace("{hookConf}", ctx.hookConf || "")
        .replace("{decisionSummary}", ctx.decisionSummary || "")
        .replace("{scoreClause}", ctx.scoreClause || "");
    }

    function isReasonTemplateUsable(template, ctx) {
      if (!template) return false;
      if (template.includes("{roleClause}") && !ctx.roleClause) return false;
      if (template.includes("{presetLabel}") && !ctx.presetLabel) return false;
      if (template.includes("{momentRange}") && !ctx.momentRange) return false;
      if (template.includes("{segmentLabel}") && !ctx.segmentLabel) return false;
      if (template.includes("{hookBucket}") && !ctx.hookBucket) return false;
      if (template.includes("{decisionSummary}") && !ctx.decisionSummary) return false;
      if (template.includes("{scoreClause}") && !ctx.scoreClause) return false;
      return true;
    }

    function buildRoleReason(song, preset, roleLabel, ctx) {
      const role = s(roleLabel).toLowerCase();
      if (role.includes("top pick")) {
        return "Reason: Clear early identity and strong genre fit make this the most immediate first-release option.";
      }
      if (role.includes("second pick")) {
        return "Reason: Complements the top pick by adding contrast while maintaining a clear musical direction.";
      }
      if (role.includes("album track")) {
        return "Reason: Better suited for context and depth, rewarding listeners beyond the first release.";
      }
      return "Reason: Not enough signals yet — re-run analysis later.";
    }

    function getRoleClause(roleLabel) {
      const base = s(roleLabel || "This pick");
      return base ? (base + " selection") : "This pick";
    }

    function getScoreClause(opts) {
      if (opts?.isLead) return "highest hit score in this batch";
      if (opts?.isPresetWinner) {
        return opts?.isBalladPreset
          ? "top preset score among ballad-eligible tracks"
          : "top preset score among eligible tracks";
      }
      if (opts?.isAlbum) return "balanced hit score and preset delta among remaining tracks";
      return "strong preset score in this view";
    }

    function getPresetScoreLabel(preset) {
      const p = String(preset || "hit_single");
      if (p === "hit_single") return "Preset score (Hit lens)";
      if (p === "ballad") return "Preset score (Ballad lens)";
      if (p === "statement_opener") return "Preset score (Statement opener lens)";
      if (p === "experimental") return "Preset score (Experimental lens)";
      if (p === "album_track") return "Preset score (Album track lens)";
      return "Preset score";
    }

    const player = new Audio();
    player.preload = "metadata";
    player.crossOrigin = "anonymous";

    let activeCard = null;
    let activeBtn = null;
    let activeSongId = null;
    let selectedFiles = [];

    function showLoading() {
      if (elLoading) elLoading.style.display = "block";
      if (elError) elError.style.display = "none";
      if (elUploader) elUploader.style.display = "none";
      if (elCompare) elCompare.style.display = "none";
      if (elError) elError.textContent = "";
    }

    function showError(msg) {
      if (elLoading) elLoading.style.display = "none";
      if (elError) elError.style.display = "block";
      if (elUploader) elUploader.style.display = "none";
      if (elCompare) elCompare.style.display = "none";
      if (elError) elError.textContent = msg;
    }

    function showUploader() {
      if (elLoading) elLoading.style.display = "none";
      if (elError) elError.style.display = "none";
      if (elUploader) elUploader.style.display = "block";
      if (elCompare) elCompare.style.display = "none";
    }

    function showCompare() {
      if (elLoading) elLoading.style.display = "none";
      if (elError) elError.style.display = "none";
      if (elUploader) elUploader.style.display = "none";
      if (elCompare) elCompare.style.display = "block";
    }

    function safeJsonParse(s) {
      try { return JSON.parse(s); } catch (_) { return null; }
    }

    function extractSessionFromParsed(parsed) {
      if (!parsed || typeof parsed !== "object") return null;
      const token = parsed?.access_token || parsed?.currentSession?.access_token || parsed?.session?.access_token;
      if (!token) return null;
      return { access_token: String(token) };
    }

    function getSupabaseAccessTokenFromLocalStorage() {
      // Try exact keys first
      const exactKeys = [
        "sb-svvfyyxryrgkemlsvzip-auth-token",
        "sb-svvfyxxryrgkemlsvzip-auth-token"
      ];

      for (const key of exactKeys) {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = safeJsonParse(raw);
        const token = parsed?.access_token || parsed?.currentSession?.access_token || parsed?.session?.access_token;
        if (token) return String(token);
      }

      // Fallback: search all localStorage keys
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;
        if (!key.startsWith("sb-")) continue;
        if (!key.endsWith("-auth-token")) continue;

        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = safeJsonParse(raw);
        const token = parsed?.access_token || parsed?.currentSession?.access_token || parsed?.session?.access_token;
        if (token) return String(token);
      }

      return null;
    }

    function findSupabaseSession() {
      const exactKeys = [
        "sb-svvfyyxryrgkemlsvzip-auth-token",
        "sb-svvfyxxryrgkemlsvzip-auth-token"
      ];

      for (const key of exactKeys) {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = safeJsonParse(raw);
        const session = extractSessionFromParsed(parsed);
        if (session) return session;
      }

      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;
        if (!key.startsWith("sb-")) continue;
        if (!key.endsWith("-auth-token")) continue;

        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = safeJsonParse(raw);
        const session = extractSessionFromParsed(parsed);
        if (session) return session;
      }

      return null;
    }

    async function findSupabaseSessionWithRetry(maxAttempts, delayMs) {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const session = findSupabaseSession();
        if (session && session.access_token) return session;
        if (attempt < maxAttempts - 1) await sleep(delayMs);
      }
      return null;
    }

    function uuidv4() {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
      return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
    }

    function qsBatchId() {
      try {
        const u = new URL(window.location.href);
        const v = u.searchParams.get("batch_id");
        return v && String(v).trim() ? String(v).trim() : null;
      } catch (_) {
        return null;
      }
    }

    function setMsg(text) {
      if (!elMsg) return;
      if (!text) {
        elMsg.style.display = "none";
        elMsg.textContent = "";
        return;
      }
      elMsg.style.display = "block";
      elMsg.textContent = text;
    }

    function setProgress(text) {
      if (!elProgress) return;
      if (!text) {
        elProgress.style.display = "none";
        elProgress.textContent = "";
        return;
      }
      elProgress.style.display = "block";
      elProgress.textContent = text;
    }

    function el(tag, className, text) {
      const n = document.createElement(tag);
      if (className) n.className = className;
      if (text !== undefined) n.textContent = text;
      return n;
    }

    function safeText(s, fallback) {
      const t = (s === null || s === undefined) ? "" : String(s);
      const trimmed = t.trim();
      return trimmed ? trimmed : (fallback || "");
    }

    function clamp01(n) {
      const x = Number(n);
      if (!isFinite(x)) return null;
      return Math.max(0, Math.min(1, x));
    }

    function formatPercent01(p) {
      if (p === null || p === undefined) return "—";
      let n = Number(p);
      if (!isFinite(n)) return "—";
      if (n > 1.0001 && n <= 100.0001) n = n / 100;
      const c = clamp01(n);
      if (c === null) return "—";
      return (c * 100).toFixed(1) + "%";
    }

    function getHitScoreColorClass(pct) {
      if (pct === null || pct === undefined || !Number.isFinite(pct)) return "hs-red";
      const num = Number(pct);
      if (num < 20) return "hs-red";
      if (num < 40) return "hs-orange";
      if (num < 60) return "hs-yellow";
      if (num < 80) return "hs-yellowgreen";
      if (num < 90) return "hs-green";
      return "hs-blue";
    }

    // Batch-relative hit score display: min/max stretch + power curve
    function computeBatchRelativeHitScore(rawPct, minPct, maxPct, floor = 5, cap = 95, gamma = 1.6, shrink = 0.85) {
      if (rawPct == null || !Number.isFinite(rawPct)) return null;
      
      // Preserve bottom: if rawPct < 20, return unchanged
      if (rawPct < 20) return rawPct;
      
      // If no range (all same), return rawPct
      if (maxPct === minPct || !Number.isFinite(minPct) || !Number.isFinite(maxPct)) {
        return rawPct;
      }
      
      // Normalize to 0..1 within batch range
      const t = (rawPct - minPct) / (maxPct - minPct);
      
      // Apply shrink factor to prevent top track from mapping to cap
      const tShrunk = Math.max(0, Math.min(1, t * shrink));
      
      // Progressive curve (gamma > 1 separates top more)
      const t2 = Math.pow(tShrunk, gamma);
      
      // Map to display range
      const dispPct = floor + (cap - floor) * t2;
      
      return Math.max(floor, Math.min(cap, dispPct));
    }

    // Helper to get batch-relative display value from hit_score (0-1) and score object
    function getHitScoreForDisplay(hitScoreRaw, scoreObj = null) {
      if (hitScoreRaw === null || hitScoreRaw === undefined) return null;
      const rawPct = Number(hitScoreRaw) * 100;
      if (!Number.isFinite(rawPct)) return null;
      
      // If score object has batch stats, use them; otherwise fallback to raw
      const minPct = scoreObj?.batchMinPct;
      const maxPct = scoreObj?.batchMaxPct;
      
      if (minPct !== null && minPct !== undefined && maxPct !== null && maxPct !== undefined) {
        return computeBatchRelativeHitScore(rawPct, minPct, maxPct);
      }
      
      // Fallback: return raw if no batch stats available
      return rawPct;
    }

    function getHitProbForDisplay(item) {
      const hp =
        item?.hit_probability_display ??
        item?.hit_probability ??
        item?.features_json?.hit_probability ??
        item?.features_json?.threshold?.hit_probability ??
        null;

      return (typeof hp === "number" && isFinite(hp)) ? hp : null;
    }

    function formatHitScorePercent(item) {
      const hp = getHitProbForDisplay(item);
      return hp === null ? null : (hp * 100);
    }

    function computeHitScore(item) {
      return getHitProbForDisplay(item);
    }

    function normalizeTagProb(tag) {
      if (!tag || typeof tag !== "object") return null;
      const name = tag.name ? String(tag.name).trim() : "";
      if (!name) return null;
      let p = (tag.probability !== undefined) ? Number(tag.probability) : null;
      if (p === null || !isFinite(p)) p = null;
      if (p !== null && p > 1.0001 && p <= 100.0001) p = p / 100;
      const prob = (p === null) ? null : clamp01(p);
      return { name, probability: prob };
    }

    function fileKey(f) {
      try {
        return [f.name || "", String(f.size || 0), String(f.lastModified || 0)].join("|");
      } catch (_) {
        return String(Math.random());
      }
    }

    function addFilesFromPicker(fileList) {
      const incoming = fileList ? Array.from(fileList) : [];
      if (!incoming.length) return;

      const existingKeys = new Set(selectedFiles.map(fileKey));
      for (const f of incoming) {
        const k = fileKey(f);
        if (!existingKeys.has(k)) {
          selectedFiles.push(f);
          existingKeys.add(k);
        }
      }

      if (selectedFiles.length > 10) {
        selectedFiles = selectedFiles.slice(0, 10);
        setMsg("Max 10 songs per batch.");
      }

      renderSelectedFilesList();
    }

    function renderSelectedFilesList() {
      if (!elFileList) return;

      if (!selectedFiles.length) {
        elFileList.style.display = "none";
        elFileList.innerHTML = "";
      } else {
        elFileList.style.display = "block";
        elFileList.innerHTML = "";

        elFileList.appendChild(el("div", "bc-file-list-header", "Selected files (" + selectedFiles.length + ")"));

        selectedFiles.forEach((f) => {
          const row = el("div", "bc-file-row");
          row.appendChild(el("div", "bc-file-name", safeText(f.name, "Untitled")));

          const removeBtn = document.createElement("button");
          removeBtn.type = "button";
          removeBtn.className = "bc-file-remove";
          removeBtn.textContent = "Remove";
          removeBtn.addEventListener("click", function () {
            const k = fileKey(f);
            selectedFiles = selectedFiles.filter((x) => fileKey(x) !== k);
            setMsg("");
            setProgress("");
            renderSelectedFilesList();
          });

          row.appendChild(removeBtn);
          elFileList.appendChild(row);
        });
      }

      if (selectedFiles.length >= 3 && selectedFiles.length <= 10) {
        if (elStart) elStart.disabled = false;
        if (elMsg && (elMsg.style.display !== "block" || elMsg.textContent === "Select at least 3 files.")) {
          setMsg("");
        }
      } else {
        if (elStart) elStart.disabled = true;
        if (selectedFiles.length > 0 && selectedFiles.length < 3) {
          setMsg("Select at least 3 files.");
        }
      }
    }

    function getBestMatchCategory(item) {
      const fj = item && item.features_json && typeof item.features_json === "object" ? item.features_json : null;
      const category1 = fj?.segment_response?.label || null;
      const category2 = fj?.segment_response?.best_segment || null;
      const category3 = fj?.best_segment || null;
      const category4 = (item?.segment && item.segment.label) ? item.segment.label : null;
      return category1 || category2 || category3 || category4 || null;
    }

    function getGenreTags(item) {
      const fj = item && item.features_json && typeof item.features_json === "object" ? item.features_json : null;
      const metadata = fj && fj.cyanite && typeof fj.cyanite === "object" ? fj.cyanite : null;
      const tags = metadata && Array.isArray(metadata.genre_tags) ? metadata.genre_tags : [];
      return tags.map(normalizeTagProb).filter(Boolean);
    }

    function formatMmSs(totalSeconds) {
      const n = Number(totalSeconds);
      if (!isFinite(n) || n < 0) return "—";
      const s = Math.round(n);
      const mm = Math.floor(s / 60);
      const ss = s % 60;
      return String(mm).padStart(2, "0") + ":" + String(ss).padStart(2, "0");
    }

    function getBestSegment(item) {
      const parts = item?.features_json?.parts;
      if (parts && typeof parts === "object") {
        return parts.best_moment || parts.best_segment || null;
      }
      return null;
    }

    function getWeakSegment(item) {
      return item?.features_json?.parts?.weak_segment || null;
    }

    function formatSegmentLine(seg) {
      if (!seg) {
        return "Strongest moment: No clear standout moment detected.";
      }
      const start = seg?.start_s;
      const end = seg?.end_s;
      const label = seg?.label ? String(seg.label) : "Segment";
      return "Strongest moment: " + formatMmSs(start) + "–" + formatMmSs(end) + " — " + label;
    }

    function formatWeakSegmentLine(seg) {
      if (!seg) return null;
      const start = seg?.start_s;
      const end = seg?.end_s;
      const label = seg?.label ? String(seg.label) : "Segment";
      return "Weak segment: " + formatMmSs(start) + "–" + formatMmSs(end) + " — " + label;
    }

    function getBestMomentRange(item) {
      const seg = getBestSegment(item);
      if (!seg) return null;
      const start = seg?.start_s;
      const end = seg?.end_s;
      const range = formatMmSs(start) + "–" + formatMmSs(end);
      return range.includes("—") ? null : range;
    }

    function getSpotifyPitch(item) {
      const fj = item && item.features_json && typeof item.features_json === "object" ? item.features_json : null;
      const pitch = fj && typeof fj.spotify_pitch === "string" ? fj.spotify_pitch.trim() : "";
      return pitch || null;
    }

    function getCyaniteBpm(item) {
      const aj = item && item.analysis_json && typeof item.analysis_json === "object" ? item.analysis_json : null;
      
      // Prioritize: analysis_json.audioAnalysisV7.result.bpmPrediction.value (or .bpmPrediction.bpm)
      if (aj?.audioAnalysisV7?.result?.bpmPrediction) {
        const bp = aj.audioAnalysisV7.result.bpmPrediction;
        const value = bp?.value ?? bp?.bpm;
        if (value !== null && value !== undefined) {
          const num = typeof value === "number" ? value : parseFloat(value);
          if (isFinite(num) && num > 0) {
            return Math.round(num) + " BPM";
          }
        }
      }
      
      const fj = item && item.features_json && typeof item.features_json === "object" ? item.features_json : null;
      
      const candidates = [
        fj?.cyanite?.tempo,
        fj?.cyanite?.bpm,
        aj?.audioAnalysisV7?.tempo,
        aj?.audioAnalysisV7?.bpm,
        aj?.cyanite?.tempo,
        aj?.cyanite?.bpm
      ];
      
      function extractBpmValue(val) {
        if (val === null || val === undefined) return null;
        
        // If it's already a number, use it
        if (typeof val === "number" && isFinite(val) && val > 0) {
          return val;
        }
        
        // If it's a string, try to parse it
        if (typeof val === "string") {
          const parsed = parseFloat(val);
          if (isFinite(parsed) && parsed > 0) {
            return parsed;
          }
          return null;
        }
        
        // If it's an object, try common keys
        if (typeof val === "object" && val !== null) {
          const objectKeys = ["bpm", "value", "mean", "tempo", "estimate", "result"];
          for (const key of objectKeys) {
            if (val.hasOwnProperty(key)) {
              const nested = val[key];
              if (typeof nested === "number" && isFinite(nested) && nested > 0) {
                return nested;
              }
              if (typeof nested === "string") {
                const parsed = parseFloat(nested);
                if (isFinite(parsed) && parsed > 0) {
                  return parsed;
                }
              }
            }
          }
        }
        
        return null;
      }
      
      for (const val of candidates) {
        const bpm = extractBpmValue(val);
        if (bpm !== null) {
          return Math.round(bpm) + " BPM";
        }
      }
      
      return null;
    }

    function getCyaniteAutoDescription(item) {
      const aj = item && item.analysis_json && typeof item.analysis_json === "object" ? item.analysis_json : null;
      
      // Priority 1: analysis_json.audioAnalysisV7.result.transformerCaption
      if (aj?.audioAnalysisV7?.result?.transformerCaption) {
        const desc = String(aj.audioAnalysisV7.result.transformerCaption).trim();
        if (desc) return desc;
      }
      
      // Priority 2: item.cyanite_song_description
      if (item?.cyanite_song_description) {
        const desc = String(item.cyanite_song_description).trim();
        if (desc) return desc;
      }
      
      // Priority 3: features_json.cyanite.song_description
      const fj = item && item.features_json && typeof item.features_json === "object" ? item.features_json : null;
      if (fj?.cyanite?.song_description) {
        const desc = String(fj.cyanite.song_description).trim();
        if (desc) return desc;
      }
      
      return null;
    }

    function copyToClipboard(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        try {
          document.execCommand("copy");
        } catch (_) {}
        document.body.removeChild(textarea);
      }
    }

    function appendSpotifyPitch(card, item) {
      const existing = getSpotifyPitch(item);
      
      const bpm = getCyaniteBpm(item);
      const autoDesc = getCyaniteAutoDescription(item);
      
      // Build lane/playlist fit: prioritize genreTags, avoid repeating genre words from autoDesc
      let playlistFit = null;
      const aj = item && item.analysis_json && typeof item.analysis_json === "object" ? item.analysis_json : null;
      if (aj?.audioAnalysisV7?.result?.genreTags && Array.isArray(aj.audioAnalysisV7.result.genreTags) && aj.audioAnalysisV7.result.genreTags.length > 0) {
        const tags = aj.audioAnalysisV7.result.genreTags.slice(0, 2).map(t => {
          if (typeof t === "string") return t;
          if (t && typeof t === "object" && t.name) return String(t.name);
          return String(t || "");
        }).filter(Boolean);
        if (tags.length > 0) {
          playlistFit = tags.join(" / ");
        }
      }
      if (!playlistFit) {
        playlistFit = getBestMatchCategory(item) || "Pop / Contemporary";
      }
      
      // Check if autoDesc already contains genre words to avoid repetition
      const autoDescLower = autoDesc ? String(autoDesc).toLowerCase() : "";
      const genreWords = ["soul", "rnb", "r&b", "funk", "pop", "rock", "jazz", "blues", "country", "hip hop", "rap", "electronic", "edm"];
      const hasGenreOverlap = genreWords.some(word => autoDescLower.includes(word));
      
      let defaultPitch = "";
      if (autoDesc) {
        defaultPitch = autoDesc + " ";
      }
      defaultPitch += "Clear identity with an early hook. ";
      if (hasGenreOverlap) {
        // Use softer phrasing when genre is already mentioned in autoDesc
        defaultPitch += "Playlist fit: " + playlistFit + ". ";
      } else {
        defaultPitch += "Lane: " + playlistFit + ". ";
      }
      if (bpm) {
        const bpmNum = String(bpm).replace(/\s*BPM\s*$/i, "").trim();
        defaultPitch += "(~" + bpmNum + " BPM)";
      }
      
      const pitchText = existing || defaultPitch;

      const wrap = el("div", "bc-pitch-wrap");

      const tbtn = document.createElement("button");
      tbtn.type = "button";
      tbtn.className = "bc-toggle";
      tbtn.textContent = "Playlist Pitch";

      const helperText = document.createElement("div");
      helperText.textContent = "Optimized for Spotify editorial and playlist submissions.";
      helperText.style.fontSize = "11px";
      helperText.style.color = "#6b7280";
      helperText.style.marginTop = "4px";
      helperText.style.marginBottom = "8px";

      const body = el("div", "bc-pitch-body");
      body.style.display = "none";

      const textarea = document.createElement("textarea");
      textarea.value = pitchText;
      textarea.rows = 2;
      textarea.style.width = "100%";
      textarea.style.padding = "8px";
      textarea.style.border = "1px solid #e5e7eb";
      textarea.style.borderRadius = "8px";
      textarea.style.fontSize = "12px";
      textarea.style.fontFamily = "inherit";
      textarea.style.color = "#111827";
      textarea.style.resize = "vertical";
      textarea.style.minHeight = "60px";
      
      const updateHeight = function() {
        textarea.style.height = "auto";
        textarea.style.height = textarea.scrollHeight + "px";
      };
      updateHeight();
      textarea.addEventListener("input", updateHeight);
      
      body.appendChild(textarea);

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.textContent = "Copy";
      copyBtn.style.marginTop = "6px";
      copyBtn.style.padding = "6px 12px";
      copyBtn.style.fontSize = "12px";
      copyBtn.style.background = "#111827";
      copyBtn.style.color = "#ffffff";
      copyBtn.style.border = "1px solid #111827";
      copyBtn.style.borderRadius = "8px";
      copyBtn.style.cursor = "pointer";
      copyBtn.addEventListener("click", function () {
        copyToClipboard(textarea.value);
        const originalText = tbtn.textContent;
        tbtn.textContent = "Copied ✓";
        setTimeout(function () {
          tbtn.textContent = originalText;
        }, 2000);
      });
      body.appendChild(copyBtn);

      tbtn.addEventListener("click", function () {
        const open = body.style.display !== "none";
        body.style.display = open ? "none" : "block";
        tbtn.textContent = open ? "Playlist Pitch" : "Hide Playlist Pitch";
        if (!open) {
          updateHeight();
        }
      });

      wrap.appendChild(tbtn);
      wrap.appendChild(helperText);
      wrap.appendChild(body);
      card.appendChild(wrap);
    }

    function appendSegmentInfo(card, item, showDebug) {
      const bestSeg = getBestSegment(item);
      const bestLine = formatSegmentLine(bestSeg);
      const bestRow = el("div", "bc-row", bestLine);
      if (!bestSeg) {
        bestRow.style.color = "#6b7280";
      }
      card.appendChild(bestRow);

      if (!showDebug) return;

      if (bestSeg) {
        const conf = (bestSeg.confidence !== null && bestSeg.confidence !== undefined) ? Number(bestSeg.confidence) : null;
        const confText = (conf !== null && isFinite(conf)) ? conf.toFixed(2) : "—";
        const reasons = Array.isArray(bestSeg.reasons) ? bestSeg.reasons.join(", ") : "—";
        card.appendChild(el("div", "bc-row", "Segment confidence: " + confText + " · Reasons: " + reasons));
      } else {
        card.appendChild(el("div", "bc-row", "Segment confidence: — · Reasons: —"));
      }

      const weakSeg = getWeakSegment(item);
      const weakLine = formatWeakSegmentLine(weakSeg);
      if (weakLine) {
        card.appendChild(el("div", "bc-row", weakLine));
      }
    }

    function renderFallbackCard(item, songId, hitScore, scoreObj = null) {
      const card = el("div", "bc-card");
      const title = safeText(item?.title, "Untitled");
      card.appendChild(el("div", "bc-song-title", title));
      // hitScore is 0-1 from tuned.hit_score, convert to batch-relative display value
      const dispPct = getHitScoreForDisplay(hitScore, scoreObj);
      const hitText = dispPct === null ? "—" : dispPct.toFixed(1) + "%";
      const colorClass = getHitScoreColorClass(dispPct);
      const hitTextColored = dispPct !== null
        ? `<span class="${colorClass}" style="font-variant-numeric:tabular-nums;">${hitText}</span>`
        : hitText;
      const rowEl = el("div", "bc-row");
      rowEl.innerHTML = "Hit score: " + hitTextColored;
      card.appendChild(rowEl);
      return card;
    }

    function isBalladEligible(input) {
      // Normalize: accept either a raw song row OR a score wrapper { item: song }
      const song =
        (input && (input.analysis_json || input.features_json)) ? input :
        (input && input.item) ? input.item :
        null;

      if (!song) return false;

      // Check multiple paths for ballad description (priority order)
      const descCandidates = [
        song.cyanite_song_description,                                    // a) top-level field
        song.analysis_json?.cyanite?.song_description,                     // b) analysis_json.cyanite
        song.features_json?.cyanite?.song_description,                     // c) features_json.cyanite
        song.analysis_json?.audioAnalysisV7?.song_description             // d) analysis_json.audioAnalysisV7
      ].filter(Boolean);

      // Find first non-empty string description
      const desc = descCandidates.find(d => d && typeof d === "string" && d.trim().length > 0);
      if (!desc) return false;

      // Match "ballad" or "ballads" as whole words (case-insensitive)
      const balladRegex = /\bballads?\b/i;
      return balladRegex.test(String(desc));
    }

    function getDecisionWeight(item) {
      const fj = item && item.features_json && typeof item.features_json === "object" ? item.features_json : null;
      const role = fj?.role ? String(fj.role).toLowerCase() : "";
      const releaseRole = fj?.release_role ? String(fj.release_role).toLowerCase() : "";
      const isAlbumTrack = fj?.is_album_track === true || fj?.album_track?.badge === true;

      if (releaseRole === "lead_single" || role === "lead") return 100;
      if (releaseRole === "follow_up_single") return 70;
      if (isAlbumTrack) return 40;
      return 0;
    }

    function getConfidenceWeight(item) {
      const fj = item && item.features_json && typeof item.features_json === "object" ? item.features_json : null;
      const decisionResponse = fj?.decision_response || {};
      const segmentResponse = fj?.segment_response || {};
      const raw = segmentResponse.segment_fit_confidence?.confidence || decisionResponse.confidence || null;

      if (typeof raw === "string") {
        const s = raw.trim().toLowerCase();
        if (s.includes("high")) return 20;
        if (s.includes("medium")) return 10;
        if (s.includes("low")) return 0;
        if (s.endsWith("%")) {
          const n = parseFloat(s.replace("%", "").trim());
          if (isFinite(n)) return n >= 66 ? 20 : (n >= 33 ? 10 : 0);
        }
        return 0;
      }

      if (typeof raw === "number" && isFinite(raw)) {
        const v = raw > 1 ? raw / 100 : raw;
        return v >= 0.66 ? 20 : (v >= 0.33 ? 10 : 0);
      }

      if (raw && typeof raw === "object") {
        const label = raw.label || raw.level || raw.confidence || raw.value;
        if (typeof label === "string") {
          const s = label.trim().toLowerCase();
          if (s.includes("high")) return 20;
          if (s.includes("medium")) return 10;
          if (s.includes("low")) return 0;
        }
        if (typeof label === "number" && isFinite(label)) {
          const v = label > 1 ? label / 100 : label;
          return v >= 0.66 ? 20 : (v >= 0.33 ? 10 : 0);
        }
      }

      return 0;
    }

    function extractExistingNumericScore(item) {
      const fj = item && item.features_json && typeof item.features_json === "object" ? item.features_json : null;
      const candidates = [
        item?.score, item?.total_score, item?.rf_score, item?.model_score,
        fj?.score, fj?.total_score, fj?.rf_score, fj?.model_score,
        fj?.decision_response?.score, fj?.decision_response?.overall_score,
        fj?.segment_response?.score
      ];

      for (const c of candidates) {
        const n = Number(c);
        if (isFinite(n)) return n;
      }
      return null;
    }

    function extractHitProbabilityFallback(item) {
      const fj = item && item.features_json && typeof item.features_json === "object" ? item.features_json : null;
      const candidates = [ item?.hit_probability, fj?.hit_probability, fj?.decision_response?.hit_probability ];
      for (const c of candidates) {
        const n = Number(c);
        if (isFinite(n)) return n;
      }
      return null;
    }

    function computeCompareScore(item) {
      const decisionWeight = getDecisionWeight(item);
      const confidenceWeight = getConfidenceWeight(item);
      const primary = decisionWeight + confidenceWeight;

      let tie = extractExistingNumericScore(item);
      if (tie === null || tie === undefined) tie = extractHitProbabilityFallback(item);

      let tieNorm = 0;
      if (tie !== null && tie !== undefined) {
        const t = Number(tie);
        if (isFinite(t)) {
          if (t <= 1) tieNorm = t;
          else if (t <= 100) tieNorm = t / 100;
          else tieNorm = t / 1000;
        }
      }

      const total = primary + (tieNorm * 0.5);
      return { primary: primary, tie: tieNorm, total: total };
    }

    function resetPlaybackUI() {
      if (activeCard) activeCard.classList.remove("bc-card-active");
      if (activeBtn) {
        activeBtn.textContent = "▶ Play";
        activeBtn.setAttribute("aria-pressed", "false");
      }
      activeCard = null;
      activeBtn = null;
      activeSongId = null;
    }

    function stopPlayback() {
      try { player.pause(); } catch (_) {}
      player.removeAttribute("src");
      try { player.load(); } catch (_) {}
      resetPlaybackUI();
    }

    function setActive(cardEl, btnEl, songId) {
      if (activeCard && activeCard !== cardEl) activeCard.classList.remove("bc-card-active");
      if (activeBtn && activeBtn !== btnEl) {
        activeBtn.textContent = "▶ Play";
        activeBtn.setAttribute("aria-pressed", "false");
      }
      activeCard = cardEl;
      activeBtn = btnEl;
      activeSongId = songId;
      if (activeCard) activeCard.classList.add("bc-card-active");
      if (activeBtn) {
        activeBtn.textContent = "⏸ Pause";
        activeBtn.setAttribute("aria-pressed", "true");
      }
    }

    async function fetchTuningScore(songId, preset) {
      const token = getSupabaseAccessTokenFromLocalStorage();
      if (!token) {
        console.warn("[BatchCompare] No token for tuning score, skipping", songId);
        return null;
      }

      preset = (preset || "").split("?")[0].trim() || "hit_single";

      // tuning override via ?force_sidecar=0/1
      const useSidecar = resolveUseSidecar(null);

      try {
        const res = await fetch(API_BASE + "/tuning/score", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            song_id: songId,
            preset: preset,
            use_sidecar: useSidecar,
            use_beats: resolveUseSidecar(null),
            use_oai: resolveUseOai()
          })
        });

        if (!res.ok) {
          const text = await res.text().catch((_) => "");
          throw new Error("Tuning score failed: HTTP " + res.status + (text ? (": " + text) : ""));
        }

        const data = await res.json();
        if (!data || !data.ok) {
          throw new Error(data?.error || "Tuning score returned error");
        }

        const tuned = (data.tuned_score !== undefined && data.tuned_score !== null) ? Number(data.tuned_score) : null;
        const tunedRaw = (data.tuned_score_raw !== undefined && data.tuned_score_raw !== null) ? Number(data.tuned_score_raw) : null;
        const hitScore = (data.hit_score !== undefined && data.hit_score !== null) ? Number(data.hit_score) : null;
        const presetUsed = data.preset_used || data.preset || preset;
        return {
          tuned_score: (tuned !== null && isFinite(tuned)) ? tuned : 0,
          tuned_score_raw: (tunedRaw !== null && isFinite(tunedRaw)) ? tunedRaw : null,
          hit_score: (hitScore !== null && isFinite(hitScore)) ? hitScore : null,
          preset_used: presetUsed ? String(presetUsed) : String(preset || "hit_single")
        };
      } catch (e) {
        console.error("[BatchCompare] tuning score failed for", songId, ":", e);
        return null;
      }
    }

    async function renderCompare(items, batchId, preset) {
      console.debug("[Batch Compare] preset", { preset: preset || "hit_single", batchId: batchId || null });
      if (elList) elList.innerHTML = "";

      const rawItems = items || [];
      const byId = new Map();
      for (const it of rawItems) {
        const id = it?.id ? String(it.id) : "";
        if (!id) continue;
        if (!byId.has(id)) byId.set(id, it);
      }
      const noId = rawItems.filter((it) => !it?.id);
      currentItems = Array.from(byId.values()).concat(noId);
      currentPreset = preset || "hit_single";
      const presetLabel =
        currentPreset === "ballad"
          ? "Ballad lens"
          : (PRESET_ROLE_LABEL[currentPreset] || (currentPreset + " lens"));
      const showDebug = qsDebug();

      // TEMP: Log ballad detection data when ballad preset is active
      if (currentPreset === "ballad" && currentItems.length > 0) {
        console.log("[Batch Compare] Ballad preset - detection check", {
          songsCount: currentItems.length,
          items: currentItems.map(item => {
            const desc = item?.analysis_json?.cyanite?.song_description ||
                         item?.features_json?.cyanite?.song_description ||
                         item?.analysis_json?.audioAnalysisV7?.song_description ||
                         null;
            const hasBallad = desc ? String(desc).toLowerCase().includes("ballad") : false;
            return {
              title: item?.title || "Untitled",
              hasAnalysisJson: !!item?.analysis_json,
              description: desc ? desc.substring(0, 100) : null,
              containsBallad: hasBallad,
              isEligible: isBalladEligible(item)
            };
          })
        });
      }

      if (!currentItems.length) {
        if (elLead) elLead.textContent = "No songs found for this batch.";
        if (elSummary) elSummary.style.display = "none";
        return;
      }

      const scores = [];
      for (const item of currentItems) {
        const songId = item?.id;
        if (!songId) {
          const fallbackHitScore = getHitProbForDisplay(item);
          const fallback = computeCompareScore(item);
          scores.push({
            item,
            hit_score: fallbackHitScore,
            preset_score: fallback.total,
            delta: (fallbackHitScore !== null) ? (fallback.total - fallbackHitScore) : 0,
            tuned_score_raw: null,
            isFallback: true
          });
          continue;
        }

        const tuned = await fetchTuningScore(songId, currentPreset);
        if (tuned === null) {
          // Fallback: use hit_probability_display if available, else null
          const fallbackHitScore = getHitProbForDisplay(item);
          const fallback = computeCompareScore(item);
          scores.push({
            item,
            hit_score: fallbackHitScore,
            preset_score: fallback.total,
            delta: (fallbackHitScore !== null) ? (fallback.total - fallbackHitScore) : 0,
            tuned_score_raw: null,
            isFallback: true
          });
        } else {
          // Use tuned.hit_score (0-1) as the source of truth for hit_score
          const hitScore = (tuned.hit_score !== null && tuned.hit_score !== undefined)
            ? Number(tuned.hit_score)
            : null;
          const presetScore = tuned.tuned_score; // from /tuning/score; ranking sorts by this (tuned_score)
          const delta = (hitScore !== null) ? (presetScore - hitScore) : 0;

          scores.push({
            item,
            hit_score: hitScore,
            preset_score: presetScore,
            delta: delta,
            tuned_score_raw: tuned.tuned_score_raw,
            preset_used: tuned.preset_used,
            isFallback: false
          });
        }
      }

      // Compute batch-relative min/max for hit score display
      const validHitScores = scores
        .filter(s => s.hit_score !== null && s.hit_score !== undefined && !s.isFallback)
        .map(s => Number(s.hit_score) * 100)
        .filter(pct => Number.isFinite(pct));
      
      const minPct = validHitScores.length > 0 ? Math.min(...validHitScores) : null;
      const maxPct = validHitScores.length > 0 ? Math.max(...validHitScores) : null;
      
      // Store batch stats on each score object for display
      scores.forEach(s => {
        s.batchMinPct = minPct;
        s.batchMaxPct = maxPct;
      });
      
      // Debug log: first item (or top 3)
      if (validHitScores.length > 0 && qsDebug()) {
        const top3 = scores.slice(0, 3).filter(s => s.hit_score !== null);
        top3.forEach((s, idx) => {
          const rawPct = Number(s.hit_score) * 100;
          // Compute intermediate values for debug
          if (rawPct >= 20 && minPct !== null && maxPct !== null && maxPct !== minPct) {
            const t = (rawPct - minPct) / (maxPct - minPct);
            const shrink = 0.85;
            const tShrunk = Math.max(0, Math.min(1, t * shrink));
            const dispPct = computeBatchRelativeHitScore(rawPct, minPct, maxPct);
            console.log(`[Batch Compare] hit_score batch-relative [${idx}]:`, {
              rawPct: rawPct.toFixed(1),
              t: t.toFixed(3),
              t_shrunk: tShrunk.toFixed(3),
              dispPct: dispPct !== null ? dispPct.toFixed(1) : null,
              minPct: minPct !== null ? minPct.toFixed(1) : null,
              maxPct: maxPct !== null ? maxPct.toFixed(1) : null
            });
          } else {
            const dispPct = computeBatchRelativeHitScore(rawPct, minPct, maxPct);
            console.log(`[Batch Compare] hit_score batch-relative [${idx}]:`, {
              rawPct: rawPct.toFixed(1),
              t: "N/A",
              t_shrunk: "N/A",
              dispPct: dispPct !== null ? dispPct.toFixed(1) : null,
              minPct: minPct !== null ? minPct.toFixed(1) : null,
              maxPct: maxPct !== null ? maxPct.toFixed(1) : null
            });
          }
        });
      }

      const isBalladPreset = (currentPreset === "ballad");
      
      // SEPARATE CODE PATH FOR BALLAD PRESET - returns early
      if (isBalladPreset) {
        const balladScores = scores.filter(s => isBalladEligible(s));

        // Hvis ingen ballader: vis tydelig melding og returner
        if (!balladScores.length) {
          const totalCount = scores.length;
          const shownCount = 0;
          const filteredOut = totalCount - shownCount;
          const note = "Ballad lens: showing " + shownCount + " of " + totalCount + " songs" +
            (filteredOut > 0 ? (" (" + filteredOut + " filtered out)") : "");
          setFilterNote(note);
          if (elLead) elLead.textContent = "No ballad candidates in this batch.";
          if (elSummary) { elSummary.style.display = "none"; elSummary.textContent = ""; }
          if (elList) elList.innerHTML = "";
          return;
        }

        // Top pick = høyest hit_score blant balladScores (null => -1)
        const sortedByHit = balladScores.slice().sort((a,b) => ((b.hit_score ?? -1) - (a.hit_score ?? -1)));
        let lead = sortedByHit[0];
        let leadId = lead?.item?.id ? String(lead.item.id) : null;

        // Preset winner = høyest preset_score blant ballader uten lead
        const rest = balladScores.filter(s => String(s?.item?.id || "") !== String(leadId || ""));
        let presetWinner = rest.length ? rest.slice().sort((a,b)=> b.preset_score - a.preset_score)[0] : null;
        let presetWinnerId = presetWinner?.item?.id ? String(presetWinner.item.id) : null;

        // Header-UI (ingen album track i ballad preset)
        if (elLead) {
          const leadTitle = safeText(lead?.item?.title, "Untitled");
          const presetTitle = safeText(presetWinner?.item?.title, "Untitled");
          elLead.innerHTML =
            `<div style="margin-bottom:4px;"><strong>Top pick:</strong> ${leadTitle}</div>` +
            (presetWinner
              ? `<div style="margin-bottom:4px;"><strong>Second pick (Ballad lens):</strong> ${presetTitle}</div>`
              : `<div style="margin-bottom:4px; color:#6b7280;">No second pick candidate in this batch.</div>`);
        }

        // Rangering/listen: kun ballader
        let ranked = [];
        if (lead) ranked.push(lead);
        if (presetWinner && presetWinnerId !== leadId) ranked.push(presetWinner);

        const added = new Set(ranked.map(r => String(r?.item?.id || "")));
        const remaining = balladScores.filter(s => !added.has(String(s?.item?.id || "")));
        remaining.sort((a,b)=> b.preset_score - a.preset_score);
        ranked.push(...remaining);

        const totalCount = scores.length;
        const shownCount = ranked.length;
        const filteredOut = totalCount - shownCount;
        const note = "Ballad lens: showing " + shownCount + " of " + totalCount + " songs" +
          (filteredOut > 0 ? (" (" + filteredOut + " filtered out)") : "");
        setFilterNote(note);

        // Render cards fra `ranked`
        if (elList) {
          ranked.forEach((r, idx) => {
            const item = r?.item || {};
            try {
              if (!window.__bcFirstItem) window.__bcFirstItem = item;
            } catch (_) {}
            const songId = item?.id || ("idx-" + idx);
            try {
              const card = el("div", "bc-card");

              let roleLabel = "";
              let roleTone = "neutral";
              let roleEmoji = "🎵";

              const sid = songId ? String(songId) : "";
              
              // Compute isWeakOrInvalid: only true for clearly bad/invalid songs
              const analysisStatus = item?.analysis_status;
              const hasFailedAnalysis = analysisStatus && String(analysisStatus).toLowerCase().includes("fail");
              const missingData = !item?.features_json && !item?.analysis_json;
              const hasNullHitScore = r?.hit_score === null || r?.hit_score === undefined;
              const hasVeryLowHitScore = r?.hit_score !== null && r?.hit_score !== undefined && r.hit_score < 0.05;
              const isWeakOrInvalid = hasFailedAnalysis || missingData || hasNullHitScore || hasVeryLowHitScore;
              
              if (sid === leadId) {
                roleLabel = "Top pick";
                roleTone = "lead";
                roleEmoji = "⭐";
              } else if (sid === presetWinnerId) {
                roleLabel = currentPreset === "ballad"
                  ? "Second pick (Ballad lens)"
                  : (PRESET_ROLE_LABEL[currentPreset] || "Second pick");
                roleTone = "preset";
                roleEmoji = "🎯";
              } else if (isWeakOrInvalid) {
                roleLabel = "Additional";
                roleTone = "neutral";
                roleEmoji = "🎵";
              } else {
                roleLabel = "Album track";
                roleTone = "album";
                roleEmoji = "💿";
              }

              const roleRow = el("div", "bc-role-row");
              roleRow.appendChild(el("span", "bc-badge bc-badge-" + roleTone, roleEmoji + " " + roleLabel));
              card.appendChild(roleRow);

              card.appendChild(el("div", "bc-song-title", safeText(item.title, "Untitled")));

              const bestSeg = getBestSegment(item);
              const segmentLabel = bestSeg?.label ? s(bestSeg.label) : s(getBestMatchCategory(item));
              const hookTiming = getHookTiming(item);
              const momentRange = getBestMomentRange(item) || "";
              const decisionSummary = getDecisionSummary(item);
              const roleClause = getRoleClause(roleLabel);
              const scoreClause = getScoreClause({
                isLead: sid === leadId,
                isPresetWinner: sid === presetWinnerId,
                isAlbum: false,
                isBalladPreset: isBalladPreset
              });
              const hookConf = hookTiming?.confidence ? (" (" + hookTiming.confidence + ")") : "";
              const reasonText = buildRoleReason(item, currentPreset, roleLabel, {
                presetLabel,
                momentRange,
                segmentLabel,
                hookBucket: hookTiming?.bucket || "",
                hookConf,
                decisionSummary,
                scoreClause,
                roleClause
              });
              card.appendChild(el("div", "bc-reason", reasonText));

              const ctx = getBestMatchCategory(item) || "—";
              card.appendChild(el("div", "bc-row", "Best performance relative to: " + ctx));
              appendSegmentInfo(card, item, showDebug);

              const scoreRow = el("div", "bc-score-row");
              const presetScore = r?.preset_score !== null && r?.preset_score !== undefined ? r.preset_score : 0;
              // r.hit_score is 0-1 from tuned.hit_score, convert to batch-relative display value
              const hitScoreRaw = r?.hit_score !== null && r?.hit_score !== undefined ? r.hit_score : null;
              const dispPct = getHitScoreForDisplay(hitScoreRaw, r);
              const delta = r?.delta !== null && r?.delta !== undefined ? r.delta : 0;

              const hitScoreText = dispPct === null ? "—" : dispPct.toFixed(1) + "%";
              const colorClass = getHitScoreColorClass(dispPct);
              const hitScoreTextColored = dispPct !== null
                ? `<span class="${colorClass}" style="font-variant-numeric:tabular-nums;">${hitScoreText}</span>`
                : hitScoreText;
              const presetScoreText = formatPercent01(presetScore);
              const showDelta = showDebug;
              const deltaPP = delta * 100;
              const deltaText = deltaPP >= 0 ? ("+" + deltaPP.toFixed(1)) : deltaPP.toFixed(1);
              const deltaColor = delta >= 0 ? "#059669" : "#dc2626";

              scoreRow.innerHTML =
                "<span style=\"font-size: 12px; color: #374151;\">Hit score: <strong>" + hitScoreTextColored + "</strong></span> " +
                "<span style=\"font-size: 12px; color: #6b7280; margin-left: 8px;\">" + getPresetScoreLabel(currentPreset) + ": " + presetScoreText + "</span>" +
                (showDelta ? (" <span style=\"font-size: 12px; color: " + deltaColor + "; margin-left: 8px;\">Δ " + deltaText + " pp</span>") : "");
              card.appendChild(scoreRow);

              const playRow = el("div", "bc-play-row");
              const btn = document.createElement("button");
              btn.type = "button";
              btn.className = "bc-play-btn";
              btn.textContent = "▶ Play";
              btn.setAttribute("aria-pressed", "false");

              const url = item?.audio_url ? String(item.audio_url) : "";
              if (!url) {
                btn.disabled = true;
                btn.textContent = "Play unavailable";
              } else {
                btn.addEventListener("click", async function () {
                  try {
                    if (activeSongId === songId && !player.paused) {
                      player.pause();
                      resetPlaybackUI();
                      return;
                    }

                    player.pause();
                    if (player.src !== url) player.src = url;

                    setActive(card, btn, songId);
                    await player.play();
                  } catch (e) {
                    resetPlaybackUI();
                    console.error("[BatchCompare] playback failed:", e);
                  }
                });
              }

              playRow.appendChild(btn);
              card.appendChild(playRow);

              const genreTags = getGenreTags(item);
              if (genreTags.length > 0) {
                const wrap = el("div", "bc-genre-wrap");

                const tbtn = document.createElement("button");
                tbtn.type = "button";
                tbtn.className = "bc-toggle";
                tbtn.textContent = "Primary genre signals";

                const body = el("div", "bc-genre-body");
                body.style.display = "none";

                const list = el("div", "bc-genre-list");
                genreTags.slice(0, 5).forEach((tag) => {
                  const row = el("div", "bc-genre-item");
                  row.appendChild(el("span", "bc-genre-name", tag.name));
                  const prob = (tag.probability === null) ? "—" : formatPercent01(tag.probability);
                  row.appendChild(el("span", "bc-genre-score", prob));
                  list.appendChild(row);
                });
                body.appendChild(list);

                tbtn.addEventListener("click", function () {
                  const open = body.style.display !== "none";
                  body.style.display = open ? "none" : "block";
                  tbtn.textContent = open ? "Primary genre signals" : "Hide genre signals";
                });

                wrap.appendChild(tbtn);
                wrap.appendChild(body);
                card.appendChild(wrap);
              }

              appendSpotifyPitch(card, item);

              elList.appendChild(card);
            } catch (e) {
              console.error("[Batch Compare] card render failed", item?.id, e);
              if (elList) elList.appendChild(renderFallbackCard(item, songId, r?.hit_score ?? null, r));
            }
          });
        }

        player.onended = function () { resetPlaybackUI(); };

        // Update lastGoodScores for debug table
        lastGoodScores = ranked.map((r) => {
          const item = r.item;
          const fj = item && item.features_json && typeof item.features_json === "object" ? item.features_json : null;
          const cyanite = fj && fj.cyanite && typeof fj.cyanite === "object" ? fj.cyanite : null;
          const songDesc = cyanite && cyanite.song_description ? String(cyanite.song_description) : null;
          const cyaniteDesc = songDesc ? (songDesc.length > 80 ? songDesc.substring(0, 80) + "..." : songDesc) : null;
          
          return {
            id: r?.item?.id ? String(r.item.id) : "",
            title: safeText(r?.item?.title, "Untitled"),
            hit_score: r?.hit_score !== null && r?.hit_score !== undefined ? Number(r.hit_score) : null,
            preset_score: Number(r?.preset_score || 0),
            delta: Number(r?.delta || 0),
            preset_used: r?.preset_used || currentPreset || "ballad",
            cyanite_desc: cyaniteDesc || null
          };
        });
        try { window.__batchCompareLastGoodScores = lastGoodScores; } catch (_) {}

        // Debug logging
        const leadObj = lead ? { id: leadId, title: safeText(lead.item.title, "Untitled"), preset_score: lead.preset_score, hit_score: lead.hit_score, delta: lead.delta } : null;
        const presetObj = presetWinner ? { id: presetWinnerId, title: safeText(presetWinner.item.title, "Untitled"), preset_score: presetWinner.preset_score, hit_score: presetWinner.hit_score, delta: presetWinner.delta } : null;
        console.debug("[Batch Compare] scores (ballad)", { preset: currentPreset, lead: leadObj, presetWinner: presetObj });

        // Render debug table if enabled
        if (elScoreDetails && elScoreTable) {
          elScoreDetails.style.display = showDebug ? "block" : "none";
          const rows = lastGoodScores.slice();
          const table = document.createElement("table");
          table.style.width = "100%";
          table.style.borderCollapse = "collapse";
          table.innerHTML = "";

          const thead = document.createElement("thead");
          thead.innerHTML = "<tr><th style=\"text-align:left;padding:8px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#374151;\">Song</th><th style=\"text-align:left;padding:8px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#374151;\">preset_used</th><th style=\"text-align:right;padding:8px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#374151;\">hit_score</th><th style=\"text-align:right;padding:8px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#374151;\">preset_score</th><th style=\"text-align:right;padding:8px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#374151;\">delta</th><th style=\"text-align:left;padding:8px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#374151;\">cyanite_desc</th></tr>";
          table.appendChild(thead);

          const tbody = document.createElement("tbody");
          rows.forEach((r) => {
            const tr = document.createElement("tr");
            const name = (r.isFallback ? (r.title + " (fallback)") : r.title);
            const cyaniteDescText = r.cyanite_desc ? String(r.cyanite_desc).replace(/</g, "&lt;").replace(/>/g, "&gt;") : "—";
            // r.hit_score is 0-1 from tuned.hit_score, convert to batch-relative display value
            const debugDispPct = getHitScoreForDisplay(r.hit_score, r);
            const debugHitScoreText = debugDispPct === null ? "—" : debugDispPct.toFixed(1) + "%";
            tr.innerHTML =
              "<td style=\"padding:8px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#111827;\">" + name.replace(/</g, "&lt;") + "</td>" +
              "<td style=\"padding:8px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#111827;\">" + String(r.preset_used || "").replace(/</g, "&lt;") + "</td>" +
              "<td style=\"padding:8px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#111827;text-align:right;\">" + debugHitScoreText + "</td>" +
              "<td style=\"padding:8px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#111827;text-align:right;\">" + formatPercent01(r.preset_score) + "</td>" +
              "<td style=\"padding:8px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#111827;text-align:right;\">" + (r.delta !== null && r.delta !== undefined ? (r.delta >= 0 ? "+" : "") + r.delta.toFixed(3) : "—") + "</td>" +
              "<td style=\"padding:8px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#111827;\">" + cyaniteDescText + "</td>";
            tbody.appendChild(tr);
          });
          table.appendChild(tbody);

          elScoreTable.innerHTML = "";
          elScoreTable.appendChild(table);
        }

        // Return early - do not execute normal preset logic
        return;
      }
      
      // NORMAL PRESET LOGIC (non-ballad)
      let lead = null;
      let leadId = null;
      let presetWinner = null;
      let presetWinnerId = null;
      
      // Non-ballad presets: normal logic
      const sortedByHitScore = scores.slice().sort((a, b) => {
        const hitA = a.hit_score !== null ? a.hit_score : -1;
        const hitB = b.hit_score !== null ? b.hit_score : -1;
        return hitB - hitA;
      });
      lead = sortedByHitScore[0];
      leadId = lead?.item?.id ? String(lead.item.id) : null;

      // Preset winner = highest preset_score among non-lead candidates
      // Preset-specific gates apply
      const withoutLead = scores.filter((s) => {
        const sid = s?.item?.id ? String(s.item.id) : "";
        return sid !== leadId;
      });

      const minHitGate = PRESET_HIT_GATES[currentPreset] ?? 0.15;

      // Apply gate based on preset for non-ballad presets
      let presetCandidates = withoutLead.filter((s) => {
        const hitScore = (s.hit_score !== null && s.hit_score !== undefined) ? Number(s.hit_score) : 0;
        return hitScore >= minHitGate;
      });

      // Special handling for hit_single: no fallback if gate fails
      if (currentPreset === "hit_single") {
        if (presetCandidates.length > 0) {
          const sortedByPresetScore = presetCandidates.slice().sort((a, b) => b.preset_score - a.preset_score);
          presetWinner = sortedByPresetScore[0];
          presetWinnerId = presetWinner?.item?.id ? String(presetWinner.item.id) : null;
        } else {
          presetWinner = null;
          presetWinnerId = null;
        }
      } else {
        // For other presets: fallback to all candidates if gate leaves us empty
        if (presetCandidates.length === 0) presetCandidates = withoutLead;

        const sortedByPresetScore = presetCandidates.slice().sort((a, b) => b.preset_score - a.preset_score);
        presetWinner = sortedByPresetScore.length > 0 ? sortedByPresetScore[0] : null;
        presetWinnerId = presetWinner?.item?.id ? String(presetWinner.item.id) : null;
      }
      
      console.debug("[Compare] preset winner selection", {
        preset: currentPreset,
        isBalladPreset: isBalladPreset,
        scoresCount: scores.length,
        leadId,
        presetWinnerId,
        presetWinnerTitle: presetWinner ? safeText(presetWinner.item.title, "Untitled") : null
      });

      // Album track selection (skip for ballad preset)
      let album = null;
      let albumId = null;
      if (!isBalladPreset) {
        const withoutLeadAndPreset = scores.filter((s) => {
          const sid = s?.item?.id ? String(s.item.id) : "";
          return sid !== leadId && sid !== presetWinnerId;
        });
        const sortedByCombined = withoutLeadAndPreset.slice().sort((a, b) => {
          const hitA = a.hit_score !== null ? a.hit_score : 0;
          const hitB = b.hit_score !== null ? b.hit_score : 0;
          const combinedA = hitA + 0.5 * a.delta;
          const combinedB = hitB + 0.5 * b.delta;
          return combinedB - combinedA;
        });
        album = sortedByCombined.length > 0 ? sortedByCombined[0] : null;
        albumId = album?.item?.id ? String(album.item.id) : null;
      }

      console.debug("[Compare] ranks", { preset: currentPreset, leadId, presetWinnerId, albumId });

      const ranked = [];
      if (lead) ranked.push(lead);
      if (presetWinner && presetWinnerId !== leadId) ranked.push(presetWinner);
      if (album && albumId !== leadId && albumId !== presetWinnerId) ranked.push(album);

      const addedIds = new Set(ranked.map((r) => r?.item?.id ? String(r.item.id) : ""));
      const remaining = scores.filter((s) => {
        const sid = s?.item?.id ? String(s.item.id) : "";
        return !addedIds.has(sid);
      });
      remaining.sort((a, b) => b.preset_score - a.preset_score);
      ranked.push(...remaining);

      const totalCount = scores.length;
      const shownCount = ranked.length;
      const filteredOut = totalCount - shownCount;
      const note = presetLabel + ": showing " + shownCount + " of " + totalCount + " songs" +
        (filteredOut > 0 ? (" (" + filteredOut + " filtered out)") : "");
      setFilterNote(note);

      const leadTitle = lead ? safeText(lead.item.title, "Untitled") : "—";
      const presetTitle = presetWinner ? safeText(presetWinner.item.title, "Untitled") : "—";
      const albumTitle = album ? safeText(album.item.title, "Untitled") : "—";

      if (elLead) {
        let presetLine = "";
        if (presetWinner && presetWinnerId !== leadId) {
          let followUpLabel = "Second pick";
          if (currentPreset === "ballad") {
            followUpLabel = "Second pick (Ballad lens)";
          }
          presetLine = "<div style=\"margin-bottom: 4px;\"><strong>" + followUpLabel + ":</strong> " + presetTitle + "</div>";
        } else if (currentPreset === "hit_single" && !presetWinner) {
          presetLine = "<div style=\"margin-bottom: 4px; color: #6b7280;\">No strong second pick candidate in this batch.</div>";
        } else if (currentPreset === "ballad" && !presetWinner) {
          presetLine = "<div style=\"margin-bottom: 4px; color: #6b7280;\">No second pick candidate in this batch.</div>";
        }
        elLead.innerHTML =
          "<div style=\"margin-bottom: 4px;\"><strong>Top pick:</strong> " + leadTitle + "</div>" +
          presetLine +
          (!isBalladPreset && album && albumId !== leadId && albumId !== presetWinnerId ?
            "<div><strong>Best album track:</strong> " + albumTitle + "</div>" : "");
      }

      const allIds = [leadId, presetWinnerId, albumId].filter((id) => id !== null);
      const hasDuplicates = new Set(allIds).size < allIds.length;

      if (hasDuplicates && scores.length <= 3) {
        if (elSummary) {
          elSummary.style.display = "block";
          elSummary.textContent = "Small set — some roles may overlap.";
        }
      } else {
        if (elSummary) {
          elSummary.style.display = "none";
          elSummary.textContent = "";
        }
      }

      if (!elList) return;

      ranked.forEach((r, idx) => {
        const item = r?.item || {};
        try {
          if (!window.__bcFirstItem) window.__bcFirstItem = item;
        } catch (_) {}
        const songId = item?.id || ("idx-" + idx);
        try {
          const card = el("div", "bc-card");

          let roleLabel = "";
          let roleTone = "neutral";
          let roleEmoji = "🎵";

          const sid = songId ? String(songId) : "";
          
          // Compute isWeakOrInvalid: only true for clearly bad/invalid songs
          const analysisStatus = item?.analysis_status;
          const hasFailedAnalysis = analysisStatus && String(analysisStatus).toLowerCase().includes("fail");
          const missingData = !item?.features_json && !item?.analysis_json;
          const hasNullHitScore = r?.hit_score === null || r?.hit_score === undefined;
          const hasVeryLowHitScore = r?.hit_score !== null && r?.hit_score !== undefined && r.hit_score < 0.05;
          const isWeakOrInvalid = hasFailedAnalysis || missingData || hasNullHitScore || hasVeryLowHitScore;
          
          if (sid === leadId) {
            roleLabel = "Top pick";
            roleTone = "lead";
            roleEmoji = "⭐";
          } else if (sid === presetWinnerId) {
            roleLabel = currentPreset === "ballad"
              ? "Second pick (Ballad lens)"
              : (PRESET_ROLE_LABEL[currentPreset] || "Second pick");
            roleTone = "preset";
            roleEmoji = "🎯";
          } else if (isWeakOrInvalid) {
            roleLabel = "Additional";
            roleTone = "neutral";
            roleEmoji = "🎵";
          } else {
            roleLabel = "Album track";
            roleTone = "album";
            roleEmoji = "💿";
          }

          const roleRow = el("div", "bc-role-row");
          roleRow.appendChild(el("span", "bc-badge bc-badge-" + roleTone, roleEmoji + " " + roleLabel));
          card.appendChild(roleRow);

          card.appendChild(el("div", "bc-song-title", safeText(item.title, "Untitled")));

          const bestSeg = getBestSegment(item);
          const segmentLabel = bestSeg?.label ? s(bestSeg.label) : s(getBestMatchCategory(item));
          const hookTiming = getHookTiming(item);
          const momentRange = getBestMomentRange(item) || "";
          const decisionSummary = getDecisionSummary(item);
          const roleClause = getRoleClause(roleLabel);
          const scoreClause = getScoreClause({
            isLead: sid === leadId,
            isPresetWinner: sid === presetWinnerId,
            isAlbum: sid === albumId,
            isBalladPreset: isBalladPreset
          });
          const hookConf = hookTiming?.confidence ? (" (" + hookTiming.confidence + ")") : "";
          const reasonText = buildRoleReason(item, currentPreset, roleLabel, {
            presetLabel,
            momentRange,
            segmentLabel,
            hookBucket: hookTiming?.bucket || "",
            hookConf,
            decisionSummary,
            scoreClause,
            roleClause
          });
          card.appendChild(el("div", "bc-reason", reasonText));

          const ctx = getBestMatchCategory(item) || "—";
          card.appendChild(el("div", "bc-row", "Best performance relative to: " + ctx));
          appendSegmentInfo(card, item, showDebug);

          const scoreRow = el("div", "bc-score-row");
          const presetScore = r?.preset_score !== null && r?.preset_score !== undefined ? r.preset_score : 0;
          // r.hit_score is 0-1 from tuned.hit_score, convert to batch-relative display value
          const hitScoreRaw = r?.hit_score !== null && r?.hit_score !== undefined ? r.hit_score : null;
          const dispPct = getHitScoreForDisplay(hitScoreRaw, r);
          const delta = r?.delta !== null && r?.delta !== undefined ? r.delta : 0;

          const hitScoreText = dispPct === null ? "—" : dispPct.toFixed(1) + "%";
          const colorClass = getHitScoreColorClass(dispPct);
          const hitScoreTextColored = dispPct !== null
            ? `<span class="${colorClass}" style="font-variant-numeric:tabular-nums;">${hitScoreText}</span>`
            : hitScoreText;
          const presetScoreText = formatPercent01(presetScore);
          const showDelta = showDebug;
          const deltaPP = delta * 100;
          const deltaText = deltaPP >= 0 ? ("+" + deltaPP.toFixed(1)) : deltaPP.toFixed(1);
          const deltaColor = delta >= 0 ? "#059669" : "#dc2626";

              scoreRow.innerHTML =
                "<span style=\"font-size: 12px; color: #374151;\">Hit score: <strong>" + hitScoreTextColored + "</strong></span> " +
                "<span style=\"font-size: 12px; color: #6b7280; margin-left: 8px;\">" + getPresetScoreLabel(currentPreset) + ": " + presetScoreText + "</span>" +
                (showDelta ? (" <span style=\"font-size: 12px; color: " + deltaColor + "; margin-left: 8px;\">Δ " + deltaText + " pp</span>") : "");
          card.appendChild(scoreRow);

          const playRow = el("div", "bc-play-row");
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "bc-play-btn";
          btn.textContent = "▶ Play";
          btn.setAttribute("aria-pressed", "false");

          const url = item?.audio_url ? String(item.audio_url) : "";
          if (!url) {
            btn.disabled = true;
            btn.textContent = "Play unavailable";
          } else {
            btn.addEventListener("click", async function () {
              try {
                if (activeSongId === songId && !player.paused) {
                  player.pause();
                  resetPlaybackUI();
                  return;
                }

                player.pause();
                if (player.src !== url) player.src = url;

                setActive(card, btn, songId);
                await player.play();
              } catch (e) {
                resetPlaybackUI();
                console.error("[BatchCompare] playback failed:", e);
              }
            });
          }

          playRow.appendChild(btn);
          card.appendChild(playRow);

          const genreTags = getGenreTags(item);
          if (genreTags.length > 0) {
            const wrap = el("div", "bc-genre-wrap");

            const tbtn = document.createElement("button");
            tbtn.type = "button";
            tbtn.className = "bc-toggle";
            tbtn.textContent = "Primary genre signals";

            const body = el("div", "bc-genre-body");
            body.style.display = "none";

            const list = el("div", "bc-genre-list");
            genreTags.slice(0, 5).forEach((tag) => {
              const row = el("div", "bc-genre-item");
              row.appendChild(el("span", "bc-genre-name", tag.name));
              const prob = (tag.probability === null) ? "—" : formatPercent01(tag.probability);
              row.appendChild(el("span", "bc-genre-score", prob));
              list.appendChild(row);
            });
            body.appendChild(list);

            tbtn.addEventListener("click", function () {
              const open = body.style.display !== "none";
              body.style.display = open ? "none" : "block";
              tbtn.textContent = open ? "Primary genre signals" : "Hide genre signals";
            });

            wrap.appendChild(tbtn);
            wrap.appendChild(body);
            card.appendChild(wrap);
          }

          appendSpotifyPitch(card, item);

          elList.appendChild(card);
        } catch (e) {
          console.error("[Batch Compare] card render failed", item?.id, e);
          if (elList) elList.appendChild(renderFallbackCard(item, songId, r?.hit_score ?? null));
        }
      });

      player.onended = function () { resetPlaybackUI(); };

      const leadObj = lead ? { id: leadId, title: safeText(lead.item.title, "Untitled"), preset_score: lead.preset_score, hit_score: lead.hit_score, delta: lead.delta } : null;
      const presetObj = presetWinner ? { id: presetWinnerId, title: safeText(presetWinner.item.title, "Untitled"), preset_score: presetWinner.preset_score, hit_score: presetWinner.hit_score, delta: presetWinner.delta } : null;
      const albumObj = album ? { id: albumId, title: safeText(album.item.title, "Untitled"), preset_score: album.preset_score, hit_score: album.hit_score, delta: album.delta } : null;
      console.debug("[Batch Compare] scores", { preset: currentPreset, lead: leadObj, presetWinner: presetObj, album: albumObj });

      lastGoodScores = ranked.map((r) => {
        const item = r.item;
        const fj = item && item.features_json && typeof item.features_json === "object" ? item.features_json : null;
        const cyanite = fj && fj.cyanite && typeof fj.cyanite === "object" ? fj.cyanite : null;
        const songDesc = cyanite && cyanite.song_description ? String(cyanite.song_description) : null;
        const cyaniteDesc = songDesc ? (songDesc.length > 80 ? songDesc.substring(0, 80) + "..." : songDesc) : null;
        
        return {
          id: r?.item?.id ? String(r.item.id) : "",
          title: safeText(r?.item?.title, "Untitled"),
          hit_score: r?.hit_score !== null && r?.hit_score !== undefined ? Number(r.hit_score) : null,
          preset_score: Number(r?.preset_score || 0),
          delta: Number(r?.delta || 0),
          tuned_score_raw: (r?.tuned_score_raw === null || r?.tuned_score_raw === undefined) ? null : Number(r.tuned_score_raw),
          preset_used: r?.preset_used ? String(r.preset_used) : String(currentPreset || "hit_single"),
          isFallback: r?.isFallback === true,
          cyanite_desc: cyaniteDesc || null,
          batchMinPct: r?.batchMinPct,
          batchMaxPct: r?.batchMaxPct
        };
      });
      try { window.__batchCompareLastGoodScores = lastGoodScores; } catch (_) {}

      if (elScoreDetails && elScoreTable) {
        elScoreDetails.style.display = showDebug ? "block" : "none";
        const rows = lastGoodScores.slice();
        const table = document.createElement("table");
        table.style.width = "100%";
        table.style.borderCollapse = "collapse";
        table.innerHTML = "";

        const thead = document.createElement("thead");
        thead.innerHTML = "<tr><th style=\"text-align:left;padding:8px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#374151;\">Song</th><th style=\"text-align:left;padding:8px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#374151;\">preset_used</th><th style=\"text-align:right;padding:8px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#374151;\">hit_score</th><th style=\"text-align:right;padding:8px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#374151;\">preset_score</th><th style=\"text-align:right;padding:8px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#374151;\">delta</th><th style=\"text-align:left;padding:8px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#374151;\">cyanite_desc</th></tr>";
        table.appendChild(thead);

        const tbody = document.createElement("tbody");
        rows.forEach((r) => {
          const tr = document.createElement("tr");
          const name = (r.isFallback ? (r.title + " (fallback)") : r.title);
          const cyaniteDescText = r.cyanite_desc ? String(r.cyanite_desc).replace(/</g, "&lt;").replace(/>/g, "&gt;") : "—";
          // r.hit_score is 0-1, convert to batch-relative display value
          const debugDispPct = getHitScoreForDisplay(r.hit_score, r);
          const debugHitScoreText = debugDispPct === null ? "—" : debugDispPct.toFixed(1) + "%";
          tr.innerHTML =
            "<td style=\"padding:8px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#111827;\">" + name.replace(/</g, "&lt;") + "</td>" +
            "<td style=\"padding:8px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#111827;\">" + String(r.preset_used || "").replace(/</g, "&lt;") + "</td>" +
            "<td style=\"padding:8px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#111827;text-align:right;\">" + debugHitScoreText + "</td>" +
            "<td style=\"padding:8px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#111827;text-align:right;\">" + formatPercent01(r.preset_score) + "</td>" +
            "<td style=\"padding:8px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#111827;text-align:right;\">" + (r.delta !== null && r.delta !== undefined ? (r.delta >= 0 ? "+" : "") + r.delta.toFixed(3) : "—") + "</td>" +
            "<td style=\"padding:8px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#111827;\">" + cyaniteDescText + "</td>";
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);

        elScoreTable.innerHTML = "";
        elScoreTable.appendChild(table);
      }
    }

    async function fetchBatch(batchId) {
      const token = getSupabaseAccessTokenFromLocalStorage();
      if (!token) {
        showError("You must be logged in to view this batch.");
        throw new Error("NO_AUTH");
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

      const url = API_BASE + "/batch/" + encodeURIComponent(batchId);
      console.debug("[Batch Compare] Fetching batch", { batchId, url, hasToken: !!token });

      const res = await fetch(url, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      console.debug("[Batch Compare] Batch fetch response", { status: res.status, ok: res.ok });

      if (res.status === 401) {
        showError("You must be logged in to view this batch.");
        throw new Error("UNAUTHORIZED");
      }

      if (!res.ok) {
        const text = await res.text().catch((_) => "");
        console.error("[Batch Compare] Batch fetch failed", { status: res.status, text: text.substring(0, 200) });
        throw new Error(`HTTP_${res.status}`);
      }

      const data = await res.json();
      console.debug("[Batch Compare] Batch fetch success", { itemsCount: data?.items?.length || 0 });
      return data;
    }

    async function uploadOne(file) {
      const fd = new FormData();
      fd.append("file", file, file.name);

      const res = await fetch(API_BASE + "/upload", { method: "POST", body: fd });

      if (!res.ok) {
        const text = await res.text().catch((_) => "");
        throw new Error("Upload failed: HTTP " + res.status + (text ? (": " + text) : ""));
      }
      const data = await res.json();
      if (!data || !data.audio_url) throw new Error("Upload failed: missing audio_url");
      return data.audio_url;
    }

    async function pipelineOne(title, audioUrl, token) {
      const res = await fetch(API_BASE + "/pipeline", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          title: title,
          artist: null,
          audio_url: audioUrl,
          force_rescore: false,
          force_reanalyze: false
        })
      });

      if (!res.ok) {
        const text = await res.text().catch((_) => "");
        throw new Error("Pipeline failed: HTTP " + res.status + (text ? (": " + text) : ""));
      }
      const data = await res.json();
      if (!data || !data.song_id) throw new Error("Pipeline failed: missing song_id");
      return data.song_id;
    }

    async function tagBatch(batchId, songIds, token) {
      const res = await fetch(API_BASE + "/batch/tag", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ batch_id: batchId, song_ids: songIds })
      });

      if (!res.ok) {
        const text = await res.text().catch((_) => "");
        throw new Error("Batch tag failed: HTTP " + res.status + (text ? (": " + text) : ""));
      }
      return await res.json();
    }

    function runWithConcurrencyLimit(tasks, limit) {
      if (!tasks || tasks.length === 0) return Promise.resolve();
      limit = Math.max(1, Math.min(limit, tasks.length));
      let index = 0;
      function runNext() {
        if (index >= tasks.length) return Promise.resolve();
        const i = index++;
        const task = tasks[i];
        return Promise.resolve(task()).then(() => runNext());
      }
      const workers = Array.from({ length: limit }, () => runNext());
      return Promise.all(workers);
    }

    function fetchOpenAIAnalyzeWithRetry(songId, token, maxRetries) {
      maxRetries = maxRetries != null ? maxRetries : 3;
      const url = API_BASE + "/sidecar/openai/analyze";
      const body = JSON.stringify({
        song_id: songId,
        force: true,
        listen: true,
        max_seconds: 300
      });
      const headers = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = "Bearer " + token;
      function attempt(retryCount) {
        return fetch(url, {
          method: "POST",
          headers: headers,
          credentials: "include",
          body: body
        }).then(function (res) {
          if (res.status === 502 || res.status === 503 || res.status === 504) {
            if (retryCount >= maxRetries) return Promise.reject(new Error("HTTP " + res.status));
            const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
            return new Promise(function (r) { setTimeout(r, delay); }).then(function () {
              return attempt(retryCount + 1);
            });
          }
          if (!res.ok) return Promise.reject(new Error("HTTP " + res.status));
          return res.json();
        });
      }
      return attempt(0);
    }

    function triggerOpenAIListenBackground(songIds, token, onDone) {
      if (!songIds || songIds.length === 0) return;
      const total = songIds.length;
      let done = 0;
      console.log("[BatchCompare] OpenAI listen start", { n: songIds.length, hasToken: !!token });
      setProgress("OpenAI listen: 0/" + total);
      const tasks = songIds.map(function (sid) {
        return function () {
          return fetchOpenAIAnalyzeWithRetry(sid, token).then(
            function (res) {
              done++;
              setProgress("OpenAI listen: " + done + "/" + total);
              var okOrError = "ok";
              console.log("[BatchCompare] OpenAI listen done", sid, okOrError);
            },
            function (err) {
              done++;
              setProgress("OpenAI listen: " + done + "/" + total);
              var okOrError = (err && err.message) ? err.message : "error";
              console.log("[BatchCompare] OpenAI listen done", sid, okOrError);
            }
          );
        };
      });
      runWithConcurrencyLimit(tasks, 2).then(
        function () {
          setProgress("OpenAI listen: done (" + total + "/" + total + ")");
          if (typeof onDone === "function") {
            try { onDone(); } catch (e) {}
          }
          setTimeout(function () { setProgress(""); }, 3000);
        },
        function () {
          setProgress("OpenAI listen: done (" + total + "/" + total + ")");
          if (typeof onDone === "function") {
            try { onDone(); } catch (e) {}
          }
          setTimeout(function () { setProgress(""); }, 3000);
        }
      );      

    }

    function baseTitleFromFilename(name) {
      const s = String(name || "Untitled");
      return s.replace(/\.[^/.]+$/, "").trim() || "Untitled";
    }

    async function handleStartBatch(token) {
      const files = selectedFiles.slice();

      if (files.length < 3) {
        setMsg("Upload at least 3 songs to compare.");
        renderSelectedFilesList();
        return;
      }
      if (files.length > 10) {
        setMsg("Max 10 songs per batch.");
        renderSelectedFilesList();
        return;
      }

      if (elStart) elStart.disabled = true;
      if (elReset) elReset.disabled = true;
      if (elFiles) elFiles.disabled = true;

      setMsg("");
      setProgress("Preparing…");
      setMsg("Preparing…");

      const batchId = uuidv4();
      const songIds = [];

      try {
        for (let i = 0; i < files.length; i++) {
          const uploadMsg = "Uploading " + (i + 1) + "/" + files.length + "…";
          setProgress(uploadMsg);
          setMsg(uploadMsg);

          const audioUrl = await uploadOne(files[i]);

          const analyzeMsg = "Analyzing " + (i + 1) + "/" + files.length + "…";
          setProgress(analyzeMsg);
          setMsg(analyzeMsg);

          const title = baseTitleFromFilename(files[i].name);
          const songId = await pipelineOne(title, audioUrl, token);
          songIds.push(songId);
        }

        const prepMsg = "Preparing comparison…";
        setProgress(prepMsg);
        setMsg(prepMsg);

        await tagBatch(batchId, songIds, token);

        window.location.href = "/batch-compare?batch_id=" + encodeURIComponent(batchId);
      } catch (e) {
        console.error("[BatchCompare] batch failed:", e);
        setMsg("Something went wrong. Please try again.");
        setProgress("");
        if (elStart) elStart.disabled = false;
        if (elReset) elReset.disabled = false;
        if (elFiles) elFiles.disabled = false;
        renderSelectedFilesList();
      }
    }

    function resetSelection() {
      selectedFiles = [];
      if (elFiles) {
        try { elFiles.value = ""; } catch (_) {}
        elFiles.disabled = false;
      }
      setMsg("");
      setProgress("");
      if (elReset) elReset.disabled = false;
      renderSelectedFilesList();
    }

    async function init() {
      showLoading();

      const session = await findSupabaseSessionWithRetry(3, 500);
      if (!session || !session.access_token) {
        showError("Please log in to use batch compare.");
        return;
      }
      const token = session.access_token;
      const debugMode = qsDebug();

      const batchId = qsBatchId();

      if (!batchId) {
        showUploader();

        resetSelection();
        setMsg("Select at least 3 files.");

        if (elFiles) {
          elFiles.addEventListener("change", function () {
            addFilesFromPicker(elFiles.files);
            try { elFiles.value = ""; } catch (_) {}
          });
        }

        if (elReset) {
          elReset.addEventListener("click", function () {
            resetSelection();
            setMsg("Select at least 3 files.");
          });
        }

        if (elStart) {
          elStart.addEventListener("click", function () { handleStartBatch(token); });
        }

        return;
      }

      showCompare();

      if (elNew) {
        elNew.addEventListener("click", function () {
          stopPlayback();
          window.location.href = "/batch-compare";
        });
      }

      const resolved = resolvePreset();
      currentPreset = resolved.preset || "hit_single";
      lastGoodPreset = currentPreset;
      if (resolved.source === "default") {
        const defaultLabel = PRESET_ROLE_LABEL[currentPreset] || "Second pick";
        setPresetNote("Preset defaulted to " + defaultLabel + ".");
      } else {
        setPresetNote("");
      }

      const loadAndRender = async (preset) => {
        const p = preset || "hit_single";
        try {
          const data = await fetchBatch(batchId);
          stopPlayback();
          await renderCompare(data.items || [], batchId, p);
          lastGoodItems = (data.items || []).slice();
          lastGoodPreset = p;
        } catch (e) {
          const errMsg = String(e?.message || e || "");
          if (errMsg === "NO_AUTH" || errMsg === "UNAUTHORIZED" || errMsg.includes("401")) {
            showError("You must be logged in to view this batch.");
          } else {
            console.error("[BatchCompare] load batch failed:", e);
            showError("Could not load this batch. Please try again." + (debugMode ? (" (" + errMsg + ")") : ""));
          }
          throw e;
        }
      };

      if (elStrategy) {
        elStrategy.value = currentPreset;
        elStrategy.addEventListener("change", async function () {
          const newPreset = elStrategy.value || "hit_single";
          if (newPreset === currentPreset) return;

          currentPreset = newPreset;
          setPresetInUrl(newPreset);
          storePreset(newPreset);
          setPresetNote("");

          try {
            if (elSummary) {
              elSummary.style.display = "block";
              elSummary.textContent = "Updating recommendations…";
            }
            await loadAndRender(newPreset);
            if (elSummary) {
              elSummary.style.display = "none";
              elSummary.textContent = "";
            }
          } catch (e) {
            console.error("[BatchCompare] preset change failed:", e);
            if (elSummary) {
              elSummary.style.display = "block";
              elSummary.textContent = "Could not update preset. Please try again.";
            }
            currentPreset = lastGoodPreset || "hit_single";
            if (elStrategy) elStrategy.value = currentPreset;
            try {
              await renderCompare(lastGoodItems || currentItems, batchId, currentPreset);
            } catch (_) {}
          }
        });
      }

      try {
        setPresetInUrl(currentPreset);
        storePreset(currentPreset);
        await loadAndRender(currentPreset);
        var songIds = (lastGoodItems || []).map(function (i) { return i.song_id; }).filter(Boolean);
        if (!openAiListenTriggered) {
          openAiListenTriggered = true;
          if (songIds.length) {
            triggerOpenAIListenBackground(songIds, token, function () {
              loadAndRender(currentPreset);
            });
          }
        }
      } catch (e) {
        const errMsg = String(e?.message || e || "");
        if (errMsg === "NO_AUTH" || errMsg === "UNAUTHORIZED" || errMsg.includes("401")) {
          // Error already shown by loadAndRender
          return;
        }
        console.error("[BatchCompare] load batch failed:", e);
        showError("Could not load this batch. Please try again." + (debugMode ? (" (" + errMsg + ")") : ""));
      }
    }

    init();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initBatchCompare);
  } else {
    initBatchCompare();
  }
})();
