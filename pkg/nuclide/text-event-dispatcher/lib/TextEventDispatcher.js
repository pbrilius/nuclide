'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

const invariant = require('assert');
const {Disposable, CompositeDisposable} = require('atom');

const {debounce} = require('nuclide-commons');

type EventCallback = (editor: TextEditor) => mixed;

type Event = 'did-reload' | 'did-change' | 'did-save' | 'did-open';

// A reload changes the text in the buffer, so it should trigger a refresh.
const FILE_CHANGE_EVENTS = ['did-change', 'did-reload', 'did-open'];

// A reload basically indicates that an external program saved the file, so
// it should trigger a refresh.
const FILE_SAVE_EVENTS = ['did-save', 'did-reload', 'did-open'];

/**
 * Stores callbacks keyed on grammar and event, to allow for easy retrieval when
 * we need to dispatch to all callbacks registered for a given (grammar, event)
 * pair.
 */
class TextCallbackContainer<CallbackArg> {
  // grammar -> event -> callback
  // invariant: no empty maps or sets (they should be removed instead)
  _callbacks: Map<string, Map<Event, Set<(arg: CallbackArg) => mixed>>>;

  // event -> callback
  // invariant: no keys mapping to empty sets (they should be removed instead)
  _allGrammarCallbacks: Map<Event, Set<(arg: CallbackArg) => mixed>>;

  constructor() {
    this._callbacks = new Map();
    this._allGrammarCallbacks = new Map();
  }

  getCallbacks(grammar: string, event: Event): Set<(arg: CallbackArg) => mixed> {
    const eventMap = this._callbacks.get(grammar);
    const callbacksForGrammar = this._getCallbacksFromEventMap(eventMap, event);
    const callbacksForAll = this._getCallbacksFromEventMap(this._allGrammarCallbacks, event);
    const resultSet = new Set();
    const add = callback => { resultSet.add(callback); };
    callbacksForGrammar.forEach(add);
    callbacksForAll.forEach(add);
    return resultSet;
  }

  isEmpty(): boolean {
    return this._callbacks.size === 0 && this._allGrammarCallbacks.size === 0;
  }

  _getCallbacksFromEventMap(
    eventMap: Map<Event, Set<(arg: CallbackArg) => mixed>>,
    event: Event): Set<(arg: CallbackArg
  ) => mixed> {
    if (!eventMap) {
      return new Set();
    }
    const callbackSet = eventMap.get(event);
    if (!callbackSet) {
      return new Set();
    }
    return callbackSet;
  }

  addCallback(
      grammarScopes: Iterable<string> | 'all',
      events: Iterable<Event>,
      callback: (arg: CallbackArg) => mixed
      ): void {
    if (grammarScopes === 'all') {
      this._addToEventMap(this._allGrammarCallbacks, events, callback);
    } else {
      for (const grammarScope of grammarScopes) {
        let eventMap = this._callbacks.get(grammarScope);
        if (!eventMap) {
          eventMap = new Map();
          this._callbacks.set(grammarScope, eventMap);
        }
        this._addToEventMap(eventMap, events, callback);
      }
    }
  }

  // remove the callbacks, maintaining the invariant that there should be no
  // empty maps or sets in this._callbacks
  removeCallback(
      grammarScopes: Iterable<string> | 'all',
      events: Iterable<Event>,
      callback: (arg: CallbackArg) => mixed
      ): void {
    if (grammarScopes === 'all') {
      this._removeFromEventMap(this._allGrammarCallbacks, events, callback);
    } else {
      for (const grammarScope of grammarScopes) {
        const eventMap = this._callbacks.get(grammarScope);
        invariant(eventMap);
        this._removeFromEventMap(eventMap, events, callback);
        if (eventMap.size === 0) {
          this._callbacks.delete(grammarScope);
        }
      }
    }
  }

  _addToEventMap(
      eventMap: Map<Event, Set<(arg: CallbackArg) => mixed>>,
      events: Iterable<Event>,
      callback: (arg: CallbackArg) => mixed): void {
    for (const event of events) {
      let callbackSet = eventMap.get(event);
      if (!callbackSet) {
        callbackSet = new Set();
        eventMap.set(event, callbackSet);
      }
      callbackSet.add(callback);
    }
  }

  _removeFromEventMap(
      eventMap: Map<Event, Set<(arg: CallbackArg) => mixed>>,
      events: Iterable<Event>,
      callback: (arg: CallbackArg) => mixed): void {
    for (const event of events) {
      const callbackSet = eventMap.get(event);
      invariant(callbackSet);
      callbackSet.delete(callback);
      if (callbackSet.size === 0) {
        eventMap.delete(event);
      }
    }
  }
}

/**
 * Meant to make it simple and easy for a DiagnosticProvider to subscribe to
 * relevant events. Currently provides two methods, onFileChange and onFileSave.
 * A DiagnosticProvider will typically subscribe to only one, depending on
 * whether it wants to be notified whenever a file changes or only when it is
 * saved.
 *
 * Both methods take two arguments:
 * - An Iterable of grammars for which the DiagnosticProvider can provide
 * diagnostics.
 * - The callback to be called on a text event.
 *
 * A TextEventDispatcher will be subscribed to text events if and only if it has
 * subscribers of its own. If all subscribers unsubscribe, it will unsubscribe
 * from Atom's text events.
 *
 */
class TextEventDispatcher {
  _callbackContainer: TextCallbackContainer<TextEditor>;

  _editorListenerDisposable: ?CompositeDisposable;

  _pendingEvents: WeakMap<atom$TextBuffer, Set<Event>>;

  constructor() {
    this._callbackContainer = new TextCallbackContainer();
    this._editorListenerDisposable = null;
    this._pendingEvents = new WeakMap();
  }

  _onEvents(
    grammarScopes: Iterable<string> | 'all',
    events: Iterable<Event>,
    callback: EventCallback,
  ) {
    if (this._callbackContainer.isEmpty()) {
      this._registerEditorListeners();
    }
    // Sometimes these events get triggered several times in succession
    // (particularly on startup).
    const debouncedCallback = debounce(callback, 50, true);
    this._callbackContainer.addCallback(grammarScopes, events, debouncedCallback);
    const disposables = new Disposable(() => {
      this._callbackContainer.removeCallback(grammarScopes, events, debouncedCallback);
      if (this._callbackContainer.isEmpty()) {
        this._deregisterEditorListeners();
      }
    });
    return disposables;
  }

  onFileChange(grammarScopes: Iterable<string>, callback: EventCallback): atom$Disposable {
    return this._onEvents(grammarScopes, FILE_CHANGE_EVENTS, callback);
  }
  onAnyFileChange(callback: EventCallback): atom$Disposable {
    return this._onEvents('all', FILE_CHANGE_EVENTS, callback);
  }

  onFileSave(grammarScopes: Iterable<string>, callback: EventCallback): atom$Disposable {
    return this._onEvents(grammarScopes, FILE_SAVE_EVENTS, callback);
  }

  onAnyFileSave(callback: EventCallback): atom$Disposable {
    return this._onEvents('all', FILE_SAVE_EVENTS, callback);
  }

  _registerEditorListeners(): void {
    if (!this._editorListenerDisposable) {
      this._editorListenerDisposable = new CompositeDisposable();
    }

    // Whenever the active pane item changes, we check to see if there are any
    // pending events for the newly-focused TextEditor.
    this._getEditorListenerDisposable().add(atom.workspace.onDidChangeActivePaneItem(() => {
      const currentEditor = atom.workspace.getActiveTextEditor();
      if (currentEditor) {
        const pendingEvents = this._pendingEvents.get(currentEditor.getBuffer());
        if (pendingEvents) {
          for (const event of pendingEvents) {
            this._dispatchEvents(currentEditor, event);
          }
          this._pendingEvents.delete(currentEditor.getBuffer());
        }
      }
    }));

    this._getEditorListenerDisposable().add(atom.workspace.observeTextEditors(editor => {
      const buffer = editor.getBuffer();
      const makeDispatch = (event: Event) => {
        return () => {
          this._dispatchEvents(editor, event);
        };
      };
      this._getEditorListenerDisposable().add(buffer.onDidStopChanging(makeDispatch('did-change')));
      this._getEditorListenerDisposable().add(buffer.onDidSave(makeDispatch('did-save')));
      this._getEditorListenerDisposable().add(buffer.onDidReload(makeDispatch('did-reload')));
      this._dispatchEvents(editor, 'did-open');
    }));
  }

  _deregisterEditorListeners() {
    if (this._editorListenerDisposable) {
      this._getEditorListenerDisposable().dispose();
      this._editorListenerDisposable = null;
    }
  }

  _dispatchEvents(editor: TextEditor, event: Event): void {
    const currentEditor = atom.workspace.getActiveTextEditor();
    if (currentEditor && editor === currentEditor) {
      const callbacks = this._callbackContainer.getCallbacks(editor.getGrammar().scopeName, event);
      for (const callback of callbacks) {
        callback(editor);
      }
    // We want to avoid storing pending events if this event was generated by
    // the same buffer as the current editor, to avoid duplicating events when
    // multiple panes have the same file open.
    } else if (!currentEditor || editor.getBuffer() !== currentEditor.getBuffer()) {
      // Trigger this event next time we switch to an editor with this buffer.
      const buffer = editor.getBuffer();
      let events = this._pendingEvents.get(buffer);
      if (!events) {
        events = new Set();
        this._pendingEvents.set(buffer, events);
      }
      events.add(event);
    }
  }

  _getEditorListenerDisposable(): CompositeDisposable {
    const disposable = this._editorListenerDisposable;
    invariant(disposable, 'TextEventDispatcher disposable is not initialized');
    return disposable;
  }
}

module.exports = {
  TextEventDispatcher,
  __TEST__: {
    TextCallbackContainer,
  },
};
