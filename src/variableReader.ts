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
    // std::byte 指针与定长数组（含可选 `const` 前缀）——典型场景是 PMR 的
    // `std::byte[N]` 背书缓冲，cppvsdbg 会把它当 2048 个 std::byte 子节点展开。
    if (/^(const\s+)?std::byte\s*(\*|\[\s*\d*\s*\])$/.test(t)) { return true; }
    return false;
}

/** 单个字符元素的编码类型：`utf8` / `utf16` / `utf32` / `unknown`。 */
export type CharKind = 'utf8' | 'utf16' | 'utf32' | 'unknown';

/**
 * 识别 DAP 字符子节点的 `type` 字段属于哪种编码。
 *
 * `wchar_t` 在 Windows 上是 16 位（`winapi` / `L""`），在 Linux/macOS 上是 32 位，
 * 这里直接用宿主 `process.platform` 决定，没有引入新的配置开关。
 */
export function getCharKind(type: string | undefined): CharKind {
    if (!type) { return 'unknown'; }
    const t = type.replace(/\s+/g, ' ').trim();
    if (/^(const\s+)?(char8_t|unsigned\s+char|signed\s+char|char|std::byte)$/.test(t)) { return 'utf8'; }
    if (/^(const\s+)?char16_t$/.test(t)) { return 'utf16'; }
    if (/^(const\s+)?char32_t$/.test(t)) { return 'utf32'; }
    if (/^(const\s+)?wchar_t$/.test(t)) {
        return process.platform === 'win32' ? 'utf16' : 'utf32';
    }
    return 'unknown';
}

/**
 * 识别 DAP 子节点字段名是否是 MSVC STL 中"结束"位置的迭代器。
 *
 * `std::vector` 在 `_Vector_val` 里有 `_Myfirst` / `_Mylast` / `_Myend` 三个裸指针。
 * 其中 `_Mylast` 是 one-past-end、`_Myend` 是 capacity 末尾，对它们解引用是 UB。
 * 但 cppvsdbg 仍会照常 deref 并把指针所指内存当作子节点展示——典型表现是
 * `_Mylast->xxx` 全是 `<NULL>` / `0` / `<Error reading characters of string.>` 等噪声，
 * 并且其内部的容器字段（如 `tags.capacity()`）也会读到 461165814791740701 这类垃圾值。
 *
 * 跳过它们的子节点展开，但仍保留指针 hex 值与 type/evaluateName，方便定位。
 */
function isOnePastEndIterator(name: string): boolean {
    return name === '_Mylast' || name === '_Myend';
}

/** 根据字符串父类型推断其子节点期望的字符编码。无法判定时返回 `unknown`。 */
function inferStringKindFromType(type: string | undefined): CharKind {
    if (!type) { return 'unknown'; }
    const t = type.replace(/\s+/g, ' ').trim();
    // std::* / std::pmr::* 别名（无模板实参）：后缀直接决定编码。
    let m = /^std::(?:pmr::)?((?:u(?:8|16|32))?string|wstring|string_view)$/.exec(t);
    if (m) {
        const s = m[1];
        if (s === 'string' || s === 'u8string') { return 'utf8'; }
        if (s === 'u16string') { return 'utf16'; }
        if (s === 'u32string') { return 'utf32'; }
        if (s === 'wstring' || s === 'string_view') {
            return process.platform === 'win32' ? 'utf16' : 'utf32';
        }
    }
    // basic_string / basic_string_view（可带 ABI 命名空间）：看第一个模板参数。
    m = /^std::((__cxx11|__1|__y|__z|__abi)::)?basic_string(_view)?\s*<\s*([^,>]+)/.exec(t);
    if (m) { return getCharKind(m[4]); }
    // 裸指针 / 数组：元素类型直接决定。
    m = /^((const\s+)?(?:signed\s+|unsigned\s+)?)(char8_t|char16_t|char32_t|wchar_t|char|std::byte)\s*(\*|\[\s*\d*\s*\])$/.exec(t);
    if (m) { return getCharKind(m[3]); }
    return 'unknown';
}

/**
 * 解析 cppvsdbg 给 `std::byte[N]` / `std::byte *` 的“字节 dump”展示值。
 *
 * 形如 `0x00000001000fed10 {168 '�', 232 '�', 15 '\xf', 0 '\0', 1 '\x1', 0 '\0', ..., ...}`，
 * 最外层是可选的十六进制地址 + `{<byte>, <byte>, ...}`，其中：
 *   - `<byte>` 由 `parseCharUnits` 解析（`168 '�'`、`0x61 'a'`、`'\xNN'` 等）
 *   - 末尾的 `...` 表示截断，跳过即可
 *   - 整个 `{...}` 为空时返回空数组
 *
 * 不可识别的输入返回 `undefined`，调用方按既有路径处理（drop value）。
 */
export function parseCppvsdbgByteDump(value: string): readonly number[] | undefined {
    const m = /^(?:0x[0-9a-fA-F]+\s+)?\{(.*)\}\s*$/.exec(value);
    if (!m) { return undefined; }
    const body = m[1];
    if (body.trim() === '') { return []; }
    // cppvsdbg 不会在单引号字面量里塞 `,`，所以朴素 split 即可。
    const entries = body.split(',').map(s => s.trim()).filter(s => s.length > 0);
    const bytes: number[] = [];
    for (const entry of entries) {
        if (entry === '...') { continue; }
        const units = parseCharUnits(entry);
        if (!units) { return undefined; }
        for (const u of units) {
            if (u > 0xff) { return undefined; }
            bytes.push(u);
        }
    }
    return bytes;
}

/**
 * 把 DAP 适配器给的一个 char 子节点 `value` 字符串解析为数字码点。
 *
 * 真实会话里观察到的形式（按优先级）：
 *   1) `228 '\xe4'`        — 十进制 + 渲染字符（cppdbg、cppvsdbg）
 *   2) `0x61 'a'`          — 十六进制 + 渲染字符
 *   3) `'\xE4\xB8\xAD'`    — 一个子节点里塞多个 UTF-8 字节的 hex 转义
 *   4) `u'a'` / `L'a'` / `U'a'` — 带前缀的 Unicode 字面量
 *   5) `'X'`               — 纯单字符字面量
 *
 * 不可识别的输入返回 `undefined`，调用方应保留适配器展示值。
 */
export function parseCharUnits(value: string | undefined): readonly number[] | undefined {
    if (!value) { return undefined; }
    const v = value.trim();
    if (!v) { return undefined; }

    // 1) <decimal> '<glyph>'
    let m = /^(\d+)\s*'(?:\\.|[^'\\])*'$/.exec(v);
    if (m) { return [parseInt(m[1], 10)]; }

    // 2) 0x<hex> '<glyph>'
    m = /^0x([0-9a-fA-F]+)\s*'(?:\\.|[^'\\])*'$/.exec(v);
    if (m) { return [parseInt(m[1], 16)]; }

    // 3) '\x..\x..\x..' / '\uNNNN'  — 多个 UTF-8 字节或单个码点打包在一个子节点里
    m = /^'((?:\\x[0-9a-fA-F]{2})+|\\u[0-9a-fA-F]{4})'$/.exec(v);
    if (m) {
        const xMatches = m[1].match(/\\x([0-9a-fA-F]{2})/g);
        if (xMatches) { return xMatches.map(h => parseInt(h.slice(2), 16)); }
        const uMatch = m[1].match(/\\u([0-9a-fA-F]{4})/);
        if (uMatch) { return [parseInt(uMatch[1], 16)]; }
    }

    // 4) [uLU]'X' / [uLU]'\xNN' / [uLU]'\uNNNN'
    m = /^[uLU]'(?:\\x([0-9a-fA-F]{1,2})|\\u([0-9a-fA-F]{1,4})|([^'\\]))'$/.exec(v);
    if (m) {
        if (m[1]) { return [parseInt(m[1], 16)]; }
        if (m[2]) { return [parseInt(m[2], 16)]; }
        if (m[3]) { return [m[3].charCodeAt(0)]; }
    }

    // 5) 'X'  — 单字符字面量
    m = /^'([^'\\])'$/.exec(v);
    if (m) { return [m[1].charCodeAt(0)]; }

    return undefined;
}

/**
 * 如果 `variable` 是字符串类容器，则读取其 char 子节点并重建完整字符串。
 *
 * - 返回 `''`：空容器（`indexedItems === 0`），不发送 `variables` 请求。
 * - 返回完整文本：能从 char 子节点拼出至少一个字符。
 * - 返回 `undefined`：没有可识别的 char 子节点 / 任一子节点解析失败 /
 *   `variables` 请求失败。调用方应保留适配器展示值。
 *
 * `ReaderCancellationError` 始终向上抛。
 */
export async function readStringValue(variable: DapVariable, context: ReaderContext): Promise<string | undefined> {
    const kind = inferStringKindFromType(variable.type);
    if (kind === 'unknown') { return undefined; }
    if (!variable.variablesReference) { return undefined; }

    // 空容器：直接是 ""，连请求都不发。
    if (variable.indexedItems === 0) { return ''; }
    if (context.token?.isCancellationRequested) { throw new ReaderCancellationError(); }

    // 用与 readVariableTree 相同的分页参数收集子节点，避免破坏 maxVariables 限制。
    const total = Math.min(variable.indexedItems ?? context.limits.maxArrayItems, context.limits.maxArrayItems);
    const collected = new Map<number, DapVariable>();
    let truncated = false;

    for (let start = 0; start < total; start += context.limits.pageSize) {
        if (context.token?.isCancellationRequested) { throw new ReaderCancellationError(); }
        if (context.count >= context.limits.maxVariables) { truncated = true; break; }
        const count = Math.min(context.limits.pageSize, total - start);
        const response = await request<{ variables?: DapVariable[] }>(context.session, 'variables', {
            variablesReference: variable.variablesReference,
            start,
            count,
        });
        const vars = (response.variables ?? []).filter(isDapVariable);
        if (vars.length === 0) { break; }
        for (const child of vars) {
            if (context.count >= context.limits.maxVariables) { truncated = true; break; }
            context.count++;
            // 只保留命名像索引、且字符类型匹配预期的子节点。
            const idx = /^[\[(]?(\d+)[\])]?$/.exec(child.name);
            if (!idx) { continue; }
            if (getCharKind(child.type) !== kind) { continue; }
            const n = parseInt(idx[1], 10);
            // 同一索引出现多次（如命名 + 索引）时，保留第一个，避免误覆盖。
            if (!collected.has(n)) { collected.set(n, child); }
        }
        if (vars.length < count || truncated) { break; }
    }

    if (collected.size === 0) { return undefined; }
    if (truncated) { return undefined; }

    // 按索引从 0 开始依次解析；任何缺失或解析失败都放弃重建。
    const size = variable.indexedItems ?? collected.size;
    const builder: number[] = [];
    for (let i = 0; i < size; i++) {
        const child = collected.get(i);
        if (!child) { return undefined; }
        const units = parseCharUnits(child.value);
        if (!units) { return undefined; }
        for (const u of units) {
            if (kind === 'utf8' && u > 0xff) { return undefined; }
            builder.push(u);
        }
    }

    return encodeCharUnits(builder, kind);
}

function encodeCharUnits(units: readonly number[], kind: CharKind): string {
    if (kind === 'utf8') {
        const bytes = new Uint8Array(units.length);
        for (let i = 0; i < units.length; i++) { bytes[i] = units[i]; }
        return new TextDecoder('utf-8').decode(bytes);
    }
    // utf16 / utf32 都用 String.fromCharCode：码点 > 0xFFFF 时它会自动产生
    // surrogate pair，所以两种宽度可以共用一份编码逻辑。0x8000 是经验阈值，
    // 避免 .apply 参数过多触发栈溢出。
    let out = '';
    for (let i = 0; i < units.length; i += 0x8000) {
        const chunk = Array.from(units.slice(i, i + 0x8000));
        out += String.fromCharCode.apply(null, chunk as number[]);
    }
    return out;
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
    // 字符串类类型：叶子节点只有 `value`，`value` 必须是 string 本身。
    // 优先级：
    //   1) 空容器（indexedItems === 0） → value = ""，不发 variables 请求
    //   2) 从 char / byte 子节点重建完整文本
    //   3) 重建失败时回退：cppvsdbg 对 std::byte[N] / std::byte * 的“字节 dump”
    //      （形如 `0x... {168 '�', 232 '�', ..., ...}`）放在 value 字段里，
    //      解析出字节并按 UTF-8 解码
    //   4) 上面都拿不到时丢弃 adapter 展示值（cppvsdbg 对 std::string 的
    //      truncated preview 不再保留）
    if (isStringLikeType(variable.type)) {
        if (variable.indexedItems === 0) {
            node.value = '';
            return node;
        }
        if (variable.variablesReference) {
            try {
                const reconstructed = await readStringValue(variable, context);
                if (reconstructed !== undefined) {
                    node.value = reconstructed;
                    return node;
                }
            } catch (error) {
                if (error instanceof ReaderCancellationError) { throw error; }
                // 非取消异常继续尝试字节 dump 回退
            }
        }
        if (variable.value) {
            const bytes = parseCppvsdbgByteDump(variable.value);
            if (bytes !== undefined) {
                node.value = new TextDecoder('utf-8').decode(new Uint8Array(bytes));
                return node;
            }
        }
        delete node.value;
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
                if (isOnePastEndIterator(child.name)) {
                    // MSVC STL 的 one-past-end / capacity-end 指针，不解引用以免
                    // 触发 cppvsdbg 把 UB 内存当成子节点展开。
                    children[child.name] = {
                        name: child.name,
                        value: child.value,
                        type: child.type,
                        evaluateName: child.evaluateName,
                        memoryReference: child.memoryReference,
                    };
                    continue;
                }
                const key = Object.prototype.hasOwnProperty.call(children, child.name) ? `${child.name}[${start}]` : child.name;
                children[key] = await readVariableTree(child, context, depth + 1);
            }
            if (vars.length < context.limits.pageSize || node.truncated) { break; }
        }
        if (Object.keys(children).length > 0) {
            // 父 node 已展开成子节点，适配器给的 `value` 摘要就冗余了，丢掉以免
            // 误读。这里只对非 string-like 的容器生效——string-like 分支在更早的
            // `isStringLikeType` 拦截里已经直接 return，value 是重建后的字符串。
            node.children = children;
            delete node.value;
        }
    } catch (error) {
        node.errors = [error instanceof Error ? error.message : String(error)];
    } finally {
        context.references.delete(variable.variablesReference);
    }
    return node;
}
