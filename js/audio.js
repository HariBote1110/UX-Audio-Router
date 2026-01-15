// js/audio.js
const store = require('./store');

// --- Ring Buffer Implementation ---
class RingBuffer {
    constructor(size, channels) {
        this.size = size;
        this.channels = channels;
        this.buffers = [];
        for (let i = 0; i < channels; i++) {
            this.buffers[i] = new Float32Array(size);
        }
        this.writePtr = 0;
        this.readPtr = 0;
        this.available = 0; 
    }

    push(floatArray, inputChannels) {
        const samplesPerCh = floatArray.length / inputChannels;
        const copyCh = Math.min(this.channels, inputChannels);

        for (let i = 0; i < samplesPerCh; i++) {
            for (let ch = 0; ch < copyCh; ch++) {
                this.buffers[ch][this.writePtr] = floatArray[i * inputChannels + ch];
            }
            this.writePtr = (this.writePtr + 1) % this.size;
            
            if (this.available < this.size) {
                this.available++;
            } else {
                this.readPtr = (this.readPtr + 1) % this.size;
            }
        }
    }

    pop(outputBuffers, count) {
        if (this.available < count) return false;

        for (let i = 0; i < count; i++) {
            for (let ch = 0; ch < this.channels; ch++) {
                outputBuffers[ch][i] = this.buffers[ch][this.readPtr];
            }
            this.readPtr = (this.readPtr + 1) % this.size;
        }
        this.available -= count;
        return true;
    }
    
    clear() {
        this.readPtr = 0;
        this.writePtr = 0;
        this.available = 0;
    }
}

class AudioEngine {
    constructor() {
        this.hardwareInputs = new Map();
        this.isRunning = false;
        this.directAnalyser = null;
        this.strips = new Map();
        this.ringBuffer = new RingBuffer(48000 * 2, 2); 
        this.schedulerInterval = null;
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
            this.schedulerInterval = setInterval(() => this.scheduleAudio(), 20);

        } catch (e) {
            console.error("Audio Engine Start Error:", e);
            this.isRunning = false;
            throw e;
        }
    }

    stop() {
        if (!this.isRunning) return;
        
        if (this.schedulerInterval) {
            clearInterval(this.schedulerInterval);
            this.schedulerInterval = null;
        }

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

        const hardwareMixBus = ctx.createGain(); 
        const hwInputGains = new Map(); 

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

        // --- Effects Chain ---
        
        // 1. 10-Band Graphic EQ (31Hz ~ 16kHz)
        const eqNodes = [];
        const gains = outputData.eqGains || new Array(10).fill(0);
        
        store.eqFrequencies.forEach((freq, i) => {
            const filter = ctx.createBiquadFilter();
            filter.type = 'peaking';
            filter.frequency.value = freq;
            filter.Q.value = 1.4; // 1オクターブ帯域幅に最適化
            filter.gain.value = gains[i] || 0;
            eqNodes.push(filter);
        });

        // 2. Compressor
        const compressor = ctx.createDynamicsCompressor();
        this.applyCompressorSettings(compressor, outputData.compressor);

        // 3. Delay
        const delayNode = ctx.createDelay(1.0); 
        delayNode.delayTime.value = (outputData.delayMs || 0) / 1000;

        // 4. Master
        const masterVol = ctx.createGain();
        masterVol.gain.value = outputData.isMuted ? 0 : outputData.volume;
        const outAnalyser = ctx.createAnalyser();
        outAnalyser.fftSize = 2048;

        // --- Connections ---
        // Inputs -> EQ[0] -> ... -> EQ[9] -> Compressor -> Delay -> Master
        
        hardwareMixBus.connect(eqNodes[0]);
        directGain.connect(eqNodes[0]);

        // Chain EQ nodes
        for (let i = 0; i < eqNodes.length - 1; i++) {
            eqNodes[i].connect(eqNodes[i+1]);
        }
        
        const eqLast = eqNodes[eqNodes.length - 1];
        eqLast.connect(compressor);
        compressor.connect(delayNode);
        delayNode.connect(masterVol);
        masterVol.connect(outAnalyser);
        outAnalyser.connect(ctx.destination);

        this.strips.set(outputData.id, {
            context: ctx,
            hwInputGains: hwInputGains,
            directGain: directGain,
            masterVol: masterVol,
            eqNodes: eqNodes, // Array of BiquadFilterNode
            compressor: compressor,
            delayNode: delayNode,
            analyser: outAnalyser,
            nextAudioTime: 0
        });
    }

    applyCompressorSettings(node, settings) {
        if (!settings || !settings.enabled) {
            node.threshold.value = 0;
            node.ratio.value = 1; 
        } else {
            node.threshold.value = settings.threshold;
            node.ratio.value = settings.ratio;
            node.attack.value = settings.attack;
            node.release.value = settings.release;
        }
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

        // Update EQ Gains (10 bands)
        if (data.eqGains && nodes.eqNodes.length === 10) {
            data.eqGains.forEach((gain, i) => {
                const filter = nodes.eqNodes[i];
                filter.gain.setTargetAtTime(gain, ctx.currentTime, 0.05);
            });
        }

        nodes.delayNode.delayTime.setTargetAtTime((data.delayMs || 0) / 1000, ctx.currentTime, 0.05);
        this.applyCompressorSettings(nodes.compressor, data.compressor);
    }

    async setStripDevice(id, deviceId) {
        const nodes = this.strips.get(id);
        if (nodes && nodes.context && typeof nodes.context.setSinkId === 'function') {
            try { await nodes.context.setSinkId(deviceId); } catch(e){}
        }
    }

    processDirectAudio(floatArray, sampleRate, channels) {
        if (!this.isRunning) return;
        this.ringBuffer.push(floatArray, channels);
    }

    scheduleAudio() {
        if (!this.isRunning) return;

        const CHUNK_SIZE = 1024;
        const userBufferSec = Math.max(store.data.directBuffer || 0.1, 0.05);

        while (this.ringBuffer.available >= CHUNK_SIZE) {
            const tempBuffers = [new Float32Array(CHUNK_SIZE), new Float32Array(CHUNK_SIZE)];
            this.ringBuffer.pop(tempBuffers, CHUNK_SIZE);
            
            this.strips.forEach((nodes) => {
                const ctx = nodes.context;
                
                if (nodes.nextAudioTime < ctx.currentTime) {
                    nodes.nextAudioTime = ctx.currentTime + userBufferSec;
                    if (store.data.directBuffer < 0.5) store.data.directBuffer += 0.001; 
                }

                const buffer = ctx.createBuffer(2, CHUNK_SIZE, 48000);
                buffer.copyToChannel(tempBuffers[0], 0);
                buffer.copyToChannel(tempBuffers[1], 1);

                const src = ctx.createBufferSource();
                src.buffer = buffer;
                src.connect(nodes.directGain);
                src.start(nodes.nextAudioTime);
                
                nodes.nextAudioTime += buffer.duration;
            });
        }
    }
}

module.exports = new AudioEngine();