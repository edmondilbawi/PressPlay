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

        // Helper function to generate consistent colors for speakers
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

        speaker = (speaker || "Unset").trim();

        // djb2
        let hash = 5381;
        for (let i = 0; i < speaker.length; i++) {
            hash = ((hash << 5) + hash) + speaker.charCodeAt(i);
            hash = hash >>> 0; // force uint32
        }

        return colors[hash % colors.length];
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
                // Arabic will be mirrored automatically (no AR input, no "جديد", no duplication)
                addNewSpeaker(enName, null, index, lang);
                document.body.removeChild(overlay);
                document.body.removeChild(dialog);
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
