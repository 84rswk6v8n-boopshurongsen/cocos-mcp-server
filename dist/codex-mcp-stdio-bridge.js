'use strict';

const http = require('http');
const https = require('https');

const targetUrl = process.env.COCOS_MCP_URL || 'http://127.0.0.1:3300/mcp';

function postToMcp(message) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(message);
        const url = new URL(targetUrl);
        const client = url.protocol === 'https:' ? https : http;
        const request = client.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: `${url.pathname}${url.search}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
                'Content-Length': Buffer.byteLength(body),
            },
        }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8').trim();
                if (!text) {
                    resolve(null);
                    return;
                }

                try {
                    resolve(parseMcpResponse(text));
                } catch (error) {
                    reject(new Error(`MCP HTTP 返回不是 JSON：${text.slice(0, 300)}`));
                }
            });
        });

        request.on('error', reject);
        request.write(body);
        request.end();
    });
}

function parseMcpResponse(text) {
    if (!text) {
        return null;
    }
    try {
        return JSON.parse(text);
    }
    catch (_) {}

    const dataLines = String(text).split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter(Boolean);
    if (dataLines.length > 0) {
        return JSON.parse(dataLines[dataLines.length - 1]);
    }

    throw new Error('invalid MCP response');
}

function writeResponse(response) {
    if (response) {
        process.stdout.write(`${JSON.stringify(response)}\n`);
    }
}

function writeError(message, error) {
    const id = message && Object.prototype.hasOwnProperty.call(message, 'id') ? message.id : null;
    writeResponse({
        jsonrpc: '2.0',
        id,
        error: {
            code: -32603,
            message: error && error.message ? error.message : String(error),
        },
    });
}

let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffer += chunk;

    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) {
            continue;
        }

        let message;
        try {
            message = JSON.parse(line);
        } catch (_) {
            continue;
        }

        postToMcp(message)
            .then(writeResponse)
            .catch((error) => writeError(message, error));
    }
});
