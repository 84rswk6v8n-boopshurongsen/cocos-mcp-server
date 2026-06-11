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
};

module.exports = Editor.Panel.define({
    template: readFileSync(join(__dirname, '../../../static/template/default/start-server-only.html'), 'utf8'),

    $: {
        startMcpServer: '#startMcpServer',
        stopMcpServer: '#stopMcpServer',
        reloadPlugin: '#reloadPlugin',
        refreshStatus: '#refreshStatus',
        refreshTools: '#refreshTools',
        serverState: '#serverState',
        serverStateText: '#serverStateText',
        portControl: '#portControl',
        serverPort: '#serverPort',
        serverPortInput: '#serverPortInput',
        serverClients: '#serverClients',
        serverUrl: '#serverUrl',
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
        const reloadPluginButton = this.$.reloadPlugin;
        const refreshButton = this.$.refreshStatus;
        const refreshToolsButton = this.$.refreshTools;
        const portControl = this.$.portControl;
        const portInput = this.$.serverPortInput;
        const autoStartInput = this.$.autoStartInput;
        let currentAction = 'start';
        let isBusy = false;
        let portInputDirty = false;
        let activeToolItem = null;
        let currentStatus = {
            running: false,
            port: '-',
            clients: '-',
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
            reloadPluginButton.disabled = busy;
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

        const setState = (state, status) => {
            const running = state === 'running';
            const checking = state === 'checking';
            const abnormal = state === 'abnormal';
            const port = status && status.port ? status.port : '-';
            const clients = status && status.clients != null ? status.clients : '-';
            const nextStatus = {
                ...status,
                state,
                running,
                port,
                clients,
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
            setText(this.$.serverUrl, getServerUrl(nextStatus));
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
                    autoStart: result && result.autoStart != null ? !!result.autoStart : currentStatus.autoStart,
                    message: result && result.message ? result.message : text.statusFailed,
                };
            }

            return {
                success: true,
                running: !!result.running,
                port: result.port || '-',
                clients: result.clients != null ? result.clients : 0,
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

        const showToolTooltip = (item, name, description) => {
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
            setText(this.$.toolTooltipDesc, description || '\u65e0\u8bf4\u660e');

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

        const bindToolTooltip = (item, name, description) => {
            item.setAttribute('title', description || '\u65e0\u8bf4\u660e');
            item.addEventListener('click', (event) => {
                event.stopPropagation();
                showToolTooltip(item, name, description);
            });
        };

        const renderTools = (result) => {
            hideToolTooltip();
            const tools = result && Array.isArray(result.tools) ? result.tools : [];
            const skills = result && Array.isArray(result.skills) ? result.skills : [];
            const source = result && result.source ? result.source : 'MCP';

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

                bindToolTooltip(item, name.textContent, desc.textContent);
                item.appendChild(name);
                item.appendChild(desc);
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

                bindToolTooltip(item, name.textContent, desc.textContent);
                item.appendChild(name);
                item.appendChild(desc);
                this.$.toolsList.appendChild(item);
            }
        };

        const renderEmptyTools = () => {
            hideToolTooltip();
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
        reloadPluginButton.addEventListener('click', reloadPlugin);
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
