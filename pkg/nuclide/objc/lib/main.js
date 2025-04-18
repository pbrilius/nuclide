'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import type ObjectiveCColonIndenter from './ObjectiveCColonIndenter';
import type ObjectiveCBracketBalancer from './ObjectiveCBracketBalancer';

class Activation {
  _indentFeature: ObjectiveCColonIndenter;
  _bracketFeature: ObjectiveCBracketBalancer;
  _configSubscription: atom$Disposable;

  constructor() {
    const ObjectiveCColonIndenterCtr = require('./ObjectiveCColonIndenter');
    this._indentFeature = new ObjectiveCColonIndenterCtr();
    this._indentFeature.enable();

    const ObjectiveCBracketBalancerCtr = require('./ObjectiveCBracketBalancer');
    this._bracketFeature = new ObjectiveCBracketBalancerCtr();
    this._configSubscription = atom.config.observe(
        'nuclide-objc.enableAutomaticSquareBracketInsertion',
        enabled => enabled ? this._bracketFeature.enable() : this._bracketFeature.disable());
  }

  dispose() {
    this._configSubscription.dispose();
    this._bracketFeature.disable();
    this._indentFeature.disable();
  }
}

let activation: ?Activation;

module.exports = {
  // $FlowIssue https://github.com/facebook/flow/issues/620
  config: require('../package.json').nuclide.config,

  activate(state: ?mixed): void {
    if (!activation) {
      activation = new Activation();
    }
  },

  deactivate(): void {
    if (activation) {
      activation.dispose();
      activation = null;
    }
  },
};
