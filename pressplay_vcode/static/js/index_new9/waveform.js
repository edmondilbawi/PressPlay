function rgbToHex(rgb) {
            // Choose a default color if parsing fails
            const defaultColor = "#3498db";
            
            try {
                // Extract RGB values from rgb() or rgba() string
                const match = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)/);
                if (match) {
                    const r = parseInt(match[1]);
                    const g = parseInt(match[2]);
                    const b = parseInt(match[3]);
                    
                    return "#" + 
                        (r < 16 ? "0" : "") + r.toString(16) +
                        (g < 16 ? "0" : "") + g.toString(16) +
                        (b < 16 ? "0" : "") + b.toString(16);
                }
            } catch (e) {
                console.warn("Failed to convert RGB to HEX:", rgb, e);
            }
            
            return defaultColor;
        }


        function getNeighborBounds(box) {
        const idx = parseInt(box?.dataset?.index || "0", 10);

        const prevBox = document.querySelector(`.segment-box[data-index="${idx - 1}"]`);
        const nextBox = document.querySelector(`.segment-box[data-index="${idx + 1}"]`);

        let prevEnd = prevBox ? parseFloat(prevBox.dataset.end) : 0;
        let nextStart = nextBox ? parseFloat(nextBox.dataset.start) : Infinity;

        if (!Number.isFinite(prevEnd)) prevEnd = 0;
        if (!Number.isFinite(nextStart)) nextStart = Infinity;

        return { prevEnd, nextStart };
        }



          

        function getScrollParent(el) {
        let p = el?.parentElement;
        while (p) {
            const style = getComputedStyle(p);
            const overflowY = style.overflowY;
            const canScroll =
            (overflowY === "auto" || overflowY === "scroll") &&
            p.scrollHeight > p.clientHeight;

            if (canScroll) return p;
            p = p.parentElement;
        }
        // fallback: page scrolling element
        return document.scrollingElement || document.documentElement;
        }

        function centerSegmentInGrid(box) {
        if (!box) return;

        const scroller = getScrollParent(box);

        const sRect = scroller.getBoundingClientRect();
        const bRect = box.getBoundingClientRect();

        // Where the box top is inside the scroller content (not viewport)
        const boxTopInScroller = (bRect.top - sRect.top) + scroller.scrollTop;

        // Target scrollTop so the box is vertically centered
        const target =
            boxTopInScroller - (scroller.clientHeight / 2) + (bRect.height / 2);

        scroller.scrollTo({
            top: target,
            behavior: "smooth"
        });
        }

        function centerSegmentInGrid(box) {
        if (!box) return;

        // Try to detect scroll container first
        const container =
            document.querySelector(".segments-container") ||
            document.querySelector("#segments-container") ||
            document.querySelector(".segments-grid") ||
            null;

        if (container) {
            const containerRect = container.getBoundingClientRect();
            const boxRect = box.getBoundingClientRect();

            const offset =
            boxRect.top -
            containerRect.top -
            containerRect.height / 2 +
            boxRect.height / 2;

            container.scrollBy({
            top: offset,
            behavior: "smooth"
            });
        } else {
            // fallback
            box.scrollIntoView({
            behavior: "smooth",
            block: "center"
            });
        }
        }        

        // Helper function to convert hex color to rgba
        function hexToRgba(hex, alpha) {
            // Remove the # if present
            hex = hex.replace('#', '');
            
            // Parse the hex values
            const r = parseInt(hex.substring(0, 2), 16);
            const g = parseInt(hex.substring(2, 4), 16);
            const b = parseInt(hex.substring(4, 6), 16);
            
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }

        // Helper function to add speaker label to region
        function addSpeakerLabelToRegion(region, speaker) {
            // Remove any existing label first to avoid duplicates
            const existingLabel = region.element.querySelector('.region-label');
            if (existingLabel) {
                existingLabel.remove();
            }
            
            // Create a label element
            const label = document.createElement('div');
            label.className = 'region-label';
            label.textContent = speaker;
            
            // Style the label
            label.style.position = 'absolute';
            label.style.top = '2px';
            label.style.left = '5px';
            label.style.fontSize = '10px';
            label.style.color = 'white';
            label.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
            label.style.padding = '1px 4px';
            label.style.borderRadius = '2px';
            label.style.pointerEvents = 'none';
            label.style.zIndex = '10';
            
            // Add the label to the region element
            const regionElement = region.element;
            regionElement.appendChild(label);
        }

        // Helper function to generate unique-yet-stable colors for speakers in current episode
        function getSpeakerColor(speaker) {
        const colors = [
        "#3F51B5",
        "#4CAF50",
        "#FF9800",
        "#9C27B0",
        "#009688",
        "#795548",
        "#607D8B",
        "#2196F3",
        "#8BC34A",
        "#00BCD4",
        "#673AB7",
        "#FFC107",
        "#CDDC39",
        "#03A9F4",
        "#FF5722",
        "#6D4C41",
        "#26A69A",
        "#5C6BC0"
        ];

        function normalizeColor(c) {
            const raw = String(c || "").trim();
            if (!raw) return "";
            if (raw.startsWith("#")) {
                const hex = raw.toLowerCase();
                if (hex.length === 4) {
                    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
                }
                return hex;
            }
            if (raw.startsWith("rgb")) return rgbToHex(raw).toLowerCase();
            return raw.toLowerCase();
        }

        function hash32(text) {
            let h = 5381;
            for (let i = 0; i < text.length; i++) {
                h = ((h << 5) + h) + text.charCodeAt(i);
                h = h >>> 0;
            }
            return h >>> 0;
        }

        function hslToHex(h, s, l) {
            const sat = Math.max(0, Math.min(100, s)) / 100;
            const lig = Math.max(0, Math.min(100, l)) / 100;
            const c = (1 - Math.abs(2 * lig - 1)) * sat;
            const hp = ((h % 360) + 360) % 360 / 60;
            const x = c * (1 - Math.abs((hp % 2) - 1));
            let r1 = 0, g1 = 0, b1 = 0;
            if (hp >= 0 && hp < 1) { r1 = c; g1 = x; b1 = 0; }
            else if (hp < 2) { r1 = x; g1 = c; b1 = 0; }
            else if (hp < 3) { r1 = 0; g1 = c; b1 = x; }
            else if (hp < 4) { r1 = 0; g1 = x; b1 = c; }
            else if (hp < 5) { r1 = x; g1 = 0; b1 = c; }
            else { r1 = c; g1 = 0; b1 = x; }
            const m = lig - c / 2;
            const r = Math.round((r1 + m) * 255);
            const g = Math.round((g1 + m) * 255);
            const b = Math.round((b1 + m) * 255);
            return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
        }

        function ensureSpeakerColorMap() {
            if (!window.__speakerColorMap) window.__speakerColorMap = {};
            if (window.__speakerColorMapInitialized) return window.__speakerColorMap;
            window.__speakerColorMapInitialized = true;

            document.querySelectorAll(".segment-box").forEach((box) => {
                const enDropdown = box.querySelector('.speaker-dropdown[data-lang="en"]');
                const enHeader = box.querySelector(".segment-col .segment-header");
                const spk = String(enDropdown?.value || "").trim();
                if (!spk) return;
                const styleColor = enHeader ? (enHeader.style.backgroundColor || window.getComputedStyle(enHeader).backgroundColor) : "";
                const normalized = normalizeColor(styleColor);
                if (normalized && !window.__speakerColorMap[spk]) {
                    window.__speakerColorMap[spk] = normalized;
                }
            });
            return window.__speakerColorMap;
        }

        speaker = (speaker || "Unset").trim();
        const speakerColorMap = ensureSpeakerColorMap();
        if (speakerColorMap[speaker]) return speakerColorMap[speaker];

        const used = new Set(Object.values(speakerColorMap).map(normalizeColor).filter(Boolean));
        let chosen = "";
        for (const base of colors) {
            const normalized = normalizeColor(base);
            if (!used.has(normalized)) {
                chosen = normalized;
                break;
            }
        }

        if (!chosen) {
            // Palette exhausted: generate non-used fallback colors.
            const seed = hash32(speaker);
            for (let i = 0; i < 360; i += 7) {
                const h = (seed + i) % 360;
                const candidate = normalizeColor(hslToHex(h, 62, 48));
                if (!used.has(candidate)) {
                    chosen = candidate;
                    break;
                }
            }
        }

        if (!chosen) chosen = "#3498db";
        speakerColorMap[speaker] = chosen;
        return chosen;
        }

        function showAddSpeakerDialog(index, lang) {
            // Create dialog overlay
            const overlay = document.createElement('div');
            overlay.className = 'dialog-overlay';
            
            // Create dialog
            const dialog = document.createElement('div');
            dialog.className = 'add-speaker-dialog';
            dialog.innerHTML = `
                <h3>Add New Speaker</h3>
                <label>English Name:</label>
                <input type="text" id="new-speaker-en" placeholder="Enter English name">
                <div style="text-align: right; margin-top: 15px;">
                    <button id="cancel-add-speaker">Cancel</button>
                    <button id="save-new-speaker" style="background: #007bff; color: white;">Save</button>
                </div>
            `;
            
            document.body.appendChild(overlay);
            document.body.appendChild(dialog);
            
            // Event listeners
            document.getElementById('cancel-add-speaker').onclick = function() {
                document.body.removeChild(overlay);
                document.body.removeChild(dialog);
            };
            
            document.getElementById('save-new-speaker').onclick = function() {
            const enName = document.getElementById('new-speaker-en').value.trim();

            if (enName) {
                try {
                    const addFn = (typeof window.addNewSpeaker === "function")
                        ? window.addNewSpeaker
                        : (typeof addNewSpeaker === "function" ? addNewSpeaker : null);
                    if (!addFn) {
                        throw new Error("addNewSpeaker is not available");
                    }
                    addFn(enName, null, index, lang);
                    document.body.removeChild(overlay);
                    document.body.removeChild(dialog);
                } catch (err) {
                    console.error("Add speaker failed:", err);
                    alert("Failed to add speaker. Please try again.");
                }
            } else {
                alert('Please enter an English speaker name');
            }
            };
            
            // Close on overlay click
            overlay.onclick = function() {
                document.body.removeChild(overlay);
                document.body.removeChild(dialog);
            };
            
            // Enter key support
            document.getElementById('new-speaker-en').addEventListener('keypress', function(e) {
                if (e.key === 'Enter') {
                    document.getElementById('save-new-speaker').click();
                }
            });
        }

        // Enhanced function to update region text label
        function updateRegionTextLabel(index) {
            if (!regions[index]) return;
            
            const box = document.querySelector(`.segment-box[data-index="${index}"]`);
            if (!box) return;
            
            // Get text content from English textarea
            const enTextarea = box.querySelector('textarea[data-lang="ar"]');
            let displayText = "No text";
            
            if (enTextarea && enTextarea.value.trim()) {
                displayText = enTextarea.value.trim();
            }
            
            // Get speaker
            const speakerDropdown = box.querySelector(".speaker-dropdown");
            const speaker = speakerDropdown?.value || "Unknown";
            
            // Update the region label with new text
            addTextLabelToRegion(regions[index], displayText, speaker);
            
            console.log(`Updated region ${index} text label on resize/zoom`);
        }

        // Update region text when editing
        function updateRegionTextOnEdit(index, newText) {
            if (regions[index]) {
                // Update the region label with new text
                const region = regions[index];
                const speakerDropdown = document.querySelector(`.speaker-dropdown[data-index="${index}"][data-lang="ar"]`);
                const speaker = speakerDropdown?.value || "Unknown";
                
                // Remove existing label and create new one with updated text
                addTextLabelToRegion(region, newText, speaker);
            }
        }
