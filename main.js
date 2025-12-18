const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const path = require('path');

let mainWindow;
let tray = null;

// 簡易的なアイコンをBase64で作成（画像ファイル不要で動くようにするため）
// 実際の開発では path.join(__dirname, 'icon.png') などを使用してください
const iconBase64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAADNGUExURQAAAP///wAAAP///wAAAP///wAAAP///wAAAP///wAAAP///wAAAP///wAAAP///wAAAP///wAAAAx0UlUAAAABdFJOUwBA5thmAAAATElEQVQ4y2MwDHgA4gFhIPYFYn9GBgYJIGaCYiA2BWIjIA6Esr2B2AmI08F6vIDYCYqD0Wyg2lA0G8BmQzAbwGYD2GwIZgPYbCAbAAA4wA3p22M2fwAAAABJRU5ErkJggg==';
const trayIcon = nativeImage.createFromDataURL(`data:image/png;base64,${iconBase64}`);

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 600, // EQ追加のため少し幅を広げました
        height: 700,
        title: "UX Audio Router",
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false // 背景でもオーディオを処理し続ける
        }
    });

    mainWindow.loadFile('index.html');

    // ウィンドウが閉じられるとき、アプリを終了せず隠すだけにする（Macらしい挙動）
    mainWindow.on('close', (event) => {
        if (!app.isQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
        return false;
    });
}

function createTray() {
    tray = new Tray(trayIcon);
    tray.setToolTip('UX Audio Router');
    updateTrayMenu(false); // 初期メニュー
}

function updateTrayMenu(isMuted) {
    const contextMenu = Menu.buildFromTemplate([
        { label: 'UX Audio Router', enabled: false },
        { type: 'separator' },
        { 
            label: isMuted ? 'Unmute All' : 'Mute All', 
            click: () => {
                // レンダラープロセス（画面側）に指令を送る
                if (mainWindow) mainWindow.webContents.send('toggle-global-mute');
            }
        },
        { type: 'separator' },
        { 
            label: 'Show Window', 
            click: () => mainWindow.show() 
        },
        { 
            label: 'Quit', 
            click: () => {
                app.isQuitting = true;
                app.quit();
            } 
        }
    ]);
    tray.setContextMenu(contextMenu);
}

app.whenReady().then(() => {
    createWindow();
    createTray();

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
        else mainWindow.show();
    });
});

// IPC受信: 画面側でミュート状態が変わったらトレイの表示も更新する
ipcMain.on('mute-status-changed', (event, isAllMuted) => {
    updateTrayMenu(isAllMuted);
});

app.on('before-quit', () => {
    app.isQuitting = true;
});