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
    }

    getBridgeScript() {
        return fs.readFileSync(path.join(__dirname, 'bridge.js'), 'utf8');
    }

    getBridgeUrl(args = {}) {
        const host = args.host || '127.0.0.1';
        const port = Number(args.port) || this.port || 3300;
        return `http://${host}:${port}/runtime/bridge.js`;
    }

    getInjectionCode(args = {}) {
        const bridgeUrl = this.getBridgeUrl(args);
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
                code,
                message: '请在 Cocos 预览网页控制台执行 code 内容，或让浏览器自动化注入 bridgeUrl。'
            }
        };
    }

    updateSettings(settings = {}) {
        if (settings.port) {
            this.port = Number(settings.port) || this.port;
        }
    }

    register(info) {
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
            queuedCommands: client.queue.length
        }));
        return {
            success: true,
            connected: clients.length > 0,
            latestClientId: this.getLatestClient() ? this.getLatestClient().id : null,
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

        const client = this.getLatestClient();
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
            if (now - client.lastSeen <= this.staleClientMs) {
                continue;
            }
            if (client.pendingPoll && client.pendingPoll.timer) {
                clearTimeout(client.pendingPoll.timer);
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
