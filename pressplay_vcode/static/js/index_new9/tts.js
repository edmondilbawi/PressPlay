function initializeTtsFeatures() {
const ttsBtn = document.getElementById("tts-btn");
const adaptSegmentBtn = document.getElementById("adapt-segment-btn");
const ttsUseEmotionControl = document.getElementById("tts-use-emotion-control");
const ttsEmoAlpha = document.getElementById("tts-emo-alpha");
const ttsEmoAlphaValue = document.getElementById("tts-emo-alpha-value");
const ttsEmotionMix = document.getElementById("tts-emotion-mix");
const ttsEmotionMixValue = document.getElementById("tts-emotion-mix-value");
const ttsRecentWaves = document.getElementById("tts-recent-waves");
const ttsLoadSelectedWaveBtn = document.getElementById("tts-load-selected-wave");
const vcBtn = document.getElementById("vc-btn");
const vcOriginalBtn = document.getElementById("vc-original-btn");
const vcTargetSpeakerInput = document.getElementById("vc-target-speaker");

function resetTtsEmotionAndEffectsControls() {
    if (ttsUseEmotionControl) ttsUseEmotionControl.checked = false;
    if (ttsEmoAlpha) ttsEmoAlpha.value = "1";
    if (ttsEmoAlphaValue) ttsEmoAlphaValue.textContent = "1";
    if (ttsEmotionMix) ttsEmotionMix.value = "0.65";
    if (ttsEmotionMixValue) ttsEmotionMixValue.textContent = "0.65";

    syncTtsEmotionUi();
}
window.resetTtsEmotionAndEffectsControls = resetTtsEmotionAndEffectsControls;

function getRecordingForIndex(idx) {
    return recordingsMeta.find(r => Number(r.index) === Number(idx));
}

function normalizeRecentWaves(recording) {
    const out = [];
    if (!recording) return out;
    const current = String(recording.file || "").trim();
    if (current) out.push(current);
    if (Array.isArray(recording.recent_waves)) {
        for (const f of recording.recent_waves) {
            const fs = String(f || "").trim();
            if (fs && !out.includes(fs)) out.push(fs);
        }
    }
    return out.slice(0, 3);
}

function waveLabel(file, idx) {
    const shortName = String(file || "").split(/[\\/]/).pop() || String(file || "");
    const maxLen = 52;
    const shown = shortName.length > maxLen ? `${shortName.slice(0, maxLen - 3)}...` : shortName;
    return `${idx + 1}. ${shown}`;
}

async function loadSelectedRecentWave() {
    if (!activeBox || !ttsRecentWaves) return;
    const selectedFile = String(ttsRecentWaves.value || "").trim();
    if (!selectedFile) return;

    const index = parseInt(activeBox.dataset.index, 10);
    const recording = getRecordingForIndex(index);
    if (!recording) return;

    recording.file = selectedFile;
    recording.recent_waves = normalizeRecentWaves(recording);
    try {
        const fd = new FormData();
        fd.append("project", project);
        fd.append("episode", episode);
        fd.append("index", String(index));
        fd.append("file", selectedFile);
        await fetch("/set_active_wave", { method: "POST", body: fd });
    } catch (e) {
        console.warn("Persist selected wave failed:", e);
    }
    await loadExistingRecording(recording);
    if (recording.fit_status) updateTtsFitDisplay(recording);
}

function refreshRecentTtsWavesUi() {
    if (!ttsRecentWaves) return;
    ttsRecentWaves.innerHTML = "";

    if (!activeBox) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "No active segment";
        ttsRecentWaves.appendChild(opt);
        ttsRecentWaves.disabled = true;
        if (ttsLoadSelectedWaveBtn) ttsLoadSelectedWaveBtn.disabled = true;
        return;
    }

    const index = parseInt(activeBox.dataset.index, 10);
    const recording = getRecordingForIndex(index);
    const recent = normalizeRecentWaves(recording);
    if (!recent.length) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "No generated waves";
        ttsRecentWaves.appendChild(opt);
        ttsRecentWaves.disabled = true;
        if (ttsLoadSelectedWaveBtn) ttsLoadSelectedWaveBtn.disabled = true;
        return;
    }

    recent.forEach((file, i) => {
        const opt = document.createElement("option");
        opt.value = file;
        opt.textContent = waveLabel(file, i);
        ttsRecentWaves.appendChild(opt);
    });
    ttsRecentWaves.value = recording?.file || recent[0];
    ttsRecentWaves.disabled = false;
    if (ttsLoadSelectedWaveBtn) ttsLoadSelectedWaveBtn.disabled = false;
}
window.refreshRecentTtsWavesUi = refreshRecentTtsWavesUi;

function syncTtsEmotionUi() {
    if (ttsEmoAlpha) ttsEmoAlpha.disabled = false;
    if (ttsEmotionMix) ttsEmotionMix.disabled = false;
}

if (ttsUseEmotionControl) {
    ttsUseEmotionControl.addEventListener("change", syncTtsEmotionUi);
}

function hasInlineEmotionTag(text) {
    return /\{[^{}]+\}/.test(String(text || ""));
}

if (ttsEmoAlpha && ttsEmoAlphaValue) {
    ttsEmoAlpha.addEventListener("input", () => {
        ttsEmoAlphaValue.textContent = ttsEmoAlpha.value;
    });
}

if (ttsEmotionMix && ttsEmotionMixValue) {
    ttsEmotionMix.addEventListener("input", () => {
        ttsEmotionMixValue.textContent = String(ttsEmotionMix.value);
    });
}

syncTtsEmotionUi();
refreshRecentTtsWavesUi();

if (ttsLoadSelectedWaveBtn) {
    ttsLoadSelectedWaveBtn.addEventListener("click", async () => {
        await loadSelectedRecentWave();
    });
}

// Selection alone does not replace the active wave.
// User must press "Apply Selected Wave".

if (ttsBtn) {
    ttsBtn.addEventListener("click", async () => {
        if (!activeBox) {
            alert("No segment selected.");
            return;
        }

        if (activeBox.classList.contains("done")) {
            alert("This segment is marked as completed.");
            return;
        }

        const index = parseInt(activeBox.dataset.index, 10);
        const start = parseFloat(activeBox.dataset.start);
        const end = parseFloat(activeBox.dataset.end);
        const speaker = document.getElementById("dubbing-speaker").textContent.trim() || "Unset";

        // fixed defaults after removing voice/speed UI
        const voice = "en-US-GuyNeural";
        const rate = "+0%";

        const text =
            activeBox.querySelector('textarea[data-lang="en"]')?.value?.trim() || "";

        if (!text) {
            alert("This segment has no English text for TTS preview.");
            return;
        }

        const useEmotionControl = hasInlineEmotionTag(text) ? "true" : "false";
        const emoAlpha = ttsEmoAlpha?.value || "1";
        const emotionMix = ttsEmotionMix?.value || "0.65";
        const useEmoTextPrompt = "true";

        ttsBtn.disabled = true;
        const oldLabel = ttsBtn.textContent;
        ttsBtn.textContent = "â³ Generating...";

        try {
            const formData = new FormData();
            formData.append("project", project);
            formData.append("episode", episode);
            formData.append("index", index);
            formData.append("speaker", speaker);
            formData.append("start", start);
            formData.append("end", end);
            formData.append("text", text);
            formData.append("voice", voice);
            formData.append("rate", rate);
            formData.append("use_emotion_control", useEmotionControl);

            formData.append("emo_alpha", emoAlpha);
            formData.append("emotion_mix", emotionMix);
            formData.append("use_emo_text_prompt", useEmoTextPrompt);

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 60000);

            const res = await fetch("/tts_segment", {
                method: "POST",
                body: formData,
                signal: controller.signal
            });

            clearTimeout(timeout);

            const result = await res.json();
            console.log("TTS result:", result); // âœ… ADD THIS LINE HERE
          

            if (result.status !== "ok") {
                throw new Error(result.message || "TTS generation failed");
            }

            const newRecording = {
                index: result.index,
                speaker: result.speaker,
                start: result.start,
                end: result.end,
                duration: result.tts_duration || +(end - start).toFixed(3),
                file: result.file,
                source: result.source,
                voice: result.voice,
                rate: result.rate || rate,
                tts_duration: result.tts_duration,
                segment_duration: result.segment_duration,
                delta: result.delta,
                fit_status: result.fit_status,
                fit_text: result.fit_text,
                use_emotion_control: result.use_emotion_control,
                emotion_mode: result.emotion_mode,
                emo_alpha: result.emo_alpha,
                emotion_mix: result.emotion_mix ?? emotionMix,
                emotion_preset: result.emotion_preset,
                text_tts: result.text_tts || text,
                recent_waves: Array.isArray(result.recent_waves) ? result.recent_waves : undefined,
            };

            const existingIndex = recordingsMeta.findIndex(r => r.index === index);
            if (existingIndex !== -1) recordingsMeta.splice(existingIndex, 1);
            recordingsMeta.push(newRecording);

            // force-refresh cache with the newly generated file
            try {
                const freshBlob = await cacheRecordingFromServer(newRecording.file);
                console.log("âœ… Generated TTS WAV refreshed in cache:", newRecording.file, freshBlob.size);
            } catch (cacheErr) {
                console.warn("âš ï¸ Failed to refresh generated WAV in cache:", cacheErr);
            }

            await loadExistingRecording(newRecording);
            updateTtsFitDisplay(newRecording);;
            refreshRecentTtsWavesUi();

            } catch (err) {
                console.error("âŒ TTS preview failed:", err);
                alert("TTS preview failed: " + (err.name === "AbortError" ? "request timeout" : err.message));
            } finally {
            ttsBtn.disabled = false;
            ttsBtn.textContent = oldLabel;
        }
    });
}

async function runVcGeneration(sourceMode) {
        if (!activeBox) {
            alert("No segment selected.");
            return;
        }

        if (activeBox.classList.contains("done")) {
            alert("This segment is marked as completed.");
            return;
        }

        const index = parseInt(activeBox.dataset.index, 10);
        const start = parseFloat(activeBox.dataset.start || "0");
        const end = parseFloat(activeBox.dataset.end || "0");
        const speaker = document.getElementById("dubbing-speaker")?.textContent?.trim() || "Unset";
        const targetSpeaker = (vcTargetSpeakerInput?.value || "").trim() || speaker;

        const sourceRecording = recordingsMeta.find(r => Number(r.index) === index && r.file);
        if (sourceMode !== "original" && !sourceRecording?.file) {
            alert("No source recording found for this segment. Record first, then run VC.");
            return;
        }

        if (vcBtn) vcBtn.disabled = true;
        if (vcOriginalBtn) vcOriginalBtn.disabled = true;
        const activeBtn = sourceMode === "original" ? vcOriginalBtn : vcBtn;
        const oldLabel = activeBtn ? activeBtn.textContent : "";
        if (activeBtn) activeBtn.textContent = "Converting VC...";

        try {
            const formData = new FormData();
            formData.append("project", project);
            formData.append("episode", episode);
            formData.append("index", index);
            formData.append("speaker", speaker);
            formData.append("start", start);
            formData.append("end", end);
            formData.append("source_mode", sourceMode);
            if (sourceRecording?.file) {
                formData.append("source_file", sourceRecording.file);
            }
            formData.append("target_speaker", targetSpeaker);

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 180000);

            const res = await fetch("/vc_segment", {
                method: "POST",
                body: formData,
                signal: controller.signal
            });
            clearTimeout(timeout);

            const result = await res.json();
            if (result.status !== "ok") {
                throw new Error(result.message || "VC generation failed");
            }

            const newRecording = {
                index: result.index,
                speaker: result.speaker,
                start: result.start,
                end: result.end,
                duration: result.tts_duration || +(end - start).toFixed(3),
                file: result.file,
                source: result.source,
                voice: result.voice,
                rate: result.rate || "+0%",
                tts_duration: result.tts_duration,
                segment_duration: result.segment_duration,
                delta: result.delta,
                fit_status: result.fit_status,
                fit_text: result.fit_text,
                vc_target_speaker: result.vc_target_speaker,
                vc_source_file: result.vc_source_file,
                pre_roll_sec: Number.isFinite(Number(result.pre_roll_sec))
                    ? Number(result.pre_roll_sec)
                    : 0,
                post_roll_sec: Number.isFinite(Number(result.post_roll_sec))
                    ? Number(result.post_roll_sec)
                    : 0,
                recent_waves: Array.isArray(sourceRecording?.recent_waves) ? sourceRecording.recent_waves : undefined,
            };

            const existingIndex = recordingsMeta.findIndex(r => Number(r.index) === index);
            if (existingIndex !== -1) recordingsMeta.splice(existingIndex, 1);
            recordingsMeta.push(newRecording);

            try {
                await cacheRecordingFromServer(newRecording.file);
            } catch (cacheErr) {
                console.warn("VC cache refresh failed:", cacheErr);
            }

            await loadExistingRecording(newRecording);
            updateTtsFitDisplay(newRecording);
            refreshRecentTtsWavesUi();
        } catch (err) {
            console.error("VC generation failed:", err);
            alert("VC failed: " + (err.name === "AbortError" ? "request timeout" : err.message));
        } finally {
            if (vcBtn) vcBtn.disabled = false;
            if (vcOriginalBtn) vcOriginalBtn.disabled = false;
            if (activeBtn) activeBtn.textContent = oldLabel;
        }
}

if (vcBtn) {
    vcBtn.addEventListener("click", async () => {
        await runVcGeneration("recorded");
    });
}

if (vcOriginalBtn) {
    vcOriginalBtn.addEventListener("click", async () => {
        await runVcGeneration("original");
    });
}

if (adaptSegmentBtn) {
    adaptSegmentBtn.addEventListener("click", async () => {
        if (!activeBox) {
            alert("No segment selected.");
            return;
        }

        const index = parseInt(activeBox.dataset.index, 10);
        const start = parseFloat(activeBox.dataset.start || "0");
        const end = parseFloat(activeBox.dataset.end || "0");
        const speaker = document.getElementById("dubbing-speaker")?.textContent?.trim() || "Unset";
        const textArea = activeBox.querySelector('textarea[data-lang="en"]');
        const sourceText = textArea?.value?.trim() || "";

        if (!sourceText) {
            alert("This segment has no English text to adapt.");
            return;
        }

        adaptSegmentBtn.disabled = true;
        const oldLabel = adaptSegmentBtn.textContent;
        adaptSegmentBtn.textContent = "Adapting...";
        let timeout = null;
        let controller = null;

        try {
            const formData = new FormData();
            formData.append("project", project);
            formData.append("episode", episode);
            formData.append("index", index);
            controller = new AbortController();
            timeout = setTimeout(() => controller.abort(), 180000);

            const res = await fetch("/adapt_segment", {
                method: "POST",
                body: formData,
                signal: controller.signal,
            });
            clearTimeout(timeout);
            timeout = null;

            const result = await res.json();
            if (result.status !== "ok") {
                throw new Error(result.message || "Adapt failed");
            }

            const adaptedText = (result.adapted_text || "").trim();
            if (!adaptedText) {
                throw new Error("Empty adapted text returned");
            }

            if (textArea) {
                textArea.value = adaptedText;
                textArea.dispatchEvent(new Event("input", { bubbles: true }));
            }

            if (typeof saveSubtitle === "function") {
                await saveSubtitle(index, "en", adaptedText, speaker, start, end);
            }
            if (typeof updateCPS === "function") {
                updateCPS(index);
            }

            console.log("Adapted segment", index, result.pause_pattern || "");
        } catch (err) {
            console.error("Adapt segment failed:", err);
            alert("Adapt segment failed: " + (err.name === "AbortError" ? "request timeout" : (err.message || err)));
        } finally {
            if (timeout) {
                clearTimeout(timeout);
            }
            adaptSegmentBtn.disabled = false;
            adaptSegmentBtn.textContent = oldLabel;
        }
    });
}

document.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (!target.closest(".segment-box")) return;
    setTimeout(() => {
        try { refreshRecentTtsWavesUi(); } catch (err) {}
    }, 0);
});
}

