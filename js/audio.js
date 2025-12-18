// js/audio.js
const store = require('./store');

class AudioEngine {
    constructor() {
        this.inputStream = null;
        this.isRunning = false;
        
        this.hardwareAnalyser = null;
        this.directAnalyser = null;
        
        this.strips = new Map();
    }

    async start() {
        if (this.isRunning) return;
        
        try {
            this.inputStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    deviceId: { exact: store.data.inputDeviceId },
                    autoGainControl: false, echoCancellation: false, noiseSuppression: false,
                    channelCount: 2, sampleRate: 48000
                }
            });

            for (const outData of store.data.outputs) {
                await this.createStripContext(outData);
            }

            this.isRunning = true;
            this.updateAllGains();
        } catch (e) {
            console.error("Audio Engine Start Error:", e);
            throw e;
        }
    }

    stop() {
        if (!this.isRunning) return;
        
        this.strips.forEach(strip => {
            if (strip.context) strip.context.close();
        });
        this.strips.clear();
        
        if (this.inputStream) {
            this.inputStream.getTracks().forEach(t => t.stop());
            this.inputStream = null;
        }
        
        this.hardwareAnalyser = null;
        this.directAnalyser = null;
        this.isRunning = false;
    }

    async createStripContext(outputData) {
        const ctx = new (window.AudioContext || window.webkitAudioContext)({
            latencyHint: 'interactive', sampleRate: 48000
        });

        if (outputData.selectedDeviceId && typeof ctx.setSinkId === 'function') {
            try { await ctx.setSinkId(outputData.selectedDeviceId); } catch(e){}
        }

        // --- Hardware Chain ---
        let hardwareGain = null;
        if (this.inputStream) {
            const source = ctx.createMediaStreamSource(this.inputStream);
            
            if (!this.hardwareAnalyser) {
                this.hardwareAnalyser = ctx.createAnalyser();
                this.hardwareAnalyser.fftSize = 2048; // 256 -> 2048 (安定化)
                source.connect(this.hardwareAnalyser);
            }

            hardwareGain = ctx.createGain();
            hardwareGain.gain.value = 0; 
            source.connect(hardwareGain);
        }

        // --- Direct Chain ---
        const directGain = ctx.createGain();
        directGain.gain.value = 0;

        if (!this.directAnalyser) {
            this.directAnalyser = ctx.createAnalyser();
            this.directAnalyser.fftSize = 2048; // 256 -> 2048 (安定化)
            directGain.connect(this.directAnalyser);
        }

        // --- EQ & Output Chain ---
        const eqHigh = ctx.createBiquadFilter(); eqHigh.type = "highshelf"; eqHigh.frequency.value = 8000;
        const eqMid = ctx.createBiquadFilter(); eqMid.type = "peaking"; eqMid.frequency.value = 1000; eqMid.Q.value = 1.0;
        const eqLow = ctx.createBiquadFilter(); eqLow.type = "lowshelf"; eqLow.frequency.value = 200;

        eqHigh.gain.value = outputData.eqValues.high;
        eqMid.gain.value = outputData.eqValues.mid;
        eqLow.gain.value = outputData.eqValues.low;

        const masterVol = ctx.createGain();
        masterVol.gain.value = outputData.isMuted ? 0 : outputData.volume;

        const outAnalyser = ctx.createAnalyser();
        outAnalyser.fftSize = 2048; // 256 -> 2048 (安定化)

        if (hardwareGain) hardwareGain.connect(eqLow);
        directGain.connect(eqLow);

        eqLow.connect(eqMid);
        eqMid.connect(eqHigh);
        eqHigh.connect(masterVol);
        masterVol.connect(outAnalyser);
        outAnalyser.connect(ctx.destination);

        this.strips.set(outputData.id, {
            context: ctx,
            hardwareGain,
            directGain,
            masterVol,
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
        this.strips.forEach((nodes, id) => {
            const ctx = nodes.context;
            
            const hwTarget = store.hardwareRoutingSet.has(id) ? store.data.hardwareGain : 0;
            if (nodes.hardwareGain) {
                nodes.hardwareGain.gain.setTargetAtTime(hwTarget, ctx.currentTime, 0.02);
            }

            const dirRouteMult = store.directRoutingSet.has(id) ? 1 : 0;
            const dirMuteMult = store.data.directMuted ? 0 : 1;
            const dirTarget = store.data.directGain * dirRouteMult * dirMuteMult;
            if (nodes.directGain) {
                nodes.directGain.gain.setTargetAtTime(dirTarget, ctx.currentTime, 0.02);
            }
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
            const SAFE_MARGIN = 0.12;

            if (nodes.nextAudioTime < currentTime) {
                nodes.nextAudioTime = currentTime + SAFE_MARGIN;
            }
            if (nodes.nextAudioTime > currentTime + 0.2) {
                nodes.nextAudioTime = currentTime + SAFE_MARGIN;
            }

            src.start(nodes.nextAudioTime);
            nodes.nextAudioTime += buffer.duration;
        });
    }
}

module.exports = new AudioEngine();