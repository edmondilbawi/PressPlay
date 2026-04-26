let lastCenteredIndex = -1;

function scrollSegmentIntoCenter(index) {
    const el = document.getElementById(`segment-${index}`);
    if (!el) return;

    // Avoid jitter — only recenter when the active segment changes
    if (index === lastCenteredIndex) return;
    lastCenteredIndex = index;

    el.scrollIntoView({
        behavior: "smooth",
        block: "center",
        inline: "nearest"
    });
}

function waitForAudioReady(audioEl, timeout = 8000) {
    return new Promise((resolve, reject) => {
        if (!audioEl) {
            reject(new Error("No audio element"));
            return;
        }

        if (audioEl.readyState >= 3 && isFinite(audioEl.duration) && audioEl.duration > 0) {
            resolve();
            return;
        }

        let done = false;

        const cleanup = () => {
            audioEl.removeEventListener("canplay", onReady);
            audioEl.removeEventListener("canplaythrough", onReady);
            audioEl.removeEventListener("loadeddata", onReady);
            audioEl.removeEventListener("loadedmetadata", onMeta);
            audioEl.removeEventListener("error", onError);
            clearTimeout(timer);
        };

        const finish = () => {
            if (done) return;
            done = true;
            cleanup();
            resolve();
        };

        const fail = (msg) => {
            if (done) return;
            done = true;
            cleanup();
            reject(new Error(msg));
        };

        const onReady = () => {
            if (audioEl.readyState >= 3) finish();
        };

        const onMeta = () => {
            if (isFinite(audioEl.duration) && audioEl.duration > 0 && audioEl.readyState >= 2) {
                finish();
            }
        };

        const onError = () => fail("Audio load failed");
        const timer = setTimeout(() => fail("Audio load timeout"), timeout);

        audioEl.addEventListener("canplay", onReady);
        audioEl.addEventListener("canplaythrough", onReady);
        audioEl.addEventListener("loadeddata", onReady);
        audioEl.addEventListener("loadedmetadata", onMeta);
        audioEl.addEventListener("error", onError);
    });
}

function highlightSegment(index) {
    document.querySelectorAll(".segment-box").forEach(el => {
        el.classList.remove("active");
    });

    const el = document.getElementById(`segment-${index}`);
    if (el) {
        el.classList.add("active");
    }
}


function saveSegmentText(index) {
    const enTextarea = document.querySelector(`textarea[data-index="${index}"][data-lang="en"]`);
    const arTextarea = document.querySelector(`textarea[data-index="${index}"][data-lang="ar"]`);
    const box = document.querySelector(`.segment-box[data-index="${index}"]`);

    if (!box) return;

    const start = parseFloat(box.dataset.start || "0").toFixed(6);
    const end = parseFloat(box.dataset.end || "0").toFixed(6);

    if (enTextarea) {
        const enSpeaker = document.querySelector(`.speaker-dropdown[data-index="${index}"][data-lang="en"]`)?.value || "";
        saveSubtitle(index, "en", enTextarea.value, enSpeaker, start, end)
            .catch(err => console.error("Save EN error:", err));
    }

    if (arTextarea) {
        const arSpeaker = document.querySelector(`.speaker-dropdown[data-index="${index}"][data-lang="ar"]`)?.value || "";
        saveSubtitle(index, "ar", arTextarea.value, arSpeaker, start, end)
            .catch(err => console.error("Save AR error:", err));
    }
}

function saveCurrentSegmentText() {
    if (!activeBox) return;
    const index = parseInt(activeBox.dataset.index, 10);
    if (!Number.isFinite(index)) return;
    saveSegmentText(index);
}

function weightedCpsLengthFallback(text) {
    if (!text) return 0;
    const trimmed = String(text).trim().replace(/[.,!?]+$/, "");
    let extra = 0;
    for (const ch of trimmed) {
        if (ch === "," || ch === ".") extra += 2;
        else if (ch === "!" || ch === "?") extra += 4;
    }
    return trimmed.length + extra;
}

function updateSingleCpsFallback(index) {
    const box = document.querySelector(`.segment-box[data-index="${index}"]`);
    if (!box) return;

    const start = parseFloat(box.dataset.start || "0");
    const end = parseFloat(box.dataset.end || "0");
    const duration = Math.max(0.001, end - start);

    const enText = document.querySelector(`textarea[data-index="${index}"][data-lang="en"]`)?.value || "";
    const arText = document.querySelector(`textarea[data-index="${index}"][data-lang="ar"]`)?.value || "";

    const enCps = (weightedCpsLengthFallback(enText) / duration).toFixed(1);
    const arCps = (weightedCpsLengthFallback(arText) / duration).toFixed(1);

    const enSpan = document.querySelector(`.cps-en[data-index="${index}"]`);
    const arSpan = document.querySelector(`.cps-ar[data-index="${index}"]`);
    if (enSpan) {
        enSpan.textContent = `CPS: ${enCps}`;
        const v = parseFloat(enCps);
        enSpan.style.color = (v < 16 || v > 21) ? "red" : "#222";
    }
    if (arSpan) {
        arSpan.textContent = `CPS: ${arCps}`;
        const v = parseFloat(arCps);
        arSpan.style.color = (v < 16 || v > 21) ? "red" : "#222";
    }
}

function forceAutoHeightAndCpsFallback() {
    document.querySelectorAll("textarea.edit-field").forEach((textarea) => {
        textarea.style.height = "auto";
        textarea.style.height = `${textarea.scrollHeight}px`;
    });

    document.querySelectorAll(".segment-box").forEach((box) => {
        const index = box.dataset.index;
        if (index !== undefined && index !== null && index !== "") {
            if (typeof updateCPS === "function") updateCPS(index);
            else updateSingleCpsFallback(index);
        }
    });
}

function bindSegmentGridInteractions() {
    document.querySelectorAll(".segment-box").forEach(box => {
        box.onclick = null;
        box.addEventListener("click", function () {
            try {
                if (typeof handleSegmentSelection === "function") {
                    handleSegmentSelection(this);
                }
            } catch (e) {
                console.error("Segment click failed:", e);
            }
        });
    });

    document.querySelectorAll("textarea.edit-field").forEach(textarea => {
        if (typeof autoResizeTextarea === "function") {
            autoResizeTextarea(textarea);
        }

        textarea.oninput = null;
        textarea.addEventListener("input", function () {
            if (typeof autoResizeTextarea === "function") autoResizeTextarea(this);
            else {
                this.style.height = "auto";
                this.style.height = `${this.scrollHeight}px`;
            }

            const index = this.dataset.index;
            const newText = this.value;

            if (typeof rememberLastEditedSegment === "function") {
                rememberLastEditedSegment(index);
            }
            if (typeof updateRegionTextOnEdit === "function") {
                updateRegionTextOnEdit(index, newText);
            }
            if (typeof updateCPS === "function") {
                updateCPS(index);
            } else {
                updateSingleCpsFallback(index);
            }
        });

        textarea.onblur = null;
        textarea.addEventListener("blur", function () {
            if (typeof saveTextEdit === "function") {
                saveTextEdit(this);
            }
        });
    });

    document.querySelectorAll(".speaker-dropdown").forEach(dropdown => {
        dropdown.onchange = null;
        dropdown.addEventListener("change", function () {
            const index = this.dataset.index;
            const lang = this.dataset.lang;
            const newSpeaker = this.value;

            if (newSpeaker === "+add_new") {
                if (typeof showAddSpeakerDialog === "function") {
                    showAddSpeakerDialog(index, lang);
                }
                this.value = this.dataset.original || "";
                return;
            }

            if (typeof updateSpeaker === "function") {
                updateSpeaker(index, "en", newSpeaker);
            }
            if (typeof applySpeakerEverywhere === "function") {
                applySpeakerEverywhere(index, newSpeaker);
            }
            if (typeof updateSpeakerColor === "function") {
                const header = this.closest(".segment-header");
                if (header) updateSpeakerColor(header, newSpeaker);
            }
            if (typeof updateArabicSpeaker === "function") {
                updateArabicSpeaker(index, newSpeaker);
            }
            if (typeof updateSpeakerFilter === "function") {
                updateSpeakerFilter(newSpeaker);
            }

            this.dataset.original = newSpeaker;
        });
    });
}

window.deleteSelectedSegment = async function() {
    const activeSegment =
        document.querySelector('.segment-box.active') ||
        document.querySelector('.segment-box');

    if (!activeSegment) {
        alert('No segment selected.');
        return;
    }

    const segmentIndex = parseInt(activeSegment.dataset.index, 10);
    if (!Number.isFinite(segmentIndex)) {
        alert('Invalid segment index');
        return;
    }

    if (!confirm(`Delete selected segment #${segmentIndex + 1}?`)) {
        return;
    }

    const formData = new FormData();
    formData.append('project', window.currentProject || (typeof project !== 'undefined' ? project : ''));
    formData.append('episode', window.currentEpisode || (typeof episode !== 'undefined' ? episode : ''));
    formData.append('segment_index', String(segmentIndex));

    try {
        if (typeof setInsertStatus === 'function') {
            setInsertStatus('Deleting segment...', '#ffa500');
        }

        const response = await fetch('/delete_segment', {
            method: 'POST',
            body: formData
        });

        const raw = await response.text();
        let result = {};
        try {
            result = raw ? JSON.parse(raw) : {};
        } catch (e) {
            throw new Error(raw || 'Invalid response from server');
        }

        if (!response.ok || result.status !== 'success') {
            throw new Error(result.message || `Server error: ${response.status}`);
        }

        if (typeof setInsertStatus === 'function') {
            setInsertStatus('Segment deleted successfully!', '#28a745');
        }

        if (typeof refreshSegmentsOnly === 'function') {
            await refreshSegmentsOnly();
        }

    } catch (error) {
        console.error('Error deleting segment:', error);
        if (typeof setInsertStatus === 'function') {
            setInsertStatus(`Error: ${error.message}`, '#dc3545');
        } else {
            alert(`Delete failed: ${error.message}`);
        }
    }
};

async function refreshSegmentsOnly() {
    const url = `/editor/${encodeURIComponent(window.currentProject || project)}/${encodeURIComponent(window.currentEpisode || episode)}`;
    const response = await fetch(url, { cache: "no-store" });

    if (!response.ok) {
        throw new Error(`Failed to refresh segments: ${response.status}`);
    }

    const html = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    const newGrid = doc.querySelector("#segment-grid");
    const currentGrid = document.querySelector("#segment-grid");

    if (!newGrid || !currentGrid) {
        throw new Error("Could not refresh segment grid");
    }

    currentGrid.innerHTML = newGrid.innerHTML;

    const newStatus = doc.querySelector("#insert-status");
    const currentStatus = document.querySelector("#insert-status");
    if (newStatus && currentStatus) {
        currentStatus.textContent = newStatus.textContent;
        currentStatus.style.color = newStatus.style.color || currentStatus.style.color;
    }

    // reset state
    activeBox = null;
    activeSegmentIndex = null;

    // refresh recordingsMeta from new HTML bootstrap payload
    let refreshedRecordings = null;
    const scripts = Array.from(doc.querySelectorAll("script"));
    for (const script of scripts) {
        const txt = script.textContent || "";
        if (!txt.includes("__EDITOR_BOOTSTRAP__")) continue;

        // index_new9 bootstrap shape:
        // window.__EDITOR_BOOTSTRAP__ = { recordingsMeta: [...], project: "...", ... };
        const bootMatch = txt.match(/recordingsMeta\s*:\s*(\[[\s\S]*?\])\s*,\s*project\s*:/);
        if (bootMatch) {
            try {
                refreshedRecordings = JSON.parse(bootMatch[1]);
            } catch (e) {
                console.warn("Could not parse recordingsMeta from bootstrap:", e);
            }
        }
        break;
    }

    if (Array.isArray(refreshedRecordings)) {
        recordingsMeta = refreshedRecordings;
        if (window.__EDITOR_BOOTSTRAP__) {
            window.__EDITOR_BOOTSTRAP__.recordingsMeta = recordingsMeta;
        }
        console.log(`🔄 recordingsMeta refreshed: ${recordingsMeta.length} item(s)`);
    } else {
        console.warn("⚠️ recordingsMeta refresh skipped (bootstrap payload not found)");
    }

    bindSegmentGridInteractions();
    if (typeof window.rebindRealtimeListeners === "function") {
        window.rebindRealtimeListeners();
    }

    if (typeof window.initializeSpeakerDropdowns === "function") window.initializeSpeakerDropdowns();
    if (typeof initializeColumnToggles === "function") initializeColumnToggles();
    if (typeof initializeCPSCalculation === "function") initializeCPSCalculation();
    if (typeof initializeSpeakerFilter === "function") initializeSpeakerFilter();

    document.querySelectorAll("textarea.edit-field").forEach(textarea => {
        if (typeof autoResizeTextarea === "function") autoResizeTextarea(textarea);
        else {
            textarea.style.height = "auto";
            textarea.style.height = `${textarea.scrollHeight}px`;
        }
    });

    forceAutoHeightAndCpsFallback();

    // re-load done state styling after DOM replacement
    if (typeof loadDoneState === "function") {
        await loadDoneState();
    }

    // auto-select one segment so audio panel becomes active again
    const targetIndex = localStorage.getItem(LAST_SEGMENT_KEY);
    let targetBox = null;

    if (targetIndex !== null) {
        targetBox = document.querySelector(`.segment-box[data-index="${targetIndex}"]`);
    }
    if (!targetBox) {
        targetBox = document.querySelector(".segment-box");
    }

    if (targetBox && typeof handleSegmentSelection === "function") {
        handleSegmentSelection(targetBox);
    }
}

// Function to check if media is actually ready
function isMediaActuallyReady() {
    return new Promise((resolve) => {
        const video = document.getElementById("videoPlayer");
        if (!video) {
            resolve(false);
            return;
        }

        // Check various ready states
        const checks = [
            video.readyState >= 4, // HAVE_ENOUGH_DATA
            video.buffered.length > 0,
            video.duration > 0
        ];

        const isReady = checks.every(check => check === true);
        
        if (isReady) {
            resolve(true);
        } else {
            // Wait a bit and check again
            setTimeout(() => {
                const recheck = [
                    video.readyState >= 4,
                    video.buffered.length > 0,
                    video.duration > 0
                ];
                resolve(recheck.every(check => check === true));
            }, 1000);
        }
    });
}


async function clearAllCache() {
    try {
        const db = await openIndexedDB();

        await new Promise((resolve, reject) => {
            const tx = db.transaction("files", "readwrite");
            const store = tx.objectStore("files");
            const req = store.clear();

            req.onsuccess = () => {
                console.log("🗑 All IndexedDB cache cleared");
                resolve();
            };

            req.onerror = () => reject(req.error);
        });
    } catch (err) {
        console.warn("⚠️ Failed to clear cache:", err);
    }
}





// Hybrid preload: stream now, cache in background, auto-purge other projects
async function preloadMediaToTemp() {
    console.log("🔍 Fresh episode preload started...");

    const videoUrl = `/subtitles/${project}/${episode}/${episode}.mp4`;
    const cacheKey = `${project}_${episode}_video`;
    const video = document.getElementById("videoPlayer");

    try {
        updateLoadingProgress(5, "Loading episode video...", episode);

        // Start video stream immediately
        video.src = videoUrl;

        // Always cache all WAVs for the opened episode at startup.
        // This avoids per-segment downloads later during Numpad0/Numpad1/Numpad2 playback.
        updateLoadingProgress(10, "Preparing episode audio cache...", "Please wait...");
        await preloadAllRecordedWavsInBackground(true, true);

        // Open editor once WAV caching is done
        updateLoadingProgress(92, "Finalizing...", "Preparing editor...");

        // Cache video quietly after UI opens
        setTimeout(async () => {
            try {
                await cacheVideoInBackground(cacheKey, videoUrl);
            } catch (err) {
                console.warn("⚠️ Video background cache failed:", err);
            }
        }, 500);

        // Keep marker fresh after successful load for same-episode refresh detection.
        const markerKey = "last_opened_episode_cache_marker";
        const currentValue = `${project}||${episode}`;
        localStorage.setItem(markerKey, currentValue);

        updateLoadingProgress(100, "Episode ready ✅", "Editor opened");
        finishLoading();

    } catch (error) {
        console.error("❌ Fresh preload error:", error);
        finishLoading();
    }
}




// Background caching: download full MP4 quietly and store in IndexedDB
async function cacheVideoInBackground(cacheKey, url) {
    try {
        console.log("📥 Background caching started:", cacheKey);

        const response = await fetch(url);
        if (!response.ok) throw new Error(`Download failed while caching: ${response.status}`);

        const reader = response.body.getReader();
        const chunks = [];
        let received = 0;

        // Optional: you could wire progress here if you want hidden logs
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.length;
        }

        const videoBlob = new Blob(chunks);
        await storeFileInCache(cacheKey, videoBlob);
        console.log("✅ Cached video successfully for future sessions:", cacheKey, "size:", videoBlob.size);

        // Auto-clean old / excess cache
        cleanupOldCacheEntries();

    } catch (err) {
        console.warn("⚠️ Background caching failed:", err);
    }
}

async function probeRecordingExists(fileName, timeoutMs = 4000) {
    const url = `/subtitles/${project}/${episode}/recordings/${fileName}?t=${Date.now()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            method: "HEAD",
            signal: controller.signal,
            cache: "no-store"
        });
        return response.ok;
    } catch (err) {
        console.warn("⚠️ Probe failed:", fileName, err);
        return false;
    } finally {
        clearTimeout(timer);
    }
}



async function probeAllEpisodeWavsOnStart() {
    const recordings = Array.isArray(recordingsMeta) ? recordingsMeta : [];
    const wavs = recordings.filter(r => r && r.file);

    if (!wavs.length) {
        console.log("ℹ️ No WAVs to probe");
        return;
    }

    console.log(`🔎 Probing episode WAVs on start: ${wavs.length} file(s)`);

    let checked = 0;
    let okCount = 0;
    let missingCount = 0;

    for (const rec of wavs) {
        const ok = await probeRecordingExists(rec.file, 3000);
        checked++;

        if (ok) okCount++;
        else missingCount++;

        updateLoadingProgress(
            15 + Math.round((checked / wavs.length) * 75),
            "Checking episode WAVs...",
            `${checked}/${wavs.length} | found=${okCount} missing=${missingCount}`
        );

        if (checked % 10 === 0 || checked === wavs.length) {
            console.log(`🔎 WAV probe progress ${checked}/${wavs.length} | found=${okCount} missing=${missingCount}`);
        }

        await new Promise(resolve => setTimeout(resolve, 0));
    }

    console.log(`🔎 WAV probe finished | found=${okCount}, missing=${missingCount}`);
}

async function fetchBlobWithTimeout(url, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            signal: controller.signal,
            cache: "no-store"
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        return await response.blob();
    } finally {
        clearTimeout(timer);
    }
}



// Background caching: download Generated wav files
let wavPreloadStarted = false;

async function preloadAllRecordedWavsInBackground(blocking = false, forceRestart = false) {
    if (forceRestart) {
        wavPreloadStarted = false;
    }
    if (wavPreloadStarted) return;
    wavPreloadStarted = true;

    try {
        const recordings = Array.isArray(recordingsMeta) ? recordingsMeta : [];
        const wavs = recordings.filter(r => r && r.file);

        if (!wavs.length) {
            console.log("No recorded WAVs to cache");
            if (blocking) {
                updateLoadingProgress(90, "No WAVs to cache", "Opening editor...");
            }
            return;
        }

        console.log(`Caching this episode WAVs only: ${wavs.length} file(s)`);

        let cachedCount = 0;
        let skippedCount = 0;
        let failedCount = 0;

        for (let i = 0; i < wavs.length; i++) {
            const rec = wavs[i];

            try {
                const cacheKey = getRecordingCacheKey(rec.file);
                const existing = await getCachedFile(cacheKey);

                if (existing) {
                    skippedCount++;
                } else {
                    const url = `/subtitles/${project}/${episode}/recordings/${rec.file}?t=${Date.now()}`;
                    console.log(`Caching ${i + 1}/${wavs.length}: ${rec.file}`);

                    try {
                        const blob = await fetchBlobWithTimeout(url, 15000);
                        await storeFileInCache(cacheKey, blob);
                        cachedCount++;
                    } catch (firstErr) {
                        // One retry for unstable network/NAS conditions.
                        const retryBlob = await fetchBlobWithTimeout(url, 20000);
                        await storeFileInCache(cacheKey, retryBlob);
                        cachedCount++;
                    }
                }
            } catch (err) {
                failedCount++;
                console.warn(`Failed to cache WAV ${i + 1}/${wavs.length}: ${rec.file}`, err);
            }

            const done = cachedCount + skippedCount + failedCount;

            if (blocking) {
                const pct = 20 + Math.round((done / wavs.length) * 70);
                updateLoadingProgress(
                    pct,
                    "Caching WAV files...",
                    `${done}/${wavs.length} | cached=${cachedCount} skipped=${skippedCount} failed=${failedCount}`
                );
            }

            if (done % 5 === 0 || done === wavs.length) {
                console.log(`WAV cache progress ${done}/${wavs.length} | cached=${cachedCount} skipped=${skippedCount} failed=${failedCount}`);
            }

            await new Promise(resolve => setTimeout(resolve, 0));
        }

        console.log(`Episode WAV cache finished | cached=${cachedCount}, skipped=${skippedCount}, failed=${failedCount}`);

        if (blocking) {
            updateLoadingProgress(
                90,
                "WAV caching complete",
                `${wavs.length} files processed`
            );
        }

    } catch (err) {
        console.warn("WAV preload failed:", err);
        if (blocking) {
            updateLoadingProgress(90, "WAV caching finished with warnings", "Opening editor...");
        }
    }
}


// Auto-purge cached videos from other projects
async function purgeOtherEpisodeVideos(activeProject, activeEpisode) {
    try {
        console.log("🧽 Auto-clean: removing cached videos from other episodes (keeping:", activeProject, activeEpisode, ")");

        const db = await openIndexedDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction("files", "readwrite");
            const store = tx.objectStore("files");
            const req = store.getAll();

            req.onsuccess = () => {
                const records = req.result || [];
                const keepKey = `${activeProject}_${activeEpisode}_video`;

                for (const rec of records) {
                    const key = String(rec.key || "");

                    if (key.endsWith("_video") && key !== keepKey) {
                        console.log("🗑 Deleting cached video from other episode:", key);
                        store.delete(key);
                    }
                }
                resolve();
            };

            req.onerror = () => reject(req.error);
        });
    } catch (err) {
        console.warn("⚠️ Failed to purge other episode videos:", err);
    }
}


async function purgeOtherEpisodeWavs(activeProject, activeEpisode) {
    try {
        console.log("🧽 Auto-clean: removing cached WAVs from other episodes (keeping:", activeProject, activeEpisode, ")");

        const db = await openIndexedDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction("files", "readwrite");
            const store = tx.objectStore("files");
            const req = store.getAll();

            req.onsuccess = () => {
                const records = req.result || [];
                const keepPrefix = `wav_${activeProject}_${activeEpisode}_`;

                for (const rec of records) {
                    const key = String(rec.key || "");

                    if (!key.startsWith("wav_")) continue;

                    if (!key.startsWith(keepPrefix)) {
                        console.log("🗑 Deleting cached WAV from other episode:", key);
                        store.delete(key);
                    }
                }
                resolve();
            };

            req.onerror = () => reject(req.error);
        });
    } catch (err) {
        console.warn("⚠️ Failed to purge other episode WAVs:", err);
    }
}


// Auto-expiring cache logic: delete old / oversized entries
async function cleanupOldCacheEntries(maxAgeDays = 7, maxBytes = 2 * 1024 * 1024 * 1024) {
    try {
        const db = await openIndexedDB();
        const now = Date.now();
        const maxAge = maxAgeDays * 24 * 60 * 60 * 1000;
        const keepWavPrefix = `wav_${project}_${episode}_`;
        const keepVideoKey = `${project}_${episode}_video`;

        await new Promise((resolve, reject) => {
            const tx = db.transaction("files", "readwrite");
            const store = tx.objectStore("files");
            const req = store.getAll();

            req.onsuccess = () => {
                const records = req.result || [];

                // 1) Drop very old entries except current episode media
                const fresh = [];
                for (const rec of records) {
                    const key = String(rec.key || "");
                    const keepCurrent = key.startsWith(keepWavPrefix) || key === keepVideoKey;
                    if (!rec.lastAccessed) {
                        rec.lastAccessed = rec.createdAt || now;
                    }
                    if (!keepCurrent && now - rec.lastAccessed > maxAge) {
                        console.log("Deleting expired cache:", rec.key);
                        store.delete(rec.key);
                    } else {
                        fresh.push(rec);
                    }
                }

                // 2) Enforce total size limit (LRU), but never evict current episode media
                let total = fresh.reduce((s, r) => s + (r.size || 0), 0);
                fresh.sort((a, b) => a.lastAccessed - b.lastAccessed);

                while (total > maxBytes && fresh.length > 0) {
                    const victim = fresh.shift();
                    const key = String(victim.key || "");
                    const keepCurrent = key.startsWith(keepWavPrefix) || key === keepVideoKey;
                    if (keepCurrent) continue;

                    console.log("Deleting cache to free space:", victim.key);
                    store.delete(victim.key);
                    total -= victim.size || 0;
                }

                resolve();
            };
            req.onerror = () => reject(req.error);
        });
    } catch (err) {
        console.warn("Cache cleanup failed:", err);
    }
}

// Loading UI functions
function showLoadingOverlay(message) {
    document.body.classList.add('loading');
    
    if (!document.getElementById('loading-overlay')) {
        const overlay = document.createElement('div');
        overlay.id = 'loading-overlay';
        overlay.className = 'loading-overlay';
        overlay.innerHTML = `
            <div class="loading-spinner"></div>
            <div class="loading-message">${message}</div>
            <div class="loading-progress">
                <div class="loading-progress-bar" id="loading-progress-bar"></div>
            </div>
            <div id="loading-detail" style="font-size: 14px; color: #666;"></div>
            <div id="loading-subdetail" style="font-size: 12px; color: #999; margin-top: 5px;"></div>
            <div id="loading-final" style="font-size: 12px; color: #28a745; margin-top: 10px; display: none;">
                ✅ Finalizing... Almost ready!
            </div>
        `;
        document.body.appendChild(overlay);
    }
    
    disableUserInterface(true);
}

function updateLoadingProgress(percent, detail, subdetail) {
    const progressBar = document.getElementById('loading-progress-bar');
    const detailEl = document.getElementById('loading-detail');
    const subdetailEl = document.getElementById('loading-subdetail');
    
    if (progressBar) {
        progressBar.style.width = percent + '%';
    }
    if (detailEl && detail) {
        detailEl.textContent = detail;
    }
    if (subdetailEl && subdetail) {
        subdetailEl.textContent = subdetail;
    }
}

function finishLoading() {
    console.log("✅ Preloading complete - enabling interface");
    
    // Remove loading overlay
    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
        overlay.remove();
    }
    
    // Re-enable body scrolling
    document.body.classList.remove('loading');
    
    // Enable user interface
    disableUserInterface(false);
    
    // Initialize the main application
    initializeMainApplication();
}

function disableUserInterface(disabled) {
    const elementsToDisable = [
        '#videoPlayer',
        '.segment-box',
        '#start-recording',
        '#stop-recording',
        '#preview-btn',
        'textarea.edit-field',
        '.speaker-dropdown',
        '#segment-done-checkbox',
        '#speaker-filter',
        '#filter-unrecorded',
        '#toggle-english',
        '#toggle-arabic',
        '#toggle-timecode'
    ];
    
    elementsToDisable.forEach(selector => {
        document.querySelectorAll(selector).forEach(element => {
            if (disabled) {
                element.style.pointerEvents = 'none';
                element.style.opacity = '0.6';
                element.disabled = true;
            } else {
                element.style.pointerEvents = '';
                element.style.opacity = '';
                element.disabled = false;
            }
        });
    });
}



            // Unified save function
            async function saveSubtitle(index, lang, text, speaker, start, end) {
                const formData = new FormData();
                formData.append('index', index);
                formData.append('lang', lang);
                formData.append('text', text);
                formData.append('speaker', speaker);
                formData.append('start', start);
                formData.append('end', end);
                formData.append('project', project);
                formData.append('episode', episode);

                const response = await fetch('/save_subtitle', {
                    method: 'POST',
                    body: formData
                });

                return await response.json();
            }


        // Text changes, speaker changes, timecode changes
        const boot = window.__EDITOR_BOOTSTRAP__ || {};
        let recordingsMeta = Array.isArray(boot.recordingsMeta) ? boot.recordingsMeta : [];
        const project = boot.project || "";
        const episode = boot.episode || "";
        window.currentProject = project;
        window.currentEpisode = episode;

        function setInsertStatus(message, color = "#666") {
            const insertStatus = document.getElementById('insert-status');
            if (!insertStatus) {
                console.log(`[insert-status] ${message}`);
                return;
            }
            insertStatus.textContent = message;
            insertStatus.style.color = color;
        }

        // ✅ Remember last edited segment per (project, episode)
        const LAST_SEGMENT_KEY = `last_edited_segment_${project}_${episode}`;

        function rememberLastEditedSegment(index) {
        if (index === undefined || index === null) return;
        localStorage.setItem(LAST_SEGMENT_KEY, String(index));
        }

        function scrollToSegmentIndex(index) {
        const box = document.querySelector(`.segment-box[data-index="${index}"]`);
        const segmentPanel = document.querySelector(".segment-panel");
        if (!box || !segmentPanel) return;

        // center it (same logic you use in timeupdate)
        segmentPanel.scrollTop =
            box.offsetTop - segmentPanel.offsetTop - segmentPanel.clientHeight / 2 + box.clientHeight / 2;

        // Optional: make it "active" visually on load
        if (activeBox) activeBox.classList.remove("active");
        activeBox = box;
        activeBox.classList.add("active");

        // keep checkbox in sync if you have it
        try { updateDoneCheckboxState(activeBox); } catch (e) {}
        }

        function formatTtsRate(value) {
        const n = Number(value || 0);
        return `${n >= 0 ? "+" : ""}${n}%`;
        }

        function resetTtsFitDisplay() {
            const seg = document.getElementById("tts-segment-duration");
            const tts = document.getElementById("tts-audio-duration");
            const rate = document.getElementById("tts-rate-display");
            const fit = document.getElementById("tts-fit-status");

            if (seg) seg.textContent = "—";
            if (tts) tts.textContent = "—";
            if (rate) rate.textContent = "—";
            if (fit) {
                fit.textContent = "—";
                fit.style.color = "";
                fit.style.fontWeight = "";
            }
        }

        function updateTtsFitDisplay(data) {
            const seg = document.getElementById("tts-segment-duration");
            const tts = document.getElementById("tts-audio-duration");
            const rate = document.getElementById("tts-rate-display");
            const fit = document.getElementById("tts-fit-status");

            if (seg) seg.textContent = `${Number(data.segment_duration || 0).toFixed(2)}s`;
            if (tts) tts.textContent = `${Number(data.tts_duration || 0).toFixed(2)}s`;
            if (rate) rate.textContent = data.rate || "+0%";
            if (fit) {
                fit.textContent = data.fit_text || "—";
                fit.style.fontWeight = "600";
                fit.style.color =
                    data.fit_status === "good" ? "#15803d" :
                    data.fit_status === "warning" ? "#b45309" :
                    data.fit_status === "bad" ? "#b91c1c" : "";
            }
        }

        function restoreLastEditedSegment() {
        const raw = localStorage.getItem(LAST_SEGMENT_KEY);
        const index = raw !== null ? parseInt(raw, 10) : NaN;
        if (!Number.isFinite(index)) return;
        scrollToSegmentIndex(index);
        }

        // Run after initial layout is ready
        window.addEventListener("load", () => {
        // small delay helps if the page is still rendering / regions are being created
        setTimeout(restoreLastEditedSegment, 200);
        });        




        let activeBox = null;
        let video = null;
        let waveform = null;
        let activeSegmentIndex = null;
        let seekEndTime = null;
        let isManualPlayback = true;
        let recordingEndTime = null;
        let isRecordingStopping = false;
        let recorder = null;
        let regions = [];
        let isRegionDragging = false;
        let ws = null;
        let userId = null;
        let dragMode = null;        // "move" | "resize-left" | "resize-right"
        let dragStartTime = 0;
        let originalStart = 0;
        let originalEnd = 0;
        let activeRegion = null;
        let dubPreviewAudioContext = null;
        let dubPreviewSources = [];
        let dubPreviewRunning = false;
        let dubPreviewRaf = null;
        let dubPreviewStartVideoTime = 0;
        let dubPreviewStartAudioTime = 0;

        let dubPreviewTimers = [];
        let dubPreviewPlayers = [];

        // Initialize speaker name mapping
        const speakerNameMapping = {};
        const bootSpeakers = Array.isArray(boot.speakers) ? boot.speakers : [];
        bootSpeakers.forEach((name) => {
            if (name) speakerNameMapping[name] = name;
        });

        // Function to format seconds to hh:mm:ss:ff (25 fps)
        function formatTimecode(seconds) {
            const fps = 25;
            const totalFrames = Math.round(seconds * fps);
            
            const hours = Math.floor(totalFrames / (3600 * fps));
            const minutes = Math.floor((totalFrames % (3600 * fps)) / (60 * fps));
            const secs = Math.floor((totalFrames % (60 * fps)) / fps);
            const frames = totalFrames % fps;
            
            return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`;
        }

        // Frame-by-frame timecode updater
        function initializeFrameTimecode() {
            const currentTimeElement = document.getElementById("currentTime");
            let animationId = null;
            let lastFrameTime = 0;
            const frameInterval = 40; // 40ms per frame at 25fps (1000ms / 25fps = 40ms)

            function updateFrameTimecode() {
                const now = performance.now();
                
                if (now - lastFrameTime >= frameInterval) {
                    if (video && currentTimeElement) {
                        currentTimeElement.textContent = formatTimecode(video.currentTime);
                    }
                    lastFrameTime = now;
                }
                
                animationId = requestAnimationFrame(updateFrameTimecode);
            }

            // Start the frame-by-frame updates
            animationId = requestAnimationFrame(updateFrameTimecode);

            // Clean up when page is hidden
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) {
                    if (animationId) {
                        cancelAnimationFrame(animationId);
                        animationId = null;
                    }
                } else {
                    if (!animationId) {
                        animationId = requestAnimationFrame(updateFrameTimecode);
                    }
                }
            });
        }


        // Simple IndexedDB helpers
        function getDB() {
            return new Promise((resolve, reject) => {
                const request = indexedDB.open("SubtitleEditorCache", 3);

                request.onupgradeneeded = () => {
                    const db = request.result;

                    if (db.objectStoreNames.contains("files")) {
                        db.deleteObjectStore("files");
                    }

                    db.createObjectStore("files", { keyPath: "key" });
                };

                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        }

        function openIndexedDB() {
            return getDB();
        }

        async function storeFileInCache(key, blob) {
            const db = await getDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction("files", "readwrite");
                const store = tx.objectStore("files");

                store.put({
                    key,
                    blob,
                    size: blob.size || 0,
                    createdAt: Date.now(),
                    lastAccessed: Date.now(),
                    type: blob.type || "application/octet-stream",
                });

                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        }

        async function getCachedFile(key) {
            const db = await getDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction("files", "readwrite");
                const store = tx.objectStore("files");
                const request = store.get(key);

                request.onsuccess = () => {
                    const record = request.result || null;
                    if (record) {
                        record.lastAccessed = Date.now();
                        store.put(record);
                        resolve(record.blob || null);
                    } else {
                        resolve(null);
                    }
                };

                request.onerror = () => reject(request.error);
            });
        }


        function getRecordingCacheKey(fileName) {
            return `wav_${project}_${episode}_${fileName}`;
        }

        async function cacheRecordingFromServer(fileName) {
            const cacheKey = getRecordingCacheKey(fileName);
            const url = `/subtitles/${project}/${episode}/recordings/${fileName}?t=${Date.now()}`;

            const response = await fetch(url, { cache: "no-store" });
            if (!response.ok) {
                throw new Error(`Failed to fetch WAV: ${response.status}`);
            }

            const blob = await response.blob();
            await storeFileInCache(cacheKey, blob);

            console.log("📦 Cache updated:", cacheKey, "size:", blob.size);
            return blob;
        }

        async function getRecordingBlob(fileName) {
            const cacheKey = getRecordingCacheKey(fileName);

            let blob = await getCachedFile(cacheKey);
            if (blob) {
                console.log("📦 WAV loaded from cache:", fileName);
                return blob;
            }

            console.log("🌐 WAV not cached, downloading:", fileName);
            blob = await cacheRecordingFromServer(fileName);
            return blob;
        }  
        
        function getEpisodeCacheMarker() {
            return `last_opened_episode_cache_marker`;
        }

        function purgeOtherEpisodeWaveforms(activeProject, activeEpisode) {
            try {
                const keepPrefix = `waveform_${activeProject}_${activeEpisode}_`;
                const keysToDelete = [];
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (!key) continue;
                    if (key.startsWith("waveform_") && !key.startsWith(keepPrefix)) {
                        keysToDelete.push(key);
                    }
                }
                keysToDelete.forEach(k => localStorage.removeItem(k));
                if (keysToDelete.length) {
                    console.log("🗑 Deleted waveform cache keys from other episodes:", keysToDelete.length);
                }
            } catch (e) {
                console.warn("⚠️ Failed to purge waveform cache keys:", e);
            }
        }

        async function cleanupCacheOnlyWhenEpisodeChanges(project, episode) {
            const markerKey = getEpisodeCacheMarker();
            const currentValue = `${project}||${episode}`;
            const previousValue = localStorage.getItem(markerKey);

            // Same episode refresh -> do nothing
            if (previousValue === currentValue) {
                console.log("♻️ Same episode refresh detected — skipping cache cleanup");
                return;
            }

            console.log("🧹 Episode changed");
            console.log("Previous:", previousValue);
            console.log("Current:", currentValue);

            try {
                await purgeOtherEpisodeVideos(project, episode);
                await purgeOtherEpisodeWavs(project, episode);
                purgeOtherEpisodeWaveforms(project, episode);
                await cleanupOldCacheEntries();
            } catch (e) {
                console.warn("⚠️ Episode-change cleanup failed:", e);
            }

            localStorage.setItem(markerKey, currentValue);
        }        


        // Add this function before the DOMContentLoaded event listener
        function initializeColumnToggles() {
            const toggleEnglish = document.getElementById("toggle-english");
            const toggleArabic = document.getElementById("toggle-arabic");
            const toggleTimecode = document.getElementById("toggle-timecode");

            if (!toggleEnglish || !toggleArabic || !toggleTimecode) {
                console.warn("Column toggle elements not found");
                return;
            }

            function applyColumnToggles() {
                document.querySelectorAll(".segment-box").forEach(box => {
                    const englishCol = box.querySelector(".segment-col:not(.ar)");
                    const arabicCol = box.querySelector(".segment-col.ar");
                    const timecodeCol = box.querySelector(".timecode");

                    if (englishCol) englishCol.style.display = toggleEnglish.checked ? "" : "none";
                    if (arabicCol) arabicCol.style.display = toggleArabic.checked ? "" : "none";
                    if (timecodeCol) timecodeCol.style.display = toggleTimecode.checked ? "" : "none";
                });
            }

            toggleEnglish.onchange = applyColumnToggles;
            toggleArabic.onchange = applyColumnToggles;
            toggleTimecode.onchange = applyColumnToggles;
            
            // Apply initial state
            applyColumnToggles();
        }
        

        // In your DOMContentLoaded event, update the main waveform initialization:
        document.addEventListener("DOMContentLoaded", async function () {
            console.log("🚀 Page loaded");

            try {
                showLoadingOverlay("Loading episode...");
                disableUserInterface(true);

                await cleanupCacheOnlyWhenEpisodeChanges(project, episode);
                await preloadMediaToTemp();

            } catch (error) {
                console.error("❌ Startup failed:", error);
                finishLoading();
            }
        });


function stopFullDubPreview() {
    dubPreviewRunning = false;

    if (dubPreviewRaf) {
        cancelAnimationFrame(dubPreviewRaf);
        dubPreviewRaf = null;
    }

    for (const t of dubPreviewTimers) {
        clearTimeout(t);
    }
    dubPreviewTimers = [];

    for (const src of dubPreviewSources) {
        try { src.stop(); } catch (e) {}
    }
    dubPreviewSources = [];

  for (const player of dubPreviewPlayers) {
      try {
          player.pause();
          player.currentTime = 0;

          if (player.src && player.src.startsWith("blob:")) {
              URL.revokeObjectURL(player.src);
          }

          player.src = "";
      } catch (e) {}
  }
  dubPreviewPlayers = [];

    if (video) {
        video.pause();
        video.muted = false;
        video.volume = 1.0;
    }

    console.log("⏹ Full dub preview stopped");
}

async function playFullVideoWithGeneratedWavsSynced() {
    if (!video) {
        alert("Video not ready.");
        return;
    }

    const currentVideoTime = video.currentTime || 0;

    const playableRecordings = (recordingsMeta || [])
        .filter(r =>
            r &&
            r.file &&
            Number.isFinite(Number(r.start)) &&
            Number.isFinite(Number(r.end)) &&
            Number(r.end) > currentVideoTime
        )
        .sort((a, b) => Number(a.start || 0) - Number(b.start || 0));

    console.log("?? Numpad2 playable recordings:", playableRecordings);

    if (!playableRecordings.length) {
        alert("No generated WAVs ahead of current playhead.");
        return;
    }

    stopFullDubPreview();
    dubPreviewRunning = true;
    isManualPlayback = false;

    video.pause();
    video.currentTime = currentVideoTime;
    video.muted = true;
    video.volume = 0;

    // Build playback items with lazy audio preparation
    const items = playableRecordings.map((rec) => ({
        rec,
        audio: null,
        started: false,
        loading: false,
        failed: false
    }));

    const prepareAudio = async (rec) => {
        try {
            const blob = await getRecordingBlob(rec.file);
            const objectUrl = URL.createObjectURL(blob);
            const audio = new Audio(objectUrl);
            audio.preload = "auto";
            audio.volume = 1.0;
            audio.muted = false;
            dubPreviewPlayers.push(audio);
            return audio;
        } catch (err) {
            console.warn("? Cache load failed, fallback to server:", rec.file, err);
            const fallback = new Audio(`/subtitles/${project}/${episode}/recordings/${rec.file}?t=${Date.now()}`);
            fallback.preload = "auto";
            fallback.volume = 1.0;
            fallback.muted = false;
            dubPreviewPlayers.push(fallback);
            return fallback;
        }
    };

    // Preload near-future audio to reduce start latency
    const preloadWindowSec = 5;
    const preloadTargets = items.filter(i => Number(i.rec.start) <= currentVideoTime + preloadWindowSec).slice(0, 4);
    await Promise.all(preloadTargets.map(async (i) => {
        i.loading = true;
        i.audio = await prepareAudio(i.rec);
        i.loading = false;
    }));

    try {
        await video.play();
        console.log("?? Video started for full dub preview");
    } catch (err) {
        console.warn("? Video play failed:", err);
        alert("Video could not start.");
        dubPreviewRunning = false;
        isManualPlayback = true;
        return;
    }

    const PRELOAD_SEC = 2.0;
    const LEAD_SEC = 0.12;

    let lastActiveBox = null;

    const syncLoop = () => {
        if (!dubPreviewRunning || !video) return;

        const now = video.currentTime || 0;

        // Start/preload upcoming audio based on *video time*
        for (const item of items) {
            if (item.started || item.failed) continue;
            const segStart = Number(item.rec.start || 0);
            const segEnd = Number(item.rec.end || segStart);

            if (now > segEnd) {
                item.started = true; // skip late segments
                continue;
            }

            if (!item.audio && !item.loading && now >= segStart - PRELOAD_SEC) {
                item.loading = true;
                prepareAudio(item.rec).then((audio) => {
                    item.audio = audio;
                    item.loading = false;
                }).catch(() => {
                    item.failed = true;
                    item.loading = false;
                });
            }

            if (item.audio && !item.started && now >= segStart - LEAD_SEC) {
                try {
                    const offset = Math.max(0, now - segStart);
                    item.audio.currentTime = offset;
                    item.audio.muted = false;
                    item.audio.volume = 1.0;
                    const p = item.audio.play();
                    if (p && typeof p.catch === "function") {
                        p.catch((e) => console.warn("? Audio play failed:", item.rec.file, e));
                    }
                } catch (e) {
                    console.warn("? Audio play error:", item.rec.file, e);
                }
                item.started = true;
            }
        }

        const hit = Array.from(document.querySelectorAll(".segment-box")).find(box => {
            const s = parseFloat(box.dataset.start || "0");
            const e = parseFloat(box.dataset.end || "0");
            return video.currentTime >= s && video.currentTime < e;
        });

        if (hit && hit !== lastActiveBox) {
            if (lastActiveBox) lastActiveBox.classList.remove("active");
            hit.classList.add("active");
            lastActiveBox = hit;
            activeBox = hit;

            // Keep dubbing panel in sync with active segment
            const speaker =
                hit.querySelector(".segment-col .speaker-dropdown")?.value || "Unknown";
            const start = parseFloat(hit.dataset.start || "0");
            const end = parseFloat(hit.dataset.end || "0");
            const ds = document.getElementById("dubbing-speaker");
            const dStart = document.getElementById("dubbing-start");
            const dEnd = document.getElementById("dubbing-end");
            const aStart = document.getElementById("adjusted-start");
            const aEnd = document.getElementById("adjusted-end");

            if (ds) ds.textContent = speaker;
            if (dStart) dStart.textContent = start.toFixed(2);
            if (dEnd) dEnd.textContent = end.toFixed(2);
            if (aStart) aStart.textContent = start.toFixed(2);
            if (aEnd) aEnd.textContent = end.toFixed(2);

            if (typeof updateDoneCheckboxState === "function") {
                updateDoneCheckboxState(hit);
            }
            if (typeof rememberLastEditedSegment === "function") {
                rememberLastEditedSegment(parseInt(hit.dataset.index, 10));
            }

            // Update scrolling text for Numpad2 playback
            if (typeof scrollText === "function") {
                const text = hit.querySelector('textarea[data-lang="en"]')?.value || "";
                const duration = Math.max(0.1, end - start);
                if (typeof resetScrollText === "function") {
                    resetScrollText();
                }
                scrollText(text, duration);
                if (typeof startScrollText === "function") {
                    startScrollText();
                }
            }

            // Keep the indicator visible by centering the active segment
            if (typeof centerSegmentInGrid === "function") {
                centerSegmentInGrid(hit);
            } else {
                hit.scrollIntoView({ behavior: "smooth", block: "center" });
            }
        }

        if (video.ended) {
            stopFullDubPreview();
            isManualPlayback = true;
            return;
        }

        dubPreviewRaf = requestAnimationFrame(syncLoop);
    };

      dubPreviewRaf = requestAnimationFrame(syncLoop);
  };








