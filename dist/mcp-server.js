"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
exports.MCPServer = void 0;

const http = require("http");
const https = require("https");
const fs = require("fs");
const net = require("net");
const path = require("path");
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
        this.runtimePreviewOrigin = "";
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
            this.httpServer.on("upgrade", this.handleRuntimePreviewUpgrade.bind(this));

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

            if (pathname === "/engine_external/" && req.method === "GET") {
                await this.handleEngineExternalRequest(res, requestUrl);
                return;
            }

            if (pathname.startsWith("/api/") && req.method === "POST") {
                this.mcpRequestCount += 1;
                this.serviceConnectionCount += 1;
                await this.handleSimpleAPIRequest(req, res, pathname);
                return;
            }

            if (this.isRuntimePreviewPassthroughPath(pathname)) {
                await this.handleRuntimePreviewPassthrough(req, res, pathname, requestUrl);
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
                            version: "1.7.6"
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
        if (req.method === "GET" && this.isRuntimeWasmPath(pathname)) {
            if (this.serveRuntimeWasmFallback(res, pathname)) {
                return;
            }
        }

        if (pathname === "/runtime/preview" && req.method === "GET") {
            await this.handleRuntimePreviewPage(req, res, requestUrl);
            return;
        }

        if (pathname.startsWith("/runtime/preview-proxy/") && req.method === "GET") {
            await this.handleRuntimePreviewProxy(req, res, pathname, requestUrl);
            return;
        }

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

        if (pathname === "/runtime/clear" && req.method === "POST") {
            this.writeJson(res, 200, this.runtimeBridge.clearClients());
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

    async handleRuntimePreviewPage(req, res, requestUrl) {
        const previewUrl = requestUrl.searchParams.get("url") || "http://127.0.0.1:7456/";
        const targetUrl = this.normalizeRuntimePreviewUrl(previewUrl);
        if (!targetUrl) {
            this.writeJson(res, 400, {
                success: false,
                error: "预览地址无效，只支持 http/https 地址。"
            });
            return;
        }
        this.runtimePreviewOrigin = new URL(targetUrl).origin;
        await this.proxyRuntimePreviewResource(res, targetUrl, true);
    }

    isRuntimePreviewPassthroughPath(pathname) {
        if (!this.runtimePreviewOrigin) {
            return false;
        }
        return pathname === "/index.css"
            || pathname === "/favicon.ico"
            || pathname === "/settings.js"
            || pathname.startsWith("/socket.io/")
            || this.isRuntimeWasmPath(pathname)
            || pathname.startsWith("/scripting/")
            || pathname.startsWith("/preview-app/")
            || pathname.startsWith("/scene/")
            || pathname.startsWith("/missing-asset/")
            || pathname.startsWith("/assets/")
            || pathname.startsWith("/resources/")
            || pathname.startsWith("/chunks/")
            || pathname.startsWith("/src/")
            || pathname.startsWith("/library/");
    }

    async handleRuntimePreviewPassthrough(req, res, pathname, requestUrl) {
        const targetUrl = this.normalizeRuntimePreviewUrl(`${this.runtimePreviewOrigin}${pathname}${requestUrl.search || ""}`);
        if (!targetUrl) {
            this.writeJson(res, 400, {
                success: false,
                error: "运行态预览资源转发地址无效。"
            });
            return;
        }
        const body = req.method === "GET" || req.method === "HEAD" ? null : Buffer.from(await this.readRequestBody(req), "utf8");
        await this.proxyRuntimePreviewResource(res, targetUrl, false, {
            method: req.method,
            body,
            headers: req.headers
        });
    }

    handleRuntimePreviewUpgrade(req, socket, head) {
        try {
            const requestUrl = this.parseRequestUrl(req);
            const pathname = requestUrl.pathname || "/";
            if (!this.runtimePreviewOrigin || !pathname.startsWith("/socket.io/")) {
                socket.destroy();
                return;
            }

            const target = new URL(this.runtimePreviewOrigin);
            const port = Number(target.port) || (target.protocol === "https:" ? 443 : 80);
            const upstream = net.connect(port, target.hostname, () => {
                const lines = [`${req.method} ${requestUrl.pathname}${requestUrl.search || ""} HTTP/${req.httpVersion}`];
                const headers = Object.assign({}, req.headers, {
                    host: target.host,
                    origin: target.origin
                });
                for (const [key, value] of Object.entries(headers)) {
                    if (Array.isArray(value)) {
                        for (const item of value) {
                            lines.push(`${key}: ${item}`);
                        }
                    } else if (value !== undefined) {
                        lines.push(`${key}: ${value}`);
                    }
                }
                upstream.write(lines.join("\r\n") + "\r\n\r\n");
                if (head && head.length) {
                    upstream.write(head);
                }
                upstream.pipe(socket);
                socket.pipe(upstream);
            });
            upstream.on("error", () => socket.destroy());
            socket.on("error", () => upstream.destroy());
        }
        catch (_) {
            socket.destroy();
        }
    }

    async handleRuntimePreviewProxy(req, res, pathname, requestUrl) {
        const prefix = "/runtime/preview-proxy/";
        const rest = pathname.slice(prefix.length);
        const slashIndex = rest.indexOf("/");
        if (slashIndex < 0) {
            this.writeJson(res, 400, {
                success: false,
                error: "代理预览路径无效。"
            });
            return;
        }

        const origin = decodeURIComponent(rest.slice(0, slashIndex));
        const resourcePath = rest.slice(slashIndex) || "/";
        const targetUrl = this.normalizeRuntimePreviewUrl(`${origin}${resourcePath}${requestUrl.search || ""}`);
        if (!targetUrl) {
            this.writeJson(res, 400, {
                success: false,
                error: "代理目标地址无效。"
            });
            return;
        }

        await this.proxyRuntimePreviewResource(res, targetUrl, false);
    }

    async handleEngineExternalRequest(res, requestUrl) {
        const externalUrl = requestUrl.searchParams.get("url") || "";
        if (!externalUrl.startsWith("external:emscripten/")) {
            this.writeJson(res, 400, {
                success: false,
                error: "engine_external 只支持 external:emscripten 资源。"
            });
            return;
        }

        if (this.isRuntimeWasmPath(externalUrl)) {
            if (this.serveRuntimeWasmFallback(res, externalUrl)) {
                return;
            }
            this.writeJson(res, 404, {
                success: false,
                error: "未找到 engine external WASM 资源。",
                url: externalUrl
            });
            return;
        }

        const buffer = this.readEngineExternalFile(externalUrl);
        if (!buffer) {
            this.writeJson(res, 404, {
                success: false,
                error: "未找到 engine external 资源。",
                url: externalUrl
            });
            return;
        }

        res.writeHead(200, {
            "Content-Type": externalUrl.endsWith(".json") ? "application/json; charset=utf-8" : "application/javascript; charset=utf-8",
            "Cache-Control": "no-cache"
        });
        res.end(buffer);
    }

    readEngineExternalFile(externalUrl) {
        const relativePath = this.getEngineExternalRelativePath(externalUrl);
        if (!relativePath) {
            return null;
        }
        for (const engineRoot of this.getCreatorEngineRoots()) {
            const fullPath = path.join(engineRoot, relativePath);
            try {
                if (fs.existsSync(fullPath)) {
                    return fs.readFileSync(fullPath);
                }
            }
            catch (_) {
            }
        }
        return null;
    }

    getEngineExternalRelativePath(externalUrl) {
        const decoded = decodeURIComponent(String(externalUrl || ""));
        if (!decoded.startsWith("external:emscripten/")) {
            return null;
        }
        const rest = decoded.slice("external:emscripten/".length);
        if (rest.includes("..") || path.isAbsolute(rest)) {
            return null;
        }
        if (rest.endsWith(".js")) {
            const parts = rest.split("/");
            const fileName = parts.pop();
            return path.join("bin", ".cache", "dev", "preview", "external", "external%3Aemscripten", ...parts, `${fileName}.js`);
        }
        return path.join("native", "external", "emscripten", ...rest.split("/"));
    }

    normalizeRuntimePreviewUrl(value) {
        try {
            const parsed = new URL(String(value || ""));
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                return null;
            }
            return parsed.toString();
        }
        catch (_) {
            return null;
        }
    }

    getRuntimePreviewProxyBase(targetUrl) {
        const parsed = new URL(targetUrl);
        let dir = parsed.pathname || "/";
        if (!dir.endsWith("/")) {
            dir = dir.slice(0, dir.lastIndexOf("/") + 1) || "/";
        }
        return `/runtime/preview-proxy/${encodeURIComponent(parsed.origin)}${dir}`;
    }

    injectRuntimeBridgeIntoHtml(html, targetUrl) {
        const proxyBase = this.getRuntimePreviewProxyBase(targetUrl);
        const injection = [
            `<base href="${proxyBase}">`,
            `<script id="cocos-mcp-runtime-bridge" src="/runtime/bridge.js?t=${Date.now()}"></script>`
        ].join("");
        if (/<head[^>]*>/i.test(html)) {
            return html.replace(/<head([^>]*)>/i, `<head$1>${injection}`);
        }
        if (/<body[^>]*>/i.test(html)) {
            return html.replace(/<body([^>]*)>/i, `<body$1>${injection}`);
        }
        return `${injection}${html}`;
    }

    async proxyRuntimePreviewResource(res, targetUrl, forceInjectHtml, options = {}) {
        let response = await this.fetchRuntimePreviewResource(targetUrl, options);
        if (this.isRuntimeWasmPath(new URL(targetUrl).pathname) && !this.isWasmBinary(response.body)) {
            const fallback = this.readRuntimeWasmFallback(new URL(targetUrl).pathname);
            if (fallback) {
                response = {
                    statusCode: 200,
                    headers: { "content-type": "application/wasm" },
                    body: fallback
                };
            }
        }

        if (forceInjectHtml) {
            const html = this.injectRuntimeBridgeIntoHtml(response.body.toString("utf8"), targetUrl);
            res.writeHead(response.statusCode || 200, {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-cache"
            });
            res.end(html);
            return;
        }

        const headers = {};
        for (const [key, value] of Object.entries(response.headers)) {
            const lower = key.toLowerCase();
            if (["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length"].includes(lower)) {
                continue;
            }
            headers[key] = value;
        }
        const contentType = this.getRuntimePreviewContentType(targetUrl, headers["content-type"] || headers["Content-Type"]);
        if (contentType) {
            headers["Content-Type"] = contentType;
            delete headers["content-type"];
        }
        headers["Cache-Control"] = "no-cache";
        res.writeHead(response.statusCode || 200, headers);
        res.end(response.body);
    }

    getRuntimePreviewContentType(targetUrl, originalContentType) {
        const pathname = new URL(targetUrl).pathname || "";
        if (this.isRuntimeWasmPath(pathname)) {
            return "application/wasm";
        }
        if (pathname.endsWith(".js") || pathname === "/settings.js") {
            return "application/javascript; charset=utf-8";
        }
        if (pathname.endsWith(".json") || pathname.endsWith("import-map-global")) {
            return "application/json; charset=utf-8";
        }
        return originalContentType || "";
    }

    isRuntimeWasmPath(pathname) {
        return /\.wasm(?:\.wasm)?(?:$|\?)/i.test(String(pathname || ""));
    }

    isWasmBinary(buffer) {
        return Buffer.isBuffer(buffer)
            && buffer.length >= 4
            && buffer[0] === 0x00
            && buffer[1] === 0x61
            && buffer[2] === 0x73
            && buffer[3] === 0x6d;
    }

    serveRuntimeWasmFallback(res, pathname) {
        const buffer = this.readRuntimeWasmFallback(pathname);
        if (!buffer) {
            return false;
        }
        res.writeHead(200, {
            "Content-Type": "application/wasm",
            "Cache-Control": "no-cache"
        });
        res.end(buffer);
        return true;
    }

    readRuntimeWasmFallback(pathname) {
        const relativePath = this.getRuntimeWasmRelativePath(pathname);
        if (!relativePath) {
            return null;
        }
        for (const engineRoot of this.getCreatorEngineRoots()) {
            const fullPath = path.join(engineRoot, relativePath);
            try {
                if (fs.existsSync(fullPath)) {
                    const buffer = fs.readFileSync(fullPath);
                    return this.isWasmBinary(buffer) ? buffer : null;
                }
            }
            catch (_) {
            }
        }
        return null;
    }

    getRuntimeWasmRelativePath(pathname) {
        const decoded = decodeURIComponent(String(pathname || ""));
        const fileName = path.basename(decoded).toLowerCase();
        const mappings = {
            "bullet.release.wasm.wasm": path.join("native", "external", "emscripten", "bullet", "bullet.release.wasm.wasm"),
            "bullet.debug.wasm.wasm": path.join("native", "external", "emscripten", "bullet", "bullet.debug.wasm.wasm"),
            "spine.wasm": path.join("native", "external", "emscripten", "spine", "spine.wasm"),
            "box2d.release.wasm.wasm": path.join("native", "external", "emscripten", "box2d", "box2d.release.wasm.wasm"),
            "box2d.debug.wasm.wasm": path.join("native", "external", "emscripten", "box2d", "box2d.debug.wasm.wasm"),
            "physx.release.wasm.wasm": path.join("native", "external", "emscripten", "physx", "physx.release.wasm.wasm"),
            "physx.debug.wasm.wasm": path.join("native", "external", "emscripten", "physx", "physx.debug.wasm.wasm"),
            "meshopt_decoder.wasm.wasm": path.join("native", "external", "emscripten", "meshopt", "meshopt_decoder.wasm.wasm"),
            "glslang.wasm": path.join("native", "external", "emscripten", "webgpu", "glslang.wasm"),
            "twgsl.wasm": path.join("native", "external", "emscripten", "webgpu", "twgsl.wasm"),
            "webgpu_wasm.wasm": path.join("native", "external", "emscripten", "webgpu", "webgpu_wasm.wasm")
        };
        if (mappings[fileName]) {
            return mappings[fileName];
        }
        if (/^bullet\.release\.wasm[-.].*\.wasm$/i.test(fileName) || fileName.includes("bullet.release.wasm")) {
            return mappings["bullet.release.wasm.wasm"];
        }
        if (/^bullet\.debug\.wasm[-.].*\.wasm$/i.test(fileName) || fileName.includes("bullet.debug.wasm")) {
            return mappings["bullet.debug.wasm.wasm"];
        }
        if (/^spine(?:[-.]|\.wasm)/i.test(fileName) || fileName.includes("spine.wasm")) {
            return mappings["spine.wasm"];
        }
        if (/^box2d\.release\.wasm[-.].*\.wasm$/i.test(fileName) || fileName.includes("box2d.release.wasm")) {
            return mappings["box2d.release.wasm.wasm"];
        }
        if (/^box2d\.debug\.wasm[-.].*\.wasm$/i.test(fileName) || fileName.includes("box2d.debug.wasm")) {
            return mappings["box2d.debug.wasm.wasm"];
        }
        if (/^physx\.release\.wasm[-.].*\.wasm$/i.test(fileName) || fileName.includes("physx.release.wasm")) {
            return mappings["physx.release.wasm.wasm"];
        }
        if (/^physx\.debug\.wasm[-.].*\.wasm$/i.test(fileName) || fileName.includes("physx.debug.wasm")) {
            return mappings["physx.debug.wasm.wasm"];
        }
        if (fileName.includes("meshopt_decoder.wasm")) {
            return mappings["meshopt_decoder.wasm.wasm"];
        }
        if (fileName.includes("glslang.wasm")) {
            return mappings["glslang.wasm"];
        }
        if (fileName.includes("twgsl.wasm")) {
            return mappings["twgsl.wasm"];
        }
        if (fileName.includes("webgpu_wasm.wasm")) {
            return mappings["webgpu_wasm.wasm"];
        }
        return null;
    }

    getCreatorEngineRoots() {
        const roots = [];
        const add = (value) => {
            if (value && !roots.includes(value)) {
                roots.push(value);
            }
        };
        try {
            const appPath = globalThis.Editor && globalThis.Editor.App && globalThis.Editor.App.path;
            if (appPath) {
                add(path.join(appPath, "resources", "resources", "3d", "engine"));
            }
        }
        catch (_) {
        }
        try {
            if (process && process.execPath) {
                add(path.join(path.dirname(process.execPath), "resources", "resources", "3d", "engine"));
            }
        }
        catch (_) {
        }
        try {
            const version = globalThis.Editor && globalThis.Editor.App && globalThis.Editor.App.version || "3.8.2";
            add(path.join("C:\\ProgramData\\cocos\\editors\\Creator", version, "resources", "resources", "3d", "engine"));
        }
        catch (_) {
        }
        add("C:\\ProgramData\\cocos\\editors\\Creator\\3.8.2\\resources\\resources\\3d\\engine");
        return roots;
    }

    buildRuntimePreviewHeaders(sourceHeaders = {}, targetUrl, body) {
        const headers = {};
        for (const [key, value] of Object.entries(sourceHeaders || {})) {
            const lower = key.toLowerCase();
            if (["host", "connection", "content-length", "accept-encoding", "origin", "referer"].includes(lower)) {
                continue;
            }
            headers[key] = value;
        }
        headers["Host"] = targetUrl.host;
        headers["User-Agent"] = headers["User-Agent"] || headers["user-agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";
        headers["Accept"] = headers["Accept"] || headers["accept"] || "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
        headers["Accept-Encoding"] = "identity";
        headers["Accept-Language"] = headers["Accept-Language"] || headers["accept-language"] || "zh-CN,zh;q=0.9,en;q=0.8";
        headers["Connection"] = "close";
        headers["Origin"] = targetUrl.origin;
        headers["Referer"] = targetUrl.origin + "/";
        if (body) {
            headers["Content-Length"] = Buffer.byteLength(body);
        }
        return headers;
    }

    fetchRuntimePreviewResource(targetUrl, options = {}) {
        return new Promise((resolve, reject) => {
            const parsed = new URL(targetUrl);
            const client = parsed.protocol === "https:" ? https : http;
            const headers = this.buildRuntimePreviewHeaders(options.headers, parsed, options.body);
            const request = client.request(parsed, {
                method: options.method || "GET",
                headers
            }, (response) => {
                const chunks = [];
                response.on("data", (chunk) => chunks.push(chunk));
                response.on("end", () => {
                    resolve({
                        statusCode: response.statusCode || 200,
                        headers: response.headers || {},
                        body: Buffer.concat(chunks)
                    });
                });
            });
            request.setTimeout(10000, () => {
                request.destroy(new Error("读取 Cocos 预览页超时。"));
            });
            request.on("error", reject);
            if (options.body) {
                request.write(options.body);
            }
            request.end();
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
