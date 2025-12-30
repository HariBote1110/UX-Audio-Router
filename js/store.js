// js/store.js
const EventEmitter = require('events');

class Store extends EventEmitter {
    constructor() {
        super();
        this.data = {
            inputs: [],
            directGain: 1.0,
            directMuted: false,
            directRouting: [],
            directBuffer: 0.1, // デフォルト 0.1秒
            outputs: []
        };
        
        this.hardwareRoutingSet = new Set();
        this.directRoutingSet = new Set();
        this.inputIdCounter = 1;
        this.outputIdCounter = 1;
    }

    load() {
        try {
            const saved = JSON.parse(localStorage.getItem('uxAudioRouterSettings'));
            if (saved) {
                // Migration logic
                if (saved.inputs) {
                    this.data.inputs = saved.inputs;
                    if (this.data.inputs.length > 0) {
                        this.inputIdCounter = Math.max(...this.data.inputs.map(i => i.id)) + 1;
                    }
                } else if (saved.hardwareGain !== undefined) {
                     // Old format migration
                     const oldRouting = new Set(saved.hardwareRouting || []);
                     this.data.inputs = [{
                        id: 1, deviceId: saved.inputDeviceId || 'default', volume: saved.hardwareGain || 1.0, isMuted: false, routing: Array.from(oldRouting)
                     }];
                     this.inputIdCounter = 2;
                } else {
                    this.addInput();
                }

                if (saved.directGain !== undefined) this.data.directGain = saved.directGain;
                if (saved.directMuted !== undefined) this.data.directMuted = saved.directMuted;
                if (saved.directBuffer !== undefined) this.data.directBuffer = saved.directBuffer;
                
                this.directRoutingSet = new Set(saved.directRouting || []);

                this.data.outputs = saved.outputs || [];
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
                this.addInput();
                this.addOutput();
                this.toggleRouting('hardware', 1, 1);
                this.toggleRouting('direct', null, 1);
            }
        } catch (e) {
            console.error("Settings load error:", e);
            this.addInput();
            this.addOutput();
        }
    }

    save() {
        const saveData = {
            inputs: this.data.inputs,
            directGain: this.data.directGain,
            directMuted: this.data.directMuted,
            directRouting: Array.from(this.directRoutingSet),
            directBuffer: this.data.directBuffer,
            outputs: this.data.outputs.map(out => ({ ...out, eq: out.eqValues }))
        };
        localStorage.setItem('uxAudioRouterSettings', JSON.stringify(saveData));
    }

    // --- Input Management ---
    addInput() {
        const id = this.getAvailableId(this.data.inputs);
        this.data.inputs.push({ id: id, deviceId: 'default', volume: 1.0, isMuted: false, routing: [] });
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
        this.data.outputs.push({ id: id, selectedDeviceId: '', volume: 1.0, isMuted: false, eqValues: { high: 0, mid: 0, low: 0 } });
        this.data.outputs.sort((a, b) => a.id - b.id);
        this.save();
        return id;
    }

    removeOutput(id) {
        const idx = this.data.outputs.findIndex(o => o.id === id);
        if (idx !== -1) {
            this.data.outputs.splice(idx, 1);
            this.directRoutingSet.delete(id);
            this.data.inputs.forEach(input => {
                input.routing = input.routing.filter(rId => rId !== id);
            });
            this.save();
        }
    }

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

    getAvailableId(list) {
        const existingIds = new Set(list.map(o => o.id));
        let id = 1;
        while (existingIds.has(id)) id++;
        return id;
    }
}

module.exports = new Store();