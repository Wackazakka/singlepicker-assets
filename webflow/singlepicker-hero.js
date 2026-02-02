(function () {
  "use strict";
  console.log("SP JS VERSION 2026-02-02-OAI");

  if (window.__TRACK_HERO_LOADED__) return;
  window.__TRACK_HERO_LOADED__ = true;

  function initTrackHero() {
    console.log("[Track Hero] init running");

    // Find container
    const container = document.getElementById("track-hero-v1") || document.querySelector("[data-track-hero]");
    if (!container) {
      console.warn("[Track Hero] Container not found");
      return;
    }

    const API_BASE = "https://rf-api-7vvq.onrender.com";

    // Get song_id from URL
    function getSongIdFromUrl() {
      try {
        const u = new URL(window.location.href);
        return u.searchParams.get("song_id");
      } catch (_) {
        return null;
      }
    }

    // Strict flag parser
    function parseFlag(v) {
      if (v === "1" || v === "true") return true;
      if (v === "0" || v === "false") return false;
      return null; // not present / invalid
    }

    // URL flags for lab/sidecar visibility (e.g. ?lab=1&force_sidecar=1)
    function isSidecarDebugEnabled() {
      try {
        const u = new URL(window.location.href);
        const lab = u.searchParams.get("lab");
        const force = u.searchParams.get("force_sidecar");
        return lab === "1" || parseFlag(force) === true;
      } catch (_) {
        return false;
      }
    }

    // Get Supabase access token
    function getSupabaseAccessTokenFromLocalStorage() {
      const exactKeys = [
        "sb-svvfyyxryrgkemlsvzip-auth-token",
        "sb-svvfyxxryrgkemlsvzip-auth-token"
      ];

      function safeJsonParse(s) {
        if (!s || typeof s !== "string") return null;
        try {
          return JSON.parse(s);
        } catch (_) {
          return null;
        }
      }

      function extractSessionFromParsed(parsed) {
        if (!parsed || typeof parsed !== "object") return null;
        const token = parsed?.access_token || parsed?.currentSession?.access_token || parsed?.session?.access_token;
        if (!token) return null;
        return String(token);
      }

      for (const key of exactKeys) {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = safeJsonParse(raw);
        const session = extractSessionFromParsed(parsed);
        if (session) return session;
      }

      // Fallback: search all localStorage keys
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith("sb-") || !key.endsWith("-auth-token")) continue;
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = safeJsonParse(raw);
        const session = extractSessionFromParsed(parsed);
        if (session) return session;
      }

      return null;
    }

    // Helper functions
    function el(tag, className, text) {
      const e = document.createElement(tag);
      if (className) e.className = className;
      if (text) e.textContent = text;
      return e;
    }

    function formatPercent(value) {
      if (value === null || value === undefined) return "—";
      const num = typeof value === "number" ? value : parseFloat(value);
      if (!isFinite(num)) return "—";
      return (num * 100).toFixed(1) + "%";
    }

    function formatPercent100(value) {
      if (value === null || value === undefined) return "—";
      const num = typeof value === "number" ? value : parseFloat(value);
      if (!isFinite(num)) return "—";
      return num.toFixed(1) + "%";
    }

    // UI elements
    const elLoading = container.querySelector("#th-loading");
    const elError = container.querySelector("#th-error");
    const elContent = container.querySelector("#th-content");

    function setState(state, message) {
      if (elLoading) elLoading.style.display = (state === "loading") ? "block" : "none";
      if (elError) {
        elError.style.display = (state === "error") ? "block" : "none";
        if (state === "error" && message) elError.textContent = message;
      }
      if (elContent) elContent.style.display = (state === "content") ? "block" : "none";
    }

    // Set initial state to loading
    setState("loading");

    // Sidecar toggle helpers
    const SIDECAR_STORAGE_KEY = "sp_use_sidecar";
    let currentMetaData = null; // Store current metadata for re-rendering
    
    function getUseSidecar() {
      const stored = localStorage.getItem(SIDECAR_STORAGE_KEY);
      if (stored === null) return true; // Default ON
      if (stored === "0") return false;
      return stored === "1" || stored === "true"; // "1" or legacy "true"
    }

    // OpenAI judge toggle: URL ?force_oai=0/1 → localStorage["sp_use_oai"] → default OFF
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
    
    function setUseSidecar(value) {
      localStorage.setItem(SIDECAR_STORAGE_KEY, value ? "1" : "0"); // Single source of truth for Batch + Track
    }

    // Fetch song metadata
    async function fetchSongMeta(songId) {
      const token = getSupabaseAccessTokenFromLocalStorage();
      if (!token) {
        throw new Error("Not authenticated. Please log in.");
      }

      const res = await fetch(API_BASE + "/song/meta?song_id=" + encodeURIComponent(songId), {
        method: "GET",
        headers: {
          "Authorization": "Bearer " + token,
          "Content-Type": "application/json"
        }
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${text ? ": " + text.substring(0, 200) : ""}`);
      }

      return await res.json();
    }

    // Determine use_sidecar from URL or checkbox
    function resolveUseSidecar(checkbox) {
      try {
        const params = new URLSearchParams(window.location.search);
        const forced = parseFlag(params.get("force_sidecar"));
        
        if (forced !== null) {
          return forced; // URL override
        } else {
          return checkbox ? checkbox.checked : getUseSidecar(); // UI state or localStorage
        }
      } catch (_) {
        return getUseSidecar(); // Fallback to localStorage
      }
    }

    // Fetch tuning score
    async function fetchTuningScore(songId, checkbox = null) {
      const token = getSupabaseAccessTokenFromLocalStorage();
      if (!token) {
        throw new Error("Not authenticated. Please log in.");
      }

      // Resolve use_sidecar: URL param > checkbox > localStorage
      const useSidecar = resolveUseSidecar(checkbox);

      let preset = "hit_single";
      try {
        const p = new URL(window.location.href).searchParams.get("preset");
        if (p != null) preset = (String(p).split("?")[0].trim() || "hit_single");
      } catch (_) {}

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
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${text ? ": " + text.substring(0, 200) : ""}`);
      }

      const scoreData = await res.json();

      // Debug logging when lab=1
      try {
        const params = new URLSearchParams(window.location.search);
        if (params.get("lab") === "1") {
          const forced = parseFlag(params.get("force_sidecar"));
          console.log("[sidecar-debug]", {
            forced,
            requested_use_sidecar: useSidecar,
            applied: scoreData?.beats_policy?.applied,
            single_score: scoreData?.single_score
          });
        }
      } catch (_) {
        // Ignore debug logging errors
      }

      return scoreData;
    }

    // Render track hero
    function renderTrackHero(scoreData, metaData) {
      if (!elContent) return;

      // Always hide loading and show content when rendering
      if (elLoading) elLoading.style.display = "none";
      if (elContent) elContent.style.display = "block";
      if (elError) elError.style.display = "none";

      elContent.innerHTML = "";

      // Title: use metaData.title if available, fallback to song_id
      const title = metaData?.title || scoreData?.song_id || "Untitled";
      const titleEl = el("h1", "th-title", title);
      elContent.appendChild(titleEl);

      // Artist (optional, shown under title if available)
      if (metaData?.artist) {
        const artistEl = el("div", "th-artist", metaData.artist);
        artistEl.style.fontSize = "14px";
        artistEl.style.color = "#6b7280";
        artistEl.style.marginTop = "4px";
        elContent.appendChild(artistEl);
      }

      // Badge: decision_band
      if (scoreData.decision_band) {
        const badgeEl = el("div", "th-badge", scoreData.decision_band);
        elContent.appendChild(badgeEl);
      }

      // Scores section
      const scoresEl = el("div", "th-scores");

      // Tuned score (main)
      const tunedScoreEl = el("div", "th-tuned-score");
      const tunedScoreValue = formatPercent(scoreData.tuned_score);
      tunedScoreEl.appendChild(el("div", "th-score-label", "Tuned Score"));
      tunedScoreEl.appendChild(el("div", "th-score-value", tunedScoreValue));
      scoresEl.appendChild(tunedScoreEl);

      // Single score and release score
      if (scoreData.single_score !== null && scoreData.single_score !== undefined) {
        const singleScoreEl = el("div", "th-score-row");
        singleScoreEl.appendChild(el("span", "th-score-label-small", "Single Score:"));
        singleScoreEl.appendChild(el("span", "th-score-value-small", formatPercent100(scoreData.single_score)));
        scoresEl.appendChild(singleScoreEl);
      }

      if (scoreData.release_score !== null && scoreData.release_score !== undefined) {
        const releaseScoreEl = el("div", "th-score-row");
        releaseScoreEl.appendChild(el("span", "th-score-label-small", "Release Score:"));
        releaseScoreEl.appendChild(el("span", "th-score-value-small", formatPercent100(scoreData.release_score)));
        scoresEl.appendChild(releaseScoreEl);
      }

      elContent.appendChild(scoresEl);

      // Reasons (all reasons from backend, including sidecar)
      const reasons = scoreData.reasons_ui || [];
      if (reasons.length > 0) {
        const reasonsEl = el("div", "th-reasons");
        const reasonsTitle = el("div", "th-reasons-title", "Reasons:");
        reasonsEl.appendChild(reasonsTitle);

        const reasonsList = el("ul", "th-reasons-list");
        reasons.forEach((reason) => {
          if (!reason) return;
          const text = reason.label || reason.msg || reason.text || reason.code || String(reason);
          if (text) {
            const li = el("li", "th-reason-item", text);
            reasonsList.appendChild(li);
          }
        });
        reasonsEl.appendChild(reasonsList);
        elContent.appendChild(reasonsEl);
      }

      // Sidecar / BEATs debug panel (only when lab=1 or force_sidecar=1)
      const beats = scoreData.beats_policy || null;
      const showSidecarBlock = isSidecarDebugEnabled() && beats && beats.applied;
      if (showSidecarBlock) {
        const sidecarEl = el("div", "th-sidecar-panel");

        const header = el("div", "th-sidecar-header", "Sidecar (BEATs)");
        sidecarEl.appendChild(header);

        const meta = el("div", "th-sidecar-meta");
        const mode = beats.mode || "annotate";
        const ctx = beats.is_instant_context ? "instant" : "non-instant";
        const triggersArr = Array.isArray(beats.triggers) ? beats.triggers : [];
        const triggersText = triggersArr.length ? triggersArr.join(", ") : "—";
        const deltas = beats.deltas_applied || {};
        const dSingle = typeof deltas.single === "number" ? deltas.single.toFixed(3) : "0.000";
        const dRelease = typeof deltas.release === "number" ? deltas.release.toFixed(3) : "0.000";
        const version = beats.sidecar_version || "";

        meta.innerHTML =
          `<div><span class="th-sidecar-label">mode:</span> <span class="th-sidecar-value">${mode}</span></div>` +
          `<div><span class="th-sidecar-label">instant context:</span> <span class="th-sidecar-value">${ctx}</span></div>` +
          `<div><span class="th-sidecar-label">triggers:</span> <span class="th-sidecar-value">${triggersText}</span></div>` +
          `<div><span class="th-sidecar-label">Δ single:</span> <span class="th-sidecar-value">${dSingle}</span></div>` +
          `<div><span class="th-sidecar-label">Δ release:</span> <span class="th-sidecar-value">${dRelease}</span></div>` +
          (version ? `<div><span class="th-sidecar-label">version:</span> <span class="th-sidecar-value">${version}</span></div>` : "");

        sidecarEl.appendChild(meta);

        // BEATs-specific reasons (codes starting with SIDECAR_)
        const sidecarReasons = reasons.filter((r) => {
          const code = r && typeof r.code === "string" ? r.code : "";
          return code.startsWith("SIDECAR_");
        });

        if (sidecarReasons.length > 0) {
          const reasonsTitle = el("div", "th-sidecar-reasons-title", "Sidecar reasons:");
          sidecarEl.appendChild(reasonsTitle);

          const list = el("ul", "th-sidecar-reasons-list");
          sidecarReasons.forEach((r) => {
            const text = r.label || r.msg || r.text || r.code || String(r);
            if (!text) return;
            const li = el("li", "th-sidecar-reason-item", text);
            list.appendChild(li);
          });
          sidecarEl.appendChild(list);
        }

        elContent.appendChild(sidecarEl);
      }

      // Sidecar toggle and status
      const sidecarContainer = el("div", "th-sidecar-container");
      sidecarContainer.style.marginTop = "16px";
      sidecarContainer.style.fontSize = "12px";
      
      // Toggle
      const toggleLabel = el("label", "th-sidecar-toggle");
      toggleLabel.style.display = "flex";
      toggleLabel.style.alignItems = "center";
      toggleLabel.style.gap = "8px";
      toggleLabel.style.cursor = "pointer";
      
      const toggleCheckbox = el("input", "");
      toggleCheckbox.type = "checkbox";
      // Initialize checkbox: URL override (force_sidecar) → else localStorage (sp_use_sidecar) → else default true
      toggleCheckbox.checked = resolveUseSidecar(null);
      toggleCheckbox.style.cursor = "pointer";
      
      const toggleText = el("span", "");
      toggleText.textContent = "Use sidecar";
      toggleText.style.userSelect = "none";
      
      toggleLabel.appendChild(toggleCheckbox);
      toggleLabel.appendChild(toggleText);
      
      // Status text
      const statusText = el("span", "th-sidecar-status");
      const useSidecar = resolveUseSidecar(toggleCheckbox);
      if (!useSidecar) {
        statusText.textContent = "Sidecar: OFF (not applied)";
        statusText.style.color = "#9ca3af";
      } else if (scoreData.sidecar_signals_present !== undefined) {
        statusText.textContent = "Sidecar: " + (scoreData.sidecar_signals_present ? "ON" : "OFF");
        statusText.style.color = scoreData.sidecar_signals_present ? "#6b7280" : "#9ca3af";
      } else {
        statusText.textContent = "Sidecar: OFF";
        statusText.style.color = "#9ca3af";
      }
      statusText.style.marginLeft = "12px";
      
      // Toggle change handler
      toggleCheckbox.addEventListener("change", async (e) => {
        const newValue = e.target.checked;
        setUseSidecar(newValue); // persists to localStorage["sp_use_sidecar"] as "1"/"0"
        
        // Update URL parameter (do NOT remove param)
        try {
          const url = new URL(window.location.href);
          url.searchParams.set("force_sidecar", newValue ? "1" : "0");
          window.history.replaceState({}, "", url.toString());
        } catch (_) {
          // Ignore URL update errors
        }
        
        // Re-fetch tuning score with new setting (pass checkbox so resolveUseSidecar uses it)
        try {
          const songId = getSongIdFromUrl();
          if (songId) {
            const newScoreData = await fetchTuningScore(songId, toggleCheckbox);
            // Re-render with new data (use stored currentMetaData)
            renderTrackHero(newScoreData, currentMetaData);
          }
        } catch (err) {
          console.error("[Track Hero] Failed to re-fetch with new sidecar setting:", err);
          // Revert checkbox on error
          toggleCheckbox.checked = !newValue;
          setUseSidecar(!newValue);
        }
      });
      
      sidecarContainer.appendChild(toggleLabel);
      sidecarContainer.appendChild(statusText);
      elContent.appendChild(sidecarContainer);
    }

    // Use OpenAI Judge checkbox (id: sp_use_oai_checkbox – added in Webflow)
    const oaiCheckbox = document.getElementById("sp_use_oai_checkbox");
    if (oaiCheckbox) {
      oaiCheckbox.checked = resolveUseOai();
      if (!oaiCheckbox.dataset.oaiWired) {
        oaiCheckbox.dataset.oaiWired = "1";
        oaiCheckbox.addEventListener("change", function () {
          localStorage.setItem("sp_use_oai", oaiCheckbox.checked ? "1" : "0");
          const songId = getSongIdFromUrl();
          if (songId) {
            fetchTuningScore(songId).then(function (newScoreData) {
              renderTrackHero(newScoreData, currentMetaData);
            }).catch(function (err) {
              console.error("[Track Hero] Failed to re-fetch with new OpenAI setting:", err);
            });
          }
        });
      }
    }

    // Main load function
    async function load() {
      try {
        setState("loading");

        const songId = getSongIdFromUrl();
        if (!songId) {
          setState("error", "Missing song_id in URL. Please add ?song_id=<uuid> to the URL.");
          return;
        }

        // Fetch metadata first (title, artist)
        currentMetaData = null;
        try {
          currentMetaData = await fetchSongMeta(songId);
          if (!currentMetaData || !currentMetaData.ok) {
            console.warn("[Track Hero] Metadata fetch failed, continuing with song_id");
          }
        } catch (e) {
          console.warn("[Track Hero] Metadata fetch error:", e);
          // Continue without metadata, will use song_id as fallback
        }

        // Fetch tuning score
        const scoreData = await fetchTuningScore(songId);
        if (!scoreData || !scoreData.ok) {
          setState("error", scoreData?.error || "Failed to load track data");
          return;
        }

        renderTrackHero(scoreData, currentMetaData);
        setState("content");
      } catch (e) {
        console.error("[Track Hero] Load failed:", e);
        setState("error", "Failed to load track: " + (e.message || String(e)));
      }
    }

    // Initialize
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", load);
    } else {
      load();
    }
  }

  // Safe initialization
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initTrackHero);
  } else {
    initTrackHero();
  }
})();
