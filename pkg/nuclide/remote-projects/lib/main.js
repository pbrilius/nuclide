'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

var {CompositeDisposable, TextEditor} = require('atom');
var subscriptions: ?CompositeDisposable = null;
var pendingFiles = {};

var logger = null;
function getLogger() {
  return logger || (logger = require('nuclide-logging').getLogger());
}

var RemoteConnection = null;
function getRemoteConnection(): RemoteConnection {
  return RemoteConnection || (RemoteConnection = require('nuclide-remote-connection').RemoteConnection);
}

async function createRemoteConnection(remoteProjectConfig: RemoteConnectionConfiguration): Promise<?RemoteConnection> {
  var RemoteConnection = getRemoteConnection();
  var connection = new RemoteConnection(remoteProjectConfig);
  try {
    await connection.initialize();
    return connection;
  } catch (e) {
    // If connection fails using saved config, open connect dialog.
    var {openConnectionDialog} = require('nuclide-ssh-dialog');
    return openConnectionDialog({
      initialServer: remoteProjectConfig.host,
      initialCwd: remoteProjectConfig.cwd,
    });
  }
}

function addRemoteFolderToProject(connection: RemoteConnection) {
  var workingDirectoryUri = connection.getUriForInitialWorkingDirectory();
  // If restoring state, then the project already exists with local directory and wrong repo instances.
  // Hence, we remove it here, if existing, and add the new path for which we added a workspace opener handler.
  atom.project.removePath(workingDirectoryUri);

  atom.project.addPath(workingDirectoryUri);

  var subscription = atom.project.onDidChangePaths(paths => {
    if (paths.indexOf(workingDirectoryUri) !== -1) {
      return;
    }
    // The project was removed from the tree.
    subscription.dispose();

    closeOpenFilesForRemoteProject(connection.getConfig());

    var hostname = connection.getRemoteHostname();
    if (getRemoteConnection().getByHostname(hostname).length > 1) {
      getLogger().info('Remaining remote projects using Nuclide Server - no prompt to shutdown');
      return connection.close();
    }

    var choice = atom.confirm({
      message: 'No more remote projects on the host: `' + hostname + '`, Would you like to shutdown Nuclide server there?',
      buttons: ['Shutdown', 'Keep It'],
    });
    if (choice === 1) {
      return connection.close();
    }
    if (choice === 0) {
      connection.getClient().shutdownServer();
      return connection.close();
    }
  });
}

function closeOpenFilesForRemoteProject(remoteProjectConfig: RemoteConnectionConfiguration): Array<string> {
  var {closeTabForBuffer} = require('nuclide-atom-helpers');
  var {sanitizeNuclideUri} = require('./utils');

  var {host: projectHostname, cwd: projectDirectory} = remoteProjectConfig;
  var closedUris = [];
  atom.workspace.getTextEditors().forEach(editor => {
    var rawUrl = editor.getURI();
    if (!rawUrl) {
      return;
    }
    var uri = sanitizeNuclideUri(rawUrl);
    var {hostname: fileHostname, path: filePath} = require('nuclide-remote-uri').parse(uri);
    if (fileHostname === projectHostname && filePath.startsWith(projectDirectory)) {
      closeTabForBuffer(editor.getBuffer());
      if (filePath !== projectDirectory) {
        closedUris.push(uri);
      }
    }
  });
  return closedUris;
}

/**
 * Restore a nuclide project state from a serialized state of the remote connection config.
 */
async function restoreNuclideProjectState(remoteProjectConfig: RemoteConnectionConfiguration) {
  // TODO use the rest of the config for the connection dialog.
  var {host: projectHostname, cwd: projectDirectory} = remoteProjectConfig;
  // try to re-connect, then, add the project to atom.project and the tree.
  var connection = await createRemoteConnection(remoteProjectConfig);
  if (!connection) {
    getLogger().info('No RemoteConnection returned on restore state trial:', projectHostname, projectDirectory);
  }
  // Reload the project files that have empty text editors/buffers open.
  var closedUris = closeOpenFilesForRemoteProject(remoteProjectConfig);
  // On Atom restart, it tries to open the uri path as a file tab because it's not a local directory.
  // Hence, we close it in the cleanup, because we have the needed connection config saved
  // with the last opened files in the package state.
  if (connection) {
    closedUris.forEach(uri => atom.workspace.open(uri));
  }
}

function cleanupRemoteNuclideProjects() {
  getRemoteRootDirectories().forEach(directory => atom.project.removePath(directory.getPath()));
}

function getRemoteRootDirectories() {
  return atom.project.getDirectories().filter(directory => directory.getPath().startsWith('nuclide:'));
}

/**
 * The same TextEditor must be returned to prevent Atom from creating multiple tabs
 * for the same file, because Atom doesn't cache pending opener promises.
 */
async function createEditorForNuclide(connection: RemoteConnection, uri: string): TextEditor {
  var NuclideTextBuffer = require('./NuclideTextBuffer');

  var buffer = new NuclideTextBuffer(connection, {filePath: uri});
  buffer.setEncoding(atom.config.get('core.fileEncoding'));
  try {
    await buffer.load();
  } catch(err) {
    getLogger().warn('buffer load issue:', err);
    throw err;
  }
  return new TextEditor(/*editorOptions*/ {buffer, registerEditor: true});
}

module.exports = {

  activate(state: ?any): void {
    subscriptions = new CompositeDisposable();

    subscriptions.add(getRemoteConnection().onDidAddRemoteConnection(connection => {
      addRemoteFolderToProject(connection);
    }));

    // Don't do require or any other expensive operations in activate().
    subscriptions.add(atom.packages.onDidActivateInitialPackages(() => {
      // Subscribe opener before restoring the remote projects.
      subscriptions.add(atom.workspace.addOpener((uri = '') => {
        if (uri.startsWith('nuclide:')) {
          var connection = getRemoteConnection().getForUri(uri);
          // On Atom restart, it tries to open the uri path as a file tab because it's not a local directory.
          // We can't let that create a file with the initial working directory path.
          if (connection && uri !== connection.getUriForInitialWorkingDirectory()) {
            if (pendingFiles[uri]) {
              return pendingFiles[uri];
            }
            var textEditorPromise = pendingFiles[uri] = createEditorForNuclide(connection, uri);
            var removeFromCache = () => delete pendingFiles[uri];
            textEditorPromise.then(removeFromCache, removeFromCache);
            return textEditorPromise;
          }
        }
      }));
    subscriptions.add(atom.commands.add(
        'atom-workspace',
        'nuclide-remote-projects:connect',
        () => require('nuclide-ssh-dialog').openConnectionDialog()
    ));

      // Remove remote projects added in case of reloads.
      // We already have their connection config stored.
      var remoteProjectsConfig = (state && state.remoteProjectsConfig) || [];
      remoteProjectsConfig.forEach(restoreNuclideProjectState);
      // Clear obsolete config.
      atom.config.set('nuclide.remoteProjectsConfig', []);
    }));
  },

  serialize(): ?any {
    var remoteProjectsConfig = getRemoteRootDirectories()
        .map(directory => {
          var connection = getRemoteConnection().getForUri(directory.getPath());
          return connection && connection.getConfig();
        }).filter(config => !!config);
    return {
      remoteProjectsConfig,
    };
  },

  deactivate(): void {
    // This should always be true here, but we do this to appease Flow.
    if (subscriptions) {
      subscriptions.dispose();
      subscriptions = null;
    }
  },

  createRemoteDirectoryProvider(): RemoteDirectoryProvider {
    var RemoteDirectoryProvider = require('./RemoteDirectoryProvider');
    return new RemoteDirectoryProvider();
  },
};