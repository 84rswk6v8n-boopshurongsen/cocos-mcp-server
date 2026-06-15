'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { v4: uuidv4 } = require('uuid');

class RuntimeBridgeManager {
    constructor(settings = {}) {
        this.clients = new Map();
        this.pendingCommands = new Map();
        this.pollTimeoutMs = 25000;
        this.commandTimeoutMs = 10000;
        this.staleClientMs = 60000;
        this.port = Number(settings.port) || 3300;
        this.minimumBridgeVersion = '0.1.15';
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
        const host = args.host || '127.0.0.1';
        const port = Number(args.port) || this.port || 3300;
        const previewUrl = this.getDefaultPreviewUrl(args);
        const url = `http://${host}:${port}/runtime/preview?url=${encodeURIComponent(previewUrl)}`;
        return args.cacheBust === false ? url : `${url}&t=${Date.now()}`;
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
