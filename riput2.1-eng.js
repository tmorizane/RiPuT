// ==========================================
// Global Variables & State Management (v2.1)
// ==========================================

// --- API & Model Settings ---
let currentGeminiApiKey = "";
let currentOpenaiApiKey = "";
let selectedAiModel = ""; // AI-Screening Model
let selectedAdaptationModel = ""; // AI-Adaptation Model
let accumulatedScreeningTime = 0;

// --- Application State ---
let currentFileName = "ris-pm-to-table-api.htm";
let hasUnsavedChanges = false;
let isScreeningRunning = false;

// --- Data Storage (NEW for v2.1) ---
// Stores all reference data (objects) in the main array
let allReferences = []; 
// Array filtered by search/etc. for display on the screen
let filteredReferences = []; 
// Backup for restoring the original sort order (keeps object references)
let previousSortOrder = [];  

// --- Pagination & Search (NEW for v2.1) ---
let currentPage = 1;
const ITEMS_PER_PAGE = 100; // Number of rows displayed per page
let currentSearchQuery = ""; // Current search keyword

// --- Deduplication Tracking (for duplicate removal) ---
let loadedIDs = new Set();
let loadedPMIDs = new Set();
let loadedDOIs = new Set();
let loadedTitleYears = new Set();
let loadedTitleAuthors = new Set();

// --- UI State (MODIFIED for v2.1) ---
// Since the DOM is recreated during page transitions, we keep unique UUIDs instead of DOM elements (rows)
let activeCommentId = null;
let activeAbstractId = null;
let currentGeminiResponseRaw = "";

// --- Background Processing Queue ---
// Although direct DOM rendering is avoided, queue processing remains to prevent UI freezing during file parsing
let renderQueue = [];
let isProcessingQueue = false;
let renderTotalForCurrentJob = 0;

// --- Default Prompts for Criteria Adaptation ---
let defaultAdaptSysPrompt = `You are an expert information specialist and systematic reviewer. Your task is to convert human-written Inclusion and Exclusion criteria into a highly sensitive evaluation framework optimized for title/abstract screening.

CRITICAL INSTRUCTIONS TO EMBED IN THE PROTOCOL:
1. 100% SENSITIVITY (ZERO FALSE NEGATIVES): Your primary goal is to ensure NO potentially relevant study is missed. Accept a high rate of false positives to achieve this.
2. EXTRACT CORE ESSENTIALS ONLY: Identify only the most fundamental elements required for a paper to be considered (e.g., core patient population, main intervention). Discard highly specific criteria that are likely unavailable in abstracts.
3. TOLERATE MISSING INFORMATION: Explicitly instruct the AI screener that if an abstract lacks sufficient explicit information to confidently confirm an exclusion, it MUST NOT exclude the paper. Missing details should not lead to exclusion unless the evidence is explicit.
4. The output must be in English, strictly formatted as the optimized criteria text itself without any conversational filler or markdown code blocks.
5. Follow the definition of the score (integer 1-5): 5=Definitely include, 4=Probably include, 3=Unsure/Needs full text, 2=Probably exclude, 1=Definitely exclude.`;

let defaultAdaptUserPrompt = `Analyze the following Inclusion and Exclusion criteria. Your task is to adapt them into an AI evaluation prompt designed for title/abstract screening that achieves "100% sensitivity" while preserving practicality.

【REQUIREMENTS】
- Since abstracts often lack fine details, retain ONLY the absolute core criteria (e.g., completely different target disease, explicit animal studies) as strict exclusion conditions.
- Strongly instruct the screening AI that if a detail is ambiguous, or if specific Inclusion Criteria elements (like secondary outcomes) are simply NOT MENTIONED in the abstract, it MUST NOT exclude the paper.
- The resulting protocol must be structurally designed to tolerate false positives (keeping irrelevant papers) while absolutely preventing false negatives (missing relevant papers).

Output strictly the optimized criteria prompt in English.`;

let currentAdaptSysPrompt = defaultAdaptSysPrompt;
let currentAdaptUserPrompt = defaultAdaptUserPrompt;

// ==========================================
// Data Core & Pagination (NEW for v2.1)
// ==========================================

// UUID generation function (assigns a unique ID to each data item)
function generateUUID() {
    if (crypto && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// (Fully replaces the old addTableRow)
// Instead of adding directly to the DOM, add to an array via the render queue
function addTableRow(e) {
    let isDuplicate = false;

    let cleanPMID = e.pmid ? String(e.pmid).replace(/\D/g, '') : "";
    if (cleanPMID && loadedPMIDs.has(cleanPMID)) isDuplicate = true;

    let cleanDOI = e.doi ? String(e.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim().toLowerCase() : "";
    if (!isDuplicate && cleanDOI && loadedDOIs.has(cleanDOI)) isDuplicate = true;

    let normTitle = normalizeTitle(e.title);
    let year = "";
    let authorLastName = "";
    if (e.refId) {
        let parts = e.refId.trim().split(/\s+/);
        year = parts.pop();
        authorLastName = parts.join("").toLowerCase();
    }

    let titleYearKey = normTitle && year ? normTitle + "||" + year : "";
    let titleAuthorKey = normTitle && authorLastName ? normTitle + "||" + authorLastName : "";

    if (!isDuplicate && titleYearKey && loadedTitleYears.has(titleYearKey)) isDuplicate = true;
    if (!isDuplicate && titleAuthorKey && loadedTitleAuthors.has(titleAuthorKey)) isDuplicate = true;
    if (!isDuplicate && e.idKey && loadedIDs.has(String(e.idKey))) isDuplicate = true;

    if (isDuplicate) return false;

    if (cleanPMID) loadedPMIDs.add(cleanPMID);
    if (cleanDOI) loadedDOIs.add(cleanDOI);
    if (titleYearKey) loadedTitleYears.add(titleYearKey);
    if (titleAuthorKey) loadedTitleAuthors.add(titleAuthorKey);
    if (e.idKey) loadedIDs.add(String(e.idKey));

    // New feature: explicitly add UUID and status to the object
    e.uuid = generateUUID();
    e.selection = e.selection || 0; // 0: none, 1: cyan, 2: gray

    // Convert score to a numeric value for sorting/filtering
    if (e.scoreNum !== undefined) {
        e.scoreNum = parseInt(e.scoreNum, 10);
    } else {
        e.scoreNum = 0;
        let combinedScore = (e.aiScoreHtml || "") + (e.aiScore || "");
        let matches = combinedScore.match(/●|&#9679;|&#x25CF;/gi);
        e.scoreNum = matches ? matches.length : 0;
        if (typeof e.aiScore === 'number') e.scoreNum = e.aiScore;
    }

    renderQueue.push(e);
    renderTotalForCurrentJob++;

    // Start queue processing
    if (!isProcessingQueue) {
        isProcessingQueue = true;
        setTimeout(processDataQueue, 10); 
    }
    markUnsaved();
    return true;
}

// (Fully replaces the old processRenderQueue)
// Queue processing for fast in-memory loading of large data sets
function processDataQueue() {
    if (renderQueue.length === 0) {
        isProcessingQueue = false;
        // Once the queue is empty, update the screen
        applyFilterAndRender();
        
        let statusNode = document.getElementById('loadingStatusNode');
        if (statusNode) {
            statusNode.innerHTML = `> Data load complete. Total references: ${allReferences.length}`;
            statusNode.classList.replace('text-blue-600', 'text-teal-700');
            statusNode.removeAttribute('id');
        }
        return;
    }

    let statusNode = document.getElementById('loadingStatusNode');
    if (!statusNode) {
        const div = document.getElementById('status');
        statusNode = document.createElement('p');
        statusNode.id = 'loadingStatusNode';
        statusNode.className = "text-blue-600 font-bold";
        div.prepend(statusNode);
    }

    // Since this only handles array operations, we can process a larger chunk size than the old DOM rendering approach (500 items at a time)
    const chunk = renderQueue.splice(0, 500); 
    chunk.forEach(e => allReferences.push(e));
    
    if (renderQueue.length > 0) {
        const processed = renderTotalForCurrentJob - renderQueue.length;
        statusNode.innerHTML = `> Loading data to memory... ${processed} / ${renderTotalForCurrentJob} items.`;
        setTimeout(processDataQueue, 5);
    } else {
        isProcessingQueue = false; 
        applyFilterAndRender();
        statusNode.innerHTML = `> Data load complete. ${renderTotalForCurrentJob} items loaded. Total references: ${allReferences.length}`;
        statusNode.classList.replace('text-blue-600', 'text-teal-700');
        statusNode.removeAttribute('id');
        renderTotalForCurrentJob = 0; 
    }
}

// Apply filtering (search) and render the table
function applyFilterAndRender() {
    if (currentSearchQuery.trim() === "") {
        filteredReferences = [...allReferences];
    } else {
        const q = currentSearchQuery.toLowerCase();
        filteredReferences = allReferences.filter(r => {
            return (r.title && r.title.toLowerCase().includes(q)) ||
                   (r.abstract && r.abstract.toLowerCase().includes(q)) ||
                   (r.refId && r.refId.toLowerCase().includes(q)) ||
                   (r.bibInfo && r.bibInfo.toLowerCase().includes(q)) ||
                   (r.notes && r.notes.toLowerCase().includes(q));
        });
    }
    
    // If the total item count decreases and the current page no longer exists, handle it
    const totalPages = Math.max(1, Math.ceil(filteredReferences.length / ITEMS_PER_PAGE));
    if (currentPage > totalPages) currentPage = totalPages;
    
    renderTable();
}

// Extract only the current page data (100 items) and render to the DOM
function renderTable() {
    const tbody = document.getElementById('tableBody');
    tbody.innerHTML = '';
    
    const totalItems = filteredReferences.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / ITEMS_PER_PAGE));
    
    updatePaginationUI(totalItems, totalPages);
    if (totalItems === 0) return;
    
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const endIndex = Math.min(startIndex + ITEMS_PER_PAGE, totalItems);
    
    const fragment = document.createDocumentFragment();
    
    for (let i = startIndex; i < endIndex; i++) {
        const e = filteredReferences[i];
        const displayNo = i + 1; // Sequential number after filtering
        
        const tr = document.createElement('tr');
        tr.className = "hover:bg-slate-50 transition-colors";
        tr.dataset.uuid = e.uuid; // For tracking
        
        if (e.translation) tr.setAttribute('data-translation', encodeURIComponent(e.translation));
        if (e.geminiResponse) tr.setAttribute('data-gemini-response', encodeURIComponent(e.geminiResponse));
        if (e.geminiRaw) tr.setAttribute('data-gemini-raw', encodeURIComponent(e.geminiRaw));

        const safeAbs = (e.abstract || "").replace(/\n/g, ' ').replace(/"/g, '&quot;');
        
        let refIdClass = "text-sm font-bold cursor-pointer border-r border-slate-100";
        if (e.selection === 1) refIdClass += " bg-selected-cyan";
        else if (e.selection === 2) refIdClass += " bg-selected-gray";

        let scoreHtml = "";
        if (e.scoreNum > 0) {
            const absText = e.abstract ? String(e.abstract).trim() : "";
            const hasAbs = absText !== "" && absText !== "No abstract available.";
            const dotColor = hasAbs ? "#22c55e" : "#eab308";
            let dotsHTML = "";
            for(let j=0; j<e.scoreNum; j++) dotsHTML += `<span style="color: ${dotColor};">●</span>`;
            for(let j=e.scoreNum; j<5; j++) dotsHTML += '<span style="color: #cbd5e1;">○</span>';
            scoreHtml = `<div class="ai-score mt-1 text-xs tracking-tighter text-center whitespace-nowrap">${dotsHTML}</div>`;
        }

        // Updated to pass the UUID via onclick handlers
        const hl = (str) => currentSearchQuery ? highlightText(str, currentSearchQuery) : (str || "");
        tr.innerHTML = `
            <td class="text-center text-slate-400 font-mono text-sm font-bold">${displayNo}${scoreHtml}</td>
            <td class="${refIdClass}" onclick="toggleRefColorByUuid('${e.uuid}')">${hl(e.refId)}</td>
            <td class="text-sm leading-relaxed">${hl(e.bibInfo)}</td>
            <td class="flex flex-col gap-1 items-start">
                ${e.abstract ? `<button class="px-2 py-1 rounded text-[9px] font-bold bg-slate-100 border w-full" data-abstract="${safeAbs}" data-title="${(e.title || '').replace(/"/g, '&quot;')}" onclick="showAbstractByUuid('${e.uuid}', this)">${e.abstract ? 'Abstract' : ''}</button>` : ''}
                ${e.pmid ? `<button class="px-2 py-1 rounded text-[9px] font-bold bg-red-50 text-red-700 border w-full" onclick="window.open('https://pubmed.ncbi.nlm.nih.gov/${e.pmid.replace(/\D/g,'')}/', '_blank')">PubMed</button>` : ''}
                ${e.doi ? `<button class="px-2 py-1 rounded text-[9px] font-bold bg-blue-50 text-blue-700 border w-full" onclick="window.open('https://doi.org/${e.doi}', '_blank')">doi</button>` : ''}
                ${e.ur ? `<button class="px-2 py-1 rounded text-[9px] font-bold bg-blue-50 text-blue-700 border w-full" onclick="window.open('${e.ur}', '_blank')">${e.label || 'Link'}</button>` : ''}
                ${e.registryUrl ? `<button class="px-2 py-1 rounded text-[9px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 w-full" onclick="window.open('${e.registryUrl}', '_blank')">Registry</button>` : ''}
            </td>
            <td class="comment-cell"><div class="comment-area text-sm outline-none" contenteditable="true" oncontextmenu="openCommentPanelByUuid(event, '${e.uuid}')" onblur="saveCommentInline('${e.uuid}', this)">${e.notes || ""}</div></td>
        `;
        fragment.appendChild(tr);
    }
    tbody.appendChild(fragment);
}

// ==========================================
// Search & Pagination Controls
// ==========================================

function updatePaginationUI(totalItems, totalPages) {
    const topNav = document.getElementById('topPagination');
    const bottomNav = document.getElementById('bottomPagination');
    
    if (totalItems > 0) {
        topNav.classList.remove('hidden');
        bottomNav.classList.remove('hidden');
    } else {
        topNav.classList.add('hidden');
        bottomNav.classList.add('hidden');
    }
    
    document.getElementById('topPageInput').value = currentPage;
    document.getElementById('bottomPageInput').value = currentPage;
    
    document.getElementById('topTotalPages').innerText = totalPages;
    document.getElementById('bottomTotalPages').innerText = totalPages;
    
    const countTop = document.getElementById('filteredCountTop');
    if(countTop) countTop.innerText = totalItems;
}

function prevPage() {
    if (currentPage > 1) {
        currentPage--;
        renderTable();
        window.scrollTo(0, 0); // Scroll to the top of the page
    }
}

function nextPage() {
    const totalPages = Math.max(1, Math.ceil(filteredReferences.length / ITEMS_PER_PAGE));
    if (currentPage < totalPages) {
        currentPage++;
        renderTable();
        window.scrollTo(0, 0);
    }
}

function jumpToPage(val) {
    let num = parseInt(val, 10);
    const totalPages = Math.max(1, Math.ceil(filteredReferences.length / ITEMS_PER_PAGE));
    if (isNaN(num) || num < 1) num = 1;
    if (num > totalPages) num = totalPages;
    
    currentPage = num;
    renderTable();
    window.scrollTo(0, 0);
}

function executeSearch() {
    const input = document.getElementById('globalSearchInput');
    currentSearchQuery = input.value;
    currentPage = 1; // Return to page 1 when searching
    applyFilterAndRender();
    updateStatus(`Searched for: "${currentSearchQuery}"`);
}

// ==========================================
// Text Highlighting Helper
// ==========================================
function highlightText(text, query) {
    if (!query || !text) return text || "";
    // Escape special regex characters
    const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const safeQuery = escapeRegExp(query);
    // Prevent replacement inside HTML tags (e.g., between < and >)
    const regex = new RegExp(`(${safeQuery})(?![^<]*>)`, 'gi');
    return String(text).replace(regex, '<mark class="bg-yellow-300 rounded px-1">$1</mark>');
}

function clearSearch() {
    const input = document.getElementById('globalSearchInput');
    input.value = "";
    currentSearchQuery = "";
    currentPage = 1;
    applyFilterAndRender();
}

// Add a red dot to the Save HTML button
function markUnsaved() {
    if (hasUnsavedChanges) return; // If a red dot is already present, do nothing
    hasUnsavedChanges = true;
    
    const saveBtn = document.querySelector('button[onclick="saveTable()"]');
    if (saveBtn && !saveBtn.querySelector('#unsavedDot')) {
        // Relative position of the SAVE HTML button; add the red dot
        saveBtn.classList.add('relative');
        const dot = document.createElement('span');
        dot.id = 'unsavedDot';
        // Design the red dot using Tailwind CSS (positioned in the upper-right corner)
        dot.className = 'absolute -top-1 -right-1 w-3 h-3 bg-rose-500 border-2 border-white rounded-full';
        saveBtn.appendChild(dot);
    }
}

// Remove the red dot from the Save HTML button
function markSaved() {
    hasUnsavedChanges = false;
    const saveBtn = document.querySelector('button[onclick="saveTable()"]');
    if (saveBtn) {
        const dot = saveBtn.querySelector('#unsavedDot');
        if (dot) dot.remove();
    }
}

window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('drop', (e) => { e.preventDefault(); });

function normalizeTitle(title) {
    if (!title) return "";
    const norm = title.replace(/<[^>]*>?/gm, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    return norm || title.replace(/<[^>]*>?/gm, '').trim();
}

// ==========================================
// File Handling / Import / Parsing
// ==========================================

async function handleFiles(files) {
    if (!files || files.length === 0) return;
    
    for (const file of Array.from(files)) {
        const ext = file.name.split('.').pop().toLowerCase();
        if (ext === 'xlsx' || ext === 'xls') { 
            handleExcelComparison(file); 
            continue; 
        }
        
        updateStatus(`Reading: ${file.name} ...`);
        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 50)));

        await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const buffer = e.target.result;
                let text = "";
                
                if (ext === 'htm' || ext === 'html') {
                    text = new TextDecoder('utf-8').decode(buffer);
                } else {
                    // Improve encoding detection to avoid garbled text
                    let utf8Text = new TextDecoder('utf-8').decode(buffer);
                    let sjisText = new TextDecoder('shift-jis').decode(buffer);
                    
                    // Force UTF-8 for CENTRAL data
                    if (utf8Text.includes('Provider: John Wiley') || utf8Text.includes('CN-')) {
                        text = utf8Text;
                    } 
                    // Force Shift-JIS for Ichushi data
                    else if (sjisText.includes('医中誌') || sjisText.match(/^UI\s*-/m)) {
                        text = sjisText;
                    } 
                    // Fallback: guess by counting replacement characters (\uFFFD)
                    else {
                        let fffdCount = (utf8Text.match(/\uFFFD/g) || []).length;
                        text = fffdCount > 50 ? sjisText : utf8Text;
                    }
                }

                // Standardize special hyphens and dashes to regular half-width hyphens
                text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'); 
                text = text.replace(/[\u2010-\u2015\u2212\uFF0D]/g, '-'); 
                
                if (text.includes('id="tableBody"') && text.includes('<!DOCTYPE html>')) {
                    performMerge(text, file.name);
                } else {
                    dispatchParser(text, file.name);
                }
                resolve(); 
            };
            reader.readAsArrayBuffer(file);
        });
    }
    
    document.getElementById('fileInput').value = "";
}

function generateCompareKey(data) {
    let cleanPMID = data.PubMed ? String(data.PubMed).replace(/\D/g, '') : "";
    if (cleanPMID) return "PMID:" + cleanPMID;
    
    let cleanDOI = data.Doi ? String(data.Doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim().toLowerCase() : "";
    if (cleanDOI) return "DOI:" + cleanDOI;
    
    let normTitle = normalizeTitle(data.Title);
    let year = "";
    let authorLastName = "";
    if (data["Reference ID"]) {
        let parts = String(data["Reference ID"]).trim().split(/\s+/);
        year = parts.pop();
        authorLastName = parts.join("").toLowerCase();
    }
    if (normTitle && year) return "TY:" + normTitle + "||" + year;
    if (normTitle && authorLastName) return "TA:" + normTitle + "||" + authorLastName;
    return "ID:" + data["Reference ID"] + "||" + data.Title; 
}

function handleExcelComparison(file) {
    updateStatus(`Reading Excel: ${file.name} ...`);
    const reader = new FileReader();
    reader.onload = (e) => {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: 'array' });
        const json = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);

        const droppedItems = json.filter(row => row["Selection"] == 1 || row["Selection"] === '1');

        if (droppedItems.length === 0) {
            showMessage("No selected article found in Excel!");
            updateStatus(`Parsed: ${file.name} (No selected article found)`);
            return;
        }

        let mergedCount = 0;
        let addedCount = 0;

        droppedItems.forEach(dropRow => {
            let pmidB = dropRow["PubMed"] ? String(dropRow["PubMed"]).replace(/\D/g, '') : "";
            let doiB = dropRow["Doi"] ? String(dropRow["Doi"]).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim().toLowerCase() : "";
            let titleB = dropRow["Title"] ? String(dropRow["Title"]).replace(/<[^>]+>/g, '').replace(/[^\w\s]/g, '').trim().toLowerCase() : "";
            if (!titleB && dropRow["Bibliographic Information"]) {
                titleB = String(dropRow["Bibliographic Information"]).replace(/[^\w\s]/g, '').trim().toLowerCase().substring(0, 50);
            }
            const dropComment = dropRow["Notes"] ? String(dropRow["Notes"]).trim() : "";
            let refIdB = dropRow["Reference ID"] ? String(dropRow["Reference ID"]).trim().toLowerCase() : "";

            let matchedItem = allReferences.find(a => 
                (pmidB && a.pmid === pmidB) ||
                (doiB && a.doi === doiB) ||
                (titleB && a.title && titleB.substring(0, 30) === a.title.substring(0, 30)) ||
                (refIdB && a.refId.toLowerCase() === refIdB)
            );

            if (matchedItem) {
                matchedItem.selection = 1; // Cyan
                if (dropComment) {
                    matchedItem.notes = (matchedItem.notes ? matchedItem.notes + "<br>" : "") + `<span style="color: blue;">${dropComment}</span>`;
                }
                mergedCount++;
            } else {
                let linkStr = dropRow["Ichushi"] || dropRow["CENTRAL"] || dropRow["Link"] || "";
                let labelStr = dropRow["Ichushi"] ? "Ichushi" : (dropRow["CENTRAL"] ? "CENTRAL" : "Link");
                const isAdded = addTableRow({
                    refId: dropRow["Reference ID"] || "",
                    bibInfo: dropRow["Bibliographic Information"] || "",
                    notes: dropComment ? `<span style="color: blue;">${dropComment}</span>` : "",
                    idKey: Math.random().toString(36).substring(2, 15),
                    pmid: pmidB, doi: doiB, ur: linkStr, label: labelStr,
                    registryUrl: dropRow["Registry"] || "",
                    title: titleB, abstract: dropRow["Abstract"] || "",
                    selection: 1
                });
                if (isAdded) addedCount++;
            }
        });

        markUnsaved();
        applyFilterAndRender(); // Refresh the screen
        showMessage(`Comparison Complete!\n\n- ${mergedCount} articles matched and highlighted.\n- ${addedCount} new selected articles added.`);
        updateStatus(`> Comparison Complete: Updated ${mergedCount}, Added ${addedCount} from Excel`);
    };
    reader.readAsArrayBuffer(file);
}

function openComparisonTab(dataArray, matchCount, htmlOnlyCount, excelOnlyCount, newWin) {
    const clone = document.documentElement.cloneNode(true);
    const tbody = clone.querySelector('#tableBody');
    tbody.innerHTML = ''; 
    
    let rowsHtml = '';
    dataArray.forEach((e, idx) => {
        const safeAbs = (e.Abstract || "").replace(/\n/g, ' ').replace(/"/g, '&quot;');
        let btns = '';
        if (e.Abstract) btns += `<button class="px-2 py-1 rounded text-[9px] font-bold bg-slate-100 border w-full" data-abstract="${safeAbs}" data-title="${(e.Title || '').replace(/"/g, '&quot;')}" onclick="showAbstract(this)">${e.Abstract ? 'Abstract' : ''}</button>`;
        if (e.PubMed) {
            let pmUrl = e.PubMed.startsWith('http') ? e.PubMed : `https://pubmed.ncbi.nlm.nih.gov/${e.PubMed.replace(/\D/g,'')}/`;
            btns += `<button class="px-2 py-1 rounded text-[9px] font-bold bg-red-50 text-red-700 border w-full" onclick="window.open('${pmUrl}', '_blank')">PubMed</button>`;
        }
        if (e.Doi) {
            let doiUrl = e.Doi.startsWith('http') ? e.Doi : `https://doi.org/${e.Doi}`;
            btns += `<button class="px-2 py-1 rounded text-[9px] font-bold bg-blue-50 text-blue-700 border w-full" onclick="window.open('${doiUrl}', '_blank')">doi</button>`;
        }
        if (e.ur) btns += `<button class="px-2 py-1 rounded text-[9px] font-bold bg-blue-50 text-blue-700 border w-full" onclick="window.open('${e.ur}', '_blank')">${e.label || 'Link'}</button>`;
        if (e.Registry) btns += `<button class="px-2 py-1 rounded text-[9px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 w-full" onclick="window.open('${e.Registry}', '_blank')">Registry</button>`;
        
        let trAttr = "";
        if (e.Translation) trAttr += ` data-translation="${encodeURIComponent(e.Translation)}"`;
        if (e["Gemini Response"]) trAttr += ` data-gemini-response="${encodeURIComponent(e["Gemini Response"])}"`;
        if (e["Gemini Raw"]) trAttr += ` data-gemini-raw="${encodeURIComponent(e["Gemini Raw"])}"`;

        rowsHtml += `
            <tr class="hover:bg-slate-50 transition-colors" ${trAttr}>
                <td class="text-center ${e.noClass} font-mono text-sm font-bold">
                    ${idx + 1}
                    ${e.AIScore ? `<div class="ai-score mt-1 text-xs tracking-tighter text-center whitespace-nowrap">${e.AIScore}</div>` : ''}
                </td>
                <td class="text-sm font-bold cursor-pointer border-r border-slate-100 ${e.selectionClass}" onclick="toggleRefColor(this)">${e["Reference ID"]}</td>
                <td class="text-sm leading-relaxed">${e["Bibliographic Information"]}</td>
                <td class="flex flex-col gap-1 items-start">${btns}</td>
                <td class="comment-cell"><div class="comment-area text-sm outline-none" contenteditable="true" oncontextmenu="openCommentPanel(event, this)">${e.NotesHTML || ""}</div></td>
            </tr>
        `;
    });
    
    tbody.innerHTML = rowsHtml;
    
    const statusDiv = clone.querySelector('#status');
    if(statusDiv) {
        statusDiv.innerHTML = `<p>> Comparison Complete. Matched: ${matchCount}, HTML Only: ${excelOnlyCount}</p>`;
    }

    newWin.document.open();
    newWin.document.write("<!DOCTYPE html>\n" + clone.outerHTML);
    newWin.document.close();
}

function dispatchParser(text, fileName) {
    const norm = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^\uFEFF/, '');
    let count = 0;

    // Route to the appropriate parser based on file structure
    if (norm.match(/^\s*PMID\s*-/m) || norm.match(/^\s*PMID- /m)) {
        if (norm.includes(' - 医中誌ID:')) count = parseIchushiPubMedFormat(norm);
        else count = parsePubMedFormat(norm);
    } else if (norm.match(/^\s*UI\s*-/m)) { 
        count = parseIchushiPubMedFormat(norm);
    } else if (norm.match(/^TY\s*[-–—‐‑‒—―~〜\uFFFD\?]/m)) {
        if (norm.includes('DB  - Journals@Ovid') || norm.includes('DB  - PsycINFO')) count = parsePsycInfoRIS(norm);
        else if (norm.includes('DB  - Embase')) count = parseEmbaseRIS(norm);
        else if (norm.includes('Provider: John Wiley') || norm.match(/^\s*AN\s*[-–—‐\uFFFD\?]\s*CN-/m)) count = parseCentralRIS(norm);
        else if (norm.includes('医中誌')) count = parseIchushiRISFormat(norm);
        else count = parseRISGeneric(norm);
    } else if (norm.match(/^\s*PMID-/m)) {
        count = parsePubMedFormat(norm);
    }
    updateStatus(`Parsed: ${fileName} (Found records, ${count} added to queue)`);
}

// Latest initialization function
function formatAuthorName(nameStr) {
    if (!nameStr) return "";

    // If the name contains Japanese characters, leave it as-is and remove only commas
    if (/[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/.test(nameStr)) {
        return String(nameStr).replace(/,\s*/g, ' ').trim();
    }

    // Remove leading/trailing spaces and a trailing period
    let clean = String(nameStr).trim().replace(/\.$/, '');

    if (clean.includes(',')) {
        // Split by comma
        let parts = clean.split(',');
        // First element = surname
        let lastName = parts[0].trim();
        
        // Remaining elements = given names / middle names, combine and remove periods
        let givenNames = parts.slice(1).join(' ').replace(/\./g, ' ').trim();
        
        // Split by spaces and take the first letter of each word, uppercase it, then join
        let initials = givenNames.split(/\s+/).map(word => {
            let alpha = word.replace(/[^A-Za-z]/g, '');
            return alpha ? alpha.charAt(0).toUpperCase() : "";
        }).join('');

        return lastName + (initials ? " " + initials : "");
    } else {
        // Fallback for names without commas
        let parts = clean.replace(/\./g, ' ').split(/\s+/).filter(n => n);
        if (parts.length > 1) {
            let lastPart = parts[parts.length - 1];
            // Treat as already initialized if the last segment is uppercase and up to 3 characters
            if (lastPart === lastPart.toUpperCase() && lastPart.length <= 3) {
                return parts.join(' ');
            }
            let lastName = parts[0];
            let initials = parts.slice(1).map(n => {
                let alpha = n.replace(/[^A-Za-z]/g, '');
                return alpha ? alpha.charAt(0).toUpperCase() : "";
            }).join('');
            return lastName + (initials ? " " + initials : "");
        }
        return clean;
    }
}

// Extract RIS/PubMed tags
function extractTags(r) {
    const data = { AU: [], A1: [] }; 
    let curr = null;
    r.split('\n').forEach(line => {
        // Handle multiline text (e.g., abstracts) beginning with spaces
        if (line.match(/^\s+/)) {
            if (curr && line.trim()) {
                if (Array.isArray(data[curr])) {
                    if (data[curr].length > 0) {
                        data[curr][data[curr].length - 1] += ' ' + line.trim();
                    } else {
                        data[curr].push(line.trim());
                    }
                } else {
                    data[curr] += ' ' + line.trim();
                }
            }
        } else {
            // Extract standard RIS/PubMed tags
            const m = line.match(/^([A-Z0-9]{2,4})\s*[-–—‐‑‒—―~〜\uFFFD\?]\s*(.*)$/);
            if (m) {
                curr = m[1].trim(); 
                const v = m[2] ? m[2].trim() : '';
                if (curr === 'AU') data.AU.push(v);
                else if (curr === 'A1') data.A1.push(v);
                else data[curr] = (data[curr] || '') + (data[curr] ? ' ' : '') + v;
            } else if (line.trim() && curr) {
                if (Array.isArray(data[curr])) {
                    if (data[curr].length > 0) {
                        data[curr][data[curr].length - 1] += ' ' + line.trim();
                    } else {
                        data[curr].push(line.trim());
                    }
                } else {
                    data[curr] += ' ' + line.trim();
                }
            }
        }
    });
    return data;
}

function parsePubMedFormat(c) {
    let count = 0; 
    const recs = c.split(/\n(?=PMID[-–—]\s*|UI\s*[-–—]\s*)/).filter(r => r.trim());
    recs.forEach(r => {
        const d = extractTags(r); 
        
        let pmidRaw = Array.isArray(d.PMID) ? d.PMID[0] : d.PMID;
        const cleanPmid = pmidRaw ? String(pmidRaw).split(/\s+/)[0] : "";
        
        let title = (d.TI || d.BTI || "No Title").trim();
        while (title.endsWith('.')) title = title.slice(0, -1);

        // Fallback ID mechanism if PMID is missing
        const id = d.UI || cleanPmid || d.AN || title; 
        if (!id || id === "No Title") return;
        
        const y = (d.DP || d.SO || d.EDAT || "").match(/\d{4}/)?.[0] || '';
        
        let authorsCleaned = "";
        let firstAuthor = "";
        if (d.AU && d.AU.length > 0) {
            const authorsRaw = Array.isArray(d.AU) ? d.AU : [d.AU];
            authorsCleaned = authorsRaw.join(', ') + ": ";
            firstAuthor = authorsRaw[0].split(',')[0].trim();
        } else {
            firstAuthor = d.UI || cleanPmid || d.AN || "Unknown";
        }
        
        const doi = d.AID ? (d.AID.match(/([^\s]+)\s*\[doi\]/i)?.[1]) : d.LID;
        const volume = d.VI || "";
        const issue = d.IP || "";
        let pages = d.PG || "";
        pages = pages.replace(/\s*[-–—‐]\s*/g, '-'); 
        const journal = d.JT || d.TA || 'Unknown Journal';
        
        const ur = d.URL || "";

        let bib = `${authorsCleaned}<span class="text-teal-600 font-bold">${title}</span>. ${journal} ${y}`;
        if (volume || pages) {
            bib += `;${volume}`;
            if (issue) bib += `(${issue})`;
            if (pages) bib += `:${pages}`;
        }
        bib += `.`;
        if (doi) bib += ` doi: ${doi}`;
        if (cleanPmid) bib += ` PMID: ${cleanPmid}`;

        if (addTableRow({ 
            refId: `${firstAuthor} ${y}`.trim(), 
            bibInfo: bib, 
            pmid: cleanPmid, 
            idKey: id, 
            doi: doi, 
            abstract: d.AB || d.N2, 
            title: title,
            ur: ur,
            label: ur ? "Link" : ""
        })) count++;
    });
    return { total: recs.length, added: count };
}

function parseCentralRIS(norm) {
    let count = 0; const recs = norm.split(/ER\s+-\s*\n?/).filter(r => r.trim());
    recs.forEach(r => {
        const d = extractTags(r); const id = d.AN || d.UI || d.TI || d.T1;
        if (!id) return;
        const y = (d.PY || d.Y1 || "").match(/\d{4}/)?.[0] || '';
        let authorsCleaned = ""; let firstAuthor = "";
        if (d.AU && d.AU.length > 0) {
            const authorsRaw = Array.isArray(d.AU) ? d.AU : [d.AU];
            authorsCleaned = authorsRaw.map(formatAuthorName).join(', ') + ": ";
            firstAuthor = authorsRaw[0].split(',')[0].trim().split(/\s+/)[0];
        } else {
            firstAuthor = d.AN || d.UI || d.ID || "Unknown";
        }
        let title = (d.TI || d.T1 || 'No Title').trim();
        while (title.endsWith('.')) title = title.slice(0, -1);
        const journal = d.JA || d.JO || d.JF || "";
        const volume = d.VL || ""; const issue = d.IS || "";
        const startPage = d.SP || ""; const endPage = d.EP || "";
        let pages = (startPage && endPage && startPage !== endPage) ? `${startPage}-${endPage}` : startPage;
        pages = pages.replace(/\s*[-–—‐]\s*/g, '-'); 
        let pmidStr = d.C3 || "";
        let pmid = pmidStr.match(/PUBMED\s*:?\s*(\d+)/i)?.[1] || (pmidStr.trim().match(/^\d+$/) ? pmidStr.trim() : "");
        let doi = d.DO || "";
        let centralUr = d.UR || ""; let registryUr = "";
        if (journal && journal.startsWith('http')) { registryUr = journal; }
        if (centralUr.includes('registry') || centralUr.includes('clinicaltrials')) {
            if (!registryUr) { registryUr = centralUr; centralUr = ""; }
        }
        let bib = `${authorsCleaned}<span class="text-teal-600 font-bold">${title}</span>.`;
        if (!journal.startsWith('http') && journal) bib += ` ${journal}`;
        if (y) bib += ` ${y}`;
        if (volume || pages) {
            bib += `;${volume}`;
            if (issue) bib += `(${issue})`;
            if (pages) bib += `:${pages}`;
        }
        bib += `.`;
        if (doi) bib += ` doi: ${doi}`;
        if (pmid) bib += ` PMID: ${pmid}`;
        if (addTableRow({ refId: `${firstAuthor} ${y}`.trim(), bibInfo: bib, doi: doi, pmid: pmid, abstract: d.AB || d.N2, idKey: id, ur: centralUr, registryUrl: registryUr, label: "CENTRAL", title: title })) count++;
    });
    return { total: recs.length, added: count };
}

function parseEmbaseRIS(c) {
    let count = 0; const recs = c.split(/ER\s+-\s*\n?/).filter(r => r.trim() && (r.includes('TI  -') || r.includes('T1  -')));
    recs.forEach(r => {
        const d = extractTags(r); const id = d.U2 || d.AN || d.DO || d.TI || d.T1;
        if (!id) return;
        const y = (d.PY || d.Y1 || "").match(/\d{4}/)?.[0] || '';
        let authorsCleaned = ""; let firstAuthor = "";
        const authorsRaw = (d.AU && d.AU.length > 0) ? d.AU : ((d.A1 && d.A1.length > 0) ? d.A1 : []);
        if (authorsRaw.length > 0) {
            const authArr = Array.isArray(authorsRaw) ? authorsRaw : [authorsRaw];
            authorsCleaned = authArr.map(formatAuthorName).join(', ') + ": ";
            firstAuthor = authArr[0].split(',')[0].trim();
        } else {
            firstAuthor = d.U2 || d.AN || d.DO || "Unknown";
        }
        let title = (d.TI || d.T1 || 'No Title').trim();
        while (title.endsWith('.')) title = title.slice(0, -1);
        const journal = d.JO || d.JF || d.T2 || 'Embase';
        const volume = d.VL || ""; const startPage = d.SP || ""; const endPage = d.EP || "";
        let pages = (startPage && endPage && startPage !== endPage) ? `${startPage}-${endPage}` : startPage;
        pages = pages.replace(/\s*[-–—‐]\s*/g, '-'); 
        let bib = `${authorsCleaned}<span class="text-teal-600 font-bold">${title}</span>. ${journal} ${y}`;
        if (volume || pages) {
            bib += `;${volume}`;
            if (pages) bib += `:${pages}`;
        }
        bib += `.`;
        if (d.DO) bib += ` doi: ${d.DO}`;
        let embaseUr = d.UR || "";
        if (embaseUr.includes('openathens.net') || embaseUr.includes('serialssolutions.com')) { embaseUr = ""; }
        if (addTableRow({ refId: `${firstAuthor} ${y}`.trim(), bibInfo: bib, doi: d.DO, abstract: d.AB || d.N2, idKey: id, ur: embaseUr, title: title })) count++;
    });
    return { total: recs.length, added: count };
}

function parsePsycInfoRIS(c) {
    let count = 0; const recs = c.split(/ER\s+-\s*\n?/).filter(r => r.trim() && (r.includes('T1  -') || r.includes('TI  -')));
    recs.forEach(r => {
        const d = extractTags(r); const id = d.ID || d.AN || d.T1 || d.TI; if (!id) return;
        const y = (d.PY || d.Y1 || "").match(/\d{4}/)?.[0] || '';
        let authorsCleaned = ""; let firstAuthor = "";
        const authorsRaw = (d.A1 && d.A1.length > 0) ? d.A1 : ((d.AU && d.AU.length > 0) ? d.AU : []);
        if (authorsRaw.length > 0) {
            const authArr = Array.isArray(authorsRaw) ? authorsRaw : [authorsRaw];
            authorsCleaned = authArr.map(formatAuthorName).join(', ') + ": ";
            firstAuthor = authArr[0].split(',')[0].trim().split(/\s+/)[0];
        } else {
            firstAuthor = d.ID || d.AN || "Unknown";
        }
        let title = (d.T1 || d.TI || "No Title").trim();
        while (title.endsWith('.')) title = title.slice(0, -1);
        let rawJournal = d.JA || d.JO || d.JF || d.T2 || "";
        let doi = d.DO || ""; let journalHtml = ""; let fetchRequired = false;
        let spanId = `journal-${Math.random().toString(36).substring(2, 15)}`;
        if (rawJournal) { journalHtml = rawJournal.replace(/\./g, ''); } 
        else if (doi) { journalHtml = `<span id="${spanId}" class="text-slate-400 italic">Fetching...</span>`; fetchRequired = true; } 
        else { journalHtml = "[NA]"; }
        const volume = d.VL || ""; const issue = d.IS || ""; const startPage = d.SP || ""; const endPage = d.EP || "";
        let pages = (startPage && endPage && startPage !== endPage) ? `${startPage}-${endPage}` : (startPage || "");
        pages = pages.replace(/\s*[-–—‐]\s*/g, '-'); 
        let bib = `${authorsCleaned}<span class="text-teal-600 font-bold">${title}</span>. ${journalHtml} ${y}`;
        if (volume || pages) {
            bib += `;${volume}`;
            if (issue) bib += `(${issue})`;
            if (pages) bib += `:${pages}`;
        }
        bib += `.`;
        if (doi) bib += ` doi: ${doi}`;
        if (addTableRow({ refId: `${firstAuthor} ${y}`.trim(), bibInfo: bib, doi: doi, abstract: d.N2 || d.AB, idKey: id, title: title })) {
            count++; if (fetchRequired) fetchJournalNameFromExternal(doi, spanId);
        }
    });
    return { total: recs.length, added: count };
}

async function fetchJournalNameFromExternal(doi, elementId) {
    const updateElement = (text) => {
        const el = document.getElementById(elementId);
        if (el) {
            el.innerText = text.replace(/\./g, '');
            el.classList.remove('text-slate-400', 'italic');
        }
    };
    try {
        const crossrefRes = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
        if (crossrefRes.ok) {
            const data = await crossrefRes.json();
            let jName = "";
            if (data.message) {
                if (data.message["short-container-title"] && data.message["short-container-title"].length > 0) jName = data.message["short-container-title"][0];
                else if (data.message["container-title"] && data.message["container-title"].length > 0) jName = data.message["container-title"][0];
            }
            if (jName) { updateElement(jName); return; }
        }
        await fetchFromPubMed(doi, updateElement);
    } catch (e) { await fetchFromPubMed(doi, updateElement); }
}

async function fetchFromPubMed(doi, updateFn) {
    try {
        const searchRes = await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(doi)}[doi]&retmode=json`);
        const searchData = await searchRes.json();
        if (searchData.esearchresult && searchData.esearchresult.idlist && searchData.esearchresult.idlist.length > 0) {
            const pmid = searchData.esearchresult.idlist[0];
            const sumRes = await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${pmid}&retmode=json`);
            const sumData = await sumRes.json();
            if (sumData.result && sumData.result[pmid] && sumData.result[pmid].source) { updateFn(sumData.result[pmid].source); return; }
        }
        updateFn("[NA]");
    } catch (e) { updateFn("[NA]"); }
}

function parseIchushiRISFormat(norm) {
    let count = 0; const recs = norm.split(/ER\s+-\s*\n?/).filter(r => r.trim());
    recs.forEach(r => {
        const d = extractTags(r); const ui = d.AN || d.UI;
        if (!ui) return;
        const y = (d.PY || "").match(/\d{4}/)?.[0] || '';
        let authorsCleaned = ""; let firstAuthor = "";
        if (d.AU && d.AU.length > 0) {
            const authorsRaw = Array.isArray(d.AU) ? d.AU : [d.AU];
            authorsCleaned = authorsRaw.map(formatAuthorName).join(', ') + ": ";
            firstAuthor = authorsRaw[0].split(',')[0].trim().split(/\s+/)[0];
        } else {
            firstAuthor = d.AN || d.UI || "Unknown";
        }
        let title = (d.TI || "No Title").trim();
        while (title.endsWith('.')) title = title.slice(0, -1);
        const journal = d.JF || d.JO || ""; const volume = d.VL || ""; let pages = d.SP || "";
        pages = pages.replace(/\s*[-–—‐]\s*/g, '-'); 
        let bib = `${authorsCleaned}<span class="text-teal-600 font-bold">${title}</span>. ${journal} ${y}`;
        if (volume || pages) {
            bib += `;${volume}`;
            if (pages) bib += `:${pages}`;
        }
        bib += `.`;
        if (d.DO) bib += ` doi: ${d.DO}`;
        bib += ` UI: ${ui}`;
        if (addTableRow({ refId: `${firstAuthor} ${y}`.trim(), bibInfo: bib, abstract: d.AB || d.N2, idKey: ui, ur: d.UR, doi: d.DO, label: "Ichushi", title: title })) count++;
    });
    return { total: recs.length, added: count };
}

function parseIchushiPubMedFormat(norm) {
    let count = 0; const recs = norm.split(/\n\s*(?=UI\s*-|PMID\s*-)/).filter(r => r.trim());
    recs.forEach(r => {
        const d = extractTags(r); const ui = d.UI; if (!ui) return;
        const y = (d.DP || d.SO || "").match(/\d{4}/)?.[0] || '';
        
        let authorsCleaned = "";
        let firstAuthor = "";
        if (d.AU && d.AU.length > 0) {
            const authorsRaw = Array.isArray(d.AU) ? d.AU : [d.AU];
            authorsCleaned = authorsRaw.join(', ') + ": ";
            firstAuthor = authorsRaw[0].split(',')[0].trim();
        } else {
            firstAuthor = d.UI || "Unknown";
        }
        
        let title = (d.TI || "No Title").trim();
        while (title.endsWith('.')) title = title.slice(0, -1);
        
        const doi = d.AID ? (d.AID.match(/([^\s]+)\s*\[doi\]/i)?.[1]) : d.LID;

        let bib = `${authorsCleaned}<span class="text-teal-600 font-bold">${title}</span>. `;
        
        if (d.SO) {
            bib += d.SO;
        } else {
            const journal = d.JT || d.TA || "";
            const volume = d.VI || "";
            let pages = d.PG || "";
            pages = pages.replace(/\s*[-–—‐]\s*/g, '-'); 
            
            bib += `${journal} ${y}`;
            if (volume || pages) {
                bib += `;${volume}`;
                if (pages) bib += `:${pages}`;
            }
            bib += `.`;
        }

        if (doi) bib += ` doi: ${doi}`;
        bib += ` UI: ${ui}`;

        if (addTableRow({ refId: `${firstAuthor} ${y}`.trim(), bibInfo: bib, idKey: ui, doi: doi, abstract: d.AB, title: title, label: "Ichushi" })) count++;
    });
    return { total: recs.length, added: count };
}

function parseRISGeneric(norm) {
    let count = 0; const recs = norm.split(/ER\s+-\s*\n?/).filter(r => r.trim());
    recs.forEach(r => {
        const d = extractTags(r); const id = d.AN || d.UI || d.TI || d.T1;
        if (!id) return;
        const y = (d.PY || d.Y1 || "").match(/\d{4}/)?.[0] || '';
        let authorsCleaned = ""; let firstAuthor = "";
        if (d.AU && d.AU.length > 0) {
            const authorsRaw = Array.isArray(d.AU) ? d.AU : [d.AU];
            authorsCleaned = authorsRaw.map(formatAuthorName).join(', ') + ": ";
            firstAuthor = authorsRaw[0].split(',')[0].trim().split(/\s+/)[0];
        } else {
            firstAuthor = d.AN || d.UI || d.ID || "Unknown"; 
        }
        let title = (d.TI || d.T1 || "No Title").trim();
        while (title.endsWith('.')) title = title.slice(0, -1);
        let bib = `${authorsCleaned}<span class="text-teal-600 font-bold">${title}</span>. ${d.JO || d.JF || d.SF || 'RIS'} ${y}; ID: ${id}`;
        if (addTableRow({ refId: `${firstAuthor} ${y}`.trim(), bibInfo: bib, doi: d.DO, abstract: d.AB || d.N2, idKey: id, ur: d.UR, title: title })) count++;
    });
    return { total: recs.length, added: count };
}

// Generate a plain-text list of abstracts
function generateAbstractsText() {
    let texts = [];
    allReferences.forEach((ref, idx) => {
        const no = idx + 1;
        let abstract = ref.abstract ? ref.abstract.replace(/&quot;/g, '"') : "No abstract available.";
        // Remove HTML tags and keep plain text
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = ref.bibInfo || "";
        const bibInfoText = tempDiv.innerText.trim();
        
        texts.push(`${no}\n${ref.refId}\n${bibInfoText}\n${abstract}`);
    });
    return texts;
}

function saveAbstracts() {
    if (allReferences.length === 0) {
        showMessage("No references to save.");
        return;
    }
    const count = allReferences.length;
    const texts = generateAbstractsText();
    const fullText = texts.join('\n\n\n');
    const fileName = `pms-all-abstracts-${count}.txt`;
    
    const blob = new Blob([fullText], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    a.click();
}

function handleSaveAbstracts(event) {
    if (event && event.shiftKey) {
        document.getElementById('abstractFileInput').click();
    } else {
        saveAbstracts();
    }
}

function importAbstractsFiles(files) {
    if (!files || files.length === 0) return;
    Array.from(files).forEach(file => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const text = e.target.result;
            const count = parseAbstractsText(text);
            updateStatus(`Imported: ${file.name} (${count} records). Total: ${referenceCount}`);
        };
        reader.readAsText(file);
    });
    document.getElementById('abstractFileInput').value = "";
}

function parseAbstractsText(text) {
    let count = 0;
    const blocks = text.split(/\n{3,}/).filter(b => b.trim());
    
    blocks.forEach(block => {
        const lines = block.split('\n');
        if (lines.length < 4) return;
        
        const refId = lines[1].trim();
        const bibInfoTxt = lines[2].trim();
        const abstract = lines.slice(3).join('\n').trim();
        
        let pmid = "", doi = "";
        const pmidMatch = bibInfoTxt.match(/PMID:\s*(\d+)/i);
        if (pmidMatch) pmid = pmidMatch[1];
        const doiMatch = bibInfoTxt.match(/doi:\s*([^\s]+)/i);
        if (doiMatch) doi = doiMatch[1];
        
        let title = "";
        const colonIdx = bibInfoTxt.indexOf(':');
        if (colonIdx !== -1) {
            const dotIdx = bibInfoTxt.indexOf('.', colonIdx);
            if (dotIdx !== -1) {
                title = bibInfoTxt.substring(colonIdx + 1, dotIdx).trim();
            }
        }
        
        let bibInfoHTML = bibInfoTxt;
        if (title) {
            const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            bibInfoHTML = bibInfoTxt.replace(new RegExp(`(:\\s*)(${escapeRegExp(title)})(\\.)`), `$1<span class="text-teal-600 font-bold">$2</span>$3`);
        } else {
            title = refId; 
        }

        if (addTableRow({
            refId: refId,
            bibInfo: bibInfoHTML,
            pmid: pmid,
            doi: doi,
            abstract: abstract === "No abstract available." ? "" : abstract,
            title: title,
            idKey: pmid || doi || refId
        })) {
            count++;
        }
    });
    return count;
}

async function saveDividedAbstracts() {
    const count = allReferences.length;
    if (count === 0) {
        showMessage("No references to save.");
        return;
    }

    const zipFileName = `pms-divided-abstracts-${count}.zip`;
    const zip = new JSZip();
    const texts = generateAbstractsText();
    
    const fullText = texts.join('\n\n\n');
    zip.file(`pms-all-abstracts-${count}.txt`, fullText);

    const chunkSize = 400;
    let fileIndex = 1;
    
    for (let i = 0; i < count; i += chunkSize) {
        const chunk = texts.slice(i, i + chunkSize);
        const chunkText = chunk.join('\n\n\n');
        const paddedIndex = String(fileIndex).padStart(2, '0');
        const chunkFileName = `${paddedIndex}-abstracts-${chunk.length}.txt`;
        
        zip.file(chunkFileName, chunkText);
        fileIndex++;
    }

    try {
        const content = await zip.generateAsync({ type: "blob" });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(content);
        a.download = zipFileName;
        a.click();
    } catch (e) {
        showMessage("Failed to generate ZIP file.");
    }
}

function openSaveFilterModal() {
    if (allReferences.length === 0) {
        showMessage("No references available to save.");
        return;
    }
    const cyanRadio = document.querySelector('input[name="saveFilter"][value="cyan"]');
    if (cyanRadio) cyanRadio.checked = true;
    
    updateFilterCounts();
    updateSaveFilterMessage();
    
    const modal = document.getElementById('saveFilterModal');
    modal.style.display = 'flex';
    modal.classList.remove('hidden');
}

function updateFilterCounts() {
    let count5 = 0, count4 = 0, count4up = 0, count3 = 0, count3up = 0;
    let count2 = 0, count2up = 0, count1 = 0, count1up = 0;
    let countCyan = 0, countNoAbstract = 0;
    
    allReferences.forEach(ref => {
        if (ref.scoreNum === 5) { count5++; count4up++; count3up++; count2up++; count1up++; }
        if (ref.scoreNum === 4) { count4++; count4up++; count3up++; count2up++; count1up++; }
        if (ref.scoreNum === 3) { count3++; count3up++; count2up++; count1up++; }
        if (ref.scoreNum === 2) { count2++; count2up++; count1up++; }
        if (ref.scoreNum === 1) { count1++; count1up++; }
        
        if (ref.selection === 1) countCyan++;
        
        const abstractText = ref.abstract ? ref.abstract.trim() : "";
        const hasAbstract = abstractText !== "" && abstractText !== "No abstract available.";
        if (!hasAbstract) countNoAbstract++;
    });

    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val; };
    setVal('count-5', count5);
    setVal('count-4', `${count4up} (=4: ${count4})`);
    setVal('count-3', `${count3up} (=3: ${count3})`);
    setVal('count-2', `${count2up} (=2: ${count2})`);
    setVal('count-1', `${count1up} (=1: ${count1})`);
    setVal('count-cyan', countCyan);
    setVal('count-noAbstract', countNoAbstract);
}

function closeSaveFilterModal() {
    const modal = document.getElementById('saveFilterModal');
    modal.style.display = 'none';
    modal.classList.add('hidden');
}

function updateSaveFilterMessage() {
    const filterValue = document.querySelector('input[name="saveFilter"]:checked').value;
    let matchCount = 0;
    let unscoredCount = 0;

    allReferences.forEach(ref => {
        if (ref.scoreNum === 0) unscoredCount++;

        let isMatch = false;
        if (filterValue === 'cyan') {
            isMatch = (ref.selection === 1);
        } else if (filterValue === 'noAbstract') { 
            const abstractText = ref.abstract ? ref.abstract.trim() : "";
            const hasAbstract = abstractText !== "" && abstractText !== "No abstract available.";
            isMatch = !hasAbstract;						
        } else {
            const targetScore = parseInt(filterValue, 10);
            if (ref.scoreNum >= targetScore) isMatch = true;
        }
        if (isMatch) matchCount++;
    });

    let msg = `${matchCount} / ${allReferences.length} articles matched.`;
    if (unscoredCount > 0) msg += `\n${unscoredCount} articles without AI score.`;

    const btnOk = document.getElementById('btnExecuteSaveFilter');

    if ((filterValue === 'cyan' || filterValue === 'noAbstract') && matchCount === 0) {
        msg = filterValue === 'cyan' ? "No selected article!" : "No articles without abstract!";
        btnOk.disabled = true;
        btnOk.classList.replace('bg-teal-600', 'bg-slate-300');
        btnOk.classList.replace('hover:bg-teal-700', 'hover:bg-slate-300');
    } else {
        btnOk.disabled = false;
        btnOk.classList.replace('bg-slate-300', 'bg-teal-600');
        btnOk.classList.replace('hover:bg-slate-300', 'hover:bg-teal-700');
    }

    document.getElementById('saveFilterMessage').innerText = msg;
}

function executeSaveFiltered() {
    const filterValue = document.querySelector('input[name="saveFilter"]:checked').value;
    syncNotesValues();
    
    // Keep the current display state intact and filter only the underlying data
    const targetReferences = allReferences.filter(ref => {
        if (filterValue === 'cyan') return ref.selection === 1;
        if (filterValue === 'noAbstract') {
            const abs = ref.abstract ? ref.abstract.trim() : "";
            return !(abs !== "" && abs !== "No abstract available.");
        }
        return ref.scoreNum >= parseInt(filterValue, 10);
    });

    // Save a backup, then reuse the saveTable logic by temporarily replacing allReferences
    const originalAllRefs = [...allReferences];
    allReferences = targetReferences; // Temporarily replace

    const clone = document.documentElement.cloneNode(true);
    const modalInClone = clone.querySelector('#saveFilterModal');
    if (modalInClone) { modalInClone.style.display = 'none'; modalInClone.classList.add('hidden'); }	
    
    // Run the same large table generation as saveTable on the clone
    const tbody = clone.querySelector('#tableBody');
    tbody.innerHTML = '';
    let allRowsHtml = "";
    allReferences.forEach((e, idx) => {
        const displayNo = idx + 1;
        const safeAbs = (e.abstract || "").replace(/\n/g, ' ').replace(/"/g, '&quot;');
        let refIdClass = "text-sm font-bold cursor-pointer border-r border-slate-100";
        if (e.selection === 1) refIdClass += " bg-selected-cyan";
        else if (e.selection === 2) refIdClass += " bg-selected-gray";

        allRowsHtml += `
            <tr class="hover:bg-slate-50 transition-colors" data-uuid="${e.uuid}">
                <td class="text-center text-slate-400 font-mono text-sm font-bold">${displayNo}${e.aiScoreHtml || ""}</td>
                <td class="${refIdClass}">${e.refId}</td>
                <td class="text-sm leading-relaxed">${e.bibInfo}</td>
                <td class="flex flex-col gap-1 items-start">
                    ${e.abstract ? `<button class="px-2 py-1 rounded text-[9px] font-bold bg-slate-100 border w-full" data-abstract="${safeAbs}" data-title="${(e.title || '').replace(/"/g, '&quot;')}" onclick="showAbstractByUuid('${e.uuid}', this)">Abstract</button>` : ''}
                    ${e.pmid ? `<button class="px-2 py-1 rounded text-[9px] font-bold bg-red-50 text-red-700 border w-full" onclick="window.open('https://pubmed.ncbi.nlm.nih.gov/${e.pmid.replace(/\D/g,'')}/', '_blank')">PubMed</button>` : ''}
                    ${e.doi ? `<button class="px-2 py-1 rounded text-[9px] font-bold bg-blue-50 text-blue-700 border w-full" onclick="window.open('https://doi.org/${e.doi}', '_blank')">doi</button>` : ''}
                    ${e.ur ? `<button class="px-2 py-1 rounded text-[9px] font-bold bg-blue-50 text-blue-700 border w-full" onclick="window.open('${e.ur}', '_blank')">${e.label || 'Link'}</button>` : ''}
                    ${e.registryUrl ? `<button class="px-2 py-1 rounded text-[9px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 w-full" onclick="window.open('${e.registryUrl}', '_blank')">Registry</button>` : ''}
                </td>
                <td class="comment-cell"><div class="comment-area text-sm outline-none">${e.notes || ""}</div></td>
            </tr>
        `;
    });
    tbody.innerHTML = allRowsHtml;

    // Restore previous state
    allReferences = originalAllRefs;

    const html = "<!DOCTYPE html>\n" + clone.outerHTML;
    const blob = new Blob([html], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    
    let filename = "filtered-references.htm";
    if (filterValue === 'cyan') filename = "selected-references.htm";
    else if (filterValue === 'noAbstract') filename = "no-abstract-references.htm";
    else filename = `ai-score-${filterValue}up-references.htm`;
    
    a.download = filename;
    a.click();
    
    closeSaveFilterModal();
    updateStatus(`> Saved ${targetReferences.length} filtered references to HTML.`);
}

function saveExcel() {
    if (allReferences.length === 0) return;
    
    const data = [["No", "AI Score", "Selection", "Reference ID", "Bibliographic Information", "Title", "Abstract", "PubMed", "Doi", "CENTRAL", "Ichushi", "Registry", "Notes", "Translation", "Gemini Response", "Gemini Raw"]];
    allReferences.forEach((e, idx) => {
        const no = idx + 1;
        
        let aiScoreStr = "";
        if (e.scoreNum > 0) {
            aiScoreStr = "●".repeat(e.scoreNum) + "○".repeat(5 - e.scoreNum);
        }
        
        const safeAbs = e.abstract ? e.abstract : "";
        const pm = e.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${e.pmid.replace(/\D/g,'')}/` : "";
        const doiStr = e.doi ? `https://doi.org/${e.doi}` : "";
        
        // Link identification logic simplified for Excel export based on label
        let ct = "", ic = "", rg = e.registryUrl || "";
        if (e.label === "CENTRAL") ct = e.ur;
        else if (e.label === "Ichushi") ic = e.ur;
        else if (e.ur && !ct && !ic) ct = e.ur; // Default fallback

        // Notes: strip HTML
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = e.notes || "";
        const notesText = tempDiv.innerText;

        // Strip HTML from bibliographic information
        const tempBib = document.createElement('div');
        tempBib.innerHTML = e.bibInfo || "";
        const bibInfoText = tempBib.innerText;

        // Decode translation and strip HTML
        let translationText = "";
        if (e.translation) {
            try {
                const decoded = decodeURIComponent(e.translation);
                const tempTrans = document.createElement('div');
                tempTrans.innerHTML = decoded;
                translationText = tempTrans.innerText;
            } catch(err) {
                translationText = e.translation;
            }
        }

        // Decode Gemini response and strip HTML
        let geminiResponseText = "";
        if (e.geminiResponse) {
            try {
                const decoded = decodeURIComponent(e.geminiResponse);
                const tempGem = document.createElement('div');
                tempGem.innerHTML = decoded;
                geminiResponseText = tempGem.innerText;
            } catch(err) {
                geminiResponseText = e.geminiResponse;
            }
        }

        // Decode Gemini raw (raw text; no HTML stripping required)
        let geminiRawText = "";
        if (e.geminiRaw) {
            try {
                geminiRawText = decodeURIComponent(e.geminiRaw);
            } catch(err) {
                geminiRawText = e.geminiRaw;
            }
        }

        // Add the cleaned values to the Excel data
        data.push([no, aiScoreStr, e.selection, e.refId, bibInfoText, e.title, safeAbs, pm, doiStr, ct, ic, rg, notesText, translationText, geminiResponseText, geminiRawText]);
    });
    
    const wb = XLSX.utils.book_new();
    const wsTable = XLSX.utils.aoa_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, wsTable, "Table");

    const badgesDiv = document.getElementById('conditionBadges');
    const promptMode = badgesDiv ? (badgesDiv.getAttribute('data-prompt-mode') || 'original criteria') : 'original criteria';
    
    const settingsData = [
        ["Setting Item", "Value"],
        ["AI Model", selectedAiModel || ""],
        ["AI-Adaptation Model", selectedAdaptationModel || ""],
        ["Prompt Mode", promptMode],
        ["Inclusion Criteria", document.getElementById('inclusionCriteria') ? document.getElementById('inclusionCriteria').value : ''],
        ["Exclusion Criteria", document.getElementById('exclusionCriteria') ? document.getElementById('exclusionCriteria').value : ''],
        ["Optimized Criteria", document.getElementById('optimizedCriteria') ? document.getElementById('optimizedCriteria').value : ''],
        ["Additional Prompt", document.getElementById('additionalPromptArea') ? document.getElementById('additionalPromptArea').value : ''],
        ["Ignore Outcome", document.getElementById('ignoreOutcomeCheck') && document.getElementById('ignoreOutcomeCheck').checked ? 1 : 0],
        ["Ignore RCT", document.getElementById('ignoreRctCheck') && document.getElementById('ignoreRctCheck').checked ? 1 : 0],
        ["Ignore Mixed", document.getElementById('ignoreMixedCheck') && document.getElementById('ignoreMixedCheck').checked ? 1 : 0]
    ];
    
    const wsSettings = XLSX.utils.aoa_to_sheet(settingsData);
    XLSX.utils.book_append_sheet(wb, wsSettings, "Criteria & Settings");

    XLSX.writeFile(wb, `reference-list.xlsx`);
}

function handleExcelImport(files) {
    if (!files || files.length === 0) return;
    const file = files[0];
    updateStatus(`Reading Excel: ${file.name} ...`);
    
    const reader = new FileReader();
    reader.onload = (e) => {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: 'array' });
        
        // Check for 'Table' sheet, fallback to the first sheet for backward compatibility
        const tableName = wb.SheetNames.includes("Table") ? "Table" : wb.SheetNames[0];
        const json = XLSX.utils.sheet_to_json(wb.Sheets[tableName]);
        
        // Restore application settings if the 'Criteria & Settings' sheet exists
        if (wb.SheetNames.includes("Criteria & Settings")) {
            const settingsJson = XLSX.utils.sheet_to_json(wb.Sheets["Criteria & Settings"], { header: 1 });
            const settings = {};
            settingsJson.forEach(row => {
                if (row && row.length >= 2) {
                    settings[row[0]] = row[1];
                }
            });
            
            if (settings["AI Model"]) {
                selectedAiModel = settings["AI Model"];
            }
            if (settings["AI-Adaptation Model"]) {
                selectedAdaptationModel = settings["AI-Adaptation Model"];
            } else if (settings["AI Model"]) {
                // Backward compatibility
                selectedAdaptationModel = settings["AI Model"];
            }
            
            updateModelDisplay();
            const select = document.getElementById('modelSelect');
            if (select) select.innerHTML = `<option value="${selectedAiModel}" selected>${selectedAiModel}</option>`;
            const adaptSelect = document.getElementById('adaptModelSelect');
            if (adaptSelect) adaptSelect.innerHTML = `<option value="${selectedAdaptationModel}" selected>${selectedAdaptationModel}</option>`;
            updateLabelsBasedOnModel();

            if (settings["Prompt Mode"]) {
                const badgesDiv = document.getElementById('conditionBadges');
                if (badgesDiv) badgesDiv.setAttribute('data-prompt-mode', settings["Prompt Mode"]);
            }
            
            if (settings["Inclusion Criteria"]) document.getElementById('inclusionCriteria').value = settings["Inclusion Criteria"];
            if (settings["Exclusion Criteria"]) document.getElementById('exclusionCriteria').value = settings["Exclusion Criteria"];
            
            if (settings["Optimized Criteria"] && settings["Optimized Criteria"].trim() !== "") {
                document.getElementById('optimizedCriteria').value = settings["Optimized Criteria"];
                document.getElementById('optimizedPromptArea').classList.remove('hidden');
            } else {
                document.getElementById('optimizedCriteria').value = '';
                document.getElementById('optimizedPromptArea').classList.add('hidden');
            }
            
            if (settings["Additional Prompt"]) {
                document.getElementById('additionalPromptArea').value = settings["Additional Prompt"];
            } else {
                document.getElementById('additionalPromptArea').value = '';
            }
            
            if (document.getElementById('ignoreOutcomeCheck')) {
                document.getElementById('ignoreOutcomeCheck').checked = (settings["Ignore Outcome"] == 1);
            }
            if (document.getElementById('ignoreRctCheck')) {
                document.getElementById('ignoreRctCheck').checked = (settings["Ignore RCT"] == 1);
            }
            if (document.getElementById('ignoreMixedCheck')) {
                document.getElementById('ignoreMixedCheck').checked = (settings["Ignore Mixed"] == 1);
            }
            updateConditionBadges();
        }
        
        let addedCount = 0;
        json.forEach(row => {
            let pmid = row["PubMed"] ? String(row["PubMed"]).replace(/\D/g, '') : "";
            let doi = row["Doi"] ? String(row["Doi"]).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim() : "";
            let title = row["Title"] || "";
            
            let bibInfo = row["Bibliographic Information"] || "";
            if (title && bibInfo.includes(title)) {
                bibInfo = bibInfo.replace(title, `<strong class="text-teal-600 font-bold">${title}</strong>`);
            }

            let selectionState = 0;
            if (row["Selection"] == 1 || row["Selection"] === '1') selectionState = 1;
            else if (row["Selection"] == 2 || row["Selection"] === '2') selectionState = 2;

            let linkStr = row["Ichushi"] || row["CENTRAL"] || row["Link"] || "";
            let labelStr = row["Ichushi"] ? "Ichushi" : (row["CENTRAL"] ? "CENTRAL" : "Link");

            let scoreHtml = "";
            if (row["AI Score"]) {
                const absText = row["Abstract"] ? String(row["Abstract"]).trim() : "";
                const hasAbs = absText !== "" && absText !== "No abstract available.";
                const dotColor = hasAbs ? "#22c55e" : "#eab308";
                
                const dots = String(row["AI Score"]).replace(/●/g, `<span style="color: ${dotColor};">●</span>`).replace(/○/g, '<span style="color: #cbd5e1;">○</span>');
                scoreHtml = `<div class="ai-score mt-1 text-xs tracking-tighter text-center whitespace-nowrap">${dots}</div>`;
            }

            const isAdded = addTableRow({
                refId: row["Reference ID"] || "",
                bibInfo: bibInfo,
                notes: row["Notes"] || "",
                idKey: Math.random().toString(36).substring(2, 15), 
                pmid: pmid,
                doi: doi,
                ur: linkStr,
                label: labelStr,
                registryUrl: row["Registry"] || "",
                title: title,
                abstract: row["Abstract"] || "",
                translation: row["Translation"] || "",
                geminiResponse: row["Gemini Response"] || "",
                geminiRaw: row["Gemini Raw"] || "",
                selection: selectionState,
                aiScoreHtml: scoreHtml
            });

            if (isAdded) addedCount++;
        });
        
        updateStatus(`Parsed: ${file.name} (Found ${json.length} records, ${addedCount} restored to queue)`);
        document.getElementById('excelFileInput').value = ""; 
    };
    reader.readAsArrayBuffer(file);
}

function openScreeningModal() {
    // Save the original textareas
    const textAreas = ['inclusionCriteria', 'exclusionCriteria', 'additionalPromptArea', 'optimizedCriteria'];
    textAreas.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.dataset.originalText = el.value;
    });

    // Save the original checkbox statuses
    const checkBoxes = ['ignoreOutcomeCheck', 'ignoreRctCheck', 'ignoreMixedCheck', 'sensitivityCheck'];
    checkBoxes.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.dataset.originalChecked = el.checked; 
    });

    document.getElementById('screeningModal').style.display = 'block';
}

function closeScreeningModal() {
    if (isScreeningRunning) return; 
    
    let hasChanges = false;

    // Check changes in textareas
    const textAreas = ['inclusionCriteria', 'exclusionCriteria', 'additionalPromptArea', 'optimizedCriteria'];
    textAreas.forEach(id => {
        const el = document.getElementById(id);
        if (el && el.value !== (el.dataset.originalText || "")) {
            hasChanges = true;
        }
    });

    // Check changes in checkboxes
    const checkBoxes = ['ignoreOutcomeCheck', 'ignoreRctCheck', 'ignoreMixedCheck', 'sensitivityCheck'];
    checkBoxes.forEach(id => {
        const el = document.getElementById(id);
        if (el && String(el.checked) !== el.dataset.originalChecked) {
            hasChanges = true;
        }
    });

    // If changes were made, add the red dot to the Save HTML button
    if (hasChanges) {
        markUnsaved();
    }

    document.getElementById('screeningModal').style.display = 'none';
}

function cancelScreening() {
    isScreeningRunning = false;
    
    const unscoredCount = allReferences.filter(r => r.scoreNum === 0).length;
    const scoredCount = allReferences.length - unscoredCount;

    document.getElementById('screeningStatus').innerText = `Stopped. Completed: ${scoredCount}, Remaining: ${unscoredCount}`;
    showMessage(`Screening manually stopped.\n\nCompleted: ${scoredCount} articles\nRemaining: ${unscoredCount} articles`);

    document.getElementById('btnStartScreening').disabled = false;
    if(document.getElementById('btnStartOptimized')) document.getElementById('btnStartOptimized').disabled = false;
    document.getElementById('btnCancelScreening').classList.add('hidden');
	
    if (document.getElementById('chunkSizeInput')) document.getElementById('chunkSizeInput').disabled = false;
    if (document.getElementById('concurrencyInput')) document.getElementById('concurrencyInput').disabled = false;
    const chunkSelect = document.querySelector('select[title="Presets"]');
    if (chunkSelect) chunkSelect.disabled = false;
}

// ==========================================
// AI Screening Operations (Array-based for v2.1)
// ==========================================

function resetScreeningScores(skipConfirm = false) {
    if (allReferences.length === 0) return;

    if (!skipConfirm) {
        if (!confirm("Do you want to reset all the screening scores and redo?\n（The red mark on the selected criteria will be reset too.）")) return;
    }

    allReferences.forEach(ref => {
        ref.scoreNum = 0;
        ref.aiScoreHtml = "";
        
        // Remove AI logs from notes
        if (ref.notes) {
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = ref.notes;
            const existingReasons = tempDiv.querySelectorAll('.ai-reason-log');
            existingReasons.forEach(el => el.remove());
            ref.notes = tempDiv.innerHTML;
        }
    });

    const indNormal = document.getElementById('indicatorNormal');
    const indOpt = document.getElementById('indicatorOptimized');
    if(indNormal) indNormal.classList.add('hidden');
    if(indOpt) indOpt.classList.add('hidden');

    const logArea = document.getElementById('sensitivityLogArea');
    if (logArea) logArea.value = "";
    accumulatedScreeningTime = 0;
    document.getElementById('screeningStatus').innerText = "Scores and marks reset.";
    renderTable();
}

function renderDotProgress(current, total, label = "Processing") {
    const safeCurrent = Math.min(current, total);
    const barLength = 20; 
    const progress = Math.min(Math.round((safeCurrent / total) * barLength), barLength);
    const dots = "●".repeat(progress);
    const empty = "○".repeat(barLength - progress);
    const percentage = Math.round((safeCurrent / total) * 100);
    return `<span class="font-mono text-indigo-600">${label}: [${dots}${empty}] ${percentage}%</span>`;
}

// --- Prompt definitions (Outcome Specification = Yes only retained) ---
const PROMPT_OUTCOME_YES = `You are an expert medical researcher conducting a systematic review. Your task is to convert the original Inclusion and Exclusion criteria into a practical, relaxed screening protocol for title/abstract review.

CRITICAL INSTRUCTIONS TO EMBED IN THE SCREENING PROMPT:
1. Study Design: Retain the original design criteria, but note that abstracts frequently omit explicit methodological labels. Do not exclude based on lack of wording if the study seems to fit the target design.
2. Outcome Criteria: Retain the core outcome criteria, but instruct the AI to include the study if the outcome is even implicitly suggested or broadly related to the target outcomes.
3. Broadened Population: Keep the target population as mandatory, but studies that also include population groups listed in the original exclusion criteria should not be automatically excluded when the target population is still present.
4. Broadened Interventions: Keep the target intervention as mandatory, but other interventions should not automatically exclude the study if the target intervention is still present.
5. Relaxed Intervention Details: Relax restrictions on dose, intensity, frequency, duration, etc. Accept broader ranges or studies where these details are not mentioned.
6. Minimal Exclusion Criteria: The relaxed exclusion criteria should retain only absolute core exclusions (e.g., completely different target disease, animal/non-human studies, or clearly unrelated intervention/population).
7. "When in doubt, include" Principle: Strongly instruct the screening AI that if a detail is ambiguous or if specific inclusion elements are not mentioned, it MUST NOT exclude the paper.
8. Scoring System: Use the following 1-5 integer scale: 5=Definitely include, 4=Probably include, 3=Unsure/Needs full text, 2=Probably exclude, 1=Definitely exclude.
9. Output Format: Output only the generated screening prompt containing the relaxed criteria in English. Do not include conversational filler.`;

//
// ==========================================
// UUID-based UI Actions (NEW/MODIFIED for v2.1)
// ==========================================

// Toggle selection state (Cyan / Gray / None)
function toggleRefColorByUuid(uuid) {
    const ref = allReferences.find(r => r.uuid === uuid);
    if (!ref) return;
    
    if (ref.selection === 1) ref.selection = 2; // Cyan -> Gray
    else if (ref.selection === 2) ref.selection = 0; // Gray -> None
    else ref.selection = 1; // None -> Cyan
    
    markUnsaved();
    renderTable(); // Refresh the screen
}

// ------------------------------------------
// Comment Modal Actions
// ------------------------------------------
function openCommentPanelByUuid(event, uuid) {
    event.preventDefault();
    event.stopPropagation();
    
    const ref = allReferences.find(r => r.uuid === uuid);
    if (!ref) return;
    
    activeCommentId = uuid;
    const displayIndex = filteredReferences.findIndex(r => r.uuid === uuid);
    const displayNo = displayIndex !== -1 ? displayIndex + 1 : "?";
    
    document.getElementById('commentModalRefInfo').innerText = `No: ${displayNo} | ${ref.refId}`;
    
    // Store the UUID in the hidden field
    document.getElementById('editingCommentUuid').value = uuid;

    // Remove AI reason logs and convert to plain text
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = ref.notes || "";
    const aiLog = tempDiv.querySelector('.ai-reason-log');
    if (aiLog) aiLog.remove();
    
    let htmlContent = tempDiv.innerHTML;
    htmlContent = htmlContent.replace(/<br\s*\/?>/gi, '\n')
                             .replace(/<\/div>\s*<div[^>]*>/gi, '\n')
                             .replace(/<div[^>]*>/gi, '')
                             .replace(/<\/div>/gi, '\n');
    
    const tempDiv2 = document.createElement('div');
    tempDiv2.innerHTML = htmlContent;
    let textToEdit = tempDiv2.innerText.replace(/^\s*\n+/, '');

    const editor = document.getElementById('commentEditorTextarea');
    editor.value = textToEdit;
    editor.dataset.originalText = textToEdit;
    
    document.getElementById('commentModal').style.display = 'block';
}

function saveAndCloseComment(event) {
    if (event) { event.preventDefault(); event.stopPropagation(); }
    
    const uuid = document.getElementById('editingCommentUuid').value;
    const ref = allReferences.find(r => r.uuid === uuid);
    if (!ref) {
        closeCommentModal();
        return;
    }
    
    const editor = document.getElementById('commentEditorTextarea');
    const newText = editor.value;
    const originalText = editor.dataset.originalText || "";

    if (newText !== originalText) {
        // Restore AI logs while saving
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = ref.notes || "";
        const aiLog = tempDiv.querySelector('.ai-reason-log');
        
        const formattedText = newText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
        let finalNotes = formattedText;
        if (aiLog) {
            finalNotes = aiLog.outerHTML + formattedText;
        }
        
        ref.notes = finalNotes;
        markUnsaved();
        renderTable(); // Refresh the screen
    }
    closeCommentModal();
}

function closeCommentModal() {
    document.getElementById('commentModal').style.display = 'none';
    activeCommentId = null;
    document.getElementById('editingCommentUuid').value = "";
}

// Save inline comment edits directly on screen
function saveCommentInline(uuid, element) {
    const ref = allReferences.find(r => r.uuid === uuid);
    if (ref) {
        const newHtml = element.innerHTML;
        if (ref.notes !== newHtml) {
            ref.notes = newHtml;
            markUnsaved();
        }
    }
}

// ------------------------------------------
// Abstract & Gemini Modal Actions
// ------------------------------------------
function showAbstractByUuid(uuid, btn) {
    const ref = allReferences.find(r => r.uuid === uuid);
    if (!ref) return;
    
    activeAbstractId = uuid; // For tracking
    const displayIndex = filteredReferences.findIndex(r => r.uuid === uuid);
    const displayNo = displayIndex !== -1 ? displayIndex + 1 : "?";
    
    document.getElementById('modalRefInfo').innerText = `No ${displayNo}: ${ref.refId}`;
    
    let abstractContent = "";
    if (ref.translation) {
        abstractContent = decodeURIComponent(ref.translation);
    } else {
        // Escape the original text safely for HTML output
        abstractContent = btn.dataset.abstract.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    
    // Apply search highlighting if a query exists
    if (currentSearchQuery) {
        abstractContent = highlightText(abstractContent, currentSearchQuery);
    }
    
    document.getElementById('modalBody').innerHTML = abstractContent;

    const askArea = document.getElementById('geminiResponseArea');
    if (ref.geminiResponse) {
        askArea.innerHTML = decodeURIComponent(ref.geminiResponse);
        askArea.classList.remove('hidden');
        document.getElementById('askGeminiArea').classList.remove('hidden');
        if (ref.geminiRaw) currentGeminiResponseRaw = decodeURIComponent(ref.geminiRaw);
    } else {
        askArea.innerHTML = "";
        askArea.classList.add('hidden');
        document.getElementById('askGeminiArea').classList.add('hidden');
        currentGeminiResponseRaw = "";
    }

    const t = document.getElementById('translateBtn'), a = document.getElementById('askGeminiBtn'), askExec = document.getElementById('executeAskBtn'); 
    if (!selectedAiModel) { 
        t.classList.add('opacity-40', 'pointer-events-none'); 
        a.classList.add('opacity-40', 'pointer-events-none'); 
        if (askExec) askExec.classList.add('opacity-40', 'pointer-events-none');
    } else { 
        t.classList.remove('opacity-40', 'pointer-events-none'); 
        a.classList.remove('opacity-40', 'pointer-events-none'); 
        if (askExec) askExec.classList.remove('opacity-40', 'pointer-events-none');
    } 
    document.getElementById('abstractModal').style.display = 'block';
}

// ==========================================
// Table Operations (Sort, Clear, Gather)
// ==========================================

function clearTable() {
    if(confirm("Clear all references?")) { 
        allReferences = [];
        filteredReferences = [];
        currentPage = 1;
        loadedIDs.clear(); 
        loadedPMIDs.clear();
        loadedDOIs.clear();
        loadedTitleYears.clear();
        loadedTitleAuthors.clear();
        renderTotalForCurrentJob = 0;
        
        document.getElementById('globalSearchInput').value = "";
        currentSearchQuery = "";
        
        renderTable(); 
        markUnsaved();
        updateStatus("All references cleared.");
    }
}

function gatherUp() {
    if (allReferences.length === 0) return;
    
    previousSortOrder = [...allReferences];
    
    // Sort by selection: Cyan (1) -> Gray (2) -> None (0)
    allReferences.sort((a, b) => {
        const getV = (r) => r.selection === 1 ? 1 : (r.selection === 2 ? 3 : 2);
        return getV(a) - getV(b);
    });
    
    currentPage = 1;
    applyFilterAndRender();
    updateStatus(`Gathered selected references. Total: ${allReferences.length}`);
}

function sortAiScore(event) {
    if (allReferences.length === 0) return;

    if (event && event.shiftKey) {
        if (previousSortOrder.length > 0) {
            allReferences = [...previousSortOrder];
            currentPage = 1;
            applyFilterAndRender();
            updateStatus(`Restored previous sort order.`);
        } else {
            showMessage("No previous sort state available.");
        }
        return;
    }

    previousSortOrder = [...allReferences];

    allReferences.sort((a, b) => b.scoreNum - a.scoreNum);

    currentPage = 1;
    applyFilterAndRender();
    updateStatus(`Sorted by AI Score. Total: ${allReferences.length}`);
}

// --- adaptCriteriaForAI function ---
async function adaptCriteriaForAI() {
    if (event && event.shiftKey) {
        document.getElementById('optimizedPromptArea').classList.toggle('hidden');
        return;
    }
    if (!selectedAdaptationModel) { 
        showMessage("Please select an AI-Adaptation Model in Settings first."); 
        return; 
    }

    const inclusion = document.getElementById('inclusionCriteria').value.trim();
    const exclusion = document.getElementById('exclusionCriteria').value.trim();

    if (!inclusion && !exclusion) {
        showMessage("Please enter Inclusion or Exclusion Criteria to adapt.");
        return;
    }

    const btn = document.getElementById('btnAdaptCriteria');
    const originalBtnHtml = btn.innerHTML;
    btn.innerHTML = `<svg class="animate-spin h-4 w-4 mr-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> Adapting...`;
    btn.disabled = true;
    
    const sysPrompt = PROMPT_OUTCOME_YES;
    const userPrompt = `### ORIGINAL CRITERIA ###\n\nInclusion Criteria:\n${inclusion}\n\nExclusion Criteria:\n${exclusion}`;

    // Temporarily switch to the adaptation model
    const originalModel = selectedAiModel;
    selectedAiModel = selectedAdaptationModel;

    try {
        let optimizedText = await executeAiRequest(sysPrompt, userPrompt);

        if (optimizedText === "Error.") {
            throw new Error("AI API request failed.");
        }

        // Remove markdown formatting (e.g., ```json or ```)
        optimizedText = optimizedText.replace(/^```[a-z]*\n/gi, '').replace(/```$/g, '').trim();

        document.getElementById('optimizedCriteria').value = optimizedText;
        document.getElementById('optimizedPromptArea').classList.remove('hidden');
        updateConditionBadges();
        
    } catch(e) {
        showMessage("Failed to adapt criteria. Please check your API key and network.");
        console.error(e);
    } finally {
        // Restore the original screening model
        selectedAiModel = originalModel;
        
        btn.innerHTML = originalBtnHtml;
        btn.disabled = false;
    }
}

function updateScoreUI(uuid, score) {
    const ref = allReferences.find(r => r.uuid === uuid);
    if (!ref) return;

    const abstractText = ref.abstract ? String(ref.abstract).trim() : "";
    const hasAbstract = abstractText !== "" && abstractText !== "No abstract available.";
    const dotColor = hasAbstract ? "#22c55e" : "#eab308";

    let dotsHTML = "";
    const numScore = parseInt(score, 10) || 0;
    for(let j=0; j<numScore; j++) dotsHTML += `<span style="color: ${dotColor};">●</span>`;
    for(let j=numScore; j<5; j++) dotsHTML += '<span style="color: #cbd5e1;">○</span>';

    ref.scoreNum = numScore;
    ref.aiScoreHtml = `<div class="ai-score mt-1 text-xs tracking-tighter text-center whitespace-nowrap">${dotsHTML}</div>`;
    
    markUnsaved();

    // Update only the score part without reloading the whole page if the row is visible
    const tr = document.querySelector(`tr[data-uuid="${uuid}"]`);
    if (tr) {
        const tdNo = tr.cells[0];
        const displayNo = tdNo.childNodes[0]?.textContent?.trim() || tdNo.innerText.replace(/●|○/g, '').trim();
        tdNo.innerHTML = `${displayNo}${ref.aiScoreHtml}`;
    }
}

// AI screening execution
async function startScreening(isOptimized = false) {
    if (!selectedAiModel) { showMessage("Please select an AI-Screening Model in Settings first."); return; }

    const criteriaName = isOptimized ? "Optimized Criteria ↓" : "Normal Criteria ↑";
    if (!confirm(`AI Model: ${selectedAiModel}\nCriteria: ${criteriaName}\n\nDo you want to start screening?`)) {
        return;
    }

    const startTime = Date.now();

    const badgesDiv = document.getElementById('conditionBadges');
    if (badgesDiv) {
        badgesDiv.setAttribute('data-prompt-mode', isOptimized ? 'AI-adapted' : 'original criteria');
        updateConditionBadges();
    }
    
    let criteriaText = "";
    const additionalRulesText = document.getElementById('additionalPromptArea') ? document.getElementById('additionalPromptArea').value.trim() : "";
    const appendedPrompt = additionalRulesText ? `\n\nAdditional Rules:\n${additionalRulesText}` : "";

    if (isOptimized) {
        criteriaText = document.getElementById('optimizedCriteria').value.trim();
        if (!criteriaText) { showMessage("Optimized criteria is empty. Please generate or enter it first."); return; }
        criteriaText = `Evaluation Criteria (Optimized Protocol):\n${criteriaText}${appendedPrompt}`;
    } else {
        const inclusion = document.getElementById('inclusionCriteria').value.trim();
        const exclusion = document.getElementById('exclusionCriteria').value.trim();
        if (!inclusion && !exclusion) { showMessage("Please enter Inclusion or Exclusion Criteria."); return; }
        criteriaText = `Inclusion Criteria:\n${inclusion}\n\nExclusion Criteria:\n${exclusion}${appendedPrompt}`;
    }

    const unscoredRefs = allReferences.filter(r => r.scoreNum === 0);

    if (allReferences.length === 0) { showMessage("No references found."); return; }
    if (unscoredRefs.length === 0) { 
        if (confirm("Screening of all references has been completed. To rerun with modified criteria, \nwould you like to reset the scores and start over from the beginning?")) {
            resetScreeningScores(true);
            startScreening(isOptimized);
        }
        return; 
    }

    isScreeningRunning = true;
    document.getElementById('btnStartScreening').disabled = true;
    if(document.getElementById('btnStartOptimized')) document.getElementById('btnStartOptimized').disabled = true;
    document.getElementById('btnCancelScreening').classList.remove('hidden');
    
    if (document.getElementById('chunkSizeInput')) document.getElementById('chunkSizeInput').disabled = true;
    if (document.getElementById('concurrencyInput')) document.getElementById('concurrencyInput').disabled = true;
    const chunkSelect = document.querySelector('select[title="Presets"]');
    if (chunkSelect) chunkSelect.disabled = true;
	
    const indNormal = document.getElementById('indicatorNormal');
    const indOpt = document.getElementById('indicatorOptimized');
    if(indNormal) indNormal.classList.add('hidden');
    if(indOpt) indOpt.classList.add('hidden');

    if (isOptimized) { if(indOpt) indOpt.classList.remove('hidden'); } 
    else { if(indNormal) indNormal.classList.remove('hidden'); }

    const statusEl = document.getElementById('screeningStatus');
    
    const isGPT = selectedAiModel.includes('gpt') || selectedAiModel.startsWith('o');
    
    // Read batch size and worker count from UI settings
    const chunkSizeInput = document.getElementById('chunkSizeInput');
    const concurrencyInput = document.getElementById('concurrencyInput');
    const CHUNK_SIZE = chunkSizeInput ? parseInt(chunkSizeInput.value, 10) || (isGPT ? 15 : 50) : (isGPT ? 15 : 50);
    const CONCURRENCY = concurrencyInput ? parseInt(concurrencyInput.value, 10) || 1 : 1;
    const waitTime = isGPT ? 2000 : 1000;
    
    const totalRowsCount = allReferences.length;
    const alreadyProcessedCount = totalRowsCount - unscoredRefs.length;
    
    // Progress and index management for concurrent processing
    let completedInSession = 0; 
    let currentIndex = 0; 

    // Initial display
    statusEl.innerHTML = renderDotProgress(alreadyProcessedCount, totalRowsCount, "Screening");

    async function processWorker() {
        while (currentIndex < unscoredRefs.length && isScreeningRunning) {
            const i = currentIndex;
            currentIndex += CHUNK_SIZE;
            
            const chunk = unscoredRefs.slice(i, i + CHUNK_SIZE);
            if (chunk.length === 0) break;

            try {
                const chunkMap = {}; // Map for short IDs to UUIDs
                
                const papersToEval = chunk.map((r, idx) => {
                    const evalId = `eval_${i + idx}`;
                    chunkMap[evalId] = r.uuid;
                    
                    let abstract = r.abstract ? String(r.abstract) : "";
                    let title = r.title ? String(r.title) : "";
                    
                    if (!title && r.bibInfo) {
                        const tempDiv = document.createElement('div');
                        tempDiv.innerHTML = r.bibInfo;
                        const st = tempDiv.querySelector('.text-teal-600.font-bold');
                        if (st) title = st.innerText;
                        else title = r.refId;
                    } else if (!title) {
                        title = r.refId;
                    }
                    
                    return {
                        id: evalId,
                        title: title.replace(/<[^>]+>/g, ''),
                        abstract: abstract.trim() || "No abstract available."
                    };
                });

                const isSensitivityMode = document.getElementById('sensitivityCheck') && document.getElementById('sensitivityCheck').checked;
                
                let sysPrompt = `You are an expert medical researcher conducting a systematic review. This usage of the AI function is strictly for academic research purposes. Evaluate the provided list of medical articles carefully.`;

                if (isSensitivityMode) {
                    sysPrompt += `\n3. SENSITIVITY ANALYSIS: If you assign a score of 1 or 2, you MUST provide a brief reason (1-2 sentences) explaining which criteria the abstract failed to meet. Include the main reason only, not extra commentary.`;
                }

                sysPrompt += `\n\nOutput ONLY a valid JSON array of objects with "id" (string), "score" (integer 1-5)`;
                if (isSensitivityMode) sysPrompt += `, and "reason" (string)`;
                sysPrompt += `.\n5=Definitely include, 4=Probably include, 3=Unsure/Needs full text, 2=Probably exclude, 1=Definitely exclude.\nDO NOT output markdown formatting, \`\`\`json, or any other conversational text.`;

                const userPrompt = `${criteriaText}\n\nPapers to evaluate:\n${JSON.stringify(papersToEval)}`;

                let responseText = "[]";
                for(let retry=0; retry<3; retry++) {
                    try {
                        if (isGPT) {
                            let gptProperties = { id: { type: "string" }, score: { type: "integer" } };
                            let gptRequired = ["id", "score"];
                            if (isSensitivityMode) { gptProperties.reason = { type: "string" }; gptRequired.push("reason"); }

                            const res = await fetch("https://api.openai.com/v1/chat/completions", {
                                method: "POST",
                                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${currentOpenaiApiKey}` },
                                body: JSON.stringify({
                                    model: selectedAiModel,
                                    messages: [{ role: "system", content: sysPrompt }, { role: "user", content: userPrompt }],
                                    response_format: { type: "json_schema", json_schema: { name: "screening_eval", strict: true, schema: { type: "object", properties: { results: { type: "array", items: { type: "object", properties: gptProperties, required: gptRequired } } }, required: ["results"] } } }
                                })
                            });
                            if(!res.ok) throw new Error(`HTTP ${res.status}`);
                            const json = await res.json();
                            const content = json.choices?.[0]?.message?.content || "";
                            try { responseText = JSON.stringify(JSON.parse(content).results || []); } catch(e) { responseText = content; }
                        } else {
                            let geminiProperties = { id: { type: "STRING" }, score: { type: "INTEGER" } };
                            let geminiRequired = ["id", "score"];
                            if (isSensitivityMode) { geminiProperties.reason = { type: "STRING" }; geminiRequired.push("reason"); }

                            const url = `https://generativelanguage.googleapis.com/v1beta/models/${selectedAiModel}:generateContent?key=${currentGeminiApiKey}`;
                            const payload = { 
                                contents: [{ parts: [{ text: userPrompt }] }], 
                                systemInstruction: { parts: [{ text: sysPrompt }] },
                                generationConfig: { 
                                    responseMimeType: "application/json",
                                    responseSchema: {
                                        type: "ARRAY",
                                        items: {
                                            type: "OBJECT",
                                            properties: geminiProperties, 
                                            required: geminiRequired
                                        }
                                    }
                                },
                                safetySettings: [
                                    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                                    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                                    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                                    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                                ]
                            };
                            const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                            if(!res.ok) throw new Error(`HTTP ${res.status}`);
                            const json = await res.json();
                            responseText = json.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
                        }
                        break; // Exit retry loop on success
                    } catch(e) {
                        console.warn(`API Error on attempt ${retry + 1}:`, e.message); 
                        if(retry === 2) throw e;
                        statusEl.innerHTML = renderDotProgress(alreadyProcessedCount + completedInSession, totalRowsCount, "Screening") + `<br><span class="text-amber-500 text-[10px]">API limit reached. Retrying in a few seconds...</span>`;
                        await new Promise(r => setTimeout(r, 15000 * (retry+1)));
                    }
                }
                
                let evalResults = [];
                try {
                    let cleanText = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
                    const matchArray = cleanText.match(/\[[\s\S]*\]/);
                    const matchObject = cleanText.match(/\{[\s\S]*\}/);

                    if (matchArray) {
                        evalResults = JSON.parse(matchArray[0]);
                    } else if (matchObject) {
                        let parsedObj = JSON.parse(matchObject[0]);
                        evalResults = parsedObj.results || parsedObj.evaluations || [parsedObj];
                    } else {
                        evalResults = JSON.parse(cleanText);
                    }

                    if (!Array.isArray(evalResults)) {
                        evalResults = (evalResults && evalResults.results) ? evalResults.results : [];
                    }
                } catch(e) { console.error("JSON parsing error:", responseText); }

                evalResults.forEach(item => {
                    const realUuid = chunkMap[item.id]; 
                    if (realUuid && item.score) {
                        updateScoreUI(realUuid, item.score);
                        
                        if (isSensitivityMode && (item.score === 1 || item.score === 2) && item.reason) {
                            const ref = allReferences.find(r => r.uuid === realUuid);
                            if (ref) {
                                const noText = (allReferences.indexOf(ref) + 1).toString();
                                const logText = `No.${noText} [Score ${item.score}] ${ref.refId}\n${item.reason}\n\n`;
                                const logArea = document.getElementById('sensitivityLogArea');
                                if (logArea) {
                                    document.getElementById('sensitivityLogContainer').classList.remove('hidden');
                                    logArea.value += logText;
                                    logArea.scrollTop = logArea.scrollHeight;
                                }
                            }
                        }
                    }
                });

                // Update progress on success
                completedInSession += chunk.length;
                statusEl.innerHTML = renderDotProgress(alreadyProcessedCount + completedInSession, totalRowsCount, "Screening");
                
                // Delay before next request
                if (currentIndex < unscoredRefs.length) await new Promise(r => setTimeout(r, waitTime));

            } catch (err) {
                console.error(err);
                statusEl.innerHTML = renderDotProgress(alreadyProcessedCount + completedInSession, totalRowsCount, "Screening") + `<br><span class="text-rose-500 text-[10px]">Error on some items, continuing without blocking the queue.</span>`;
                // Even on error, increase progress to avoid infinite loops
                completedInSession += chunk.length;
                await new Promise(r => setTimeout(r, 2000));
            }
        }
    }

    // Start as many workers as required by the concurrency setting
    const workers = [];
    for (let w = 0; w < CONCURRENCY; w++) {
        workers.push(processWorker());
    }
    
    // Wait for all workers to finish
    await Promise.all(workers);

    // Get the end timestamp and calculate the duration
    const endTime = Date.now();
    const durationSec = Math.floor((endTime - startTime) / 1000);
    
    // Add this run's time to the total time
    accumulatedScreeningTime += durationSec; 

    // Calculate total minutes and seconds
    const mins = Math.floor(accumulatedScreeningTime / 60);
    const secs = accumulatedScreeningTime % 60;
    const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

    if (isScreeningRunning) {
        const remainingCount = allReferences.filter(r => r.scoreNum === 0).length;
        const scoredCount = allReferences.length - remainingCount;

        if (remainingCount > 0) {
            statusEl.innerText = `Paused. Remaining: ${remainingCount} (Time: ${timeStr})`;
            showMessage(`Screening paused due to API limits or errors.\n\nCompleted: ${scoredCount} articles\nRemaining: ${remainingCount} articles\nTime elapsed: ${timeStr}`);
        } else {
            statusEl.innerText = `Screening complete. (Time: ${timeStr})`;
            showMessage(`AI Screening completed successfully for all articles!\n\nTime elapsed: ${timeStr}`);
        }
    }
    
    isScreeningRunning = false;
    document.getElementById('btnStartScreening').disabled = false;
    if(document.getElementById('btnStartOptimized')) document.getElementById('btnStartOptimized').disabled = false;
    document.getElementById('btnCancelScreening').classList.add('hidden');
    
    if (document.getElementById('chunkSizeInput')) document.getElementById('chunkSizeInput').disabled = false;
    if (document.getElementById('concurrencyInput')) document.getElementById('concurrencyInput').disabled = false;
    if (chunkSelect) chunkSelect.disabled = false;
}

function openApiKeyModal() { 
    document.getElementById('geminiApiKeyInput').value = currentGeminiApiKey; 
    document.getElementById('openaiApiKeyInput').value = currentOpenaiApiKey; 
    document.getElementById('apiKeyModal').style.display = 'block'; 
}
        
function togglePasswordVisibility() {
    const geminiInput = document.getElementById('geminiApiKeyInput');
    const openaiInput = document.getElementById('openaiApiKeyInput');
    const icon = document.getElementById('eyeIcon');
    
    const isHidden = (geminiInput && geminiInput.type === 'password') || (openaiInput && openaiInput.type === 'password');
    
    if (isHidden) {
        if (geminiInput) geminiInput.type = 'text';
        if (openaiInput) openaiInput.type = 'text';
        if (icon) icon.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72 3.11a3 3 0 1 0 4.24 4.24M1 1l22 22" />';
    } else {
        if (geminiInput) geminiInput.type = 'password';
        if (openaiInput) openaiInput.type = 'password';
        if (icon) icon.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>';
    }
}
        
function closeApiKeyModal() { 
    document.getElementById('apiKeyModal').style.display = 'none'; 
}
       
function updateApiKeyUI() { 
    const btn = document.getElementById('headerApiKeyBtn'); 
    if ((currentGeminiApiKey && currentGeminiApiKey.length > 5) || (currentOpenaiApiKey && currentOpenaiApiKey.length > 5)) { 
        btn.classList.remove('text-slate-400'); btn.classList.add('text-slate-800', 'font-bold'); 
    } else { 
        btn.classList.remove('text-slate-800', 'font-bold'); btn.classList.add('text-slate-400'); 
    } 
}
        
function saveApiKey() { 
    const geminiKey = document.getElementById('geminiApiKeyInput').value.trim(); 
    const openaiKey = document.getElementById('openaiApiKeyInput').value.trim(); 
    const model = document.getElementById('modelSelect').value; 
    const adaptModel = document.getElementById('adaptModelSelect').value; 
    
    if (!model || model === "" || model.includes("Click") || model.includes("Loading")) { 
        showMessage("Please set the AI-Screening Model."); return; 
    } 
    
    currentGeminiApiKey = geminiKey; 
    currentOpenaiApiKey = openaiKey; 
    selectedAiModel = model; 
    selectedAdaptationModel = adaptModel;
    
    syncNotesValues(); 

    const clone = document.documentElement.cloneNode(true);
    
    const modalInClone = clone.querySelector('#apiKeyModal');
    if (modalInClone) modalInClone.style.display = 'none';

    // Embed API keys into the saved HTML inputs
    const gInput = clone.querySelector('#geminiApiKeyInput');
    if (gInput) gInput.setAttribute('value', geminiKey);
    
    const oInput = clone.querySelector('#openaiApiKeyInput');
    if (oInput) oInput.setAttribute('value', openaiKey);

    const mSelect = clone.querySelector('#modelSelect');
    if (mSelect) mSelect.innerHTML = `<option value="${model}" selected>${model}</option>`;

    const aSelect = clone.querySelector('#adaptModelSelect');
    if (aSelect) aSelect.innerHTML = `<option value="${adaptModel}" selected>${adaptModel}</option>`;

    clone.querySelectorAll('.injected-settings-script').forEach(el => el.remove());

    const settingsScript = document.createElement('script');
    settingsScript.className = 'injected-settings-script';

    // Escape backticks (`) and dollar signs ($) to prevent syntax errors when injecting into a template literal
    const safeSysPrompt = currentAdaptSysPrompt.replace(/`/g, '\\`').replace(/\$/g, '\\$');
    const safeUserPrompt = currentAdaptUserPrompt.replace(/`/g, '\\`').replace(/\$/g, '\\$');

    settingsScript.textContent = `
        currentGeminiApiKey = "${currentGeminiApiKey}";
        currentOpenaiApiKey = "${currentOpenaiApiKey}";
        selectedAiModel = "${selectedAiModel}";
        selectedAdaptationModel = "${selectedAdaptationModel}";
        
        // Inject saved adaptation prompts
        currentAdaptSysPrompt = \`${safeSysPrompt}\`;
        currentAdaptUserPrompt = \`${safeUserPrompt}\`;
    `;
    clone.querySelector('head').appendChild(settingsScript);

    const htmlString = "<!DOCTYPE html>\n" + clone.outerHTML;
    const blob = new Blob([htmlString], { type: 'text/html' }); 
    const a = document.createElement('a'); 
    a.href = URL.createObjectURL(blob); 
    a.download = currentFileName; 
    a.click();

    document.getElementById('apiKeyModal').style.display = 'none'; 
    updateApiKeyUI(); 
    updateModelDisplay();
    updateLabelsBasedOnModel();
    updateConditionBadges(); 
}
        
// ==========================================
// Save & Export Operations (Array-based for v2.1)
// ==========================================

function saveTable() { 
    syncNotesValues(); 
    markSaved();
    const clone = document.documentElement.cloneNode(true);
    const chunkInput = clone.querySelector('#chunkSizeInput');
    if (chunkInput) chunkInput.setAttribute('value', document.getElementById('chunkSizeInput').value);
    const workersInput = clone.querySelector('#concurrencyInput');
    if (workersInput) workersInput.setAttribute('value', document.getElementById('concurrencyInput').value);
    const gInput = clone.querySelector('#geminiApiKeyInput');
    if (gInput) gInput.setAttribute('value', currentGeminiApiKey);
    const oInput = clone.querySelector('#openaiApiKeyInput');
    if (oInput) oInput.setAttribute('value', currentOpenaiApiKey);

    const mSelect = clone.querySelector('#modelSelect');
    if (mSelect) mSelect.innerHTML = `<option value="${selectedAiModel}" selected>${selectedAiModel}</option>`;
    const aSelect = clone.querySelector('#adaptModelSelect');
    if (aSelect) aSelect.innerHTML = `<option value="${selectedAdaptationModel}" selected>${selectedAdaptationModel}</option>`;

    clone.querySelectorAll('.injected-settings-script').forEach(el => el.remove());
    const settingsScript = document.createElement('script');
    settingsScript.className = 'injected-settings-script';

    const safeSysPrompt = currentAdaptSysPrompt.replace(/`/g, '\\`').replace(/\$/g, '\\$');
    const safeUserPrompt = currentAdaptUserPrompt.replace(/`/g, '\\`').replace(/\$/g, '\\$');

    settingsScript.textContent = `
        currentGeminiApiKey = "${currentGeminiApiKey}";
        currentOpenaiApiKey = "${currentOpenaiApiKey}";
        selectedAiModel = "${selectedAiModel}";
        selectedAdaptationModel = "${selectedAdaptationModel}";
        currentAdaptSysPrompt = \`${safeSysPrompt}\`;
        currentAdaptUserPrompt = \`${safeUserPrompt}\`;
    `;
    clone.querySelector('head').appendChild(settingsScript);

    // Important: when exporting full HTML, write all rows as a large <tr> table (backward compatibility)
    const tbody = clone.querySelector('#tableBody');
    tbody.innerHTML = '';
    
    let allRowsHtml = "";
    allReferences.forEach((e, idx) => {
        const displayNo = idx + 1;
        const safeAbs = (e.abstract || "").replace(/\n/g, ' ').replace(/"/g, '&quot;');
        let refIdClass = "text-sm font-bold cursor-pointer border-r border-slate-100";
        if (e.selection === 1) refIdClass += " bg-selected-cyan";
        else if (e.selection === 2) refIdClass += " bg-selected-gray";

        let trAttr = `data-uuid="${e.uuid}"`;
        if (e.translation) trAttr += ` data-translation="${encodeURIComponent(e.translation)}"`;
        if (e.geminiResponse) trAttr += ` data-gemini-response="${encodeURIComponent(e.geminiResponse)}"`;
        if (e.geminiRaw) trAttr += ` data-gemini-raw="${encodeURIComponent(e.geminiRaw)}"`;

        allRowsHtml += `
            <tr class="hover:bg-slate-50 transition-colors" ${trAttr}>
                <td class="text-center text-slate-400 font-mono text-sm font-bold">${displayNo}${e.aiScoreHtml || ""}</td>
                <td class="${refIdClass}" onclick="toggleRefColorByUuid('${e.uuid}')">${e.refId}</td>
                <td class="text-sm leading-relaxed">${e.bibInfo}</td>
                <td class="flex flex-col gap-1 items-start">
                    ${e.abstract ? `<button class="px-2 py-1 rounded text-[9px] font-bold bg-slate-100 border w-full" data-abstract="${safeAbs}" data-title="${(e.title || '').replace(/"/g, '&quot;')}" onclick="showAbstractByUuid('${e.uuid}', this)">Abstract</button>` : ''}
                    ${e.pmid ? `<button class="px-2 py-1 rounded text-[9px] font-bold bg-red-50 text-red-700 border w-full" onclick="window.open('https://pubmed.ncbi.nlm.nih.gov/${e.pmid.replace(/\D/g,'')}/', '_blank')">PubMed</button>` : ''}
                    ${e.doi ? `<button class="px-2 py-1 rounded text-[9px] font-bold bg-blue-50 text-blue-700 border w-full" onclick="window.open('https://doi.org/${e.doi}', '_blank')">doi</button>` : ''}
                    ${e.ur ? `<button class="px-2 py-1 rounded text-[9px] font-bold bg-blue-50 text-blue-700 border w-full" onclick="window.open('${e.ur}', '_blank')">${e.label || 'Link'}</button>` : ''}
                    ${e.registryUrl ? `<button class="px-2 py-1 rounded text-[9px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 w-full" onclick="window.open('${e.registryUrl}', '_blank')">Registry</button>` : ''}
                </td>
                <td class="comment-cell"><div class="comment-area text-sm outline-none" contenteditable="true" oncontextmenu="openCommentPanelByUuid(event, '${e.uuid}')" onblur="saveCommentInline('${e.uuid}', this)">${e.notes || ""}</div></td>
            </tr>
        `;
    });
    tbody.innerHTML = allRowsHtml;

    const blob = new Blob(["<!DOCTYPE html>\n" + clone.outerHTML], { type: 'text/html' }); 
    const a = document.createElement('a'); 
    a.href = URL.createObjectURL(blob); 
    a.download = currentFileName; 
    a.click(); 
}
        
function syncNotesValues() { 
    // Preserve textarea states for HTML export
    document.querySelectorAll('textarea').forEach(ta => {
        if(ta.id !== 'commentEditorTextarea') {
            ta.innerHTML = ta.value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
    });
    
    // Checkbox states
    const cb = document.getElementById('ignoreOutcomeCheck');
    if (cb) {
        if (cb.checked) cb.setAttribute('checked', 'checked');
        else cb.removeAttribute('checked');
    }
    const cbRct = document.getElementById('ignoreRctCheck');
    if (cbRct) {
        if (cbRct.checked) cbRct.setAttribute('checked', 'checked');
        else cbRct.removeAttribute('checked');
    }
    const cbMixed = document.getElementById('ignoreMixedCheck');
    if (cbMixed) {
        if (cbMixed.checked) cbMixed.setAttribute('checked', 'checked');
        else cbMixed.removeAttribute('checked');
    }
    const addPrompt = document.getElementById('additionalPromptArea');
    if (addPrompt) addPrompt.textContent = addPrompt.value;
    
    const cbSens = document.getElementById('sensitivityCheck');
    if (cbSens) {
        if (cbSens.checked) cbSens.setAttribute('checked', 'checked');
        else cbSens.removeAttribute('checked');
    }
}

function updateStatus(msg) { const div = document.getElementById('status'); const p = document.createElement('p'); p.textContent = `> ${msg}`; div.prepend(p); }
function showMessage(t) { document.getElementById('messageText').innerText = t; document.getElementById('messageModal').style.display = 'block'; }
function closeMessageModal() { document.getElementById('messageModal').style.display = 'none'; }

function closeModal() { document.getElementById('abstractModal').style.display = 'none'; document.getElementById('askGeminiArea').classList.add('hidden'); }
function toggleMode() { const ui = document.getElementById('feedingUI'); const btn = document.getElementById('modeToggleBtn'); if (ui.classList.contains('hidden')) { ui.classList.remove('hidden'); btn.innerHTML = 'Literature Feeding Mode'; } else { ui.classList.add('hidden'); btn.innerHTML = 'Study Selection Mode'; } }

async function fetchAvailableModels() { 
    const geminiKey = document.getElementById('geminiApiKeyInput').value.trim(); 
    const openaiKey = document.getElementById('openaiApiKeyInput').value.trim(); 
    const select = document.getElementById('modelSelect'); 
    const adaptSelect = document.getElementById('adaptModelSelect'); 
    
    if (!geminiKey && !openaiKey) {
        showMessage("Please enter at least one API Key (Gemini or OpenAI).");
        return;
    }

    select.innerHTML = '<option>Loading models...</option>'; 
    adaptSelect.innerHTML = '<option>Loading models...</option>'; 
    
    let geminiModels = [];
    let openaiModels = [];

    if (geminiKey) {
        try { 
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`); 
            if (res.ok) {
                const data = await res.json(); 
                data.models.filter(m => m.supportedGenerationMethods.includes('generateContent')).forEach(m => { 
                    geminiModels.push(m.name.replace('models/', '')); 
                }); 
            }
        } catch (err) { console.warn("Gemini fetch error", err); }
    }

    if (openaiKey) {
        try {
            const res = await fetch('https://api.openai.com/v1/models', {
                headers: { 'Authorization': `Bearer ${openaiKey}` }
            });
            if (res.ok) {
                const data = await res.json();
                data.data.filter(m => m.id.includes('gpt') || m.id.startsWith('o1') || m.id.startsWith('o3')).forEach(m => {
                    openaiModels.push(m.id);
                });
            }
        } catch (err) { console.warn("OpenAI fetch error", err); }
    }

    select.innerHTML = ''; 
    adaptSelect.innerHTML = ''; 
    
    if (geminiModels.length === 0 && openaiModels.length === 0) {
        select.innerHTML = '<option value="">No models found or API keys are invalid.</option>';
        adaptSelect.innerHTML = '<option value="">No models found or API keys are invalid.</option>';
        return;
    }

    geminiModels.sort((a, b) => a.localeCompare(b));
    openaiModels.sort((a, b) => a.localeCompare(b));

    if (geminiModels.length > 0) {
        const group1 = document.createElement('optgroup');
        group1.label = "🟢 Gemini";
        const group2 = document.createElement('optgroup');
        group2.label = "🟢 Gemini";
        
        geminiModels.forEach(val => {
            const el1 = document.createElement('option');
            el1.value = val;
            el1.textContent = val; 
            if (val === selectedAiModel) el1.selected = true;
            group1.appendChild(el1);
            
            const el2 = document.createElement('option');
            el2.value = val;
            el2.textContent = val; 
            if (val === selectedAdaptationModel) el2.selected = true;
            group2.appendChild(el2);
        });
        select.appendChild(group1);
        adaptSelect.appendChild(group2);
    }

    if (openaiModels.length > 0) {
        const group1 = document.createElement('optgroup');
        group1.label = "🟣 Open AI";
        const group2 = document.createElement('optgroup');
        group2.label = "🟣 Open AI";
        
        openaiModels.forEach(val => {
            const el1 = document.createElement('option');
            el1.value = val;
            el1.textContent = val; 
            if (val === selectedAiModel) el1.selected = true;
            group1.appendChild(el1);
            
            const el2 = document.createElement('option');
            el2.value = val;
            el2.textContent = val; 
            if (val === selectedAdaptationModel) el2.selected = true;
            group2.appendChild(el2);
        });
        select.appendChild(group1);
        adaptSelect.appendChild(group2);
    }
}
        
function confirmModelSelection() { 
    const geminiKey = document.getElementById('geminiApiKeyInput').value.trim();
    const openaiKey = document.getElementById('openaiApiKeyInput').value.trim();
    const val = document.getElementById('modelSelect').value; 
    const adaptVal = document.getElementById('adaptModelSelect').value; 
    
    if (!val || val.includes("Error") || val.includes("Loading") || val.includes("(Click")) { 
        showMessage("Please select a valid AI-Screening Model."); return; 
    } 
    
    currentGeminiApiKey = geminiKey;
    currentOpenaiApiKey = openaiKey;
    selectedAiModel = val; 
    selectedAdaptationModel = adaptVal;
    
    updateModelDisplay();
    updateApiKeyUI();
    updateLabelsBasedOnModel();
    showMessage("Models are set temporarily.\n\nNote: Please click 'Save Keys & Models' to store them in your browser.");
    updateConditionBadges(); 
}

function updateModelDisplay() {
    const display = document.getElementById('currentModelDisplay');
    if (display) {
        display.innerText = `Screening: ${selectedAiModel || 'None'} | Adapt: ${selectedAdaptationModel || 'None'}`;
    }
}
        
async function handleTranslate() { 
    const btn = document.getElementById('translateBtn'); const original = btn.innerText; btn.innerText = "Translating..."; btn.disabled = true; 
    let abstract = "";
    
    // Retrieve the data from the internal array using UUID
    const ref = allReferences.find(r => r.uuid === activeAbstractId);
    if (ref && ref.abstract) {
        abstract = ref.abstract;
    } else {
        abstract = document.getElementById('modalBody').innerText;
    }

    let res = await executeAiRequest(
        "You are an expert medical translator. Do not output greetings or extra preamble. Output only the result.", 
        `Please translate the following abstract into Japanese:\n\n${abstract}`
    ); 
    if (res && res !== "Error.") { 
        let lines = res.split('\n');
        if (lines[0].trim().match(/^(はい|承知|分かりました|それでは)/) || lines[0].trim().match(/(翻訳します|以下の通りです)[。：:]?$/)) {
            lines.shift();
            while(lines.length > 0 && lines[0].trim() === "") lines.shift();
            res = lines.join('\n');
        }

        const encodedRes = encodeURIComponent(res);
        const translatedHtml = `
            <div class="flex justify-end mb-2">
                <span class="text-xs font-bold text-teal-600 cursor-pointer hover:underline" onclick="copyTranslation(this, '${encodedRes}')">Copy translation</span>
            </div>
            <div class="bg-teal-50 p-4 rounded mb-4">${marked.parse(res)}</div><hr class="my-4"><div class="opacity-60">${abstract}</div>
        `;
        document.getElementById('modalBody').innerHTML = translatedHtml; 
        
        // Update both the internal data and the DOM
        if (ref) {
            ref.translation = encodeURIComponent(translatedHtml);
            const tr = document.querySelector(`tr[data-uuid="${activeAbstractId}"]`);
            if (tr) tr.setAttribute('data-translation', ref.translation);
        }
        markUnsaved();
    } else {
        showMessage("An error occurred with the AI API.");
    }
    btn.innerText = original; btn.disabled = false; 
}

function copyTranslation(el, encodedText) {
    navigator.clipboard.writeText(decodeURIComponent(encodedText)).then(() => {
        el.innerText = "Copied translation";
        el.classList.replace('text-teal-600', 'text-teal-800');
    });
}
        
function setGeminiPrompt(type) {
    const promptArea = document.getElementById('geminiPrompt');
    const prompts = {
        summary: "Please summarize the essence of this study in a few lines.",
        pico: "Please briefly summarize this randomized controlled trial as P, I, C, O, and a brief effect summary. Use labels: P, I, C, O, Comments.",
        pdf: "This URL is a PDF of a research paper. Please summarize the most important findings from this study.",
        pdf_pico: "This URL is a PDF of a randomized controlled trial. Please summarize P, I, C, O, and the main effect for this RCT."
    };
    if (prompts[type]) { promptArea.value = prompts[type]; promptArea.focus(); }
}

function toggleAskGemini() { document.getElementById('askGeminiArea').classList.toggle('hidden'); }
        
async function executeGeminiAsk() { 
    const prompt = document.getElementById('geminiPrompt').value; 
    const btn = document.getElementById('executeAskBtn');
    let original = "Ask";
    if (btn) { original = btn.innerText; btn.innerText = "Asking..."; btn.disabled = true; }

    let res = await executeAiRequest(
        "Do not output greetings or preamble such as 'yes', 'understood', or 'below is the summary'. Output only the requested result directly.", 
        `Abstract:\n${document.getElementById('modalBody').innerText}\n\nQuestion:\n${prompt}`
    );
    
    if (res && res !== "Error.") { 
        let lines = res.split('\n');
        let firstLine = lines[0].trim();
        if (firstLine.match(/^(はい|承知|分かりました|それでは|以下のよう)/) || firstLine.match(/(まとめます|まとめると|以下の通り|以下になります)[。：:]?$/)) {
            lines.shift();
            while(lines.length > 0 && lines[0].trim() === "") lines.shift();
            res = lines.join('\n');
        }

        const area = document.getElementById('geminiResponseArea'); 
        currentGeminiResponseRaw = res;
        const encodedRes = encodeURIComponent(res);
        const responseHtml = `
            <div class="flex justify-end gap-4 mb-3 border-b pb-2">
                <button onclick="copyGeminiResponse(this, '${encodedRes}')" class="text-xs font-bold text-indigo-600 hover:text-indigo-800">Copy</button>
                <button onclick="putAfterComment(this)" class="text-xs font-bold text-indigo-600 hover:text-indigo-800">Put after comment</button>
            </div>
            <div class="markdown-body text-slate-800 text-sm">${marked.parse(res)}</div>
        `; 
        
        let currentHtml = area.innerHTML;
        if (area.classList.contains('hidden')) currentHtml = "";
        const newEntry = `<div class="mb-6"><div class="text-xs text-indigo-500 font-bold mb-1">Q: ${prompt}</div>${responseHtml}</div>`;
        
        area.innerHTML = newEntry + currentHtml;
        area.classList.remove('hidden'); 

        // Update internal state and DOM with UUID
        const ref = allReferences.find(r => r.uuid === activeAbstractId);
        if (ref) {
            ref.geminiResponse = encodeURIComponent(area.innerHTML);
            ref.geminiRaw = encodeURIComponent(res);
            
            const tr = document.querySelector(`tr[data-uuid="${activeAbstractId}"]`);
            if (tr) {
                tr.setAttribute('data-gemini-response', ref.geminiResponse);
                tr.setAttribute('data-gemini-raw', ref.geminiRaw);
            }
        }
    } else {
        showMessage("An error occurred with the AI API. Recording skipped.");
        currentGeminiResponseRaw = "";
    }
    if (btn) { btn.innerText = original; btn.disabled = false; }
}

function copyGeminiResponse(btn, encodedText) {
    navigator.clipboard.writeText(decodeURIComponent(encodedText)).then(() => {
        const orig = btn.innerText;
        btn.innerText = "Copied!";
        setTimeout(() => btn.innerText = orig, 2000);
    });
}

function putAfterComment(btn) {
    // Process using activeAbstractId
    if (!activeAbstractId) {
        showMessage("No active reference selected.");
        return;
    }
    const ref = allReferences.find(r => r.uuid === activeAbstractId);
    if (!ref) return;

    let text = currentGeminiResponseRaw;
    if (!text && ref.geminiRaw) text = decodeURIComponent(ref.geminiRaw);
    
    if (!text) {
        const firstContent = document.querySelector('#geminiResponseArea .markdown-body');
        if (firstContent) text = firstContent.innerText;
    }

    if (!text || text.trim() === "") return;
    
    // Protect AI logs while appending the new comment
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = ref.notes || "";
    const aiLog = tempDiv.querySelector('.ai-reason-log');
    if (aiLog) aiLog.remove();
    
    let currentTextHtml = tempDiv.innerHTML.trim();
    let newTextFormatted = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');

    if (currentTextHtml) {
        currentTextHtml += '<br><br>' + newTextFormatted;
    } else {
        currentTextHtml = newTextFormatted;
    }
    
    if (aiLog) {
        currentTextHtml = aiLog.outerHTML + currentTextHtml;
    }
    
    // Update internal data and refresh the screen
    ref.notes = currentTextHtml;
    markUnsaved();
    renderTable(); 
    
    if (btn) {
        const orig = btn.innerText;
        btn.innerText = "Added!";
        setTimeout(() => btn.innerText = orig, 2000);
    }
}

function performMerge(droppedHtml, fileName = "HTML File") { 
    const parser = new DOMParser();
    const droppedDoc = parser.parseFromString(droppedHtml, 'text/html');
    
    // Extract only selected references from the dropped HTML (Cyan selection)
    const droppedRows = Array.from(droppedDoc.querySelectorAll('#tableBody tr')).filter(r => r.cells[1]?.classList.contains('bg-selected-cyan')); 

    if (droppedRows.length === 0) {
        showMessage("No selected article found in dropped HTML!");
        updateStatus(`Parsed: ${fileName} (No selected article found)`);
        return;
    }

    let mergedCount = 0;
    let addedCount = 0;

    droppedRows.forEach(dropRow => {
        let pmidB = "", doiB = "", titleB = "";
        let refIdB = dropRow.cells[1].innerText.trim().toLowerCase();

        dropRow.cells[3].querySelectorAll('button').forEach(btn => {
            const t = btn.innerText.trim();
            const onClick = btn.getAttribute('onclick') || "";
            const url = onClick.match(/'([^']+)'/)?.[1] || "";
            if (t === "PubMed") pmidB = url.replace(/\D/g, '');
            else if (t === "doi") doiB = url.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim().toLowerCase();
        });
        const strongTagB = dropRow.cells[2].querySelector('strong');
        if (strongTagB) {
            titleB = strongTagB.innerText.replace(/<[^>]+>/g, '').replace(/[^\w\s]/g, '').trim().toLowerCase();
        } else {
            titleB = dropRow.cells[2].innerText.replace(/[^\w\s]/g, '').trim().toLowerCase().substring(0, 50);
        }

        const dropCommentArea = dropRow.querySelector('.comment-area');
        const dropComment = dropCommentArea ? dropCommentArea.innerHTML.trim() : "";

        let matchedItem = allReferences.find(a => 
            (pmidB && a.pmid === pmidB) ||
            (doiB && a.doi === doiB) ||
            (titleB && a.title && titleB.substring(0, 30) === a.title.substring(0, 30)) ||
            (refIdB && a.refId.toLowerCase() === refIdB)
        );

        if (matchedItem) {
            matchedItem.selection = 1; // Cyan
            if (dropComment) {
                matchedItem.notes = (matchedItem.notes ? matchedItem.notes + "<br>" : "") + `<span style="color: blue;">${dropComment}</span>`;
            }
            mergedCount++;
        } else {
            // If not found, add as new entry (addTableRow handles queue processing later)
            const isAdded = addTableRow({
                refId: dropRow.cells[1].innerText.trim(),
                bibInfo: dropRow.cells[2].innerHTML,
                notes: dropComment ? `<span style="color: blue;">${dropComment}</span>` : "",
                idKey: Math.random().toString(36).substring(2, 15),
                pmid: pmidB, doi: doiB, title: titleB,
                selection: 1
            });
            if (isAdded) addedCount++;
        }
    });

    markUnsaved();
    applyFilterAndRender();
    showMessage(`Merge Complete!\n\n- ${mergedCount} articles matched and highlighted.\n- ${addedCount} new selected articles added.`);
    updateStatus(`> Merge Complete: Updated ${mergedCount}, Added ${addedCount} from ${fileName}`);
}

async function handleOpenHtml(files) {
    if (!files || files.length === 0) return;
    const file = files[0];
    
    updateStatus(`Reading: ${file.name} ...`);
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 50)));

    const reader = new FileReader();
    reader.onload = (e) => {
        const text = new TextDecoder('utf-8').decode(e.target.result);
        if (text.includes('id="tableBody"') && text.includes('<!DOCTYPE html>')) {
            restoreSavedHtml(text, file.name);
        } else {
            showMessage("Invalid HTML file format.");
            updateStatus(`Error: ${file.name} is not a valid saved HTML.`);
        }
        document.getElementById('htmlFileInput').value = ""; 
    };
    reader.readAsArrayBuffer(file);
}

// ==========================================
// HTML Import & Merge Operations (v2.1 Array-based)
// ==========================================

function restoreSavedHtml(htmlText, fileName) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, 'text/html');
    
    // Restore UI and settings (existing logic)
    const savedInclusion = doc.getElementById('inclusionCriteria');
    const savedExclusion = doc.getElementById('exclusionCriteria');
    const savedCb = doc.getElementById('ignoreOutcomeCheck');
    if (savedInclusion) document.getElementById('inclusionCriteria').value = savedInclusion.value || savedInclusion.textContent;
    if (savedExclusion) document.getElementById('exclusionCriteria').value = savedExclusion.value || savedExclusion.textContent;
    if (savedCb) document.getElementById('ignoreOutcomeCheck').checked = savedCb.hasAttribute('checked');
    const savedCbRct = doc.getElementById('ignoreRctCheck');
    if (savedCbRct) document.getElementById('ignoreRctCheck').checked = savedCbRct.hasAttribute('checked');
    const savedCbMixed = doc.getElementById('ignoreMixedCheck');
    if (savedCbMixed) document.getElementById('ignoreMixedCheck').checked = savedCbMixed.hasAttribute('checked');
    const savedCbSens = doc.getElementById('sensitivityCheck');
    if (savedCbSens) document.getElementById('sensitivityCheck').checked = savedCbSens.hasAttribute('checked');
    const savedLogArea = doc.getElementById('sensitivityLogArea');
    if (savedLogArea) {
        const logText = savedLogArea.value || savedLogArea.textContent;
        document.getElementById('sensitivityLogArea').value = logText;
        if (logText.trim() !== '') document.getElementById('sensitivityLogContainer').classList.remove('hidden');
    }
    const savedOptimized = doc.getElementById('optimizedCriteria');
    if (savedOptimized) {
        const optText = savedOptimized.value || savedOptimized.textContent;
        if (optText.trim() !== '') {
            document.getElementById('optimizedCriteria').value = optText;
            document.getElementById('optimizedPromptArea').classList.remove('hidden');
        } else {
            document.getElementById('optimizedCriteria').value = '';
            document.getElementById('optimizedPromptArea').classList.add('hidden');
        }
    }
    const savedAddPrompt = doc.getElementById('additionalPromptArea');
    if (savedAddPrompt) document.getElementById('additionalPromptArea').value = savedAddPrompt.textContent.trim();
    const savedMemo = doc.getElementById('projectMemoArea');
    if (savedMemo) {
        document.getElementById('projectMemoArea').value = savedMemo.value || savedMemo.textContent;
        updateMemoBtnUI();
    }
    
    const savedChunk = doc.getElementById('chunkSizeInput');
    if (savedChunk) {
        const val = savedChunk.value || savedChunk.getAttribute('value');
        if (val) document.getElementById('chunkSizeInput').value = val;
    }
    const savedWorkers = doc.getElementById('concurrencyInput');
    if (savedWorkers) {
        const val = savedWorkers.value || savedWorkers.getAttribute('value');
        if (val) document.getElementById('concurrencyInput').value = val;
    }

    const savedBadges = doc.getElementById('conditionBadges');
    if (savedBadges && savedBadges.hasAttribute('data-prompt-mode')) {
        document.getElementById('conditionBadges').setAttribute('data-prompt-mode', savedBadges.getAttribute('data-prompt-mode'));
    } else if (savedOptimized && (savedOptimized.value || savedOptimized.textContent).trim() !== '') {
        document.getElementById('conditionBadges').setAttribute('data-prompt-mode', 'AI-adapted');
    } else {
        document.getElementById('conditionBadges').setAttribute('data-prompt-mode', 'original criteria');
    }

    const injectedScript = doc.querySelector('.injected-settings-script');
    if (injectedScript) {
        document.querySelectorAll('.injected-settings-script').forEach(el => el.remove());
        const newScript = document.createElement('script');
        newScript.className = 'injected-settings-script';
        newScript.textContent = injectedScript.textContent;
        document.head.appendChild(newScript);
        
        setTimeout(() => {
            updateModelDisplay();
            updateApiKeyUI();
            updateLabelsBasedOnModel();
        }, 50);
    }
    const rows = Array.from(doc.querySelectorAll('#tableBody tr'));
    let addedCount = 0;

    rows.forEach(row => {
        let pmid = "", doi = "", title = "", abstract = "";
        let ur = "", label = "Link", registryUrl = "";

        if (!row.cells || row.cells.length < 5) return;

        const absBtn = row.cells[3].querySelector('button[data-abstract]');
        if (absBtn) { 
            abstract = absBtn.dataset.abstract; 
            title = absBtn.dataset.title; 
        }

        row.cells[3].querySelectorAll('button').forEach(btn => {
            const t = btn.innerText.trim();
            const onClick = btn.getAttribute('onclick') || "";
            const url = onClick.match(/'([^']+)'/)?.[1] || "";
            if (t === "PubMed") pmid = url.replace(/\D/g, '');
            else if (t === "doi") doi = url.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
            else if (t === "Registry") registryUrl = url;
            else if (t !== "Abstract") { ur = url; label = t; }
        });

        if (!title) {
            const titleMatch = row.cells[2].innerHTML.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i);
            if (titleMatch) title = titleMatch[1].replace(/<[^>]+>/g, '').trim();
        }

        const scoreDiv = row.cells[0].querySelector('.ai-score');
        let aiScoreHtml = scoreDiv ? scoreDiv.outerHTML : "";
        let scoreNum = (row.cells[0].textContent.match(/●/g) || []).length;
        
        // Self-healing logic for cases where tags were accidentally lost in past versions
        if (!scoreDiv && scoreNum > 0) {
            const hasAbs = abstract !== "" && abstract !== "No abstract available.";
            const dotColor = hasAbs ? "#22c55e" : "#eab308";
            let dotsHTML = "";
            for(let j=0; j<scoreNum; j++) dotsHTML += `<span style="color: ${dotColor};">●</span>`;
            for(let j=scoreNum; j<5; j++) dotsHTML += '<span style="color: #cbd5e1;">○</span>';
            aiScoreHtml = `<div class="ai-score mt-1 text-xs tracking-tighter text-center whitespace-nowrap">${dotsHTML}</div>`;
        }

        const trans = row.getAttribute('data-translation') ? decodeURIComponent(row.getAttribute('data-translation')) : "";
        const geminiRes = row.getAttribute('data-gemini-response') ? decodeURIComponent(row.getAttribute('data-gemini-response')) : "";
        const geminiRaw = row.getAttribute('data-gemini-raw') ? decodeURIComponent(row.getAttribute('data-gemini-raw')) : "";

        let selectionState = 0;
        if (row.cells[1].classList.contains('bg-selected-cyan')) selectionState = 1;
        else if (row.cells[1].classList.contains('bg-selected-gray')) selectionState = 2;

        const isAdded = addTableRow({
            refId: row.cells[1].innerText.trim(),
            bibInfo: row.cells[2].innerHTML,
            notes: row.querySelector('.comment-area') ? row.querySelector('.comment-area').innerHTML : "",
            idKey: Math.random().toString(36).substring(2, 15),
            pmid: pmid, doi: doi, ur: ur, label: label, registryUrl: registryUrl,
            title: title, abstract: abstract, translation: trans, geminiResponse: geminiRes, geminiRaw: geminiRaw,
            selection: selectionState, aiScoreHtml: aiScoreHtml,
            scoreNum: scoreNum
        });

        if (isAdded) addedCount++;
    });

    updateStatus(`Parsed: ${fileName} (Found ${rows.length} records, ${addedCount} restored to queue)`);
    updateConditionBadges(); 
}

function removeApiKey() { 
    currentGeminiApiKey = ""; 
    currentOpenaiApiKey = ""; 
    
    localStorage.removeItem('gemini_api_key_riput');
    localStorage.removeItem('openai_api_key_riput');
    localStorage.removeItem('selected_ai_model_riput');
    localStorage.removeItem('selected_adaptation_model_riput');
    
    document.getElementById('geminiApiKeyInput').value = ""; 
    document.getElementById('openaiApiKeyInput').value = ""; 
    updateApiKeyUI(); 
    updateModelDisplay();
    updateLabelsBasedOnModel();
    
    showMessage("API Keys and Models removed from your browser.\n\nNote: Please click 'Save Keys & Models' if you want to save this state to your HTML file.");
    
    updateConditionBadges(); 
}

window.addEventListener('DOMContentLoaded', () => {
    const path = window.location.pathname;
    const fileName = path.substring(path.lastIndexOf('/') + 1);
    if (fileName && fileName.trim() !== "" && fileName !== "index.html") {
        currentFileName = decodeURIComponent(fileName);
    }

    if (!currentGeminiApiKey) {
        currentGeminiApiKey = localStorage.getItem('gemini_api_key_riput') || "";
    }
    if (!currentOpenaiApiKey) {
        currentOpenaiApiKey = localStorage.getItem('openai_api_key_riput') || "";
    }
    
    if (!selectedAiModel || selectedAiModel === "") {
        const savedModel = localStorage.getItem('selected_ai_model_riput');
        if (savedModel) selectedAiModel = savedModel;
        else selectedAiModel = "gemini-3.8-flash"; 
    }

    if (!selectedAdaptationModel || selectedAdaptationModel === "") {
        const savedAdaptModel = localStorage.getItem('selected_adaptation_model_riput');
        if (savedAdaptModel) selectedAdaptationModel = savedAdaptModel;
        else selectedAdaptationModel = "gemini-3.1-pro-preview"; // Default for adaptation
    }
    
    updateModelDisplay();
    
    const select = document.getElementById('modelSelect');
    if (select) select.innerHTML = `<option value="${selectedAiModel}" selected>${selectedAiModel}</option>`;

    const adaptSelect = document.getElementById('adaptModelSelect');
    if (adaptSelect) adaptSelect.innerHTML = `<option value="${selectedAdaptationModel}" selected>${selectedAdaptationModel}</option>`;
    
    updateApiKeyUI();
    updateLabelsBasedOnModel();
    updateConditionBadges(); 
    updateMemoBtnUI(); // Initialize the memo button state
    
    const dz = document.getElementById('dropZone');
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('hover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('hover'));
    dz.addEventListener('drop', (e) => { 
        e.preventDefault(); 
        e.stopPropagation(); 
        dz.classList.remove('hover'); 

        const files = e.dataTransfer.files;
        if (files && files.length > 0) {
            setTimeout(() => {
                handleFiles(files); 
            }, 50);
        }
    });
    
    const tbody = document.getElementById('tableBody');
    let draggedRow = null;
  
    // Make the AI Screening modal draggable
    const screeningModalContent = document.getElementById('screeningModalContent');
    const screeningModalHeader = document.getElementById('screeningModalHeader');
    
    let isDraggingScreening = false;
    let startX, startY, initialLeft, initialTop;

    if (screeningModalHeader && screeningModalContent) {
        screeningModalHeader.addEventListener('mousedown', (e) => {
            if(e.target.closest('button')) return;

            isDraggingScreening = true;
            startX = e.clientX;
            startY = e.clientY;

            const rect = screeningModalContent.getBoundingClientRect();
            if (screeningModalContent.style.position !== 'absolute') {
                screeningModalContent.style.position = 'absolute';
                screeningModalContent.style.margin = '0';
                screeningModalContent.style.left = rect.left + 'px';
                screeningModalContent.style.top = rect.top + 'px';
            }

            initialLeft = parseFloat(screeningModalContent.style.left) || rect.left;
            initialTop = parseFloat(screeningModalContent.style.top) || rect.top;
            
            screeningModalHeader.style.cursor = 'grabbing';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDraggingScreening) return;
            e.preventDefault(); 
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            screeningModalContent.style.left = (initialLeft + dx) + 'px';
            screeningModalContent.style.top = (initialTop + dy) + 'px';
        });

        document.addEventListener('mouseup', () => {
            isDraggingScreening = false;
            screeningModalHeader.style.cursor = 'move';
        });
    }
    ingestExistingTable();
});

function updateLabelsBasedOnModel() {
    const isGPT = selectedAiModel && (selectedAiModel.includes('gpt') || selectedAiModel.startsWith('o'));
    const askBtn = document.getElementById('askGeminiBtn');
    const screeningHeaderBtn = document.querySelector('button[onclick="openScreeningModal()"]');
    
    const label = isGPT ? "Ask GPT" : "Ask Gemini";
    
    if (askBtn) askBtn.innerText = label;
    if (screeningHeaderBtn) {
        // 元のアイコン（キラキラマーク）とテキストをセットするように修正
        screeningHeaderBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg> ` + label;
    }
}

async function executeAiRequest(sysPrompt, userPrompt) { 
    if (!selectedAiModel) return "Error: Model not selected.";

    const isGPT = selectedAiModel.includes('gpt') || selectedAiModel.startsWith('o');

    if (isGPT) {
        if (!currentOpenaiApiKey) return "Error: OpenAI API Key is missing.";
        const url = "https://api.openai.com/v1/chat/completions";
        const messages = [];
        if (sysPrompt) messages.push({ role: "system", content: sysPrompt });
        messages.push({ role: "user", content: userPrompt });

        const payload = {
            model: selectedAiModel,
            messages: messages
        };

        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${currentOpenaiApiKey}` },
                body: JSON.stringify(payload)
            });
            if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
            const data = await res.json();
            return data.choices?.[0]?.message?.content || "Error.";
        } catch(e) {
            console.error(e);
            return "Error.";
        }
    } else {
        if (!currentGeminiApiKey) return "Error: Gemini API Key is missing.";
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${selectedAiModel}:generateContent?key=${currentGeminiApiKey}`; 
        const payload = { contents: [{ parts: [{ text: userPrompt }] }] };
        if (sysPrompt) {
            payload.systemInstruction = { parts: [{ text: sysPrompt }] };
        }
        try {
            const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); 
            if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
            const data = await res.json(); 
            return data.candidates?.[0]?.content?.parts?.[0]?.text || "Error."; 
        } catch(e) {
            console.error(e);
            return "Error.";
        }
    }
}

function updateConditionBadges() {
    const badgesDiv = document.getElementById('conditionBadges');
    if (!badgesDiv) return;

    badgesDiv.innerHTML = '';

    // 1. Adaptation model badge
    if (selectedAdaptationModel) {
        const adaptBadge = document.createElement('span');
        adaptBadge.className = 'bg-slate-200 text-slate-800 px-2 py-0.5 rounded border border-slate-300';
        adaptBadge.innerText = `Adapt: ${selectedAdaptationModel}`;
        badgesDiv.appendChild(adaptBadge);
    }

    // 1.5 Screening model badge
    if (selectedAiModel) {
        const modelBadge = document.createElement('span');
        modelBadge.className = 'bg-slate-200 text-slate-800 px-2 py-0.5 rounded border border-slate-300';
        modelBadge.innerText = `Screen: ${selectedAiModel}`;
        badgesDiv.appendChild(modelBadge);
    }

    // 2. Prompt mode badge
    let promptMode = badgesDiv.getAttribute('data-prompt-mode') || 'original criteria';
    const promptBadge = document.createElement('span');
    if (promptMode === 'AI-adapted') {
        promptBadge.className = 'bg-teal-100 text-teal-800 px-2 py-0.5 rounded border border-teal-200';
        promptBadge.innerText = 'AI-adapted';
    } else {
        promptBadge.className = 'bg-blue-100 text-blue-800 px-2 py-0.5 rounded border border-blue-200';
        promptBadge.innerText = 'original criteria';
    }
    badgesDiv.appendChild(promptBadge);

    // 3. Outcome badge
    const ignoreOutcome = document.getElementById('ignoreOutcomeCheck') ? document.getElementById('ignoreOutcomeCheck').checked : false;
    if (ignoreOutcome) {
        const outcomeBadge = document.createElement('span');
        outcomeBadge.className = 'bg-amber-100 text-amber-800 px-2 py-0.5 rounded border border-amber-200';
        outcomeBadge.innerText = 'outcomes';
        badgesDiv.appendChild(outcomeBadge);
    }

    // 4. Randomization badge
    const ignoreRct = document.getElementById('ignoreRctCheck') ? document.getElementById('ignoreRctCheck').checked : false;
    if (ignoreRct) {
        const rctBadge = document.createElement('span');
        rctBadge.className = 'bg-indigo-100 text-indigo-800 px-2 py-0.5 rounded border border-indigo-200';
        rctBadge.innerText = 'randomization';
        badgesDiv.appendChild(rctBadge);
    }

    // 5. Mixed/Multi-arm badge
    const ignoreMixed = document.getElementById('ignoreMixedCheck') ? document.getElementById('ignoreMixedCheck').checked : false;
    if (ignoreMixed) {
        const mixedBadge = document.createElement('span');
        mixedBadge.className = 'bg-blue-100 text-blue-800 px-2 py-0.5 rounded border border-blue-200';
        mixedBadge.innerText = 'mixed/multi-arm';
        badgesDiv.appendChild(mixedBadge);
    }

    // 6. Custom rules badge
    const addPromptArea = document.getElementById('additionalPromptArea');
    if (addPromptArea) {
        let customText = addPromptArea.value;
        if (typeof RULE_OUTCOME !== 'undefined') customText = customText.replace(RULE_OUTCOME, "");
        if (typeof RULE_RCT !== 'undefined') customText = customText.replace(RULE_RCT, "");
        if (typeof RULE_MIXED !== 'undefined') customText = customText.replace(RULE_MIXED, "");
        
        if (customText.trim().length > 0) {
            const customBadge = document.createElement('span');
            customBadge.className = 'bg-pink-100 text-pink-800 px-2 py-0.5 rounded border border-pink-200';
            customBadge.innerText = 'custom rules';
            badgesDiv.appendChild(customBadge);
        }
    }
}

function clearOptimizedCriteria() {
    const optArea = document.getElementById('optimizedPromptArea');
    if (optArea && !optArea.classList.contains('hidden')) {
        optArea.classList.add('hidden');
        document.getElementById('optimizedCriteria').value = '';
        
        const badgesDiv = document.getElementById('conditionBadges');
        if (badgesDiv) badgesDiv.setAttribute('data-prompt-mode', 'original criteria');
        
        updateConditionBadges();
    }
}

const RULE_OUTCOME = "[Rule for Outcome Specification]\nSince this is a primary screening based on titles and abstracts, do NOT exclude a study or assign a low score simply because the abstract lacks explicit outcome details. If the outcome is implied or broadly related, it may still qualify.";
const RULE_RCT = "[Rule for Methodological Ambiguity]\nDue to abstract word limits, authors often omit the word 'randomized' even for actual RCTs. If the inclusion criteria require an RCT, and the abstract is otherwise consistent with the target population/intervention, do not automatically exclude it based only on missing methodological wording.";
const RULE_MIXED = "[Rule for Mixed Populations and Multi-Arm Trials]\nIf a study mentions an intervention or population that falls under the exclusion criteria, you must NOT automatically assign a low score if the target population/intervention is still clearly present. Mixed or multi-arm studies may still be relevant unless the target criteria are clearly absent.";

function syncAdditionalPrompt() {
    const cbOutcome = document.getElementById('ignoreOutcomeCheck').checked;
    const cbRct = document.getElementById('ignoreRctCheck').checked;
    const cbMixed = document.getElementById('ignoreMixedCheck') ? document.getElementById('ignoreMixedCheck').checked : false;
    
    const textArea = document.getElementById('additionalPromptArea');
    
    if (!textArea) return;

    let currentText = textArea.value;

    if (cbOutcome && !currentText.includes("[Rule for Outcome Specification]")) {
        currentText = currentText ? currentText + "\n\n" + RULE_OUTCOME : RULE_OUTCOME;
    } else if (!cbOutcome && currentText.includes("[Rule for Outcome Specification]")) {
        currentText = currentText.replace(RULE_OUTCOME, "").trim();
    }

    if (cbRct && !currentText.includes("[Rule for Methodological Ambiguity]")) {
        currentText = currentText ? currentText + "\n\n" + RULE_RCT : RULE_RCT;
    } else if (!cbRct && currentText.includes("[Rule for Methodological Ambiguity]")) {
        currentText = currentText.replace(RULE_RCT, "").trim();
    }
    
    if (cbMixed && !currentText.includes("[Rule for Mixed Populations and Multi-Arm Trials]")) {
        currentText = currentText ? currentText + "\n\n" + RULE_MIXED : RULE_MIXED;
    } else if (!cbMixed && currentText.includes("[Rule for Mixed Populations and Multi-Arm Trials]")) {
        currentText = currentText.replace(RULE_MIXED, "").trim();
    }
    
    currentText = currentText.replace(/\n{3,}/g, '\n\n').trim();
    textArea.value = currentText;

    updateConditionBadges();
}

// ==========================================
// Prompt Copying & Display Modal Functions
// ==========================================

function showPromptModal(isOptimized) {
    const sysPrompt = `You are an expert medical researcher conducting a systematic review. This usage of the AI function is strictly for academic research purposes. Evaluate the provided list of medical articles carefully.

CRITICAL EVALUATION RULES:
1. Strict Text Adherence: Base your evaluation STRICTLY and EXCLUSIVELY on the provided title and abstract. Do not use prior knowledge to infer missing details.
2. Handling Missing Information: If the abstract lacks enough explicit information to confirm inclusion or exclusion, do NOT guess. Assign a score of 3.

Output only a valid JSON array of objects with "id" (string) and "score" (integer 1-5).
5=Definitely include, 4=Probably include, 3=Unsure/Needs full text, 2=Probably exclude, 1=Definitely exclude.
Do not output markdown formatting, \`\`\`json, or conversational text. Output raw JSON only.`;

    const additionalRulesText = document.getElementById('additionalPromptArea') ? document.getElementById('additionalPromptArea').value.trim() : "";
    const appendedPrompt = additionalRulesText ? `\n\nAdditional Rules:\n${additionalRulesText}` : "";

    let criteriaText = "";
    if (isOptimized) {
        const optText = document.getElementById('optimizedCriteria').value.trim();
        criteriaText = `Evaluation Criteria (Optimized Protocol):\n${optText || "None specified."}${appendedPrompt}`;
    } else {
        const incText = document.getElementById('inclusionCriteria').value.trim();
        const excText = document.getElementById('exclusionCriteria').value.trim();
        criteriaText = `Inclusion Criteria:\n${incText || "None specified."}\n\nExclusion Criteria:\n${excText || "None specified."}${appendedPrompt}`;
    }

    const fullPrompt = `${sysPrompt}\n\n-----------------------------------\n\n${criteriaText}\n\nPapers to evaluate:\n[Please paste the target paper title, abstract, or full text here. If a list of paper titles/abstracts is provided, keep each item clearly separated.]`;

    document.getElementById('fullPromptTextarea').value = fullPrompt;
    document.getElementById('fullPromptModal').style.display = 'block';
    
    const copyBtn = document.getElementById('btnCopyFullPrompt');
    if(copyBtn) copyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16h8a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 20H6a2 2 0 0 1-2-2V8"></path></svg>`;
}

function closeFullPromptModal() {
    document.getElementById('fullPromptModal').style.display = 'none';
}

function copyFullPromptText() {
    const textarea = document.getElementById('fullPromptTextarea');
    navigator.clipboard.writeText(textarea.value).then(() => {
        const btn = document.getElementById('btnCopyFullPrompt');
        if (btn) {
            btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 3"></path></svg>`;
            setTimeout(() => {
                btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16h8a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 20H6a2 2 0 0 1-2-2V8"></path></svg>`;
            }, 2000);
        }
    });
}

// ==========================================
// ROC Analysis Data Export
// ==========================================

function exportRocData() {
    let csvContent = "Reference_ID,AI_Score,Is_Target\n";
    let exportCount = 0;

    allReferences.forEach(ref => {
        if (ref.scoreNum === 0) return; // Exclude unscored items
        
        const refId = ref.refId.trim().replace(/"/g, '""'); 
        const isTarget = (ref.selection === 1) ? 1 : 0;
        csvContent += `"${refId}",${ref.scoreNum},${isTarget}\n`;
        exportCount++;
    });

    if (exportCount === 0) {
        showMessage("No scored references available for ROC export.");
        return;
    }

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = "roc_analysis_data.csv";
    a.click();
    
    updateStatus(`> Exported ${exportCount} articles for ROC analysis.`);
}

function copyReasonsToComment() {
    const logArea = document.getElementById('sensitivityLogArea');
    if (!logArea) return;
    const logText = logArea.value;
    if (!logText.trim()) {
        showMessage("SENSITIVITY ANALYSIS LOG is empty.");
        return;
    }

    const lines = logText.split('\n');
    let currentNo = null;
    let currentScore = null;
    let currentReason = [];
    const reasonsMap = new Map();

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match = line.match(/^No\.(\d+)\s+(\[Score\s+[12]\])/);
        if (match) {
            if (currentNo) reasonsMap.set(currentNo, { score: currentScore, reason: currentReason.join('<br>').trim() });
            currentNo = match[1];
            currentScore = match[2];
            currentReason = []; 
        } else if (currentNo) {
            if (line.trim() !== "" || currentReason.length > 0) currentReason.push(line);
        }
    }
    if (currentNo) {
        let finalReason = currentReason.join('<br>').replace(/(<br>)+$/, '').trim();
        reasonsMap.set(currentNo, { score: currentScore, reason: finalReason });
    }

    if (reasonsMap.size === 0) {
        showMessage("No Score 1 or 2 reasons found in the log.");
        return;
    }

    let copiedCount = 0;

    // Map the sequential number (No.) to the reference array index
    allReferences.forEach((ref, idx) => {
        const noText = (idx + 1).toString();
        
        if (reasonsMap.has(noText)) {
            const data = reasonsMap.get(noText);
            
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = ref.notes || "";
            const existingReasons = tempDiv.querySelectorAll('.ai-reason-log');
            existingReasons.forEach(el => el.remove());

            const reasonHtml = `<div class="ai-reason-log" contenteditable="false" style="color: #db2777; font-weight: bold; font-size: 0.9em; margin-bottom: 8px; display: block;">${data.score} ${data.reason}</div>`;
            ref.notes = reasonHtml + tempDiv.innerHTML;
            copiedCount++;
        }
    });

    markUnsaved();
    applyFilterAndRender(); // Refresh the screen
    showMessage(`Copied reasons to Comments for ${copiedCount} articles.`);
    updateStatus(`> Copied reasons to comments for ${copiedCount} items.`);
}

// ==========================================
// Project Memo Functions
// ==========================================

function openMemoModal() {
    const memoArea = document.getElementById('projectMemoArea');
    memoArea.dataset.originalText = memoArea.value;
    
    document.getElementById('memoModal').style.display = 'block';
}

function closeMemoModal() {
    document.getElementById('memoModal').style.display = 'none';
    updateMemoBtnUI();
}

function saveMemo() {
    const memoArea = document.getElementById('projectMemoArea');
    
    if (memoArea.value !== (memoArea.dataset.originalText || "")) {
        markUnsaved();
    }
    
    closeMemoModal();
    updateStatus("> Project memo updated.");
}

function updateMemoBtnUI() {
    const btn = document.getElementById('memoBtn');
    if (!btn) return;
    
    const memoArea = document.getElementById('projectMemoArea');
    const memoText = memoArea ? memoArea.value.trim() : '';
    
    if (memoText) {
        btn.className = "group relative px-4 py-1.5 text-xs font-bold text-amber-800 bg-amber-100 border border-amber-300 rounded-lg shadow-sm flex items-center gap-1 hover:bg-amber-200 transition-colors";
        
        const tooltipText = memoText.length > 300 ? memoText.substring(0, 300) + '...' : memoText;
        const safeText = tooltipText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');

        btn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h10"></path></svg>
            MEMO
            <div class="absolute top-full left-1/2 -translate-x-1/2 mt-2 hidden group-hover:block w-72 p-3 bg-black text-white text-xs font-normal rounded-lg shadow-xl z-50 text-left leading-relaxed break-words">
                ${safeText}
            </div>
        `;
        
        btn.removeAttribute('title');
    } else {
        btn.className = "px-4 py-1.5 text-xs font-bold text-slate-500 bg-slate-100 border border-slate-300 rounded-lg hover:bg-slate-200 transition-colors";
        btn.innerHTML = "MEMO";
        btn.removeAttribute('title');
    }
}

// ==========================================
// Adaptation Prompt Modal
// ==========================================

function openAdaptPromptModal() {
    document.getElementById('editAdaptSysPrompt').value = currentAdaptSysPrompt;
    document.getElementById('editAdaptUserPrompt').value = currentAdaptUserPrompt;
    
    document.getElementById('previewInclusion').innerText = document.getElementById('inclusionCriteria').value || "None";
    document.getElementById('previewExclusion').innerText = document.getElementById('exclusionCriteria').value || "None";
    
    document.getElementById('adaptPromptModal').style.display = 'flex';
    document.getElementById('adaptPromptModal').classList.remove('hidden');
}

function closeAdaptPromptModal() {
    document.getElementById('adaptPromptModal').style.display = 'none';
    document.getElementById('adaptPromptModal').classList.add('hidden');
}

function saveAdaptPrompt() {
    currentAdaptSysPrompt = document.getElementById('editAdaptSysPrompt').value;
    currentAdaptUserPrompt = document.getElementById('editAdaptUserPrompt').value;
    
    closeAdaptPromptModal();
    updateStatus("> Adaptation prompt updated for this session.");
}

function saveAdaptPromptAsDefault() {
    currentAdaptSysPrompt = document.getElementById('editAdaptSysPrompt').value;
    currentAdaptUserPrompt = document.getElementById('editAdaptUserPrompt').value;
    
    defaultAdaptSysPrompt = currentAdaptSysPrompt; 
    defaultAdaptUserPrompt = currentAdaptUserPrompt;
    
    localStorage.setItem('defaultAdaptSysPrompt_riput', defaultAdaptSysPrompt);
    localStorage.setItem('defaultAdaptUserPrompt_riput', defaultAdaptUserPrompt);
    
    closeAdaptPromptModal();
    showMessage("Saved as default adaptation prompt.");
    updateStatus("> Adaptation prompt saved as default.");
}

// ==========================================
// Session Import (Merge Scores & Settings)
// ==========================================
async function handleImportSession(files) {
    if (!files || files.length === 0) return;
    const file = files[0];
    
    updateStatus(`Importing Session from: ${file.name} ...`);
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 50)));

    const reader = new FileReader();
    reader.onload = (e) => {
        const text = new TextDecoder('utf-8').decode(e.target.result);
        if (text.includes('id="tableBody"') && text.includes('<!DOCTYPE html>')) {
            executeSessionImport(text, file.name);
        } else {
            showMessage("Invalid HTML file format. Cannot import session.");
            updateStatus(`Error: ${file.name} is not a valid saved HTML.`);
        }
        document.getElementById('importSessionInput').value = ""; 
    };
    reader.readAsArrayBuffer(file);
}

function executeSessionImport(htmlText, fileName) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, 'text/html');
    
    // Restore UI/settings
    const savedInclusion = doc.getElementById('inclusionCriteria');
    const savedExclusion = doc.getElementById('exclusionCriteria');
    if (savedInclusion) document.getElementById('inclusionCriteria').value = savedInclusion.value || savedInclusion.textContent;
    if (savedExclusion) document.getElementById('exclusionCriteria').value = savedExclusion.value || savedExclusion.textContent;
    const checkboxes = ['ignoreOutcomeCheck', 'ignoreRctCheck', 'ignoreMixedCheck', 'sensitivityCheck'];
    checkboxes.forEach(id => {
        const cb = doc.getElementById(id);
        const localCb = document.getElementById(id);
        if (cb && localCb) localCb.checked = cb.hasAttribute('checked');
    });
    const savedLogArea = doc.getElementById('sensitivityLogArea');
    if (savedLogArea) {
        const logText = savedLogArea.value || savedLogArea.textContent;
        document.getElementById('sensitivityLogArea').value = logText;
        if (logText.trim() !== '') document.getElementById('sensitivityLogContainer').classList.remove('hidden');
    }
    const savedOptimized = doc.getElementById('optimizedCriteria');
    if (savedOptimized) {
        const optText = savedOptimized.value || savedOptimized.textContent;
        if (optText.trim() !== '') {
            document.getElementById('optimizedCriteria').value = optText;
            document.getElementById('optimizedPromptArea').classList.remove('hidden');
        }
    }
    const savedAddPrompt = doc.getElementById('additionalPromptArea');
    if (savedAddPrompt) document.getElementById('additionalPromptArea').value = savedAddPrompt.textContent.trim();
    const savedMemo = doc.getElementById('projectMemoArea');
    if (savedMemo) {
        document.getElementById('projectMemoArea').value = savedMemo.value || savedMemo.textContent;
        updateMemoBtnUI();
    }
    
    const savedChunk = doc.getElementById('chunkSizeInput');
    if (savedChunk) {
        const val = savedChunk.value || savedChunk.getAttribute('value');
        if (val) document.getElementById('chunkSizeInput').value = val;
    }
    const savedWorkers = doc.getElementById('concurrencyInput');
    if (savedWorkers) {
        const val = savedWorkers.value || savedWorkers.getAttribute('value');
        if (val) document.getElementById('concurrencyInput').value = val;
    }
    
    const savedBadges = doc.getElementById('conditionBadges');
    if (savedBadges && savedBadges.hasAttribute('data-prompt-mode')) {
        document.getElementById('conditionBadges').setAttribute('data-prompt-mode', savedBadges.getAttribute('data-prompt-mode'));
    } else if (savedOptimized && (savedOptimized.value || savedOptimized.textContent).trim() !== '') {
        document.getElementById('conditionBadges').setAttribute('data-prompt-mode', 'AI-adapted');
    } else {
        document.getElementById('conditionBadges').setAttribute('data-prompt-mode', 'original criteria');
    }

    const injectedScript = doc.querySelector('.injected-settings-script');
    if (injectedScript) {
        document.querySelectorAll('.injected-settings-script').forEach(el => el.remove());
        const newScript = document.createElement('script');
        newScript.className = 'injected-settings-script';
        newScript.textContent = injectedScript.textContent;
        document.head.appendChild(newScript);
        
        setTimeout(() => {
            updateModelDisplay();
            updateApiKeyUI();
            updateLabelsBasedOnModel();
        }, 50);
    }
	
    syncAdditionalPrompt();
    updateConditionBadges();

    const importRows = Array.from(doc.querySelectorAll('#tableBody tr'));
    let mergedCount = 0;
    let addedCount = 0;

    importRows.forEach(dropRow => {
        let pmidB = "", doiB = "", titleB = "", abstractB = "";
        let refIdB = dropRow.cells[1].innerText.trim();
        let refIdLower = refIdB.toLowerCase();

        const absBtn = dropRow.cells[3].querySelector('button[data-abstract]');
        if (absBtn) {
            abstractB = absBtn.dataset.abstract;
            titleB = absBtn.dataset.title ? absBtn.dataset.title.replace(/<[^>]+>/g, '').replace(/[^\w\s]/g, '').trim().toLowerCase() : "";
        }

        let ur = "", label = "Link", registryUrl = "";
        dropRow.cells[3].querySelectorAll('button').forEach(btn => {
            const t = btn.innerText.trim();
            const onClick = btn.getAttribute('onclick') || "";
            const url = onClick.match(/'([^']+)'/)?.[1] || "";
            if (t === "PubMed") pmidB = url.replace(/\D/g, '');
            else if (t === "doi") doiB = url.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim().toLowerCase();
            else if (t === "Registry") registryUrl = url;
            else if (t !== "Abstract") { ur = url; label = t; }
        });

        if (!titleB) {
            const strongTagB = dropRow.cells[2].querySelector('strong');
            if (strongTagB) titleB = strongTagB.innerText.replace(/<[^>]+>/g, '').replace(/[^\w\s]/g, '').trim().toLowerCase();
            else titleB = dropRow.cells[2].innerText.replace(/[^\w\s]/g, '').trim().toLowerCase().substring(0, 50);
        }

        const dropCommentHTML = dropRow.querySelector('.comment-area') ? dropRow.querySelector('.comment-area').innerHTML : "";
        
        const dropScoreDiv = dropRow.cells[0].querySelector('.ai-score');
        let dropScoreHTML = dropScoreDiv ? dropScoreDiv.outerHTML : "";
        let dropScoreNum = (dropRow.cells[0].textContent.match(/●/g) || []).length;
        
        // Self-healing logic for past cases where score tags were accidentally lost
        if (!dropScoreDiv && dropScoreNum > 0) {
            const hasAbs = abstractB !== "" && abstractB !== "No abstract available.";
            const dotColor = hasAbs ? "#22c55e" : "#eab308";
            let dotsHTML = "";
            for(let j=0; j<dropScoreNum; j++) dotsHTML += `<span style="color: ${dotColor};">●</span>`;
            for(let j=dropScoreNum; j<5; j++) dotsHTML += '<span style="color: #cbd5e1;">○</span>';
            dropScoreHTML = `<div class="ai-score mt-1 text-xs tracking-tighter text-center whitespace-nowrap">${dotsHTML}</div>`;
        }

        const trans = dropRow.getAttribute('data-translation') || "";
        const geminiRes = dropRow.getAttribute('data-gemini-response') || "";
        const geminiRaw = dropRow.getAttribute('data-gemini-raw') || "";

        let selectionState = 0;
        if (dropRow.cells[1].classList.contains('bg-selected-cyan')) selectionState = 1;
        else if (dropRow.cells[1].classList.contains('bg-selected-gray')) selectionState = 2;

        // Find matching item in the array
        let matchedItem = allReferences.find(a => 
            (pmidB && a.pmid === pmidB) ||
            (doiB && a.doi === doiB) ||
            (titleB && a.title && titleB.substring(0, 30) === a.title.substring(0, 30)) ||
            (refIdLower && a.refId.toLowerCase() === refIdLower)
        );

        if (matchedItem) {
            if (dropScoreNum > 0 || dropScoreHTML) {
                matchedItem.aiScoreHtml = dropScoreHTML;
                matchedItem.scoreNum = dropScoreNum;
            }
            if (dropCommentHTML) matchedItem.notes = dropCommentHTML;
            matchedItem.selection = selectionState;
            
            if (trans) matchedItem.translation = decodeURIComponent(trans);
            if (geminiRes) matchedItem.geminiResponse = decodeURIComponent(geminiRes);
            if (geminiRaw) matchedItem.geminiRaw = decodeURIComponent(geminiRaw);

            mergedCount++;
        } else {
            let rawTitleForAdd = "";
            const titleMatch = dropRow.cells[2].innerHTML.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i);
            if (titleMatch) rawTitleForAdd = titleMatch[1].replace(/<[^>]+>/g, '').trim();

            const isAdded = addTableRow({
                refId: refIdB, bibInfo: dropRow.cells[2].innerHTML, notes: dropCommentHTML,
                idKey: Math.random().toString(36).substring(2, 15),
                pmid: pmidB, doi: doiB, ur: ur, label: label, registryUrl: registryUrl,
                title: rawTitleForAdd, abstract: abstractB,
                translation: decodeURIComponent(trans), geminiResponse: decodeURIComponent(geminiRes), geminiRaw: decodeURIComponent(geminiRaw),
                selection: selectionState, aiScoreHtml: dropScoreHTML,
                scoreNum: dropScoreNum
            });
            if (isAdded) addedCount++;
        }
    });

    markUnsaved();
    applyFilterAndRender(); // Refresh the screen
    showMessage(`Session Imported Successfully!\n\n- Settings & Prompts restored.\n- ${mergedCount} existing articles updated with scores/comments.\n- ${addedCount} new articles added to the list.`);
    updateStatus(`> Session Imported: Updated ${mergedCount}, Added ${addedCount} from ${fileName}`);
}

// ==========================================
// Initialization from Saved HTML (v2.1 Fix)
// ==========================================
function ingestExistingTable() {
    const tbody = document.getElementById('tableBody');
    const rows = Array.from(tbody.querySelectorAll('tr'));
    
    // If there is no table data on the page, this is a fresh startup; exit
    if (rows.length === 0) return; 
    
    // If data is already in the array, e.g., after importing HTML, exit
    if (allReferences.length > 0) return;

    let statusNode = document.getElementById('loadingStatusNode');
    if (!statusNode) {
        const div = document.getElementById('status');
        statusNode = document.createElement('p');
        statusNode.id = 'loadingStatusNode';
        statusNode.className = "text-blue-600 font-bold";
        div.prepend(statusNode);
    }
    statusNode.innerHTML = `> Initializing saved references to memory... Please wait.`;

    // Wait briefly to avoid UI freeze, then load everything into memory at once
    setTimeout(() => {
        rows.forEach(row => {
            const uuid = row.getAttribute('data-uuid') || generateUUID();
            
            let pmid = "", doi = "", title = "", abstract = "";
            let ur = "", label = "Link", registryUrl = "";

            const absBtn = row.cells[3].querySelector('button[data-abstract]');
            if (absBtn) { 
                abstract = absBtn.dataset.abstract; 
                title = absBtn.dataset.title; 
            }

            row.cells[3].querySelectorAll('button').forEach(btn => {
                const t = btn.innerText.trim();
                const onClick = btn.getAttribute('onclick') || "";
                const url = onClick.match(/'([^']+)'/)?.[1] || "";
                if (t === "PubMed") pmid = url.replace(/\D/g, '');
                else if (t === "doi") doi = url.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
                else if (t === "Registry") registryUrl = url;
                else if (t !== "Abstract") { ur = url; label = t; }
            });

            if (!title) {
                const titleMatch = row.cells[2].innerHTML.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i);
                if (titleMatch) title = titleMatch[1].replace(/<[^>]+>/g, '').trim();
            }

            const scoreDiv = row.cells[0].querySelector('.ai-score');
            let aiScoreHtml = scoreDiv ? scoreDiv.outerHTML : "";
            let scoreNum = (row.cells[0].textContent.match(/●/g) || []).length;
            
            // Self-healing logic for cases where tags were accidentally lost in earlier versions
            if (!scoreDiv && scoreNum > 0) {
                const hasAbs = abstract !== "" && abstract !== "No abstract available.";
                const dotColor = hasAbs ? "#22c55e" : "#eab308";
                let dotsHTML = "";
                for(let j=0; j<scoreNum; j++) dotsHTML += `<span style="color: ${dotColor};">●</span>`;
                for(let j=scoreNum; j<5; j++) dotsHTML += '<span style="color: #cbd5e1;">○</span>';
                aiScoreHtml = `<div class="ai-score mt-1 text-xs tracking-tighter text-center whitespace-nowrap">${dotsHTML}</div>`;
            }

            const trans = row.getAttribute('data-translation') ? decodeURIComponent(row.getAttribute('data-translation')) : "";
            const geminiRes = row.getAttribute('data-gemini-response') ? decodeURIComponent(row.getAttribute('data-gemini-response')) : "";
            const geminiRaw = row.getAttribute('data-gemini-raw') ? decodeURIComponent(row.getAttribute('data-gemini-raw')) : "";

            let selectionState = 0;
            if (row.cells[1].classList.contains('bg-selected-cyan')) selectionState = 1;
            else if (row.cells[1].classList.contains('bg-selected-gray')) selectionState = 2;

            const notesArea = row.querySelector('.comment-area');
            const notes = notesArea ? notesArea.innerHTML : "";

            allReferences.push({
                uuid: uuid,
                refId: row.cells[1].innerText.trim(),
                bibInfo: row.cells[2].innerHTML,
                notes: notes,
                idKey: Math.random().toString(36).substring(2, 15),
                pmid: pmid, doi: doi, ur: ur, label: label, registryUrl: registryUrl,
                title: title, abstract: abstract, translation: trans, geminiResponse: geminiRes, geminiRaw: geminiRaw,
                selection: selectionState, aiScoreHtml: aiScoreHtml, scoreNum: scoreNum
            });
            
            // Prepare deduplication tracking for subsequent imports
            if (pmid) loadedPMIDs.add(pmid);
            if (doi) loadedDOIs.add(doi);
        });

        // After loading into the array, clear the large DOM data and render the first page (100 items)
        currentPage = 1;
        applyFilterAndRender();
        
        statusNode.innerHTML = `> Initialization complete. ${rows.length} references loaded from saved file.`;
        statusNode.classList.replace('text-blue-600', 'text-teal-700');
    }, 50);
}