function getRecorderRef() {
  if (typeof recorder !== "undefined") return recorder;
  if (typeof window !== "undefined" && typeof window.recorder !== "undefined") return window.recorder;
  return null;
}

function setRecorderRef(value) {
  try {
    if (typeof recorder !== "undefined") recorder = value;
  } catch (e) {}
  if (typeof window !== "undefined") window.recorder = value;
}

async function stopRecordingAndVideo() {
  try {
    // If we’re not recording, just cleanup UI state
    const rec = getRecorderRef();
    if (!rec) {
      cleanupRecordingResources();
      return;
    }

    const blob = await new Promise((resolve) => {
      rec.stop();
      rec.exportWAV(resolve);
    });

    const speaker = document.getElementById("dubbing-speaker").textContent.trim();
    const start = parseFloat(document.getElementById("dubbing-start").textContent);
    const end = parseFloat(document.getElementById("dubbing-end").textContent);
    const index = activeBox ? parseInt(activeBox.dataset.index) : 0;
    const recordingSession =
      (typeof window !== "undefined" && window.__recordingSession) ? window.__recordingSession : null;
    const preRollSec = Math.max(
      0,
      Number(recordingSession && Number.isFinite(recordingSession.preRollSec) ? recordingSession.preRollSec : 0)
    );
    const postRollSec = Math.max(
      0,
      Number(recordingSession && Number.isFinite(recordingSession.postRollSec) ? recordingSession.postRollSec : 0)
    );

    const formData = new FormData();
    formData.append("project", project);
    formData.append("episode", episode);
    formData.append("index", index);
    formData.append("speaker", speaker);
    formData.append("start", start);
    formData.append("end", end);
    formData.append("pre_roll_sec", preRollSec);
    formData.append("post_roll_sec", postRollSec);
    formData.append("file", blob, "recording.wav");

    console.log("📤 Uploading recording to server...");
    const res = await fetch("/upload_audio", { method: "POST", body: formData });
    const result = await res.json();

    if (result.status !== "ok") {
      console.error("❌ Upload failed:", result.message);
      alert("Upload failed: " + (result.message || "Unknown error"));
      cleanupRecordingResources();
      return;
    }

    console.log("✅ Recording uploaded successfully:", result.file);

    // Update recordingsMeta (replace existing entry for this index)
    const newRecording = {
      index,
      speaker,
      start,
      end,
      duration: +(end - start).toFixed(3),
      file: result.file,
      source: result.source || "mic",
      pre_roll_sec: Number.isFinite(Number(result.pre_roll_sec))
        ? Number(result.pre_roll_sec)
        : preRollSec,
      post_roll_sec: Number.isFinite(Number(result.post_roll_sec))
        ? Number(result.post_roll_sec)
        : postRollSec
    };

    const existingIndex = recordingsMeta.findIndex((r) => r.index === index);
    if (existingIndex !== -1) recordingsMeta.splice(existingIndex, 1);
    recordingsMeta.push(newRecording);

    resetTtsFitDisplay();

    // Update audio player (cache busting ok for audio)
    const audioPath = `/subtitles/${project}/${episode}/recordings/${result.file}?t=${Date.now()}`;
    const audioPlayer = document.getElementById("dubbing-audio");
    if (audioPlayer) {
      if (audioPlayer.src && audioPlayer.src.startsWith("blob:")) {
        URL.revokeObjectURL(audioPlayer.src);
      }
      audioPlayer.src = "";
      setTimeout(() => (audioPlayer.src = audioPath), 50);
    }

    // Refresh peaks (optional, guarded)
    if (typeof loadWaveformPeaks === "function") {
      loadWaveformPeaks(project, episode).catch((err) =>
        console.warn("Waveform peaks failed:", err)
      );
    }

    // If you have miniWave (WaveSurfer) for the *recording* waveform, reload it safely
    if (typeof miniWave !== "undefined" && miniWave && typeof miniWave.load === "function") {
      const waveformPath = `/subtitles/${project}/${episode}/recordings/${result.file}`; // no cache bust for ws
      setTimeout(() => {
        try {
          miniWave.load(waveformPath);
        } catch (e) {
          console.warn("miniWave.load failed:", e);
        }
      }, 300);
    }
  } catch (err) {
    console.error("❌ stopRecordingAndVideo failed:", err);
    alert("Failed to stop/upload recording. Check console.");
  } finally {
    cleanupRecordingResources();
  }
}

function cleanupRecordingResources() {
  if (typeof window !== "undefined" && window.gumStream) {
    window.gumStream.getTracks().forEach((track) => track.stop());
    window.gumStream = null;
  }

  if (video) {
    video.pause();
    video.volume = 1.0;
  }

  const waveformCursor = document.getElementById("waveform-cursor");
  if (waveformCursor) waveformCursor.style.display = "none";

  const startRecordingBtn = document.getElementById("start-recording");
  const stopRecordingBtn = document.getElementById("stop-recording");
  if (startRecordingBtn) startRecordingBtn.disabled = false;
  if (stopRecordingBtn) stopRecordingBtn.disabled = true;

  if (typeof recordingEndTime !== "undefined") {
    recordingEndTime = null;
  } else if (typeof window !== "undefined") {
    window.recordingEndTime = null;
  }
  if (typeof isRecordingStopping !== "undefined") {
    isRecordingStopping = false;
  }
  if (typeof window !== "undefined") {
    window.__recordingSession = null;
  }
  isManualPlayback = true;
  setRecorderRef(null);

  console.log("✅ Recording resources cleaned up");
}

// Helper: update done checkbox + recording/preview buttons for active segment
function updateDoneCheckboxState(box) {
  const doneCheckbox = document.getElementById("segment-done-checkbox");
  if (!doneCheckbox || !box) return;

  const isDone = box.classList.contains("done");
  doneCheckbox.checked = isDone;

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

function updateScrollingTextDuration(start, end) {
  const span = document.getElementById("scrolling-text");
  if (!span) return;
  const duration = Math.max(0.1, (end - start));
  span.dataset.scrollDuration = duration;
}

function resetScrollText() {
  const span = document.getElementById("scrolling-text");
  if (!span) return;
  span.style.transition = "none";
  span.style.transform = "translateY(-50%) translateX(0%)";
  span.textContent = "";
}

function scrollText(text, duration) {
  const span = document.getElementById("scrolling-text");
  if (!span) return;
  span.textContent = text;
  span.style.transition = "none";
  span.style.transform = "translateY(-50%) translateX(0%)";
  span.dataset.scrollDuration = duration;
}

function startScrollText() {
  const span = document.getElementById("scrolling-text");
  if (!span) return;
  const duration = span.dataset.scrollDuration || 1;
  // Force a reflow so the transition always restarts
  void span.offsetWidth;
  requestAnimationFrame(() => {
    span.style.transition = `transform ${duration}s linear`;
    span.style.transform = "translateY(-50%) translateX(-100%)";
  });
}






// Enhanced function to load existing recording - FORCE RELOAD
window.loadExistingRecording = async function(recording) {
    if (!recording || !recording.file) {
        console.error("No recording data or file name provided");
        return;
    }

    const audioPlayer = document.getElementById("dubbing-audio");
    if (audioPlayer) {
        try {
            const blob = await getRecordingBlob(recording.file);
            const objectUrl = URL.createObjectURL(blob);

            if (audioPlayer.dataset.objectUrl) {
                URL.revokeObjectURL(audioPlayer.dataset.objectUrl);
            }

            audioPlayer.pause();
            audioPlayer.src = "";
            audioPlayer.currentTime = 0;

            audioPlayer.src = objectUrl;
            audioPlayer.dataset.objectUrl = objectUrl;

            console.log("📦 Audio player source set from cache:", recording.file);
        } catch (error) {
            console.warn("⚠️ Cache load failed, falling back to server:", error);

            const audioPath = `/subtitles/${project}/${episode}/recordings/${recording.file}?t=${Date.now()}`;

            if (audioPlayer.dataset.objectUrl) {
                URL.revokeObjectURL(audioPlayer.dataset.objectUrl);
                delete audioPlayer.dataset.objectUrl;
            }

            audioPlayer.pause();
            audioPlayer.src = "";
            audioPlayer.currentTime = 0;
            audioPlayer.src = audioPath;

            console.log("🌐 Audio player source set from server fallback:", audioPath);
        }
    }

    const waveformTrack = document.getElementById("waveform-timeline");
    if (waveformTrack) {
        waveformTrack.innerHTML = `<div style="text-align:center;color:#666;padding:20px;">Loaded: ${recording.file}</div>`;
    }
};


// Add this function to refresh the current recording
function refreshCurrentRecording() {
    if (activeBox) {
        const index = parseInt(activeBox.dataset.index);
        const recording = recordingsMeta.find(r => r.index === index);
        if (recording) {
            console.log("Refreshing current recording...");
            loadExistingRecording(recording);
            if (recording.fit_status) {
                updateTtsFitDisplay(recording);
            } else {
                resetTtsFitDisplay();
            }
        }
    }
}

// Add keyboard shortcut to refresh recording (Ctrl+R)
document.addEventListener('keydown', function(e) {
    if (e.ctrlKey && e.key === 'r') {
        e.preventDefault();
        refreshCurrentRecording();
    }
});

// Enhanced function to handle segment selection - loads recording from file if exists
async function handleSegmentSelection(box, options = {}) {
    const preserveWaveformScroll = !!(options && options.preserveWaveformScroll);
    const isDone = box.classList.contains("done");
    const previousIndex = activeBox ? parseInt(activeBox.dataset.index, 10) : -1;
    const start = parseFloat(box.dataset.start);
    const end = parseFloat(box.dataset.end);

    // Fail-safe: seek as early as possible, before any downstream UI logic.
    try {
        if (typeof window.seekVideoToTime === "function" && !preserveWaveformScroll) {
            window.seekVideoToTime(start);
        } else {
            const v = window.video || document.getElementById("videoPlayer");
            if (v && Number.isFinite(start)) {
                v.currentTime = start;
                window.video = v;
            }
        }
    } catch (seekErr) {
        console.warn("Early segment seek failed:", seekErr);
    }

    try {
        if (activeBox && !activeBox.classList.contains("done")) {
            if (typeof saveCurrentSegmentText === "function") {
                saveCurrentSegmentText();
            }
        }
    } catch (e) {
        console.warn("saveCurrentSegmentText failed:", e);
    }

    const speaker = box.querySelector(".segment-col .segment-header .speaker-dropdown")?.value || "Unknown";
    const index = parseInt(box.dataset.index);

    console.log("Selecting segment:", index, "Speaker:", speaker);

    document.getElementById("dubbing-speaker").textContent = speaker;
    const vcTargetSpeakerInput = document.getElementById("vc-target-speaker");
    if (vcTargetSpeakerInput) {
        vcTargetSpeakerInput.value = speaker;
    }
    document.getElementById("dubbing-start").textContent = start.toFixed(2);
    document.getElementById("dubbing-end").textContent = end.toFixed(2);

    document.querySelectorAll(".segment-box.active").forEach(b => b.classList.remove("active"));
    activeBox = box;
    activeBox.classList.add("active");
    centerSegmentInGrid(activeBox);
    rememberLastEditedSegment(parseInt(activeBox.dataset.index, 10));
    const currentIndex = parseInt(activeBox.dataset.index, 10);
    if (
        Number.isFinite(previousIndex) &&
        Number.isFinite(currentIndex) &&
        previousIndex !== currentIndex &&
        typeof window.resetTtsEmotionAndEffectsControls === "function"
    ) {
        window.resetTtsEmotionAndEffectsControls();
    }

    updateDoneCheckboxState(box);

    // Always seek to selected segment start (source of truth for all play shortcuts).
    if (video && !isNaN(start)) {
        if (typeof window.seekVideoToTime === "function" && !preserveWaveformScroll) {
            window.seekVideoToTime(start);
        } else {
            video.currentTime = start;
        }
        if (!preserveWaveformScroll && typeof window.centerWaveformOnTime === "function") {
            window.centerWaveformOnTime(start);
        }
        const currentTimeElement = document.getElementById("currentTime");
        if (currentTimeElement) {
            currentTimeElement.textContent = formatTimecode(start);
        }
    }

    if (!isDone) {
        const text = box.querySelector('textarea[data-lang="en"]')?.value || "";
        const duration = end - start;
        scrollText(text, duration);
    } else {
        resetScrollText();
    }

    // No pre/post roll anymore
    document.getElementById("adjusted-start").textContent = start.toFixed(2);
    document.getElementById("adjusted-end").textContent = end.toFixed(2);

    if (!isDone) {
        const recording = recordingsMeta.find(r => Number(r.index) === index);
        if (recording && recording.file) {
            console.log("Found recording for segment", index, "file:", recording.file);
            await window.loadExistingRecording(recording);

            if (recording.fit_status) {
                updateTtsFitDisplay(recording);
            } else {
                resetTtsFitDisplay();
            }
        } else {

            console.log("No recording found for segment", index);
            const audioPlayer = document.getElementById("dubbing-audio");
            if (audioPlayer) {
                if (audioPlayer.src && audioPlayer.src.startsWith('blob:')) {
                    URL.revokeObjectURL(audioPlayer.src);
                }
                audioPlayer.src = "";
            }

            const waveformTrack = document.getElementById("waveform-timeline");
            if (waveformTrack) {
                waveformTrack.innerHTML = "<div style='text-align: center; color: #666; padding: 20px;'>No recording</div>";
            }
            resetTtsFitDisplay();
        }
    } else {
        const audioPlayer = document.getElementById("dubbing-audio");
        if (audioPlayer) {
            if (audioPlayer.src && audioPlayer.src.startsWith('blob:')) {
                URL.revokeObjectURL(audioPlayer.src);
            }
            audioPlayer.src = "";
        }

        const waveformTrack = document.getElementById("waveform-timeline");
        if (waveformTrack) {
            waveformTrack.innerHTML = "<div style='text-align: center; color: #666; padding: 20px;'>Segment completed</div>";
        }
        resetTtsFitDisplay();
    }
    if (typeof window.refreshRecentTtsWavesUi === "function") {
        try { window.refreshRecentTtsWavesUi(); } catch (e) { console.warn("refreshRecentTtsWavesUi failed:", e); }
    }
}
// Function to refresh all recordings from server (optional)
async function refreshRecordingsFromServer() {
    try {
        const response = await fetch(`/get_recordings?project=${encodeURIComponent(project)}&episode=${encodeURIComponent(episode)}`);
        const result = await response.json();
        
        if (result.status === 'ok' && result.recordings) {
            // Update local recordingsMeta array
            recordingsMeta = result.recordings;
            console.log('Refreshed recordings from server:', recordingsMeta);
            
            // If current active segment has a recording, reload it
            if (activeBox) {
                const index = parseInt(activeBox.dataset.index);
                const recording = recordingsMeta.find(r => r.index === index);
                if (recording) {
                    loadExistingRecording(recording);
                }
            }
            if (typeof window.refreshRecentTtsWavesUi === "function") {
                try { window.refreshRecentTtsWavesUi(); } catch (e) {}
            }
        }
    } catch (error) {
        console.error('Error refreshing recordings:', error);
    }
}
