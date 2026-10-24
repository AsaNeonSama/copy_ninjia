import ts from "typescript";

/** packages/consts/ 里一条以标识符命名的导出常量声明。 */
export interface ExportedConstDeclaration {
  readonly path: string;
  readonly name: string;
  readonly declaration: ts.VariableDeclaration;
}

/**
 * 按文件与声明顺序列出 constFiles 里顶层带 export 的变量声明。
 *
 * @param program 包含常量文件的 TypeScript Program
 * @param constFiles 待扫描的常量文件绝对路径列表
 * @returns 导出常量声明列表
 */
export function exportedConstDeclarations(
  program: ts.Program,
  constFiles: readonly string[]
): ExportedConstDeclaration[] {
  const declarations: ExportedConstDeclaration[] = [];
  for (const path of constFiles) {
    const sourceFile: ts.SourceFile | undefined = program.getSourceFile(path);
    if (sourceFile === undefined) continue;
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      if (statement.modifiers?.some((modifier: ts.ModifierLike): boolean => modifier.kind === ts.SyntaxKind.ExportKeyword) !== true) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        declarations.push({ path, name: declaration.name.text, declaration });
      }
    }
  }
  return declarations;
}
