'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import ConnectionTracker from './ConnectionTracker';

const SshConnection = require('ssh2').Client;
const fs = require('fs-plus');
const net = require('net');
const logger = require('nuclide-logging').getLogger();
const invariant = require('assert');

const {RemoteConnection} = require('./RemoteConnection');
const {fsPromise} = require('nuclide-commons');

// Sync word and regex pattern for parsing command stdout.
const SYNC_WORD = 'SYNSYN';
const STDOUT_REGEX = /SYNSYN[\s\S\n]*({.*})[\s\S\n]*SYNSYN/;
const READY_TIMEOUT = 60000;

export type SshConnectionConfiguration = {
  host: string; // host nuclide server is running on
  sshPort: number; // ssh port of host nuclide server is running on
  username: string; // username to authenticate as
  pathToPrivateKey: string; // The path to private key
  remoteServerCommand: string; // Command to use to start server
  cwd: string; // Path to remote directory user should start in upon connection.
  authMethod: string; // Which of the authentication methods in `SupportedMethods` to use.
  password: string; // for simple password-based authentication
}

const SupportedMethods = {
  SSL_AGENT: 'SSL_AGENT',
  PASSWORD: 'PASSWORD',
  PRIVATE_KEY: 'PRIVATE_KEY',
};

/**
 * The server is asking for replies to the given prompts for
 * keyboard-interactive user authentication.
 *
 * @param name is generally what you'd use as
 *     a window title (for GUI apps).
 * @param prompts is an array of { prompt: 'Password: ',
 *     echo: false } style objects (here echo indicates whether user input
 *     should be displayed on the screen).
 * @param finish: The answers for all prompts must be provided as an
 *     array of strings and passed to finish when you are ready to continue. Note:
 *     It's possible for the server to come back and ask more questions.
 */
export type KeyboardInteractiveCallback = (
  name: string,
  instructions: string,
  instructionsLang: string,
  prompts: Array<{prompt: string; echo: boolean;}>,
  finish: (answers: Array<string>) => void)  => void;

export type SshConnectionDelegate = {
  /** Invoked when server requests keyboard interaction */
  onKeyboardInteractive: KeyboardInteractiveCallback;
  /** Invoked when trying to connect */
  onWillConnect: (config: SshConnectionConfiguration) => void;
  /** Invoked when connection is sucessful */
  onDidConnect: (connection: RemoteConnection, config: SshConnectionConfiguration) => void;
  /** Invoked when connection is fails */
  onError: (error: Error, config: SshConnectionConfiguration) => void;
}

export class SshHandshake {
  _delegate: SshConnectionDelegate;
  _connection: SshConnection;
  _config: SshConnectionConfiguration;
  _forwardingServer: net.Server;
  _remoteHost: ?string;
  _remotePort: ?number;
  _certificateAuthorityCertificate: Buffer;
  _clientCertificate: Buffer;
  _clientKey: Buffer;
  static SupportedMethods: {};

  constructor(delegate: SshConnectionDelegate, connection?: SshConnection) {
    this._delegate = delegate;
    this._connection = connection ? connection : new SshConnection();
    this._connection.on('ready', this._onConnect.bind(this));
    this._connection.on('error', e => this._delegate.onError(e, this._config));
    this._connection.on('keyboard-interactive', this._onKeyboardInteractive.bind(this));
  }

  async connect(config: SshConnectionConfiguration): Promise<void> {
    this._config = config;

    this._delegate.onWillConnect(this._config);

    const existingConnection = RemoteConnection
      .getByHostnameAndPath(this._config.host, this._config.cwd);

    if (existingConnection) {
      this._delegate.onDidConnect(existingConnection, this._config);
      return;
    }

    const connection = await RemoteConnection.createConnectionBySavedConfig(
      this._config.host,
      this._config.cwd,
    );

    if (connection) {
      this._delegate.onDidConnect(connection, this._config);
      return;
    }

    const {lookupPreferIpv6} = require('nuclide-commons').dnsUtils;
    return lookupPreferIpv6(config.host).then((address) => {
      if (config.authMethod === SupportedMethods.SSL_AGENT) {
        // Point to ssh-agent's socket for ssh-agent-based authentication.
        let agent = process.env['SSH_AUTH_SOCK'];
        if (!agent && /^win/.test(process.platform)) {
          // #100: On Windows, fall back to pageant.
          agent = 'pageant';
        }
        this._connection.connect({
          host: address,
          port: config.sshPort,
          username: config.username,
          agent,
          tryKeyboard: true,
          readyTimeout: READY_TIMEOUT,
        });
      } else if (config.authMethod === SupportedMethods.PASSWORD) {
          // When the user chooses password-based authentication, we specify
          // the config as follows so that it tries simple password auth and
          // failing that it falls through to the keyboard interactive path
        this._connection.connect({
          host: address,
          port: config.sshPort,
          username: config.username,
          password: config.password,
          tryKeyboard: true,
        });
      } else if (config.authMethod === SupportedMethods.PRIVATE_KEY) {
        // We use fs-plus's normalize() function because it will expand the ~, if present.
        const expandedPath = fs.normalize(config.pathToPrivateKey);
        fsPromise.readFile(expandedPath).then(privateKey => {
          this._connection.connect({
            host: address,
            port: config.sshPort,
            username: config.username,
            privateKey,
            tryKeyboard: true,
            readyTimeout: READY_TIMEOUT,
          });
        }).catch((e) => {
          this._delegate.onError(e, this._config);
        });
      } else {
        throw new Error('Invalid authentication method');
      }
    }).catch((e) => {
      this._delegate.onError(e, this._config);
    });
  }

  cancel() {
    this._connection.end();
  }

  _onKeyboardInteractive(
      name: string,
      instructions: string,
      instructionsLang: string,
      prompts: Array<{prompt: string; echo: boolean;}>,
      finish: (answers: Array<string>) => void): void {
    this._delegate.onKeyboardInteractive(name, instructions, instructionsLang, prompts, finish);
  }

  _forwardSocket(socket: net.Socket): void {
    this._connection.forwardOut(
      /* $FlowIssue t9212378 */
      socket.remoteAddress,
      /* $FlowIssue t9212378 */
      socket.remotePort,
      'localhost',
      this._remotePort,
      (err, stream) => {
        if (err) {
          /* $FlowIssue t9212378 */
          socket.end();
          logger.error(err);
          return;
        }
        /* $FlowIssue t9212378 */
        socket.pipe(stream);
        stream.pipe(socket);
      }
    );
  }

  _updateServerInfo(serverInfo: {}) {
    invariant(serverInfo.port);
    this._remotePort = serverInfo.port;
    this._remoteHost = `${serverInfo.hostname || this._config.host}`;
    // Because the value for the Initial Directory that the user supplied may have
    // been a symlink that was resolved by the server, overwrite the original `cwd`
    // value with the resolved value.
    invariant(serverInfo.workspace);
    this._config.cwd = serverInfo.workspace;
    invariant(serverInfo.ca);
    this._certificateAuthorityCertificate = serverInfo.ca;
    invariant(serverInfo.cert);
    this._clientCertificate = serverInfo.cert;
    invariant(serverInfo.key);
    this._clientKey = serverInfo.key;
  }

  _isSecure(): boolean {
    return !!(this._certificateAuthorityCertificate
        && this._clientCertificate
        && this._clientKey);
  }

  _startRemoteServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      let stdOut = '';

      //TODO: escape any single quotes
      //TODO: the timeout value shall be configurable using .json file too (t6904691).
      const cmd = `${this._config.remoteServerCommand} --workspace=${this._config.cwd}`
        + ` --common_name=${this._config.host} -t 60`;

      // This imitates a user typing:
      //   $ TERM=nuclide ssh server
      // then on the interactive prompt executing the remote server command.  If
      // that works, then nuclide should also work.
      //
      // The reason we don'y use exec here is because people like to put as the
      // last statement in their .bashrc zsh or fish.  This starts an
      // and interactive child shell that never exits if you exec.
      //
      // This is a bad idea because besides breaking us, it also breaks this:
      // $ ssh server any_cmd
      //
      // As a last resort we also set term to 'nuclide' so that if anything we
      // haven't thought of happens, the user can always add the following to
      // the top of their favorite shell startup file:
      //
      //   [ "$TERM" = "nuclide"] && return;
      this._connection.shell({term: 'nuclide'}, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }
        stream.on('close', (code, signal) => {
          const rejectWithError = (error) => {
            logger.error(error);
            const errorText = `${error}\n\nstdout:${stdOut}`;
            reject(new Error(errorText));
          };

          // Note: this code is probably the code from the child shell if one
          // is in use.
          if (code === 0) {
            let serverInfo;
            const match = STDOUT_REGEX.exec(stdOut);
            if (!match) {
              rejectWithError(`Bad stdout from remote server: ${stdOut}`);
              return;
            }
            try {
              serverInfo = JSON.parse(match[1]);
            } catch (e) {
              rejectWithError(`Bad JSON reply from Nuclide server: ${match[1]}`);
              return;
            }
            if (!serverInfo.workspace) {
              rejectWithError(`Could not find directory: ${this._config.cwd}`);
              return;
            }

            // Update server info that is needed for setting up client.
            this._updateServerInfo(serverInfo);
            resolve(undefined);
          } else {
            reject(new Error(stdOut));
          }
        }).on('data', data => {
          stdOut += data;
        });
        // Yes we exit twice.  This is because people who use shells like zsh
        // or fish, etc like to put zsh/fish as the last statement of their
        // .bashrc.  This means that when we exit zsh/fish, we then have to exit
        // the parent bash shell.
        //
        // The second exit is ignored when there is only one shell.
        //
        // We will still hang forever if they have a shell within a shell within
        // a shell.  But I can't bring myself to exit 3 times.
        //
        // TODO: (mikeo) There is a SHLVL environment variable set that can be
        // used to decide how many times to exit
        stream.end(`echo ${SYNC_WORD};${cmd};echo ${SYNC_WORD}\nexit\nexit\n`);
      });
    });
  }

  async _onConnect(): Promise<void> {
    try {
      await this._startRemoteServer();
    } catch (e) {
      this._delegate.onError(e, this._config);
      return;
    }

    const finishHandshake = async (connection: RemoteConnection) => {
      try {
        await connection.initialize();
      } catch (e) {
        const error = new Error(
          `Failed to connect to Nuclide server on ${this._config.host}: ${e.message}`,
        );
        this._delegate.onError(error, this._config);
      }
      this._delegate.onDidConnect(connection, this._config);
      // If we are secure then we don't need the ssh tunnel.
      if (this._isSecure()) {
        this._connection.end();
      }
    };

    // Use an ssh tunnel if server is not secure
    if (this._isSecure()) {
      invariant(this._remoteHost);
      invariant(this._remotePort);
      const connection = new RemoteConnection({
        host: this._remoteHost,
        port: this._remotePort,
        cwd: this._config.cwd,
        certificateAuthorityCertificate: this._certificateAuthorityCertificate,
        clientCertificate: this._clientCertificate,
        clientKey: this._clientKey,
      });
      finishHandshake(connection);
    } else {
      /* $FlowIssue t9212378 */
      this._forwardingServer = net.createServer(sock => {
        this._forwardSocket(sock);
      }).listen(0, 'localhost', () => {
        const localPort = this._getLocalPort();
        invariant(localPort);
        const connection = new RemoteConnection({
          host: 'localhost',
          port: localPort,
          cwd: this._config.cwd,
        });
        finishHandshake(connection);
      });
    }
  }

  _getLocalPort(): ?number {
    return this._forwardingServer ? this._forwardingServer.address().port : null;
  }

  getConfig(): SshConnectionConfiguration {
    return this._config;
  }
}

SshHandshake.SupportedMethods = SupportedMethods;

export function decorateSshConnectionDelegateWithTracking(
  delegate: SshConnectionDelegate,
): SshConnectionDelegate {
  let connectionTracker;

  return {
    onKeyboardInteractive: (
      name: string,
      instructions: string,
      instructionsLang: string,
      prompts: Array<{prompt: string; echo: boolean;}>,
      finish: (answers: Array<string>) => void,
    ) => {
      invariant(connectionTracker);
      connectionTracker.trackPromptYubikeyInput();
      delegate.onKeyboardInteractive(
        name,
        instructions,
        instructionsLang,
        prompts,
        (answers) => {
          invariant(connectionTracker);
          connectionTracker.trackFinishYubikeyInput();
          finish(answers);
        },
      );
    },
    onWillConnect: (config: SshConnectionConfiguration) => {
      connectionTracker = new ConnectionTracker(config);
      delegate.onWillConnect(config);
    },
    onDidConnect: (connection: RemoteConnection, config: SshConnectionConfiguration) => {
      invariant(connectionTracker);
      connectionTracker.trackSuccess();
      delegate.onDidConnect(connection, config);
    },
    onError: (error: Error, config: SshConnectionConfiguration) => {
      invariant(connectionTracker);
      connectionTracker.trackFailure(error);
      delegate.onError(error, config);
    },
  };
}
