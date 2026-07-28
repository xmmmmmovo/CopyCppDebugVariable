import type * as vscode from 'vscode';

export class ReaderCancellationError extends Error {
    override name = 'ReaderCancellationError';
    constructor() { super('cancelled'); }
}

export interface DapVariable {
    name: string;
    value?: string;
    type?: string;
    evaluateName?: string;
    variablesReference?: number;
    memoryReference?: string;
    indexedItems?: number;
    namedVariables?: number;
}

export interface DapVariableNode {
    name: string;
    value?: string;
    type?: string;
    evaluateName?: string;
    memoryReference?: string;
    children?: Record<string, DapVariableNode>;
    errors?: string[];
    truncated?: boolean;
    cycle?: boolean;
}

export interface ReaderLimits {
    maxDepth: number;
    maxVariables: number;
    maxArrayItems: number;
    pageSize: number;
}

export interface ReaderContext {
    session: vscode.DebugSession;
    limits: ReaderLimits;
    token?: vscode.CancellationToken;
    count: number;
    references: Set<number>;
}

export function isDapVariable(value: unknown): value is DapVariable {
    return typeof value === 'object' && value !== null && typeof (value as { name?: unknown }).name === 'string';
}

export async function request<T>(session: vscode.DebugSession, command: string, args?: unknown): Promise<T> {
    return session.customRequest(command, args) as Promise<T>;
}

export async function readVariableTree(variable: DapVariable, context: ReaderContext, depth = 0): Promise<DapVariableNode> {
    const node: DapVariableNode = {
        name: variable.name,
        value: variable.value,
        type: variable.type,
        evaluateName: variable.evaluateName,
        memoryReference: variable.memoryReference,
    };

    if (context.token?.isCancellationRequested) {
        throw new ReaderCancellationError();
    }
    if (!variable.variablesReference) {
        return node;
    }
    if (depth >= context.limits.maxDepth || context.count >= context.limits.maxVariables) {
        node.truncated = true;
        return node;
    }
    if (context.references.has(variable.variablesReference)) {
        node.cycle = true;
        return node;
    }

    context.references.add(variable.variablesReference);
    try {
        const children: Record<string, DapVariableNode> = {};
        const total = Math.min(variable.indexedItems ?? context.limits.maxArrayItems, context.limits.maxArrayItems);
        for (let start = 0; start < total; start += context.limits.pageSize) {
            const response: { variables?: DapVariable[] } = await request<{ variables?: DapVariable[] }>(context.session, 'variables', {
                variablesReference: variable.variablesReference,
                start,
                count: Math.min(context.limits.pageSize, total - start),
            });
            const vars: DapVariable[] = (response.variables ?? []).filter(isDapVariable);
            if (vars.length === 0) { break; }
            for (const child of vars) {
                if (context.count >= context.limits.maxVariables) {
                    node.truncated = true;
                    break;
                }
                context.count++;
                const key = Object.prototype.hasOwnProperty.call(children, child.name) ? `${child.name}[${start}]` : child.name;
                children[key] = await readVariableTree(child, context, depth + 1);
            }
            if (vars.length < context.limits.pageSize || node.truncated) { break; }
        }
        if (Object.keys(children).length > 0) { node.children = children; }
    } catch (error) {
        node.errors = [error instanceof Error ? error.message : String(error)];
    } finally {
        context.references.delete(variable.variablesReference);
    }
    return node;
}
