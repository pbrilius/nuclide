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

import {
  checkOutput,
  findNearestFile,
  safeSpawn,
  PromiseQueue,
} from 'nuclide-commons';

const logger = require('nuclide-logging').getLogger();

const ERROR_RESPONSES = new Set([
  'failure',
  'error',
  'exception',
]);

/**
 * Wraps an ocamlmerlin process; provides api access to
 * ocamlmerlin's json-over-stdin/stdout protocol.
 *
 * This is based on the protocol description at:
 *   https://github.com/the-lambda-church/merlin/blob/master/PROTOCOL.md
 *   https://github.com/the-lambda-church/merlin/tree/master/src/frontend
 */
export class MerlinProcess {
  _proc: child_process$ChildProcess;
  _promiseQueue: PromiseQueue;
  _running: bool;

  constructor(proc: child_process$ChildProcess) {
    this._proc = proc;
    this._promiseQueue = new PromiseQueue();
    this._running = true;
    this._proc.on('exit', (code, signal) => { this._running = false; });
  }

  isRunning(): bool {
    return this._running;
  }

  /**
   * Tell merlin where to find its per-repo .merlin config file.
   *
   * Configuration file format description:
   *   https://github.com/the-lambda-church/merlin/wiki/project-configuration
   *
   * @return a dummy cursor position on success
   */
  async pushDotMerlinPath(path: NuclideUri): Promise<mixed> {
    return await this._promiseQueue.submit(async (resolve, reject) => {
      const result = await this.runSingleCommand([
        'reset',
        'dot_merlin',
        [path],
        'auto',
      ]);
      resolve(result);
    });
  }

  /**
   * Set the buffer content to query against. Merlin uses an internal
   * buffer (name + content) that is independent from file content on
   * disk.
   *
   * @return on success: a cursor position pointed at the end of the buffer
   */
  async pushNewBuffer(name: NuclideUri, content: string): Promise<mixed> {
    return await this._promiseQueue.submit(async (resolve, reject) => {
      await this.runSingleCommand([
        'reset',
        'auto', // one of {ml, mli, auto}
        name,
      ]);

      const result = await this.runSingleCommand([
        'tell',
        'source',
        content,
      ]);
      resolve(result);
    });
  }

  /**
   * Find definition
   *
   * `kind` is one of 'ml' or 'mli'
   *
   * Note: ocamlmerlin line numbers are 1-based.
   * @return null if nothing was found; a position of the form
   *   {"file": "somepath", "pos": {"line": 41, "col": 5}}.
   */
  async locate(
    path: NuclideUri,
    line: number,
    col: number,
    kind: string,
  ): Promise<?{file: string, pos: {line: number, col: number}}> {
    return await this._promiseQueue.submit(async (resolve, reject) => {
      const location: Object = await this.runSingleCommand([
        'locate',
        /* identifier name */ '',
        kind,
        'at',
        {line: line + 1, col},
      ]);


      if (typeof location === 'string') {
        return reject(Error(location));
      }

      // Ocamlmerlin doesn't include a `file` field at all if the destination is
      // in the same file.
      if (!location.file) {
        location.file = path;
      }

      resolve(location);
    });
  }

  async complete(path: NuclideUri, line: number, col: number, prefix: string): Promise<mixed> {
    return await this._promiseQueue.submit(async (resolve, reject) => {
      const result = await this.runSingleCommand([
        'complete',
        'prefix',
        prefix,
        'at',
        {line: line + 1, col: col + 1},
      ]);

      resolve(result);
    });
  }


  /**
   * Run a command; parse the json output, return an object. This assumes
   * that merlin's protocol is line-based (results are json objects rendered
   * on a single line).
   */
  runSingleCommand(command: mixed): Promise<mixed> {
    const logger = require('nuclide-logging').getLogger();

    const commandString = JSON.stringify(command);
    const stdin = this._proc.stdin;
    const stdout = this._proc.stdout;

    return new Promise((resolve, reject) => {
      // Flow claims that createInterface is not found, but it obviously can find it since the type
      // hint for `reader` returns Interface, which is the return value of createInterface.
      // $FlowIssue
      const {createInterface} = require('readline');
      const reader = createInterface({
        input: stdout,
        terminal: false,
      });

      reader.on('line', (line) => {
        reader.close();
        let response;
        try {
          response = JSON.parse(line);
        } catch (err) {
          response = null;
        }
        if (!response || !Array.isArray(response) || response.length !== 2) {
          logger.error('Unexpected response from ocamlmerlin: ${line}');
          reject(Error('Unexpected ocamlmerlin output format'));
          return;
        }

        const status = response[0];
        const content = response[1];

        if (ERROR_RESPONSES.has(status)) {
          logger.error('Ocamlmerlin raised an error: ' + line);
          reject(Error('Ocamlmerlin returned an error'));
          return;
        }

        resolve(content);
      });

      stdin.write(commandString);
    });
  }

  dispose() {
    this._proc.kill();
  }
}

let merlinProcessInstance: ?MerlinProcess;

export async function getInstance(file: NuclideUri): Promise<?MerlinProcess> {
  if (merlinProcessInstance && merlinProcessInstance.isRunning()) {
    return merlinProcessInstance;
  }

  const merlinPath = getPathToMerlin();

  if (!await isInstalled(merlinPath)) {
    return null;
  }

  const dotMerlinPath = await findNearestFile('.merlin', file);

  const options = {
    cwd: (dotMerlinPath ? require('path').dirname(dotMerlinPath) : '.'),
  };

  logger.info('Spawning new ocamlmerlin process');
  const process = await safeSpawn(merlinPath, [], options);
  merlinProcessInstance = new MerlinProcess(process);

  if (dotMerlinPath) {
    // TODO(pieter) add support for multiple .dotmerlin files
    await merlinProcessInstance.pushDotMerlinPath(dotMerlinPath);
    logger.debug('Added .merlin path: ' + dotMerlinPath);
  }

  return merlinProcessInstance;
}

/**
 * @return The path to ocamlmerlin on the user's machine. It is recommended not to cache the result
 *   of this function in case the user updates his or her preferences in Atom, in which case the
 *   return value will be stale.
 */
function getPathToMerlin(): string {
  if (global.atom) {
    return global.atom.config.get('nuclide-ocaml.pathToMerlin');
  } else {
    return 'ocamlmerlin';
  }
}

let isInstalledCache: ?boolean = null;
async function isInstalled(merlinPath: string): Promise<boolean> {
  if (isInstalledCache == null) {
    const result = await checkOutput('which', [merlinPath]);
    isInstalledCache = result.exitCode === 0;
    if (!isInstalledCache) {
      logger.info('ocamlmerlin not installed');
    }
  }
  return isInstalledCache;
}
