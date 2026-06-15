'use strict';

const { readFileSync } = require('fs');
const { join } = require('path');
const packageJson = require('../../../package.json');

const text = {
    start: '\u542f\u52a8 MCP \u670d\u52a1\u5668',
    restart: '\u91cd\u542f MCP \u670d\u52a1\u5668',
    stop: '\u505c\u6b62 MCP \u670d\u52a1\u5668',
    address: '\u83b7\u53d6 MCP \u5730\u5740',
    checking: '\u68c0\u6d4b\u4e2d...',
    running: '\u8fd0\u884c\u4e2d',
    stopped: '\u5df2\u505c\u6b62',
    abnormal: '\u5f02\u5e38',
    runningMessage: 'MCP \u670d\u52a1\u5668\u6b63\u5728\u8fd0\u884c\u3002',
    stoppedMessage: 'MCP \u670d\u52a1\u5668\u5df2\u505c\u6b62\u3002',
    abnormalMessage: 'MCP \u670d\u52a1\u5668\u72b6\u6001\u5f02\u5e38\u3002',
    statusFailed: '\u83b7\u53d6 MCP \u670d\u52a1\u5668\u72b6\u6001\u5931\u8d25\u3002',
    invalidPort: '\u8bf7\u8f93\u5165 1024 \u5230 65535 \u4e4b\u95f4\u7684\u7aef\u53e3\u3002',
    portInUse: '\u7aef\u53e3\u5df2\u88ab\u5360\u7528\uff0c\u8bf7\u6362\u4e00\u4e2a\u7aef\u53e3\u540e\u91cd\u8bd5\u3002',
    operationFailed: '\u64cd\u4f5c\u5931\u8d25\u3002',
    starting: '\u6b63\u5728\u542f\u52a8...',
    restarting: '\u6b63\u5728\u91cd\u542f...',
    stopping: '\u6b63\u5728\u505c\u6b62...',
    startingMessage: '\u6b63\u5728\u542f\u52a8 MCP \u670d\u52a1\u5668...',
    restartingMessage: '\u6b63\u5728\u91cd\u542f MCP \u670d\u52a1\u5668...',
    stoppingMessage: '\u6b63\u5728\u505c\u6b62 MCP \u670d\u52a1\u5668...',
    stoppedOk: 'MCP \u670d\u52a1\u5668\u5df2\u505c\u6b62\u3002',
    addressCopied: 'MCP \u5730\u5740\u5df2\u590d\u5236\u3002',
    autoStartSaved: '\u81ea\u52a8\u542f\u52a8\u8bbe\u7f6e\u5df2\u4fdd\u5b58\u3002',
    autoStartFailed: '\u4fdd\u5b58\u81ea\u52a8\u542f\u52a8\u8bbe\u7f6e\u5931\u8d25\u3002',
    portChanged: '\u7aef\u53e3\u5df2\u4fee\u6539\uff0c\u70b9\u51fb\u542f\u52a8 MCP \u670d\u52a1\u5668\u540e\u751f\u6548\u3002',
    toolsLoading: '\u6b63\u5728\u8bfb\u53d6\u5de5\u5177\u5217\u8868...',
    toolsEmpty: '\u6682\u65e0\u5de5\u5177\u6570\u636e\u3002',
    toolsFailed: '\u8bfb\u53d6\u5de5\u5177\u5217\u8868\u5931\u8d25\u3002',
    wechatCopied: '\u5fae\u4fe1\u5df2\u590d\u5236\u3002',
    reloadingPlugin: '\u6b63\u5728\u91cd\u65b0\u52a0\u8f7d\u63d2\u4ef6...',
    reloadPluginSent: '\u63d2\u4ef6\u91cd\u65b0\u52a0\u8f7d\u547d\u4ee4\u5df2\u53d1\u9001\u3002',
    reloadPluginFailed: '\u91cd\u65b0\u52a0\u8f7d\u63d2\u4ef6\u5931\u8d25\u3002',
    configuringCodex: '\u6b63\u5728\u5199\u5165 Codex MCP \u914d\u7f6e...',
    configureCodexOk: '\u5df2\u5199\u5165 Codex MCP \u672c\u5730\u6865\u63a5\u914d\u7f6e\uff0c\u65b0\u5f00 Codex \u5bf9\u8bdd\u540e\u751f\u6548\u3002',
    configureCodexFailed: '\u5199\u5165 Codex MCP \u914d\u7f6e\u5931\u8d25\u3002',
};

module.exports = Editor.Panel.define({
    template: readFileSync(join(__dirname, '../../../static/template/default/start-server-only.html'), 'utf8'),

    $: {
        startMcpServer: '#startMcpServer',
        stopMcpServer: '#stopMcpServer',
        openToolVisualizer: '#openToolVisualizer',
        reloadPlugin: '#reloadPlugin',
        configureCodex: '#configureCodex',
        refreshStatus: '#refreshStatus',
        refreshTools: '#refreshTools',
        serverState: '#serverState',
        serverStateText: '#serverStateText',
        portControl: '#portControl',
        serverPort: '#serverPort',
        serverPortInput: '#serverPortInput',
        serverClients: '#serverClients',
        toolExecutionCount: '#toolExecutionCount',
        mcpRequestCount: '#mcpRequestCount',
        serviceConnectionCount: '#serviceConnectionCount',
        serverUrl: '#serverUrl',
        activeToolCount: '#activeToolCount',
        visualizedToolCount: '#visualizedToolCount',
        lastToolStatus: '#lastToolStatus',
        activeToolsList: '#activeToolsList',
        toolActivityGrid: '#toolActivityGrid',
        autoStartInput: '#autoStartInput',
        toolsSummary: '#toolsSummary',
        toolsList: '#toolsList',
        statusMessage: '#statusMessage',
        mcpVersion: '#mcpVersion',
        mcpWechatContact: '#mcpWechatContact',
        toolTooltip: '#toolTooltip',
        toolTooltipTitle: '#toolTooltipTitle',
        toolTooltipDesc: '#toolTooltipDesc',
    },

    ready() {
        const startButton = this.$.startMcpServer;
        const stopButton = this.$.stopMcpServer;
        const openToolVisualizerButton = this.$.openToolVisualizer;
        const reloadPluginButton = this.$.reloadPlugin;
        const configureCodexButton = this.$.configureCodex;
        const refreshButton = this.$.refreshStatus;
        const refreshToolsButton = this.$.refreshTools;
        const portControl = this.$.portControl;
        const portInput = this.$.serverPortInput;
        const autoStartInput = this.$.autoStartInput;
        let currentAction = 'start';
        let isBusy = false;
        let portInputDirty = false;
        let activeToolItem = null;
        let knownTools = [];
        let currentStatus = {
            running: false,
            port: '-',
            clients: '-',
            toolExecutionCount: '-',
            mcpRequestCount: '-',
            serviceConnectionCount: '-',
            activeToolCalls: [],
            toolStats: [],
            autoStart: false,
            message: '',
        };

        const setText = (element, value) => {
            if (element) {
                element.textContent = value == null || value === '' ? '-' : String(value);
            }
        };

        setText(this.$.mcpVersion, `MCP \u7248\u672c\uff1av${packageJson.version || '-'}`);

        const clearElement = (element) => {
            if (element) {
                while (element.firstChild) {
                    element.removeChild(element.firstChild);
                }
            }
        };

        const normalizePort = (value) => {
            const port = Number(value);
            if (!Number.isInteger(port) || port < 1024 || port > 65535) {
                return null;
            }
            return port;
        };

        const getInputPort = () => {
            if (!portInput) {
                return null;
            }
            return normalizePort(portInput.value);
        };

        const getPreferredPort = () => {
            const inputPort = getInputPort();
            if (inputPort) {
                return inputPort;
            }
            return normalizePort(currentStatus.port);
        };

        const getServerUrl = (status) => {
            const port = status && status.port ? status.port : '-';
            return status && status.running && port !== '-' ? `http://127.0.0.1:${port}/mcp` : '-';
        };

        const syncPortInput = (port, force = false) => {
            if (!portInput || port === '-' || port == null || port === '') {
                return;
            }
            if (portInputDirty && !force) {
                return;
            }
            if (document.activeElement !== portInput || !portInput.value) {
                portInput.value = String(port);
                portInput.classList.remove('invalid');
            }
        };

        const setPrimaryAction = (action) => {
            currentAction = action;
            const textMap = {
                start: text.start,
                restart: text.restart,
                address: text.address,
                checking: text.checking,
            };
            setText(startButton, textMap[action] || textMap.start);
        };

        const updateButtons = (state, status) => {
            if (state === 'checking') {
                setPrimaryAction('checking');
                startButton.disabled = true;
                stopButton.style.display = 'none';
                return;
            }

            startButton.disabled = false;

            if (state === 'abnormal') {
                setPrimaryAction('restart');
                stopButton.style.display = 'none';
                return;
            }

            if (status && status.running) {
                setPrimaryAction('address');
                stopButton.style.display = '';
                stopButton.disabled = false;
                return;
            }

            setPrimaryAction('start');
            stopButton.style.display = 'none';
        };

        const setBusy = (busy, buttonText) => {
            isBusy = busy;
            startButton.disabled = busy;
            stopButton.disabled = busy;
            openToolVisualizerButton.disabled = busy;
            reloadPluginButton.disabled = busy;
            configureCodexButton.disabled = busy;
            refreshButton.disabled = busy;
            refreshToolsButton.disabled = busy;
            if (autoStartInput) {
                autoStartInput.disabled = busy;
            }
            if (busy && buttonText) {
                setText(startButton, buttonText);
            } else if (!busy) {
                updateButtons(currentStatus.state || 'stopped', currentStatus);
            }
        };

        const formatDuration = (ms) => {
            const value = Number(ms || 0);
            if (!Number.isFinite(value) || value <= 0) {
                return '0.0s';
            }
            return `${(value / 1000).toFixed(1)}s`;
        };

        const getShortToolName = (name) => {
            const textValue = String(name || '-');
            const parts = textValue.split('_');
            if (parts.length <= 1) {
                return textValue;
            }
            return parts.slice(1).join('_') || textValue;
        };

        const getToolInitial = (name) => {
            const shortName = getShortToolName(name);
            return shortName && shortName !== '-' ? shortName.charAt(0).toUpperCase() : '?';
        };

        const buildToolStateMap = (status) => {
            const stats = Array.isArray(status && status.toolStats) ? status.toolStats : [];
            const activeCalls = Array.isArray(status && status.activeToolCalls) ? status.activeToolCalls : [];
            const map = new Map();

            for (const stat of stats) {
                const name = stat && (stat.name || stat.toolName);
                if (name) {
                    map.set(name, { ...stat });
                }
            }

            for (const call of activeCalls) {
                const name = call && call.toolName;
                if (!name) {
                    continue;
                }
                const stat = map.get(name) || { name, count: 0, running: 0, lastStatus: 'idle' };
                stat.running = Math.max(Number(stat.running || 0), 1);
                stat.lastStatus = 'running';
                stat.lastStartedAt = call.startedAt || stat.lastStartedAt;
                map.set(name, stat);
            }

            return map;
        };

        const renderActiveTools = (status) => {
            const container = this.$.activeToolsList;
            if (!container) {
                return;
            }

            const activeCalls = Array.isArray(status && status.activeToolCalls) ? status.activeToolCalls : [];
            clearElement(container);

            if (!activeCalls.length) {
                const empty = document.createElement('div');
                empty.className = 'empty-tools';
                empty.textContent = '\u6682\u65e0\u8fd0\u884c\u4e2d\u7684\u5de5\u5177\u3002';
                container.appendChild(empty);
                return;
            }

            const now = Date.now();
            for (const call of activeCalls.slice(-5).reverse()) {
                const item = document.createElement('div');
                item.className = 'active-tool-chip';

                const name = document.createElement('div');
                name.className = 'active-tool-name';
                name.textContent = getShortToolName(call.toolName);
                name.title = call.toolName || '';

                const time = document.createElement('div');
                time.className = 'active-tool-time';
                time.textContent = formatDuration(now - Number(call.startedAt || now));

                item.appendChild(name);
                item.appendChild(time);
                container.appendChild(item);
            }
        };

        const renderToolActivity = (status = currentStatus) => {
            const grid = this.$.toolActivityGrid;
            if (!grid) {
                return;
            }

            const stateMap = buildToolStateMap(status);
            const names = [];
            for (const tool of knownTools) {
                const name = tool && (tool.name || tool.toolName);
                if (name && !names.includes(name)) {
                    names.push(name);
                }
            }
            for (const name of stateMap.keys()) {
                if (!names.includes(name)) {
                    names.push(name);
                }
            }

            clearElement(grid);
            setText(this.$.activeToolCount, Array.isArray(status.activeToolCalls) ? status.activeToolCalls.length : 0);
            setText(this.$.visualizedToolCount, names.length);

            let latestStatus = '-';
            let latestAt = 0;
            for (const stat of stateMap.values()) {
                const endedAt = Number(stat.lastEndedAt || 0);
                const startedAt = Number(stat.lastStartedAt || 0);
                const marker = Math.max(endedAt, startedAt);
                if (marker >= latestAt) {
                    latestAt = marker;
                    latestStatus = stat.lastStatus || '-';
                }
            }
            setText(this.$.lastToolStatus, latestStatus === 'success' ? '\u6210\u529f' : latestStatus === 'error' ? '\u5931\u8d25' : latestStatus === 'running' ? '\u8fd0\u884c' : '-');

            if (!names.length) {
                const empty = document.createElement('div');
                empty.className = 'empty-tools';
                empty.textContent = text.toolsEmpty;
                grid.appendChild(empty);
                renderActiveTools(status);
                return;
            }

            names.sort((a, b) => {
                const aStat = stateMap.get(a) || {};
                const bStat = stateMap.get(b) || {};
                const aRunning = Number(aStat.running || 0) > 0 ? 1 : 0;
                const bRunning = Number(bStat.running || 0) > 0 ? 1 : 0;
                if (aRunning !== bRunning) {
                    return bRunning - aRunning;
                }
                return String(a).localeCompare(String(b));
            });

            for (const name of names) {
                const stat = stateMap.get(name) || { name, count: 0, running: 0, lastStatus: 'idle' };
                const running = Number(stat.running || 0) > 0;
                const recentlyFinished = !running && stat.lastEndedAt && Date.now() - Number(stat.lastEndedAt) < 4000;
                const statusName = running ? 'running' : recentlyFinished ? stat.lastStatus || 'idle' : 'idle';
                const cell = document.createElement('div');
                cell.className = `tool-workcell ${statusName}`;
                cell.title = `${name}\ncount: ${stat.count || 0}\nstatus: ${statusName}${stat.lastError ? `\nerror: ${stat.lastError}` : ''}`;

                const icon = document.createElement('div');
                icon.className = 'tool-workcell-icon';
                icon.textContent = running ? '>' : getToolInitial(name);

                const title = document.createElement('div');
                title.className = 'tool-workcell-name';
                title.textContent = getShortToolName(name);

                const meta = document.createElement('div');
                meta.className = 'tool-workcell-meta';

                const count = document.createElement('span');
                count.textContent = `x${stat.count || 0}`;

                const dot = document.createElement('span');
                dot.className = 'tool-status-dot';

                const duration = document.createElement('span');
                duration.textContent = running
                    ? formatDuration(Date.now() - Number(stat.lastStartedAt || Date.now()))
                    : formatDuration(stat.lastDuration || 0);

                meta.appendChild(count);
                meta.appendChild(dot);
                meta.appendChild(duration);
                cell.appendChild(icon);
                cell.appendChild(title);
                cell.appendChild(meta);
                grid.appendChild(cell);
            }

            renderActiveTools(status);
        };

        const setState = (state, status) => {
            const running = state === 'running';
            const checking = state === 'checking';
            const abnormal = state === 'abnormal';
            const port = status && status.port ? status.port : '-';
            const clients = status && status.clients != null ? status.clients : '-';
            const toolExecutionCount = status && status.toolExecutionCount != null ? status.toolExecutionCount : '-';
            const mcpRequestCount = status && status.mcpRequestCount != null ? status.mcpRequestCount : '-';
            const serviceConnectionCount = status && status.serviceConnectionCount != null ? status.serviceConnectionCount : '-';
            const activeToolCalls = Array.isArray(status && status.activeToolCalls) ? status.activeToolCalls : [];
            const toolStats = Array.isArray(status && status.toolStats) ? status.toolStats : [];
            const nextStatus = {
                ...status,
                state,
                running,
                port,
                clients,
                toolExecutionCount,
                mcpRequestCount,
                serviceConnectionCount,
                activeToolCalls,
                toolStats,
                autoStart: !!(status && status.autoStart),
            };

            currentStatus = nextStatus;
            this.$.serverState.classList.toggle('running', running);
            this.$.serverState.classList.toggle('stopped', state === 'stopped');
            this.$.serverState.classList.toggle('abnormal', abnormal);
            portControl.classList.toggle('running', running);
            setText(this.$.serverStateText, checking ? text.checking : abnormal ? text.abnormal : running ? text.running : text.stopped);
            setText(this.$.serverPort, port);
            setText(this.$.serverClients, clients);
            setText(this.$.toolExecutionCount, toolExecutionCount);
            setText(this.$.mcpRequestCount, mcpRequestCount);
            setText(this.$.serviceConnectionCount, serviceConnectionCount);
            setText(this.$.serverUrl, getServerUrl(nextStatus));
            renderToolActivity(nextStatus);
            syncPortInput(port, running);

            if (autoStartInput) {
                autoStartInput.checked = nextStatus.autoStart;
            }

            if (status && status.message) {
                setText(this.$.statusMessage, status.message);
            } else if (abnormal) {
                setText(this.$.statusMessage, text.abnormalMessage);
            } else {
                setText(this.$.statusMessage, running ? text.runningMessage : text.stoppedMessage);
            }

            updateButtons(state, nextStatus);
        };

        const normalizeStatus = (result) => {
            if (!result || result.success === false) {
                return {
                    success: false,
                    running: false,
                    port: result && result.port ? result.port : currentStatus.port,
                    clients: '-',
                    toolExecutionCount: currentStatus.toolExecutionCount,
                    mcpRequestCount: currentStatus.mcpRequestCount,
                    serviceConnectionCount: currentStatus.serviceConnectionCount,
                    activeToolCalls: currentStatus.activeToolCalls,
                    toolStats: currentStatus.toolStats,
                    autoStart: result && result.autoStart != null ? !!result.autoStart : currentStatus.autoStart,
                    message: result && result.message ? result.message : text.statusFailed,
                };
            }

            return {
                success: true,
                running: !!result.running,
                port: result.port || '-',
                clients: result.clients != null ? result.clients : 0,
                toolExecutionCount: result.toolExecutionCount != null ? result.toolExecutionCount : 0,
                mcpRequestCount: result.mcpRequestCount != null ? result.mcpRequestCount : 0,
                serviceConnectionCount: result.serviceConnectionCount != null ? result.serviceConnectionCount : 0,
                activeToolCalls: Array.isArray(result.activeToolCalls) ? result.activeToolCalls : [],
                toolStats: Array.isArray(result.toolStats) ? result.toolStats : [],
                autoStart: !!result.autoStart,
                message: result.message || '',
            };
        };

        const requestStatus = async () => {
            try {
                const devStatus = await Editor.Message.request('cocos-mcp-server', 'dev-get-server-status');
                if (devStatus) {
                    return devStatus;
                }
            } catch (error) {
                // 扩展未重载前，旧 manifest 可能还没有开发状态入口。
            }

            try {
                return await Editor.Message.request('cocos-mcp-server', 'get-server-status');
            } catch (error) {
                const message = error && error.message ? error.message : String(error);
                return {
                    success: false,
                    running: false,
                    message,
                };
            }
        };

        const refreshStatus = async (showChecking = true) => {
            if (isBusy) {
                return;
            }

            refreshButton.disabled = true;
            if (showChecking) {
                setState('checking', currentStatus);
            }

            try {
                const status = normalizeStatus(await requestStatus());
                const state = status.success === false ? 'abnormal' : status.running ? 'running' : 'stopped';
                setState(state, status);
            } finally {
                refreshButton.disabled = false;
            }
        };

        const formatVisibleError = (message) => {
            if (/EADDRINUSE|address already in use/i.test(message)) {
                return text.portInUse;
            }
            return message || text.operationFailed;
        };

        const showError = (message, error) => {
            const visibleMessage = formatVisibleError(message);
            if (error) {
                console.error('[cocos-mcp-server] 启动 MCP 服务器失败：', error);
            } else {
                console.error('[cocos-mcp-server] ' + visibleMessage);
            }

            if (Editor.Dialog && Editor.Dialog.error) {
                Editor.Dialog.error('MCP 服务器', { detail: visibleMessage });
            }

            return visibleMessage;
        };

        const copyText = async (value) => {
            if (!value || value === '-') {
                return false;
            }

            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(value);
                return true;
            }

            const textarea = document.createElement('textarea');
            textarea.value = value;
            textarea.style.position = 'fixed';
            textarea.style.left = '-9999px';
            document.body.appendChild(textarea);
            textarea.focus();
            textarea.select();
            const copied = document.execCommand('copy');
            document.body.removeChild(textarea);
            return copied;
        };

        const hideToolTooltip = () => {
            if (activeToolItem) {
                activeToolItem.classList.remove('active');
                activeToolItem = null;
            }
            if (this.$.toolTooltip) {
                this.$.toolTooltip.classList.remove('show');
            }
        };

        const formatToolDescription = (description, actions) => {
            const parts = [description || '\u65e0\u8bf4\u660e'];
            if (Array.isArray(actions) && actions.length > 0) {
                parts.push(`\u53ef\u7528\u64cd\u4f5c\uff1a${actions.join(' / ')}`);
            }
            return parts.join('\n');
        };

        const showToolTooltip = (item, name, description, actions) => {
            const tooltip = this.$.toolTooltip;
            if (!tooltip) {
                return;
            }

            if (activeToolItem && activeToolItem !== item) {
                activeToolItem.classList.remove('active');
            }

            activeToolItem = item;
            item.classList.add('active');
            setText(this.$.toolTooltipTitle, name || '-');
            setText(this.$.toolTooltipDesc, formatToolDescription(description, actions));

            tooltip.classList.add('show');
            tooltip.style.left = '0px';
            tooltip.style.top = '0px';

            const margin = 12;
            const itemRect = item.getBoundingClientRect();
            const tooltipRect = tooltip.getBoundingClientRect();
            let left = itemRect.left;
            let top = itemRect.top;

            if (left + tooltipRect.width > window.innerWidth - margin) {
                left = window.innerWidth - tooltipRect.width - margin;
            }
            if (top + tooltipRect.height > window.innerHeight - margin) {
                top = window.innerHeight - tooltipRect.height - margin;
            }

            tooltip.style.left = `${Math.max(margin, left)}px`;
            tooltip.style.top = `${Math.max(margin, top)}px`;
        };

        const bindToolTooltip = (item, name, description, actions) => {
            item.setAttribute('title', formatToolDescription(description, actions));
            item.addEventListener('click', (event) => {
                event.stopPropagation();
                showToolTooltip(item, name, description, actions);
            });
        };

        const renderTools = (result) => {
            hideToolTooltip();
            const tools = result && Array.isArray(result.tools) ? result.tools : [];
            const skills = result && Array.isArray(result.skills) ? result.skills : [];
            const source = result && result.source ? result.source : 'MCP';
            knownTools = tools.map((tool) => ({
                name: tool.name || tool.toolName || '-',
                description: tool.description || '',
                actions: Array.isArray(tool.actions) ? tool.actions : []
            }));
            renderToolActivity(currentStatus);

            setText(this.$.toolsSummary, `${source}\uff1a\u5de5\u5177 ${tools.length} \u4e2a\uff0cSkill ${skills.length} \u4e2a`);
            clearElement(this.$.toolsList);

            if (!tools.length && !skills.length) {
                const empty = document.createElement('div');
                empty.className = 'empty-tools';
                empty.textContent = text.toolsEmpty;
                this.$.toolsList.appendChild(empty);
                return;
            }

            for (const tool of tools) {
                const item = document.createElement('div');
                item.className = 'tool-item';

                const name = document.createElement('div');
                name.className = 'tool-name';
                name.textContent = tool.name || tool.toolName || '-';

                const desc = document.createElement('div');
                desc.className = 'tool-desc';
                desc.textContent = tool.description || '\u65e0\u8bf4\u660e';

                const actions = Array.isArray(tool.actions) ? tool.actions : [];
                if (actions.length > 0) {
                    const actionText = document.createElement('div');
                    actionText.className = 'tool-desc';
                    actionText.textContent = `\u64cd\u4f5c\uff1a${actions.slice(0, 6).join(' / ')}${actions.length > 6 ? ' ...' : ''}`;
                    item.appendChild(name);
                    item.appendChild(desc);
                    item.appendChild(actionText);
                }
                else {
                    item.appendChild(name);
                    item.appendChild(desc);
                }

                bindToolTooltip(item, name.textContent, desc.textContent, actions);
                this.$.toolsList.appendChild(item);
            }

            for (const skill of skills) {
                const item = document.createElement('div');
                item.className = 'tool-item';

                const name = document.createElement('div');
                name.className = 'tool-name';
                name.textContent = skill.name || '-';

                const desc = document.createElement('div');
                desc.className = 'tool-desc';
                desc.textContent = skill.description || '\u65e0\u8bf4\u660e';

                bindToolTooltip(item, name.textContent, desc.textContent, []);
                item.appendChild(name);
                item.appendChild(desc);
                this.$.toolsList.appendChild(item);
            }
        };

        const renderEmptyTools = () => {
            hideToolTooltip();
            knownTools = [];
            renderToolActivity(currentStatus);
            clearElement(this.$.toolsList);
            const empty = document.createElement('div');
            empty.className = 'empty-tools';
            empty.textContent = text.toolsEmpty;
            this.$.toolsList.appendChild(empty);
        };

        const refreshTools = async () => {
            refreshToolsButton.disabled = true;
            setText(this.$.toolsSummary, text.toolsLoading);

            try {
                const result = await Editor.Message.request('cocos-mcp-server', 'dev-get-registered-tools');
                if (!result || result.success === false) {
                    setText(this.$.toolsSummary, result && result.message ? result.message : text.toolsFailed);
                    renderEmptyTools();
                    return;
                }
                renderTools(result);
            } catch (error) {
                setText(this.$.toolsSummary, error && error.message ? error.message : text.toolsFailed);
                renderEmptyTools();
            } finally {
                refreshToolsButton.disabled = false;
            }
        };

        const startServer = async (forceRestart) => {
            const port = getInputPort();
            if (!port) {
                if (portInput) {
                    portInput.classList.add('invalid');
                    portInput.focus();
                }
                setText(this.$.statusMessage, text.invalidPort);
                return;
            }

            setBusy(true, forceRestart ? text.restarting : text.starting);
            setText(this.$.statusMessage, forceRestart ? text.restartingMessage : text.startingMessage);

            try {
                const result = await Editor.Message.request('cocos-mcp-server', 'dev-start-server', {
                    port,
                    forceRestart,
                });
                const status = normalizeStatus(result);
                if (!result || result.success === false) {
                    const message = showError(status.message);
                    setState('abnormal', { ...status, message });
                } else {
                    portInputDirty = false;
                    setState('running', status);
                    await refreshTools();
                }
            } catch (error) {
                const message = showError(error && error.message ? error.message : String(error), error);
                setState('abnormal', {
                    success: false,
                    running: false,
                    port,
                    clients: '-',
                    autoStart: currentStatus.autoStart,
                    message,
                });
            } finally {
                setBusy(false);
                await refreshStatus(false);
            }
        };

        const stopServer = async () => {
            setBusy(true, text.stopping);
            setText(this.$.statusMessage, text.stoppingMessage);

            try {
                const result = await Editor.Message.request('cocos-mcp-server', 'dev-stop-server');
                if (!result || result.success === false) {
                    const message = showError(result && result.message ? result.message : text.operationFailed);
                    setState('abnormal', {
                        success: false,
                        running: false,
                        port: currentStatus.port,
                        clients: '-',
                        autoStart: currentStatus.autoStart,
                        message,
                    });
                } else {
                    portInputDirty = false;
                    setState('stopped', normalizeStatus(result));
                    setText(this.$.statusMessage, text.stoppedOk);
                    await refreshTools();
                }
            } catch (error) {
                const message = showError(error && error.message ? error.message : String(error), error);
                setState('abnormal', {
                    success: false,
                    running: false,
                    port: currentStatus.port,
                    clients: '-',
                    autoStart: currentStatus.autoStart,
                    message,
                });
            } finally {
                setBusy(false);
                await refreshStatus(false);
            }
        };

        const updateAutoStart = async () => {
            if (!autoStartInput) {
                return;
            }

            const autoStart = !!autoStartInput.checked;
            const port = getPreferredPort();
            try {
                const result = await Editor.Message.request('cocos-mcp-server', 'dev-update-auto-start', {
                    autoStart,
                    port,
                });
                if (!result || result.success === false) {
                    autoStartInput.checked = currentStatus.autoStart;
                    setText(this.$.statusMessage, result && result.message ? result.message : text.autoStartFailed);
                    return;
                }
                portInputDirty = false;
                currentStatus.autoStart = autoStart;
                setText(this.$.statusMessage, text.autoStartSaved);
            } catch (error) {
                autoStartInput.checked = currentStatus.autoStart;
                setText(this.$.statusMessage, error && error.message ? error.message : text.autoStartFailed);
            }
        };

        const reloadPlugin = async () => {
            reloadPluginButton.disabled = true;
            setText(this.$.statusMessage, text.reloadingPlugin);

            try {
                const result = await Editor.Message.request('cocos-mcp-server', 'dev-reload-plugin');
                if (!result || result.success === false) {
                    setText(this.$.statusMessage, result && result.message ? result.message : text.reloadPluginFailed);
                    reloadPluginButton.disabled = false;
                    return;
                }
                setText(this.$.statusMessage, result.message || text.reloadPluginSent);
            } catch (error) {
                setText(this.$.statusMessage, error && error.message ? error.message : text.reloadPluginFailed);
                reloadPluginButton.disabled = false;
            }
        };

        const configureCodex = async () => {
            const port = getPreferredPort();
            if (!port) {
                if (portInput) {
                    portInput.classList.add('invalid');
                    portInput.focus();
                }
                setText(this.$.statusMessage, text.invalidPort);
                return;
            }

            configureCodexButton.disabled = true;
            setText(this.$.statusMessage, text.configuringCodex);

            try {
                const serverUrl = `http://127.0.0.1:${port}/mcp`;
                const result = await Editor.Message.request('cocos-mcp-server', 'dev-configure-codex', {
                    port,
                    serverUrl,
                });
                if (!result || result.success === false) {
                    setText(this.$.statusMessage, result && result.message ? result.message : text.configureCodexFailed);
                    return;
                }
                setText(this.$.statusMessage, result.message || text.configureCodexOk);
            } catch (error) {
                setText(this.$.statusMessage, error && error.message ? error.message : text.configureCodexFailed);
            } finally {
                configureCodexButton.disabled = false;
            }
        };

        const openToolVisualizer = async () => {
            try {
                await Editor.Message.request('cocos-mcp-server', 'open-tool-visualizer');
            } catch (error) {
                setText(this.$.statusMessage, error && error.message ? error.message : '打开工具运行视图失败。');
            }
        };

        if (portInput) {
            portInput.addEventListener('input', () => {
                portInputDirty = true;
                portInput.classList.remove('invalid');
                if (!currentStatus.running) {
                    setText(this.$.statusMessage, text.portChanged);
                }
            });
        }

        if (autoStartInput) {
            autoStartInput.addEventListener('change', updateAutoStart);
        }

        this._hideToolTooltipOnClick = (event) => {
            if (
                this.$.toolTooltip
                && !this.$.toolTooltip.contains(event.target)
                && !(event.target && event.target.closest && event.target.closest('.tool-item'))
            ) {
                hideToolTooltip();
            }
        };
        this._hideToolTooltipOnKeydown = (event) => {
            if (event.key === 'Escape') {
                hideToolTooltip();
            }
        };
        document.addEventListener('click', this._hideToolTooltipOnClick);
        document.addEventListener('keydown', this._hideToolTooltipOnKeydown);

        startButton.addEventListener('click', async () => {
            if (currentAction === 'address') {
                const url = getServerUrl(currentStatus);
                const copied = await copyText(url);
                setText(this.$.statusMessage, copied ? text.addressCopied : url);
                return;
            }

            await startServer(currentAction === 'restart');
        });

        stopButton.addEventListener('click', stopServer);
        openToolVisualizerButton.addEventListener('click', openToolVisualizer);
        reloadPluginButton.addEventListener('click', reloadPlugin);
        configureCodexButton.addEventListener('click', configureCodex);
        this.$.mcpWechatContact.addEventListener('click', async () => {
            await copyText('13272695146');
            setText(this.$.statusMessage, text.wechatCopied);
        });
        refreshButton.addEventListener('click', () => refreshStatus(true));
        refreshToolsButton.addEventListener('click', refreshTools);
        refreshStatus(true);
        refreshTools();
        this._statusTimer = setInterval(() => refreshStatus(false), 2000);
    },

    beforeClose() {
        if (this._hideToolTooltipOnClick) {
            document.removeEventListener('click', this._hideToolTooltipOnClick);
            this._hideToolTooltipOnClick = null;
        }
        if (this._hideToolTooltipOnKeydown) {
            document.removeEventListener('keydown', this._hideToolTooltipOnKeydown);
            this._hideToolTooltipOnKeydown = null;
        }
        if (this._statusTimer) {
            clearInterval(this._statusTimer);
            this._statusTimer = null;
        }
    },
    close() {},
});
