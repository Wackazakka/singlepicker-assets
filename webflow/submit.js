(function () {
  "use strict";
  const BUILD_TAG = "2025-02-06";
  console.log("[submit] build", BUILD_TAG);

  const API_BASE = "https://rf-api-7vvq.onrender.com";
  const SP_BATCH_STORAGE_KEY = "sp_active_batch_id";
  const SP_RUN_IDEM_KEY = "sp_run_idem_key";

  function getActiveBatchId() {
    try {
      const id = localStorage.getItem(SP_BATCH_STORAGE_KEY);
      return id && String(id).trim() ? String(id).trim() : null;
    } catch (_) { return null; }
  }
  function setActiveBatchId(id) {
    try {
      if (id == null || id === "") localStorage.removeItem(SP_BATCH_STORAGE_KEY);
      else localStorage.setItem(SP_BATCH_STORAGE_KEY, String(id));
    } catch (_) {}
  }
  function clearActiveBatchId() {
    try { localStorage.removeItem(SP_BATCH_STORAGE_KEY); } catch (_) {}
  }

  function handleApiErrorForBatch(res, bodyText) {
    const status = res.status;
    let msg = "";
    let clearBatch = false;
    let data = null;
    try { data = bodyText ? JSON.parse(bodyText) : null; } catch (_) {}
    if (status === 401 || (bodyText && String(bodyText).includes("JWT expired"))) {
      msg = "Session expired. Please log in again.";
      clearBatch = true;
    } else if (status === 402) {
      const code = (data && (data.error || data.code || data.detail));
      if (String(code).indexOf("INSUFFICIENT_CREDITS") !== -1 || status === 402) {
        msg = "Insufficient credits. Please top up.";
      } else { msg = "Payment error. Please try again."; }
    } else if (status === 403) {
      const code = (data && (data.error || data.code || (data.detail && String(data.detail)))) || "";
      if (String(code).indexOf("BATCH_NOT_OWNED") !== -1) {
        msg = "Batch session invalid. Please start a new compare.";
        clearBatch = true;
      } else { msg = "Access denied. Please try again."; }
    } else if (status === 422) {
      msg = "Internal request missing fields (batch_id/title). Please refresh and try again.";
      console.error("sp validation error", bodyText || data);
    } else {
      msg = "Request failed. Please try again.";
    }
    if (clearBatch) clearActiveBatchId();
    setDebug(msg);
    throw new Error(msg);
  }

  function getSupabaseToken() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith("sb-") || !key.endsWith("-auth-token")) continue;
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        const token = parsed && (parsed.access_token || parsed.currentSession?.access_token || parsed.session?.access_token);
        if (token) return String(token);
      }
    } catch (_) {}
    return "";
  }

  function setDebug(msg) {
    const el = document.getElementById("sp-debug");
    if (el) {
      el.textContent = msg || "";
      el.style.display = msg ? "block" : "none";
    }
  }

  function setCountText(n) {
    const el = document.getElementById("sp-count");
    if (!el) return;
    if (n === 0) el.textContent = "Choose 3–10 files to upload.";
    else if (n === 1) el.textContent = "Add 2 more files to analyze (minimum is 3).";
    else if (n === 2) el.textContent = "Add 1 more file to analyze (minimum is 3).";
    else if (n >= 3 && n <= 10) el.textContent = "Ready. You can still add more files (up to 10).";
    else el.textContent = "Choose 3–10 files to upload.";
  }

  function baseTitleFromFilename(name) {
    const s = String(name || "Untitled");
    return s.replace(/\.[^/.]+$/, "").trim() || "Untitled";
  }

  function uuidv4() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  let selectedFiles = [];
  let sameArtistForAll = true;
  let elSameArtistCheckbox = null;
  let elArtistWrap = null;

  function getArtistForIndex(i) {
    if (sameArtistForAll) {
      const el = document.getElementById("sp-artist");
      return el ? String(el.value || "").trim() : "";
    }
    const item = selectedFiles[i];
    return item && item.artist != null ? String(item.artist).trim() : "";
  }

  function renderFileList() {
    const list = document.getElementById("sp-file-list");
    const pickBtn = document.getElementById("sp-pick-btn");
    const uploadBtn = document.getElementById("sp-upload-btn");
    if (pickBtn) pickBtn.textContent = selectedFiles.length === 0 ? "Choose files" : "Add more files";
    if (uploadBtn) uploadBtn.disabled = selectedFiles.length < 3 || selectedFiles.length > 10;
    setCountText(selectedFiles.length);

    if (!list) return;
    list.innerHTML = "";
    if (selectedFiles.length === 0) return;

    selectedFiles.forEach(function (item, idx) {
      const row = document.createElement("div");
      row.className = "sp-file-row";
      const name = document.createElement("span");
      name.className = "sp-file-name";
      name.textContent = item.file.name || "Untitled";
      row.appendChild(name);

      if (!sameArtistForAll) {
        const artistInp = document.createElement("input");
        artistInp.type = "text";
        artistInp.placeholder = "Artist";
        artistInp.className = "sp-artist-per-file";
        artistInp.value = item.artist != null ? item.artist : "";
        artistInp.addEventListener("input", function () {
          item.artist = artistInp.value;
        });
        row.appendChild(artistInp);
      }

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "sp-file-remove";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", function () {
        selectedFiles.splice(idx, 1);
        renderFileList();
      });
      row.appendChild(removeBtn);
      list.appendChild(row);
    });
  }

  function injectArtistToggle() {
    const artistEl = document.getElementById("sp-artist");
    if (!artistEl || elSameArtistCheckbox) return;
    const parent = artistEl.parentNode;
    const wrap = document.createElement("div");
    wrap.className = "sp-artist-toggle-wrap";
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = sameArtistForAll;
    checkbox.className = "sp-same-artist-checkbox";
    checkbox.addEventListener("change", function () {
      sameArtistForAll = checkbox.checked;
      if (elArtistWrap) elArtistWrap.style.display = sameArtistForAll ? "block" : "none";
      renderFileList();
    });
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(" Same artist for all"));
    wrap.appendChild(label);
    parent.insertBefore(wrap, artistEl);
    elSameArtistCheckbox = checkbox;
    const artistWrap = document.createElement("div");
    artistWrap.className = "sp-artist-input-wrap";
    artistWrap.style.display = sameArtistForAll ? "block" : "none";
    parent.insertBefore(artistWrap, artistEl);
    artistWrap.appendChild(artistEl);
    elArtistWrap = artistWrap;
  }

  function onFileInputChange() {
    const input = document.getElementById("sp-file-input");
    if (!input || !input.files) return;
    const added = Array.from(input.files);
    const before = selectedFiles.length;
    for (let i = 0; i < added.length; i++) {
      if (selectedFiles.length >= 10) {
        setDebug("Max 10 files allowed. Extra files ignored.");
        break;
      }
      selectedFiles.push({ file: added[i], artist: "" });
    }
    if (selectedFiles.length > 10) {
      selectedFiles = selectedFiles.slice(0, 10);
      setDebug("Max 10 files. Extras ignored.");
    } else if (added.length && selectedFiles.length <= 10) {
      setDebug("");
    }
    renderFileList();
    try { input.value = ""; } catch (_) {}
  }

  async function uploadOne(file) {
    const fd = new FormData();
    fd.append("file", file, file.name);
    const res = await fetch(API_BASE + "/upload", { method: "POST", body: fd });
    if (!res.ok) {
      const text = await res.text().catch(function () { return ""; });
      throw new Error("Upload failed: HTTP " + res.status + (text ? ": " + text : ""));
    }
    const data = await res.json();
    if (!data || !data.audio_url) throw new Error("Upload failed: missing audio_url");
    return data.audio_url;
  }

  async function pipelineOne(title, audioUrl, token, artist, batchId) {
    const safeTitle = (title && String(title).trim()) ? String(title).trim() : "Untitled";
    if (!batchId) {
      setDebug("Batch session missing. Please start a new compare.");
      throw new Error("MISSING_BATCH_ID");
    }
    console.info("sp calling /pipeline with batch_id=", batchId);
    const res = await fetch(API_BASE + "/pipeline", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        batch_id: batchId,
        title: safeTitle,
        artist: artist != null && String(artist).trim() !== "" ? String(artist).trim() : null,
        audio_url: audioUrl,
        force_rescore: false,
        force_reanalyze: false
      })
    });
    const text = await res.text().catch(function () { return ""; });
    if (!res.ok) {
      if (res.status === 401 || res.status === 402 || res.status === 403 || res.status === 422) {
        handleApiErrorForBatch(res, text);
      }
      throw new Error("Pipeline failed: HTTP " + res.status + (text ? ": " + text : ""));
    }
    const data = text ? JSON.parse(text) : {};
    if (!data || !data.song_id) throw new Error("Pipeline failed: missing song_id");
    return data.song_id;
  }

  async function tagBatch(batchId, songIds, token) {
    if (!batchId) {
      setDebug("Batch session missing. Please start a new compare.");
      throw new Error("MISSING_BATCH_ID");
    }
    console.info("sp calling /batch/tag with batch_id=", batchId);
    const res = await fetch(API_BASE + "/batch/tag", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ batch_id: batchId, song_ids: songIds })
    });
    const text = await res.text().catch(function () { return ""; });
    if (!res.ok) {
      if (res.status === 401 || res.status === 402 || res.status === 403 || res.status === 422) {
        handleApiErrorForBatch(res, text);
      }
      throw new Error("Batch tag failed: HTTP " + res.status + (text ? ": " + text : ""));
    }
    const data = text ? JSON.parse(text) : {};
    console.log("[submit] tag_batch ok rows_written?", data);
    return data;
  }

  async function runSubmit() {
    const token = getSupabaseToken();
    if (!token) {
      setDebug("Please log in to submit.");
      return;
    }
    if (selectedFiles.length < 3) {
      setDebug("Select at least 3 files.");
      return;
    }
    if (selectedFiles.length > 10) {
      selectedFiles = selectedFiles.slice(0, 10);
    }

    let idemKey = null;
    try { idemKey = sessionStorage.getItem(SP_RUN_IDEM_KEY); } catch (_) {}
    if (!idemKey || !String(idemKey).trim()) {
      idemKey = "sp_run_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
      try { sessionStorage.setItem(SP_RUN_IDEM_KEY, idemKey); } catch (_) {}
    }

    const N = selectedFiles.length;
    console.info("sp batch-create track_count=", N);
    let batchId = null;
    const uploadBtn = document.getElementById("sp-upload-btn");
    const fileInput = document.getElementById("sp-file-input");
    const pickBtn = document.getElementById("sp-pick-btn");
    if (uploadBtn) uploadBtn.disabled = true;
    if (fileInput) fileInput.disabled = true;
    if (pickBtn) pickBtn.disabled = true;
    setDebug("Creating batch…");

    try {
      const createRes = await fetch(API_BASE + "/credits/batch-create", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ track_count: N, idempotency_key: idemKey })
      });
      const createText = await createRes.text().catch(function () { return ""; });
      if (!createRes.ok) {
        if (createRes.status === 401 || createRes.status === 402 || createRes.status === 403 || createRes.status === 422) {
          handleApiErrorForBatch(createRes, createText);
        }
        throw new Error("Batch create failed: HTTP " + createRes.status + (createText ? ": " + createText : ""));
      }
      const createData = createText ? JSON.parse(createText) : {};
      batchId = createData.batch_id || null;
      if (!batchId) {
        setDebug("Batch session invalid. Please start a new compare.");
        if (uploadBtn) uploadBtn.disabled = false;
        if (fileInput) fileInput.disabled = false;
        if (pickBtn) pickBtn.disabled = false;
        return;
      }
      console.info("sp batch_id=", batchId);
      setActiveBatchId(batchId);
    } catch (e) {
      console.error("[submit] batch-create error", e);
      setDebug(e && e.message ? e.message : "Could not start batch. Please try again.");
      try { sessionStorage.removeItem(SP_RUN_IDEM_KEY); } catch (_) {}
      if (uploadBtn) uploadBtn.disabled = false;
      if (fileInput) fileInput.disabled = false;
      if (pickBtn) pickBtn.disabled = false;
      return;
    }

    const songIds = [];
    setDebug("Uploading…");
    try {
      for (let i = 0; i < selectedFiles.length; i++) {
        setDebug("Uploading " + (i + 1) + "/" + selectedFiles.length + "…");
        const item = selectedFiles[i];
        const audioUrl = await uploadOne(item.file);
        setDebug("Analyzing " + (i + 1) + "/" + selectedFiles.length + "…");
        const title = baseTitleFromFilename(item.file.name);
        const artist = getArtistForIndex(i);
        const songId = await pipelineOne(title, audioUrl, token, artist || null, batchId);
        songIds.push(songId);
      }

      setDebug("Linking batch…");
      await tagBatch(batchId, songIds, token);

      try { sessionStorage.removeItem(SP_RUN_IDEM_KEY); } catch (_) {}
      const cachebust = Date.now();
      const url = "/batch-compare?batch_id=" + encodeURIComponent(batchId) + "&preset=hit_single&v=" + cachebust;
      window.location.href = url;
    } catch (e) {
      console.error("[submit] error", e);
      setDebug(e && e.message ? e.message : String(e));
      try { sessionStorage.removeItem(SP_RUN_IDEM_KEY); } catch (_) {}
      if (uploadBtn) uploadBtn.disabled = false;
      if (fileInput) fileInput.disabled = false;
      if (pickBtn) pickBtn.disabled = false;
    }
  }

  function init() {
    injectArtistToggle();

    const fileInput = document.getElementById("sp-file-input");
    if (fileInput) {
      fileInput.addEventListener("change", onFileInputChange);
    }

    const pickBtn = document.getElementById("sp-pick-btn");
    if (pickBtn) {
      pickBtn.textContent = "Choose files";
      pickBtn.addEventListener("click", function () {
        if (fileInput) fileInput.click();
      });
    }

    const uploadBtn = document.getElementById("sp-upload-btn");
    if (uploadBtn) {
      uploadBtn.addEventListener("click", runSubmit);
    }

    setCountText(0);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
