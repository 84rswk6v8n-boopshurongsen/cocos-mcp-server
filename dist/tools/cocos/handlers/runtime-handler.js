'use strict';

const ACTIONS = [
    'get_injection_code',
    'check_support',
    'wait_until_ready',
    'get_scene_tree',
    'find_node',
    'get_node_info',
    'get_component_info',
    'set_node_active',
    'set_node_transform',
    'get_runtime_stats'
];

class RuntimeHandler {
    getToolDefinition() {
        return {
            name: 'runtime',
            description: [
                'Cocos Web 运行态桥接工具，用于读取浏览器预览页中的运行时场景、节点、组件和基础统计。',
                '使用前需要在预览网页注入 /runtime/bridge.js；本工具只返回精简 JSON，不提供网页 UI。',
                'Actions: get_injection_code, check_support, wait_until_ready, get_scene_tree, find_node, get_node_info, get_component_info, set_node_active, set_node_transform, get_runtime_stats.'
            ].join('\n'),
            inputSchema: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ACTIONS,
                        description: '运行态操作'
                    },
                    host: {
                        type: 'string',
                        description: 'get_injection_code 使用的 MCP 主机，默认 127.0.0.1'
                    },
                    port: {
                        type: 'number',
                        description: 'get_injection_code 使用的 MCP 端口，默认当前 MCP 服务端口'
                    },
                    node: {
                        type: 'string',
                        description: '节点名称、路径或 UUID'
                    },
                    query: {
                        type: 'string',
                        description: 'find_node 查询文本，可匹配名称、路径或 UUID'
                    },
                    component: {
                        type: 'string',
                        description: '组件类型名或组件 UUID'
                    },
                    componentType: {
                        type: 'string',
                        description: '组件类型名，等同 component'
                    },
                    active: {
                        type: 'boolean',
                        description: 'set_node_active 要设置的 active 状态'
                    },
                    position: {
                        type: 'object',
                        description: 'set_node_transform 的位置 {x,y,z}'
                    },
                    rotation: {
                        type: 'object',
                        description: 'set_node_transform 的欧拉角 {x,y,z}'
                    },
                    scale: {
                        type: 'object',
                        description: 'set_node_transform 的缩放 {x,y,z}'
                    },
                    maxDepth: {
                        type: 'number',
                        description: 'get_scene_tree 最大递归深度'
                    },
                    nameKeyword: {
                        type: 'string',
                        description: 'get_scene_tree 节点名称/路径筛选关键字'
                    },
                    timeoutMs: {
                        type: 'number',
                        description: '等待浏览器运行态响应的超时时间'
                    },
                    readyTimeoutMs: {
                        type: 'number',
                        description: '读取场景树/统计前等待 Cocos 场景就绪的超时时间'
                    },
                    waitReady: {
                        type: 'boolean',
                        description: 'get_scene_tree/get_runtime_stats 是否自动等待场景就绪，默认 true'
                    },
                    requireNodes: {
                        type: 'boolean',
                        description: 'wait_until_ready 是否要求场景下已有节点，默认 true'
                    }
                },
                required: ['action']
            }
        };
    }

    async execute(args = {}) {
        const action = args.action;
        if (!ACTIONS.includes(action)) {
            return {
                success: false,
                error: `未知运行态操作：${action || ''}`
            };
        }

        const manager = globalThis.__cocosMcpRuntimeBridgeManager;
        if (!manager || typeof manager.execute !== 'function') {
            return {
                success: false,
                error: '运行态桥接管理器尚未初始化，请先启动 MCP 服务器。'
            };
        }

        if (action === 'get_injection_code') {
            return typeof manager.getInjectionCode === 'function'
                ? manager.getInjectionCode(args)
                : {
                    success: false,
                    error: '当前 MCP 服务器不支持生成注入脚本。'
                };
        }

        const result = await manager.execute(action, args);
        if (action === 'check_support' && result && result.success && result.data) {
            return Object.assign({}, result, {
                data: Object.assign({}, result.data, {
                    runtimeStatus: typeof manager.getStatus === 'function' ? manager.getStatus() : null
                })
            });
        }
        return result;
    }
}

module.exports = { RuntimeHandler };
