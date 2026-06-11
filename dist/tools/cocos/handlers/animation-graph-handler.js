'use strict';

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const GRAPH_TYPE = 'cc.animation.AnimationGraph';
const LAYER_TYPE = 'cc.animation.Layer';
const STATE_MACHINE_TYPE = 'cc.animation.StateMachine';
const STATE_TYPE = 'cc.animation.State';
const EMPTY_STATE_TYPE = 'cc.animation.EmptyState';
const MOTION_TYPE = 'cc.animation.Motion';
const CLIP_MOTION_TYPE = 'cc.animation.ClipMotion';
const TRANSITION_TYPE = 'cc.animation.Transition';
const ANIMATION_TRANSITION_TYPE = 'cc.animation.AnimationTransition';
const EVENT_BINDING_TYPE = 'cc.animation.AnimationGraphEventBinding';

const PARAM_TYPES = {
    float: { kind: 'plain', type: 0, defaultValue: 0 },
    number: { kind: 'plain', type: 0, defaultValue: 0 },
    boolean: { kind: 'plain', type: 1, defaultValue: false },
    bool: { kind: 'plain', type: 1, defaultValue: false },
    trigger: { kind: 'trigger', defaultValue: undefined },
    integer: { kind: 'plain', type: 3, defaultValue: 0 },
    int: { kind: 'plain', type: 3, defaultValue: 0 }
};

const BINARY_OPERATORS = {
    '==': 0,
    '=': 0,
    '!=': 1,
    '<': 2,
    '<=': 3,
    '>': 4,
    '>=': 5
};

class AnimationGraphHandler {
    getToolDefinition() {
        return {
            name: 'animation_graph',
            description: [
                'Animation Graph asset editing for Cocos Creator 3.8.x Marionette .animgraph resources.',
                'Actions: compatibility, list_graphs, inspect_graph, create_graph, add_parameter, update_parameter, remove_parameter, create_state, update_state, remove_state, connect_states, update_transition, set_transition_conditions, remove_transition, update_layer, validate_graph.'
            ].join('\n'),
            inputSchema: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: [
                            'compatibility',
                            'list_graphs',
                            'inspect_graph',
                            'create_graph',
                            'add_parameter',
                            'update_parameter',
                            'remove_parameter',
                            'create_state',
                            'update_state',
                            'remove_state',
                            'connect_states',
                            'update_transition',
                            'set_transition_conditions',
                            'remove_transition',
                            'update_layer',
                            'validate_graph'
                        ]
                    },
                    url: { type: 'string' },
                    folder: { type: 'string' },
                    name: { type: 'string' },
                    overwrite: { type: 'boolean' },
                    layerName: { type: 'string' },
                    layerIndex: { type: 'number' },
                    parameter: { type: 'string' },
                    parameterType: { type: 'string', enum: ['float', 'number', 'boolean', 'bool', 'trigger', 'integer', 'int'] },
                    value: {},
                    stateName: { type: 'string' },
                    newStateName: { type: 'string' },
                    stateType: { type: 'string', enum: ['empty', 'motion'] },
                    clipUuid: { type: 'string' },
                    clipUrl: { type: 'string' },
                    speed: { type: 'number' },
                    centerX: { type: 'number' },
                    centerY: { type: 'number' },
                    fromStateName: { type: 'string' },
                    toStateName: { type: 'string' },
                    transitionIndex: { type: 'number' },
                    duration: { type: 'number' },
                    exitConditionEnabled: { type: 'boolean' },
                    exitCondition: { type: 'number' },
                    destinationStart: { type: 'number' },
                    conditions: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                parameter: { type: 'string' },
                                operator: { type: 'string' },
                                value: {}
                            },
                            required: ['parameter', 'operator']
                        }
                    },
                    weight: { type: 'number' },
                    additive: { type: 'boolean' },
                    maskUrl: { type: 'string' },
                    maskUuid: { type: 'string' }
                },
                required: ['action']
            }
        };
    }

    async execute(args = {}) {
        switch (args.action) {
            case 'compatibility':
                return this.compatibility();
            case 'list_graphs':
                return await this.listGraphs(args);
            case 'inspect_graph':
                return await this.inspectGraph(args);
            case 'create_graph':
                return await this.createGraph(args);
            case 'add_parameter':
                return await this.addParameter(args);
            case 'update_parameter':
                return await this.updateParameter(args);
            case 'remove_parameter':
                return await this.removeParameter(args);
            case 'create_state':
                return await this.createState(args);
            case 'update_state':
                return await this.updateState(args);
            case 'remove_state':
                return await this.removeState(args);
            case 'connect_states':
                return await this.connectStates(args);
            case 'update_transition':
                return await this.updateTransition(args);
            case 'set_transition_conditions':
                return await this.setTransitionConditions(args);
            case 'remove_transition':
                return await this.removeTransition(args);
            case 'update_layer':
                return await this.updateLayer(args);
            case 'validate_graph':
                return await this.validateGraph(args);
            default:
                return { success: false, error: `Unknown animation_graph action: ${args.action}` };
        }
    }

    compatibility() {
        const currentEditorVersion = this.getEditorVersion();
        const support = this.getCompatibilityForVersion(currentEditorVersion);
        return {
            success: true,
            data: {
                tool: 'cocos_animation_graph',
                format: GRAPH_TYPE,
                verifiedVersions: ['3.8.2'],
                compatibleRange: '3.8.x',
                currentEditorVersion,
                supportLevel: support.supportLevel,
                writePolicy: support.writePolicy,
                notes: [
                    '3.8.2 has been tested with minimal graph, transitions, conditions, masks, and clip motions.',
                    'Other 3.8.x versions are treated as structurally compatible when schema detection passes.',
                    'Non-3.8.x versions default to write refusal.'
                ]
            }
        };
    }

    async listGraphs(args) {
        const folderUrl = this.normalizeFolderUrl(args.folder || 'db://assets');
        const folder = await this.resolveDbUrlToPath(folderUrl);
        const graphs = [];
        if (fs.existsSync(folder)) {
            this.walk(folder, (file) => {
                if (!file.endsWith('.animgraph')) {
                    return;
                }
                let summary = null;
                try {
                    summary = this.summarizeDocument(this.readGraphFile(file).document);
                } catch (_) {}
                graphs.push({
                    url: this.pathToDbUrl(file),
                    source: file,
                    layers: summary ? summary.layers.length : 0,
                    states: summary ? summary.states.length : 0,
                    transitions: summary ? summary.transitions.length : 0
                });
            });
        }
        return { success: true, data: { folder: folderUrl, count: graphs.length, graphs } };
    }

    async inspectGraph(args) {
        const { url, source, document } = await this.loadGraph(args.url, true);
        return {
            success: true,
            data: {
                url,
                source,
                compatibility: this.getCompatibilityForDocument(document),
                ...this.summarizeDocument(document)
            }
        };
    }

    async createGraph(args) {
        const url = this.normalizeGraphUrl(this.requireString(args.url, 'url'));
        const source = await this.resolveAssetSource(url, false);
        if (fs.existsSync(source) && !args.overwrite) {
            return {
                success: false,
                error: `Animation graph already exists: ${url}. Pass overwrite:true to replace it.`
            };
        }
        this.assertWriteAllowed(null);
        const document = this.createMinimalGraph(args.name || '');
        await this.writeGraphFile(source, document);
        await this.ensureMeta(source);
        await this.refreshAsset(url);
        return { success: true, data: { url, source, ...this.summarizeCounts(document) }, message: `Animation graph created: ${url}` };
    }

    async addParameter(args) {
        return await this.mutateGraph(args, (document) => {
            const graph = this.getGraphRoot(document);
            const name = this.requireString(args.parameter || args.name, 'parameter');
            if (graph._variables && graph._variables[name]) {
                throw new Error(`Parameter already exists: ${name}`);
            }
            graph._variables = graph._variables || {};
            const id = this.addObject(document, this.createParameterObject(args.parameterType || 'float', args.value));
            graph._variables[name] = this.ref(id);
            return { parameter: name, parameterId: id };
        });
    }

    async updateParameter(args) {
        return await this.mutateGraph(args, (document) => {
            const graph = this.getGraphRoot(document);
            const name = this.requireString(args.parameter || args.name, 'parameter');
            const id = this.refId(graph._variables && graph._variables[name]);
            if (id == null || !document[id]) {
                throw new Error(`Parameter not found: ${name}`);
            }
            const replacement = this.createParameterObject(args.parameterType || this.inferParameterType(document[id]), args.value);
            document[id] = { ...document[id], ...replacement };
            return { parameter: name, parameterId: id };
        });
    }

    async removeParameter(args) {
        return await this.mutateGraph(args, (document) => {
            const graph = this.getGraphRoot(document);
            const name = this.requireString(args.parameter || args.name, 'parameter');
            if (!graph._variables || !graph._variables[name]) {
                throw new Error(`Parameter not found: ${name}`);
            }
            delete graph._variables[name];
            return { parameter: name };
        });
    }

    async createState(args) {
        return await this.mutateGraph(args, async (document) => {
            const stateName = this.requireString(args.stateName || args.name, 'stateName');
            const context = this.getLayerContext(document, args);
            this.assertUniqueStateName(document, context.stateMachine, stateName);
            const stateType = args.stateType || (args.clipUuid || args.clipUrl ? 'motion' : 'empty');
            const position = this.resolveStatePosition(document, context.stateMachine, args);
            let stateId;
            if (stateType === 'motion') {
                stateId = await this.addMotionState(document, stateName, args, position);
            } else {
                stateId = this.addObject(document, this.createEmptyState(stateName, position));
            }
            context.stateMachine._states = context.stateMachine._states || [];
            context.stateMachine._states.push(this.ref(stateId));
            return { stateName, stateId, stateType };
        });
    }

    async updateState(args) {
        return await this.mutateGraph(args, async (document) => {
            const context = this.getLayerContext(document, args);
            const state = this.findStateByName(document, context.stateMachine, this.requireString(args.stateName || args.name, 'stateName'), true);
            if (args.newStateName && args.newStateName !== state.object.name) {
                this.assertUniqueStateName(document, context.stateMachine, args.newStateName);
                state.object.name = args.newStateName;
            }
            if (typeof args.speed === 'number' && state.object.__type__ === MOTION_TYPE) {
                state.object.speed = args.speed;
            }
            this.updateEditorPosition(state.object, args);
            if ((args.clipUuid || args.clipUrl) && state.object.__type__ === MOTION_TYPE) {
                const clipMotionId = this.refId(state.object.motion);
                if (clipMotionId == null || !document[clipMotionId]) {
                    throw new Error(`Motion state has no ClipMotion: ${state.object.name}`);
                }
                document[clipMotionId].clip = { __uuid__: await this.resolveAssetUuid(args.clipUuid || args.clipUrl), __expectedType__: 'cc.AnimationClip' };
            }
            return { stateId: state.id, stateName: state.object.name };
        });
    }

    async removeState(args) {
        return await this.mutateGraph(args, (document) => {
            const context = this.getLayerContext(document, args);
            const state = this.findStateByName(document, context.stateMachine, this.requireString(args.stateName || args.name, 'stateName'), true);
            if (['Entry', 'Exit', 'Any'].includes(state.object.name)) {
                throw new Error(`Cannot remove built-in state: ${state.object.name}`);
            }
            context.stateMachine._states = (context.stateMachine._states || []).filter((item) => this.refId(item) !== state.id);
            const before = (context.stateMachine._transitions || []).length;
            context.stateMachine._transitions = (context.stateMachine._transitions || []).filter((item) => {
                const transition = document[this.refId(item)];
                return transition && this.refId(transition.from) !== state.id && this.refId(transition.to) !== state.id;
            });
            return { stateId: state.id, stateName: state.object.name, removedTransitions: before - context.stateMachine._transitions.length };
        });
    }

    async connectStates(args) {
        return await this.mutateGraph(args, async (document) => {
            const context = this.getLayerContext(document, args);
            const from = this.findStateByName(document, context.stateMachine, this.requireString(args.fromStateName, 'fromStateName'), true);
            const to = this.findStateByName(document, context.stateMachine, this.requireString(args.toStateName, 'toStateName'), true);
            const transitionId = await this.addTransition(document, from.id, to.id, args);
            context.stateMachine._transitions = context.stateMachine._transitions || [];
            context.stateMachine._transitions.push(this.ref(transitionId));
            return { transitionId, fromStateName: from.object.name, toStateName: to.object.name };
        });
    }

    async updateTransition(args) {
        return await this.mutateGraph(args, (document) => {
            const transition = this.findTransition(document, args, true);
            if (typeof args.duration === 'number') {
                transition.object.duration = args.duration;
            }
            if (typeof args.exitConditionEnabled === 'boolean') {
                transition.object.exitConditionEnabled = args.exitConditionEnabled;
            }
            if (typeof args.exitCondition === 'number') {
                transition.object._exitCondition = args.exitCondition;
            }
            if (typeof args.destinationStart === 'number') {
                transition.object.destinationStart = args.destinationStart;
            }
            return { transitionId: transition.id };
        });
    }

    async setTransitionConditions(args) {
        return await this.mutateGraph(args, async (document) => {
            const transition = this.findTransition(document, args, true);
            transition.object.conditions = await this.addConditionObjects(document, args.conditions || []);
            return { transitionId: transition.id, conditionCount: transition.object.conditions.length };
        });
    }

    async removeTransition(args) {
        return await this.mutateGraph(args, (document) => {
            const context = this.getLayerContext(document, args);
            const transition = this.findTransition(document, args, true);
            context.stateMachine._transitions = (context.stateMachine._transitions || []).filter((item) => this.refId(item) !== transition.id);
            return { transitionId: transition.id };
        });
    }

    async updateLayer(args) {
        return await this.mutateGraph(args, async (document) => {
            const context = this.getLayerContext(document, args);
            const layer = context.layer;
            if (typeof args.name === 'string') {
                layer.name = args.name;
            }
            if (typeof args.layerName === 'string' && args.name == null) {
                layer.name = args.layerName;
            }
            if (typeof args.weight === 'number') {
                layer.weight = args.weight;
            }
            if (typeof args.additive === 'boolean') {
                layer.additive = args.additive;
            }
            if (args.maskUuid || args.maskUrl) {
                layer.mask = {
                    __uuid__: await this.resolveAssetUuid(args.maskUuid || args.maskUrl),
                    __expectedType__: 'cc.animation.AnimationMask'
                };
            } else if (args.maskUrl === null || args.maskUuid === null) {
                layer.mask = null;
            }
            return { layerIndex: context.layerIndex, name: layer.name || '' };
        });
    }

    async validateGraph(args) {
        const { url, source, document } = await this.loadGraph(args.url, true);
        const issues = this.validateDocument(document);
        return {
            success: true,
            data: {
                url,
                source,
                valid: issues.length === 0,
                issueCount: issues.length,
                issues,
                ...this.summarizeCounts(document)
            }
        };
    }

    async mutateGraph(args, mutator) {
        const { url, source, document } = await this.loadGraph(args.url, true);
        this.assertWriteAllowed(document);
        const data = await mutator(document);
        await this.writeGraphFile(source, document);
        await this.ensureMeta(source);
        await this.refreshAsset(url);
        return { success: true, data: { url, source, ...data, ...this.summarizeCounts(document) }, message: `Animation graph updated: ${url}` };
    }

    async loadGraph(inputUrl, mustExist) {
        const url = this.normalizeGraphUrl(this.requireString(inputUrl, 'url'));
        const source = await this.resolveAssetSource(url, mustExist);
        const { document } = this.readGraphFile(source);
        return { url, source, document };
    }

    readGraphFile(source) {
        const raw = fs.readFileSync(source, 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            throw new Error('Animation graph must be a Cocos reference array');
        }
        this.getGraphRoot(parsed);
        return { document: parsed };
    }

    createMinimalGraph(name) {
        return [
            {
                __type__: GRAPH_TYPE,
                _name: name || '',
                _objFlags: 0,
                __editorExtras__: {},
                _native: '',
                _layers: [this.ref(1)],
                _variables: {}
            },
            {
                __type__: LAYER_TYPE,
                _stateMachine: this.ref(2),
                name: '',
                weight: 1,
                mask: null,
                additive: false,
                _stashes: {}
            },
            {
                __type__: STATE_MACHINE_TYPE,
                __editorExtras__: this.editorExtras(),
                _states: [this.ref(3), this.ref(4), this.ref(5)],
                _transitions: [],
                _entryState: this.ref(3),
                _exitState: this.ref(4),
                _anyState: this.ref(5)
            },
            this.createBuiltInState('Entry', -320, 0),
            this.createBuiltInState('Exit', 360, 0),
            this.createBuiltInState('Any', -320, -140)
        ];
    }

    createBuiltInState(name, centerX, centerY) {
        return {
            __type__: STATE_TYPE,
            __editorExtras__: this.editorExtras({ centerX, centerY }),
            name
        };
    }

    createEmptyState(name, position = {}) {
        return {
            __type__: EMPTY_STATE_TYPE,
            __editorExtras__: this.editorExtras({ centerX: position.centerX, centerY: position.centerY }),
            name
        };
    }

    async addMotionState(document, name, args, position = {}) {
        const clipUuid = args.clipUuid || args.clipUrl ? await this.resolveAssetUuid(args.clipUuid || args.clipUrl) : null;
        const clipMotionId = this.addObject(document, {
            __type__: CLIP_MOTION_TYPE,
            __editorExtras__: this.editorExtras({ includePosition: false }),
            clip: clipUuid ? { __uuid__: clipUuid, __expectedType__: 'cc.AnimationClip' } : null
        });
        const transitionInId = this.addObject(document, this.createEventBinding());
        const transitionOutId = this.addObject(document, this.createEventBinding());
        return this.addObject(document, {
            __type__: MOTION_TYPE,
            __editorExtras__: this.editorExtras({ centerX: position.centerX, centerY: position.centerY }),
            name,
            _components: [],
            motion: this.ref(clipMotionId),
            speed: typeof args.speed === 'number' ? args.speed : 1,
            speedMultiplier: '',
            speedMultiplierEnabled: false,
            transitionInEventBinding: this.ref(transitionInId),
            transitionOutEventBinding: this.ref(transitionOutId)
        });
    }

    async addTransition(document, fromId, toId, args) {
        const useAnimationTransition = document[fromId] && document[fromId].__type__ === MOTION_TYPE;
        const conditions = await this.addConditionObjects(document, args.conditions || []);
        if (!useAnimationTransition) {
            return this.addObject(document, {
                __type__: TRANSITION_TYPE,
                __editorExtras__: null,
                from: this.ref(fromId),
                to: this.ref(toId),
                conditions
            });
        }
        const startEventId = this.addObject(document, this.createEventBinding());
        const endEventId = this.addObject(document, this.createEventBinding());
        return this.addObject(document, {
            __type__: ANIMATION_TRANSITION_TYPE,
            __editorExtras__: null,
            from: this.ref(fromId),
            to: this.ref(toId),
            conditions,
            destinationStart: typeof args.destinationStart === 'number' ? args.destinationStart : 0,
            relativeDestinationStart: false,
            startEventBinding: this.ref(startEventId),
            endEventBinding: this.ref(endEventId),
            duration: typeof args.duration === 'number' ? args.duration : 0.3,
            relativeDuration: false,
            exitConditionEnabled: typeof args.exitConditionEnabled === 'boolean' ? args.exitConditionEnabled : true,
            _exitCondition: typeof args.exitCondition === 'number' ? args.exitCondition : 1
        });
    }

    async addConditionObjects(document, conditions) {
        if (!Array.isArray(conditions)) {
            throw new Error('conditions must be an array');
        }
        const refs = [];
        for (const condition of conditions) {
            refs.push(this.ref(await this.addConditionObject(document, condition)));
        }
        return refs;
    }

    async addConditionObject(document, condition) {
        const parameter = this.requireString(condition.parameter, 'condition.parameter');
        const operator = this.requireString(condition.operator, 'condition.operator');
        if (operator === 'triggered' || operator === 'trigger') {
            return this.addObject(document, { __type__: 'cc.animation.TriggerCondition', trigger: parameter });
        }
        if (typeof condition.value === 'boolean') {
            const operandId = this.addObject(document, {
                __type__: 'cc.animation.BindableBoolean',
                variable: parameter,
                value: condition.value
            });
            return this.addObject(document, {
                __type__: 'cc.animation.UnaryCondition',
                operator: operator === '!=' ? 1 : 0,
                operand: this.ref(operandId)
            });
        }
        if (!(operator in BINARY_OPERATORS)) {
            throw new Error(`Unsupported condition operator: ${operator}`);
        }
        const bindingId = this.addObject(document, {
            __type__: 'cc.animation.TCVariableBinding',
            type: 0,
            variableName: parameter
        });
        return this.addObject(document, {
            __type__: 'cc.animation.BinaryCondition',
            operator: BINARY_OPERATORS[operator],
            lhs: 0,
            lhsBinding: this.ref(bindingId),
            rhs: typeof condition.value === 'number' ? condition.value : Number(condition.value || 0)
        });
    }

    createParameterObject(type, value) {
        const normalized = String(type || 'float').toLowerCase();
        const spec = PARAM_TYPES[normalized];
        if (!spec) {
            throw new Error(`Unsupported parameter type: ${type}`);
        }
        if (spec.kind === 'trigger') {
            return { __type__: 'cc.animation.TriggerVariable', _flags: 0 };
        }
        return {
            __type__: 'cc.animation.PlainVariable',
            _type: spec.type,
            _value: value !== undefined ? value : spec.defaultValue
        };
    }

    inferParameterType(variable) {
        if (!variable) {
            return 'float';
        }
        if (variable.__type__ === 'cc.animation.TriggerVariable') {
            return 'trigger';
        }
        if (variable.__type__ === 'cc.animation.PlainVariable') {
            if (variable._type === 1) return 'boolean';
            if (variable._type === 3) return 'integer';
        }
        return 'float';
    }

    createEventBinding() {
        return { __type__: EVENT_BINDING_TYPE, methodName: '' };
    }

    resolveStatePosition(document, stateMachine, args) {
        if (typeof args.centerX === 'number' || typeof args.centerY === 'number') {
            return {
                centerX: typeof args.centerX === 'number' ? args.centerX : 0,
                centerY: typeof args.centerY === 'number' ? args.centerY : -120
            };
        }

        const userStateCount = (stateMachine._states || [])
            .map((ref) => document[this.refId(ref)])
            .filter((state) => state && !['Entry', 'Exit', 'Any'].includes(state.name || ''))
            .length;
        const column = userStateCount % 3;
        const row = Math.floor(userStateCount / 3);
        return {
            centerX: -80 + column * 220,
            centerY: -120 - row * 140
        };
    }

    updateEditorPosition(object, args) {
        if (typeof args.centerX !== 'number' && typeof args.centerY !== 'number') {
            return;
        }
        object.__editorExtras__ = object.__editorExtras__ || this.editorExtras();
        if (typeof args.centerX === 'number') {
            object.__editorExtras__.centerX = args.centerX;
        }
        if (typeof args.centerY === 'number') {
            object.__editorExtras__.centerY = args.centerY;
        }
    }

    editorExtras(options = {}) {
        const extras = {
            name: '',
            id: uuidv4(),
            clone: null
        };
        if (options.includePosition !== false) {
            extras.centerX = options.centerX || 0;
            extras.centerY = options.centerY || 0;
        }
        return extras;
    }

    summarizeDocument(document) {
        const graph = this.getGraphRoot(document);
        const layers = this.getLayerRefs(document).map(({ id, layer }, index) => ({
            id,
            index,
            name: layer.name || '',
            weight: layer.weight,
            additive: !!layer.additive,
            mask: layer.mask || null,
            stateMachineId: this.refId(layer._stateMachine)
        }));
        const states = [];
        const transitions = [];
        for (const layerInfo of this.getLayerRefs(document)) {
            const smId = this.refId(layerInfo.layer._stateMachine);
            const stateMachine = document[smId];
            if (!stateMachine) {
                continue;
            }
            for (const stateRef of stateMachine._states || []) {
                const id = this.refId(stateRef);
                const state = document[id];
                if (!state) continue;
                states.push(this.describeState(document, id, state, layerInfo.index));
            }
            for (const transitionRef of stateMachine._transitions || []) {
                const id = this.refId(transitionRef);
                const transition = document[id];
                if (!transition) continue;
                transitions.push(this.describeTransition(document, id, transition, layerInfo.index));
            }
        }
        return {
            name: graph._name || '',
            layers,
            parameters: this.describeParameters(document, graph),
            states,
            transitions
        };
    }

    summarizeCounts(document) {
        const summary = this.summarizeDocument(document);
        return {
            layerCount: summary.layers.length,
            parameterCount: summary.parameters.length,
            stateCount: summary.states.length,
            transitionCount: summary.transitions.length
        };
    }

    describeParameters(document, graph) {
        return Object.entries(graph._variables || {}).map(([name, ref]) => {
            const id = this.refId(ref);
            const variable = document[id] || {};
            return {
                name,
                id,
                type: this.inferParameterType(variable),
                value: variable._value,
                rawType: variable.__type__
            };
        });
    }

    describeState(document, id, state, layerIndex) {
        const result = {
            id,
            layerIndex,
            type: state.__type__,
            name: state.name || ''
        };
        if (state.__type__ === MOTION_TYPE) {
            const clipMotionId = this.refId(state.motion);
            const clipMotion = document[clipMotionId] || {};
            result.speed = state.speed;
            result.clipMotionId = clipMotionId;
            result.clip = clipMotion.clip || null;
        }
        return result;
    }

    describeTransition(document, id, transition, layerIndex) {
        return {
            id,
            layerIndex,
            type: transition.__type__,
            fromId: this.refId(transition.from),
            fromStateName: this.nameForId(document, this.refId(transition.from)),
            toId: this.refId(transition.to),
            toStateName: this.nameForId(document, this.refId(transition.to)),
            duration: transition.duration,
            destinationStart: transition.destinationStart,
            exitConditionEnabled: transition.exitConditionEnabled,
            exitCondition: transition._exitCondition,
            conditions: (transition.conditions || []).map((ref) => this.describeCondition(document, this.refId(ref))).filter(Boolean)
        };
    }

    describeCondition(document, id) {
        const condition = document[id];
        if (!condition) {
            return null;
        }
        if (condition.__type__ === 'cc.animation.BinaryCondition') {
            const binding = document[this.refId(condition.lhsBinding)] || {};
            return {
                id,
                type: condition.__type__,
                parameter: binding.variableName || '',
                operator: this.operatorName(condition.operator),
                value: condition.rhs
            };
        }
        if (condition.__type__ === 'cc.animation.UnaryCondition') {
            const operand = document[this.refId(condition.operand)] || {};
            return {
                id,
                type: condition.__type__,
                parameter: operand.variable || '',
                operator: condition.operator === 1 ? '!=' : '==',
                value: operand.value
            };
        }
        if (condition.__type__ === 'cc.animation.TriggerCondition') {
            return { id, type: condition.__type__, parameter: condition.trigger, operator: 'triggered' };
        }
        return { id, type: condition.__type__ };
    }

    operatorName(value) {
        for (const [name, code] of Object.entries(BINARY_OPERATORS)) {
            if (code === value && name !== '=') {
                return name;
            }
        }
        return String(value);
    }

    validateDocument(document) {
        const issues = [];
        let graph = null;
        try {
            graph = this.getGraphRoot(document);
        } catch (error) {
            return [{ severity: 'error', message: error.message }];
        }
        const parameters = new Set(Object.keys(graph._variables || {}));
        for (const { layer, index } of this.getLayerRefs(document)) {
            const smId = this.refId(layer._stateMachine);
            const stateMachine = document[smId];
            if (!stateMachine || stateMachine.__type__ !== STATE_MACHINE_TYPE) {
                issues.push({ severity: 'error', message: `Layer ${index} has invalid state machine reference` });
                continue;
            }
            const names = new Map();
            const stateIds = new Set();
            for (const stateRef of stateMachine._states || []) {
                const id = this.refId(stateRef);
                const state = document[id];
                if (!state) {
                    issues.push({ severity: 'error', message: `Layer ${index} references missing state id ${id}` });
                    continue;
                }
                stateIds.add(id);
                if (state.name) {
                    names.set(state.name, (names.get(state.name) || 0) + 1);
                }
                if (state.__type__ === MOTION_TYPE) {
                    const clipMotion = document[this.refId(state.motion)];
                    if (!clipMotion || clipMotion.__type__ !== CLIP_MOTION_TYPE || !clipMotion.clip || !clipMotion.clip.__uuid__) {
                        issues.push({ severity: 'warning', message: `Motion state "${state.name}" has no valid clip` });
                    }
                }
            }
            for (const [name, count] of names.entries()) {
                if (count > 1) {
                    issues.push({ severity: 'error', message: `Duplicate state name in layer ${index}: ${name}` });
                }
            }
            for (const transitionRef of stateMachine._transitions || []) {
                const transitionId = this.refId(transitionRef);
                const transition = document[transitionId];
                if (!transition) {
                    issues.push({ severity: 'error', message: `Missing transition id ${transitionId}` });
                    continue;
                }
                if (!stateIds.has(this.refId(transition.from)) || !stateIds.has(this.refId(transition.to))) {
                    issues.push({ severity: 'error', message: `Transition ${transitionId} references a state outside layer ${index}` });
                }
                for (const conditionRef of transition.conditions || []) {
                    const conditionIssue = this.validateCondition(document, this.refId(conditionRef), parameters, transitionId);
                    if (conditionIssue) {
                        issues.push(conditionIssue);
                    }
                }
            }
            if (layer.mask && (!layer.mask.__uuid__ || layer.mask.__expectedType__ !== 'cc.animation.AnimationMask')) {
                issues.push({ severity: 'warning', message: `Layer ${index} has malformed animation mask reference` });
            }
        }
        return issues;
    }

    validateCondition(document, id, parameters, transitionId) {
        const condition = document[id];
        if (!condition) {
            return { severity: 'error', message: `Transition ${transitionId} references missing condition ${id}` };
        }
        if (condition.__type__ === 'cc.animation.BinaryCondition') {
            const binding = document[this.refId(condition.lhsBinding)];
            if (!binding || !binding.variableName) {
                return { severity: 'error', message: `Binary condition ${id} is missing variable binding` };
            }
            if (typeof condition.rhs !== 'number') {
                return { severity: 'error', message: `Binary condition ${id} is missing numeric rhs` };
            }
        }
        if (condition.__type__ === 'cc.animation.UnaryCondition') {
            const operand = document[this.refId(condition.operand)];
            if (!operand || !operand.variable) {
                return { severity: 'error', message: `Unary condition ${id} is missing boolean operand` };
            }
        }
        if (condition.__type__ === 'cc.animation.TriggerCondition' && !condition.trigger) {
            return { severity: 'error', message: `Trigger condition ${id} is missing trigger name` };
        }
        const described = this.describeCondition(document, id);
        if (described && described.parameter && !parameters.has(described.parameter)) {
            return { severity: 'error', message: `Condition ${id} references missing parameter "${described.parameter}"` };
        }
        return null;
    }

    getGraphRoot(document) {
        const graph = document[0];
        if (!graph || graph.__type__ !== GRAPH_TYPE) {
            throw new Error(`Invalid animation graph root. Expected ${GRAPH_TYPE}`);
        }
        graph._layers = graph._layers || [];
        graph._variables = graph._variables || {};
        return graph;
    }

    getLayerRefs(document) {
        const graph = this.getGraphRoot(document);
        return (graph._layers || [])
            .map((ref, index) => ({ id: this.refId(ref), index }))
            .filter((item) => item.id != null && document[item.id])
            .map((item) => ({ ...item, layer: document[item.id] }));
    }

    getLayerContext(document, args) {
        const layers = this.getLayerRefs(document);
        if (layers.length === 0) {
            throw new Error('Animation graph has no layers');
        }
        let layerInfo = null;
        if (typeof args.layerIndex === 'number') {
            layerInfo = layers.find((item) => item.index === args.layerIndex);
        } else if (args.layerName) {
            layerInfo = layers.find((item) => item.layer.name === args.layerName);
        } else {
            layerInfo = layers[0];
        }
        if (!layerInfo) {
            throw new Error('Layer not found');
        }
        const smId = this.refId(layerInfo.layer._stateMachine);
        const stateMachine = document[smId];
        if (!stateMachine || stateMachine.__type__ !== STATE_MACHINE_TYPE) {
            throw new Error(`Layer has invalid state machine: ${layerInfo.index}`);
        }
        stateMachine._states = stateMachine._states || [];
        stateMachine._transitions = stateMachine._transitions || [];
        return { layer: layerInfo.layer, layerIndex: layerInfo.index, stateMachineId: smId, stateMachine };
    }

    findStateByName(document, stateMachine, name, required) {
        const matches = (stateMachine._states || [])
            .map((ref) => this.refId(ref))
            .filter((id) => id != null && document[id] && document[id].name === name)
            .map((id) => ({ id, object: document[id] }));
        if (matches.length > 1) {
            throw new Error(`State name is duplicated, cannot target safely: ${name}`);
        }
        if (matches.length === 0 && required) {
            throw new Error(`State not found: ${name}`);
        }
        return matches[0] || null;
    }

    assertUniqueStateName(document, stateMachine, name) {
        if (this.findStateByName(document, stateMachine, name, false)) {
            throw new Error(`State already exists: ${name}`);
        }
    }

    findTransition(document, args, required) {
        const context = this.getLayerContext(document, args);
        const fromName = this.requireString(args.fromStateName, 'fromStateName');
        const toName = this.requireString(args.toStateName, 'toStateName');
        const matches = (context.stateMachine._transitions || [])
            .map((ref) => this.refId(ref))
            .filter((id) => {
                const transition = document[id];
                return transition &&
                    this.nameForId(document, this.refId(transition.from)) === fromName &&
                    this.nameForId(document, this.refId(transition.to)) === toName;
            })
            .map((id) => ({ id, object: document[id] }));
        if (matches.length === 0 && required) {
            throw new Error(`Transition not found: ${fromName} -> ${toName}`);
        }
        if (matches.length > 1) {
            if (typeof args.transitionIndex !== 'number') {
                throw new Error(`Multiple transitions found for ${fromName} -> ${toName}; pass transitionIndex`);
            }
            if (!matches[args.transitionIndex]) {
                throw new Error(`transitionIndex out of range: ${args.transitionIndex}`);
            }
            return matches[args.transitionIndex];
        }
        return matches[0] || null;
    }

    nameForId(document, id) {
        return id != null && document[id] ? document[id].name || '' : '';
    }

    addObject(document, object) {
        document.push(object);
        return document.length - 1;
    }

    ref(id) {
        return { __id__: id };
    }

    refId(value) {
        return value && typeof value.__id__ === 'number' ? value.__id__ : null;
    }

    async resolveAssetUuid(value) {
        const text = this.requireString(value, 'asset uuid/url');
        if (!text.startsWith('db://')) {
            return text;
        }
        if (this.canUseEditorMessage()) {
            try {
                const info = await Editor.Message.request('asset-db', 'query-asset-info', text);
                if (info && info.uuid) {
                    return info.uuid;
                }
            } catch (_) {}
        }
        const source = await this.resolveDbUrlToPath(text);
        const metaPath = `${source}.meta`;
        if (fs.existsSync(metaPath)) {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            if (meta.uuid) {
                return meta.uuid;
            }
        }
        throw new Error(`Unable to resolve asset uuid: ${text}`);
    }

    assertWriteAllowed(document) {
        const support = document ? this.getCompatibilityForDocument(document) : this.getCompatibilityForVersion(this.getEditorVersion());
        if (support.writePolicy === 'refuse') {
            throw new Error(`Animation graph write refused for editor version ${support.currentEditorVersion || 'unknown'} (${support.supportLevel})`);
        }
    }

    getCompatibilityForDocument(document) {
        const base = this.getCompatibilityForVersion(this.getEditorVersion());
        try {
            this.getGraphRoot(document);
        } catch (_) {
            return { ...base, supportLevel: 'unsupported', writePolicy: 'refuse', schemaDetected: false };
        }
        return { ...base, schemaDetected: true };
    }

    getCompatibilityForVersion(version) {
        if (version === '3.8.2') {
            return { currentEditorVersion: version, supportLevel: 'verified', writePolicy: 'allow' };
        }
        if (/^3\.8\./.test(version || '')) {
            return { currentEditorVersion: version, supportLevel: 'compatible', writePolicy: 'cautious' };
        }
        return { currentEditorVersion: version || null, supportLevel: 'unsupported', writePolicy: 'refuse' };
    }

    getEditorVersion() {
        try {
            if (global.Editor && Editor.App && Editor.App.version) {
                return Editor.App.version;
            }
        } catch (_) {}
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(this.getProjectPath(), 'package.json'), 'utf8'));
            return pkg && pkg.creator && pkg.creator.version || null;
        } catch (_) {
            return null;
        }
    }

    async resolveAssetSource(url, mustExist) {
        let source = null;
        if (this.canUseEditorMessage()) {
            try {
                const info = await Editor.Message.request('asset-db', 'query-asset-info', url);
                source = this.pickAssetSource(info);
            } catch (_) {}
        }
        source = source || await this.resolveDbUrlToPath(url);
        if (mustExist && !fs.existsSync(source)) {
            throw new Error(`Animation graph not found: ${url}`);
        }
        return source;
    }

    pickAssetSource(info) {
        if (!info) {
            return null;
        }
        for (const candidate of [info.source, info.file, info.path]) {
            if (typeof candidate !== 'string' || !candidate.trim() || candidate.startsWith('db://')) {
                continue;
            }
            return candidate;
        }
        return null;
    }

    async resolveDbUrlToPath(url) {
        if (!url.startsWith('db://assets')) {
            throw new Error(`Only db://assets URLs are supported: ${url}`);
        }
        const relative = url.slice('db://assets'.length).replace(/^\/+/, '');
        return path.join(this.getProjectPath(), 'assets', ...relative.split('/').filter(Boolean));
    }

    pathToDbUrl(file) {
        const assetsRoot = path.join(this.getProjectPath(), 'assets');
        const relative = path.relative(assetsRoot, file).split(path.sep).join('/');
        return `db://assets/${relative}`;
    }

    getProjectPath() {
        if (global.Editor && Editor.Project && Editor.Project.path) {
            return Editor.Project.path;
        }
        let current = process.cwd();
        for (let index = 0; index < 8; index++) {
            const packagePath = path.join(current, 'package.json');
            const assetsPath = path.join(current, 'assets');
            if (fs.existsSync(packagePath) && fs.existsSync(assetsPath)) {
                try {
                    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
                    if (pkg.creator) {
                        return current;
                    }
                } catch (_) {}
            }
            const parent = path.dirname(current);
            if (parent === current) {
                break;
            }
            current = parent;
        }
        return path.resolve(__dirname, '../../../../../../..');
    }

    async writeGraphFile(source, document) {
        fs.mkdirSync(path.dirname(source), { recursive: true });
        fs.writeFileSync(source, JSON.stringify(document, null, 2), 'utf8');
    }

    async ensureMeta(source) {
        const metaPath = `${source}.meta`;
        if (fs.existsSync(metaPath)) {
            return;
        }
        const meta = {
            ver: '1.0.0',
            importer: 'animation-graph',
            imported: true,
            uuid: uuidv4(),
            files: ['.json'],
            subMetas: {},
            userData: {}
        };
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    }

    async refreshAsset(url) {
        if (!this.canUseEditorMessage()) {
            return;
        }
        for (const attempt of [
            () => Editor.Message.request('asset-db', 'refresh-asset', url),
            () => Editor.Message.request('asset-db', 'refresh', url),
            () => Editor.Message.request('asset-db', 'reimport-asset', url)
        ]) {
            try {
                await attempt();
                return;
            } catch (_) {}
        }
    }

    canUseEditorMessage() {
        return !!(global.Editor && Editor.Message && typeof Editor.Message.request === 'function');
    }

    normalizeGraphUrl(url) {
        const clean = this.normalizeFolderUrl(url);
        return clean.endsWith('.animgraph') ? clean : `${clean}.animgraph`;
    }

    normalizeFolderUrl(url) {
        const clean = this.requireString(url, 'url').replace(/\\/g, '/').replace(/\/+$/g, '');
        if (!clean.startsWith('db://assets')) {
            throw new Error(`Only db://assets URLs are supported: ${clean}`);
        }
        return clean;
    }

    requireString(value, name) {
        if (typeof value !== 'string' || !value.trim()) {
            throw new Error(`${name} is required`);
        }
        return value.trim();
    }

    walk(dir, visitor) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                this.walk(full, visitor);
            } else {
                visitor(full);
            }
        }
    }
}

module.exports = { AnimationGraphHandler };
