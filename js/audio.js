// js/audio.js
const store = require('./store');

class AudioEngine {
    constructor() {
        this.hardwareInputs = new Map();
        this.isRunning = false;
        this.directAnalyser = null;
        this.strips = new Map();
    }

    async start() {
        if (this.isRunning) return;
        this.isRunning = true;

        try {
            for (const inputData of store.data.inputs) {
                await this.setupHardwareInput(inputData);
            }

            for (const outData of store.data.outputs) {
                await this.createStripContext(outData);
            }

            this.updateAllGains();
        } catch (e) {
            console.error("Audio Engine Start Error:", e);
            this.isRunning = false;
            throw e;
        }
    }

    stop() {
        if (!this.isRunning) return;
        
        this.strips.forEach(strip => {
            if (strip.context) strip.context.close();
        });
        this.strips.clear();
        
        this.hardwareInputs.forEach(hw => {
            if (hw.stream) hw.stream.getTracks().forEach(t => t.stop());
        });
        this.hardwareInputs.clear();
        
        this.directAnalyser = null;
        this.isRunning = false;
    }

    async setupHardwareInput(inputData) {
        if (this.hardwareInputs.has(inputData.id)) return;

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    deviceId: { exact: inputData.deviceId },
                    autoGainControl: false, echoCancellation: false, noiseSuppression: false,
                    channelCount: 2, sampleRate: 48000
                }
            });
            
            this.hardwareInputs.set(inputData.id, {
                stream: stream,
                analyser: null 
            });

        } catch (e) {
            console.warn(`Failed to open input ${inputData.id}:`, e);
        }
    }

    async createStripContext(outputData) {
        const ctx = new (window.AudioContext || window.webkitAudioContext)({
            latencyHint: 'interactive', sampleRate: 48000
        });

        if (outputData.selectedDeviceId && typeof ctx.setSinkId === 'function') {
            try { await ctx.setSinkId(outputData.selectedDeviceId); } catch(e){}
        }

        const hwInputGains = new Map(); 
        const hardwareMixBus = ctx.createGain(); 

        this.hardwareInputs.forEach((hw, inputId) => {
            const source = ctx.createMediaStreamSource(hw.stream);
            
            if (!hw.analyser || hw.analyser.context.state === 'closed') {
                hw.analyser = ctx.createAnalyser();
                hw.analyser.fftSize = 2048;
                source.connect(hw.analyser);
            }

            const gain = ctx.createGain();
            gain.gain.value = 0; 
            source.connect(gain);
            gain.connect(hardwareMixBus);
            
            hwInputGains.set(inputId, gain);
        });

        const directGain = ctx.createGain();
        directGain.gain.value = 0;

        if (!this.directAnalyser || this.directAnalyser.context.state === 'closed') {
            this.directAnalyser = ctx.createAnalyser();
            this.directAnalyser.fftSize = 2048;
            directGain.connect(this.directAnalyser);
        }

        const eqHigh = ctx.createBiquadFilter(); eqHigh.type = "highshelf"; eqHigh.frequency.value = 8000;
        const eqMid = ctx.createBiquadFilter(); eqMid.type = "peaking"; eqMid.frequency.value = 1000; eqMid.Q.value = 1.0;
        const eqLow = ctx.createBiquadFilter(); eqLow.type = "lowshelf"; eqLow.frequency.value = 200;

        eqHigh.gain.value = outputData.eqValues.high;
        eqMid.gain.value = outputData.eqValues.mid;
        eqLow.gain.value = outputData.eqValues.low;

        const masterVol = ctx.createGain();
        masterVol.gain.value = outputData.isMuted ? 0 : outputData.volume;

        const outAnalyser = ctx.createAnalyser();
        outAnalyser.fftSize = 2048;

        hardwareMixBus.connect(eqLow); 
        directGain.connect(eqLow);     

        eqLow.connect(eqMid);
        eqMid.connect(eqHigh);
        eqHigh.connect(masterVol);
        masterVol.connect(outAnalyser);
        outAnalyser.connect(ctx.destination);

        this.strips.set(outputData.id, {
            context: ctx,
            hwInputGains: hwInputGains,
            directGain: directGain,
            masterVol: masterVol,
            eqNodes: { high: eqHigh, mid: eqMid, low: eqLow },
            analyser: outAnalyser,
            nextAudioTime: 0
        });
    }

    removeStripContext(id) {
        const strip = this.strips.get(id);
        if (strip) {
            strip.context.close();
            this.strips.delete(id);
        }
    }

    updateAllGains() {
        this.strips.forEach((stripNodes, outputId) => {
            const ctx = stripNodes.context;
            
            stripNodes.hwInputGains.forEach((gainNode, inputId) => {
                const inputData = store.data.inputs.find(i => i.id === inputId);
                if (inputData) {
                    const isRouted = inputData.routing.includes(outputId);
                    const target = isRouted ? inputData.volume : 0;
                    gainNode.gain.setTargetAtTime(target, ctx.currentTime, 0.02);
                }
            });

            const dirRouteMult = store.directRoutingSet.has(outputId) ? 1 : 0;
            const dirMuteMult = store.data.directMuted ? 0 : 1;
            const dirTarget = store.data.directGain * dirRouteMult * dirMuteMult;
            stripNodes.directGain.gain.setTargetAtTime(dirTarget, ctx.currentTime, 0.02);
        });
    }

    updateStripParams(id) {
        const nodes = this.strips.get(id);
        const data = store.data.outputs.find(o => o.id === id);
        if (!nodes || !data) return;

        const ctx = nodes.context;
        const volTarget = data.isMuted ? 0 : data.volume;
        nodes.masterVol.gain.setTargetAtTime(volTarget, ctx.currentTime, 0.02);

        nodes.eqNodes.high.gain.setTargetAtTime(data.eqValues.high, ctx.currentTime, 0.05);
        nodes.eqNodes.mid.gain.setTargetAtTime(data.eqValues.mid, ctx.currentTime, 0.05);
        nodes.eqNodes.low.gain.setTargetAtTime(data.eqValues.low, ctx.currentTime, 0.05);
    }

    async setStripDevice(id, deviceId) {
        const nodes = this.strips.get(id);
        if (nodes && nodes.context && typeof nodes.context.setSinkId === 'function') {
            try { await nodes.context.setSinkId(deviceId); } catch(e){}
        }
    }

    processDirectAudio(floatArray, sampleRate) {
        if (!this.isRunning) return;
        const frameCount = floatArray.length / 2;
        
        this.strips.forEach((nodes) => {
            const ctx = nodes.context;
            const buffer = ctx.createBuffer(2, frameCount, sampleRate);
            const ch0 = buffer.getChannelData(0);
            const ch1 = buffer.getChannelData(1);

            for (let i = 0; i < frameCount; i++) {
                ch0[i] = floatArray[i * 2];
                ch1[i] = floatArray[i * 2 + 1];
            }

            const src = ctx.createBufferSource();
            src.buffer = buffer;
            src.connect(nodes.directGain);

            const currentTime = ctx.currentTime;
            
            // ユーザー設定のバッファ時間 (最低0.05秒)
            const userBuffer = Math.max(store.data.directBuffer || 0.1, 0.05);
            
            // リセット閾値の緩和: 設定バッファの3倍 + 0.2秒まで許容
            // バッファを大きく取った時に、すぐに「遅延過多」と判定されないようにする
            const resetThreshold = (userBuffer * 3) + 0.2;

            // --- スケジューリング補正ロジック ---

            // 1. Underrun (音が途切れた)
            if (nodes.nextAudioTime < currentTime) {
                // 対策: 途切れた場合、バッファ設定値にさらに 50ms 上乗せして再開する。
                // これにより「ギリギリで再開してすぐまた途切れる」ループを防ぐ。
                nodes.nextAudioTime = currentTime + userBuffer + 0.05;
            }
            
            // 2. Overrun (遅延が大きくなりすぎた)
            // 閾値を超えたら、設定バッファの位置までジャンプして遅延を解消する
            if (nodes.nextAudioTime > currentTime + resetThreshold) {
                nodes.nextAudioTime = currentTime + userBuffer;
            }

            src.start(nodes.nextAudioTime);
            nodes.nextAudioTime += buffer.duration;
        });
    }
}

module.exports = new AudioEngine();