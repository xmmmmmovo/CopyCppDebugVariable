import type * as vscode from 'vscode';
import { DapVariable, DapVariableNode, ReaderContext, ReaderLimits, isDapVariable, readVariableTree, request } from './variableReader';

export const DEFAULT_LIMITS: ReaderLimits = { maxDepth: 8, maxVariables: 10000, maxArrayItems: 1000, pageSize: 100 };

export const SCHEMA_VERSION = 1;

export interface EvaluateResponse { result?: string; type?: string; evaluateName?: string; variablesReference?: number; memoryReference?: string; }

export type ResultSource = 'watch' | 'variables';

/**
 * VS Code 传给 `debug/variables/context` 和 `debug/watch/context` 菜单命令的参数。
 * 字段与 VS Code 内部 `IVariablesContext` 一致，全部按可选字段做运行时校验。
 */
export interface VariableMenuContext {
    sessionId?: string;
    container?: { name?: string; expression?: string; variablesReference?: number };
    variable: DapVariable;
}

export interface ResultDocument {
    schemaVersion: number;
    source: ResultSource;
    expression: string;
    sessionType: string;
    capturedAt: string;
    data: DapVariableNode;
    warnings: string[];
    truncated: boolean;
    nodeCount: number;
}

export interface DebugCopyDeps {
    getSession(): vscode.DebugSession | undefined;
    getSessionById(id: string): vscode.DebugSession | undefined;
    showInputBox(): Promise<string | undefined>;
    showSaveDialog(defaultFileName: string): Promise<string | undefined>;
    writeClipboard(text: string): Promise<void>;
    writeFile(path: string, content: Uint8Array): Promise<void>;
    showInfo(message: string): void;
    showWarning(message: string): void;
    showError(message: string): void;
    readLimits(): ReaderLimits;
    now(): Date;
}

export function readLimitsFromConfig(get: <T>(key: string, defaultValue: T) => T): ReaderLimits {
    return {
        maxDepth: get('maxDepth', DEFAULT_LIMITS.maxDepth),
        maxVariables: get('maxVariables', DEFAULT_LIMITS.maxVariables),
        maxArrayItems: get('maxArrayItems', DEFAULT_LIMITS.maxArrayItems),
        pageSize: get('variablePagingSize', DEFAULT_LIMITS.pageSize),
    };
}

export function buildResultDocument(args: { expression: string; sessionType: string; data: DapVariableNode; count: number; now: Date; source?: ResultSource }): ResultDocument {
    const errors = args.data.errors ?? [];
    const truncated = args.data.truncated === true;
    return {
        schemaVersion: SCHEMA_VERSION,
        source: args.source ?? 'watch',
        expression: args.expression,
        sessionType: args.sessionType,
        capturedAt: args.now.toISOString(),
        data: args.data,
        warnings: errors,
        truncated,
        nodeCount: args.count,
    };
}

export function buildDefaultFileName(expression: string): string {
    const safe = expression.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'debug-variable';
    return `${safe}.json`;
}

export function evaluateToVariable(expression: string, response: EvaluateResponse): DapVariable {
    return {
        name: expression,
        value: response.result,
        type: response.type,
        evaluateName: response.evaluateName ?? expression,
        variablesReference: response.variablesReference,
        memoryReference: response.memoryReference,
    };
}

function isCancellation(error: unknown): boolean {
    if (error && typeof error === 'object' && (error as { name?: string }).name === 'CancellationError') {
        return true;
    }
    return false;
}

/** 判断命令参数是否来自 Debug Variables/Watch 右键菜单。 */
export function isVariableMenuContext(value: unknown): value is VariableMenuContext {
    if (typeof value !== 'object' || value === null) { return false; }
    return isDapVariable((value as { variable?: unknown }).variable);
}

/** 把菜单参数里的 DAP 变量规范化为读取器输入，丢弃未知字段。 */
export function menuContextToVariable(context: VariableMenuContext): DapVariable {
    const variable = context.variable;
    return {
        name: variable.name,
        value: variable.value,
        type: variable.type,
        evaluateName: variable.evaluateName,
        variablesReference: variable.variablesReference,
        memoryReference: variable.memoryReference,
        indexedItems: variable.indexedItems,
        namedVariables: variable.namedVariables,
    };
}

interface ReadTarget {
    session: vscode.DebugSession;
    expression: string;
    source: ResultSource;
    /** 菜单路径下已经拿到变量句柄，无需再 evaluate。 */
    variable?: DapVariable;
}

/**
 * 解析命令入口：来自右键菜单时直接使用变量句柄，否则回退到输入表达式。
 * 返回 undefined 表示流程已终止（已提示或用户取消）。
 */
async function resolveTarget(deps: DebugCopyDeps, arg?: unknown): Promise<ReadTarget | undefined> {
    if (isVariableMenuContext(arg)) {
        const session = (arg.sessionId ? deps.getSessionById(arg.sessionId) : undefined) ?? deps.getSession();
        if (!session) { deps.showWarning('请先启动 C/C++ 调试会话。'); return undefined; }
        const variable = menuContextToVariable(arg);
        return { session, expression: variable.evaluateName || variable.name, source: 'variables', variable };
    }
    const session = deps.getSession();
    if (!session) { deps.showWarning('请先启动 C/C++ 调试会话。'); return undefined; }
    const expression = await deps.showInputBox();
    if (!expression) { return undefined; }
    return { session, expression, source: 'watch' };
}

async function runRead(args: { target: ReadTarget; limits: ReaderLimits; token?: vscode.CancellationToken }): Promise<{ data: DapVariableNode; count: number }> {
    const { target } = args;
    let variable = target.variable;
    if (!variable) {
        const result = await request<EvaluateResponse>(target.session, 'evaluate', { expression: target.expression, context: 'watch' });
        variable = evaluateToVariable(target.expression, result);
    }
    const context: ReaderContext = { session: target.session, limits: args.limits, token: args.token, count: 0, references: new Set() };
    const data = await readVariableTree(variable, context);
    return { data, count: context.count + 1 };
}

async function readDocument(deps: DebugCopyDeps, target: ReadTarget): Promise<ResultDocument> {
    const result = await runRead({ target, limits: deps.readLimits() });
    return buildResultDocument({
        expression: target.expression,
        source: target.source,
        sessionType: target.session.type,
        data: result.data,
        count: result.count,
        now: deps.now(),
    });
}

export async function copyVariableAsJson(deps: DebugCopyDeps, arg?: unknown): Promise<void> {
    const target = await resolveTarget(deps, arg);
    if (!target) { return; }
    try {
        const document = await readDocument(deps, target);
        await deps.writeClipboard(JSON.stringify(document, null, 2));
        deps.showInfo(`已复制变量 ${target.expression}（${document.nodeCount} 个节点）`);
    } catch (error) {
        if (isCancellation(error)) { return; }
        const message = error instanceof Error ? error.message : String(error);
        deps.showError(`读取调试变量失败：${message}`);
    }
}

export async function saveVariableAsJson(deps: DebugCopyDeps, arg?: unknown): Promise<void> {
    const target = await resolveTarget(deps, arg);
    if (!target) { return; }
    try {
        const document = await readDocument(deps, target);
        const text = JSON.stringify(document, null, 2);
        const path = await deps.showSaveDialog(buildDefaultFileName(target.expression));
        if (!path) { return; }
        await deps.writeFile(path, Buffer.from(text, 'utf8'));
        deps.showInfo(`已保存到 ${path}`);
    } catch (error) {
        if (isCancellation(error)) { return; }
        const message = error instanceof Error ? error.message : String(error);
        deps.showError(`保存调试变量失败：${message}`);
    }
}
