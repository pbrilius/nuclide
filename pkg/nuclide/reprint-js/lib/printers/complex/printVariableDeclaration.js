'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import type {Context, Lines, Print} from '../../types/common';
import type {VariableDeclaration} from 'ast-types-flow';

const flatten = require('../../utils/flatten');
const markers = require('../../constants/markers');

function printVariableDeclaration(
  print: Print,
  node: VariableDeclaration,
  context: Context,
): Lines {
  const last = context.path.last();

  const parts = [
    node.kind,
    markers.space,
    flatten(node.declarations.map((node, i) => {
      if (i === 0) {
        return print(node);
      } else {
        return [
          ',',
          markers.space,
          print(node),
        ];
      }
    })),
  ];

  // For these node types we shouldn't break or add a semicolon.
  const nonBreakingParents = new Set([
    'ForInStatement',
    'ForOfStatement',
    'ForStatement',
  ]);

  if (!last || nonBreakingParents.has(last.type)) {
    return flatten(parts);
  } else {
    return flatten([
      parts,
      markers.noBreak,
      ';',
      markers.hardBreak,
    ]);
  }
}

module.exports = printVariableDeclaration;
