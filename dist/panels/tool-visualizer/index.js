'use strict';

const { readFileSync } = require('fs');
const { join } = require('path');

const officeEmojiPath = join(__dirname, '../../../static/template/default/assets/office-thinking.gif');
const officeEmojiSrc = `data:image/gif;base64,${readFileSync(officeEmojiPath).toString('base64')}`;

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
        visualizerBody: '.visualizer-body',
        commuteLayer: '#commuteLayer',
    },

    ready() {
        let knownTools = [];
        let currentStatus = {
            running: false,
            toolExecutionCount: 0,
            activeToolCalls: [],
            toolStats: [],
        };
        const activeCallNames = new Map();
        const animatedActiveCallIds = new Set();
        const officePositionsByCallId = new Map();
        const homePositionsByToolName = new Map();
        const officeRoomArrivedCallIds = new Set();
        const officeRoomEnteringCallIds = new Set();
        const commuteDepartureTimes = new Map();
        const transientOfficeCalls = new Map();
        const hiddenResidentsByToolName = new Map();
        const hiddenResidentCallIds = new Set();
        const lastToolCounts = new Map();
        const replayedRecentCallIds = new Set();
        let hasToolCountBaseline = false;
        const recentReplayWindowMs = 6000;
        const commuteTravelMs = 1450;
        const minimumVisualWorkMs = 2200;

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

        const getCallId = (call) => {
            if (call && call.id) {
                return String(call.id);
            }
            return `${call && call.toolName ? call.toolName : 'unknown'}-${call && call.startedAt ? call.startedAt : 'active'}`;
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

        const getLayerPoint = (rect, layerRect) => ({
            x: rect.left - layerRect.left + rect.width / 2 - 15,
            y: rect.top - layerRect.top + rect.height / 2 - 15,
        });

        const getOfficeFallbackPoint = (layerRect) => {
            const panel = this.$.activeToolsList || this.$.visualizerBody;
            if (!panel) {
                return { x: 12, y: 12 };
            }
            const rect = panel.getBoundingClientRect();
            return {
                x: rect.left - layerRect.left + Math.min(40, Math.max(15, rect.width / 2)) - 15,
                y: rect.top - layerRect.top + 34,
            };
        };

        const getOfficeRoomByCallId = (callId) => {
            if (!this.$.activeToolsList) {
                return null;
            }
            return Array.from(this.$.activeToolsList.querySelectorAll('.active-tool-chip'))
                .find((item) => item.dataset && item.dataset.callId === callId) || null;
        };

        const hideResident = (callId, toolName) => {
            if (!toolName) {
                return;
            }
            if (hiddenResidentCallIds.has(callId)) {
                return;
            }
            hiddenResidentCallIds.add(callId);
            hiddenResidentsByToolName.set(toolName, (hiddenResidentsByToolName.get(toolName) || 0) + 1);
        };

        const showResident = (callId, toolName) => {
            if (!toolName) {
                return;
            }
            if (!hiddenResidentCallIds.has(callId)) {
                return;
            }
            hiddenResidentCallIds.delete(callId);
            const nextCount = Math.max(0, (hiddenResidentsByToolName.get(toolName) || 0) - 1);
            if (nextCount > 0) {
                hiddenResidentsByToolName.set(toolName, nextCount);
            }
            else {
                hiddenResidentsByToolName.delete(toolName);
            }
        };

        const playCommute = (toolName, callId, direction, avatarByToolName) => {
            const layer = this.$.commuteLayer;
            if (!layer || !this.$.visualizerBody) {
                return false;
            }

            const layerRect = layer.getBoundingClientRect();
            const avatar = avatarByToolName && avatarByToolName.get(toolName);
            let from = null;
            if (avatar && avatar.isConnected) {
                const avatarRect = avatar.getBoundingClientRect();
                if (avatarRect.width || avatarRect.height) {
                    from = getLayerPoint(avatarRect, layerRect);
                    homePositionsByToolName.set(toolName, from);
                }
            }
            if (!from) {
                from = homePositionsByToolName.get(toolName);
            }
            if (!from) {
                return false;
            }

            let to = officePositionsByCallId.get(callId);
            const officeRoom = getOfficeRoomByCallId(callId);
            const officeTarget = officeRoom ? officeRoom.querySelector('.office-worker') : null;
            if (officeTarget) {
                to = getLayerPoint(officeTarget.getBoundingClientRect(), layerRect);
                officePositionsByCallId.set(callId, to);
            }
            if (!to) {
                if (direction === 'to-home') {
                    return false;
                }
                to = getOfficeFallbackPoint(layerRect);
            }

            const commuter = document.createElement('div');
            commuter.className = direction === 'to-home' ? 'commute-person to-home' : 'commute-person';

            const face = document.createElement('span');
            face.className = 'commute-face';

            const walk = document.createElement('span');
            walk.className = 'commute-step commute-walk';
            walk.textContent = '🚶';

            const run = document.createElement('span');
            run.className = 'commute-step commute-run';
            run.textContent = '🏃';

            face.appendChild(walk);
            face.appendChild(run);
            commuter.appendChild(face);

            commuter.style.setProperty('--from-x', `${from.x}px`);
            commuter.style.setProperty('--from-y', `${from.y}px`);
            commuter.style.setProperty('--to-x', `${to.x}px`);
            commuter.style.setProperty('--to-y', `${to.y}px`);
            layer.appendChild(commuter);
            if (direction !== 'to-home') {
                hideResident(callId, toolName);
                if (avatar && avatar.isConnected) {
                    avatar.style.opacity = '0';
                    const cell = avatar.closest('.tool-workcell');
                    if (cell) {
                        cell.classList.add('resident-away');
                    }
                }
                commuteDepartureTimes.set(callId, Date.now());
            }

            window.setTimeout(() => {
                if (commuter.parentNode) {
                    commuter.parentNode.removeChild(commuter);
                }
                if (direction === 'to-home') {
                    showResident(callId, toolName);
                    if (avatar && avatar.isConnected && !hiddenResidentsByToolName.has(toolName)) {
                        avatar.style.opacity = '';
                        const cell = avatar.closest('.tool-workcell');
                        if (cell) {
                            cell.classList.remove('resident-away');
                        }
                    }
                }
            }, commuteTravelMs + 120);
            return true;
        };

        const revealOfficeRoom = (callId) => {
            officeRoomArrivedCallIds.add(callId);
            officeRoomEnteringCallIds.add(callId);
            const room = getOfficeRoomByCallId(callId);
            if (room) {
                room.classList.remove('pre-arrival');
                room.classList.add('arrived');
                room.classList.add('entering');
            }
            window.setTimeout(() => {
                officeRoomEnteringCallIds.delete(callId);
                const currentRoom = getOfficeRoomByCallId(callId);
                if (currentRoom) {
                    currentRoom.classList.remove('entering');
                }
            }, 420);
        };

        const scheduleOfficeRoomReveal = (callId) => {
            window.setTimeout(() => revealOfficeRoom(callId), commuteTravelMs);
        };

        const createOfficeRoom = (callId, toolName, startedAt) => {
            const item = document.createElement('div');
            const classes = ['active-tool-chip'];
            classes.push(officeRoomArrivedCallIds.has(callId) ? 'arrived' : 'pre-arrival');
            if (officeRoomEnteringCallIds.has(callId)) {
                classes.push('entering');
            }
            item.className = classes.join(' ');
            item.dataset.callId = callId;

            const worker = document.createElement('div');
            worker.className = 'office-worker';

            const workerImage = document.createElement('img');
            workerImage.src = officeEmojiSrc;
            workerImage.alt = '';
            worker.appendChild(workerImage);

            const info = document.createElement('div');
            info.className = 'office-tool-info';

            const name = document.createElement('div');
            name.className = 'active-tool-name';
            name.textContent = getShortToolName(toolName);
            name.title = toolName || '';

            const state = document.createElement('div');
            state.className = 'active-tool-state';
            state.textContent = '办公中';

            const time = document.createElement('div');
            time.className = 'active-tool-time';
            time.textContent = formatDuration(Date.now() - Number(startedAt || Date.now()));

            info.appendChild(name);
            info.appendChild(state);
            item.appendChild(worker);
            item.appendChild(info);
            item.appendChild(time);
            return item;
        };

        const addTransientOfficeRoom = (callId, toolName, startedAt) => {
            if (!this.$.activeToolsList || getOfficeRoomByCallId(callId)) {
                return;
            }
            transientOfficeCalls.set(callId, {
                callId,
                toolName,
                startedAt: startedAt || Date.now(),
                expiresAt: Date.now() + commuteTravelMs + minimumVisualWorkMs + 300,
            });
            const empty = this.$.activeToolsList.querySelector('.empty-tools');
            if (empty) {
                empty.remove();
            }
            const room = createOfficeRoom(callId, toolName, startedAt);
            this.$.activeToolsList.appendChild(room);
            window.setTimeout(() => {
                transientOfficeCalls.delete(callId);
                showResident(callId, toolName);
                if (room.parentNode) {
                    room.parentNode.removeChild(room);
                }
                if (this.$.activeToolsList && !this.$.activeToolsList.children.length) {
                    const nextEmpty = document.createElement('div');
                    nextEmpty.className = 'empty-tools';
                    nextEmpty.textContent = '暂无正在办公的工具。';
                    this.$.activeToolsList.appendChild(nextEmpty);
                }
            }, commuteTravelMs + minimumVisualWorkMs + 300);
        };

        const playTransientToolCall = (callId, toolName, startedAt, avatarByToolName) => {
            if (!toolName || replayedRecentCallIds.has(callId)) {
                return;
            }
            replayedRecentCallIds.add(callId);
            addTransientOfficeRoom(callId, toolName, startedAt || Date.now());
            playCommute(toolName, callId, 'to-office', avatarByToolName);
            scheduleOfficeRoomReveal(callId);
            window.setTimeout(() => {
                if (!playCommute(toolName, callId, 'to-home', avatarByToolName)) {
                    showResident(callId, toolName);
                }
                officePositionsByCallId.delete(callId);
                officeRoomArrivedCallIds.delete(callId);
                officeRoomEnteringCallIds.delete(callId);
                commuteDepartureTimes.delete(callId);
            }, commuteTravelMs + minimumVisualWorkMs);
            window.setTimeout(() => {
                replayedRecentCallIds.delete(callId);
            }, recentReplayWindowMs + commuteTravelMs + minimumVisualWorkMs);
        };

        const renderActiveTools = (status) => {
            const activeCalls = Array.isArray(status && status.activeToolCalls) ? status.activeToolCalls : [];
            clearElement(this.$.activeToolsList);
            const now = Date.now();
            const activeCallIds = new Set(activeCalls.map((call) => getCallId(call)));
            for (const [callId, call] of Array.from(transientOfficeCalls.entries())) {
                if (call.expiresAt <= now || activeCallIds.has(callId)) {
                    transientOfficeCalls.delete(callId);
                }
            }
            const transientCalls = Array.from(transientOfficeCalls.values());

            if (!activeCalls.length && !transientCalls.length) {
                const empty = document.createElement('div');
                empty.className = 'empty-tools';
                empty.textContent = '暂无正在办公的工具。';
                this.$.activeToolsList.appendChild(empty);
                return;
            }

            for (const call of activeCalls.slice(-12).reverse()) {
                const callId = getCallId(call);
                this.$.activeToolsList.appendChild(createOfficeRoom(callId, call.toolName, call.startedAt || now));
            }
            for (const call of transientCalls.slice(-12).reverse()) {
                this.$.activeToolsList.appendChild(createOfficeRoom(call.callId, call.toolName, call.startedAt || now));
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

            const avatarByToolName = new Map();
            for (const name of names) {
                const stat = stateMap.get(name) || { name, count: 0, running: 0, lastStatus: 'idle' };
                const running = Number(stat.running || 0) > 0;
                const recentlyFinished = !running && stat.lastEndedAt && Date.now() - Number(stat.lastEndedAt) < 4000;
                const statusName = running ? 'running' : recentlyFinished ? stat.lastStatus || 'idle' : 'idle';
                const residentAway = running || hiddenResidentsByToolName.has(name);
                const cell = document.createElement('div');
                cell.className = `tool-workcell ${statusName}${residentAway ? ' resident-away' : ''}`;
                cell.title = `${name}\ncount: ${stat.count || 0}\nstatus: ${statusName}${stat.lastError ? `\nerror: ${stat.lastError}` : ''}`;

                const avatar = document.createElement('div');
                avatar.className = 'resident-avatar';
                avatar.title = running ? '去办公区' : recentlyFinished ? '回到居住区' : '居住区';
                avatarByToolName.set(name, avatar);

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
                cell.appendChild(avatar);
                cell.appendChild(title);
                cell.appendChild(meta);
                this.$.toolActivityGrid.appendChild(cell);
            }

            if (this.$.commuteLayer) {
                const layerRect = this.$.commuteLayer.getBoundingClientRect();
                for (const [name, avatar] of avatarByToolName.entries()) {
                    const avatarRect = avatar.getBoundingClientRect();
                    if (avatarRect.width || avatarRect.height) {
                        homePositionsByToolName.set(name, getLayerPoint(avatarRect, layerRect));
                    }
                }
            }

            renderActiveTools(status);

            const activeCalls = Array.isArray(status.activeToolCalls) ? status.activeToolCalls : [];
            const activeToolNames = new Set(activeCalls.map((call) => call && call.toolName).filter(Boolean));
            const currentActiveCallIds = new Set();
            for (const call of activeCalls) {
                const callId = getCallId(call);
                const toolName = call && call.toolName;
                if (!toolName) {
                    continue;
                }
                currentActiveCallIds.add(callId);
                activeCallNames.set(callId, toolName);
                if (!animatedActiveCallIds.has(callId)) {
                    playCommute(toolName, callId, 'to-office', avatarByToolName);
                    scheduleOfficeRoomReveal(callId);
                    animatedActiveCallIds.add(callId);
                }
            }

            for (const [callId, toolName] of Array.from(activeCallNames.entries())) {
                if (currentActiveCallIds.has(callId)) {
                    continue;
                }
                const departureAt = commuteDepartureTimes.get(callId) || 0;
                const returnDelay = departureAt ? Math.max(0, commuteTravelMs - (Date.now() - departureAt)) : 0;
                window.setTimeout(() => {
                    if (!playCommute(toolName, callId, 'to-home', avatarByToolName)) {
                        showResident(callId, toolName);
                    }
                }, returnDelay);
                activeCallNames.delete(callId);
                animatedActiveCallIds.delete(callId);
                window.setTimeout(() => {
                    officePositionsByCallId.delete(callId);
                    officeRoomArrivedCallIds.delete(callId);
                    officeRoomEnteringCallIds.delete(callId);
                    commuteDepartureTimes.delete(callId);
                }, returnDelay + commuteTravelMs + 300);
            }

            for (const [name, stat] of stateMap.entries()) {
                const nextCount = Number(stat && stat.count || 0);
                const previousCount = lastToolCounts.has(name) ? lastToolCounts.get(name) : nextCount;
                if (hasToolCountBaseline && nextCount > previousCount && !activeToolNames.has(name)) {
                    playTransientToolCall(`recent-${name}-${stat.lastStartedAt || Date.now()}-${nextCount}`, name, stat.lastStartedAt || Date.now(), avatarByToolName);
                }
                if (!hasToolCountBaseline && nextCount > 0 && !activeToolNames.has(name)) {
                    const marker = Math.max(Number(stat.lastEndedAt || 0), Number(stat.lastStartedAt || 0));
                    if (marker && Date.now() - marker < recentReplayWindowMs) {
                        playTransientToolCall(`initial-recent-${name}-${marker}-${nextCount}`, name, stat.lastStartedAt || marker, avatarByToolName);
                    }
                }
                lastToolCounts.set(name, nextCount);
            }
            hasToolCountBaseline = true;
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
