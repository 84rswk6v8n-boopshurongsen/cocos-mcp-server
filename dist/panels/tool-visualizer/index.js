'use strict';

const { readFileSync } = require('fs');
const { join } = require('path');

module.exports = Editor.Panel.define({
    template: readFileSync(join(__dirname, '../../../static/template/default/tool-visualizer.html'), 'utf8'),

    $: {
        refreshStatus: '#refreshStatus',
        refreshTools: '#refreshTools',
        statusMessage: '#statusMessage',
        activeToolCount: '#activeToolCount',
        visualizedToolCount: '#visualizedToolCount',
        toolExecutionCount: '#toolExecutionCount',
        lastToolStatus: '#lastToolStatus',
        activeToolsList: '#activeToolsList',
        toolActivityGrid: '#toolActivityGrid',
    },

    ready() {
        let knownTools = [];
        let currentStatus = {
            running: false,
            toolExecutionCount: 0,
            activeToolCalls: [],
            toolStats: [],
        };

        const setText = (element, value) => {
            if (element) {
                element.textContent = value == null || value === '' ? '-' : String(value);
            }
        };

        const clearElement = (element) => {
            if (element) {
                while (element.firstChild) {
                    element.removeChild(element.firstChild);
                }
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

        const normalizeStatus = (result) => ({
            running: !!(result && result.running),
            toolExecutionCount: result && result.toolExecutionCount != null ? result.toolExecutionCount : 0,
            activeToolCalls: result && Array.isArray(result.activeToolCalls) ? result.activeToolCalls : [],
            toolStats: result && Array.isArray(result.toolStats) ? result.toolStats : [],
            message: result && result.message ? result.message : '',
        });

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
            const activeCalls = Array.isArray(status && status.activeToolCalls) ? status.activeToolCalls : [];
            clearElement(this.$.activeToolsList);

            if (!activeCalls.length) {
                const empty = document.createElement('div');
                empty.className = 'empty-tools';
                empty.textContent = '暂无正在办公的工具。';
                this.$.activeToolsList.appendChild(empty);
                return;
            }

            const now = Date.now();
            for (const call of activeCalls.slice(-12).reverse()) {
                const item = document.createElement('div');
                item.className = 'active-tool-chip';

                const computer = document.createElement('div');
                computer.className = 'office-computer';
                computer.textContent = '💻';

                const info = document.createElement('div');
                info.className = 'office-tool-info';

                const name = document.createElement('div');
                name.className = 'active-tool-name';
                name.textContent = getShortToolName(call.toolName);
                name.title = call.toolName || '';

                const state = document.createElement('div');
                state.className = 'active-tool-state';
                state.textContent = '办公中';

                const time = document.createElement('div');
                time.className = 'active-tool-time';
                time.textContent = formatDuration(now - Number(call.startedAt || now));

                info.appendChild(name);
                info.appendChild(state);
                item.appendChild(computer);
                item.appendChild(info);
                item.appendChild(time);
                this.$.activeToolsList.appendChild(item);
            }
        };

        const renderToolActivity = () => {
            const status = currentStatus;
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

            setText(this.$.activeToolCount, Array.isArray(status.activeToolCalls) ? status.activeToolCalls.length : 0);
            setText(this.$.visualizedToolCount, names.length);
            setText(this.$.toolExecutionCount, status.toolExecutionCount || 0);

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
            setText(this.$.lastToolStatus, latestStatus === 'success' ? '成功' : latestStatus === 'error' ? '失败' : latestStatus === 'running' ? '运行' : '-');

            clearElement(this.$.toolActivityGrid);
            if (!names.length) {
                const empty = document.createElement('div');
                empty.className = 'empty-tools';
                empty.textContent = '暂无工具数据。';
                this.$.toolActivityGrid.appendChild(empty);
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

                const homeLabel = document.createElement('div');
                homeLabel.className = 'tool-home-label';
                homeLabel.textContent = running ? '去办公区' : recentlyFinished ? '回到居住区' : '居住区';

                const avatar = document.createElement('div');
                avatar.className = 'resident-avatar';
                avatar.title = getToolInitial(name);

                const walk = document.createElement('span');
                walk.className = 'emoji-step emoji-walk';
                walk.textContent = '🚶';

                const run = document.createElement('span');
                run.className = 'emoji-step emoji-run';
                run.textContent = '🏃';

                avatar.appendChild(walk);
                avatar.appendChild(run);

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
                cell.appendChild(homeLabel);
                cell.appendChild(avatar);
                cell.appendChild(title);
                cell.appendChild(meta);
                this.$.toolActivityGrid.appendChild(cell);
            }

            renderActiveTools(status);
        };

        const refreshStatus = async () => {
            try {
                const result = await Editor.Message.request('cocos-mcp-server', 'dev-get-server-status');
                currentStatus = normalizeStatus(result);
                setText(this.$.statusMessage, currentStatus.running ? 'MCP 服务器正在运行。' : 'MCP 服务器已停止。');
                renderToolActivity();
            } catch (error) {
                setText(this.$.statusMessage, error && error.message ? error.message : '读取状态失败。');
            }
        };

        const refreshTools = async () => {
            try {
                const result = await Editor.Message.request('cocos-mcp-server', 'dev-get-registered-tools');
                const tools = result && Array.isArray(result.tools) ? result.tools : [];
                knownTools = tools.map((tool) => ({
                    name: tool.name || tool.toolName || '-',
                    description: tool.description || '',
                }));
                setText(this.$.statusMessage, `已读取 ${knownTools.length} 个工具。`);
                renderToolActivity();
            } catch (error) {
                setText(this.$.statusMessage, error && error.message ? error.message : '读取工具失败。');
            }
        };

        this.$.refreshStatus.addEventListener('click', refreshStatus);
        this.$.refreshTools.addEventListener('click', refreshTools);

        refreshTools();
        refreshStatus();
        this._statusTimer = setInterval(refreshStatus, 1000);
    },

    beforeClose() {
        if (this._statusTimer) {
            clearInterval(this._statusTimer);
            this._statusTimer = null;
        }
    },
    close() {},
});
