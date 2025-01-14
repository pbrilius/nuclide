'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

const BASE_ITEM_URI = 'nuclide-home://';
const CONFIG_KEY = 'nuclide-home.showHome';

function findHomePaneAndItem(): {pane: ?atom$Pane, item: ?Object} {
  const pane = atom.workspace.paneForURI(BASE_ITEM_URI);
  const item = pane ? pane.itemForURI(BASE_ITEM_URI) : null;
  return {pane, item};
}

describe('Home', () => {

  beforeEach(() => {
    waitsForPromise(async () => {
      jasmine.unspy(window, 'setTimeout');
      await atom.packages.activatePackage('nuclide-home');
    });
  });

  it('does not appear by default', () => {
    expect(findHomePaneAndItem().item).toBeTruthy();
  });

  it('appears when opened by URI, persisting into config', () => {
    waitsForPromise(async () => {
      await atom.workspace.open(BASE_ITEM_URI);
      const {item} = findHomePaneAndItem();
      expect(item).toBeTruthy();
      if (item) {
        expect(item.getTitle()).toEqual('Home');
        expect(item.innerHTML).toContain('Welcome to Nuclide');
        expect(atom.config.get(CONFIG_KEY)).toBeTruthy();
      }
    });
  });

  it('disappears when closed, persisting into config', () => {
    waitsForPromise(async () => {
      await atom.workspace.open(BASE_ITEM_URI);
      const {pane, item} = findHomePaneAndItem();
      expect(item).toBeTruthy();
      if (pane && item) {
        pane.activateItem(item);
        atom.commands.dispatch(atom.views.getView(atom.workspace), 'core:close');
        expect(findHomePaneAndItem().item).toBeFalsy();
        expect(atom.config.get(CONFIG_KEY)).toBeFalsy();
      }
    });
  });

});
