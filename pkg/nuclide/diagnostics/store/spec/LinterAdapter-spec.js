'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import {Disposable} from 'atom';

import invariant from 'assert';

import {
  LinterAdapter,
  linterMessageToDiagnosticMessage,
  linterMessagesToDiagnosticUpdate,
} from '../lib/LinterAdapter';

const grammar = 'testgrammar';

import {arePropertiesEqual} from 'nuclide-test-helpers';

function makePromise<T>(ret: T, timeout: number): Promise<T> {
  return new Promise(resolve => {
    setTimeout(() => {
      resolve(ret);
    }, timeout);
  });
}

describe('LinterAdapter', () => {
  let eventCallback: any;
  let fakeLinter: any;
  let linterAdapter: any;
  let linterReturn: any;
  let fakeEditor: any;
  let subscribedToAny: any;
  let newUpdateSubscriber: any;
  let publishMessageUpdateSpy: any;
  let fakeDiagnosticsProviderBase: any;

  class FakeDiagnosticsProviderBase {
    publishMessageUpdate: JasmineSpy;
    publishMessageInvalidation: JasmineSpy;
    dispose: JasmineSpy;
    constructor(options) {
      eventCallback = options.onTextEditorEvent;
      subscribedToAny = options.enableForAllGrammars;
      newUpdateSubscriber = options.onNewUpdateSubscriber;
      this.publishMessageUpdate = jasmine.createSpy();
      publishMessageUpdateSpy = this.publishMessageUpdate;
      this.publishMessageInvalidation = jasmine.createSpy();
      this.dispose = jasmine.createSpy();
      fakeDiagnosticsProviderBase = this;  // eslint-disable-line consistent-this
    }
    onMessageUpdate(callback) {
      this.publishMessageUpdate.andCallFake(callback);
      return new Disposable(() => {});
    }
    onMessageInvalidation() {
      return new Disposable(() => {});
    }
  }

  function newLinterAdapter(linter) {
    return new LinterAdapter(linter, (FakeDiagnosticsProviderBase: any));
  }

  beforeEach(() => {
    fakeEditor = {
      getPath() { return 'foo'; },
      getGrammar() { return { scopeName: grammar }; },
    };
    spyOn(atom.workspace, 'getActiveTextEditor').andReturn(fakeEditor);
    linterReturn = Promise.resolve([]);
    fakeLinter = {
      grammarScopes: [grammar],
      scope: 'file',
      lintOnFly: true,
      lint: () => linterReturn,
    };
    spyOn(fakeLinter, 'lint').andCallThrough();
    linterAdapter = newLinterAdapter(fakeLinter);
  });

  afterEach(() => {
    jasmine.unspy(atom.workspace, 'getActiveTextEditor');
  });

  it('should dispatch the linter on an event', () => {
    eventCallback(fakeEditor);
    expect(fakeLinter.lint).toHaveBeenCalled();
  });

  it("should subscribe to 'all' for linters for allGrammarScopes", () => {
    newLinterAdapter({
      grammarScopes: [],
      allGrammarScopes: true,
      scope: 'file',
      lintOnFly: true,
      lint: () => linterReturn,
    });
    expect(subscribedToAny).toBe(true);
  });

  it('should dispatch an event on subscribe if no lint is in progress', () => {
    const callback = jasmine.createSpy();
    newUpdateSubscriber(callback);
    waitsFor(() => {
      return publishMessageUpdateSpy.callCount > 0;
    }, 'It should call the callback', 100);
  });

  it('should work when the linter is synchronous', () => {
    linterReturn = [{type: 'Error', filePath: 'foo'}];
    let message = null;
    linterAdapter.onMessageUpdate(m => {
      message = m;
    });
    eventCallback(fakeEditor);
    waitsFor(() => {
      return message && message.filePathToMessages.has('foo');
    }, 'The adapter should publish a message');
  });

  it('should not reorder results', () => {
    waitsForPromise(async () => {
      let numMessages = 0;
      let lastMessage = null;
      linterAdapter.onMessageUpdate(message => {
        numMessages++;
        lastMessage = message;
      });
      // Dispatch two linter requests.
      linterReturn = makePromise([{type: 'Error', filePath: 'bar'}], 50);
      eventCallback(fakeEditor);
      linterReturn = makePromise([{type: 'Error', filePath: 'baz'}], 10);
      eventCallback(fakeEditor);
      // If we call it once with a larger value, the first promise will resolve
      // first, even though the timeout is larger
      window.advanceClock(30);
      window.advanceClock(30);
      waitsFor(() => {
        return numMessages === 1 && lastMessage && lastMessage.filePathToMessages.has('baz');
      }, 'There should be only the latest message', 100);
    });
  });

  it('should delegate dispose', () => {
    expect(fakeDiagnosticsProviderBase.dispose).not.toHaveBeenCalled();
    linterAdapter.dispose();
    expect(fakeDiagnosticsProviderBase.dispose).toHaveBeenCalled();
  });
});

describe('message transformation functions', () => {
  const fileMessage = {
    type: 'Error',
    text: 'Uh oh',
    filePath: '/fu/bar',
  };

  const projectMessage = {
    type: 'Warning',
    text: 'Oh no!',
  };

  let providerName;
  let currentPath: string = (null: any);

  beforeEach(() => {
    providerName = 'provider';
    currentPath = 'foo/bar';
  });

  describe('linterMessageToDiagnosticMessage', () => {
    function checkMessage(linterMessage, expected) {
      invariant(providerName);
      const actual = linterMessageToDiagnosticMessage(linterMessage, providerName);
      const areEqual = arePropertiesEqual(actual, expected);
      expect(areEqual).toBe(true);
    }

    it('should turn a message with a filePath into a file scope diagnostic', () => {
      checkMessage(fileMessage, {
        scope: 'file',
        providerName,
        type: fileMessage.type,
        filePath: fileMessage.filePath,
        text: fileMessage.text,
      });
    });

    it('should turn a message without a filePath into a project scope diagnostic', () => {
      checkMessage(projectMessage, {
        scope: 'project',
        providerName,
        type: projectMessage.type,
        text: projectMessage.text,
      });
    });
  });

  describe('linterMessagesToDiagnosticUpdate', () => {
    function runWith(linterMessages) {
      return linterMessagesToDiagnosticUpdate(currentPath, linterMessages, providerName);
    }

    it('should invalidate diagnostics in the current file', () => {
      const result = runWith([]);
      invariant(result.filePathToMessages);
      expect(result.filePathToMessages.get(currentPath)).toEqual([]);
    });

    it('should name linters that do not provide a name', () => {
      providerName = undefined;
      const result = runWith([fileMessage]);
      invariant(result.filePathToMessages);
      const resultMessage = result.filePathToMessages.get(fileMessage.filePath)[0];
      expect(resultMessage.providerName).toEqual('Unnamed Linter');
    });

    it('should provide both project messages and file messages', () => {
      const result = runWith([fileMessage, projectMessage]);
      invariant(result.filePathToMessages);
      // The actual message transformations are tested in the tests from
      // linterMessageToDiagnosticMessage -- no need to duplicate them here.
      expect(result.filePathToMessages.get(fileMessage.filePath).length).toEqual(1);
      invariant(result.projectMessages);
      expect(result.projectMessages.length).toEqual(1);
    });
  });
});
