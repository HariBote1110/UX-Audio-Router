// js/ui.js
const { ipcRenderer } = require('electron');
const store = require('./store');
const audio = require('./audio');

class UI {
    constructor() {
        this.el = {
            inputsContainer: document.getElementById('inputStripsContainer'),
            directContainer: document.getElementById('directStripContainer'),
            outputsContainer: document.getElementById('outputStripsContainer'),
            startBtn: document.getElementById('startBtn'),
            addInputBtn: document.getElementById('addInputBtn'),
            addOutputBtn: document.getElementById('addOutputBtn'),
            statusDot: document.getElementById('uxMusicStatusDot'),
            statusText: document.getElementById('uxMusicStatusText'),
            dirRoute: document.getElementById('directRouteContainer'),
            dirFader: document.getElementById('directGainFader'),
            dirDb: document.getElementById('directDbDisplay'),
            dirMute: document.getElementById('directMuteBtn'),
            dirMeterL: document.getElementById('directMeterL'),
            dirMeterR: document.getElementById('directMeterR'),
            dirBufferSlider: document.getElementById('directBufferSlider'),
            dirBufferVal: document.getElementById('directBufferVal'),

            // Modal Elements
            eqModalOverlay: document.getElementById('eqModalOverlay'),
            eqModalTitle: document.getElementById('eqModalTitle'),
            eqModalCloseBtn: document.getElementById('eqModalCloseBtn'),
            eqSlidersContainer: document.getElementById('eqSlidersContainer'),
            eqResetBtn: document.getElementById('eqResetBtn')
        };

        this.meterValues = new Map();
        this.lastTime = performance.now();
        this.fftData = new Uint8Array(2048);
        this.inputDevices = [];
        this.outputDevices = [];
        this.isVisible = true;

        this.currentEqOutputId = null; // 現在モーダルで編集中のOutput ID
    }

    async init() {
        this.setupGlobalListeners();
        await this.refreshDeviceList();
        store.load();

        store.data.inputs.forEach(inData => this.renderInputStrip(inData));

        if (this.el.dirFader) this.el.dirFader.value = store.data.directGain;
        if (this.el.dirDb) this.updateDb(this.el.dirDb, store.data.directGain);
        if (this.el.dirMute) this.updateMuteBtn(this.el.dirMute, store.data.directMuted);
        if (this.el.dirRoute) this.renderRoutingContainer(this.el.dirRoute, 'direct', null);
        if (this.el.dirBufferSlider) {
            this.el.dirBufferSlider.value = store.data.directBuffer;
            if (this.el.dirBufferVal) this.el.dirBufferVal.textContent = store.data.directBuffer.toFixed(2);
        }

        store.data.outputs.forEach(outData => this.renderOutputStrip(outData));

        store.on('routing-changed', () => {
            store.data.inputs.forEach(i => {
                const container = document.getElementById(`input-${i.id}-route`);
                if (container) this.renderRoutingContainer(container, 'hardware', i.id);
            });
            if (this.el.dirRoute) this.renderRoutingContainer(this.el.dirRoute, 'direct', null);
            audio.updateAllGains();
        });

        this.startMeterLoop();
    }

    setupGlobalListeners() {
        ipcRenderer.on('window-hide', () => { this.isVisible = false; });
        ipcRenderer.on('window-show', () => {
            if (!this.isVisible) {
                this.isVisible = true;
                this.lastTime = performance.now();
                this.startMeterLoop();
            }
        });

        this.el.dirFader?.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            store.data.directGain = val;
            this.updateDb(this.el.dirDb, val);
            audio.updateAllGains();
        });
        this.el.dirFader?.addEventListener('change', () => store.save());

        this.el.dirMute?.addEventListener('click', () => {
            store.data.directMuted = !store.data.directMuted;
            this.updateMuteBtn(this.el.dirMute, store.data.directMuted);
            audio.updateAllGains();
            store.save();
        });

        this.el.dirBufferSlider?.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            store.data.directBuffer = val;
            if (this.el.dirBufferVal) this.el.dirBufferVal.textContent = val.toFixed(2);
        });
        this.el.dirBufferSlider?.addEventListener('change', () => store.save());

        this.el.startBtn?.addEventListener('click', () => {
            if (audio.isRunning) { audio.stop(); this.updateStartBtn(false); }
            else { audio.start(); this.updateStartBtn(true); }
        });

        this.el.addInputBtn?.addEventListener('click', () => this.addNewInput());
        this.el.addOutputBtn?.addEventListener('click', () => this.addNewOutput());
        navigator.mediaDevices.ondevicechange = () => this.refreshDeviceList();

        ipcRenderer.on('toggle-global-mute', (event, newState) => {
            const anyActive = store.data.outputs.some(o => !o.isMuted);
            const muteAll = anyActive;
            store.data.outputs.forEach(o => o.isMuted = muteAll);
            store.save();
            this.el.outputsContainer.innerHTML = '';
            store.data.outputs.forEach(o => this.renderOutputStrip(o));
            store.data.outputs.forEach(o => audio.updateStripParams(o.id));
            ipcRenderer.send('mute-status-changed', muteAll);
        });

        // --- Modal Events ---
        this.el.eqModalCloseBtn?.addEventListener('click', () => this.closeEqModal());
        this.el.eqModalOverlay?.addEventListener('click', (e) => {
            if (e.target === this.el.eqModalOverlay) this.closeEqModal();
        });
        this.el.eqResetBtn?.addEventListener('click', () => {
            if (this.currentEqOutputId === null) return;
            const data = store.data.outputs.find(o => o.id === this.currentEqOutputId);
            if (data) {
                data.eqGains.fill(0);
                audio.updateStripParams(data.id);
                store.save();
                this.renderEqModalContent(data); // Slidersを0に戻す
            }
        });
    }

    // --- Input Management ---
    addNewInput() {
        const id = store.addInput();
        this.renderInputStrip(store.data.inputs.find(i => i.id === id));
        if (audio.isRunning) { audio.stop(); audio.start(); this.updateStartBtn(true); }
    }

    removeInput(id) {
        if (!confirm('Remove input?')) return;
        const el = document.getElementById(`input-strip-${id}`);
        if (el) el.remove();
        this.meterValues.delete(`input-${id}-meter`);
        store.removeInput(id);
        if (audio.isRunning) { audio.stop(); audio.start(); this.updateStartBtn(true); }
    }

    renderInputStrip(data) {
        const div = document.createElement('div');
        div.className = 'strip input-strip';
        div.id = `input-strip-${data.id}`;
        div.innerHTML = `
            <div class="strip-header">IN ${data.id}</div>
            <button class="delete-strip-btn">×</button>
            <select class="device-select"></select>
            <div class="route-container" id="input-${data.id}-route"></div>
            <div class="fader-group">
                <div class="meter-container-stereo">
                    <div class="meter-container"><div class="meter-fill" id="input-${data.id}-meterL"></div></div>
                    <div class="meter-container"><div class="meter-fill" id="input-${data.id}-meterR"></div></div>
                </div>
                <input type="range" class="fader-main" orient="vertical" min="0" max="1.5" step="0.01" value="${data.volume}">
            </div>
            <div class="db-display">0.0dB</div>
        `;
        const sel = div.querySelector('.device-select');
        const routeCont = div.querySelector('.route-container');
        const fader = div.querySelector('.fader-main');
        const dbDisp = div.querySelector('.db-display');
        const delBtn = div.querySelector('.delete-strip-btn');

        this.updateDb(dbDisp, data.volume);
        this.populateInputDeviceSelect(sel, data.deviceId);
        this.renderRoutingContainer(routeCont, 'hardware', data.id);

        delBtn.onclick = () => this.removeInput(data.id);
        sel.onchange = () => { data.deviceId = sel.value; store.save(); if (audio.isRunning) { audio.stop(); audio.start(); } };
        fader.oninput = (e) => { data.volume = parseFloat(e.target.value); this.updateDb(dbDisp, data.volume); audio.updateAllGains(); };
        fader.onchange = () => store.save();
        this.el.inputsContainer.appendChild(div);
    }

    // --- Output Management ---
    addNewOutput() {
        const id = store.addOutput();
        const newData = store.data.outputs.find(o => o.id === id);
        store.data.inputs.forEach(inp => store.toggleRouting('hardware', inp.id, id));
        store.toggleRouting('direct', null, id);
        this.renderOutputStrip(newData);

        store.data.inputs.forEach(i => {
            const c = document.getElementById(`input-${i.id}-route`);
            if (c) this.renderRoutingContainer(c, 'hardware', i.id);
        });
        if (this.el.dirRoute) this.renderRoutingContainer(this.el.dirRoute, 'direct', null);
        if (audio.isRunning) audio.createStripContext(newData);
    }

    removeOutput(id) {
        if (!confirm('Remove output?')) return;
        const el = document.getElementById(`strip-${id}`);
        if (el) el.remove();
        this.meterValues.delete(`strip-${id}-meter`);
        audio.removeStripContext(id);
        store.removeOutput(id);

        store.data.inputs.forEach(i => {
            const c = document.getElementById(`input-${i.id}-route`);
            if (c) this.renderRoutingContainer(c, 'hardware', i.id);
        });
        if (this.el.dirRoute) this.renderRoutingContainer(this.el.dirRoute, 'direct', null);
    }

    renderOutputStrip(data) {
        const div = document.createElement('div');
        div.className = 'strip';
        div.id = `strip-${data.id}`;
        div.innerHTML = `
            <div class="strip-header">A${data.id}</div>
            <button class="delete-strip-btn">×</button>
            <select class="device-select"></select>
            
            <button class="eq-open-btn">EQ</button>

            <div class="fx-section">
                <div class="fx-row">
                    <span class="fx-label">DLY</span>
                    <input type="number" class="delay-input" min="0" max="1000" value="${data.delayMs || 0}">
                </div>
                <div class="fx-row">
                    <span class="fx-label">CMP</span>
                    <button class="comp-btn ${data.compressor?.enabled ? 'active' : ''}">ACT</button>
                    <input type="range" class="comp-thresh" min="-60" max="0" value="${data.compressor?.threshold || -24}" title="Threshold">
                </div>
            </div>

            <div class="fader-group">
                <div class="meter-container-stereo">
                    <div class="meter-container"><div class="meter-fill" id="strip-${data.id}-meterL"></div></div>
                    <div class="meter-container"><div class="meter-fill" id="strip-${data.id}-meterR"></div></div>
                </div>
                <input type="range" class="fader-main" orient="vertical" min="0" max="1.5" step="0.01" value="${data.volume}">
            </div>
            <div class="db-display">0.0dB</div>
            <button class="btn-mute">Mute</button>
        `;

        const sel = div.querySelector('.device-select');
        const fader = div.querySelector('.fader-main');
        const dbDisp = div.querySelector('.db-display');
        const muteBtn = div.querySelector('.btn-mute');
        const delBtn = div.querySelector('.delete-strip-btn');
        const eqBtn = div.querySelector('.eq-open-btn');

        const delayInput = div.querySelector('.delay-input');
        const compBtn = div.querySelector('.comp-btn');
        const compThresh = div.querySelector('.comp-thresh');

        this.updateDb(dbDisp, data.volume);
        this.updateMuteBtn(muteBtn, data.isMuted);
        this.populateOutputDeviceSelect(sel, data.selectedDeviceId);

        eqBtn.onclick = () => this.openEqModal(data.id);

        delBtn.onclick = () => this.removeOutput(data.id);
        sel.onchange = () => { data.selectedDeviceId = sel.value; store.save(); audio.setStripDevice(data.id, sel.value); };
        fader.oninput = (e) => { data.volume = parseFloat(e.target.value); this.updateDb(dbDisp, data.volume); audio.updateStripParams(data.id); };
        fader.onchange = () => store.save();
        muteBtn.onclick = () => { data.isMuted = !data.isMuted; this.updateMuteBtn(muteBtn, data.isMuted); audio.updateStripParams(data.id); store.save(); };

        delayInput.onchange = (e) => {
            let val = parseInt(e.target.value); if (val < 0) val = 0;
            data.delayMs = val; audio.updateStripParams(data.id); store.save();
        };
        compBtn.onclick = () => {
            if (!data.compressor) data.compressor = { enabled: false, threshold: -24, ratio: 4, attack: 0.003, release: 0.25 };
            data.compressor.enabled = !data.compressor.enabled;
            compBtn.classList.toggle('active', data.compressor.enabled);
            audio.updateStripParams(data.id); store.save();
        };
        compThresh.oninput = (e) => {
            if (!data.compressor) data.compressor = { enabled: true, threshold: -24, ratio: 4, attack: 0.003, release: 0.25 };
            data.compressor.threshold = parseFloat(e.target.value);
            audio.updateStripParams(data.id);
        };
        compThresh.onchange = () => store.save();

        this.el.outputsContainer.appendChild(div);
    }

    // --- Modal Logic ---
    openEqModal(outputId) {
        this.currentEqOutputId = outputId;
        const data = store.data.outputs.find(o => o.id === outputId);
        if (!data) return;

        this.el.eqModalTitle.textContent = `Graphic EQ - Output A${outputId}`;
        this.el.eqModalOverlay.style.display = 'flex';
        this.renderEqModalContent(data);
    }

    closeEqModal() {
        this.el.eqModalOverlay.style.display = 'none';
        this.currentEqOutputId = null;
    }

    renderEqModalContent(data) {
        this.el.eqSlidersContainer.innerHTML = '';
        const freqs = store.eqFrequencies;

        freqs.forEach((freq, i) => {
            const val = data.eqGains[i] || 0;
            const label = freq >= 1000 ? `${freq / 1000}K` : freq;

            const col = document.createElement('div');
            col.className = 'eq-band-col';
            col.innerHTML = `
                <div class="eq-val-label">${val > 0 ? '+' : ''}${val.toFixed(1)}</div>
                <input type="range" class="eq-fader" orient="vertical" min="-15" max="15" step="0.1" value="${val}">
                <div class="eq-freq-label">${label}</div>
            `;

            const fader = col.querySelector('.eq-fader');
            const valDisp = col.querySelector('.eq-val-label');

            fader.oninput = (e) => {
                const newVal = parseFloat(e.target.value);
                data.eqGains[i] = newVal;
                valDisp.textContent = `${newVal > 0 ? '+' : ''}${newVal.toFixed(1)}`;

                audio.updateStripParams(data.id);
            };
            fader.onchange = () => store.save();

            this.el.eqSlidersContainer.appendChild(col);
        });
    }

    // --- Helpers ---
    async refreshDeviceList() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            this.inputDevices = devices.filter(d => d.kind === 'audioinput');
            this.outputDevices = devices.filter(d => d.kind === 'audiooutput');

            // --- Auto-Reconnect Check ---
            let shouldRestartAudio = false;

            // 1. Check Input Devices
            if (audio.isRunning) {
                store.data.inputs.forEach(input => {
                    // Check if this input is configured but missing in the engine
                    const currentHw = audio.hardwareInputs.get(input.id);
                    const isMissingInEngine = !currentHw || !currentHw.stream || !currentHw.stream.active;

                    // Check if the configured device ID is actually present now
                    const isAvailable = this.inputDevices.some(d => d.deviceId === input.deviceId);

                    if (isMissingInEngine && isAvailable) {
                        console.log(`Input device ${input.deviceId} reconnected. Restarting audio.`);
                        shouldRestartAudio = true;
                    }
                });
            }

            // 2. Refresh UI Selects
            const inputSelects = document.querySelectorAll('.input-strip .device-select');
            inputSelects.forEach(sel => {
                const stripId = parseInt(sel.closest('.strip').id.replace('input-strip-', ''));
                const data = store.data.inputs.find(i => i.id === stripId);
                this.populateInputDeviceSelect(sel, data ? data.deviceId : '');
            });

            const outputSelects = document.querySelectorAll('#outputStripsContainer .device-select');
            outputSelects.forEach(sel => {
                const stripId = parseInt(sel.closest('.strip').id.replace('strip-', ''));
                const data = store.data.outputs.find(o => o.id === stripId);
                this.populateOutputDeviceSelect(sel, data ? data.selectedDeviceId : '');
            });

            // 3. Audio Engine Action
            if (shouldRestartAudio) {
                audio.stop();
                await audio.start();
                this.updateStartBtn(true);
            } else if (audio.isRunning) {
                // Determine if any output devices need re-hooking
                store.data.outputs.forEach(out => {
                    const nodes = audio.strips.get(out.id);
                    const isAvailable = this.outputDevices.some(d => d.deviceId === out.selectedDeviceId);
                    // If the device is present but maybe not correctly attached? 
                    // Note: WebAudio often handles output device loss gracefully, but explicit setSinkId can help on reconnect.
                    if (isAvailable && out.selectedDeviceId) {
                        // Re-apply sink ID just in case it was lost
                        audio.setStripDevice(out.id, out.selectedDeviceId);
                    }
                });
            }

        } catch (e) { console.error(e); }
    }

    populateInputDeviceSelect(select, currentVal) {
        if (!select) return;
        select.innerHTML = '';
        this.inputDevices.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.text = d.label || `Input ${d.deviceId.slice(0, 4)}`;
            if (d.label.includes('BlackHole')) opt.selected = true;
            select.appendChild(opt);
        });
        if (currentVal && this.inputDevices.some(d => d.deviceId === currentVal)) select.value = currentVal;
    }

    populateOutputDeviceSelect(select, currentVal) {
        if (!select) return;
        select.innerHTML = '<option value="">Select Device...</option>';
        this.outputDevices.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.text = d.label || `Output ${d.deviceId.slice(0, 4)}`;
            select.appendChild(opt);
        });
        if (currentVal) select.value = currentVal;
    }

    renderRoutingContainer(container, type, inputId) {
        if (!container) return;
        container.innerHTML = '';
        store.data.outputs.forEach(out => {
            const btn = document.createElement('div');
            const isRouted = store.isRouted(type, inputId, out.id);
            btn.className = `route-btn ${isRouted ? 'active' : ''}`;
            btn.textContent = `A${out.id}`;
            btn.onclick = () => { store.toggleRouting(type, inputId, out.id); };
            container.appendChild(btn);
        });
    }

    updateDb(el, val) {
        if (!el) return;
        const db = val === 0 ? -Infinity : 20 * Math.log10(val);
        el.textContent = (db === -Infinity ? "-Inf" : db.toFixed(1)) + "dB";
    }

    updateMuteBtn(el, isMuted) {
        if (!el) return;
        el.classList.toggle('active', isMuted);
        el.textContent = isMuted ? "MUTED" : "Mute";
    }

    updateStartBtn(isActive) {
        if (!this.el.startBtn) return;
        this.el.startBtn.textContent = isActive ? "ACTIVE" : "ON";
        this.el.startBtn.style.backgroundColor = isActive ? "var(--accent-orange)" : "var(--accent-green)";
    }

    updateStatusDot(connected, rate) {
        if (!this.el.statusDot || !this.el.statusText) return;
        if (connected) {
            this.el.statusDot.classList.add('connected');
            this.el.statusText.textContent = `UX Music: Connected (${rate}Hz)`;
            this.el.statusText.style.color = "var(--accent-blue)";
        } else {
            this.el.statusDot.classList.remove('connected');
            this.el.statusText.textContent = "UX Music: Disconnected";
            this.el.statusText.style.color = "#555";
        }
    }

    startMeterLoop() {
        const loop = (timestamp) => {
            if (!this.isVisible) return;
            let dt = (timestamp - this.lastTime) / 1000;
            this.lastTime = timestamp;
            if (dt > 0.1) dt = 0.1;

            if (audio.isRunning) {
                store.data.inputs.forEach(input => {
                    const hw = audio.hardwareInputs.get(input.id);
                    const elL = document.getElementById(`input-${input.id}-meterL`);
                    const elR = document.getElementById(`input-${input.id}-meterR`);
                    if (hw && hw.analyserL && elL) this.updateMeter(hw.analyserL, elL, dt);
                    else if (elL) this.updateMeter(null, elL, dt);
                    if (hw && hw.analyserR && elR) this.updateMeter(hw.analyserR, elR, dt);
                    else if (elR) this.updateMeter(null, elR, dt);
                });

                this.updateMeter(audio.directAnalyserL, this.el.dirMeterL, dt);
                this.updateMeter(audio.directAnalyserR, this.el.dirMeterR, dt);

                store.data.outputs.forEach(outData => {
                    const nodes = audio.strips.get(outData.id);
                    const elL = document.getElementById(`strip-${outData.id}-meterL`);
                    const elR = document.getElementById(`strip-${outData.id}-meterR`);
                    if (nodes && nodes.analyserL && elL) this.updateMeter(nodes.analyserL, elL, dt);
                    else if (elL) this.updateMeter(null, elL, dt);
                    if (nodes && nodes.analyserR && elR) this.updateMeter(nodes.analyserR, elR, dt);
                    else if (elR) this.updateMeter(null, elR, dt);
                });
            } else {
                store.data.inputs.forEach(i => {
                    this.updateMeter(null, document.getElementById(`input-${i.id}-meterL`), dt);
                    this.updateMeter(null, document.getElementById(`input-${i.id}-meterR`), dt);
                });
                this.updateMeter(null, this.el.dirMeterL, dt);
                this.updateMeter(null, this.el.dirMeterR, dt);
                store.data.outputs.forEach(outData => {
                    this.updateMeter(null, document.getElementById(`strip-${outData.id}-meterL`), dt);
                    this.updateMeter(null, document.getElementById(`strip-${outData.id}-meterR`), dt);
                });
            }
            requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
    }

    updateMeter(analyser, element, dt) {
        if (!element) return;
        let targetPercent = 0;
        if (analyser) {
            analyser.getByteTimeDomainData(this.fftData);
            let sum = 0;
            const len = analyser.frequencyBinCount;
            for (let i = 0; i < len; i++) {
                const v = (this.fftData[i] - 128) / 128.0;
                sum += v * v;
            }
            const rms = Math.sqrt(sum / len);
            const db = 20 * Math.log10(rms);
            targetPercent = (db + 60) / 60 * 100;
            if (targetPercent < 0) targetPercent = 0;
            if (targetPercent > 100) targetPercent = 100;
            if (targetPercent < 5.0) targetPercent = 0;
        }

        const id = element.id;
        let current = this.meterValues.get(id) || 0;
        if (targetPercent > current) {
            current += (targetPercent - current) * 15.0 * dt;
        } else {
            current -= 80.0 * dt;
        }
        if (current < 0) current = 0;
        if (current > 100) current = 100;
        this.meterValues.set(id, current);
        element.style.height = `${current}%`;
    }
}

module.exports = new UI();