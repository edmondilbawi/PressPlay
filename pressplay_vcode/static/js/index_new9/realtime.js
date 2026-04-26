// Ensure split function is available globally for inline button onclick.
// Do not override the main implementation from segments.js if already present.
if (typeof window.splitSegmentAtCurrentTime !== "function") {
window.splitSegmentAtCurrentTime = async function() {
    if (typeof window.isEpisodeEditRestricted === "function" && window.isEpisodeEditRestricted()) {
        alert(`Editing is locked by ${window.__episodeEditRestrictedBy || "another user"}.`);
        return;
    }
    const activeSegment =
        document.querySelector('.segment-box.active') ||
        document.querySelector('.segment-box');

    if (!activeSegment) {
        alert('No segment selected.');
        return;
    }

    const segmentIndex = parseInt(activeSegment.dataset.index, 10);
    const segmentStart = parseFloat(activeSegment.dataset.start);
    const segmentEnd = parseFloat(activeSegment.dataset.end);

    if (!Number.isFinite(segmentIndex) || !Number.isFinite(segmentStart) || !Number.isFinite(segmentEnd)) {
        alert('Invalid segment data');
        return;
    }

    if (segmentEnd <= segmentStart) {
        alert('Invalid segment duration');
        return;
    }

    // split into 2 equal halves
    const splitTime = (segmentStart + segmentEnd) / 2;

    const tc = (typeof formatTimecode === 'function')
        ? formatTimecode(splitTime)
        : splitTime.toFixed(2);

    if (!confirm(`Split selected segment into 2 equal parts at ${tc}?`)) {
        return;
    }

    const formData = new FormData();
    formData.append('project', window.currentProject || (typeof project !== 'undefined' ? project : ''));
    formData.append('episode', window.currentEpisode || (typeof episode !== 'undefined' ? episode : ''));
    formData.append('segment_index', String(segmentIndex));
    formData.append('split_time', splitTime.toFixed(6));
    formData.append('editor_user_id', sessionStorage.getItem("subtitleUserId") || "");
    formData.append('editor_session_id', sessionStorage.getItem("subtitleSessionId") || "");

    try {
        if (typeof setInsertStatus === 'function') {
            setInsertStatus('Splitting segment...', '#ffa500');
        }

        const response = await fetch('/split_segment', {
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
            setInsertStatus('Segment split successfully!', '#28a745');
        }
        window.__suppressSegmentsChangedRefreshUntil = Date.now() + 2000;
        if (typeof refreshSegmentsOnly === 'function') {
            await refreshSegmentsOnly({ background: false, reason: "split" });
        } else if (typeof window.scheduleSegmentsRefresh === "function") {
            window.scheduleSegmentsRefresh("split", 0);
        }
        window.__suppressSegmentsChangedRefreshUntil = 0;
    } catch (error) {
        console.error('Error splitting segment:', error);
        if (typeof setInsertStatus === 'function') {
            setInsertStatus(`Error: ${error.message}`, '#dc3545');
        } else {
            alert(`Split failed: ${error.message}`);
        }
    }
};
}

document.addEventListener('keydown', function(e) {
    if (e.repeat) return;
    if (typeof window.isEpisodeEditRestricted === "function" && window.isEpisodeEditRestricted()) {
        return;
    }
    const key = (e.key || '').toLowerCase();

    // 🚫 Ignore if typing in inputs
    const active = document.activeElement;
    const isTyping =
        active &&
        (active.tagName === "TEXTAREA" ||
         active.tagName === "INPUT" ||
         active.isContentEditable);

    // ✅ CTRL + I → INSERT SEGMENT
    if (e.ctrlKey && key === 'i') {
        if (isTyping) return;

        e.preventDefault();
        e.stopPropagation();

        console.log("⌨️ CTRL+I → Insert Segment");
        insertSegmentAtCurrentTime();
        return;
    }

    // ✂️ CTRL + SHIFT + S → SPLIT
    if (e.ctrlKey && e.shiftKey && key === 's') {
        if (isTyping) return;

        e.preventDefault();
        e.stopPropagation();

        console.log("⌨️ CTRL+SHIFT+S → Split Segment");
        splitSegmentAtCurrentTime();
        return;
    }

    if (e.ctrlKey && e.shiftKey && key === 'd') {
        if (isTyping) return;
        e.preventDefault();
        e.stopPropagation();
        deleteSelectedSegment();
        return;
    }


}, true);
