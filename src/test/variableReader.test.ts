import * as assert from 'assert';
import type * as vscode from 'vscode';
import { DapVariable, ReaderCancellationError, formatByteAsCppvsdbg, getCharKind, isDapVariable, isStringLikeType, parseCharUnits, parseCppvsdbgByteDump, readStringValue, readVariableTree } from '../variableReader';
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
			// 没有 char 子节点时走不通 reconstruction；先前会删掉 value 然后 return，
			// 留下一个全空节点。现在改成落到通用分支把 children 展出来，让用户能看到
			// cppvsdbg 实际给的字段名/值（典型如 [size] / [capacity] / [allocator]
			// 或 std::pmr::basic_string 的 _Mysize / _Myres / _Altr），用来定位
			// "为什么重建不出来"。
			let variablesCalls = 0;
			const session = makeSession(async (cmd) => {
				if (cmd === 'variables') { variablesCalls++; }
				return { variables: [{ name: '[size]', value: '0', type: 'unsigned __int64', variablesReference: 0 }] };
			});
			const node = await readVariableTree({ name: 's', value: c.value, type: c.type, variablesReference: 42 }, makeContext(session));
			assert.strictEqual(node.value, undefined, `${c.type} should drop adapter value when no char children`);
			assert.ok(node.children, `${c.type} should expose adapter children when reconstruction fails`);
			assert.ok(node.children?.['[size]'], `${c.type} should preserve [size] child for diagnosis`);
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

	test('materializes std::byte[N] cppvsdbg byte dump as virtual children', async () => {
		// cppvsdbg 对 std::byte[N] 偶尔不展开 byte 子节点而是把字节 dump 直接放进
		// value 字段（`0x... {<byte>, <byte>, ...}`）。reader 把这些 entry 抽出来
		// 当作 std::byte 虚拟 children——跟 IDE Variables panel 手动展开后看到的
		// `[0] = 72 'H'` 等是同一种形态，调用方不再需要走 readMemory / evaluate
		// refresh 那两条不稳定的绕路。
		const session = makeSession(async (cmd) => cmd === 'variables' ? { variables: [] } : {});
		const node = await readVariableTree(
			{ name: 'pmr_buf', value: "0x000000827AAFED60 {72 'H', 105 'i', 33 '!'}", type: 'std::byte[2048]', variablesReference: 7, indexedItems: 4 },
			makeContext(session),
		);
		assert.strictEqual(node.value, undefined, 'byte buffer must not carry both value and children');
		assert.ok(node.children, 'byte buffer should expose its dump as virtual children');
		assert.strictEqual(Object.keys(node.children ?? {}).length, 3);
		assert.strictEqual(node.children?.['[0]']?.value, "72 'H'");
		assert.strictEqual(node.children?.['[0]']?.type, 'std::byte');
		assert.strictEqual(node.children?.['[1]']?.value, "105 'i'");
		assert.strictEqual(node.children?.['[2]']?.value, "33 '!'");
	});

	test('reads every byte of std::byte[N] even when indexedItems exceeds maxArrayItems', async () => {
		// PMR 背书缓冲典型是 `std::byte[2048]` 这种"长度已知、内容当二进制读"的类型。
		// cppvsdbg 把全部 N 个 std::byte 子节点展开；readStringValue 必须绕过
		// maxArrayItems（默认 1000）才能拿到剩下的 1048 字节，否则只能依赖 cppvsdbg
		// 给的 ~16 字节 truncated preview，2048 - 16 ≈ 2032 字节静默丢。
		const total = 2048;
		const bytes = Array.from({ length: total }, (_, i) => i % 256);
		const session = makeSession(async (cmd, args) => {
			if (cmd !== 'variables') { return {}; }
			const a = args as { start: number; count: number };
			const items = Array.from({ length: Math.min(a.count, total - a.start) }, (_, i) => ({
				name: `[${a.start + i}]`,
				value: `${bytes[a.start + i]} 'x'`,
				type: 'std::byte',
				variablesReference: 0,
			}));
			return { variables: items };
		});
		const decoded = await readStringValue(
			{ name: 'pmr_buf', type: 'std::byte[2048]', variablesReference: 7, indexedItems: total },
			makeContext(session, { pageSize: 100, maxArrayItems: 1000 }),
		);
		assert.ok(decoded, 'should reconstruct every byte, not just the first 1000');
		assert.strictEqual(decoded.length, total, 'all 2048 bytes must round-trip through UTF-8 decode (modulo control bytes lost as Unicode replacements)');
	});

	test('pmr_buf-style byte buffer reconstructs past maxArrayItems through DAP variables', async () => {
		// 端到端：模拟 demo 里 pmr_buf（std::byte[2048]，cppvsdbg 给完整 N 个 byte 子节点），
		// readVariableTree 必须把所有 2048 字节拼回来，不能在被 maxArrayItems 卡住后退化成
		// 半截 cppvsdbg 字节 dump 预览。
		const total = 2048;
		const bytes = new Uint8Array(total);
		// 头一段塞点非零内容模拟 PMR 池里实际写入的字节
		for (let i = 0; i < 200; i++) { bytes[i] = (i * 7 + 1) & 0xff; }
		const session = makeSession(async (cmd, args) => {
			if (cmd !== 'variables') { return {}; }
			const a = args as { start: number; count: number };
			const items = Array.from({ length: Math.min(a.count, total - a.start) }, (_, i) => ({
				name: `[${a.start + i}]`,
				value: `${bytes[a.start + i]} 'x'`,
				type: 'std::byte',
				variablesReference: 0,
			}));
			return { variables: items };
		});
		const node = await readVariableTree(
			{ name: 'pmr_buf', value: "0x000000a7692fe820 {..., ...}", type: 'std::byte[2048]', variablesReference: 7, indexedItems: total },
			makeContext(session, { pageSize: 100, maxArrayItems: 1000 }),
		);
		assert.ok(node.value, 'pmr_buf should rebuild a value out of all 2048 byte children, not the truncated preview');
		assert.strictEqual(node.type, 'std::byte[2048]');
		assert.strictEqual(node.children, undefined);
	});

	test('materialises folded std::byte[N] via DAP evaluate using MSVC format specifiers', async () => {
		// cppvsdbg 在首屏对 std::byte[2048] 这种"全是二进制"字段默认折叠——只回
		// 字节 dump 预览进 value、不带 variablesReference。如果 DAP `readMemory`
		// 也不支持（DAP spec 字段 `data` 在老 cppvsdbg 里没实现），reader 退到
		// `evaluate` 试若干 MSVC format specifier（`,N` pointer size hint、
		// `,!` raw 格式、`,s8` UTF-8 字符串）——任一让 cppvsdbg 在 result 字符串里
		// 把完整 2048 byte dump 出来，reader 解析后物化 N 个虚拟 child。旧版用
		// `,e` 当 expand 是错的（MSVC spec 里 `,e` 是 float sci notation）。
		const total = 2048;
		const bytes = new Uint8Array(total);
		for (let i = 0; i < total; i++) { bytes[i] = (i * 7 + 1) & 0xff; }
		const calls: string[] = [];
		const session = makeSession(async (cmd, args) => {
			calls.push(cmd);
			if (cmd === 'evaluate') {
				const expr = (args as { expression: string }).expression;
				// 模拟 cppvsdbg 对 `pmr_buf,2048` 把完整 byte dump 给到 result：
				// 返回的 result 必须包含全部 2048 条 entry，reader 才能物化所有 child。
				if (expr.includes(',2048') || expr.endsWith(',!') || expr.endsWith(',s8')) {
					const entries = Array.from(bytes, (b) => formatByteAsCppvsdbg(b)).join(', ');
					return {
						result: `0x000000385713ECD0 {${entries}}`,
						type: 'std::byte[2048]',
						// 注意：不带 variablesReference——reader 必须从 result 字符串
						// 解析出完整 byte dump 而不是去查 paginated variables。
					};
				}
				// 默认 evaluate（无 specifier）只给 truncated preview
				return {
					result: "0x000000385713ECD0 {104 'h', 19 '\\x13', 87 'W', 56 '8', 0 '\\0', 0 '\\0', 0 '\\0', 0 '\\0', 0 '\\0', ..., ...}",
					type: 'std::byte[2048]',
				};
			}
			return {};
		});
		const node = await readVariableTree(
			{
				name: 'pmr_buf',
				value: "0x000000385713ECD0 {104 'h', 19 '\\x13', 87 'W', 56 '8', 0 '\\0', 0 '\\0', 0 '\\0', 0 '\\0', 0 '\\0', ..., ...}",
				type: 'std::byte[2048]',
				evaluateName: 'strings.pmr_buf',
				memoryReference: '0x000000385713ECD0',
			},
			makeContext(session, { pageSize: 100, maxArrayItems: 1000 }),
		);
		assert.ok(calls.includes('evaluate'), 'must consult evaluate when readMemory is unavailable');
		assert.strictEqual(node.value, undefined, 'byte buffer must not carry both value and children');
		assert.ok(node.children, 'must expose all 2048 bytes as virtual children');
		assert.strictEqual(Object.keys(node.children ?? {}).length, total, `must expose all ${total} bytes from evaluated byte dump`);
		assert.strictEqual(node.children?.['[0]']?.value, formatByteAsCppvsdbg(bytes[0]!));
		assert.strictEqual(node.children?.['[1024]']?.value, formatByteAsCppvsdbg(bytes[1024]!));
		assert.strictEqual(node.children?.['[2047]']?.value, formatByteAsCppvsdbg(bytes[2047]!));
	});

	test('per-index DAP evaluate iterates all 2048 byte children of std::byte[N]', async () => {
		// pmr_buf 这种 cppvsdbg 折叠的 std::byte[2048]，readMemory 在某些 session
		// 不工作、evaluate refresh 也拿不到 ref、但 IDE 里手动展开能看到全部 2048 个
		// 字节——reader 用 `${name}[i]` 形式 per-index evaluate 把所有 child 拉出来，
		// 跟 IDE Variables 面板展开后是同一份数据。
		const total = 2048;
		const bytes = new Uint8Array(total);
		for (let i = 0; i < total; i++) { bytes[i] = i & 0xff; }
		const calls: string[] = [];
		const session = makeSession(async (cmd, args) => {
			calls.push(cmd);
			if (cmd === 'evaluate') {
				const expr = (args as { expression: string }).expression;
				const m = /\[(\d+)\]/.exec(expr);
				const i = m ? parseInt(m[1], 10) : -1;
				if (i >= 0 && i < total) {
					return { result: `${bytes[i]} 'x'`, type: 'std::byte' };
				}
				// refresh via evaluate (no bracket): refuse variablesReference
				return { result: "0x... {..., ...}", type: 'std::byte[2048]' };
			}
			return {};
		});
		const node = await readVariableTree(
			{
				name: 'pmr_buf',
				value: "0x0000004BB7AFE7A0 {216 '', 230 '', 111 'o', 211 '', ..., ...}",
				type: 'std::byte[2048]',
				evaluateName: 'strings.pmr_buf',
				memoryReference: '0x0000004BB7AFE7A0',
				indexedItems: total,
			},
			makeContext(session, { pageSize: 100, maxArrayItems: 1000 }),
		);
		// 整张表 2048 个 children 都得在；最后一轮 children 加载完就退出。
		assert.strictEqual(node.value, undefined);
		assert.strictEqual(Object.keys(node.children ?? {}).length, total);
		assert.strictEqual(node.children?.['[0]']?.value, "0 'x'");
		assert.strictEqual(node.children?.['[256]']?.value, `${bytes[256]} 'x'`);
		assert.strictEqual(node.children?.['[2047]']?.value, `${bytes[2047]} 'x'`);
	});

	test('falls back to truncated dump entries when per-index evaluate fails', async () => {
		// per-index evaluate 也失败时（cppvsdbg 把 `${name}[i]` 直接 reject），退回
		// truncated dump 那 10 条 entry 作为虚拟 children——这是接口能拿到的所有数据。
		const session = makeSession(async (cmd) => {
			if (cmd === 'evaluate') { return { result: '', type: 'std::byte[2048]' }; }
			return {};
		});
		const raw = "0x0000004BB7AFE7A0 {56 '8', 231 '', 156 '', 135 '', 75 'K', 0 '\\0', 0 '\\0', 0 '\\0', 0 '\\0', 0 '\\0', ..., ...}";
		const node = await readVariableTree(
			{
				name: 'pmr_buf',
				value: raw,
				type: 'std::byte[2048]',
				evaluateName: 'strings.pmr_buf',
				memoryReference: '0x0000004BB7AFE7A0',
			},
			makeContext(session),
		);
		assert.strictEqual(node.value, undefined, 'byte buffer must not carry both value and children');
		assert.ok(node.children);
		// per-index evaluate 全返回空 result → 第一条就 break，accumulator 永远为空；
		// iterateByteBufferChildren 返回 undefined → 落到 byte dump fallback。
		assert.strictEqual(Object.keys(node.children ?? {}).length, 10);
		assert.strictEqual(node.children?.['[0]']?.value, "56 '8'");
		assert.strictEqual(node.children?.['[4]']?.value, "75 'K'");
		assert.strictEqual(node.children?.['[5]']?.value, "0 '\\0'");
	});

	test('non-byte string-like still decodes cppvsdbg byte dump to UTF-8', async () => {
		// std::byte[N] / std::byte * 现在走"虚拟 children"路径；其它 string-like
		// 类型（`char *` / `const char *` / `wchar_t *` 等通过 `,s8` 这种 format spec
		// 也可能拿到字节 dump 形态）继续走原本的 UTF-8 decode 兜底，避免 std::byte 的
		// 行为扩散到真正的文本字符串。
		const session = makeSession(async () => ({}));
		const node = await readVariableTree(
			{
				name: 'short_sso',
				value: "0x000000385713ECD0 {72 'H', 105 'i', 33 '!'}",
				type: 'const char *',
				evaluateName: 'strings.short_sso',
			},
			makeContext(session),
		);
		assert.strictEqual(node.value, 'Hi!');
		assert.strictEqual(node.children, undefined);
	});

	test('reads std::byte[N] via DAP readMemory and synthesises all bytes as virtual children', async () => {
		// cppvsdbg 折叠的 std::byte[2048] 没有 variablesReference、也没有子节点——
		// 上一版走 readMemory 拿到 raw bytes 后做 UTF-8 decode，对二进制 buffer 是错的
		// （只有前几个 ASCII-ish 字节解出来）。正确做法：直接按 cppvsdbg "<dec> '<glyph>'"
		// 形态物化成 N 个虚拟 child，跟 IDE Variables 面板展开看到的 [0]..[2047]
		// 完全一致；UTF-8 decode 那条仅保留给 char[N] / char * 文本类兜底。
		const total = 2048;
		const bytes = new Uint8Array(total);
		for (let i = 0; i < total; i++) { bytes[i] = (i * 7 + 1) & 0xff; }
		let base64: string;
		if (typeof Buffer !== 'undefined') {
			base64 = Buffer.from(bytes).toString('base64');
		} else {
			let bin = '';
			for (let i = 0; i < bytes.length; i++) { bin += String.fromCharCode(bytes[i]!); }
			base64 = btoa(bin);
		}
		const calls: string[] = [];
		const session = makeSession(async (cmd, args) => {
			calls.push(cmd);
			if (cmd === 'readMemory') {
				// DAP spec：响应 body 用 `data` 字段携带 base64 bytes（`address` 是
				// 起始地址，`unreadableBytes` 是末段不可读字节数）。部分 adapter
				// 历史上用 `bytes` 别名——reader 必须两个都接受，下一条测试覆盖
				// 别名路径。
				return { address: '0x0000004BB7AFE7A0', data: base64, unreadableBytes: 0 };
			}
			return {};
		});
		const node = await readVariableTree(
			{
				name: 'pmr_buf',
				value: "0x0000004BB7AFE7A0 {..., ...}",
				type: 'std::byte[2048]',
				evaluateName: 'strings.pmr_buf',
				memoryReference: '0x0000004BB7AFE7A0',
			},
			makeContext(session),
		);
		assert.ok(calls.includes('readMemory'), 'readMemory should be tried when memoryReference is set');
		assert.ok(!calls.includes('evaluate'), 'evaluate should be skipped when readMemory succeeds');
		assert.strictEqual(node.value, undefined, 'byte buffer must not carry both value and children');
		assert.ok(node.children, 'byte buffer should expose its raw bytes as virtual children');
		assert.strictEqual(Object.keys(node.children ?? {}).length, total, `must expose all ${total} bytes, not a truncated subset`);
		for (let i = 0; i < total; i++) {
			const child: { name: string; value?: string; type?: string } | undefined = node.children?.[`[${i}]`];
			assert.ok(child, `child [${i}] should exist`);
			assert.strictEqual(child!.type, 'std::byte');
			assert.strictEqual(child!.value, formatByteAsCppvsdbg(bytes[i]!), `[${i}] should be formatted as cppvsdbg "<dec> '<glyph>'"`);
		}
	});

	test('readMemory accepts `bytes` alias for adapters that do not follow DAP spec field name', async () => {
		// DAP spec 把 base64 字段叫 `data`。但部分 adapter（包括较旧版本的
		// cppvsdbg）历史上用 `bytes` 别名——为了兼容，reader 必须两个都接受。
		const bytes = new Uint8Array([0x41, 0x00, 0x42]);
		let base64: string;
		if (typeof Buffer !== 'undefined') {
			base64 = Buffer.from(bytes).toString('base64');
		} else {
			let bin = '';
			for (let i = 0; i < bytes.length; i++) { bin += String.fromCharCode(bytes[i]!); }
			base64 = btoa(bin);
		}
		const session = makeSession(async (cmd) => {
			if (cmd === 'readMemory') { return { bytes: base64 }; }
			return {};
		});
		const node = await readVariableTree(
			{ name: 'b', type: 'std::byte[3]', memoryReference: '0x1', value: '' },
			makeContext(session),
		);
		assert.strictEqual(Object.keys(node.children ?? {}).length, 3);
		assert.strictEqual(node.children?.['[0]']?.value, `65 'A'`);
		assert.strictEqual(node.children?.['[1]']?.value, `0 '\\0'`);
		assert.strictEqual(node.children?.['[2]']?.value, `66 'B'`);
	});

	test('readMemory uses DAP-spec `indexedVariables` for size hint', async () => {
		// DAP spec 把 size hint 字段叫 `indexedVariables`，cppvsdbg 历史上用 `indexedItems`
		// 别名。reader 两个都接受——直接传 `indexedVariables` 时 readMemory 应该按这个
		// 尺寸去请求，而不是 fallback 到 4096。
		let requestedCount: number | undefined;
		const base64 = Buffer.alloc(8).toString('base64');
		const session = makeSession(async (cmd, args) => {
			if (cmd === 'readMemory') {
				requestedCount = (args as { count: number }).count;
				return { data: base64 };
			}
			return {};
		});
		await readVariableTree(
			{ name: 'b', type: 'std::byte[128]', memoryReference: '0x1', indexedVariables: 128, value: '' },
			makeContext(session),
		);
		assert.strictEqual(requestedCount, 128, 'readMemory count must follow DAP-spec indexedVariables');
	});

	test('readMemory uses `indexedItems` alias for backwards compatibility', async () => {
		// cppvsdbg 历史上用 `indexedItems`，仍要兼容。
		let requestedCount: number | undefined;
		const base64 = Buffer.alloc(8).toString('base64');
		const session = makeSession(async (cmd, args) => {
			if (cmd === 'readMemory') {
				requestedCount = (args as { count: number }).count;
				return { data: base64 };
			}
			return {};
		});
		await readVariableTree(
			{ name: 'b', type: 'std::byte[64]', memoryReference: '0x1', indexedItems: 64, value: '' },
			makeContext(session),
		);
		assert.strictEqual(requestedCount, 64, 'readMemory count must follow legacy indexedItems alias');
	});

	test('readMemory uses `address` field from response if memoryReference missing', async () => {
		// 部分 adapter 把 readMemory 响应里的 `address`（首字节实际地址）跟
		// 原始 memoryReference 区分对待。当原始 memoryReference 缺失时
		// 应该用响应里的 address 作为兜底。我们的 reader 在 result 里不依赖
		// address 字段（只取 raw bytes），但仍记录到 node 上方便用户排错。
		const base64 = Buffer.from([0x41, 0x42]).toString('base64');
		const session = makeSession(async (cmd) => {
			if (cmd === 'readMemory') { return { address: '0xDEADBEEF', data: base64 }; }
			return {};
		});
		const node = await readVariableTree(
			{ name: 'b', type: 'std::byte[2]', memoryReference: '0x1', value: '' },
			makeContext(session),
		);
		assert.strictEqual(Object.keys(node.children ?? {}).length, 2);
		assert.strictEqual(node.memoryReference, '0x1', 'original memoryReference should be preserved');
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

	test('drops adapter value but keeps children when std::string exposes no char children', async () => {
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
		// string-like 节点没有 char 子节点 → 重建失败：
		//   - adapter 的截断 preview (`"Lorem ipsum...aliqua..."`) 不应保留为 value
		//   - 但 variablesReference 还在 → 落到通用分支把 children 展开，
		//     让用户看到 [size] / [capacity] / [allocator] 这些实际字段
		assert.strictEqual(node.value, undefined);
		assert.ok(node.children, 'long_str should expose adapter children when reconstruction fails');
		assert.strictEqual(node.children?.['[size]']?.value, '300');
		assert.strictEqual(node.children?.['[capacity]']?.value, '300');
		assert.ok(node.children?.['[allocator]']);
	});

	test('exposes MSVC internal layout for std::pmr::basic_string when no char children', async () => {
		// pmr_str = std::pmr::basic_string<char, ..., std::pmr::polymorphic_allocator<char>>。
		// cppvsdbg 对它不暴露 char buffer 子节点（数据在 monotonic_buffer_resource 池里），
		// 只把 MSVC 内部布局（_Mysize / _Myres / _Altr / _Buf）当作子节点返回。
		// 重建失败时应当让这些内部字段以 children 形式落地，而不是把节点清空。
		const session = makeSession(async (cmd) => cmd === 'variables' ? {
			variables: [
				{ name: '_Mysize', value: '43', type: 'unsigned __int64', variablesReference: 0 },
				{ name: '_Myres', value: '63', type: 'unsigned __int64', variablesReference: 0 },
				{ name: '_Altr', value: 'allocator', type: 'std::pmr::polymorphic_allocator<char>', variablesReference: 0 },
				{ name: '_Buf', value: '0x000000217719e9f0', type: 'std::_Container_proxy', variablesReference: 99 },
			],
		} : {});
		const node = await readVariableTree(
			{
				name: 'pmr_str',
				type: 'std::basic_string<char,std::char_traits<char>,std::pmr::polymorphic_allocator<char>>',
				evaluateName: 'this->pmr_str',
				variablesReference: 7,
				indexedItems: 1,
			},
			makeContext(session),
		);
		assert.strictEqual(node.value, undefined, 'pmr_str adapter value must be dropped when reconstruction fails');
		assert.strictEqual(node.type, 'std::basic_string<char,std::char_traits<char>,std::pmr::polymorphic_allocator<char>>');
		assert.strictEqual(node.evaluateName, 'this->pmr_str');
		assert.ok(node.children, 'pmr_str should expose MSVC internal layout when no char children');
		assert.strictEqual(node.children?.['_Mysize']?.value, '43');
		assert.strictEqual(node.children?.['_Myres']?.value, '63');
		assert.ok(node.children?._Altr);
		assert.ok(node.children?._Buf);
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

suite('formatByteAsCppvsdbg', () => {
	test('renders null byte as 0 \'\\0\'', () => {
		assert.strictEqual(formatByteAsCppvsdbg(0), `0 '\\0'`);
	});
	test('renders control bytes as \\xNN escapes', () => {
		assert.strictEqual(formatByteAsCppvsdbg(0x0f), `15 '\\xf'`);
		assert.strictEqual(formatByteAsCppvsdbg(0x7f), `127 '\\x7f'`);
		assert.strictEqual(formatByteAsCppvsdbg(0x01), `1 '\\x1'`);
	});
	test('renders printable ASCII directly', () => {
		assert.strictEqual(formatByteAsCppvsdbg(0x41), `65 'A'`);
		assert.strictEqual(formatByteAsCppvsdbg(0x20), `32 ' '`);
		assert.strictEqual(formatByteAsCppvsdbg(0x7e), `126 '~'`);
	});
	test('escapes backslash, single-quote, and comma so dump concatenation stays well-formed', () => {
		// PMR 缓冲内容里就会出现 `\` (0x5c)、`'` (0x27)、`,` (0x2c)。如果不
		// 对它们转义，dump 字符串连起来后会被切错——这是 tryEvaluateForFullByteDump
		// 路径上 cppvsdbg 把 2048 条 entry 都塞进一个 result 时的硬约束。
		assert.strictEqual(formatByteAsCppvsdbg(0x5c), `92 '\\\\'`);
		assert.strictEqual(formatByteAsCppvsdbg(0x27), `39 '\\''`);
		assert.strictEqual(formatByteAsCppvsdbg(0x2c), `44 '\\,'`);
	});
	test('renders high bytes as Latin-1 single char', () => {
		// cppvsdbg 也是 byte → char 直接映射（高位字节按 Latin-1 单字符渲染）。
		// 高字节不强制 \x 转义——把单字节当 char 直接显示，跟 cppvsdbg 同形态。
		assert.strictEqual(formatByteAsCppvsdbg(0x80), `128 ''`);
		assert.strictEqual(formatByteAsCppvsdbg(0xe8), `232 'è'`);
		assert.strictEqual(formatByteAsCppvsdbg(0xff), `255 'ÿ'`);
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
				return {
					variables: [
						{ name: '[0]', value: "72 'H'", type: 'char', variablesReference: 0 },
						{ name: '[1]', value: "101 'e'", type: 'char', variablesReference: 0 },
						{ name: '[2]', value: "108 'l'", type: 'char', variablesReference: 0 },
						{ name: '[3]', value: "108 'l'", type: 'char', variablesReference: 0 },
						{ name: '[4]', value: "111 'o'", type: 'char', variablesReference: 0 },
					]
				};
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