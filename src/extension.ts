import * as vscode from 'vscode';
import { DebugCopyDeps, copyVariableAsJson, readLimitsFromConfig, saveVariableAsJson } from './debugCopy';

/** 右键菜单只提供 sessionId，需要自己维护 id -> DebugSession 的映射。 */
const sessions = new Map<string, vscode.DebugSession>();

function makeDeps(): DebugCopyDeps {
    return {
        getSession: () => vscode.debug.activeDebugSession,
        getSessionById: (id: string) => {
            const active = vscode.debug.activeDebugSession;
            if (active?.id === id) { return active; }
            return sessions.get(id);
        },
        showInputBox: async () => {
            const value = await vscode.window.showInputBox({ prompt: '输入要复制的 C/C++ 变量或 Watch 表达式', placeHolder: '例如 person、vec[0]、myObject.field', ignoreFocusOut: true });
            return value?.trim() || undefined;
        },
        showSaveDialog: async (defaultFileName: string) => {
            const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(defaultFileName), filters: { JSON: ['json'] } });
            return uri?.fsPath;
        },
        writeClipboard: async (text: string) => { await vscode.env.clipboard.writeText(text); },
        writeFile: async (path: string, content: Uint8Array) => {
            await vscode.workspace.fs.writeFile(vscode.Uri.file(path), content);
        },
        showInfo: (message: string) => { void vscode.window.showInformationMessage(message); },
        showWarning: (message: string) => { void vscode.window.showWarningMessage(message); },
        showError: (message: string) => { void vscode.window.showErrorMessage(message); },
        readLimits: () => readLimitsFromConfig(<T,>(key: string, defaultValue: T) => vscode.workspace.getConfiguration('copy-cpp-debug-variable').get<T>(key, defaultValue)),
        now: () => new Date(),
    };
}

export function activate(context: vscode.ExtensionContext): void {
    const deps = makeDeps();
    const active = vscode.debug.activeDebugSession;
    if (active) { sessions.set(active.id, active); }
    context.subscriptions.push(
        vscode.debug.onDidStartDebugSession(session => { sessions.set(session.id, session); }),
        vscode.debug.onDidTerminateDebugSession(session => { sessions.delete(session.id); }),
        vscode.commands.registerCommand('copy-cpp-debug-variable.copyAsJson', () => copyVariableAsJson(deps)),
        vscode.commands.registerCommand('copy-cpp-debug-variable.saveAsJson', () => saveVariableAsJson(deps)),
        vscode.commands.registerCommand('copy-cpp-debug-variable.copySelectedAsJson', (arg?: unknown) => copyVariableAsJson(deps, arg)),
        vscode.commands.registerCommand('copy-cpp-debug-variable.saveSelectedAsJson', (arg?: unknown) => saveVariableAsJson(deps, arg)),
    );
}

export function deactivate(): void {
    sessions.clear();
}
