// js/store.js
const EventEmitter = require('events');

class Store extends EventEmitter {
    constructor() {
        super();
        this.data = {
            inputDeviceId: 'default',
            hardwareGain: 1.0,
            directGain: 1.0,
            directMuted: false,
            hardwareRouting: [], // SetはJSON化できないため配列で保存
            directRouting: [],
            outputs: []
        };
        
        // 実行時のSetオブジェクト（高速アクセス用）
        this.hardwareRoutingSet = new Set();
        this.directRoutingSet = new Set();
        this.outputIdCounter = 1;
    }

    load() {
        try {
            const saved = JSON.parse(localStorage.getItem('uxAudioRouterSettings'));
            if (saved) {
                // 配列からSetへ復元
                this.hardwareRoutingSet = new Set(saved.hardwareRouting || []);
                this.directRoutingSet = new Set(saved.directRouting || []);
                
                // マージ
                this.data = { ...this.data, ...saved };
                
                // IDカウンターの復元
                if (this.data.outputs.length > 0) {
                    const maxId = Math.max(...this.data.outputs.map(o => o.id));
                    this.outputIdCounter = maxId + 1;
                }
            }
        } catch (e) {
            console.error("Settings load error:", e);
        }
    }

    save() {
        // Setを配列に変換して保存用データを作成
        const saveData = {
            ...this.data,
            hardwareRouting: Array.from(this.hardwareRoutingSet),
            directRouting: Array.from(this.directRoutingSet)
        };
        localStorage.setItem('uxAudioRouterSettings', JSON.stringify(saveData));
    }

    // ヘルパーメソッド
    addOutput(output) {
        this.data.outputs.push(output);
        this.save();
    }

    removeOutput(id) {
        const idx = this.data.outputs.findIndex(o => o.id === id);
        if (idx !== -1) {
            this.data.outputs.splice(idx, 1);
            this.hardwareRoutingSet.delete(id);
            this.directRoutingSet.delete(id);
            this.save();
        }
    }

    toggleRouting(type, id) {
        const set = type === 'hardware' ? this.hardwareRoutingSet : this.directRoutingSet;
        if (set.has(id)) set.delete(id);
        else set.add(id);
        this.save();
        this.emit('routing-changed'); // UIやAudioへ通知
    }
}

module.exports = new Store();