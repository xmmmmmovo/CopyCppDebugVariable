import * as assert from 'assert';
import { buildDefaultFileName, buildResultDocument, copyVariableAsJson, evaluateToVariable, readLimitsFromConfig, readShowSuccessNotificationFromConfig, saveVariableAsJson } from '../debugCopy';
import { DEFAULT_LIMITS, makeDeps, makeSession, makeSessionWithType } from './helpers';

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

	test('readShowSuccessNotificationFromConfig reads from getter', () => {
		assert.strictEqual(readShowSuccessNotificationFromConfig(<T,>(_k: string, _d: T) => true as T), true);
	});

	test('readShowSuccessNotificationFromConfig defaults to false', () => {
		assert.strictEqual(readShowSuccessNotificationFromConfig(<T,>(_k: string, d: T) => d), false);
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
		const deps = makeDeps({ session, readShowSuccessNotification: () => true });
		await copyVariableAsJson(deps);
		assert.strictEqual(deps.calls.clipboard.length, 1);
		const payload = JSON.parse(deps.calls.clipboard[0]);
		assert.strictEqual(payload.expression, 'person');
		assert.strictEqual(payload.sessionType, 'cppdbg');
		assert.strictEqual(payload.data.value, '42');
		assert.deepStrictEqual(deps.calls.info, [`已复制变量 person（1 个节点）`]);
	});

	test('showSuccessNotification=false suppresses copy info but still copies', async () => {
		const session = makeSessionWithType('cppdbg', async (cmd) => cmd === 'evaluate' ? { result: '42', type: 'int', variablesReference: 0 } : {});
		const deps = makeDeps({ session, readShowSuccessNotification: () => false });
		await copyVariableAsJson(deps);
		assert.strictEqual(deps.calls.clipboard.length, 1);
		assert.strictEqual(deps.calls.info.length, 0);
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
		const deps = makeDeps({ session, showSaveDialog: async () => '/tmp/x.json', readShowSuccessNotification: () => true });
		await saveVariableAsJson(deps);
		assert.strictEqual(deps.calls.files.length, 1);
		assert.strictEqual(deps.calls.files[0].path, '/tmp/x.json');
		const json = JSON.parse(Buffer.from(deps.calls.files[0].content).toString('utf8'));
		assert.strictEqual(json.expression, 'person');
		assert.deepStrictEqual(deps.calls.info, [`已保存到 /tmp/x.json`]);
	});

	test('showSuccessNotification=false suppresses save info but still writes file', async () => {
		const session = makeSession(async (cmd) => cmd === 'evaluate' ? { result: '0', type: 'int', variablesReference: 0 } : {});
		const deps = makeDeps({ session, showSaveDialog: async () => '/tmp/x.json', readShowSuccessNotification: () => false });
		await saveVariableAsJson(deps);
		assert.strictEqual(deps.calls.files.length, 1);
		assert.strictEqual(deps.calls.info.length, 0);
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