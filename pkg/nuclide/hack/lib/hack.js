'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import type {HackReference} from 'nuclide-hack-base/lib/types';
import type {HackDiagnosticItem} from './types';

import invariant from 'assert';
import {getClient, getFileSystemServiceByNuclideUri} from 'nuclide-client';
import {extractWordAtPosition} from 'nuclide-atom-helpers';
import HackLanguage from './HackLanguage';
import {getPath} from 'nuclide-remote-uri';
import {Range} from 'atom';
import pathUtil from 'path';
import {SymbolType} from 'nuclide-hack-common';
import {getHackService} from './utils';

const HACK_WORD_REGEX = /[a-zA-Z0-9_$]+/g;

// Symbol types we can get references for.
const SYMBOL_TYPES_WITH_REFERENCES = new Set([
  SymbolType.CLASS,
  SymbolType.FUNCTION,
  SymbolType.METHOD,
]);

/**
 * This is responsible for managing (creating/disposing) multiple HackLanguage instances,
 * creating the designated HackService instances with the NuclideClient it needs per remote project.
 * Also, it deelegates the language feature request to the correct HackLanguage instance.
 */
const clientToHackLanguage: {[clientId: string]: HackLanguage} = {};

module.exports = {

  async findDiagnostics(
    editor: TextEditor
  ): Promise<Array<HackDiagnosticItem>> {
    const filePath = editor.getPath();
    const hackLanguage = await getHackLanguageForUri(filePath);
    if (!hackLanguage || !filePath) {
      return [];
    }

    invariant(filePath);
    const localPath = getPath(filePath);
    const contents = editor.getText();

    let diagnostics;
    if (hackLanguage.isHackAvailable()) {
      diagnostics = await hackLanguage.getServerDiagnostics(filePath);
    } else {
      diagnostics = await hackLanguage.getDiagnostics(localPath, contents);
    }
    return diagnostics;
  },

  async fetchCompletionsForEditor(editor: TextEditor, prefix: string): Promise<Array<any>> {
    const hackLanguage = await getHackLanguageForUri(editor.getPath());
    const filePath = editor.getPath();
    if (!hackLanguage || !filePath) {
      return [];
    }

    invariant(filePath);
    const contents = editor.getText();
    const cursor = editor.getLastCursor();
    const offset = editor.getBuffer().characterIndexForPosition(cursor.getBufferPosition());
    // The returned completions may have unrelated results, even though the offset is set on the end of the prefix.
    const completions = await hackLanguage.getCompletions(filePath, contents, offset);
    // Filter out the completions that do not contain the prefix as a token in the match text case insentively.
    const tokenLowerCase = prefix.toLowerCase();

    const {compareHackCompletions} = require('./utils');
    const hackCompletionsCompartor = compareHackCompletions(prefix);

    return completions
      .filter(completion => completion.matchText.toLowerCase().indexOf(tokenLowerCase) >= 0)
      // Sort the auto-completions based on a scoring function considering:
      // case sensitivity, position in the completion, private functions and alphabetical order.
      .sort((completion1, completion2) => hackCompletionsCompartor(completion1.matchText, completion2.matchText));
  },

  async formatSourceFromEditor(editor: TextEditor, range: atom$Range): Promise<string> {
    const buffer = editor.getBuffer();
    const filePath = editor.getPath();
    const hackLanguage = await getHackLanguageForUri(filePath);
    if (!hackLanguage || !filePath) {
      return buffer.getTextInRange(range);
    }

    const startPosition = buffer.characterIndexForPosition(range.start);
    const endPosition = buffer.characterIndexForPosition(range.end);
    return await hackLanguage.formatSource(buffer.getText(), startPosition + 1, endPosition + 1);
  },

  async codeHighlightFromEditor(
    editor: atom$TextEditor,
    position: atom$Point,
  ): Promise<Array<atom$Range>> {
    const hackLanguage = await getHackLanguageForUri(editor.getPath());
    if (!hackLanguage) {
      return [];
    }

    const matchData = extractWordAtPosition(editor, position, HACK_WORD_REGEX);
    if (
      !matchData ||
      !matchData.wordMatch.length ||
      !matchData.wordMatch[0].startsWith('$')
    ) {
      return [];
    }

    return hackLanguage.highlightSource(
      getPath(editor.getPath() || ''),
      editor.getText(),
      position.row + 1,
      position.column,
    );
  },

  async typeHintFromEditor(editor: TextEditor, position: atom$Point): Promise<?TypeHint> {
    const filePath = editor.getPath();
    const hackLanguage = await getHackLanguageForUri(filePath);
    if (!hackLanguage || !filePath) {
      return null;
    }

    const matchData = extractWordAtPosition(editor, position, HACK_WORD_REGEX);
    if (!matchData) {
      return null;
    }

    const path = getPath(filePath);
    const contents = editor.getText();

    const type = await hackLanguage.getType(path, contents, matchData.wordMatch[0], position.row + 1, position.column + 1);
    if (!type || type === '_') {
      return null;
    } else {
      return {
        hint: type,
        range: matchData.range,
      };
    }
  },

  /**
   * If a location can be found for the declaration, the return value will
   * resolve to an object with these fields: file, line, column.
   */
  async findDefinition(
    editor: atom$TextEditor,
    line: number,
    column: number,
  ): Promise<?Array<Object>> {
    const hackLanguage = await getHackLanguageForUri(editor.getPath());
    const filePath = editor.getPath();
    if (!hackLanguage || !filePath) {
      return null;
    }

    const contents = editor.getText();
    const buffer = editor.getBuffer();
    const lineText = buffer.lineForRow(line);
    const positions = await hackLanguage.getDefinition(
      filePath, contents, line + 1, column + 1, lineText
    );
    if (positions.length === 0) {
      return null;
    }
    return positions.map(position => {
      let range = null;
      // If the search string was expanded to include more than a valid regex php word.
      // e.g. in case of XHP tags, the start and end column are provided to underline the full range
      // to visit its definition.
      if (position.searchStartColumn && position.searchEndColumn) {
        range = new Range([line, position.searchStartColumn], [line, position.searchEndColumn]);
      }
      return {
        ...position,
        range,
      };
    });
  },

  async findReferences(
    editor: TextEditor,
    line: number,
    column: number
  ): Promise<?{baseUri: string, symbolName: string; references: Array<HackReference>}> {
    const filePath = editor.getPath();
    const hackLanguage = await getHackLanguageForUri(filePath);
    if (!hackLanguage || !filePath) {
      return null;
    }

    const contents = editor.getText();
    const symbol = await hackLanguage.getSymbolNameAtPositionWithDependencies(
      getPath(filePath),
      contents,
      line + 1,
      column + 1
    );
    if (!symbol || !SYMBOL_TYPES_WITH_REFERENCES.has(symbol.type)) {
      return null;
    }
    const referencesResult = await hackLanguage.getReferences(filePath, contents, symbol);
    if (!referencesResult) {
      return null;
    }
    const {hackRoot, references} = referencesResult;
    return {baseUri: hackRoot, symbolName: symbol.name, references};
  },

  async isFinishedLoadingDependencies(editor: TextEditor): Promise<boolean> {
    const hackLanguage = await getHackLanguageForUri(editor.getPath());
    return hackLanguage.isFinishedLoadingDependencies();
  },

  async onFinishedLoadingDependencies(
    editor: TextEditor,
    callback: (() => mixed),
  ): Promise<atom$Disposable> {
    const hackLanguage = await getHackLanguageForUri(editor.getPath());
    return hackLanguage.onFinishedLoadingDependencies(callback);
  },

  getHackLanguageForUri,
  getCachedHackLanguageForUri,
};

function getCachedHackLanguageForUri(uri: NuclideUri): ?HackLanguage {
  const client = getClient(uri);
  if (!client) {
    return null;
  }
  return clientToHackLanguage[client.getID()];
}

function getHackLanguageForUri(uri: NuclideUri): Promise<?HackLanguage> {
  // `getClient` can return null if a file path doesn't have a root directory in the tree.
  // Also, returns null when reloading Atom with open files, while the RemoteConnection creation is pending.
  const client = getClient(uri);
  if (!client) {
    return null;
  }
  return createHackLanguageIfNotExisting(client, uri);
}

async function createHackLanguageIfNotExisting(
  client: NuclideClient,
  fileUri: NuclideUri,
): Promise<HackLanguage> {
  const clientId = client.getID();
  if (clientToHackLanguage[clientId]) {
    return clientToHackLanguage[clientId];
  }

  const hackEnvironment = await getHackService(fileUri).getHackEnvironmentDetails(fileUri);
  const isHHAvailable = hackEnvironment != null;
  const {hackRoot} = hackEnvironment || {};

  // If multiple calls were done asynchronously, then return the single-created HackLanguage.
  if (clientToHackLanguage[clientId]) {
    return clientToHackLanguage[clientId];
  }
  clientToHackLanguage[clientId] = new HackLanguage(isHHAvailable, hackRoot, fileUri);
  return clientToHackLanguage[clientId];
}
