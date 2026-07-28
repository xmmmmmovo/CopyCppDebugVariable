import type * as vscode from 'vscode';
import { DapVariable, DapVariableNode, ReaderContext, ReaderLimits, readVariableTree, request } from './variableReader';

export const DEFAULT_LIMITS: ReaderLimits = { maxDepth: 32, maxVariables: 10000, maxArrayItems: 1000, pageSize: 100 };

export const SCHEMA_VERSION = 1;

export interface EvaluateResponse { result?: string; type?: string; evaluateName?: string; variablesReference?: number; memoryReference?: string; }

export interface ResultDocument {
    schemaVersion: number;
    source: 'watch';
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

export function buildResultDocument(args: { expression: string; sessionType: string; data: DapVariableNode; count: number; now: Date }): ResultDocument {
    const errors = args.data.errors ?? [];
    const truncated = args.data.truncated === true;
    return {
        schemaVersion: SCHEMA_VERSION,
        source: 'watch',
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

async function runRead(args: { session: vscode.DebugSession; expression: string; limits: ReaderLimits; token?: vscode.CancellationToken }): Promise<{ data: DapVariableNode; count: number }> {
    const result = await request<EvaluateResponse>(args.session, 'evaluate', { expression: args.expression, context: 'watch' });
    const variable = evaluateToVariable(args.expression, result);
    const context: ReaderContext = { session: args.session, limits: args.limits, token: args.token, count: 0, references: new Set() };
    const data = await readVariableTree(variable, context);
    return { data, count: context.count + 1 };
}

export async function copyVariableAsJson(deps: DebugCopyDeps): Promise<void> {
    const session = deps.getSession();
    if (!session) { deps.showWarning('请先启动 C/C++ 调试会话。'); return; }
    const expression = await deps.showInputBox();
    if (!expression) {return;}
    try {
        const result = await runRead({ session, expression, limits: deps.readLimits() });
        const document = buildResultDocument({ expression, sessionType: session.type, data: result.data, count: result.count, now: deps.now() });
        await deps.writeClipboard(JSON.stringify(document, null, 2));
        deps.showInfo(`已复制变量 ${expression}（${result.count} 个节点）`);
    } catch (error) {
        if (isCancellation(error)) {return;}
        const message = error instanceof Error ? error.message : String(error);
        deps.showError(`读取调试变量失败：${message}`);
    }
}

export async function saveVariableAsJson(deps: DebugCopyDeps): Promise<void> {
    const session = deps.getSession();
    if (!session) { deps.showWarning('请先启动 C/C++ 调试会话。'); return; }
    const expression = await deps.showInputBox();
    if (!expression) {return;}
    try {
        const result = await runRead({ session, expression, limits: deps.readLimits() });
        const document = buildResultDocument({ expression, sessionType: session.type, data: result.data, count: result.count, now: deps.now() });
        const text = JSON.stringify(document, null, 2);
        const path = await deps.showSaveDialog(buildDefaultFileName(expression));
        if (!path) {return;}
        await deps.writeFile(path, Buffer.from(text, 'utf8'));
        deps.showInfo(`已保存到 ${path}`);
    } catch (error) {
        if (isCancellation(error)) {return;}
        const message = error instanceof Error ? error.message : String(error);
        deps.showError(`保存调试变量失败：${message}`);
    }
}
