// js/ipc.js
const net = require('net');
const fs = require('fs');
const audio = require('./audio');

class DirectServer {
    constructor() {
        this.server = null;
        this.socket = null;
        this.isHeaderReceived = false;
        this.headerBuffer = Buffer.alloc(0);
        this.sampleRate = 44100;

        // ステータス変更時のコールバック
        this.onStatusChange = null;
    }

    start() {
        const isWin = process.platform === 'win32';
        const SOCKET_PATH = isWin ? '\\\\.\\pipe\\ux_audio_router_pipe' : '/tmp/ux_audio_router.sock';

        if (!isWin && fs.existsSync(SOCKET_PATH)) { try { fs.unlinkSync(SOCKET_PATH); } catch (e) { } }

        this.server = net.createServer((socket) => {
            console.log('UX Music Connected');
            this.socket = socket;
            this.isHeaderReceived = false;
            this.headerBuffer = Buffer.alloc(0);
            this.reportStatus(false); // ハンドシェイク前

            socket.on('data', (buffer) => {
                if (!this.isHeaderReceived) {
                    this.handleHandshake(buffer, socket);
                } else {
                    this.handleAudioData(buffer);
                }
            });

            socket.on('end', () => {
                console.log('UX Music Disconnected');
                this.reportStatus(false);
                this.socket = null;
            });

            socket.on('error', (err) => {
                this.reportStatus(false);
            });
        });

        this.server.listen(SOCKET_PATH, () => {
            console.log(`IPC Server listening on ${SOCKET_PATH}`);
        });
    }

    handleHandshake(buffer, socket) {
        this.headerBuffer = Buffer.concat([this.headerBuffer, buffer]);
        if (this.headerBuffer.length > 1024) this.headerBuffer = this.headerBuffer.slice(-1024); // Limit memory usage

        if (this.headerBuffer.length >= 8) {
            const magic = this.headerBuffer.slice(0, 4).toString();
            if (magic === 'UXD1') {
                this.sampleRate = this.headerBuffer.readUInt32LE(4);
                console.log(`Handshake OK. Rate: ${this.sampleRate}Hz`);
                this.isHeaderReceived = true;
                this.reportStatus(true, this.sampleRate);

                const remaining = this.headerBuffer.slice(8);
                if (remaining.length > 0) this.handleAudioData(remaining);
            } else {
                console.error("Invalid Header");
                socket.destroy();
            }
            this.headerBuffer = Buffer.alloc(0);
        }
    }

    handleAudioData(buffer) {
        // 8バイト整列
        if (buffer.length % 8 !== 0) {
            const alignedLen = Math.floor(buffer.length / 8) * 8;
            buffer = buffer.slice(0, alignedLen);
        }
        if (buffer.length === 0) return;

        const floatArray = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);

        // AudioEngineへ処理を委譲
        audio.processDirectAudio(floatArray, this.sampleRate);
    }

    reportStatus(connected, rate) {
        if (this.onStatusChange) this.onStatusChange(connected, rate);
    }
}

module.exports = new DirectServer();