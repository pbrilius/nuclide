'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import type {NuclideUri} from 'nuclide-remote-uri';
import type RemoteFile from './RemoteFile';

import NuclideClient from 'nuclide-server/lib/NuclideClient';
import NuclideLocalEventbus from 'nuclide-server/lib/NuclideLocalEventbus';

const localClients: {[rootPath: string]: NuclideClient} = {};
const {RemoteConnection} = require('./RemoteConnection');
let localEventBus: ?NuclideLocalEventbus = null;
let defaultLocalClient: ?NuclideClient = null;
const {containsPathSync} = require('./utils');
const {isRemote} = require('nuclide-remote-uri');

module.exports = {
  /**
   * @return null if the specified path is a remote NuclideUri and the corresponding
   *     RemoteConnection has not been created yet. This is likely to happen if getClient() is
   *     called early in the startup process and we are trying to restore a remote project root.
   */
  getClient(path: NuclideUri): ?NuclideClient {
    if (isRemote(path)) {
      const connection = RemoteConnection.getForUri(path);
      return connection ? connection.getClient() : null;
    } else {
      if (!localEventBus) {
        localEventBus = new NuclideLocalEventbus();
      }
      if (!defaultLocalClient) {
        defaultLocalClient = new NuclideClient('local', localEventBus);
      }
      // Return a default local client with no working directory if Atom was started to edit a
      // single file with a command like: $ atom file.php
      let localClient = defaultLocalClient;
      atom.project.getPaths().forEach(rootPath => {
        if (!containsPathSync(rootPath, path)) {
          return;
        }
        // Create a local client with its root as the working directory, if none already exists.
        if (!localClients[rootPath]) {
          localClients[rootPath] = new NuclideClient(
            /*id: string*/ 'local/' + rootPath,
            /*eventbus: NuclideLocalEventBus*/ localEventBus,
            /*options: NuclideClientOptions*/ {cwd: rootPath}
          );
        }
        localClient = localClients[rootPath];
      });
      return localClient;
    }
  },

  getFileForPath(filePath: NuclideUri): ?(atom$File | RemoteFile) {
    if (isRemote(filePath)) {
      const connection = RemoteConnection.getForUri(filePath);
      if (!connection) {
        return null;
      }
      return connection.createFile(filePath);
    } else {
      const {File} = require('atom');
      return new File(filePath);
    }
  },
};
