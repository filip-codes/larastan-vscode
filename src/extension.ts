// larastan-vscode-extension/src/extension.ts
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

interface LarastanError {
    file: string;
    line: number;
    message: string;
    level: string;
}

export function activate(context: vscode.ExtensionContext) {
    // Register a command to manually trigger Larastan analysis
    let disposable = vscode.commands.registerCommand('larastan.analyze', () => {
        runLarastanAnalysis();
    });

    // Create a status bar item
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'larastan.analyze';
    statusBarItem.text = '$(check) Larastan';
    statusBarItem.tooltip = 'Run Larastan analysis';
    statusBarItem.show();

    // Register the diagnostic collection to store errors
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('larastan');
    
    // Register file watcher to auto-run Larastan on changes
    const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.php');
    const changeHandler = debounce(() => runLarastanAnalysis(), 2000);
    
    fileWatcher.onDidChange(changeHandler);
    fileWatcher.onDidCreate(changeHandler);
    fileWatcher.onDidDelete(changeHandler);

    // Create and setup the results view
    const provider = new LarastanResultsProvider();
    const view = vscode.window.createTreeView('larastanResults', {
        treeDataProvider: provider
    });

    // Function to run Larastan and update results
    function runLarastanAnalysis() {
        statusBarItem.text = '$(sync~spin) Running Larastan...';
        
        const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (!workspacePath) {
            vscode.window.showErrorMessage('No workspace folder is open');
            statusBarItem.text = '$(check) Larastan';
            return;
        }

        // Check if vendor/bin/phpstan exists
        const larastanPath = path.join(workspacePath, 'vendor/bin/phpstan');
        if (!fs.existsSync(larastanPath)) {
            vscode.window.showErrorMessage('Larastan not found. Make sure it\'s installed in your project.');
            statusBarItem.text = '$(check) Larastan';
            return;
        }

        try {
            // Run Larastan with JSON output format
            const process = cp.spawn('php', [
                larastanPath,
                'analyse',
                '--error-format=json'
            ], { cwd: workspacePath });

            let stdout = '';
            let stderr = '';

            process.stdout.on('data', data => {
                stdout += data.toString();
            });

            process.stderr.on('data', data => {
                stderr += data.toString();
            });

            process.on('close', code => {
                statusBarItem.text = '$(check) Larastan';
                
                if (code !== 0 && !stdout) {
                    vscode.window.showErrorMessage(`Larastan failed: ${stderr}`);
                    return;
                }

                try {
                    // Parse the JSON output
                    const result = JSON.parse(stdout);
                    const errors: LarastanError[] = [];
                    const diagnosticsMap = new Map<string, vscode.Diagnostic[]>();

                    if (result.files) {
                        for (const file in result.files) {
                            const fileErrors = result.files[file].messages;
                            
                            fileErrors.forEach((error: any) => {
                                // Create a diagnostic for each error
                                const range = new vscode.Range(
                                    error.line - 1, 0, 
                                    error.line - 1, 100
                                );
                                
                                const diagnostic = new vscode.Diagnostic(
                                    range,
                                    error.message,
                                    vscode.DiagnosticSeverity.Error
                                );
                                
                                // Store diagnostics by file
                                const filePath = path.join(workspacePath, file);
                                const diagnostics = diagnosticsMap.get(filePath) || [];
                                diagnostics.push(diagnostic);
                                diagnosticsMap.set(filePath, diagnostics);
                                
                                // Add to our errors list for the view
                                errors.push({
                                    file: file,
                                    line: error.line,
                                    message: error.message,
                                    level: 'error'
                                });
                            });
                        }
                    }

                    // Update diagnostics
                    diagnosticCollection.clear();
                    for (const [file, diagnostics] of diagnosticsMap.entries()) {
						diagnosticCollection.set(
							vscode.Uri.file(file.replace(workspacePath, '')),
							diagnostics
						);
                    }

                    // Update the tree view
                    provider.update(errors);
                    
                    // Show status message
                    const errorCount = errors.length;
                    vscode.window.showInformationMessage(`Larastan found ${errorCount} issue${errorCount !== 1 ? 's' : ''}`);
                } catch (e) {
                    vscode.window.showErrorMessage(`Failed to parse Larastan output: ${e}`);
                }
            });
        } catch (error) {
            statusBarItem.text = '$(check) Larastan';
            vscode.window.showErrorMessage(`Failed to run Larastan: ${error}`);
        }
    }

    // Run Larastan on extension activation
    runLarastanAnalysis();

    context.subscriptions.push(
        disposable, 
        statusBarItem, 
        diagnosticCollection,
        fileWatcher,
        view
    );
}

// Simple debounce function to prevent running too many analyses
function debounce(func: Function, delay: number) {
    let timeout: NodeJS.Timeout;
    return function(...args: any[]) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), delay);
    };
}

// TreeDataProvider for the Larastan results view
class LarastanResultsProvider implements vscode.TreeDataProvider<LarastanErrorItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<LarastanErrorItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private errors: LarastanError[] = [];

    getTreeItem(element: LarastanErrorItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: LarastanErrorItem): Thenable<LarastanErrorItem[]> {
        if (element) {
            return Promise.resolve([]);
        }

        return Promise.resolve(this.errors.map(error => {
            const treeItem = new LarastanErrorItem(
                `${error.file}:${error.line} - ${error.message}`,
    			vscode.TreeItemCollapsibleState.None
            );

            treeItem.tooltip = error.message;
            treeItem.description = `Line ${error.line}`;
            treeItem.command = {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [
					vscode.Uri.file(error.file),
                    { selection: new vscode.Range(error.line - 1, 0, error.line - 1, 0) }
                ]
            };
            
            return treeItem;
        }));
    }

    update(errors: LarastanError[]) {
        this.errors = errors;
        this._onDidChangeTreeData.fire(undefined);
    }
}

class LarastanErrorItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);
        this.iconPath = new vscode.ThemeIcon('error');
    }
}