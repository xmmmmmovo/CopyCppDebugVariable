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

/**
 * 识别 DAP 返回的 `type` 字段是否属于“字符串类”类型。
 *
 * cppdbg 等适配器会把 `std::string`、`const char *`、`char[16]` 等的内部 buffer/union 当作
 * 子节点暴露给 `variables`，对它们展开会产生上百个无意义的字符子节点。把它们当成叶子即可，
 * 因为适配器已经给出了可读的展示值（例如 `"hello"` 或 `0x55... "hello"`）。
 *
 * `std::vector<char>` 等真正是容器的类型不在此列，仍按容器展开。
 */
export function isStringLikeType(type: string | undefined): boolean {
    if (!type) { return false; }
    const t = type.replace(/\s+/g, ' ').trim();
    // std::basic_string / std::basic_string_view，可选套在 ABI 命名空间内
    // （libstdc++ 的 __cxx11、libc++ 的 __1/__y/__z/__abi）。正则只关心
    // `basic_string<` 前缀，第三个模板参数（allocator）任意值都被覆盖。
    if (/^std::((__cxx11|__1|__y|__z|__abi)::)?basic_string(_view)?\s*</.test(t)) { return true; }
    // std::pmr::* 别名
    if (/^std::pmr::(string|wstring|u8string|u16string|u32string|string_view)$/.test(t)) { return true; }
    // std::* 直接别名（无模板实参）
    if (/^std::(string|wstring|u8string|u16string|u32string|string_view)$/.test(t)) { return true; }
    // char / const char 指针与定长数组（含可选 `signed` / `unsigned` 前缀）
    if (/^((const|signed|unsigned)\s+)?char\s*(\*|\[\s*\d*\s*\])$/.test(t)) { return true; }
    // wchar_t / char8_t / char16_t / char32_t 的指针与定长数组
    if (/^((const|signed|unsigned)\s+)?(wchar_t|char8_t|char16_t|char32_t)\s*(\*|\[\s*\d*\s*\])$/.test(t)) { return true; }
    return false;
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
    // 字符串类类型：适配器已经给出可读值，避免把内部 buffer 当作字符数组展开
    if (isStringLikeType(variable.type)) {
        return node;
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
