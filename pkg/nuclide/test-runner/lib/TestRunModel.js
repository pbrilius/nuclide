'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

const Ansi = require('./Ansi');

/**
 * Status codes returned in the "status" field of the testing utility's JSON response.
 */
const Status: {[key: string]: number} = {
  PASSED: 1,
  FAILED: 2,
  SKIPPED: 3,
  FATAL: 4,
  TIMEOUT: 5,
};

const StatusSymbol: {[key: $Keys<typeof Status>]: string} = {};
StatusSymbol[Status.PASSED] = `${Ansi.GREEN}✓${Ansi.RESET}`;
StatusSymbol[Status.FAILED] = `${Ansi.RED}✗${Ansi.RESET}`;
StatusSymbol[Status.SKIPPED] = `${Ansi.YELLOW}?${Ansi.RESET}`;
StatusSymbol[Status.FATAL] = `${Ansi.RED}✘${Ansi.RESET}`;
StatusSymbol[Status.TIMEOUT] = `${Ansi.BLUE}✉${Ansi.RESET}`;

const StatusMessage: {[key: $Keys<typeof Status>]: string} = {};
StatusMessage[Status.PASSED] = `${Ansi.GREEN}(PASS)${Ansi.RESET}`;
StatusMessage[Status.FAILED] = `${Ansi.RED}(FAIL)${Ansi.RESET}`;
StatusMessage[Status.SKIPPED] = `${Ansi.YELLOW}(SKIP)${Ansi.RESET}`;
StatusMessage[Status.FATAL] = `${Ansi.RED}(FATAL)${Ansi.RESET}`;
StatusMessage[Status.TIMEOUT] = `${Ansi.BLUE}(TIMEOUT)${Ansi.RESET}`;

class TestRunModel {

  static Status: {[key: string]: number};

  startTime: ?number;
  endTime: ?number;
  label: string;
  dispose: ?() => void;

  constructor(label: string, dispose: () => void) {
    this.label = label;
    this.dispose = dispose;
  }

  getDuration(): ?number {
    if (this.startTime && this.endTime) {
      return this.endTime - this.startTime;
    }
  }

  start(): void {
    this.startTime = Date.now();
  }

  stop(): void {
    this.endTime = Date.now();
  }

  /**
   * @return A summary of the test run including its name, its duration, and whether it passed,
   * failed, skipped, etc.
   */
  static formatStatusMessage(name: string, duration: number, status: $Keys<typeof Status>): string {
    const durationStr = duration.toFixed(3);
    return `      ${StatusSymbol[status]} ${name} ${durationStr}s ${StatusMessage[status]}`;
  }
}

// TODO: Use a property initializer when supported by Flow.
TestRunModel.Status = Status;

module.exports = TestRunModel;
