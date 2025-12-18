// js/renderer.js

const { ipcRenderer } = require('electron');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

// --- Global State ---
let inputStream = null;
let inputDeviceId = null;
let isRunning = false;

// Direct Audio Link State
let directServer = null;
let directSocket = null;
let currentSampleRate = 44100;
let isHeaderReceived = false;
let headerBuffer = Buffer.alloc(0);

// Routing State
let hardwareRouting = new Set();
let directRouting = new Set();

// Outputs array (stores strip objects)
let outputs = [];
let outputIdCounter = 1;

// Analyser Nodes for Meters
let hardwareAnalyser = null;
let directAnalyser = null;

// --- UI Elements ---
const inputDeviceSelect = document.getElementById('inputDeviceSelect');
const startBtn = document.getElementById('startBtn');
const addStripBtn = document.getElementById('addStripBtn');
const outputStripsContainer = document.getElementById('outputStripsContainer');
const uxMusicStatusDot = document.getElementById('uxMusicStatusDot');
const uxMusicStatusText = document.getElementById('uxMusicStatusText');

const hardwareRouteContainer = document.getElementById('hardwareRouteContainer');
const directRouteContainer = document.getElementById('directRouteContainer');

const inputGainFader = document.getElementById('inputGainFader');
const inputDbDisplay = document.getElementById('inputDbDisplay');
const hardwareMeterFill = document.getElementById('hardwareMeter');
let hardwareInputGainValue = 1.0;

const directGainFader = document.getElementById('directGainFader');
const directDbDisplay = document.getElementById('directDbDisplay');
const directMuteBtn = document.getElementById('directMuteBtn');
const directMeterFill = document.getElementById('directMeter');
let directInputGainValue = 1.0;
let directInputMuted = false;

// --- Persistence ---
function saveSettings() {
    const settings = {
        inputDeviceId: inputDeviceSelect.value,
        hardwareGain: hardwareInputGainValue,
        directGain: directInputGainValue,
        directMuted: directInputMuted,
        hardwareRouting: Array.from(hardwareRouting),
        directRouting: Array.from(directRouting),
        outputs: outputs.map(out => ({
            id: out.id,
            selectedDeviceId: out.selectedDeviceId,
            volume: out.volume,
            isMuted: out.isMuted,
            eq: out.eqValues
        }))
    };
    localStorage.setItem('uxAudioRouterSettings', JSON.stringify(settings));
}

function loadSettings() {
    try { return JSON.parse(localStorage.getItem('uxAudioRouterSettings')); } catch (e) { return null; }
}

// --- IPC Handlers ---
ipcRenderer.on('toggle-global-mute', () => {
    const anyActive = outputs.some(o => !o.isMuted);
    const newState = anyActive; // If any active, mute all
    outputs.forEach(out => { out.isMuted = newState; });
    outputs.forEach(out => {
        const btn = out.div.querySelector('.btn-mute');
        btn.classList.toggle('active', out.isMuted);
        btn.textContent = out.isMuted ? "MUTED" : "Mute";
    });
    updateCalculatedGains();
    saveSettings();
    ipcRenderer.send('mute-status-changed', newState);
});

function checkGlobalMuteStatus() {
    const allMuted = outputs.length > 0 && outputs.every(o => o.isMuted);
    ipcRenderer.send('mute-status-changed', allMuted);
}

// --- Initialisation ---
async function init() {
    await refreshDevices();
    const settings = loadSettings();

    if (settings) {
        if (settings.inputDeviceId) {
            const exists = [...inputDeviceSelect.options].some(o => o.value === settings.inputDeviceId);
            if (exists) inputDeviceSelect.value = settings.inputDeviceId;
        }
        if (settings.hardwareGain !== undefined) {
            hardwareInputGainValue = settings.hardwareGain;
            inputGainFader.value = hardwareInputGainValue;
            updateDbDisplay(inputDbDisplay, hardwareInputGainValue);
        }
        if (settings.directGain !== undefined) {
            directInputGainValue = settings.directGain;
            directGainFader.value = directInputGainValue;
            updateDbDisplay(directDbDisplay, directInputGainValue);
        }
        if (settings.directMuted !== undefined) {
            directInputMuted = settings.directMuted;
            updateDirectMuteUI();
        }
        if (settings.hardwareRouting) hardwareRouting = new Set(settings.hardwareRouting);
        if (settings.directRouting) directRouting = new Set(settings.directRouting);

        if (settings.outputs && settings.outputs.length > 0) {
            let maxId = 0;
            settings.outputs.forEach(savedData => {
                addOutputStrip(savedData);
                if (savedData.id > maxId) maxId = savedData.id;
            });
            outputIdCounter = maxId + 1;
        } else { addOutputStrip(); }
    } else { addOutputStrip(); }
    
    updateRoutingUI();
    checkGlobalMuteStatus();
    startDirectAudioServer();
    
    // Auto start
    console.log("Auto-starting audio engine...");
    startEngine();
    
    // Start Meter Loop
    requestAnimationFrame(updateMetersLoop);
}

// --- Meter Logic ---
function updateMetersLoop() {
    if (isRunning) {
        // Hardware Meter
        if (hardwareAnalyser) updateSingleMeter(hardwareAnalyser, hardwareMeterFill);
        
        // Direct Meter
        if (directAnalyser) updateSingleMeter(directAnalyser, directMeterFill);
        
        // Output Meters
        outputs.forEach(out => {
            if (out.analyser && out.meterFill) {
                updateSingleMeter(out.analyser, out.meterFill);
            }
        });
    } else {
        // Reset meters if stopped
        hardwareMeterFill.style.height = '0%';
        directMeterFill.style.height = '0%';
        outputs.forEach(out => { if(out.meterFill) out.meterFill.style.height = '0%'; });
    }
    requestAnimationFrame(updateMetersLoop);
}

function updateSingleMeter(analyser, element) {
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteTimeDomainData(dataArray);

    let sum = 0;
    for (let i = 0; i < bufferLength; i++) {
        const value = (dataArray[i] - 128) / 128.0;
        sum += value * value;
    }
    const rms = Math.sqrt(sum / bufferLength);
    
    // RMS to Decibels
    const db = 20 * Math.log10(rms);
    
    // Map -60dB to 0dB to 0% - 100%
    // Range: -60 ~ 0
    let percent = (db + 60) / 60 * 100;
    
    if (percent < 0) percent = 0;
    if (percent > 100) percent = 100;
    
    element.style.height = `${percent}%`;
}

// --- Routing Logic ---
function updateRoutingUI() {
    renderRoutingButtons(hardwareRouteContainer, hardwareRouting, 'hardware');
    renderRoutingButtons(directRouteContainer, directRouting, 'direct');
}

function renderRoutingButtons(container, routingSet, type) {
    container.innerHTML = '';
    outputs.forEach(out => {
        const btn = document.createElement('div');
        const busName = "A" + out.id;
        btn.className = `route-btn ${routingSet.has(out.id) ? 'active' : ''}`;
        btn.textContent = busName;
        btn.onclick = () => {
            if (routingSet.has(out.id)) {
                routingSet.delete(out.id);
                btn.classList.remove('active');
            } else {
                routingSet.add(out.id);
                btn.classList.add('active');
            }
            updateCalculatedGains();
            saveSettings();
        };
        container.appendChild(btn);
    });
}

function updateCalculatedGains() {
    outputs.forEach(out => {
        if (!out.context) return;
        
        const hwTarget = hardwareRouting.has(out.id) ? hardwareInputGainValue : 0;
        if (out.hardwareGainNode) {
            out.hardwareGainNode.gain.setTargetAtTime(hwTarget, out.context.currentTime, 0.02);
        }
        
        const dirRouteMult = directRouting.has(out.id) ? 1 : 0;
        const dirMuteMult = directInputMuted ? 0 : 1;
        const dirTarget = directInputGainValue * dirRouteMult * dirMuteMult;
        if (out.directGainNode) {
            out.directGainNode.gain.setTargetAtTime(dirTarget, out.context.currentTime, 0.02);
        }
    });
}

// --- Direct Audio Server ---
function startDirectAudioServer() {
    const isWin = process.platform === 'win32';
    const SOCKET_PATH = isWin ? '\\\\.\\pipe\\ux_audio_router_pipe' : '/tmp/ux_audio_router.sock';
    if (!isWin && fs.existsSync(SOCKET_PATH)) { try { fs.unlinkSync(SOCKET_PATH); } catch(e) {} }

    directServer = net.createServer((socket) => {
        console.log('UX Music Connected');
        updateStatusUI(false);
        directSocket = socket;
        isHeaderReceived = false;
        headerBuffer = Buffer.alloc(0);
        outputs.forEach(out => { out.nextAudioTime = 0; });

        socket.on('data', (buffer) => {
            if (!isRunning) return;
            if (!isHeaderReceived) {
                headerBuffer = Buffer.concat([headerBuffer, buffer]);
                if (headerBuffer.length >= 8) {
                    const magic = headerBuffer.slice(0, 4).toString();
                    if (magic === 'UXD1') {
                        currentSampleRate = headerBuffer.readUInt32LE(4);
                        console.log(`Rate: ${currentSampleRate}Hz`);
                        isHeaderReceived = true;
                        updateStatusUI(true, currentSampleRate);
                        const remaining = headerBuffer.slice(8);
                        if (remaining.length > 0) processAudioPacket(remaining);
                    } else { socket.destroy(); }
                    headerBuffer = Buffer.alloc(0);
                }
                return;
            }
            processAudioPacket(buffer);
        });

        socket.on('end', () => { updateStatusUI(false); directSocket = null; });
        socket.on('error', (err) => { updateStatusUI(false); });
    });

    directServer.listen(SOCKET_PATH, () => { console.log(`Listening on ${SOCKET_PATH}`); });
}

function updateStatusUI(isConnected, rate) {
    if (isConnected) {
        uxMusicStatusDot.classList.add('connected');
        uxMusicStatusText.textContent = `UX Music: Connected (${rate}Hz)`;
        uxMusicStatusText.style.color = "var(--accent-blue)";
    } else {
        uxMusicStatusDot.classList.remove('connected');
        uxMusicStatusText.textContent = "UX Music: Disconnected";
        uxMusicStatusText.style.color = "#555";
    }
}

function processAudioPacket(buffer) {
    if (buffer.length % 8 !== 0) {
        const alignedLen = Math.floor(buffer.length / 8) * 8;
        buffer = buffer.slice(0, alignedLen);
    }
    if (buffer.length === 0) return;
    const floatArray = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
    const frameCount = floatArray.length / 2;
    outputs.forEach(out => {
        if (out.context && out.directGainNode) {
            playBufferOnContext(out, floatArray, frameCount);
        }
    });
}

function playBufferOnContext(out, floatArray, frameCount) {
    const ctx = out.context;
    const audioBuffer = ctx.createBuffer(2, frameCount, currentSampleRate);
    const ch0 = audioBuffer.getChannelData(0);
    const ch1 = audioBuffer.getChannelData(1);
    for (let i = 0; i < frameCount; i++) {
        ch0[i] = floatArray[i * 2];
        ch1[i] = floatArray[i * 2 + 1];
    }
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(out.directGainNode);
    
    const currentTime = ctx.currentTime;
    const BUFFER_SAFE_MARGIN = 0.12; 
    
    if (out.nextAudioTime < currentTime) { out.nextAudioTime = currentTime + BUFFER_SAFE_MARGIN; }
    if (out.nextAudioTime > currentTime + 0.2) { out.nextAudioTime = currentTime + BUFFER_SAFE_MARGIN; }

    source.start(out.nextAudioTime);
    out.nextAudioTime += audioBuffer.duration;
}

// --- Audio Engine ---
async function refreshDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter(d => d.kind === 'audioinput');
    const outputDevices = devices.filter(d => d.kind === 'audiooutput');

    const currentInput = inputDeviceSelect.value;
    inputDeviceSelect.innerHTML = '';
    inputs.forEach(device => {
        const opt = document.createElement('option');
        opt.value = device.deviceId;
        opt.text = cleanLabel(device.label) || `Input ${device.deviceId.slice(0,4)}`;
        if (device.label.includes('BlackHole')) opt.selected = true;
        inputDeviceSelect.appendChild(opt);
    });
    if(currentInput && inputs.some(d => d.deviceId === currentInput)) inputDeviceSelect.value = currentInput;

    window.availableOutputDevices = outputDevices;
    outputs.forEach(out => updateOutputStripDropdown(out, outputDevices));
}

function cleanLabel(label) {
    return label.replace(/Default - /, '').replace(/ \([0-9a-f]{4}:[0-9a-f]{4}\)/, '');
}

async function startEngine() {
    if (isRunning) return;
    outputs.forEach(out => { out.nextAudioTime = 0; });

    try {
        inputDeviceId = inputDeviceSelect.value;
        inputStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                deviceId: { exact: inputDeviceId },
                autoGainControl: false, echoCancellation: false, noiseSuppression: false,
                channelCount: 2, sampleRate: 48000
            }
        });

        // Initialize Hardware Analyser for visualization
        // We need a dummy context to analyze hardware input independent of outputs?
        // Actually, we can attach analyser to the first output context, or better:
        // Create analysers inside connectOutputEngine (visualizing POST-routing).
        // For Input meters, it's best to visualize PRE-routing.
        // However, `inputStream` is raw.
        // We will capture it in the first available context.
        
        // For simplicity in this architecture where inputs are streams:
        // We will assign analysers when outputs are connected.

        for (const out of outputs) await connectOutputEngine(out);

        isRunning = true;
        startBtn.textContent = "ACTIVE";
        startBtn.style.backgroundColor = "var(--accent-orange)";
        inputDeviceSelect.disabled = true;
        updateCalculatedGains();

    } catch (err) {
        console.error(err);
    }
}

function stopEngine() {
    if (!isRunning) return;
    outputs.forEach(out => {
        if (out.context) { out.context.close(); out.context = null; }
        out.sourceNode = null; out.hardwareGainNode = null; out.directGainNode = null;
        out.analyser = null;
    });
    // Reset global analysers
    hardwareAnalyser = null;
    directAnalyser = null;
    
    if (inputStream) { inputStream.getTracks().forEach(t => t.stop()); inputStream = null; }
    isRunning = false;
    startBtn.textContent = "ON";
    startBtn.style.backgroundColor = "var(--accent-green)";
    inputDeviceSelect.disabled = false;
}

async function connectOutputEngine(outputObj) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)({
        latencyHint: 'interactive', sampleRate: 48000
    });

    if (outputObj.selectedDeviceId && typeof ctx.setSinkId === 'function') {
        try { await ctx.setSinkId(outputObj.selectedDeviceId); } catch (e) {}
    }

    // --- HARDWARE INPUT CHAIN ---
    let hardwareGain = null;
    if (inputStream) {
        const source = ctx.createMediaStreamSource(inputStream);
        
        // Setup Hardware Input Analyser (Global, using the first context available)
        if (!hardwareAnalyser) {
            hardwareAnalyser = ctx.createAnalyser();
            hardwareAnalyser.fftSize = 256;
            // Connect Source -> Analyser (Pre-Fader)
            source.connect(hardwareAnalyser);
        }

        hardwareGain = ctx.createGain();
        hardwareGain.gain.value = 0; 
        source.connect(hardwareGain);
    }

    // --- DIRECT INPUT CHAIN ---
    const directGain = ctx.createGain();
    directGain.gain.value = 0; 
    
    // Setup Direct Input Analyser (Attached to directGain, Post-Fader relative to source but Pre-Mix)
    // To measure Direct Input *Signal*, we should attach it to the source logic in processAudioPacket.
    // But we don't have a node until here.
    // Let's attach an analyser node to directGain's INPUT side.
    // But directGain input comes from buffer sources created on fly.
    // Workaround: Create a dummy node or use the directGain node output for Post-Fader metering.
    // Let's put it on Output of DirectGain for "Input Strip Meter" (Post-Fader).
    
    if (!directAnalyser) {
        directAnalyser = ctx.createAnalyser();
        directAnalyser.fftSize = 256;
        directGain.connect(directAnalyser); 
        // Note: this will measure Post-Fader of Direct Input
    }

    // --- OUTPUT STRIP CHAIN ---
    const highShelf = ctx.createBiquadFilter(); highShelf.type = "highshelf"; highShelf.frequency.value = 8000; highShelf.gain.value = outputObj.eqValues.high;
    const peaking = ctx.createBiquadFilter(); peaking.type = "peaking"; peaking.frequency.value = 1000; peaking.Q.value = 1.0; peaking.gain.value = outputObj.eqValues.mid;
    const lowShelf = ctx.createBiquadFilter(); lowShelf.type = "lowshelf"; lowShelf.frequency.value = 200; lowShelf.gain.value = outputObj.eqValues.low;

    const stripVolume = ctx.createGain();
    stripVolume.gain.value = outputObj.isMuted ? 0 : outputObj.volume;

    // Analyser for this Output Strip
    const outAnalyser = ctx.createAnalyser();
    outAnalyser.fftSize = 256;

    // Mixing
    if (hardwareGain) hardwareGain.connect(lowShelf);
    directGain.connect(lowShelf);

    lowShelf.connect(peaking);
    peaking.connect(highShelf);
    highShelf.connect(stripVolume);
    
    // Chain: Vol -> Analyser -> Dest
    stripVolume.connect(outAnalyser);
    outAnalyser.connect(ctx.destination);

    // Save references
    outputObj.context = ctx;
    outputObj.hardwareGainNode = hardwareGain; 
    outputObj.directGainNode = directGain;     
    outputObj.eqNodes = { low: lowShelf, mid: peaking, high: highShelf };
    outputObj.gainNode = stripVolume;
    outputObj.analyser = outAnalyser;
    outputObj.nextAudioTime = 0;
}

// --- UI Handlers ---
inputGainFader.addEventListener('input', (e) => {
    hardwareInputGainValue = parseFloat(e.target.value);
    updateDbDisplay(inputDbDisplay, hardwareInputGainValue);
    updateCalculatedGains();
});
inputGainFader.addEventListener('change', saveSettings);

directGainFader.addEventListener('input', (e) => {
    directInputGainValue = parseFloat(e.target.value);
    updateDbDisplay(directDbDisplay, directInputGainValue);
    updateCalculatedGains();
});
directGainFader.addEventListener('change', saveSettings);

directMuteBtn.addEventListener('click', () => {
    directInputMuted = !directInputMuted;
    updateDirectMuteUI();
    updateCalculatedGains();
    saveSettings();
});

function updateDirectMuteUI() {
    directMuteBtn.classList.toggle('active', directInputMuted);
    directMuteBtn.textContent = directInputMuted ? "MUTED" : "Mute";
}

function updateDbDisplay(element, val) {
    const db = val === 0 ? -Infinity : 20 * Math.log10(val);
    element.textContent = (db === -Infinity ? "-Inf" : db.toFixed(1)) + "dB";
}

// --- Add/Remove Strip ---
function removeOutputStrip(id) {
    const index = outputs.findIndex(o => o.id === id);
    if (index === -1) return;
    const out = outputs[index];
    if (out.context) out.context.close();
    out.div.remove();
    outputs.splice(index, 1);
    hardwareRouting.delete(id);
    directRouting.delete(id);
    updateRoutingUI();
    saveSettings();
    checkGlobalMuteStatus();
}

function addOutputStrip(savedData = null) {
    const id = savedData ? savedData.id : outputIdCounter++;
    const stripName = "A" + id;
    if (savedData && savedData.id >= outputIdCounter) outputIdCounter = savedData.id + 1;

    if (!savedData) { hardwareRouting.add(id); directRouting.add(id); }

    const initialVol = savedData ? savedData.volume : 1.0;
    const initialMute = savedData ? savedData.isMuted : false;
    const eqVals = savedData ? savedData.eq : { low: 0, mid: 0, high: 0 };

    const stripDiv = document.createElement('div');
    stripDiv.className = 'strip';
    stripDiv.innerHTML = `
        <div class="strip-header">${stripName}</div>
        <button class="delete-strip-btn" title="Remove Strip">×</button>
        <select></select>
        <div class="eq-section">
            <div class="eq-label">EQ</div>
            <div class="eq-control"><span>H</span> <input type="range" class="eq-slider" data-type="high" min="-15" max="15" value="${eqVals.high}"></div>
            <div class="eq-control"><span>M</span> <input type="range" class="eq-slider" data-type="mid" min="-15" max="15" value="${eqVals.mid}"></div>
            <div class="eq-control"><span>L</span> <input type="range" class="eq-slider" data-type="low" min="-15" max="15" value="${eqVals.low}"></div>
        </div>
        <div class="fader-group">
            <div class="meter-container"><div class="meter-fill"></div></div>
            <input type="range" class="fader-main" orient="vertical" min="0" max="1.5" step="0.01" value="${initialVol}">
        </div>
        <div class="db-display">0.0dB</div>
        <button class="btn-mute ${initialMute ? 'active' : ''}">${initialMute ? 'MUTED' : 'Mute'}</button>
    `;
    outputStripsContainer.appendChild(stripDiv);

    const outputObj = {
        id: id, div: stripDiv,
        context: null, hardwareGainNode: null, directGainNode: null, gainNode: null, eqNodes: {}, analyser: null,
        selectedDeviceId: savedData ? savedData.selectedDeviceId : null,
        volume: initialVol, isMuted: initialMute, eqValues: eqVals,
        nextAudioTime: 0 
    };

    const select = stripDiv.querySelector('select');
    const fader = stripDiv.querySelector('.fader-main');
    const dbDisplay = stripDiv.querySelector('.db-display');
    const muteBtn = stripDiv.querySelector('.btn-mute');
    const eqSliders = stripDiv.querySelectorAll('.eq-slider');
    const deleteBtn = stripDiv.querySelector('.delete-strip-btn');
    const meterFill = stripDiv.querySelector('.meter-fill');
    
    // Attach meter element ref
    outputObj.meterFill = meterFill;

    const db = initialVol === 0 ? -Infinity : 20 * Math.log10(initialVol);
    dbDisplay.textContent = (db === -Infinity ? "-Inf" : db.toFixed(1)) + "dB";
    if (window.availableOutputDevices) updateOutputStripDropdown(outputObj, window.availableOutputDevices);

    deleteBtn.addEventListener('click', () => { if (confirm(`Remove output ${stripName}?`)) removeOutputStrip(id); });

    select.addEventListener('change', async (e) => {
        outputObj.selectedDeviceId = e.target.value;
        saveSettings();
        if (isRunning && outputObj.context && typeof outputObj.context.setSinkId === 'function') {
            try { await outputObj.context.setSinkId(outputObj.selectedDeviceId); } catch(err){}
        }
    });

    eqSliders.forEach(slider => {
        slider.addEventListener('input', (e) => {
            const type = e.target.dataset.type;
            const val = parseFloat(e.target.value);
            outputObj.eqValues[type] = val;
            if (outputObj.eqNodes && outputObj.eqNodes[type]) {
                outputObj.eqNodes[type].gain.setTargetAtTime(val, outputObj.context.currentTime, 0.05);
            }
        });
        slider.addEventListener('change', saveSettings);
    });

    fader.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        outputObj.volume = val;
        updateDbDisplay(dbDisplay, val);
        if (outputObj.gainNode && !outputObj.isMuted) {
            outputObj.gainNode.gain.setTargetAtTime(val, outputObj.context.currentTime, 0.02);
        }
    });
    fader.addEventListener('change', saveSettings);

    muteBtn.addEventListener('click', () => {
        outputObj.isMuted = !outputObj.isMuted;
        muteBtn.classList.toggle('active', outputObj.isMuted);
        muteBtn.textContent = outputObj.isMuted ? "MUTED" : "Mute";
        if (outputObj.gainNode && outputObj.context) {
            const targetVol = outputObj.isMuted ? 0 : outputObj.volume;
            outputObj.gainNode.gain.setTargetAtTime(targetVol, outputObj.context.currentTime, 0.02);
        }
        saveSettings();
        checkGlobalMuteStatus();
    });

    outputs.push(outputObj);
    updateRoutingUI();
    if (isRunning) connectOutputEngine(outputObj);
    saveSettings();
}

function updateOutputStripDropdown(outputObj, devices) {
    const select = outputObj.div.querySelector('select');
    const currentVal = outputObj.selectedDeviceId;
    select.innerHTML = '<option value="">Select Device...</option>';
    devices.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.text = cleanLabel(d.label);
        select.appendChild(opt);
    });
    if (currentVal) select.value = currentVal;
}

inputDeviceSelect.addEventListener('change', saveSettings);
startBtn.addEventListener('click', () => { if (isRunning) stopEngine(); else startEngine(); });
addStripBtn.addEventListener('click', () => addOutputStrip());
navigator.mediaDevices.ondevicechange = refreshDevices;

init();