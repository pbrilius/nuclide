'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

const {Disposable} = require('atom');
const {EventEmitter} = require('events');
const Constants = require('./Constants');

import type {Dispatcher} from 'flux';
import type {
  nuclide_debugger$DebuggerInstance,
  nuclide_debugger$Service,
} from 'nuclide-debugger-interfaces/service';
import type * as DebuggerProcessInfo from './DebuggerProcessInfo';

/**
 * Flux style Store holding all data used by the debugger plugin.
 */
class DebuggerStore {
  _dispatcher: Dispatcher;
  _eventEmitter: EventEmitter;
  _dispatcherToken: any;

  // Stored values
  _debuggerProcess: ?nuclide_debugger$DebuggerInstance;
  _error: ?string;
  _services: Set<nuclide_debugger$Service>;
  _processSocket: ?string;

  constructor(dispatcher: Dispatcher) {
    this._dispatcher = dispatcher;
    this._eventEmitter = new EventEmitter();
    this._dispatcherToken = this._dispatcher.register(this._handlePayload.bind(this));

    this._debuggerProcess = null;
    this._error = null;
    this._services = new Set();
    this._processSocket = null;
  }

  dispose() {
    this._eventEmitter.removeAllListeners();
    this._dispatcher.unregister(this._dispatcherToken);
    if (this._debuggerProcess) {
      this._debuggerProcess.dispose();
    }
  }

  getDebuggerProcess(): ?nuclide_debugger$DebuggerInstance {
    return this._debuggerProcess;
  }

  getError(): ?string {
    return this._error;
  }

  /**
   * Return attachables.
   *
   * @param optional service name (e.g. lldb) to filter resulting attachables.
   */
  getProcessInfoList(serviceName?: string): Promise<Array<DebuggerProcessInfo>> {
    return Promise.all(
        require('nuclide-commons').array.from(this._services)
          .map(service => {
            if (!serviceName || service.name === serviceName) {
              return service.getProcessInfoList();
            } else {
              return Promise.resolve([]);
            }
          }))
        .then(values => [].concat.apply([], values));
  }

  getProcessSocket(): ?string {
    return this._processSocket;
  }

  onChange(callback: () => void): Disposable {
    const emitter = this._eventEmitter;
    this._eventEmitter.on('change', callback);
    return new Disposable(() => emitter.removeListener('change', callback));
  }

  _handlePayload(payload: Object) {
    switch (payload.actionType) {
      case Constants.Actions.SET_PROCESS_SOCKET:
        this._processSocket = payload.data;
        break;
      case Constants.Actions.ADD_SERVICE:
        if (this._services.has(payload.data)) {
          return;
        }
        this._services.add(payload.data);
        break;
      case Constants.Actions.REMOVE_SERVICE:
        if (!this._services.has(payload.data)) {
          return;
        }
        this._services.delete(payload.data);
        break;
      case Constants.Actions.SET_ERROR:
        this._error = payload.data;
        break;
      case Constants.Actions.SET_DEBUGGER_PROCESS:
        this._debuggerProcess = payload.data;
        break;
      default:
        return;
    }
    this._eventEmitter.emit('change');
  }
}

module.exports = DebuggerStore;
