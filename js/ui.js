// js/ui.js
const { ipcRenderer } = require('electron');
const store = require('./store');
const audio = require('./audio');

class UI {
    constructor() {
        // --- UI Elements Cache ---
        // 頻繁にアクセスする要素はここで一度だけ取得
        this.el = {
            inputSelect: document.getElementById('inputDeviceSelect'),
            startBtn: document.getElementById('startBtn'),
            addBtn: document.getElementById('addStripBtn'),
            outputsContainer: document.getElementById('outputStripsContainer'),
            statusDot: document.getElementById('uxMusicStatusDot'),
            statusText: document.getElementById('uxMusicStatusText'),
            hwRoute: document.getElementById('hardwareRouteContainer'),
            dirRoute: document.getElementById('directRouteContainer'),
            inputFader: document.getElementById('inputGainFader'),
            inputDb: document.getElementById('inputDbDisplay'),
            hwMeter: document.getElementById('hardwareMeter'),
            dirFader: document.getElementById('directGainFader'),
            dirDb: document.getElementById('directDbDisplay'),
            dirMute: document.getElementById('directMuteBtn'),
            dirMeter: document.getElementById('directMeter')
        };

        // --- Meter System ---
        // メーター更新対象のリスト (オブジェクト: { analyser, element, currentLevel })
        // これによりID検索を毎フレーム行う無駄を排除
        this.activeMeters = []; 
        
        // 最後に更新した時間
        this.lastTime = performance.now();
        
        // 分析用バッファ (FFTサイズ2048に対応)
        this.fftData = new Uint8Array(2048); 
    }

    init() {
        this.setupListeners();
        this.refreshDeviceList();
        this.loadValuesFromStore();
        this.renderAllRoutingButtons();
        
        // 初期ストリップの描画
        store.data.outputs.forEach(out => this.renderOutputStrip(out));

        // メーターリストの初期構築
        this.rebuildMeterList();

        store.on('routing-changed', () => {
            this.renderAllRoutingButtons();
            audio.updateAllGains();
        });

        // アニメーションループ開始
        this.startMeterLoop();
    }

    // --- Meter Logic (Core Fix) ---

    // メーター対象リストを再構築する（ストリップ追加・削除時や起動時に呼ぶ）
    rebuildMeterList() {
        this.activeMeters = [];

        // 1. Hardware Input
        if (this.el.hwMeter) {
            this.activeMeters.push({
                type: 'hardware',
                element: this.el.hwMeter,
                currentLevel: 0
            });
        }

        // 2. Direct Input
        if (this.el.dirMeter) {
            this.activeMeters.push({
                type: 'direct',
                element: this.el.dirMeter,
                currentLevel: 0
            });
        }

        // 3. Output Strips
        store.data.outputs.forEach(outData => {
            const el = document.getElementById(`strip-${outData.id}-meter`);
            if (el) {
                this.activeMeters.push({
                    type: 'output',
                    id: outData.id,
                    element: el,
                    currentLevel: 0
                });
            }
        });
    }

    startMeterLoop() {
        const loop = (timestamp) => {
            // デルタタイム計算 (秒単位)
            let dt = (timestamp - this.lastTime) / 1000;
            this.lastTime = timestamp;

            // タブ切り替え復帰時などの巨大なdtを無視
            if (dt > 0.1) dt = 0.016; 

            // エンジンが動いていない場合は全メーターを減衰させて終了
            if (!audio.isRunning) {
                this.decayAllMeters(dt);
                requestAnimationFrame(loop);
                return;
            }

            // 全メーターの一括更新
            this.activeMeters.forEach(meter => {
                let analyser = null;

                // アナライザーの参照解決
                if (meter.type === 'hardware') analyser = audio.hardwareAnalyser;
                else if (meter.type === 'direct') analyser = audio.directAnalyser;
                else if (meter.type === 'output') {
                    const nodes = audio.strips.get(meter.id);
                    if (nodes) analyser = nodes.analyser;
                }

                if (analyser) {
                    this.updateSingleMeter(analyser, meter, dt);
                } else {
                    // アナライザーがない場合は減衰のみ
                    this.decaySingleMeter(meter, dt);
                }
            });

            requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
    }

    updateSingleMeter(analyser, meterObj, dt) {
        // 1. 音量(RMS)の取得
        analyser.getByteTimeDomainData(this.fftData);
        
        let sum = 0;
        const len = analyser.frequencyBinCount;
        for (let i = 0; i < len; i++) {
            const v = (this.fftData[i] - 128) / 128.0;
            sum += v * v;
        }
        const rms = Math.sqrt(sum / len);
        
        // 2. dB -> % 変換 (-60dB ~ 0dB)
        const db = 20 * Math.log10(rms);
        let target = (db + 60) / 60 * 100;
        
        // クランプ & ノイズゲート
        if (target < 0) target = 0;
        if (target > 100) target = 100;
        if (target < 1.0) target = 0; // 微小ノイズカット

        // 3. ピークホールド & ディケイ (Peak Hold & Decay)
        // ここがガタつき防止の肝です。
        // 「入力が今より大きければ即座に上がる」
        // 「入力が今より小さければ、一定速度で下がる（一瞬で0には戻さない）」
        
        if (target > meterObj.currentLevel) {
            // Attack: 即座に反映 (必要なら少しLerpを入れても良いが、即時の方がキビキビ動く)
            // 少しだけ平均化してジッターを抑えるなら: 
            meterObj.currentLevel += (target - meterObj.currentLevel) * 0.5; 
        } else {
            // Decay: 定速減衰
            // 1秒間に減る量 (例: 60% / sec) -> 残光感の調整はここ
            const decaySpeed = 60.0; 
            meterObj.currentLevel -= decaySpeed * dt;
        }

        // 範囲チェック
        if (meterObj.currentLevel < 0) meterObj.currentLevel = 0;
        if (meterObj.currentLevel > 100) meterObj.currentLevel = 100;

        // 4. DOM反映 (キャッシュしたelementを直接操作)
        meterObj.element.style.height = `${meterObj.currentLevel}%`;
    }

    decayAllMeters(dt) {
        this.activeMeters.forEach(m => this.decaySingleMeter(m, dt));
    }

    decaySingleMeter(meterObj, dt) {
        if (meterObj.currentLevel > 0) {
            const decaySpeed = 60.0; 
            meterObj.currentLevel -= decaySpeed * dt;
            if (meterObj.currentLevel < 0) meterObj.currentLevel = 0;
            meterObj.element.style.height = `${meterObj.currentLevel}%`;
        }
    }

    // --- Standard UI Logic ---

    setupListeners() {
        this.el.inputFader.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            store.data.hardwareGain = val;
            this.updateDb(this.el.inputDb, val);
            audio.updateAllGains();
        });
        this.el.inputFader.addEventListener('change', () => store.save());

        this.el.inputSelect.addEventListener('change', () => {
            store.data.inputDeviceId = this.el.inputSelect.value;
            store.save();
            audio.stop();
            audio.start();
        });

        this.el.dirFader.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            store.data.directGain = val;
            this.updateDb(this.el.dirDb, val);
            audio.updateAllGains();
        });
        this.el.dirFader.addEventListener('change', () => store.save());

        this.el.dirMute.addEventListener('click', () => {
            store.data.directMuted = !store.data.directMuted;
            this.updateMuteBtn(this.el.dirMute, store.data.directMuted);
            audio.updateAllGains();
            store.save();
        });

        this.el.startBtn.addEventListener('click', () => {
            if (audio.isRunning) {
                audio.stop();
                this.updateStartBtn(false);
            } else {
                audio.start();
                this.updateStartBtn(true);
            }
        });

        this.el.addBtn.addEventListener('click', () => this.addNewOutput());
        
        navigator.mediaDevices.ondevicechange = () => this.refreshDeviceList();

        ipcRenderer.on('toggle-global-mute', (event, newState) => {
             const anyActive = store.data.outputs.some(o => !o.isMuted);
             const muteAll = anyActive;
             store.data.outputs.forEach(o => o.isMuted = muteAll);
             store.save();
             
             this.el.outputsContainer.innerHTML = '';
             store.data.outputs.forEach(o => this.renderOutputStrip(o));
             this.rebuildMeterList(); // DOM再生成後はリスト再構築必須
             
             store.data.outputs.forEach(o => audio.updateStripParams(o.id));
             ipcRenderer.send('mute-status-changed', muteAll);
        });
    }

    loadValuesFromStore() {
        this.el.inputFader.value = store.data.hardwareGain;
        this.updateDb(this.el.inputDb, store.data.hardwareGain);
        this.el.dirFader.value = store.data.directGain;
        this.updateDb(this.el.dirDb, store.data.directGain);
        this.updateMuteBtn(this.el.dirMute, store.data.directMuted);
    }

    addNewOutput() {
        const id = store.outputIdCounter++;
        const newOutput = {
            id: id,
            selectedDeviceId: '',
            volume: 1.0,
            isMuted: false,
            eqValues: { high: 0, mid: 0, low: 0 }
        };
        
        store.addOutput(newOutput);
        store.hardwareRoutingSet.add(id);
        store.directRoutingSet.add(id);
        store.save();
        
        this.renderOutputStrip(newOutput);
        this.rebuildMeterList(); // リスト更新
        this.renderAllRoutingButtons();
        if (audio.isRunning) audio.createStripContext(newOutput);
    }

    removeOutput(id) {
        if (!confirm('Remove output?')) return;
        const el = document.getElementById(`strip-${id}`);
        if (el) el.remove();
        
        audio.removeStripContext(id);
        store.removeOutput(id);
        this.renderAllRoutingButtons();
        this.rebuildMeterList(); // リスト更新
    }

    renderOutputStrip(data) {
        const div = document.createElement('div');
        div.className = 'strip';
        div.id = `strip-${data.id}`;
        div.innerHTML = `
            <div class="strip-header">A${data.id}</div>
            <button class="delete-strip-btn">×</button>
            <select class="device-select"></select>
            <div class="eq-section">
                <div class="eq-label">EQ</div>
                <div class="eq-control"><span>H</span> <input type="range" class="eq-slider" data-type="high" min="-15" max="15" value="${data.eqValues.high}"></div>
                <div class="eq-control"><span>M</span> <input type="range" class="eq-slider" data-type="mid" min="-15" max="15" value="${data.eqValues.mid}"></div>
                <div class="eq-control"><span>L</span> <input type="range" class="eq-slider" data-type="low" min="-15" max="15" value="${data.eqValues.low}"></div>
            </div>
            <div class="fader-group">
                <div class="meter-container"><div class="meter-fill" id="strip-${data.id}-meter"></div></div>
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
        const eqSliders = div.querySelectorAll('.eq-slider');

        this.updateDb(dbDisp, data.volume);
        this.updateMuteBtn(muteBtn, data.isMuted);
        this.populateDeviceSelect(sel, data.selectedDeviceId);

        delBtn.onclick = () => this.removeOutput(data.id);
        
        sel.onchange = () => {
            data.selectedDeviceId = sel.value;
            store.save();
            audio.setStripDevice(data.id, sel.value);
        };
        fader.oninput = (e) => {
            data.volume = parseFloat(e.target.value);
            this.updateDb(dbDisp, data.volume);
            audio.updateStripParams(data.id);
        };
        fader.onchange = () => store.save();
        muteBtn.onclick = () => {
            data.isMuted = !data.isMuted;
            this.updateMuteBtn(muteBtn, data.isMuted);
            audio.updateStripParams(data.id);
            store.save();
        };
        eqSliders.forEach(slider => {
            slider.oninput = (e) => {
                const type = e.target.dataset.type;
                data.eqValues[type] = parseFloat(e.target.value);
                audio.updateStripParams(data.id);
            };
            slider.onchange = () => store.save();
        });

        this.elOutputsContainer.appendChild(div);
    }

    async refreshDeviceList() {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const inputs = devices.filter(d => d.kind === 'audioinput');
        const outputs = devices.filter(d => d.kind === 'audiooutput');

        this.elInputSelect.innerHTML = '';
        inputs.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.text = d.label || `Input ${d.deviceId.slice(0,4)}`;
            if (d.label.includes('BlackHole')) opt.selected = true;
            this.elInputSelect.appendChild(opt);
        });
        if (store.data.inputDeviceId && inputs.some(d => d.deviceId === store.data.inputDeviceId)) {
            this.elInputSelect.value = store.data.inputDeviceId;
        }

        store.data.outputs.forEach(outData => {
            const el = document.getElementById(`strip-${outData.id}`);
            if (el) {
                const sel = el.querySelector('.device-select');
                this.populateDeviceSelect(sel, outData.selectedDeviceId, outputs);
            }
        });
        this.cachedOutputDevices = outputs;
    }

    populateDeviceSelect(select, currentVal, deviceList = null) {
        const devices = deviceList || this.cachedOutputDevices || [];
        select.innerHTML = '<option value="">Select Device...</option>';
        devices.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.text = d.label || `Output ${d.deviceId.slice(0,4)}`;
            select.appendChild(opt);
        });
        if (currentVal) select.value = currentVal;
    }

    renderAllRoutingButtons() {
        this.renderRoutingContainer(this.elHwRoute, store.hardwareRoutingSet, 'hardware');
        this.renderRoutingContainer(this.elDirRoute, store.directRoutingSet, 'direct');
    }

    renderRoutingContainer(container, set, type) {
        container.innerHTML = '';
        store.data.outputs.forEach(out => {
            const btn = document.createElement('div');
            btn.className = `route-btn ${set.has(out.id) ? 'active' : ''}`;
            btn.textContent = `A${out.id}`;
            btn.onclick = () => store.toggleRouting(type, out.id);
            container.appendChild(btn);
        });
    }

    updateDb(el, val) {
        const db = val === 0 ? -Infinity : 20 * Math.log10(val);
        el.textContent = (db === -Infinity ? "-Inf" : db.toFixed(1)) + "dB";
    }

    updateMuteBtn(el, isMuted) {
        el.classList.toggle('active', isMuted);
        el.textContent = isMuted ? "MUTED" : "Mute";
    }

    updateStartBtn(isActive) {
        this.elStartBtn.textContent = isActive ? "ACTIVE" : "ON";
        this.elStartBtn.style.backgroundColor = isActive ? "var(--accent-orange)" : "var(--accent-green)";
        this.elInputSelect.disabled = isActive;
    }

    updateStatusDot(connected, rate) {
        if (connected) {
            this.elStatusDot.classList.add('connected');
            this.elStatusText.textContent = `UX Music: Connected (${rate}Hz)`;
            this.elStatusText.style.color = "var(--accent-blue)";
        } else {
            this.elStatusDot.classList.remove('connected');
            this.elStatusText.textContent = "UX Music: Disconnected";
            this.elStatusText.style.color = "#555";
        }
    }
}

module.exports = new UI();