const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const path = require('path');

let mainWindow;
let tray;
let isQuitting = false;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            // ループは手動で止めるので、OSによる強制停止は防ぐ（音切れ防止）
            backgroundThrottling: false 
        },
        icon: path.join(__dirname, 'icon.png')
    });

    mainWindow.loadFile('index.html');

    // --- 閉じるボタン（×）の挙動 ---
    mainWindow.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault(); // アプリ終了をキャンセル

            // 1. レンダラーのループを止める命令を送る
            mainWindow.webContents.send('window-hide');
            
            // 2. 少し待ってから隠す（メッセージが届くのを確実にするため）
            // ※即座に隠すとレンダラーが停止処理をする前にサスペンドされることがあるため
            setTimeout(() => {
                mainWindow.hide();
                // 3. macOSならDockからも消す
                if (process.platform === 'darwin') {
                    app.dock.hide();
                }
            }, 50);
        }
        return false;
    });

    // --- 表示された時の挙動 ---
    mainWindow.on('show', () => {
        // macOSならDockを表示に戻す
        if (process.platform === 'darwin') {
            app.dock.show();
        }
        mainWindow.webContents.send('window-show');
    });
}

function createTray() {
    const iconPath = path.join(__dirname, 'icon.png');
    let trayIcon = nativeImage.createFromPath(iconPath);
    trayIcon = trayIcon.resize({ width: 20, height: 20 });
    
    if (process.platform === 'darwin') {
        trayIcon.setTemplateImage(true);
    }
    
    tray = new Tray(trayIcon);
    tray.setToolTip('UX Audio Router');

    const contextMenu = Menu.buildFromTemplate([
        { 
            label: 'Show Window', 
            click: () => showWindow()
        },
        { type: 'separator' },
        { 
            label: 'Quit', 
            click: () => {
                isQuitting = true;
                app.quit();
            } 
        }
    ]);
    tray.setContextMenu(contextMenu);

    // トレイアイコンクリック時の挙動
    tray.on('click', () => {
        if (mainWindow.isVisible()) {
            // 隠す処理 (closeイベントと同じフローを通すため close() を呼ぶ)
            mainWindow.close(); 
        } else {
            showWindow();
        }
    });
}

// ウィンドウを表示する共通関数
function showWindow() {
    if (process.platform === 'darwin') {
        app.dock.show().then(() => {
            mainWindow.show();
        });
    } else {
        mainWindow.show();
    }
    // ループ再開命令
    mainWindow.webContents.send('window-show');
}

// 多重起動防止
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            showWindow();
            mainWindow.focus();
        }
    });

    app.whenReady().then(() => {
        createWindow();
        createTray();
    });
}

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
});