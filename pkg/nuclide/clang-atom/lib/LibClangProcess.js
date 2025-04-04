'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */
const {getServiceByNuclideUri} = require('nuclide-client');
const {Point} = require('atom');

class LibClangProcess {

  async getDiagnostics(editor: TextEditor): Promise<Array<mixed>> {
    const src = editor.getPath();
    const contents = editor.getText();

    return getServiceByNuclideUri('ClangService', src)
        .compile(src, contents);
  }

  getCompletions(editor: TextEditor): Promise {
    const src = editor.getPath();
    const cursor = editor.getLastCursor();
    const range = cursor.getCurrentWordBufferRange({
      wordRegex: cursor.wordRegExp({includeNonWordCharacters: false}),
    });

    // Current word might go beyond the cursor, so we cut it.
    range.end = new Point(cursor.getBufferRow(), cursor.getBufferColumn());
    const prefix = editor.getTextInBufferRange(range).trim();

    const line = cursor.getBufferRow();
    const column = cursor.getBufferColumn();
    const tokenStartColumn = column - prefix.length;

    return getServiceByNuclideUri('ClangService', src)
        .getCompletions(src, editor.getText(), line, column, tokenStartColumn, prefix);
  }

  /**
   * If a location can be found for the declaration, it will be available via
   * the 'location' field on the returned object.
   */
  getDeclaration(editor: TextEditor, line: number, column: number): Promise {
    const src = editor.getPath();
    return getServiceByNuclideUri('ClangService', src)
        .getDeclaration(src, editor.getText(), line, column);
  }

}

module.exports = LibClangProcess;
