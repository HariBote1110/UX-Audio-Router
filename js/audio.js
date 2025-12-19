// js/audio.js
const store = require('./store');

class AudioEngine {
    constructor() {
        // Hardware Inputs: Map<id, { stream, source, analyser, gainNode }>
        // ※ gainNodeはここでは作らず、Output接続時に作るのが一般的だが、
        // アナライザー用にソース直結が必要。
        this.hardwareInputs = new Map();
        
        this.isRunning = false;
        this.directAnalyser = null;
        
        // Output Strips: Map<id, { context, inputGains: Map<inputId, GainNode>, ... }>
        this.strips = new Map();
    }

    async start() {
        if (this.isRunning) return;
        this.isRunning = true;

        try {
            // 1. 全ハードウェア入力を初期化
            for (const inputData of store.data.inputs) {
                await this.setupHardwareInput(inputData);
            }

            // 2. 全出力ストリップを構築
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
        
        // Outputs破棄
        this.strips.forEach(strip => {
            if (strip.context) strip.context.close();
        });
        this.strips.clear();
        
        // Inputs破棄
        this.hardwareInputs.forEach(hw => {
            if (hw.stream) hw.stream.getTracks().forEach(t => t.stop());
        });
        this.hardwareInputs.clear();
        
        this.directAnalyser = null;
        this.isRunning = false;
    }

    // 個別のハードウェア入力をセットアップ（再利用可能）
    async setupHardwareInput(inputData) {
        // 既に存在する場合は何もしない（変更時はrestartInputを呼ぶ）
        if (this.hardwareInputs.has(inputData.id)) return;

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    deviceId: { exact: inputData.deviceId },
                    autoGainControl: false, echoCancellation: false, noiseSuppression: false,
                    channelCount: 2, sampleRate: 48000
                }
            });

            // Analyser用にダミーコンテキストを作るか、最初の出力コンテキストを待つか...
            // ここではシンプルに、後で出力ストリップ作成時にこのストリームを使う設計にする。
            // ただし、メーター表示のために Analyser だけは早めに欲しい。
            // -> createStripContext 内で、このストリームをソースとして使う。
            
            this.hardwareInputs.set(inputData.id, {
                stream: stream,
                analyser: null // OutputContext作成時にアタッチする
            });

        } catch (e) {
            console.warn(`Failed to open input ${inputData.id}:`, e);
        }
    }

    async restartInput(inputData) {
        // 既存を削除
        const old = this.hardwareInputs.get(inputData.id);
        if (old && old.stream) {
            old.stream.getTracks().forEach(t => t.stop());
        }
        this.hardwareInputs.delete(inputData.id);
        
        // 再作成
        await this.setupHardwareInput(inputData);
        
        // 全出力ストリップの接続を更新（大変なので、エンジン全体リスタート推奨だが、頑張るならここ）
        // 今回は簡易的に「デバイス変更時はエンジン全再起動」をUI側で行う方針とする。
    }

    async createStripContext(outputData) {
        const ctx = new (window.AudioContext || window.webkitAudioContext)({
            latencyHint: 'interactive', sampleRate: 48000
        });

        if (outputData.selectedDeviceId && typeof ctx.setSinkId === 'function') {
            try { await ctx.setSinkId(outputData.selectedDeviceId); } catch(e){}
        }

        // --- Hardware Inputs Mixing ---
        // この出力ストリップ専用の各入力ゲインノードを作成
        const hwInputGains = new Map(); // <inputId, GainNode>
        
        // ミックス用ノード（全ハードウェア入力がここに集まる）
        const hardwareMixBus = ctx.createGain(); 

        this.hardwareInputs.forEach((hw, inputId) => {
            const source = ctx.createMediaStreamSource(hw.stream);
            
            // Global Analyser (最初の1回だけ作成して共有、または各Contextで作成)
            // AnalyserはContextに依存するため、ストリップごとに作る必要があるが、
            // UIには「入力メーター」として1つだけ表示したい。
            // -> 一番若いIDの出力ストリップのAnalyserを採用する等の工夫が必要。
            // ここでは「各入力オブジェクトにAnalyser参照を持たせる」方式で、上書きしていく。
            if (!hw.analyser || hw.analyser.context.state === 'closed') {
                hw.analyser = ctx.createAnalyser();
                hw.analyser.fftSize = 2048;
                source.connect(hw.analyser);
            }

            const gain = ctx.createGain();
            gain.gain.value = 0; // ルーティングとボリュームは updateAllGains で適用
            source.connect(gain);
            gain.connect(hardwareMixBus);
            
            hwInputGains.set(inputId, gain);
        });

        // --- Direct Input Chain ---
        const directGain = ctx.createGain();
        directGain.gain.value = 0;

        if (!this.directAnalyser || this.directAnalyser.context.state === 'closed') {
            this.directAnalyser = ctx.createAnalyser();
            this.directAnalyser.fftSize = 2048;
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
        outAnalyser.fftSize = 2048;

        // Connect
        hardwareMixBus.connect(eqLow); // 全ハードウェア入力ミックス -> EQ
        directGain.connect(eqLow);     // Direct入力 -> EQ

        eqLow.connect(eqMid);
        eqMid.connect(eqHigh);
        eqHigh.connect(masterVol);
        masterVol.connect(outAnalyser);
        outAnalyser.connect(ctx.destination);

        this.strips.set(outputData.id, {
            context: ctx,
            hwInputGains: hwInputGains, // Map<inputId, GainNode>
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
            
            // 1. Hardware Inputs Gains
            // 各入力について、ルーティング確認 -> Gain計算
            stripNodes.hwInputGains.forEach((gainNode, inputId) => {
                // Storeから入力設定を取得
                const inputData = store.data.inputs.find(i => i.id === inputId);
                if (inputData) {
                    // ルーティングされているか？
                    const isRouted = inputData.routing.includes(outputId);
                    const target = isRouted ? inputData.volume : 0;
                    gainNode.gain.setTargetAtTime(target, ctx.currentTime, 0.02);
                }
            });

            // 2. Direct Input Gain
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
            const SAFE_MARGIN = 0.12;

            if (nodes.nextAudioTime < currentTime) nodes.nextAudioTime = currentTime + SAFE_MARGIN;
            if (nodes.nextAudioTime > currentTime + 0.2) nodes.nextAudioTime = currentTime + SAFE_MARGIN;

            src.start(nodes.nextAudioTime);
            nodes.nextAudioTime += buffer.duration;
        });
    }
}

module.exports = new AudioEngine();