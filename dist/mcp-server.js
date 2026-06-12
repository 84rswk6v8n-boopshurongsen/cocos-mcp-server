"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
exports.MCPServer = void 0;

const http = require("http");
const { v4: uuidv4 } = require("uuid");
const { CocosTools } = require("./tools/cocos/cocos-tools");
const { isAuthDisabled, getAuthConfig } = require("./auth/server-config");
const { RuntimeBridgeManager } = require("./runtime/runtime-bridge-manager");

class MCPServer {
    constructor(settings) {
        this.httpServer = null;
        this.clients = new Map();
        this.tools = {};
        this.toolsList = [];
        this.enabledTools = [];
        this.staleClientTimer = null;
        this.isLicenseValid = null;
        this._initialProjectPath = "";
        this.actionCallCounts = new Map();
        this.toolExecutionCount = 0;
        this.mcpRequestCount = 0;
        this.serviceConnectionCount = 0;
        this.toolStats = new Map();
        this.activeToolCalls = new Map();
        this.toolCallSequence = 0;
        this.autoSaveTimer = null;
        this.settings = settings;
        this.runtimeBridge = new RuntimeBridgeManager(settings);
        globalThis.__cocosMcpRuntimeBridgeManager = this.runtimeBridge;

        console.log("[MCPServer] 构造参数：", settings);
        console.log("[MCPServer] 传输方式：HTTP 流式传输（MCP 2025-03-26）");
        this.initializeTools();

        try {
            this._initialProjectPath = (globalThis.Editor && globalThis.Editor.Project && globalThis.Editor.Project.path) || "";
            console.log("[MCPServer] 已绑定项目：" + this._initialProjectPath);
        }
        catch (_) {
            this._initialProjectPath = "";
        }
    }

    initializeTools() {
        try {
            console.log("[MCPServer] 正在初始化统一 CocosTools...");
            this.tools.cocos = new CocosTools();
            console.log("[MCPServer] CocosTools 初始化完成");
        }
        catch (error) {
            console.error("[MCPServer] 初始化工具失败：", error);
            throw error;
        }
    }

    async start() {
        if (this.httpServer) {
            console.log("[MCPServer] 服务器已在运行");
            return;
        }

        try {
            console.log(`[MCPServer] 正在端口 ${this.settings.port} 启动 HTTP 流式服务器...`);
            this.httpServer = http.createServer(this.handleHttpRequest.bind(this));

            await new Promise((resolve, reject) => {
                this.httpServer.listen(this.settings.port, "127.0.0.1", () => {
                    console.log(`[MCPServer] HTTP 流式服务器已启动：http://127.0.0.1:${this.settings.port}`);
                    console.log(`[MCPServer] 健康检查地址：http://127.0.0.1:${this.settings.port}/health`);
                    console.log(`[MCPServer] MCP 服务地址：http://127.0.0.1:${this.settings.port}/mcp`);
                    resolve();
                });

                this.httpServer.on("error", (error) => {
                    console.error("[MCPServer] 启动服务器失败：", error);
                    if (error && error.code === "EADDRINUSE") {
                        console.error(`[MCPServer] 端口 ${this.settings.port} 已被占用，请在设置中更换端口。`);
                    }
                    reject(error);
                });
            });

            this.setupTools();
            console.log("[MCPServer] HTTP 流式 MCP 服务器已就绪，可以连接");
        }
        catch (error) {
            console.error("[MCPServer] 启动服务器失败：", error);
            this.httpServer = null;
            throw error;
        }
    }

    setupTools() {
        this.toolsList = [];

        if (!this.enabledTools || this.enabledTools.length === 0) {
            for (const [category, toolSet] of Object.entries(this.tools)) {
                for (const tool of toolSet.getTools()) {
                    this.toolsList.push({
                        name: `${category}_${tool.name}`,
                        description: tool.description,
                        inputSchema: tool.inputSchema
                    });
                }
            }
        }
        else {
            const enabledToolNames = new Set(this.enabledTools.map((tool) => `${tool.category}_${tool.name}`));
            for (const [category, toolSet] of Object.entries(this.tools)) {
                for (const tool of toolSet.getTools()) {
                    const toolName = `${category}_${tool.name}`;
                    if (enabledToolNames.has(toolName)) {
                        this.toolsList.push({
                            name: toolName,
                            description: tool.description,
                            inputSchema: tool.inputSchema
                        });
                    }
                }
            }
        }

        console.log(`[MCPServer] 已配置工具：当前可用 ${this.toolsList.length} 个工具`);
    }

    async executeToolCall(toolName, args) {
        const parts = String(toolName || "").split("_");
        const category = parts[0];
        const toolMethodName = parts.slice(1).join("_");

        if (this.tools[category]) {
            return await this.tools[category].execute(toolMethodName, args || {});
        }

        if (this.tools.cocos) {
            return await this.tools.cocos.execute(toolName, args || {});
        }

        throw new Error(`未找到工具：${toolName}`);
    }

    getToolStat(toolName) {
        const name = String(toolName || "unknown");
        if (!this.toolStats.has(name)) {
            this.toolStats.set(name, {
                name,
                count: 0,
                running: 0,
                lastStatus: "idle",
                lastStartedAt: null,
                lastEndedAt: null,
                lastDuration: 0,
                lastError: ""
            });
        }
        return this.toolStats.get(name);
    }

    beginToolCall(toolName) {
        const name = String(toolName || "unknown");
        const startedAt = Date.now();
        const id = `${startedAt}-${++this.toolCallSequence}`;
        const stat = this.getToolStat(name);
        this.toolExecutionCount += 1;
        stat.count += 1;
        stat.running += 1;
        stat.lastStatus = "running";
        stat.lastStartedAt = startedAt;
        stat.lastError = "";
        this.activeToolCalls.set(id, {
            id,
            toolName: name,
            startedAt
        });
        return { id, toolName: name, startedAt };
    }

    finishToolCall(toolCall, error) {
        if (!toolCall) {
            return;
        }
        const stat = this.getToolStat(toolCall.toolName);
        const endedAt = Date.now();
        stat.running = Math.max(0, stat.running - 1);
        stat.lastEndedAt = endedAt;
        stat.lastDuration = endedAt - toolCall.startedAt;
        stat.lastStatus = error ? "error" : "success";
        stat.lastError = error && error.message ? error.message : "";
        this.activeToolCalls.delete(toolCall.id);
    }

    async autoSaveScene() {
        return this.doAutoSave();
    }

    async doAutoSave() {
        try {
            if (globalThis.Editor && globalThis.Editor.Message) {
                await globalThis.Editor.Message.request("scene", "save");
            }
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    }

    async execInToolbar(script) {
        if (!globalThis.Editor || !globalThis.Editor.Message) {
            return { success: false, error: "编辑器消息系统不可用" };
        }
        return await globalThis.Editor.Message.request("scene", "execute-scene-script", { script });
    }

    async ensurePreviewStopped() {
        return { success: true };
    }

    getClients() {
        return Array.from(this.clients.values());
    }

    getAvailableTools() {
        return this.toolsList;
    }

    updateEnabledTools(enabledTools) {
        const nextTools = Array.isArray(enabledTools) ? enabledTools : [];
        console.log(`[MCPServer] 正在更新启用工具：${nextTools.length} 个工具`);
        this.enabledTools = nextTools;
        this.setupTools();
    }

    getSettings() {
        return this.settings;
    }

    async handleHttpRequest(req, res) {
        const requestUrl = this.parseRequestUrl(req);
        const pathname = requestUrl.pathname || "/";

        if (!this.validateOrigin(req)) {
            res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: "来源不允许访问 MCP 服务" }));
            return;
        }

        this.setCorsHeaders(res);

        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }

        try {
            if (pathname === "/health" && req.method === "GET") {
                this.writeJson(res, 200, {
                    status: "ok",
                    running: !!this.httpServer,
                    tools: this.toolsList.length,
                    clients: this.clients.size
                });
                return;
            }

            if (pathname === "/mcp" && req.method === "GET") {
                await this.handleStreamingConnection(req, res);
                return;
            }

            if (pathname === "/mcp" && req.method === "POST") {
                this.mcpRequestCount += 1;
                this.serviceConnectionCount += 1;
                await this.handleMCPRequest(req, res);
                return;
            }

            if (pathname === "/api/tools" && req.method === "GET") {
                this.writeJson(res, 200, { tools: this.getSimplifiedToolsList() });
                return;
            }

            if (pathname.startsWith("/runtime/")) {
                await this.handleRuntimeRequest(req, res, pathname, requestUrl);
                return;
            }

            if (pathname.startsWith("/api/") && req.method === "POST") {
                this.mcpRequestCount += 1;
                this.serviceConnectionCount += 1;
                await this.handleSimpleAPIRequest(req, res, pathname);
                return;
            }

            this.writeJson(res, 404, { error: "未找到接口" });
        }
        catch (error) {
            console.error("[MCPServer] HTTP 请求处理失败：", error);
            this.writeJson(res, 500, { error: "服务器内部错误", message: error.message });
        }
    }

    async handleMCPRequest(req, res) {
        if (this.isLicenseExpired()) {
            this.rejectLicenseExpired(res, "mcp");
            return;
        }

        const body = await this.readRequestBody(req);
        let message;

        try {
            message = body ? JSON.parse(body) : {};
        }
        catch (error) {
            this.writeJson(res, 400, {
                jsonrpc: "2.0",
                id: null,
                error: {
                    code: -32700,
                    message: `解析 JSON 失败：${error.message}`
                }
            });
            return;
        }

        if (Array.isArray(message)) {
            const responses = [];
            for (const item of message) {
                const response = await this.handleMessage(item);
                if (response) {
                    responses.push(response);
                }
            }
            this.writeJson(res, 200, responses);
            return;
        }

        const response = await this.handleMessage(message);
        if (response) {
            this.writeJson(res, 200, response);
        }
        else {
            res.writeHead(202);
            res.end();
        }
    }

    async handleMessage(message) {
        const id = message && Object.prototype.hasOwnProperty.call(message, "id") ? message.id : null;
        const method = message && message.method;
        const params = (message && message.params) || {};

        try {
            let result;
            switch (method) {
                case "initialize":
                    result = {
                        protocolVersion: "2025-03-26",
                        capabilities: {
                            tools: {}
                        },
                        serverInfo: {
                            name: "cocos-mcp-server",
                            version: "1.7.5"
                        }
                    };
                    break;
                case "notifications/initialized":
                    return null;
                case "ping":
                    result = {};
                    break;
                case "tools/list":
                    result = { tools: this.getAvailableTools() };
                    break;
                case "tools/call": {
                    const toolCall = this.beginToolCall(params.name);
                    let toolResult;
                    try {
                        toolResult = await this.executeToolCall(params.name, params.arguments || {});
                        this.finishToolCall(toolCall);
                    }
                    catch (error) {
                        this.finishToolCall(toolCall, error);
                        throw error;
                    }
                    result = {
                        content: [
                            {
                                type: "text",
                                text: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult)
                            }
                        ]
                    };
                    break;
                }
                case "resources/list":
                    result = { resources: [] };
                    break;
                case "prompts/list":
                    result = { prompts: [] };
                    break;
                default:
                    throw new Error(`未知方法：${method}`);
            }

            return {
                jsonrpc: "2.0",
                id,
                result
            };
        }
        catch (error) {
            return {
                jsonrpc: "2.0",
                id,
                error: {
                    code: -32603,
                    message: error.message
                }
            };
        }
    }

    getSessionId(req) {
        const requestUrl = this.parseRequestUrl(req);
        const headerId = req.headers["mcp-session-id"];
        if (Array.isArray(headerId)) {
            return headerId[0];
        }
        return headerId || requestUrl.searchParams.get("sessionId") || uuidv4();
    }

    isLicenseExpired() {
        try {
            if (isAuthDisabled && isAuthDisabled()) {
                return false;
            }
            const config = getAuthConfig ? getAuthConfig() : null;
            if (!config || !config.expiresAt) {
                return false;
            }
            return Date.now() > Number(config.expiresAt);
        }
        catch (_) {
            return false;
        }
    }

    rejectLicenseExpired(res, source) {
        this.writeJson(res, 403, {
            success: false,
            source,
            error: "许可证已过期，MCP 服务请求被拒绝"
        });
    }

    validateOrigin(req) {
        const allowedOrigins = this.settings.allowedOrigins || ["*"];
        if (allowedOrigins.includes("*")) {
            return true;
        }

        const origin = req.headers.origin;
        if (!origin) {
            return true;
        }

        return allowedOrigins.includes(origin);
    }

    async handleStreamingConnection(req, res) {
        if (this.isLicenseExpired()) {
            this.rejectLicenseExpired(res, "stream");
            return;
        }

        const maxConnections = Number(this.settings.maxConnections || 10);
        if (this.clients.size >= maxConnections) {
            this.writeJson(res, 429, { error: "连接数已达到上限" });
            return;
        }

        const sessionId = this.getSessionId(req);
        res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        });

        res.write(`event: endpoint\ndata: /mcp?sessionId=${sessionId}\n\n`);
        res.write(": connected\n\n");

        const pingTimer = setInterval(() => {
            try {
                res.write(": ping\n\n");
            }
            catch (_) {
                clearInterval(pingTimer);
            }
        }, 30000);

        this.clients.set(sessionId, {
            id: sessionId,
            connectedAt: Date.now(),
            response: res,
            pingTimer
        });
        this.serviceConnectionCount += 1;

        if (this.settings.enableDebugLog) {
            console.log(`[MCPServer] 客户端已连接：${sessionId}`);
        }

        const cleanup = () => {
            clearInterval(pingTimer);
            this.clients.delete(sessionId);
            if (this.settings.enableDebugLog) {
                console.log(`[MCPServer] 客户端已断开：${sessionId}`);
            }
        };

        req.on("close", cleanup);
        req.on("error", cleanup);
    }

    stop() {
        if (this.staleClientTimer) {
            clearInterval(this.staleClientTimer);
            this.staleClientTimer = null;
        }

        if (this.autoSaveTimer) {
            clearTimeout(this.autoSaveTimer);
            this.autoSaveTimer = null;
        }

        if (this.runtimeBridge) {
            this.runtimeBridge.destroy();
        }

        if (this.httpServer) {
            this.httpServer.close();
            this.httpServer = null;
            console.log("[MCPServer] HTTP 流式服务器已停止");
        }

        for (const client of this.clients.values()) {
            if (client.pingTimer) {
                clearInterval(client.pingTimer);
            }
            if (client.response && !client.response.destroyed) {
                client.response.end();
            }
        }

        this.clients.clear();
    }

    getStatus() {
        return {
            running: !!this.httpServer,
            port: this.settings.port,
            clients: this.clients.size,
            toolExecutionCount: this.toolExecutionCount,
            mcpRequestCount: this.mcpRequestCount,
            serviceConnectionCount: this.serviceConnectionCount,
            activeToolCalls: Array.from(this.activeToolCalls.values()),
            toolStats: Array.from(this.toolStats.values())
        };
    }

    updateSettings(settings) {
        const wasRunning = !!this.httpServer;
        this.settings = settings;
        if (this.runtimeBridge && typeof this.runtimeBridge.updateSettings === "function") {
            this.runtimeBridge.updateSettings(settings);
        }
        if (wasRunning) {
            this.stop();
            this.start();
        }
    }

    getFilteredTools(enabledTools) {
        if (!enabledTools || enabledTools.length === 0) {
            return this.toolsList;
        }

        const enabledToolNames = new Set(enabledTools.map((tool) => `${tool.category}_${tool.name}`));
        return this.toolsList.filter((tool) => enabledToolNames.has(tool.name));
    }

    async handleRuntimeRequest(req, res, pathname, requestUrl) {
        if (pathname === "/runtime/bridge.js" && req.method === "GET") {
            const script = this.runtimeBridge.getBridgeScript();
            res.writeHead(200, {
                "Content-Type": "application/javascript; charset=utf-8",
                "Cache-Control": "no-cache"
            });
            res.end(script);
            return;
        }

        if (pathname === "/runtime/status" && req.method === "GET") {
            this.writeJson(res, 200, this.runtimeBridge.getStatus());
            return;
        }

        if (pathname === "/runtime/register" && req.method === "POST") {
            const body = await this.readRequestBody(req);
            const info = body ? JSON.parse(body) : {};
            this.writeJson(res, 200, this.runtimeBridge.register(info));
            return;
        }

        if (pathname === "/runtime/heartbeat" && req.method === "POST") {
            const body = await this.readRequestBody(req);
            const payload = body ? JSON.parse(body) : {};
            this.writeJson(res, 200, this.runtimeBridge.heartbeat(payload));
            return;
        }

        if (pathname === "/runtime/poll" && req.method === "GET") {
            const clientId = requestUrl.searchParams.get("clientId") || "";
            this.runtimeBridge.handlePoll(clientId, res, this.writeJson.bind(this));
            return;
        }

        if (pathname === "/runtime/result" && req.method === "POST") {
            const body = await this.readRequestBody(req);
            const payload = body ? JSON.parse(body) : {};
            this.writeJson(res, 200, this.runtimeBridge.acceptResult(payload));
            return;
        }

        this.writeJson(res, 404, {
            success: false,
            error: "未找到运行态接口。"
        });
    }

    async handleSimpleAPIRequest(req, res, pathname) {
        if (this.isLicenseExpired()) {
            this.rejectLicenseExpired(res, "api");
            return;
        }

        const pathParts = pathname.split("/").filter(Boolean);
        if (pathParts.length < 3) {
            this.writeJson(res, 400, { error: "接口路径无效，请使用 /api/{category}/{tool_name}" });
            return;
        }

        const category = pathParts[1];
        const toolName = pathParts.slice(2).join("_");
        const fullToolName = `${category}_${toolName}`;
        let params = {};

        try {
            const body = await this.readRequestBody(req);
            params = body ? JSON.parse(body) : {};
        }
        catch (error) {
            this.writeJson(res, 400, { error: "请求体 JSON 无效", details: error.message });
            return;
        }

        try {
            const toolCall = this.beginToolCall(fullToolName);
            let result;
            try {
                result = await this.executeToolCall(fullToolName, params);
                this.finishToolCall(toolCall);
            }
            catch (error) {
                this.finishToolCall(toolCall, error);
                throw error;
            }
            this.writeJson(res, 200, {
                success: true,
                tool: fullToolName,
                result
            });
        }
        catch (error) {
            console.error("[MCPServer] 简易 API 请求失败：", error);
            this.writeJson(res, 500, {
                success: false,
                error: error.message,
                tool: pathname
            });
        }
    }

    getSimplifiedToolsList() {
        return this.toolsList.map((tool) => {
            const parts = tool.name.split("_");
            const category = parts[0];
            const toolName = parts.slice(1).join("_");
            return {
                name: tool.name,
                category,
                toolName,
                description: tool.description,
                apiPath: `/api/${category}/${toolName}`
            };
        });
    }

    setCorsHeaders(res) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, mcp-session-id");
    }

    writeJson(res, statusCode, payload) {
        res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(payload));
    }

    readRequestBody(req) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            let size = 0;
            const limit = 2 * 1024 * 1024;

            req.on("data", (chunk) => {
                size += chunk.length;
                if (size > limit) {
                    reject(new Error("请求体过大"));
                    req.destroy();
                    return;
                }
                chunks.push(chunk);
            });

            req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
            req.on("error", reject);
        });
    }

    parseRequestUrl(req) {
        return new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    }
}

exports.MCPServer = MCPServer;
MCPServer.__cocosMcpChineseBuild = true;
