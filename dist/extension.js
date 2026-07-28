"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode2 = __toESM(require("vscode"));

// src/variableReader.ts
var vscode = __toESM(require("vscode"));
function isDapVariable(value) {
  return typeof value === "object" && value !== null && typeof value.name === "string";
}
async function request(session, command, args) {
  return session.customRequest(command, args);
}
async function readVariableTree(variable, context, depth = 0) {
  const node = {
    name: variable.name,
    value: variable.value,
    type: variable.type,
    evaluateName: variable.evaluateName,
    memoryReference: variable.memoryReference
  };
  if (context.token?.isCancellationRequested) {
    throw new vscode.CancellationError();
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
    const children = {};
    const total = Math.min(variable.indexedItems ?? context.limits.maxArrayItems, context.limits.maxArrayItems);
    for (let start = 0; start < total; start += context.limits.pageSize) {
      const response = await request(context.session, "variables", {
        variablesReference: variable.variablesReference,
        start,
        count: Math.min(context.limits.pageSize, total - start)
      });
      const vars = (response.variables ?? []).filter(isDapVariable);
      if (vars.length === 0) break;
      for (const child of vars) {
        if (context.count >= context.limits.maxVariables) {
          node.truncated = true;
          break;
        }
        context.count++;
        const key = Object.prototype.hasOwnProperty.call(children, child.name) ? `${child.name}[${start}]` : child.name;
        children[key] = await readVariableTree(child, context, depth + 1);
      }
      if (vars.length < context.limits.pageSize || node.truncated) break;
    }
    if (Object.keys(children).length > 0) node.children = children;
  } catch (error) {
    node.errors = [error instanceof Error ? error.message : String(error)];
  } finally {
    context.references.delete(variable.variablesReference);
  }
  return node;
}

// src/extension.ts
var DEFAULT_LIMITS = { maxDepth: 32, maxVariables: 1e4, maxArrayItems: 1e3, pageSize: 100 };
function limits() {
  const config = vscode2.workspace.getConfiguration("copy-cpp-debug-variable");
  return {
    maxDepth: config.get("maxDepth", DEFAULT_LIMITS.maxDepth),
    maxVariables: config.get("maxVariables", DEFAULT_LIMITS.maxVariables),
    maxArrayItems: config.get("maxArrayItems", DEFAULT_LIMITS.maxArrayItems),
    pageSize: config.get("variablePagingSize", DEFAULT_LIMITS.pageSize)
  };
}
async function chooseExpression() {
  const value = await vscode2.window.showInputBox({ prompt: "\u8F93\u5165\u8981\u590D\u5236\u7684 C/C++ \u53D8\u91CF\u6216 Watch \u8868\u8FBE\u5F0F", placeHolder: "\u4F8B\u5982 person\u3001vec[0]\u3001myObject.field", ignoreFocusOut: true });
  return value?.trim() || void 0;
}
function ensureSession() {
  const session = vscode2.debug.activeDebugSession;
  if (!session) {
    void vscode2.window.showWarningMessage("\u8BF7\u5148\u542F\u52A8 C/C++ \u8C03\u8BD5\u4F1A\u8BDD\u3002");
    return void 0;
  }
  return session;
}
async function copyExpression() {
  const session = ensureSession();
  if (!session) return;
  const expression = await chooseExpression();
  if (!expression) return;
  await vscode2.window.withProgress({ location: vscode2.ProgressLocation.Notification, title: "\u6B63\u5728\u8BFB\u53D6\u8C03\u8BD5\u53D8\u91CF" }, async (_, token) => {
    try {
      const result = await request(session, "evaluate", { expression, context: "watch" });
      const variable = { name: expression, value: result.result, type: result.type, evaluateName: result.evaluateName ?? expression, variablesReference: result.variablesReference, memoryReference: result.memoryReference };
      const context = { session, limits: limits(), token, count: 0, references: /* @__PURE__ */ new Set() };
      const data = await readVariableTree(variable, context);
      const document = { schemaVersion: 1, source: "watch", expression, sessionType: session.type, capturedAt: (/* @__PURE__ */ new Date()).toISOString(), data, warnings: data.errors ?? [] };
      const text = JSON.stringify(document, null, 2);
      await vscode2.env.clipboard.writeText(text);
      void vscode2.window.showInformationMessage(`\u5DF2\u590D\u5236\u53D8\u91CF ${expression}\uFF08${context.count + 1} \u4E2A\u8282\u70B9\uFF09`);
    } catch (error) {
      if (error instanceof vscode2.CancellationError) return;
      const message = error instanceof Error ? error.message : String(error);
      void vscode2.window.showErrorMessage(`\u8BFB\u53D6\u8C03\u8BD5\u53D8\u91CF\u5931\u8D25\uFF1A${message}`);
    }
  });
}
async function saveExpression() {
  const session = ensureSession();
  if (!session) return;
  const expression = await chooseExpression();
  if (!expression) return;
  try {
    const result = await request(session, "evaluate", { expression, context: "watch" });
    const variable = { name: expression, value: result.result, type: result.type, evaluateName: result.evaluateName ?? expression, variablesReference: result.variablesReference, memoryReference: result.memoryReference };
    const context = { session, limits: limits(), count: 0, references: /* @__PURE__ */ new Set() };
    const data = await readVariableTree(variable, context);
    const text = JSON.stringify({ schemaVersion: 1, source: "watch", expression, sessionType: session.type, capturedAt: (/* @__PURE__ */ new Date()).toISOString(), data }, null, 2);
    const uri = await vscode2.window.showSaveDialog({ defaultUri: vscode2.Uri.file(`${expression.replace(/[^\w.-]+/g, "_")}.json`), filters: { JSON: ["json"] } });
    if (uri) {
      await vscode2.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
      void vscode2.window.showInformationMessage(`\u5DF2\u4FDD\u5B58\u5230 ${uri.fsPath}`);
    }
  } catch (error) {
    void vscode2.window.showErrorMessage(`\u4FDD\u5B58\u8C03\u8BD5\u53D8\u91CF\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
  }
}
function activate(context) {
  context.subscriptions.push(
    vscode2.commands.registerCommand("copy-cpp-debug-variable.copyAsJson", copyExpression),
    vscode2.commands.registerCommand("copy-cpp-debug-variable.saveAsJson", saveExpression)
  );
}
function deactivate() {
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
//# sourceMappingURL=extension.js.map
