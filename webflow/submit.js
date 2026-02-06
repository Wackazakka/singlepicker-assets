(function () {
  "use strict";
  const BUILD_TAG = "2025-02-06";
  console.log("[submit] build", BUILD_TAG);

  const API_BASE = "https://rf-api-7vvq.onrender.com";

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

  async function pipelineOne(title, audioUrl, token, artist) {
    const res = await fetch(API_BASE + "/pipeline", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        title: title,
        artist: artist != null && String(artist).trim() !== "" ? String(artist).trim() : null,
        audio_url: audioUrl,
        force_rescore: false,
        force_reanalyze: false
      })
    });
    if (!res.ok) {
      const text = await res.text().catch(function () { return ""; });
      throw new Error("Pipeline failed: HTTP " + res.status + (text ? ": " + text : ""));
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
      const text = await res.text().catch(function () { return ""; });
      throw new Error("Batch tag failed: HTTP " + res.status + (text ? ": " + text : ""));
    }
    const data = await res.json();
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

    const batchId = uuidv4();
    const songIds = [];
    console.log("[submit] batch_id", batchId, "files", selectedFiles.length);

    const uploadBtn = document.getElementById("sp-upload-btn");
    const fileInput = document.getElementById("sp-file-input");
    const pickBtn = document.getElementById("sp-pick-btn");
    if (uploadBtn) uploadBtn.disabled = true;
    if (fileInput) fileInput.disabled = true;
    if (pickBtn) pickBtn.disabled = true;
    setDebug("Uploading…");

    try {
      for (let i = 0; i < selectedFiles.length; i++) {
        setDebug("Uploading " + (i + 1) + "/" + selectedFiles.length + "…");
        const item = selectedFiles[i];
        const audioUrl = await uploadOne(item.file);
        setDebug("Analyzing " + (i + 1) + "/" + selectedFiles.length + "…");
        const title = baseTitleFromFilename(item.file.name);
        const artist = getArtistForIndex(i);
        const songId = await pipelineOne(title, audioUrl, token, artist || null);
        songIds.push(songId);
      }

      setDebug("Linking batch…");
      await tagBatch(batchId, songIds, token);

      const cachebust = Date.now();
      const url = "/batch-compare?batch_id=" + encodeURIComponent(batchId) + "&preset=hit_single&v=" + cachebust;
      window.location.href = url;
    } catch (e) {
      console.error("[submit] error", e);
      setDebug(String(e && e.message ? e.message : e));
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
