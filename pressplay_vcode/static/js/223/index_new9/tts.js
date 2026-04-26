function initializeTtsFeatures() {
const ttsBtn = document.getElementById("tts-btn");
const adaptSegmentBtn = document.getElementById("adapt-segment-btn");
const ttsUseEmotionControl = document.getElementById("tts-use-emotion-control");
const ttsEmoAlpha = document.getElementById("tts-emo-alpha");
const ttsEmoAlphaValue = document.getElementById("tts-emo-alpha-value");
const ttsEmotionMix = document.getElementById("tts-emotion-mix");
const ttsEmotionMixValue = document.getElementById("tts-emotion-mix-value");
const ttsEmotionPresetWrap = document.getElementById("tts-emotion-preset-wrap");
const ttsEmotionPreset = document.getElementById("tts-emotion-preset");
const vcBtn = document.getElementById("vc-btn");
const vcOriginalBtn = document.getElementById("vc-original-btn");
const vcTargetSpeakerInput = document.getElementById("vc-target-speaker");

function resetTtsEmotionAndEffectsControls() {
    if (ttsUseEmotionControl) ttsUseEmotionControl.checked = false;
    if (ttsEmotionPreset) ttsEmotionPreset.value = "neutral";
    if (ttsEmoAlpha) ttsEmoAlpha.value = "1";
    if (ttsEmoAlphaValue) ttsEmoAlphaValue.textContent = "1";
    if (ttsEmotionMix) ttsEmotionMix.value = "0.65";
    if (ttsEmotionMixValue) ttsEmotionMixValue.textContent = "0.65";

    syncTtsEmotionUi();
}
window.resetTtsEmotionAndEffectsControls = resetTtsEmotionAndEffectsControls;

function syncTtsEmotionUi() {
    const enabled = !!ttsUseEmotionControl?.checked;

    if (ttsEmoAlpha) ttsEmoAlpha.disabled = false;
    if (ttsEmotionMix) ttsEmotionMix.disabled = !enabled;

    if (ttsEmotionPresetWrap) {
        ttsEmotionPresetWrap.style.display = enabled ? "block" : "none";
    }
}

if (ttsUseEmotionControl) {
    ttsUseEmotionControl.addEventListener("change", syncTtsEmotionUi);
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

        const useEmotionControl = ttsUseEmotionControl?.checked ? "true" : "false";
        const emoAlpha = ttsEmoAlpha?.value || "0.65";
        const emotionMix = ttsEmotionMix?.value || "0.65";
        const emotionPreset = ttsEmotionPreset?.value || "neutral";
        const useEmoTextPrompt = "true";

        ttsBtn.disabled = true;
        const oldLabel = ttsBtn.textContent;
        ttsBtn.textContent = "⏳ Generating...";

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

            if (useEmotionControl === "true") {
                formData.append("emotion_preset", emotionPreset);
            }

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 60000);

            const res = await fetch("/tts_segment", {
                method: "POST",
                body: formData,
                signal: controller.signal
            });

            clearTimeout(timeout);

            const result = await res.json();
            console.log("TTS result:", result); // ✅ ADD THIS LINE HERE
          

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
            };

            const existingIndex = recordingsMeta.findIndex(r => r.index === index);
            if (existingIndex !== -1) recordingsMeta.splice(existingIndex, 1);
            recordingsMeta.push(newRecording);

            // force-refresh cache with the newly generated file
            try {
                const freshBlob = await cacheRecordingFromServer(newRecording.file);
                console.log("✅ Generated TTS WAV refreshed in cache:", newRecording.file, freshBlob.size);
            } catch (cacheErr) {
                console.warn("⚠️ Failed to refresh generated WAV in cache:", cacheErr);
            }

            await loadExistingRecording(newRecording);
            updateTtsFitDisplay(newRecording);;

            } catch (err) {
                console.error("❌ TTS preview failed:", err);
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

        try {
            const formData = new FormData();
            formData.append("project", project);
            formData.append("episode", episode);
            formData.append("index", index);

            const res = await fetch("/adapt_segment", {
                method: "POST",
                body: formData,
            });

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
            alert("Adapt segment failed: " + (err.message || err));
        } finally {
            adaptSegmentBtn.disabled = false;
            adaptSegmentBtn.textContent = oldLabel;
        }
    });
}
}
