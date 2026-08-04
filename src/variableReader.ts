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
    /**
     * Indexed child count. DAP spec uses `indexedVariables`; cppvsdbg (and this
     * extension's historical code) uses `indexedItems`. Both are accepted—
     * populate the one your adapter emits.
     */
    indexedVariables?: number;
    indexedItems?: number;
    namedVariables?: number;
}

/** Resolve indexed child count from either DAP-spec (`indexedVariables`) or alias (`indexedItems`). */
function getIndexedCount(variable: { indexedVariables?: number; indexedItems?: number }): number | undefined {
    return variable.indexedVariables ?? variable.indexedItems;
}

/**
 * per-index evaluate 连续 miss 多少次才判定 cppvsdbg 不再应答。
 *
 * cppvsdbg 对 `std::byte[N]` 的单条索引偶发返回空 result（典型是 0x00 字节），
 * 单个 miss 就 break 会把数组截在 preview 那 ~10 条；需要连续足够多次 miss 才
 * 能确信真的到上限了，同时避免全失败时白白打满 2048 个 round trip。
 */
const MAX_CONSECUTIVE_MISSES = 8;

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
    /**
     * `std::byte[N]` / `std::byte *` 字节 buffer 是否合并进 `value` 字符串
     * （string-like 叶子）。开：字节能按 UTF-8 解码成文本就合并成 value，
     * 二进制（解码含 U+FFFD 替换符）退回物化 children；关：一律物化全部
     * 字节 children。
     */
    mergeByteBufferIntoValue: boolean;
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

/**
 * 判断 string-like 类型是否是真正的二进制缓冲区（`std::byte[N]` / `std::byte *`），
 * 而不是文本字符串（`std::string` / `char *` / `char[]` 等）。
 *
 * cppvsdbg 对 `std::byte[N]` 的处理跟 `std::string` 完全不同：
 * - `std::string` 给一个 truncated preview（例如 `"Lorem ipsum..."`），按 UTF-8 解码后保留为 value 是误导
 * - `std::byte[N]` 给的是字节 dump 预览 + 完整的 byte 子节点，要拿到 N 个字节就不能被
 *   `maxArrayItems` 卡住（默认 1000，对 byte[2048] 这种典型 PMR 背书缓冲就是直接少 1048 个字节）
 *
 * 调用方根据这个差异决定是否绕过 `maxArrayItems` cap。
 */
export function isByteBufferType(type: string | undefined): boolean {
    if (!type) { return false; }
    const t = type.replace(/\s+/g, ' ').trim();
    return /^(const\s+)?std::byte\s*(\[\s*\d*\s*\]|\*)$/.test(t);
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
 * 解析 cppvsdbg 给 `std::byte[N]` / `std::byte *` 的”字节 dump”展示值。
 *
 * 形如 `0x00000001000fed10 {168 '�', 232 '�', 15 '\xf', 0 '\0', 1 '\x1', 0 '\0', ..., ...}`，
 * 最外层是可选的十六进制地址 + `{<byte>, <byte>, ...}`，其中：
 *   - `<byte>` 由 `parseCharUnits` 解析（`168 '�'`、`0x61 'a'`、`'\xNN'` 等）
 *   - 末尾的 `...` 表示截断，跳过即可
 *   - 整个 `{...}` 为空时返回空数组
 *
 * 关键实现：用 `parseCharUnits` 的 per-entry 正则 matchAll 整个 body，
 * **不**在 `,` 上朴素 split——cppvsdbg 可能在 glyph 字面量里塞 `,`（典型反例：
 * PMR 缓冲里塞了 `0x2c` 字节，cppvsdbg 渲染成 `44 ','`）。`...,` 截断标记
 * 跟 entry 之间靠正则自动分隔——matchAll 只匹配 entry，不会把 `...` 当成 entry。
 *
 * 不可识别的输入返回 `undefined`，调用方按既有路径处理（drop value）。
 */
export function parseCppvsdbgByteDump(value: string): readonly number[] | undefined {
    const m = /^(?:0x[0-9a-fA-F]+\s+)?\{(.*)\}\s*$/.exec(value);
    if (!m) { return undefined; }
    const body = m[1];
    if (body.trim() === '') { return []; }
    // per-entry 正则 matchAll。一条 entry 有三种形态：
    //   1) `[0x]NN '<glyph>'` —— 数字（可选 hex 前缀）+ glyph（MSVC 默认渲染）
    //   2) `[0x]NN`          —— 裸数字（`,x` 之类的 hex/dec 数组视图常见）
    //   3) `'<glyph>'`        —— 裸 glyph（`'\x18'`、`'a'`，交给 parseCharUnits）
    // 数字 + glyph 必须作为一个整体匹配，否则 `24 'a'` 会被数成 24 和 97 两个 byte；
    // glyph 内的 `\` 转义由 `\\.` 处理，`...` 截断标记不匹配任何分支，自然跳过。
    // 之前只认 `(\d+)\s*'...'`——cppvsdbg 用 `,x` / `,2048,x` 给完整 dump 时条目是
    // `0xNN` 这种裸 hex 形态，旧正则一个都匹配不上，导致全量 dump 被当成"不是 dump"。
    const entryRe = /(?:(0x[0-9a-fA-F]+|\d+)\s*)?'(?:\\.|[^'\\])*'|(0x[0-9a-fA-F]+|\d+)/g;
    const bytes: number[] = [];
    let invalid = false;
    let entryMatch: RegExpExecArray | null;
    while ((entryMatch = entryRe.exec(body)) !== null) {
        const numeric = entryMatch[1] ?? entryMatch[2];
        if (numeric !== undefined) {
            const n = /^0x/i.test(numeric) ? parseInt(numeric.slice(2), 16) : parseInt(numeric, 10);
            if (!(n >= 0 && n <= 0xff)) { invalid = true; break; }
            bytes.push(n);
        } else {
            // 裸 glyph：交给 parseCharUnits 解出码点（支持 `'\xE4\xB8\xAD'` 多字节形态）。
            const units = parseCharUnits(entryMatch[0]);
            if (!units) { invalid = true; break; }
            for (const u of units) {
                if (u > 0xff) { invalid = true; break; }
                bytes.push(u);
            }
            if (invalid) { break; }
        }
    }
    if (invalid) { return undefined; }
    if (bytes.length === 0) { return undefined; }
    return bytes;
}

/**
 * 从 cppvsdbg 的字节 dump 字符串里按 entry 拆分，跳过 `...` 截断标记，
 * 保留每个 entry 的原始 `<decimal> '<glyph>'` 文本。
 *
 * 与 `parseCppvsdbgByteDump` 的差别：后者把 entries 拆成单个 byte 数字，
 * 这里把整个 entry 字符串原样保留——拿来构造跟 cppvsdbg IDE Variables 面板
 * 同形态的虚拟 children（`[0] = 168 ''`）。
 *
 * `...` 不算 entry（截断标记）：调用方能从 entries 数量 vs 已知 buffer 大小
 * 推断剩余多少字节 cppvsdbg 折叠掉了。
 */
export interface ByteDumpEntry { name: string; value: string; type: 'std::byte'; }

export function parseCppvsdbgByteDumpEntries(value: string): readonly ByteDumpEntry[] {
    const m = /^(?:0x[0-9a-fA-F]+\s+)?\{(.*)\}\s*$/.exec(value);
    if (!m) { return []; }
    const body = m[1];
    if (body.trim() === '') { return []; }
    // 用跟 parseCppvsdbgByteDump 相同的 per-entry 正则切分，而不是在 `,` 上 split——
    // 字节 0x2c 会被 cppvsdbg 渲染成 `44 ','`，glyph 里的 `,` 会被 split 切成两半。
    // 正则只匹配 entry，`...` 截断标记自然跳过。
    const entryRe = /(?:(0x[0-9a-fA-F]+|\d+)\s*)?'(?:\\.|[^'\\])*'|(0x[0-9a-fA-F]+|\d+)/g;
    const out: ByteDumpEntry[] = [];
    let index = 0;
    let entryMatch: RegExpExecArray | null;
    while ((entryMatch = entryRe.exec(body)) !== null) {
        out.push({ name: `[${index}]`, value: entryMatch[0], type: 'std::byte' });
        index++;
    }
    return out;
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
/**
 * 把单个 byte 格式化为 cppvsdbg 在 std::byte 子节点 value 字段里展示的形态：
 * `<decimal> '<glyph>'`。
 *
 * 与 cppvsdbg 行为对齐（IDE Variables 面板里展开 [0]...[N-1] 看到的就是这种 value）：
 *   - `0` → `0 '\0'`
 *   - 其它控制字符（< 32 或 127）→ `'\xNN'` 转义
 *   - 可打印 ASCII（32-126）→ 直接显示字符；`\` 和 `'` 自身在 glyph 里必须
 *     转义，否则会把外层单引号 / dump 边界吃掉（典型 PMR 缓冲内容里就有
 *     反斜杠——漏转义整个 dump 直接被解析端截断）
 *   - 高位字节（>= 128）→ Latin-1 单字符（cppvsdbg 也是 byte → char 直接映射）
 *
 * 调用方：readMemory / tryEvaluateForFullByteDump 拿到 raw bytes 后物化成 N
 * 个虚拟 children 时，按 cppvsdbg 同形态构造 value，让 IDE 与 reader 的渲染
 * 完全一致；并且这些 value 串接成完整 byte dump 时结构稳定。
 */
export function formatByteAsCppvsdbg(byte: number): string {
    if (byte === 0) { return `0 '\\0'`; }
    if (byte < 32 || byte === 127) {
        // 不补前导 0——cppvsdbg 在 IDE Variables 面板里 `0x0f` 就渲染成 `'\xf'`，
        // padStart(2) 会被解析端 / 用户校验对不上。两边都用单字符 hex 即可。
        return `${byte} '\\x${byte.toString(16)}'`;
    }
    if (byte === 0x5c /* '\\' */) { return `${byte} '\\\\'`; }
    // 字面量 `'` 在 dump entry 里必须转义成 `\'`——直接拼字符串会跟外层
    // 单引号边界撞车。这里用模板字面量逐字符拼，避开 TS 字符串嵌套引号的陷阱。
    if (byte === 0x27 /* "'" */) { return `${byte} ` + `'\\''`; }
    // 字面量 `,` 在 dump entry 里也得转义——`parseCppvsdbgByteDump` 用 `,` 做
    // entry 分隔符，glyph 里塞 `,` 会让一条 entry 被切两半，parse 失败。`\,` 在
    // cppvsdbg 的 entry 字面量里被 `parseCharUnits` 的 `\\.` 规则接受。
    if (byte === 0x2c /* ',' */) { return `${byte} '\\,'`; }
    return `${byte} '${String.fromCharCode(byte)}'`;
}

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
    //
    // 例外：`std::byte[N]` 这种明确的二进制缓冲区，cppvsdbg 把 N 个 byte 子节点
    // 全部暴露出来（不像 std::string 给的是 truncated preview）。对二进制缓冲
    // 不能再套 maxArrayItems 上限——典型 PMR 背书缓冲 byte[2048] 会被默认 1000
    // 卡住、剩下 1048 字节直接丢。`std::byte *` 也按 indexedItems 走，没给
    // indexedItems 时再退回 maxArrayItems，避免无 size 信息的指针拖死会话。
    const isByteBuffer = isByteBufferType(variable.type);
    const indexedCount = getIndexedCount(variable);
    const total = isByteBuffer
        ? (indexedCount ?? context.limits.maxArrayItems)
        : Math.min(indexedCount ?? context.limits.maxArrayItems, context.limits.maxArrayItems);
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
    const size = getIndexedCount(variable) ?? collected.size;
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

/**
 * 对 std::byte[N] / std::byte * 走 per-index DAP `evaluate` 拉全部 child 节点。
 *
 * 触发场景：cppvsdbg 在 DAP 初始响应中不暴露 `variablesReference`（首屏折叠），
 * 但 IDE 内部确实知道 pmr_buf 是 expandable 的（用户手动展开能看到 `[0]` ...
 * `[2047]`）。我们的 reader 拿不到 ref，就走这条 per-index evaluate——发
 * `${evaluateName}[i]`（i 从 0 到 size-1），cppvsdbg 对每个返回
 * `{result: "<n> '<glyph>'", type: "std::byte"}`，把结果拼成 children map。
 *
 * 性能提醒：最多 2048 个 DAP round trip（typical ~10ms），典型 ~20s。
 * reader 在以下情形提前停止，避免无谓烧：
 *   - 任一 `evaluate` 失败（cppvsdbg 此时通常已经被打断或拒绝）
 *   - `result` 突然为空（说明 cppvsdbg 不再展开）
 *   - 命中 `context.limits.maxVariables` 上限
 *   - token 被取消（抛 `ReaderCancellationError` 向上传播）
 *
 * `size` 来源优先 `variable.indexedItems`，否则从 truncated dump 里尽量猜，
 * 实在猜不到就 `2048`（PMR demo 实际尺寸，够 std::byte 数组大多数情况用）。
 *
 * 调用方：把这段排在 readMemory / evaluate-refresh 之后——前两条不奏效时
 * 才动用这最暴力的兜底。
 */
async function iterateByteBufferChildren(
    variable: DapVariable,
    context: ReaderContext,
): Promise<Record<string, DapVariableNode> | undefined> {
    if (!variable.evaluateName) { return undefined; }
    const inferredSize = getIndexedCount(variable)
        ?? parseSizeFromByteDump(variable.value)
        ?? 2048;
    if (inferredSize <= 0 || inferredSize > 0x10000) { return undefined; }

    const children: Record<string, DapVariableNode> = {};
    let evaluations = 0;
    // 每条索引尝试多种 expression 形式：基本 `${name}[i]`、cppvsdbg hex `,x`、指针偏移
    // `((uint8_t*)&${name})[i]`。任一返回非空 result 即采纳；全都失败才放弃这条索引。
    const expressionsPerIndex = (i: number) => [
        `${variable.evaluateName}[${i}]`,
        `${variable.evaluateName}[${i}],x`,
        `((uint8_t*)&${variable.evaluateName})[${i}]`,
    ];
    // 连续 miss 计数：单个索引失败（0x00 字节偶发返回空 result）不再直接 break，
    // 要连续 miss 足够多次才判定 cppvsdbg 真的不再应答。否则 byte[2048] 这种
    // 数组会在第一个空结果处被截成 ~10 条，剩下的 2038 个字节全丢。
    let consecutiveMisses = 0;
    for (let i = 0; i < inferredSize; i++) {
        if (context.count >= context.limits.maxVariables) { break; }
        if (context.token?.isCancellationRequested) { throw new ReaderCancellationError(); }
        let stored = false;
        for (const expr of expressionsPerIndex(i)) {
            try {
                const resp = await request<{
                    result?: string;
                    type?: string;
                    variablesReference?: number;
                }>(context.session, 'evaluate', {
                    expression: expr,
                    context: 'watch',
                });
                evaluations++;
                context.count++;
                if (resp.result) {
                    children[`[${i}]`] = {
                        name: `[${i}]`,
                        value: resp.result,
                        type: resp.type ?? 'std::byte',
                    };
                    stored = true;
                    break;
                }
            } catch (error) {
                if (error instanceof ReaderCancellationError) { throw error; }
            }
        }
        if (stored) {
            consecutiveMisses = 0;
        } else {
            consecutiveMisses++;
            // 前 10 个索引 cppvsdbg 跟 IDE preview dump 一样总能答；之后允许最多
            // MAX_CONSECUTIVE_MISSES 个连续 miss 再停，避免把"只是刚好失败一条"
            // 误判成"per-index 上限到了"。
            if (consecutiveMisses >= MAX_CONSECUTIVE_MISSES && i > 9) {
                break;
            }
        }
    }

    return evaluations > 0 && Object.keys(children).length > 0 ? children : undefined;
}

/**
 * 从 cppvsdbg 的 truncated byte dump 字符串里猜 buffer 实际大小。
 *
 * cppvsdbg preview 通常只 dump 前 ~10 个 entry，truncated 后会留 `..., ..., ...`
 * 标记。但有的版本会在 `}` 前直接给出 size hint（比如先前的 `indexedItems`
 * 字段没回来时）。这里没法猜到真值就返回 undefined，让 iterateByteBufferChildren
 * 兜底用 2048 当默认（demo 的 PMR 缓冲实际是 2048 字节）。
 */
function parseSizeFromByteDump(value: string | undefined): number | undefined {
    if (!value) { return undefined; }
    // 已知的 cppvsdbg 形态：单纯的 `{..., ...}` 没有地址前缀，可以从
    // `PMR` pool 那种带地址前缀的 dump 里尝试匹配更多。预算一个保守值。
    return undefined;
}

/**
 * 调 DAP `readMemory` 直接读 raw memory bytes（base64 解码）。
 *
 * DAP spec 里有这个请求但很多 adapter 不实现——cppvsdbg 在支持 memory window
 * 的版本里也会暴露它。失败（adapter 不支持 / 内存不可读）一律返回 undefined，
 * 调用方继续走 evaluate refresh / 字节 dump 兜底。
 *
 * 响应字段：spec 里是 `body.data`（base64），`body.unreadableBytes`（uint64）。
 * 部分 adapter 历史上用 `bytes` 别名；这里两个都接受，spec 字段优先。
 */
async function readMemoryBytes(
    memoryReference: string,
    count: number,
    context: ReaderContext,
): Promise<Uint8Array | undefined> {
    if (typeof atob !== 'function') { return undefined; }
    try {
        const response = await request<{ data?: string; bytes?: string; unreadableBytes?: number; address?: string }>(
            context.session, 'readMemory',
            { memoryReference, offset: 0, count },
        );
        // DAP spec：`ReadMemoryResponse.body.data`（base64）。`bytes` 是别名兜底。
        const encoded = response.data ?? response.bytes;
        if (!encoded) { return undefined; }
        const binary = atob(encoded);
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) { out[i] = binary.charCodeAt(i); }
        return out;
    } catch (error) {
        if (error instanceof ReaderCancellationError) { throw error; }
    }
    return undefined;
}

/**
 * 给一个被 cppvsdbg "折叠"的 std::byte[N] / std::byte *（value 字段是字节 dump
 * 预览、不带 variablesReference 的形态），通过 DAP `evaluate` 试多种 MSVC
 * format specifier 来获取**完整 byte dump**（不只是默认 ~10 条预览）。
 *
 * MSVC format specifier 真相（来自 [Microsoft Learn](https://learn.microsoft.com/en-us/visualstudio/debugger/format-specifiers-in-cpp)）：
 *   - `,N`（pointer-style size specifier）：把指针当 N 元素数组渲染；对已知
 *     size 的 std::byte[N]，cppvsdbg 多数版本也认，并把 byte dump preview 扩到 N 条。
 *   - `,!`：raw 格式，忽略所有 natvis / 自定义渲染——把 std::byte[N] 当成纯
 *     字节 buffer 渲染，可能跟 `,N` 一起绕过默认截断。
 *   - `,s8`：UTF-8 字符串——把 buffer 解释为 UTF-8 字面量渲染（cppvsdbg 会把
 *     全部 2048 字节塞进 result）。
 *
 * 注意：旧版代码用的 `,e` 是**错的**——`,e` 在 MSVC spec 里是 float 科学计数
 * 格式（`2.500000e+07`），跟 expand 没关系。已删除。
 *
 * 返回：解析出的最长 byte dump（>= 64 bytes）。fallback / 全失败返回 undefined。
 */
async function tryEvaluateForFullByteDump(
    variable: DapVariable,
    context: ReaderContext,
): Promise<readonly number[] | undefined> {
    if (!variable.evaluateName) { return undefined; }
    const sizeHint = getIndexedCount(variable) ?? parseSizeFromType(variable.type) ?? 2048;
    // MSVC format specifier 表达式，按"最容易让 cppvsdbg dump 全量"排序：
    //   - `,N` 尺寸提示对 std::byte[N] 数组多数版本有效，把 ~10 条 preview 扩成 N 条；
    //   - `,N,x` 同尺寸 + hex 渲染（条目是 `0xNN` 裸 hex，parseCppvsdbgByteDump 已支持）；
    //   - `(unsigned char*)name,N[,x]`——`,N` 只对指针类表达式生效时，显式指针 cast
    //     让 cppvsdbg 把它当 N 元素数组渲染；
    //   - `,x` / `,!` / `,s8` / 裸名 作为后续兜底。
    const expressions = [
        `${variable.evaluateName},${sizeHint}`,
        `${variable.evaluateName},${sizeHint},x`,
        `(unsigned char*)${variable.evaluateName},${sizeHint}`,
        `(unsigned char*)${variable.evaluateName},${sizeHint},x`,
        `${variable.evaluateName},x`,
        `${variable.evaluateName},!`,
        `${variable.evaluateName},s8`,
        variable.evaluateName,
    ];
    let bestDump: readonly number[] | undefined;
    let bestDumpSize = 0;
    for (const expr of expressions) {
        try {
            const fresh = await request<{ result?: string }>(
                context.session, 'evaluate',
                { expression: expr, context: 'watch' },
            );
            if (!fresh.result) { continue; }
            const bytes = parseCppvsdbgByteDump(fresh.result);
            // 选 dump 最大的那个：cppvsdbg 各 spec 给的 byte 数差异很大，
            // 选最大的那一份就能拿到最多 byte（接近全量 2048）。
            if (bytes && bytes.length > bestDumpSize) {
                bestDump = bytes;
                bestDumpSize = bytes.length;
                // 已经拿到预期尺寸的全量 dump，后面的表达式不用再试了。
                if (bestDumpSize >= sizeHint) { break; }
            }
        } catch (error) {
            if (error instanceof ReaderCancellationError) { throw error; }
        }
    }
    // 64 bytes 阈值：默认 preview 给 ~10 条 entry，远低于 64；只有真的把
    // 完整 buffer dump 出来才会过这条线（PMR demo 是 2048 bytes，肯定过）。
    return bestDumpSize >= 64 ? bestDump : undefined;
}

/**
 * 从 DAP `variablesReference` 分页收集 `[0]..[N-1]` 的字节 children。
 *
 * 收集到足够条目才返回 map（< min(64, sizeHint) 视为半截 preview 的 ref，
 * 返回 undefined 让调用方继续走 per-index / dump fallback，避免把截断结果
 * 当成全量）。每个 child 的 `name` 必须形如 `[N]`（或裸 `N`），`value` 保留
 * adapter 给的 `<decimal> '<glyph>'` 形态。
 */
async function collectByteChildrenFromRef(
    ref: number,
    sizeHint: number,
    context: ReaderContext,
): Promise<Record<string, DapVariableNode> | undefined> {
    const children: Record<string, DapVariableNode> = {};
    let collected = 0;
    for (let start = 0; start < sizeHint; start += context.limits.pageSize) {
        if (context.token?.isCancellationRequested) { throw new ReaderCancellationError(); }
        if (context.count >= context.limits.maxVariables) { break; }
        const count = Math.min(context.limits.pageSize, sizeHint - start);
        let response: { variables?: DapVariable[] };
        try {
            response = await request<{ variables?: DapVariable[] }>(
                context.session, 'variables',
                { variablesReference: ref, start, count },
            );
        } catch (error) {
            if (error instanceof ReaderCancellationError) { throw error; }
            break;
        }
        const vars = (response.variables ?? []).filter(isDapVariable);
        if (vars.length === 0) { break; }
        for (const child of vars) {
            if (context.count >= context.limits.maxVariables) { break; }
            const m = /^\[?(\d+)\]?$/.exec(child.name);
            if (!m) { continue; }
            context.count++;
            collected++;
            children[`[${m[1]}]`] = {
                name: `[${m[1]}]`,
                value: child.value,
                type: child.type ?? 'std::byte',
            };
        }
        if (vars.length < count) { break; }
    }
    if (collected === 0) { return undefined; }
    // 阈值 64：cppvsdbg 的截断 preview 只给 ~10 条 entry，远低于 64；真正展开的
    // 数组 ref 会给出全量（PMR demo 2048 条，肯定过线）。不足 64 视为半截 ref，
    // 返回 undefined 让调用方继续走 per-index / dump fallback。小 buffer（如
    // std::byte[4] 文本）也会落到 readStringValue 走文本解码，保持旧行为。
    if (collected < 64) { return undefined; }
    return children;
}

/**
 * 解析单个 std::byte child 的 `value` 字符串为一个字节值。
 *
 * cppvsdbg 给 byte 数组子节点的 value 形态不固定：`24 '\x18'`、`0x18`、
 * `184 '�'`、`0 '\0'`、`44 ','` 都见过。与 `parseCppvsdbgByteDump` 共用
 * per-entry 正则，要求恰好解析出一个 0-255 的数值。
 */
function parseByteChildValue(value: string | undefined): number | undefined {
    if (!value) { return undefined; }
    const v = value.trim();
    const entryRe = /(?:(0x[0-9a-fA-F]+|\d+)\s*)?'(?:\\.|[^'\\])*'|(0x[0-9a-fA-F]+|\d+)/g;
    const matches: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = entryRe.exec(v)) !== null) {
        const numeric = m[1] ?? m[2];
        if (numeric !== undefined) {
            matches.push(/^0x/i.test(numeric) ? parseInt(numeric.slice(2), 16) : parseInt(numeric, 10));
        } else {
            const units = parseCharUnits(m[0]);
            if (units) { matches.push(...units); }
        }
    }
    if (matches.length !== 1) { return undefined; }
    const n = matches[0]!;
    return n >= 0 && n <= 0xff ? n : undefined;
}

/**
 * 尝试把已物化的 byte children 合并成一个 value 字符串（string-like 叶子）。
 *
 * 按 `[0]..[N-1]` 顺序取每个 child 的字节值做 UTF-8 解码；任何缺口 / 无法
 * 解析 / 解码出 U+FFFD 替换符（二进制内容）都返回 undefined，调用方退回
 * 物化 children。收集少于 `min(64, sizeHint)` 条时也返回 undefined，避免把
 * cppvsdbg 的截断 preview 合并成"只有 10 字节"的误导性 value。
 */
function tryMergeByteChildrenIntoValue(
    children: Record<string, DapVariableNode>,
    sizeHint: number,
): string | undefined {
    const indexes = Object.keys(children)
        .map(k => parseInt(k.replace(/[\[\]]/g, ''), 10))
        .filter(n => Number.isInteger(n) && n >= 0)
        .sort((a, b) => a - b);
    if (indexes.length < Math.min(64, sizeHint)) { return undefined; }
    const bytes: number[] = [];
    let expected = 0;
    for (const i of indexes) {
        if (i !== expected) { return undefined; }
        const child = children[`[${i}]`] ?? children[String(i)];
        const b = parseByteChildValue(child?.value);
        if (b === undefined) { return undefined; }
        bytes.push(b);
        expected++;
    }
    const decoded = new TextDecoder('utf-8').decode(new Uint8Array(bytes));
    if (decoded.includes('\uFFFD')) { return undefined; }
    return decoded;
}

/**
 * byte buffer children 收尾：合并模式下字节能解码成文本就合成 `value`（叶子），
 * 否则保留物化好的 children。调用前 `node.children` 必须已设置好。
 */
function finalizeByteChildren(
    node: DapVariableNode,
    sizeHint: number,
    context: ReaderContext,
): DapVariableNode {
    if (context.limits.mergeByteBufferIntoValue && node.children) {
        const merged = tryMergeByteChildrenIntoValue(node.children, sizeHint);
        if (merged !== undefined) {
            node.value = merged;
            delete node.children;
            return node;
        }
    }
    delete node.value;
    return node;
}

/**
 * 通过 `evaluate` 拿一个可展开句柄，再用 `variables` 分页把全部字节 children 拉回。
 *
 * cppvsdbg 对 `std::byte[N]` 在 `variables` 首屏折叠（不带 variablesReference），
 * 但对 `name,N` 这种尺寸提示的 evaluate 表达式会返回**可展开的 ref**——IDE Watch
 * 里 `pmr_buf,2048` 就能展开看到 `[0]..[N-1]`（999 以上都能看到）。reader 拿到
 * ref 后走 `collectByteChildrenFromRef` 分页，等价于 IDE 展开后的数据，比
 * per-index evaluate 少几十倍 round trip。
 *
 * `name,N` 拿不到 ref 时退回 `name,N,!`、`name,!`、裸 `name`。
 */
async function readByteChildrenViaExpandableEvaluate(
    variable: DapVariable,
    context: ReaderContext,
): Promise<Record<string, DapVariableNode> | undefined> {
    if (!variable.evaluateName) { return undefined; }
    const sizeHint = getIndexedCount(variable) ?? parseSizeFromType(variable.type) ?? 2048;
    const expressions = [
        `${variable.evaluateName},${sizeHint}`,
        `${variable.evaluateName},${sizeHint},!`,
        `${variable.evaluateName},!`,
        variable.evaluateName,
    ];
    for (const expr of expressions) {
        if (context.token?.isCancellationRequested) { throw new ReaderCancellationError(); }
        let ref: number | undefined;
        try {
            const resp = await request<{ variablesReference?: number }>(
                context.session, 'evaluate',
                { expression: expr, context: 'watch' },
            );
            ref = resp.variablesReference;
        } catch (error) {
            if (error instanceof ReaderCancellationError) { throw error; }
            continue;
        }
        if (!ref) { continue; }
        const children = await collectByteChildrenFromRef(ref, sizeHint, context);
        if (children) { return children; }
    }
    return undefined;
}

/**
 * 从 `std::byte[N]` / `std::byte *` 类型字符串里抽出 N（已知 size）。
 * 失败返回 undefined——调用方继续用 indexedVariables / 2048 fallback。
 */
function parseSizeFromType(type: string | undefined): number | undefined {
    if (!type) { return undefined; }
    const m = /\[\s*(\d+)\s*\]/.exec(type);
    if (!m) { return undefined; }
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * 把 raw bytes 数组物化成 `[0]..[N-1]` 虚拟 child map，挂到 `node.children` 上。
 * 共享于 readMemory / tryEvaluateForFullByteDump 两条路径。
 *
 * `sizeHint`：可信赖的预期 size（来自 indexedVariables / type）——如果小于
 * `bytes.length`，多余的字节是 cppvsdbg 在另一个数组边界处的额外 payload，
 * 应该截掉而不是把 [extra] 当成 [sizeHint] 之后的位置。
 */
function nodeWithByteChildren(
    node: DapVariableNode,
    bytes: readonly number[],
    sizeHint: number | undefined,
    context: ReaderContext,
): DapVariableNode {
    const size = sizeHint ?? bytes.length;
    const actual = Math.min(size, bytes.length);
    const children: Record<string, DapVariableNode> = {};
    for (let i = 0; i < actual; i++) {
        if (context.count >= context.limits.maxVariables) {
            node.truncated = true;
            break;
        }
        context.count++;
        children[`[${i}]`] = {
            name: `[${i}]`,
            value: formatByteAsCppvsdbg(bytes[i]),
            type: 'std::byte',
        };
    }
    node.children = children;
    delete node.value;
    return node;
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
    // 字符串类类型。
    //   1) 空容器（indexedItems === 0） → value = ""，不发 variables 请求
    //   2) 从 char / byte 子节点重建完整文本 → 用重建结果当 value
    //   3) std::byte[N] / std::byte * 但没带 variablesReference（cppvsdbg 默认
    //      把二进制 buffer 折叠成字节 dump 预览，不暴露子节点）：evaluate 一遍
    //      拿一个新句柄，再走第 2 步；刷新仍失败才继续向下
    //   4) 重建失败时回退：cppvsdbg 对 std::byte[N] / std::byte * 的“字节 dump”
    //      （形如 `0x... {168 '�', 232 '�', ..., ...}`）放在 value 字段里，
    //      解析出字节并按 UTF-8 解码
    //   5) 重建失败但 `variablesReference` 还在（cppvsdbg 对 std::pmr::basic_string
    //      / u16s / u32s 等暴露 MSVC 内部布局而不是 char 子节点）：落到通用分支
    //      展开 children，让 type/evaluateName/memoryReference 与实际字段
    //      （_Mysize / _Myres / _Altr / _Buf 等）一起保留，便于排错
    //   6) 都没有：清掉残留的 adapter 摘要，返回只剩 type/evaluateName 的空节点
    if (isStringLikeType(variable.type)) {
        if (getIndexedCount(variable) === 0) {
            node.value = '';
            return node;
        }
        // std::byte[N] / std::byte *（cppvsdbg 折叠形态）：无论输入是否自带
        // variablesReference，都要物化全部字节 children。按可靠性排序：
        //   1) 输入自带 ref（cppvsdbg 对 byte 数组会给可展开 ref，只是 value 折叠
        //      成 preview）→ 直接 variables 分页，等价于 IDE 展开后的数据
        //   2) DAP readMemory 直接读 raw memory bytes
        //   3) evaluate 拿全量 byte dump（`,N` / `,x` / 指针 cast 等）
        //   4) evaluate 拿可展开 ref → variables 分页
        //   5) per-index evaluate
        // 全失败才回到通用字节 dump 兜底 / readStringValue 文本解码。
        if (isByteBufferType(variable.type)) {
            if (context.token?.isCancellationRequested) { throw new ReaderCancellationError(); }
            const sizeHint = getIndexedCount(variable) ?? parseSizeFromType(variable.type) ?? 2048;
            // 各字节源先把 children 物化到 node 上，再用 finalizeByteChildren 收尾：
            // 合并模式（mergeByteBufferIntoValue）下内容可解码成文本 → value 叶子，
            // 二进制 / 非合并模式 → 保留 children。
            if (variable.variablesReference) {
                const fromRef = await collectByteChildrenFromRef(variable.variablesReference, sizeHint, context);
                if (fromRef) {
                    node.children = fromRef;
                    return finalizeByteChildren(node, sizeHint, context);
                }
            }
            if (variable.memoryReference) {
                const memCount = getIndexedCount(variable) ?? 4096;
                const memBytes = await readMemoryBytes(variable.memoryReference, memCount, context);
                if (memBytes && memBytes.length > 0) {
                    nodeWithByteChildren(node, Array.from(memBytes), sizeHint, context);
                    return finalizeByteChildren(node, sizeHint, context);
                }
            }
            const dump = await tryEvaluateForFullByteDump(variable, context);
            if (dump && dump.length > 0) {
                // sizeHint 用 type / indexedItems 里的数组尺寸而不是 dump.length：
                // cppvsdbg 的 `,N` dump 偶发在数组边界外多给几条 payload，多出来的
                // 应该截掉，而不是把 [sizeHint] 之后的额外字节当成数组内容。
                nodeWithByteChildren(node, dump, sizeHint, context);
                return finalizeByteChildren(node, sizeHint, context);
            }
            const expanded = await readByteChildrenViaExpandableEvaluate(variable, context);
            if (expanded) {
                node.children = expanded;
                return finalizeByteChildren(node, sizeHint, context);
            }
            const iterated = await iterateByteBufferChildren(variable, context);
            if (iterated) {
                node.children = iterated;
                return finalizeByteChildren(node, sizeHint, context);
            }
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
            if (isByteBufferType(variable.type)) {
                // std::byte[N] / std::byte *：cppvsdbg 在 DAP 首屏常把 byte 子节点
                // 折叠掉不给 variablesReference，但 value 字段里给的是字节 dump 预览——
                // 每个 entry 已经就是 `<decimal> '<glyph>'` 的形态，跟 IDE Variables
                // 面板里手动展开看到的同一个数据。readMemory / evaluate refresh 都没拿到
                // 完整 2048 字节的情况下，把这些 dump entry 直接做成虚拟 children，对应
                // IDE 展开后看到的子节点。长截断（"..., ..." 标记）和短完整都按这个走。
                // `...,` 标记本身不算 entry，调用方能从 entries 数 vs known size 推断
                // 剩余字节数。
                const dumpEntries = parseCppvsdbgByteDumpEntries(variable.value);
                if (dumpEntries.length > 0) {
                    const children: Record<string, DapVariableNode> = {};
                    for (const entry of dumpEntries) {
                        children[entry.name] = {
                            name: entry.name,
                            value: entry.value,
                            type: entry.type,
                        };
                    }
                    node.children = children;
                    delete node.value;
                    return node;
                }
            }
            const bytes = parseCppvsdbgByteDump(variable.value);
            if (bytes !== undefined) {
                // char / char[N] / const char * / char16_t * 等文本类 byte dump：
                // dump 形态（"0x... {byte 'X', byte 'Y', ...}"）罕见但 cppvsdbg 在
                // `,s8` 这种强制 string 显示的场景里会给出。
                node.value = new TextDecoder('utf-8').decode(new Uint8Array(bytes));
                return node;
            }
        }
        if (!variable.variablesReference) {
            // 既无 char / byte 子节点、字节 dump 也对不上、又拿不到 variablesReference：
            // 真无路可走，丢掉 adapter 的"半截"预览，避免 type 与残 value 同时出现。
            delete node.value;
            return node;
        }
        // 重建失败但 variablesReference 还在（cppvsdbg 对 std::pmr::basic_string
        // / u16s / u32s 等暴露 MSVC 内部布局而不是 char 子节点）：落到通用分支
        // 把 children 展开，让用户至少能看到 _Mysize / _Myres / _Altr / _Buf 等
        // 实际字段。通用分支在装上 children 后会再清一次残留的 value 摘要。
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
        const total = Math.min(getIndexedCount(variable) ?? context.limits.maxArrayItems, context.limits.maxArrayItems);
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
