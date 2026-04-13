window.onerror = function(message, source, lineno, colno, error) {
    console.error(`[Global Error] ${message} at ${source}:${lineno}:${colno}`, error);
    return false;
};

console.log("[App] Script loaded");
const MODES = {
    segment: { display_name: 'S21 セグメントスイープ', data_field: 'S21_dB', ylabel: '|S21| [dB]', ylim: [-100, -20] },
    fullband: { display_name: 'S21 フルバンドスイープ', data_field: 'S21_dB', ylabel: '|S21| [dB]', ylim: [-100, -20] },
    permittivity: { display_name: '誘電率 (εr\')', data_field: 'epsilon_r', ylabel: '比誘電率 (εr\')', ylim: [3.5, 4.0] },
    dielectricloss: { display_name: '誘電損失 (εr\' × tanδ)', data_field: 'dielectric_loss', data_scale: 1e3, ylabel: '誘電損失 (εr\'\') [× 10⁻³]' },
    losstangent: { display_name: '誘電正接 (tanδ)', data_field: 'tan_delta', data_scale: 1e3, ylabel: '誘電正接 (tanδ) [× 10⁻³]', ylim: [4, 25] },
    conductivity: { display_name: '導電率', data_field: 'conductivity', ylabel: 'Conductivity / (1e7 S/m)' }
};

const state = {
    loadedData: [], // { filename, freq_GHz, values: { S21_dB, epsilon_r, ... } }
    processedStats: null,
    currentFilterStats: null
};

document.addEventListener('DOMContentLoaded', () => {
    console.log("[App] DOMContentLoaded fired");
    const modeSelect = document.getElementById('mode-select');
    Object.keys(MODES).forEach(key => {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = MODES[key].display_name;
        modeSelect.appendChild(option);
    });
    modeSelect.value = 'fullband';

    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');

    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', async (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        
        console.log("[Drop] Items detected:", e.dataTransfer.items ? e.dataTransfer.items.length : "none");
        const items = e.dataTransfer.items;
        if (items) {
            const files = [];
            const queue = [];
            for (let i = 0; i < items.length; i++) {
                const entry = items[i].webkitGetAsEntry();
                if (entry) {
                    console.log(`[Drop] Processing entry: ${entry.name} (${entry.isFile ? 'file' : 'directory'})`);
                    queue.push(traverseFileTree(entry, files));
                }
            }
            await Promise.all(queue);
            console.log(`[Drop] Total files found after traversal: ${files.length}`);
            handleFiles(files);
        } else {
            console.log("[Drop] Using fallback files list");
            handleFiles(e.dataTransfer.files);
        }
    });

    async function traverseFileTree(entry, fileList) {
        if (entry.isFile) {
            return new Promise((resolve) => {
                entry.file((file) => {
                    fileList.push(file);
                    resolve();
                });
            });
        } else if (entry.isDirectory) {
            const dirReader = entry.createReader();
            const readAllEntries = async () => {
                const entries = await new Promise((resolve) => {
                    dirReader.readEntries((results) => resolve(results));
                });
                if (entries.length > 0) {
                    const promises = entries.map(e => traverseFileTree(e, fileList));
                    await Promise.all(promises);
                    await readAllEntries(); // Read next batch
                }
            };
            return readAllEntries();
        }
    }
    fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

    document.getElementById('btn-clear-files').addEventListener('click', () => {
        state.loadedData = [];
        updateFileList();
    });

    document.querySelectorAll('input[name="plot-style"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            const avgOptions = document.getElementById('avg-options');
            if (e.target.value === 'average') {
                avgOptions.style.opacity = '1';
                avgOptions.style.pointerEvents = 'auto';
            } else {
                avgOptions.style.opacity = '0.5';
                avgOptions.style.pointerEvents = 'none';
            }
        });
    });

    document.getElementById('btn-plot').addEventListener('click', plotGraph);
    document.getElementById('btn-filter').addEventListener('click', openFilterModal);
    document.getElementById('btn-export').addEventListener('click', exportCSV);
    document.getElementById('btn-filter-cancel').addEventListener('click', () => {
        document.getElementById('filter-modal').classList.remove('active');
    });
    document.getElementById('btn-filter-apply').addEventListener('click', applyFilter);
});

function handleFiles(files) {
    console.log(`[File] Handling ${files.length} files`);
    const fileArray = Array.from(files);
    
    // Filter files to only include the core data types requested by the user
    const filteredFiles = fileArray.filter(f => {
        const name = f.name.toLowerCase();
        return name.includes('sij') || name.includes('ertan') || name.includes('cond');
    });

    console.log(`[File] Filtered to ${filteredFiles.length} core data files`);

    // Detect dominant type for smart mode selection based on user convention
    const counts = { sij: 0, ertan: 0, cond: 0 };
    filteredFiles.forEach(f => {
        const name = f.name.toLowerCase();
        if (name.includes('sij')) counts.sij++;
        else if (name.includes('ertan')) counts.ertan++;
        else if (name.includes('cond')) counts.cond++;
    });

    console.log("[File] Type counts:", counts);

    const dominant = Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b);
    if (counts[dominant] > 0) {
        const targetMode = dominant === 'sij' ? 'fullband' : (dominant === 'ertan' ? 'permittivity' : 'conductivity');
        document.getElementById('mode-select').value = targetMode;
        console.log(`[File] Auto-selected mode: ${targetMode} based on dominant type: ${dominant}`);
    }

    filteredFiles.forEach(file => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const text = e.target.result;
                const parsed = parseData(text, file.name);
                
                if (parsed.length > 0) {
                    state.loadedData.push({
                        filename: file.name,
                        rawData: parsed
                    });
                    updateFileList();
                } else {
                    console.warn(`[File] No valid data points parsed from ${file.name}. Check format.`);
                }
            } catch (err) {
                console.error(`[File] Error processing ${file.name}:`, err);
            }
        };
        reader.readAsText(file);
    });
}

function parseData(text, filename) {
    const lines = text.split('\n');
    const data = [];
    for (let line of lines) {
        line = line.trim();
        if (!line || /^[%\#/]/.test(line)) continue;
        
        // Split by whitespace or comma
        const parts = line.split(/[\s,]+/).filter(p => p.length > 0);
        
        // Convert to numbers, handling literal "NaN" and cleaning up potential unit strings
        const nums = parts.map(p => {
            if (p.toLowerCase() === 'nan') return NaN;
            // Keep only characters valid in a number
            const cleaned = p.replace(/[^0-9.\-+eE]/g, '');
            return cleaned ? Number(cleaned) : NaN;
        });

        // A valid data row should have at least 2 numbers and the first one must be a number
        // We check the first two columns specifically as they are essential for all modes
        if (nums.length >= 2 && !isNaN(nums[0]) && !isNaN(nums[1])) {
            // Keep the whole row including NaNs to preserve column indexing
            data.push(nums);
        }
    }

    if (data.length === 0 && text.trim().length > 0) {
        console.warn(`[Parse] Failed to find numeric data in ${filename}. First 100 chars: "${text.substring(0, 100).replace(/\n/g, '\\n')}"`);
    }
    return data;
}

function extractData(parsedData, modeKey) {
    const result = { freq_GHz: [], values: {} };
    if (modeKey === 'segment' || modeKey === 'fullband') {
        parsedData.forEach(row => {
            if (row.length >= 5) { // Changed from > 4 to >= 5 for safety
                result.freq_GHz.push(row[0] * 1e-9);
                const mag = Math.sqrt(row[3]*row[3] + row[4]*row[4]);
                result.values.S21_dB = result.values.S21_dB || [];
                result.values.S21_dB.push(20 * Math.log10(mag));
            }
        });
    } else if (modeKey === 'permittivity' || modeKey === 'dielectricloss' || modeKey === 'losstangent') {
        parsedData.forEach(row => {
            if (row.length >= 3) { // Relaxed from 4 to 3
                result.freq_GHz.push(row[0]);
                result.values.epsilon_r = result.values.epsilon_r || [];
                result.values.epsilon_r.push(row[1]);
                
                // If 4 columns, tan_delta is row[3]. If 3 columns, it's row[2].
                const tanDeltaIdx = row.length >= 4 ? 3 : 2;
                result.values.tan_delta = result.values.tan_delta || [];
                result.values.tan_delta.push(row[tanDeltaIdx]);
                
                result.values.dielectric_loss = result.values.dielectric_loss || [];
                result.values.dielectric_loss.push(row[1] * row[tanDeltaIdx]);
            }
        });
    } else if (modeKey === 'conductivity') {
        parsedData.forEach(row => {
            if (row.length >= 2) { // Changed from > 1 to >= 2
                result.freq_GHz.push(row[0]);
                result.values.conductivity = result.values.conductivity || [];
                result.values.conductivity.push(row[1]);
            }
        });
    }

    // Ensure data is sorted by frequency for interpolation
    const combined = result.freq_GHz.map((f, i) => {
        const vals = {};
        Object.keys(result.values).forEach(k => vals[k] = result.values[k][i]);
        return { f, vals };
    });
    combined.sort((a, b) => a.f - b.f);
    
    result.freq_GHz = combined.map(c => c.f);
    Object.keys(result.values).forEach(k => {
        result.values[k] = combined.map(c => c.vals[k]);
    });

    return result;
}

function updateFileList() {
    const listEl = document.getElementById('file-list');
    listEl.innerHTML = '';
    
    // Group files strictly by the core types
    const groups = {
        'Sパラメータ (sij)': [],
        '誘電率・誘電正接 (ertand)': [],
        '導電率 (cond)': []
    };

    state.loadedData.forEach((d) => {
        const name = d.filename.toLowerCase();
        if (name.includes('sij')) groups['Sパラメータ (sij)'].push(d);
        else if (name.includes('ertan')) groups['誘電率・誘電正接 (ertand)'].push(d);
        else if (name.includes('cond')) groups['導電率 (cond)'].push(d);
    });

    Object.keys(groups).forEach(groupName => {
        if (groups[groupName].length === 0) return;

        const groupHeader = document.createElement('li');
        groupHeader.style.fontWeight = 'bold';
        groupHeader.style.backgroundColor = 'rgba(0,0,0,0.1)';
        groupHeader.style.fontSize = '11px';
        groupHeader.style.padding = '6px 10px';
        groupHeader.style.color = '#333';
        groupHeader.textContent = groupName;
        listEl.appendChild(groupHeader);

        groups[groupName].forEach(data => {
            const li = document.createElement('li');
            li.textContent = data.filename;
            const removeBtn = document.createElement('span');
            removeBtn.textContent = '×';
            removeBtn.className = 'remove-file';
            removeBtn.onclick = (e) => {
                e.stopPropagation();
                const idx = state.loadedData.indexOf(data);
                if (idx !== -1) {
                    state.loadedData.splice(idx, 1);
                    updateFileList();
                }
            };
            li.appendChild(removeBtn);
            listEl.appendChild(li);
        });
    });
}

function interp1d(x, y, x_new) {
    const y_new = new Array(x_new.length).fill(NaN);
    for (let i = 0; i < x_new.length; i++) {
        const target = x_new[i];
        if (target < x[0] || target > x[x.length - 1]) continue;
        
        let low = 0, high = x.length - 1;
        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            if (x[mid] === target) {
                y_new[i] = y[mid];
                break;
            } else if (x[mid] < target) {
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        if (isNaN(y_new[i])) {
            const idx1 = high;
            const idx2 = low;
            if (idx1 >= 0 && idx2 < x.length) {
                const x0 = x[idx1], y0 = y[idx1];
                const x1 = x[idx2], y1 = y[idx2];
                if (x1 !== x0) {
                    y_new[i] = y0 + (y1 - y0) * ((target - x0) / (x1 - x0));
                } else {
                    y_new[i] = y0;
                }
            }
        }
    }
    return y_new;
}

function calcStats(dataList, fieldName, scale) {
    console.log(`[Stats] Calculating stats for ${dataList.length} files, field: ${fieldName}`);
    if (dataList.length === 0) return null;
    
    let allFreqs = [];
    dataList.forEach(d => allFreqs.push(...d.freq_GHz));
    let rawGrid = [...new Set(allFreqs)].sort((a, b) => a - b);
    console.log(`[Stats] Grid size: ${rawGrid.length} points`);
    
    const valsMatrix = [];
    dataList.forEach(d => {
        const x = d.freq_GHz;
        const y = d.values[fieldName].map(v => v * scale);
        
        const validX = [], validY = [];
        for(let i=0; i<y.length; i++) {
            if(!isNaN(y[i])) {
                validX.push(x[i]); validY.push(y[i]);
            }
        }
        
        if (validX.length >= 2) {
            valsMatrix.push(interp1d(validX, validY, rawGrid));
        } else if (validX.length === 1) {
            const col = new Array(rawGrid.length).fill(NaN);
            const idx = rawGrid.findIndex(f => Math.abs(f - validX[0]) < 1e-12);
            if (idx !== -1) col[idx] = validY[0];
            valsMatrix.push(col);
        }
    });
    
    if (valsMatrix.length === 0) {
        console.warn("[Stats] No valid data matrix created");
        return null;
    }
    
    const rawMean = [], rawStd = [];
    for (let i = 0; i < rawGrid.length; i++) {
        const rowVals = [];
        for (let j = 0; j < valsMatrix.length; j++) {
            if (!isNaN(valsMatrix[j][i])) rowVals.push(valsMatrix[j][i]);
        }
        if (rowVals.length > 0) {
            const mean = rowVals.reduce((a, b) => a + b, 0) / rowVals.length;
            rawMean[i] = mean;
            if (rowVals.length > 1) {
                const variance = rowVals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / rowVals.length;
                rawStd[i] = Math.sqrt(variance);
            } else {
                rawStd[i] = 0;
            }
        } else {
            rawMean[i] = NaN; rawStd[i] = NaN;
        }
    }
    
    const validGrid = [], validMean = [], validStd = [];
    for (let i = 0; i < rawGrid.length; i++) {
        if (!isNaN(rawMean[i])) {
            validGrid.push(rawGrid[i]); validMean.push(rawMean[i]); validStd.push(rawStd[i]);
        }
    }
    
    console.log(`[Stats] Valid points after processing: ${validGrid.length}`);
    if (validGrid.length > 1) {
        const span = validGrid[validGrid.length - 1] - validGrid[0];
        const diffs = [];
        for(let i=1; i<validGrid.length; i++) diffs.push(validGrid[i] - validGrid[i-1]);
        diffs.sort((a,b) => a-b);
        const medianDiff = diffs[Math.floor(diffs.length/2)];
        const threshold = Math.max(medianDiff * 2, span * 0.01);
        console.log(`[Stats] Clustering with threshold: ${threshold}`);
        return clusterFreqs(validGrid, validMean, validStd, threshold);
    }
    
    return { freq: validGrid, mean: validMean, std: validStd, threshold: 0 };
}

function clusterFreqs(freq, val, err, threshold) {
    if (freq.length === 0) return { freq, mean: val, std: err, threshold };
    const groups = [[0]];
    for (let i = 1; i < freq.length; i++) {
        if ((freq[i] - freq[i-1]) <= threshold) groups[groups.length - 1].push(i);
        else groups.push([i]);
    }
    
    const nFreq = [], nMean = [], nStd = [];
    groups.forEach(idxArr => {
        nFreq.push(idxArr.reduce((sum, i) => sum + freq[i], 0) / idxArr.length);
        const meanV = idxArr.reduce((sum, i) => sum + val[i], 0) / idxArr.length;
        nMean.push(meanV);
        if (idxArr.length > 1) {
            const errMeanSq = idxArr.reduce((sum, i) => sum + Math.pow(err[i], 2), 0) / idxArr.length;
            const valVariance = idxArr.reduce((sum, i) => sum + Math.pow(val[i] - meanV, 2), 0) / idxArr.length;
            nStd.push(Math.sqrt(errMeanSq + valVariance));
        } else {
            nStd.push(err[idxArr[0]]);
        }
    });
    console.log(`[Stats] Clustered into ${nFreq.length} groups`);
    return { freq: nFreq, mean: nMean, std: nStd, threshold };
}

function downsample(x, y, z, maxPts) {
    if (x.length <= maxPts) return { x, y, z };
    const idx = [];
    for (let i = 0; i < maxPts; i++) idx.push(Math.floor(i * (x.length - 1) / (maxPts - 1)));
    return {
        x: idx.map(i => x[i]),
        y: idx.map(i => y[i]),
        z: z ? idx.map(i => z[i]) : null
    };
}

function insertNaNsAtGaps(x, y) {
    if (x.length < 2) return { x, y };
    const diffs = [];
    for(let i=1; i<x.length; i++) diffs.push(x[i] - x[i-1]);
    const sortedDiffs = [...diffs].sort((a,b) => a-b);
    const medianDiff = sortedDiffs[Math.floor(sortedDiffs.length/2)];
    const threshold = (medianDiff === 0 ? 1 : medianDiff) * 20;
    
    const newX = [], newY = [];
    newX.push(x[0]); newY.push(y[0]);
    for(let i=1; i<x.length; i++) {
        if (x[i] - x[i-1] > threshold) {
            newX.push(x[i-1] + 1e-9);
            newY.push(NaN);
        }
        newX.push(x[i]);
        newY.push(y[i]);
    }
    return { x: newX, y: newY };
}

function detectBands(freq) {
    // Use unique frequencies to avoid 0 diffs from multiple identical files
    const uniqueFreqs = Array.from(new Set(freq)).sort((a, b) => a - b);
    if (uniqueFreqs.length < 2) return [[uniqueFreqs[0], uniqueFreqs[uniqueFreqs.length - 1]]];
    
    const diffs = [];
    for (let i = 1; i < uniqueFreqs.length; i++) {
        const d = uniqueFreqs[i] - uniqueFreqs[i - 1];
        if (d > 0) diffs.push(d);
    }
    
    if (diffs.length === 0) return [[uniqueFreqs[0], uniqueFreqs[uniqueFreqs.length - 1]]];
    
    const sortedDiffs = [...diffs].sort((a, b) => a - b);
    const medianDiff = sortedDiffs[Math.floor(sortedDiffs.length / 2)];
    
    // A gap is usually much larger than the normal step. 
    // Use a smaller multiplier (5x) and ensure threshold is reasonable.
    const threshold = Math.max(medianDiff * 5, 0.1); 

    console.log(`[Stats] Band detection: unique points=${uniqueFreqs.length}, median step=${medianDiff.toFixed(6)}, threshold=${threshold.toFixed(6)}`);

    const bands = [];
    let startIdx = 0;
    for (let i = 1; i < uniqueFreqs.length; i++) {
        if (uniqueFreqs[i] - uniqueFreqs[i - 1] > threshold) {
            bands.push([uniqueFreqs[startIdx], uniqueFreqs[i - 1]]);
            startIdx = i;
        }
    }
    bands.push([uniqueFreqs[startIdx], uniqueFreqs[uniqueFreqs.length - 1]]);
    return bands;
}

function plotGraph() {
    console.log("[Plot] Starting plot process...");
    if (state.loadedData.length === 0) {
        console.warn("[Plot] No data loaded");
        return alert("データファイルが読み込まれていません。");
    }

    const modeKey = document.getElementById('mode-select').value;
    const modeCfg = MODES[modeKey];
    const plotStyle = document.querySelector('input[name="plot-style"]:checked').value;
    const dataField = modeCfg.data_field;
    const scale = modeCfg.data_scale || 1.0;

    console.log(`[Plot] Mode: ${modeKey}, Style: ${plotStyle}, Field: ${dataField}, Scale: ${scale}`);

    // Filter data based on mode to ensure only relevant files are processed
    let filteredStateData = state.loadedData;
    if (modeKey === 'segment' || modeKey === 'fullband') {
        filteredStateData = state.loadedData.filter(d => d.filename.toLowerCase().includes('sij'));
    } else if (modeKey === 'permittivity' || modeKey === 'dielectricloss' || modeKey === 'losstangent') {
        filteredStateData = state.loadedData.filter(d => d.filename.toLowerCase().includes('ertan'));
    } else if (modeKey === 'conductivity') {
        filteredStateData = state.loadedData.filter(d => d.filename.toLowerCase().includes('cond'));
    }

    // Extract data for current mode from filtered data
    const currentData = filteredStateData.map(d => {
        const extracted = extractData(d.rawData, modeKey);
        extracted.filename = d.filename;
        return extracted;
    }).filter(d => d.freq_GHz.length > 0);

    if (currentData.length === 0) {
        console.error("[Plot] No valid data extracted for current mode");
        return alert("現在のモードで表示可能なデータがありません。");
    }

    const plotData = [];
    let layout = {
        title: modeCfg.display_name,
        hovermode: 'closest',
        margin: { l: 60, r: 30, t: 50, b: 50 },
        showlegend: true
    };

    try {
        if (modeKey === 'segment') {
            // Detect bands from all loaded data
            let allFreqs = [];
            currentData.forEach(d => allFreqs.push(...d.freq_GHz));
            allFreqs.sort((a, b) => a - b);
            const bands = detectBands(allFreqs);
            console.log(`[Plot] Detected ${bands.length} bands for segment sweep`);

            const numBands = bands.length;
            const gap = 0.02; // Gap between subplots
            const bandWidth = (1 - (numBands - 1) * gap) / numBands;

            // Configure single Y-axis
            layout.yaxis = {
                title: modeCfg.ylabel,
                range: modeCfg.ylim || [-100, -20],
                gridcolor: '#eee',
                zerolinecolor: '#ccc'
            };

            bands.forEach((band, bIdx) => {
                const xAxisKey = bIdx === 0 ? 'xaxis' : `xaxis${bIdx + 1}`;
                const domainStart = bIdx * (bandWidth + gap);

                layout[xAxisKey] = {
                    title: bIdx === Math.floor(numBands / 2) ? 'Frequency [GHz]' : '',
                    domain: [domainStart, domainStart + bandWidth],
                    range: band,
                    anchor: 'y',
                    showticklabels: true,
                    gridcolor: '#eee',
                    zerolinecolor: '#ccc'
                };

                if (plotStyle === 'average') {
                    const stats = calcStats(currentData, dataField, scale);
                    if (stats) {
                        const mask = stats.freq.map(f => f >= band[0] && f <= band[1]);
                        const fBand = stats.freq.filter((_, i) => mask[i]);
                        const mBand = stats.mean.filter((_, i) => mask[i]);
                        const eBand = stats.std.filter((_, i) => mask[i]);

                        if (fBand.length > 0) {
                            const ds = downsample(fBand, mBand, eBand, 1000);
                            plotData.push({
                                x: ds.x, y: ds.y, error_y: { type: 'data', array: ds.z, visible: true },
                                mode: 'markers', name: `Avg (Band ${bIdx + 1})`, marker: { size: 6 },
                                xaxis: bIdx === 0 ? 'x' : `x${bIdx + 1}`,
                                yaxis: 'y',
                                showlegend: bIdx === 0
                            });
                        }
                    }
                } else {
                    currentData.forEach((d, dIdx) => {
                        const mask = d.freq_GHz.map(f => f >= band[0] && f <= band[1]);
                        const fBand = d.freq_GHz.filter((_, i) => mask[i]);
                        const vBand = d.values[dataField].filter((_, i) => mask[i]).map(v => v * scale);

                        if (fBand.length > 0) {
                            const ds = downsample(fBand, vBand, null, 1000);
                            plotData.push({
                                x: ds.x, y: ds.y, mode: 'lines+markers', name: d.filename,
                                marker: { size: 4 }, line: { width: 1.5 },
                                xaxis: bIdx === 0 ? 'x' : `x${bIdx + 1}`,
                                yaxis: 'y',
                                showlegend: bIdx === 0,
                                legendgroup: d.filename // Group same files across bands
                            });
                        }
                    });
                }
            });
        } else {
            // Standard single plot (Fullband, Permittivity, etc.)
            layout.xaxis = { title: 'Frequency [GHz]', autorange: true };
            layout.yaxis = { title: modeCfg.ylabel, autorange: true };
            if (modeCfg.ylim) layout.yaxis.range = modeCfg.ylim;
            else if (modeKey === 'fullband') layout.yaxis.range = [-100, -20];

            if (plotStyle === 'average') {
                const stats = calcStats(currentData, dataField, scale);
                if (!stats) return alert("有効なデータがありません。");
                state.processedStats = { stats, modeKey, dataField, scale };
                const ds = downsample(stats.freq, stats.mean, stats.std, 2000);
                plotData.push({
                    x: ds.x, y: ds.y, error_y: { type: 'data', array: ds.z, visible: true },
                    mode: 'markers', name: document.getElementById('group-name').value || 'Average',
                    marker: { size: 6 }
                });
            } else {
                currentData.forEach((d, idx) => {
                    let x = d.freq_GHz;
                    let y = d.values[dataField].map(v => v * scale);
                    const ds = downsample(x, y, null, 2000);
                    plotData.push({
                        x: ds.x, y: ds.y, mode: 'lines+markers', name: d.filename,
                        marker: { size: 4 }, line: { width: 1.5 }
                    });
                });
            }
        }
        
        const container = document.getElementById('plot-container');
        console.log(`[Plot] Container dimensions: ${container.clientWidth}x${container.clientHeight}`);
        console.log(`[Plot] Plotly version: ${window.Plotly ? Plotly.version : 'Not found'}`);
        
        if (container.clientWidth === 0 || container.clientHeight === 0) {
            console.warn("[Plot] Container has zero dimensions, Plotly might not render correctly.");
        }

        console.log("[Plot] Calling Plotly.react...");
        // Use react instead of newPlot for better performance and stability on updates
        Plotly.react(container, plotData, layout, { 
            responsive: true,
            displaylogo: false,
            modeBarButtonsToRemove: ['sendDataToCloud']
        })
            .then(() => {
                console.log("[Plot] Plotly rendering complete");
                console.log(`[Plot] Container innerHTML length: ${container.innerHTML.length}`);
                // Force a resize calculation just in case
                Plotly.Plots.resize(container);
            })
            .catch(err => console.error("[Plot] Plotly error:", err));
            
    } catch (err) {
        console.error("[Plot] Unexpected error during plotting:", err);
        alert("描画中にエラーが発生しました。詳細はコンソールを確認してください。");
    }
}

function openFilterModal() {
    if (state.loadedData.length === 0) return alert("データがありません");
    const modeKey = document.getElementById('mode-select').value;
    const modeCfg = MODES[modeKey];
    const stats = calcStats(state.loadedData, modeCfg.data_field, modeCfg.data_scale || 1.0);
    if (!stats || stats.freq.length === 0) return alert("有効な周波数データがありません");
    
    state.currentFilterStats = stats;
    
    const listEl = document.getElementById('filter-list');
    listEl.innerHTML = '';
    stats.freq.forEach((f, i) => {
        const li = document.createElement('li');
        li.innerHTML = `<input type="checkbox" value="${i}" id="filter-${i}">
                        <label for="filter-${i}">${f.toFixed(4)} GHz (Avg: ${stats.mean[i].toFixed(2)})</label>`;
        listEl.appendChild(li);
    });
    
    document.getElementById('filter-modal').classList.add('active');
}

function applyFilter() {
    const checkboxes = document.querySelectorAll('#filter-list input:checked');
    const indices = Array.from(checkboxes).map(cb => parseInt(cb.value));
    if (indices.length === 0) {
        document.getElementById('filter-modal').classList.remove('active');
        return;
    }
    
    const stats = state.currentFilterStats;
    const targetFreqs = indices.map(i => stats.freq[i]);
    const threshold = stats.threshold * 1.5;
    
    let cleanedCount = 0;
    state.loadedData.forEach(d => {
        const before = d.rawData.length;
        d.rawData = d.rawData.filter(row => {
            const f = row[0];
            return !targetFreqs.some(tf => Math.abs(f - tf) < threshold);
        });
        cleanedCount += (before - d.rawData.length);
    });
    
    alert(`${targetFreqs.length} 個のクラスタ (計 ${cleanedCount} データ点) を削除しました。`);
    document.getElementById('filter-modal').classList.remove('active');
    plotGraph();
}

function exportCSV() {
    if (!state.processedStats) return alert("エクスポート可能な平均データがありません。先に平均モードでグラフを描画してください。");
    
    const { stats, modeKey, dataField, scale } = state.processedStats;
    const groupName = document.getElementById('group-name').value || '';
    
    let csvContent = `Frequency_GHz,Mean_${dataField},Std_${dataField},Mode,GroupName,ScaleMultiplier\n`;
    for(let i=0; i<stats.freq.length; i++) {
        csvContent += `${stats.freq[i]},${stats.mean[i]},${stats.std[i]},${modeKey},${groupName},${scale}\n`;
    }
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    link.setAttribute('href', url);
    link.setAttribute('download', `${modeKey}_${dataField}_avg_${ts}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}
