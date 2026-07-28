import * as vscode from 'vscode';
import { DapVariable, DapVariableNode, ReaderContext, ReaderLimits, readVariableTree, request } from './variableReader';

const DEFAULT_LIMITS: ReaderLimits = { maxDepth: 32, maxVariables: 10000, maxArrayItems: 1000, pageSize: 100 };

interface EvaluateResponse { result?: string; type?: string; evaluateName?: string; variablesReference?: number; memoryReference?: string; }

function limits(): ReaderLimits {
    const config = vscode.workspace.getConfiguration('copy-cpp-debug-variable');
    return {
        maxDepth: config.get('maxDepth', DEFAULT_LIMITS.maxDepth),
        maxVariables: config.get('maxVariables', DEFAULT_LIMITS.maxVariables),
        maxArrayItems: config.get('maxArrayItems', DEFAULT_LIMITS.maxArrayItems),
        pageSize: config.get('variablePagingSize', DEFAULT_LIMITS.pageSize),
    };
}

async function chooseExpression(): Promise<string | undefined> {
    const value = await vscode.window.showInputBox({ prompt: '输入要复制的 C/C++ 变量或 Watch 表达式', placeHolder: '例如 person、vec[0]、myObject.field', ignoreFocusOut: true });
    return value?.trim() || undefined;
}

function ensureSession(): vscode.DebugSession | undefined {
    const session = vscode.debug.activeDebugSession;
    if (!session) { void vscode.window.showWarningMessage('请先启动 C/C++ 调试会话。'); return undefined; }
    return session;
}

async function copyExpression(): Promise<void> {
    const session = ensureSession();
    if (!session) {return;}
    const expression = await chooseExpression();
    if (!expression) {return;}
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在读取调试变量' }, async (_, token) => {
        try {
            const result = await request<EvaluateResponse>(session, 'evaluate', { expression, context: 'watch' });
            const variable: DapVariable = { name: expression, value: result.result, type: result.type, evaluateName: result.evaluateName ?? expression, variablesReference: result.variablesReference, memoryReference: result.memoryReference };
            const context: ReaderContext = { session, limits: limits(), token, count: 0, references: new Set() };
            const data = await readVariableTree(variable, context);
            const document = { schemaVersion: 1, source: 'watch', expression, sessionType: session.type, capturedAt: new Date().toISOString(), data, warnings: data.errors ?? [] };
            const text = JSON.stringify(document, null, 2);
            await vscode.env.clipboard.writeText(text);
            void vscode.window.showInformationMessage(`已复制变量 ${expression}（${context.count + 1} 个节点）`);
        } catch (error) {
            if (error instanceof vscode.CancellationError) {return;}
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`读取调试变量失败：${message}`);
        }
    });
}

async function saveExpression(): Promise<void> {
    const session = ensureSession();
    if (!session) {return;}
    const expression = await chooseExpression();
    if (!expression) {return;}
    try {
        const result = await request<EvaluateResponse>(session, 'evaluate', { expression, context: 'watch' });
        const variable: DapVariable = { name: expression, value: result.result, type: result.type, evaluateName: result.evaluateName ?? expression, variablesReference: result.variablesReference, memoryReference: result.memoryReference };
        const context: ReaderContext = { session, limits: limits(), count: 0, references: new Set() };
        const data: DapVariableNode = await readVariableTree(variable, context);
        const text = JSON.stringify({ schemaVersion: 1, source: 'watch', expression, sessionType: session.type, capturedAt: new Date().toISOString(), data }, null, 2);
        const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`${expression.replace(/[^\w.-]+/g, '_')}.json`), filters: { JSON: ['json'] } });
        if (uri) { await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8')); void vscode.window.showInformationMessage(`已保存到 ${uri.fsPath}`); }
    } catch (error) { void vscode.window.showErrorMessage(`保存调试变量失败：${error instanceof Error ? error.message : String(error)}`); }
}

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('copy-cpp-debug-variable.copyAsJson', copyExpression),
        vscode.commands.registerCommand('copy-cpp-debug-variable.saveAsJson', saveExpression),
    );
}

export function deactivate(): void { }
