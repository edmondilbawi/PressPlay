function initializeMainApplication() {
        if (window.__subtitleEditorInitialized) {
            console.warn("⚠️ initializeMainApplication called twice — ignoring");
            return;
        }
        window.__subtitleEditorInitialized = true;
        console.log("🎯 Initializing main application");

        video = document.getElementById("videoPlayer");
        window.video = video;

        // =====================
        // Canvas Waveform (HiDPI + Zoom/Pan + Regions Overlay)
        // =====================
        const canvas = document.getElementById("waveformCanvas");
        const ctx = canvas.getContext("2d");

        // Peaks from backend
        let peaks = [];
        let chunkSec = 1.0;      // seconds per peak sample
        let durationSec = 0;          // timeline duration (video)
        let waveformDurationSec = 0;  // waveform data duration
        let waveformTimeScale = 1;    // waveformTime = videoTime * scale

        // View state (real zoom/pan)
        let pxPerSec = 80;       // zoom level (increase => more zoom)
        let scrollSec = 0;       // left edge time in seconds
        let isPanning = false;
        let panStartX = 0;
        let panStartScroll = 0;

        // Helpers
        const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

        function resizeCanvasHiDPI() {
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        const w = Math.max(1, Math.floor(rect.width * dpr));
        const h = Math.max(1, Math.floor(rect.height * dpr));

        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS pixels
        return { cssW: rect.width, cssH: rect.height, dpr };
        }

        function xToTime(cssX) {
        return (cssX / pxPerSec) + scrollSec;
        }
        function timeToX(t) {
        return (t - scrollSec) * pxPerSec;
        }
        function updateDurationMapping() {
        const videoDur = Number.isFinite(video?.duration) ? video.duration : 0;
        durationSec = videoDur > 0 ? videoDur : waveformDurationSec;
        if (durationSec > 0 && waveformDurationSec > 0) {
            waveformTimeScale = waveformDurationSec / durationSec;
        } else {
            waveformTimeScale = 1;
        }
        }
        function mapVideoToWaveformTime(t) {
        return t * waveformTimeScale;
        }

        function getNeighborBoundsByIndex(idx) {
        const prevBox = document.querySelector(`.segment-box[data-index="${idx - 1}"]`);
        const nextBox = document.querySelector(`.segment-box[data-index="${idx + 1}"]`);

        let prevEnd = prevBox ? parseFloat(prevBox.dataset.end) : 0;
        let nextStart = nextBox ? parseFloat(nextBox.dataset.start) : Infinity;

        if (!Number.isFinite(prevEnd)) prevEnd = 0;
        if (!Number.isFinite(nextStart)) nextStart = Infinity;

        return { prevEnd, nextStart };
        }        

        function getSegmentsFromDOM() {
        const segs = [];
        document.querySelectorAll(".segment-box").forEach(box => {
            if (box.classList.contains("hidden")) return;
            const start = parseFloat(box.dataset.start || "0");
            const end = parseFloat(box.dataset.end || "0");
            const index = parseInt(box.dataset.index || "0", 10);
            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;

            // Pull speaker color from EN header (already colored in your UI)
            const header = box.querySelector(".segment-col:not(.ar) .segment-header");
            let color = "rgba(0,0,0,0.12)";
            if (header) {
            const c = window.getComputedStyle(header).backgroundColor;
            // keep it translucent
            color = c.startsWith("rgb") ? c.replace("rgb(", "rgba(").replace(")", ",0.18)") : "rgba(0,0,0,0.12)";
            }
            segs.push({ start, end, index, box, fill: color });
        });
        return segs;
        }

// =====================
// Canvas Regions Overlay + Editing (move/resize)
// =====================
const REGION_HANDLE_PX = 6;          // handle hit area in CSS pixels
const REGION_MIN_DUR = 0.12;         // seconds
const REGION_FPS = 25;               // snapping fps
const ALLOW_REGION_OVERLAP = true;   // true = segments may overlap in time
const AUTO_SCROLL_DURING_REGION_EDIT = false;

let regionDrag = null;
let suppressNextCanvasClick = false;

function updateWaveformCursor(e) {
  if (!canvas) return;

  // If currently dragging a region or panning the timeline
  if (regionDrag || isPanning) {
    canvas.style.cursor = "grabbing";
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const t = xToTime(x);

  const hit = hitTestRegion(t);
  if (!hit) {
    canvas.style.cursor = "grab";
    return;
  }

  const edgeThreshold = REGION_HANDLE_PX / pxPerSec; // seconds
  if (Math.abs(t - hit.start) <= edgeThreshold || Math.abs(t - hit.end) <= edgeThreshold) {
    canvas.style.cursor = "ew-resize";
  } else {
    canvas.style.cursor = "move";
  }
}
 // { box, index, mode, origStart, origEnd, grabOffsetSec }

function snapTime(t) {
    return Math.round(t * REGION_FPS) / REGION_FPS;
}

function drawRegionsOverlay(cssW, cssH) {
    const segments = getSegmentsFromDOM();
    if (!segments.length) return;

    const active = document.querySelector(".segment-box.active");

    for (const s of segments) {
        const x1 = timeToX(s.start);
        const x2 = timeToX(s.end);
        if (x2 < 0 || x1 > cssW) continue;

        const rx1 = Math.max(0, Math.min(cssW, x1));
        const rx2 = Math.max(0, Math.min(cssW, x2));
        const w = Math.max(1, rx2 - rx1);

        // fill
        ctx.fillStyle = s.fill;
        ctx.fillRect(rx1, 0, w, cssH);

        // outline
        ctx.strokeStyle = "rgba(0,0,0,0.16)";
        ctx.lineWidth = 1;
        ctx.strokeRect(rx1 + 0.5, 0.5, w - 1, cssH - 1);

        // handles
        ctx.fillStyle = "rgba(255,255,255,0.75)";
        ctx.fillRect(rx1, 0, 3, cssH);
        ctx.fillRect(rx2 - 3, 0, 3, cssH);

        // active highlight
        if (active && s.box === active) {
            ctx.strokeStyle = "rgba(229,57,53,0.95)";
            ctx.lineWidth = 2;
            ctx.strokeRect(rx1 + 1, 1, w - 2, cssH - 2);
            ctx.lineWidth = 1;
        }
    }
}




function getHitRegions(timeSec) {
  const EPS = 1e-9;
  const boundaryTol = Math.max(EPS, 0.75 / Math.max(pxPerSec || 1, 1)); // ~sub-pixel in time
  const all = getSegmentsFromDOM();

  // Boundary priority: if click is near a segment START, prefer that segment.
  // This fixes shared-boundary selection where prev.end === next.start.
  const nearStarts = all.filter(
    s => Math.abs(timeSec - s.start) <= boundaryTol
  );

  const segments = nearStarts.length
    ? nearStarts
    : all.filter(s => (timeSec + EPS) >= s.start && (timeSec + EPS) < s.end);

  segments.sort((a, b) => {
    if (a.start !== b.start) return b.start - a.start; // later-start first
    const da = a.end - a.start;
    const db = b.end - b.start;
    if (da !== db) return da - db;
    return b.index - a.index;
  });
  return segments;
}

function hitTestRegion(timeSec, cycleIfOverlap = false) {
  const hits = getHitRegions(timeSec);
  if (!hits.length) return null;
  if (!cycleIfOverlap || hits.length === 1) return hits[0];

  const active = document.querySelector(".segment-box.active");
  if (!active) return hits[0];

  const activeIdx = hits.findIndex(h => h.box === active);
  if (activeIdx === -1) return hits[0];
  return hits[(activeIdx + 1) % hits.length];
}

function updateSegmentTimesInDOM(box, startSec, endSec) {
    box.dataset.start = startSec.toFixed(6);
    box.dataset.end = endSec.toFixed(6);

    // Update timecode block
    const tc = box.querySelector(".timecode");
    if (tc) {
        const displayIndex = (parseInt(box.dataset.index, 10) + 1) || "";
        tc.innerHTML = `${displayIndex}<br />${formatTimecode(startSec)}<br />${formatTimecode(endSec)}`;
    }

    // Update dubbing panel live if this is active
    if (activeBox && activeBox === box) {
        const ds = document.getElementById("dubbing-start");
        const de = document.getElementById("dubbing-end");
        if (ds) ds.textContent = startSec.toFixed(2);
        if (de) de.textContent = endSec.toFixed(2);

        // keep adjusted preview numbers in sync (no pre/post roll)
        const as = document.getElementById("adjusted-start");
        const ae = document.getElementById("adjusted-end");
        if (as) as.textContent = Math.max(0, startSec).toFixed(2);
        if (ae) ae.textContent = endSec.toFixed(2);
    }

    // CPS recalculation if available
    try {
        updateCPS(parseInt(box.dataset.index, 10));
    } catch (e) {}
}

function commitSegmentTimes(box, startSec, endSec) {
    const index = parseInt(box.dataset.index, 10);

    // Keep UI consistent
    updateSegmentTimesInDOM(box, startSec, endSec);

    // Persist: save EN + AR with same timing
    const speaker = box.querySelector('.speaker-dropdown[data-lang="en"]')?.value || "";
    const enText = box.querySelector('textarea.edit-field[data-lang="en"]')?.value || "";
    const arText = box.querySelector('textarea.edit-field[data-lang="ar"]')?.value || "";

    (async () => {
        try {
            await saveSubtitle(index, "en", enText, speaker, startSec, endSec);
            await saveSubtitle(index, "ar", arText, speaker, startSec, endSec);
            console.log("✅ Region saved", { index, startSec, endSec });
        } catch (err) {
            console.warn("❌ Region save failed:", err);
        }
    })();
}

        // Better peak sampling: linear interpolation in time
        function peakAtTime(t) {
        if (!peaks.length || !Number.isFinite(t)) return 0;

        const pos = t / chunkSec;
        const i0 = Math.floor(pos);
        const i1 = i0 + 1;

        if (i0 < 0) return 0;
        if (i0 >= peaks.length) return 0;

        const p0 = peaks[i0] || 0;
        const p1 = peaks[i1] || p0;
        const frac = pos - i0;

        const p = p0 + (p1 - p0) * frac;
        return clamp(p, 0, 1);
        }

        function ensureScrollInBounds() {
        const visibleSec = (canvas.getBoundingClientRect().width / pxPerSec);
        const maxScroll = Math.max(0, durationSec - visibleSec);
        scrollSec = clamp(scrollSec, 0, maxScroll);
        }

        function centerOn(timeSec) {
        const rect = canvas.getBoundingClientRect();
        const visibleSec = rect.width / pxPerSec;
        scrollSec = timeSec - visibleSec / 2;
        ensureScrollInBounds();
        }

        // =====================
        // Canvas waveform section
        // =====================

        function draw() {
        const { cssW, cssH } = resizeCanvasHiDPI();
        ctx.clearRect(0, 0, cssW, cssH);

        // background
        ctx.fillStyle = "#f5f5f5";
        ctx.fillRect(0, 0, cssW, cssH);

        const midY = cssH / 2;

        // midline
        ctx.strokeStyle = "#d0d0d0";
        ctx.beginPath();
        ctx.moveTo(0, midY);
        ctx.lineTo(cssW, midY);
        ctx.stroke();


        // Regions overlay (segments)
        drawRegionsOverlay(cssW, cssH);

        // ✅ Accept either waveform format
        const wfMin = Array.isArray(window._wfMin) ? window._wfMin : null;
        const wfMax = Array.isArray(window._wfMax) ? window._wfMax : null;
        const hasMinMax = !!(wfMin && wfMax && wfMax.length > 0 && wfMin.length === wfMax.length);
        const hasPeaks = Array.isArray(peaks) && peaks.length > 0;

        if (!hasMinMax && !hasPeaks) {
            ctx.fillStyle = "#666";
            ctx.font = "12px sans-serif";
            ctx.fillText("Loading waveform…", 12, 18);
            return;
        }

        // --- Waveform rendering (min/max aggregation per pixel column) ---
        ctx.lineWidth = 1;
        ctx.strokeStyle = "#111";
        ctx.beginPath();

        const halfHeight = cssH * 0.48;
        const secondsPerPixel = 1 / pxPerSec;

        for (let x = 0; x < cssW; x++) {
            const t0Video = xToTime(x);
            const t1Video = t0Video + secondsPerPixel;
            const t0 = mapVideoToWaveformTime(t0Video);
            const t1 = mapVideoToWaveformTime(t1Video);

            const i0 = Math.max(0, Math.floor(t0 / chunkSec));
            const i1 = Math.max(i0, Math.floor(t1 / chunkSec));

            let minV = 0;
            let maxV = 0;

            if (hasMinMax) {
            const end = Math.min(wfMax.length - 1, i1);
            let mn = 0, mx = 0;
            for (let i = i0; i <= end; i++) {
                const a = wfMin[i] || 0;
                const b = wfMax[i] || 0;
                if (a < mn) mn = a;
                if (b > mx) mx = b;
            }
            minV = mn;
            maxV = mx;
            } else {
            const end = Math.min(peaks.length - 1, i1);
            let mx = 0;
            for (let i = i0; i <= end; i++) {
                const a = Math.abs(peaks[i] || 0);
                if (a > mx) mx = a;
            }
            minV = -mx;
            maxV = mx;
            }

            // Draw crisp 1px vertical bar
            const yTop = midY - (maxV * halfHeight);
            const yBot = midY - (minV * halfHeight);
            ctx.moveTo(x + 0.5, yTop);
            ctx.lineTo(x + 0.5, yBot);
        }

        ctx.stroke();

        // --- Playhead + optional follow ---
        if (video && Number.isFinite(video.currentTime)) {
            const playX = timeToX(video.currentTime);

            if (playX >= 0 && playX <= cssW) {
            ctx.strokeStyle = "#e53935";
            ctx.beginPath();
            ctx.moveTo(playX + 0.5, 0);
            ctx.lineTo(playX + 0.5, cssH);
            ctx.stroke();
            }

            // keep view following playback (but NOT while dragging)
            if (!regionDrag && !isPanning && video && Number.isFinite(video.currentTime)) {

            const edgePad = (cssW / pxPerSec) * 0.15;
            const viewLeft = scrollSec;
            const viewRight = scrollSec + (cssW / pxPerSec);

            if (
                video.currentTime < viewLeft + edgePad ||
                video.currentTime > viewRight - edgePad
            ) {
                centerOn(video.currentTime);
            }
            }
        }

        }

        // Render loop (start once)
        function startCanvasLoop() {
        const loop = () => {
            draw();
            requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
        }

        // Click: either select a region (segment) OR seek
        canvas.addEventListener("click", (e) => {
        if (suppressNextCanvasClick) {
            suppressNextCanvasClick = false;
            return;
        }
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const t = xToTime(x);

        const hit = hitTestRegion(t, true);

        if (hit) {
            if (typeof handleSegmentSelection === "function") {
            handleSegmentSelection(hit.box);
            } else {
            document.querySelectorAll(".segment-box").forEach(b => b.classList.remove("active"));
            hit.box.classList.add("active");
            centerSegmentInGrid(hit.box);
            }
            if (video) video.currentTime = hit.start;
            return;
        }

        if (video && Number.isFinite(t)) {
            video.currentTime = clamp(t, 0, video.duration || t);
        }
        });

// Mouse down: region edit (move/resize) OR pan

canvas.addEventListener("mousedown", (e) => {
  // Left button only
  if (e.button !== 0) return;

  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const t = xToTime(x);

  const hit = hitTestRegion(t, true);
  if (hit) {
    e.preventDefault();
    e.stopPropagation();
    suppressNextCanvasClick = true;

    // Select the segment + auto-scroll it into view
    if (typeof handleSegmentSelection === "function") {
      handleSegmentSelection(hit.box);
    } else {
      document.querySelectorAll(".segment-box").forEach(b => b.classList.remove("active"));
      hit.box.classList.add("active");
      activeBox = hit.box;
    }
    try { scrollToSegmentIndex(hit.index); } catch (err) {}

    // Determine drag mode (edge handles)
    const edgeThreshold = REGION_HANDLE_PX / pxPerSec; // seconds worth of handle pixels
    let mode = "move";
    if (Math.abs(t - hit.start) <= edgeThreshold) mode = "resize-left";
    else if (Math.abs(t - hit.end) <= edgeThreshold) mode = "resize-right";

    regionDrag = {
      box: hit.box,
      index: hit.index,
      mode,
      origStart: hit.start,
      origEnd: hit.end,
      mouseT0: t
    };


    canvas.style.cursor = "grabbing";

    return; // don\'t start panning
  }

  // Start panning if not editing a region
  isPanning = true;
  
  canvas.style.cursor = "grabbing";
panStartX = e.clientX;
  panStartScroll = scrollSec;
});

// Cursor UX for region edit / pan
canvas.style.cursor = "grab";
canvas.addEventListener("mousemove", updateWaveformCursor);
canvas.addEventListener("mouseleave", () => {
  if (!regionDrag && !isPanning) canvas.style.cursor = "default";
});




window.addEventListener("mousemove", (e) => {
  if (regionDrag) {
    canvas.style.cursor = "grabbing";

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    let t = xToTime(x);

    // Snap mouse time
    t = snapTime(t);

    const dur = regionDrag.origEnd - regionDrag.origStart;
    const delta = t - regionDrag.mouseT0;

    let newStart = regionDrag.origStart;
    let newEnd = regionDrag.origEnd;

    // ---- Candidate based on drag mode ----
    if (regionDrag.mode === "move") {
      newStart = regionDrag.origStart + delta;
      newEnd = newStart + dur;
    } else if (regionDrag.mode === "resize-left") {
      newStart = Math.min(regionDrag.origStart + delta, regionDrag.origEnd - REGION_MIN_DUR);
      newEnd = regionDrag.origEnd;
    } else if (regionDrag.mode === "resize-right") {
      newStart = regionDrag.origStart;
      newEnd = Math.max(regionDrag.origEnd + delta, regionDrag.origStart + REGION_MIN_DUR);
    }

    if (!ALLOW_REGION_OVERLAP) {
      // ---- Clamp to neighbors (NO overlap) ----
      const { prevEnd, nextStart } = getNeighborBounds(regionDrag.box);

      if (regionDrag.mode === "move") {
        const dur2 = dur;

        // if we don't have a next bound, just respect prev bound
        const minStart = prevEnd;
        const maxStart = (Number.isFinite(nextStart) ? (nextStart - dur2) : Infinity);

        // If there is no space between neighbors, lock the region in place
        if (Number.isFinite(maxStart) && maxStart < minStart) {
            newStart = regionDrag.origStart;
            newEnd = regionDrag.origEnd;
        } else {
            newStart = clamp(newStart, minStart, maxStart);
            newEnd = newStart + dur2;
        }
      } else {
        // resize-left / resize-right
        newStart = Math.max(newStart, prevEnd);
        newEnd = Math.min(newEnd, nextStart);

        // enforce min duration
        if (newEnd < newStart + REGION_MIN_DUR) {
            if (regionDrag.mode === "resize-left") {
              newStart = newEnd - REGION_MIN_DUR;
              newStart = Math.max(newStart, prevEnd);
            } else {
              newEnd = newStart + REGION_MIN_DUR;
              newEnd = Math.min(newEnd, nextStart);
            }
        }

        // final safety
        if (newEnd < newStart + REGION_MIN_DUR) {
            newEnd = newStart + REGION_MIN_DUR;
        }
      }
    } else {
      // Overlap mode: only enforce minimum duration.
      if (newEnd < newStart + REGION_MIN_DUR) {
        if (regionDrag.mode === "resize-left") {
          newStart = newEnd - REGION_MIN_DUR;
        } else {
          newEnd = newStart + REGION_MIN_DUR;
        }
      }
    }

    // ---- Clamp to timeline duration if known ----
    const maxT = (Number.isFinite(durationSec) && durationSec > 0)
      ? durationSec
      : (video?.duration || 0);

    if (maxT > 0) {
      if (regionDrag.mode === "move") {
        // preserve duration while clamping to [0, maxT]
        newStart = clamp(newStart, 0, maxT - dur);
        newEnd = newStart + dur;
      } else {
        newStart = clamp(newStart, 0, maxT);
        newEnd = clamp(newEnd, 0, maxT);

        if (newEnd < newStart + REGION_MIN_DUR) {
          newEnd = Math.min(maxT, newStart + REGION_MIN_DUR);
        }
      }
    }

    // ---- Snap final start/end (keeps clean frame alignment) ----
    newStart = snapTime(newStart);
    newEnd = snapTime(newEnd);

    // After snapping, re-enforce constraints.
    if (!ALLOW_REGION_OVERLAP) {
      const { prevEnd: p2, nextStart: n2 } = getNeighborBoundsByIndex(regionDrag.index);

      if (regionDrag.mode === "move") {
        const minStart = p2;
        const maxStart = n2 - dur;
        newStart = clamp(newStart, minStart, maxStart);
        newEnd = newStart + dur;
      } else {
        newStart = Math.max(newStart, p2);
        newEnd = Math.min(newEnd, n2);
        if (newEnd < newStart + REGION_MIN_DUR) newEnd = newStart + REGION_MIN_DUR;
      }
    }

    if (maxT > 0) {
      if (regionDrag.mode === "move") {
        newStart = clamp(newStart, 0, maxT - dur);
        newEnd = newStart + dur;
      } else {
        newStart = clamp(newStart, 0, maxT);
        newEnd = clamp(newEnd, 0, maxT);
        if (newEnd < newStart + REGION_MIN_DUR) newEnd = Math.min(maxT, newStart + REGION_MIN_DUR);
      }
    }

    updateSegmentTimesInDOM(regionDrag.box, newStart, newEnd);

    // Optional auto-scroll while editing (disabled by default)
    if (AUTO_SCROLL_DURING_REGION_EDIT) {
      try { scrollToSegmentIndex(regionDrag.index); } catch (err) {}
    }

    // Scrub video while editing:
    // - move / resize-left -> follow start
    // - resize-right -> follow end
    if (video) {
      if (regionDrag.mode === "resize-right") {
        video.currentTime = newEnd;
      } else {
        video.currentTime = newStart;
      }
    }

    ensureScrollInBounds();
    return;
  }

  if (!isPanning) return;
  const dx = (e.clientX - panStartX);
  scrollSec = panStartScroll - (dx / pxPerSec);
  ensureScrollInBounds();
});

window.addEventListener("mouseup", () => {
  if (regionDrag) {
    const box = regionDrag.box;
    const startSec = parseFloat(box.dataset.start);
    const endSec = parseFloat(box.dataset.end);

    commitSegmentTimes(box, startSec, endSec);
    regionDrag = null;
  }

  isPanning = false;
  canvas.style.cursor = "grab";
});


// Wheel zoom around cursor
        canvas.addEventListener("wheel", (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseT = xToTime(mouseX);

        const zoomFactor = e.deltaY < 0 ? 1.15 : 0.87;
        pxPerSec = clamp(pxPerSec * zoomFactor, 20, 600);

        // keep mouse time under cursor
        scrollSec = mouseT - (mouseX / pxPerSec);
        ensureScrollInBounds();
        }, { passive: false });

        // Hook your existing zoom buttons
        window.zoomIn = () => {
        pxPerSec = clamp(pxPerSec * 1.25, 20, 600);
        ensureScrollInBounds();
        };
        window.zoomOut = () => {
        pxPerSec = clamp(pxPerSec / 1.25, 20, 600);
        ensureScrollInBounds();
        };

        // Load peaks from your endpoint
        const WF_CACHE_VERSION = "v4";
        const WF_EXPECTED_SAMPLE_RATE = 22050;
        const WF_EXPECTED_CHUNK_SEC = 0.005;
        const waveformCacheKey = `waveform_${project}_${episode}_${WF_CACHE_VERSION}`;
        const wfUrl = `/waveform_json/${encodeURIComponent(project)}/${encodeURIComponent(episode)}`;
        const WAVEFORM_CACHE_MAX_CHARS = 3_500_000; // ~3.5MB safety for localStorage
        let waveformCacheSkipLogged = false;

        function compactWaveformForCache(data, maxChars) {
            const srcMin = Array.isArray(data?.peaks_min) ? data.peaks_min : null;
            const srcMax = Array.isArray(data?.peaks_max) ? data.peaks_max : null;
            if (!srcMin || !srcMax || srcMin.length === 0 || srcMin.length !== srcMax.length) {
                return null;
            }

            const baseChunk = Number(data.chunk_duration_sec);
            const chunk = Number.isFinite(baseChunk) && baseChunk > 0 ? baseChunk : 0.005;
            let stride = 2;

            while (stride <= 64) {
                const outMin = [];
                const outMax = [];
                for (let i = 0; i < srcMin.length; i += stride) {
                    outMin.push(Math.round((Number(srcMin[i]) || 0) * 1000) / 1000);
                    outMax.push(Math.round((Number(srcMax[i]) || 0) * 1000) / 1000);
                }

                const compact = {
                    ...data,
                    peaks_min: outMin,
                    peaks_max: outMax,
                    chunk_duration_sec: chunk * stride,
                    cache_compacted: true,
                    cache_compact_stride: stride
                };
                const compactRaw = JSON.stringify(compact);
                if (compactRaw.length <= maxChars) {
                    return { raw: compactRaw, stride, chars: compactRaw.length };
                }
                stride *= 2;
            }
            return null;
        }

        function tryCacheWaveform(data) {
            try {
                const compactFirst = compactWaveformForCache(data, WAVEFORM_CACHE_MAX_CHARS);
                if (compactFirst) {
                    localStorage.setItem(waveformCacheKey, compactFirst.raw);
                    if (!waveformCacheSkipLogged) {
                        waveformCacheSkipLogged = true;
                        console.info(
                            `Waveform cache compacted (stride x${compactFirst.stride}, ${compactFirst.chars.toLocaleString()} chars).`
                        );
                    }
                    return;
                }

                const raw = JSON.stringify(data);
                if (raw.length > WAVEFORM_CACHE_MAX_CHARS) {
                    if (!waveformCacheSkipLogged) {
                        waveformCacheSkipLogged = true;
                        console.info("Waveform cache disabled for this episode (payload too large).");
                    }
                    return;
                }
                localStorage.setItem(waveformCacheKey, raw);
            } catch (e) {
                console.warn("Waveform cache skipped:", e);
            }
        }

        const cachedWaveform = localStorage.getItem(waveformCacheKey);

        if (cachedWaveform) {
            try {
                const data = JSON.parse(cachedWaveform);
                const sr = Number(data.sample_rate);
                const cs = Number(data.chunk_duration_sec);
                const isCompactedCache = !!data.cache_compacted;
                const isLowRes = (!Number.isFinite(sr) || sr < WF_EXPECTED_SAMPLE_RATE)
                    || (!Number.isFinite(cs) || (!isCompactedCache && cs > WF_EXPECTED_CHUNK_SEC));

                if (isLowRes) {
                    localStorage.removeItem(waveformCacheKey);
                    loadWaveformFromServer();
                    return;
                }

                const peaksMin = Array.isArray(data.peaks_min) ? data.peaks_min : null;
                const peaksMax = Array.isArray(data.peaks_max) ? data.peaks_max : null;

                chunkSec = Number.isFinite(data.chunk_duration_sec) ? data.chunk_duration_sec : 0.02;

                if (peaksMin && peaksMax && peaksMin.length > 0 && peaksMin.length === peaksMax.length) {
                    window._wfMin = peaksMin;
                    window._wfMax = peaksMax;
                    peaks = [];
                    waveformDurationSec = peaksMax.length * chunkSec;
                    updateDurationMapping();
                } else {
                    window._wfMin = null;
                    window._wfMax = null;
                    peaks = Array.isArray(data.peaks) ? data.peaks : [];
                    waveformDurationSec = peaks.length * chunkSec;
                    updateDurationMapping();
                }

                centerOn(video?.currentTime || 0);
                console.log("📈 Waveform loaded from local cache");
            } catch (e) {
                console.warn("Bad cached waveform, refetching...", e);
                localStorage.removeItem(waveformCacheKey);
                loadWaveformFromServer();
            }
        } else {
            loadWaveformFromServer();
        }

        function loadWaveformFromServer() {
            fetch(wfUrl)
                .then(r => r.json())
                .then(data => {
                    try {
                    tryCacheWaveform(data);
                    } catch (e) {
                        // If waveform is too large for storage quota, just skip caching.
                        console.warn("Waveform cache skipped:", e);
                    }

                    const peaksMin = Array.isArray(data.peaks_min) ? data.peaks_min : null;
                    const peaksMax = Array.isArray(data.peaks_max) ? data.peaks_max : null;

                    chunkSec = Number.isFinite(data.chunk_duration_sec) ? data.chunk_duration_sec : 0.02;

                    if (peaksMin && peaksMax && peaksMin.length > 0 && peaksMin.length === peaksMax.length) {
                        window._wfMin = peaksMin;
                        window._wfMax = peaksMax;
                        peaks = [];
                    waveformDurationSec = peaksMax.length * chunkSec;
                    updateDurationMapping();
                } else {
                    window._wfMin = null;
                    window._wfMax = null;
                    peaks = Array.isArray(data.peaks) ? data.peaks : [];
                    waveformDurationSec = peaks.length * chunkSec;
                    updateDurationMapping();
                }

                    centerOn(video?.currentTime || 0);
                    console.log("📈 Waveform loaded from server");
                })
                .catch(err => console.warn("Waveform JSON failed:", err));
        }

        // Start loop once, and redraw on resize
        if (video) {
            video.addEventListener("loadedmetadata", () => {
                updateDurationMapping();
            });
        }
        startCanvasLoop();
        window.addEventListener("resize", () => draw());

        // Keep the rest of your app init
        initializeFrameTimecode();
        initializeSpeakerDropdowns();
        initializeDubbingPanel();
        initializeColumnToggles();
        initializeSpeakerFilter();
        initializeRealTimeEditing();
        initializeCPSCalculation();

        console.log("✅ Main application initialized");

        function initializeSpeakerDropdowns() {
            // Handle speaker dropdown changes
            document.querySelectorAll('.speaker-dropdown').forEach(dropdown => {
                if (dropdown.dataset.mainSpeakerBound === "1") return;
                dropdown.dataset.mainSpeakerBound = "1";

                dropdown.addEventListener('change', function(e) {
                    const index = this.dataset.index;
                    const lang = this.dataset.lang;
                    const newSpeaker = this.value;
                    
                    if (newSpeaker === '+add_new') {
                        showAddSpeakerDialog(index, lang);
                        this.value = this.dataset.original; // Reset to original value
                        return;
                    }
                    
                    // Update the speaker in the segment
                    updateSpeaker(index, "en", newSpeaker);   // ✅ always save EN only
                    applySpeakerEverywhere(index, newSpeaker); // ✅ mirror + color sync
                    
                    // Update the header background color if needed
                    updateSpeakerColor(this.closest('.segment-header'), newSpeaker);
                    
                    // Update Arabic speaker name
                    updateArabicSpeaker(index, newSpeaker);
                    
                    // Update speaker filter dropdown if needed
                    updateSpeakerFilter(newSpeaker);
                    
                    // Update the original value
                    this.dataset.original = newSpeaker;
                });
            });
        }
        window.initializeSpeakerDropdowns = initializeSpeakerDropdowns;


        function applySpeakerEverywhere(index, englishSpeaker) {
            // 1) Mirror name to Arabic (clean, no duplication)
            const arabicElement = document.querySelector(
                `.segment-box[data-index="${index}"] .arabic-speaker-name`
            );
            if (arabicElement) {
                arabicElement.textContent = speakerNameMapping[englishSpeaker] || englishSpeaker;
            }

            // 2) Apply color to BOTH headers
            const enHeader = document
                .querySelector(`.speaker-dropdown[data-index="${index}"][data-lang="en"]`)
                ?.closest(".segment-header");

            const arHeader = document
                .querySelector(`.segment-box[data-index="${index}"] .segment-col.ar .segment-header`);

            if (enHeader) updateSpeakerColor(enHeader, englishSpeaker);
            if (arHeader) updateSpeakerColor(arHeader, englishSpeaker);
        }




        // Fixed region control functions
        function toggleRegions() {
            const regionStatus = document.getElementById('region-status');
            const hasRegions = regions.some(region => region !== undefined && region !== null);
            
            if (hasRegions) {
                // Hide regions
                waveform.clearRegions();
                regions = []; // Clear our regions array
                regionStatus.textContent = 'Regions: Hidden';
                regionStatus.style.color = '#999';
                console.log('Regions hidden');
            } else {
                // Show regions
                initializeWaveformRegions();
                regionStatus.textContent = 'Regions: Visible';
                regionStatus.style.color = '#28a745';
                console.log('Regions shown');
            }
        }

        function fitAllRegionsToView() {
            const hasRegions = regions.some(region => region !== undefined && region !== null);
            
            if (!hasRegions) {
                alert('No regions to fit. Please enable regions first.');
                return;
            }
            
            let minStart = Number.MAX_VALUE;
            let maxEnd = 0;
            let validRegions = 0;
            
            regions.forEach(region => {
                if (region) {
                    if (region.start < minStart) minStart = region.start;
                    if (region.end > maxEnd) maxEnd = region.end;
                    validRegions++;
                }
            });
            
            if (validRegions > 0 && minStart < Number.MAX_VALUE && maxEnd > 0) {
                const duration = maxEnd - minStart;
                const padding = duration * 0.1; // 10% padding
                waveform.zoom((waveform.getDuration() / (duration + padding * 2)) * 0.9);
                waveform.setScroll(Math.max(0, minStart - padding));
                console.log(`Fitted ${validRegions} regions to view`);
            }
        }

        // Enhanced region initialization - using text content instead of speaker names
        function initializeWaveformRegions() {
            // Clear existing regions
            waveform.clearRegions();
            regions = []; // Reset the regions array

            console.log("Initializing waveform regions with text content...");

            // Create regions for each segment
            document.querySelectorAll(".segment-box").forEach(box => {
                const index = parseInt(box.dataset.index);
                const start = parseFloat(box.dataset.start);
                const end = parseFloat(box.dataset.end);
                
                // Get speaker from the selected option in the dropdown
                const speakerDropdown = box.querySelector(".speaker-dropdown");
                let speaker = "Unknown";
                
                if (speakerDropdown) {
                    speaker = speakerDropdown.value;
                }

                // Get text content from English textarea
                const enTextarea = box.querySelector('textarea[data-lang="en"]');
                let displayText = "No text";
                
                if (enTextarea && enTextarea.value.trim()) {
                    displayText = enTextarea.value.trim();
                }

                if (waveform && !isNaN(start) && !isNaN(end) && start < end) {
                    // Get the EXACT SAME color as the speaker header
                    const header = box.querySelector(".segment-header");
                    let speakerColor = "#3498db"; // default blue
                    
                    if (header) {
                        // Extract the background color from the header
                        const computedStyle = window.getComputedStyle(header);
                        speakerColor = computedStyle.backgroundColor;
                        
                        // If it's rgba, convert to hex for consistency
                        if (speakerColor.startsWith('rgba') || speakerColor.startsWith('rgb')) {
                            speakerColor = rgbToHex(speakerColor);
                        }
                    }
                    
                    const regionColor = hexToRgba(speakerColor, 0.4); // Convert to rgba with transparency

                    console.log(`Segment ${index}: Text="${displayText}", Color="${speakerColor}"`);

                    const region = waveform.addRegion({
                        id: `segment-${index}`,
                        start: start,
                        end: end,
                        color: regionColor,
                        drag: true,
                        resize: true,
                        minLength: 0.1,
                        channelIdx: 0
                    });

                    // Store region reference
                    regions[index] = region;


                    // Handle text direction in the label (NO MIRRORING)
                    const label = region.element.querySelector('.region-text-label');
                    if (label) {
                        if (/[\u0600-\u06FF]/.test(displayText)) {
                            label.style.direction = 'rtl';
                            label.style.textAlign = 'right';
                        } else {
                            label.style.direction = 'ltr';
                            label.style.textAlign = 'left';
                        }
                        // Remove any mirror transforms
                        label.style.transform = 'none';
                    }

                    // Remove mirror from region element
                    region.element.style.transform = 'none';

                    // Region event listeners
                    region.on('update', () => {
                        if (!isRegionDragging) {
                            isRegionDragging = true;
                        }
                        handleRegionUpdate(index, region.start, region.end);
                        
                        // Update text label in real-time during resize
                        updateRegionTextLabel(index);
                    });

                    region.on('update-end', () => {
                        isRegionDragging = false;
                        saveRegionChanges(index, region.start, region.end);
                        
                        // Final text label update after resize complete
                        updateRegionTextLabel(index);
                    });

                    region.on('click', (e) => {
                        e.stopPropagation();
                        
                        // Highlight corresponding segment in grid
                        document.querySelectorAll(".segment-box").forEach(b => b.classList.remove("active"));
                        box.classList.add("active");
                        activeBox = box;

                        // Scroll to segment in grid
                        box.scrollIntoView({ behavior: 'smooth', block: 'center' });

                        // Update dubbing panel
                        document.getElementById("dubbing-speaker").textContent = speaker;
                        document.getElementById("dubbing-start").textContent = region.start.toFixed(2);
                        document.getElementById("dubbing-end").textContent = region.end.toFixed(2);

                        // Update adjusted times (no pre/post roll)
                        const adjustedStart = Math.max(0, region.start);
                        const adjustedEnd = region.end;

                        document.getElementById("adjusted-start").textContent = adjustedStart.toFixed(2);
                        document.getElementById("adjusted-end").textContent = adjustedEnd.toFixed(2);

                        // Seek video to exact region start
                        if (video) {
                            video.currentTime = region.start;
                        }
                    });
                }
            });
            
            console.log(`Initialized ${regions.filter(r => r).length} regions with text content`);
        }

        /* Segment insertion helpers moved to /static/js/index_new9/segments.js */

/* Waveform helpers moved to /static/js/index_new9/waveform.js */

function autoResizeTextarea(el) {
        if (!el) return;
        el.style.height = "auto";                 // reset first
        el.style.height = (el.scrollHeight) + "px"; // then expand to content
        }        

        document.querySelectorAll("textarea.edit-field").forEach(textarea => {
        // NEW: resize once on load
        autoResizeTextarea(textarea);

        textarea.addEventListener("input", function() {
            // NEW: resize as user types
            autoResizeTextarea(this);

            const index = this.dataset.index;
            const newText = this.value;

            // Only update the region text visually - no WebSocket sending
            rememberLastEditedSegment(index);
            updateRegionTextOnEdit(index, newText);
        });
        });

        function handleRegionUpdate(index, newStart, newEnd) {
            // Update the segment box data attributes in real-time
            const box = document.querySelector(`.segment-box[data-index="${index}"]`);
            if (box) {
                box.dataset.start = newStart.toFixed(6);
                box.dataset.end = newEnd.toFixed(6);
                
                // Update timecode display
                const timecodeElement = box.querySelector(".timecode");
                if (timecodeElement) {
                    const children = timecodeElement.children;
                    if (children.length >= 3) {
                        children[1].textContent = formatTimecode(newStart);
                        children[2].textContent = formatTimecode(newEnd);
                    }
                }

                // Update CPS calculation
                updateCPS(index);
                
                // Update region text label on resize
                updateRegionTextLabel(index);
                
                // Live update dubbing panel if this is the active segment
                if (activeBox && parseInt(activeBox.dataset.index) === index) {
                    updateDubbingPanelLive(index, newStart, newEnd);
                }
            }
        }

        // Live update dubbing panel during region resize
        function updateDubbingPanelLive(index, newStart, newEnd) {
            document.getElementById("dubbing-start").textContent = newStart.toFixed(2);
            document.getElementById("dubbing-end").textContent = newEnd.toFixed(2);

            // No pre/post roll anymore
            document.getElementById("adjusted-start").textContent = newStart.toFixed(2);
            document.getElementById("adjusted-end").textContent = newEnd.toFixed(2);

            updateScrollingTextDuration(newStart, newEnd);

            console.log(`Live update: Segment ${index} → ${newStart.toFixed(2)}-${newEnd.toFixed(2)}`);
        }

        async function saveRegionChanges(index, newStart, newEnd) {
            console.log(`Saving region changes for segment ${index}: ${newStart.toFixed(2)} -> ${newEnd.toFixed(2)}`);
            
            // Save to server for both English and Arabic using unified endpoint
            const promises = ['en', 'ar'].map(async lang => {
                const textarea = document.querySelector(`textarea[data-index="${index}"][data-lang="${lang}"]`);
                const speakerDropdown = document.querySelector(`.speaker-dropdown[data-index="${index}"][data-lang="${lang}"]`);
                
                const text = textarea?.value || "";
                const speaker = speakerDropdown?.value || "";
                
                return saveSubtitle(index, lang, text, speaker, newStart.toFixed(6), newEnd.toFixed(6));
            });

            try {
                await Promise.all(promises);
                console.log('Region changes saved successfully');
            } catch (error) {
                console.error('Error saving region changes:', error);
            }
        }

    function addNewSpeaker(enName, arName, index, lang) {
        // Store mapping (Arabic optional, but no duplication formatting)
        speakerNameMapping[enName] = arName || enName;

        // Add new option to all English dropdowns (avoid duplicates)
        document.querySelectorAll('.speaker-dropdown').forEach(dropdown => {
            const exists = Array.from(dropdown.options).some(opt => opt.value === enName);
            if (!exists) {
                const option = document.createElement('option');
                option.value = enName;
                option.textContent = enName;
                dropdown.insertBefore(option, dropdown.lastElementChild);
            }
        });

        // Update filter dropdown
        updateSpeakerFilter(enName);

        // ✅ Update English speaker (this triggers save)
        updateSpeaker(index, "en", enName);

        // ✅ Mirror to Arabic visually ONLY (no duplication formatting)
        const arabicElement = document.querySelector(
            `.segment-box[data-index="${index}"] .arabic-speaker-name`
        );

        if (arabicElement) {
            arabicElement.textContent = speakerNameMapping[enName];

            const arabicHeader = arabicElement.closest('.segment-header');
            if (arabicHeader) {
                updateSpeakerColor(arabicHeader, enName);
            }
        }

        // Set English dropdown value
        const dropdown = document.querySelector(
            `.speaker-dropdown[data-index="${index}"][data-lang="en"]`
        );

        if (dropdown) {
            dropdown.value = enName;
            dropdown.dataset.original = enName;
        }
    }

        function updateSpeaker(index, lang, speaker) {
            console.log(`Updating speaker for segment ${index}, ${lang} to: ${speaker}`);
            
            // Get current text and timecodes
            const box = document.querySelector(`.segment-box[data-index="${index}"]`);
            const textarea = document.querySelector(`textarea[data-index="${index}"][data-lang="${lang}"]`);
            const text = textarea?.value || "";
            const start = parseFloat(box?.dataset.start || "0").toFixed(6);
            const end = parseFloat(box?.dataset.end || "0").toFixed(6);

            // Use unified save endpoint
            saveSubtitle(index, lang, text, speaker, start, end)
                .then(data => {
                    if (data.status === "ok") {
                        console.log('Speaker updated successfully');
                        
                        // Update the region color and label if regions are visible
                        if (regions[index]) {
                            // Get the color from the updated header
                            const header = document.querySelector(`.segment-box[data-index="${index}"] .segment-header`);
                            let speakerColor = "#3498db";
                            
                            if (header) {
                                const computedStyle = window.getComputedStyle(header);
                                speakerColor = computedStyle.backgroundColor;
                                
                                if (speakerColor.startsWith('rgba') || speakerColor.startsWith('rgb')) {
                                    speakerColor = rgbToHex(speakerColor);
                                }
                            }
                            
                            const regionColor = hexToRgba(speakerColor, 0.4);
                            
                            regions[index].update({
                                color: regionColor
                            });
                            
                            // Update the label
                            addSpeakerLabelToRegion(regions[index], speaker);
                            console.log(`Updated region ${index} to speaker "${speaker}" with color ${speakerColor}`);
                        }
                        
                        // Update the header background color
                        const header = document.querySelector(`.speaker-dropdown[data-index="${index}"][data-lang="${lang}"]`)?.closest('.segment-header');
                        if (header) {
                            updateSpeakerColor(header, speaker);
                        }
                        
                        // Update Arabic speaker name
                        updateArabicSpeaker(index, speaker);
                    }
                })
                .catch(error => {
                    console.error('Error updating speaker:', error);
                });
        }

        function updateArabicSpeaker(index, englishSpeaker) {
        const arabicElement = document.querySelector(`.segment-box[data-index="${index}"] .arabic-speaker-name`);
        if (!arabicElement) return;

        arabicElement.textContent = speakerNameMapping[englishSpeaker] || englishSpeaker;

        const arabicHeader = arabicElement.closest('.segment-header');
        if (arabicHeader) updateSpeakerColor(arabicHeader, englishSpeaker);
        }

        function updateSpeakerColor(headerElement, speaker) {
            const color = getSpeakerColor(speaker);
            headerElement.style.backgroundColor = color;
        }

        function updateSpeakerFilter(newSpeaker) {
            const speakerFilter = document.getElementById('speaker-filter');
            const existingOptions = Array.from(speakerFilter.options).map(opt => opt.value);
            
            if (!existingOptions.includes(newSpeaker)) {
                const option = document.createElement('option');
                option.value = newSpeaker;
                option.textContent = newSpeaker;
                speakerFilter.appendChild(option);
            }
        }

        // Function to visually set segment done state
        function setSegmentDoneState(index, isDone) {
            const box = document.querySelector(`.segment-box[data-index="${index}"]`);
            if (!box) return;
            
            if (isDone) {
                box.classList.add("done");
                
                // Add done badge if not exists
                if (!box.querySelector('.done-badge')) {
                    const badge = document.createElement('div');
                    badge.className = 'done-badge';
                    badge.textContent = 'DONE';
                    badge.title = 'This segment is marked as completed';
                    box.appendChild(badge);
                }
                
                // Disable editing
                const textareas = box.querySelectorAll('.edit-field');
                const dropdowns = box.querySelectorAll('.speaker-dropdown');
                
                textareas.forEach(textarea => {
                    textarea.disabled = true;
                    textarea.title = 'Segment completed - editing disabled';
                });
                
                dropdowns.forEach(dropdown => {
                    dropdown.disabled = true;
                    dropdown.title = 'Segment completed - editing disabled';
                });
                
            } else {
                box.classList.remove("done");
                
                // Remove done badge
                const badge = box.querySelector('.done-badge');
                if (badge) {
                    badge.remove();
                }
                
                // Enable editing
                const textareas = box.querySelectorAll('.edit-field');
                const dropdowns = box.querySelectorAll('.speaker-dropdown');
                
                textareas.forEach(textarea => {
                    textarea.disabled = false;
                    textarea.title = '';
                });
                
                dropdowns.forEach(dropdown => {
                    dropdown.disabled = false;
                    dropdown.title = '';
                });
            }
        }

        // Function to save done state to server
        async function saveDoneState(index, isDone) {
            try {
                const formData = new FormData();
                formData.append('project', project);
                formData.append('episode', episode);
                formData.append('index', index);
                formData.append('is_done', isDone.toString());
                
                const response = await fetch('/save_done_state', {
                    method: 'POST',
                    body: formData
                });
                
                const result = await response.json();
                
                if (result.status === 'ok') {
                    console.log(`Segment ${index} marked as ${isDone ? 'done' : 'not done'}`);
                } else {
                    console.error('Failed to save done state:', result.message);
                }
            } catch (error) {
                console.error('Error saving done state:', error);
            }
        }

        // Function to load done states
        async function loadDoneState() {
            try {
                const response = await fetch(`/get_done_states?project=${encodeURIComponent(project)}&episode=${encodeURIComponent(episode)}`);
                const result = await response.json();
                
                if (result.status === 'ok' && result.done_states) {
                    result.done_states.forEach(doneState => {
                        if (doneState.is_done) {
                            setSegmentDoneState(doneState.index, true);
                        }
                    });
                    
                    // Update any active segment's checkbox state
                    if (activeBox) {
                        updateDoneCheckboxState(activeBox);
                    }
                }
            } catch (error) {
                console.error('Error loading done states:', error);
            }
        }

        // Also add this helper function for updating the checkbox state
        function updateDoneCheckboxState(box) {
            const doneCheckbox = document.getElementById("segment-done-checkbox");
            if (!doneCheckbox) return;
            
            const index = parseInt(box.dataset.index);
            const isDone = box.classList.contains("done");
            
            doneCheckbox.checked = isDone;
            
            // Enable/disable recording buttons based on done state
            const startRecordingBtn = document.getElementById("start-recording");
            const previewBtn = document.getElementById("preview-btn");
            
            if (startRecordingBtn && previewBtn) {
                startRecordingBtn.disabled = isDone;
                previewBtn.disabled = isDone;
                
                if (isDone) {
                    startRecordingBtn.title = "Segment completed - recording disabled";
                    previewBtn.title = "Segment completed - preview disabled";
                } else {
                    startRecordingBtn.title = "";
                    previewBtn.title = "";
                }
            }
        }        

        function initializeDubbingPanel() {
            const startRecordingBtn = document.getElementById("start-recording");
            const stopRecordingBtn = document.getElementById("stop-recording");
            const previewBtn = document.getElementById("preview-btn");
            const waveformCursor = document.getElementById("waveform-cursor");
            const waveformTrack = document.getElementById("waveform-timeline");
            const doneCheckbox = document.getElementById("segment-done-checkbox");

            window.gumStream = null;
            recorder = null;
            let miniWave = null;





            // Handle done checkbox changes
            doneCheckbox.addEventListener("change", function() {
                if (activeBox) {
                    const index = parseInt(activeBox.dataset.index);
                    const isDone = this.checked;
                    
                    setSegmentDoneState(index, isDone);
                    saveDoneState(index, isDone);
                }
            });

            // Function to update the done checkbox based on segment state
            function updateDoneCheckboxState(box) {
                const index = parseInt(box.dataset.index);
                const isDone = box.classList.contains("done");
                
                doneCheckbox.checked = isDone;
                
                // Enable/disable recording buttons based on done state
                startRecordingBtn.disabled = isDone;
                previewBtn.disabled = isDone;
                
                if (isDone) {
                    startRecordingBtn.title = "Segment completed - recording disabled";
                    previewBtn.title = "Segment completed - preview disabled";
                } else {
                    startRecordingBtn.title = "";
                    previewBtn.title = "";
                }
            }


            // Video timeupdate listener - auto-highlight segments
            video.addEventListener("timeupdate", () => {
                const current = video.currentTime;
                
                // UPDATE TIME DISPLAY WITH TIMECODE FORMAT
                const currentTimeElement = document.getElementById("currentTime");
                if (currentTimeElement) {
                    currentTimeElement.textContent = formatTimecode(current);
                }

                // Auto-highlight segment during general playback (skip done segments)
                if (isManualPlayback) {
                    const boxes = document.querySelectorAll(".segment-box:not(.done)");
                    let newActiveBox = null;

                    // If currently selected segment still contains current time,
                    // keep it selected. This prevents overlap clicks from being
                    // immediately overridden by first-match scanning.
                    if (activeBox && !activeBox.classList.contains("done")) {
                        const aStart = parseFloat(activeBox.dataset.start);
                        const aEnd = parseFloat(activeBox.dataset.end);
                        if (
                            Number.isFinite(aStart) &&
                            Number.isFinite(aEnd) &&
                            current >= aStart &&
                            current < aEnd
                        ) {
                            newActiveBox = activeBox;
                        }
                    }
                     
                    if (!newActiveBox) {
                        for (let i = 0; i < boxes.length; i++) {
                            const box = boxes[i];
                            const start = parseFloat(box.dataset.start);
                            const end = parseFloat(box.dataset.end);

                            if (current >= start && current < end) {
                                newActiveBox = box;
                                break;
                            }
                        }
                    }

                    // If switching to a new segment, save the current one
                    if (newActiveBox && newActiveBox !== activeBox) {
                        const previousIndex = activeBox ? parseInt(activeBox.dataset.index, 10) : -1;
                        try {
                            if (activeBox && !activeBox.classList.contains("done")) {
                                if (typeof saveCurrentSegmentText === "function") {
                                    saveCurrentSegmentText();
                                }
                            }
                        } catch (e) {
                            console.warn("saveCurrentSegmentText failed:", e);
                        }
                        
                        if (activeBox) activeBox.classList.remove("active");
                        activeBox = newActiveBox;
                        activeBox.classList.add("active");
                        const currentIndex = parseInt(activeBox.dataset.index, 10);
                        if (
                            Number.isFinite(previousIndex) &&
                            Number.isFinite(currentIndex) &&
                            previousIndex !== currentIndex &&
                            typeof window.resetTtsEmotionAndEffectsControls === "function"
                        ) {
                            window.resetTtsEmotionAndEffectsControls();
                        }

                        // Update done checkbox state for new active segment
                        updateDoneCheckboxState(activeBox);

                        const start = parseFloat(activeBox.dataset.start);
                        const end = parseFloat(activeBox.dataset.end);
                        const text = activeBox.querySelector('textarea[data-lang="en"]')?.value || "";
                        const duration = end - start;
                        scrollText(text, duration);

                        // Auto-scroll to active segment
                        const segmentPanel = document.querySelector(".segment-panel");
                        segmentPanel.scrollTop = activeBox.offsetTop - segmentPanel.offsetTop - segmentPanel.clientHeight / 2 + activeBox.clientHeight / 2;
                    }
                }
                // Stop recording if needed
                if (typeof recordingEndTime === "number" && !isNaN(recordingEndTime) && 
                    current >= recordingEndTime && !isRecordingStopping) {
                    isRecordingStopping = true;
                    isManualPlayback = false;
                    (async () => {
                        await stopRecordingAndVideo();
                        recordingEndTime = null;
                        isRecordingStopping = false;
                    })();
                }

                // Cursor movement
                // Cursor movement (exact segment only)
                const start = parseFloat(document.getElementById("adjusted-start").textContent || "0");
                const end = parseFloat(document.getElementById("adjusted-end").textContent || "0");
                const duration = Math.max(0.001, end - start);
                const elapsed = current - start;
                const percent = Math.min(1, Math.max(0, elapsed / duration));
                const trackWidth = waveformTrack.clientWidth;

                if (current >= start && current < end) {
                    waveformCursor.style.display = "block";
                    waveformCursor.style.left = `${percent * trackWidth}px`;
                } else {
                    waveformCursor.style.display = "none";
                }
            });

            // Start recording
            startRecordingBtn.addEventListener("click", async () => {
                if (activeBox && activeBox.classList.contains("done")) {
                    alert("This segment is marked as completed and cannot be recorded.");
                    return;
                }

                const start = parseFloat(document.getElementById("dubbing-start").textContent);
                const end = parseFloat(document.getElementById("dubbing-end").textContent);

                // No pre/post roll anymore
                const adjustedStart = start;
                const adjustedEnd = end;

                const cursorDuration = adjustedEnd - adjustedStart;
                const scrollDuration = end - start;
                const trackWidth = waveformTrack.clientWidth;

                const box = document.querySelector(".segment-box.active");
                if (!box) {
                    alert("No segment selected for recording.");
                    return;
                }
                const text = box.querySelector('textarea[data-lang="en"]')?.value || "";

                scrollText(text, scrollDuration);
                recordingEndTime = adjustedEnd;
                isManualPlayback = false;

                try {
                    const stream = await navigator.mediaDevices.getUserMedia({
                        audio: {
                            sampleRate: 48000,
                            channelCount: 1,
                            echoCancellation: false,
                            noiseSuppression: false,
                            autoGainControl: true
                        }
                    });

                    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                    const input = audioContext.createMediaStreamSource(stream);
                    window.gumStream = stream;
                    recorder = new Recorder(input, { numChannels: 1 });

                    document.getElementById("start-recording").disabled = true;
                    document.getElementById("stop-recording").disabled = false;
                    video.currentTime = adjustedStart;
                    video.pause();
                    video.volume = 0.1;

                    waveformCursor.style.display = "block";
                    waveformCursor.style.left = "0px";

                    setTimeout(() => {
                        video.play();
                        startScrollText();
                        animateCursor(cursorDuration, trackWidth);
                        recorder.record();
                    }, 800);

                } catch (error) {
                    console.error("Error starting recording:", error);
                    alert("Error accessing microphone. Please check permissions.");
                }
            });

            // Stop recording
            stopRecordingBtn.addEventListener("click", async () => {
                await stopRecordingAndVideo();
            });

            // Preview recording
            previewBtn.addEventListener("click", async () => {
                if (activeBox && activeBox.classList.contains("done")) {
                    alert("This segment is marked as completed and cannot be previewed.");
                    return;
                }

                const start = parseFloat(document.getElementById("dubbing-start").textContent);
                const end = parseFloat(document.getElementById("dubbing-end").textContent);

                const adjustedStart = start;
                const adjustedEnd = end;

                const cursorDuration = adjustedEnd - adjustedStart;
                const scrollDuration = end - start;
                const trackWidth = waveformTrack.clientWidth;

                const audioPlayer = document.getElementById("dubbing-audio");
                const box = document.querySelector(".segment-box.active");
                if (!box) {
                    alert("No segment selected for preview.");
                    return;
                }

                const text = box.querySelector('textarea[data-lang="en"]')?.value || "";
                scrollText(text, scrollDuration);

                waveformCursor.style.left = "0px";
                waveformCursor.style.display = "block";

                stopSegmentPreviewPlayback();

                const hasAudio = audioPlayer && audioPlayer.src && !audioPlayer.src.endsWith("/");

                try {
                    if (hasAudio) {
                        audioPlayer.pause();
                        audioPlayer.currentTime = 0;
                        audioPlayer.load();

                        // ✅ WAIT FOR WAV BEFORE STARTING VIDEO
                        await waitForAudioReady(audioPlayer, 8000);
                    }

                    video.currentTime = adjustedStart;
                    video.volume = 0.1;
                    video.muted = false;
                    video.pause();

                    isManualPlayback = false;

                    await video.play();
                    await waitForVideoPlaying(video);

                    if (hasAudio) {
                        await audioPlayer.play();
                    }

                    startScrollText();
                    animateCursor(cursorDuration, trackWidth, () => {
                        stopSegmentPreviewPlayback();
                        isManualPlayback = false;
                    });

                } catch (err) {
                    console.warn("Preview play failed:", err);
                    stopSegmentPreviewPlayback();
                }
            });

/* Recording helpers moved to /static/js/index_new9/recording.js */

initializeTtsFeatures();

// Update the segment click event listener to use the new function
document.querySelectorAll(".segment-box").forEach(box => {
    box.addEventListener("click", () => {
        handleSegmentSelection(box);
    });
});
            // Load initial done states
            loadDoneState();
        }

        function initializeSpeakerFilter() {
            const speakerFilter = document.getElementById("speaker-filter");
            const unrecordedFilter = document.getElementById("filter-unrecorded");
            const doneOnlyFilter = document.getElementById("filter-done-only");

            if (!speakerFilter || !unrecordedFilter || !doneOnlyFilter) {
                return;
            }

            // rebuild speaker dropdown safely
            const existingValue = speakerFilter.value;
            speakerFilter.innerHTML = `<option value="">All</option>`;

            const speakerSet = new Set();
            document.querySelectorAll(".segment-box").forEach(box => {
                const speaker = box.querySelector(".segment-col .speaker-dropdown")?.value || "";
                if (speaker) speakerSet.add(speaker);
            });

            Array.from(speakerSet).sort().forEach(speaker => {
                const opt = document.createElement("option");
                opt.value = speaker;
                opt.textContent = speaker;
                speakerFilter.appendChild(opt);
            });

            if ([...speakerFilter.options].some(opt => opt.value === existingValue)) {
                speakerFilter.value = existingValue;
            }

            function applyFilters() {
                const selectedSpeaker = speakerFilter.value;
                const showOnlyUnrecorded = unrecordedFilter.checked;
                const showOnlyDone = doneOnlyFilter.checked;

                document.querySelectorAll(".segment-box").forEach(box => {
                    let visible = true;

                    const speaker = box.querySelector(".segment-col .speaker-dropdown")?.value || "";
                    const index = parseInt(box.dataset.index, 10);
                    const isDone = box.classList.contains("done");
                    const hasRecording = recordingsMeta.some(r => Number(r.index) === index);

                    if (selectedSpeaker && speaker !== selectedSpeaker) {
                        visible = false;
                    }

                    if (showOnlyUnrecorded && hasRecording) {
                        visible = false;
                    }

                    if (showOnlyDone && !isDone) {
                        visible = false;
                    }

                    box.classList.toggle("hidden", !visible);

                    // Keep waveform regions in sync with filtered segments
                    if (typeof regions !== "undefined" && regions[index] && regions[index].element) {
                        regions[index].element.style.display = visible ? "" : "none";
                    }
                });

                // Nudge waveform canvas redraw if available
                try {
                    window.dispatchEvent(new Event("resize"));
                } catch (e) {}
            }

            speakerFilter.onchange = applyFilters;
            unrecordedFilter.onchange = applyFilters;
            doneOnlyFilter.onchange = applyFilters;

            applyFilters();
        }

        // Function to save text immediately
        function saveTextEdit(textarea) {
            const key = `${textarea.dataset.index}-${textarea.dataset.lang}`;
            if (lockedFields.has(key)) return;

            const box = document.querySelector(`.segment-box[data-index="${textarea.dataset.index}"]`);
            if (!box) return;

            // Get all the data for unified save
            const index = textarea.dataset.index;
            const lang = textarea.dataset.lang;
            const text = textarea.value;
            const start = parseFloat(box.dataset.start || "0").toFixed(6);
            const end = parseFloat(box.dataset.end || "0").toFixed(6);
            
            // Get speaker from dropdown
            const speakerDropdown = document.querySelector(`.speaker-dropdown[data-index="${index}"][data-lang="${lang}"]`);
            const speaker = speakerDropdown?.value || "";

            console.log(`Saving subtitle for segment ${index}-${lang}:`, { text, speaker, start, end });

            // Use unified save endpoint
            saveSubtitle(index, lang, text, speaker, start, end)
                .then(result => {
                    if (result.status === "ok") {
                        console.log("Subtitle saved successfully");
                    } else {
                        console.error("Save failed:", result.message);
                    }
                })
                .catch(err => console.error("Save error:", err));

            // Also send via WebSocket for real-time collaboration
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: "edit",
                    index: index,
                    lang: lang,
                    text: text
                }));
            }
        }

function weightedCpsLength(text) {
  if (!text) return 0;

  // remove trailing punctuation so sentence endings don't count
  const trimmed = text.trim().replace(/[.,!?]+$/, "");

  let extra = 0;

  for (const char of trimmed) {
    if (char === "," || char === ".") {
      extra += 2;        // comma / mid pause
    } 
    else if (char === "!" || char === "?") {
      extra += 4;        // stronger pause
    }
  }

  return trimmed.length + extra;
}


// Function to update Characters Per Second calculation (GLOBAL SCOPE)
function updateCPS(index) {
  const enText = document.querySelector(`textarea[data-index="${index}"][data-lang="en"]`)?.value || "";
  const arText = document.querySelector(`textarea[data-index="${index}"][data-lang="ar"]`)?.value || "";
  const box = document.querySelector(`.segment-box[data-index="${index}"]`);
  if (!box) return;
  const start = parseFloat(box.dataset.start);
  const end = parseFloat(box.dataset.end);
  const duration = Math.max(end - start, 0.001);

  const enLen = weightedCpsLength(enText);
  const arLen = weightedCpsLength(arText);

  const enCPS = (enLen / duration).toFixed(1);
  const arCPS = (arLen / duration).toFixed(1);

  const enSpan = document.querySelector(`.cps-en[data-index="${index}"]`);
  const arSpan = document.querySelector(`.cps-ar[data-index="${index}"]`);

  if (enSpan) {
    enSpan.textContent = `CPS: ${enCPS}`;
    const val = parseFloat(enCPS);
    enSpan.style.color = (val < 16 || val > 21) ? "red" : "#222";
  }
  if (arSpan) {
    arSpan.textContent = `CPS: ${arCPS}`;
    const val = parseFloat(arCPS);
    arSpan.style.color = (val < 16 || val > 21) ? "red" : "#222";
  }
}



// Initialize CPS calculation for all segments
function initializeCPSCalculation() {
    // Update CPS for all segments on page load
    document.querySelectorAll(".segment-box").forEach(box => {
        const index = parseInt(box.dataset.index);
        updateCPS(index);
    });

    // Set up event listeners for text changes
    document.querySelectorAll("textarea.edit-field").forEach(textarea => {
        textarea.addEventListener("input", () => {
            updateCPS(textarea.dataset.index);
        });
    });
}

// Global fallback: keep auto-height + CPS responsive after dynamic DOM refreshes.
document.addEventListener("input", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLTextAreaElement)) return;
    if (!target.classList.contains("edit-field")) return;

    try {
        autoResizeTextarea(target);
    } catch (err) {}

    try {
        const idx = target.dataset.index;
        if (idx !== undefined && idx !== null && idx !== "") {
            updateCPS(idx);
        }
    } catch (err) {}
});

        // Text scrolling functions
        function resetScrollText() {
            const span = document.getElementById("scrolling-text");
            span.style.transition = "none";
            span.style.transform = "translateY(-50%) translateX(0%)";   // start at red cursor, text extends to right
            span.textContent = "";
        }

        function scrollText(text, duration) {
            const span = document.getElementById("scrolling-text");
            span.textContent = text;
            span.style.transition = "none";
            span.style.transform = "translateY(-50%) translateX(0%)";   // start from right of red cursor
            void span.offsetWidth;
            span.dataset.scrollDuration = duration;
        }

        function startScrollText() {
            const span = document.getElementById("scrolling-text");
            const duration = span.dataset.scrollDuration || 1;
            span.style.transition = `transform ${duration}s linear`;
            span.style.transform = "translateY(-50%) translateX(-100%)";  // move left on preview
        }

        let segmentPlaybackRaf = null;

        function stopSegmentPreviewPlayback() {
            if (segmentPlaybackRaf) {
                cancelAnimationFrame(segmentPlaybackRaf);
                segmentPlaybackRaf = null;
            }

            const waveformCursor = document.getElementById("waveform-cursor");
            if (waveformCursor) {
                waveformCursor.style.display = "none";
            }

            const audioPlayer = document.getElementById("dubbing-audio");
            if (audioPlayer) {
                try {
                    audioPlayer.pause();
                    audioPlayer.currentTime = 0;
                } catch (err) {
                    console.warn("Audio stop failed:", err);
                }
            }

            if (video) {
                video.pause();
                video.muted = false;
                video.volume = 1.0;
            }
        }

        function animateCursor(duration, trackWidth, onComplete = null) {
            const startTime = video.currentTime;
            const waveformCursor = document.getElementById("waveform-cursor");

            if (segmentPlaybackRaf) {
                cancelAnimationFrame(segmentPlaybackRaf);
                segmentPlaybackRaf = null;
            }

            function finishPlayback() {
                if (segmentPlaybackRaf) {
                    cancelAnimationFrame(segmentPlaybackRaf);
                    segmentPlaybackRaf = null;
                }

                if (waveformCursor) {
                    waveformCursor.style.display = "none";
                }

                if (typeof onComplete === "function") {
                    onComplete();
                } else if (video) {
                    video.pause();
                    video.muted = false;
                    video.volume = 1.0;
                }
            }

            function frame() {
                if (!video) {
                    finishPlayback();
                    return;
                }

                const current = video.currentTime;
                const elapsed = current - startTime;
                const percent = Math.min(1, Math.max(0, elapsed / Math.max(duration, 0.001)));

                if (waveformCursor) {
                    waveformCursor.style.left = `${percent * trackWidth}px`;
                }

                if (percent < 1 && !video.paused) {
                    segmentPlaybackRaf = requestAnimationFrame(frame);
                } else {
                    finishPlayback();
                }
            }

            if (waveformCursor) {
                waveformCursor.style.display = "block";
                waveformCursor.style.left = "0px";
            }

            segmentPlaybackRaf = requestAnimationFrame(frame);
        }

        function waitForVideoPlaying(videoEl, timeoutMs = 2000) {
            return new Promise((resolve) => {
                if (!videoEl) {
                    resolve();
                    return;
                }

                if (!videoEl.paused && videoEl.currentTime > 0) {
                    resolve();
                    return;
                }

                let done = false;
                const cleanup = () => {
                    videoEl.removeEventListener('playing', onPlaying);
                    videoEl.removeEventListener('timeupdate', onTimeUpdate);
                    clearTimeout(timer);
                };
                const finish = () => {
                    if (done) return;
                    done = true;
                    cleanup();
                    resolve();
                };
                const onPlaying = () => finish();
                const onTimeUpdate = () => {
                    if (!videoEl.paused) finish();
                };
                const timer = setTimeout(finish, timeoutMs);

                videoEl.addEventListener('playing', onPlaying, { once: true });
                videoEl.addEventListener('timeupdate', onTimeUpdate);
            });
        }

        async function playSelectedSegmentGeneratedMuted() {
            if (!activeBox) {
                alert("No segment selected.");
                return;
            }

            if (activeBox.classList.contains("done")) {
                alert("This segment is marked as completed.");
                return;
            }

            const index = parseInt(activeBox.dataset.index, 10);
            console.log("🎯 Trying to play segment:", index);
            console.log("📦 recordingsMeta:", recordingsMeta);

            const audioPlayer = document.getElementById("dubbing-audio");
            const waveformTrack = document.getElementById("waveform-timeline");
            const start = parseFloat(document.getElementById("dubbing-start").textContent || activeBox.dataset.start || "0");
            const end = parseFloat(document.getElementById("dubbing-end").textContent || activeBox.dataset.end || "0");
            const duration = Math.max(0.001, end - start);
            const trackWidth = waveformTrack ? waveformTrack.clientWidth : 0;
            const text = activeBox.querySelector('textarea[data-lang="en"]')?.value || "";

            const recording = recordingsMeta.find(r => Number(r.index) === index && r.file);

            console.log("🔎 recording found:", recording);

            if (!recording) {
                alert("No generated wave found for this segment.");
                console.warn("No recording found in recordingsMeta for index:", index, recordingsMeta);
                return;
            }

            async function ensureAudioPlays(audioEl, rec) {
                const tryPlay = async (label) => {
                    try {
                        const p = audioEl.play();
                        if (p && typeof p.catch === "function") {
                            await p.catch((e) => {
                                console.warn(`Audio play ${label} failed:`, e);
                            });
                        }
                    } catch (e) {
                        console.warn(`Audio play ${label} threw:`, e);
                    }
                    return !audioEl.paused;
                };

                if (await tryPlay("initial")) return true;

                await new Promise(r => setTimeout(r, 150));
                try { await waitForAudioReady(audioEl, 4000); } catch (e) {}
                if (await tryPlay("retry")) return true;

                // Fallback to server URL (no blob) and retry
                try {
                    const fallbackUrl = `/subtitles/${project}/${episode}/recordings/${rec.file}?t=${Date.now()}`;
                    audioEl.pause();
                    audioEl.src = "";
                    audioEl.currentTime = 0;
                    audioEl.src = fallbackUrl;
                    try { audioEl.load(); } catch (e) {}
                    try { await waitForAudioReady(audioEl, 4000); } catch (e) {}
                    if (await tryPlay("fallback")) return true;
                } catch (e) {
                    console.warn("Audio fallback failed:", e);
                }

                return !audioEl.paused;
            }

            try {
                stopSegmentPreviewPlayback();
                scrollText(text, duration);
                isManualPlayback = false;

                await window.loadExistingRecording(recording);

                if (!audioPlayer || !audioPlayer.src) {
                    throw new Error("Audio source not ready");
                }

                audioPlayer.pause();
                audioPlayer.currentTime = 0;

                try {
                    audioPlayer.load();
                } catch (e) {
                    console.warn("audio.load() skipped:", e);
                }

                try {
                    await waitForAudioReady(audioPlayer, 8000);
                } catch (e) {
                    console.warn("Audio not ready on first wait, will retry via ensureAudioPlays:", e);
                }

                console.log("▶ Playing generated segment:", {
                    index,
                    file: recording.file,
                    audioSrc: audioPlayer.src,
                    start,
                    end
                });

                video.pause();
                video.currentTime = start;
                video.muted = true;
                video.volume = 0;

                const videoPlayPromise = video.play();
                const results = await Promise.allSettled([videoPlayPromise]);
                console.log("▶ play results:", results);

                const audioOk = await ensureAudioPlays(audioPlayer, recording);
                if (!audioOk) {
                    throw new Error("Generated WAV did not start playing");
                }

                startScrollText();
                animateCursor(duration, trackWidth, () => {
                    stopSegmentPreviewPlayback();
                    isManualPlayback = false;
                });

            } catch (err) {
                console.error("❌ Generated preview failed:", err);
                stopSegmentPreviewPlayback();
                alert("Generated preview failed: " + err.message);
            }
        }

        async function playSelectedSegmentOriginalOnly() {
            if (!activeBox) {
                alert("No segment selected.");
                return;
            }

            const waveformTrack = document.getElementById("waveform-timeline");
            const audioPlayer = document.getElementById("dubbing-audio");
            const start = parseFloat(document.getElementById("dubbing-start").textContent || activeBox.dataset.start || "0");
            const end = parseFloat(document.getElementById("dubbing-end").textContent || activeBox.dataset.end || "0");
            const duration = Math.max(0.001, end - start);
            const trackWidth = waveformTrack ? waveformTrack.clientWidth : 0;
            const text = activeBox.querySelector('textarea[data-lang="en"]')?.value || "";

            stopSegmentPreviewPlayback();
            scrollText(text, duration);
            isManualPlayback = false;

            if (audioPlayer) {
                try {
                    audioPlayer.pause();
                    audioPlayer.currentTime = 0;
                } catch (err) {
                    console.warn("Audio reset failed:", err);
                }
            }

            video.currentTime = start;
            video.muted = false;
            video.volume = 1.0;
            video.pause();

            try {
                await video.play();
                startScrollText();
                animateCursor(duration, trackWidth, () => {
                    stopSegmentPreviewPlayback();
                    isManualPlayback = false;
                });
            } catch (err) {
                console.warn("Original-only preview failed:", err);
                stopSegmentPreviewPlayback();
            }
        }

        // Export function
        function exportCSV(url) {
            fetch(url)
                .then(response => response.json())
                .then(data => {
                    console.log("Exported to", data.path);
                })
                .catch(err => {
                    console.error("Export failed", err);
                });
        }

    // Keyboard shortcuts - NUMPAD ONLY
    document.addEventListener('keydown', function(e) {
        if (e.repeat) return;

        switch (e.code) {
            case 'Numpad0': {   // Preview recording
                e.preventDefault();
                e.stopPropagation();
                const previewBtn = document.getElementById('preview-btn');
                if (previewBtn && !previewBtn.disabled) {
                    previewBtn.click();
                }
                break;
            }

            case 'NumpadMultiply': {   // Start recording
                e.preventDefault();
                e.stopPropagation();
                const startBtn = document.getElementById('start-recording');
                if (startBtn && !startBtn.disabled) {
                    startBtn.click();
                }
                break;
            }

            case 'NumpadEnter': {   // Generate TTS preview
                e.preventDefault();
                e.stopPropagation();
                const ttsBtn = document.getElementById('tts-btn');
                if (ttsBtn && !ttsBtn.disabled) {
                    ttsBtn.click();
                }
                break;
            }

            case 'Numpad2': {
                e.preventDefault();
                e.stopPropagation();
                stopSegmentPreviewPlayback();
                playFullVideoWithGeneratedWavsSynced();
                break;
            }
            
            
            case 'NumpadDecimal': {
                e.preventDefault();
                e.stopPropagation();
                stopFullDubPreview();
                break;
            }           

            case 'Numpad1': {   // Play generated wave + muted original video
                e.preventDefault();
                e.stopPropagation();
                playSelectedSegmentGeneratedMuted();
                break;
            }

            case 'Numpad3': {   // Play original video audio only
                e.preventDefault();
                e.stopPropagation();
                playSelectedSegmentOriginalOnly();
                break;
            }

            case 'NumpadAdd': {   // Select next segment
                e.preventDefault();
                e.stopPropagation();
                selectNextSegment();
                break;
            }

            case 'NumpadSubtract': {   // Select previous segment
                e.preventDefault();
                e.stopPropagation();
                selectPreviousSegment();
                break;
            }
        }
    }, true);



        // Mouse middle button (scroll wheel press) → Preview recording
        document.addEventListener('mousedown', function(e) {

            if (e.button === 1) {   // middle mouse button
                e.preventDefault();

                const previewBtn = document.getElementById('preview-btn');

                if (previewBtn && !previewBtn.disabled) {
                    previewBtn.click();
                }
            }

        });        

        // Select previous segment
        function selectPreviousSegment() {
            const segments = Array.from(document.querySelectorAll('.segment-box:not(.hidden)'));
            const currentIndex = segments.findIndex(segment => segment.classList.contains('active'));
            
            if (currentIndex > 0) {
                segments[currentIndex - 1].click();
            } else if (segments.length > 0) {
                segments[segments.length - 1].click();
            }
        }

        // Select next segment
        function selectNextSegment() {
            const segments = Array.from(document.querySelectorAll('.segment-box:not(.hidden)'));
            const currentIndex = segments.findIndex(segment => segment.classList.contains('active'));
            
            if (currentIndex < segments.length - 1) {
                segments[currentIndex + 1].click();
            } else if (segments.length > 0) {
                segments[0].click();
            }
        }

// Enhanced real-time editing with proper update handling
function initializeRealTimeEditing() {
    const userId = sessionStorage.getItem("subtitleUserId") || (() => {
        const id = "User " + Math.floor(1000 + Math.random() * 9000);
        sessionStorage.setItem("subtitleUserId", id);
        return id;
    })();
    
    const userColor = "#" + Math.floor(Math.random() * 16777215).toString(16);
    const protocol = location.protocol === "https:" ? "wss://" : "ws://";
    ws = new WebSocket(
        `${protocol}${location.host}/ws/edits/${project}/${episode}`
    );
    
    console.log("🔧 Real-time editing initialized:", { userId, userColor });

    // Track which fields the current user is editing
    const userEditingFields = new Set();

    ws.onopen = function() {
        console.log("✅ WebSocket connected for real-time editing");
    };

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            console.log("📨 WebSocket message received:", msg);
            
            const { type, index, lang, text, user, speaker, start, end, timestamp } = msg;
            
            // Ignore messages from current user
            if (user === userId) return;
            
            const key = `${index}-${lang}`;
            
            switch (type) {
                case "edit":
                    handleExternalEditComplete(msg);
                    break;

                case "edit_complete":
                    handleExternalEditComplete(msg);
                    break;
                    
                case "speaker_change":
                    handleExternalSpeakerChange(msg);
                    break;
                    
                case "region_update":
                    handleExternalRegionUpdate(msg);
                    break;
                    
                case "segment_done":
                    handleExternalSegmentDone(msg);
                    break;

                case "segments_changed":
                    if (typeof refreshSegmentsOnly === "function") {
                        if (!window.__segmentsRefreshInFlight) {
                            window.__segmentsRefreshInFlight = true;
                            refreshSegmentsOnly()
                                .catch(err => console.error("❌ segments_changed refresh failed:", err))
                                .finally(() => {
                                    window.__segmentsRefreshInFlight = false;
                                });
                        }
                    }
                    break;
                    
                case "lock":
                    handleExternalLock(msg);
                    break;
                    
                case "unlock":
                    handleExternalUnlock(msg);
                    break;
            }
            
        } catch (e) {
            console.error("❌ WebSocket message error:", e);
        }
    };

    // Set up event listeners for all editable elements
    setupRealTimeEventListeners(ws, userId, userColor, userEditingFields);

    // Allow rebinding listeners after dynamic DOM refreshes (insert/split/delete).
    window.rebindRealtimeListeners = function() {
        try {
            if (ws) {
                setupRealTimeEventListeners(ws, userId, userColor, userEditingFields);
            }
        } catch (e) {
            console.warn("rebindRealtimeListeners failed:", e);
        }
    };

    // Handle WebSocket connection issues
    ws.onerror = (error) => {
        console.error("❌ WebSocket error:", error);
    };

    ws.onclose = () => {
        console.log("🔌 WebSocket connection closed");
        // Unlock all fields when connection closes
        document.querySelectorAll("textarea.edit-field").forEach(textarea => {
            textarea.disabled = false;
            textarea.title = "";
            textarea.style.backgroundColor = "";
            const liveTag = document.getElementById(`live-${textarea.dataset.index}-${textarea.dataset.lang}`);
            if (liveTag) liveTag.textContent = "";
        });
        userEditingFields.clear();
    };
}

// Setup event listeners for real-time updates
function setupRealTimeEventListeners(ws, userId, userColor, userEditingFields) {
    // Textarea editing with debouncing
    document.querySelectorAll("textarea.edit-field").forEach(textarea => {
        let editTimeout;
        let liveTimeout;
        
        textarea.addEventListener("focus", () => {
            rememberLastEditedSegment(textarea.dataset.index);
            const key = `${textarea.dataset.index}-${textarea.dataset.lang}`;
            userEditingFields.add(key);
            
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: "lock",
                    index: textarea.dataset.index,
                    lang: textarea.dataset.lang,
                    user: userId,
                    color: userColor,
                    timestamp: Date.now()
                }));
            }
        });

        textarea.addEventListener("blur", () => {
            const key = `${textarea.dataset.index}-${textarea.dataset.lang}`;
            userEditingFields.delete(key);
            
            // Send final edit on blur
            clearTimeout(editTimeout);
            clearTimeout(liveTimeout);
            sendEditComplete(ws, textarea, userId, "edit_complete");
            
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: "unlock",
                    index: textarea.dataset.index,
                    lang: textarea.dataset.lang,
                    user: userId,
                    timestamp: Date.now()
                }));
            }
        });

        textarea.addEventListener("input", () => {
            // Clear previous timeout
            clearTimeout(editTimeout);
            clearTimeout(liveTimeout);

            // Live update for collaborators while typing
            liveTimeout = setTimeout(() => {
                sendEditComplete(ws, textarea, userId, "edit");
            }, 120);
            
            // Set new timeout for debounced edit complete
            editTimeout = setTimeout(() => {
                sendEditComplete(ws, textarea, userId, "edit_complete");
            }, 1000); // 1 second debounce
            
            // Only update local region text, don't broadcast typing
            const index = textarea.dataset.index;
            const newText = textarea.value;
            updateRegionTextOnEdit(index, newText);
        });
    });

        // Speaker dropdown changes
    document.querySelectorAll(".speaker-dropdown").forEach(dropdown => {
        if (dropdown.dataset.realtimeSpeakerBound === "1") return;
        dropdown.dataset.realtimeSpeakerBound = "1";

        dropdown.addEventListener("change", function() {
            rememberLastEditedSegment(this.dataset.index);
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: "speaker_change",
                    index: this.dataset.index,
                    lang: this.dataset.lang || "en",
                    speaker: this.value,
                    user: userId,
                    timestamp: Date.now()
                }));
            }
        });
    });

    // Segment done state changes
    const doneCheckbox = document.getElementById("segment-done-checkbox");
    if (doneCheckbox) {
        doneCheckbox.addEventListener("change", function() {
            if (activeBox && ws.readyState === WebSocket.OPEN) {
                const index = parseInt(activeBox.dataset.index);
                ws.send(JSON.stringify({
                    type: "segment_done",
                    index: index,
                    is_done: this.checked,
                    user: userId,
                    timestamp: Date.now()
                }));
            }
        });
    }
}

// Send edit complete message
function sendEditComplete(ws, textarea, userId, messageType = "edit_complete") {
    const box = textarea.closest('.segment-box');
    if (!box) return;

    const index = textarea.dataset.index;
    const lang = textarea.dataset.lang;
    const text = textarea.value;
    const start = parseFloat(box.dataset.start || "0").toFixed(6);
    const end = parseFloat(box.dataset.end || "0").toFixed(6);
    
    const speakerDropdown = document.querySelector(`.speaker-dropdown[data-index="${index}"][data-lang="${lang}"]`);
    const speaker = speakerDropdown?.value || "";

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: messageType,
            index: index,
            lang: lang,
            text: text,
            speaker: speaker,
            start: start,
            end: end,
            user: userId,
            timestamp: Date.now()
        }));
    }
}

// Handle external edit completion
function handleExternalEditComplete(msg) {
    const { index, lang, text, speaker, start, end, user } = msg;
    
    const textarea = document.querySelector(`textarea[data-index="${index}"][data-lang="${lang}"]`);
    const speakerDropdown = document.querySelector(`.speaker-dropdown[data-index="${index}"][data-lang="${lang}"]`);
    const box = document.querySelector(`.segment-box[data-index="${index}"]`);
    
    if (textarea && !textarea.matches(':focus')) {
        console.log(`🔄 Updating text from ${user}:`, text);
        textarea.value = text;
        
        // Update region text
        updateRegionTextOnEdit(index, text);
        
        // Update CPS calculation
        updateCPS(index);
    }
    
    if (speakerDropdown && speakerDropdown.value !== speaker) {
        console.log(`🔄 Updating speaker from ${user}:`, speaker);
        speakerDropdown.value = speaker;
        updateSpeakerColor(speakerDropdown.closest('.segment-header'), speaker);
        
        if (lang === 'en') {
            updateArabicSpeaker(index, speaker);
        }
    }
    
    if (box && start && end) {
        const currentStart = parseFloat(box.dataset.start).toFixed(6);
        const currentEnd = parseFloat(box.dataset.end).toFixed(6);
        
        if (currentStart !== start || currentEnd !== end) {
            console.log(`🔄 Updating timecodes from ${user}:`, start, end);
            box.dataset.start = start;
            box.dataset.end = end;
            
            // Update timecode display
            const timecodeElement = box.querySelector(".timecode");
            if (timecodeElement) {
                const children = timecodeElement.children;
                if (children.length >= 3) {
                    children[1].textContent = formatTimecode(parseFloat(start));
                    children[2].textContent = formatTimecode(parseFloat(end));
                }
            }
            
            // Update region if exists
            if (regions[index]) {
                regions[index].update({
                    start: parseFloat(start),
                    end: parseFloat(end)
                });
                updateRegionTextLabel(index);
            }
            
            updateCPS(index);
        }
    }
}

// Handle external speaker changes
function handleExternalSpeakerChange(msg) {
    const { index, lang, speaker, user } = msg;

    const effectiveLang = lang || "en";
    let speakerDropdown = document.querySelector(`.speaker-dropdown[data-index="${index}"][data-lang="${effectiveLang}"]`);
    if (!speakerDropdown) {
        speakerDropdown = document.querySelector(`.speaker-dropdown[data-index="${index}"]`);
    }
    if (!speakerDropdown) {
        if (typeof refreshSegmentsOnly === "function" && !window.__segmentsRefreshInFlight) {
            window.__segmentsRefreshInFlight = true;
            refreshSegmentsOnly()
                .catch(err => console.error("segments refresh after missing speaker target failed:", err))
                .finally(() => {
                    window.__segmentsRefreshInFlight = false;
                });
        }
        return;
    }
    if (!speaker || speakerDropdown.value === speaker) return;

    console.log(`Realtime speaker update from ${user}:`, speaker);
    speakerDropdown.value = speaker;
    updateSpeakerColor(speakerDropdown.closest('.segment-header'), speaker);
    updateArabicSpeaker(index, speaker);
    updateSpeakerFilter(speaker);

    // Update region if exists
    if (regions[index]) {
        const header = document.querySelector(`.segment-box[data-index="${index}"] .segment-header`);
        let speakerColor = "#3498db";

        if (header) {
            const computedStyle = window.getComputedStyle(header);
            speakerColor = computedStyle.backgroundColor;

            if (speakerColor.startsWith('rgba') || speakerColor.startsWith('rgb')) {
                speakerColor = rgbToHex(speakerColor);
            }
        }

        const regionColor = hexToRgba(speakerColor, 0.4);
        regions[index].update({ color: regionColor });
        addSpeakerLabelToRegion(regions[index], speaker);
    }
}

// Handle external region updates
function handleExternalRegionUpdate(msg) {
    const { index, start, end, user } = msg;
    
    const box = document.querySelector(`.segment-box[data-index="${index}"]`);
    
    if (box && !isRegionDragging) {
        const currentStart = parseFloat(box.dataset.start).toFixed(6);
        const currentEnd = parseFloat(box.dataset.end).toFixed(6);
        
        if (currentStart !== start || currentEnd !== end) {
            console.log(`🔄 Updating region from ${user}:`, start, end);
            handleRegionUpdate(index, parseFloat(start), parseFloat(end));
        }
    }
}

// Handle external segment done state
function handleExternalSegmentDone(msg) {
    const { index, is_done, user } = msg;
    
    const box = document.querySelector(`.segment-box[data-index="${index}"]`);
    const isCurrentlyDone = box.classList.contains("done");
    
    if (box && isCurrentlyDone !== is_done) {
        console.log(`🔄 Updating done state from ${user}:`, is_done);
        setSegmentDoneState(index, is_done);
        
        // Update checkbox if this is the active segment
        if (activeBox && parseInt(activeBox.dataset.index) === index) {
            const doneCheckbox = document.getElementById("segment-done-checkbox");
            if (doneCheckbox) {
                doneCheckbox.checked = is_done;
            }
        }
    }
}

// Handle external field locking
function handleExternalLock(msg) {
    const { project, episode, index, lang, user, color } = msg;

    // Ignore locks from other projects
    if (project !== window.currentProject) return;
    if (episode !== window.currentEpisode) return;

    const textarea = document.querySelector(`textarea[data-index="${index}"][data-lang="${lang}"]`);
    const liveTag = document.getElementById(`live-${index}-${lang}`);

    if (textarea && !textarea.matches(':focus')) {
        textarea.disabled = true;
        textarea.title = `Locked by ${user}`;
        textarea.style.backgroundColor = "#f8d7da";
    }

    if (liveTag) {
        liveTag.textContent = `✏️ ${user}`;
        liveTag.style.color = color;
    }
}


// Handle external field unlocking
function handleExternalUnlock(msg) {
    const { project, episode, index, lang } = msg;

    // Ignore unlocks from other projects
    if (project !== window.currentProject) return;
    if (episode !== window.currentEpisode) return;

    const textarea = document.querySelector(`textarea[data-index="${index}"][data-lang="${lang}"]`);
    const liveTag = document.getElementById(`live-${index}-${lang}`);

    if (textarea && !textarea.matches(':focus')) {
        textarea.disabled = false;
        textarea.title = "";
        textarea.style.backgroundColor = "";
    }

    if (liveTag) {
        liveTag.textContent = "";
    }
}

}


