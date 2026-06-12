'use strict';

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

class RuntimeBridgeManager {
    constructor(settings = {}) {
        this.clients = new Map();
        this.pendingCommands = new Map();
        this.pollTimeoutMs = 25000;
        this.commandTimeoutMs = 10000;
        this.staleClientMs = 60000;
        this.port = Number(settings.port) || 3300;
        this.minimumBridgeVersion = '0.1.2';
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
        return `http://${host}:${port}/runtime/preview?url=${encodeURIComponent(previewUrl)}`;
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
                message: '优先使用 code 注入；如果浏览器自动化不能执行页面脚本，请直接打开 injectedPreviewUrl，它会自动代理预览页并注入 runtime bridge。'
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
        const clients = Array.from(this.clients.values()).map((client) => ({
            id: client.id,
            url: client.url,
            title: client.title,
            connectedAt: new Date(client.connectedAt).toISOString(),
            lastSeen: new Date(client.lastSeen).toISOString(),
            support: client.support,
            hasPendingPoll: !!client.pendingPoll,
            queuedCommands: client.queue.length
        }));
        return {
            success: true,
            connected: clients.length > 0,
            latestClientId: this.getLatestClient() ? this.getLatestClient().id : null,
            activeClientId: this.getActiveClient() ? this.getActiveClient().id : null,
            clients
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

        const client = this.getActiveClient();
        if (!client) {
            return {
                success: false,
                error: '尚未连接 Cocos 运行态网页，请先在预览页面注入 runtime bridge 脚本。'
            };
        }

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

            this.pendingCommands.set(command.id, { resolve, timer });
            this.enqueueCommand(client, command);
        });
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

    getActiveClient() {
        let best = null;
        let bestScore = -1;
        for (const client of this.clients.values()) {
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
            if (this.compareBridgeVersion(support.bridgeVersion, '0.1.2') >= 0) {
                score += 25;
            }
            if (!best || score > bestScore || score === bestScore && client.lastSeen > best.lastSeen) {
                best = client;
                bestScore = score;
            }
        }
        return best || this.getLatestClient();
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
        }
    }

    destroy() {
        for (const client of this.clients.values()) {
            if (client.pendingPoll && client.pendingPoll.timer) {
                clearTimeout(client.pendingPoll.timer);
            }
        }
        this.clients.clear();
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
