'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const http = require('http');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

class RuntimeBridgeManager {
    constructor(settings = {}) {
        this.clients = new Map();
        this.pendingCommands = new Map();
        this.pollTimeoutMs = 5000;
        this.commandTimeoutMs = 10000;
        this.staleClientMs = 60000;
        this.port = Number(settings.port) || 3300;
        this.minimumBridgeVersion = '0.1.19';
        this.activeClientId = null;
    }

    getBridgeScript() {
        return fs.readFileSync(path.join(__dirname, 'bridge.js'), 'utf8');
    }

    getBridgeUrl(args = {}) {
        const host = args.host || '127.0.0.1';
        const port = Number(args.port) || this.port || 3300;
        return `http://${host}:${port}/runtime/bridge.js`;
    }

    getDefaultPreviewUrl(args = {}) {
        if (args.previewUrl) {
            return String(args.previewUrl);
        }
        const previewHost = args.previewHost || '127.0.0.1';
        const previewPort = Number(args.previewPort) || 7456;
        return `http://${previewHost}:${previewPort}/`;
    }

    getInjectedPreviewUrl(args = {}) {
        return this.getDefaultPreviewUrl(args);
    }

    openExternalUrl(url) {
        const platform = process.platform;
        const command = platform === 'win32'
            ? 'cmd'
            : platform === 'darwin'
                ? 'open'
                : 'xdg-open';
        const args = platform === 'win32'
            ? ['/c', 'start', '', url]
            : [url];
        const child = childProcess.spawn(command, args, {
            detached: true,
            stdio: 'ignore',
            windowsHide: true
        });
        child.unref();
    }

    openInjectedPreview(args = {}) {
        const injectedPreviewUrl = this.getInjectedPreviewUrl(args);
        const previewUrl = this.getDefaultPreviewUrl(args);
        try {
            this.openExternalUrl(injectedPreviewUrl);
            return {
                success: true,
                message: '已在外部浏览器打开自动注入预览页。',
                data: {
                    injectedPreviewUrl,
                    previewUrl,
                    bridgeUrl: this.getBridgeUrl(args)
                }
            };
        } catch (error) {
            return {
                success: false,
                message: '打开外部浏览器失败。',
                error: error && error.message ? error.message : String(error),
                data: {
                    injectedPreviewUrl,
                    previewUrl,
                    bridgeUrl: this.getBridgeUrl(args)
                }
            };
        }
    }

    findBrowserExecutable() {
        if (process.platform !== 'win32') {
            return null;
        }
        const candidates = [
            path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
        ];
        return candidates.find((item) => item && fs.existsSync(item)) || null;
    }

    launchDebugBrowser(previewUrl, args = {}) {
        const debugPort = Number(args.debugPort) || 9231;
        const userDataDir = args.userDataDir || path.join(os.tmpdir(), `cocos-mcp-runtime-browser-${debugPort}`);
        const executable = args.browserPath || this.findBrowserExecutable();
        const browserArgs = [
            `--remote-debugging-port=${debugPort}`,
            `--user-data-dir=${userDataDir}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--new-window',
            previewUrl
        ];
        if (executable) {
            const child = childProcess.spawn(executable, browserArgs, {
                detached: true,
                stdio: 'ignore',
                windowsHide: false
            });
            child.unref();
            return { debugPort, userDataDir, executable, launchedBy: 'executable' };
        }
        if (process.platform === 'win32') {
            const child = childProcess.spawn('cmd', ['/c', 'start', '', 'msedge', ...browserArgs], {
                detached: true,
                stdio: 'ignore',
                windowsHide: false
            });
            child.unref();
            return { debugPort, userDataDir, executable: 'msedge', launchedBy: 'cmd' };
        }
        this.openExternalUrl(previewUrl);
        return { debugPort, userDataDir, executable: '', launchedBy: 'fallback-open', fallback: true };
    }

    httpGetJson(url, timeoutMs = 2000) {
        return new Promise((resolve, reject) => {
            const req = http.get(url, (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                    } catch (error) {
                        reject(error);
                    }
                });
            });
            req.on('error', reject);
            req.setTimeout(timeoutMs, () => req.destroy(new Error('CDP HTTP request timed out')));
        });
    }

    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async findCdpPage(debugPort, previewUrl, timeoutMs = 12000) {
        const deadline = Date.now() + timeoutMs;
        const previewPrefix = String(previewUrl || '').replace(/[?#].*$/, '').replace(/\/$/, '');
        let lastPages = [];
        while (Date.now() < deadline) {
            try {
                const pages = await this.httpGetJson(`http://127.0.0.1:${debugPort}/json/list`, 1500);
                lastPages = Array.isArray(pages) ? pages : [];
                const page = lastPages.find((item) => {
                    const url = String(item && item.url || '').replace(/\/$/, '');
                    return item && item.type === 'page' && url.startsWith(previewPrefix) && item.webSocketDebuggerUrl;
                }) || lastPages.find((item) => item && item.type === 'page' && item.webSocketDebuggerUrl);
                if (page) {
                    return page;
                }
            } catch (_) {
            }
            await this.sleep(300);
        }
        throw new Error(`未找到可注入的浏览器预览页，已扫描 ${lastPages.length} 个调试页面。`);
    }

    tryReadWebSocketFrame(buffer) {
        if (!buffer || buffer.length < 2) {
            return null;
        }
        const opcode = buffer[0] & 0x0f;
        let offset = 2;
        let length = buffer[1] & 0x7f;
        if (length === 126) {
            if (buffer.length < 4) return null;
            length = buffer.readUInt16BE(2);
            offset = 4;
        } else if (length === 127) {
            if (buffer.length < 10) return null;
            length = Number(buffer.readBigUInt64BE(2));
            offset = 10;
        }
        const masked = !!(buffer[1] & 0x80);
        let mask = null;
        if (masked) {
            if (buffer.length < offset + 4) return null;
            mask = buffer.slice(offset, offset + 4);
            offset += 4;
        }
        if (buffer.length < offset + length) {
            return null;
        }
        const payload = Buffer.from(buffer.slice(offset, offset + length));
        if (mask) {
            for (let index = 0; index < payload.length; index++) {
                payload[index] ^= mask[index % 4];
            }
        }
        if (opcode === 8) {
            return { text: '', rest: buffer.slice(offset + length), closed: true };
        }
        return { text: payload.toString('utf8'), rest: buffer.slice(offset + length) };
    }

    createWebSocketTextFrame(text) {
        const payload = Buffer.from(text, 'utf8');
        const mask = crypto.randomBytes(4);
        let header;
        if (payload.length < 126) {
            header = Buffer.from([0x81, 0x80 | payload.length]);
        } else if (payload.length < 65536) {
            header = Buffer.alloc(4);
            header[0] = 0x81;
            header[1] = 0x80 | 126;
            header.writeUInt16BE(payload.length, 2);
        } else {
            header = Buffer.alloc(10);
            header[0] = 0x81;
            header[1] = 0x80 | 127;
            header.writeBigUInt64BE(BigInt(payload.length), 2);
        }
        const masked = Buffer.alloc(payload.length);
        for (let index = 0; index < payload.length; index++) {
            masked[index] = payload[index] ^ mask[index % 4];
        }
        return Buffer.concat([header, mask, masked]);
    }

    async cdpEvaluate(webSocketUrl, expression, timeoutMs = 8000) {
        const url = new URL(webSocketUrl);
        const key = crypto.randomBytes(16).toString('base64');
        const socket = net.connect(Number(url.port) || 80, url.hostname);
        socket.setTimeout(timeoutMs);
        let buffer = Buffer.alloc(0);
        let connected = false;
        const waitForFrame = () => new Promise((resolve, reject) => {
            const cleanup = () => {
                socket.off('data', onData);
                socket.off('error', onError);
                socket.off('timeout', onTimeout);
            };
            const onError = (error) => {
                cleanup();
                reject(error);
            };
            const onTimeout = () => {
                cleanup();
                reject(new Error('CDP WebSocket timed out'));
            };
            const onData = (chunk) => {
                buffer = Buffer.concat([buffer, chunk]);
                if (!connected) {
                    const text = buffer.toString('utf8');
                    const headerEnd = text.indexOf('\r\n\r\n');
                    if (headerEnd < 0) {
                        return;
                    }
                    connected = true;
                    buffer = buffer.slice(Buffer.byteLength(text.slice(0, headerEnd + 4)));
                }
                const frame = this.tryReadWebSocketFrame(buffer);
                if (!frame) {
                    return;
                }
                buffer = frame.rest;
                cleanup();
                resolve(frame.text);
            };
            socket.on('data', onData);
            socket.on('error', onError);
            socket.on('timeout', onTimeout);
        });
        await new Promise((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('error', reject);
        });
        socket.write([
            `GET ${url.pathname}${url.search || ''} HTTP/1.1`,
            `Host: ${url.host}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            '\r\n'
        ].join('\r\n'));
        await waitForFrame().catch(() => null);
        const payload = JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: {
                expression,
                awaitPromise: true,
                returnByValue: true
            }
        });
        socket.write(this.createWebSocketTextFrame(payload));
        while (true) {
            const text = await waitForFrame();
            const message = JSON.parse(text);
            if (message.id === 1) {
                socket.end();
                return message;
            }
        }
    }

    buildInjectionExpression(args = {}) {
        const bridgeUrl = this.getBridgeUrl(args);
        return [
            '(function(){',
            '  function inject(){',
            '    var old = document.getElementById("cocos-mcp-runtime-bridge");',
            '    if (old && old.parentNode) old.parentNode.removeChild(old);',
            '    var s = document.createElement("script");',
            '    s.id = "cocos-mcp-runtime-bridge";',
            `    s.src = "${bridgeUrl}?t=" + Date.now();`,
            '    (document.head || document.documentElement).appendChild(s);',
            '    return { injected: true, url: location.href, readyState: document.readyState };',
            '  }',
            '  if (document.head || document.documentElement) return inject();',
            '  document.addEventListener("DOMContentLoaded", inject, { once: true });',
            '  return { injected: false, waiting: true, url: location.href, readyState: document.readyState };',
            '})();'
        ].join('\n');
    }

    async openInjectedPreview(args = {}) {
        const injectedPreviewUrl = this.getInjectedPreviewUrl(args);
        const previewUrl = this.getDefaultPreviewUrl(args);
        const bridgeUrl = this.getBridgeUrl(args);
        try {
            const launchInfo = this.launchDebugBrowser(previewUrl, args);
            if (launchInfo.fallback) {
                return {
                    success: false,
                    message: '当前平台无法自动注入，请使用 get_injection_code 手动注入。',
                    data: { injectedPreviewUrl, previewUrl, bridgeUrl, launchInfo }
                };
            }
            const page = await this.findCdpPage(launchInfo.debugPort, previewUrl, Number(args.readyTimeoutMs) || 12000);
            const evaluation = await this.cdpEvaluate(page.webSocketDebuggerUrl, this.buildInjectionExpression(args), 8000);
            return {
                success: true,
                message: '已在外部浏览器打开原始 Cocos 预览页，并自动注入 runtime bridge。',
                data: {
                    injectedPreviewUrl,
                    previewUrl,
                    bridgeUrl,
                    debugPort: launchInfo.debugPort,
                    pageUrl: page.url,
                    injected: evaluation && evaluation.result && evaluation.result.result
                }
            };
        } catch (error) {
            return {
                success: false,
                message: '打开原始预览页并自动注入 bridge 失败。',
                error: error && error.message ? error.message : String(error),
                data: { injectedPreviewUrl, previewUrl, bridgeUrl }
            };
        }
    }

    getInjectionCode(args = {}) {
        const bridgeUrl = this.getBridgeUrl(args);
        const injectedPreviewUrl = this.getInjectedPreviewUrl(args);
        const code = [
            '(function(){',
            '  var old = document.getElementById("cocos-mcp-runtime-bridge");',
            '  if (old && old.parentNode) old.parentNode.removeChild(old);',
            '  var s = document.createElement("script");',
            '  s.id = "cocos-mcp-runtime-bridge";',
            `  s.src = "${bridgeUrl}?t=" + Date.now();`,
            '  document.head.appendChild(s);',
            '})();'
        ].join('\n');
        return {
            success: true,
            data: {
                bridgeUrl,
                injectedPreviewUrl,
                code,
                message: '优先调用 open_injected_preview 打开外部浏览器自动注入预览页；本脚本仅作为特殊环境兜底。'
            }
        };
    }

    updateSettings(settings = {}) {
        if (settings.port) {
            this.port = Number(settings.port) || this.port;
        }
    }

    register(info) {
        const support = info && info.support || {};
        const bridgeVersion = support && support.bridgeVersion || '';
        if (bridgeVersion && this.compareBridgeVersion(bridgeVersion, this.minimumBridgeVersion) < 0) {
            return {
                success: false,
                error: `运行态 bridge 版本过旧：${bridgeVersion}，请刷新 injected 预览页加载 ${this.minimumBridgeVersion} 或更新版本。`,
                minimumBridgeVersion: this.minimumBridgeVersion
            };
        }
        const clientId = uuidv4();
        const now = Date.now();
        const client = {
            id: clientId,
            url: info && info.url || '',
            title: info && info.title || '',
            userAgent: info && info.userAgent || '',
            support: info && info.support || null,
            connectedAt: now,
            lastSeen: now,
            queue: [],
            pendingPoll: null
        };
        this.clients.set(clientId, client);
        this.cleanupStaleClients();
        return {
            success: true,
            clientId,
            message: 'Cocos 运行态网页已连接 MCP。'
        };
    }

    getStatus() {
        this.cleanupStaleClients();
        const latest = this.getLatestClient();
        const active = this.getActiveClient();
        const clients = Array.from(this.clients.values()).map((client) => ({
            id: client.id,
            url: client.url,
            title: client.title,
            connectedAt: new Date(client.connectedAt).toISOString(),
            lastSeen: new Date(client.lastSeen).toISOString(),
            support: client.support,
            active: client.id === this.activeClientId,
            hasPendingPoll: !!client.pendingPoll,
            queuedCommands: client.queue.length
        }));
        return {
            success: true,
            connected: clients.length > 0,
            latestClientId: latest ? latest.id : null,
            activeClientId: active ? active.id : null,
            clients
        };
    }

    listClients() {
        const status = this.getStatus();
        return {
            success: true,
            data: Object.assign({}, status, {
                minimumBridgeVersion: this.minimumBridgeVersion
            })
        };
    }

    selectClient(clientId) {
        this.cleanupStaleClients();
        const id = String(clientId || '').trim();
        if (!id) {
            return {
                success: false,
                error: '缺少 clientId。'
            };
        }
        const client = this.clients.get(id);
        if (!client) {
            return {
                success: false,
                error: `未找到运行态页面：${id}`
            };
        }
        if (!this.isUsableClient(client)) {
            return {
                success: false,
                error: `运行态页面不可用或版本过旧：${id}`,
                data: {
                    client: this.summarizeClient(client),
                    minimumBridgeVersion: this.minimumBridgeVersion
                }
            };
        }
        this.activeClientId = id;
        return {
            success: true,
            message: '已切换运行态目标页面。',
            data: {
                activeClientId: id,
                client: this.summarizeClient(client)
            }
        };
    }

    handlePoll(clientId, res, writeJson) {
        const client = this.clients.get(clientId);
        if (!client) {
            writeJson(res, 404, {
                success: false,
                error: '运行态客户端不存在，请刷新预览页后重新注入 bridge。'
            });
            return;
        }
        client.lastSeen = Date.now();
        if (client.queue.length > 0) {
            const command = client.queue.shift();
            writeJson(res, 200, {
                success: true,
                type: 'command',
                command
            });
            return;
        }
        if (client.pendingPoll && client.pendingPoll.timer) {
            clearTimeout(client.pendingPoll.timer);
        }
        const timer = setTimeout(() => {
            if (client.pendingPoll && client.pendingPoll.res === res) {
                client.pendingPoll = null;
            }
            writeJson(res, 200, {
                success: true,
                type: 'ping'
            });
        }, this.pollTimeoutMs);
        client.pendingPoll = { res, writeJson, timer };
    }

    acceptResult(payload) {
        const clientId = payload && payload.clientId;
        const commandId = payload && payload.commandId;
        const client = this.clients.get(clientId);
        if (client) {
            client.lastSeen = Date.now();
            this.updateClientSupport(client, payload && payload.result);
        }
        const pending = this.pendingCommands.get(commandId);
        if (!pending) {
            return {
                success: false,
                error: '命令已过期或不存在。'
            };
        }
        clearTimeout(pending.timer);
        this.pendingCommands.delete(commandId);
        pending.resolve(payload.result);
        return {
            success: true
        };
    }

    heartbeat(payload) {
        const clientId = payload && payload.clientId;
        const client = this.clients.get(clientId);
        if (!client) {
            return {
                success: false,
                error: '运行态客户端不存在，请刷新预览页后重新注入 bridge。'
            };
        }
        client.lastSeen = Date.now();
        if (payload && payload.support) {
            client.support = payload.support;
        }
        return {
            success: true
        };
    }

    async execute(action, args) {
        this.cleanupStaleClients();
        if (action === 'clear_clients') {
            return this.clearClients();
        }
        if (action === 'list_clients') {
            return this.listClients();
        }
        if (action === 'select_client') {
            return this.selectClient(args && (args.clientId || args.id));
        }
        if (action === 'open_injected_preview') {
            return this.openInjectedPreview(args || {});
        }
        if (action === 'check_support' && this.clients.size === 0) {
            return {
                success: true,
                data: {
                    connected: false,
                    support: false,
                    message: '尚未连接 Cocos 运行态网页，请先在预览页面注入 runtime bridge 脚本。'
                }
            };
        }

        if (action === 'get_console_logs') {
            return await this.executeConsoleLogs(args || {});
        }

        const requestedClientId = args && (args.clientId || args.targetClientId);
        const client = requestedClientId ? this.clients.get(String(requestedClientId)) : this.getActiveClient();
        if (!client) {
            return {
                success: false,
                error: requestedClientId
                    ? `未找到指定运行态页面：${requestedClientId}`
                    : '尚未连接 Cocos 运行态网页，请先在预览页面注入 runtime bridge 脚本。'
            };
        }
        if (!this.isUsableClient(client)) {
            return {
                success: false,
                error: `运行态页面不可用或版本过旧：${client.id}`,
                data: {
                    client: this.summarizeClient(client),
                    minimumBridgeVersion: this.minimumBridgeVersion
                }
            };
        }

        return await this.executeOnClient(client, action, args || {});
    }

    async executeOnClient(client, action, args) {
        const command = {
            id: uuidv4(),
            action,
            args: args || {},
            createdAt: Date.now()
        };

        return await new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.pendingCommands.delete(command.id);
                resolve({
                    success: false,
                    error: `运行态命令超时：${action}`
                });
            }, this.getCommandTimeout(args));

            this.pendingCommands.set(command.id, { resolve, timer, clientId: client.id });
            this.enqueueCommand(client, command);
        });
    }

    async executeConsoleLogs(args) {
        this.cleanupStaleClients();
        const requestedClientId = args && (args.clientId || args.targetClientId);
        let clients = requestedClientId
            ? [this.clients.get(String(requestedClientId))].filter(Boolean)
            : Array.from(this.clients.values()).filter((client) => {
            const support = client.support || {};
            return this.isUsableClient(client)
                && !!client.pendingPoll
                && !!(support.hasScene || support.ready);
        });
        if (!clients.length) {
            const active = this.getActiveClient();
            clients = active ? [active] : [];
        }
        if (!clients.length) {
            return {
                success: false,
                error: '尚未连接 Cocos 运行态网页，请先在预览页面注入 runtime bridge 脚本。'
            };
        }

        const waitMs = Math.max(0, Math.min(Number(args && args.waitMs) || 0, 10000));
        const timeoutMs = Math.max(2000, Math.min(waitMs + 1000, 5000));
        const commandArgs = Object.assign({}, args || {}, {
            timeoutMs: Math.min(Number(args && args.timeoutMs) || timeoutMs, timeoutMs)
        });
        const results = await Promise.all(clients.map(async (client) => {
            const result = await this.executeOnClient(client, 'get_console_logs', commandArgs);
            return { client, result };
        }));

        const successResults = results.filter((item) => item.result && item.result.success && item.result.data);
        if (!successResults.length) {
            const firstError = results.find((item) => item.result && item.result.error);
            return firstError && firstError.result || {
                success: false,
                error: '读取运行态日志失败。'
            };
        }

        const logs = [];
        const totals = [];
        let waitedMs = 0;
        for (const item of successResults) {
            const data = item.result.data || {};
            totals.push(Number(data.totalStored) || 0);
            waitedMs = Math.max(waitedMs, Number(data.waitedMs) || 0);
            for (const log of data.logs || []) {
                logs.push(Object.assign({ clientId: item.client.id }, log));
            }
        }

        logs.sort((left, right) => {
            const leftTime = Date.parse(left.time || '') || 0;
            const rightTime = Date.parse(right.time || '') || 0;
            if (leftTime !== rightTime) {
                return leftTime - rightTime;
            }
            return (Number(left.index) || 0) - (Number(right.index) || 0);
        });

        const limit = Math.max(1, Math.min(Number(args && args.limit) || 100, 500));
        const limitedLogs = logs.slice(-limit);
        const totalStored = totals.length ? Math.min(...totals) : 0;

        return {
            success: true,
            data: {
                totalStored,
                maxStored: totals.length ? Math.max(...totals) : 0,
                clientCount: successResults.length,
                returned: limitedLogs.length,
                waitedMs,
                logs: limitedLogs
            }
        };
    }

    enqueueCommand(client, command) {
        if (client.pendingPoll) {
            const pendingPoll = client.pendingPoll;
            client.pendingPoll = null;
            clearTimeout(pendingPoll.timer);
            pendingPoll.writeJson(pendingPoll.res, 200, {
                success: true,
                type: 'command',
                command
            });
            return;
        }
        client.queue.push(command);
    }

    getLatestClient() {
        let latest = null;
        for (const client of this.clients.values()) {
            if (!latest || client.lastSeen > latest.lastSeen) {
                latest = client;
            }
        }
        return latest;
    }

    summarizeClient(client) {
        if (!client) {
            return null;
        }
        return {
            id: client.id,
            url: client.url,
            title: client.title,
            connectedAt: new Date(client.connectedAt).toISOString(),
            lastSeen: new Date(client.lastSeen).toISOString(),
            support: client.support,
            active: client.id === this.activeClientId,
            hasPendingPoll: !!client.pendingPoll,
            queuedCommands: client.queue.length
        };
    }

    getActiveClient() {
        const active = this.activeClientId ? this.clients.get(this.activeClientId) : null;
        if (this.isUsableClient(active)) {
            return active;
        }
        let best = null;
        let bestScore = -1;
        for (const client of this.clients.values()) {
            if (!this.isUsableClient(client)) {
                continue;
            }
            const support = client.support || {};
            let score = 0;
            if (support.support || support.hasCc) {
                score += 100;
            }
            if (support.hasDirector) {
                score += 50;
            }
            if (support.hasScene || support.ready) {
                score += 200;
            }
            if (support.sceneChildCount > 0) {
                score += 100;
            }
            if (client.pendingPoll) {
                score += 500;
            } else {
                score -= 500;
            }
            if (support.diagnostics) {
                score += 25;
            }
            if (this.compareBridgeVersion(support.bridgeVersion, this.minimumBridgeVersion) >= 0) {
                score += 1000;
            }
            if (!best || score > bestScore || score === bestScore && client.lastSeen > best.lastSeen) {
                best = client;
                bestScore = score;
            }
        }
        if (best) {
            this.activeClientId = best.id;
            return best;
        }
        this.activeClientId = null;
        return null;
    }

    isUsableClient(client) {
        if (!client) {
            return false;
        }
        const support = client.support || {};
        const bridgeVersion = support.bridgeVersion || '';
        if (bridgeVersion && this.compareBridgeVersion(bridgeVersion, this.minimumBridgeVersion) < 0) {
            return false;
        }
        return Date.now() - client.lastSeen <= this.staleClientMs;
    }

    compareBridgeVersion(left, right) {
        const parse = (value) => String(value || '')
            .split('.')
            .map((item) => Number(item) || 0);
        const a = parse(left);
        const b = parse(right);
        const length = Math.max(a.length, b.length);
        for (let i = 0; i < length; i++) {
            const diff = (a[i] || 0) - (b[i] || 0);
            if (diff !== 0) {
                return diff;
            }
        }
        return 0;
    }

    clearClients() {
        for (const client of this.clients.values()) {
            if (client.pendingPoll && client.pendingPoll.timer) {
                clearTimeout(client.pendingPoll.timer);
                client.pendingPoll.writeJson(client.pendingPoll.res, 200, {
                    success: true,
                    type: 'reset',
                    message: '运行态客户端列表已清理，请刷新或重新打开预览页。'
                });
            }
        }
        this.clients.clear();
        this.activeClientId = null;
        for (const pending of this.pendingCommands.values()) {
            clearTimeout(pending.timer);
            pending.resolve({
                success: false,
                error: '运行态客户端列表已清理，命令已取消。'
            });
        }
        this.pendingCommands.clear();
        return {
            success: true,
            message: '运行态客户端列表已清理。'
        };
    }

    updateClientSupport(client, result) {
        if (!client || !result || !result.data) {
            return;
        }
        const data = result.data;
        if (Object.prototype.hasOwnProperty.call(data, 'support') || Object.prototype.hasOwnProperty.call(data, 'hasCc')) {
            client.support = data;
        }
    }

    getCommandTimeout(args) {
        const explicit = Number(args && args.timeoutMs) || 0;
        const readyTimeout = Number(args && args.readyTimeoutMs) || 0;
        return Math.max(explicit, readyTimeout ? readyTimeout + 2000 : 0, this.commandTimeoutMs);
    }

    cleanupStaleClients() {
        const now = Date.now();
        for (const [id, client] of this.clients.entries()) {
            const bridgeVersion = client.support && client.support.bridgeVersion || '';
            const isLegacyClient = bridgeVersion && this.compareBridgeVersion(bridgeVersion, this.minimumBridgeVersion) < 0;
            if (!isLegacyClient && now - client.lastSeen <= this.staleClientMs) {
                continue;
            }
            if (client.pendingPoll && client.pendingPoll.timer) {
                clearTimeout(client.pendingPoll.timer);
                if (isLegacyClient) {
                    client.pendingPoll.writeJson(client.pendingPoll.res, 200, {
                        success: true,
                        type: 'reset',
                        message: `运行态 bridge 版本过旧，请刷新 injected 预览页加载 ${this.minimumBridgeVersion} 或更新版本。`
                    });
                }
            }
            this.clients.delete(id);
            if (this.activeClientId === id) {
                this.activeClientId = null;
            }
        }
    }

    destroy() {
        for (const client of this.clients.values()) {
            if (client.pendingPoll && client.pendingPoll.timer) {
                clearTimeout(client.pendingPoll.timer);
            }
        }
        this.clients.clear();
        this.activeClientId = null;
        for (const pending of this.pendingCommands.values()) {
            clearTimeout(pending.timer);
            pending.resolve({
                success: false,
                error: 'MCP 服务器已停止，运行态命令已取消。'
            });
        }
        this.pendingCommands.clear();
    }
}

module.exports = { RuntimeBridgeManager };
