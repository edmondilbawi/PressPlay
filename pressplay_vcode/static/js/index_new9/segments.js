// Segment insertion functionality
        function getProjectEpisodeSafe() {
            const boot = window.__EDITOR_BOOTSTRAP__ || {};
            const projectName = window.currentProject || boot.project || "";
            const episodeName = window.currentEpisode || boot.episode || "";
            return { projectName, episodeName };
        }

        window.insertSegmentAtCurrentTime = function insertSegmentAtCurrentTime() {
            const videoEl = window.video || document.getElementById('videoPlayer');
            if (!videoEl) {
                alert("Video not loaded");
                return;
            }

            const start = Number(videoEl.currentTime || 0);
            const duration = 1.0;

            let speaker = "Unset";
            const activeSeg = document.querySelector(".segment-box.active");
            if (activeSeg) {
                const activeSpeaker = activeSeg.querySelector('.speaker-dropdown[data-lang="en"]');
                if (activeSpeaker && activeSpeaker.value) {
                    speaker = activeSpeaker.value;
                }
            }

            insertNewSegment(start, duration, speaker, "", "");
        };

        window.showInsertSegmentDialog = function showInsertSegmentDialog(startTime = null, duration = 1.0) {
            // Create dialog overlay
            const overlay = document.createElement('div');
            overlay.className = 'dialog-overlay';
            
            // Create dialog
            const dialog = document.createElement('div');
            dialog.className = 'add-speaker-dialog';
            dialog.innerHTML = `
                <h3>Insert New Segment</h3>
                <label>Start Time (seconds):</label>
                <input type="number" id="insert-start-time" step="0.01" value="${startTime || 0}" style="width: 100%;">
                
                <label>Duration (seconds):</label>
                <input type="number" id="insert-duration" step="0.01" value="${duration}" style="width: 100%;">
                
                <label>Speaker:</label>
                <select id="insert-speaker" style="width: 100%; padding: 8px; margin: 8px 0;">
                    ${getSpeakerOptions()}
                </select>
                
                <label>English Text:</label>
                <textarea id="insert-english-text" placeholder="Enter English text" style="width: 100%; height: 60px; padding: 8px; margin: 8px 0;"></textarea>
                
                <label>Arabic Text:</label>
                <textarea id="insert-arabic-text" placeholder="Enter Arabic text" style="width: 100%; height: 60px; padding: 8px; margin: 8px 0;"></textarea>
                
                <div style="text-align: right; margin-top: 15px;">
                    <button id="cancel-insert">Cancel</button>
                    <button id="confirm-insert" style="background: #28a745; color: white;">Insert Segment</button>
                </div>
            `;
            
            document.body.appendChild(overlay);
            document.body.appendChild(dialog);
            
            // Event listeners
            document.getElementById('cancel-insert').onclick = function() {
                document.body.removeChild(overlay);
                document.body.removeChild(dialog);
            };
            
            document.getElementById('confirm-insert').onclick = function() {
                const start = parseFloat(document.getElementById('insert-start-time').value);
                const duration = parseFloat(document.getElementById('insert-duration').value);
                const speaker = document.getElementById('insert-speaker').value;
                const englishText = document.getElementById('insert-english-text').value;
                const arabicText = document.getElementById('insert-arabic-text').value;
                
                if (isNaN(start) || isNaN(duration) || duration <= 0) {
                    alert('Please enter valid start time and duration');
                    return;
                }
                
                insertNewSegment(start, duration, speaker, englishText, arabicText);
                document.body.removeChild(overlay);
                document.body.removeChild(dialog);
            };
            
            // Close on overlay click
            overlay.onclick = function() {
                document.body.removeChild(overlay);
                document.body.removeChild(dialog);
            };
            
            // Enter key support
            document.getElementById('insert-start-time').addEventListener('keypress', function(e) {
                if (e.key === 'Enter') {
                    document.getElementById('confirm-insert').click();
                }
            });
        }

        function getSpeakerOptions() {
            let uniqueSpeakers = new Map(); // Use Map to store unique speakers by value
            let addNewOption = ''; // Store the "add_new" option separately
            
            document.querySelectorAll('.speaker-dropdown option').forEach(option => {
                if (option.value === '+add_new') {
                    // Store the "Add New" option
                    addNewOption = `<option value="${option.value}">${option.textContent}</option>`;
                } else if (option.value) {
                    // Use the value as key to ensure uniqueness for regular speakers
                    if (!uniqueSpeakers.has(option.value)) {
                        uniqueSpeakers.set(option.value, option.textContent);
                    }
                }
            });
            
            // Build the options string from unique speakers
            let options = addNewOption; // Start with "Add New" option
            
            // Add all unique speakers
            uniqueSpeakers.forEach((text, value) => {
                options += `<option value="${value}">${text}</option>`;
            });
            
            return options;
        }

        // Enhanced insert function with better error handling
        async function insertNewSegment(start, duration, speaker, englishText, arabicText) {
            if (typeof window.isEpisodeEditRestricted === "function" && window.isEpisodeEditRestricted()) {
                alert(`Editing is locked by ${window.__episodeEditRestrictedBy || "another user"}.`);
                return;
            }
            const end = start + duration;
            const insertStatus = document.getElementById('insert-status');
            const { projectName, episodeName } = getProjectEpisodeSafe();
            
            try {
                setInsertStatus('Inserting segment...', '#ffa500');
                
                // Prepare the data for the new segment
                const formData = new FormData();
                formData.append('project', projectName);
                formData.append('episode', episodeName);
                formData.append('start', start.toFixed(6));
                formData.append('end', end.toFixed(6));
                formData.append('speaker', speaker);
                formData.append('english_text', englishText);
                formData.append('arabic_text', arabicText);
                formData.append('editor_user_id', sessionStorage.getItem("subtitleUserId") || "");
                formData.append('editor_session_id', sessionStorage.getItem("subtitleSessionId") || "");
                
                console.log('Sending insert request:', {
                    project: projectName, episode: episodeName, start, end, speaker, englishText, arabicText
                });
                window.__suppressSegmentsChangedRefreshUntil = Date.now() + 3000;
                
                // Send request to server to insert segment
                const response = await fetch('/insert_segment', {
                    method: 'POST',
                    body: formData
                });
                
                // Get the response as text first
                const responseText = await response.text();
                console.log('Raw server response:', responseText);
                
                let result;
                try {
                    // Try to parse as JSON
                    result = JSON.parse(responseText);
                } catch (jsonError) {
                    console.error('Failed to parse JSON response:', jsonError);
                    // If it's not JSON, check if it's an HTML error page
                    if (responseText.includes('<!DOCTYPE html>') || responseText.includes('<html>')) {
                        throw new Error('Server returned HTML error page. Check server console for details.');
                    } else {
                        throw new Error(`Server returned invalid response: ${responseText.substring(0, 100)}`);
                    }
                }
                
                // Now check if the response was successful
                if (!response.ok) {
                    throw new Error(result.message || `Server error: ${response.status}`);
                }
                
                // Check the result status
                if (result.status === 'success') {
                    setInsertStatus('Segment inserted successfully!', '#28a745');
                    window.__suppressSegmentsChangedRefreshUntil = Date.now() + 2000;
                    if (typeof refreshSegmentsOnly === 'function') {
                        await refreshSegmentsOnly({ background: false, reason: "insert" });
                    } else if (typeof window.scheduleSegmentsRefresh === "function") {
                        window.scheduleSegmentsRefresh("insert", 0);
                    }
                    window.__suppressSegmentsChangedRefreshUntil = 0;
                    
                } else {
                    throw new Error(result.message || 'Failed to insert segment');
                }
                
            } catch (error) {
                console.error('Error inserting segment:', error);
                window.__suppressSegmentsChangedRefreshUntil = 0;
                
                setInsertStatus(`Error: ${error.message}`, '#dc3545');
                
                setTimeout(() => {
                    setInsertStatus('Ready to insert', '#666');
                }, 5000);
            }
        }

        // Function to split segment at current time
        function splitSegmentAtCurrentTime() {
            const videoEl = window.video || document.getElementById('videoPlayer');
            if (!videoEl) {
                alert("Video not loaded");
                return;
            }
            
            const currentTime = Number(videoEl.currentTime || 0);
            const activeSegment =
                document.querySelector('.segment-box.active') ||
                findSegmentAtTime(currentTime);
            
            if (!activeSegment) {
                alert("No segment selected.");
                return;
            }
            
            const segmentIndex = parseInt(activeSegment.dataset.index);
            const segmentStart = parseFloat(activeSegment.dataset.start);
            const segmentEnd = parseFloat(activeSegment.dataset.end);
            
            let splitAt = currentTime;
            if (splitAt <= segmentStart || splitAt >= segmentEnd) {
                splitAt = (segmentStart + segmentEnd) / 2;
            }

            if (confirm(`Split segment at ${formatTimecode(splitAt)}?`)) {
                splitSegment(segmentIndex, splitAt);
            }
        }

        function findSegmentAtTime(time) {
            const segments = document.querySelectorAll('.segment-box');
            for (let segment of segments) {
                const start = parseFloat(segment.dataset.start);
                const end = parseFloat(segment.dataset.end);
                if (time >= start && time <= end) {
                    return segment;
                }
            }
            return null;
        }

        async function splitSegment(segmentIndex, splitTime) {
            if (typeof window.isEpisodeEditRestricted === "function" && window.isEpisodeEditRestricted()) {
                alert(`Editing is locked by ${window.__episodeEditRestrictedBy || "another user"}.`);
                return;
            }
            try {
                const insertStatus = document.getElementById('insert-status');
                const { projectName, episodeName } = getProjectEpisodeSafe();
                setInsertStatus('Splitting segment...', '#ffa500');
                
                const formData = new FormData();
                formData.append('project', projectName);
                formData.append('episode', episodeName);
                formData.append('segment_index', segmentIndex);
                formData.append('split_time', splitTime.toFixed(6));
                formData.append('editor_user_id', sessionStorage.getItem("subtitleUserId") || "");
                formData.append('editor_session_id', sessionStorage.getItem("subtitleSessionId") || "");
                
                console.log('Sending split request:', {
                    project: projectName, episode: episodeName, segmentIndex, splitTime
                });
                window.__suppressSegmentsChangedRefreshUntil = Date.now() + 3000;
                
                const response = await fetch('/split_segment', {
                    method: 'POST',
                    body: formData
                });
                
                // Check if response is OK
                if (!response.ok) {
                    const errorText = await response.text();
                    console.error('Server error response:', errorText);
                    throw new Error(`Server error: ${response.status} ${response.statusText}`);
                }
                
                // Try to parse as JSON
                let result;
                try {
                    result = await response.json();
                } catch (jsonError) {
                    const responseText = await response.text();
                    console.error('JSON parse error:', jsonError, 'Response:', responseText);
                    throw new Error('Invalid response from server');
                }
                
                if (result.status === 'success') {
                    setInsertStatus('Segment split successfully!', '#28a745');
                    window.__suppressSegmentsChangedRefreshUntil = Date.now() + 2000;
                    if (typeof refreshSegmentsOnly === 'function') {
                        await refreshSegmentsOnly({ background: false, reason: "split" });
                    } else if (typeof window.scheduleSegmentsRefresh === "function") {
                        window.scheduleSegmentsRefresh("split", 0);
                    }
                    window.__suppressSegmentsChangedRefreshUntil = 0;
                    
                } else {
                    throw new Error(result.message || 'Failed to split segment');
                }
                
            } catch (error) {
                console.error('Error splitting segment:', error);
                window.__suppressSegmentsChangedRefreshUntil = 0;
                const insertStatus = document.getElementById('insert-status');
                setInsertStatus('Error: ' + error.message, '#dc3545');
                
                setTimeout(() => {
                    setInsertStatus('Ready to insert', '#666');
                }, 5000);
            }
        }
        window.splitSegmentAtCurrentTime = splitSegmentAtCurrentTime;



        // Helper function to convert RGB/RGBA to HEX
