import * as assert from 'assert';
import type * as vscode from 'vscode';
import { DapVariable, ReaderCancellationError, ReaderLimits, isDapVariable, readVariableTree } from '../variableReader';
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

const DEFAULT_LIMITS: ReaderLimits = { maxDepth: 32, maxVariables: 10000, maxArrayItems: 1000, pageSize: 100 };

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
						{ name: 'name', value: '"Alice"', type: 'std::string', variablesReference: 2 },
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
