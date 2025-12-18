// js/app.js
const store = require('./js/store');
const audio = require('./js/audio');
const ipc = require('./js/ipc');
const ui = require('./js/ui');

async function main() {
    console.log("Starting UX Audio Router...");
    
    // 1. 設定読み込み
    store.load();

    // 2. UI初期化
    ui.init();
    
    // 3. IPCサーバー起動（UI更新コールバックを設定）
    ipc.onStatusChange = (connected, rate) => {
        ui.updateStatusDot(connected, rate);
    };
    ipc.start();
    
    // 4. オーディオエンジン自動スタート
    try {
        await audio.start();
        ui.updateStartBtn(true);
        console.log("Audio Engine Started.");
    } catch (e) {
        console.warn("Auto-start failed (Permissions?):", e);
    }
}

// 起動
main();