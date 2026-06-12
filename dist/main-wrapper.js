'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const mainModule = require('./main');

function escapeTomlString(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function toCodexPath(value) {
    return String(value).replace(/\\/g, '/');
}

function findNodeCommand() {
    try {
        const command = process.platform === 'win32' ? 'where' : 'which';
        const output = childProcess.execFileSync(command, ['node'], {
            encoding: 'utf8',
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const first = String(output || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
        if (first) {
            return first;
        }
    } catch (_) {
        // 没找到全局 node 时交给 Codex 运行环境按 PATH 解析。
    }
    return 'node';
}

function findCodexMcpSection(lines) {
    return lines.findIndex((line) => /^\s*\[mcp_servers\.(?:"cocos-mcp-server"|cocos-mcp-server)\]\s*$/.test(line));
}

function upsertCodexMcpConfig(content, serverUrl) {
    const normalized = String(content || '').replace(/\r\n/g, '\n');
    const lines = normalized ? normalized.split('\n') : [];
    const bridgePath = toCodexPath(path.join(__dirname, 'codex-mcp-stdio-bridge.js'));
    const nodeCommand = findNodeCommand();
    const section = [
        '[mcp_servers.cocos-mcp-server]',
        `command = "${escapeTomlString(nodeCommand)}"`,
        `args = ["${escapeTomlString(bridgePath)}"]`,
        `env = { COCOS_MCP_URL = "${escapeTomlString(serverUrl)}" }`,
    ];
    const start = findCodexMcpSection(lines);

    if (start >= 0) {
        let end = lines.length;
        for (let index = start + 1; index < lines.length; index++) {
            if (/^\s*\[/.test(lines[index])) {
                end = index;
                break;
            }
        }
        lines.splice(start, end - start, ...section);
        return lines.join(os.EOL).replace(/(\r?\n)*$/, os.EOL);
    }

    while (lines.length && lines[lines.length - 1] === '') {
        lines.pop();
    }
    if (lines.length) {
        lines.push('');
    }
    lines.push(...section);
    return lines.join(os.EOL) + os.EOL;
}

function getCodexConfigPath() {
    return path.join(os.homedir(), '.codex', 'config.toml');
}

async function devConfigureCodex(options = {}) {
    const port = Number(options.port || 3000);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        return {
            success: false,
            message: '请先输入 1024 到 65535 之间的 MCP 端口。',
        };
    }

    const serverUrl = options.serverUrl || `http://127.0.0.1:${port}/mcp`;
    const configPath = getCodexConfigPath();
    const configDir = path.dirname(configPath);

    try {
        fs.mkdirSync(configDir, { recursive: true });
        const oldContent = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
        const nextContent = upsertCodexMcpConfig(oldContent, serverUrl);
        fs.writeFileSync(configPath, nextContent, 'utf8');
        return {
            success: true,
            configPath,
            serverUrl,
            message: '已写入 Codex MCP 本地桥接配置。请重新打开 Codex 对话后使用 cocos-mcp-server。',
        };
    } catch (error) {
        return {
            success: false,
            configPath,
            serverUrl,
            message: `写入 Codex MCP 配置失败：${error && error.message ? error.message : String(error)}`,
        };
    }
}

if (mainModule && mainModule.methods) {
    mainModule.methods.devConfigureCodex = devConfigureCodex;
}
if (mainModule) {
    mainModule.devConfigureCodex = devConfigureCodex;
}

module.exports = mainModule;
