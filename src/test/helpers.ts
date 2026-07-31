import type * as vscode from 'vscode';
import { ReaderLimits } from '../variableReader';
import { DebugCopyDeps } from '../debugCopy';

export type CustomRequest = (command: string, args?: unknown) => Promise<unknown>;

export function makeSession(impl: CustomRequest): vscode.DebugSession {
	return { customRequest: impl } as unknown as vscode.DebugSession;
}

export function makeSessionWithType(type: string, impl: CustomRequest): vscode.DebugSession {
	return { type, customRequest: impl } as unknown as vscode.DebugSession;
}

export const DEFAULT_LIMITS: ReaderLimits = { maxDepth: 8, maxVariables: 10000, maxArrayItems: 1000, pageSize: 100 };

export function makeContext(session: vscode.DebugSession, overrides: Partial<ReaderLimits> = {}, token?: vscode.CancellationToken) {
	return { session, limits: { ...DEFAULT_LIMITS, ...overrides }, token, count: 0, references: new Set<number>() };
}

export type DepsCalls = {
	info: string[];
	warning: string[];
	error: string[];
	clipboard: string[];
	files: { path: string; content: Uint8Array }[];
};

export type Deps = DebugCopyDeps & { calls: DepsCalls };

export function makeDeps(overrides: Partial<DebugCopyDeps> & { session?: vscode.DebugSession | undefined; sessionsById?: Record<string, vscode.DebugSession> } = {}): Deps {
	const session = 'session' in overrides ? overrides.session : undefined;
	const sessionsById = overrides.sessionsById ?? {};
	const calls: DepsCalls = { info: [], warning: [], error: [], clipboard: [], files: [] };
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

export async function request<T>(session: vscode.DebugSession, command: string, args?: unknown): Promise<T> {
	return session.customRequest(command, args) as Promise<T>;
}