import * as assert from 'assert';
import type * as vscode from 'vscode';
import { DapVariable, ReaderCancellationError, getCharKind, isDapVariable, isStringLikeType, parseCharUnits, parseCppvsdbgByteDump, readStringValue, readVariableTree } from '../variableReader';
import { makeContext, makeSession, request } from './helpers';

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
		// std::byte 指针与定长数组（PMR 背书缓冲等场景）
		'std::byte[2048]',
		'const std::byte[2048]',
		'std::byte *',
		'const std::byte *',
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
		// 父 node 在展开 children 后会丢掉 value；name 还有更深的 size 子节点，
		// 所以这里也应该是 undefined。age/size 是叶子（variablesReference: 0），
		// 它们的 value 保留。
		assert.strictEqual(data.value, undefined, 'root with children should drop value');
		assert.strictEqual(data.children?.name.value, undefined, 'name has size child so its value is dropped');
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
			// 或根本无子节点），此时不应重建字符串，也不应让内部字段泄漏；
			// adapter 的截断 preview（或 std::byte[N] 的字节 dump）也不应作为
			// 叶子 value 保留——string-like 节点只有 value, value 必须是 string 本身。
			let variablesCalls = 0;
			const session = makeSession(async (cmd) => {
				if (cmd === 'variables') { variablesCalls++; }
				return { variables: [{ name: '[size]', value: '0', type: 'unsigned __int64', variablesReference: 0 }] };
			});
			const node = await readVariableTree({ name: 's', value: c.value, type: c.type, variablesReference: 42 }, makeContext(session));
			assert.strictEqual(node.children, undefined, `${c.type} should not expose children`);
			assert.strictEqual(node.value, undefined, `${c.type} should drop adapter value when no char children`);
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

	test('treats std::byte[N] as a leaf and reconstructs UTF-8 from byte children', async () => {
		const session = makeSession(async (cmd) => cmd === 'variables' ? {
			variables: [
				{ name: '[0]', value: "72 'H'", type: 'std::byte', variablesReference: 0 },
				{ name: '[1]', value: "105 'i'", type: 'std::byte', variablesReference: 0 },
				// cppvsdbg 偶发把多字节 UTF-8 塞进一个子节点
				{ name: '[2]', value: "'\\xE4\\xBD\\xA0'", type: 'std::byte', variablesReference: 0 },
				{ name: '[3]', value: "33 '!'", type: 'std::byte', variablesReference: 0 },
			],
		} : {});
		const node = await readVariableTree(
			{ name: 'pmr_buf', value: '0x555555 {...}', type: 'std::byte[2048]', variablesReference: 7, indexedItems: 4 },
			makeContext(session),
		);
		// 应当从 std::byte 子节点重建为 UTF-8 字符串，而不是再展开 2048 个子节点。
		assert.strictEqual(node.value, 'Hi你!');
		assert.strictEqual(node.children, undefined);
	});

	test('decodes std::byte[N] value from cppvsdbg byte dump preview', async () => {
		const session = makeSession(async (cmd) => cmd === 'variables' ? { variables: [] } : {});
		const node = await readVariableTree(
			{ name: 'pmr_buf', value: "0x000000827AAFED60 {72 'H', 105 'i', 33 '!'}", type: 'std::byte[2048]', variablesReference: 7, indexedItems: 4 },
			makeContext(session),
		);
		// cppvsdbg 对 std::byte[N] 不暴露 byte 子节点，而是把字节 dump 直接放进
		// value 字段（`0x... {<byte>, <byte>, ..., ...}`）。string-like 节点只有 value,
		// value 必须是 string 本身，所以从 dump 解析出字节并按 UTF-8 解码。
		assert.strictEqual(node.value, 'Hi!');
		assert.strictEqual(node.children, undefined);
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
		for (const variablesReference of [99, 0]) {
			const node = await readVariableTree(
				{ name: 'empty', value: '""', type: 'std::string', variablesReference, indexedItems: 0 },
				makeContext(session),
			);
			assert.strictEqual(node.value, '');
			assert.strictEqual(node.children, undefined);
		}
		assert.strictEqual(variablesCalls, 0, 'empty string must not trigger a variables request');
	});

	test('drops adapter value when std::string exposes no char children', async () => {
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
		// string-like 节点只有 value, value 必须是 string 本身；
		// 重建不出完整字符串时丢弃 adapter 的截断 preview，
		// 也不暴露内部 [size]/[capacity]/[allocator] 等结构。
		assert.strictEqual(node.value, undefined);
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

	test('skips _Mylast/_Myend dereference in MSVC vector raw view', async () => {
		// 模拟 cppvsdbg 对 std::vector 暴露的内部指针。`_Myfirst` 是合法可解引用
		// 的首元素指针，`_Mylast` / `_Myend` 是 one-past-end / capacity-end，
		// 对其解引用是 UB。buggy 适配器会把 UB 内存当字段返回，并在它们"内部"的
		// 子 vector / 子结构继续爆开，导致节点数与字段值全面失真。
		const childCalls: number[] = [];
		const session = makeSession(async (cmd, args) => {
			if (cmd !== 'variables') { return {}; }
			const ref = (args as { variablesReference: number }).variablesReference;
			childCalls.push(ref);
			if (ref === 1) {
				// vector 顶层：[capacity] / [allocator] / [Raw View]（含 _Myfirst/_Mylast/_Myend）
				return {
					variables: [
						{ name: '[capacity]', value: '3', type: 'unsigned __int64', variablesReference: 0 },
						{ name: '[allocator]', value: 'allocator', type: 'std::allocator<Person>', variablesReference: 0 },
						{ name: '[Raw View]', value: '', type: 'std::_Vector_val<std::_Simple_types<Person>>', variablesReference: 2 },
					],
				};
			}
			if (ref === 2) {
				// _Vector_val：三个裸指针
				return {
					variables: [
						{ name: '_Myfirst', value: '0x000001a4341aa800', type: 'Person *', variablesReference: 10 },
						{ name: '_Mylast', value: '0x000001a4341aa818', type: 'Person *', variablesReference: 11 },
						{ name: '_Myend', value: '0x000001a4341aa818', type: 'Person *', variablesReference: 12 },
					],
				};
			}
			if (ref === 10) {
				// 合法的首元素——应继续展开
				return {
					variables: [
						{ name: 'name', value: '"Alice"', type: 'std::string', variablesReference: 0 },
						{ name: 'age', value: '29', type: 'int', variablesReference: 0 },
					],
				};
			}
			if (ref === 11 || ref === 12) {
				// 模拟 cppvsdbg 把 UB 内存当作 Person 暴露的垃圾子节点。
				// 任何针对这两个 ref 的子请求都不应发生。
				throw new Error(`unexpected recursion into one-past-end iterator (ref=${ref})`);
			}
			return { variables: [] };
		});
		const ctx = makeContext(session);
		const data = await readVariableTree({ name: 'people', type: 'std::vector<Person>', variablesReference: 1, indexedItems: 3 }, ctx);
		const raw = data.children?.['[Raw View]'];
		assert.ok(raw, '[Raw View] should be present');
		const first = raw.children?._Myfirst;
		const last = raw.children?._Mylast;
		const end = raw.children?._Myend;
		// _Myfirst 是合法的：仍递归
		assert.ok(first?.children?.name, '_Myfirst must keep being expanded');
		assert.strictEqual(first?.children?.age?.value, '29');
		// _Mylast / _Myend：保留指针 hex 值但不解引用
		assert.strictEqual(last?.value, '0x000001a4341aa818');
		assert.strictEqual(last?.children, undefined, '_Mylast must not be dereferenced');
		assert.strictEqual(end?.value, '0x000001a4341aa818');
		assert.strictEqual(end?.children, undefined, '_Myend must not be dereferenced');
		// 计数只计入"已访问"的节点（_Mylast/_Myend 算 1，不再算它们子树）
		assert.ok(!childCalls.includes(11), 'must not issue variables request for _Mylast');
		assert.ok(!childCalls.includes(12), 'must not issue variables request for _Myend');
	});
});

suite('getCharKind', () => {
	const cases: Array<{ type: string | undefined; expected: 'utf8' | 'utf16' | 'utf32' | 'unknown' }> = [
		// utf8
		{ type: 'char', expected: 'utf8' },
		{ type: 'const char', expected: 'utf8' },
		{ type: 'unsigned char', expected: 'utf8' },
		{ type: 'char8_t', expected: 'utf8' },
		{ type: 'std::byte', expected: 'utf8' },
		{ type: 'const std::byte', expected: 'utf8' },
		// utf16
		{ type: 'char16_t', expected: 'utf16' },
		{ type: 'const char16_t', expected: 'utf16' },
		// utf32
		{ type: 'char32_t', expected: 'utf32' },
		// wchar_t 跟随宿主平台
		{ type: 'wchar_t', expected: process.platform === 'win32' ? 'utf16' : 'utf32' },
		// 不可识别
		{ type: 'int', expected: 'unknown' },
		{ type: undefined, expected: 'unknown' },
		{ type: '', expected: 'unknown' },
	];
	for (const c of cases) {
		test(`classifies ${c.type === undefined ? 'undefined' : JSON.stringify(c.type)}`, () => {
			assert.strictEqual(getCharKind(c.type), c.expected);
		});
	}
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

suite('parseCppvsdbgByteDump', () => {
	test('extracts bytes from cppvsdbg byte dump with address prefix', () => {
		assert.deepStrictEqual(
			parseCppvsdbgByteDump("0x000000827AAFED60 {72 'H', 105 'i', 33 '!'}"),
			[72, 105, 33],
		);
	});

	test('extracts bytes from cppvsdbg byte dump without address prefix', () => {
		assert.deepStrictEqual(
			parseCppvsdbgByteDump("{72 'H', 105 'i', 33 '!'}"),
			[72, 105, 33],
		);
	});

	test('decodes hex-escaped glyphs and skips truncation marker', () => {
		// 末尾的 `...,` 是截断标记，应跳过；中间的 `'\xf'` 由 parseCharUnits 解析。
		assert.deepStrictEqual(
			parseCppvsdbgByteDump("{168 '�', 232 '�', 15 '\\xf', 0 '\\0', ..., ...}"),
			[168, 232, 15, 0],
		);
	});

	test('returns empty array for empty braces', () => {
		assert.deepStrictEqual(parseCppvsdbgByteDump('{}'), []);
		assert.deepStrictEqual(parseCppvsdbgByteDump('0x000000827AAFED60 {}'), []);
	});

	test('returns undefined for non-byte-dump input', () => {
		assert.strictEqual(parseCppvsdbgByteDump('"hello"'), undefined);
		assert.strictEqual(parseCppvsdbgByteDump('0x555555 "hello"'), undefined);
		assert.strictEqual(parseCppvsdbgByteDump('garbage'), undefined);
		assert.strictEqual(parseCppvsdbgByteDump(''), undefined);
	});

	test('returns undefined when any entry cannot be parsed', () => {
		// "{0}" 单独一个数字没有 glyph 形式，parseCharUnits 解析不了。
		assert.strictEqual(parseCppvsdbgByteDump('{0, 1, 2}'), undefined);
	});
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