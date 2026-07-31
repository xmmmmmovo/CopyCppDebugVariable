import * as assert from 'assert';
import type * as vscode from 'vscode';
import { DapVariable, ReaderCancellationError, ReaderLimits, isDapVariable, isStringLikeType, parseCharUnits, readStringValue, readVariableTree } from '../variableReader';
import {
	DebugCopyDeps,
	VariableMenuContext,
	buildDefaultFileName,
	buildResultDocument,
	copyVariableAsJson,
	evaluateToVariable,
	isVariableMenuContext,
	menuContextToVariable,
	readLimitsFromConfig,
	saveVariableAsJson,
} from '../debugCopy';

type CustomRequest = (command: string, args?: unknown) => Promise<unknown>;

function makeSession(impl: CustomRequest): vscode.DebugSession {
	return { customRequest: impl } as unknown as vscode.DebugSession;
}

function makeSessionWithType(type: string, impl: CustomRequest): vscode.DebugSession {
	return { type, customRequest: impl } as unknown as vscode.DebugSession;
}

const DEFAULT_LIMITS: ReaderLimits = { maxDepth: 8, maxVariables: 10000, maxArrayItems: 1000, pageSize: 100 };

function makeContext(session: vscode.DebugSession, overrides: Partial<ReaderLimits> = {}, token?: vscode.CancellationToken) {
	return { session, limits: { ...DEFAULT_LIMITS, ...overrides }, token, count: 0, references: new Set<number>() };
}

function makeDeps(overrides: Partial<DebugCopyDeps> & { session?: vscode.DebugSession | undefined; sessionsById?: Record<string, vscode.DebugSession> } = {}): DebugCopyDeps & { calls: { info: string[]; warning: string[]; error: string[]; clipboard: string[]; files: { path: string; content: Uint8Array }[] } } {
	const session = 'session' in overrides ? overrides.session : undefined;
	const sessionsById = overrides.sessionsById ?? {};
	const calls = { info: [] as string[], warning: [] as string[], error: [] as string[], clipboard: [] as string[], files: [] as { path: string; content: Uint8Array }[] };
	const deps: DebugCopyDeps = {
		getSession: overrides.getSession ?? (() => session),
		getSessionById: overrides.getSessionById ?? ((id: string) => sessionsById[id]),
		showInputBox: overrides.showInputBox ?? (async () => 'person'),
		showSaveDialog: overrides.showSaveDialog ?? (async () => '/tmp/out.json'),
		writeClipboard: overrides.writeClipboard ?? (async (text: string) => { calls.clipboard.push(text); }),
		writeFile: overrides.writeFile ?? (async (path: string, content: Uint8Array) => { calls.files.push({ path, content }); }),
		showInfo: overrides.showInfo ?? ((m: string) => { calls.info.push(m); }),
		showWarning: overrides.showWarning ?? ((m: string) => { calls.warning.push(m); }),
		showError: overrides.showError ?? ((m: string) => { calls.error.push(m); }),
		readLimits: overrides.readLimits ?? (() => DEFAULT_LIMITS),
		now: overrides.now ?? (() => new Date('2026-01-01T00:00:00.000Z')),
	};
	return Object.assign(deps, { calls });
}

suite('isDapVariable type guard', () => {
	test('accepts object with name', () => {
		assert.strictEqual(isDapVariable({ name: 'x' }), true);
	});
	test('rejects non-object', () => {
		assert.strictEqual(isDapVariable('x'), false);
		assert.strictEqual(isDapVariable(null), false);
		assert.strictEqual(isDapVariable(123), false);
	});
	test('rejects object without string name', () => {
		assert.strictEqual(isDapVariable({}), false);
		assert.strictEqual(isDapVariable({ name: 123 }), false);
	});
});

suite('isStringLikeType', () => {
	const stringCases = [
		'std::string',
		'std::wstring',
		'std::u8string',
		'std::u16string',
		'std::u32string',
		'std::string_view',
		'std::basic_string<char, std::char_traits<char>, std::allocator<char> >',
		'std::basic_string_view<char, std::char_traits<char> >',
		'const char *',
		'char *',
		'char[16]',
		'const char[16]',
		'wchar_t *',
		'const wchar_t *',
		'wchar_t[8]',
		'char8_t *',
		'char16_t *',
		'char32_t *',
		'unsigned char *',
		// std::pmr::* 别名
		'std::pmr::string',
		'std::pmr::wstring',
		'std::pmr::u8string',
		'std::pmr::u16string',
		'std::pmr::u32string',
		'std::pmr::string_view',
		// ABI 命名空间包裹的 basic_string（libstdc++ __cxx11 / libc++ __1 / __y / __abi）
		'std::__cxx11::basic_string<char, std::char_traits<char>, std::allocator<char> >',
		'std::__1::basic_string<char, std::char_traits<char>, std::allocator<char> >',
		'std::__cxx11::basic_string_view<char, std::char_traits<char> >',
		'std::__y::basic_string<char, std::char_traits<char>, std::allocator<char> >',
		// 兼容多余/不规则空白
		'std::basic_string<char>',
		'  std::string  ',
	];
	for (const t of stringCases) {
		test(`matches ${t}`, () => {
			assert.strictEqual(isStringLikeType(t), true);
		});
	}
	const nonStringCases = [
		undefined,
		'',
		'int',
		'double',
		'Person',
		'std::vector<int>',
		'std::vector<char>',
		'std::vector<std::string>',
		'std::deque<char>',
		'std::list<char>',
		'std::array<char, 16>',
		'std::map<std::string, int>',
		'signed int',
		'unsigned int',
		'char',                                // 裸标量，不是指针/数组
		'wchar_t',
		'MyString',                            // 用户自定义类型
		'std::basic_string_factory<int>',      // false-positive 防护
		'std::__cxx11::vector<int>',           // ABI 命名空间，但容器不是 string
		'std::__cxx11::allocator<char>',       // 名字像 string，但不是
	];
	for (const t of nonStringCases) {
		test(`rejects ${t === undefined ? 'undefined' : JSON.stringify(t)}`, () => {
			assert.strictEqual(isStringLikeType(t), false);
		});
	}
});

suite('readVariableTree', () => {
	test('returns leaf when variablesReference is 0', async () => {
		const session = makeSession(async () => { throw new Error('should not call'); });
		const node = await readVariableTree({ name: 'x', value: '1', variablesReference: 0 }, makeContext(session));
		assert.deepStrictEqual(node, { name: 'x', value: '1', type: undefined, evaluateName: undefined, memoryReference: undefined });
	});

	test('recurses into children and preserves names', async () => {
		const calls: string[] = [];
		const session = makeSession(async (cmd, args) => {
			calls.push(cmd);
			if (cmd === 'evaluate') { return { result: '{...}', type: 'Person', variablesReference: 1 }; }
			if (cmd === 'variables' && (args as { variablesReference: number }).variablesReference === 1) {
				return {
					variables: [
						{ name: 'name', value: '"Alice"', type: 'NameBuffer', variablesReference: 2 },
						{ name: 'age', value: '29', type: 'int', variablesReference: 0 },
					]
				};
			}
			if (cmd === 'variables' && (args as { variablesReference: number }).variablesReference === 2) {
				return { variables: [{ name: 'size', value: '5', type: 'size_t', variablesReference: 0 }] };
			}
			return { variables: [] };
		});
		const result = await request<{ result: string; type: string; variablesReference: number }>(session, 'evaluate', { expression: 'person' });
		const variable: DapVariable = { name: 'person', value: result.result, type: result.type, variablesReference: result.variablesReference };
		const context = makeContext(session);
		const data = await readVariableTree(variable, context);
		assert.strictEqual(data.children?.name.value, '"Alice"');
		assert.strictEqual(data.children?.name.children?.size.value, '5');
		assert.strictEqual(data.children?.age.value, '29');
		assert.ok(calls.includes('variables'));
	});

	test('treats string-like types as leaves even when variablesReference is set', async () => {
		const cases: Array<{ type: string; value: string }> = [
			{ type: 'std::string', value: '"Alice"' },
			{ type: 'std::basic_string<char, std::char_traits<char>, std::allocator<char> >', value: '"Alice"' },
			{ type: 'std::wstring', value: 'L"Alice"' },
			{ type: 'std::string_view', value: '"Alice"' },
			{ type: 'std::basic_string_view<char, std::char_traits<char> >', value: '"Alice"' },
			{ type: 'const char *', value: '0x555555 "Alice"' },
			{ type: 'char *', value: '0x555555 "Alice"' },
			{ type: 'char[16]', value: '"Alice"' },
			{ type: 'const char[16]', value: '"Alice"' },
			{ type: 'const wchar_t *', value: '0x555555 L"Alice"' },
			{ type: 'wchar_t[8]', value: 'L"Alice"' },
			{ type: 'char16_t *', value: 'u"hi"' },
			{ type: 'unsigned char *', value: '0x555555 ""' },
		];
		for (const c of cases) {
			// 模拟适配器返回的是非 char 的“噪声”子节点（如 cppvsdbg 的 [size]/[capacity]
			// 或根本无子节点），此时不应重建字符串，也不应让内部字段泄漏。
			let variablesCalls = 0;
			const session = makeSession(async (cmd) => {
				if (cmd === 'variables') { variablesCalls++; }
				return { variables: [{ name: '[size]', value: '0', type: 'unsigned __int64', variablesReference: 0 }] };
			});
			const node = await readVariableTree({ name: 's', value: c.value, type: c.type, variablesReference: 42 }, makeContext(session));
			assert.strictEqual(node.children, undefined, `${c.type} should not expose children`);
			assert.strictEqual(node.value, c.value, `${c.type} should keep adapter value when no char children`);
			assert.ok(variablesCalls >= 1, `${c.type} should consult variables to look for char children`);
		}
	});

	test('reconstructs string value from indexed char children', async () => {
		const cases: Array<{ type: string; indexedItems: number; children: DapVariable[]; expected: string; charKind: 'utf8' | 'utf16' | 'utf32' }> = [
			{
				type: 'std::string',
				indexedItems: 5,
				charKind: 'utf8',
				children: [
					{ name: '[0]', value: "72 'H'", type: 'char', variablesReference: 0 },
					{ name: '[1]', value: "101 'e'", type: 'char', variablesReference: 0 },
					{ name: '[2]', value: "108 'l'", type: 'char', variablesReference: 0 },
					{ name: '[3]', value: "108 'l'", type: 'char', variablesReference: 0 },
					{ name: '[4]', value: "111 'o'", type: 'char', variablesReference: 0 },
				],
				expected: 'Hello',
			},
			{
				type: 'std::u8string',
				indexedItems: 1,
				charKind: 'utf8',
				children: [
					{ name: '[0]', value: "'\\xE4\\xBD\\xA0'", type: 'char8_t', variablesReference: 0 },
				],
				expected: '你',
			},
		];
		for (const c of cases) {
			const session = makeSession(async (cmd) => cmd === 'variables' ? { variables: c.children } : {});
			const node = await readVariableTree(
				{ name: 's', value: '"..."', type: c.type, variablesReference: 42, indexedItems: c.indexedItems },
				makeContext(session),
			);
			assert.strictEqual(node.value, c.expected, `${c.type} should reconstruct to ${JSON.stringify(c.expected)}`);
			assert.strictEqual(node.children, undefined, `${c.type} should not expose char children`);
		}
	});

	test('still expands non-string container types like std::vector<char>', async () => {
		const session = makeSession(async (cmd, args) => {
			if (cmd === 'variables') {
				return { variables: [{ name: '0', value: '65 \'A\'', type: 'char', variablesReference: 0 }] };
			}
			return {};
		});
		const data = await readVariableTree({ name: 'buf', value: '{ size=1 }', type: 'std::vector<char>', variablesReference: 7, indexedItems: 1 }, makeContext(session, { maxArrayItems: 1 }));
		assert.ok(data.children);
		assert.strictEqual(data.children[0].value, '65 \'A\'');
	});

	test('treats empty std::string as empty value without consulting variables', async () => {
		let variablesCalls = 0;
		const session = makeSession(async (cmd) => {
			if (cmd === 'variables') { variablesCalls++; }
			return { variables: [] };
		});
		const node = await readVariableTree(
			{ name: 'empty', value: '""', type: 'std::string', variablesReference: 99, indexedItems: 0 },
			makeContext(session),
		);
		assert.strictEqual(node.value, '');
		assert.strictEqual(node.children, undefined);
		assert.strictEqual(variablesCalls, 0, 'empty string must not trigger a variables request');
	});

	test('keeps adapter value when std::string exposes no char children (cppvsdbg fallback)', async () => {
		const session = makeSession(async (cmd) => cmd === 'variables' ? {
			variables: [
				{ name: '[size]', value: '300', type: 'unsigned __int64', variablesReference: 0 },
				{ name: '[capacity]', value: '300', type: 'unsigned __int64', variablesReference: 0 },
				{ name: '[allocator]', value: 'allocator', type: 'std::allocator<char>', variablesReference: 0 },
			],
		} : {});
		const node = await readVariableTree(
			{ name: 'long_str', value: '"Lorem ipsum...aliqua...', type: 'std::string', variablesReference: 7, indexedItems: 300 },
			makeContext(session),
		);
		// 保留截断的展示值，不暴露内部 [size]/[capacity]/[allocator] 等结构。
		assert.strictEqual(node.value, '"Lorem ipsum...aliqua...');
		assert.strictEqual(node.children, undefined);
	});

	test('marks truncated when max depth reached', async () => {
		const session = makeSession(async (cmd, args) => {
			if (cmd === 'variables') {
				return { variables: [{ name: 'inner', value: '0', type: 'int', variablesReference: (args as { variablesReference: number }).variablesReference + 1 }] };
			}
			return {};
		});
		const variable: DapVariable = { name: 'root', variablesReference: 100 };
		const data = await readVariableTree(variable, makeContext(session, { maxDepth: 1 }));
		assert.strictEqual(data.children?.inner.truncated, true);
	});

	test('marks truncated when max variables reached', async () => {
		const session = makeSession(async (cmd) => {
			if (cmd === 'variables') {
				return { variables: Array.from({ length: 5 }, (_, i) => ({ name: `v${i}`, value: '0', type: 'int', variablesReference: 1000 + i })) };
			}
			return {};
		});
		const variable: DapVariable = { name: 'root', variablesReference: 1 };
		const data = await readVariableTree(variable, makeContext(session, { maxVariables: 3 }));
		assert.strictEqual(data.truncated, true);
		assert.ok(data.children && Object.keys(data.children).length <= 3);
	});

	test('detects cycles and marks cycle flag', async () => {
		const session = makeSession(async (cmd, args) => {
			if (cmd === 'variables') {
				const ref = (args as { variablesReference: number }).variablesReference;
				return { variables: [{ name: 'self', value: '<ref>', type: 'T*', variablesReference: ref }] };
			}
			return {};
		});
		const variable: DapVariable = { name: 'a', variablesReference: 42 };
		const data = await readVariableTree(variable, makeContext(session));
		assert.strictEqual(data.children?.self.cycle, true);
	});

	test('pages large arrays using start/count', async () => {
		const requested: Array<{ start: number; count: number }> = [];
		const session = makeSession(async (cmd, args) => {
			if (cmd === 'variables') {
				const a = args as { start: number; count: number; variablesReference: number };
				requested.push({ start: a.start, count: a.count });
				const items = Array.from({ length: a.count }, (_, i) => ({ name: `[${a.start + i}]`, value: `${a.start + i}`, type: 'int', variablesReference: 0 }));
				return { variables: items };
			}
			return {};
		});
		const variable: DapVariable = { name: 'arr', variablesReference: 7, indexedItems: 250 };
		const data = await readVariableTree(variable, makeContext(session, { pageSize: 100, maxArrayItems: 250 }));
		assert.strictEqual(requested.length, 3);
		assert.deepStrictEqual(requested.map(r => [r.start, r.count]), [[0, 100], [100, 100], [200, 50]]);
		assert.ok(data.children && Object.keys(data.children).length === 250);
	});

	test('respects maxArrayItems', async () => {
		const session = makeSession(async (cmd) => cmd === 'variables' ? { variables: [{ name: 'a', value: '0', type: 'int', variablesReference: 0 }] } : {});
		const variable: DapVariable = { name: 'arr', variablesReference: 1, indexedItems: 1000 };
		const data = await readVariableTree(variable, makeContext(session, { maxArrayItems: 2 }));
		assert.ok(data.children && Object.keys(data.children).length <= 2);
	});

	test('captures child errors without losing siblings', async () => {
		const session = makeSession(async (cmd, args) => {
			if (cmd === 'variables' && (args as { variablesReference: number }).variablesReference === 1) {
				return {
					variables: [
						{ name: 'good', value: '1', type: 'int', variablesReference: 0 },
						{ name: 'bad', value: '?', type: 'X', variablesReference: 99 },
					]
				};
			}
			if (cmd === 'variables' && (args as { variablesReference: number }).variablesReference === 99) {
				throw new Error('boom');
			}
			return { variables: [] };
		});
		const variable: DapVariable = { name: 'root', variablesReference: 1 };
		const data = await readVariableTree(variable, makeContext(session));
		assert.ok(data.children?.good);
		assert.ok(data.children?.bad.errors && data.children.bad.errors[0].includes('boom'));
	});

	test('handles non-array variables response', async () => {
		const session = makeSession(async (cmd) => cmd === 'variables' ? { variables: 'oops' as unknown as DapVariable[] } : {});
		const variable: DapVariable = { name: 'root', variablesReference: 1 };
		const data = await readVariableTree(variable, makeContext(session));
		assert.strictEqual(data.children, undefined);
	});

	test('renames duplicate child keys with offset suffix', async () => {
		const session = makeSession(async (cmd, args) => {
			if (cmd === 'variables') {
				return {
					variables: [
						{ name: 'dup', value: '0', type: 'int', variablesReference: 0 },
						{ name: 'dup', value: '1', type: 'int', variablesReference: 0 },
					]
				};
			}
			return {};
		});
		const variable: DapVariable = { name: 'root', variablesReference: 1 };
		const data = await readVariableTree(variable, makeContext(session));
		const keys = Object.keys(data.children ?? {});
		assert.ok(keys.includes('dup'));
	});

	test('throws ReaderCancellationError when token is cancelled', async () => {
		const session = makeSession(async () => ({}));
		const token: vscode.CancellationToken = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose() { /* noop */ } }) } as unknown as vscode.CancellationToken;
		await assert.rejects(readVariableTree({ name: 'x', variablesReference: 1 }, makeContext(session, {}, token)), (err: unknown) => err instanceof ReaderCancellationError);
	});

	test('stops after empty page', async () => {
		const session = makeSession(async () => ({ variables: [] }));
		const variable: DapVariable = { name: 'root', variablesReference: 1, indexedItems: 50 };
		const data = await readVariableTree(variable, makeContext(session));
		assert.strictEqual(data.children, undefined);
	});
});

suite('parseCharUnits', () => {
	const cases: Array<{ input: string | undefined; expected: readonly number[] | undefined }> = [
		// 1) <decimal> '<glyph>' —— cppdbg、cppvsdbg 主流
		{ input: "72 'H'", expected: [72] },
		{ input: "228 '\\xe4'", expected: [228] },
		// 2) 0x<hex> '<glyph>'
		{ input: "0x61 'a'", expected: [0x61] },
		// 3) 一个子节点里塞多个 UTF-8 字节（cppvsdbg 对 char8_t 的截断渲染）
		{ input: "'\\xE4'", expected: [0xE4] },
		{ input: "'\\xE4\\xB8\\xAD'", expected: [0xE4, 0xB8, 0xAD] },
		// 4) [uLU]'X' / [uLU]'\xNN' / [uLU]'\uNNNN'
		{ input: "u'a'", expected: [97] },
		{ input: "L'a'", expected: [97] },
		{ input: "U'a'", expected: [97] },
		{ input: "'\\u00E9'", expected: [0xE9] },
		// 5) 'X' 纯字面量
		{ input: "'a'", expected: [97] },
		// 不可识别
		{ input: 'a', expected: undefined },
		{ input: undefined, expected: undefined },
		{ input: '', expected: undefined },
		{ input: 'garbage', expected: undefined },
		{ input: "'", expected: undefined },
	];
	for (const c of cases) {
		test(`parses ${JSON.stringify(c.input)}`, () => {
			assert.deepStrictEqual(parseCharUnits(c.input), c.expected);
		});
	}
});

suite('readStringValue', () => {
	test('reconstructs printable ASCII from cppdbg-style char children', async () => {
		let variablesCalls = 0;
		const session = makeSession(async (cmd) => {
			if (cmd === 'variables') {
				variablesCalls++;
				return { variables: [
					{ name: '[0]', value: "72 'H'", type: 'char', variablesReference: 0 },
					{ name: '[1]', value: "101 'e'", type: 'char', variablesReference: 0 },
					{ name: '[2]', value: "108 'l'", type: 'char', variablesReference: 0 },
					{ name: '[3]', value: "108 'l'", type: 'char', variablesReference: 0 },
					{ name: '[4]', value: "111 'o'", type: 'char', variablesReference: 0 },
				] };
			}
			return {};
		});
		const result = await readStringValue(
			{ name: 's', value: '"..."', type: 'std::string', variablesReference: 42, indexedItems: 5 },
			makeContext(session),
		);
		assert.strictEqual(result, 'Hello');
		assert.strictEqual(variablesCalls, 1);
	});

	test('decodes packed UTF-8 multi-byte child for std::u8string', async () => {
		const session = makeSession(async (cmd) => cmd === 'variables' ? {
			variables: [{ name: '[0]', value: "'\\xE4\\xBD\\xA0'", type: 'char8_t', variablesReference: 0 }],
		} : {});
		const result = await readStringValue(
			{ name: 'utf8', value: '"..."', type: 'std::u8string', variablesReference: 7, indexedItems: 1 },
			makeContext(session),
		);
		assert.strictEqual(result, '你');
	});

	test('combines surrogate pair halves from std::u16string children', async () => {
		const session = makeSession(async (cmd) => cmd === 'variables' ? {
			variables: [
				{ name: '[0]', value: "0xD834 '?'", type: 'char16_t', variablesReference: 0 },
				{ name: '[1]', value: "0xDD1E '?'", type: 'char16_t', variablesReference: 0 },
			],
		} : {});
		const result = await readStringValue(
			{ name: 'u16', value: '"..."', type: 'std::u16string', variablesReference: 9, indexedItems: 2 },
			makeContext(session),
		);
		assert.strictEqual(result, '𝄞'); // U+1D11E 𝄞
	});

	test('returns empty string for indexedItems: 0 without a variables request', async () => {
		let variablesCalls = 0;
		const session = makeSession(async (cmd) => {
			if (cmd === 'variables') { variablesCalls++; }
			return { variables: [] };
		});
		const result = await readStringValue(
			{ name: 'empty', value: '""', type: 'std::string', variablesReference: 99, indexedItems: 0 },
			makeContext(session),
		);
		assert.strictEqual(result, '');
		assert.strictEqual(variablesCalls, 0);
	});

	test('returns undefined when only non-char siblings are exposed (cppvsdbg fallback)', async () => {
		const session = makeSession(async (cmd) => cmd === 'variables' ? {
			variables: [
				{ name: '[size]', value: '300', type: 'unsigned __int64', variablesReference: 0 },
				{ name: '[capacity]', value: '300', type: 'unsigned __int64', variablesReference: 0 },
				{ name: '[allocator]', value: 'allocator', type: 'std::allocator<char>', variablesReference: 0 },
			],
		} : {});
		const result = await readStringValue(
			{ name: 'long_str', value: '"Lorem...aliqua...', type: 'std::string', variablesReference: 7, indexedItems: 300 },
			makeContext(session),
		);
		assert.strictEqual(result, undefined);
	});

	test('returns undefined when any char child value fails to parse', async () => {
		const session = makeSession(async (cmd) => cmd === 'variables' ? {
			variables: [
				{ name: '[0]', value: "72 'H'", type: 'char', variablesReference: 0 },
				{ name: '[1]', value: '???', type: 'char', variablesReference: 0 },
			],
		} : {});
		const result = await readStringValue(
			{ name: 's', value: '"..."', type: 'std::string', variablesReference: 7, indexedItems: 2 },
			makeContext(session),
		);
		assert.strictEqual(result, undefined);
	});

	test('pages large strings using start/count', async () => {
		const requested: Array<{ start: number; count: number }> = [];
		const session = makeSession(async (cmd, args) => {
			if (cmd === 'variables') {
				const a = args as { start: number; count: number };
				requested.push({ start: a.start, count: a.count });
				const items = Array.from({ length: a.count }, (_, i) => ({
					name: `[${a.start + i}]`,
					value: `${(97 + ((a.start + i) % 26))} 'x'`,
					type: 'char',
					variablesReference: 0,
				}));
				return { variables: items };
			}
			return {};
		});
		const result = await readStringValue(
			{ name: 's', value: '"..."', type: 'std::string', variablesReference: 7, indexedItems: 250 },
			makeContext(session, { pageSize: 100, maxArrayItems: 250 }),
		);
		assert.deepStrictEqual(requested.map(r => [r.start, r.count]), [[0, 100], [100, 100], [200, 50]]);
		assert.ok(result);
		assert.strictEqual(result.length, 250);
	});

	test('throws ReaderCancellationError when token is cancelled', async () => {
		const session = makeSession(async () => ({ variables: [] }));
		const token: vscode.CancellationToken = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose() { /* noop */ } }) } as unknown as vscode.CancellationToken;
		await assert.rejects(
			readStringValue({ name: 's', type: 'std::string', variablesReference: 1 }, makeContext(session, {}, token)),
			(err: unknown) => err instanceof ReaderCancellationError,
		);
	});
});

suite('debugCopy pure helpers', () => {
	test('readLimitsFromConfig reads from getter', () => {
		const cfg: Record<string, number> = { maxDepth: 5, maxVariables: 100, maxArrayItems: 10, variablePagingSize: 25 };
		const limits = readLimitsFromConfig(<T,>(key: string, def: T) => (cfg[key] as T) ?? def);
		assert.deepStrictEqual(limits, { maxDepth: 5, maxVariables: 100, maxArrayItems: 10, pageSize: 25 });
	});

	test('readLimitsFromConfig falls back to defaults', () => {
		const limits = readLimitsFromConfig(<T,>(_k: string, d: T) => d);
		assert.deepStrictEqual(limits, DEFAULT_LIMITS);
	});

	test('buildResultDocument collects warnings and truncated flag', () => {
		const data = { name: 'p', errors: ['x'], truncated: true } as never;
		const doc = buildResultDocument({ expression: 'p', sessionType: 'cppdbg', data, count: 7, now: new Date('2026-01-01T00:00:00Z') });
		assert.strictEqual(doc.schemaVersion, 1);
		assert.deepStrictEqual(doc.warnings, ['x']);
		assert.strictEqual(doc.truncated, true);
		assert.strictEqual(doc.nodeCount, 7);
		assert.strictEqual(doc.capturedAt, '2026-01-01T00:00:00.000Z');
	});

	test('buildResultDocument defaults empty warnings and false truncated', () => {
		const data = { name: 'p' } as never;
		const doc = buildResultDocument({ expression: 'p', sessionType: 'cppdbg', data, count: 1, now: new Date() });
		assert.deepStrictEqual(doc.warnings, []);
		assert.strictEqual(doc.truncated, false);
	});

	test('buildDefaultFileName sanitizes expression', () => {
		assert.strictEqual(buildDefaultFileName('person'), 'person.json');
		assert.strictEqual(buildDefaultFileName('my.var[0]'), 'my.var_0.json');
		assert.strictEqual(buildDefaultFileName('   '), 'debug-variable.json');
		assert.strictEqual(buildDefaultFileName('ptr->field'), 'ptr-_field.json');
		assert.strictEqual(buildDefaultFileName('a/b\\c?d'), 'a_b_c_d.json');
	});

	test('evaluateToVariable maps fields and defaults evaluateName', () => {
		const variable = evaluateToVariable('p', { result: '{}', type: 'P', variablesReference: 1, memoryReference: '0x1' });
		assert.strictEqual(variable.name, 'p');
		assert.strictEqual(variable.evaluateName, 'p');
		assert.strictEqual(variable.memoryReference, '0x1');
		const v2 = evaluateToVariable('p', { result: '{}', variablesReference: 0, evaluateName: 'p.x' });
		assert.strictEqual(v2.evaluateName, 'p.x');
	});
});

async function request<T>(session: vscode.DebugSession, command: string, args?: unknown): Promise<T> {
	return session.customRequest(command, args) as Promise<T>;
}

suite('copyVariableAsJson orchestration', () => {
	test('no session shows warning and returns', async () => {
		const deps = makeDeps({ session: undefined });
		await copyVariableAsJson(deps);
		assert.deepStrictEqual(deps.calls.warning, ['请先启动 C/C++ 调试会话。']);
		assert.strictEqual(deps.calls.clipboard.length, 0);
	});

	test('empty expression returns without warning', async () => {
		const session = makeSession(async () => ({}));
		const deps = makeDeps({ session, showInputBox: async () => undefined });
		await copyVariableAsJson(deps);
		assert.strictEqual(deps.calls.clipboard.length, 0);
		assert.strictEqual(deps.calls.warning.length, 0);
	});

	test('writes clipboard and shows info on success', async () => {
		const session = makeSessionWithType('cppdbg', async (cmd) => cmd === 'evaluate' ? { result: '42', type: 'int', variablesReference: 0 } : {});
		const deps = makeDeps({ session });
		await copyVariableAsJson(deps);
		assert.strictEqual(deps.calls.clipboard.length, 1);
		const payload = JSON.parse(deps.calls.clipboard[0]);
		assert.strictEqual(payload.expression, 'person');
		assert.strictEqual(payload.sessionType, 'cppdbg');
		assert.strictEqual(payload.data.value, '42');
		assert.deepStrictEqual(deps.calls.info, [`已复制变量 person（1 个节点）`]);
	});

	test('evaluate error shows error message', async () => {
		const session = makeSession(async () => { throw new Error('eval failed'); });
		const deps = makeDeps({ session });
		await copyVariableAsJson(deps);
		assert.deepStrictEqual(deps.calls.error, ['读取调试变量失败：eval failed']);
	});

	test('cancellation error name is treated as cancel and does not error', async () => {
		const session = makeSession(async () => { const e = new Error('cancelled'); e.name = 'CancellationError'; throw e; });
		const deps = makeDeps({ session });
		await copyVariableAsJson(deps);
		assert.strictEqual(deps.calls.error.length, 0);
		assert.strictEqual(deps.calls.clipboard.length, 0);
	});

	test('non-Error throwable is stringified', async () => {
		const session = makeSession(async () => { throw new Error('string-error'); });
		const deps = makeDeps({ session });
		await copyVariableAsJson(deps);
		assert.deepStrictEqual(deps.calls.error, ['读取调试变量失败：string-error']);
	});
});

suite('saveVariableAsJson orchestration', () => {
	test('writes file at selected path on success', async () => {
		const session = makeSession(async (cmd) => cmd === 'evaluate' ? { result: '0', type: 'int', variablesReference: 0 } : {});
		const deps = makeDeps({ session, showSaveDialog: async () => '/tmp/x.json' });
		await saveVariableAsJson(deps);
		assert.strictEqual(deps.calls.files.length, 1);
		assert.strictEqual(deps.calls.files[0].path, '/tmp/x.json');
		const json = JSON.parse(Buffer.from(deps.calls.files[0].content).toString('utf8'));
		assert.strictEqual(json.expression, 'person');
		assert.deepStrictEqual(deps.calls.info, [`已保存到 /tmp/x.json`]);
	});

	test('cancel save dialog returns without writing', async () => {
		const session = makeSession(async (cmd) => cmd === 'evaluate' ? { result: '0', type: 'int', variablesReference: 0 } : {});
		const deps = makeDeps({ session, showSaveDialog: async () => undefined });
		await saveVariableAsJson(deps);
		assert.strictEqual(deps.calls.files.length, 0);
		assert.strictEqual(deps.calls.info.length, 0);
	});

	test('save with no session shows warning', async () => {
		const deps = makeDeps({ session: undefined });
		await saveVariableAsJson(deps);
		assert.deepStrictEqual(deps.calls.warning, ['请先启动 C/C++ 调试会话。']);
	});

	test('save error shows error message', async () => {
		const session = makeSession(async () => { throw new Error('write fail'); });
		const deps = makeDeps({ session });
		await saveVariableAsJson(deps);
		assert.deepStrictEqual(deps.calls.error, ['保存调试变量失败：write fail']);
	});

	test('save with cancellation does not error', async () => {
		const session = makeSession(async () => { const e = new Error('cancelled'); e.name = 'CancellationError'; throw e; });
		const deps = makeDeps({ session });
		await saveVariableAsJson(deps);
		assert.strictEqual(deps.calls.error.length, 0);
	});
});

suite('debug variables context menu', () => {
	const menuContext = (variable: Record<string, unknown>, sessionId?: string) => ({
		sessionId,
		container: { name: 'Locals', variablesReference: 1 },
		variable,
	}) as unknown as VariableMenuContext;

	test('isVariableMenuContext accepts VS Code menu argument', () => {
		assert.strictEqual(isVariableMenuContext(menuContext({ name: 'alice', variablesReference: 5 })), true);
	});

	test('isVariableMenuContext rejects palette invocation and malformed arguments', () => {
		assert.strictEqual(isVariableMenuContext(undefined), false);
		assert.strictEqual(isVariableMenuContext(null), false);
		assert.strictEqual(isVariableMenuContext({}), false);
		assert.strictEqual(isVariableMenuContext({ variable: 'alice' }), false);
		assert.strictEqual(isVariableMenuContext({ variable: { name: 1 } }), false);
	});

	test('menuContextToVariable keeps known DAP fields only', () => {
		const variable = menuContextToVariable(menuContext({
			name: 'alice',
			value: '{name="" age=0}',
			type: 'Person',
			evaluateName: 'alice',
			variablesReference: 5,
			memoryReference: '0x7ffd',
			presentationHint: { kind: 'data' },
		}));
		assert.deepStrictEqual(variable, {
			name: 'alice',
			value: '{name="" age=0}',
			type: 'Person',
			evaluateName: 'alice',
			variablesReference: 5,
			memoryReference: '0x7ffd',
			indexedItems: undefined,
			namedVariables: undefined,
		});
	});

	test('copy from menu skips evaluate and expands the clicked variable', async () => {
		const commands: string[] = [];
		const session = makeSessionWithType('cppdbg', async (cmd, args) => {
			commands.push(cmd);
			if (cmd === 'variables' && (args as { variablesReference: number }).variablesReference === 5) {
				return { variables: [{ name: 'age', value: '42', type: 'int', variablesReference: 0 }] };
			}
			return { variables: [] };
		});
		const deps = makeDeps({ session, showInputBox: async () => { throw new Error('should not prompt'); } });
		await copyVariableAsJson(deps, menuContext({ name: 'alice', value: '{...}', type: 'Person', evaluateName: 'alice', variablesReference: 5 }));
		assert.ok(!commands.includes('evaluate'));
		const payload = JSON.parse(deps.calls.clipboard[0]);
		assert.strictEqual(payload.source, 'variables');
		assert.strictEqual(payload.expression, 'alice');
		assert.strictEqual(payload.data.type, 'Person');
		assert.strictEqual(payload.data.children.age.value, '42');
		assert.deepStrictEqual(deps.calls.info, ['已复制变量 alice（2 个节点）']);
	});

	test('copy from menu uses evaluateName for nested fields', async () => {
		const session = makeSession(async () => ({ variables: [] }));
		const deps = makeDeps({ session });
		await copyVariableAsJson(deps, menuContext({ name: 'city', value: '"Berlin"', evaluateName: 'alice.address.city', variablesReference: 0 }));
		const payload = JSON.parse(deps.calls.clipboard[0]);
		assert.strictEqual(payload.expression, 'alice.address.city');
		assert.strictEqual(payload.data.name, 'city');
		assert.strictEqual(payload.nodeCount, 1);
	});

	test('copy from menu falls back to variable name when evaluateName is absent', async () => {
		const session = makeSession(async () => ({ variables: [] }));
		const deps = makeDeps({ session });
		await copyVariableAsJson(deps, menuContext({ name: 'alice', variablesReference: 0 }));
		assert.strictEqual(JSON.parse(deps.calls.clipboard[0]).expression, 'alice');
	});

	test('copy from menu resolves the owning session by sessionId', async () => {
		const active = makeSessionWithType('node', async () => { throw new Error('wrong session'); });
		const owner = makeSessionWithType('cppdbg', async () => ({ variables: [] }));
		const deps = makeDeps({ session: active, sessionsById: { 'session-2': owner } });
		await copyVariableAsJson(deps, menuContext({ name: 'alice', variablesReference: 0 }, 'session-2'));
		assert.strictEqual(JSON.parse(deps.calls.clipboard[0]).sessionType, 'cppdbg');
	});

	test('copy from menu falls back to the active session for unknown sessionId', async () => {
		const active = makeSessionWithType('cppdbg', async () => ({ variables: [] }));
		const deps = makeDeps({ session: active, sessionsById: {} });
		await copyVariableAsJson(deps, menuContext({ name: 'alice', variablesReference: 0 }, 'gone'));
		assert.strictEqual(JSON.parse(deps.calls.clipboard[0]).sessionType, 'cppdbg');
	});

	test('copy from menu without any session warns', async () => {
		const deps = makeDeps({ session: undefined });
		await copyVariableAsJson(deps, menuContext({ name: 'alice', variablesReference: 0 }, 'gone'));
		assert.deepStrictEqual(deps.calls.warning, ['请先启动 C/C++ 调试会话。']);
		assert.strictEqual(deps.calls.clipboard.length, 0);
	});

	test('copy from menu reports variables request failure', async () => {
		const session = makeSession(async () => { throw new Error('read fail'); });
		const deps = makeDeps({ session });
		await copyVariableAsJson(deps, menuContext({ name: 'alice', variablesReference: 5 }));
		assert.strictEqual(deps.calls.clipboard.length, 1);
		assert.deepStrictEqual(JSON.parse(deps.calls.clipboard[0]).warnings, ['read fail']);
	});

	test('save from menu names the file after the evaluate name', async () => {
		const session = makeSession(async () => ({ variables: [] }));
		const names: string[] = [];
		const deps = makeDeps({
			session,
			showInputBox: async () => { throw new Error('should not prompt'); },
			showSaveDialog: async (name: string) => { names.push(name); return '/tmp/alice.json'; },
		});
		await saveVariableAsJson(deps, menuContext({ name: '[0]', evaluateName: 'people[0]', variablesReference: 0 }));
		assert.deepStrictEqual(names, ['people_0.json']);
		assert.strictEqual(deps.calls.files.length, 1);
		assert.strictEqual(JSON.parse(Buffer.from(deps.calls.files[0].content).toString('utf8')).source, 'variables');
	});
});
