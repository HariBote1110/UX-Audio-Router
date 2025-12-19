// js/store.js
const EventEmitter = require('events');

class Store extends EventEmitter {
    constructor() {
        super();
        this.data = {
            // 複数のハードウェア入力を管理する配列
            // { id, deviceId, volume, isMuted, routing: Set(outputIds) }
            inputs: [],
            
            // Direct Link (UX Music) は特殊なので別枠のまま（シンプル化のため）
            directGain: 1.0,
            directMuted: false,
            directRouting: [], // 配列で保存
            
            outputs: []
        };
        
        // 実行時の高速アクセス用
        this.directRoutingSet = new Set();
        
        // IDカウンター
        this.inputIdCounter = 1;
        this.outputIdCounter = 1;
    }

    load() {
        try {
            const saved = JSON.parse(localStorage.getItem('uxAudioRouterSettings'));
            if (saved) {
                // --- Migration: 古いデータ形式からの変換 ---
                if (saved.hardwareGain !== undefined || saved.inputDeviceId) {
                    // 旧データをInput1として移行
                    const oldRouting = new Set(saved.hardwareRouting || []);
                    this.data.inputs = [{
                        id: 1,
                        deviceId: saved.inputDeviceId || 'default',
                        volume: saved.hardwareGain || 1.0,
                        isMuted: false,
                        routing: Array.from(oldRouting) // Set -> Array
                    }];
                    this.inputIdCounter = 2;
                } else if (saved.inputs) {
                    this.data.inputs = saved.inputs;
                    // カウンター復元
                    if (this.data.inputs.length > 0) {
                        this.inputIdCounter = Math.max(...this.data.inputs.map(i => i.id)) + 1;
                    }
                } else {
                    // 初期状態
                    this.addInput(); 
                }

                // Direct Input
                if (saved.directGain !== undefined) this.data.directGain = saved.directGain;
                if (saved.directMuted !== undefined) this.data.directMuted = saved.directMuted;
                this.directRoutingSet = new Set(saved.directRouting || []);

                // Outputs
                this.data.outputs = saved.outputs || [];
                // EQ互換性
                if (this.data.outputs) {
                    this.data.outputs.forEach(out => {
                        if (!out.eqValues) out.eqValues = out.eq || { high: 0, mid: 0, low: 0 };
                    });
                    if (this.data.outputs.length > 0) {
                        this.outputIdCounter = Math.max(...this.data.outputs.map(o => o.id)) + 1;
                    }
                } else {
                    this.addOutput();
                }
            } else {
                // 初回起動
                this.addInput();
                this.addOutput();
                // デフォルトルーティング: Input1 -> Output1, Direct -> Output1
                this.toggleRouting('hardware', 1, 1);
                this.toggleRouting('direct', null, 1);
            }
        } catch (e) {
            console.error("Settings load error:", e);
            // エラー時は初期化
            this.addInput();
            this.addOutput();
        }
    }

    save() {
        // Setを配列に変換して保存
        // InputごとのRouting Setも配列化する必要があるが、
        // 実行中は data.inputs 内の routing を直接 Set に変換せず配列のまま扱う設計にする（簡易化）
        // ただし UI/Audio 側で Set として扱いたい場合は変換が必要。
        // 今回は「store.data内は常に最新の配列」として保つ方針でいく。

        const saveData = {
            inputs: this.data.inputs,
            directGain: this.data.directGain,
            directMuted: this.data.directMuted,
            directRouting: Array.from(this.directRoutingSet),
            outputs: this.data.outputs.map(out => ({ ...out, eq: out.eqValues }))
        };
        localStorage.setItem('uxAudioRouterSettings', JSON.stringify(saveData));
    }

    // --- Input Management ---
    addInput() {
        const id = this.getAvailableId(this.data.inputs);
        this.data.inputs.push({
            id: id,
            deviceId: 'default',
            volume: 1.0,
            isMuted: false,
            routing: [] // 出力IDの配列
        });
        this.data.inputs.sort((a, b) => a.id - b.id);
        this.save();
        return id;
    }

    removeInput(id) {
        const idx = this.data.inputs.findIndex(i => i.id === id);
        if (idx !== -1) {
            this.data.inputs.splice(idx, 1);
            this.save();
        }
    }

    // --- Output Management ---
    addOutput() {
        const id = this.getAvailableId(this.data.outputs);
        this.data.outputs.push({
            id: id,
            selectedDeviceId: '',
            volume: 1.0,
            isMuted: false,
            eqValues: { high: 0, mid: 0, low: 0 }
        });
        this.data.outputs.sort((a, b) => a.id - b.id);
        this.save();
        return id;
    }

    removeOutput(id) {
        const idx = this.data.outputs.findIndex(o => o.id === id);
        if (idx !== -1) {
            this.data.outputs.splice(idx, 1);
            // Directルーティングから削除
            this.directRoutingSet.delete(id);
            // 全Inputのルーティングから削除
            this.data.inputs.forEach(input => {
                input.routing = input.routing.filter(rId => rId !== id);
            });
            this.save();
        }
    }

    // --- Routing ---
    // type: 'hardware' | 'direct'
    // inputId: hardwareの場合のID (directならnull)
    // outputId: ターゲット
    toggleRouting(type, inputId, outputId) {
        if (type === 'direct') {
            if (this.directRoutingSet.has(outputId)) this.directRoutingSet.delete(outputId);
            else this.directRoutingSet.add(outputId);
        } else {
            const input = this.data.inputs.find(i => i.id === inputId);
            if (input) {
                const idx = input.routing.indexOf(outputId);
                if (idx !== -1) input.routing.splice(idx, 1);
                else input.routing.push(outputId);
            }
        }
        this.save();
        this.emit('routing-changed');
    }

    isRouted(type, inputId, outputId) {
        if (type === 'direct') return this.directRoutingSet.has(outputId);
        const input = this.data.inputs.find(i => i.id === inputId);
        return input ? input.routing.includes(outputId) : false;
    }

    // ID生成
    getAvailableId(list) {
        const existingIds = new Set(list.map(o => o.id));
        let id = 1;
        while (existingIds.has(id)) id++;
        return id;
    }
}

module.exports = new Store();