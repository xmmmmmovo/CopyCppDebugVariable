import * as assert from 'assert';
import { VariableMenuContext, copyVariableAsJson, isVariableMenuContext, menuContextToVariable, saveVariableAsJson } from '../debugCopy';
import { makeDeps, makeSession, makeSessionWithType } from './helpers';

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
		const deps = makeDeps({ session, showInputBox: async () => { throw new Error('should not prompt'); }, readShowSuccessNotification: () => true });
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