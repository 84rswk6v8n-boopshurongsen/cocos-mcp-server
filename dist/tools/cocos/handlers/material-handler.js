'use strict';

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { ComponentHandler } = require('./component-handler');
const { NodeHandler } = require('./node-handler');

const ACTIONS = [
    'list',
    'create_material',
    'inspect_material',
    'inspect_effect',
    'set_property',
    'set_color',
    'set_texture',
    'set_define',
    'inspect_renderer',
    'list_slots',
    'assign_material',
    'clear_material',
    'replace_material',
    'find_usages',
    'validate_materials'
];

const RENDERER_RE = /(MeshRenderer|SkinnedMeshRenderer|ModelRenderer|Sprite|Label|RichText|ParticleSystemRenderer|TrailRenderer)/i;
const MATERIAL_EXT_RE = /\.mtl$/i;
const EFFECT_EXT_RE = /\.effect$/i;
const SCENE_FILE_RE = /\.(scene|prefab)$/i;

function ok(data, message) {
    return { success: true, data, message };
}

function fail(error, data) {
    return { success: false, error, data };
}

function projectRoot() {
    try {
        if (globalThis.Editor && Editor.Project && Editor.Project.path) {
            return Editor.Project.path;
        }
    }
    catch (_) {}
    return process.cwd();
}

function normalizeSlash(value) {
    return String(value || '').replace(/\\/g, '/');
}

function toDbUrl(value, fallbackFolder, ext) {
    if (!value) {
        return null;
    }
    const text = normalizeSlash(value);
    if (text.startsWith('db://')) {
        return text;
    }
    if (text.startsWith('assets/')) {
        return `db://${text}`;
    }
    if (text.startsWith('/assets/')) {
        return `db://${text.slice(1)}`;
    }
    const folder = fallbackFolder || 'db://assets';
    const name = ext && !text.toLowerCase().endsWith(ext) ? `${text}${ext}` : text;
    return `${folder.replace(/\/$/, '')}/${name.replace(/^\/+/, '')}`;
}

function dbUrlToFilePath(dbUrl) {
    const normalized = normalizeSlash(dbUrl);
    if (normalized === 'db://assets') {
        return path.join(projectRoot(), 'assets');
    }
    if (!normalized.startsWith('db://assets/')) {
        return null;
    }
    return path.join(projectRoot(), 'assets', normalized.slice('db://assets/'.length));
}

function getEditorCandidateRoots() {
    const roots = new Set();
    const add = (value) => {
        if (value && typeof value === 'string') {
            roots.add(value);
        }
    };
    try {
        add(globalThis.Editor && Editor.App && Editor.App.path);
        add(globalThis.Editor && Editor.App && Editor.App.home);
        add(globalThis.Editor && Editor.Project && Editor.Project.path);
    }
    catch (_) {}
    add(process.resourcesPath);
    add(process.execPath && path.dirname(process.execPath));
    add(process.cwd());
    return Array.from(roots).filter((root) => root && fs.existsSync(root));
}

function findInternalEffectFile(dbUrl) {
    const normalized = normalizeSlash(dbUrl);
    if (!normalized.startsWith('db://internal/') || !normalized.endsWith('.effect')) {
        return null;
    }
    const fileName = path.basename(normalized);
    const relative = normalized.slice('db://internal/'.length);
    const suffixes = [
        relative,
        `resources/${relative}`,
        `resources/3d/engine/editor/assets/internal/${relative}`,
        `resources/3d/engine/editor/assets/${relative}`,
        `resources/resources/3d/engine/editor/assets/internal/${relative}`,
        `resources/resources/3d/engine/editor/assets/${relative}`
    ];
    for (const root of getEditorCandidateRoots()) {
        for (const suffix of suffixes) {
            const candidate = path.join(root, ...normalizeSlash(suffix).split('/'));
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
    }
    for (const root of getEditorCandidateRoots()) {
        const files = walkFiles(root, (file) => path.basename(file) === fileName, 3000);
        const matched = files.find((file) => normalizeSlash(file).endsWith(normalizeSlash(relative)))
            || files.find((file) => normalizeSlash(file).includes('/internal/') && path.basename(file) === fileName)
            || files[0];
        if (matched) {
            return matched;
        }
    }
    return null;
}

function filePathToDbUrl(filePath) {
    const root = path.join(projectRoot(), 'assets');
    const relative = path.relative(root, filePath);
    if (!relative || relative.startsWith('..')) {
        return null;
    }
    return `db://assets/${normalizeSlash(relative)}`;
}

function readTextIfExists(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) {
            return null;
        }
        return fs.readFileSync(filePath, 'utf8');
    }
    catch (_) {
        return null;
    }
}

function readJsonIfExists(filePath) {
    const text = readTextIfExists(filePath);
    if (!text) {
        return null;
    }
    try {
        return JSON.parse(text);
    }
    catch (_) {
        return null;
    }
}

function walkFiles(root, predicate, maxFiles) {
    const output = [];
    const limit = Number(maxFiles) || 2000;
    function walk(dir) {
        if (!dir || output.length >= limit || !fs.existsSync(dir)) {
            return;
        }
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'library' || entry.name === 'temp') {
                continue;
            }
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
            }
            else if (!predicate || predicate(fullPath)) {
                output.push(fullPath);
                if (output.length >= limit) {
                    return;
                }
            }
        }
    }
    walk(root);
    return output;
}

function firstObject(value) {
    if (Array.isArray(value)) {
        return value.find((item) => item && typeof item === 'object') || null;
    }
    return value && typeof value === 'object' ? value : null;
}

function compactValue(value, depth = 0) {
    if (depth > 5) {
        return '[MaxDepth]';
    }
    if (value === null || value === undefined || typeof value !== 'object') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.slice(0, 32).map((item) => compactValue(item, depth + 1));
    }
    if (value.uuid || value.__uuid__) {
        return { uuid: value.uuid || value.__uuid__ };
    }
    const output = {};
    for (const [key, item] of Object.entries(value)) {
        if (key === '_owner' || key === 'node' || key === '__eventTargets') {
            continue;
        }
        output[key] = compactValue(item, depth + 1);
    }
    return output;
}

function propValue(component, name) {
    const props = component && component.properties;
    if (!props || !props[name]) {
        return undefined;
    }
    const prop = props[name];
    return Object.prototype.hasOwnProperty.call(prop, 'value') ? prop.value : prop;
}

function componentType(component) {
    return (component && (component.type || component.name || component.componentType)) || '';
}

function isRendererComponent(component) {
    return RENDERER_RE.test(componentType(component));
}

function materialUuidFromSlot(slot) {
    if (!slot) {
        return '';
    }
    if (typeof slot === 'string') {
        return slot;
    }
    if (slot.uuid || slot.__uuid__) {
        return slot.uuid || slot.__uuid__;
    }
    if (slot.value) {
        return materialUuidFromSlot(slot.value);
    }
    return '';
}

function getMaterialSlots(component) {
    const raw = propValue(component, 'sharedMaterials') || propValue(component, '_materials') || propValue(component, 'materials') || [];
    const list = Array.isArray(raw) ? raw : [raw];
    return list.map((slot, index) => ({
        slot: index,
        uuid: materialUuidFromSlot(slot),
        raw: compactValue(slot)
    }));
}

function extractMaterialObjects(json) {
    if (!json) {
        return [];
    }
    const items = Array.isArray(json) ? json : [json];
    return items.filter((item) => item && typeof item === 'object');
}

function createMaterialJson(args) {
    return {
        __type__: 'cc.Material',
        _name: args.name || '',
        _objFlags: 0,
        __editorExtras__: {},
        _native: '',
        _effectAsset: {
            __uuid__: args.effectUuid || args.effect || 'c8f66d17-351a-48da-a12c-0212d28575c4',
            __expectedType__: 'cc.EffectAsset'
        },
        _techIdx: Number(args.technique || args.techIdx || 0),
        _defines: Array.isArray(args.defines) ? args.defines : [isObject(args.defines) ? args.defines : {}],
        _states: [
            {
                rasterizerState: {},
                depthStencilState: {},
                blendState: {
                    targets: [
                        {}
                    ]
                }
            }
        ],
        _props: Array.isArray(args.properties) ? args.properties : [isObject(args.properties) ? args.properties : {}]
    };
}

function createMaterialMeta(uuid) {
    return {
        ver: '1.0.21',
        importer: 'material',
        imported: true,
        uuid,
        files: [
            '.json'
        ],
        subMetas: {},
        userData: {}
    };
}

function findKeyDeep(value, names, results = [], depth = 0) {
    if (!value || typeof value !== 'object' || depth > 8) {
        return results;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            findKeyDeep(item, names, results, depth + 1);
        }
        return results;
    }
    for (const [key, item] of Object.entries(value)) {
        if (names.includes(key)) {
            results.push(item);
        }
        findKeyDeep(item, names, results, depth + 1);
    }
    return results;
}

function isObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function techniqueIndex(args) {
    const value = args.technique !== undefined ? args.technique : args.techIdx;
    const index = Number(value === undefined ? 0 : value);
    return Number.isFinite(index) && index >= 0 ? Math.floor(index) : 0;
}

function ensureArraySlot(owner, key, index) {
    if (!Array.isArray(owner[key])) {
        owner[key] = [];
    }
    while (owner[key].length <= index) {
        owner[key].push({});
    }
    if (!isObject(owner[key][index])) {
        owner[key][index] = {};
    }
    return owner[key][index];
}

function normalizeColor(value) {
    const color = isObject(value) ? value : {};
    return {
        __type__: 'cc.Color',
        r: Number(color.r !== undefined ? color.r : 255),
        g: Number(color.g !== undefined ? color.g : 255),
        b: Number(color.b !== undefined ? color.b : 255),
        a: Number(color.a !== undefined ? color.a : 255)
    };
}

function normalizeMaterialValue(args) {
    const propertyType = String(args.propertyType || args.type || '').toLowerCase();
    if (propertyType === 'color') {
        return normalizeColor(args.color || args.value);
    }
    if (propertyType === 'texture' || propertyType === 'texture2d') {
        const uuid = args.textureUuid || args.uuid || materialUuidFromSlot(args.value);
        if (!uuid) {
            return null;
        }
        return {
            __uuid__: uuid,
            __expectedType__: 'cc.Texture2D'
        };
    }
    const value = args.value !== undefined ? args.value : args.color;
    if (isObject(value) && ['r', 'g', 'b'].some((key) => Object.prototype.hasOwnProperty.call(value, key))) {
        return normalizeColor(value);
    }
    return value;
}

function extractMaterialInfo(json, dbUrl, uuid) {
    const objects = extractMaterialObjects(json);
    const main = objects.find((item) => /Material/i.test(String(item.__type__ || item.type || ''))) || firstObject(json) || {};
    const props = findKeyDeep(main, ['_props', 'props', 'properties']).find((item) => item && typeof item === 'object') || {};
    const defines = findKeyDeep(main, ['_defines', 'defines']).find((item) => item && typeof item === 'object') || {};
    const states = findKeyDeep(main, ['_states', 'states']).find((item) => item && typeof item === 'object') || {};
    const effectAsset = main._effectAsset || main.effectAsset || main.effect || null;
    return {
        url: dbUrl || null,
        uuid: uuid || null,
        name: main._name || main.name || (dbUrl ? path.basename(dbUrl, path.extname(dbUrl)) : ''),
        type: main.__type__ || main.type || 'cc.Material',
        effect: compactValue(effectAsset),
        technique: main._techIdx !== undefined ? main._techIdx : main.technique,
        defines: compactValue(defines),
        states: compactValue(states),
        properties: compactValue(props),
        textureRefs: collectUuidRefs(props),
        rawKeys: Object.keys(main).slice(0, 80)
    };
}

function collectUuidRefs(value, refs = []) {
    if (!value || typeof value !== 'object') {
        return refs;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            collectUuidRefs(item, refs);
        }
        return refs;
    }
    const uuid = value.uuid || value.__uuid__;
    if (uuid) {
        refs.push(uuid);
    }
    for (const item of Object.values(value)) {
        collectUuidRefs(item, refs);
    }
    return Array.from(new Set(refs));
}

function countIndent(line) {
    const match = String(line || '').match(/^\s*/);
    return match ? match[0].length : 0;
}

function stripInlineComment(line) {
    const text = String(line || '');
    let quote = null;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if ((char === '"' || char === "'") && text[i - 1] !== '\\') {
            quote = quote === char ? null : quote || char;
        }
        if (!quote && char === '#') {
            return text.slice(0, i).trimEnd();
        }
    }
    return text.trimEnd();
}

function splitTopLevel(text, delimiter) {
    const output = [];
    let quote = null;
    let depth = 0;
    let start = 0;
    const source = String(text || '');
    for (let i = 0; i < source.length; i++) {
        const char = source[i];
        const previous = source[i - 1];
        if ((char === '"' || char === "'") && previous !== '\\') {
            quote = quote === char ? null : quote || char;
            continue;
        }
        if (quote) {
            continue;
        }
        if (char === '{' || char === '[' || char === '(') {
            depth++;
        }
        else if (char === '}' || char === ']' || char === ')') {
            depth = Math.max(0, depth - 1);
        }
        else if (char === delimiter && depth === 0) {
            output.push(source.slice(start, i).trim());
            start = i + 1;
        }
    }
    const last = source.slice(start).trim();
    if (last) {
        output.push(last);
    }
    return output;
}

function findTopLevelColon(text) {
    let quote = null;
    let depth = 0;
    const source = String(text || '');
    for (let i = 0; i < source.length; i++) {
        const char = source[i];
        const previous = source[i - 1];
        if ((char === '"' || char === "'") && previous !== '\\') {
            quote = quote === char ? null : quote || char;
            continue;
        }
        if (quote) {
            continue;
        }
        if (char === '{' || char === '[' || char === '(') {
            depth++;
        }
        else if (char === '}' || char === ']' || char === ')') {
            depth = Math.max(0, depth - 1);
        }
        else if (char === ':' && depth === 0) {
            return i;
        }
    }
    return -1;
}

function parseScalar(raw) {
    const value = String(raw == null ? '' : raw).trim();
    if (value === '') {
        return '';
    }
    if (value.startsWith('{') && value.endsWith('}')) {
        return parseInlineMap(value) || value;
    }
    if (value.startsWith('[') && value.endsWith(']')) {
        return parseInlineArray(value) || value;
    }
    if (value === 'true') {
        return true;
    }
    if (value === 'false') {
        return false;
    }
    if (value === 'null') {
        return null;
    }
    if (/^-?\d+(\.\d+)?$/.test(value)) {
        return Number(value);
    }
    const quoted = value.match(/^['"](.*)['"]$/);
    if (quoted) {
        return quoted[1];
    }
    return value;
}

function parseInlineArray(raw) {
    const text = String(raw || '').trim();
    if (!text.startsWith('[') || !text.endsWith(']')) {
        return null;
    }
    const body = text.slice(1, -1).trim();
    if (!body) {
        return [];
    }
    return splitTopLevel(body, ',').map((part) => parseScalar(part));
}

function parseInlineMap(raw) {
    const text = String(raw || '').trim();
    if (!text.startsWith('{') || !text.endsWith('}')) {
        return null;
    }
    const body = text.slice(1, -1).trim();
    if (!body) {
        return {};
    }
    const output = {};
    for (const part of splitTopLevel(body, ',')) {
        const index = findTopLevelColon(part);
        if (index <= 0) {
            continue;
        }
        const key = part.slice(0, index).trim();
        output[key] = parseScalar(part.slice(index + 1));
    }
    return output;
}

function extractBlockLines(lines, startIndex) {
    const startIndent = countIndent(lines[startIndex]);
    const output = [];
    for (let i = startIndex + 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) {
            output.push({ line, index: i });
            continue;
        }
        const indent = countIndent(line);
        if (indent <= startIndent) {
            break;
        }
        output.push({ line, index: i });
    }
    return output;
}

function parsePropertyBlock(lines, startIndex) {
    const block = extractBlockLines(lines, startIndex);
    const propertyIndent = countIndent(lines[startIndex]);
    const childIndents = [];
    for (const entry of block) {
        const clean = stripInlineComment(entry.line);
        const match = clean.match(/^(\s*)([A-Za-z_][\w]*)\s*:/);
        if (match && match[1].length > propertyIndent) {
            childIndents.push(match[1].length);
        }
    }
    const directPropertyIndent = childIndents.length ? Math.min(...childIndents) : propertyIndent + 2;
    const properties = [];
    for (let i = 0; i < block.length; i++) {
        const entry = block[i];
        const clean = stripInlineComment(entry.line);
        if (!clean.trim()) {
            continue;
        }
        const match = clean.match(/^(\s*)([A-Za-z_][\w]*)\s*:\s*(.*)$/);
        if (!match) {
            continue;
        }
        const indent = match[1].length;
        if (indent <= propertyIndent) {
            continue;
        }
        if (indent !== directPropertyIndent) {
            continue;
        }
        const name = match[2];
        const raw = match[3].trim();
        const inlineMap = parseInlineMap(raw);
        const property = {
            name,
            line: entry.index + 1,
            raw: raw || null
        };
        if (inlineMap) {
            Object.assign(property, inlineMap);
        }
        else if (raw) {
            property.default = parseScalar(raw);
        }
        else {
            const nested = parseIndentedMap(lines, entry.index);
            if (Object.keys(nested).length) {
                Object.assign(property, nested);
            }
        }
        properties.push(property);
    }
    return properties;
}

function parseIndentedMap(lines, startIndex) {
    const block = extractBlockLines(lines, startIndex);
    const mapIndent = countIndent(lines[startIndex]);
    const output = {};
    for (const entry of block) {
        const clean = stripInlineComment(entry.line);
        const match = clean.match(/^(\s*)([A-Za-z_][\w]*)\s*:\s*(.*)$/);
        if (!match) {
            continue;
        }
        const indent = match[1].length;
        if (indent <= mapIndent) {
            continue;
        }
        const key = match[2];
        const raw = match[3].trim();
        output[key] = parseInlineMap(raw) || parseScalar(raw);
    }
    return output;
}

function parseEffectPasses(lines) {
    const passes = [];
    let current = null;
    for (let i = 0; i < lines.length; i++) {
        const clean = stripInlineComment(lines[i]);
        const passStart = clean.match(/^\s*-\s*vert\s*:\s*(.+)$/);
        if (passStart) {
            current = {
                index: passes.length,
                line: i + 1,
                vert: parseScalar(passStart[1]),
                frag: null,
                phase: null,
                properties: [],
                defines: {},
                states: {}
            };
            passes.push(current);
            continue;
        }
        if (!current) {
            continue;
        }
        const frag = clean.match(/^\s*frag\s*:\s*(.+)$/);
        if (frag) {
            current.frag = parseScalar(frag[1]);
            continue;
        }
        const phase = clean.match(/^\s*phase\s*:\s*(.+)$/);
        if (phase) {
            current.phase = parseScalar(phase[1]);
            continue;
        }
        if (/^\s*properties\s*:\s*$/.test(clean)) {
            current.properties.push(...parsePropertyBlock(lines, i));
            continue;
        }
        if (/^\s*defines\s*:\s*$/.test(clean)) {
            Object.assign(current.defines, parseIndentedMap(lines, i));
            continue;
        }
        const state = clean.match(/^\s*(rasterizerState|depthStencilState|blendState)\s*:\s*(.*)$/);
        if (state) {
            current.states[state[1]] = parseInlineMap(state[2]) || parseIndentedMap(lines, i) || {};
        }
    }
    return passes;
}

function extractUniformBlocks(source) {
    const blocks = [];
    const blockRe = /\buniform\s+([A-Za-z_][\w]*)\s*\{([\s\S]*?)\}/g;
    let match;
    while ((match = blockRe.exec(source))) {
        const body = match[2];
        const fields = [];
        const fieldRe = /\b([A-Za-z_][\w]*)\s+([A-Za-z_][\w]*)\s*(?:\[[^\]]+\])?\s*;/g;
        let field;
        while ((field = fieldRe.exec(body))) {
            fields.push({ type: field[1], name: field[2] });
        }
        blocks.push({
            name: match[1],
            fields
        });
    }
    return blocks;
}

function extractMacroRefs(source) {
    const macros = new Set();
    const re = /#\s*(?:if|ifdef|ifndef|elif)\s+([A-Z_][A-Z0-9_]*)/g;
    let match;
    while ((match = re.exec(source))) {
        macros.add(match[1]);
    }
    return Array.from(macros);
}

function parseEffectText(text) {
    const source = String(text || '');
    const lines = source.split(/\r?\n/);
    const passes = parseEffectPasses(lines);
    const passProperties = [];
    for (const pass of passes) {
        for (const property of pass.properties || []) {
            passProperties.push(Object.assign({ pass: pass.index }, property));
        }
    }
    const propertyNames = [];
    const uniformNames = [];
    const programNames = [];
    for (const property of passProperties) {
        if (!propertyNames.includes(property.name)) {
            propertyNames.push(property.name);
        }
    }
    const ignoredPropertyKeys = new Set([
        'techniques', 'passes', 'vert', 'frag', 'phase', 'properties', 'migrations',
        'defines', 'rasterizerState', 'depthStencilState', 'blendState', 'targets',
        'cullMode', 'depthTest', 'depthWrite', 'blend', 'blendSrc', 'blendDst',
        'blendEq', 'format', 'type', 'editor', 'value'
    ]);
    const propertyRe = /^\s{2,}([A-Za-z_][\w]*)\s*:/gm;
    let match;
    if (propertyNames.length === 0) {
        while ((match = propertyRe.exec(source))) {
            const name = match[1];
            if (!ignoredPropertyKeys.has(name) && !propertyNames.includes(name)) {
                propertyNames.push(name);
            }
        }
    }
    const uniformRe = /\buniform\s+\w+\s+([A-Za-z_][\w]*)/g;
    while ((match = uniformRe.exec(source))) {
        if (!uniformNames.includes(match[1])) {
            uniformNames.push(match[1]);
        }
    }
    const programRe = /\bCCProgram\s+([A-Za-z_][\w]*)/g;
    while ((match = programRe.exec(source))) {
        if (!programNames.includes(match[1])) {
            programNames.push(match[1]);
        }
    }
    const uniformBlocks = extractUniformBlocks(source);
    for (const block of uniformBlocks) {
        for (const field of block.fields) {
            if (!uniformNames.includes(field.name)) {
                uniformNames.push(field.name);
            }
        }
    }
    return {
        propertyNames: propertyNames.slice(0, 80),
        properties: passProperties.slice(0, 120),
        uniformNames: uniformNames.slice(0, 80),
        uniformBlocks,
        programNames,
        macroRefs: extractMacroRefs(source),
        passes,
        techniqueCount: (source.match(/^\s*-\s*passes:/gm) || []).length || (source.match(/\btechniques\s*:/g) || []).length,
        passCount: passes.length || (source.match(/^\s*-\s*vert:/gm) || []).length,
        lineCount: lines.length
    };
}

function resolveNodeList(result) {
    const data = result && result.data;
    if (!data) {
        return [];
    }
    if (Array.isArray(data)) {
        return data;
    }
    if (Array.isArray(data.nodes)) {
        return data.nodes;
    }
    if (data.tree) {
        return flattenNodeTree(data.tree);
    }
    if (data.root) {
        return flattenNodeTree(data.root);
    }
    return [];
}

function flattenNodeTree(node, output = []) {
    if (!node || typeof node !== 'object') {
        return output;
    }
    output.push(node);
    for (const child of node.children || []) {
        flattenNodeTree(child, output);
    }
    return output;
}

class MaterialHandler {
    constructor() {
        this.component = new ComponentHandler();
        this.node = new NodeHandler();
    }

    getToolDefinition() {
        return {
            name: 'material',
            description: 'Cocos 材质与 Shader 工具 - 读取/检查渲染材质、Renderer 材质槽、自定义 effect 浅层信息，并支持基础材质槽替换。',
            inputSchema: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ACTIONS,
                        description: '操作：list、create_material、inspect_material、inspect_effect、set_property、set_color、set_texture、set_define、inspect_renderer、list_slots、assign_material、clear_material、replace_material、find_usages、validate_materials'
                    },
                    url: { type: 'string', description: '材质或 effect 的 db:// 路径' },
                    uuid: { type: 'string', description: '材质或资源 UUID' },
                    folder: { type: 'string', description: '扫描文件夹，默认 db://assets' },
                    node: { type: 'string', description: '节点名称、路径或 UUID' },
                    componentType: { type: 'string', description: 'Renderer 组件类型，默认自动筛选 MeshRenderer/SkinnedMeshRenderer 等' },
                    slot: { type: 'number', description: '材质槽下标，默认 0' },
                    materialUrl: { type: 'string', description: '要设置的材质 db:// 路径' },
                    templateUrl: { type: 'string', description: '创建材质时使用的模板材质路径' },
                    name: { type: 'string', description: '创建材质时的名称' },
                    effect: { type: 'string', description: '创建材质时使用的 effect UUID' },
                    effectUuid: { type: 'string', description: '创建材质时使用的 effect UUID' },
                    technique: { type: 'number', description: '创建材质时使用的 technique 下标，默认 0' },
                    property: { type: 'string', description: '材质属性名，例如 mainColor、roughness、metallic、自定义 shader 属性名' },
                    propertyType: { type: 'string', description: '属性类型：color、number、boolean、string、texture、vec4 等；不填则自动按 value 推断' },
                    value: { description: 'set_property/set_define 要写入的值' },
                    color: { description: 'set_color 要写入的颜色 {r,g,b,a}' },
                    textureUrl: { type: 'string', description: 'set_texture 要绑定的贴图 db:// 路径' },
                    textureUuid: { type: 'string', description: 'set_texture 要绑定的贴图 UUID' },
                    overwrite: { type: 'boolean', description: 'create_material 是否覆盖已有文件，默认 false' },
                    oldMaterialUrl: { type: 'string', description: 'replace_material/find_usages 的旧材质路径' },
                    newMaterialUrl: { type: 'string', description: 'replace_material 的新材质路径' },
                    rootNode: { type: 'string', description: '扫描场景节点的根节点，默认整个场景' },
                    includeDetails: { type: 'boolean', description: '是否返回材质文件详情，默认 false' },
                    recursive: { type: 'boolean', description: '是否递归扫描，默认 true' },
                    maxFiles: { type: 'number', description: '文件扫描上限，默认 2000' },
                    maxNodes: { type: 'number', description: '节点扫描上限，默认 200' },
                    dryRun: { type: 'boolean', description: 'replace_material 预演，不实际修改' }
                },
                required: ['action']
            }
        };
    }

    async execute(args) {
        const action = args && args.action;
        switch (action) {
            case 'list':
                return await this.listMaterials(args || {});
            case 'create_material':
                return await this.createMaterial(args || {});
            case 'inspect_material':
                return await this.inspectMaterial(args || {});
            case 'inspect_effect':
                return await this.inspectEffect(args || {});
            case 'set_property':
                return await this.setMaterialProperty(args || {});
            case 'set_color':
                return await this.setMaterialColor(args || {});
            case 'set_texture':
                return await this.setMaterialTexture(args || {});
            case 'set_define':
                return await this.setMaterialDefine(args || {});
            case 'inspect_renderer':
            case 'list_slots':
                return await this.inspectRenderer(args || {});
            case 'assign_material':
                return await this.assignMaterial(args || {});
            case 'clear_material':
                return await this.clearMaterial(args || {});
            case 'replace_material':
                return await this.replaceMaterial(args || {});
            case 'find_usages':
                return await this.findUsages(args || {});
            case 'validate_materials':
                return await this.validateMaterials(args || {});
            default:
                return fail(`未知材质工具操作：${action || ''}`);
        }
    }

    async queryAssetUuid(dbUrl) {
        if (!dbUrl || !globalThis.Editor || !Editor.Message || !Editor.Message.request) {
            return null;
        }
        const attempts = [
            ['asset-db', 'query-uuid', dbUrl],
            ['asset-db', 'query-asset-uuid', dbUrl],
            ['asset-db', 'query-url-to-uuid', dbUrl]
        ];
        for (const [channel, message, payload] of attempts) {
            try {
                const result = await Editor.Message.request(channel, message, payload);
                if (typeof result === 'string' && result) {
                    return result;
                }
                if (result && typeof result === 'object' && (result.uuid || result.value)) {
                    return result.uuid || result.value;
                }
            }
            catch (_) {}
        }
        return null;
    }

    async queryAssetUrl(uuid) {
        if (!uuid || !globalThis.Editor || !Editor.Message || !Editor.Message.request) {
            return null;
        }
        const attempts = [
            ['asset-db', 'query-url', uuid],
            ['asset-db', 'query-asset-url', uuid],
            ['asset-db', 'query-uuid-to-url', uuid]
        ];
        for (const [channel, message, payload] of attempts) {
            try {
                const result = await Editor.Message.request(channel, message, payload);
                if (typeof result === 'string' && result) {
                    return result;
                }
                if (result && typeof result === 'object' && (result.url || result.value)) {
                    return result.url || result.value;
                }
            }
            catch (_) {}
        }
        return null;
    }

    async queryAssetFilePath(dbUrl) {
        if (!dbUrl || !globalThis.Editor || !Editor.Message || !Editor.Message.request) {
            return null;
        }
        const attempts = [
            ['asset-db', 'query-path', dbUrl],
            ['asset-db', 'query-asset-path', dbUrl],
            ['asset-db', 'query-url-to-path', dbUrl],
            ['asset-db', 'query-asset-info', dbUrl],
            ['asset-db', 'query-info', dbUrl],
            ['asset-db', 'query-asset', dbUrl]
        ];
        const pickPath = (result) => {
            if (typeof result === 'string' && result) {
                return result;
            }
            if (!result || typeof result !== 'object') {
                return null;
            }
            const candidates = [
                result.path,
                result.file,
                result.source,
                result.nativeAsset,
                result.value,
                result.asset && result.asset.path,
                result.asset && result.asset.file,
                result.asset && result.asset.source
            ];
            return candidates.find((item) => typeof item === 'string' && item) || null;
        };
        for (const [channel, message, payload] of attempts) {
            try {
                const result = await Editor.Message.request(channel, message, payload);
                const filePath = pickPath(result);
                if (filePath && fs.existsSync(filePath)) {
                    return filePath;
                }
            }
            catch (_) {}
        }
        return null;
    }

    async resolveEffectFilePath(dbUrl) {
        const localPath = dbUrlToFilePath(dbUrl);
        if (localPath && fs.existsSync(localPath)) {
            return { filePath: localPath, source: 'db://assets' };
        }
        const assetDbPath = await this.queryAssetFilePath(dbUrl);
        if (assetDbPath && fs.existsSync(assetDbPath)) {
            return { filePath: assetDbPath, source: 'asset-db' };
        }
        const internalPath = findInternalEffectFile(dbUrl);
        if (internalPath && fs.existsSync(internalPath)) {
            return { filePath: internalPath, source: 'internal-search' };
        }
        return { filePath: localPath || assetDbPath || internalPath || null, source: null };
    }

    async refreshAsset(dbUrl) {
        if (!globalThis.Editor || !Editor.Message || !Editor.Message.request) {
            return { success: false, skipped: true, reason: 'asset-db 刷新接口不可用' };
        }
        const attempts = [
            ['asset-db', 'refresh-asset', dbUrl],
            ['asset-db', 'refresh', dbUrl],
            ['asset-db', 'refresh']
        ];
        for (const [channel, message, payload] of attempts) {
            try {
                const result = payload === undefined
                    ? await Editor.Message.request(channel, message)
                    : await Editor.Message.request(channel, message, payload);
                return { success: true, channel, message, result };
            }
            catch (_) {}
        }
        return { success: false, skipped: true, reason: 'asset-db 刷新接口不可用' };
    }

    async resolveMaterialUrl(args) {
        if (args.url || args.materialUrl) {
            return toDbUrl(args.url || args.materialUrl, args.folder, '.mtl');
        }
        if (args.uuid) {
            return await this.queryAssetUrl(args.uuid);
        }
        return null;
    }

    async listMaterials(args) {
        const folderUrl = toDbUrl(args.folder || 'db://assets');
        const folderPath = dbUrlToFilePath(folderUrl);
        if (!folderPath || !fs.existsSync(folderPath)) {
            return fail(`材质扫描目录不存在：${folderUrl}`);
        }
        const files = walkFiles(folderPath, (file) => MATERIAL_EXT_RE.test(file), args.maxFiles);
        const items = [];
        for (const file of files) {
            const url = filePathToDbUrl(file);
            const json = args.includeDetails ? readJsonIfExists(file) : null;
            const info = json ? extractMaterialInfo(json, url, await this.queryAssetUuid(url)) : null;
            items.push(info || {
                url,
                name: path.basename(file, path.extname(file)),
                uuid: await this.queryAssetUuid(url)
            });
        }
        return ok({
            folder: folderUrl,
            count: items.length,
            materials: items
        }, `已找到 ${items.length} 个材质资源。`);
    }

    async createMaterial(args) {
        const baseName = args.name || `McpMaterial_${Date.now()}`;
        let dbUrl = args.url || args.materialUrl;
        if (!dbUrl) {
            const folder = args.folder || 'db://assets/materials';
            dbUrl = `${folder.replace(/\/$/, '')}/${baseName}.mtl`;
        }
        dbUrl = toDbUrl(dbUrl, args.folder || 'db://assets/materials', '.mtl');
        const filePath = dbUrlToFilePath(dbUrl);
        if (!filePath) {
            return fail(`只能在 db://assets 下创建材质：${dbUrl}`);
        }
        if (fs.existsSync(filePath) && !args.overwrite) {
            return fail(`材质文件已存在：${dbUrl}。如需覆盖请传 overwrite:true。`);
        }

        let json = null;
        if (args.templateUrl) {
            const templateUrl = toDbUrl(args.templateUrl, args.folder, '.mtl');
            json = readJsonIfExists(dbUrlToFilePath(templateUrl));
            if (!json) {
                return fail(`无法读取模板材质：${templateUrl}`);
            }
            const main = firstObject(json);
            if (main && typeof main === 'object') {
                main._name = baseName;
            }
        }
        else {
            json = createMaterialJson(Object.assign({}, args, { name: baseName }));
        }

        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(json, null, 2), 'utf8');

        const metaPath = `${filePath}.meta`;
        const metaUuid = args.uuid || uuidv4();
        if (!fs.existsSync(metaPath) || args.overwrite) {
            fs.writeFileSync(metaPath, JSON.stringify(createMaterialMeta(metaUuid), null, 2), 'utf8');
        }

        const refresh = await this.refreshAsset(dbUrl);
        const uuid = await this.queryAssetUuid(dbUrl) || metaUuid;
        return ok({
            url: dbUrl,
            uuid,
            filePath,
            metaPath,
            material: extractMaterialInfo(json, dbUrl, uuid),
            refresh
        }, '材质已创建。');
    }

    async inspectMaterial(args) {
        const dbUrl = await this.resolveMaterialUrl(args);
        if (!dbUrl) {
            return fail('url/materialUrl/uuid 至少需要提供一个。');
        }
        const filePath = dbUrlToFilePath(dbUrl);
        const json = readJsonIfExists(filePath);
        const uuid = args.uuid || await this.queryAssetUuid(dbUrl);
        if (!json) {
            return fail(`无法读取材质文件：${dbUrl}`, { url: dbUrl, uuid, filePath });
        }
        return ok(extractMaterialInfo(json, dbUrl, uuid), '已读取材质信息。');
    }

    async writeMaterialJson(dbUrl, json) {
        const filePath = dbUrlToFilePath(dbUrl);
        if (!filePath) {
            return fail(`只能修改 db://assets 下的材质：${dbUrl}`);
        }
        fs.writeFileSync(filePath, JSON.stringify(json, null, 2), 'utf8');
        const refresh = await this.refreshAsset(dbUrl);
        return ok({
            url: dbUrl,
            filePath,
            refresh
        }, '材质文件已写入。');
    }

    async loadEditableMaterial(args) {
        const dbUrl = await this.resolveMaterialUrl(args);
        if (!dbUrl) {
            return fail('url/materialUrl/uuid 至少需要提供一个。');
        }
        const filePath = dbUrlToFilePath(dbUrl);
        const json = readJsonIfExists(filePath);
        if (!json || !isObject(json)) {
            return fail(`无法读取可编辑材质文件：${dbUrl}`, { url: dbUrl, filePath });
        }
        return ok({ dbUrl, filePath, json });
    }

    async setMaterialProperty(args) {
        const property = args.property || args.name;
        if (!property) {
            return fail('property 是必填参数。');
        }
        const loaded = await this.loadEditableMaterial(args);
        if (!loaded.success) {
            return loaded;
        }
        const json = loaded.data.json;
        const index = techniqueIndex(args);
        const props = ensureArraySlot(json, '_props', index);
        const value = normalizeMaterialValue(args);
        if (value === null || value === undefined) {
            return fail('value/color/textureUuid 是必填参数，或当前属性类型无法推断。');
        }
        props[property] = value;
        const written = await this.writeMaterialJson(loaded.data.dbUrl, json);
        if (!written.success) {
            return written;
        }
        const uuid = args.uuid || await this.queryAssetUuid(loaded.data.dbUrl);
        return ok({
            url: loaded.data.dbUrl,
            uuid,
            technique: index,
            property,
            value,
            material: extractMaterialInfo(json, loaded.data.dbUrl, uuid),
            refresh: written.data.refresh
        }, `材质属性已更新：${property}`);
    }

    async setMaterialColor(args) {
        return await this.setMaterialProperty(Object.assign({}, args, {
            property: args.property || 'mainColor',
            propertyType: 'color',
            value: args.color || args.value
        }));
    }

    async setMaterialTexture(args) {
        let textureUuid = args.textureUuid || args.uuid;
        if (!textureUuid && args.textureUrl) {
            textureUuid = await this.queryAssetUuid(toDbUrl(args.textureUrl, args.folder));
        }
        if (!textureUuid) {
            return fail('textureUrl 或 textureUuid 是必填参数。');
        }
        return await this.setMaterialProperty(Object.assign({}, args, {
            property: args.property || 'mainTexture',
            propertyType: 'texture',
            textureUuid
        }));
    }

    async setMaterialDefine(args) {
        const property = args.property || args.name;
        if (!property) {
            return fail('property 是必填参数，请提供 define 名称。');
        }
        const loaded = await this.loadEditableMaterial(args);
        if (!loaded.success) {
            return loaded;
        }
        const json = loaded.data.json;
        const index = techniqueIndex(args);
        const defines = ensureArraySlot(json, '_defines', index);
        defines[property] = args.value !== undefined ? args.value : true;
        const written = await this.writeMaterialJson(loaded.data.dbUrl, json);
        if (!written.success) {
            return written;
        }
        const uuid = args.uuid || await this.queryAssetUuid(loaded.data.dbUrl);
        return ok({
            url: loaded.data.dbUrl,
            uuid,
            technique: index,
            property,
            value: defines[property],
            material: extractMaterialInfo(json, loaded.data.dbUrl, uuid),
            refresh: written.data.refresh
        }, `材质 define 已更新：${property}`);
    }

    async inspectEffect(args) {
        const dbUrl = toDbUrl(args.url, args.folder, '.effect');
        if (!dbUrl) {
            return fail('url 是必填参数，请提供 effect 文件路径。');
        }
        const resolved = await this.resolveEffectFilePath(dbUrl);
        const filePath = resolved.filePath;
        const text = readTextIfExists(filePath);
        if (!text) {
            return fail(`无法读取 effect 文件：${dbUrl}`, {
                url: dbUrl,
                filePath,
                source: resolved.source,
                hint: dbUrl.startsWith('db://internal/')
                    ? '当前是 Cocos 内置 effect，请确认 AssetDB 能返回真实文件路径，或使用 db://assets 下的自定义 .effect 测试。'
                    : undefined
            });
        }
        return ok(Object.assign({
            url: dbUrl,
            filePath,
            source: resolved.source,
            name: path.basename(dbUrl),
            size: Buffer.byteLength(text, 'utf8')
        }, parseEffectText(text)), '已读取 effect 浅层信息。');
    }

    async inspectRenderer(args) {
        if (!args.node) {
            return fail('node 是必填参数，请提供节点名称、路径或 UUID。');
        }
        const result = await this.component.execute({ action: 'list', node: args.node });
        if (!result || !result.success) {
            return result;
        }
        const components = (result.data && result.data.components) || [];
        const renderers = components.filter((component) => {
            if (args.componentType) {
                return componentType(component) === args.componentType;
            }
            return isRendererComponent(component);
        });
        const rendererInfos = [];
        for (const renderer of renderers) {
            const slots = [];
            for (const slot of getMaterialSlots(renderer)) {
                const url = await this.queryAssetUrl(slot.uuid);
                const item = Object.assign({}, slot, { url });
                if (args.includeDetails && url) {
                    const material = await this.inspectMaterial({ url });
                    item.material = material && material.success ? material.data : null;
                }
                slots.push(item);
            }
            rendererInfos.push({
                type: componentType(renderer),
                uuid: renderer.uuid,
                enabled: renderer.enabled,
                slots
            });
        }
        return ok({
            node: args.node,
            nodeUuid: result.data && result.data.nodeUuid,
            rendererCount: rendererInfos.length,
            renderers: rendererInfos
        }, `已读取 ${rendererInfos.length} 个渲染组件的材质槽。`);
    }

    async setRendererSlots(args, mutator) {
        if (!args.node) {
            return fail('node 是必填参数。');
        }
        const rendererInfo = await this.inspectRenderer(args);
        if (!rendererInfo.success) {
            return rendererInfo;
        }
        const renderer = (rendererInfo.data.renderers || [])[0];
        if (!renderer) {
            return fail('当前节点没有可设置材质的渲染组件。', { node: args.node });
        }
        const slots = renderer.slots.map((slot) => ({ value: { uuid: slot.uuid || '' } }));
        mutator(slots);
        const value = slots.map((slot) => slot.value);
        const result = await this.component.execute({
            action: 'set_property',
            node: args.node,
            componentType: renderer.type,
            property: 'sharedMaterials',
            propertyType: 'asset',
            value
        });
        if (!result || !result.success) {
            return fail('材质槽写入失败。当前编辑器组件接口可能不支持数组材质槽直接写入。', {
                node: args.node,
                componentType: renderer.type,
                attemptedValue: value,
                result
            });
        }
        return ok({
            node: args.node,
            componentType: renderer.type,
            slots: value,
            result
        }, '材质槽已更新。');
    }

    async assignMaterial(args) {
        if (!args.materialUrl && !args.url) {
            return fail('materialUrl 是必填参数。');
        }
        const dbUrl = toDbUrl(args.materialUrl || args.url, args.folder, '.mtl');
        const uuid = await this.queryAssetUuid(dbUrl);
        if (!uuid) {
            return fail(`无法解析材质 UUID：${dbUrl}`);
        }
        const slotIndex = Number(args.slot || 0);
        return await this.setRendererSlots(args, (slots) => {
            while (slots.length <= slotIndex) {
                slots.push({ value: { uuid: '' } });
            }
            slots[slotIndex] = { value: { uuid } };
        });
    }

    async clearMaterial(args) {
        const slotIndex = Number(args.slot || 0);
        return await this.setRendererSlots(args, (slots) => {
            while (slots.length <= slotIndex) {
                slots.push({ value: { uuid: '' } });
            }
            slots[slotIndex] = { value: { uuid: '' } };
        });
    }

    async replaceMaterial(args) {
        const oldUrl = toDbUrl(args.oldMaterialUrl || args.url, args.folder, '.mtl');
        const newUrl = toDbUrl(args.newMaterialUrl || args.materialUrl, args.folder, '.mtl');
        if (!oldUrl || !newUrl) {
            return fail('oldMaterialUrl 和 newMaterialUrl 是必填参数。');
        }
        const oldUuid = await this.queryAssetUuid(oldUrl);
        const newUuid = await this.queryAssetUuid(newUrl);
        if (!oldUuid || !newUuid) {
            return fail('无法解析旧材质或新材质 UUID。', { oldUrl, oldUuid, newUrl, newUuid });
        }
        const rootResult = args.rootNode
            ? await this.node.execute({ action: 'tree', node: args.rootNode, maxDepth: 30 })
            : await this.node.execute({ action: 'list' });
        if (!rootResult || !rootResult.success) {
            return rootResult;
        }
        const nodes = resolveNodeList(rootResult).slice(0, Number(args.maxNodes) || 200);
        const changed = [];
        const errors = [];
        for (const node of nodes) {
            const nodeId = node.uuid || node.path || node.name;
            if (!nodeId) {
                continue;
            }
            const info = await this.inspectRenderer({ node: nodeId, componentType: args.componentType });
            if (!info.success) {
                continue;
            }
            for (const renderer of info.data.renderers || []) {
                const indexes = (renderer.slots || []).filter((slot) => slot.uuid === oldUuid).map((slot) => slot.slot);
                if (indexes.length === 0) {
                    continue;
                }
                changed.push({ node: node.path || node.name || nodeId, uuid: node.uuid, componentType: renderer.type, slots: indexes });
                if (!args.dryRun) {
                    const result = await this.setRendererSlots({ node: nodeId, componentType: renderer.type }, (slots) => {
                        for (const index of indexes) {
                            slots[index] = { value: { uuid: newUuid } };
                        }
                    });
                    if (!result.success) {
                        errors.push({ node: nodeId, error: result.error, data: result.data });
                    }
                }
            }
        }
        return ok({
            dryRun: !!args.dryRun,
            oldMaterial: { url: oldUrl, uuid: oldUuid },
            newMaterial: { url: newUrl, uuid: newUuid },
            changedCount: changed.length,
            changed,
            errors
        }, args.dryRun ? '材质替换预演完成。' : '材质替换执行完成。');
    }

    async findUsages(args) {
        const dbUrl = await this.resolveMaterialUrl(args);
        const uuid = args.uuid || (dbUrl ? await this.queryAssetUuid(dbUrl) : null);
        if (!dbUrl && !uuid) {
            return fail('url/materialUrl/uuid 至少需要提供一个。');
        }
        const folderUrl = toDbUrl(args.folder || 'db://assets');
        const folderPath = dbUrlToFilePath(folderUrl);
        if (!folderPath || !fs.existsSync(folderPath)) {
            return fail(`扫描目录不存在：${folderUrl}`);
        }
        const needles = [uuid, dbUrl].filter(Boolean);
        const files = walkFiles(folderPath, (file) => SCENE_FILE_RE.test(file) || MATERIAL_EXT_RE.test(file), args.maxFiles);
        const usages = [];
        for (const file of files) {
            const text = readTextIfExists(file) || '';
            const hits = needles.filter((needle) => text.includes(needle));
            if (hits.length > 0) {
                usages.push({
                    url: filePathToDbUrl(file),
                    type: path.extname(file).slice(1),
                    hits
                });
            }
        }
        return ok({
            material: { url: dbUrl, uuid },
            count: usages.length,
            usages
        }, `已找到 ${usages.length} 个资源引用。`);
    }

    async validateMaterials(args) {
        const folderUrl = toDbUrl(args.folder || 'db://assets');
        const folderPath = dbUrlToFilePath(folderUrl);
        if (!folderPath || !fs.existsSync(folderPath)) {
            return fail(`扫描目录不存在：${folderUrl}`);
        }
        const materialFiles = walkFiles(folderPath, (file) => MATERIAL_EXT_RE.test(file), args.maxFiles);
        const sceneFiles = walkFiles(folderPath, (file) => SCENE_FILE_RE.test(file), args.maxFiles);
        const issues = [];
        for (const file of materialFiles) {
            const url = filePathToDbUrl(file);
            const json = readJsonIfExists(file);
            if (!json) {
                issues.push({ level: 'error', code: 'material_json_invalid', url, message: '材质文件不是有效 JSON。' });
                continue;
            }
            const info = extractMaterialInfo(json, url, await this.queryAssetUuid(url));
            if (!info.effect || (typeof info.effect === 'object' && Object.keys(info.effect).length === 0)) {
                issues.push({ level: 'warn', code: 'effect_missing', url, message: '材质没有读取到 effect 引用。' });
            }
        }
        for (const file of sceneFiles) {
            const url = filePathToDbUrl(file);
            const json = readJsonIfExists(file);
            const objects = extractMaterialObjects(json);
            for (const object of objects) {
                const type = String(object.__type__ || object.type || '');
                if (!RENDERER_RE.test(type)) {
                    continue;
                }
                const mats = object._materials || object.sharedMaterials || object.materials || [];
                if (!Array.isArray(mats) || mats.length === 0) {
                    issues.push({ level: 'info', code: 'renderer_no_material', url, rendererType: type, message: '渲染组件没有显式材质槽。' });
                    continue;
                }
                mats.forEach((slot, index) => {
                    const uuid = materialUuidFromSlot(slot);
                    if (!uuid) {
                        issues.push({ level: 'warn', code: 'material_slot_empty', url, rendererType: type, slot: index, message: '材质槽为空。' });
                    }
                });
            }
        }
        return ok({
            folder: folderUrl,
            materialFileCount: materialFiles.length,
            sceneFileCount: sceneFiles.length,
            issueCount: issues.length,
            issues
        }, `材质检查完成，发现 ${issues.length} 个提示。`);
    }
}

exports.MaterialHandler = MaterialHandler;
